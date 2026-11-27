// ブラウザでの試験（スマホ幅）。同じ文書を複数のブラウザコンテキストで開いて確かめる
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { BASE, closeBrowser, d1Local, editorHtml, editorText, openAs, sleep } from "./helpers.mjs";

after(closeBrowser);

/** 1 人目が新しい文書を作り、2 人目が同じ URL を開く */
async function pair() {
  const a = await openAs("Alice");
  await a.click(".new-btn");
  await a.waitForSelector(".editor");
  const url = a.url();
  const b = await openAs("Bob", new URL(url).pathname);
  await b.waitForSelector(".editor");
  await a.waitForFunction(() => document.querySelector(".presence")?.textContent === "2");
  return { a, b, url };
}

const close = async (...pages) => {
  for (const p of pages) {
    assert.deepEqual(p.errors, [], "ページでの例外");
    await p.context().close();
  }
};

/** HTML から属性の揺れを除いて比較しやすくする */
const normalize = (html) =>
  html
    .replace(/ data-task-item=""| data-task-list=""| class="[a-z-]*"/g, "")
    .replace(/<span contenteditable="false"><\/span>/g, "");

test("初回だけ閉じられない名前モーダルが出て、リロード後も名前を保持する", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector(".overlay");
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  assert.ok(await page.$(".overlay"), "背景タップや Escape では閉じない");
  assert.equal(await page.$(".overlay .btn:not(.primary)"), null, "キャンセルボタンがない");
  await page.fill(".overlay .text-input", "初回");
  await page.click(".overlay .btn.primary");
  await page.waitForSelector(".overlay", { state: "detached" });
  await page.reload();
  await page.waitForSelector(".name-chip");
  assert.equal(await page.$(".overlay"), null);
  assert.equal(await page.textContent(".name-chip"), "初回");
  await browser.close();
});

test("存在しない文書は 404 表示", async () => {
  const p = await openAs("Ghost", "/d/ZZZZZZZZZZZZZZZZZZZZZZ");
  await p.waitForSelector(".notfound");
  const q = await openAs("Ghost2", "/d/short");
  await q.waitForSelector(".notfound");
  await close(p, q);
});

test("同時入力・書式・チェック・文書名が同期する", async () => {
  const { a, b } = await pair();
  await a.click(".editor");
  await b.click(".editor");
  await Promise.all([
    a.keyboard.type("AAAAAAAAAAAAAAAAAAAA", { delay: 60 }),
    b.keyboard.type("bbbbbbbbbbbbbbbbbbbb", { delay: 70 }),
  ]);
  await a.keyboard.press("Enter");
  await a.keyboard.type("[] todo");
  await a.click(".tb-bold");
  await a.keyboard.type(" bold");
  await b.click(".tb-underline");
  await b.keyboard.type("under");
  await a.waitForTimeout(2500);
  await b.click(".task-box");
  await a.fill(".title-input", "会議メモ");
  await a.keyboard.press("Enter");
  await a.waitForTimeout(1500);

  const [ha, hb] = [await editorHtml(a), await editorHtml(b)];
  assert.equal(ha, hb);
  const text = await editorText(a);
  assert.equal((text.match(/A/g) ?? []).length, 20, "同時入力で文字が欠けない");
  assert.equal((text.match(/b/g) ?? []).length, 20 + 1, "20 文字 + bold の b");
  assert.match(ha, /<strong> bold<\/strong>/);
  assert.match(ha, /<u>under<\/u>/);
  assert.match(ha, /data-checked="true"/);
  assert.equal(await b.inputValue(".title-input"), "会議メモ");
  await close(a, b);
});

test("IME の変換中の文字は送らず、確定してから同期する", async () => {
  const { a, b } = await pair();
  await a.click(".editor");
  await a.keyboard.type("前");
  await b.waitForFunction(() => document.querySelector(".editor")?.textContent === "前");
  const ime = await a.context().newCDPSession(a);
  for (const text of ["に", "にほ", "にほn"]) {
    await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await sleep(150);
  }
  // 変換中に相手の入力が届いても、変換は途切れない
  await b.click(".editor");
  await b.keyboard.press("End");
  await b.keyboard.type("B");
  await sleep(2500);
  assert.equal(await editorText(b), "前B", "未確定の文字は相手に届かない");
  assert.equal(await editorText(a), "前にほn", "相手の入力は確定まで待つ");

  await ime.send("Input.insertText", { text: "日本" });
  // 同じ位置への入力なので、B と「日本」の順は先にサーバーへ届いたほうで決まる
  await sleep(2500);
  const text = await editorText(a);
  assert.equal(await editorText(b), text);
  assert.match(text, /^前(B日本|日本B)$/);
  await close(a, b);
});

