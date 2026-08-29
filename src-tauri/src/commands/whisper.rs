use crate::os_error;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use tracing::{error, info};

use crate::state::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct WhisperServer {
    process: Option<Child>,
    stdin_tx: Option<std::io::BufWriter<std::process::ChildStdin>>,
    response_rx: Option<mpsc::Receiver<serde_json::Value>>,
    pub ready: bool,
    pub backend: Option<String>,
}

/// Throw away replies still sitting in the channel from an earlier, abandoned
/// request. Returns how many were dropped (for the log — a non-zero count means
/// a previous transcription overran its timeout).
fn drain_stale(rx: &mpsc::Receiver<serde_json::Value>) -> usize {
    let mut n = 0;
    while rx.try_recv().is_ok() {
        n += 1;
    }
    n
}

/// Does this `send_command` failure mean the server is gone, rather than the
/// request being bad or merely slow?
///
/// Anchored on the prefixes `send_command` writes itself, never on the words
/// after them: those come from the operating system and are in whatever
/// language Windows was installed in, so matching on them would work on an
/// English box and quietly stop working on a German one.
///
/// "Whisper transcription timed out" is deliberately NOT in this list. A long
/// dictation is a living server doing its job, and restarting under it would
/// throw the take away for nothing.
pub fn is_pipe_failure(message: &str) -> bool {
    const GONE: &[&str] = &[
        "stdin write:",
        "stdin newline:",
        "stdin flush:",
        "No stdin connection",
        "No response channel",
    ];
    GONE.iter().any(|p| message.starts_with(p))
}

impl WhisperServer {
    pub fn new() -> Self {
        Self {
            process: None,
            stdin_tx: None,
            response_rx: None,
            ready: false,
            backend: None,
        }
    }

