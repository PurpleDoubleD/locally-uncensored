//! The Neuron tweaker (3.0.9, P11): sliders that push a local model's inner
//! activity in a direction, live in the chat.
//!
//! ── How ────────────────────────────────────────────────────────────────────
//!
//! Activation steering with control vectors. A direction per layer is added
//! to the model's residual stream while it writes; llama-server does that
//! itself (`--control-vector`). Three kinds of direction:
//!
//!   * ready-made sliders (`presets.rs`): example pairs LU ships, turned into
//!     a direction on the user's own model by `lu-llama-cvector-generator`
//!     (mean of the activation differences, the pinned llama.cpp's own tool);
//!   * the user's own slider: their "more like this" / "less like this"
//!     lines, same tool;
//!   * SAE features (`sae.rs`): one decoder row of an official sparse
//!     autoencoder, for the models one exists for.
//!
//! Each direction gets its own full strength once, measured (`calib.rs`).
//! The active sliders are mixed into one file (`cvec.rs`), whose name is a
//! hash of its content, and the engine is restarted with it. llama-server
//! cannot change control vectors while it runs (no endpoint for it in
//! b9949), so "live" is a restart of a few seconds.
//!
//! ── Files ──────────────────────────────────────────────────────────────────
//!
//!   <data>/neuron/models/<model key>/vectors/<id>.gguf + <id>.json
//!   <data>/neuron/models/<model key>/features/<sae>-<n>.json   (strength)
//!   <data>/neuron/sae/<sae id>/w_dec.f32, top_tokens.i32
//!   <data>/neuron/mix/<hash>.gguf            what the engine runs with
//!   <data>/neuron/active.json                model path → mix
//!
//! ── Where it works ─────────────────────────────────────────────────────────
//!
//! LU Engine only. Ollama, LM Studio and cloud models are answered by
//! programs that take no control vector; the panel says so.

pub mod calib;
pub mod cvec;
pub mod model;
pub mod presets;
pub mod sae;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const GENERATOR: &str = "lu-llama-cvector-generator";
const PROBE_QUESTION: &str = "Write one sentence about rain.";
const LOG_LINES: usize = 40;

// ── paths ─────────────────────────────────────────────────────────────────

pub fn root() -> PathBuf {
    crate::os_paths::data_dir().join("neuron")
}

/// A folder name for one model file: the stem, cleaned, and its size, so a
/// different file under the same name gets its own vectors.
pub fn model_key(model_path: &str) -> String {
    let p = Path::new(model_path);
    let stem: String = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c.to_ascii_lowercase() } else { '_' })
        .take(80)
        .collect();
    let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    format!("{stem}-{size:x}")
}

fn model_dir(root: &Path, model_path: &str) -> PathBuf {
    root.join("models").join(model_key(model_path))
}

/// Vector ids are ours ("creative") or made here ("own-…"): letters, digits,
/// dashes. Anything else is refused, so an id never walks out of its folder.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// ── what is active ────────────────────────────────────────────────────────

static ACTIVE: LazyLock<Mutex<Option<BTreeMap<String, String>>>> = LazyLock::new(|| Mutex::new(None));

fn with_active<T>(f: impl FnOnce(&mut BTreeMap<String, String>) -> T) -> T {
    let mut guard = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(|| {
        std::fs::read(root().join("active.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    f(map)
}

fn save_active(map: &BTreeMap<String, String>) {
    let dir = root();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(bytes) = serde_json::to_vec_pretty(map) {
        let tmp = dir.join("active.json.part");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(tmp, dir.join("active.json"));
        }
    }
}

/// Only a mix file LU wrote itself is passed to the engine.
pub(crate) fn mix_path_is_ours(root: &Path, path: &str) -> bool {
    let p = Path::new(path);
    p.parent() == Some(root.join("mix").as_path())
        && p.extension().is_some_and(|e| e == "gguf")
        && p.file_stem().is_some_and(|s| s.to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()))
        && p.is_file()
}

/// The control vector the engine starts this model with, if any.
pub(crate) fn control_vector_for(model_path: &str) -> Option<String> {
    let path = with_active(|m| m.get(model_path).cloned())?;
    if mix_path_is_ours(&root(), &path) {
        Some(path)
    } else {
        tracing::warn!(target: "neuron", path = %path, "ignoring a control vector outside LU's neuron folder or missing");
        None
    }
}

// ── vectors on disk ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorMeta {
    pub id: String,
    /// preset | own | feature
    pub kind: String,
    pub name: String,
    pub left: String,
    pub right: String,
    /// The scale slider +1 stands for (calib.rs).
    pub unit: f32,
    pub built_at: u64,
    #[serde(default)]
    pub more: Vec<String>,
    #[serde(default)]
    pub less: Vec<String>,
    #[serde(default)]
    pub feature: Option<usize>,
    #[serde(default)]
    pub sae: Option<String>,
}

fn vectors_dir(root: &Path, model_path: &str) -> PathBuf {
    model_dir(root, model_path).join("vectors")
}

fn feature_id(sae: &str, feature: usize) -> String {
    format!("f-{sae}-{feature}")
}

pub fn list_vectors(root: &Path, model_path: &str) -> Vec<VectorMeta> {
    let dir = vectors_dir(root, model_path);
    let mut out: Vec<VectorMeta> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<VectorMeta>(&b).ok())
        .filter(|m| valid_id(&m.id) && (m.kind == "feature" || dir.join(format!("{}.gguf", m.id)).is_file()))
        .collect();
    out.sort_by_key(|m| m.built_at);
    out
}

