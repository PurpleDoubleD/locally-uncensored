//! Parakeet dictation (GitHub #233): NVIDIA Parakeet TDT 0.6B v3 as a second
//! speech-to-text engine next to faster-whisper.
//!
//! It runs on NVIDIA's own runtime, NeMo-Speech.cpp, a native program without
//! Python. LU fetches the release archive for this machine and the model file
//! once, keeps each only when size and sha256 match the pins in
//! `parakeet/manifest.json`, and starts `nemo-speech serve` on 127.0.0.1 the
//! first time a take is transcribed. The server listens on a free port and
//! answers only with a key made for that run, so no other program on the
//! machine can use it. A take goes to its OpenAI-compatible
//! `/v1/audio/transcriptions` as the WAV the recorder writes.
//!
//! Everything lives below `data_dir()/parakeet`:
//!   runtime/<release dir>/bin/nemo-speech[.exe]   the unpacked release
//!   models/parakeet-tdt-0.6b-v3.q8_0.gguf          the model
//!   installed.json                                 what was verified
//! A file under its real name is always a verified one: downloads go to a
//! `.download` twin first (`voice_loop::fetch`).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::commands::voice_loop::fetch::{fetch_verified, http_client, FetchError};
use crate::commands::voice_loop::manifest::RemoteFile;
use crate::os_error;

const MANIFEST_TEXT: &str = include_str!("parakeet/manifest.json");
const SUPPORTED_SCHEMA: u32 = 1;
/// The model loads in about a second; the first start on a Mac also compiles
/// the Metal shaders once (16 to 20 s on an M-series Mac). That start happens
/// at the end of the install, see `parakeet_install`.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);

// ── manifest ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct Build {
    pub target: String,
    /// The single top-level directory of the archive.
    pub dir: String,
    #[serde(flatten)]
    pub remote: RemoteFile,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Runtime {
    pub name: String,
    pub version: String,
    pub license: String,
    pub source: String,
    pub builds: Vec<Build>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub license: String,
    pub attribution: String,
    pub source: String,
    pub revision: String,
    pub file: String,
    #[serde(flatten)]
    pub remote: RemoteFile,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Manifest {
    schema: u32,
    pub runtime: Runtime,
    pub model: Model,
}

fn is_hex_digest(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A name that stays one plain path component on every system.
fn is_plain_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let m: Manifest = serde_json::from_str(text).map_err(|e| format!("The Parakeet manifest could not be read: {e}."))?;
        if m.schema != SUPPORTED_SCHEMA {
            return Err(format!("The Parakeet manifest has schema {}, this LU reads {SUPPORTED_SCHEMA}.", m.schema));
        }
        let remotes = m.runtime.builds.iter().map(|b| (&b.remote, b.dir.as_str())).chain(std::iter::once((&m.model.remote, m.model.file.as_str())));
        for (remote, name) in remotes {
            if !remote.url.starts_with("https://") || remote.size == 0 || !is_hex_digest(&remote.sha256) || !is_plain_name(name) {
                return Err(format!("The Parakeet manifest has an entry it cannot use: {name}."));
            }
        }
        if !m.runtime.source.starts_with("https://") || !m.model.source.starts_with("https://") {
            return Err("The Parakeet manifest names a source that is not https.".to_string());
        }
        if m.model.revision.len() != 40 || !m.model.remote.url.contains(&format!("/resolve/{}/", m.model.revision)) {
            return Err("The Parakeet model is not fetched by its pinned revision.".to_string());
        }
        Ok(m)
    }

    /// "NeMo-Speech.cpp 0.3.0", for the log and the settings.
    pub fn runtime_label(&self) -> String {
        format!("{} {}", self.runtime.name, self.runtime.version)
    }

    pub fn build_for(&self, target: &str) -> Option<&Build> {
        self.runtime.builds.iter().find(|b| b.target == target)
    }
}

pub fn manifest() -> &'static Manifest {
    static M: OnceLock<Manifest> = OnceLock::new();
    M.get_or_init(|| Manifest::parse(MANIFEST_TEXT).expect("the bundled Parakeet manifest is checked by a test"))
}

/// The release target of this machine, or the sentence that says why
/// Parakeet cannot run here.
pub fn target_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("windows", _) | ("linux", _) => Err(format!(
            "Parakeet needs a 64-bit Intel or AMD processor on this system. This machine reports {arch}."
        )),
        _ => Err("Parakeet is not available on this system.".to_string()),
    }
}

