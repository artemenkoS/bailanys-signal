import { createHmac } from 'node:crypto';

import type { UpdateProfileRequest } from '../types';
import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { verifyGuestToken } from '../guestTokens';
import { supabase, validateToken } from '../supabase';
import {
  deleteAvatarByUrl,
  normalizeAvatarUrl,
  processAvatarImage,
  uploadAvatar,
} from '../storage';

import type { RouteHandler } from './shared';
import { USERNAME_MIN_LENGTH } from './shared';

const DEFAULT_TURN_TTL_SECONDS = 600;

type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

const parseUrls = (value?: string | null) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const TURN_URLS = parseUrls(process.env.TURN_URLS ?? process.env.TURN_URL);
const STUN_URLS = parseUrls(process.env.STUN_URLS ?? process.env.STUN_URL);
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL ?? '';
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_TTL_SECONDS = Number.parseInt(process.env.TURN_TTL_SECONDS ?? String(DEFAULT_TURN_TTL_SECONDS), 10);
const TURN_USER_PREFIX = process.env.TURN_USER_PREFIX ?? '';

const resolveTurnTtlSeconds = () => {
  if (Number.isFinite(TURN_TTL_SECONDS) && TURN_TTL_SECONDS > 0) {
    return TURN_TTL_SECONDS;
  }
  return DEFAULT_TURN_TTL_SECONDS;
};

