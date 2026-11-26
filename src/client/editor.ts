import { EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { history, undo, redo } from "prosemirror-history";
import { inputRules } from "prosemirror-inputrules";
import { baseKeymap, chainCommands, toggleMark } from "prosemirror-commands";
import { schema } from "../shared/schema";
import { handleTaskBoxEvent, insertHardBreak, splitTask, taskInputRule, unwrapTaskAtStart } from "./commands";

export function emptyDoc(): Node {
  return schema.node("doc", null, [schema.node("paragraph")]);
}

export function createState(doc: Node, extraPlugins: Plugin[] = []): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      inputRules({ rules: [taskInputRule] }),
      keymap({
        "Mod-b": toggleMark(schema.marks.strong),
        "Mod-i": toggleMark(schema.marks.em),
        "Mod-u": toggleMark(schema.marks.underline),
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        Enter: splitTask,
        "Shift-Enter": insertHardBreak,
        Backspace: chainCommands(unwrapTaskAtStart),
      }),
      keymap(baseKeymap),
      history(),
      ...extraPlugins,
    ],
  });
}

export interface EditorOptions {
  state: EditorState;
  onTransaction?: (tr: Transaction, view: EditorView) => void;
  onUpdate?: (view: EditorView) => void;
}

export function createView(mount: HTMLElement, opts: EditorOptions): EditorView {
  const view: EditorView = new EditorView(mount, {
    state: opts.state,
    attributes: { class: "editor", spellcheck: "false", "aria-label": "本文" },
    handleDOMEvents: {
      mousedown: handleTaskBoxEvent,
    },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      opts.onTransaction?.(tr, view);
      opts.onUpdate?.(view);
    },
  });
  return view;
}
