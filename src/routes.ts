import type {
  CallDirection,
  CallHistoryStatus,
  CallKind,
  CreateCallHistoryRequest,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  UpdateProfileRequest,
} from './types';
import { createHmac } from 'node:crypto';
import { errorResponse, getBearerToken, jsonResponse } from './http';
import { supabase, supabaseAuth, validateToken } from './supabase';
import { callHistoryByUser, rooms, users } from './state';
import {
  deleteAvatarByUrl,
  extractAvatarKey,
  normalizeAvatarUrl,
  processAvatarImage,
  uploadAvatar,
  uploadRoomAvatar,
} from './storage';

export type RouteHandler = (req: Request) => Promise<Response>;

const CALL_HISTORY_LIMIT = 50;
const allowedCallDirections = new Set<CallDirection>(['incoming', 'outgoing']);
const allowedCallStatuses = new Set<CallHistoryStatus>(['completed', 'missed', 'rejected', 'failed']);
const allowedCallTypes = new Set<CallKind>(['audio', 'video']);
const MISSING_TABLE_ERROR_CODE = '42P01';
const MISSING_COLUMN_ERROR_CODE = '42703';
const USERNAME_MIN_LENGTH = 4;
const DEFAULT_TURN_TTL_SECONDS = 600;

type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

const parseUrls = (value?: string | null) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const TURN_URLS = parseUrls(process.env.TURN_URLS ?? process.env.TURN_URL);
const STUN_URLS = parseUrls(process.env.STUN_URLS ?? process.env.STUN_URL);
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL ?? '';
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_TTL_SECONDS = Number.parseInt(process.env.TURN_TTL_SECONDS ?? String(DEFAULT_TURN_TTL_SECONDS), 10);
const TURN_USER_PREFIX = process.env.TURN_USER_PREFIX ?? '';

const resolveTurnTtlSeconds = () => {
  if (Number.isFinite(TURN_TTL_SECONDS) && TURN_TTL_SECONDS > 0) {
    return TURN_TTL_SECONDS;
  }
  return DEFAULT_TURN_TTL_SECONDS;
};