test("行のチェックボックス化と解除が同期する", async () => {
  const { a, b } = await pair();
  await a.click(".editor");
  await a.keyboard.type("first");
  await a.keyboard.press("Enter");
  await a.keyboard.type("[] milk");
  await a.keyboard.press("Enter");
  await a.keyboard.type("eggs");
  await a.waitForTimeout(900);
  await a.click(".task-text >> nth=0");
  await a.click(".tb-check");
  await a.waitForTimeout(900);
  assert.equal(normalize(await editorHtml(a)), normalize(await editorHtml(b)));
  assert.match(normalize(await editorHtml(a)), /^<p>first<\/p><p>milk<\/p><ul><li data-checked="false"><div>eggs<\/div><\/li><\/ul>$/);
  await a.click(".tb-check");
  await a.waitForTimeout(900);
  assert.match(normalize(await editorHtml(b)), /^<p>first<\/p><ul><li data-checked="false"><div>milk<\/div><\/li><li data-checked="false"><div>eggs<\/div><\/li><\/ul>$/);
  await close(a, b);
});

test("履歴に編集者名つきで並び、過去の版に戻せて、名前変更が履歴に反映される", async () => {
  const { a, b } = await pair();
  await a.click(".editor");
  await a.keyboard.type("first line");
  await a.waitForTimeout(900);
  await a.keyboard.press("Enter");
  await a.keyboard.type("[] milk");
  await a.waitForTimeout(900);
  await b.click(".task-box");
  await b.waitForTimeout(900);

  await b.click('.tb-btn:has-text("履歴")');
  await b.waitForSelector(".rev-row");
  const rows = () => b.$$eval(".rev-row", (els) => els.map((e) => e.querySelector(".rev-name").textContent + "|" + e.querySelector(".rev-stats").textContent));
  const before = await rows();
  assert.equal(before.length, 2);
  assert.equal(before[0], "Bob|書式・チェック");
  const [, added, deleted] = before[1].match(/^Alice\|\+(\d+) \/ −(\d+)文字$/) ?? [];
  assert.ok(Number(added) > Number(deleted), before[1]);

  // 一番古い版（Alice のまとまり）を表示して戻す
  await b.click(".rev-row >> nth=-1");
  await b.waitForSelector(".preview");
  await b.click(".sheet-foot .btn");
  for (const p of [a, b]) await p.waitForFunction(() => !document.querySelector('.editor [data-checked="true"]'));
  assert.equal(await editorHtml(a), await editorHtml(b));

  await b.click('.tb-btn:has-text("履歴")');
  await b.waitForSelector(".rev-row");
  await a.click(".name-chip");
  await a.fill(".overlay .text-input", "アリス");
  await a.click(".overlay .btn.primary");
  await b.waitForFunction(() => [...document.querySelectorAll(".rev-name")].some((e) => e.textContent === "アリス"));
  assert.deepEqual(await rows(), ["Bob|過去の版に復元", "Bob|書式・チェック", before[1].replace("Alice", "アリス")]);
  await close(a, b);
});

test("オフライン中の編集は再接続後に届く", async () => {
  const { a, b } = await pair();
  await b.context().setOffline(true);
  await b.waitForSelector(".status-banner:not([hidden])");
  await b.click(".editor");
  await b.keyboard.type("offline-B ");
  await a.click(".editor");
  await a.keyboard.type("online-A");
  await a.waitForTimeout(1500);
  assert.ok(!(await editorText(a)).includes("offline-B"));
  await b.context().setOffline(false);
  await a.waitForFunction(() => document.querySelector(".editor").textContent.includes("offline-B"), null, { timeout: 15000 });
  await a.waitForTimeout(800);
  assert.equal(await editorText(a), await editorText(b));
  await close(a, b);
});

test("オフライン中に変えた文書名は再接続後に反映される", async () => {
  const { a, b } = await pair();
  await b.context().setOffline(true);
  await b.waitForSelector(".status-banner:not([hidden])");
  await b.fill(".title-input", "オフラインで命名");
  await b.keyboard.press("Enter");
  await b.waitForSelector(".toast.show");
  assert.equal(await b.inputValue(".title-input"), "オフラインで命名", "入力が消えない");
  await b.context().setOffline(false);
  await a.waitForFunction(() => document.querySelector(".title-input").value === "オフラインで命名", null, { timeout: 15000 });
  await close(a, b);
});

