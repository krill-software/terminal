# Terminal — Spec (v1)

A minimal terminal for Linux with a built-in **command composer** and **snippet library**. The terminal is the obvious feature; the USP is everything around it.

## Goals

- A clean, fast terminal emulator — one window, one shell.
- A first-class **command composer**: a multi-line editor under the terminal where the user drafts the command they're about to run, then pastes (or pastes and runs) with a button.
- A **snippet library** in the aux pane: save commands, tag them, search them, click to load into the composer.
- Quiet, palette-strict chrome; terminal output renders ANSI as emitted (the standard "palette is for UI, not output" carve-out).

The product question that justifies the app: *"why is it still cumbersome to write a multi-line shell command in 2026?"* — because terminals make you compose inline at the prompt with a single line buffer. This app moves command authoring into a proper text editor and treats the terminal as the runner.

## Non-goals (v1)

- No tabs. No splits. One terminal per window.
- No SSH integration / remote profiles / "connection manager."
- No themes, no profiles, no per-session config.
- No multi-window state sync (each window is independent).
- No shell injection / env mangling beyond `$SHELL`.
- No Windows / macOS builds.

## Stack

- **Shell:** Tauri 2.
- **Frontend:** TypeScript + Vite. Terminal renderer: [`xterm.js`](https://xtermjs.org) (used by VS Code). Composer: CodeMirror 6 + [`@codemirror/lang-shell`](https://www.npmjs.com/package/@codemirror/lang-shell-script-mode-ish-or-equivalent) for shell highlighting.
- **PTY:** [`portable-pty`](https://crates.io/crates/portable-pty) on the Rust side. Spawn `$SHELL` (fallback `/bin/sh`), wire stdin/stdout/stderr to a Tauri event channel.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui).
- **State / fs / dev / updater:** [`krill-desktop-core`](https://github.com/krill-software/desktop-core).

## Typography

- **Terminal:** Hasklig at the chrome size (14px default). Ligatures on — Hasklig is a Source Code Pro fork specifically for programming, so `==`, `=>`, `!=` look right.
- **Composer:** Same — Hasklig, monospace, line-height 1.5.
- **UI chrome:** Inter as standard.
- **Adjustable size** (terminal + composer together) via `Ctrl+=` / `Ctrl+-` / `Ctrl+0`. Persisted.

## Layout

```
┌────────────────────────────────────────────────────┐
│ titlebar — File / Edit / View / Help               │
├──────────────┬─────────────────────────────────────┤
│ AUX (260px)  │ MAIN (1fr)                          │
│              │                                     │
│ [search]     │ ┌─── xterm.js terminal ──────────┐ │
│ [+ New]      │ │ $ ls                            │ │
│              │ │ foo.txt  bar.txt                │ │
│ #work #dev   │ │ $ █                             │ │
│ ───          │ └─────────────────────────────────┘ │
│ build all    │ ┌── composer (CodeMirror) ───────┐ │
│ deploy prod  │ │ for f in *.txt; do              │ │
│ docker clean │ │   wc -l "$f"                    │ │
│ ...          │ │ done                            │ │
│              │ └─────────────────────────────────┘ │
│              │  [Paste] [Paste & run] [Save…]      │
├──────────────┴─────────────────────────────────────┤
│ status — shell name · pid · exit code             │
└────────────────────────────────────────────────────┘
```

- **Aux pane (left, 260px):** snippet library. Search at top, then filter chips for tags, then a vertical list of snippets. Each row: name + colored tag dots + hover-revealed kebab menu (Edit, Delete). Click a row → load its body into the composer.
- **Main pane (right, 1fr):** vertical split, top is terminal (~65% by default), bottom is composer (~35%). Resizable divider (drag).
- **Status line:** `<shell-name>` on the left half; `pid · last exit code` on the right half.

## Composer ↔ terminal interaction

Three buttons under the composer:

- **Paste** — types the composer body into the terminal's stdin as if the user pasted it, but **does not send a newline**. The user can review the line at the prompt and run it manually with Enter.
- **Paste & run** — same as Paste, then sends a newline.
- **Save…** — opens an inline form: name (required), tags (comma-separated, optional). Persists to disk and adds the row to the aux pane.

The composer is **never cleared automatically.** It keeps the last draft across runs so the user can iterate ("paste, see error, edit, paste again, run").

`Esc` in the composer focuses the terminal. `Tab` from terminal focuses the composer. (Implemented as keybindings — the terminal itself sees Esc / Tab as normal keys when focused.)

## Snippets

Each snippet is JSON:

```json
{ "id": "...", "name": "build all", "tags": ["work", "dev"], "body": "pnpm -r build", "created": "2026-05-18T..." }
```

- Stored at `$XDG_STATE_HOME/krill-terminal/snippets.json`.
- Tag colors are deterministic from the tag string (hash → palette-derived hue) — no tag color picker.
- **Search** filters by case-insensitive substring match against name + body.
- **Tag chips** filter by tag; clicking a chip toggles it. Multiple chips active = AND (only snippets having every active tag).
- **Click a snippet row** — loads its body into the composer (replacing whatever's there). No confirmation; the composer's previous body is recoverable from the editor's undo stack.
- **Kebab → Edit** — opens the snippet in the composer with its metadata loaded into the save form.
- **Kebab → Delete** — confirmation dialog, then removed.

## Window

- One terminal session per window. Closing the window terminates the shell process (SIGHUP).
- Window geometry + composer/terminal split ratio persisted to `$XDG_STATE_HOME/krill-terminal/state.json`.
- No "restore last session" — opening a new window opens a fresh shell.

## Keybindings (v1)

| Action                  | Key                |
|-------------------------|--------------------|
| New window              | `Ctrl+N`           |
| Save composer as snippet| `Ctrl+S`           |
| Paste composer to term  | `Ctrl+Shift+Enter` |
| Paste & run             | `Ctrl+Enter`       |
| Focus terminal          | `Esc` (in composer)|
| Focus composer          | `Tab` (in terminal)|
| Clear terminal          | `Ctrl+L`           |
| Increase / decrease size| `Ctrl+=` / `Ctrl+-`|
| Reset size              | `Ctrl+0`           |
| Quit                    | `Ctrl+Q`           |

Standard terminal keys (`Ctrl+C` → SIGINT, `Ctrl+D` → EOF) pass through to the shell when the terminal is focused.

## Shell

- Spawned via `portable-pty`. Command: `$SHELL` (fall back to `/bin/sh` if unset).
- No login flag. No `-i` injection. Inherits the parent process env unchanged (Tauri's default).

## Linux integration

- Slug: `krill-terminal`. Binary `krill-terminal`. Identifier `software.krill.krill-terminal`.
- No MIME associations — terminals don't "open" files.
- No `.desktop` file association — it's a standalone app.
- Distribution: AppImage + `.deb`, both via the shared `krill-app-release.yml` workflow.
- In-app updater wired via `@krill-software/desktop-ui` v0.5.0+.

## Milestones

1. **M1 — Shell window works.** portable-pty spawns `$SHELL`, xterm.js renders output, keyboard input flows back through. Resize works. Selection + copy/paste work. *No composer, no snippets yet.* The app should already be usable as a basic terminal.
2. **M2 — Composer.** Add the bottom panel with CodeMirror + shell highlighting + Paste / Paste & run buttons. Wire them through to the PTY. Resizable split divider.
3. **M3 — Snippet save / list.** Save button + inline name/tag form. Persist to JSON. List in aux pane. Click-to-load.
4. **M4 — Search + tags.** Search input. Filter chips. Tag colors. Edit / Delete via kebab.
5. **M5 — Polish.** Status line (shell, pid, last exit). Adjustable font size. Final keybinding pass. Release.

## Out of scope / open questions

- **Scrollback persistence across windows.** v1 keeps scrollback in-memory only (xterm.js default). A persisted-history feature is debatable.
- **Hyperlink detection in terminal output.** xterm.js has a `Links` addon that lights up URLs. Free; almost certainly worth enabling.
- **Command history within the composer** — like up-arrow recalling previous composer drafts. Maybe. Not v1.
- **"Run in fresh shell"** vs "Run in current shell." v1 only does the latter (the shell that's already alive in the window).
- **Sandboxing the shell.** Out of scope — krill apps don't sandbox.