fn save_meta(root: &Path, model_path: &str, meta: &VectorMeta) -> Result<(), String> {
    let dir = vectors_dir(root, model_path);
    std::fs::create_dir_all(&dir).map_err(|e| crate::os_error::english(&e))?;
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| crate::os_error::english(&e))?;
    std::fs::write(dir.join(format!("{}.json", meta.id)), bytes).map_err(|e| crate::os_error::english(&e))
}

/// One slider as the frontend sends it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// −1 … +1, clamped.
    pub strength: f32,
}

/// Mixes the sliders into one vector. A slider at 0 is left out, so all at 0
/// is no vector at all: the engine then starts with exactly the argv it has
/// without the tweaker, and the answer is the unsteered one.
pub fn mix(root: &Path, model_path: &str, n_embd: usize, entries: &[Entry]) -> Result<Option<cvec::ControlVector>, String> {
    let metas: HashMap<String, VectorMeta> = list_vectors(root, model_path).into_iter().map(|m| (m.id.clone(), m)).collect();
    let mut out = cvec::ControlVector::new(n_embd);
    let mut any = false;
    for e in entries {
        let strength = e.strength.clamp(-1.0, 1.0);
        if strength == 0.0 || !strength.is_finite() {
            continue;
        }
        let meta = metas.get(&e.id).ok_or_else(|| format!("The slider \"{}\" has not been computed for this model yet.", e.id))?;
        let v = match (&meta.sae, meta.feature) {
            (Some(sae_id), Some(f)) => {
                let spec = sae::by_id(sae_id).ok_or("Unknown feature set.")?;
                sae::feature_vector(root, spec, f)?
            }
            _ => cvec::read(&vectors_dir(root, model_path).join(format!("{}.gguf", meta.id)))?,
        };
        out.add_scaled(&v, strength * meta.unit)?;
        any = true;
    }
    Ok(if any && !out.is_zero() { Some(out) } else { None })
}

/// Writes the mix under its content hash and returns the path.
fn write_mix(root: &Path, cv: &cvec::ControlVector, hint: &str, n_layer: usize) -> Result<String, String> {
    let bytes = cvec::to_bytes(cv, hint, n_layer);
    let dir = root.join("mix");
    std::fs::create_dir_all(&dir).map_err(|e| crate::os_error::english(&e))?;
    let path = dir.join(format!("{}.gguf", cvec::content_tag(&bytes)));
    if !path.is_file() {
        let tmp = path.with_extension("part");
        std::fs::write(&tmp, &bytes).map_err(|e| crate::os_error::english(&e))?;
        std::fs::rename(&tmp, &path).map_err(|e| crate::os_error::english(&e))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Mix files nothing points at any more. Cheap; run after each apply.
fn prune_mixes(root: &Path, keep: &BTreeMap<String, String>) {
    let Ok(dir) = std::fs::read_dir(root.join("mix")) else { return };
    for e in dir.flatten() {
        let p = e.path().to_string_lossy().into_owned();
        if p.ends_with(".gguf") && !keep.values().any(|v| *v == p) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ── the job ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// idle | running | done | failed | cancelled
    pub status: String,
    /// build | feature | download
    pub kind: String,
    pub title: String,
    pub model_path: String,
    pub phase_label: String,
    pub step: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub rate_bps: u64,
    pub eta_secs: Option<u64>,
    pub elapsed_secs: u64,
    pub result_id: Option<String>,
    pub error: Option<String>,
    pub logs: VecDeque<String>,
    #[serde(skip)]
    started: Option<Instant>,
    #[serde(skip)]
    phase_started: Option<Instant>,
}

static JOB: LazyLock<Mutex<Job>> = LazyLock::new(|| Mutex::new(Job { status: "idle".into(), ..Default::default() }));
static CANCEL: AtomicBool = AtomicBool::new(false);

fn with_job<T>(f: impl FnOnce(&mut Job) -> T) -> T {
    let mut g = JOB.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut g)
}

fn log(line: impl Into<String>) {
    let line = line.into();
    let line = line.trim_end();
    if line.is_empty() {
        return;
    }
    tracing::info!(target: "neuron", "{line}");
    with_job(|j| {
        j.logs.push_back(line.to_string());
        while j.logs.len() > LOG_LINES {
            j.logs.pop_front();
        }
    });
}

fn phase(label: &str, total: u64) {
    log(format!("· {label}"));
    with_job(|j| {
        j.phase_label = label.into();
        j.step = 0;
        j.total = total;
        j.eta_secs = None;
        j.bytes_done = 0;
        j.bytes_total = 0;
        j.rate_bps = 0;
        j.phase_started = Some(Instant::now());
    });
}

fn step(n: u64) {
    with_job(|j| {
        j.step = n;
        if let Some(t0) = j.phase_started {
            let secs = t0.elapsed().as_secs_f64();
            if n > 0 && j.total > n {
                j.eta_secs = Some((secs / n as f64 * (j.total - n) as f64).round() as u64);
            } else if j.total <= n {
                j.eta_secs = Some(0);
            }
        }
    });
}

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::SeqCst) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn start_job(kind: &str, title: &str, model_path: &str, work: impl FnOnce() -> Result<String, String> + Send + 'static) -> Result<Value, String> {
    let busy = with_job(|j| {
        if j.status == "running" {
            return true;
        }
        *j = Job {
            status: "running".into(),
            kind: kind.into(),
            title: title.into(),
            model_path: model_path.into(),
            started: Some(Instant::now()),
            ..Default::default()
        };
        false
    });
    if busy {
        return Err("The Neuron tweaker is already computing something. Wait for it or stop it.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = work();
        with_job(|j| {
            j.elapsed_secs = j.started.map(|t| t.elapsed().as_secs()).unwrap_or(0);
            match result {
                Ok(id) => {
                    j.status = "done".into();
                    j.result_id = Some(id);
                    j.eta_secs = Some(0);
                }
                Err(e) if e == "cancelled" => j.status = "cancelled".into(),
                Err(e) => {
                    j.status = "failed".into();
                    j.error = Some(e);
                }
            }
        });
    });
    Ok(json!({ "started": true }))
}

// ── generator and probes ──────────────────────────────────────────────────

fn generator_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::commands::engine::resolve_sidecar(app, GENERATOR)
}

