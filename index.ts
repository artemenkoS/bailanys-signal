import { serve } from "bun";
import { existsSync } from "node:fs";
import type { WebSocketMessage, WSData } from "./src/types";
import { routes } from "./src/routes";
import { errorResponse, withCors } from "./src/http";
import { setPresence, touchLastSeen, validateToken } from "./src/supabase";
import { users, activeCalls } from "./src/state";
import { broadcast, sendJson, sendToUser } from "./src/ws";
import {
  handleJoinRoom,
  handleLeaveRoom,
  removeUserFromRooms,
} from "./src/rooms";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS } from "./src/presence";

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
  if (activeCalls.has(userId)) return "in-call";
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
    if (req.method === "OPTIONS") return withCors(new Response(null));

    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token");
      const userId = token ? await validateToken(token) : null;
      if (!userId) return withCors(errorResponse("Unauthorized", 401));

      const upgraded = server.upgrade(req, { data: { userId } });
      return upgraded
        ? undefined
        : withCors(errorResponse("Upgrade failed", 500));
    }

    const handler = routes[url.pathname];
    if (handler) {
      const res = await handler(req);
      return withCors(res);
    }

    return withCors(errorResponse("Not found", 404));
  },

  websocket: {
    sendPings: true,
    idleTimeout: 30,

    async open(ws) {
      const { userId } = ws.data;
      ws.data.lastPongAt = Date.now();
      let sockets = users.get(userId);
      const isFirstConnection = !sockets || sockets.size === 0;
      if (!sockets) {
        sockets = new Set();
        users.set(userId, sockets);
      }
      sockets.add(ws);

      if (isFirstConnection) {
        const status = resolvePresenceStatus(userId);
        await updateUserStatus(userId, status);
        broadcast({ type: "user-connected", userId }, userId);
      }
      console.log(`[WSS] Connected: ${userId}`);
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(message as string) as WebSocketMessage;
        ws.data.lastPongAt = Date.now();

        if (data.type === "presence-pong") {
          void touchLastSeen([ws.data.userId]);
          return;
        }

        if (
          ["offer", "answer", "ice-candidate", "hangup"].includes(data.type)
        ) {
          const from = ws.data.userId;
          const to = data.to;
          if (!to) return;

          if (data.type === "offer") {
            if (activeCalls.has(to) || activeCalls.has(from)) {
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

        switch (data.type) {
          case "join-room":
            await handleJoinRoom(ws, data.roomId!);
            break;
          case "leave-room":
            await handleLeaveRoom(ws);
            break;
          case "start-call":
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
      const sockets = users.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) users.delete(userId);
      }
      const isLastConnection = !sockets || sockets.size === 0;
      if (isLastConnection) {
        removeUserFromRooms(userId);
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
      console.log(`[WSS] Disconnected: ${userId}`);
    },
  },
});

console.log(
  `Server is running on ${tls ? "https" : "http"}://localhost:${port}`,
);
