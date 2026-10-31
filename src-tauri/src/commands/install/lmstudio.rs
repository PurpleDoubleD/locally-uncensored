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

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::os_error;

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
    // %PROGRAMFILES%\LM Studio\. A user confirmed (2026-05-06): the
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
    let mut where_cmd = crate::process_util::foreign_system_command("where");
    where_cmd.arg("lms");
    crate::process_util::suppress_window(&mut where_cmd);
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

/// True when a GGUF under `~/.lmstudio/models/` is a model the chat picker
/// will list once the server runs. `rel` is the lowercased path below the
/// models dir (`publisher/repo/file.gguf`).
///
/// The line in the picker says "N models on disk" next to its Start button,
/// and after the click the list has to show N rows. Counting every GGUF said 8
/// where the list showed 7 (Windows box, 05.10.2026). Three kinds of file are
/// no row of their own:
///   - an embedding model: the picker drops those by name, with the patterns
///     of `EMBEDDING_GGUF_PATTERNS` in src/api/engine.ts, repeated here;
///   - a vision projector (`mmproj-*.gguf`), which rides along with its model;
///   - the further parts of a split model (`-00002-of-00003.gguf`).
fn lmstudio_chat_model_file(rel: &str) -> bool {
    const EMBEDDING_MARKS: [&str; 5] = ["embed", "bge-", "e5-", "gte-", "sentence-"];
    if EMBEDDING_MARKS.iter().any(|m| rel.contains(m)) {
        return false;
    }
    let file = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    if file.contains("mmproj") {
        return false;
    }
    // "<name>-00002-of-00003.gguf": only the first part stands for the model.
    let stem = file.strip_suffix(".gguf").unwrap_or(file);
    if let Some((head, total)) = stem.rsplit_once("-of-") {
        let all_digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        if let Some((_, part)) = head.rsplit_once('-') {
            if all_digits(total) && all_digits(part) {
                return part.trim_start_matches('0') == "1";
            }
        }
    }
    true
}

/// What `~/.lmstudio/models/` holds.
#[derive(Default)]
struct LmStudioModelsOnDisk {
    /// Any GGUF at all. Even when `lms.exe` isn't on any search path
    /// (system-wide install missed by our fallback, GUI never launched), a
    /// GGUF in the canonical models dir is a strong signal that the user *has*
    /// LM Studio and just hasn't started the server.
    any: bool,
    /// The models the chat picker will list, see `lmstudio_chat_model_file`.
    chat_models: u32,
}

/// Soft-detect LM Studio by scanning `~/.lmstudio/models/` for GGUF files.
fn lmstudio_models_present() -> LmStudioModelsOnDisk {
    let mut found = LmStudioModelsOnDisk::default();
    let models_dir = match dirs::home_dir() {
        Some(h) => h.join(".lmstudio").join("models"),
        None => return found,
    };
    if !models_dir.exists() {
        return found;
    }
    // The standard layout is ~/.lmstudio/models/<publisher>/<repo>/<file>.gguf —
    // up to three levels deep. We walk lazily and stop after the first 1000
    // matches; the user does not care about the exact count past "many".
    fn walk(root: &Path, dir: &Path, depth: u32, found: &mut LmStudioModelsOnDisk) {
        if found.chat_models >= 1000 || depth > 4 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, depth + 1, found);
            } else if path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                found.any = true;
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_lowercase();
                if lmstudio_chat_model_file(&rel) {
                    found.chat_models += 1;
                    if found.chat_models >= 1000 {
                        return;
                    }
                }
            }
        }
    }
    walk(&models_dir, &models_dir, 0, &mut found);
    found
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

/// The arguments LU starts LM Studio's server with.
///
/// Until 3.0.6 they carried `--cors`. LM Studio's server has no login, and
/// with that flag it answers any origin: a web page open in the user's
/// browser could list the models and run them. LU does not need it, every
/// request to a local backend goes through the Rust proxy (`proxy_localhost`),
/// which is no browser and knows no origin rule.
pub(super) fn lms_server_args() -> [String; 4] {
    ["server".into(), "start".into(), "--port".into(), LMSTUDIO_DEFAULT_PORT.to_string()]
}

