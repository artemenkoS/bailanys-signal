import { serve } from "bun";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WebSocketMessage, WSData } from "./src/types";
import { routes } from "./src/routes";
import { errorResponse, withCors } from "./src/http";
import { setPresence, touchLastSeen, validateToken } from "./src/supabase";
import { users, activeCalls, rooms, roomChats } from "./src/state";
import {
  broadcast,
  broadcastToRoom,
  broadcastToRoomChat,
  sendJson,
  sendToUser,
} from "./src/ws";
import { verifyGuestToken } from "./src/guestTokens";
import {
  handleJoinRoom,
  handleLeaveRoom,
  isUserInAnyRoom,
  removeUserFromRooms,
} from "./src/rooms";
import {
  canAccessRoomChat,
  getRoomMessages,
  storeRoomMessage,
} from "./src/roomMessages";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS } from "./src/presence";
import { ROOM_MESSAGE_MAX_LENGTH, nowIso } from "./src/routes/shared";

const port = process.env.PORT ?? 8080;
const tlsEnabled = process.env.TLS_ENABLED === "true";
const certPath = process.env.TLS_CERT_PATH ?? "certs/cert.pem";
const keyPath = process.env.TLS_KEY_PATH ?? "certs/key.pem";
const shouldAttemptTls =
  tlsEnabled || process.env.TLS_CERT_PATH || process.env.TLS_KEY_PATH;
const hasTlsFiles = existsSync(certPath) && existsSync(keyPath);
const tls =
  shouldAttemptTls && hasTlsFiles
    ? { cert: Bun.file(certPath), key: Bun.file(keyPath) }
    : undefined;
const WS_OPEN_STATE = 1;
type PresenceStatus = "online" | "offline" | "in-call";

const getConnectionCount = (userId: string) => users.get(userId)?.size ?? 0;

const resolvePresenceStatus = (userId: string): PresenceStatus => {
  if (activeCalls.has(userId) || isUserInAnyRoom(userId)) return "in-call";
  return getConnectionCount(userId) > 0 ? "online" : "offline";
};

const updateUserStatus = async (userId: string, status: PresenceStatus) => {
  await setPresence(userId, status);
  broadcast({ type: "user-status", userId, status });
};

if (shouldAttemptTls && !hasTlsFiles) {
  console.warn(
    "[TLS] Enabled but cert/key files not found. Check TLS_CERT_PATH/TLS_KEY_PATH.",
  );
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, sockets] of users) {
    for (const ws of sockets) {
      const lastPongAt = ws.data.lastPongAt ?? 0;
      if (now - lastPongAt > PRESENCE_TTL_MS) {
        console.warn(`[Presence] Timeout: ${userId}`);
        ws.close(4001, "Presence timeout");
        continue;
      }
      if (ws.readyState === WS_OPEN_STATE) {
        sendJson(ws, { type: "presence-check", ts: now });
      }
    }
  }
}, PRESENCE_HEARTBEAT_MS);

