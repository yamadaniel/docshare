import type { Mark, Node } from "prosemirror-model";
import { isSafeHref } from "../shared/constants";

// 文書をサーバー側で HTML にする。JavaScript を実行しない読み手（AI の URL 読み取りなど）向け。
// 利用者の入力はすべてエスケープし、リンクは許可したスキームだけを出力する。

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

function wrap(mark: Mark, inner: string): string {
  switch (mark.type.name) {
    case "strong":
      return `<strong>${inner}</strong>`;
    case "em":
      return `<em>${inner}</em>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "link": {
      const href = mark.attrs.href as unknown;
      if (!isSafeHref(href)) return inner;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${inner}</a>`;
    }
    default:
      return inner;
  }
}

function inline(block: Node): string {
  let out = "";
  block.forEach((child) => {
    if (child.type.name === "hard_break") {
      out += "<br>";
    } else if (child.isText) {
      let html = escapeHtml(child.text ?? "");
      // 内側のマークから順に包む
      for (const mark of [...child.marks].reverse()) html = wrap(mark, html);
      out += html;
    }
  });
  return out;
}

/** 本文の HTML。チェックボックスは ☑ / ☐ の文字で表し、どの読み手でも状態がわかるようにする */
export function renderDocHtml(doc: Node): string {
  let out = "";
  doc.forEach((block) => {
    if (block.type.name === "paragraph") {
      out += `<p>${inline(block)}</p>`;
    } else if (block.type.name === "image") {
      out += `<p><img src="/api/images/${escapeHtml(String(block.attrs.src))}" alt="写真"></p>`;
    } else if (block.type.name === "task_list") {
      out += "<ul>";
      block.forEach((item) => {
        const checked = item.attrs.checked === true;
        out += `<li data-checked="${checked}">${checked ? "☑" : "☐"} ${inline(item)}</li>`;
      });
      out += "</ul>";
    }
  });
  return out;
}

/** 説明文（meta description）用に、本文の先頭を 1 行にまとめる */
export function describeDoc(doc: Node, max = 160): string {
  const text = doc.textBetween(0, doc.content.size, " ", " ").replace(/\s+/g, " ").trim();
  return [...text].length > max ? [...text].slice(0, max - 1).join("") + "…" : text;
}
