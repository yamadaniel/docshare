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

/**
 * 1 つのアイコンの左半分を白抜きの太陽（光線付き）、右半分を塗りつぶしの満月にする。
 * 固定の図形だけを使い、利用者の入力は含まない
 */
function halfSunMoonIcon(): { svg: SVGSVGElement; sun: SVGGElement; moon: SVGGElement } {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    // 左半分：太陽の輪郭（半円と直径）と、左側の光線
    '<g class="half-sun" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<path d="M12 6.5A5.5 5.5 0 0 0 12 17.5Z"/>' +
    '<path d="M12 1.8v2M3.6 5.6l1.4 1.4M1.8 12h2M3.6 18.4l1.4-1.4M12 20.2v2"/>' +
    "</g>" +
    // 右半分：塗りつぶした満月
    '<g class="half-moon"><path d="M12 6.5A5.5 5.5 0 0 1 12 17.5Z" fill="currentColor"/></g>';
  return {
    svg,
    sun: svg.querySelector<SVGGElement>(".half-sun")!,
    moon: svg.querySelector<SVGGElement>(".half-moon")!,
  };
}

/** 半分ずつの太陽と満月のアイコン 1 つ。押すたびにライト／ダークを切り替え、今の側を強調する */
export function createThemeToggle(): { el: HTMLButtonElement; destroy(): void } {
  const icon = halfSunMoonIcon();
  const el = h("button", { type: "button", class: "theme-toggle", role: "switch", "aria-label": "ダークモード" }, icon.svg);
  const render = () => {
    const dark = currentTheme() === "dark";
    el.setAttribute("aria-checked", String(dark));
    el.title = dark ? "ライトモードにする" : "ダークモードにする";
    icon.sun.classList.toggle("on", !dark);
    icon.moon.classList.toggle("on", dark);
  };
  // 編集中に押してもキーボードを閉じない
  el.addEventListener("pointerdown", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  listeners.add(render);
  render();
  return { el, destroy: () => listeners.delete(render) };
}