    pub fn start(&mut self, python_bin: &str, script_path: &str) -> Result<(), String> {
        if self.process.is_some() {
            return Ok(());
        }
        // A start that fails halfway must leave nothing behind: `process` is set
        // before the readiness wait, so an error after that point used to leave a
        // dead server registered. `needs_start` then saw process.is_some(), never
        // retried, and every later transcription answered "Whisper server not
        // ready" until the app was restarted.
        match self.start_inner(python_bin, script_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.stop();
                Err(e)
            }
        }
    }

    fn start_inner(&mut self, python_bin: &str, script_path: &str) -> Result<(), String> {

        println!("[Whisper] Starting persistent server: {} {}", python_bin, script_path);

        let mut cmd = Command::new(python_bin);
        cmd.arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to start whisper server: {}", os_error::english(&e)))?;
        // Long lived Python server: it must not outlive the app on a hard kill.
        crate::commands::process::tie_child_to_app_lifetime(child.id());

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        self.stdin_tx = Some(std::io::BufWriter::new(stdin));

        // Channel for passing responses from reader thread to callers
        let (tx, rx) = mpsc::channel();
        self.response_rx = Some(rx);

        // Stdout reader thread — parses JSON lines from whisper_server.py
        let tx_clone = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        let _ = tx_clone.send(json);
                    }
                }
            }
        });

        // Stderr reader thread — log Python output
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if !line.trim().is_empty() {
                        println!("[Whisper] {}", line.trim());
                    }
                }
            }
        });

        self.process = Some(child);

        // Wait for the "ready" signal (up to 5 minutes for model loading)
        if let Some(ref rx) = self.response_rx {
            match rx.recv_timeout(std::time::Duration::from_secs(300)) {
                Ok(msg) => {
                    if msg.get("status").and_then(|s| s.as_str()) == Some("ready") {
                        self.ready = true;
                        self.backend = msg.get("backend").and_then(|b| b.as_str()).map(|s| s.to_string());
                        println!("[Whisper] Server ready (backend: {})", self.backend.as_deref().unwrap_or("unknown"));
                    } else if msg.get("status").and_then(|s| s.as_str()) == Some("error") {
                        let err = msg.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                        return Err(format!("Whisper server error: {}", err));
                    }
                }
                Err(_) => {
                    return Err("Whisper server did not become ready within 5 minutes".to_string());
                }
            }
        }

        Ok(())
    }

    pub fn send_command(&mut self, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
        if !self.ready {
            return Err("Whisper server not ready".to_string());
        }

        // Discard anything already queued BEFORE sending. The protocol is
        // strictly one request, one response, and the channel carries no
        // correlation id — so a reply that arrived after its caller gave up
        // would be handed to the NEXT caller as if it were theirs. Concretely:
        // a long dictation trips the 60 s timeout and reports "timed out"; the
        // server finishes anyway and pushes that text into the channel; the
        // user records something new and gets the PREVIOUS recording's words
        // back — and every dictation after that stays one behind, until the
        // server is restarted. Any stray JSON line the server logs desyncs it
        // the same way.
        let stale = {
            let rx = self.response_rx.as_ref().ok_or("No response channel")?;
            drain_stale(rx)
        };
        if stale > 0 {
            println!("[Whisper] dropped {} stale response(s) before sending", stale);
        }

        let stdin = self.stdin_tx.as_mut().ok_or("No stdin connection")?;
        let json_str = serde_json::to_string(cmd).map_err(|e| e.to_string())?;

        // os_error::english, not the error's own Display. When the python
        // process dies the write fails with ERROR_NO_DATA, and Windows words
        // that failure in the language it was installed in: the box showed
        // "stdin flush: Die Pipe wird gerade geschlossen. (os error 232)" in
        // the red hint over the microphone, in an app set to English
        // (B4 Gegenprobe 29.08.). english() never asks the system for words.
        stdin
            .write_all(json_str.as_bytes())
            .map_err(|e| format!("stdin write: {}", os_error::english(&e)))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("stdin newline: {}", os_error::english(&e)))?;
        stdin
            .flush()
            .map_err(|e| format!("stdin flush: {}", os_error::english(&e)))?;

        // Wait for response (60s timeout for transcription)
        let rx = self.response_rx.as_ref().ok_or("No response channel")?;
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "Whisper transcription timed out".to_string())
    }

    /// Whether the whisper server child is currently running (model resident).
    pub fn is_running(&self) -> bool {
        self.process.is_some()
    }

    /// Has the child gone away?
    ///
    /// `try_wait` is the only honest answer. The `Child` value survives the
    /// process it describes, so `process.is_some()` keeps saying yes to a
    /// corpse, and that is exactly why a killed whisper server stayed
    /// registered: `needs_start` saw a process, skipped the start, and every
    /// take from then on wrote into a pipe nobody holds, until the app was
    /// restarted (B4 Gegenprobe 29.08.).
    ///
    /// Reaps as a side effect, which is the point: `try_wait` collects the
    /// exit status, so the dead python is not left as a zombie either.
    pub fn has_exited(&mut self) -> bool {
        match self.process.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                // We cannot ask about it any more, so it is not ours to use.
                Err(_) => true,
            },
            None => true,
        }
    }

    pub fn stop(&mut self) {
        if let Some(ref mut stdin) = self.stdin_tx {
            let _ = stdin.write_all(b"{\"action\":\"quit\"}\n");
            let _ = stdin.flush();
        }
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
            let _ = child.wait(); // reap, or the python server lingers as a zombie
        }
        self.process = None;
        self.stdin_tx = None;
        self.response_rx = None;
        self.ready = false;
        println!("[Whisper] Server stopped");
    }
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn whisper_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        whisper_status_blocking(&state)
    })
    .await
    .map_err(|e| format!("whisper_status task: {e}"))?
}

