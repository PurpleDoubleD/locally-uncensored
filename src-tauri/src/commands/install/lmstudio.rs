//! Das `lms`-CLI finden und den laufenden LM-Studio-Server bedienen.
//!
//! Der geteilte Zustand ist eine fremde, bereits laufende Anwendung: ein Port
//! auf dem Loopback und ein Kommandozeilenwerkzeug irgendwo auf der Platte.
//! Alles hier dreht sich um diese zwei und um nichts sonst — den Server
//! starten, seinen Zustand abfragen, Modelle laden und entladen.
//!
//! Die Naht gegen `lmstudio_install` verläuft entlang des Zustands, nicht
//! entlang des Themas: dort wird ein `InstallState` gefüllt, hier wird ein
//! laufender Dienst angesprochen. Der Modellwähler fragt dieses Modul im
//! Sekundentakt ab, während die Installation genau einmal im Leben läuft.
//!
//! Daraus folgt die auffälligste Eigenheit hier: `lmstudio_port_open` mit
//! seinen 300 ms geht JEDER HTTP-Anfrage voraus. Ein einfaches GET gegen
//! einen geschlossenen Port braucht auf manchen Windows-Kisten zwei bis
//! sieben Sekunden, und der Wähler fragt alle 1,5 s — das war die Ursache
//! des eingefrorenen Fensters, nicht die Anfrage selbst.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::os_error;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

pub(super) const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

pub(crate) fn lmstudio_lms_path() -> Option<PathBuf> {
    // Every branch below is a Windows-ism (`lms.exe`, LOCALAPPDATA/PROGRAMFILES,
    // the registry, `where`), so on macOS/Linux this returned None even with LM
    // Studio installed — breaking lmstudio_load/unload/server there. The
    // cross-platform helper already handles the Unix layout (`lms` with no
    // extension at ~/.lmstudio/bin, plus Spotlight), so delegate to it.
    #[cfg(not(target_os = "windows"))]
    {
        return crate::os_paths::find_lms_cli();
    }
    // Post-bootstrap: `lms bootstrap` materialises the launcher here and adds
    // the same path to PATH. Cheapest check first.
    #[allow(unreachable_code)]
    let direct = dirs::home_dir().map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
    if let Some(ref p) = direct {
        if p.exists() {
            return direct;
        }
    }

    // Pre-bootstrap: on a fresh install, lms.exe ships inside the GUI app's
    // resources dir before `lms bootstrap` ever runs. Calling this binary
    // directly is how we *do* the bootstrap on a brand-new box — without it
    // the user has to open LM Studio once from the Start menu just to seed
    // the CLI, which is exactly the noob-cliff this sweep is removing.
    let webpack_suffix = ["resources", "app", ".webpack", "lms.exe"];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let mut pre_bootstrap = PathBuf::from(la);
        pre_bootstrap.push("Programs");
        pre_bootstrap.push("LM Studio");
        for s in &webpack_suffix { pre_bootstrap.push(s); }
        if pre_bootstrap.exists() {
            return Some(pre_bootstrap);
        }
    }

    // System-wide install path: when LM Studio's installer is run "for all
    // users" (or installed via an MSI deployment), it lands in
    // %PROGRAMFILES%\LM Studio\. techx69 confirmed (2026-05-06): the
    // per-user-only lookup made LU report "no LM Studio detected" even with
    // `~/.lmstudio/models/` already populated.
    for env_var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Ok(pf) = std::env::var(env_var) {
            let mut sys_wide = PathBuf::from(pf);
            sys_wide.push("LM Studio");
            for s in &webpack_suffix { sys_wide.push(s); }
            if sys_wide.exists() {
                return Some(sys_wide);
            }
        }
    }

    // Registry-based fallback: LM Studio's installer writes its install dir
    // under HKCU or HKLM Uninstall keys. Reading the registry lets us catch
    // exotic install dirs (e.g. user moved it to D:\Apps\LM Studio\).
    #[cfg(target_os = "windows")]
    if let Some(p) = lmstudio_path_from_registry() {
        let candidate = p.join("resources").join("app").join(".webpack").join("lms.exe");
        if candidate.exists() {
            return Some(candidate);
        }
        // Some builds drop lms.exe at the install root.
        let root_candidate = p.join("lms.exe");
        if root_candidate.exists() {
            return Some(root_candidate);
        }
    }

    // Last resort: PATH lookup. Catches non-standard installs (Chocolatey,
    // user-relocated install dir, etc.). CREATE_NO_WINDOW so this `where` probe
    // never flashes a console window at the end user.
    let mut where_cmd = Command::new("where");
    where_cmd.arg("lms");
    #[cfg(target_os = "windows")]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = where_cmd.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// Soft-detect LM Studio by scanning `~/.lmstudio/models/` for GGUF files.
