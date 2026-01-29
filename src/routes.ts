import type { LoginRequest, RegisterRequest } from "./types";
import { errorResponse, getBearerToken, jsonResponse } from "./http";
import { supabase, validateToken } from "./supabase";
import { users } from "./state";

export type RouteHandler = (req: Request) => Promise<Response>;

export const routes: Record<string, RouteHandler> = {
  "/api/register": async (req: Request) => {
    try {
      const body = (await req.json()) as RegisterRequest;
      const { email, password, username, displayName } = body;

      if (!email || !password || !username) {
        return errorResponse("Missing fields", 400);
      }

      const { data: existing } = await supabase
        .from("profiles")
        .select("username")
        .eq("username", username)
        .single();
      if (existing) return errorResponse("Username taken", 409);

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName || username } },
      });

      if (error) throw error;
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err?.message ?? "Internal error", 500);
    }
  },

  "/api/login": async (req: Request) => {
    try {
      const { email, password } = (await req.json()) as LoginRequest;
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return errorResponse(error.message, 401);

      return jsonResponse(data);
    } catch {
      return errorResponse("Internal error", 500);
    }
  },

  "/api/users": async (req: Request) => {
    const token = getBearerToken(req);
    const userId = token ? await validateToken(token) : null;
    if (!userId) return errorResponse("Unauthorized", 401);

    const onlineIds = Array.from(users.keys()).filter((id) => id !== userId);
    if (onlineIds.length === 0) return jsonResponse({ users: [] });

    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, display_name, status, avatar_url")
      .in("id", onlineIds);
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ users: data || [] });
  },
};