const buildIceServers = (userId: string) => {
  const iceServers: IceServer[] = [];

  if (STUN_URLS.length > 0) {
    iceServers.push({ urls: STUN_URLS });
  }

  if (TURN_URLS.length > 0) {
    if (TURN_SECRET) {
      const ttlSeconds = resolveTurnTtlSeconds();
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiresAt}:${TURN_USER_PREFIX}${userId}`;
      const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      iceServers.push({ urls: TURN_URLS, username, credential });
      return { iceServers, ttlSeconds };
    }

    if (TURN_USERNAME && TURN_CREDENTIAL) {
      iceServers.push({
        urls: TURN_URLS,
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      });
      return { iceServers };
    }

    throw new Error('TURN credentials are not configured');
  }

  if (iceServers.length === 0) {
    throw new Error('ICE servers are not configured');
  }

  return { iceServers };
};

function parseDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeCallStatus(value?: string | null): CallHistoryStatus {
  if (value === 'completed' || value === 'missed' || value === 'rejected' || value === 'failed') {
    return value;
  }
  return 'failed';
}

function normalizeCallType(value?: string): CallKind {
  return value === 'video' ? 'video' : 'audio';
}

const nowIso = () => new Date().toISOString();

async function attachPeers(
  calls: Array<{
    id: string;
    peer_id: string | null;
    room_id?: string | null;
    direction: CallDirection;
    status: CallHistoryStatus;
    duration_seconds: number;
    call_type: CallKind;
    started_at: string;
    ended_at: string | null;
  }>
) {
  const peerIds = Array.from(new Set(calls.map((call) => call.peer_id).filter(Boolean) as string[]));
  const peersById = new Map<string, any>();

  if (peerIds.length > 0) {
    const { data: peers, error: peersError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', peerIds);
    if (peersError) throw peersError;
    for (const peer of peers || []) {
      peersById.set(peer.id, peer);
    }
  }

  return calls.map((call) => ({
    ...call,
    peer: call.peer_id ? (peersById.get(call.peer_id) ?? null) : null,
  }));
}

async function attachRooms(
  calls: Array<{
    id: string;
    peer_id: string | null;
    room_id?: string | null;
    direction: CallDirection;
    status: CallHistoryStatus;
    duration_seconds: number;
    call_type: CallKind;
    started_at: string;
    ended_at: string | null;
    peer?: any;
  }>
) {
  const roomIds = Array.from(new Set(calls.map((call) => call.room_id).filter(Boolean) as string[]));
  const roomsById = new Map<string, any>();

  if (roomIds.length > 0) {
    let roomsData: any[] | null = null;
    let roomsError: any = null;

    ({ data: roomsData, error: roomsError } = await supabase
      .from('rooms')
      .select('id, name, avatar_url, room_type')
      .in('id', roomIds));
    if (roomsError?.code === MISSING_COLUMN_ERROR_CODE) {
      ({ data: roomsData, error: roomsError } = await supabase
        .from('rooms')
        .select('id, name, avatar_url')
        .in('id', roomIds));
    }
    if (roomsError) throw roomsError;
    for (const room of roomsData || []) {
      roomsById.set(room.id, {
        ...room,
        avatar_url: normalizeAvatarUrl(room.avatar_url),
      });
    }
  }

  return calls.map((call) => ({
    ...call,
    room: call.room_id ? (roomsById.get(call.room_id) ?? null) : null,
  }));
}

export const routes: Record<string, RouteHandler> = {
  '/api/profile': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, status, last_seen')
        .eq('id', userId)
        .single();
      if (error) return errorResponse(error.message, 500);
      if (data?.avatar_url) {
        const normalized = normalizeAvatarUrl(data.avatar_url);
        if (normalized && normalized !== data.avatar_url) {
          const { error: updateError } = await supabase
            .from('profiles')
            .update({ avatar_url: normalized })
            .eq('id', userId);
          if (!updateError) {
            data.avatar_url = normalized;
          }
        }
      }
      return jsonResponse({ profile: data });
    }

    if (req.method === 'PATCH') {
      try {
        const contentType = req.headers.get('content-type') ?? '';
        const isMultipart = contentType.includes('multipart/form-data');
        const updates: Record<string, string | null> = {};
        let avatarUrl: string | null | undefined = undefined;

        if (isMultipart) {
          const form = await req.formData();
          const usernameValue = form.get('username');
          const displayNameValue = form.get('displayName');
          const removeAvatarValue = form.get('removeAvatar');
          const avatarValue = form.get('avatar');
          let currentAvatarUrl: string | null = null;

          if (typeof usernameValue === 'string') {
            const username = usernameValue.trim();
            if (!username) return errorResponse('Username is required', 400);
            if (username.length < USERNAME_MIN_LENGTH) {
              return errorResponse('Username too short', 400);
            }
            updates.username = username;
          }

          if (displayNameValue !== null && displayNameValue !== undefined) {
            const displayName = String(displayNameValue).trim();
            updates.display_name = displayName.length > 0 ? displayName : null;
          }

          const removeAvatar = typeof removeAvatarValue === 'string' && removeAvatarValue.toLowerCase() === 'true';

          if (avatarValue instanceof Blob || removeAvatar) {
            const { data: currentProfile, error: currentError } = await supabase
              .from('profiles')
              .select('avatar_url')
              .eq('id', userId)
              .single();
            if (currentError) {
              return errorResponse(currentError.message, 500);
            }
            currentAvatarUrl = normalizeAvatarUrl(currentProfile?.avatar_url);
          }

          if (avatarValue && avatarValue instanceof Blob) {
            if (!avatarValue.type.startsWith('image/')) {
              return errorResponse('Avatar must be an image', 400);
            }
            const buffer = Buffer.from(await avatarValue.arrayBuffer());
            try {
              const processed = await processAvatarImage(buffer);
              const uploadResult = await uploadAvatar(userId, processed.buffer, processed.contentType);
              avatarUrl = uploadResult.url;
              if (currentAvatarUrl) {
                deleteAvatarByUrl(currentAvatarUrl).catch((error) => {
                  console.error('[Avatar] Old avatar delete failed:', error);
                });
              }
            } catch (error: any) {
              return errorResponse(error?.message ?? 'Avatar processing failed', 400);
            }
          } else if (avatarValue) {
            return errorResponse('Invalid avatar file', 400);
          } else if (removeAvatar) {
            if (currentAvatarUrl) {
              deleteAvatarByUrl(currentAvatarUrl).catch((error) => {
                console.error('[Avatar] Old avatar delete failed:', error);
              });
            }
            avatarUrl = null;
          }
        } else {
          const body = (await req.json()) as UpdateProfileRequest;

          if (body.username !== undefined) {
            const username = body.username.trim();
            if (!username) return errorResponse('Username is required', 400);
            if (username.length < USERNAME_MIN_LENGTH) {
              return errorResponse('Username too short', 400);
            }
            updates.username = username;
          }

          if (body.displayName !== undefined) {
            const displayName = (body.displayName ?? '').trim();
            updates.display_name = displayName.length > 0 ? displayName : null;
          }
        }

        if (avatarUrl !== undefined) {
          updates.avatar_url = avatarUrl;
        }

        if (Object.keys(updates).length === 0) {
          return errorResponse('No fields to update', 400);
        }

        if (updates.username) {
          const { data: existing, error: existingError } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', updates.username)
            .neq('id', userId)
            .maybeSingle();
          if (existingError) {
            return errorResponse(existingError.message, 500);
          }
          if (existing) return errorResponse('Username taken', 409);
        }

        const { data: profile, error } = await supabase
          .from('profiles')
          .update(updates)
          .eq('id', userId)
          .select('id, username, display_name, avatar_url, status, last_seen')
          .single();
        if (error) return errorResponse(error.message, 500);

        const metadataUpdate: Record<string, string> = {};
        if (updates.username) metadataUpdate.username = updates.username;
        if ('display_name' in updates) {
          metadataUpdate.display_name = updates.display_name ?? '';
        }
        if (Object.keys(metadataUpdate).length > 0) {
          const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
            user_metadata: metadataUpdate,
          });
          if (authError) {
            console.error('[Auth] Metadata update failed:', authError.message);
          }
        }

        return jsonResponse({ profile });
      } catch (err: any) {
        const status = err instanceof SyntaxError ? 400 : 500;
        return errorResponse(err?.message ?? 'Invalid request body', status);
      }
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/ice-servers': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    try {
      const { iceServers, ttlSeconds } = buildIceServers(userId);
      return jsonResponse({ iceServers, ttlSeconds });
    } catch (error: any) {
      return errorResponse(error?.message ?? 'ICE servers are not configured', 500);
    }
  },

  '/api/register': async (req: Request) => {
    try {
      const body = (await req.json()) as RegisterRequest;
      const { email, password, username, displayName } = body;

      if (!email || !password || !username) {
        return errorResponse('Missing fields', 400);
      }

      const { data: existing } = await supabase.from('profiles').select('username').eq('username', username).single();
      if (existing) return errorResponse('Username taken', 409);

      const { data, error } = await supabaseAuth.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName || username } },
      });

      if (error) throw error;
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Internal error', 500);
    }
  },

  '/api/login': async (req: Request) => {
    try {
      const { email, password } = (await req.json()) as LoginRequest;
      const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return errorResponse(error.message, 401);

      return jsonResponse(data);
    } catch {
      return errorResponse('Internal error', 500);
    }
  },

  '/api/refresh': async (req: Request) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    try {
      const { refreshToken } = (await req.json()) as RefreshRequest;
      if (!refreshToken) return errorResponse('Missing refresh token', 400);
      const { data, error } = await supabaseAuth.auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (error) return errorResponse(error.message, 401);
      return jsonResponse(data);
    } catch {
      return errorResponse('Internal error', 500);
    }
  },

  '/api/users': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    const onlineIds = Array.from(users.keys()).filter((id) => id !== userId);
    if (onlineIds.length === 0) return jsonResponse({ users: [] });

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, status, avatar_url')
      .in('id', onlineIds);
    if (error) return errorResponse(error.message, 500);
    const normalizedUsers = (data || []).map((user) => ({
      ...user,
      avatar_url: normalizeAvatarUrl(user.avatar_url),
    }));
    return jsonResponse({ users: normalizedUsers });
  },

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

  '/api/call-history': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      let calls: any[] | null = null;
      let error: any = null;

      ({ data: calls, error } = await supabase
        .from('call_history')
        .select('id, caller_id, receiver_id, room_id, status, duration, call_type, started_at, ended_at')
        .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
        .order('started_at', { ascending: false })
        .limit(CALL_HISTORY_LIMIT));

      if (error?.code === MISSING_COLUMN_ERROR_CODE) {
        ({ data: calls, error } = await supabase
          .from('call_history')
          .select('id, caller_id, receiver_id, status, duration, call_type, started_at, ended_at')
          .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
          .order('started_at', { ascending: false })
          .limit(CALL_HISTORY_LIMIT));
      }

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE) {
          try {
            const fallbackCalls = callHistoryByUser.get(userId) || [];
            const normalizedCalls = await attachRooms(await attachPeers(fallbackCalls));
            return jsonResponse({ calls: normalizedCalls });
          } catch (fallbackError: any) {
            return errorResponse(fallbackError.message, 500);
          }
        }
        return errorResponse(error.message, 500);
      }

      try {
        const mappedCalls = (calls || [])
          .map((call) => {
            const roomId = (call as any).room_id ?? null;
            const isRoomCall = Boolean(roomId);
            const isOutgoing = call.caller_id === userId;
            const peerId = isRoomCall ? null : isOutgoing ? call.receiver_id : call.caller_id;
            if (!isRoomCall && !peerId) return null;

            return {
              id: call.id,
              peer_id: peerId,
              room_id: roomId,
              direction: isRoomCall ? 'outgoing' : isOutgoing ? 'outgoing' : 'incoming',
              status: normalizeCallStatus(call.status),
              duration_seconds: call.duration ?? 0,
              call_type: normalizeCallType(call.call_type),
              started_at: call.started_at,
              ended_at: call.ended_at,
            };
          })
          .filter(Boolean) as Array<{
          id: string;
          peer_id: string | null;
          room_id?: string | null;
          direction: CallDirection;
          status: CallHistoryStatus;
          duration_seconds: number;
          call_type: CallKind;
          started_at: string;
          ended_at: string | null;
        }>;

        const fallbackCalls = callHistoryByUser.get(userId) || [];
        const combinedCalls = [...mappedCalls, ...fallbackCalls]
          .sort((a, b) => {
            const aTime = new Date(a.started_at).getTime();
            const bTime = new Date(b.started_at).getTime();
            return bTime - aTime;
          })
          .slice(0, CALL_HISTORY_LIMIT);

        const normalizedCalls = await attachRooms(await attachPeers(combinedCalls));
        return jsonResponse({ calls: normalizedCalls });
      } catch (peerError: any) {
        return errorResponse(peerError.message, 500);
      }
    }

    if (req.method === 'POST') {
      try {
        const body = (await req.json()) as CreateCallHistoryRequest;
        const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : '';
        const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
        const isRoomCall = Boolean(roomId);

        if (!peerId && !roomId) {
          return errorResponse('peerId or roomId is required', 400);
        }
        if (peerId && roomId) {
          return errorResponse('peerId and roomId cannot both be set', 400);
        }
        if (!allowedCallDirections.has(body.direction)) {
          return errorResponse('Invalid direction', 400);
        }
        if (isRoomCall && body.direction !== 'outgoing') {
          return errorResponse('Invalid direction for room call', 400);
        }
        if (!allowedCallStatuses.has(body.status)) {
          return errorResponse('Invalid status', 400);
        }

        const startedAt = parseDate(body.startedAt);
        const endedAt = parseDate(body.endedAt) ?? new Date().toISOString();
        const durationSeconds = Math.max(0, Math.floor(Number(body.durationSeconds) || 0));
        const callType = normalizeCallType(body.callType);
        const callerId = body.direction === 'outgoing' ? userId : peerId || userId;
        const receiverId = isRoomCall ? userId : body.direction === 'outgoing' ? peerId : userId;
        const fallbackLog = {
          id: crypto.randomUUID(),
          peer_id: peerId || null,
          room_id: roomId || null,
          direction: body.direction,
          status: body.status,
          duration_seconds: durationSeconds,
          call_type: callType,
          started_at: startedAt ?? endedAt,
          ended_at: endedAt,
        };

        if (!allowedCallTypes.has(callType)) {
          return errorResponse('Invalid callType', 400);
        }

        const insertPayload: Record<string, any> = {
          caller_id: callerId,
          receiver_id: receiverId,
          status: body.status,
          duration: durationSeconds,
          call_type: callType,
          started_at: startedAt ?? endedAt,
          ended_at: endedAt,
        };
        if (roomId) insertPayload.room_id = roomId;

        const { error } = await supabase.from('call_history').insert(insertPayload);

        if (error) {
          if (error.code === MISSING_TABLE_ERROR_CODE || (error.code === MISSING_COLUMN_ERROR_CODE && roomId)) {
            const existing = callHistoryByUser.get(userId) || [];
            existing.unshift(fallbackLog);
            callHistoryByUser.set(userId, existing.slice(0, CALL_HISTORY_LIMIT));
            return jsonResponse({ ok: true }, 201);
          }
          return errorResponse(error.message, 500);
        }

        return jsonResponse({ ok: true }, 201);
      } catch {
        return errorResponse('Invalid request body', 400);
      }
    }

    return errorResponse('Method not allowed', 405);
  },
};