fn whisper_status_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let (running, ready, backend) = {
        let whisper = state.whisper.lock().unwrap();
        (whisper.process.is_some(), whisper.ready, whisper.backend.clone())
    };
    // Report INSTALLED-on-disk, not merely "server process running". The whisper
    // server lazy-starts on first mic use and is killed on quit, so keying the
    // badge on process.is_some() made STT read as uninstalled after every
    // relaunch — the "reinstall every launch" report (#78, ElBiggus). If the
    // server is up it's obviously installed; otherwise probe the resolved
    // interpreter for the faster_whisper package.
    let available = running || whisper_package_installed(state);
    Ok(serde_json::json!({
        "available": available,
        "backend": backend,
        "loading": running && !ready,
    }))
}

/// Is `faster_whisper` importable in the interpreter install_whisper targets
/// (resolve_lu_python: ComfyUI venv if present, else system Python)? Cheap
/// best-effort probe so the badge reflects a prior install across relaunches
/// without the server running. Any spawn/timeout failure → "not installed".
fn whisper_package_installed(state: &AppState) -> bool {
    let python = crate::commands::install::resolve_lu_python(state);
    if python.is_empty() {
        return false;
    }
    let mut cmd = Command::new(&python);
    // Probe INSTALLABILITY with importlib.find_spec, NOT a full
    // `import faster_whisper`. The real import pulls in ctranslate2 / onnxruntime
    // / av and takes ~8 s warm (longer with a cold OS file cache), which on the
    // first status check right after a cold relaunch blew past the cap below and
    // made STT read as "not installed" until the next check — the #78 symptom,
    // softened but not gone. find_spec answers "is the package present" in about
    // 100 ms with no heavy import, so the badge is right on the very first probe.
    cmd.args([
        "-c",
        "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('faster_whisper') else 1)",
    ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    // find_spec returns in well under a second; the cap is kept purely so a
    // wedged interpreter can never hang the status call.
    for _ in 0..100 {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return false,
        }
    }
    let _ = child.kill();
    false
}

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    audio_base64: String,
    content_type: String,
) -> Result<serde_json::Value, String> {
    // On the first dictation this starts the whisper server and waits for the
    // model — up to five minutes — and every transcription after that blocks for
    // up to 60 s. As a sync #[command] all of that froze the Tauri main thread,
    // so the window locked up for the whole take.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        transcribe_blocking(&app, audio_base64, content_type, &state)
    })
    .await
    .map_err(|e| format!("Transcription task failed to run: {e}"))?
}

