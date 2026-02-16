import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";
import { supabase } from "./supabase";
import { rooms } from "./state";
import { clearRoomMessages, getRoomMessages } from "./roomMessages";
import { broadcastToRoom, sendJson } from "./ws";

const MISSING_TABLE_ERROR_CODE = "42P01";
const MISSING_COLUMN_ERROR_CODE = "42703";

const nowIso = () => new Date().toISOString();

const isMissingTableError = (error: any) =>
  Boolean(error && error.code === MISSING_TABLE_ERROR_CODE);

const isMissingColumnError = (error: any) =>
  Boolean(error && error.code === MISSING_COLUMN_ERROR_CODE);

const normalizeRoomName = (name?: string | null) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
};

const hashRoomPassword = async (password?: string | null) => {
  const value = password?.trim();
  if (!value) return null;
  try {
    return await Bun.password.hash(value);
  } catch (err) {
    console.warn("[Rooms] Password hash failed:", err);
    return null;
  }
};

const verifyRoomPassword = async (password: string, hash: string) => {
  try {
    return await Bun.password.verify(password, hash);
  } catch (err) {
    console.warn("[Rooms] Password verify failed:", err);
    return false;
  }
};

const logRoomWarning = (context: string, error: any) => {
  if (!error) return;
  if (isMissingTableError(error)) {
    console.warn(`[Rooms] Table missing for ${context}, skipping.`);
    return;
  }
  if (isMissingColumnError(error)) {
    console.warn(`[Rooms] Column missing for ${context}, skipping.`);
    return;
  }
  console.warn(`[Rooms] ${context} failed:`, error.message ?? error);
};

