import { DurableObject } from "cloudflare:workers";
import { Node, Slice } from "prosemirror-model";
import { AttrStep, DocAttrStep, ReplaceStep, Step } from "prosemirror-transform";
import { schema } from "../../shared/schema";
import {
  MAX_DOC_BYTES,
  MAX_WS_MESSAGE_BYTES,
  SECRET_RE,
  SNAPSHOT_INTERVAL,
  USER_ID_RE,
  WS_MESSAGES_PER_SECOND,
  sanitizeTitle,
} from "../../shared/constants";
import type {
  ClientMessage,
  ErrorCode,
  RevisionDocResponse,
  RevisionKind,
  RevisionListResponse,
  RevisionStats,
  ServerMessage,
  StepJSON,
} from "../../shared/messages";
import type { Env } from "../env";
import { getUserName, resolveNames, verifyUser } from "../users";

interface Attachment {
  userId: string | null;
  name: string;
}

interface Loaded {
  doc: Node;
  version: number;
  title: string;
}

const encoder = new TextEncoder();
const byteLength = (s: string): number => (s.length * 3 <= MAX_WS_MESSAGE_BYTES ? s.length : encoder.encode(s).length);
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** 前後の共通部分を除いた文字数の差 */
function textDiff(before: string, after: string): RevisionStats {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end++;
  }
  return { added: after.length - start - end, deleted: before.length - start - end };
}

