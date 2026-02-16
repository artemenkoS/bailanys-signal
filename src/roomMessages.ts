import { roomMessagesByRoom } from './state';
import { supabase } from './supabase';
import { MISSING_COLUMN_ERROR_CODE, MISSING_TABLE_ERROR_CODE, ROOM_MESSAGE_LIMIT } from './routes/shared';
import { decryptChatBody, encryptChatBody } from './chatCrypto';

export type RoomMessage = {
  id: string;
  room_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

const isMissingTableError = (error: any) => Boolean(error && error.code === MISSING_TABLE_ERROR_CODE);

const isMissingColumnError = (error: any) => Boolean(error && error.code === MISSING_COLUMN_ERROR_CODE);

const storeRoomMessageFallback = (roomId: string, message: RoomMessage) => {
  const existing = roomMessagesByRoom.get(roomId) ?? [];
  existing.push(message);
  if (existing.length > ROOM_MESSAGE_LIMIT) {
    existing.splice(0, existing.length - ROOM_MESSAGE_LIMIT);
  }
  roomMessagesByRoom.set(roomId, existing);
};

const getRoomMessagesFallback = (roomId: string): RoomMessage[] => {
  return roomMessagesByRoom.get(roomId) ?? [];
};

export const storeRoomMessage = async (roomId: string, message: RoomMessage) => {
  try {
    const payload = {
      id: message.id,
      room_id: roomId,
      sender_id: message.sender_id,
      body: encryptChatBody(message.body),
      created_at: message.created_at,
    };
    const { error } = await supabase.from('room_messages').insert(payload);
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        storeRoomMessageFallback(roomId, message);
        return;
      }
      console.warn('[RoomMessages] Insert failed:', error.message ?? error);
      storeRoomMessageFallback(roomId, message);
    }
  } catch (err) {
    console.warn('[RoomMessages] Insert error:', err);
    storeRoomMessageFallback(roomId, message);
  }
};

export const getRoomMessages = async (roomId: string): Promise<RoomMessage[]> => {
  try {
    const { data, error } = await supabase
      .from('room_messages')
      .select('id, room_id, sender_id, body, created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(ROOM_MESSAGE_LIMIT);
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        return getRoomMessagesFallback(roomId);
      }
      console.warn('[RoomMessages] Load failed:', error.message ?? error);
      return getRoomMessagesFallback(roomId);
    }
    try {
      return (data ?? [])
        .slice()
        .reverse()
        .map((message) => ({
          ...message,
          body: decryptChatBody(message.body),
        })) as RoomMessage[];
    } catch (err) {
      console.warn('[RoomMessages] Decrypt failed:', err);
      return getRoomMessagesFallback(roomId);
    }
  } catch (err) {
    console.warn('[RoomMessages] Load error:', err);
    return getRoomMessagesFallback(roomId);
  }
};

export const canAccessRoomChat = async (
  userId: string,
  roomId: string,
): Promise<{ ok: boolean; error?: string }> => {
  try {
    const { data, error } = await supabase
      .from('rooms')
      .select('id, is_private, created_by')
      .eq('id', roomId)
      .maybeSingle();
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        return { ok: true };
      }
      console.warn('[RoomMessages] Room lookup failed:', error.message ?? error);
      return { ok: false, error: 'Room error' };
    }
    if (!data) return { ok: false, error: 'Room not found' };
    const isPrivate = Boolean((data as any).is_private);
    const ownerId = (data as any).created_by;
    if (isPrivate && ownerId !== userId) {
      return { ok: false, error: 'Room access denied' };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[RoomMessages] Room access error:', err);
    return { ok: false, error: 'Room error' };
  }
};

export const clearRoomMessages = (roomId: string) => {
  roomMessagesByRoom.delete(roomId);
};