/// "Evaluating prompt[12/40]: ..." → (12, 40)
pub fn parse_progress(line: &str) -> Option<(u64, u64)> {
    let rest = line.split("Evaluating prompt[").nth(1)?;
    let (pair, _) = rest.split_once(']')?;
    let (a, b) = pair.split_once('/')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Runs the generator on the example pairs and returns the direction.
fn generate(app: &tauri::AppHandle, model_path: &str, plus: &[String], minus: &[String], work: &Path) -> Result<cvec::ControlVector, String> {
    let binary = generator_binary(app).ok_or("This build of LU has no vector tool (lu-llama-cvector-generator). On Linux it comes in a later version.")?;
    std::fs::create_dir_all(work).map_err(|e| crate::os_error::english(&e))?;
    let pos = work.join("more.txt");
    let neg = work.join("less.txt");
    let out = work.join("direction.gguf");
    std::fs::write(&pos, plus.join("\n") + "\n").map_err(|e| crate::os_error::english(&e))?;
    std::fs::write(&neg, minus.join("\n") + "\n").map_err(|e| crate::os_error::english(&e))?;
    let _ = std::fs::remove_file(&out);
    let mut cmd = Command::new(&binary);
    cmd.arg("-m").arg(model_path)
        .arg("--positive-file").arg(&pos)
        .arg("--negative-file").arg(&neg)
        .arg("-o").arg(&out)
        .args(["--method", "mean", "-ngl", "99", "-c", "1024"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::commands::engine::prepare_tool_command(app, &mut cmd);
    log(format!("$ {} …", binary.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()));
    let mut child = cmd.spawn().map_err(|e| format!("The vector tool did not start: {}", crate::os_error::english(&e)))?;
    let stderr = child.stderr.take().map(crate::commands::shell::drain);
    let stdout = child.stdout.take().ok_or("no output")?;
    let id = child.id();
    let watcher = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some((n, total)) = parse_progress(&line) {
                with_job(|j| j.total = total);
                step(n.saturating_sub(1));
            }
        }
    });
    let status = loop {
        if CANCEL.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = watcher.join();
            return Err("cancelled".into());
        }
        if let Some(s) = child.try_wait().map_err(|e| crate::os_error::english(&e))? {
            break s;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let _ = watcher.join();
    tracing::info!(target: "neuron", pid = id, ?status, "vector tool finished");
    if !status.success() || !out.is_file() {
        let why = stderr.map(|(buf, _)| crate::commands::shell::captured_text(&buf)).unwrap_or_default();
        let tail: Vec<&str> = why.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("The vector tool stopped without a result.\n{}", tail.join("\n")));
    }
    with_job(|j| j.step = j.total);
    let cv = cvec::read(&out)?;
    let _ = std::fs::remove_file(&pos);
    let _ = std::fs::remove_file(&neg);
    Ok(cv)
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| crate::os_error::english(&e))
}

