// 最終更新から一定期間で読み取り専用になることの試験。期間を数秒にした wrangler dev を別に起動する
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = String(Number(process.env.TEST_PORT ?? "8788") + 1);
const PERSIST_DIR = ".wrangler/test-state-archive";
const ARCHIVE_AFTER_MS = 6000;
process.env.BASE_URL = `http://localhost:${PORT}`;
process.env.PERSIST_DIR = PERSIST_DIR;
const { api, createDoc, hello, insertText, registerUser } = await import("./helpers.mjs");

let server;
before(async () => {
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "docshare", "--local", "--persist-to", PERSIST_DIR], {
    stdio: "ignore",
  });
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", PORT, "--persist-to", PERSIST_DIR, "--var", `ARCHIVE_AFTER_MS:${ARCHIVE_AFTER_MS}`],
    { stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await fetch(process.env.BASE_URL).then((r) => r.ok, () => false)) return;
  }
  throw new Error("wrangler dev が起動しなかった");
});
after(() => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // 終了済み
  }
});

test("最後の更新から期間がたつと読み取り専用になり、続きの文書は作れる", async () => {
  const user = await registerUser("期限");
  const docId = await createDoc();
  const { ws, init } = await hello(docId, user);
  assert.equal(init.archive, null);
  ws.sendJson({ type: "steps", version: init.version, clientId: "c1", steps: [insertText(1, "old")] });
  assert.equal((await ws.until("steps")).type, "steps");

  await sleep(ARCHIVE_AFTER_MS + 1000);
  ws.sendJson({ type: "steps", version: init.version + 1, clientId: "c1", steps: [insertText(1, "x")] });
  assert.equal((await ws.until("error")).code, "archived");
  const again = await hello(docId, user);
  assert.equal(again.init.archive.reason, "auto");

  const res = await api(`/api/docs/${docId}/continue`, { method: "POST" });
  assert.equal(res.status, 200);
  const next = await hello((await res.json()).docId, user);
  assert.equal(next.init.archive, null, "続きの文書は編集できる");
});
