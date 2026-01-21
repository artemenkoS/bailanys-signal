import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "fs";

const CERT_PATH = process.env.TLS_CERT_PATH || "./certs/cert.pem";
const KEY_PATH = process.env.TLS_KEY_PATH || "./certs/key.pem";

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
  console.error("❌ ОШИБКА: Сертификаты не найдены в папке ./certs/");
  console.log("Сгенерируйте их командой:");
  console.log(
    'openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout ./certs/key.pem -out ./certs/cert.pem -subj "/CN=localhost"',
  );
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface WSData {
  userId: string;
  roomId?: string;
}

interface RegisterRequest {
  email: string;
  password: string;
  username: string;
  displayName?: string;
}

interface LoginRequest {
  email: string;
  password: string;
}

interface WebSocketMessage {
  type: string;
  roomId?: string;
  to?: string;
  callType?: string;
  receiverId?: string;
  callId?: string;
  duration?: number;
  [key: string]: any;
}

const users = new Map<string, ServerWebSocket<WSData>>();
const rooms = new Map<string, Set<string>>();

async function validateToken(token: string): Promise<string | null> {
  console.log("[Auth] Проверка токена...");
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error) {
      console.error("[Auth] Ошибка Supabase:", error.message);
      return null;
    }
    return user ? user.id : null;
  } catch (err) {
    console.error("[Auth] Системная ошибка:", err);
    return null;
  }
}

function broadcast(message: Record<string, any>, excludeUserId?: string) {
  const msg = JSON.stringify(message);
  for (const [id, ws] of users) {
    if (id !== excludeUserId) {
      ws.send(msg);
    }
  }
}

function broadcastToRoom(
  roomId: string,
  message: Record<string, any>,
  excludeUserId?: string,
) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(message);
  for (const userId of room) {
    if (userId !== excludeUserId) {
      const ws = users.get(userId);
      ws?.send(msg);
    }
  }
}

const routes = {
  "/api/register": async (req: Request) => {
    try {
      const body = (await req.json()) as RegisterRequest;
      const { email, password, username, displayName } = body;

      if (!email || !password || !username) {
        return new Response(JSON.stringify({ error: "Missing fields" }), {
          status: 400,
        });
      }

      const { data: existing } = await supabase
        .from("profiles")
        .select("username")
        .eq("username", username)
        .single();
      if (existing)
        return new Response(JSON.stringify({ error: "Username taken" }), {
          status: 409,
        });

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName || username } },
      });

      if (error) throw error;
      return new Response(JSON.stringify(data));
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
      });
    }
  },

  "/api/login": async (req: Request) => {
    try {
      const { email, password } = (await req.json()) as LoginRequest;
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error)
        return new Response(JSON.stringify({ error: error.message }), {
          status: 401,
        });

      await supabase
        .from("profiles")
        .update({ status: "online", last_seen: new Date().toISOString() })
        .eq("id", data.user.id);
      return new Response(JSON.stringify(data));
    } catch (err: any) {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
      });
    }
  },

  "/api/users": async (req: Request) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    const userId = token ? await validateToken(token) : null;
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const { data } = await supabase
      .from("profiles")
      .select("id, username, display_name, status, avatar_url")
      .eq("status", "online")
      .neq("id", userId);
    return new Response(JSON.stringify({ users: data || [] }));
  },
};

async function handleJoinRoom(ws: ServerWebSocket<WSData>, roomId: string) {
  const { userId } = ws.data;
  const { data: room } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();
  if (!room)
    return ws.send(
      JSON.stringify({ type: "error", message: "Room not found" }),
    );

  ws.data.roomId = roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(userId);

  ws.send(
    JSON.stringify({
      type: "room-joined",
      roomId,
      users: Array.from(rooms.get(roomId)!),
    }),
  );
  broadcastToRoom(roomId, { type: "user-joined", userId }, userId);
}

async function handleLeaveRoom(ws: ServerWebSocket<WSData>) {
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Запуск сервера с поддержкой TLS
serve<WSData>({
  port: process.env.PORT ?? 8080,

  // Добавляем TLS сертификаты
  tls: {
    cert: Bun.file(CERT_PATH),
    key: Bun.file(KEY_PATH),
  },

  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders });

    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token");
      const userId = token ? await validateToken(token) : null;
      if (!userId) return new Response("Unauthorized", { status: 401 });

      return server.upgrade(req, { data: { userId } })
        ? undefined
        : new Response("Upgrade failed", { status: 500 });
    }

    if (url.pathname in routes) {
      const res = await routes[url.pathname as keyof typeof routes](req);
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    sendPings: true,
    idleTimeout: 30,

    async open(ws) {
      const { userId } = ws.data;
      users.set(userId, ws);

      await supabase
        .from("profiles")
        .update({
          status: "online",
          last_seen: new Date().toISOString(),
        })
        .eq("id", userId);

      broadcast({ type: "user-connected", userId }, userId);
      console.log(`[WSS] Connected: ${userId}`);
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(message as string) as WebSocketMessage;

        if (
          ["offer", "answer", "ice-candidate", "hangup"].includes(data.type)
        ) {
          console.log(`[WSS] Signaling: ${data.type} to ${data.to}`);
          const target = users.get(data.to!);
          if (target) {
            target.send(JSON.stringify({ ...data, from: ws.data.userId }));
          }
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
            const receiver = users.get(data.receiverId!);
            if (receiver) {
              receiver.send(
                JSON.stringify({
                  type: "incoming-call",
                  from: ws.data.userId,
                  callType: data.callType,
                }),
              );
            }
            break;
        }
      } catch (e) {
        console.error("Message error:", e);
      }
    },

    async close(ws) {
      const { userId, roomId } = ws.data;
      users.delete(userId);
      if (roomId) await handleLeaveRoom(ws);

      await supabase
        .from("profiles")
        .update({
          status: "offline",
          last_seen: new Date().toISOString(),
        })
        .eq("id", userId);

      broadcast({ type: "user-disconnected", userId }, userId);
      console.log(`[WSS] Disconnected: ${userId}`);
    },
  },
});

console.log(
  `Secure Server running on https://localhost:${process.env.PORT ?? 8080}`,
);