/// One answer from an engine on `port`, deterministic: temperature 0 and a
/// fixed seed.
pub(crate) fn ask(port: u16, question: &str, seed: u64, max_tokens: u32) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(|e| crate::os_error::english(&e))?;
    let body = json!({
        "messages": [{ "role": "user", "content": question }],
        "temperature": 0,
        "seed": seed,
        "max_tokens": max_tokens,
        "stream": false,
    });
    let req = client.post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body);
    let resp = crate::commands::engine_key::authorize_blocking(req).send().map_err(|e| format!("The model did not answer: {}", crate::os_error::english(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("The model answered with HTTP {}.", resp.status()));
    }
    let v: Value = resp.json().map_err(|e| crate::os_error::english(&e))?;
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

/// The measured full strength of `cv` (calib.rs), probing a private engine
/// per scale. `both_signs`: a slider goes both ways, a feature only up.
fn calibrate(app: &tauri::AppHandle, model_path: &str, facts: &model::ModelFacts, cv: &cvec::ControlVector, start: f32, both_signs: bool, work: &Path) -> Result<f32, String> {
    phase("Finding the strongest setting that still reads well", 12);
    let mut tries = 0u64;
    let probe_file = work.join("probe.gguf");
    let mut probe = |scale: f32| -> Result<bool, String> {
        cancelled()?;
        let signs: &[f32] = if both_signs { &[1.0, -1.0] } else { &[1.0] };
        for sign in signs {
            let mut scaled = cvec::ControlVector::new(cv.n_embd);
            scaled.add_scaled(cv, scale * sign)?;
            cvec::write(&probe_file, &scaled, &facts.arch, facts.n_layer)?;
            let port = free_port()?;
            let extra = vec!["--control-vector".to_string(), probe_file.to_string_lossy().into_owned()];
            let mut child = crate::commands::engine::spawn_private_server_with(app, model_path, port, 1024, &extra)?;
            let answer = ask(port, PROBE_QUESTION, 42, 60);
            let _ = child.kill();
            let _ = child.wait();
            let answer = answer?;
            let ok = calib::coherent(&answer);
            log(format!("  {:+.3}: {} — {}", scale * sign, if ok { "reads well" } else { "breaks" }, answer.chars().take(90).collect::<String>().replace('\n', " ")));
            tries += 1;
            step(tries.min(11));
            if !ok {
                return Ok(false);
            }
        }
        Ok(true)
    };
    let unit = calib::find_unit(start, &mut probe)?;
    let _ = std::fs::remove_file(&probe_file);
    log(format!("  full strength = {unit:.3}"));
    Ok(unit)
}

/// The chat engine and the tool would hold the model twice. Stop the engine
/// first; the next chat message (or the apply after the job) brings it back.
fn free_the_model(app: &tauri::AppHandle) {
    let state = app.state::<crate::state::AppState>();
    if crate::commands::engine::stop_engine_on_request(&state) {
        log("Paused the chat engine while LU computes.");
    }
}

// ── commands ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildArgs {
    pub model_path: String,
    /// A preset id, or absent for an own slider.
    pub preset: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub more: Vec<String>,
    #[serde(default)]
    pub less: Vec<String>,
    /// To recompute an own slider under its id.
    pub id: Option<String>,
}

fn own_id(name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base: String = base.chars().take(24).collect();
    let tag = format!("{:x}", now_ms() % 0xfffff);
    if base.is_empty() { format!("own-{tag}") } else { format!("own-{base}-{tag}") }
}

#[tauri::command]
pub fn neuron_presets() -> Value {
    json!(presets::PRESETS.iter().map(|p| json!({ "id": p.id, "left": p.left, "right": p.right })).collect::<Vec<_>>())
}

#[tauri::command]
pub async fn neuron_info(app: tauri::AppHandle, model_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let facts = model::facts(&model_path)?;
        let root = root();
        let (band_start, band_end) = cvec::band_for(facts.n_layer);
        let lower_name = facts.name.to_lowercase();
        let instruct = lower_name.contains("-it") || lower_name.contains(" it") || lower_name.contains("instruct");
        let sae = sae::for_model(&facts).map(|s| {
            json!({
                "id": s.id, "title": s.title, "license": s.license, "layer": s.layer, "width": s.width,
                "bytes": s.bytes(), "downloaded": sae::is_downloaded(&root, s),
                "source": format!("https://huggingface.co/{}/tree/{}/{}", s.repo, s.revision, s.folder),
                "instruct": instruct,
            })
        });
        let active = control_vector_for(&model_path);
        Ok(json!({
            "facts": facts,
            "modelKey": model_key(&model_path),
            "generator": generator_binary(&app).is_some(),
            "band": [band_start, band_end],
            "vectors": list_vectors(&root, &model_path),
            "sae": sae,
            "activeMix": active,
        }))
    })
    .await
    .map_err(|e| crate::os_error::english(&e))?
}

