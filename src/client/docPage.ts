import type { EditorView } from "prosemirror-view";
import { TITLE_MAX, sanitizeTitle } from "../shared/constants";
import { createView } from "./editor";
import { createToolbar } from "./toolbar";
import { h, toast } from "./dom";
import { nameModal } from "./modal";
import { removeRecent, touchRecent } from "./recent";
import { DocConnection } from "./sync";
import { clearUser, renameUser, type User } from "./user";

export interface PageContext {
  getUser(): User;
  setUser(user: User): void;
  showNotFound(): void;
}

const UNTITLED = "無題の文書";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非セキュアコンテキストなど：一時的な input 経由でコピー
    const input = h("input", { value: text, readOnly: true, style: "position:fixed;opacity:0" });
    document.body.append(input);
    input.select();
    const ok = document.execCommand("copy");
    input.remove();
    return ok;
  }
}

export function renderDocPage(app: HTMLElement, docId: string, ctx: PageContext): () => void {
  let view: EditorView | null = null;
  let title = "";
  let online = false;

  const titleInput = h("input", {
    class: "title-input",
    type: "text",
    placeholder: UNTITLED,
    maxLength: TITLE_MAX,
    enterKeyHint: "done",
    "aria-label": "文書名",
  });
  const presence = h("span", { class: "presence", title: "接続人数" }, "0");
  const nameChip = h("button", { class: "name-chip", type: "button", title: "名前を変更" }, ctx.getUser().name);
  const header = h(
    "header",
    { class: "header" },
    h("a", { class: "home-link", href: "/", title: "トップへ", "aria-label": "トップへ" }, "‹"),
    titleInput,
    presence,
    nameChip,
  );
  const banner = h("div", { class: "status-banner", role: "status", hidden: true }, "オフライン。再接続中…");
  const mount = h("main", { class: "doc-main" }, h("p", { class: "sheet-note" }, "読み込み中…"));

  const applyTitle = (next: string) => {
    title = next;
    if (document.activeElement !== titleInput) titleInput.value = next;
    document.title = `${next || UNTITLED} | docshare`;
    touchRecent(docId, next);
  };

  const conn = new DocConnection(docId, ctx.getUser, {
    createView(state) {
      mount.replaceChildren();
      view = createView(mount, {
        state,
        onTransaction: (tr) => conn.handleTransaction(tr),
        onUpdate: (v) => toolbar.update(v),
      });
      toolbar.update(view);
      return view;
    },
    onInit(msg) {
      applyTitle(msg.title);
    },
    onStatus(next) {
      online = next;
      presence.classList.toggle("online", next);
      banner.hidden = next || !view;
    },
    onTitle: applyTitle,
    onPresence(userIds) {
      presence.textContent = String(userIds.length);
      presence.setAttribute("aria-label", `接続中 ${userIds.length}人`);
    },
    onRename(userId, name) {
      const me = ctx.getUser();
      if (userId === me.userId && name !== me.name) {
        // 別タブでの名前変更を反映
        ctx.setUser({ ...me, name });
        nameChip.textContent = name;
      }
    },
    onRevision() {},
    onNotFound() {
      removeRecent(docId);
      ctx.showNotFound();
    },
    onUnauthorized() {
      // 登録情報がサーバーにない：登録し直す
      clearUser();
      location.reload();
    },
    onReset(reason) {
      toast(reason === "too_large" ? "サイズ上限を超えたため編集を取り消した" : "同期できない編集を取り消した");
    },
  });

  const toolbar = createToolbar(() => view, {
    onHistory: () => toast("履歴は未実装"),
    async onShare() {
      const url = `${location.origin}/d/${docId}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: title || UNTITLED, url });
        } catch {
          // キャンセル
        }
        return;
      }
      toast((await copyText(url)) ? "リンクをコピーした" : "コピーできなかった");
    },
  });

  // 文書名：フォーカスを外すか Enter で確定
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) titleInput.blur();
    if (e.key === "Escape") {
      titleInput.value = title;
      titleInput.blur();
    }
  });
  titleInput.addEventListener("blur", () => {
    const next = sanitizeTitle(titleInput.value);
    if (next === null || next === title || !online) {
      titleInput.value = title;
      return;
    }
    titleInput.value = next;
    conn.sendTitle(next);
  });

  nameChip.addEventListener("click", () => {
    void nameModal({
      title: "名前を変更",
      description: "過去の編集履歴の名前も新しい名前で表示される。",
      initial: ctx.getUser().name,
      dismissable: true,
      async submit(name) {
        const next = await renameUser(ctx.getUser(), name);
        ctx.setUser(next);
        nameChip.textContent = next.name;
        conn.sendRename();
      },
    });
  });

  app.replaceChildren(header, banner, mount, toolbar.el);

  return () => {
    conn.destroy();
    view?.destroy();
    toolbar.destroy();
  };
}