serve<WSData>({
  port,
  hostname: "0.0.0.0",
  ...(tls ? { tls } : {}),

  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return withCors(new Response(null), req);

    if (url.pathname === "/ws") {
      const guestToken = url.searchParams.get("guest");
      if (guestToken) {
        const guestPayload = verifyGuestToken(guestToken);
        if (!guestPayload) {
          return withCors(errorResponse("Unauthorized", 401), req);
        }
        const guestIdParam = url.searchParams.get("guestId")?.trim() ?? "";
        const guestId =
          guestIdParam.startsWith("guest:") && guestIdParam.length <= 128
            ? guestIdParam
            : `guest:${randomUUID()}`;
        const upgraded = server.upgrade(req, {
          data: {
            userId: guestId,
            isGuest: true,
            guestRoomId: guestPayload.roomId,
            guestAllowPrivate: guestPayload.allowPrivate,
          },
        });
        return upgraded
          ? undefined
          : withCors(errorResponse("Upgrade failed", 500), req);
      }

      const token = url.searchParams.get("token");
      const userId = token ? await validateToken(token) : null;
      if (!userId) return withCors(errorResponse("Unauthorized", 401), req);

      const upgraded = server.upgrade(req, { data: { userId } });
      return upgraded
        ? undefined
        : withCors(errorResponse("Upgrade failed", 500), req);
    }

    const handler = routes[url.pathname];
    if (handler) {
      const res = await handler(req);
      return withCors(res, req);
    }

    return withCors(errorResponse("Not found", 404), req);
  },

  websocket: {
    sendPings: true,
    idleTimeout: 30,

    async open(ws) {
      const { userId } = ws.data;
      const isGuest = Boolean(ws.data.isGuest);
      ws.data.lastPongAt = Date.now();
      let sockets = users.get(userId);
      const isFirstConnection = !sockets || sockets.size === 0;
      if (!sockets) {
        sockets = new Set();
        users.set(userId, sockets);
      }
      sockets.add(ws);

      if (isFirstConnection && !isGuest) {
        const status = resolvePresenceStatus(userId);
        await updateUserStatus(userId, status);
        broadcast({ type: "user-connected", userId }, userId);
      }
      if (isGuest && ws.data.guestRoomId) {
        await handleJoinRoom(ws, ws.data.guestRoomId, {
          actor: {
            isGuest: true,
            allowPrivateBypass: Boolean(ws.data.guestAllowPrivate),
          },
        });
      }
      console.log(`[WSS] Connected: ${userId}`);
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(message as string) as WebSocketMessage;
        const isGuest = Boolean(ws.data.isGuest);
        ws.data.lastPongAt = Date.now();

        if (data.type === "presence-pong") {
          if (!isGuest) {
            void touchLastSeen([ws.data.userId]);
          }
          return;
        }

        if (
          ["offer", "answer", "ice-candidate", "hangup", "screen-share"].includes(
            data.type,
          )
        ) {
          if (isGuest) return;
          const from = ws.data.userId;
          const to = data.to;
          if (!to) return;

          if (data.type === "offer") {
            if (
              activeCalls.has(to) ||
              activeCalls.has(from) ||
              isUserInAnyRoom(to) ||
              isUserInAnyRoom(from)
            ) {
              sendToUser(from, {
                type: "hangup",
                from: to,
                reason: "rejected",
              });
              return;
            }
          }

          if (data.type === "answer") {
            activeCalls.set(from, to);
            activeCalls.set(to, from);
            void updateUserStatus(from, "in-call");
            void updateUserStatus(to, "in-call");
          }

          if (data.type === "hangup") {
            const peerId = activeCalls.get(from) ?? to;
            activeCalls.delete(from);
            if (peerId) activeCalls.delete(peerId);

            const fromStatus = resolvePresenceStatus(from);
            void updateUserStatus(from, fromStatus);
            if (peerId) {
              const peerStatus = resolvePresenceStatus(peerId);
              void updateUserStatus(peerId, peerStatus);
            }
          }

          console.log(`[WSS] Signaling: ${data.type} to ${to}`);
          sendToUser(to, { ...data, from });
          return;
        }

        if (data.type === "typing") {
          if (isGuest) return;
          const from = ws.data.userId;
          const to = typeof data.to === "string" ? data.to : "";
          const isTyping = Boolean(data.isTyping);
          if (!to) return;
          sendToUser(to, { type: "typing", from, isTyping });
          return;
        }

        if (["room-offer", "room-answer", "room-ice"].includes(data.type)) {
          const from = ws.data.userId;
          const to = data.to;
          const roomId = data.roomId;
          if (!to || !roomId) return;
          const room = rooms.get(roomId);
          if (!room || !room.has(from) || !room.has(to)) return;
          sendToUser(to, { ...data, from });
          return;
        }

        if (data.type === "join-room-chat") {
          const roomId = typeof data.roomId === "string" ? data.roomId : "";
          if (!roomId) return;
          const access = await canAccessRoomChat(ws.data.userId, roomId);
          if (!access.ok) {
            sendJson(ws, {
              type: "error",
              message: access.error ?? "Room access denied",
            });
            return;
          }
          if (!roomChats.has(roomId)) roomChats.set(roomId, new Set());
          roomChats.get(roomId)!.add(ws.data.userId);
          if (!ws.data.chatRooms) ws.data.chatRooms = new Set();
          ws.data.chatRooms.add(roomId);

          const history = await getRoomMessages(roomId);
          sendJson(ws, { type: "room-messages", roomId, messages: history });
          return;
        }

        if (data.type === "leave-room-chat") {
          const roomId = typeof data.roomId === "string" ? data.roomId : "";
          if (!roomId) return;
          const room = roomChats.get(roomId);
          if (room) {
            room.delete(ws.data.userId);
            if (room.size === 0) roomChats.delete(roomId);
          }
          ws.data.chatRooms?.delete(roomId);
          return;
        }

        if (data.type === "room-message") {
          const from = ws.data.userId;
          const roomId = typeof data.roomId === "string" ? data.roomId : "";
          if (!roomId) return;
          const access = await canAccessRoomChat(from, roomId);
          if (!access.ok) {
            sendJson(ws, {
              type: "error",
              message: access.error ?? "Room access denied",
            });
            return;
          }
          const body = typeof data.body === "string" ? data.body.trim() : "";
          if (!body) return;
          if (body.length > ROOM_MESSAGE_MAX_LENGTH) {
            sendJson(ws, { type: "error", message: "Message too long" });
            return;
          }
          const messagePayload = {
            id: crypto.randomUUID(),
            room_id: roomId,
            sender_id: from,
            body,
            created_at: nowIso(),
          };
          await storeRoomMessage(roomId, messagePayload);
          broadcastToRoomChat(roomId, {
            type: "room-message",
            roomId,
            message: messagePayload,
          });
          return;
        }

        switch (data.type) {
          case "join-room":
            if (isGuest) {
              break;
            }
            if (!data.roomId) {
              sendJson(ws, { type: "error", message: "Room not found" });
              break;
            }
            await handleJoinRoom(ws, data.roomId, {
              createIfMissing: Boolean(data.create),
              name: data.name,
              isPrivate: data.isPrivate,
              password: data.password,
            });
            void updateUserStatus(
              ws.data.userId,
              resolvePresenceStatus(ws.data.userId),
            );
            break;
          case "leave-room":
            await handleLeaveRoom(ws, { skipPresence: isGuest });
            if (!isGuest) {
              void updateUserStatus(
                ws.data.userId,
                resolvePresenceStatus(ws.data.userId),
              );
            }
            break;
          case "start-call":
            if (isGuest) break;
            sendToUser(data.receiverId!, {
              type: "incoming-call",
              from: ws.data.userId,
              callType: data.callType,
            });
            break;
        }
      } catch (e) {
        console.error("Message error:", e);
      }
    },

    async close(ws) {
      const { userId } = ws.data;
      const isGuest = Boolean(ws.data.isGuest);
      const sockets = users.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) users.delete(userId);
      }
      const isLastConnection = !sockets || sockets.size === 0;
      if (isLastConnection) {
        await removeUserFromRooms(userId, { skipPresence: isGuest });
        if (ws.data.chatRooms) {
          for (const roomId of ws.data.chatRooms) {
            const room = roomChats.get(roomId);
            if (room) {
              room.delete(userId);
              if (room.size === 0) roomChats.delete(roomId);
            }
          }
          ws.data.chatRooms.clear();
        }
        if (!isGuest) {
          const peerId = activeCalls.get(userId);
          if (peerId) {
            activeCalls.delete(userId);
            activeCalls.delete(peerId);
            const peerStatus = resolvePresenceStatus(peerId);
            void updateUserStatus(peerId, peerStatus);
            sendToUser(peerId, {
              type: "hangup",
              from: userId,
              reason: "ended",
            });
          }
          await updateUserStatus(userId, "offline");
          broadcast({ type: "user-disconnected", userId }, userId);
        }
      }
      console.log(`[WSS] Disconnected: ${userId}`);
    },
  },
});

console.log(
  `Server is running on ${tls ? "https" : "http"}://localhost:${port}`,
);