#[tauri::command]
pub fn neuron_build(app: tauri::AppHandle, args: BuildArgs) -> Result<Value, String> {
    let facts = model::facts(&args.model_path)?;
    if generator_binary(&app).is_none() {
        return Err("This build of LU has no vector tool (lu-llama-cvector-generator). Feature sliders still work where the model has an SAE.".into());
    }
    let (id, kind, name, left, right, plus, minus) = match &args.preset {
        Some(pid) => {
            let p = presets::find(pid).ok_or("Unknown slider.")?;
            let (plus, minus) = presets::pairs(p, facts.template);
            (p.id.to_string(), "preset", format!("{} ↔ {}", p.left, p.right), p.left.to_string(), p.right.to_string(), plus, minus)
        }
        None => {
            let name = args.name.clone().map(|n| n.trim().chars().take(40).collect::<String>()).filter(|n| !n.is_empty()).unwrap_or_else(|| "My slider".into());
            let (plus, minus) = presets::custom_pairs(&args.more, &args.less, facts.template)?;
            let id = match &args.id {
                Some(id) if valid_id(id) && id.starts_with("own-") => id.clone(),
                _ => own_id(&name),
            };
            (id, "own", name.clone(), "Less like this".into(), name, plus, minus)
        }
    };
    let title = format!("Computing \"{name}\"");
    let model_path = args.model_path.clone();
    let (more, less) = (args.more.clone(), args.less.clone());
    start_job("build", &title, &model_path.clone(), move || {
        let root = root();
        let work = model_dir(&root, &model_path).join("work");
        free_the_model(&app);
        phase("Reading the examples through the model", plus.len() as u64);
        let mut cv = generate(&app, &model_path, &plus, &minus, &work)?;
        let (s, e) = cvec::band_for(facts.n_layer);
        cv.restrict(s, e);
        cancelled()?;
        let unit = calibrate(&app, &model_path, &facts, &cv, 0.25, true, &work)?;
        let path = vectors_dir(&root, &model_path).join(format!("{id}.gguf"));
        cvec::write(&path, &cv, &facts.arch, facts.n_layer)?;
        let meta = VectorMeta {
            id: id.clone(), kind: kind.into(), name, left, right, unit, built_at: now_ms(),
            more: if kind == "own" { more } else { Vec::new() },
            less: if kind == "own" { less } else { Vec::new() },
            feature: None, sae: None,
        };
        save_meta(&root, &model_path, &meta)?;
        let _ = std::fs::remove_dir_all(&work);
        log(format!("Saved {id}."));
        Ok(id)
    })
}

#[tauri::command]
pub fn neuron_feature_add(app: tauri::AppHandle, model_path: String, feature: usize, label: Option<String>) -> Result<Value, String> {
    let facts = model::facts(&model_path)?;
    let spec = sae::for_model(&facts).ok_or("There is no official feature set for this model.")?;
    if !sae::is_downloaded(&root(), spec) {
        return Err("Download the feature data first.".into());
    }
    if feature >= spec.width {
        return Err("No such feature.".into());
    }
    let id = feature_id(if spec.id.contains("270m") { "g270m" } else { "g1b" }, feature);
    let name = label.map(|l| l.chars().take(60).collect::<String>()).unwrap_or_else(|| format!("Feature #{feature}"));
    start_job("feature", &format!("Adding feature #{feature}"), &model_path.clone(), move || {
        let root = root();
        let work = model_dir(&root, &model_path).join("work");
        std::fs::create_dir_all(&work).map_err(|e| crate::os_error::english(&e))?;
        free_the_model(&app);
        let cv = sae::feature_vector(&root, spec, feature)?;
        let unit = calibrate(&app, &model_path, &facts, &cv, 50.0, false, &work)?;
        let meta = VectorMeta {
            id: id.clone(), kind: "feature".into(), name: format!("#{feature} {name}"), left: "Off".into(), right: "More".into(),
            unit, built_at: now_ms(), more: Vec::new(), less: Vec::new(), feature: Some(feature), sae: Some(spec.id.into()),
        };
        save_meta(&root, &model_path, &meta)?;
        let _ = std::fs::remove_dir_all(&work);
        Ok(id)
    })
}

