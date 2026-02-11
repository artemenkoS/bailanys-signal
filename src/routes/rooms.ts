import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { supabase, validateToken } from '../supabase';
import { rooms } from '../state';
import {
  deleteAvatarByUrl,
  extractAvatarKey,
  normalizeAvatarUrl,
  processAvatarImage,
  uploadRoomAvatar,
} from '../storage';

import type { RouteHandler } from './shared';
import { MISSING_COLUMN_ERROR_CODE, MISSING_TABLE_ERROR_CODE, nowIso } from './shared';

export const roomRoutes: Record<string, RouteHandler> = {
  '/api/rooms': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      let roomRows: any[] | null = null;
      let error: any = null;

      ({ data: roomRows, error } = await supabase
        .from('rooms')
        .select('id, name, is_private, is_active, max_participants, room_type, updated_at, avatar_url')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(100));

      if (error?.code === MISSING_COLUMN_ERROR_CODE) {
        ({ data: roomRows, error } = await supabase
          .from('rooms')
          .select('id, name, is_active, max_participants, room_type, updated_at')
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(100));
      }

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE) {
          const fallbackRooms = Array.from(rooms.entries()).map(([roomId, participants]) => ({
            id: roomId,
            name: roomId,
            isPrivate: false,
            participants: participants.size,
            maxParticipants: null,
            roomType: 'group',
            avatarUrl: null,
          }));
          return jsonResponse({ rooms: fallbackRooms });
        }
        return errorResponse(error.message, 500);
      }

      const normalizedRooms = (roomRows || [])
        .map((room) => {
          const participants = rooms.get(room.id)?.size ?? 0;
          if (participants === 0) return null;
          return {
            id: room.id,
            name: room.name || room.id,
            isPrivate: Boolean((room as any).is_private),
            participants,
            maxParticipants: room.max_participants ?? null,
            roomType: room.room_type || 'group',
            avatarUrl: normalizeAvatarUrl(room.avatar_url),
          };
        })
        .filter(Boolean);

      return jsonResponse({ rooms: normalizedRooms });
    }

    if (req.method === 'PATCH') {
      try {
        const contentType = req.headers.get('content-type') ?? '';
        if (!contentType.includes('multipart/form-data')) {
          return errorResponse('Invalid content type', 400);
        }

        const form = await req.formData();
        const roomIdValue = form.get('roomId');
        const avatarValue = form.get('avatar');
        const removeAvatarValue = form.get('removeAvatar');

        if (typeof roomIdValue !== 'string') {
          return errorResponse('Room id is required', 400);
        }
        const roomId = roomIdValue.trim();
        if (!roomId) return errorResponse('Room id is required', 400);

        const removeAvatar = typeof removeAvatarValue === 'string' && removeAvatarValue.toLowerCase() === 'true';
        const hasAvatarFile = avatarValue instanceof Blob;

        if (!hasAvatarFile && !removeAvatar) {
          return errorResponse('No fields to update', 400);
        }

        const { data: room, error: fetchError } = await supabase
          .from('rooms')
          .select('id, created_by, avatar_url')
          .eq('id', roomId)
          .maybeSingle();
        if (fetchError) {
          if (fetchError.code === MISSING_TABLE_ERROR_CODE) {
            return errorResponse('Room not found', 404);
          }
          if (fetchError.code === MISSING_COLUMN_ERROR_CODE) {
            return errorResponse('Room avatar unsupported', 400);
          }
          return errorResponse(fetchError.message, 500);
        }
        if (!room) return errorResponse('Room not found', 404);
        if (room.created_by !== userId) {
          return errorResponse('Forbidden', 403);
        }

        let avatarUrl: string | null | undefined = undefined;

        if (hasAvatarFile) {
          if (!avatarValue.type.startsWith('image/')) {
            return errorResponse('Avatar must be an image', 400);
          }
          const buffer = Buffer.from(await avatarValue.arrayBuffer());
          try {
            const processed = await processAvatarImage(buffer);
            const uploadResult = await uploadRoomAvatar(roomId, processed.buffer, processed.contentType);
            avatarUrl = uploadResult.url;

            const previousKey = extractAvatarKey(normalizeAvatarUrl(room.avatar_url));
            if (previousKey && previousKey !== uploadResult.key) {
              deleteAvatarByUrl(room.avatar_url).catch((error) => {
                console.error('[Room Avatar] Old avatar delete failed:', error);
              });
            }
          } catch (error: any) {
            return errorResponse(error?.message ?? 'Avatar processing failed', 400);
          }
        } else if (removeAvatar) {
          if (room.avatar_url) {
            deleteAvatarByUrl(room.avatar_url).catch((error) => {
              console.error('[Room Avatar] Delete failed:', error);
            });
          }
          avatarUrl = null;
        }

        if (avatarUrl !== undefined) {
          const { error: updateError } = await supabase
            .from('rooms')
            .update({ avatar_url: avatarUrl, updated_at: nowIso() })
            .eq('id', roomId);
          if (updateError) {
            if (updateError.code === MISSING_COLUMN_ERROR_CODE) {
              return errorResponse('Room avatar unsupported', 400);
            }
            return errorResponse(updateError.message, 500);
          }
        }

        return jsonResponse({
          ok: true,
          avatarUrl: normalizeAvatarUrl(avatarUrl ?? null),
        });
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    if (req.method === 'DELETE') {
      try {
        const body = (await req.json()) as { id?: string };
        const roomId = body?.id?.trim();
        if (!roomId) return errorResponse('Room id is required', 400);

        const activeParticipants = rooms.get(roomId)?.size ?? 0;
        if (activeParticipants > 0) {
          return errorResponse('Room has active participants', 409);
        }

        let room: any = null;
        let fetchError: any = null;
        ({ data: room, error: fetchError } = await supabase
          .from('rooms')
          .select('id, created_by')
          .eq('id', roomId)
          .maybeSingle());
        if (fetchError) {
          if (fetchError.code === MISSING_TABLE_ERROR_CODE) {
            rooms.delete(roomId);
            return jsonResponse({ ok: true });
          }
          return errorResponse(fetchError.message, 500);
        }
        if (!room) return errorResponse('Room not found', 404);
        if (room.created_by !== userId) {
          return errorResponse('Forbidden', 403);
        }

        const { error: participantsError } = await supabase
          .from('room_participants')
          .update({ is_active: false, left_at: nowIso() })
          .eq('room_id', roomId)
          .eq('is_active', true);
        if (participantsError) {
          console.warn('[Rooms] Failed to close participants:', participantsError.message);
        }

        const { error: participantsDeleteError } = await supabase
          .from('room_participants')
          .delete()
          .eq('room_id', roomId);
        if (participantsDeleteError && participantsDeleteError.code !== MISSING_TABLE_ERROR_CODE) {
          return errorResponse(participantsDeleteError.message, 500);
        }

        const { error: historyError } = await supabase.from('call_history').delete().eq('room_id', roomId);
        if (
          historyError &&
          historyError.code !== MISSING_TABLE_ERROR_CODE &&
          historyError.code !== MISSING_COLUMN_ERROR_CODE
        ) {
          return errorResponse(historyError.message, 500);
        }

        const { data: deletedRooms, error: deleteError } = await supabase
          .from('rooms')
          .delete()
          .eq('id', roomId)
          .select('id');
        if (deleteError) {
          if (deleteError.code === MISSING_TABLE_ERROR_CODE) {
            rooms.delete(roomId);
            return jsonResponse({ ok: true });
          }
          return errorResponse(deleteError.message, 500);
        }
        if (!deletedRooms || deletedRooms.length === 0) {
          return errorResponse('Room delete failed', 500);
        }

        rooms.delete(roomId);
        return jsonResponse({ ok: true });
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/rooms/mine': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      let roomRows: any[] | null = null;
      let error: any = null;

      ({ data: roomRows, error } = await supabase
        .from('rooms')
        .select('id, name, is_private, is_active, max_participants, room_type, updated_at, avatar_url')
        .eq('created_by', userId)
        .order('updated_at', { ascending: false })
        .limit(200));

      if (error?.code === MISSING_COLUMN_ERROR_CODE) {
        ({ data: roomRows, error } = await supabase
          .from('rooms')
          .select('id, name, is_active, max_participants, room_type, updated_at')
          .eq('created_by', userId)
          .order('updated_at', { ascending: false })
          .limit(200));
      }

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE) {
          return jsonResponse({ rooms: [] });
        }
        return errorResponse(error.message, 500);
      }

      const normalizedRooms = (roomRows || []).map((room) => ({
        id: room.id,
        name: room.name || room.id,
        isPrivate: Boolean((room as any).is_private),
        isActive: Boolean(room.is_active),
        participants: rooms.get(room.id)?.size ?? 0,
        maxParticipants: room.max_participants ?? null,
        roomType: room.room_type || 'group',
        avatarUrl: normalizeAvatarUrl(room.avatar_url),
      }));

      return jsonResponse({ rooms: normalizedRooms });
    }

    return errorResponse('Method not allowed', 405);
  },
};