const buildIceServers = (userId: string) => {
  const iceServers: IceServer[] = [];

  if (STUN_URLS.length > 0) {
    iceServers.push({ urls: STUN_URLS });
  }

  if (TURN_URLS.length > 0) {
    if (TURN_SECRET) {
      const ttlSeconds = resolveTurnTtlSeconds();
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiresAt}:${TURN_USER_PREFIX}${userId}`;
      const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      iceServers.push({ urls: TURN_URLS, username, credential });
      return { iceServers, ttlSeconds };
    }

    if (TURN_USERNAME && TURN_CREDENTIAL) {
      iceServers.push({
        urls: TURN_URLS,
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      });
      return { iceServers };
    }

    throw new Error('TURN credentials are not configured');
  }

  if (iceServers.length === 0) {
    throw new Error('ICE servers are not configured');
  }

  return { iceServers };
};

export const profileRoutes: Record<string, RouteHandler> = {
  '/api/profile': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, status, last_seen')
        .eq('id', userId)
        .single();
      if (error) return errorResponse(error.message, 500);
      if (data?.avatar_url) {
        const normalized = normalizeAvatarUrl(data.avatar_url);
        if (normalized && normalized !== data.avatar_url) {
          const { error: updateError } = await supabase
            .from('profiles')
            .update({ avatar_url: normalized })
            .eq('id', userId);
          if (!updateError) {
            data.avatar_url = normalized;
          }
        }
      }
      return jsonResponse({ profile: data });
    }

    if (req.method === 'PATCH') {
      try {
        const contentType = req.headers.get('content-type') ?? '';
        const isMultipart = contentType.includes('multipart/form-data');
        const updates: Record<string, string | null> = {};
        let avatarUrl: string | null | undefined = undefined;

        if (isMultipart) {
          const form = await req.formData();
          const usernameValue = form.get('username');
          const displayNameValue = form.get('displayName');
          const removeAvatarValue = form.get('removeAvatar');
          const avatarValue = form.get('avatar');
          let currentAvatarUrl: string | null = null;

          if (typeof usernameValue === 'string') {
            const username = usernameValue.trim();
            if (!username) return errorResponse('Username is required', 400);
            if (username.length < USERNAME_MIN_LENGTH) {
              return errorResponse('Username too short', 400);
            }
            updates.username = username;
          }

          if (displayNameValue !== null && displayNameValue !== undefined) {
            const displayName = String(displayNameValue).trim();
            updates.display_name = displayName.length > 0 ? displayName : null;
          }

          const removeAvatar = typeof removeAvatarValue === 'string' && removeAvatarValue.toLowerCase() === 'true';

          if (avatarValue instanceof Blob || removeAvatar) {
            const { data: currentProfile, error: currentError } = await supabase
              .from('profiles')
              .select('avatar_url')
              .eq('id', userId)
              .single();
            if (currentError) {
              return errorResponse(currentError.message, 500);
            }
            currentAvatarUrl = normalizeAvatarUrl(currentProfile?.avatar_url);
          }

          if (avatarValue && avatarValue instanceof Blob) {
            if (!avatarValue.type.startsWith('image/')) {
              return errorResponse('Avatar must be an image', 400);
            }
            const buffer = Buffer.from(await avatarValue.arrayBuffer());
            try {
              const processed = await processAvatarImage(buffer);
              const uploadResult = await uploadAvatar(userId, processed.buffer, processed.contentType);
              avatarUrl = uploadResult.url;
              if (currentAvatarUrl) {
                deleteAvatarByUrl(currentAvatarUrl).catch((error) => {
                  console.error('[Avatar] Old avatar delete failed:', error);
                });
              }
            } catch (error: any) {
              return errorResponse(error?.message ?? 'Avatar processing failed', 400);
            }
          } else if (avatarValue) {
            return errorResponse('Invalid avatar file', 400);
          } else if (removeAvatar) {
            if (currentAvatarUrl) {
              deleteAvatarByUrl(currentAvatarUrl).catch((error) => {
                console.error('[Avatar] Old avatar delete failed:', error);
              });
            }
            avatarUrl = null;
          }
        } else {
          const body = (await req.json()) as UpdateProfileRequest;

          if (body.username !== undefined) {
            const username = body.username.trim();
            if (!username) return errorResponse('Username is required', 400);
            if (username.length < USERNAME_MIN_LENGTH) {
              return errorResponse('Username too short', 400);
            }
            updates.username = username;
          }

          if (body.displayName !== undefined) {
            const displayName = (body.displayName ?? '').trim();
            updates.display_name = displayName.length > 0 ? displayName : null;
          }
        }

        if (avatarUrl !== undefined) {
          updates.avatar_url = avatarUrl;
        }

        if (Object.keys(updates).length === 0) {
          return errorResponse('No fields to update', 400);
        }

        if (updates.username) {
          const { data: existing, error: existingError } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', updates.username)
            .neq('id', userId)
            .maybeSingle();
          if (existingError) {
            return errorResponse(existingError.message, 500);
          }
          if (existing) return errorResponse('Username taken', 409);
        }

        const { data: profile, error } = await supabase
          .from('profiles')
          .update(updates)
          .eq('id', userId)
          .select('id, username, display_name, avatar_url, status, last_seen')
          .single();
        if (error) return errorResponse(error.message, 500);

        const metadataUpdate: Record<string, string> = {};
        if (updates.username) metadataUpdate.username = updates.username;
        if ('display_name' in updates) {
          metadataUpdate.display_name = updates.display_name ?? '';
        }
        if (Object.keys(metadataUpdate).length > 0) {
          const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
            user_metadata: metadataUpdate,
          });
          if (authError) {
            console.error('[Auth] Metadata update failed:', authError.message);
          }
        }

        return jsonResponse({ profile });
      } catch (err: any) {
        const status = err instanceof SyntaxError ? 400 : 500;
        return errorResponse(err?.message ?? 'Invalid request body', status);
      }
    }

    return errorResponse('Method not allowed', 405);
  },

  '/api/ice-servers': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    try {
      const { iceServers, ttlSeconds } = buildIceServers(userId);
      return jsonResponse({ iceServers, ttlSeconds });
    } catch (error: any) {
      return errorResponse(error?.message ?? 'ICE servers are not configured', 500);
    }
  },

  '/api/guest/ice-servers': async (req: Request) => {
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);
    const url = new URL(req.url);
    const token = getBearerToken(req) ?? url.searchParams.get('token');
    const payload = verifyGuestToken(token);
    if (!payload) return errorResponse('Unauthorized', 401);

    try {
      const { iceServers, ttlSeconds } = buildIceServers(payload.guestId);
      return jsonResponse({ iceServers, ttlSeconds });
    } catch (error: any) {
      return errorResponse(error?.message ?? 'ICE servers are not configured', 500);
    }
  },
};
