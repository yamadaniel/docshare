import "./style.css";
import { DOC_ID_RE } from "../shared/constants";
import { renderDocPage, type PageContext } from "./docPage";
import { h } from "./dom";
import { renderHome } from "./home";
import { nameModal } from "./modal";
import { loadUser, registerUser, saveUser, type User } from "./user";

const app = document.getElementById("app")!;
let cleanup: (() => void) | null = null;
let user: User;

function renderNotFound(): void {
  cleanup?.();
  cleanup = null;
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

const ctx: PageContext = {
  getUser: () => user,
  setUser(next) {
    user = next;
    saveUser(next);
  },
  showNotFound: renderNotFound,
};

function route(): void {
  cleanup?.();
  cleanup = null;
  const path = location.pathname;
  const m = /^\/d\/([^/]+)\/?$/.exec(path);
  if (path === "/") renderHome(app, ctx, navigate);
  else if (m && DOC_ID_RE.test(m[1])) cleanup = renderDocPage(app, m[1], ctx);
  else renderNotFound();
}

function navigate(path: string): void {
  history.pushState(null, "", path);
  route();
}

// 同一オリジンのリンクは SPA 内遷移にする
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a");
  if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname);
});
window.addEventListener("popstate", route);

async function start(): Promise<void> {
  const stored = loadUser();
  if (stored) {
    user = stored;
  } else {
    // 初回アクセス：閉じられないモーダルで名前を登録する
    await nameModal({
      title: "名前を入力",
      description: "編集履歴に表示される名前。あとから変更できる。",
      dismissable: false,
      async submit(name) {
        user = await registerUser(name);
      },
    });
  }
  route();
}

void start();
