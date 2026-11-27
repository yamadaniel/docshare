import { DOMSerializer, Node } from "prosemirror-model";
import { HISTORY_GROUP_MS, HISTORY_PAGE } from "../shared/constants";
import type { RevisionDocResponse, RevisionListResponse, RevisionSummary } from "../shared/messages";
import { schema } from "../shared/schema";
import { h, inertApp, toast } from "./dom";

interface Group {
  /** グループ内で最も新しいリビジョン（表示・復元の対象） */
  revId: number;
  userId: string;
  name: string;
  kind: RevisionSummary["kind"];
  createdAt: number;
  added: number;
  deleted: number;
  title?: string;
}

export interface HistorySheet {
  open(): void;
  /** 文書が進んだときに一覧を更新する */
  refresh(): void;
  rename(userId: string, name: string): void;
  destroy(): void;
}

interface Options {
  docId: string;
  /** 復元を依頼する。送信できなければ false */
  restore(revId: number): boolean;
  /** 読み取り専用の文書では復元できない */
  canRestore(): boolean;
}

/** 同じ人の 60 秒以内の連続リビジョンをまとめる（revisions は新しい順） */
function groupRevisions(revisions: RevisionSummary[]): Group[] {
  const groups: Group[] = [];
  let oldest = 0;
  for (const r of revisions) {
    const g = groups[groups.length - 1];
    if (
      g &&
      g.kind === "steps" &&
      r.kind === "steps" &&
      g.userId === r.userId &&
      oldest - r.createdAt < HISTORY_GROUP_MS
    ) {
      g.added += r.stats.added;
      g.deleted += r.stats.deleted;
    } else {
      groups.push({
        revId: r.revId,
        userId: r.userId,
        name: r.name,
        kind: r.kind,
        createdAt: r.createdAt,
        added: r.stats.added,
        deleted: r.stats.deleted,
        title: r.title,
      });
    }
    oldest = r.createdAt;
  }
  return groups;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} ${time}`;
}

function statsNode(g: Group): HTMLElement {
  if (g.kind === "title") return h("span", { class: "rev-stats" }, "文書名を変更");
  if (g.kind === "restore") return h("span", { class: "rev-stats" }, "過去の版に復元");
  if (g.kind === "close") return h("span", { class: "rev-stats" }, "完了にした");
  if (g.kind === "reopen") return h("span", { class: "rev-stats" }, "完了を取り消した");
  if (!g.added && !g.deleted) return h("span", { class: "rev-stats" }, "書式・チェック");
  return h(
    "span",
    { class: "rev-stats" },
    h("span", { class: "add" }, `+${g.added}`),
    " / ",
    h("span", { class: "del" }, `−${g.deleted}`),
    "文字",
  );
}

export function createHistorySheet(opts: Options): HistorySheet {
  let revisions: RevisionSummary[] = [];
  let nextBefore: number | null = null;
  let isOpen = false;
  let preview: Group | null = null;
  let loadSeq = 0;
  let refreshTimer = 0;
  let releaseInert = () => {};

  const heading = h("h2", null, "履歴");
  const backBtn = h("button", { class: "icon-btn", type: "button", hidden: true }, "‹ 一覧");
  const closeBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "閉じる" }, "閉じる");
  const body = h("div", { class: "sheet-body" });
  const restoreBtn = h("button", { class: "btn primary", type: "button" }, "この版に戻す");
  const foot = h("div", { class: "sheet-foot", hidden: true }, restoreBtn);
  const sheet = h(
    "section",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "履歴" },
    h("div", { class: "sheet-head" }, backBtn, heading, closeBtn),
    body,
    foot,
  );
  const overlay = h("div", { class: "sheet-overlay" });

  const note = (text: string) => h("p", { class: "sheet-note" }, text);

  function renderList(): void {
    preview = null;
    backBtn.hidden = true;
    foot.hidden = true;
    heading.replaceChildren("履歴");
    const groups = groupRevisions(revisions);
    if (!groups.length) {
      // 読み取り専用の文書は、アーカイブ時に履歴を消して確定版だけを残している
      body.replaceChildren(note(opts.canRestore() ? "まだ編集がない。" : "アーカイブ時に履歴を整理した。残っているのは確定版だけ。"));
      return;
    }
    const list = h(
      "ul",
      { class: "rev-list" },
      ...groups.map((g) => {
        const row = h(
          "button",
          { class: "rev-row", type: "button" },
          h(
            "span",
            { class: "rev-main" },
            h("span", { class: "rev-name" }, g.name || "不明なユーザー"),
            h("span", { class: "rev-time" }, g.kind === "title" ? `${formatTime(g.createdAt)}「${g.title ?? ""}」` : formatTime(g.createdAt)),
          ),
          statsNode(g),
        );
        row.addEventListener("click", () => void showPreview(g));
        return h("li", null, row);
      }),
    );
    body.replaceChildren(list);
    if (nextBefore !== null) {
      const more = h("button", { class: "btn more-btn", type: "button" }, "さらに表示");
      more.addEventListener("click", () => {
        more.disabled = true;
        void load(false);
      });
      body.append(more);
    }
  }

  async function load(reset: boolean): Promise<void> {
    const seq = ++loadSeq;
    const before = reset || nextBefore === null ? "" : `&before=${nextBefore}`;
    try {
      const res = await fetch(`/api/docs/${opts.docId}/revisions?limit=${HISTORY_PAGE}${before}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as RevisionListResponse;
      if (seq !== loadSeq) return;
      revisions = reset ? data.revisions : [...revisions, ...data.revisions];
      nextBefore = data.nextBefore;
      if (isOpen && !preview) renderList();
    } catch {
      if (seq === loadSeq && isOpen && !preview) body.replaceChildren(note("履歴を読み込めなかった。"));
    }
  }

  async function showPreview(g: Group): Promise<void> {
    preview = g;
    backBtn.hidden = false;
    foot.hidden = true;
    heading.replaceChildren(g.name || "不明なユーザー", h("span", { class: "sub" }, `${formatTime(g.createdAt)} の版`));
    body.replaceChildren(note("読み込み中…"));
    try {
      const res = await fetch(`/api/docs/${opts.docId}/revisions/${g.revId}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as RevisionDocResponse;
      if (preview !== g) return;
      const doc = Node.fromJSON(schema, data.doc);
      const content = h("div", { class: "preview" });
      content.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
      body.replaceChildren(content);
      body.scrollTop = 0;
      foot.hidden = !opts.canRestore();
    } catch {
      if (preview === g) body.replaceChildren(note("この版を読み込めなかった。"));
    }
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    preview = null;
    sheet.classList.remove("open");
    overlay.remove();
    releaseInert();
    document.removeEventListener("keydown", onKey);
    window.setTimeout(() => {
      if (!isOpen) sheet.remove();
    }, 250);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  overlay.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  backBtn.addEventListener("click", renderList);
  restoreBtn.addEventListener("click", () => {
    if (!preview) return;
    if (!opts.restore(preview.revId)) {
      toast("オフラインのため戻せない");
      return;
    }
    toast("この版に戻した");
    close();
  });

  return {
    open() {
      if (isOpen) return;
      isOpen = true;
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.append(overlay, sheet);
      releaseInert = inertApp();
      document.addEventListener("keydown", onKey);
      body.replaceChildren(note("読み込み中…"));
      backBtn.hidden = true;
      foot.hidden = true;
      heading.replaceChildren("履歴");
      // 追加直後の再描画を待ってからスライドさせる
      requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add("open")));
      void load(true);
    },
    refresh() {
      if (!isOpen || preview) return;
      clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (isOpen && !preview) void load(true);
      }, 800);
    },
    rename(userId, name) {
      let changed = false;
      for (const r of revisions) {
        if (r.userId === userId && r.name !== name) {
          r.name = name;
          changed = true;
        }
      }
      if (changed && isOpen && !preview) renderList();
    },
    destroy() {
      clearTimeout(refreshTimer);
      isOpen = false;
      overlay.remove();
      sheet.remove();
      releaseInert();
      document.removeEventListener("keydown", onKey);
    },
  };
}