fn this_target() -> Result<&'static str, String> {
    target_for(std::env::consts::OS, std::env::consts::ARCH)
}

// ── layout ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Dirs {
    pub root: PathBuf,
}

impl Dirs {
    pub fn current() -> Self {
        Self { root: crate::os_paths::data_dir().join("parakeet") }
    }
    pub fn runtime(&self) -> PathBuf {
        self.root.join("runtime")
    }
    pub fn release(&self, build: &Build) -> PathBuf {
        self.runtime().join(&build.dir)
    }
    pub fn exe(&self, build: &Build, windows: bool) -> PathBuf {
        self.release(build).join("bin").join(if windows { "nemo-speech.exe" } else { "nemo-speech" })
    }
    pub fn archive(&self, build: &Build) -> PathBuf {
        let ext = if build.remote.url.ends_with(".zip") { "zip" } else { "tar.gz" };
        self.root.join("downloads").join(format!("{}.{ext}", build.dir))
    }
    pub fn model(&self, model: &Model) -> PathBuf {
        self.root.join("models").join(&model.file)
    }
    pub fn marker(&self) -> PathBuf {
        self.root.join("installed.json")
    }
}

/// What a finished install verified. Read on every status, so it stays small:
/// hashing the 714 MB model on each look would cost seconds.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Marker {
    pub runtime_sha256: String,
    pub model_sha256: String,
}

impl Marker {
    fn load(dirs: &Dirs) -> Marker {
        std::fs::read_to_string(dirs.marker()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    fn save(&self, dirs: &Dirs) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(dirs.marker(), text).map_err(|e| format!("The Parakeet install record could not be written: {}.", os_error::io_english(&e)))
    }
}

/// Is the pinned runtime and model in place for `build`? The marker says both
/// were verified; the sizes catch a file that was replaced or cut since.
pub fn is_installed(dirs: &Dirs, m: &Manifest, build: &Build, windows: bool) -> bool {
    let marker = Marker::load(dirs);
    let model_ok = std::fs::metadata(dirs.model(&m.model)).map(|md| md.is_file() && md.len() == m.model.remote.size).unwrap_or(false);
    marker.runtime_sha256 == build.remote.sha256
        && marker.model_sha256 == m.model.remote.sha256
        && model_ok
        && dirs.exe(build, windows).is_file()
}

// ── unpacking ───────────────────────────────────────────────────────────────

/// Unpack a release archive into `into`. Both readers refuse entries that
/// would land outside it.
pub fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let fail = |e: &dyn std::fmt::Display| format!("The Parakeet runtime could not be unpacked: {e}.");
    std::fs::create_dir_all(into).map_err(|e| fail(&os_error::io_english(&e)))?;
    let file = std::fs::File::open(archive).map_err(|e| fail(&os_error::io_english(&e)))?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| fail(&e))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| fail(&e))?;
            let Some(rel) = entry.enclosed_name() else {
                return Err(fail(&"an entry points outside the folder"));
            };
            let out = into.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| fail(&os_error::io_english(&e)))?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| fail(&os_error::io_english(&e)))?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| fail(&os_error::io_english(&e)))?;
            std::io::copy(&mut entry, &mut w).map_err(|e| fail(&os_error::io_english(&e)))?;
        }
        Ok(())
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(std::io::BufReader::new(file)));
        tar.set_overwrite(true);
        tar.unpack(into).map_err(|e| fail(&os_error::io_english(&e)))
    }
}

fn remove_tree(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {}.", path.display(), os_error::io_english(&e))),
    }
}

// ── install job ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Default, Debug)]
pub struct JobView {
    pub running: bool,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Default)]
struct Job {
    view: Mutex<JobView>,
    cancel: AtomicBool,
}

fn job() -> &'static Job {
    static J: OnceLock<Job> = OnceLock::new();
    J.get_or_init(Job::default)
}

