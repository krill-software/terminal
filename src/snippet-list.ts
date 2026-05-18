// Snippet list rendered into the aux pane. Live-filters by the composer
// body. Click → replace composer; Shift+click → append at cursor end.
//
// Empty state: a single muted hint until the user saves their first
// snippet. After that, an empty filter shows all snippets.

import { all, filter, remove, subscribe, type Snippet } from "./snippets";

export interface SnippetListHandlers {
  /** Replace the composer body with the snippet's body. */
  replace: (body: string) => void;
  /** Append the snippet's body to the end of the composer body. */
  append: (body: string) => void;
}

export interface SnippetListHandle {
  /** Update the active filter (driven by composer-doc-change). */
  setQuery: (q: string) => void;
}

const ICON_TRASH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

export function createSnippetList(
  host: HTMLElement,
  handlers: SnippetListHandlers,
): SnippetListHandle {
  let query = "";

  host.classList.add("snippet-list-host");

  const render = () => {
    host.replaceChildren();
    const total = all().length;
    if (total === 0) {
      host.appendChild(emptyHint("Save the composer body with Ctrl+S to add your first snippet."));
      return;
    }
    const matches = filter(query);
    if (matches.length === 0) {
      host.appendChild(emptyHint(`No snippets match "${query}".`));
      return;
    }
    for (const s of matches) host.appendChild(row(s, handlers));
  };

  render();
  subscribe(render);

  return {
    setQuery: (q) => {
      if (q === query) return;
      query = q;
      render();
    },
  };
}

function emptyHint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "snippet-empty";
  p.textContent = text;
  return p;
}

function row(s: Snippet, handlers: SnippetListHandlers): HTMLElement {
  const li = document.createElement("div");
  li.className = "snippet-row";

  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "snippet-label";
  labelBtn.title = s.body;
  labelBtn.addEventListener("click", (e) => {
    if (e.shiftKey) handlers.append(s.body);
    else handlers.replace(s.body);
  });

  const nameEl = document.createElement("div");
  nameEl.className = "snippet-name";
  nameEl.textContent = s.name || "(untitled)";
  labelBtn.appendChild(nameEl);

  const preview = document.createElement("div");
  preview.className = "snippet-preview";
  preview.textContent = s.body.split("\n")[0] || s.body;
  labelBtn.appendChild(preview);

  if (s.tags.length) {
    const tagWrap = document.createElement("div");
    tagWrap.className = "snippet-tags";
    for (const tag of s.tags) {
      const chip = document.createElement("span");
      chip.className = "snippet-tag";
      chip.textContent = tag;
      tagWrap.appendChild(chip);
    }
    labelBtn.appendChild(tagWrap);
  }

  li.appendChild(labelBtn);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "snippet-delete";
  del.innerHTML = ICON_TRASH;
  del.title = "Delete snippet";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    remove(s.id);
  });
  li.appendChild(del);

  return li;
}
