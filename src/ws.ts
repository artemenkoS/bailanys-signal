import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";
import { users, rooms, roomChats } from "./state";

export function sendJson(
  ws: ServerWebSocket<WSData>,
  message: Record<string, any>,
) {
  ws.send(JSON.stringify(message));
}

export function sendToUser(userId: string, message: Record<string, any>) {
  const sockets = users.get(userId);
  if (!sockets || sockets.size === 0) return;
  for (const ws of sockets) {
    sendJson(ws, message);
  }
}

export function broadcast(
  message: Record<string, any>,
  excludeUserId?: string,
) {
  for (const [id, sockets] of users) {
    if (id === excludeUserId) continue;
    for (const ws of sockets) {
      sendJson(ws, message);
    }
  }
}

export function broadcastToRoom(
  roomId: string,
  message: Record<string, any>,
  excludeUserId?: string,
) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const userId of room) {
    if (userId !== excludeUserId) {
      sendToUser(userId, message);
    }
  }
}

export function broadcastToRoomChat(
  roomId: string,
  message: Record<string, any>,
  excludeUserId?: string,
) {
  const room = roomChats.get(roomId);
  if (!room) return;
  for (const userId of room) {
    if (userId !== excludeUserId) {
      sendToUser(userId, message);
    }
  }
}