fn start_lmstudio_server_blocking() -> Result<serde_json::Value, String> {
    if lmstudio_server_running() {
        return Ok(serde_json::json!({"status": "already_running"}));
    }
    match lmstudio_lms_path() {
        Some(p) => {
            let mut srv = crate::process_util::foreign_system_command(&p);
            srv.args(lms_server_args())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            crate::process_util::suppress_window(&mut srv);
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
        let on_disk = lmstudio_models_present();
        Ok(serde_json::json!({
            "running": lmstudio_server_running(),
            "port": LMSTUDIO_DEFAULT_PORT,
            "lms_present": lmstudio_lms_path().is_some(),
            // Soft-detect signals — onboarding shows "Start LM Studio server?"
            // when models are present even if lms.exe couldn't be located.
            "models_detected": on_disk.any,
            // The rows the chat picker will show, not the files on disk.
            "model_count": on_disk.chat_models,
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
// Backport from the web app E2E pass (2026-05-19). Body is 1:1; signature
// adapted from the web app's bridge-daemon convention to Tauri command, and
// the lms-CLI lookup uses desktop's richer `lmstudio_lms_path()` helper
// instead of the web app's lighter `os_paths::find_lms_cli()`.

// ASYNC + spawn_blocking + fast port pre-check (see lmstudio_server_status /
// lmstudio_port_open). Polled every ~1.5 s by the model selector while open —
// the old sync + slow-localhost-probe form was the main cause of the dropdown
// freeze.
#[tauri::command]
pub async fn lmstudio_list_loaded() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
        // `readable: false` is "the list could not be read", which is not the
        // same as "nothing is loaded". The picker's poll treats both as an
        // empty list; whoever reports the result of a load or unload to a
        // person must not (api/lmstudio.ts, readLoadedLmStudioModels).
        let unreadable = || serde_json::json!({ "loaded": Vec::<String>::new(), "readable": false });
        // Down server → return empty in <=300 ms instead of a 2–7 s connect.
        if !lmstudio_port_open() {
            return Ok(unreadable());
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
            Err(_) => return Ok(unreadable()),
        };
        if !resp.status().is_success() {
            return Ok(unreadable());
        }
        let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "loaded": loaded_ids(&body), "readable": true }))
    })
    .await
    .map_err(|e| format!("lmstudio_list_loaded task: {e}"))?
}

/// The ids `/api/v0/models` reports with `state: "loaded"`.
fn loaded_ids(body: &serde_json::Value) -> Vec<String> {
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("state").and_then(|s| s.as_str()) == Some("loaded"))
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// ── A load or unload has an end ────────────────────────────────
//
// `lms load` blocks until the model is in memory, and `Command::output()`
// waited with it for as long as that took: no limit, and nothing the app
// could do to stop. The same hand test that found the Ollama switch turning
// forever (10.10.2026) applies here unchanged.
//
// Every `lms` call that changes state now runs through `run_lms`: it polls
// the child, and ends it at the limit or when the caller cancels.
//
// Ending it is two steps. `lms load` asks LM Studio to cancel its load when it
// is interrupted (its SIGINT handler aborts the request and exits; read from
// the source of `lms`, not measured against an LM Studio), so where the system
// has an interrupt for a child, that is sent first and the process is given a
// moment to leave by itself. Whatever is still there after that, and every
// `lms` on Windows, loses its process tree.
//
// A killed `lms` does NOT end the load: LM Studio 0.4.12 was seen to go on
// loading for 26 to 46 s after its client was gone, and to keep the model
// (hand test on Windows, 11.10.2026). So the end of this call is never taken
// as the end of the load. The frontend tells LM Studio to unload the model
// as soon as it reports the load, keeps watching, and unloads it once it has
// arrived if that first unload was not taken (api/lmstudio.ts, the ended
// loads).

/// How long a load may take when the caller names no limit. Five minutes, the
/// limit an Ollama load has (api/ollama.ts), plus the slack that lets the
/// frontend's own limit be the one that ends the call.
const LMS_LOAD_LIMIT: Duration = Duration::from_secs(305);
/// The same for an unload.
const LMS_UNLOAD_LIMIT: Duration = Duration::from_secs(20);
/// No caller may ask for a longer wait than this.
const LMS_LIMIT_CEILING: Duration = Duration::from_secs(900);
const LMS_POLL: Duration = Duration::from_millis(50);
/// How long a finished `lms` call is given to hand over what it wrote.
const LMS_OUTPUT_GRACE: Duration = Duration::from_secs(1);
/// How long an interrupted `lms` is given to cancel its load and exit.
const LMS_INTERRUPT_GRACE: Duration = Duration::from_secs(1);

/// The loads that are running, by the id the frontend minted for each, so
/// `lmstudio_cancel_load` can end one. The registry keeps a cancel that
/// arrives before its load registered (cancel_registry.rs).
static LMS_LOADS: once_cell::sync::Lazy<crate::cancel_registry::CancelRegistry> =
    once_cell::sync::Lazy::new(crate::cancel_registry::CancelRegistry::new);

fn lms_limit(timeout_ms: Option<u64>, default: Duration) -> Duration {
    timeout_ms
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(default)
        .min(LMS_LIMIT_CEILING)
}

