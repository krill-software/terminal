// Snippet store — named, tagged shell commands. Loaded once on boot,
// mutated in memory, debounce-persisted to disk on every change.

import { invoke } from "@tauri-apps/api/core";

export interface Snippet {
  id: string;
  name: string;
  tags: string[];
  body: string;
  created: string; // ISO
}

type Listener = () => void;
const listeners = new Set<Listener>();

let snippets: Snippet[] = [];
let saveTimer: number | undefined;

export async function loadSnippets(): Promise<void> {
  try {
    const raw = await invoke<unknown>("snippets_load");
    if (Array.isArray(raw)) {
      snippets = raw
        .filter((s): s is Snippet => {
          if (!s || typeof s !== "object") return false;
          const t = s as Snippet;
          return typeof t.id === "string" && typeof t.name === "string" && typeof t.body === "string";
        })
        .map(s => ({ ...s, tags: Array.isArray(s.tags) ? s.tags : [] }));
    }
  } catch {
    snippets = [];
  }
  notify();
}

function persist(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("snippets_save", { snippets }).catch(() => {});
  }, 200);
}

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function all(): readonly Snippet[] {
  return snippets;
}

/** Filter by case-insensitive substring against name + body. Empty query
 *  returns everything. */
export function filter(query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...snippets];
  return snippets.filter(s =>
    s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
  );
}

export function add(name: string, tags: string[], body: string): Snippet {
  const s: Snippet = {
    id: crypto.randomUUID(),
    name: name.trim(),
    tags: tags.map(t => t.trim()).filter(Boolean),
    body,
    created: new Date().toISOString(),
  };
  snippets = [s, ...snippets];
  persist();
  notify();
  return s;
}

export function remove(id: string): void {
  const i = snippets.findIndex(s => s.id === id);
  if (i < 0) return;
  snippets = snippets.filter(s => s.id !== id);
  persist();
  notify();
}
