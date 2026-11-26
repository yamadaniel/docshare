// WebSocket と HTTP API の試験
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  J,
  api,
  createDoc,
  hello,
  insertText,
  openWs,
  randomSecret,
  registerUser,
  sleep,
  uniqueIp,
} from "./helpers.mjs";

/** 1 文書を 1 接続で編集する。version はサーバーの応答で進める */
async function session() {
  const ip = uniqueIp();
  const user = await registerUser("テスター", ip);
  const docId = await createDoc(ip);
  const { ws, init } = await hello(docId, user);
  const s = { ip, user, docId, ws, version: init.version };
  s.send = async (steps, clientId = "c1") => {
    ws.sendJson({ type: "steps", version: s.version, clientId, steps });
    const m = await ws.until("steps");
    if (m.type === "steps") s.version = m.version;
    return m;
  };
  return s;
}

const textOf = (doc) =>
  (J(doc).match(/"text":"([^"]*)"/g) ?? []).map((t) => t.slice(8, -1)).join("");

test("セキュリティヘッダー", async () => {
  for (const path of ["/", "/d/abcdefghijklmnopqrstuv"]) {
    const res = await api(path, { headers: { "Sec-Fetch-Mode": "navigate" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
  }
  const res = await api("/api/docs/abcdefghijklmnopqrstuv/revisions");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("文書 ID は 22 文字の base62", async () => {
  const docId = await createDoc();
  assert.match(docId, /^[0-9A-Za-z]{22}$/);
});

test("存在しない文書は 404 で、WebSocket も not_found で閉じる", async () => {
  assert.equal((await api("/api/docs/ZZZZZZZZZZZZZZZZZZZZZZ/revisions")).status, 404);
  assert.equal((await api("/api/docs/bad!/revisions")).status, 404);
  const ws = await openWs("ZZZZZZZZZZZZZZZZZZZZZZ");
  assert.deepEqual(await ws.next(), { type: "error", code: "not_found" });
});

test("hello なし・secret 不一致は unauthorized", async () => {
  const ip = uniqueIp();
  const user = await registerUser("認証", ip);
  const docId = await createDoc(ip);
  const ws = await openWs(docId);
  ws.sendJson({ type: "sync", version: 0 });
  assert.equal((await ws.next()).code, "unauthorized");
  ws.sendJson({ type: "hello", userId: user.userId, secret: randomSecret() });
  assert.equal((await ws.next()).code, "unauthorized");
  await sleep(200);
  assert.equal(ws.closeCode, 4401);
});

test("ping は自動応答で pong", async () => {
  const { ws } = await session();
  ws.send("ping");
  assert.equal((await ws.until("pong")).type, "pong");
});

test("step の検証", async () => {
  const s = await session();
  assert.equal((await s.send([insertText(1, "hello")])).type, "steps");

  // 古い version
  s.ws.sendJson({ type: "steps", version: 0, clientId: "c1", steps: [insertText(1, "x")] });
  assert.equal((await s.ws.next()).code, "version_mismatch");

  const invalid = async (step) => assert.equal((await s.send([step])).code, "invalid", J(step));
  await invalid(insertText(999, "x"));
  await invalid({ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "image", attrs: { src: "x" } }] } });
  await invalid({
    stepType: "replace",
    from: 1,
    to: 1,
    slice: { content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "javascript:1" } }] }] },
  });
  await invalid({ stepType: "attr", pos: 0, attr: "checked", value: true });
  await invalid({ stepType: "docAttr", attr: "x", value: 1 });

  // 段落をタスク化してからチェック属性を検証
  const wrap = await s.send([
    {
      stepType: "replaceAround",
      from: 0,
      to: 7,
      gapFrom: 1,
      gapTo: 6,
      insert: 2,
      structure: true,
      slice: { content: [{ type: "task_list", content: [{ type: "task_item" }] }] },
    },
  ]);
  assert.equal(wrap.type, "steps");
  await invalid({ stepType: "attr", pos: 1, attr: "evil", value: 1 });
  await invalid({ stepType: "attr", pos: 1, attr: "checked", value: "yes" });
  assert.equal((await s.send([{ stepType: "attr", pos: 1, attr: "checked", value: true }])).type, "steps");
});

test("サイズ上限", async () => {
  const s = await session();
  s.ws.sendJson({ type: "steps", version: s.version, clientId: "c1", steps: [insertText(1, "あ".repeat(30000))] });
  assert.equal((await s.ws.next()).code, "too_large", "WebSocket 1 メッセージ 64KB");
  s.ws.sendJson({ type: "title", version: s.version, title: "x".repeat(101) });
  assert.equal((await s.ws.next()).code, "too_large", "文書名 100 文字");

  // 文書全体 1MB
  let m;
  for (let i = 0; i < 25; i++) {
    m = await s.send([insertText(1, "z".repeat(60000))]);
    if (m.type === "error") break;
    if (i % 15 === 14) await sleep(1100);
  }
  assert.equal(m.code, "too_large", "文書全体 1MB");
  assert.equal((await s.send([insertText(1, "small")])).type, "steps", "上限内の編集は受理");
});

