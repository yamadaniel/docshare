import type { EditorView } from "prosemirror-view";
import { toggleMark } from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import { schema } from "../shared/schema";
import { inTask, linkAt, markActive, removeLink, toggleTask } from "./commands";
import { h } from "./dom";

export interface Toolbar {
  el: HTMLElement;
  update(view: EditorView): void;
  /** 読み取り専用のあいだは書式ボタンと「完了」を使えなくする */
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

interface Handlers {
  onHistory(): void;
  onShare(): void;
  /** 写真を選んで本文に置く */
  onImage(): void;
  /** 文書を「完了」にする */
  onClose(): void;
  /** リンクの入力（新規・編集） */
  onLink(): void;
}

/** 線で描いたアイコン。固定の図形だけを使い、利用者の入力は含まない */
const ICONS = {
  check: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.2-1.2"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "tb-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

export function createToolbar(getView: () => EditorView | null, handlers: Handlers): Toolbar {
  const updaters: ((view: EditorView) => void)[] = [];

  const button = (label: string | Node, title: string, cls: string, action: () => void): HTMLButtonElement => {
    const btn = h("button", { type: "button", class: `tb-btn ${cls}`, title, "aria-label": title }, label);
    // フォーカスを奪わずキーボードを閉じない
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      action();
    });
    return btn;
  };

  const commandButton = (
    label: string | Node,
    title: string,
    cls: string,
    command: Command,
    active: (view: EditorView) => boolean,
  ): HTMLButtonElement => {
    const btn = button(label, title, cls, () => {
      const view = getView();
      if (view) command(view.state, view.dispatch, view);
    });
    updaters.push((view) => {
      const on = active(view);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    return btn;
  };

  function linkButton(): HTMLButtonElement {
    const btn = button(icon("link"), "リンク", "tb-link", handlers.onLink);
    updaters.push((view) => {
      const on = !!linkAt(view.state);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    return btn;
  }

  // カーソルがリンク上にあるときだけ出す操作バー
  const linkUrl = h("span", { class: "link-url" });
  const linkBar = h(
    "div",
    { class: "link-bar", hidden: true },
    linkUrl,
    button("開く", "リンクを開く", "lb-btn", () => {
      const view = getView();
      const link = view && linkAt(view.state);
      if (link) window.open(link.href, "_blank", "noopener,noreferrer");
    }),
    button("編集", "リンクを編集", "lb-btn", handlers.onLink),
    button("解除", "リンクを解除", "lb-btn", () => {
      const view = getView();
      if (view) removeLink(view.state, view.dispatch);
    }),
  );
  updaters.push((view) => {
    const link = view.hasFocus() ? linkAt(view.state) : null;
    linkBar.hidden = !link;
    if (link) linkUrl.textContent = link.href.replace(/^https?:\/\//, "");
  });

  const { strong, em, underline } = schema.marks;
  const formatButtons = [
    commandButton("B", "太字", "tb-bold", toggleMark(strong), (v) => markActive(v.state, strong)),
    commandButton("I", "斜体", "tb-italic", toggleMark(em), (v) => markActive(v.state, em)),
    commandButton("U", "下線", "tb-underline", toggleMark(underline), (v) => markActive(v.state, underline)),
    commandButton(icon("check"), "チェックボックス", "tb-check", toggleTask, (v) => inTask(v.state)),
    linkButton(),
  ];
  // 絵文字のアイコンは端末ごとに見た目が変わって伝わりにくいので、文字で示す
  const imageBtn = button("写真", "写真を貼る", "tb-text tb-image", handlers.onImage);
  const closeBtn = button("完了", "完了にする（読み取り専用にする）", "tb-text tb-close", handlers.onClose);
  const el = h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "書式" },
    ...formatButtons,
    h("span", { class: "tb-spacer" }),
    imageBtn,
    closeBtn,
    button("履歴", "履歴", "tb-text", handlers.onHistory),
    button("共有", "共有", "tb-text", handlers.onShare),
    linkBar,
  );

  // ソフトウェアキーボードの直上へ追従
  const vv = window.visualViewport;
  const reposition = () => {
    const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    el.style.transform = offset ? `translateY(${-offset}px)` : "";
    document.documentElement.style.setProperty("--kb", `${offset}px`);
    const view = getView();
    if (view) view.setProps({ scrollMargin: { top: 64, bottom: offset + 72, left: 0, right: 0 } });
  };
  vv?.addEventListener("resize", reposition);
  vv?.addEventListener("scroll", reposition);
  window.addEventListener("resize", reposition);

  return {
    el,
    update(view) {
      for (const u of updaters) u(view);
    },
    setReadOnly(readOnly) {
      for (const btn of [...formatButtons, imageBtn]) btn.disabled = readOnly;
      closeBtn.hidden = readOnly;
      if (readOnly) linkBar.hidden = true;
    },
    destroy() {
      vv?.removeEventListener("resize", reposition);
      vv?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
      document.documentElement.style.removeProperty("--kb");
      el.remove();
    },
  };
}
