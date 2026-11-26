import "./style.css";
import { DOC_ID_RE } from "../shared/constants";
import { renderDocPage } from "./docPage";
import { h } from "./dom";

const app = document.getElementById("app")!;
let cleanup: (() => void) | null = null;

export function renderNotFound(): void {
  document.title = "404 | docshare";
  app.replaceChildren(
    h(
      "div",
      { class: "page notfound" },
      h("p", { class: "code" }, "404"),
      h("p", null, "文書が見つからない"),
      h("a", { href: "/" }, "トップへ戻る"),
    ),
  );
}

function route(): void {
  cleanup?.();
  cleanup = null;
  const path = location.pathname;
  const m = /^\/d\/([^/]+)\/?$/.exec(path);
  if (path === "/") {
    app.replaceChildren(h("div", { class: "page" }, h("h1", null, "docshare")));
  } else if (m && DOC_ID_RE.test(m[1])) {
    cleanup = renderDocPage(app, m[1]);
  } else {
    renderNotFound();
  }
}

export function navigate(path: string): void {
  history.pushState(null, "", path);
  route();
}

// 同一オリジンのリンクは SPA 内遷移にする
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a");
  if (!a || a.target || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname);
});
window.addEventListener("popstate", route);
route();
