import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";
import { supabase } from "./supabase";
import { rooms } from "./state";
import { broadcastToRoom, sendJson } from "./ws";

export async function handleJoinRoom(
  ws: ServerWebSocket<WSData>,
  roomId: string,
) {
  const { userId } = ws.data;
  const { data: room } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();
  if (!room) return sendJson(ws, { type: "error", message: "Room not found" });

  ws.data.roomId = roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(userId);

  sendJson(ws, {
    type: "room-joined",
    roomId,
    users: Array.from(rooms.get(roomId)!),
  });
  broadcastToRoom(roomId, { type: "user-joined", userId }, userId);
}

export async function handleLeaveRoom(ws: ServerWebSocket<WSData>) {
  const { userId, roomId } = ws.data;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) rooms.delete(roomId);
    else broadcastToRoom(roomId, { type: "user-left", userId }, userId);
  }
  ws.data.roomId = undefined;
}

export function removeUserFromRooms(userId: string) {
  for (const [roomId, room] of rooms) {
    if (!room.has(userId)) continue;
    room.delete(userId);
    if (room.size === 0) rooms.delete(roomId);
    else broadcastToRoom(roomId, { type: "user-left", userId }, userId);
  }
}