fn transcribe_blocking(
    app: &AppHandle,
    audio_base64: String,
    content_type: String,
    state: &State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    if audio_bytes.is_empty() {
        return Err("Empty audio data".to_string());
    }

    // Determine file extension
    let ext = if content_type.contains("wav") { ".wav" }
        else if content_type.contains("mp3") || content_type.contains("mpeg") { ".mp3" }
        else if content_type.contains("ogg") { ".ogg" }
        else if content_type.contains("mp4") || content_type.contains("m4a") { ".m4a" }
        else { ".webm" };

    // Write to temp file
    let tmp_dir = std::env::temp_dir();
    let tmp_file = tmp_dir.join(format!("whisper-{}{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0), ext));

    std::fs::write(&tmp_file, &audio_bytes)
        .map_err(|e| format!("Write temp file: {}", os_error::english(&e)))?;

    let audio_path = tmp_file.to_string_lossy().replace('\\', "/");
    println!("[Whisper] Transcribing: {} ({:.1} KB)", audio_path, audio_bytes.len() as f64 / 1024.0);

    // Lazy-start Whisper on first use — it is no longer pre-started at launch
    // (it kept ~360 MB resident even in Cloud mode). Block until the server is
    // spawned; send_command below then waits for the model to finish loading.
    //
    // Self-healing, first half: this also reaps a server that died since the
    // last take, so what follows is a real start and not a send into a closed
    // pipe.
    ensure_whisper_running(app, state)?;

    let cmd = serde_json::json!({
        "action": "transcribe",
        "path": audio_path,
    });

    // Send to persistent whisper server
    let mut result = send_to_whisper(state, &cmd);

    // Self-healing, second half: the server died DURING this take, so the send
    // found a pipe nobody holds any more. Start it again and send the same
    // audio once more; the user only hears about it if that fails too. Before
    // this, the first failure was permanent: every later recording hit the
    // same dead pipe until the app was restarted (B4 Gegenprobe 29.08.).
    if let Err(ref why) = result {
        if whisper_is_gone(state, why) {
            println!("[Whisper] server gone ({}), restarting once and retrying the take", why);
            info!("whisper restart after a dead pipe");
            result = match restart_whisper(app, state) {
                Ok(()) => send_to_whisper(state, &cmd),
                Err(e) => Err(e),
            };
        }
    }

    // Clean up temp file, after the retry, which reads the same file.
    let _ = std::fs::remove_file(&tmp_file);

    match result {
        Ok(response) => {
            if let Some(transcript) = response.get("transcript").and_then(|t| t.as_str()) {
                println!("[Whisper] Transcribed: \"{}\" (lang: {})",
                    transcript.chars().take(80).collect::<String>(),
                    response.get("language").and_then(|l| l.as_str()).unwrap_or("?"));
                info!("transcribe ok");
            }
            Ok(response)
        }
        Err(e) => {
            error!(error = %e, "transcribe failed");
            Err(e)
        }
    }
}

/// One transcribe request to the running server, with the lock held for no
/// longer than the send.
fn send_to_whisper(
    state: &State<'_, AppState>,
    cmd: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut whisper = state.whisper.lock().unwrap();
    whisper.send_command(cmd)
}

/// Clear a whisper child that has exited, then start one if none is running.
///
/// The clearing is the new half. `stop()` resets `process`, `stdin_tx`,
/// `response_rx` and `ready` together, so what starts afterwards is a whole
/// server and not a fresh process wired to the dead one's channels.
fn ensure_whisper_running(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let needs_start = match state.whisper.lock() {
        Ok(mut w) => {
            if w.is_running() && w.has_exited() {
                println!("[Whisper] the server process is gone, clearing it before this take");
                w.stop();
            }
            !w.is_running()
        }
        Err(_) => true,
    };
    if !needs_start {
        return Ok(());
    }
    // Resolve the SAME interpreter install_whisper used (ComfyUI venv if
    // present, else system Python). Using state.python_bin here meant a
    // venv install was invisible at runtime → STT silently dead after
    // relaunch on boxes with a ComfyUI venv (#78).
    let python_bin = crate::commands::install::resolve_lu_python(state.inner());
    if python_bin.is_empty() {
        return Err("Whisper unavailable: no Python runtime detected. Install Python in the setup step, then retry.".to_string());
    }
    auto_start_whisper_sync(app, &python_bin, &state.whisper)
}

/// Tear the server down and bring it back up, once.
fn restart_whisper(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut w) = state.whisper.lock() {
        w.stop();
    }
    ensure_whisper_running(app, state)
}

/// Is this failure worth a restart?
///
/// Two independent answers, either of which is enough: the message says the
/// pipe is gone, or the child has actually exited. The second catches a server
/// that died without the write noticing yet, and the first catches a pipe that
/// closed under a process still technically alive.
fn whisper_is_gone(state: &State<'_, AppState>, why: &str) -> bool {
    if is_pipe_failure(why) {
        return true;
    }
    match state.whisper.lock() {
        Ok(mut w) => w.has_exited(),
        // A poisoned lock is not evidence of a dead server, and restarting on
        // it would hide a panic behind a retry loop.
        Err(_) => false,
    }
}

/// Synchronous whisper startup (runs in background thread).
///
/// Returns WHY it could not start. Every failure used to end in a `println!`,
/// so the four distinct causes — faster-whisper missing, whisper_server.py
/// missing, the server dying, the model never loading — all reached the user
/// as the same "Whisper server not ready" from send_command, which says nothing
/// about what to do next.
pub fn auto_start_whisper_sync(
    app: &tauri::AppHandle,
    python_bin: &str,
    whisper: &Arc<Mutex<WhisperServer>>,
) -> Result<(), String> {
    // Check if faster-whisper is installed
    let mut cmd = Command::new(python_bin);
    cmd.args(["-c", "import faster_whisper"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let check = cmd.output();

    match check {
        Ok(output) if output.status.success() => {
            println!("[Whisper] faster-whisper found, starting persistent server...");
        }
        _ => {
            println!("[Whisper] faster-whisper not installed — STT disabled");
            return Err(
                "Speech-to-text needs faster-whisper, which is not installed. \
                 Install it from Settings → Voice, then try again."
                    .to_string(),
            );
        }
    }

    // Resolve whisper_server.py path from bundled resources
    let script_path: Option<PathBuf> = app.path()
        .resource_dir()
        .ok()
        .map(|d: PathBuf| d.join("resources").join("whisper_server.py"))
        .filter(|p: &PathBuf| p.exists())
        .or_else(|| {
            let dev_path = PathBuf::from("public").join("whisper_server.py");
            if dev_path.exists() { Some(dev_path) } else { None }
        });

    match script_path {
        Some(path) => {
            let path_str: String = path.to_string_lossy().to_string();
            let mut ws = whisper.lock().unwrap();
            if let Err(e) = ws.start(python_bin, &path_str) {
                println!("[Whisper] Failed to start: {}", e);
                return Err(format!("Speech-to-text could not start: {}", e));
            }
            Ok(())
        }
        None => {
            println!("[Whisper] whisper_server.py not found");
            Err("Speech-to-text is missing its server script (whisper_server.py). \
                 Reinstall LU to restore it."
                .to_string())
        }
    }
}

#[cfg(test)]
mod response_channel_tests {
    use super::*;
    use serde_json::json;

    /// The exact sequence a user hits: a long dictation overruns the 60 s
    /// timeout, the server finishes anyway and pushes its text into the shared
    /// channel, and the NEXT dictation would read that as its own answer.
    #[test]
    fn a_reply_that_arrived_too_late_is_not_handed_to_the_next_caller() {
        let (tx, rx) = mpsc::channel::<serde_json::Value>();

        // Dictation A times out; its reply lands afterwards.
        tx.send(json!({ "text": "the FIRST recording" })).unwrap();

        // Dictation B starts: everything queued is by definition not ours.
        assert_eq!(drain_stale(&rx), 1);

        // Now B's own reply arrives and is the one that gets read.
        tx.send(json!({ "text": "the SECOND recording" })).unwrap();
        let got = rx.recv_timeout(std::time::Duration::from_millis(200)).unwrap();
        assert_eq!(got["text"], "the SECOND recording");
    }

    /// More than one abandoned call, plus any stray JSON the server logs.
    #[test]
    fn several_stale_messages_are_all_dropped() {
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        tx.send(json!({ "text": "old one" })).unwrap();
        tx.send(json!({ "progress": 0.5 })).unwrap();
        tx.send(json!({ "text": "old two" })).unwrap();

        assert_eq!(drain_stale(&rx), 3);
        assert!(rx.try_recv().is_err(), "channel should be empty");
    }

    #[test]
    fn an_empty_channel_costs_nothing_and_drops_nothing() {
        let (_tx, rx) = mpsc::channel::<serde_json::Value>();
        assert_eq!(drain_stale(&rx), 0);
    }

    /// Draining must not block when the sender is still alive and idle.
    #[test]
    fn draining_does_not_wait_for_a_live_sender() {
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        let started = std::time::Instant::now();
        assert_eq!(drain_stale(&rx), 0);
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
        drop(tx);
    }
}

/// B4 Gegenprobe, 29.08.: the whisper server was killed mid-session on the
/// Windows box. Two things went wrong and both are covered here.
///
///  1. The failure reached the red hint over the microphone in German:
///     "stdin flush: Die Pipe wird gerade geschlossen. (os error 232)".
///  2. Nothing healed. Every recording after that hit the same dead pipe until
///     the app was restarted.
#[cfg(test)]
mod dead_server_tests {
    use super::*;
    use serde_json::json;

    /// A child that is gone almost at once.
    fn spawn_quick() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().expect("a shell exists on the machine running the tests")
    }

    /// A child that sits and waits on stdin, the way whisper_server.py does.
    fn spawn_lingering() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "pause"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "read line"]);
            c
        };
        cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().expect("a shell exists on the machine running the tests")
    }

    /// A server wired to `child`, in the state it has between two dictations.
    ///
    /// The sender comes back with it and has to be kept alive by the caller:
    /// dropping it would disconnect the response channel, and a disconnected
    /// channel is a different failure than the one under test.
    fn server_around(child: Child) -> (WhisperServer, mpsc::Sender<serde_json::Value>) {
        let mut ws = WhisperServer::new();
        let mut child = child;
        if let Some(stdin) = child.stdin.take() {
            ws.stdin_tx = Some(std::io::BufWriter::new(stdin));
        }
        let (tx, rx) = mpsc::channel();
        ws.response_rx = Some(rx);
        ws.ready = true;
        ws.process = Some(child);
        (ws, tx)
    }

    #[test]
    fn a_live_server_does_not_read_as_gone() {
        let (mut ws, _tx) = server_around(spawn_lingering());
        assert!(ws.is_running());
        assert!(!ws.has_exited(), "a waiting server was declared dead");
        ws.stop();
    }

    #[test]
    fn a_dead_server_is_seen_even_though_the_child_value_is_still_there() {
        let (mut ws, _tx) = server_around(spawn_quick());
        // The exact trap: the Child outlives the process, so this keeps
        // answering yes and `needs_start` kept skipping the restart.
        assert!(ws.is_running(), "the handle is still registered, as it was");
        let mut saw_it = false;
        for _ in 0..100 {
            if ws.has_exited() {
                saw_it = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(saw_it, "the exited child was never noticed");
        ws.stop();
    }

    #[test]
    fn a_server_that_was_never_started_counts_as_gone() {
        let mut ws = WhisperServer::new();
        assert!(!ws.is_running());
        assert!(ws.has_exited());
    }

    /// The whole failure, at the wire: kill the server the way the box did,
    /// then send a take into it.
    #[test]
    fn sending_into_a_killed_server_fails_in_english_and_is_recognised_as_a_dead_pipe() {
        let (mut ws, _tx) = server_around(spawn_lingering());
        if let Some(child) = ws.process.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(ws.has_exited());

        let err = ws
            .send_command(&json!({ "action": "transcribe", "path": "/tmp/x.wav" }))
            .expect_err("writing into a dead pipe must fail");

        // The message is ours all the way through. The operating system's own
        // sentence for this is German on a German Windows; none of these
        // assertions care which language it was, because none of it survives.
        // Printed so a `cargo test -- --nocapture` run shows the exact wording
        // that replaced the German line, on whatever machine ran the suite.
        println!("[dead pipe] {}", err);
        assert!(is_pipe_failure(&err), "not recognised as a dead pipe: {}", err);
        assert!(err.contains("os error"), "the searchable number is gone: {}", err);
        assert!(err.is_ascii(), "non ascii in a message we wrote: {}", err);
        // And it is one of our three prefixes, so the retry above can key on it.
        assert!(
            err.starts_with("stdin write:")
                || err.starts_with("stdin newline:")
                || err.starts_with("stdin flush:"),
            "unexpected shape: {}",
            err
        );
        ws.stop();
    }

    #[test]
    fn every_way_the_pipe_can_be_gone_asks_for_a_restart() {
        for m in [
            "stdin write: the pipe is closing (os error 232)",
            "stdin newline: broken pipe (os error 32)",
            "stdin flush: the pipe is closing (os error 232)",
            "No stdin connection",
            "No response channel",
        ] {
            assert!(is_pipe_failure(m), "should restart on: {}", m);
        }
    }

    /// NEGATIVE CONTROL. Restarting on any of these would make things worse:
    /// a long dictation would lose its take, and a model still loading would be
    /// thrown away and reloaded for another five minutes.
    #[test]
    fn a_slow_or_busy_server_is_left_alone() {
        for m in [
            "Whisper transcription timed out",
            "Whisper server not ready",
            "Whisper server error: Model load failed: out of memory",
            "Empty audio data",
            "base64 decode: invalid byte",
            "Whisper server did not become ready within 5 minutes",
        ] {
            assert!(!is_pipe_failure(m), "must not restart on: {}", m);
        }
    }

    /// NEGATIVE CONTROL for the language rule: the German sentence the box
    /// showed must not be what the check keys on, or the fix works only where
    /// the bug never appeared.
    #[test]
    fn the_check_does_not_depend_on_the_systems_own_words() {
        let german = "stdin flush: Die Pipe wird gerade geschlossen. (os error 232)";
        let english = "stdin flush: the pipe is closing (os error 232)";
        assert!(is_pipe_failure(german));
        assert!(is_pipe_failure(english));
        // Same prefix, so the same verdict either way.
        assert!(!is_pipe_failure("Die Pipe wird gerade geschlossen. (os error 232)"));
    }
}

/// The wiring the unit tests above cannot reach: `transcribe_blocking` needs a
/// Tauri AppHandle and a live AppState, so the ORDER of the healing is guarded
/// at the source, in the style of the drift guard in os_error.rs.
#[cfg(test)]
mod healing_is_wired_in {
    /// The SHIPPING half of this file, with every `#[cfg(test)]` module cut
    /// off. Without the cut the guard reads its own assertions and passes on
    /// the strength of the strings it was written with.
    fn source() -> String {
        let all = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/whisper.rs"),
        )
        .expect("this file is readable");
        match all.find("#[cfg(test)]") {
            Some(at) => all[..at].to_string(),
            None => all,
        }
    }

    #[test]
    fn the_guard_reads_only_the_shipping_code() {
        let s = source();
        assert!(s.contains("fn transcribe_blocking"), "the cut took too much");
        assert!(!s.contains("mod healing_is_wired_in"), "the guard is reading itself");
    }

    #[test]
    fn a_take_starts_by_clearing_a_dead_server() {
        let s = source();
        assert!(s.contains("ensure_whisper_running(app, state)?;"), "the pre-take check is gone");
        // The old shape, which asked only whether a handle existed.
        assert!(
            !s.contains("let needs_start = state.whisper.lock().map(|w| w.process.is_none())"),
            "the corpse-blind check is back"
        );
    }

    #[test]
    fn a_take_that_hits_a_dead_pipe_is_retried_once() {
        let s = source();
        assert!(s.contains("if whisper_is_gone(state, why)"), "the retry gate is gone");
        assert!(s.contains("Ok(()) => send_to_whisper(state, &cmd),"), "the retry send is gone");
        // Once, not in a loop: a second failure is the user's answer.
        assert_eq!(s.matches("restart_whisper(app, state)").count(), 1);
    }

    #[test]
    fn the_temp_file_outlives_the_retry() {
        let s = source();
        let send = s.find("let mut result = send_to_whisper").expect("the send is gone");
        let retry = s.find("if whisper_is_gone(state, why)").expect("the retry is gone");
        let cleanup = s.find("let _ = std::fs::remove_file(&tmp_file);").expect("the cleanup is gone");
        assert!(send < retry, "the retry must come after the first send");
        assert!(retry < cleanup, "the audio was deleted before the retry could read it");
    }
}
