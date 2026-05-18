// Ghost-text inline completion for the composer. Reads a "suggest"
// callback each time the document changes and decorates the cursor
// position with a muted span showing the remainder of the longest
// matching history entry. Tab (or Right at end-of-line) accepts.

import { EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget): boolean { return other.text === this.text; }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean { return true; }
}

export function ghostText(suggest: (prefix: string) => string | null) {
  // Compute the suggestion (if any) for the current state. Returns null
  // when there's no completion to display (cursor not at end, no match,
  // or match equals the prefix).
  const ghostFor = (state: EditorState): string | null => {
    const cursor = state.selection.main.head;
    if (cursor !== state.doc.length) return null;
    const prefix = state.doc.toString();
    if (!prefix) return null;
    const match = suggest(prefix);
    if (!match || !match.startsWith(prefix) || match === prefix) return null;
    return match.slice(prefix.length);
  };

  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;

    constructor(view: EditorView) { this.compute(view.state); }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet) this.compute(u.state);
    }
    compute(state: EditorState): void {
      const ghost = ghostFor(state);
      if (!ghost) {
        this.decorations = Decoration.none;
        return;
      }
      this.decorations = Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(ghost),
          side: 1,
        }).range(state.doc.length),
      ]);
    }
  }, {
    decorations: v => v.decorations,
  });

  const accept = keymap.of([
    {
      key: "Tab",
      run: (view) => {
        const ghost = ghostFor(view.state);
        if (!ghost) return false;
        view.dispatch({
          changes: { from: view.state.doc.length, insert: ghost },
          selection: { anchor: view.state.doc.length + ghost.length },
        });
        return true;
      },
    },
    {
      key: "ArrowRight",
      run: (view) => {
        const ghost = ghostFor(view.state);
        if (!ghost) return false;
        view.dispatch({
          changes: { from: view.state.doc.length, insert: ghost },
          selection: { anchor: view.state.doc.length + ghost.length },
        });
        return true;
      },
    },
  ]);

  return [plugin, accept];
}
