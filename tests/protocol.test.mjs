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
  d1Local,
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
  for (const [path, status] of [["/", 200], ["/d/abcdefghijklmnopqrstuv", 404]]) {
    const res = await api(path, { headers: { "Sec-Fetch-Mode": "navigate" } });
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  }
  // 静的ファイル（public/_headers）と Worker の応答で CSP が同じ
  const csp = async (path) => (await api(path)).headers.get("content-security-policy");
  assert.equal(await csp("/"), await csp("/d/abcdefghijklmnopqrstuv"));
  assert.equal(await csp("/about"), await csp("/api/docs/abcdefghijklmnopqrstuv/revisions"));
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

test("文書作成の全体上限", async () => {
  const minute = Math.floor(Date.now() / 60_000);
  // tests/run.mjs で上限を 1000 にしている。次の 1 分にまたがっても上限に達しているよう、2 分ぶん埋めておく
  d1Local(`INSERT OR REPLACE INTO create_quota (minute, count) VALUES (${minute}, 1000), (${minute + 1}, 1000)`);
  try {
    assert.equal((await api("/api/docs", { method: "POST" })).status, 429);
  } finally {
    d1Local("DELETE FROM create_quota");
  }
  assert.equal((await api("/api/docs", { method: "POST" })).status, 201);
});

test("WebSocket の同時接続数と接続回数の上限", async () => {
  const docId = await createDoc();
  const ip = uniqueIp();
  const sockets = [];
  for (let i = 0; i < 20; i++) sockets.push(await openWs(docId, ip));
  await assert.rejects(openWs(docId, ip), "同じ IP から 21 本目はつながらない");
  const other = await openWs(docId);
  for (const ws of [...sockets, other]) ws.close();

  // 同じ IP からの接続は 1 分に 60 回まで（文書をまたいで数える）
  const ip2 = uniqueIp();
  const results = [];
  for (let i = 0; i < 61; i++) {
    results.push(await openWs(docId, ip2).then((ws) => (ws.close(), "ok"), () => "rejected"));
  }
  assert.deepEqual(results, [...Array(60).fill("ok"), "rejected"]);
});

test("hello を送らない接続は 10 秒で閉じられる", async () => {
  const docId = await createDoc();
  const ws = await openWs(docId);
  // ping は hello の代わりにならない（wrangler dev では、何も送らない接続だと閉じる処理が最後まで届かない）
  ws.send("ping");
  await sleep(12_000);
  assert.equal(ws.closeCode, 4408);
});

test("リンクは http・https・mailto だけを受け付ける", async () => {
  const s = await session();
  await s.send([insertText(1, "abc")]);
  const addLink = (href) => ({ stepType: "addMark", from: 1, to: 4, mark: { type: "link", attrs: { href } } });
  for (const href of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", " https://x.test", 5]) {
    assert.equal((await s.send([addLink(href)])).code, "invalid", String(href));
  }
  for (const href of ["https://example.com/a?b=1", "http://example.com", "mailto:a@example.com"]) {
    assert.equal((await s.send([addLink(href)])).type, "steps", href);
  }
});

test("文書の HTML に本文が埋め込まれる（JavaScript を実行しない読み手向け）", async () => {
  const s = await session();
  const t = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });
  await s.send([
    {
      stepType: "replace",
      from: 0,
      to: 2,
      slice: {
        content: [
          {
            type: "paragraph",
            content: [
              t("<script>alert(1)</script> & "),
              t("太字", [{ type: "strong" }]),
              t(" "),
              t("リンク", [{ type: "link", attrs: { href: 'https://example.com/?a=1&b="x"' } }]),
            ],
          },
          {
            type: "task_list",
            content: [
              { type: "task_item", attrs: { checked: true }, content: [t("済み")] },
              { type: "task_item", content: [t("未完了")] },
            ],
          },
        ],
      },
    },
  ]);
  s.ws.sendJson({ type: "title", version: s.version, title: "<b>会議</b>" });
  await s.ws.until("title");

  const res = await api(`/d/${s.docId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const html = await res.text();
  assert.match(html, /<title>&lt;b&gt;会議&lt;\/b&gt; \| docshare<\/title>/);
  assert.match(html, /<meta name="description" content="&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; 太字 リンク 済み 未完了">/);
  assert.ok(!html.includes("<script>alert"), "本文はエスケープされる");
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com\/\?a=1&amp;b=&quot;x&quot;" rel="noopener noreferrer nofollow" target="_blank">リンク<\/a>/);
  assert.match(html, /<li data-checked="true">☑ 済み<\/li><li data-checked="false">☐ 未完了<\/li>/);
  assert.match(html, /<script type="module"/, "ブラウザでは通常どおり SPA が動く");

  const missing = await api("/d/ZZZZZZZZZZZZZZZZZZZZZZ");
  assert.equal(missing.status, 404);
  assert.equal((await api("/d/short")).status, 404);
  assert.equal(await (await api("/robots.txt")).text(), "User-agent: *\nAllow: /\n");
});