test("画面復帰時に死んだ接続を検知して張り直す", async () => {
  const { a, b, url } = await pair();
  const c = await openAs("Carol", "/");
  // 接続を中継し、途中から一切通さない（close イベントの来ない死んだ接続）
  const links = [];
  await c.routeWebSocket(/\/ws$/, (route) => {
    const link = { dead: false };
    links.push(link);
    const server = route.connectToServer();
    route.onMessage((m) => !link.dead && server.send(m));
    server.onMessage((m) => !link.dead && route.send(m));
  });
  await c.goto(url);
  await c.waitForSelector(".editor");
  links[0].dead = true;
  await c.click(".editor");
  await c.keyboard.type("after-resume");
  await c.waitForTimeout(1500);
  assert.ok(!(await editorText(a)).includes("after-resume"), "死んだ接続では届かない");

  // バックグラウンドからの復帰
  await c.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await a.waitForFunction(() => document.querySelector(".editor").textContent.includes("after-resume"), null, { timeout: 15000 });
  assert.equal(links.length, 2, "接続を 1 回張り直した");
  await close(a, b, c);
});

test("名前モーダルと履歴シートの表示中は背後を操作できず、閉じるとフォーカスが戻る", async () => {
  const p = await openAs("Focus");
  await p.click(".new-btn");
  await p.waitForSelector(".editor");
  await p.focus(".name-chip");
  await p.keyboard.press("Enter");
  await p.waitForSelector(".overlay");
  assert.equal(await p.evaluate(() => document.getElementById("app").inert), true);
  for (let i = 0; i < 6; i++) {
    await p.keyboard.press("Tab");
    assert.equal(await p.evaluate(() => !!document.activeElement?.closest("#app")), false, "フォーカスが背後に出ない");
  }
  await p.click(".overlay .btn:not(.primary)");
  assert.equal(await p.evaluate(() => document.getElementById("app").inert), false);
  assert.equal(await p.evaluate(() => document.activeElement?.className), "name-chip", "名前チップにフォーカスが戻る");

  await p.click('.tb-btn:has-text("履歴")');
  await p.waitForSelector(".sheet.open");
  assert.equal(await p.evaluate(() => document.getElementById("app").inert), true);
  await p.click(".sheet .icon-btn:has-text('閉じる')");
  assert.equal(await p.evaluate(() => document.getElementById("app").inert), false);
  await close(p);
});

test("最近開いた文書が新しい順に並ぶ", async () => {
  const p = await openAs("Recent");
  await p.click(".new-btn");
  await p.waitForSelector(".editor");
  const first = p.url();
  await p.fill(".title-input", "買い物リスト");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(800);
  await p.click(".home-link");
  await p.click(".new-btn");
  await p.waitForSelector(".editor");
  await p.waitForTimeout(500);
  await p.click(".home-link");
  await p.waitForSelector(".recent-list");
  assert.deepEqual(await p.$$eval(".recent-title", (els) => els.map((e) => e.textContent)), ["無題の文書", "買い物リスト"]);
  await p.click(".recent-link >> nth=1");
  await p.waitForSelector(".editor");
  assert.equal(p.url(), first);
  await close(p);
});

test("ダークモードに追従する", async () => {
  const p = await openAs("Dark", "/", { colorScheme: "dark" });
  assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(19, 19, 21)");
  await close(p);
});

test("D1 が失敗しても止まらず、復旧後に自動で再接続する", async () => {
  const { a, b, url } = await pair();
  await close(b);
  d1Local("ALTER TABLE users RENAME TO users_down");
  try {
    await a.reload();
    await a.waitForTimeout(3000);
    assert.equal(await a.$(".editor"), null, "名前を確認できない間は開けない");
  } finally {
    d1Local("ALTER TABLE users_down RENAME TO users");
  }
  await a.waitForSelector(".editor", { timeout: 20000 });
  assert.equal(new URL(a.url()).pathname, new URL(url).pathname, "登録情報を消して再登録させたりしない");
  assert.equal(await a.$(".overlay"), null);
  await close(a);
});

