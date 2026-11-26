import type { EditorView } from "prosemirror-view";
import { createState, createView, emptyDoc } from "./editor";
import { createToolbar } from "./toolbar";
import { h, toast } from "./dom";

export function renderDocPage(app: HTMLElement, _docId: string): () => void {
  let view: EditorView | null = null;

  const titleInput = h("input", {
    class: "title-input",
    type: "text",
    placeholder: "無題の文書",
    maxLength: 100,
    enterKeyHint: "done",
    "aria-label": "文書名",
  });
  const header = h(
    "header",
    { class: "header" },
    h("a", { class: "home-link", href: "/", title: "トップへ", "aria-label": "トップへ" }, "‹"),
    titleInput,
  );
  const mount = h("main", { class: "doc-main" });
  const toolbar = createToolbar(() => view, {
    onHistory: () => toast("履歴は未実装"),
    onShare: () => toast("共有は未実装"),
  });
  app.replaceChildren(header, mount, toolbar.el);

  view = createView(mount, {
    state: createState(emptyDoc()),
    onUpdate: (v) => toolbar.update(v),
  });
  toolbar.update(view);

  return () => {
    view?.destroy();
    toolbar.destroy();
  };
}
