const defaultOrigins = ["https://serezha.kz", "https://www.serezha.kz"];
const devOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://192.168.0.196:5556",
  "http://192.168.0.196:5556",
  "https://172.20.10.11:5556",
];

const allowedOrigins = (() => {
  const base = (process.env.CORS_ORIGINS ?? defaultOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== "production") {
    for (const origin of devOrigins) {
      if (!base.includes(origin)) base.push(origin);
    }
  }

  return base;
})();

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
  response.headers.set(
    "Access-Control-Allow-Origin",
    resolveCorsOrigin(origin),
  );
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
