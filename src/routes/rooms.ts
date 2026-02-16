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
import { createGuestToken } from '../guestTokens';
import { canAccessRoomChat, getRoomMessages, storeRoomMessage } from '../roomMessages';
import { createRoomInviteToken, verifyRoomInviteToken } from '../roomInviteTokens';
import {
  addRoomMember,
  getRoomMemberRole,
  isRoomAdmin,
  listRoomMembers,
  removeRoomMember,
  ROOM_MEMBER_ROLE_ADMIN,
  ROOM_MEMBER_ROLE_MEMBER,
  setRoomMemberRole,
} from '../roomMembers';
import { broadcastToRoom, broadcastToRoomChat, sendToUser } from '../ws';

import type { RouteHandler } from './shared';
import { MISSING_COLUMN_ERROR_CODE, MISSING_TABLE_ERROR_CODE, ROOM_MESSAGE_MAX_LENGTH, nowIso } from './shared';

const ROOM_INVITE_STATUS_PENDING = 'pending';
const ROOM_INVITE_STATUS_ACCEPTED = 'accepted';
const ROOM_INVITE_STATUS_DECLINED = 'declined';
const ROOM_INVITE_STATUS_CANCELED = 'canceled';
const ROOM_INVITE_ACTIONS = new Set(['accept', 'decline', 'cancel']);

