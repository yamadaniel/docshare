import { h } from "./dom";

export type Theme = "light" | "dark";
const KEY = "ds.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** 今の表示テーマ。選んだことがなければ OS の設定に従う */
export function currentTheme(): Theme {
  return stored() ?? (media.matches ? "dark" : "light");
}

const listeners = new Set<() => void>();

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 保存できなくても、このページでは切り替える
  }
  document.documentElement.dataset.theme = theme;
  for (const l of listeners) l();
}

// OS の設定が変わったら、まだ選んでいない人の表示を追従させる
media.addEventListener("change", () => {
  if (!stored()) for (const l of listeners) l();
});

const svg = (paths: string): SVGSVGElement => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  // 固定の図形だけを入れる（利用者の入力は含まない）
  el.innerHTML = paths;
  return el;
};

/** 白抜きの太陽 */
const sunIcon = () =>
  svg(
    '<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>' +
      "</g>",
  );

/** 塗りつぶしの満月 */
const moonIcon = () => svg('<circle cx="12" cy="12" r="7.5" fill="currentColor"/>');

/** 左に太陽、右に満月。押すたびにライト／ダークを切り替える */
export function createThemeToggle(): { el: HTMLButtonElement; destroy(): void } {
  const sun = h("span", { class: "theme-opt theme-sun" }, sunIcon());
  const moon = h("span", { class: "theme-opt theme-moon" }, moonIcon());
  const el = h("button", { type: "button", class: "theme-toggle", role: "switch", "aria-label": "ダークモード" }, sun, moon);
  const render = () => {
    const dark = currentTheme() === "dark";
    el.setAttribute("aria-checked", String(dark));
    el.title = dark ? "ライトモードにする" : "ダークモードにする";
    sun.classList.toggle("on", !dark);
    moon.classList.toggle("on", dark);
  };
  // 編集中に押してもキーボードを閉じない
  el.addEventListener("pointerdown", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  listeners.add(render);
  render();
  return { el, destroy: () => listeners.delete(render) };
}
