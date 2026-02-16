import { supabase } from './supabase';
import { normalizeAvatarUrl } from './storage';
import { MISSING_COLUMN_ERROR_CODE, MISSING_TABLE_ERROR_CODE, nowIso } from './routes/shared';

export const ROOM_MEMBER_ROLE_ADMIN = 'admin';
export const ROOM_MEMBER_ROLE_MEMBER = 'member';
export type RoomMemberRole = typeof ROOM_MEMBER_ROLE_ADMIN | typeof ROOM_MEMBER_ROLE_MEMBER;

const isMissingTableError = (error: any) => Boolean(error && error.code === MISSING_TABLE_ERROR_CODE);
const isMissingColumnError = (error: any) => Boolean(error && error.code === MISSING_COLUMN_ERROR_CODE);

export const getRoomMemberRole = async (roomId: string, userId: string) => {
  try {
    const { data, error } = await supabase
      .from('room_members')
      .select('role')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        return { supported: false, role: null } as const;
      }
      console.warn('[RoomMembers] Role lookup failed:', error.message ?? error);
      return { supported: true, role: null, error } as const;
    }
    return { supported: true, role: (data?.role as RoomMemberRole | null) ?? null } as const;
  } catch (err) {
    console.warn('[RoomMembers] Role lookup error:', err);
    return { supported: true, role: null, error: err } as const;
  }
};

export const isRoomAdmin = async (roomId: string, userId: string) => {
  const roleResult = await getRoomMemberRole(roomId, userId);
  if (roleResult.supported) {
    if (roleResult.error) return { ok: false, error: roleResult.error } as const;
    if (roleResult.role === ROOM_MEMBER_ROLE_ADMIN) return { ok: true } as const;

    const { data: room, error } = await supabase
      .from('rooms')
      .select('created_by')
      .eq('id', roomId)
      .maybeSingle();
    if (error) return { ok: false, error } as const;
    return { ok: room?.created_by === userId } as const;
  }

  const { data: room, error } = await supabase.from('rooms').select('created_by').eq('id', roomId).maybeSingle();
  if (error) return { ok: false, error } as const;
  return { ok: room?.created_by === userId } as const;
};

export const isRoomMember = async (roomId: string, userId: string) => {
  const roleResult = await getRoomMemberRole(roomId, userId);
  if (!roleResult.supported) {
    return { ok: true, supported: false } as const;
  }
  if (roleResult.error) {
    return { ok: false, supported: true, error: roleResult.error } as const;
  }
  return { ok: Boolean(roleResult.role), supported: true, role: roleResult.role } as const;
};

export const ensureRoomMember = async (roomId: string, userId: string, role: RoomMemberRole, addedBy?: string | null) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('room_members')
      .select('role')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle();
    if (fetchError) {
      if (isMissingTableError(fetchError) || isMissingColumnError(fetchError)) return { ok: false, supported: false } as const;
      console.warn('[RoomMembers] Fetch failed:', fetchError.message ?? fetchError);
      return { ok: false, supported: true, error: fetchError } as const;
    }
    if (existing) return { ok: true, supported: true, role: existing.role as RoomMemberRole } as const;

    const payload = {
      room_id: roomId,
      user_id: userId,
      role,
      added_by: addedBy ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const { error: insertError } = await supabase.from('room_members').insert(payload);
    if (insertError) {
      if (isMissingTableError(insertError) || isMissingColumnError(insertError)) return { ok: false, supported: false } as const;
      console.warn('[RoomMembers] Insert failed:', insertError.message ?? insertError);
      return { ok: false, supported: true, error: insertError } as const;
    }
    return { ok: true, supported: true, role } as const;
  } catch (err) {
    console.warn('[RoomMembers] Insert error:', err);
    return { ok: false, supported: true, error: err } as const;
  }
};

export const addRoomMember = async (roomId: string, userId: string, role: RoomMemberRole, addedBy?: string | null) => {
  return ensureRoomMember(roomId, userId, role, addedBy);
};

export const setRoomMemberRole = async (roomId: string, userId: string, role: RoomMemberRole) => {
  try {
    const { data: updated, error } = await supabase
      .from('room_members')
      .update({ role, updated_at: nowIso() })
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .select('room_id, user_id, role')
      .maybeSingle();
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) return { ok: false, supported: false } as const;
      console.warn('[RoomMembers] Role update failed:', error.message ?? error);
      return { ok: false, supported: true, error } as const;
    }
    if (!updated) return { ok: false, supported: true, error: new Error('Member not found') } as const;
    return { ok: true, supported: true, member: updated } as const;
  } catch (err) {
    console.warn('[RoomMembers] Role update error:', err);
    return { ok: false, supported: true, error: err } as const;
  }
};

export const removeRoomMember = async (roomId: string, userId: string) => {
  try {
    const { error } = await supabase.from('room_members').delete().eq('room_id', roomId).eq('user_id', userId);
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) return { ok: false, supported: false } as const;
      console.warn('[RoomMembers] Delete failed:', error.message ?? error);
      return { ok: false, supported: true, error } as const;
    }
    return { ok: true, supported: true } as const;
  } catch (err) {
    console.warn('[RoomMembers] Delete error:', err);
    return { ok: false, supported: true, error: err } as const;
  }
};

export const listRoomMembers = async (roomId: string) => {
  try {
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id, created_by')
      .eq('id', roomId)
      .maybeSingle();
    if (roomError) return { ok: false, error: roomError } as const;
    if (!room) return { ok: false, error: new Error('Room not found') } as const;

    const { data: members, error: membersError } = await supabase
      .from('room_members')
      .select('user_id, role, created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });

    if (membersError) {
      if (isMissingTableError(membersError) || isMissingColumnError(membersError)) {
        return { ok: false, unsupported: true, error: membersError } as const;
      }
      return { ok: false, error: membersError } as const;
    }

    const memberIds = (members || []).map((member) => member.user_id).filter(Boolean);
    const profilesById = new Map<string, any>();

    if (memberIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, username, display_name, status, avatar_url, last_seen')
        .in('id', memberIds);
      if (profilesError) return { ok: false, error: profilesError } as const;

      (profiles || []).forEach((profile) => {
        profilesById.set(profile.id, {
          ...profile,
          avatar_url: normalizeAvatarUrl(profile.avatar_url),
        });
      });
    }

    const normalized = (members || [])
      .map((member) => ({
        user: profilesById.get(member.user_id) ?? null,
        role: member.role as RoomMemberRole,
        isCreator: room.created_by === member.user_id,
        created_at: member.created_at ?? null,
      }))
      .filter((entry) => entry.user);

    return { ok: true, members: normalized } as const;
  } catch (err) {
    console.warn('[RoomMembers] List error:', err);
    return { ok: false, error: err } as const;
  }
};
