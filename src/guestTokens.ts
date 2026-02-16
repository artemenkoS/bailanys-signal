import { createHmac } from "node:crypto";

const DEFAULT_GUEST_TOKEN_TTL_SECONDS = 300;
const MIN_GUEST_TOKEN_TTL_SECONDS = 300;
const MAX_GUEST_TOKEN_TTL_SECONDS = 86_400;

const resolveGuestTokenSecret = () => {
  const secret = process.env.GUEST_TOKEN_SECRET;
  if (secret && secret.trim()) return secret.trim();
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dev-guest-secret";
  console.warn(
    "[Guest] GUEST_TOKEN_SECRET is not set. Falling back to server secret.",
  );
  return fallback;
};

const GUEST_TOKEN_SECRET = resolveGuestTokenSecret();

export interface GuestTokenPayload {
  v: number;
  roomId: string;
  guestId?: string;
  iat: number;
  exp: number;
  allowPrivate: boolean;
}

const base64UrlEncode = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

const base64UrlDecode = (value: string) =>
  Buffer.from(value, "base64url").toString("utf8");

const sign = (payloadB64: string) =>
  createHmac("sha256", GUEST_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");

export const resolveGuestTokenTtl = (requestedTtl?: number | null) => {
  const base = Number.isFinite(requestedTtl) ? Number(requestedTtl) : null;
  const envDefault = Number.parseInt(
    process.env.GUEST_LINK_TTL_SECONDS ??
      String(DEFAULT_GUEST_TOKEN_TTL_SECONDS),
    10,
  );
  const fallback = Number.isFinite(envDefault)
    ? envDefault
    : DEFAULT_GUEST_TOKEN_TTL_SECONDS;
  const ttl = base && base > 0 ? base : fallback;
  return Math.min(
    MAX_GUEST_TOKEN_TTL_SECONDS,
    Math.max(MIN_GUEST_TOKEN_TTL_SECONDS, ttl),
  );
};

export const createGuestToken = (
  roomId: string,
  options?: { ttlSeconds?: number; allowPrivate?: boolean },
) => {
  const ttlSeconds = resolveGuestTokenTtl(options?.ttlSeconds);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: GuestTokenPayload = {
    v: 2,
    roomId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    allowPrivate: options?.allowPrivate ?? true,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64);
  return { token: `${payloadB64}.${signature}`, payload };
};

export const verifyGuestToken = (token?: string | null) => {
  if (!token) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = sign(payloadB64);
  if (expected !== signature) return null;
  try {
    const payload = JSON.parse(
      base64UrlDecode(payloadB64),
    ) as GuestTokenPayload;
    if (!payload || (payload.v !== 1 && payload.v !== 2)) return null;
    if (!payload.roomId) return null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
};