const roomStorageError = (error: any) => {
  if (error?.code === MISSING_TABLE_ERROR_CODE) {
    return errorResponse('Rooms storage is not configured', 501);
  }
  return errorResponse(error?.message ?? 'Rooms storage error', 500);
};

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

  '/api/rooms/guest-link': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    try {
      const body = (await req.json()) as { roomId?: string; ttlSeconds?: number };
      const roomId = body?.roomId?.trim();
      if (!roomId) return errorResponse('Room id is required', 400);

      const room = rooms.get(roomId);
      if (!room || !room.has(userId)) {
        return errorResponse('Forbidden', 403);
      }

      const { token: guestToken, payload } = createGuestToken(roomId, {
        ttlSeconds: body?.ttlSeconds,
        allowPrivate: true,
      });

      return jsonResponse({
        token: guestToken,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      });
    } catch {
      return errorResponse('Invalid request body', 400);
    }
  },

  '/api/rooms/invite-link': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    try {
      const body = (await req.json()) as { roomId?: string; ttlSeconds?: number };
      const roomId = body?.roomId?.trim();
      if (!roomId) return errorResponse('Room id is required', 400);

      const adminCheck = await isRoomAdmin(roomId, userId);
      if (adminCheck.error) return roomStorageError(adminCheck.error);
      if (!adminCheck.ok) return errorResponse('Forbidden', 403);

      const membershipProbe = await getRoomMemberRole(roomId, userId);
      if (!membershipProbe.supported) return errorResponse('Room membership unsupported', 501);
      if (membershipProbe.error) return roomStorageError(membershipProbe.error);

      const { token: inviteToken, payload } = createRoomInviteToken(roomId, {
        ttlSeconds: body?.ttlSeconds,
      });

      return jsonResponse({
        token: inviteToken,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      });
    } catch {
      return errorResponse('Invalid request body', 400);
    }
  },

  '/api/rooms/invite-link/accept': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    try {
      const body = (await req.json()) as { token?: string };
      const inviteToken = body?.token?.trim();
      if (!inviteToken) return errorResponse('Invite token is required', 400);

      const payload = verifyRoomInviteToken(inviteToken);
      if (!payload?.roomId) return errorResponse('Invalid invite token', 400);

      let room: any = null;
      let error: any = null;
      ({ data: room, error } = await supabase
        .from('rooms')
        .select('id, name, is_private, avatar_url')
        .eq('id', payload.roomId)
        .maybeSingle());

      if (error?.code === MISSING_COLUMN_ERROR_CODE) {
        ({ data: room, error } = await supabase
          .from('rooms')
          .select('id, name')
          .eq('id', payload.roomId)
          .maybeSingle());
      }

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE) {
          return errorResponse('Room not found', 404);
        }
        return errorResponse(error.message, 500);
      }
      if (!room) return errorResponse('Room not found', 404);

      const addResult = await addRoomMember(room.id, userId, ROOM_MEMBER_ROLE_MEMBER, null);
      if (!addResult.ok) {
        if (!addResult.supported) {
          return errorResponse('Room membership unsupported', 501);
        }
        return roomStorageError(addResult.error);
      }

      return jsonResponse({
        room: {
          id: room.id,
          name: room.name || room.id,
          isPrivate: Boolean((room as any).is_private),
          avatarUrl: normalizeAvatarUrl(room.avatar_url),
        },
      });
    } catch {
      return errorResponse('Invalid request body', 400);
    }
  },

  '/api/rooms/requests': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const { data: invites, error } = await supabase
        .from('room_invites')
        .select('id, room_id, requester_id, target_id, status, created_at')
        .or(
          `and(requester_id.eq.${userId},status.eq.${ROOM_INVITE_STATUS_PENDING}),and(target_id.eq.${userId},status.eq.${ROOM_INVITE_STATUS_PENDING})`
        )
        .order('created_at', { ascending: false });

      if (error) return roomStorageError(error);

      const roomIds = new Set<string>();
      const profileIds = new Set<string>();
      (invites || []).forEach((row: any) => {
        if (row.room_id) roomIds.add(row.room_id);
        if (row.requester_id) profileIds.add(row.requester_id);
        if (row.target_id) profileIds.add(row.target_id);
      });

      const roomsById = new Map<string, any>();
      if (roomIds.size > 0) {
        let roomsData: any[] | null = null;
        let roomsError: any = null;
        ({ data: roomsData, error: roomsError } = await supabase
          .from('rooms')
          .select('id, name, is_private, avatar_url')
          .in('id', Array.from(roomIds)));
        if (roomsError?.code === MISSING_COLUMN_ERROR_CODE) {
          ({ data: roomsData, error: roomsError } = await supabase.from('rooms').select('id, name').in('id', Array.from(roomIds)));
        }
        if (roomsError) return roomStorageError(roomsError);
        (roomsData || []).forEach((room) => {
          roomsById.set(room.id, {
            id: room.id,
            name: room.name || room.id,
            isPrivate: Boolean((room as any).is_private),
            avatarUrl: normalizeAvatarUrl(room.avatar_url),
          });
        });
      }

      const profilesById = new Map<string, any>();
      if (profileIds.size > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, display_name, status, avatar_url, last_seen')
          .in('id', Array.from(profileIds));

        if (profilesError) return errorResponse(profilesError.message, 500);

        (profiles || []).forEach((profile) => {
          profilesById.set(profile.id, {
            ...profile,
            avatar_url: normalizeAvatarUrl(profile.avatar_url),
          });
        });
      }

      const incoming = (invites || [])
        .filter((row: any) => row.target_id === userId)
        .map((row: any) => ({
          id: row.id,
          status: row.status,
          created_at: row.created_at ?? null,
          room: roomsById.get(row.room_id) ?? null,
          user: profilesById.get(row.requester_id) ?? null,
        }))
        .filter((entry) => entry.user && entry.room);

      const outgoing = (invites || [])
        .filter((row: any) => row.requester_id === userId)
        .map((row: any) => ({
          id: row.id,
          status: row.status,
          created_at: row.created_at ?? null,
          room: roomsById.get(row.room_id) ?? null,
          user: profilesById.get(row.target_id) ?? null,
        }))
        .filter((entry) => entry.user && entry.room);

      return jsonResponse({ incoming, outgoing });
    }

    if (req.method === 'POST') {
      let body: { roomId?: string; targetId?: string };
      try {
        body = (await req.json()) as { roomId?: string; targetId?: string };
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
      if (!roomId) return errorResponse('roomId is required', 400);
      if (!targetId) return errorResponse('targetId is required', 400);
      if (targetId === userId) return errorResponse('Cannot invite yourself', 400);

      const adminCheck = await isRoomAdmin(roomId, userId);
      if (adminCheck.error) return roomStorageError(adminCheck.error);
      if (!adminCheck.ok) return errorResponse('Forbidden', 403);

      const targetMembership = await getRoomMemberRole(roomId, targetId);
      if (!targetMembership.supported) return errorResponse('Room membership unsupported', 501);
      if (targetMembership.error) return roomStorageError(targetMembership.error);
      if (targetMembership.role) return errorResponse('User already a member', 409);

      const { data: existing, error: existingError } = await supabase
        .from('room_invites')
        .select('id, status, created_at')
        .eq('room_id', roomId)
        .eq('target_id', targetId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (existingError) return roomStorageError(existingError);

      const existingRow = (existing || [])[0] as any | undefined;
      if (existingRow?.status === ROOM_INVITE_STATUS_PENDING) {
        return errorResponse('Invite already sent', 409);
      }

      const createdAt = nowIso();
      const { data: request, error: insertError } = await supabase
        .from('room_invites')
        .insert({
          room_id: roomId,
          requester_id: userId,
          target_id: targetId,
          status: ROOM_INVITE_STATUS_PENDING,
          created_at: createdAt,
        })
        .select('id, room_id, requester_id, target_id, status, created_at')
        .single();

      if (insertError) return roomStorageError(insertError);

      return jsonResponse({ request }, 201);
    }

    if (req.method === 'PATCH') {
      let body: { requestId?: string; action?: string };
      try {
        body = (await req.json()) as { requestId?: string; action?: string };
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!requestId) return errorResponse('requestId is required', 400);
      if (!ROOM_INVITE_ACTIONS.has(action)) return errorResponse('Invalid action', 400);

      const { data: existing, error: existingError } = await supabase
        .from('room_invites')
        .select('id, room_id, requester_id, target_id, status')
        .eq('id', requestId)
        .single();

      if (existingError) return roomStorageError(existingError);
      if (!existing) return errorResponse('Request not found', 404);
      if (existing.status !== ROOM_INVITE_STATUS_PENDING) {
        return errorResponse('Request already resolved', 409);
      }

      if ((action === 'accept' || action === 'decline') && existing.target_id !== userId) {
        return errorResponse('Forbidden', 403);
      }
      if (action === 'cancel' && existing.requester_id !== userId) {
        return errorResponse('Forbidden', 403);
      }

      const newStatus =
        action === 'accept'
          ? ROOM_INVITE_STATUS_ACCEPTED
          : action === 'decline'
            ? ROOM_INVITE_STATUS_DECLINED
            : ROOM_INVITE_STATUS_CANCELED;

      if (action === 'accept') {
        const addResult = await addRoomMember(existing.room_id, existing.target_id, ROOM_MEMBER_ROLE_MEMBER, existing.requester_id);
        if (!addResult.ok) {
          if (!addResult.supported) return errorResponse('Room membership unsupported', 501);
          return roomStorageError(addResult.error);
        }
      }

      const { data: updated, error: updateError } = await supabase
        .from('room_invites')
        .update({ status: newStatus, responded_at: nowIso() })
        .eq('id', requestId)
        .select('id, room_id, requester_id, target_id, status, created_at, responded_at')
        .single();

      if (updateError) return roomStorageError(updateError);

      return jsonResponse({ request: updated }, 200);
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/rooms/members': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const roomId = url.searchParams.get('roomId')?.trim() ?? '';
      if (!roomId) return errorResponse('roomId is required', 400);

      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('id, created_by')
        .eq('id', roomId)
        .maybeSingle();
      if (roomError) return roomStorageError(roomError);
      if (!room) return errorResponse('Room not found', 404);

      const membership = await getRoomMemberRole(roomId, userId);
      if (!membership.supported) return errorResponse('Room membership unsupported', 501);
      if (membership.error) return roomStorageError(membership.error);
      if (!membership.role && room.created_by !== userId) return errorResponse('Forbidden', 403);

      const listResult = await listRoomMembers(roomId);
      if (!listResult.ok) {
        if ('unsupported' in listResult && listResult.unsupported) {
          return errorResponse('Room membership unsupported', 501);
        }
        return roomStorageError(listResult.error);
      }

      return jsonResponse({ members: listResult.members });
    }

    if (req.method === 'PATCH') {
      let body: { roomId?: string; userId?: string; action?: string };
      try {
        body = (await req.json()) as { roomId?: string; userId?: string; action?: string };
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
      const targetId = typeof body.userId === 'string' ? body.userId.trim() : '';
      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!roomId) return errorResponse('roomId is required', 400);
      if (!targetId) return errorResponse('userId is required', 400);
      if (!['promote', 'demote', 'remove', 'leave'].includes(action)) return errorResponse('Invalid action', 400);

      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('id, created_by')
        .eq('id', roomId)
        .maybeSingle();
      if (roomError) return roomStorageError(roomError);
      if (!room) return errorResponse('Room not found', 404);

      if (action === 'leave') {
        if (targetId !== userId) return errorResponse('Forbidden', 403);
        if (room.created_by === targetId) {
          return errorResponse('Cannot leave room as creator', 409);
        }

        const removeResult = await removeRoomMember(roomId, targetId);
        if (!removeResult.ok) {
          if (!removeResult.supported) return errorResponse('Room membership unsupported', 501);
          return roomStorageError(removeResult.error);
        }

        const { error: participantsError } = await supabase
          .from('room_participants')
          .update({ is_active: false, left_at: nowIso() })
          .eq('room_id', roomId)
          .eq('user_id', targetId)
          .eq('is_active', true);
        if (participantsError && participantsError.code !== MISSING_TABLE_ERROR_CODE) {
          console.warn('[Rooms] Failed to close participant:', participantsError.message);
        }

        const activeRoom = rooms.get(roomId);
        if (activeRoom?.has(targetId)) {
          activeRoom.delete(targetId);
          if (activeRoom.size === 0) {
            rooms.delete(roomId);
          }
          broadcastToRoom(roomId, { type: 'room-user-left', roomId, userId: targetId }, targetId);
        }

        return jsonResponse({ ok: true });
      }

      const adminCheck = await isRoomAdmin(roomId, userId);
      if (adminCheck.error) return roomStorageError(adminCheck.error);
      if (!adminCheck.ok) return errorResponse('Forbidden', 403);

      if (action === 'demote' && room.created_by === targetId) {
        return errorResponse('Cannot demote room creator', 409);
      }

      if (action === 'remove') {
        if (room.created_by === targetId) {
          return errorResponse('Cannot remove room creator', 409);
        }

        const removeResult = await removeRoomMember(roomId, targetId);
        if (!removeResult.ok) {
          if (!removeResult.supported) return errorResponse('Room membership unsupported', 501);
          return roomStorageError(removeResult.error);
        }

        const { error: participantsError } = await supabase
          .from('room_participants')
          .update({ is_active: false, left_at: nowIso() })
          .eq('room_id', roomId)
          .eq('user_id', targetId)
          .eq('is_active', true);
        if (participantsError && participantsError.code !== MISSING_TABLE_ERROR_CODE) {
          console.warn('[Rooms] Failed to close participant:', participantsError.message);
        }

        const activeRoom = rooms.get(roomId);
        if (activeRoom?.has(targetId)) {
          activeRoom.delete(targetId);
          if (activeRoom.size === 0) {
            rooms.delete(roomId);
          }
          broadcastToRoom(roomId, { type: 'room-user-left', roomId, userId: targetId }, targetId);
          sendToUser(targetId, { type: 'room-kicked', roomId });
        }

        return jsonResponse({ ok: true });
      }

      const nextRole = action === 'promote' ? ROOM_MEMBER_ROLE_ADMIN : ROOM_MEMBER_ROLE_MEMBER;
      const updateResult = await setRoomMemberRole(roomId, targetId, nextRole);
      if (!updateResult.ok) {
        if (!updateResult.supported) return errorResponse('Room membership unsupported', 501);
        return roomStorageError(updateResult.error);
      }

      return jsonResponse({ member: updateResult.member });
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/rooms/messages': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const roomId = url.searchParams.get('roomId')?.trim() ?? '';
      if (!roomId) return errorResponse('roomId is required', 400);

      const access = await canAccessRoomChat(userId, roomId);
      if (!access.ok) return errorResponse(access.error ?? 'Forbidden', access.error === 'Room not found' ? 404 : 403);

      const messages = await getRoomMessages(roomId);
      return jsonResponse({ messages });
    }

    if (req.method === 'POST') {
      let body: { roomId?: string; body?: string };
      try {
        body = (await req.json()) as { roomId?: string; body?: string };
      } catch {
        return errorResponse('Invalid request body', 400);
      }

      const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
      const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
      if (!roomId) return errorResponse('roomId is required', 400);
      if (!messageBody) return errorResponse('Message body is required', 400);
      if (messageBody.length > ROOM_MESSAGE_MAX_LENGTH) return errorResponse('Message is too long', 400);

      const access = await canAccessRoomChat(userId, roomId);
      if (!access.ok) return errorResponse(access.error ?? 'Forbidden', access.error === 'Room not found' ? 404 : 403);

      const messagePayload = {
        id: crypto.randomUUID(),
        room_id: roomId,
        sender_id: userId,
        body: messageBody,
        created_at: nowIso(),
      };

      await storeRoomMessage(roomId, messagePayload);
      broadcastToRoomChat(roomId, {
        type: 'room-message',
        roomId,
        message: messagePayload,
      });

      return jsonResponse({ message: messagePayload }, 201);
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/rooms/mine': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      let membershipRows: any[] | null = null;
      let membershipError: any = null;
      let membershipSupported = true;

      ({ data: membershipRows, error: membershipError } = await supabase
        .from('room_members')
        .select('room_id, role')
        .eq('user_id', userId));

      if (membershipError) {
        if (
          membershipError.code === MISSING_TABLE_ERROR_CODE ||
          membershipError.code === MISSING_COLUMN_ERROR_CODE
        ) {
          membershipSupported = false;
        } else {
          return errorResponse(membershipError.message, 500);
        }
      }

      const membershipMap = new Map<string, string>();
      if (membershipSupported) {
        (membershipRows || []).forEach((row) => {
          if (row?.room_id) {
            membershipMap.set(row.room_id, row.role);
          }
        });
      }

      const roomSelect =
        'id, name, is_private, is_active, max_participants, room_type, updated_at, avatar_url, created_by';
      const roomSelectFallback = 'id, name, is_active, max_participants, room_type, updated_at, created_by';

      const fetchRooms = async (applyFilters: (builder: any) => any) => {
        let data: any[] | null = null;
        let error: any = null;
        ({ data, error } = await applyFilters(supabase.from('rooms').select(roomSelect))
          .order('updated_at', { ascending: false })
          .limit(200));
        if (error?.code === MISSING_COLUMN_ERROR_CODE) {
          ({ data, error } = await applyFilters(supabase.from('rooms').select(roomSelectFallback))
            .order('updated_at', { ascending: false })
            .limit(200));
        }
        return { data, error };
      };

      const { data: createdRooms, error: createdError } = await fetchRooms(
        (builder) => builder.eq('created_by', userId)
      );

      if (createdError) {
        if (createdError.code === MISSING_TABLE_ERROR_CODE) {
          return jsonResponse({ rooms: [] });
        }
        return errorResponse(createdError.message, 500);
      }

      let membershipRooms: any[] = [];
      const membershipRoomIds = Array.from(membershipMap.keys()).filter(Boolean);

      if (membershipSupported && membershipRoomIds.length > 0) {
        const { data, error } = await fetchRooms((builder) => builder.in('id', membershipRoomIds));
        if (error) {
          if (error.code !== MISSING_TABLE_ERROR_CODE) {
            return errorResponse(error.message, 500);
          }
        } else {
          membershipRooms = data || [];
        }
      }

      const roomsById = new Map<string, any>();
      (createdRooms || []).forEach((room) => roomsById.set(room.id, room));
      membershipRooms.forEach((room) => roomsById.set(room.id, room));

      const orderedRooms = Array.from(roomsById.values()).sort((a, b) => {
        const aTime = a?.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bTime = b?.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bTime - aTime;
      });

      const normalizedRooms = orderedRooms.map((room) => {
        const role = membershipMap.get(room.id);
        const isCreator = room.created_by === userId;
        return {
          id: room.id,
          name: room.name || room.id,
          isPrivate: Boolean((room as any).is_private),
          isActive: Boolean(room.is_active),
          participants: rooms.get(room.id)?.size ?? 0,
          maxParticipants: room.max_participants ?? null,
          roomType: room.room_type || 'group',
          avatarUrl: normalizeAvatarUrl(room.avatar_url),
          role: role || (isCreator ? ROOM_MEMBER_ROLE_ADMIN : ROOM_MEMBER_ROLE_MEMBER),
          isCreator,
        };
      });

      return jsonResponse({ rooms: normalizedRooms });
    }

    return errorResponse('Method not allowed', 405);
  },
};
