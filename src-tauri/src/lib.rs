//! krill-terminal — minimal PTY-backed terminal. M1 surface area:
//!
//!   * `pty_spawn(cols, rows)` — spawn $SHELL (fallback /bin/sh) attached to a
//!     freshly allocated pseudo-terminal at the given size. Returns a session
//!     id. Spawns a background thread that pumps the PTY's master reader and
//!     emits `pty://<id>/data` events with the raw bytes (latin1-encoded JS
//!     string).
//!   * `pty_write(id, data)` — write `data` (string) to the PTY master.
//!     Frontend uses this for both keystrokes and "paste from composer."
//!   * `pty_resize(id, cols, rows)` — propagate window-size changes.
//!   * `pty_kill(id)` — drop the session (closes the master, child gets SIGHUP).
//!
//! State helpers (`load_state` / `save_state`) follow the krill convention.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use krill_desktop_core::{state as kstate, updater::BuilderExt};

const SLUG: &str = "krill-terminal";

struct PtySession {
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
struct PtyRegistry {
    sessions: HashMap<u64, PtySession>,
    next_id: u64,
}

type PtyState = Arc<Mutex<PtyRegistry>>;

#[tauri::command]
fn pty_spawn(
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let id = {
        let mut reg = state.lock().unwrap();
        let id = reg.next_id;
        reg.next_id += 1;
        reg.sessions.insert(id, PtySession { pair, writer });
        id
    };

    // Pump PTY → frontend. Each byte becomes a u16 char in [0, 255] so the
    // frontend can decode UTF-8 from the bytes itself (xterm.js handles its
    // own decoding via TextDecoder when we hand it Uint8Array).
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s: String = buf[..n].iter().map(|&b| b as char).collect();
                    let _ = app_for_thread.emit(&format!("pty://{}/data", id), s);
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(&format!("pty://{}/exit", id), ());
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(id: u64, data: String, state: State<'_, PtyState>) -> Result<(), String> {
    let mut reg = state.lock().unwrap();
    let session = reg
        .sessions
        .get_mut(&id)
        .ok_or_else(|| format!("unknown pty session {id}"))?;
    let bytes: Vec<u8> = data.chars().map(|c| c as u32 as u8).collect();
    session.writer.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_resize(id: u64, cols: u16, rows: u16, state: State<'_, PtyState>) -> Result<(), String> {
    let reg = state.lock().unwrap();
    let session = reg
        .sessions
        .get(&id)
        .ok_or_else(|| format!("unknown pty session {id}"))?;
    session
        .pair
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_kill(id: u64, state: State<'_, PtyState>) -> Result<(), String> {
    let mut reg = state.lock().unwrap();
    reg.sessions.remove(&id);
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    font_size: Option<u32>,
    split_ratio: Option<f32>,
    window: Option<kstate::WindowGeometry>,
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

// ---- Snippet + history persistence ------------------------------------
//
// Both are simple JSON arrays of opaque records. Frontend owns the shape;
// Rust just shuttles bytes via `serde_json::Value`. Stored alongside
// `state.json` in the XDG state dir.

#[tauri::command]
fn snippets_load() -> serde_json::Value {
    kstate::load::<serde_json::Value>(SLUG, "snippets.json")
        .unwrap_or_else(|| serde_json::Value::Array(vec![]))
}

#[tauri::command]
fn snippets_save(snippets: serde_json::Value) -> Result<(), String> {
    kstate::save(SLUG, "snippets.json", &snippets)
}

#[tauri::command]
fn history_load() -> serde_json::Value {
    kstate::load::<serde_json::Value>(SLUG, "history.json")
        .unwrap_or_else(|| serde_json::Value::Array(vec![]))
}

#[tauri::command]
fn history_save(history: serde_json::Value) -> Result<(), String> {
    kstate::save(SLUG, "history.json", &history)
}

// ---- Command lookup ---------------------------------------------------
//
// `which_command` resolves a single executable name via PATH and returns
// whether it exists. Frontend caches results per session — `which` is
// fast but we still don't want to re-resolve the same token on every
// keystroke. Shell builtins (cd, echo, etc.) are handled on the
// frontend side.

#[tauri::command]
fn which_command(name: String) -> bool {
    which::which(&name).is_ok()
}

// ---- shellcheck wrapper -----------------------------------------------
//
// Spawns `shellcheck --shell=bash --format=json -` and pipes the
// composer body to its stdin. Returns the parsed JSON array of findings.
// A missing shellcheck binary returns the sentinel error "NOT_INSTALLED"
// which the frontend special-cases to show install guidance.

#[tauri::command]
fn shellcheck_run(body: String) -> Result<serde_json::Value, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = match Command::new("shellcheck")
        .args(["--shell=bash", "--format=json", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("NOT_INSTALLED".to_string());
        }
        Err(e) => return Err(format!("spawn: {e}")),
    };

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait: {e}"))?;

    // shellcheck exits non-zero when there are findings; that's not an
    // error condition for us. Parse stdout regardless.
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(serde_json::Value::Array(vec![]));
    }
    serde_json::from_str(&stdout).map_err(|e| format!("parse: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .with_updater()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(Mutex::new(PtyRegistry::default())) as PtyState);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            load_state,
            save_state,
            snippets_load,
            snippets_save,
            history_load,
            history_save,
            which_command,
            shellcheck_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
