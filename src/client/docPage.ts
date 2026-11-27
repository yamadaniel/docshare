import type { EditorView } from "prosemirror-view";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { HREF_MAX, TITLE_MAX, normalizeHref, sanitizeTitle } from "../shared/constants";
import { linkAt, setLink } from "./commands";
import { createView } from "./editor";
import { createToolbar } from "./toolbar";
import { h, toast } from "./dom";
import { createHistorySheet } from "./history";
import { pickImage, uploadImage } from "./images";
import { schema } from "../shared/schema";
import { confirmModal, nameModal, promptModal } from "./modal";
import type { ArchiveInfo } from "../shared/messages";
import { removeRecent, touchRecent } from "./recent";
import { DocConnection } from "./sync";
import { createThemeToggle } from "./theme";
import { clearUser, renameUser, type User } from "./user";

export interface PageContext {
  getUser(): User;
  setUser(user: User): void;
  showNotFound(): void;
  navigate(path: string): void;
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
  /** オフライン中に変更した文書名。再接続後に送る */
  let pendingTitle: string | null = null;
  /** 読み取り専用（完了・期限切れ）なら理由。編集できるなら null */
  let archive: ArchiveInfo | null = null;

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
  const themeToggle = createThemeToggle();
  const header = h(
    "header",
    { class: "header" },
    h("a", { class: "home-link", href: "/", title: "トップへ", "aria-label": "トップへ" }, "‹"),
    titleInput,
    themeToggle.el,
    presence,
    nameChip,
  );
  const banner = h("div", { class: "status-banner", role: "status", hidden: true }, "オフライン。再接続中…");
  const archiveText = h("p", { class: "archive-text" });
  const archiveActions = h("div", { class: "archive-actions" });
  const archiveBanner = h("div", { class: "archive-banner", role: "status", hidden: true }, archiveText, archiveActions);

  /** 読み取り専用の表示と、続きの文書・取り消しの操作を出す */
  function applyArchive(next: ArchiveInfo | null): void {
    archive = next;
    const readOnly = next !== null;
    view?.setProps({ editable: () => archive === null });
    titleInput.readOnly = readOnly;
    toolbar.setReadOnly(readOnly);
    archiveBanner.hidden = !readOnly;
    if (!next) return;
    archiveText.textContent =
      next.reason === "manual"
        ? `${next.name || "誰か"}さんが完了にした文書。読み取り専用。`
        : "30 日間更新がなかったため、読み取り専用になった。";
    const actions: HTMLElement[] = [];
    if (next.successor) {
      actions.push(h("a", { class: "btn primary small", href: `/d/${next.successor}` }, "続きの文書を開く"));
    } else {
      const cont = h("button", { class: "btn primary small", type: "button" }, "続きを新しい文書で");
      cont.addEventListener("click", () => void continueDoc(cont));
      actions.push(cont);
      if (next.reason === "manual" && next.userId === ctx.getUser().userId) {
        const reopen = h("button", { class: "btn small", type: "button" }, "完了を取り消す");
        reopen.addEventListener("click", () => {
          if (!conn.sendReopen()) toast("オフラインのため取り消せない");
        });
        actions.push(reopen);
      }
    }
    archiveActions.replaceChildren(...actions);
  }

