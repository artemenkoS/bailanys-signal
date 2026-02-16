import { createHmac, randomUUID } from 'node:crypto';

const DEFAULT_INVITE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIN_INVITE_TOKEN_TTL_SECONDS = 300;
const MAX_INVITE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const resolveInviteTokenSecret = () => {
  const secret = process.env.ROOM_INVITE_TOKEN_SECRET;
  if (secret && secret.trim()) return secret.trim();
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dev-room-invite-secret';
  console.warn('[RoomInvite] ROOM_INVITE_TOKEN_SECRET is not set. Falling back to server secret.');
  return fallback;
};

const INVITE_TOKEN_SECRET = resolveInviteTokenSecret();

export interface RoomInviteTokenPayload {
  v: number;
  roomId: string;
  tokenId: string;
  iat: number;
  exp: number;
}

const base64UrlEncode = (value: string | Buffer) => Buffer.from(value).toString('base64url');

const base64UrlDecode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const sign = (payloadB64: string) => createHmac('sha256', INVITE_TOKEN_SECRET).update(payloadB64).digest('base64url');

export const resolveRoomInviteTtl = (requestedTtl?: number | null) => {
  const base = Number.isFinite(requestedTtl) ? Number(requestedTtl) : null;
  const envDefault = Number.parseInt(
    process.env.ROOM_INVITE_TTL_SECONDS ?? String(DEFAULT_INVITE_TOKEN_TTL_SECONDS),
    10
  );
  const fallback = Number.isFinite(envDefault) ? envDefault : DEFAULT_INVITE_TOKEN_TTL_SECONDS;
  const ttl = base && base > 0 ? base : fallback;
  return Math.min(MAX_INVITE_TOKEN_TTL_SECONDS, Math.max(MIN_INVITE_TOKEN_TTL_SECONDS, ttl));
};

export const createRoomInviteToken = (roomId: string, options?: { ttlSeconds?: number }) => {
  const ttlSeconds = resolveRoomInviteTtl(options?.ttlSeconds);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: RoomInviteTokenPayload = {
    v: 1,
    roomId,
    tokenId: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64);
  return { token: `${payloadB64}.${signature}`, payload };
};

export const verifyRoomInviteToken = (token?: string | null) => {
  if (!token) return null;
  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;
  const expected = sign(payloadB64);
  if (expected !== signature) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as RoomInviteTokenPayload;
    if (!payload || payload.v !== 1) return null;
    if (!payload.roomId || !payload.tokenId) return null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
};