const ensureRoomRecord = async (
  roomId: string,
  userId: string,
  createIfMissing: boolean,
  options?: { name?: string; isPrivate?: boolean; password?: string },
) => {
  try {
    const { data: room, error } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .maybeSingle();
    if (error) {
      logRoomWarning("lookup", error);
      return { room: null, allowed: true };
    }
    if (!room) {
      if (!createIfMissing) return { room: null, allowed: false };
      const roomName = normalizeRoomName(options?.name);
      if (!roomName) {
        return { room: null, allowed: false, error: "name-required" };
      }
      const isPrivate = Boolean(options?.isPrivate);
      if (isPrivate && !options?.password) {
        return { room: null, allowed: false, error: "password-required" };
      }
      const passwordHash = isPrivate
        ? await hashRoomPassword(options?.password)
        : null;
      if (isPrivate && !passwordHash) {
        return { room: null, allowed: false, error: "password-hash-failed" };
      }
      const payload: Record<string, any> = {
        id: roomId,
        name: roomName,
        room_type: "group",
        created_by: userId,
        is_active: true,
        max_participants: null,
        updated_at: nowIso(),
      };
      if (isPrivate) {
        payload.is_private = true;
        payload.password_hash = passwordHash;
      }
      const { error: createError } = await supabase
        .from("rooms")
        .insert(payload);
      if (createError) {
        logRoomWarning("create", createError);
        if (isMissingColumnError(createError)) {
          return {
            room: null,
            allowed: false,
            error: "privacy-unsupported",
          };
        }
        return { room: null, allowed: false, error: "server" };
      }
      return { room: null, allowed: true, created: true };
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
  options?: {
    createIfMissing?: boolean;
    name?: string;
    isPrivate?: boolean;
    password?: string;
    actor?: {
      isGuest?: boolean;
      allowPrivateBypass?: boolean;
    };
  },
) {
  const { userId } = ws.data;
  const isGuest = Boolean(options?.actor?.isGuest);
  const allowPrivateBypass = Boolean(options?.actor?.allowPrivateBypass);
  if (ws.data.roomId && ws.data.roomId !== roomId) {
    await handleLeaveRoom(ws, { skipPresence: isGuest });
  }

  const createIfMissing = !isGuest && (options?.createIfMissing ?? false);
  const roomResult = await ensureRoomRecord(roomId, userId, createIfMissing, {
    name: isGuest ? undefined : options?.name,
    isPrivate: isGuest ? undefined : options?.isPrivate,
    password: isGuest ? undefined : options?.password,
  });
  if (isGuest && !roomResult.room && !rooms.has(roomId)) {
    sendJson(ws, { type: "error", message: "Room not found" });
    return;
  }
  if (!roomResult.allowed) {
    const errorMessage = (() => {
      switch (roomResult.error) {
        case "password-required":
          return "Room password required";
        case "password-hash-failed":
          return "Room password required";
        case "name-required":
          return "Room name required";
        case "privacy-unsupported":
          return "Room privacy unsupported";
        case "server":
          return "Room error";
        default:
          return "Room not found";
      }
    })();
    sendJson(ws, { type: "error", message: errorMessage });
    return;
  }

  if (roomResult.room && roomResult.room.is_active === false) {
    if (roomResult.room.created_by !== userId) {
      sendJson(ws, { type: "error", message: "Room inactive" });
      return;
    }
    await setRoomActive(roomId, true);
  }

  if (isGuest) {
    const activeRoom = rooms.get(roomId);
    const hasAuthenticated = activeRoom
      ? Array.from(activeRoom).some((id) => !id.startsWith("guest:"))
      : false;
    if (!hasAuthenticated) {
      sendJson(ws, { type: "error", message: "Room inactive" });
      return;
    }
  }

  const maxParticipants = Number(roomResult.room?.max_participants);
  if (Number.isFinite(maxParticipants) && maxParticipants > 0) {
    const currentSize = rooms.get(roomId)?.size ?? 0;
    if (currentSize >= maxParticipants) {
      sendJson(ws, { type: "error", message: "Room is full" });
      return;
    }
  }

  if (roomResult.room?.is_private && !(isGuest && allowPrivateBypass)) {
    const password = options?.password?.trim() ?? "";
    if (!password) {
      sendJson(ws, { type: "error", message: "Room password required" });
      return;
    }
    const passwordHash = roomResult.room?.password_hash;
    if (!passwordHash) {
      sendJson(ws, { type: "error", message: "Invalid room password" });
      return;
    }
    const ok = await verifyRoomPassword(password, passwordHash);
    if (!ok) {
      sendJson(ws, { type: "error", message: "Invalid room password" });
      return;
    }
  }

  ws.data.roomId = roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(userId);
  if (!isGuest) {
    await upsertParticipantJoin(roomId, userId);
  }
  await setRoomActive(roomId, true);

  sendJson(ws, {
    type: "room-joined",
    roomId,
    users: Array.from(rooms.get(roomId)!),
    selfId: userId,
  });
  const roomMessages = await getRoomMessages(roomId);
  if (roomMessages.length > 0) {
    sendJson(ws, {
      type: "room-messages",
      roomId,
      messages: roomMessages,
    });
  }
  broadcastToRoom(
    roomId,
    { type: "room-user-joined", roomId, userId },
    userId,
  );
}

export async function handleLeaveRoom(
  ws: ServerWebSocket<WSData>,
  options?: { skipPresence?: boolean },
) {
  const { userId, roomId } = ws.data;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      rooms.delete(roomId);
      clearRoomMessages(roomId);
    }
    else
      broadcastToRoom(
        roomId,
        { type: "room-user-left", roomId, userId },
        userId,
      );
  }
  if (!options?.skipPresence) {
    await deactivateParticipant(roomId, userId);
  }
  if (!rooms.has(roomId)) {
    await setRoomActive(roomId, false);
  }
  ws.data.roomId = undefined;
}

export async function removeUserFromRooms(
  userId: string,
  options?: { skipPresence?: boolean },
) {
  for (const [roomId, room] of rooms) {
    if (!room.has(userId)) continue;
    room.delete(userId);
    if (room.size === 0) {
      rooms.delete(roomId);
      clearRoomMessages(roomId);
    }
    else
      broadcastToRoom(
        roomId,
        { type: "room-user-left", roomId, userId },
        userId,
      );
    if (!options?.skipPresence) {
      await deactivateParticipant(roomId, userId);
    }
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
