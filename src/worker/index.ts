import {
  DOC_ID_RE,
  GLOBAL_CREATE_PER_MINUTE,
  IMAGE_SRC_RE,
  MAX_IMAGE_BYTES,
  SECRET_RE,
  USER_ID_RE,
  generateDocId,
  sanitizeName,
} from "../shared/constants";
import type { Env } from "./env";
import { allowRequest } from "./ratelimit";
import { escapeHtml } from "./render";
import { sha256Hex, verifyUser } from "./users";

export { DocRoom } from "./do/DocRoom";

/** 読み込めるものを自サイト（と紹介ページの Google Fonts）に限り、他サイトへの埋め込みを禁じる。public/_headers と揃える */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Worker が返す応答に付けるヘッダー（public/_headers は Worker の応答には効かない） */
const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
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

/** 全体の文書作成数を 1 分単位で数え、上限以内なら true */
async function allowGlobalCreate(env: Env): Promise<boolean> {
  const limit = Number(env.GLOBAL_CREATE_PER_MINUTE) || GLOBAL_CREATE_PER_MINUTE;
  const minute = Math.floor(Date.now() / 60_000);
  try {
    const [, counted] = await env.DB.batch<{ count: number }>([
      env.DB.prepare("DELETE FROM create_quota WHERE minute < ?").bind(minute - 1),
      env.DB.prepare(
        "INSERT INTO create_quota (minute, count) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET count = count + 1 RETURNING count",
      ).bind(minute),
    ]);
    return (counted.results[0]?.count ?? Infinity) <= limit;
  } catch (err) {
    // テーブル未作成（マイグレーション前）や D1 の一時的な失敗では、IP 単位の制限だけで作成を続ける
    console.error("create_quota failed", err);
    return true;
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

/** 先頭のバイト列から写真の形式を判定する。WebP・JPEG・PNG 以外は null */
function imageType(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  return null;
}

/** 写真を受け取って保存し、本文に書く参照（「文書 ID/写真 ID」）を返す */
async function uploadImage(request: Request, env: Env, docId: string): Promise<Response> {
  if (!env.IMAGES) return json({ error: "unavailable" }, 503);
  const userId = request.headers.get("X-User-Id") ?? "";
  const secret = request.headers.get("X-User-Secret") ?? "";
  if (!USER_ID_RE.test(userId) || !SECRET_RE.test(secret) || (await verifyUser(env.DB, userId, secret)) === null) {
    return json({ error: "unauthorized" }, 401);
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
  if (!(await allowRequest(env, "images", request))) return json({ error: "rate_limited" }, 429);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
  const type = imageType(bytes);
  if (!type) return json({ error: "invalid" }, 400);

  const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
  const reserved = await stub.fetch(`https://do/images/reserve?docId=${docId}`, { method: "POST" });
  if (!reserved.ok) return json(await reserved.json(), reserved.status);

  const src = `${docId}/${generateDocId()}`;
  await env.IMAGES.put(src, bytes, { httpMetadata: { contentType: type }, customMetadata: { userId } });
  return json({ src }, 201);
}

/** 保存した写真を返す。写真は書き換えないので長くキャッシュさせる */
async function serveImage(env: Env, src: string): Promise<Response> {
  if (!env.IMAGES) return json({ error: "unavailable" }, 503);
  const object = await env.IMAGES.get(src);
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers(SECURITY_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/docs" && method === "POST") {
    if (!(await allowRequest(env, "docs", request))) return json({ error: "rate_limited" }, 429);
    if (!(await allowGlobalCreate(env))) return json({ error: "rate_limited" }, 429);
    return createDoc(env);
  }
  if (path === "/api/users" && method === "POST") {
    if (!(await allowRequest(env, "users", request))) return json({ error: "rate_limited" }, 429);
    return registerUser(request, env);
  }
  if (path === "/api/users/me" && method === "PATCH") return renameUser(request, env);

  const upload = /^\/api\/docs\/([^/]+)\/images$/.exec(path);
  if (upload && method === "POST") {
    if (!DOC_ID_RE.test(upload[1])) return json({ error: "not_found" }, 404);
    return uploadImage(request, env, upload[1]);
  }
  const image = /^\/api\/images\/(.+)$/.exec(path);
  if (image && method === "GET") {
    if (!IMAGE_SRC_RE.test(image[1])) return json({ error: "not_found" }, 404);
    return serveImage(env, image[1]);
  }

  const cont = /^\/api\/docs\/([^/]+)\/continue$/.exec(path);
  if (cont && method === "POST") {
    if (!DOC_ID_RE.test(cont[1])) return json({ error: "not_found" }, 404);
    if (!(await allowRequest(env, "docs", request))) return json({ error: "rate_limited" }, 429);
    if (!(await allowGlobalCreate(env))) return json({ error: "rate_limited" }, 429);
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(cont[1]));
    const params = new URLSearchParams({ docId: cont[1], origin: url.origin });
    const res = await stub.fetch(`https://do/continue?${params}`, { method: "POST" });
    return json(await res.json(), res.status);
  }

  const m = /^\/api\/docs\/([^/]+)\/(ws|revisions|revisions\/\d+)$/.exec(path);
  if (m && method === "GET") {
    const [, docId, rest] = m;
    if (!DOC_ID_RE.test(docId)) return json({ error: "not_found" }, 404);
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    if (rest === "ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      if (!(await allowRequest(env, "ws", request))) return json({ error: "rate_limited" }, 429);
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
