import { Fragment, Slice, type MarkType } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { ReplaceAroundStep } from "prosemirror-transform";
import { InputRule } from "prosemirror-inputrules";
import type { EditorView } from "prosemirror-view";
import { schema } from "../shared/schema";
import { normalizeHref } from "../shared/constants";

const { paragraph, task_list, task_item } = schema.nodes;

/**
 * 選択範囲の行を paragraph ⇄ task_item に変換する。
 * makeTask 未指定なら「選択行がすべてタスクなら解除、そうでなければタスク化」。
 * 行の中身には触れず外側の構造だけを差し替えるので、同時編集中の入力を巻き込まない。
 */
export function convertLines(tr: Transaction, makeTask?: boolean): boolean {
  const { from, to } = tr.selection;
  const lines: { pos: number; isTask: boolean }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    lines.push({ pos, isTask: node.type === task_item });
    return false;
  });
  if (!lines.length) return false;
  const toTask = makeTask ?? !lines.every((l) => l.isTask);

  // 後ろの行から処理すると、手前の行の位置は変わらない
  for (const line of lines.reverse()) {
    if (line.isTask === toTask) continue;
    const pos = line.pos;
    const end = pos + tr.doc.nodeAt(pos)!.nodeSize;
    if (toTask) {
      // <p>…</p> → <ul><li>…</li></ul>
      const wrapper = Fragment.from(task_list.create(null, task_item.create({ checked: false })));
      tr.step(new ReplaceAroundStep(pos, end, pos + 1, end - 1, new Slice(wrapper, 0, 0), 2, true));
      // 前後の task_list と結合（後ろ→前の順）
      for (const p of [end + 2, pos]) {
        const $p = tr.doc.resolve(p);
        if ($p.nodeBefore?.type === task_list && $p.nodeAfter?.type === task_list) tr.join(p);
      }
    } else {
      // <li>…</li> → （</ul>）<p>…</p>（<ul>）。前後に項目があればリストを分割する
      const $pos = tr.doc.resolve(pos);
      const first = $pos.index() === 0;
      const last = $pos.index() === $pos.parent.childCount - 1;
      const nodes = [first ? null : task_list.create(), paragraph.create(), last ? null : task_list.create()];
      const slice = new Slice(Fragment.from(nodes.filter((n) => n !== null)), first ? 0 : 1, last ? 0 : 1);
      tr.step(
        new ReplaceAroundStep(
          first ? $pos.before() : pos,
          last ? $pos.after() : end,
          pos + 1,
          end - 1,
          slice,
          first ? 1 : 2,
          true,
        ),
      );
    }
  }
  return true;
}

export const toggleTask: Command = (state, dispatch) => {
  const tr = state.tr;
  if (!convertLines(tr)) return false;
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
};

/** task_item 内の Enter：空なら段落に戻し、そうでなければ未チェックの項目に分割 */
export const splitTask: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if ($from.parent.type !== task_item) return false;
  if (empty && $from.parent.content.size === 0) return toggleTask(state, dispatch);
  if (dispatch) {
    const tr = state.tr;
    if (!empty) tr.deleteSelection();
    tr.split(tr.selection.from, 1, [{ type: task_item, attrs: { checked: false } }]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** task_item 行頭の Backspace：段落に戻す */
export const unwrapTaskAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== task_item || $from.parentOffset !== 0) return false;
  return toggleTask(state, dispatch);
};

export const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};

/** 行頭の `[] `（`[ ] ` も可）で task_item に変換 */
export const taskInputRule = new InputRule(/^\[ ?\]\s$/, (state, _match, start, end) => {
  if (state.doc.resolve(start).parent.type !== paragraph) return null;
  const tr = state.tr.delete(start, end);
  return convertLines(tr, true) ? tr : null;
});

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function inTask(state: EditorState): boolean {
  return state.selection.$from.parent.type === task_item;
}

/** チェックボックスのタップでトグル。キーボードの開閉状態は変えない */
export function handleTaskBoxEvent(view: EditorView, event: Event): boolean {
  const target = event.target as HTMLElement | null;
  if (!target?.classList?.contains("task-box")) return false;
  event.preventDefault();
  if (!view.editable) return true;
  const li = target.parentElement!;
  const pos = view.posAtDOM(li, 0) - 1;
  const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
  if (node?.type === task_item) {
    view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", !node.attrs.checked));
  }
  return true;
}