/// How an `lms` call ended.
#[derive(Debug)]
enum LmsEnd {
    Exited { success: bool, stdout: String, stderr: String },
    Cancelled,
    TimedOut,
}

/// What a child wrote to one of its pipes, collected while it runs.
struct Drained {
    bytes: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    closed: std::sync::mpsc::Receiver<()>,
}

/// Read `pipe` to its end on a thread of its own: a child that fills a pipe
/// nobody reads blocks, and then it never exits.
fn drain(pipe: Option<Box<dyn Read + Send>>) -> Drained {
    let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (tx, closed) = std::sync::mpsc::channel::<()>();
    let sink = bytes.clone();
    std::thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap_or_else(|p| p.into_inner()).extend_from_slice(&chunk[..n]);
            }
        }
        let _ = tx.send(());
    });
    Drained { bytes, closed }
}

impl Drained {
    /// Everything the child wrote, once it has exited.
    ///
    /// The pipe closes with the child, at once, unless the child left a
    /// process behind that still holds it (`lms` starts LM Studio's service
    /// when that is not running). Such a pipe never closes, so the wait for
    /// it has an end, and what was written until then is what is returned.
    fn text(&self) -> String {
        let _ = self.closed.recv_timeout(LMS_OUTPUT_GRACE);
        String::from_utf8_lossy(&self.bytes.lock().unwrap_or_else(|p| p.into_inner())).into_owned()
    }
}

/// Run `cmd` until it exits, `deadline` passes or `cancel` fires, whichever
/// comes first. On the last two the process is interrupted, then its tree is
/// killed if it is still there, and nothing of its output is read.
fn run_lms(mut cmd: Command, deadline: Instant, cancel: &CancellationToken) -> std::io::Result<LmsEnd> {
    // No stdin: `lms` asks on it when a model key is ambiguous, and a question
    // nobody answers is a call that never returns.
    cmd.stdin(Stdio::null());
    let mut child = crate::process_util::spawn_piped(cmd)?;
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(LmsEnd::Exited {
                success: status.success(),
                stdout: stdout.text(),
                stderr: stderr.text(),
            });
        }
        let cancelled = cancel.is_cancelled();
        if cancelled || Instant::now() >= deadline {
            if crate::process_util::interrupt(&child) {
                let leave_by = Instant::now() + LMS_INTERRUPT_GRACE;
                while Instant::now() < leave_by && child.try_wait()?.is_none() {
                    std::thread::sleep(LMS_POLL);
                }
            }
            // kill_tree reaps the child itself; the readers end when the
            // pipes close and are not waited for.
            if child.try_wait()?.is_none() {
                let _ = crate::process_util::kill_tree(&mut child);
            }
            return Ok(if cancelled { LmsEnd::Cancelled } else { LmsEnd::TimedOut });
        }
        std::thread::sleep(LMS_POLL);
    }
}

/// What a call that was ended answers with.
const LMS_CANCELLED: &str = "lms load cancelled";
const LMS_LOAD_TIMED_OUT: &str = "lms load timed out";
const LMS_UNLOAD_TIMED_OUT: &str = "lms unload timed out";

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window.
//
// `timeout_ms` is the limit of the whole call, `call_id` the handle
// `lmstudio_cancel_load` ends it by. Both are optional: a caller that names
// neither gets the default limit and a load only the limit ends.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn lmstudio_load_model(
    model: String,
    contextLength: Option<u32>,
    timeout_ms: Option<u64>,
    call_id: Option<String>,
) -> Result<serde_json::Value, String> {
    // Registered here, before the blocking pool is asked for a thread, so a
    // cancel finds the load from its first moment on.
    let (cancel, guard) = match call_id {
        Some(id) => {
            let (token, guard) = LMS_LOADS.register(id);
            (token, Some(guard))
        }
        None => (CancellationToken::new(), None),
    };
    let deadline = Instant::now() + lms_limit(timeout_ms, LMS_LOAD_LIMIT);
    let result = tokio::task::spawn_blocking(move || lmstudio_load_model_blocking(model, contextLength, deadline, &cancel))
        .await
        .map_err(|e| format!("lmstudio_load_model task: {e}"));
    drop(guard);
    result?
}

/// End the load that was started with this `call_id`. The `lms` process is
/// killed and the load command answers with an error.
#[tauri::command]
pub fn lmstudio_cancel_load(call_id: String) -> Result<(), String> {
    LMS_LOADS.cancel(&call_id);
    Ok(())
}

