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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
