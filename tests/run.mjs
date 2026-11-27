// テスト用の wrangler dev を起動し、tests/*.test.mjs を順に実行する。
// 保存先（.wrangler/test-state）とポートを分けるので、普段の開発データには触れない。
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.TEST_PORT ?? "8788";
const PERSIST_DIR = ".wrangler/test-state";
const BASE_URL = `http://localhost:${PORT}`;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

rmSync(PERSIST_DIR, { recursive: true, force: true });
run("npx", ["vite", "build", "--logLevel", "warn"]);
run("npx", ["wrangler", "d1", "migrations", "apply", "docshare", "--local", "--persist-to", PERSIST_DIR]);

// 試験では文書を多く作るので、文書作成の全体上限を引き上げる
const server = spawn("npx", ["wrangler", "dev", "--port", PORT, "--persist-to", PERSIST_DIR, "--var", "GLOBAL_CREATE_PER_MINUTE:1000"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // 終了済み
  }
};
process.on("exit", stop);

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  ready = await fetch(BASE_URL).then((r) => r.ok, () => false);
}
if (!ready) {
  console.error(log);
  console.error("wrangler dev が起動しなかった");
  process.exit(1);
}

const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-force-exit", ...(files.length ? files : ["tests/protocol.test.mjs", "tests/archive.test.mjs", "tests/e2e.test.mjs"])],
  { stdio: "inherit", env: { ...process.env, BASE_URL, PERSIST_DIR } },
);
if (result.status !== 0 && process.env.TEST_SERVER_LOG) console.error(log);
process.exit(result.status ?? 1);