#[tauri::command]
pub fn neuron_delete(model_path: String, id: String) -> Result<Value, String> {
    if !valid_id(&id) || !(id.starts_with("own-") || id.starts_with("f-") || presets::find(&id).is_some()) {
        return Err("Unknown slider.".into());
    }
    let dir = vectors_dir(&root(), &model_path);
    let _ = std::fs::remove_file(dir.join(format!("{id}.gguf")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    Ok(json!({ "deleted": id }))
}

/// Byte-range download of one slice with progress and the pinned hash.
fn fetch_slice(client: &reqwest::blocking::Client, url: &str, slice: &sae::Slice, dest: &Path, done_before: u64, total: u64, t0: Instant) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let part = dest.with_extension("part");
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={}-{}", slice.start, slice.end))
        .send()
        .map_err(|e| format!("Download failed: {}", crate::os_error::english(&e)))?;
    if resp.status().as_u16() != 206 {
        return Err(format!("The server did not send the part LU asked for (HTTP {}).", resp.status()));
    }
    let mut resp = resp;
    let mut f = std::fs::File::create(&part).map_err(|e| crate::os_error::english(&e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    loop {
        cancelled()?;
        let n = resp.read(&mut buf).map_err(|e| format!("Download interrupted: {}", crate::os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        got += n as u64;
        if got > slice.len() {
            return Err("The server sent more than LU asked for.".into());
        }
        hasher.update(&buf[..n]);
        f.write_all(&buf[..n]).map_err(|e| crate::os_error::english(&e))?;
        with_job(|j| {
            j.bytes_done = done_before + got;
            j.bytes_total = total;
            let secs = t0.elapsed().as_secs_f64().max(0.1);
            j.rate_bps = (j.bytes_done as f64 / secs) as u64;
            if let Some(eta) = (total - j.bytes_done).checked_div(j.rate_bps) {
                j.eta_secs = Some(eta);
            }
        });
    }
    drop(f);
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != slice.len() || digest != slice.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The downloaded data does not match the official file (SHA-256 {digest}). Nothing was kept."));
    }
    std::fs::rename(&part, dest).map_err(|e| crate::os_error::english(&e))
}

#[tauri::command]
pub fn neuron_sae_download(model_path: String) -> Result<Value, String> {
    let facts = model::facts(&model_path)?;
    let spec = sae::for_model(&facts).ok_or("There is no official feature set for this model.")?;
    start_job("download", &format!("Downloading {}", spec.title), &model_path, move || {
        let root = root();
        let dir = sae::dir(&root, spec);
        std::fs::create_dir_all(&dir).map_err(|e| crate::os_error::english(&e))?;
        phase(&format!("Downloading the feature data ({})", spec.license), 0);
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(3600))
            .user_agent(crate::app_identity::outgoing_agent_for(crate::app_identity::APP_VERSION))
            .build()
            .map_err(|e| crate::os_error::english(&e))?;
        let total = spec.bytes();
        let t0 = Instant::now();
        fetch_slice(&client, &spec.url(&spec.w_dec), &spec.w_dec, &dir.join("w_dec.f32"), 0, total, t0)?;
        fetch_slice(&client, &spec.url(&spec.top_tokens), &spec.top_tokens, &dir.join("top_tokens.i32"), spec.w_dec.len(), total, t0)?;
        log(format!("Checked against the official SHA-256: {} and {}.", &spec.w_dec.sha256[..12], &spec.top_tokens.sha256[..12]));
        Ok(spec.id.to_string())
    })
}

/// Feature labels per SAE and model file, read once.
type LabelCache = HashMap<String, std::sync::Arc<Vec<Vec<String>>>>;
static LABELS: LazyLock<Mutex<LabelCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub async fn neuron_sae_search(model_path: String, query: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let facts = model::facts(&model_path)?;
        let spec = sae::for_model(&facts).ok_or("There is no official feature set for this model.")?;
        let root = root();
        if !sae::is_downloaded(&root, spec) {
            return Err("Download the feature data first.".to_string());
        }
        let key = format!("{}|{}", spec.id, model_key(&model_path));
        let cached = LABELS.lock().unwrap_or_else(|p| p.into_inner()).get(&key).cloned();
        let labels = match cached {
            Some(l) => l,
            None => {
                let vocab = model::string_array(Path::new(&model_path), "tokenizer.ggml.tokens")?;
                let tops = sae::read_i32s(&sae::dir(&root, spec).join("top_tokens.i32"))?;
                let l = std::sync::Arc::new(sae::labels(&tops, &vocab));
                LABELS.lock().unwrap_or_else(|p| p.into_inner()).insert(key, l.clone());
                l
            }
        };
        Ok(json!({ "hits": sae::search(&labels, &query, 30) }))
    })
    .await
    .map_err(|e| crate::os_error::english(&e))?
}

#[tauri::command]
pub fn neuron_status() -> Value {
    let mut j = with_job(|j| {
        if j.status == "running" {
            j.elapsed_secs = j.started.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        }
        j.clone()
    });
    j.logs = j.logs.iter().rev().take(12).rev().cloned().collect();
    json!(j)
}

#[tauri::command]
pub fn neuron_cancel() -> Value {
    CANCEL.store(true, Ordering::SeqCst);
    json!({ "cancelling": true })
}

#[tauri::command]
pub fn neuron_dismiss() -> Value {
    with_job(|j| {
        if j.status != "running" {
            *j = Job { status: "idle".into(), ..Default::default() };
        }
    });
    json!({ "ok": true })
}

fn engine_holds(app: &tauri::AppHandle, model_path: &str) -> bool {
    let state = app.state::<crate::state::AppState>();
    let guard = state.bundled_engine.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref().is_some_and(|e| e.model_path == model_path)
}

fn set_active(model_path: &str, mix: Option<String>, persist: bool) {
    with_active(|m| {
        match mix {
            Some(p) => m.insert(model_path.to_string(), p),
            None => m.remove(model_path),
        };
        if persist {
            save_active(m);
            prune_mixes(&root(), m);
        }
    });
}

fn restart(app: &tauri::AppHandle, model_path: &str, tuning: Option<crate::commands::engine::EngineTuning>) -> Result<Value, String> {
    let state = app.state::<crate::state::AppState>();
    crate::commands::engine::start_bundled_engine_blocking(app, &state, model_path.to_string(), tuning, None)
}

/// Sets the sliders for a model and, when the engine runs that model,
/// restarts it with them. `tuning` is the user's engine tuning, the same the
/// chat's own starts pass.
#[tauri::command]
pub async fn neuron_apply(app: tauri::AppHandle, model_path: String, entries: Vec<Entry>, tuning: Option<crate::commands::engine::EngineTuning>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let facts = model::facts(&model_path)?;
        let root = root();
        let mixed = mix(&root, &model_path, facts.n_embd, &entries)?;
        let path = match &mixed {
            Some(cv) => Some(write_mix(&root, cv, &facts.arch, facts.n_layer)?),
            None => None,
        };
        set_active(&model_path, path.clone(), true);
        let load: f32 = entries.iter().map(|e| e.strength.clamp(-1.0, 1.0).abs()).sum();
        let mut out = json!({ "mix": path, "restarted": false, "load": load });
        if engine_holds(&app, &model_path) {
            let started = restart(&app, &model_path, tuning)?;
            out["restarted"] = json!(started["status"] != "already_running");
            out["port"] = started["port"].clone();
        }
        tracing::info!(target: "neuron", model = %model_path, sliders = entries.len(), mix = ?path, "sliders applied");
        Ok(out)
    })
    .await
    .map_err(|e| crate::os_error::english(&e))?
}

