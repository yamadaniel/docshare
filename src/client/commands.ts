import { Fragment, type Node, type MarkType } from "prosemirror-model";
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { InputRule } from "prosemirror-inputrules";
import type { EditorView } from "prosemirror-view";
import { schema } from "../shared/schema";

const { paragraph, task_list, task_item } = schema.nodes;

interface Line {
  node: Node;
  /** textblock の開始位置（開きトークンの位置） */
  pos: number;
  selected: boolean;
}

/**
 * 選択範囲の行を paragraph ⇄ task_item に変換する。
 * makeTask 未指定なら「選択行がすべてタスクなら解除、そうでなければタスク化」。
 */
export function convertLines(tr: Transaction, makeTask?: boolean): boolean {
  const { $from, $to, from, to, anchor, head } = tr.selection;
  const doc = tr.doc;
  const fromIdx = $from.index(0);
  const toIdx = Math.min($to.index(0), doc.childCount - 1);
  const start = $from.posAtIndex(fromIdx, 0);
  const end = $to.posAtIndex(toIdx + 1, 0);

  const lines: Line[] = [];
  let pos = start;
  for (let i = fromIdx; i <= toIdx; i++) {
    const block = doc.child(i);
    if (block.type === task_list) {
      let p = pos + 1;
      block.forEach((item) => {
        lines.push({ node: item, pos: p, selected: from <= p + item.nodeSize - 1 && to >= p + 1 });
        p += item.nodeSize;
      });
    } else {
      lines.push({ node: block, pos, selected: from <= pos + block.nodeSize - 1 && to >= pos + 1 });
    }
    pos += block.nodeSize;
  }
  const selected = lines.filter((l) => l.selected);
  if (!selected.length) return false;
  const toTask = makeTask ?? !selected.every((l) => l.node.type === task_item);

  // 行を作り直し、連続するタスクを task_list にまとめる
  const nodes: Node[] = [];
  const newPos: number[] = [];
  let group: Node[] = [];
  let cursor = start;
  const flush = () => {
    if (!group.length) return;
    nodes.push(task_list.create(null, group));
    cursor += 1; // task_list の閉じトークン
    group = [];
  };
  for (const line of lines) {
    const asTask = line.selected ? toTask : line.node.type === task_item;
    if (asTask) {
      if (!group.length) cursor += 1; // task_list の開きトークン
      const item =
        line.node.type === task_item ? line.node : task_item.create({ checked: false }, line.node.content);
      newPos.push(cursor);
      group.push(item);
      cursor += item.nodeSize;
    } else {
      flush();
      const para = line.node.type === paragraph ? line.node : paragraph.create(null, line.node.content);
      newPos.push(cursor);
      nodes.push(para);
      cursor += para.nodeSize;
    }
  }
  flush();

  const remap = (p: number): number => {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (p >= l.pos && p <= l.pos + l.node.nodeSize) {
        const offset = Math.max(0, Math.min(p - l.pos - 1, l.node.content.size));
        return newPos[i] + 1 + offset;
      }
    }
    return newPos[0] + 1;
  };
  const newAnchor = remap(anchor);
  const newHead = remap(head);

  tr.replaceWith(start, end, Fragment.from(nodes));
  const base = tr.steps.length;
  // 前後の task_list と結合（後ろ→前の順で位置ずれを避ける）
  for (const p of [cursor, start]) {
    const $p = tr.doc.resolve(tr.mapping.slice(base).map(p));
    if ($p.nodeBefore?.type === task_list && $p.nodeAfter?.type === task_list) tr.join($p.pos);
  }
  const map = tr.mapping.slice(base);
  tr.setSelection(TextSelection.create(tr.doc, map.map(newAnchor), map.map(newHead)));
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
