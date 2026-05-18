// Composer linter — two layered decorations:
//
//   1. Command-token highlight. The first token of each non-empty line is
//      checked against PATH (via the `which_command` Tauri command) and,
//      if it resolves OR is a shell builtin, painted bold + accent-pink.
//      Per-token results are cached for the session.
//
//   2. shellcheck findings. The whole body is piped to `shellcheck --json`
//      (debounced ~350ms after the last edit) and each finding is rendered
//      as a translucent-pink background. Hover for a tooltip with the
//      message + a link to the shellcheck wiki page.
//
// Both are exposed as a single `linterExtension()` that the composer mixes
// into its `extraExtensions` slot. Activation of shellcheck depends on the
// binary being installed; missing → we silently skip without errors.

import { invoke } from "@tauri-apps/api/core";
import { Annotation, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// ---- Command-token highlight ---------------------------------------------

const SHELL_BUILTINS = new Set([
  // POSIX + common bash builtins. Not exhaustive, but covers the common
  // cases that `which` won't find.
  "alias", "bg", "bind", "break", "builtin", "case", "cd", "command",
  "continue", "declare", "do", "done", "echo", "elif", "else", "esac",
  "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for",
  "function", "getopts", "hash", "help", "history", "if", "in", "jobs",
  "kill", "let", "local", "logout", "popd", "printf", "pushd", "pwd",
  "read", "readonly", "return", "select", "set", "shift", "shopt",
  "source", "suspend", "test", "then", "time", "times", "trap", "true",
  "type", "typeset", "ulimit", "umask", "unalias", "unset", "until",
  "wait", "while", "[", ":", ".",
]);

const cmdCache = new Map<string, boolean | "pending">();

/** Resolve a token to "is this an executable command?" Returns synchronously
 *  if cached; otherwise kicks off an async lookup and re-paints the view
 *  when the answer comes in. */
function lookupCommand(token: string, view: EditorView): boolean {
  if (SHELL_BUILTINS.has(token)) return true;
  const cached = cmdCache.get(token);
  if (cached === true) return true;
  if (cached === false || cached === "pending") return false;
  cmdCache.set(token, "pending");
  void invoke<boolean>("which_command", { name: token })
    .then((found) => {
      cmdCache.set(token, found);
      // Force a redecorate by dispatching a no-op transaction.
      view.dispatch({ effects: cmdRefreshEffect.of(null) });
    })
    .catch(() => { cmdCache.set(token, false); });
  return false;
}

const cmdRefreshEffect = StateEffect.define<null>();

const cmdHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  constructor(view: EditorView) { this.decorations = compute(view); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged ||
        u.transactions.some(t => t.effects.some(e => e.is(cmdRefreshEffect)))) {
      this.decorations = compute(u.view);
    }
  }
}, { decorations: v => v.decorations });

const CMD_MARK = Decoration.mark({ class: "cm-cmd-token" });

function compute(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number }[] = [];
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^\s*([A-Za-z0-9_./+-]+)/.exec(line.text);
    if (!m) continue;
    const token = m[1];
    if (!lookupCommand(token, view)) continue;
    const start = line.from + (m.index ?? 0) + (m[0].length - token.length);
    const end = start + token.length;
    ranges.push({ from: start, to: end });
  }
  return Decoration.set(ranges.map(r => CMD_MARK.range(r.from, r.to)));
}

// ---- shellcheck findings -------------------------------------------------

interface ShellcheckFinding {
  line: number;
  endLine: number;
  column: number;
  endColumn: number;
  level: "error" | "warning" | "info" | "style";
  code: number;
  message: string;
}

let shellcheckAvailable = true; // first call decides; missing -> false
let debounceTimer: number | undefined;

const setFindings = StateEffect.define<ShellcheckFinding[]>();

const findingsField = StateField.define<readonly ShellcheckFinding[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFindings)) return e.value;
    return value;
  },
});

const FINDING_MARK = Decoration.mark({ class: "cm-shellcheck-finding" });

const findingsDecorations = EditorView.decorations.compute([findingsField], (state) => {
  const findings = state.field(findingsField);
  if (!findings.length) return Decoration.none;
  const doc = state.doc;
  const ranges: { from: number; to: number }[] = [];
  for (const f of findings) {
    try {
      const startLine = doc.line(Math.max(1, Math.min(doc.lines, f.line)));
      const endLine = doc.line(Math.max(1, Math.min(doc.lines, f.endLine)));
      const from = Math.min(doc.length, startLine.from + Math.max(0, f.column - 1));
      const to = Math.min(doc.length, endLine.from + Math.max(0, f.endColumn - 1));
      if (to > from) ranges.push({ from, to });
    } catch {
      /* skip out-of-range */
    }
  }
  return Decoration.set(ranges.map(r => FINDING_MARK.range(r.from, r.to)));
});

function runShellcheck(view: EditorView, body: string): void {
  if (!shellcheckAvailable) return;
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(async () => {
    if (!body.trim()) {
      view.dispatch({ effects: setFindings.of([]) });
      return;
    }
    try {
      const raw = await invoke<ShellcheckFinding[]>("shellcheck_run", { body });
      view.dispatch({ effects: setFindings.of(Array.isArray(raw) ? raw : []) });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("NOT_INSTALLED")) {
        shellcheckAvailable = false;
        console.info(
          "shellcheck not installed — install via `sudo apt install shellcheck` for inline command validation.",
        );
      }
    }
  }, 350);
}

const shellcheckRunner = ViewPlugin.fromClass(class {
  constructor(view: EditorView) { runShellcheck(view, view.state.doc.toString()); }
  update(u: ViewUpdate): void {
    if (u.docChanged) runShellcheck(u.view, u.state.doc.toString());
  }
});

// Hover tooltip — looks up which finding covers the hovered position.
const findingTooltip = hoverTooltip((view, pos) => {
  const findings = view.state.field(findingsField, false);
  if (!findings) return null;
  const doc = view.state.doc;
  for (const f of findings) {
    try {
      const startLine = doc.line(Math.max(1, Math.min(doc.lines, f.line)));
      const endLine = doc.line(Math.max(1, Math.min(doc.lines, f.endLine)));
      const from = startLine.from + Math.max(0, f.column - 1);
      const to = endLine.from + Math.max(0, f.endColumn - 1);
      if (pos >= from && pos <= to) {
        return {
          pos: from,
          end: to,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "cm-shellcheck-tooltip";
            const level = document.createElement("div");
            level.className = "cm-shellcheck-tooltip-level";
            level.textContent = `${f.level.toUpperCase()} · SC${f.code}`;
            const msg = document.createElement("div");
            msg.className = "cm-shellcheck-tooltip-msg";
            msg.textContent = f.message;
            const link = document.createElement("a");
            link.href = `https://www.shellcheck.net/wiki/SC${f.code}`;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = "Wiki";
            link.className = "cm-shellcheck-tooltip-link";
            dom.appendChild(level);
            dom.appendChild(msg);
            dom.appendChild(link);
            return { dom };
          },
        };
      }
    } catch { /* skip */ }
  }
  return null;
});

// Annotation used in tests; not needed at runtime but cheap to keep so
// future debugging hooks have a stable handle.
export const linterPing = Annotation.define<void>();

export function linterExtension() {
  return [
    cmdHighlight,
    findingsField,
    findingsDecorations,
    shellcheckRunner,
    findingTooltip,
  ];
}