/// The same question to the same model with the sliders off and on, side by
/// side: temperature 0 and a fixed seed, so a difference is the sliders'.
/// The engine is left with the sliders on (what the user set).
#[tauri::command]
pub async fn neuron_compare(
    app: tauri::AppHandle,
    model_path: String,
    question: String,
    seed: Option<u64>,
    entries: Vec<Entry>,
    tuning: Option<crate::commands::engine::EngineTuning>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let question: String = question.trim().chars().take(2000).collect();
        if question.is_empty() {
            return Err("Type a question to compare.".to_string());
        }
        let seed = seed.unwrap_or(42);
        let facts = model::facts(&model_path)?;
        let root = root();
        let mixed = mix(&root, &model_path, facts.n_embd, &entries)?;
        let on = match &mixed {
            Some(cv) => Some(write_mix(&root, cv, &facts.arch, facts.n_layer)?),
            None => None,
        };
        set_active(&model_path, None, false);
        let started = restart(&app, &model_path, tuning.clone())?;
        let port = started["port"].as_u64().unwrap_or(8127) as u16;
        let before = ask(port, &question, seed, 220);
        set_active(&model_path, on.clone(), true);
        let before = before?;
        let started = restart(&app, &model_path, tuning)?;
        let port = started["port"].as_u64().unwrap_or(8127) as u16;
        let after = ask(port, &question, seed, 220)?;
        Ok(json!({ "before": before, "after": after, "seed": seed, "steered": on.is_some(), "same": before == after }))
    })
    .await
    .map_err(|e| crate::os_error::english(&e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_of_the_generator_parse() {
        assert_eq!(parse_progress("Evaluating prompt[12/40]: \"a\" - \"b\" (31 tokens)"), Some((12, 40)));
        assert_eq!(parse_progress("n_total_tokens: 2000"), None);
        assert_eq!(parse_progress("Evaluating prompt[x/40]"), None);
    }

    #[test]
    fn ids_cannot_leave_their_folder() {
        assert!(valid_id("creative"));
        assert!(valid_id("own-pirate-3f2a"));
        assert!(!valid_id("../x"));
        assert!(!valid_id("A"));
        assert!(!valid_id(""));
        assert!(own_id("Talk like a Pirate!").starts_with("own-talk-like-a-pirate-"));
        assert!(own_id("!!!").starts_with("own-"));
        assert!(valid_id(&own_id("Ünïcode name")));
    }

    #[test]
    fn only_our_mix_files_reach_the_engine() {
        let dir = tempfile::tempdir().unwrap();
        let mix = dir.path().join("mix");
        std::fs::create_dir_all(&mix).unwrap();
        let good = mix.join("0123abcd.gguf");
        std::fs::write(&good, b"x").unwrap();
        assert!(mix_path_is_ours(dir.path(), &good.to_string_lossy()));
        let other = dir.path().join("0123abcd.gguf");
        std::fs::write(&other, b"x").unwrap();
        assert!(!mix_path_is_ours(dir.path(), &other.to_string_lossy()));
        assert!(!mix_path_is_ours(dir.path(), &mix.join("evil;rm.gguf").to_string_lossy()));
        assert!(!mix_path_is_ours(dir.path(), &mix.join("ffff.gguf").to_string_lossy()), "missing file");
    }

    fn setup_vector(root: &Path, model: &str, id: &str, unit: f32) {
        let mut cv = cvec::ControlVector::new(4);
        cv.layers.insert(2, vec![1.0, 0.0, 0.0, 0.0]);
        cvec::write(&vectors_dir(root, model).join(format!("{id}.gguf")), &cv, "qwen2", 5).unwrap();
        let meta = VectorMeta {
            id: id.into(), kind: "preset".into(), name: id.into(), left: "a".into(), right: "b".into(), unit, built_at: 1,
            more: vec![], less: vec![], feature: None, sae: None,
        };
        save_meta(root, model, &meta).unwrap();
    }

    #[test]
    fn mix_scales_by_the_measured_unit_and_zero_is_no_vector() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("m.gguf");
        std::fs::write(&model, b"model").unwrap();
        let model = model.to_string_lossy().into_owned();
        setup_vector(dir.path(), &model, "creative", 0.8);
        setup_vector(dir.path(), &model, "casual", 2.0);
        let e = |id: &str, s: f32| Entry { id: id.into(), strength: s };
        assert!(mix(dir.path(), &model, 4, &[e("creative", 0.0), e("casual", 0.0)]).unwrap().is_none());
        assert!(mix(dir.path(), &model, 4, &[]).unwrap().is_none());
        let m = mix(dir.path(), &model, 4, &[e("creative", 0.5), e("casual", -0.25)]).unwrap().unwrap();
        assert!((m.layers[&2][0] - (0.4 - 0.5)).abs() < 1e-6);
        // Out of range is clamped, not multiplied.
        let m = mix(dir.path(), &model, 4, &[e("creative", 7.0)]).unwrap().unwrap();
        assert!((m.layers[&2][0] - 0.8).abs() < 1e-6);
        assert!(mix(dir.path(), &model, 4, &[e("missing", 0.5)]).is_err());
    }

    #[test]
    fn the_same_sliders_give_the_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut cv = cvec::ControlVector::new(4);
        cv.layers.insert(1, vec![0.5; 4]);
        let a = write_mix(dir.path(), &cv, "x", 3).unwrap();
        let b = write_mix(dir.path(), &cv, "x", 3).unwrap();
        assert_eq!(a, b);
        cv.layers.insert(1, vec![0.6; 4]);
        assert_ne!(a, write_mix(dir.path(), &cv, "x", 3).unwrap());
        assert!(mix_path_is_ours(dir.path(), &a));
    }

    #[test]
    fn the_engine_argv_carries_the_mix_and_only_then() {
        use crate::commands::engine::{server_args, EngineTuning};
        let plain = server_args("/m.gguf", &EngineTuning::default(), 8127, None, None, None, false);
        assert!(!plain.iter().any(|a| a == "--control-vector"));
        let tuning = EngineTuning { control_vector: Some("/data/neuron/mix/ab12.gguf".into()), ..EngineTuning::default() };
        let steered = server_args("/m.gguf", &tuning, 8127, None, None, None, false);
        let at = steered.iter().position(|a| a == "--control-vector").unwrap();
        assert_eq!(steered[at + 1], "/data/neuron/mix/ab12.gguf");
        // A different mix is a different request, so the engine restarts.
        assert_ne!(plain, steered);
        // Settings cannot smuggle a path in: the field is never read from JSON.
        let from_json: EngineTuning = serde_json::from_str(r#"{"controlVector":"/etc/x.gguf","control_vector":"/etc/y.gguf"}"#).unwrap();
        assert_eq!(from_json.control_vector, None);
    }

    #[test]
    fn model_key_separates_files_of_one_name() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("Qwen 2.5.gguf");
        std::fs::write(&a, b"12345").unwrap();
        let k = model_key(&a.to_string_lossy());
        assert_eq!(k, "qwen_2.5-5");
        std::fs::write(&a, b"123456").unwrap();
        assert_ne!(k, model_key(&a.to_string_lossy()));
    }
}