#[allow(non_snake_case)]
fn lmstudio_load_model_blocking(
    model: String,
    contextLength: Option<u32>,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found. Install LM Studio first.".to_string())?;
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
        // `run_lms` hides the console window the `lms` CLI would otherwise
        // flash on Windows: these run during normal model switching and the
        // VRAM hand-off, not just at install time.
        let mut unload = crate::process_util::foreign_system_command(&lms);
        unload.args(["unload", &model]);
        match run_lms(unload, deadline, cancel) {
            Ok(LmsEnd::Cancelled) => return Err(LMS_CANCELLED.to_string()),
            Ok(LmsEnd::TimedOut) => return Err(LMS_LOAD_TIMED_OUT.to_string()),
            // Best effort, as before: nothing loaded is not a failure.
            Ok(LmsEnd::Exited { .. }) | Err(_) => {}
        }
    }
    let ctx = contextLength.unwrap_or(0);
    let ctx_str = ctx.to_string();
    let mut args: Vec<&str> = vec!["load", model.as_str(), "-y"];
    if ctx > 0 {
        args.push("-c");
        args.push(ctx_str.as_str());
    }
    let mut cmd = crate::process_util::foreign_system_command(&lms);
    cmd.args(&args);
    let end = run_lms(cmd, deadline, cancel)
        .map_err(|e| format!("spawn lms load: {}", os_error::english(&e)))?;
    match end {
        LmsEnd::Cancelled => {
            eprintln!("[lmstudio_load_model] CANCELLED model='{}' ctx={:?}", model, contextLength);
            return Err(LMS_CANCELLED.to_string());
        }
        LmsEnd::TimedOut => {
            eprintln!("[lmstudio_load_model] TIMED OUT model='{}' ctx={:?}", model, contextLength);
            return Err(LMS_LOAD_TIMED_OUT.to_string());
        }
        LmsEnd::Exited { success: false, stdout, stderr } => {
            eprintln!(
                "[lmstudio_load_model] FAILED model='{}' ctx={:?}\n  stderr={:?}\n  stdout={:?}",
                model,
                contextLength,
                stderr.trim(),
                stdout.trim()
            );
            return Err(format!("lms load failed: {}", stderr.trim()));
        }
        LmsEnd::Exited { success: true, .. } => {}
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
// so every millisecond spent here is a frozen window.
#[tauri::command]
pub async fn lmstudio_unload_model(model: String, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + lms_limit(timeout_ms, LMS_UNLOAD_LIMIT);
    tokio::task::spawn_blocking(move || lmstudio_unload_model_blocking(model, deadline))
        .await
        .map_err(|e| format!("lmstudio_unload_model task: {e}"))?
}

fn lmstudio_unload_model_blocking(model: String, deadline: Instant) -> Result<serde_json::Value, String> {
    // Nothing to unload from an LM Studio that is not running, and `lms`
    // would start it to find that out (box runs d307-b and d307-c, H4: every
    // VRAM hand-off before a render left "LM Studio.exe --run-as-service"
    // behind on a box where LM Studio had been closed).
    if !should_run_lms_unload(lmstudio_daemon_answers(), lmstudio_process_running) {
        eprintln!("[lmstudio_unload_model] skipped model='{}': LM Studio is not running", model);
        return Ok(serde_json::json!({ "ok": true, "model": model, "skipped": "not_running" }));
    }
    let lms = lmstudio_lms_path()
        .ok_or_else(|| "lms CLI not found".to_string())?;
    let mut cmd = crate::process_util::foreign_system_command(&lms);
    cmd.args(["unload", &model]);
    let end = run_lms(cmd, deadline, &CancellationToken::new())
        .map_err(|e| format!("spawn lms unload: {}", os_error::english(&e)))?;
    match end {
        LmsEnd::Exited { success: true, .. } => Ok(serde_json::json!({ "ok": true, "model": model })),
        LmsEnd::Exited { success: false, stderr, .. } => Err(format!("lms unload failed: {}", stderr.trim())),
        LmsEnd::Cancelled | LmsEnd::TimedOut => Err(LMS_UNLOAD_TIMED_OUT.to_string()),
    }
}

// ── Is LM Studio running at all ────────────────────────────────
//
// `lms unload` does not fail on a closed LM Studio, it wakes it: the CLI asks
// its daemon for `/lms-status` on a fixed list of loopback ports and, when
// nobody answers, spawns the app from `~/.lmstudio/.internal/
// app-install-location.json` with `--run-as-service` (or the headless
// `llmster` from `llmster-install-location.json`). Read from the `lms` 0.4.15
// bundle on a Mac (`findOrStartLlmster`, `wakeUpServiceFromLocation`,
// `apiServerPorts`). The port 1234 probe above cannot stand in for this: it is
// the OpenAI server, which can be off while the app runs with a model loaded.
//
// So the unload asks the same question `lms` asks first, and only when that
// comes back empty does it look at the process table as a second opinion, in
// case a later `lms` moved its ports. A process only counts as "not LM Studio"
// when neither its name nor its executable path says LM Studio in any
// spelling: "LM Studio.exe" on Windows (box run d307-c), "LM Studio" and its
// helpers inside "LM Studio.app" on the Mac, the node worker under
// `~/.lmstudio/.internal`, an AppImage named lm-studio, or `llmster`. Too wide
// a match only costs the old behaviour (an unload that wakes nothing new).

/// The loopback ports `lms` 0.4.15 probes for its daemon (`apiServerPorts`).
const LMSTUDIO_DAEMON_PORTS: [u16; 5] = [41343, 52993, 16141, 39414, 22931];

/// Whether a `/lms-status` reply is LM Studio's: `lms` accepts a 200 with a
/// string `package` and a string `version`, and so does this.
fn is_lms_status(body: &serde_json::Value) -> bool {
    body.get("package").and_then(|p| p.as_str()).is_some()
        && body.get("version").and_then(|v| v.as_str()).is_some()
}

/// One daemon port, bounded like `lmstudio_port_open`: a closed port refuses
/// in at most 300 ms, an open one gets 800 ms to answer.
fn lmstudio_daemon_at(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_err() {
        return false;
    }
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .connect_timeout(Duration::from_millis(400))
        .no_proxy()
        .build()
    else {
        return false;
    };
    match client.get(format!("http://127.0.0.1:{port}/lms-status")).send() {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().map(|b| is_lms_status(&b)).unwrap_or(false),
        _ => false,
    }
}

/// Whether LM Studio's daemon answers on any of its ports. The ports are asked
/// side by side, so the closed case costs one 300 ms refusal, not five.
fn lmstudio_daemon_answers() -> bool {
    std::thread::scope(|s| {
        let asks: Vec<_> = LMSTUDIO_DAEMON_PORTS
            .iter()
            .map(|&p| s.spawn(move || lmstudio_daemon_at(p)))
            .collect();
        asks.into_iter().any(|h| h.join().unwrap_or(false))
    })
}

/// Whether a name or path says LM Studio: lower case, with spaces, dashes and
/// underscores dropped, it contains "lmstudio" or "llmster".
fn says_lmstudio(text: &str) -> bool {
    let squeezed: String = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    squeezed.contains("lmstudio") || squeezed.contains("llmster")
}

/// Whether any process in the list is LM Studio, by its name or the path of
/// its executable. The command line is left out on purpose: LU's own engine
/// can run a model file that lies under `~/.lmstudio/models`.
fn lmstudio_in_process_list<'a>(procs: impl IntoIterator<Item = (&'a str, Option<&'a Path>)>) -> bool {
    procs
        .into_iter()
        .any(|(name, exe)| says_lmstudio(name) || exe.is_some_and(|p| says_lmstudio(&p.to_string_lossy())))
}

