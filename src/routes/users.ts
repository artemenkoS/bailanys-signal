import { errorResponse, getBearerToken, jsonResponse } from '../http';
import { supabase, validateToken } from '../supabase';
import { users } from '../state';
import { normalizeAvatarUrl } from '../storage';

import type { RouteHandler } from './shared';

export const userRoutes: Record<string, RouteHandler> = {
  '/api/users': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);

    const onlineIds = Array.from(users.keys()).filter((id) => id !== userId);
    if (onlineIds.length === 0) return jsonResponse({ users: [] });

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, status, avatar_url')
      .in('id', onlineIds);
    if (error) return errorResponse(error.message, 500);
    const normalizedUsers = (data || []).map((user) => ({
      ...user,
      avatar_url: normalizeAvatarUrl(user.avatar_url),
    }));
    return jsonResponse({ users: normalizedUsers });
  },

  '/api/user': async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse('Unauthorized', 401);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    const url = new URL(req.url);
    const targetId = url.searchParams.get('id')?.trim() ?? '';
    if (!targetId) return errorResponse('id is required', 400);

    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, status, last_seen')
      .eq('id', targetId)
      .single();

    if (error) return errorResponse(error.message, 500);
    if (!data) return errorResponse('User not found', 404);

    return jsonResponse({
      user: {
        ...data,
        avatar_url: normalizeAvatarUrl(data.avatar_url),
      },
    });
  },
};