async fn install_into(dirs: &Dirs, m: &Manifest, build: &Build, windows: bool) -> Result<(), String> {
    let j = job();
    let client = http_client()?;
    let runtime_bytes = build.remote.size;
    let total = runtime_bytes + m.model.remote.size;
    j.view.lock().unwrap().total_bytes = total;
    let what = |e: FetchError, name: &str| if e == FetchError::Cancelled { "cancelled".to_string() } else { e.user_message(name) };

    if !dirs.exe(build, windows).is_file() || Marker::load(dirs).runtime_sha256 != build.remote.sha256 {
        let archive = dirs.archive(build);
        let mut progress = |n: u64| j.view.lock().unwrap().done_bytes = n.min(runtime_bytes);
        fetch_verified(&client, &build.remote, &archive, &j.cancel, &mut progress)
            .await
            .map_err(|e| what(e, "the Parakeet runtime"))?;
        // Unpack beside the final place, then move: a half unpacked release
        // is never under the name the server is started from.
        let staging = dirs.runtime().join(".unpacking");
        remove_tree(&staging)?;
        unpack(&archive, &staging)?;
        let unpacked = staging.join(&build.dir);
        if !unpacked.is_dir() {
            return Err("The Parakeet runtime archive did not hold the expected folder.".to_string());
        }
        remove_tree(&dirs.release(build))?;
        std::fs::rename(&unpacked, dirs.release(build))
            .map_err(|e| format!("The Parakeet runtime could not be moved into place: {}.", os_error::io_english(&e)))?;
        remove_tree(&staging)?;
        let _ = std::fs::remove_file(&archive);
        let mut marker = Marker::load(dirs);
        marker.runtime_sha256 = build.remote.sha256.clone();
        std::fs::create_dir_all(&dirs.root).map_err(|e| os_error::io_english(&e))?;
        marker.save(dirs)?;
    }
    j.view.lock().unwrap().done_bytes = runtime_bytes;

    let mut progress = |n: u64| j.view.lock().unwrap().done_bytes = runtime_bytes + n;
    fetch_verified(&client, &m.model.remote, &dirs.model(&m.model), &j.cancel, &mut progress)
        .await
        .map_err(|e| what(e, "the Parakeet model"))?;
    let mut marker = Marker::load(dirs);
    marker.runtime_sha256 = build.remote.sha256.clone();
    marker.model_sha256 = m.model.remote.sha256.clone();
    marker.save(dirs)?;
    j.view.lock().unwrap().done_bytes = total;
    Ok(())
}

// ── server ──────────────────────────────────────────────────────────────────

struct Running {
    child: Child,
    port: u16,
    key: String,
}

fn server() -> &'static Mutex<Option<Running>> {
    static S: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// One start at a time: two takes in quick succession must not start two
/// servers.
fn start_gate() -> &'static tokio::sync::Mutex<()> {
    static G: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    G.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The arguments `nemo-speech serve` is started with. Loopback only, no
/// browser playground, and a key on every request.
pub fn serve_args(model: &Path, port: u16, key: &str) -> Vec<String> {
    vec![
        "serve".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--no-ui".into(),
        "--api-key".into(),
        key.into(),
        "--asr-model".into(),
        model.to_string_lossy().into_owned(),
    ]
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("No free local port for Parakeet: {}.", os_error::io_english(&e)))?;
    l.local_addr().map(|a| a.port()).map_err(|e| os_error::io_english(&e))
}

/// The address and key of a running server, if there is one that is alive.
fn live() -> Option<(u16, String)> {
    let mut slot = server().lock().unwrap();
    let alive = match slot.as_mut() {
        Some(r) => matches!(r.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        if let Some(mut r) = slot.take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
        return None;
    }
    slot.as_ref().map(|r| (r.port, r.key.clone()))
}

fn spawn(exe: &Path, model: &Path) -> Result<(u16, String), String> {
    let port = free_port()?;
    let key = uuid::Uuid::new_v4().simple().to_string();
    let mut cmd = Command::new(exe);
    cmd.args(serve_args(model, port, &key))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bin) = exe.parent() {
        cmd.current_dir(bin);
    }
    crate::process_util::suppress_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Parakeet could not be started: {}.", os_error::english(&e)))?;
    crate::commands::process::tie_child_to_app_lifetime(child.id());
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    tracing::info!(target: "parakeet", "{}", line.trim());
                }
            }
        });
    }
    *server().lock().unwrap() = Some(Running { child, port, key: key.clone() });
    Ok((port, key))
}