/// The live process table through [`lmstudio_in_process_list`].
fn lmstudio_process_running() -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let names: Vec<(String, Option<PathBuf>)> = sys
        .processes()
        .values()
        .map(|p| (p.name().to_string_lossy().into_owned(), p.exe().map(Path::to_path_buf)))
        .collect();
    lmstudio_in_process_list(names.iter().map(|(n, e)| (n.as_str(), e.as_deref())))
}

/// Whether `lms unload` may run: when the daemon answers, or failing that,
/// when any LM Studio process is there. Skipped only when both say no.
fn should_run_lms_unload(daemon_answers: bool, process_running: impl FnOnce() -> bool) -> bool {
    daemon_answers || process_running()
}

/// The llama.cpp runtime LM Studio runs GGUF models with, e.g. "2.55.0".
///
/// N1, 30.10.2026: Liquid LFM3 needs LM Studio's llama.cpp runtime 2.65.1 or
/// newer (model card of LiquidAI/LFM3-1.7B-GGUF). LM Studio keeps the runtime
/// it uses per format in `~/.lmstudio/.internal/backend-preferences-v1.json`
/// (read on the Mac: `[{"model_format":"gguf","name":"llama.cpp-mac-arm64-
/// apple-metal-advsimd","version":"2.55.0"}, …]`). An internal file, so
/// anything that does not read as that shape answers None and LU says nothing.
/// Read only; LU never changes LM Studio's runtime.
#[tauri::command]
pub fn lmstudio_gguf_runtime() -> Option<String> {
    let path = dirs::home_dir()?.join(".lmstudio").join(".internal").join("backend-preferences-v1.json");
    gguf_runtime_of(&std::fs::read_to_string(path).ok()?)
}