test("複数 step のリビジョンと sync", async () => {
  const s = await session();
  await s.send([insertText(1, "hello")]);
  const before = s.version;
  const m = await s.send([insertText(2, "a"), insertText(3, "b"), insertText(4, "c")]);
  assert.equal(m.version, before + 3);

  s.ws.sendJson({ type: "sync", version: before });
  const synced = await s.ws.until("steps");
  assert.equal(synced.steps.length, 3);
  assert.equal(synced.clientIds.length, 3);

  s.ws.sendJson({ type: "sync", version: before + 1 });
  assert.equal((await s.ws.next()).code, "invalid", "リビジョンの途中からは再開できない");
  s.ws.sendJson({ type: "sync", version: s.version + 5 });
  assert.equal((await s.ws.next()).code, "invalid", "未来の version");
});

test("200 step ごとのスナップショットから過去版と最新版を再構成できる", async () => {
  const s = await session();
  await s.send([insertText(1, "hello")]);
  const many = Array.from({ length: 210 }, () => insertText(2, "x"));
  assert.equal((await s.send(many)).type, "steps");

  const { revisions } = await (await api(`/api/docs/${s.docId}/revisions?limit=10`)).json();
  assert.ok(revisions.every((r) => r.name === "テスター"));
  const latest = await (await api(`/api/docs/${s.docId}/revisions/${revisions[0].revId}`)).json();
  const prev = await (await api(`/api/docs/${s.docId}/revisions/${revisions[1].revId}`)).json();
  assert.equal(latest.version, s.version);
  assert.equal(textOf(latest.doc).length, 215);
  assert.equal(textOf(prev.doc), "hello");

  s.ws.close();
  const { init } = await hello(s.docId, s.user);
  assert.equal(J(init.doc), J(latest.doc), "再接続後の init が最新版と一致");
});

test("1 接続あたり毎秒 20 メッセージまで", async () => {
  const { ws } = await session();
  await sleep(1100);
  // D1 を使わず即座に invalid が返るメッセージで、処理時間が 1 秒の窓をまたがないようにする
  for (let i = 0; i < 25; i++) ws.sendJson({ type: "unknown" });
  const got = [];
  for (let i = 0; i < 25; i++) got.push(await ws.next(2000));
  assert.equal(got.filter((m) => m.code === "invalid").length, 20);
  assert.equal(got.filter((m) => m.code === "rate_limited").length, 5);
});

test("ユーザー API", async () => {
  const ip = uniqueIp();
  const user = await registerUser("旧名", ip);
  const docId = await createDoc(ip);
  const { ws } = await hello(docId, user);
  ws.sendJson({ type: "steps", version: 0, clientId: "c1", steps: [insertText(1, "a")] });
  await ws.until("steps");

  const patch = (secret, body) =>
    api("/api/users/me", {
      method: "PATCH",
      ip,
      headers: secret ? { "X-User-Id": user.userId, "X-User-Secret": secret } : {},
      body: J(body),
    });
  assert.equal((await patch(randomSecret(), { name: "hack" })).status, 401);
  assert.equal((await patch(null, { name: "hack" })).status, 401);
  const ok = await patch(user.secret, { name: "  新しい\u0000名前​  " });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name, "新しい名前", "制御文字の除去と trim");
  assert.equal((await patch(user.secret, { name: "x".repeat(21) })).status, 400);
  assert.equal((await patch(user.secret, { name: "   " })).status, 400);
  assert.equal((await patch(user.secret, { name: "😀".repeat(20) })).status, 200);

  const steal = await api("/api/users", { method: "POST", ip, body: J({ ...user, secret: randomSecret(), name: "x" }) });
  assert.equal(steal.status, 409, "他人の userId で再登録");
  const resend = await api("/api/users", { method: "POST", ip, body: J({ ...user, name: "again" }) });
  assert.equal(resend.status, 200, "同じ secret の再送は成功扱い");

  const { revisions } = await (await api(`/api/docs/${docId}/revisions?limit=1`)).json();
  assert.equal(revisions[0].name, "😀".repeat(20), "過去の差分にも新しい名前");
});

test("文書作成とユーザー登録の IP レート制限", async () => {
  const ip = uniqueIp();
  const docs = [];
  for (let i = 0; i < 11; i++) docs.push((await api("/api/docs", { method: "POST", ip })).status);
  assert.deepEqual(docs, [...Array(10).fill(201), 429]);

  const users = [];
  for (let i = 0; i < 11; i++) {
    const body = J({ userId: crypto.randomUUID(), secret: randomSecret(), name: `u${i}` });
    users.push((await api("/api/users", { method: "POST", ip, body })).status);
  }
  assert.deepEqual(users, [...Array(10).fill(201), 429]);
});
