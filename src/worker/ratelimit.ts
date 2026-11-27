import type { Env } from "./env";

export type Scope = "docs" | "users" | "ws";

/** 60 秒あたりの回数。wrangler.jsonc の ratelimits と揃える */
const LIMITS: Record<Scope, number> = { docs: 10, users: 10, ws: 60 };
const PERIOD_MS = 60_000;

// Rate Limiting バインディングが使えない場合の簡易カウンター（isolate 単位）
const counters = new Map<string, { at: number; count: number }>();

function allowLocal(key: string, limit: number): boolean {
  const now = Date.now();
  if (counters.size > 10_000) {
    for (const [k, v] of counters) if (now - v.at >= PERIOD_MS) counters.delete(k);
  }
  const c = counters.get(key);
  if (!c || now - c.at >= PERIOD_MS) {
    counters.set(key, { at: now, count: 1 });
    return true;
  }
  return ++c.count <= limit;
}

/** IP 単位のレート制限（scope ごとに 60 秒あたり LIMITS 回） */
export async function allowRequest(env: Env, scope: Scope, request: Request): Promise<boolean> {
  const key = `${scope}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  const limiter = scope === "ws" ? env.WS_LIMITER : env.CREATE_LIMITER;
  if (limiter) {
    try {
      return (await limiter.limit({ key })).success;
    } catch {
      // バインディングが応答しない場合は簡易カウンターで代替
    }
  }
  return allowLocal(key, LIMITS[scope]);
}