fn gguf_runtime_of(preferences: &str) -> Option<String> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(preferences).ok()?;
    entries.iter().find_map(|e| {
        let gguf = e.get("model_format")?.as_str()? == "gguf";
        let llama = e.get("name")?.as_str()?.starts_with("llama.cpp");
        let version = e.get("version")?.as_str()?;
        (gguf && llama && !version.is_empty()).then(|| version.to_string())
    })
}

#[cfg(test)]
mod gguf_runtime_tests {
    use super::gguf_runtime_of;

    #[test]
    fn the_gguf_runtime_is_read_from_lm_studios_preferences() {
        // The file as it lies on the Mac (LM Studio, 30.10.2026).
        let mac = r#"[{"model_format":"gguf","name":"llama.cpp-mac-arm64-apple-metal-advsimd","version":"2.55.0"},{"model_format":"safetensors","name":"mlx-llm-mac-arm64-apple-metal-nax-advsimd","version":"1.13.1"}]"#;
        assert_eq!(gguf_runtime_of(mac).as_deref(), Some("2.55.0"));
        let windows = r#"[{"model_format":"gguf","name":"llama.cpp-win-x86_64-nvidia-cuda12-avx2","version":"2.66.0"}]"#;
        assert_eq!(gguf_runtime_of(windows).as_deref(), Some("2.66.0"));
    }

    #[test]
    fn another_shape_says_nothing() {
        assert_eq!(gguf_runtime_of("{}"), None);
        assert_eq!(gguf_runtime_of("not json"), None);
        assert_eq!(gguf_runtime_of(r#"[{"model_format":"safetensors","name":"mlx","version":"1.0"}]"#), None);
    }
}

#[cfg(test)]
mod tests {
    /// Security pass of 2026-10-13: the server was started with a flag that
    /// lets any web page read it.
    #[test]
    fn the_server_start_does_not_open_lm_studio_to_every_web_page() {
        let args = super::lms_server_args();
        assert_eq!(args, ["server", "start", "--port", "1234"]);
        let flag = ["\"--", "cors\""].concat();
        for (name, source) in [
            ("lmstudio.rs", include_str!("lmstudio.rs")),
            ("lmstudio_install.rs", include_str!("lmstudio_install.rs")),
        ] {
            assert!(!source.contains(&flag), "{name} passes the open flag again");
        }
    }

    use super::lmstudio_chat_model_file;
    use super::{lms_limit, loaded_ids, LMS_LIMIT_CEILING, LMS_LOAD_LIMIT};
    use std::time::Duration;

    #[test]
    fn a_limit_is_the_callers_or_the_default_and_never_endless() {
        assert_eq!(lms_limit(None, LMS_LOAD_LIMIT), LMS_LOAD_LIMIT);
        assert_eq!(lms_limit(Some(0), LMS_LOAD_LIMIT), LMS_LOAD_LIMIT);
        assert_eq!(lms_limit(Some(1500), LMS_LOAD_LIMIT), Duration::from_millis(1500));
        assert_eq!(lms_limit(Some(u64::MAX), LMS_LOAD_LIMIT), LMS_LIMIT_CEILING);
    }

    mod is_lm_studio_running {
        use super::super::{is_lms_status, lmstudio_in_process_list, should_run_lms_unload};
        use std::path::Path;

        fn list<'a>(rows: &'a [(&'a str, Option<&'a str>)]) -> impl Iterator<Item = (&'a str, Option<&'a Path>)> + 'a {
            rows.iter().map(|(n, e)| (*n, e.map(Path::new)))
        }

        /// The processes of a closed LM Studio are none of these, and then
        /// the unload must not run (it would start the service).
        #[test]
        fn a_box_without_lm_studio_skips_the_unload() {
            let rows = [
                ("Locally Uncensored.exe", Some(r"C:\Program Files\Locally Uncensored\Locally Uncensored.exe")),
                ("lu-llama-server.exe", Some(r"C:\Program Files\Locally Uncensored\lu-llama-server.exe")),
                ("python.exe", Some(r"C:\ComfyUI\venv\Scripts\python.exe")),
                ("ollama.exe", Some(r"C:\Users\u\AppData\Local\Programs\Ollama\ollama.exe")),
                ("explorer.exe", None),
            ];
            assert!(!lmstudio_in_process_list(list(&rows)));
            assert!(!should_run_lms_unload(false, || lmstudio_in_process_list(list(&rows))));
        }

        /// The service LM Studio leaves running, by name alone.
        #[test]
        fn the_windows_service_counts() {
            let rows = [("explorer.exe", None), ("LM Studio.exe", None)];
            assert!(lmstudio_in_process_list(list(&rows)));
        }

        /// What this Mac shows with LM Studio 0.4.15 running as a service.
        #[test]
        fn the_mac_app_its_helpers_and_its_node_worker_count() {
            for row in [
                ("LM Studio", Some("/Applications/LM Studio.app/Contents/MacOS/LM Studio")),
                (
                    "LM Studio Helper (GPU)",
                    Some("/Applications/LM Studio.app/Contents/Frameworks/LM Studio Helper (GPU).app/Contents/MacOS/LM Studio Helper (GPU)"),
                ),
                ("node", Some("/Users/u/.lmstudio/.internal/utils/node")),
            ] {
                assert!(lmstudio_in_process_list(list(&[row])), "{row:?}");
            }
        }

        /// Spellings no box has shown yet, matched on purpose: too wide only
        /// costs an unload that wakes nothing new.
        #[test]
        fn an_appimage_and_llmster_count() {
            assert!(lmstudio_in_process_list(list(&[("lm-studio", Some("/tmp/.mount_LM-StuAbc/lm-studio"))])));
            assert!(lmstudio_in_process_list(list(&[("AppRun", Some("/home/u/Apps/LM_Studio-0.4.15.AppImage"))])));
            assert!(lmstudio_in_process_list(list(&[("llmster", Some("/home/u/.cache/lm-studio/llmster"))])));
        }

        /// A model file under ~/.lmstudio/models in LU's own engine is not LM
        /// Studio: only the name and the executable are read, never the argv.
        #[test]
        fn lus_engine_on_an_lm_studio_model_file_does_not_count() {
            let rows = [("lu-llama-server", Some("/Applications/LU.app/Contents/MacOS/lu-llama-server"))];
            assert!(!lmstudio_in_process_list(list(&rows)));
        }

        /// The daemon answering is enough, the process table is not even read.
        #[test]
        fn a_daemon_that_answers_runs_the_unload_without_the_table() {
            assert!(should_run_lms_unload(true, || panic!("the process table must not be read")));
            assert!(should_run_lms_unload(false, || true));
        }

        #[test]
        fn only_lm_studios_status_reply_counts() {
            assert!(is_lms_status(&serde_json::json!({ "package": "lmstudio", "version": "0.4.15+2" })));
            assert!(!is_lms_status(&serde_json::json!({ "package": "lmstudio" })));
            assert!(!is_lms_status(&serde_json::json!({ "status": "ok" })));
            assert!(!is_lms_status(&serde_json::json!(null)));
        }
    }