/// Returns the number of GGUF files found (0 if the dir is missing or empty).
///
/// Rationale: even when `lms.exe` isn't on any search path (system-wide
/// install missed by our fallback, GUI never launched, etc.), the presence
/// of GGUFs in the canonical models dir is a strong signal that the user
/// *has* LM Studio and just hasn't started the server. Surfacing that in the
/// onboarding lets us show "LM Studio models detected — start server?" instead
/// of the dead-end "no LM Studio".
fn lmstudio_models_present() -> u32 {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return 0,
    };
    let models_dir = home.join(".lmstudio").join("models");
    if !models_dir.exists() {
        return 0;
    }
    // The standard layout is ~/.lmstudio/models/<publisher>/<repo>/<file>.gguf —
    // up to three levels deep. We walk lazily and stop after the first 1000
    // matches; the user does not care about the exact count past "many".
    fn walk(dir: &Path, depth: u32, found: &mut u32) {
        if *found >= 1000 || depth > 4 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, found);
            } else if path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                *found += 1;
                if *found >= 1000 {
                    return;
                }
            }
        }
    }
    let mut count: u32 = 0;
    walk(&models_dir, 0, &mut count);
    count
}

#[cfg(target_os = "windows")]
fn lmstudio_path_from_registry() -> Option<PathBuf> {
    // Read InstallLocation from LM Studio's Uninstall entry. We try HKCU
    // first (per-user installs) then HKLM (system-wide). The display name
    // varies slightly between installer builds, so we scan for any subkey
    // whose DisplayName starts with "LM Studio".
    use winreg::enums::*;
    use winreg::RegKey;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for uninstall_path in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(uninstall) = root.open_subkey(uninstall_path) else { continue };
            for key_res in uninstall.enum_keys() {
                let Ok(key) = key_res else { continue };
                let Ok(sub) = uninstall.open_subkey(&key) else { continue };
                let name: String = sub.get_value("DisplayName").unwrap_or_default();
                if name.eq_ignore_ascii_case("LM Studio") || name.starts_with("LM Studio") {
                    if let Ok(loc) = sub.get_value::<String, _>("InstallLocation") {
                        let p = PathBuf::from(loc);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Path to the LM Studio GUI executable on Windows. We only need to launch
/// this in the rare case where `lms bootstrap` from the pre-bootstrap binary
/// reports success but `~/.lmstudio/` is still missing — some installs
/// require a one-time GUI launch to populate user-data dirs before
/// `lms bootstrap` will register the CLI on PATH.
pub(super) fn lmstudio_gui_exe() -> Option<PathBuf> {
    let la = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(la)
        .join("Programs")
        .join("LM Studio")
        .join("LM Studio.exe");
    if p.exists() { Some(p) } else { None }
}

/// Das App-Bundle an den zwei Stellen, an denen es unter macOS landet.
///
/// KEINE Spotlight-Suche. Die alte Fassung in `os_paths` hing hier ein
/// `mdfind` an, und das war der Grund, warum die Settings-Zeile den
/// Hauptthread blockieren konnte: auf einem Mac mit beschaeftigtem Index
/// dauert der Aufruf Sekunden. Damit faellt der Fall weg, dass jemand LM
/// Studio an eine ungewoehnliche Stelle gelegt hat. Wer das tut, hat fast
/// immer auch `lms bootstrap` gelaufen, und dann findet ihn der Weg darueber.
#[cfg(target_os = "macos")]
fn lmstudio_app_bundle() -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/LM Studio.app"),
        dirs::home_dir()?.join("Applications").join("LM Studio.app"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

#[cfg(not(target_os = "macos"))]
fn lmstudio_app_bundle() -> Option<PathBuf> {
    // Windows deckt `lmstudio_lms_path` selbst ab, es kennt dort beide
    // Programmverzeichnisse. Unter Linux liefert LM Studio ein AppImage ohne
    // festen Ort, es gibt also nichts nachzusehen.
    None
}

/// Ist LM Studio ueberhaupt da? Die `lms`-CLI ODER das App-Bundle.
///
/// Beide Haelften werden gebraucht: wer LM Studio ueber die Oberflaeche
/// installiert und `lms bootstrap` nie laufen laesst, hat keine CLI und kein
/// `~/.lmstudio`, und die Settings-Zeile meldete dann faelschlich "nicht
/// installiert".
pub(crate) fn lmstudio_installed() -> bool {
    lmstudio_lms_path().is_some() || lmstudio_app_bundle().is_some()
}

/// Fast, BOUNDED reachability probe for the LM Studio server. A plain HTTP GET
/// to a DOWN server is catastrophically slow on some Windows boxes: connecting
/// to a closed `127.0.0.1:<port>` can take ~2 s to refuse (the IPv4 loopback
/// SYN is silently dropped by the firewall → TCP retransmit timeout), and
/// `reqwest`'s request `timeout` does NOT bound the connect phase tightly, so
/// the GET ran 2–7 s. Worse, the model-selector re-polls the LM-Studio
/// loaded-state every ~1.5 s while open, and the commands were SYNCHRONOUS
/// (→ main thread), so each stacked multi-second probe froze the whole UI.
/// `TcpStream::connect_timeout` hard-caps the down-case at 300 ms; the explicit
/// `127.0.0.1` (not `localhost`) skips the slow IPv4/IPv6 happy-eyeballs dance.
fn lmstudio_port_open() -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), LMSTUDIO_DEFAULT_PORT);
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

pub(super) fn lmstudio_server_running() -> bool {
    // Bail in <=300 ms when nothing is listening — see lmstudio_port_open.
    if !lmstudio_port_open() {
        return false;
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .connect_timeout(std::time::Duration::from_millis(400))
        .no_proxy()
        .build();
    if let Ok(c) = client {
        return c
            .get(format!("http://127.0.0.1:{}/v1/models", LMSTUDIO_DEFAULT_PORT))
            .send()
            .map(|r| r.status().is_success() || r.status() == 401)
            .unwrap_or(false);
    }
    false
}

/// Best-effort: spawn `lms server start` so we don't make the user open the
/// LM Studio GUI just to flip the Server toggle. Idempotent — quick early-exit
/// if the server is already responding.
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
pub async fn start_lmstudio_server() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(start_lmstudio_server_blocking)
        .await
        .map_err(|e| format!("start_lmstudio_server task: {e}"))?
}

fn start_lmstudio_server_blocking() -> Result<serde_json::Value, String> {
    if lmstudio_server_running() {
        return Ok(serde_json::json!({"status": "already_running"}));
    }
    match lmstudio_lms_path() {
        Some(p) => {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            srv.spawn()
                .map_err(|e| format!("spawn lms: {}", os_error::english(&e)))?;
            Ok(serde_json::json!({"status": "starting"}))
        }
        None => Err(
            "LM Studio is not installed (no lms.exe found). Use Settings → Install LM Studio first."
                .to_string(),
        ),
    }
}

// ASYNC + spawn_blocking: this command does a (now-bounded) blocking TCP/HTTP
// probe + filesystem scan. A SYNCHRONOUS Tauri command runs on the MAIN thread,
// so the model-selector's on-open + 1.5 s poll froze the UI. Running the
// blocking body on the blocking pool keeps the webview responsive even if a
// probe is slow. (reqwest::blocking also panics inside an async runtime, so the
// blocking work MUST live in spawn_blocking, not a bare async body.)
#[tauri::command]
pub async fn lmstudio_server_status() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
        let model_count = lmstudio_models_present();
        Ok(serde_json::json!({
            "running": lmstudio_server_running(),
            "port": LMSTUDIO_DEFAULT_PORT,
            "lms_present": lmstudio_lms_path().is_some(),
            // Soft-detect signals — onboarding shows "Start LM Studio server?"
            // when models are present even if lms.exe couldn't be located.
            "models_detected": model_count > 0,
            "model_count": model_count,
        }))
    })
    .await
    .map_err(|e| format!("lmstudio_server_status task: {e}"))?
}