test("ヘッダーの切り替えでライト／ダークが変わり、リロード後も保持する", async () => {
  const p = await openAs("Theme", "/", { colorScheme: "light" });
  const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await p.click(".new-btn");
  await p.waitForSelector(".editor");
  assert.equal(await bg(), "rgb(255, 255, 255)");
  assert.ok(await p.$(".header .theme-toggle .half-sun.on"), "ライトでは左半分の太陽を強調");
  assert.equal(await p.$$eval(".header .theme-toggle svg", (els) => els.length), 1, "太陽と満月は 1 つのアイコン");
  await p.click(".editor");
  await p.click(".header .theme-toggle");
  assert.equal(await bg(), "rgb(19, 19, 21)");
  assert.ok(await p.$(".header .theme-toggle .half-moon.on"), "ダークでは右半分の満月を強調");
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("ProseMirror")), true, "編集中のフォーカスを奪わない");
  await p.reload();
  await p.waitForSelector(".editor");
  assert.equal(await bg(), "rgb(19, 19, 21)", "リロード後も保持");
  await p.click(".header .theme-toggle");
  assert.equal(await bg(), "rgb(255, 255, 255)");
  await close(p);
});

test("リンク：URL の自動リンク化、ツールバーからの追加・編集・解除、同期", async () => {
  const { a, b } = await pair();
  await a.click(".editor");
  await a.keyboard.type("資料は https://example.com/guide. を見る");
  await a.waitForSelector('.editor a[href="https://example.com/guide"]');

  // 選択した文字をリンクにする
  await a.keyboard.press("Enter");
  await a.keyboard.type("公式サイト");
  await a.keyboard.press("Shift+Home");
  await a.click(".tb-link");
  await a.fill(".overlay .text-input", "javascript:alert(1)");
  await a.click(".overlay .btn.primary");
  assert.match(await a.textContent(".overlay .form-error"), /URL/, "javascript: は拒否");
  await a.fill(".overlay .text-input", "www.cloudflare.com");
  await a.click(".overlay .btn.primary");
  await a.waitForSelector(".overlay", { state: "detached" });
  await a.waitForSelector('.editor a[href="https://www.cloudflare.com"]');

  // 相手にも同期し、rel=noreferrer が付く
  await b.waitForSelector('.editor a[href="https://www.cloudflare.com"]', { timeout: 5000 });
  assert.equal(await b.getAttribute('.editor a[href="https://example.com/guide"]', "rel"), "noopener noreferrer nofollow");

  // カーソルをリンクに置くと操作バーが出て、開ける
  await a.click('.editor a[href="https://example.com/guide"]');
  await a.waitForSelector(".link-bar:not([hidden])");
  assert.equal(await a.textContent(".link-url"), "example.com/guide");
  const [popup] = await Promise.all([a.context().waitForEvent("page"), a.click('.link-bar button:has-text("開く")')]);
  assert.equal(popup.url(), "https://example.com/guide");
  await popup.close();

  // 解除
  await a.click('.link-bar button:has-text("解除")');
  await b.waitForFunction(() => !document.querySelector('.editor a[href="https://example.com/guide"]'), null, { timeout: 5000 });
  assert.equal(await editorHtml(a), await editorHtml(b));
  await close(a, b);
});

test("サーバーが埋め込んだ本文を読み込み中の表示に使い、接続後はエディタに置き換える", async () => {
  const p = await openAs("SSR");
  await p.click(".new-btn");
  await p.waitForSelector(".editor");
  await p.click(".editor");
  await p.keyboard.type("サーバー描画の確認");
  await p.waitForTimeout(1200);
  // JavaScript なしでも本文が見える
  const ctx = await p.context().browser().newContext({ javaScriptEnabled: false });
  const nojs = await ctx.newPage();
  await nojs.goto(p.url());
  assert.match(await nojs.textContent("#app"), /サーバー描画の確認/);
  await ctx.close();
  // JavaScript ありでは、エディタだけが残る（本文が二重にならない）
  await p.reload();
  await p.waitForSelector(".editor");
  assert.equal(await p.$(".ssr"), null);
  assert.equal(await editorText(p), "サーバー描画の確認");
  await close(p);
});

test("紹介ページはトップから開け、名前未登録でも名前モーダルなしで読める", async () => {
  const p = await openAs("About");
  await p.click(".about-link a");
  await p.waitForURL(BASE + "/about");
  await p.waitForSelector("h1");
  assert.match(await p.textContent("h1"), /一緒に書けるメモ/);
  await p.click(".btn >> nth=0");
  await p.waitForSelector(".new-btn");
  await close(p);

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const res = await page.goto(BASE + "/about");
  assert.equal(res.status(), 200);
  assert.equal(res.headers()["referrer-policy"], "no-referrer");
  assert.equal(res.headers()["x-robots-tag"], undefined, "紹介ページは検索エンジンに載せる");
  assert.equal(await page.$('meta[name="robots"]'), null);
  assert.equal(await page.$(".overlay"), null);
  assert.match(await page.textContent("body"), /リンクを知っている人は誰でも読み書きできる/);
  await browser.close();
});
