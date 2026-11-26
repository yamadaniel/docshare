import { Schema } from "prosemirror-model";
import { isSafeHref } from "./constants";

// DOM 型に依存しない最小限の要素型（Worker 側でも型検査を通すため）
interface El {
  getAttribute(name: string): string | null;
  style: { fontWeight: string };
}

// フロントと DocRoom で共用する schema。ここにない node/mark は読み込まれない。
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    task_list: {
      group: "block",
      content: "task_item+",
      parseDOM: [{ tag: "ul[data-task-list]" }],
      toDOM: () => ["ul", { "data-task-list": "", class: "task-list" }, 0],
    },
    task_item: {
      content: "inline*",
      defining: true,
      attrs: { checked: { default: false, validate: "boolean" } },
      parseDOM: [
        {
          tag: "li[data-task-item]",
          contentElement: "div",
          getAttrs: (dom) => ({ checked: (dom as unknown as El).getAttribute("data-checked") === "true" }),
        },
      ],
      toDOM: (node) => [
        "li",
        { "data-task-item": "", "data-checked": node.attrs.checked ? "true" : "false", class: "task-item" },
        ["span", { class: "task-box", contenteditable: "false" }],
        ["div", { class: "task-text" }, 0],
      ],
    },
    text: { group: "inline" },
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },
  marks: {
    strong: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b", getAttrs: (dom) => (dom as unknown as El).style.fontWeight !== "normal" && null },
        { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[5-9]\d{2,})$/.test(v as string) && null },
      ],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    link: {
      attrs: {
        href: {
          validate: (value: unknown) => {
            if (!isSafeHref(value)) throw new RangeError("link href must be http, https or mailto");
          },
        },
      },
      // リンクの末尾で入力した文字はリンクに含めない
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => {
            const href = (dom as unknown as El).getAttribute("href");
            return isSafeHref(href) ? { href } : false;
          },
        },
      ],
      // 外部サイトへ文書の URL を渡さない
      toDOM: (mark) => ["a", { href: mark.attrs.href, rel: "noopener noreferrer nofollow", target: "_blank" }, 0],
    },
    underline: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration", getAttrs: (v) => /underline/.test(v as string) && null }],
      toDOM: () => ["u", 0],
    },
  },
});
