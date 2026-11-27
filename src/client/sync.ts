import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { MAX_WS_MESSAGE_BYTES, SEND_DEBOUNCE_MS, SEND_MAX_WAIT_MS } from "../shared/constants";
import type { ArchiveInfo, ClientMessage, ServerMessage, StepJSON } from "../shared/messages";
import { schema } from "../shared/schema";
import { createState } from "./editor";
import type { User } from "./user";

export interface SyncCallbacks {
  /** 初回 init で view を作る */
  createView(state: EditorState): EditorView;
  onInit(msg: Extract<ServerMessage, { type: "init" }>): void;
  onStatus(online: boolean): void;
  onTitle(title: string): void;
  onPresence(userIds: string[]): void;
  onRename(userId: string, name: string): void;
  /** 完了・取り消し・期限切れ・続きの文書の作成 */
  onArchive(archive: ArchiveInfo | null): void;
  /** 文書が進んだ（履歴の再読込用） */
  onRevision(): void;
  onNotFound(): void;
  onUnauthorized(): void;
  /** 未送信の編集を破棄してサーバーの状態に戻した */
  onReset(reason: "too_large" | "invalid" | "archived"): void;
}

const encoder = new TextEncoder();
const PING_MS = 30_000;
/** 接続開始から init を受け取るまでの上限 */
const HANDSHAKE_MS = 15_000;
/** 復帰時の生存確認で pong を待つ時間 */
const PROBE_MS = 5_000;

export class DocConnection {
  private ws: WebSocket | null = null;
  private view: EditorView | null = null;
  private readonly clientId = crypto.randomUUID();
  private inflight = false;
  private synced = false;
  private syncTarget = 0;
  private needReset = false;
  private closed = false;
  private retry = 0;
  private sendTimer = 0;
  private firstPendingAt = 0;
  private reconnectTimer = 0;
  private pingTimer = 0;
  private handshakeTimer = 0;
  private probeTimer = 0;
  private lastPong = 0;