// ---- リンク ----

export interface LinkRange {
  from: number;
  to: number;
  href: string;
}

/** カーソル位置（または選択範囲の始点）にあるリンクの範囲 */
export function linkAt(state: EditorState): LinkRange | null {
  const { link } = schema.marks;
  const { $from, from, to, empty } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  const start = $from.start();
  // 子を順に見て、同じ href のリンクが連続する区間を探す
  let runFrom = -1;
  let runHref: string | null = null;
  let pos = start;
  const runs: LinkRange[] = [];
  parent.forEach((child) => {
    const mark = link.isInSet(child.marks);
    const href = mark ? (mark.attrs.href as string) : null;
    if (href !== runHref) {
      if (runHref !== null) runs.push({ from: runFrom, to: pos, href: runHref });
      runFrom = pos;
      runHref = href;
    }
    pos += child.nodeSize;
  });
  if (runHref !== null) runs.push({ from: runFrom, to: pos, href: runHref });
  const hit = runs.find((r) => (empty ? r.from < from && from <= r.to : r.from <= from && to <= r.to));
  // カーソルがリンクの直前（行頭など）にある場合も、そのリンクを対象にする
  return hit ?? (empty ? runs.find((r) => r.from === from) ?? null : null);
}

/** 選択範囲をリンクにする。カーソルがリンク内ならそのリンク先を変え、何も選択していなければ URL を挿入する */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { link } = schema.marks;
    const mark = link.create({ href });
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    const current = linkAt(state);
    if (empty && current) {
      tr.removeMark(current.from, current.to, link).addMark(current.from, current.to, mark);
    } else if (empty) {
      tr.insert(from, schema.text(href, [mark]));
    } else {
      tr.removeMark(from, to, link).addMark(from, to, mark);
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

export const removeLink: Command = (state, dispatch) => {
  const { link } = schema.marks;
  const { from, to, empty } = state.selection;
  const current = linkAt(state);
  const range = empty ? current : { from, to };
  if (!range) return false;
  if (dispatch) dispatch(state.tr.removeMark(range.from, range.to, link));
  return true;
};

const TRAILING_PUNCT = /[.,;:!?'")\]}>、。，．！？」』）]+$/;

/** URL を入力して空白を打つとリンクにする */
export const autoLinkRule = new InputRule(/(?:^|\s)((?:https?:\/\/|www\.)\S+)(\s)$/, (state, match, start, end) => {
  const { link } = schema.marks;
  // 文末の句読点や閉じ括弧はリンクに含めない
  const url = match[1].replace(TRAILING_PUNCT, "");
  const href = normalizeHref(url);
  if (!href) return null;
  const urlFrom = start + match[0].indexOf(match[1]);
  const urlTo = urlFrom + url.length;
  if (state.doc.rangeHasMark(urlFrom, urlTo, link)) return null;
  // InputRule は入力された文字（空白）を自分で入れる必要がある
  const tr = state.tr.insertText(match[2], end);
  tr.addMark(urlFrom, urlTo, link.create({ href }));
  return tr;
});

/** URL だけを貼り付けたら、選択範囲をリンクにする（選択がなければリンク付きで挿入） */
export function handleLinkPaste(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain").trim() ?? "";
  if (!/^(https?:\/\/|mailto:)\S+$/i.test(text)) return false;
  const href = normalizeHref(text);
  if (!href) return false;
  if (view.state.selection.$from.parent.type.spec.code) return false;
  event.preventDefault();
  return setLink(href)(view.state, view.dispatch);
}

/** Ctrl / Cmd を押しながらのクリックでリンクを開く */
export function openLinkOnModClick(view: EditorView, pos: number, event: MouseEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const mark = view.state.doc.resolve(pos).marks().find((m) => m.type === schema.marks.link);
  if (!mark) return false;
  window.open(mark.attrs.href as string, "_blank", "noopener,noreferrer");
  return true;
}