// ── Per-model load / unload ────────────────────────────────────
//
// LM Studio's HTTP API has no load/unload endpoints; we drive the `lms`
// CLI for state changes and read the list of loaded models from the v0
// REST API (`/api/v0/models` returns each entry with `state: "loaded" |
// "not-loaded"`). This mirrors the Ollama per-row toggle in the model
// selector — without it LM-Studio rows have no on/off affordance even
// though the underlying engine does the same load-into-VRAM dance.
//
// Backport from uselu E2E pass (2026-05-19). Body is 1:1; signature
// adapted from uselu's bridge-daemon convention to Tauri command, and
// the lms-CLI lookup uses desktop's richer `lmstudio_lms_path()` helper
// instead of uselu's lighter `os_paths::find_lms_cli()`.

// ASYNC + spawn_blocking + fast port pre-check (see lmstudio_server_status /
// lmstudio_port_open). Polled every ~1.5 s by the model selector while open —
// the old sync + slow-localhost-probe form was the main cause of the dropdown
// freeze.
#[tauri::command]
pub async fn lmstudio_list_loaded() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
        let empty = || serde_json::json!({ "loaded": Vec::<String>::new() });
        // Down server → return empty in <=300 ms instead of a 2–7 s connect.
        if !lmstudio_port_open() {
            return Ok(empty());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .connect_timeout(std::time::Duration::from_millis(400))
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("http://127.0.0.1:{}/api/v0/models", LMSTUDIO_DEFAULT_PORT);
        let resp = match client.get(&url).send() {
            Ok(r) => r,
            Err(_) => return Ok(empty()),
        };
        if !resp.status().is_success() {
            return Ok(empty());
        }
        let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let loaded: Vec<String> = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|m| m.get("state").and_then(|s| s.as_str()) == Some("loaded"))
                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({ "loaded": loaded }))
    })
    .await
    .map_err(|e| format!("lmstudio_list_loaded task: {e}"))?
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn lmstudio_load_model(model: String, contextLength: Option<u32>) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || lmstudio_load_model_blocking(model, contextLength))
        .await
        .map_err(|e| format!("lmstudio_load_model task: {e}"))?
}

