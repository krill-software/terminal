import "@krill-software/desktop-ui/styles";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { mountChrome, showBootError } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { createComposer, type ComposerHandle } from "./composer";

interface PersistedState {
  font_size?: number;
  split_ratio?: number;
  window?: { width: number; height: number; x: number; y: number };
}

const FONT_MIN = 11;
const FONT_MAX = 24;
const FONT_DEFAULT = 14;

let fontSize = FONT_DEFAULT;
const persisted: PersistedState = {};
let saveStateTimer: number | undefined;

let term: Terminal;
let fit: FitAddon;
let ptyId: number | null = null;
let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;

let composer: ComposerHandle | null = null;

// ---- xterm.js wire-up ----------------------------------------------------

/** Krill-palette xterm theme. Foreground / background match the chrome.
 *  The 16 ANSI slots are muted variants so cat'ing a colorful log doesn't
 *  shout — but anything `ls --color` / vim emits is still distinguishable.
 *  Output is not subject to the palette (carve-out in STYLE.md). */
const KRILL_THEME = {
  background: "#FAFAFF",
  foreground: "#30343F",
  cursor: "#DD7596",
  cursorAccent: "#FAFAFF",
  selectionBackground: "rgba(221, 117, 150, 0.30)",
  selectionForeground: "#30343F",
  black:   "#30343F", brightBlack:   "#878472",
  red:     "#B5495B", brightRed:     "#DD7596",
  green:   "#5A7A4E", brightGreen:   "#7A9C6E",
  yellow:  "#B0853C", brightYellow:  "#C9A85A",
  blue:    "#4A6E94", brightBlue:    "#6E92B8",
  magenta: "#8A5990", brightMagenta: "#B07BB8",
  cyan:    "#4F8488", brightCyan:    "#73A4A8",
  white:   "#878472", brightWhite:   "#30343F",
};

function buildTerminal(host: HTMLElement): void {
  term = new Terminal({
    fontFamily: "Hasklig, 'Source Code Pro', ui-monospace, monospace",
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "bar",
    theme: KRILL_THEME,
    allowProposedApi: true,
    scrollback: 5000,
  });

  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  term.open(host);
  fit.fit();

  term.onData((data) => {
    if (ptyId === null) return;
    void invoke("pty_write", { id: ptyId, data });
  });

  const ro = new ResizeObserver(() => {
    try { fit.fit(); } catch { /* term not ready */ }
  });
  ro.observe(host);

  term.onResize(({ cols, rows }) => {
    if (ptyId === null) return;
    void invoke("pty_resize", { id: ptyId, cols, rows });
  });
}

async function startPty(): Promise<void> {
  const { cols, rows } = term;
  ptyId = await invoke<number>("pty_spawn", { cols, rows });

  unlistenData = await listen<string>(`pty://${ptyId}/data`, (e) => {
    const s = e.payload;
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    term.write(bytes);
  });

  unlistenExit = await listen<void>(`pty://${ptyId}/exit`, () => {
    term.writeln("\r\n\x1b[2m[process exited]\x1b[0m");
  });
}

// ---- Font size ------------------------------------------------------------

function applyFontSize(size: number) {
  fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  if (term) {
    term.options.fontSize = fontSize;
    try { fit.fit(); } catch { /* term not ready */ }
  }
  persisted.font_size = fontSize;
  schedulePersist();
}

function bumpFontSize(delta: number) { applyFontSize(fontSize + delta); }
function resetFontSize() { applyFontSize(FONT_DEFAULT); }

// ---- Chrome ---------------------------------------------------------------

function initChrome() {
  const chrome = mountChrome({
    productName: "Krill Terminal",
    customMenu: [
      {
        group: "view",
        items: [
          { label: "Increase font size", shortcut: "Ctrl+=", action: () => bumpFontSize(1) },
          { label: "Decrease font size", shortcut: "Ctrl+-", action: () => bumpFontSize(-1) },
          { label: "Reset font size",    shortcut: "Ctrl+0", action: resetFontSize },
          { sep: true },
          { label: "Clear terminal",     shortcut: "Ctrl+L", action: () => term?.clear() },
        ],
      },
    ],
    showStatusLine: true,
    updater: true,
  });

  chrome.title.textContent = "Krill Terminal";

  // Vertical stack inside the main viewport: terminal pane (top),
  // drag handle, composer pane (bottom with buttons under the editor).
  const stack = document.createElement("div");
  stack.id = "term-stack";
  chrome.viewport.appendChild(stack);

  const termPane = document.createElement("div");
  termPane.id = "term-pane";
  stack.appendChild(termPane);

  const handle = document.createElement("div");
  handle.id = "term-split";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  stack.appendChild(handle);
  installSplitDrag(handle, termPane);

  const composerPane = document.createElement("div");
  composerPane.id = "composer-pane";
  stack.appendChild(composerPane);

  const composerHost = document.createElement("div");
  composerHost.id = "composer-host";
  composerPane.appendChild(composerHost);

  const bar = document.createElement("div");
  bar.id = "composer-bar";
  composerPane.appendChild(bar);

  const btnPaste = mkBtn("Paste",        "secondary", () => paste());
  const btnRun   = mkBtn("Paste & run",  "primary",   () => pasteAndRun());
  const btnSave  = mkBtn("Save…",        "secondary", () => saveSnippet());
  btnSave.disabled = true;
  btnSave.title = "Snippet save lands in M3";
  bar.appendChild(btnPaste);
  bar.appendChild(btnRun);
  bar.appendChild(btnSave);

  composer = createComposer(composerHost, { paste, pasteAndRun, save: saveSnippet });

  // Status line — M1 labels the shell. M5 adds pid + last exit code.
  const shellSpan = document.createElement("span");
  shellSpan.id = "status-shell";
  shellSpan.textContent = "shell";
  chrome.statusInfo!.appendChild(shellSpan);

  buildTerminal(termPane);

  // Apply persisted split ratio after the panes exist.
  if (persisted.split_ratio) applySplitRatio(persisted.split_ratio);
}

