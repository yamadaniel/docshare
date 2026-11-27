// テスト共通の補助。BASE_URL の wrangler dev に対して実行する（tests/run.mjs が起動する）
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

export const BASE = process.env.BASE_URL ?? "http://localhost:8787";
export const PERSIST_DIR = process.env.PERSIST_DIR ?? "";
export const J = JSON.stringify;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
export const randomSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * テストごとに別の IP を名乗り、IP 単位のレート制限を互いに共有しないようにする。
 * wrangler dev ではリクエストの CF-Connecting-IP がそのまま使われる（本番では Cloudflare が上書きする）
 */
let ipSeq = 0;
export const uniqueIp = () => `10.${process.pid % 250}.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

export async function api(path, { ip = uniqueIp(), headers = {}, ...init } = {}) {
  return fetch(BASE + path, { ...init, headers: { "CF-Connecting-IP": ip, ...headers } });
}

export async function registerUser(name, ip) {
  const user = { userId: crypto.randomUUID(), secret: randomSecret(), name };
  const res = await api("/api/users", { method: "POST", body: J(user), ip });
  if (res.status !== 201) throw new Error(`register ${res.status}`);
  return user;
}

export async function createDoc(ip) {
  const res = await api("/api/docs", { method: "POST", ip });
  if (res.status !== 201) throw new Error(`create ${res.status}`);
  return (await res.json()).docId;
}

/** メッセージを順に受け取れる WebSocket クライアント */
export function openWs(docId, ip = uniqueIp()) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/docs/${docId}/ws`, {
      headers: { "CF-Connecting-IP": ip },
    });
    const queue = [];
    const waiters = [];
    ws.closeCode = null;
    ws.onmessage = (e) => {
      const w = waiters.shift();
      if (w) w(e.data);
      else queue.push(e.data);
    };
    ws.onclose = (e) => {
      ws.closeCode = e.code;
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
    /** 次のメッセージ。届かなければ { type: "TIMEOUT" } */
    ws.next = (ms = 3000) =>
      new Promise((r) => {
        if (queue.length) return r(parse(queue.shift()));
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(f), 1);
          r({ type: "TIMEOUT" });
        }, ms);
        const f = (d) => {
          clearTimeout(t);
          r(parse(d));
        };
        waiters.push(f);
      });
    /** 指定 type（またはエラー）が来るまで presence などを読み飛ばす */
    ws.until = async (type, ms) => {
      for (;;) {
        const m = await ws.next(ms);
        if (m.type === type || m.type === "TIMEOUT" || m.type === "error") return m;
      }
    };
    ws.sendJson = (o) => ws.send(J(o));
  });
}
const parse = (d) => (d === "pong" ? { type: "pong" } : JSON.parse(d));

export async function hello(docId, user) {
  const ws = await openWs(docId);
  ws.sendJson({ type: "hello", userId: user.userId, secret: user.secret });
  const init = await ws.until("init");
  // init の直後に自分を含む presence が届く。以降の応答と取り違えないよう読み終えておく
  if (init.type === "init") await ws.until("presence");
  return { ws, init };
}

export const insertText = (pos, text) => ({
  stepType: "replace",
  from: pos,
  to: pos,
  slice: { content: [{ type: "text", text }] },
});

// ---- ブラウザ ----

let browser = null;
export async function launch() {
  browser ??= await chromium.launch();
  return browser;
}
export async function closeBrowser() {
  await browser?.close();
  browser = null;
}

/** スマホ幅のページを開き、初回の名前モーダルで登録まで済ませる */
export async function openAs(name, path = "/", opts = {}) {
  const b = await launch();
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: { "CF-Connecting-IP": uniqueIp() },
    ...opts,
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(BASE + path);
  await page.fill(".overlay .text-input", name);
  await page.click(".overlay .btn.primary");
  await page.waitForSelector(".overlay", { state: "detached" });
  return page;
}

export const editorHtml = (page) => page.$eval(".editor", (e) => e.innerHTML);
export const editorText = (page) => page.$eval(".editor", (e) => e.textContent);

/** ローカル D1 に SQL を実行する（障害の再現用） */
export function d1Local(sql) {
  const args = ["wrangler", "d1", "execute", "docshare", "--local", "--command", sql];
  if (PERSIST_DIR) args.push("--persist-to", PERSIST_DIR);
  execFileSync("npx", args, { stdio: "pipe" });
}
