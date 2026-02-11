import type { CallDirection, CallHistoryStatus, CallKind, CreateCallHistoryRequest } from '../types';
import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { supabase, validateToken } from '../supabase';
import { callHistoryByUser } from '../state';
import { normalizeAvatarUrl } from '../storage';

import type { RouteHandler } from './shared';
import {
  CALL_HISTORY_LIMIT,
  MISSING_COLUMN_ERROR_CODE,
  MISSING_TABLE_ERROR_CODE,
  allowedCallDirections,
  allowedCallStatuses,
  allowedCallTypes,
  normalizeCallStatus,
  normalizeCallType,
  nowIso,
  parseDate,
} from './shared';

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

export const callHistoryRoutes: Record<string, RouteHandler> = {
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
