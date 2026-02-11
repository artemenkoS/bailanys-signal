import type { LoginRequest, RefreshRequest, RegisterRequest } from '../types';
import { errorResponse, jsonResponse } from '../http';
import { supabase, supabaseAuth } from '../supabase';

import type { RouteHandler } from './shared';

export const authRoutes: Record<string, RouteHandler> = {
  '/api/register': async (req: Request) => {
    try {
      const body = (await req.json()) as RegisterRequest;
      const { email, password, username, displayName } = body;

      if (!email || !password || !username) {
        return errorResponse('Missing fields', 400);
      }

      const { data: existing } = await supabase.from('profiles').select('username').eq('username', username).single();
      if (existing) return errorResponse('Username taken', 409);

      const { data, error } = await supabaseAuth.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName || username } },
      });

      if (error) throw error;
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Internal error', 500);
    }
  },

  '/api/login': async (req: Request) => {
    try {
      const { email, password } = (await req.json()) as LoginRequest;
      const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return errorResponse(error.message, 401);

      return jsonResponse(data);
    } catch {
      return errorResponse('Internal error', 500);
    }
  },

  '/api/refresh': async (req: Request) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    try {
      const { refreshToken } = (await req.json()) as RefreshRequest;
      if (!refreshToken) return errorResponse('Missing refresh token', 400);
      const { data, error } = await supabaseAuth.auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (error) return errorResponse(error.message, 401);
      return jsonResponse(data);
    } catch {
      return errorResponse('Internal error', 500);
    }
  },
};
