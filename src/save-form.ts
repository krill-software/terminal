// Save-as-snippet form. Renders as an overlay anchored to the composer
// bar; Esc / outside click cancels. Tags are comma-separated. The
// composer body is read at the moment of opening.

import { add } from "./snippets";

export function openSaveForm(getBody: () => string, anchor: HTMLElement): void {
  if (document.querySelector(".save-form")) return; // single instance

  const body = getBody();
  if (!body.trim()) return;

  const overlay = document.createElement("div");
  overlay.className = "save-form-backdrop";

  const form = document.createElement("form");
  form.className = "save-form";

  const title = document.createElement("h3");
  title.textContent = "Save snippet";
  form.appendChild(title);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "build all";
  name.required = true;
  nameLabel.appendChild(name);
  form.appendChild(nameLabel);

  const tagsLabel = document.createElement("label");
  tagsLabel.textContent = "Tags (comma-separated, optional)";
  const tags = document.createElement("input");
  tags.type = "text";
  tags.placeholder = "work, build";
  tagsLabel.appendChild(tags);
  form.appendChild(tagsLabel);

  const bodyPreview = document.createElement("pre");
  bodyPreview.className = "save-form-body";
  bodyPreview.textContent = body;
  form.appendChild(bodyPreview);

  const actions = document.createElement("div");
  actions.className = "save-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "composer-btn secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "composer-btn primary";
  save.textContent = "Save";
  actions.appendChild(cancel);
  actions.appendChild(save);
  form.appendChild(actions);

  overlay.appendChild(form);
  document.body.appendChild(overlay);

  // Anchor the form just above the composer bar so it doesn't fly to
  // the center of the window.
  const rect = anchor.getBoundingClientRect();
  form.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  form.style.right = `${window.innerWidth - rect.right}px`;

  name.focus();

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return;
    const ts = tags.value.split(",").map(t => t.trim()).filter(Boolean);
    add(n, ts, body);
    close();
  });
}