#[allow(non_snake_case)]
fn lmstudio_load_model_blocking(model: String, contextLength: Option<u32>) -> Result<serde_json::Value, String> {
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found — install LM Studio first".to_string())?;
    // `lms load` blocks until the model is in memory. The caller is expected
    // to render a spinner while the request is in flight (same pattern as
    // the Ollama per-row toggle).
    //
    // `-y` / --yes is REQUIRED here, not optional: per `lms load --help`, when
    // the model key is ambiguous (multiple quant/variant matches) or the CLI
    // wants to confirm a device, `lms load` drops into an INTERACTIVE picker
    // that reads from stdin. We capture output with no stdin attached, so that
    // picker blocks forever — the command never returns and the model-selector
    // spinner hangs indefinitely with no error surfaced (observed live on
    // 2026-06-01 with qwen2.5-0.5b-instruct@q4_k_m). `-y` auto-approves and
    // loads the first/preferred match, which is exactly the scripted behaviour
    // we want. Verified: `lms load -y <key>` returns in ~4s and `lms ps` shows
    // the model loaded.
    //
    // contextLength: LM Studio fixes the context window at LOAD time (the
    // OpenAI-compat HTTP API has no per-request num_ctx). To CHANGE it we must
    // reload — so when a context length is requested we unload the current
    // instance first (best-effort; a no-op if nothing is loaded) and reload
    // with `-c <N>` (`lms load --context-length`). Without a context length
    // this stays a plain load (the B3 power toggle path, unchanged).
    if contextLength.is_some() {
        // Hide the console window the `lms` CLI would otherwise flash on
        // Windows (CREATE_NO_WINDOW) — these run during normal model
        // switching / the VRAM hand-off, not just at install time.
        let mut unload = Command::new(&lms);
        unload.args(["unload", &model]);
        #[cfg(target_os = "windows")]
        unload.creation_flags(CREATE_NO_WINDOW);
        let _ = unload.output();
    }
    let ctx = contextLength.unwrap_or(0);
    let ctx_str = ctx.to_string();
    let mut args: Vec<&str> = vec!["load", model.as_str(), "-y"];
    if ctx > 0 {
        args.push("-c");
        args.push(ctx_str.as_str());
    }
    let mut cmd = Command::new(&lms);
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("spawn lms load: {}", os_error::english(&e)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!(
            "[lmstudio_load_model] FAILED model='{}' ctx={:?} code={:?}\n  stderr={:?}\n  stdout={:?}",
            model,
            contextLength,
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        );
        return Err(format!("lms load failed: {}", stderr.trim()));
    }
    eprintln!("[lmstudio_load_model] OK model='{}' ctx={:?}", model, contextLength);
    Ok(serde_json::json!({ "ok": true, "model": model, "contextLength": contextLength }))
}