  /** 本文を引き継いだ新しい文書を作って開く（すでにあればそれを開く） */
  async function continueDoc(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/docs/${docId}/continue`, { method: "POST" });
      if (res.status === 429) throw new Error("混み合っているため、少し待ってから試す");
      if (!res.ok) throw new Error("続きの文書を作れなかった");
      const { docId: next } = (await res.json()) as { docId: string };
      ctx.navigate(`/d/${next}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "続きの文書を作れなかった");
      btn.disabled = false;
    }
  }
  // サーバーが埋め込んだ本文があれば、接続が終わるまでの表示に使う（文書名は header にあるので見出しは外す）
  const ssr = app.querySelector<HTMLElement>(`.ssr[data-doc-id="${docId}"]`);
  ssr?.querySelector("h1")?.remove();
  const mount = h("main", { class: "doc-main" }, ssr ?? h("p", { class: "sheet-note" }, "読み込み中…"));

  const applyTitle = (next: string) => {
    title = next;
    if (document.activeElement !== titleInput && pendingTitle === null) titleInput.value = next;
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
        onLinkShortcut: () => void editLink(),
      });
      toolbar.update(view);
      return view;
    },
    onInit(msg) {
      applyTitle(msg.title);
      applyArchive(msg.archive);
      if (pendingTitle !== null) {
        const next = pendingTitle;
        pendingTitle = null;
        if (next !== msg.title && conn.sendTitle(next)) titleInput.value = next;
        else pendingTitle = next === msg.title ? null : next;
      }
    },
    onStatus(next) {
      presence.classList.toggle("online", next);
      banner.hidden = next || !view;
    },
    onTitle(next) {
      applyTitle(next);
      historySheet.refresh();
    },
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
      historySheet.rename(userId, name);
    },
    onRevision: () => historySheet.refresh(),
    onArchive(next) {
      applyArchive(next);
      historySheet.refresh();
    },
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
      toast(
        reason === "too_large"
          ? "サイズ上限を超えたため編集を取り消した"
          : reason === "archived"
            ? "読み取り専用になったため、送れなかった編集を取り消した"
            : "同期できない編集を取り消した",
      );
    },
  });

  const historySheet = createHistorySheet({
    docId,
    restore: (revId) => conn.sendRestore(revId),
    canRestore: () => archive === null,
  });

  /** 選択範囲（またはカーソル位置のリンク）にリンク先を設定する */
  async function editLink(): Promise<void> {
    const v = view;
    if (!v || !v.editable) return;
    const current = linkAt(v.state);
    await promptModal({
      title: current ? "リンクを編集" : "リンクを追加",
      description: v.state.selection.empty && !current ? "入力した URL を本文に挿入する。" : "選択した文字をリンクにする。",
      initial: current?.href ?? "",
      dismissable: true,
      okLabel: "設定",
      input: {
        inputMode: "url",
        maxLength: HREF_MAX,
        placeholder: "https://example.com",
        autocomplete: "url",
        autocapitalize: "off",
        "aria-label": "リンク先の URL",
      },
      async submit(value) {
        const href = normalizeHref(value);
        if (!href) throw new Error("http://・https://・mailto: の URL を入力");
        setLink(href)(v.state, v.dispatch);
      },
    });
  }

  const toolbar = createToolbar(() => view, {
    onHistory: () => historySheet.open(),
    onLink: () => void editLink(),
    async onImage() {
      if (!view || archive) return;
      const file = await pickImage();
      if (!file) return;
      toast("写真を送っている…");
      try {
        const { src, width, height } = await uploadImage(docId, ctx.getUser(), file);
        const v = view;
        if (!v || archive) return;
        const tr = v.state.tr.replaceSelectionWith(schema.nodes.image.create({ src, width, height }));
        // 置いた直後は写真そのものが選ばれ、続けて打つと写真が文字に置き換わる。カーソルを次の段落へ移す
        if (tr.selection instanceof NodeSelection) {
          const after = tr.selection.to;
          if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, after + 1));
        }
        v.dispatch(tr.scrollIntoView());
        toast("写真を置いた");
      } catch (err) {
        toast(err instanceof Error ? err.message : "写真を送れなかった");
      }
    },
    async onClose() {
      const ok = await confirmModal({
        title: "完了にする",
        description:
          "完了にすると、誰も編集できなくなる（読み取り専用）。今の版を確定版として残し、編集の履歴と使っていない写真は消す（取り消しても戻らない）。続きは新しい文書で書ける。",
        okLabel: "完了にする",
      });
      if (ok && !conn.sendClose()) toast("オフラインのため完了にできない");
    },
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
      titleInput.value = pendingTitle ?? title;
      titleInput.blur();
    }
  });
  titleInput.addEventListener("blur", () => {
    const next = sanitizeTitle(titleInput.value);
    if (next === null) {
      titleInput.value = pendingTitle ?? title;
      return;
    }
    titleInput.value = next;
    if (next === (pendingTitle ?? title)) return;
    if (conn.sendTitle(next)) {
      pendingTitle = null;
    } else {
      pendingTitle = next;
      toast("オフラインのため、再接続後に文書名を反映する");
    }
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

  app.replaceChildren(header, banner, archiveBanner, mount, toolbar.el);

  return () => {
    conn.destroy();
    themeToggle.destroy();
    historySheet.destroy();
    view?.destroy();
    toolbar.destroy();
  };
}
