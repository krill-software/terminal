// Composer — the multi-line shell-command editor that sits below the
// terminal. CodeMirror 6 with shell highlighting. Exposes get/set on its
// document plus the three commit actions (Paste / Paste & run / Save).
//
// The composer never clears itself; users iterate on a draft and run it
// multiple times. Save is wired in M3 once the snippet store exists.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";

export interface ComposerHandlers {
  /** Paste the body into the terminal at the cursor (no trailing newline). */
  paste: () => void;
  /** Paste then send Enter — run the command in the shell. */
  pasteAndRun: () => void;
  /** Save the body as a snippet. */
  save: () => void;
  /** Called whenever the doc changes. Used to live-filter the snippet list. */
  onDocChange?: (body: string) => void;
  /** Extra CodeMirror extensions to mix in (ghost-text completion, etc.). */
  extraExtensions?: Extension[];
}

export interface ComposerHandle {
  view: EditorView;
  getBody(): string;
  setBody(s: string): void;
  focus(): void;
}

export function createComposer(
  host: HTMLElement,
  handlers: ComposerHandlers,
): ComposerHandle {
  // Ctrl+Enter = paste & run, Ctrl+Shift+Enter = paste only. Highest
  // precedence so they shadow CodeMirror's default keymap which has
  // Mod-Enter bound to "insert blank line."
  const commitKeymap = Prec.highest(keymap.of([
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => { handlers.pasteAndRun(); return true; },
    },
    {
      key: "Mod-Shift-Enter",
      preventDefault: true,
      run: () => { handlers.paste(); return true; },
    },
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => { handlers.save(); return true; },
    },
  ]));

  const state = EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      placeholder("Edit input here…"),
      StreamLanguage.define(shell),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      commitKeymap,
      ...(handlers.extraExtensions ?? []),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && handlers.onDocChange) {
          handlers.onDocChange(u.state.doc.toString());
        }
      }),
    ],
  });

  const view = new EditorView({ state, parent: host });

  return {
    view,
    getBody: () => view.state.doc.toString(),
    setBody: (s: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: s },
      });
    },
    focus: () => view.focus(),
  };
}