  constructor(
    private readonly docId: string,
    private readonly getUser: () => User,
    private readonly cb: SyncCallbacks,
  ) {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  // ---- 接続 ----

  private connect(): void {
    if (this.closed || this.ws) return;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/docs/${this.docId}/ws`);
    this.ws = ws;
    // サーバーが応答しないまま止まらないよう、init が来なければ張り直す
    this.handshakeTimer = window.setTimeout(() => this.dropped(ws), HANDSHAKE_MS);
    ws.onopen = () => {
      const { userId, secret } = this.getUser();
      this.send({ type: "hello", userId, secret });
      this.lastPong = Date.now();
      this.pingTimer = window.setInterval(() => {
        if (Date.now() - this.lastPong > PING_MS * 2.5) return this.dropped(ws);
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      if (e.data === "pong") {
        this.lastPong = Date.now();
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => this.dropped(ws);
  }

  /** 接続を切断済みとして扱い、再接続を予約する。close イベントの到着を待たない */
  private dropped(ws: WebSocket): void {
    if (this.ws !== ws) return;
    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.probeTimer);
    this.ws = null;
    this.synced = false;
    this.inflight = false;
    try {
      ws.close();
    } catch {
      // すでに閉じている
    }
    if (this.closed) return;
    this.cb.onStatus(false);
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private readonly onOnline = (): void => {
    this.retry = 0;
    if (!this.ws) this.connect();
    else this.probe();
  };

  /**
   * 接続が生きているかを確かめる。回線の切り替えやバックグラウンドからの復帰後は、
   * close イベントが来ないまま接続だけが死んでいることがある
   */
  private probe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const sentAt = Date.now();
    ws.send("ping");
    clearTimeout(this.probeTimer);
    this.probeTimer = window.setTimeout(() => {
      if (this.lastPong < sentAt) this.dropped(ws);
    }, PROBE_MS);
  }

  /** 回線断を検知したら、ping のタイムアウトを待たずに閉じて再接続に備える */
  private readonly onOffline = (): void => {
    if (this.ws) this.dropped(this.ws);
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.sendNow();
    else if (!this.ws) this.connect();
    else this.probe();
  };

  destroy(): void {
    this.sendNow();
    this.closed = true;
    clearTimeout(this.sendTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.probeTimer);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // ---- 受信 ----

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "init":
        return this.onInit(msg);
      case "steps":
        return this.onSteps(msg);
      case "title":
        return this.cb.onTitle(msg.title);
      case "presence":
        return this.cb.onPresence(msg.userIds);
      case "rename":
        return this.cb.onRename(msg.userId, msg.name);
      case "archive":
        return this.cb.onArchive(msg.archive);
      case "error":
        return this.onError(msg.code);
    }
  }

  private onInit(msg: Extract<ServerMessage, { type: "init" }>): void {
    clearTimeout(this.handshakeTimer);
    this.retry = 0;
    const local = this.view ? getVersion(this.view.state) : -1;
    if (!this.view || this.needReset || msg.version < local) {
      const state = createState(Node.fromJSON(schema, msg.doc), [
        collab({ version: msg.version, clientID: this.clientId }),
      ]);
      if (this.view) this.view.updateState(state);
      else this.view = this.cb.createView(state);
      this.needReset = false;
      this.synced = true;
    } else if (msg.version === local) {
      this.synced = true;
    } else {
      // 再接続：切断中の差分を受け取ってから未送信 step を再送する
      this.syncTarget = msg.version;
      this.send({ type: "sync", version: local });
    }
    this.cb.onInit(msg);
    this.cb.onStatus(true);
    if (this.synced) this.sendNow();
  }

  private onSteps(msg: Extract<ServerMessage, { type: "steps" }>): void {
    const view = this.view;
    if (!view) return;
    const current = getVersion(view.state);
    const from = msg.version - msg.steps.length;
    if (from < current) return; // 受信済み
    if (from > current) {
      // 抜けがある：差分を取り直す
      this.synced = false;
      this.syncTarget = msg.version;
      this.send({ type: "sync", version: current });
      return;
    }
    let steps: Step[];
    try {
      steps = msg.steps.map((s) => Step.fromJSON(schema, s));
    } catch {
      return this.reset("invalid");
    }
    const tr = receiveTransaction(view.state, steps, msg.clientIds, { mapSelectionBackward: true });
    view.dispatch(tr);
    if (msg.clientIds[0] === this.clientId) this.inflight = false;
    if (!this.synced && getVersion(view.state) >= this.syncTarget) this.synced = true;
    this.cb.onRevision();
    this.sendNow();
  }

  private onError(code: Extract<ServerMessage, { type: "error" }>["code"]): void {
    switch (code) {
      case "version_mismatch":
        // 先行 step は受信済み（rebase 済み）なので、そのまま再送する
        this.inflight = false;
        window.setTimeout(() => this.sendNow(), 30);
        return;
      case "rate_limited":
        this.inflight = false;
        window.setTimeout(() => this.sendNow(), 1000);
        return;
      case "too_large":
      case "invalid":
      case "archived":
        // archived：読み取り専用になった文書への編集。送れなかった分を捨ててサーバーの状態を取り直す
        return this.reset(code);
      case "not_found":
        this.closed = true;
        this.ws?.close();
        return this.cb.onNotFound();
      case "unauthorized":
        this.closed = true;
        this.ws?.close();
        return this.cb.onUnauthorized();
    }
  }

  /** 未送信の編集を破棄し、再接続してサーバーの状態を取り直す */
  private reset(reason: "too_large" | "invalid" | "archived"): void {
    this.needReset = true;
    this.retry = 0;
    if (this.ws) this.dropped(this.ws);
    this.cb.onReset(reason);
  }

  // ---- 送信 ----

  /** ローカル編集のたびに呼ぶ。入力停止 500ms 後（最大 2 秒間隔）に送信 */
  handleTransaction(tr: Transaction): void {
    if (!tr.docChanged || !this.view || !sendableSteps(this.view.state)) return;
    const now = Date.now();
    if (!this.firstPendingAt) this.firstPendingAt = now;
    const wait = Math.min(SEND_DEBOUNCE_MS, Math.max(0, this.firstPendingAt + SEND_MAX_WAIT_MS - now));
    clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.sendNow(), wait);
  }

  private sendNow(): void {
    clearTimeout(this.sendTimer);
    this.firstPendingAt = 0;
    if (!this.view || !this.synced || this.inflight) return;
    const sendable = sendableSteps(this.view.state);
    if (!sendable) return;
    // 1メッセージの上限に収まる分だけ送る（残りは確定後に続けて送る）
    const steps: StepJSON[] = [];
    let bytes = 256;
    for (const step of sendable.steps) {
      const stepJson = step.toJSON() as StepJSON;
      bytes += encoder.encode(JSON.stringify(stepJson)).length + 1;
      if (steps.length && bytes > MAX_WS_MESSAGE_BYTES) break;
      steps.push(stepJson);
    }
    if (this.send({ type: "steps", version: sendable.version, clientId: this.clientId, steps })) {
      this.inflight = true;
    }
  }

  get version(): number {
    return this.view ? getVersion(this.view.state) : 0;
  }

  /** 送信できなければ false（オフライン中など） */
  sendTitle(title: string): boolean {
    return this.send({ type: "title", version: this.version, title });
  }

  sendRename(): void {
    this.send({ type: "rename" });
  }

  sendRestore(revId: number): boolean {
    return this.send({ type: "restore", revId });
  }

  /** 送信できなければ false */
  sendClose(): boolean {
    return this.send({ type: "close" });
  }

  sendReopen(): boolean {
    return this.send({ type: "reopen" });
  }
}
