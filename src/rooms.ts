import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";
import { supabase } from "./supabase";
import { rooms } from "./state";
import { broadcastToRoom, sendJson } from "./ws";

const MISSING_TABLE_ERROR_CODE = "42P01";

const nowIso = () => new Date().toISOString();

const isMissingTableError = (error: any) =>
  Boolean(error && error.code === MISSING_TABLE_ERROR_CODE);

const logRoomWarning = (context: string, error: any) => {
  if (!error) return;
  if (isMissingTableError(error)) {
    console.warn(`[Rooms] Table missing for ${context}, skipping.`);
    return;
  }
  console.warn(`[Rooms] ${context} failed:`, error.message ?? error);
};

const ensureRoomRecord = async (
  roomId: string,
  userId: string,
  createIfMissing: boolean,
) => {
  try {
    const { data: room, error } = await supabase
      .from("rooms")
      .select("id, is_active, room_type, max_participants")
      .eq("id", roomId)
      .maybeSingle();
    if (error) {
      logRoomWarning("lookup", error);
      return { room: null, allowed: true };
    }
    if (!room) {
      if (!createIfMissing) return { room: null, allowed: false };
      const { error: createError } = await supabase.from("rooms").insert({
        id: roomId,
        name: roomId,
        room_type: "group",
        created_by: userId,
        is_active: true,
        max_participants: null,
        updated_at: nowIso(),
      });
      logRoomWarning("create", createError);
      return { room: null, allowed: true, created: true };
    }
    if (!room.is_active) {
      const { error: updateError } = await supabase
        .from("rooms")
        .update({ is_active: true, updated_at: nowIso() })
        .eq("id", roomId);
      logRoomWarning("activate", updateError);
    }
    return { room, allowed: true };
  } catch (err) {
    console.warn("[Rooms] Lookup error, using ephemeral:", err);
    return { room: null, allowed: true };
  }
};

const upsertParticipantJoin = async (roomId: string, userId: string) => {
  const now = nowIso();
  try {
    const { error: deactivateError } = await supabase
      .from("room_participants")
      .update({ is_active: false, left_at: now })
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .eq("is_active", true);
    logRoomWarning("participant-deactivate", deactivateError);

    const { error: insertError } = await supabase
      .from("room_participants")
      .insert({
        room_id: roomId,
        user_id: userId,
        joined_at: now,
        is_active: true,
      });
    logRoomWarning("participant-insert", insertError);
  } catch (err) {
    console.warn("[Rooms] Participant join error:", err);
  }
};

const deactivateParticipant = async (roomId: string, userId: string) => {
  try {
    const { error } = await supabase
      .from("room_participants")
      .update({ is_active: false, left_at: nowIso() })
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .eq("is_active", true);
    logRoomWarning("participant-leave", error);
  } catch (err) {
    console.warn("[Rooms] Participant leave error:", err);
  }
};

const setRoomActive = async (roomId: string, isActive: boolean) => {
  try {
    const { error } = await supabase
      .from("rooms")
      .update({ is_active: isActive, updated_at: nowIso() })
      .eq("id", roomId);
    logRoomWarning(isActive ? "activate" : "deactivate", error);
  } catch (err) {
    console.warn("[Rooms] Room update error:", err);
  }
};

export async function handleJoinRoom(
  ws: ServerWebSocket<WSData>,
  roomId: string,
  options?: { createIfMissing?: boolean },
) {
  const { userId } = ws.data;
  if (ws.data.roomId && ws.data.roomId !== roomId) {
    await handleLeaveRoom(ws);
  }

  const createIfMissing = options?.createIfMissing ?? false;
  const roomResult = await ensureRoomRecord(roomId, userId, createIfMissing);
  if (!roomResult.allowed) {
    sendJson(ws, { type: "error", message: "Room not found" });
    return;
  }

  ws.data.roomId = roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(userId);
  await upsertParticipantJoin(roomId, userId);

  sendJson(ws, {
    type: "room-joined",
    roomId,
    users: Array.from(rooms.get(roomId)!),
  });
  broadcastToRoom(
    roomId,
    { type: "room-user-joined", roomId, userId },
    userId,
  );
}

export async function handleLeaveRoom(ws: ServerWebSocket<WSData>) {
  const { userId, roomId } = ws.data;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) rooms.delete(roomId);
    else
      broadcastToRoom(
        roomId,
        { type: "room-user-left", roomId, userId },
        userId,
      );
  }
  await deactivateParticipant(roomId, userId);
  if (!rooms.has(roomId)) {
    await setRoomActive(roomId, false);
  }
  ws.data.roomId = undefined;
}

export async function removeUserFromRooms(userId: string) {
  for (const [roomId, room] of rooms) {
    if (!room.has(userId)) continue;
    room.delete(userId);
    if (room.size === 0) rooms.delete(roomId);
    else
      broadcastToRoom(
        roomId,
        { type: "room-user-left", roomId, userId },
        userId,
      );
    await deactivateParticipant(roomId, userId);
    if (!rooms.has(roomId)) {
      await setRoomActive(roomId, false);
    }
  }
}

export function isUserInAnyRoom(userId: string) {
  for (const room of rooms.values()) {
    if (room.has(userId)) return true;
  }
  return false;
}