function mkBtn(label: string, variant: "primary" | "secondary", onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `composer-btn ${variant}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// ---- Composer actions ----------------------------------------------------

/** Type the composer body into the PTY as if the user pasted it. No newline. */
function paste(): void {
  if (!composer || ptyId === null) return;
  const body = composer.getBody();
  if (!body) return;
  void invoke("pty_write", { id: ptyId, data: body });
  term.focus();
}

/** Paste, then send a newline so the shell runs it. */
function pasteAndRun(): void {
  if (!composer || ptyId === null) return;
  const body = composer.getBody();
  if (!body) return;
  void invoke("pty_write", { id: ptyId, data: body + "\n" });
  term.focus();
}

/** Stub for M3 — keeps the keybinding alive without doing anything. */
function saveSnippet(): void {
  // TODO(M3): open inline save form (name + tags) and persist.
}

// ---- Split divider --------------------------------------------------------

const SPLIT_MIN_RATIO = 0.2;
const SPLIT_MAX_RATIO = 0.85;

function applySplitRatio(r: number): void {
  const stack = document.getElementById("term-stack");
  if (!stack) return;
  const clamped = Math.max(SPLIT_MIN_RATIO, Math.min(SPLIT_MAX_RATIO, r));
  stack.style.setProperty("--term-fr", String(clamped));
  stack.style.setProperty("--composer-fr", String(1 - clamped));
  persisted.split_ratio = clamped;
  schedulePersist();
  try { fit?.fit(); } catch { /* term not ready */ }
}

function installSplitDrag(handle: HTMLElement, _termPane: HTMLElement): void {
  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const stack = document.getElementById("term-stack")!;
    const rect = stack.getBoundingClientRect();
    const y = e.clientY - rect.top;
    applySplitRatio(y / rect.height);
  });
  const end = (e: PointerEvent) => {
    dragging = false;
    handle.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

// ---- Window persistence ---------------------------------------------------

function schedulePersist() {
  if (saveStateTimer !== undefined) clearTimeout(saveStateTimer);
  saveStateTimer = window.setTimeout(() => {
    invoke("save_state", { state: persisted }).catch(() => {});
  }, 300);
}

async function installWindowPersistence() {
  const w = getCurrentWindow();
  if (persisted.window) {
    const { width, height, x, y } = persisted.window;
    await w.setSize(new LogicalSize(width, height)).catch(() => {});
    await w.setPosition(new LogicalPosition(x, y)).catch(() => {});
  }
  const record = async () => {
    try {
      const size = await w.innerSize();
      const pos = await w.outerPosition();
      const factor = await w.scaleFactor();
      persisted.window = {
        width: Math.round(size.width / factor),
        height: Math.round(size.height / factor),
        x: Math.round(pos.x / factor),
        y: Math.round(pos.y / factor),
      };
      schedulePersist();
    } catch { /* ignore */ }
  };
  await w.onResized(record);
  await w.onMoved(record);
  await w.onCloseRequested(async () => {
    if (ptyId !== null) {
      try { await invoke("pty_kill", { id: ptyId }); } catch { /* ignore */ }
    }
    unlistenData?.();
    unlistenExit?.();
  });
}

// ---- Boot -----------------------------------------------------------------

async function boot() {
  try {
    const loaded = await invoke<PersistedState | null>("load_state");
    if (loaded) Object.assign(persisted, loaded);
  } catch { /* no prior state */ }

  applyFontSize(persisted.font_size ?? FONT_DEFAULT);

  initChrome();
  await installWindowPersistence();
  await startPty();

  term.focus();
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
