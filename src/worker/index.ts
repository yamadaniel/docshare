import { DOC_ID_RE, SECRET_RE, USER_ID_RE, generateDocId, sanitizeName } from "../shared/constants";
import type { Env } from "./env";
import { sha256Hex, verifyUser } from "./users";

export { DocRoom } from "./do/DocRoom";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function createDoc(env: Env): Promise<Response> {
  for (let i = 0; i < 3; i++) {
    const docId = generateDocId();
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    const res = await stub.fetch("https://do/init", { method: "POST" });
    if (res.ok) return json({ docId }, 201);
  }
  return json({ error: "internal" }, 500);
}

async function registerUser(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const name = sanitizeName(body?.name);
  const userId = body?.userId;
  const secret = body?.secret;
  if (
    !name ||
    typeof userId !== "string" ||
    typeof secret !== "string" ||
    !USER_ID_RE.test(userId) ||
    !SECRET_RE.test(secret)
  ) {
    return json({ error: "invalid" }, 400);
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO users (user_id, secret_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
  )
    .bind(userId, await sha256Hex(secret), name, now, now)
    .run();
  if (result.meta.changes === 0) {
    // 再送（同じ secret）なら成功扱い、他人の userId なら拒否
    const existing = await verifyUser(env.DB, userId, secret);
    if (existing === null) return json({ error: "conflict" }, 409);
    return json({ userId, name: existing });
  }
  return json({ userId, name }, 201);
}

async function renameUser(request: Request, env: Env): Promise<Response> {
  const userId = request.headers.get("X-User-Id") ?? "";
  const secret = request.headers.get("X-User-Secret") ?? "";
  if (!USER_ID_RE.test(userId) || !SECRET_RE.test(secret) || (await verifyUser(env.DB, userId, secret)) === null) {
    return json({ error: "unauthorized" }, 401);
  }
  const name = sanitizeName((await readJson(request))?.name);
  if (!name) return json({ error: "invalid" }, 400);
  await env.DB.prepare("UPDATE users SET name = ?, updated_at = ? WHERE user_id = ?")
    .bind(name, Date.now(), userId)
    .run();
  return json({ userId, name });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/docs" && method === "POST") return createDoc(env);
  if (path === "/api/users" && method === "POST") return registerUser(request, env);
  if (path === "/api/users/me" && method === "PATCH") return renameUser(request, env);

  const m = /^\/api\/docs\/([^/]+)\/(ws|revisions|revisions\/\d+)$/.exec(path);
  if (m && method === "GET") {
    const [, docId, rest] = m;
    if (!DOC_ID_RE.test(docId)) return json({ error: "not_found" }, 404);
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    if (rest === "ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      return stub.fetch(new Request("https://do/ws", request));
    }
    const res = await stub.fetch(`https://do/${rest}${url.search}`);
    return json(await res.json(), res.status);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