    #[test]
    fn only_models_in_state_loaded_count_as_loaded() {
        let body = serde_json::json!({ "data": [
            { "id": "a", "state": "loaded" },
            { "id": "b", "state": "not-loaded" },
            { "id": "c" },
        ]});
        assert_eq!(loaded_ids(&body), vec!["a".to_string()]);
        assert!(loaded_ids(&serde_json::json!({})).is_empty());
    }

    /// A stand-in for an `lms load` that never comes back.
    #[cfg(unix)]
    mod a_call_that_hangs {
        use super::super::{run_lms, LmsEnd};
        use std::process::Command;
        use std::time::{Duration, Instant};
        use tokio_util::sync::CancellationToken;

        fn sleeper() -> Command {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30"]);
            cmd
        }

        #[test]
        fn ends_at_its_limit() {
            let started = Instant::now();
            let end = run_lms(sleeper(), started + Duration::from_millis(300), &CancellationToken::new()).unwrap();
            assert!(matches!(end, LmsEnd::TimedOut), "{end:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        /// Ending the call means the process is gone, not that nobody waits
        /// for it any more: a load that keeps running would still arrive.
        #[test]
        fn ends_when_it_is_cancelled_and_the_process_is_gone() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(format!("echo $$ > '{}'; sleep 30", pid_file.display()));
            let cancel = CancellationToken::new();
            let later = cancel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                later.cancel();
            });
            let started = Instant::now();
            let end = run_lms(cmd, started + Duration::from_secs(30), &cancel).unwrap();
            assert!(matches!(end, LmsEnd::Cancelled), "{end:?}");
            assert!(started.elapsed() < Duration::from_secs(5));

