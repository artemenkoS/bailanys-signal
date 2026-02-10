const defaultOrigins = ["https://serezha.kz", "https://www.serezha.kz"];
const allowedOrigins = (process.env.CORS_ORIGINS ?? defaultOrigins.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsHeadersBase = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  Vary: "Origin",
};

const jsonHeaders = {
  "Content-Type": "application/json",
};

const resolveCorsOrigin = (origin: string | null): string => {
  if (origin && allowedOrigins.includes(origin)) return origin;
  return allowedOrigins[0] ?? "*";
};

export function withCors(response: Response, req?: Request): Response {
  const origin = req?.headers.get("Origin") ?? null;
  response.headers.set("Access-Control-Allow-Origin", resolveCorsOrigin(origin));
  Object.entries(corsHeadersBase).forEach(([key, value]) =>
    response.headers.set(key, value),
  );
  return response;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
