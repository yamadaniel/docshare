import { h, toast } from "./dom";
import { nameModal } from "./modal";
import type { PageContext } from "./docPage";
import { loadRecent } from "./recent";
import { renameUser } from "./user";

function formatDate(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

export function renderHome(app: HTMLElement, ctx: PageContext, navigate: (path: string) => void): void {
  document.title = "docshare";
  const nameChip = h("button", { class: "name-chip", type: "button", title: "名前を変更" }, ctx.getUser().name);
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
      },
    });
  });

  const newBtn = h("button", { class: "btn primary new-btn", type: "button" }, "新しい文書");
  newBtn.addEventListener("click", async () => {
    newBtn.disabled = true;
    try {
      const res = await fetch("/api/docs", { method: "POST" });
      if (res.status === 429) throw new Error("作成が多すぎる。少し待ってから再試行");
      if (!res.ok) throw new Error("作成に失敗した");
      const { docId } = (await res.json()) as { docId: string };
      navigate(`/d/${docId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "作成に失敗した");
      newBtn.disabled = false;
    }
  });

  const recent = loadRecent();
  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      h("div", { class: "home-head" }, h("h1", null, "docshare"), nameChip),
      newBtn,
      h("h2", { class: "section-title" }, "最近開いた文書"),
      recent.length
        ? h(
            "ul",
            { class: "recent-list" },
            ...recent.map((d) =>
              h(
                "li",
                null,
                h(
                  "a",
                  { class: "recent-link", href: `/d/${d.docId}` },
                  h("span", { class: "recent-title" }, d.title || "無題の文書"),
                  h("span", { class: "recent-time" }, formatDate(d.openedAt)),
                ),
              ),
            ),
          )
        : h("p", { class: "empty-note" }, "まだ文書を開いていない。"),
    ),
  );
}