/// Read a model's context window from LM Studio's enhanced REST API
/// (`GET /api/v0/models`). Returns `loaded_context_length` (what the model is
/// ACTUALLY running with right now — the value the chat truly uses) and
/// `max_context_length` (the model's ceiling). Both are null when LM Studio
/// isn't running or the model isn't found. Reading the list endpoint (not the
/// per-id one) sidesteps URL-encoding issues with publisher/slash ids.
// ASYNC + spawn_blocking + fast port pre-check — same freeze class as
// lmstudio_list_loaded; this one feeds the header token counter.
#[tauri::command]
pub async fn lmstudio_model_context(model: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let null_json = || serde_json::json!({ "loaded": serde_json::Value::Null, "max": serde_json::Value::Null, "state": serde_json::Value::Null });
        if !lmstudio_port_open() {
            return Ok(null_json());
        }
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(2000))
            .connect_timeout(std::time::Duration::from_millis(400))
            .no_proxy()
            .build()
        {
            Ok(c) => c,
            Err(_) => return Ok(null_json()),
        };
        let url = format!("http://127.0.0.1:{}/api/v0/models", LMSTUDIO_DEFAULT_PORT);
        let resp = match client.get(&url).send() {
            Ok(r) => r,
            Err(_) => return Ok(null_json()),
        };
        if !resp.status().is_success() {
            return Ok(null_json());
        }
        let body: serde_json::Value = match resp.json() {
            Ok(b) => b,
            Err(_) => return Ok(null_json()),
        };
        let entry = body
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.iter().find(|m| m.get("id").and_then(|i| i.as_str()) == Some(model.as_str())));
        match entry {
            Some(m) => {
                let loaded = m.get("loaded_context_length").and_then(|v| v.as_u64());
                let max = m
                    .get("max_context_length")
                    .and_then(|v| v.as_u64())
                    .or_else(|| m.get("context_length").and_then(|v| v.as_u64()));
                let state = m.get("state").and_then(|v| v.as_str());
                Ok(serde_json::json!({ "loaded": loaded, "max": max, "state": state }))
            }
            None => Ok(null_json()),
        }
    })
    .await
    .map_err(|e| format!("lmstudio_model_context task: {e}"))?
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
pub async fn lmstudio_unload_model(model: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || lmstudio_unload_model_blocking(model))
        .await
        .map_err(|e| format!("lmstudio_unload_model task: {e}"))?
}

fn lmstudio_unload_model_blocking(model: String) -> Result<serde_json::Value, String> {
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found".to_string())?;
    let mut cmd = Command::new(&lms);
    cmd.args(["unload", &model]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("spawn lms unload: {}", os_error::english(&e)))?;
    if !output.status.success() {
        return Err(format!(
            "lms unload failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(serde_json::json!({ "ok": true, "model": model }))
}
