import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || supabaseServiceKey;

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

export const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey,
  clientOptions,
);

export const supabaseAuth = createClient(
  supabaseUrl,
  supabaseAnonKey,
  clientOptions,
);

export async function validateToken(token: string): Promise<string | null> {
  console.log("[Auth] Проверка токена...");
  try {
    const {
      data: { user },
      error,
    } = await supabaseAuth.auth.getUser(token);
    if (error) {
      console.error("[Auth] Ошибка Supabase:", error.message);
      return null;
    }
    return user ? user.id : null;
  } catch (err) {
    console.error("[Auth] Системная ошибка:", err);
    return null;
  }
}

export async function setPresence(
  userId: string,
  status: "online" | "offline",
) {
  const { error } = await supabase
    .from("profiles")
    .update({ status, last_seen: new Date().toISOString() })
    .eq("id", userId);
  if (error) {
    console.error("[Presence] Update failed:", error.message);
  }
}

export async function touchLastSeen(userIds: string[]) {
  if (userIds.length === 0) return;
  const { error } = await supabase
    .from("profiles")
    .update({ last_seen: new Date().toISOString() })
    .in("id", userIds);
  if (error) {
    console.error("[Presence] Heartbeat failed:", error.message);
  }
}
