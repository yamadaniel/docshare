import type { EditorView } from "prosemirror-view";
import { toggleMark } from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import { schema } from "../shared/schema";
import { inTask, markActive, toggleTask } from "./commands";
import { h } from "./dom";

export interface Toolbar {
  el: HTMLElement;
  update(view: EditorView): void;
  destroy(): void;
}

interface Handlers {
  onHistory(): void;
  onShare(): void;
}

export function createToolbar(getView: () => EditorView | null, handlers: Handlers): Toolbar {
  const updaters: ((view: EditorView) => void)[] = [];

  const button = (label: string, title: string, cls: string, action: () => void): HTMLButtonElement => {
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
    label: string,
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

  const { strong, em, underline } = schema.marks;
  const el = h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "書式" },
    commandButton("B", "太字", "tb-bold", toggleMark(strong), (v) => markActive(v.state, strong)),
    commandButton("I", "斜体", "tb-italic", toggleMark(em), (v) => markActive(v.state, em)),
    commandButton("U", "下線", "tb-underline", toggleMark(underline), (v) => markActive(v.state, underline)),
    commandButton("☑", "チェックボックス", "tb-check", toggleTask, (v) => inTask(v.state)),
    h("span", { class: "tb-spacer" }),
    button("履歴", "履歴", "tb-text", handlers.onHistory),
    button("共有", "共有", "tb-text", handlers.onShare),
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
    destroy() {
      vv?.removeEventListener("resize", reposition);
      vv?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
      document.documentElement.style.removeProperty("--kb");
      el.remove();
    },
  };
}