export class DocRoom extends DurableObject<Env> {
  /** undefined: 未ロード / null: 文書が存在しない */
  private loaded: Loaded | null | undefined;
  private readonly sql: SqlStorage;
  private readonly rate = new WeakMap<WebSocket, { at: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // ping/pong は DO を起こさずに応答する
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- 状態の読み込み ----

  /** meta が未登録なら null。存在確認のために何も書き込まない */
  private load(): Loaded | null {
    if (this.loaded !== undefined) return this.loaded;
    let rows: { key: string; value: string }[];
    try {
      rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta").toArray();
    } catch {
      rows = [];
    }
    if (!rows.length) return (this.loaded = null);
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    const { doc, version } = this.docAt(Number.MAX_SAFE_INTEGER);
    return (this.loaded = { doc, version, title: meta.get("title") ?? "" });
  }

  /** 直近スナップショット ＋ 以降の revisions を再生して、指定 version 時点の文書を得る */
  private docAt(maxVersion: number): { doc: Node; version: number } {
    const snap = this.sql
      .exec<{ version: number; doc_json: string }>(
        "SELECT version, doc_json FROM snapshots WHERE version <= ? ORDER BY version DESC LIMIT 1",
        maxVersion,
      )
      .one();
    let doc = Node.fromJSON(schema, JSON.parse(snap.doc_json));
    let version = snap.version;
    const cursor = this.sql.exec<{ to_version: number; steps_json: string }>(
      "SELECT to_version, steps_json FROM revisions WHERE kind != 'title' AND from_version >= ? AND to_version <= ? ORDER BY rev_id",
      snap.version,
      maxVersion,
    );
    for (const row of cursor) {
      for (const stepJson of JSON.parse(row.steps_json) as StepJSON[]) {
        const result = Step.fromJSON(schema, stepJson).apply(doc);
        if (!result.doc) throw new Error(`revision replay failed: ${result.failed}`);
        doc = result.doc;
      }
      version = row.to_version;
    }
    return { doc, version };
  }

  private create(): void {
    const now = Date.now();
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS revisions (
          rev_id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          client_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          from_version INTEGER NOT NULL,
          to_version INTEGER NOT NULL,
          steps_json TEXT NOT NULL,
          stats_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS snapshots (version INTEGER PRIMARY KEY, doc_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
      );
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('title', ''), ('created_at', ?), ('version', '0')",
        String(now),
      );
      this.sql.exec(
        "INSERT INTO snapshots (version, doc_json, created_at) VALUES (0, ?, ?)",
        JSON.stringify(doc.toJSON()),
        now,
      );
    });
    this.loaded = { doc, version: 0, title: "" };
  }

  // ---- HTTP ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") {
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId: null, name: "" } satisfies Attachment);
      if (!this.load()) {
        this.send(server, { type: "error", code: "not_found" });
        server.close(4404, "not_found");
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/init" && request.method === "POST") {
      if (this.load()) return json({ error: "exists" }, 409);
      this.create();
      return json({ ok: true });
    }

    const state = this.load();
    if (!state) return json({ error: "not_found" }, 404);

    if (path === "/revisions" && request.method === "GET") {
      const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
      const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get("limit")) || 50)));
      return json(await this.listRevisions(before, limit));
    }

    const m = /^\/revisions\/(\d+)$/.exec(path);
    if (m && request.method === "GET") {
      const row = this.sql
        .exec<{ to_version: number }>("SELECT to_version FROM revisions WHERE rev_id = ?", Number(m[1]))
        .toArray()[0];
      if (!row) return json({ error: "not_found" }, 404);
      const { doc, version } = this.docAt(row.to_version);
      return json({ revId: Number(m[1]), version, doc: doc.toJSON() } satisfies RevisionDocResponse);
    }

    return json({ error: "not_found" }, 404);
  }

  private async listRevisions(before: number, limit: number): Promise<RevisionListResponse> {
    const rows = this.sql
      .exec<{
        rev_id: number;
        user_id: string;
        kind: RevisionKind;
        to_version: number;
        title_json: string | null;
        stats_json: string;
        created_at: number;
      }>(
        `SELECT rev_id, user_id, kind, to_version, stats_json, created_at,
                CASE WHEN kind = 'title' THEN steps_json END AS title_json
         FROM revisions WHERE rev_id < ? ORDER BY rev_id DESC LIMIT ?`,
        before,
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const names = await resolveNames(
      this.env.DB,
      page.map((r) => r.user_id),
    );
    return {
      revisions: page.map((r) => ({
        revId: r.rev_id,
        userId: r.user_id,
        name: names[r.user_id] ?? "",
        kind: r.kind,
        version: r.to_version,
        stats: JSON.parse(r.stats_json) as RevisionStats,
        ...(r.title_json ? { title: (JSON.parse(r.title_json) as { title: string }).title } : {}),
        createdAt: r.created_at,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].rev_id : null,
    };
  }

  // ---- WebSocket（Hibernation API）----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.allow(ws)) return this.error(ws, "rate_limited");
    if (typeof raw !== "string") return this.error(ws, "invalid");
    if (byteLength(raw) > MAX_WS_MESSAGE_BYTES) return this.error(ws, "too_large");
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.error(ws, "invalid");
    }
    if (!msg || typeof msg !== "object") return this.error(ws, "invalid");

    if (msg.type === "hello") return this.onHello(ws, msg);

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.userId) return this.error(ws, "unauthorized");
    const state = this.load();
    if (!state) return this.error(ws, "not_found");

    switch (msg.type) {
      case "steps":
        return this.onSteps(ws, att.userId, state, msg);
      case "title":
        return this.onTitle(ws, att.userId, state, msg.title);
      case "sync":
        return this.onSync(ws, state, msg.version);
      case "rename":
        return this.onRename(att.userId);
      case "restore":
        return this.onRestore(ws, att.userId, state, msg.revId);
      default:
        return this.error(ws, "invalid");
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // すでに閉じている
    }
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  private async onHello(ws: WebSocket, msg: { userId: string; secret: string }): Promise<void> {
    const valid =
      typeof msg.userId === "string" &&
      typeof msg.secret === "string" &&
      USER_ID_RE.test(msg.userId) &&
      SECRET_RE.test(msg.secret);
    const name = valid ? await verifyUser(this.env.DB, msg.userId, msg.secret) : null;
    if (name === null) {
      this.error(ws, "unauthorized");
      ws.close(4401, "unauthorized");
      return;
    }
    const state = this.load();
    if (!state) return this.error(ws, "not_found");

    ws.serializeAttachment({ userId: msg.userId, name } satisfies Attachment);
    const users: Record<string, string> = {};
    for (const { att } of this.sessions()) users[att.userId!] = att.name;
    this.send(ws, {
      type: "init",
      version: state.version,
      doc: state.doc.toJSON(),
      title: state.title,
      users,
    });
    this.broadcast({ type: "rename", userId: msg.userId, name }, ws);
    this.broadcastPresence();
  }

  private onSteps(
    ws: WebSocket,
    userId: string,
    state: Loaded,
    msg: { version: number; clientId: string; steps: StepJSON[] },
  ): void {
    if (
      !Number.isInteger(msg.version) ||
      typeof msg.clientId !== "string" ||
      msg.clientId.length > 64 ||
      !Array.isArray(msg.steps) ||
      msg.steps.length === 0
    ) {
      return this.error(ws, "invalid");
    }
    if (msg.version !== state.version) return this.error(ws, "version_mismatch");

    let doc = state.doc;
    const steps: Step[] = [];
    const stats: RevisionStats = { added: 0, deleted: 0 };
    try {
      for (const stepJson of msg.steps) {
        const step = Step.fromJSON(schema, stepJson);
        if (!this.attrsDeclared(step, doc)) throw new Error("undeclared attr");
        const result = step.apply(doc);
        if (!result.doc) throw new Error(result.failed ?? "apply failed");
        const before = doc;
        const after = result.doc;
        step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
          const d = textDiff(before.textBetween(oldStart, oldEnd, "\n"), after.textBetween(newStart, newEnd, "\n"));
          stats.added += d.added;
          stats.deleted += d.deleted;
        });
        doc = after;
        steps.push(step);
      }
      doc.check();
    } catch {
      return this.error(ws, "invalid");
    }
    if (this.tooLarge(doc)) return this.error(ws, "too_large");
    this.commit(state, "steps", userId, msg.clientId, steps, doc, stats);
  }

  private onTitle(ws: WebSocket, userId: string, state: Loaded, rawTitle: unknown): void {
    const title = sanitizeTitle(rawTitle);
    if (title === null) return this.error(ws, typeof rawTitle === "string" ? "too_large" : "invalid");
    if (title === state.title) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE meta SET value = ? WHERE key = 'title'", title);
      this.sql.exec(
        `INSERT INTO revisions (user_id, client_id, kind, from_version, to_version, steps_json, stats_json, created_at)
         VALUES (?, '', 'title', ?, ?, ?, ?, ?)`,
        userId,
        state.version,
        state.version,
        JSON.stringify({ title }),
        JSON.stringify({ added: 0, deleted: 0 } satisfies RevisionStats),
        Date.now(),
      );
    });
    state.title = title;
    this.broadcast({ type: "title", title, userId });
  }

  /** 再接続したクライアントへ、手元の version 以降の差分を送る */
  private onSync(ws: WebSocket, state: Loaded, version: unknown): void {
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > state.version) {
      return this.error(ws, "invalid");
    }
    const cursor = this.sql.exec<{
      rev_id: number;
      user_id: string;
      client_id: string;
      from_version: number;
      to_version: number;
      steps_json: string;
    }>(
      "SELECT rev_id, user_id, client_id, from_version, to_version, steps_json FROM revisions WHERE kind != 'title' AND to_version > ? ORDER BY rev_id",
      version,
    );
    let expected = version;
    for (const row of cursor) {
      // リビジョンの途中からは再開できない
      if (row.from_version !== expected) return this.error(ws, "invalid");
      const steps = JSON.parse(row.steps_json) as StepJSON[];
      this.send(ws, {
        type: "steps",
        version: row.to_version,
        revId: row.rev_id,
        userId: row.user_id,
        clientIds: steps.map(() => row.client_id),
        steps,
      });
      expected = row.to_version;
    }
  }

  private async onRename(userId: string): Promise<void> {
    const name = await getUserName(this.env.DB, userId);
    if (name === null) return;
    for (const { ws, att } of this.sessions()) {
      if (att.userId === userId) ws.serializeAttachment({ userId, name } satisfies Attachment);
    }
    this.broadcast({ type: "rename", userId, name });
  }

  /** 過去版の文書で現在の文書全体を置換する step を、新しいリビジョンとして追加する */
  private onRestore(ws: WebSocket, userId: string, state: Loaded, revId: unknown): void {
    if (typeof revId !== "number" || !Number.isInteger(revId)) return this.error(ws, "invalid");
    const row = this.sql
      .exec<{ to_version: number }>("SELECT to_version FROM revisions WHERE rev_id = ?", revId)
      .toArray()[0];
    if (!row) return this.error(ws, "invalid");
    const target = this.docAt(row.to_version).doc;
    if (target.eq(state.doc)) return;
    const step = new ReplaceStep(0, state.doc.content.size, new Slice(target.content, 0, 0));
    const result = step.apply(state.doc);
    if (!result.doc) return this.error(ws, "invalid");
    const size = state.doc.content.size;
    const stats = textDiff(
      state.doc.textBetween(0, size, "\n"),
      result.doc.textBetween(0, result.doc.content.size, "\n"),
    );
    this.commit(state, "restore", userId, "server", [step], result.doc, stats);
  }

  /** リビジョンを保存し、version を進めて全員に配信する */
  private commit(
    state: Loaded,
    kind: RevisionKind,
    userId: string,
    clientId: string,
    steps: Step[],
    doc: Node,
    stats: RevisionStats,
  ): void {
    const from = state.version;
    const to = from + steps.length;
    const stepsJson = steps.map((s) => s.toJSON() as StepJSON);
    const now = Date.now();
    let revId = 0;
    this.ctx.storage.transactionSync(() => {
      revId = this.sql
        .exec<{ rev_id: number }>(
          `INSERT INTO revisions (user_id, client_id, kind, from_version, to_version, steps_json, stats_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING rev_id`,
          userId,
          clientId,
          kind,
          from,
          to,
          JSON.stringify(stepsJson),
          JSON.stringify(stats),
          now,
        )
        .one().rev_id;
      this.sql.exec("UPDATE meta SET value = ? WHERE key = 'version'", String(to));
      if (Math.floor(to / SNAPSHOT_INTERVAL) > Math.floor(from / SNAPSHOT_INTERVAL)) {
        this.sql.exec(
          "INSERT OR REPLACE INTO snapshots (version, doc_json, created_at) VALUES (?, ?, ?)",
          to,
          JSON.stringify(doc.toJSON()),
          now,
        );
      }
    });
    state.doc = doc;
    state.version = to;
    this.broadcast({
      type: "steps",
      version: to,
      revId,
      userId,
      clientIds: stepsJson.map(() => clientId),
      steps: stepsJson,
    });
  }

  // ---- 補助 ----

  /** schema に宣言されていない属性を書き換える step は、適用しても無視されるだけなので受け付けない */
  private attrsDeclared(step: Step, doc: Node): boolean {
    if (step instanceof DocAttrStep) return Object.hasOwn(doc.type.spec.attrs ?? {}, step.attr);
    if (step instanceof AttrStep) {
      const node = doc.nodeAt(step.pos);
      return !!node && Object.hasOwn(node.type.spec.attrs ?? {}, step.attr);
    }
    return true;
  }

  private tooLarge(doc: Node): boolean {
    // 小さい文書では JSON 化を省く（1位置あたり40バイトを超えることはまずない）
    if (doc.nodeSize * 40 <= MAX_DOC_BYTES) return false;
    return encoder.encode(JSON.stringify(doc.toJSON())).length > MAX_DOC_BYTES;
  }

  /** 1接続あたり毎秒 WS_MESSAGES_PER_SECOND メッセージまで */
  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rate.get(ws);
    if (!r || now - r.at >= 1000) {
      this.rate.set(ws, { at: now, count: 1 });
      return true;
    }
    return ++r.count <= WS_MESSAGES_PER_SECOND;
  }

  /** hello 済みの接続 */
  private sessions(except?: WebSocket): { ws: WebSocket; att: Attachment }[] {
    const out: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.userId) out.push({ ws, att });
    }
    return out;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 切断済み
    }
  }

  private error(ws: WebSocket, code: ErrorCode): void {
    this.send(ws, { type: "error", code });
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const { ws } of this.sessions(except)) {
      try {
        ws.send(data);
      } catch {
        // 切断済み
      }
    }
  }

  private broadcastPresence(except?: WebSocket): void {
    const userIds = [...new Set(this.sessions(except).map((s) => s.att.userId!))];
    this.broadcast({ type: "presence", userIds }, except);
  }
}
