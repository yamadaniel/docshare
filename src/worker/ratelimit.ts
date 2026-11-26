import type { Env } from "./env";

const LIMIT = 10;
const PERIOD_MS = 60_000;

// Rate Limiting バインディングが使えない場合の簡易カウンター（isolate 単位）
const counters = new Map<string, { at: number; count: number }>();

function allowLocal(key: string): boolean {
  const now = Date.now();
  if (counters.size > 10_000) {
    for (const [k, v] of counters) if (now - v.at >= PERIOD_MS) counters.delete(k);
  }
  const c = counters.get(key);
  if (!c || now - c.at >= PERIOD_MS) {
    counters.set(key, { at: now, count: 1 });
    return true;
  }
  return ++c.count <= LIMIT;
}

/** IP 単位のレート制限（scope ごとに 60 秒あたり 10 回） */
export async function allowRequest(env: Env, scope: string, request: Request): Promise<boolean> {
  const key = `${scope}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  if (env.CREATE_LIMITER) {
    try {
      return (await env.CREATE_LIMITER.limit({ key })).success;
    } catch {
      // バインディングが応答しない場合は簡易カウンターで代替
    }
  }
  return allowLocal(key);
}
