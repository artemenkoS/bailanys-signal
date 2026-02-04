import type {
  CallDirection,
  CallHistoryStatus,
  CallKind,
  CreateCallHistoryRequest,
  LoginRequest,
  RegisterRequest,
} from "./types";
import { errorResponse, getBearerToken, jsonResponse } from "./http";
import { supabase, supabaseAuth, validateToken } from "./supabase";
import { callHistoryByUser, users } from "./state";

export type RouteHandler = (req: Request) => Promise<Response>;

const CALL_HISTORY_LIMIT = 50;
const allowedCallDirections = new Set<CallDirection>(["incoming", "outgoing"]);
const allowedCallStatuses = new Set<CallHistoryStatus>([
  "completed",
  "missed",
  "rejected",
  "failed",
]);
const allowedCallTypes = new Set<CallKind>(["audio", "video"]);
const MISSING_TABLE_ERROR_CODE = "42P01";

function parseDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeCallStatus(value?: string | null): CallHistoryStatus {
  if (
    value === "completed" ||
    value === "missed" ||
    value === "rejected" ||
    value === "failed"
  ) {
    return value;
  }
  return "failed";
}

function normalizeCallType(value?: string): CallKind {
  return value === "video" ? "video" : "audio";
}

async function attachPeers(
  calls: Array<{
    id: string;
    peer_id: string;
    direction: CallDirection;
    status: CallHistoryStatus;
    duration_seconds: number;
    call_type: CallKind;
    started_at: string;
    ended_at: string | null;
  }>,
) {
  const peerIds = Array.from(
    new Set(calls.map((call) => call.peer_id).filter(Boolean)),
  );
  const peersById = new Map<string, any>();

  if (peerIds.length > 0) {
    const { data: peers, error: peersError } = await supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url")
      .in("id", peerIds);
    if (peersError) throw peersError;
    for (const peer of peers || []) {
      peersById.set(peer.id, peer);
    }
  }

  return calls.map((call) => ({
    ...call,
    peer: call.peer_id ? peersById.get(call.peer_id) ?? null : null,
  }));
}

export const routes: Record<string, RouteHandler> = {
  "/api/register": async (req: Request) => {
    try {
      const body = (await req.json()) as RegisterRequest;
      const { email, password, username, displayName } = body;

      if (!email || !password || !username) {
        return errorResponse("Missing fields", 400);
      }

      const { data: existing } = await supabase
        .from("profiles")
        .select("username")
        .eq("username", username)
        .single();
      if (existing) return errorResponse("Username taken", 409);

      const { data, error } = await supabaseAuth.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName || username } },
      });

      if (error) throw error;
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err?.message ?? "Internal error", 500);
    }
  },

  "/api/login": async (req: Request) => {
    try {
      const { email, password } = (await req.json()) as LoginRequest;
      const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return errorResponse(error.message, 401);

      return jsonResponse(data);
    } catch {
      return errorResponse("Internal error", 500);
    }
  },

  "/api/users": async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse("Unauthorized", 401);

    const onlineIds = Array.from(users.keys()).filter((id) => id !== userId);
    if (onlineIds.length === 0) return jsonResponse({ users: [] });

    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, display_name, status, avatar_url")
      .in("id", onlineIds);
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ users: data || [] });
  },

  "/api/call-history": async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse("Unauthorized", 401);

    if (req.method === "GET") {
      const { data: calls, error } = await supabase
        .from("call_history")
        .select(
          "id, caller_id, receiver_id, status, duration, call_type, started_at, ended_at",
        )
        .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
        .order("started_at", { ascending: false })
        .limit(CALL_HISTORY_LIMIT);

      if (error) {
        if (error.code === MISSING_TABLE_ERROR_CODE) {
          try {
            const fallbackCalls = callHistoryByUser.get(userId) || [];
            const normalizedCalls = await attachPeers(fallbackCalls);
            return jsonResponse({ calls: normalizedCalls });
          } catch (fallbackError: any) {
            return errorResponse(fallbackError.message, 500);
          }
        }
        return errorResponse(error.message, 500);
      }

      try {
        const normalizedCalls = await attachPeers(
          (calls || [])
            .map((call) => {
              const isOutgoing = call.caller_id === userId;
              const peerId = isOutgoing ? call.receiver_id : call.caller_id;
              if (!peerId) return null;

              return {
                id: call.id,
                peer_id: peerId,
                direction: isOutgoing ? "outgoing" : "incoming",
                status: normalizeCallStatus(call.status),
                duration_seconds: call.duration ?? 0,
                call_type: normalizeCallType(call.call_type),
                started_at: call.started_at,
                ended_at: call.ended_at,
              };
            })
            .filter(Boolean) as Array<{
            id: string;
            peer_id: string;
            direction: CallDirection;
            status: CallHistoryStatus;
            duration_seconds: number;
            call_type: CallKind;
            started_at: string;
            ended_at: string | null;
          }>,
        );
        return jsonResponse({ calls: normalizedCalls });
      } catch (peerError: any) {
        return errorResponse(peerError.message, 500);
      }
    }

    if (req.method === "POST") {
      try {
        const body = (await req.json()) as CreateCallHistoryRequest;
        if (!body.peerId) return errorResponse("peerId is required", 400);
        if (!allowedCallDirections.has(body.direction)) {
          return errorResponse("Invalid direction", 400);
        }
        if (!allowedCallStatuses.has(body.status)) {
          return errorResponse("Invalid status", 400);
        }

        const startedAt = parseDate(body.startedAt);
        const endedAt = parseDate(body.endedAt) ?? new Date().toISOString();
        const durationSeconds = Math.max(
          0,
          Math.floor(Number(body.durationSeconds) || 0),
        );
        const callType = normalizeCallType(body.callType);
        const callerId = body.direction === "outgoing" ? userId : body.peerId;
        const receiverId = body.direction === "outgoing" ? body.peerId : userId;
        const fallbackLog = {
          id: crypto.randomUUID(),
          peer_id: body.peerId,
          direction: body.direction,
          status: body.status,
          duration_seconds: durationSeconds,
          call_type: callType,
          started_at: startedAt ?? endedAt,
          ended_at: endedAt,
        };

        if (!allowedCallTypes.has(callType)) {
          return errorResponse("Invalid callType", 400);
        }

        const { error } = await supabase.from("call_history").insert({
          caller_id: callerId,
          receiver_id: receiverId,
          status: body.status,
          duration: durationSeconds,
          call_type: callType,
          started_at: startedAt ?? endedAt,
          ended_at: endedAt,
        });

        if (error) {
          if (error.code === MISSING_TABLE_ERROR_CODE) {
            const existing = callHistoryByUser.get(userId) || [];
            existing.unshift(fallbackLog);
            callHistoryByUser.set(userId, existing.slice(0, CALL_HISTORY_LIMIT));
            return jsonResponse({ ok: true }, 201);
          }
          return errorResponse(error.message, 500);
        }

        return jsonResponse({ ok: true }, 201);
      } catch {
        return errorResponse("Invalid request body", 400);
      }
    }

    return errorResponse("Method not allowed", 405);
  },
};
