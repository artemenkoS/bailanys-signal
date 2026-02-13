import type {
  LoginRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  RefreshRequest,
  RegisterRequest,
} from '../types';
import { errorResponse, jsonResponse } from '../http';
import { supabase, supabaseAuth } from '../supabase';

import type { RouteHandler } from './shared';

export const authRoutes: Record<string, RouteHandler> = {
  '/api/password-reset': async (req: Request) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    try {
      const { email } = (await req.json()) as PasswordResetRequest;
      if (!email) return errorResponse('Missing email', 400);

      const { error } = await supabaseAuth.auth.resetPasswordForEmail(email);
      if (error) return errorResponse(error.message, 400);
      return jsonResponse({ success: true });
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Internal error', 500);
    }
  },

  '/api/password-reset/confirm': async (req: Request) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    try {
      const { accessToken, password } = (await req.json()) as PasswordResetConfirmRequest;
      if (!accessToken || !password) return errorResponse('Missing fields', 400);
      if (password.length < 6) return errorResponse('Password too short', 400);

      const {
        data: { user },
        error,
      } = await supabaseAuth.auth.getUser(accessToken);
      if (error || !user) return errorResponse('Invalid or expired token', 401);

      const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, { password });
      if (updateError) return errorResponse(updateError.message, 500);
      return jsonResponse({ success: true });
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Internal error', 500);
    }
  },

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