            let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            // kill_tree reaps on a thread of its own after its grace.
            let gone_by = Instant::now() + Duration::from_secs(5);
            // Declared here: the libc crate is a dependency of the macOS build only.
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            while unsafe { kill(pid, 0) } == 0 {
                assert!(Instant::now() < gone_by, "the process {pid} outlived its cancel");
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        /// `lms load` cancels its load in LM Studio on an interrupt and
        /// drops it on a kill, so the interrupt has to arrive first.
        #[test]
        fn a_cancelled_call_is_interrupted_before_it_is_killed() {
            let dir = tempfile::tempdir().unwrap();
            let heard = dir.path().join("heard");
            let ready = dir.path().join("ready");
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(format!(
                "trap 'echo int > \"{}\"; exit 1' INT; echo up > \"{}\"; while :; do sleep 0.05; done",
                heard.display(),
                ready.display()
            ));
            let cancel = CancellationToken::new();
            let later = cancel.clone();
            let trap_set = ready.clone();
            std::thread::spawn(move || {
                let give_up = Instant::now() + Duration::from_secs(10);
                while !trap_set.exists() && Instant::now() < give_up {
                    std::thread::sleep(Duration::from_millis(20));
                }
                later.cancel();
            });
            let started = Instant::now();
            let end = run_lms(cmd, started + Duration::from_secs(30), &cancel).unwrap();
            assert!(matches!(end, LmsEnd::Cancelled), "{end:?}");
            assert!(started.elapsed() < Duration::from_secs(15));
            assert_eq!(std::fs::read_to_string(&heard).unwrap_or_default().trim(), "int");
        }

        #[test]
        fn a_cancel_that_came_first_starts_nothing_that_stays() {
            let cancel = CancellationToken::new();
            cancel.cancel();
            let started = Instant::now();
            let end = run_lms(sleeper(), started + Duration::from_secs(30), &cancel).unwrap();
            assert!(matches!(end, LmsEnd::Cancelled), "{end:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        /// `lms` starts LM Studio's service when it is not running, and that
        /// process keeps the pipes of the call that started it.
        #[test]
        fn a_process_left_behind_does_not_hold_the_finished_call() {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 20 & echo why >&2; exit 2"]);
            let started = Instant::now();
            let end = run_lms(cmd, started + Duration::from_secs(30), &CancellationToken::new()).unwrap();
            match end {
                LmsEnd::Exited { success, stderr, .. } => {
                    assert!(!success);
                    assert_eq!(stderr.trim(), "why");
                }
                other => panic!("{other:?}"),
            }
            assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        }

        #[test]
        fn hands_back_what_a_finished_call_wrote() {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "echo out; echo why >&2; exit 3"]);
            let end = run_lms(cmd, Instant::now() + Duration::from_secs(30), &CancellationToken::new()).unwrap();
            match end {
                LmsEnd::Exited { success, stdout, stderr } => {
                    assert!(!success);
                    assert_eq!(stdout.trim(), "out");
                    assert_eq!(stderr.trim(), "why");
                }
                other => panic!("{other:?}"),
            }
        }
    }

    /// The picker line says "N models on disk" and the list then shows N rows.
    /// Windows box, 05.10.2026: every GGUF was counted, the line said 8, the
    /// list showed 7.
    #[test]
    fn counts_what_the_chat_picker_lists() {
        let on_disk = [
            "lmstudio-community/qwen3-8b-gguf/qwen3-8b-q4_k_m.gguf",
            "lmstudio-community/gemma-3-12b-it-gguf/gemma-3-12b-it-q4_k_m.gguf",
            "lmstudio-community/gemma-3-12b-it-gguf/mmproj-model-f16.gguf",
            "nomic-ai/nomic-embed-text-v1.5-gguf/nomic-embed-text-v1.5.q4_k_m.gguf",
            "baai/bge-m3-gguf/bge-m3-q8_0.gguf",
            "bartowski/big-model-gguf/big-model-q4_k_m-00001-of-00003.gguf",
            "bartowski/big-model-gguf/big-model-q4_k_m-00002-of-00003.gguf",
            "bartowski/big-model-gguf/big-model-q4_k_m-00003-of-00003.gguf",
        ];
        let listed: Vec<&str> = on_disk.iter().copied().filter(|f| lmstudio_chat_model_file(f)).collect();
        assert_eq!(
            listed,
            [
                "lmstudio-community/qwen3-8b-gguf/qwen3-8b-q4_k_m.gguf",
                "lmstudio-community/gemma-3-12b-it-gguf/gemma-3-12b-it-q4_k_m.gguf",
                "bartowski/big-model-gguf/big-model-q4_k_m-00001-of-00003.gguf",
            ]
        );
    }

    #[test]
    fn a_windows_path_and_an_ordinary_name_with_of_in_it_count() {
        assert!(lmstudio_chat_model_file("publisher\\repo\\model-q4_k_m.gguf"));
        assert!(!lmstudio_chat_model_file("publisher\\repo\\mmproj-model-f16.gguf"));
        assert!(lmstudio_chat_model_file("publisher/repo/best-of-breed-7b.gguf"));
        assert!(lmstudio_chat_model_file("publisher/repo/tales-of-2024-q4.gguf"));
    }
}
