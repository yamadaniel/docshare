import { DOC_ID_RE, SECRET_RE, USER_ID_RE, generateDocId, sanitizeName } from "../shared/constants";
import type { Env } from "./env";
import { allowRequest } from "./ratelimit";
import { escapeHtml } from "./render";
import { sha256Hex, verifyUser } from "./users";

export { DocRoom } from "./do/DocRoom";

/** Worker が返す応答に付けるヘッダー（public/_headers は Worker の応答には効かない） */
const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: SECURITY_HEADERS });
}

const UNTITLED = "無題の文書";

/**
 * 文書画面。SPA の index.html に、サーバーで描画した本文を埋め込んで返す。
 * JavaScript を実行しない読み手（AI の URL 読み取りなど）にも中身が見え、
 * ブラウザでは接続が終わるまでの表示になる
 */
async function docPage(request: Request, env: Env, docId: string): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  const headers = new Headers(shell.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.delete("ETag");
  headers.delete("Last-Modified");

  let rendered: { title: string; html: string; description: string } | null = null;
  if (DOC_ID_RE.test(docId)) {
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    const res = await stub.fetch("https://do/render");
    if (res.ok) rendered = await res.json();
  }
  if (!rendered) {
    // 画面の 404 表示は SPA が行う。ステータスだけ 404 にする
    return new Response(shell.body, { status: 404, headers });
  }

  const title = rendered.title || UNTITLED;
  const article =
    `<main class="doc-main"><article class="ssr" data-doc-id="${docId}">` +
    `<h1>${escapeHtml(title)}</h1>${rendered.html}</article></main>`;
  const page = new HTMLRewriter()
    .on("title", { element: (el) => void el.setInnerContent(`${title} | docshare`) })
    .on("head", {
      element: (el) =>
        void el.append(`<meta name="description" content="${escapeHtml(rendered.description)}">`, { html: true }),
    })
    .on("#app", { element: (el) => void el.setInnerContent(article, { html: true }) })
    .transform(new Response(shell.body, { status: 200, headers }));
  return page;
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

  if (path === "/api/docs" && method === "POST") {
    if (!(await allowRequest(env, "docs", request))) return json({ error: "rate_limited" }, 429);
    return createDoc(env);
  }
  if (path === "/api/users" && method === "POST") {
    if (!(await allowRequest(env, "users", request))) return json({ error: "rate_limited" }, 429);
    return registerUser(request, env);
  }
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
    const doc = /^\/d\/([^/]+)\/?$/.exec(url.pathname);
    if (doc && request.method === "GET") return docPage(request, env, doc[1]);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
