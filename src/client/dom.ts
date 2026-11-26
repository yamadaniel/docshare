type Child = Node | string | null | undefined | false;

/** DOM 生成ヘルパー。文字列は必ず textContent 経由で入る（innerHTML は使わない） */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c);
  }
  return el;
}

let toastTimer = 0;
export function toast(text: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = h("div", { class: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 2500);
}

/**
 * モーダル表示中に背後の画面（#app）を操作・フォーカスできなくする。
 * 戻り値を呼ぶと元に戻す。重ねて呼んでも最後の解除で戻る
 */
let inertDepth = 0;
export function inertApp(): () => void {
  const app = document.getElementById("app");
  if (!app) return () => {};
  if (inertDepth++ === 0) app.inert = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--inertDepth === 0) app.inert = false;
  };
}
