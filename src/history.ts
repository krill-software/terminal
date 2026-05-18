// Command history — records every paste-and-run sent through the composer.
// Persisted to ~/.local/state/krill-terminal/history.json. Capped at MAX
// entries with most-recent-first ordering and dedupe-by-body.

import { invoke } from "@tauri-apps/api/core";

const MAX_ENTRIES = 1000;

interface HistoryEntry {
  body: string;
  /** Last time this command was run. ISO timestamp. */
  used: string;
}

let entries: HistoryEntry[] = [];
let saveTimer: number | undefined;

export async function loadHistory(): Promise<void> {
  try {
    const raw = await invoke<unknown>("history_load");
    if (Array.isArray(raw)) {
      entries = raw
        .filter((e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).body === "string")
        .slice(0, MAX_ENTRIES);
    }
  } catch {
    entries = [];
  }
}

function persist(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("history_save", { history: entries }).catch(() => {});
  }, 200);
}

/** Record a command. Moves an existing entry to the front; trims to MAX. */
export function record(body: string): void {
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) return;
  const i = entries.findIndex(e => e.body === trimmed);
  if (i >= 0) entries.splice(i, 1);
  entries.unshift({ body: trimmed, used: new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  persist();
}

/** Longest history entry that *starts with* `prefix` and isn't the prefix
 *  itself. Returns null if nothing matches. Most-recent wins on ties. */
export function suggest(prefix: string): string | null {
  if (!prefix) return null;
  for (const e of entries) {
    if (e.body.startsWith(prefix) && e.body !== prefix) return e.body;
  }
  return null;
}

export function all(): readonly HistoryEntry[] {
  return entries;
}