async fn wait_ready(port: u16, key: &str) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).no_proxy().build().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/ready");
    let start = Instant::now();
    while start.elapsed() < READY_TIMEOUT {
        if live().is_none() {
            return Err("Parakeet stopped while it was loading the model. The app log has its last lines.".to_string());
        }
        if let Ok(r) = client.get(&url).bearer_auth(key).send().await {
            if let Ok(v) = r.json::<serde_json::Value>().await {
                if v.get("ready").and_then(|b| b.as_bool()) == Some(true) {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    stop();
    Err("Parakeet did not finish loading the model in time.".to_string())
}

async fn ensure_running() -> Result<(u16, String), String> {
    let _gate = start_gate().lock().await;
    if let Some(found) = live() {
        return Ok(found);
    }
    let m = manifest();
    let target = this_target()?;
    let build = m.build_for(target).ok_or_else(|| "Parakeet is not available on this system.".to_string())?;
    let dirs = Dirs::current();
    let windows = cfg!(windows);
    if !is_installed(&dirs, m, build, windows) {
        return Err("Parakeet is not installed. Get it in Settings, Voice.".to_string());
    }
    let started = Instant::now();
    let (port, key) = spawn(&dirs.exe(build, windows), &dirs.model(&m.model))?;
    wait_ready(port, &key).await?;
    tracing::info!(target: "parakeet", "server ready on port {port} after {} ms", started.elapsed().as_millis());
    Ok((port, key))
}

/// Stop the server, if one runs. Called on quit and when dictation leaves
/// Parakeet, so the model does not stay in memory for nothing.
pub fn stop() {
    if let Ok(mut slot) = server().lock() {
        if let Some(mut r) = slot.take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

async fn post_take(port: u16, key: &str, audio: Vec<u8>) -> Result<reqwest::Response, reqwest::Error> {
    let part = reqwest::multipart::Part::bytes(audio).file_name("take.wav").mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new().part("file", part).text("response_format", "json");
    reqwest::Client::builder()
        .timeout(TRANSCRIBE_TIMEOUT)
        .no_proxy()
        .build()?
        .post(format!("http://127.0.0.1:{port}/v1/audio/transcriptions"))
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
}

// ── commands ────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct Status {
    pub supported: bool,
    /// Why not, when `supported` is false.
    pub reason: Option<String>,
    pub installed: bool,
    pub running: bool,
    pub download_bytes: u64,
    pub model: String,
    pub license: String,
    pub attribution: String,
    pub runtime: String,
    pub runtime_license: String,
    pub job: JobView,
}

#[tauri::command]
pub fn parakeet_status() -> Status {
    let m = manifest();
    let job = job().view.lock().unwrap().clone();
    let running = live().is_some();
    let base = |supported, reason, installed, download_bytes| Status {
        supported,
        reason,
        installed,
        running,
        download_bytes,
        model: m.model.name.clone(),
        license: m.model.license.clone(),
        attribution: m.model.attribution.clone(),
        runtime: m.runtime_label(),
        runtime_license: m.runtime.license.clone(),
        job: job.clone(),
    };
    match this_target().and_then(|t| m.build_for(t).ok_or_else(|| "Parakeet is not available on this system.".to_string())) {
        Err(reason) => base(false, Some(reason), false, 0),
        Ok(build) => {
            let installed = is_installed(&Dirs::current(), m, build, cfg!(windows));
            base(true, None, installed, build.remote.size + m.model.remote.size)
        }
    }
}

#[tauri::command]
pub fn parakeet_install() -> Result<(), String> {
    let m = manifest();
    let build = m.build_for(this_target()?).ok_or_else(|| "Parakeet is not available on this system.".to_string())?.clone();
    {
        let mut v = job().view.lock().unwrap();
        if v.running {
            return Ok(());
        }
        *v = JobView { running: true, ..JobView::default() };
    }
    job().cancel.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let dirs = Dirs::current();
        let mut result = install_into(&dirs, manifest(), &build, cfg!(windows)).await;
        // Start it once before saying it is ready. That proves the runtime
        // runs on this machine, and on a Mac it compiles the Metal shaders
        // (about 20 s, once per install) here, under the download's spinner,
        // instead of in the user's first dictation. Stopped again after, so
        // the model only takes memory when dictation uses it.
        if result.is_ok() {
            let started = Instant::now();
            result = match ensure_running().await {
                Ok(_) => {
                    tracing::info!(target: "parakeet", "first start after install took {} ms", started.elapsed().as_millis());
                    Ok(())
                }
                Err(e) => {
                    // Not ready means not installed: the microphone stays
                    // closed and the Download button comes back. The files
                    // stay, so another try only checks them again.
                    let _ = std::fs::remove_file(dirs.marker());
                    Err(format!("Parakeet was downloaded but does not start on this computer: {e}"))
                }
            };
            stop();
        }
        match &result {
            Ok(()) => tracing::info!(target: "parakeet", "installed {} ({}) and {} at {}", manifest().runtime_label(), build.dir, manifest().model.id, manifest().model.revision),
            Err(e) => tracing::warn!(target: "parakeet", "install stopped: {e}"),
        }
        let mut v = job().view.lock().unwrap();
        v.running = false;
        v.error = result.err().filter(|e| e != "cancelled");
    });
    Ok(())
}

#[tauri::command]
pub fn parakeet_cancel() {
    job().cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn parakeet_stop() {
    stop();
}

/// One dictation take, a WAV as base64, to text.
#[tauri::command]
pub async fn parakeet_transcribe(audio_base64: String) -> Result<serde_json::Value, String> {
    let audio = base64::engine::general_purpose::STANDARD.decode(&audio_base64).map_err(|e| format!("base64 decode: {e}"))?;
    if audio.is_empty() {
        return Err("Empty audio data".to_string());
    }
    let started = Instant::now();
    let (port, key) = ensure_running().await?;
    let resp = match post_take(port, &key, audio.clone()).await {
        Ok(r) => r,
        // The server went away between the check and the request. One fresh
        // start, the same take again.
        Err(e) if e.is_connect() => {
            stop();
            let (port, key) = ensure_running().await?;
            post_take(port, &key, audio).await.map_err(|e| format!("Parakeet did not answer: {}", os_error::english(&e)))?
        }
        Err(e) => return Err(format!("Parakeet did not answer: {}", os_error::english(&e))),
    };
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let detail: String = resp.text().await.unwrap_or_default().chars().take(200).collect();
        return Err(format!("Parakeet answered HTTP {code}: {detail}"));
    }
    let answer: serde_json::Value = resp.json().await.map_err(|e| format!("Parakeet's answer was not JSON: {e}"))?;
    let text = answer.get("text").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).ok_or("Parakeet's answer carried no text")?;
    tracing::info!(target: "parakeet", "take transcribed in {} ms", started.elapsed().as_millis());
    Ok(serde_json::json!({ "transcript": text }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_manifest_reads_and_pins_every_desktop_target() {
        let m = Manifest::parse(MANIFEST_TEXT).unwrap();
        for target in ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] {
            let b = m.build_for(target).unwrap_or_else(|| panic!("no build for {target}"));
            assert!(b.remote.url.starts_with("https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/"), "{}", b.remote.url);
            assert!(b.remote.url.contains(&b.dir), "{} does not name {}", b.remote.url, b.dir);
        }
        assert!(m.model.remote.url.starts_with("https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/"));
        assert!(m.model.remote.url.contains(&m.model.revision), "the model is fetched by its pinned revision");
        assert_eq!(m.model.license, "CC-BY-4.0");
        assert_eq!(m.runtime.license, "Apache-2.0");
    }

    #[test]
    fn a_manifest_with_a_loose_entry_is_refused() {
        let bad_digest = MANIFEST_TEXT.replace("e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e", "abc");
        assert!(Manifest::parse(&bad_digest).is_err());
        let plain_http = MANIFEST_TEXT.replacen("\"url\": \"https://github.com", "\"url\": \"http://github.com", 1);
        assert!(Manifest::parse(&plain_http).is_err());
        let escaping = MANIFEST_TEXT.replace("\"dir\": \"nemo-speech-0.3.0-macos-aarch64-metal\"", "\"dir\": \"..\"");
        assert!(Manifest::parse(&escaping).is_err());
        let floating = MANIFEST_TEXT.replace("/resolve/541d1f99c6b0c3cd0b11a95167540bb8edefd82b/", "/resolve/main/");
        assert!(Manifest::parse(&floating).is_err(), "a model on a moving branch is refused");
    }

    #[test]
    fn every_desktop_system_has_a_target_and_others_get_a_sentence() {
        assert_eq!(target_for("macos", "aarch64").unwrap(), "aarch64-apple-darwin");
        assert_eq!(target_for("windows", "x86_64").unwrap(), "x86_64-pc-windows-msvc");
        assert_eq!(target_for("linux", "x86_64").unwrap(), "x86_64-unknown-linux-gnu");
        assert!(target_for("windows", "aarch64").unwrap_err().contains("aarch64"));
        assert!(target_for("android", "aarch64").is_err());
    }

    #[test]
    fn the_server_listens_on_loopback_without_playground_and_with_a_key() {
        let a = serve_args(Path::new("/m/p.gguf"), 4321, "k1");
        let pair = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone());
        assert_eq!(pair("--host").as_deref(), Some("127.0.0.1"));
        assert_eq!(pair("--port").as_deref(), Some("4321"));
        assert_eq!(pair("--api-key").as_deref(), Some("k1"));
        assert_eq!(pair("--asr-model").as_deref(), Some("/m/p.gguf"));
        assert!(a.contains(&"--no-ui".to_string()));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lu-parakeet-test-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn installed_needs_the_marker_the_exe_and_a_model_of_the_pinned_size() {
        let root = tmp("installed");
        let dirs = Dirs { root: root.clone() };
        let mut m = Manifest::parse(MANIFEST_TEXT).unwrap();
        m.model.remote.size = 5;
        let build = m.build_for("aarch64-apple-darwin").unwrap().clone();
        assert!(!is_installed(&dirs, &m, &build, false));

        let exe = dirs.exe(&build, false);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"x").unwrap();
        std::fs::create_dir_all(dirs.model(&m.model).parent().unwrap()).unwrap();
        std::fs::write(dirs.model(&m.model), b"12345").unwrap();
        assert!(!is_installed(&dirs, &m, &build, false), "no marker, nothing was verified");

        Marker { runtime_sha256: build.remote.sha256.clone(), model_sha256: m.model.remote.sha256.clone() }.save(&dirs).unwrap();
        assert!(is_installed(&dirs, &m, &build, false));

        std::fs::write(dirs.model(&m.model), b"1234").unwrap();
        assert!(!is_installed(&dirs, &m, &build, false), "a cut model is not installed");

        std::fs::write(dirs.model(&m.model), b"12345").unwrap();
        Marker { runtime_sha256: "0".repeat(64), model_sha256: m.model.remote.sha256.clone() }.save(&dirs).unwrap();
        assert!(!is_installed(&dirs, &m, &build, false), "another runtime release is not this one");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_tar_release_unpacks_with_its_links_and_a_zip_one_without_escaping() {
        let root = tmp("unpack");
        // tar.gz with a file and a relative link, as the macOS and Linux releases have.
        let tgz = root.join("r.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(std::fs::File::create(&tgz).unwrap(), flate2::Compression::fast());
            let mut b = tar::Builder::new(gz);
            let mut h = tar::Header::new_gnu();
            h.set_size(3);
            h.set_mode(0o755);
            h.set_cksum();
            b.append_data(&mut h, "rel/bin/nemo-speech", &b"abc"[..]).unwrap();
            let mut l = tar::Header::new_gnu();
            l.set_entry_type(tar::EntryType::Symlink);
            l.set_size(0);
            l.set_cksum();
            b.append_link(&mut l, "rel/lib/libx.dylib", "libx.0.dylib").unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        let out = root.join("out");
        unpack(&tgz, &out).unwrap();
        assert_eq!(std::fs::read(out.join("rel/bin/nemo-speech")).unwrap(), b"abc");
        assert!(std::fs::symlink_metadata(out.join("rel/lib/libx.dylib")).unwrap().file_type().is_symlink());

        // zip as on Windows; an entry that climbs out is refused.
        let zp = root.join("r.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("rel/bin/nemo-speech.exe", o).unwrap();
            std::io::Write::write_all(&mut z, b"exe").unwrap();
            z.finish().unwrap();
        }
        let out2 = root.join("out2");
        unpack(&zp, &out2).unwrap();
        assert_eq!(std::fs::read(out2.join("rel/bin/nemo-speech.exe")).unwrap(), b"exe");

        let evil = root.join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
            z.start_file("../outside.txt", zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut z, b"no").unwrap();
            z.finish().unwrap();
        }
        assert!(unpack(&evil, &root.join("out3")).is_err());
        assert!(!root.join("outside.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
