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

  const host = document.createElement("div");
  host.id = "term-host";
  chrome.viewport.appendChild(host);

  // Status line — M1 just labels the shell. M5 adds pid + last exit code.
  const shellSpan = document.createElement("span");
  shellSpan.id = "status-shell";
  shellSpan.textContent = "shell";
  chrome.statusInfo!.appendChild(shellSpan);

  buildTerminal(host);
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
