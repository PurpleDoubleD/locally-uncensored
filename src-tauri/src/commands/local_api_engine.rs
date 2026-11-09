//! The LU Engine lane of the local API: which models it offers, and loading
//! one when a client asks for it.
//!
//! ── WHY THIS FILE EXISTS (C57, 3.1.0) ──────────────────────────────────────
//!
//! From 3.0.9 on, `GET /v1/models` of the local API listed Ollama and LM Studio
//! but no LU Engine model (GitHub Discussion #225, Discord: SillyTavern shows
//! "no model loaded"). The cause: 3.0.9 moved the engine to llama.cpp b11960,
//! and b11960 took `/models` and `/v1/models` off its list of addresses that
//! answer without a key (b9949 `server-http.cpp` had them public, b11960 keeps
//! only `/health` and `/v1/health`). LU starts every engine with a key
//! (engine_key.rs, since 3.0.7). The chat forwarding put that key on its
//! requests, the model listing did not, got a 401, and read it as "no models".
//!
//! And even before that, the lane only knew what a running llama-server says
//! about itself: one model, the loaded one, or nothing when the engine was
//! stopped (idle unload, nothing chosen yet). Ollama lists everything that is
//! installed and loads on the first request. That is the yardstick here:
//!
//!   * `/v1/models` lists every installed chat GGUF of the LU Engine (the same
//!     scan the Models page shows) plus the loaded one, under `lu/<name>`.
//!   * A chat or completion for a model that is not loaded loads it first.
//!     The request waits for the load, like Ollama's first request. A load
//!     that fails ends in one clear error (`model_load_failed`), never in a
//!     dead port or a crash.
//!   * A model swap waits until the engine has finished what it is doing
//!     (`/slots`), so neither an API client nor the app's own chat loses an
//!     answer half way through. Ollama with one model slot behaves the same.

use std::sync::Arc;
use std::time::Duration;

/// One installed LU Engine model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineModell {
    /// The file name without `.gguf` (first part of a split set: the base).
    /// The same name the Models page shows; the API offers it as `lu/<name>`.
    pub name: String,
    pub path: String,
}

/// What the local API needs from the app to serve the LU Engine lane.
///
/// A trait so the tests can stand in a fake engine; the app's implementation
/// is `AppEngine` below.
pub trait EngineHost: Send + Sync {
    /// Every installed chat model. Blocking (walks folders).
    fn installiert(&self) -> Vec<EngineModell>;
    /// The chat model the engine holds right now: (path, port).
    fn geladen(&self) -> Option<(String, u16)>;
    /// Load `path` (stop what runs, start this). Blocking, can take a while.
    /// `Ok(port)` when the engine is up and answers.
    fn laden(&self, path: &str) -> Result<u16, String>;
}

/// Embedding GGUFs are no chat model. Same patterns as the chat picker's
/// filter (`isEmbeddingGgufName` in src/api/engine.ts).
pub fn ist_embedding_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["embed", "nomic-embed", "bge-", "e5-", "gte-", "sentence-"].iter().any(|p| n.contains(p))
}

/// The name an LU Engine model has in the API, from its path.
pub fn name_aus_pfad(path: &str) -> String {
    crate::commands::proxy::builtin_model_name_from_path(path)
}

/// The engine lane's catalogue: every installed chat model, the loaded one
/// included even when it lies outside the scanned folders. Sorted by name,
/// each name once.
pub fn engine_katalog(installiert: &[EngineModell], geladen: Option<&str>) -> Vec<EngineModell> {
    let mut raus: Vec<EngineModell> = installiert.iter().filter(|m| !ist_embedding_name(&m.name)).cloned().collect();
    if let Some(p) = geladen {
        let name = name_aus_pfad(p);
        if !name.is_empty() && !raus.iter().any(|m| m.name == name) {
            raus.push(EngineModell { name, path: p.to_string() });
        }
    }
    raus.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    raus.dedup_by(|a, b| a.name == b.name);
    raus
}

/// 3.0.8 offered the loaded model under the id llama-server gives it: the full
/// path (`lu//Users/x/.../Qwen.gguf`). A client that saved that id keeps
/// working: a path after `lu/` is read as the model it names.
pub fn alte_engine_id_lesen(requested: &str) -> Option<String> {
    let rest = requested.trim().strip_prefix("lu/")?;
    let sieht_aus_wie_pfad = rest.contains('/') || rest.contains('\\') || rest.to_ascii_lowercase().ends_with(".gguf");
    if !sieht_aus_wie_pfad {
        return None;
    }
    let name = name_aus_pfad(rest);
    (!name.is_empty()).then(|| format!("lu/{}", name))
}

/// Why a model could not be made ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LadeFehler {
    /// The engine stayed busy with another model's answer for too long.
    Belegt { name: String, sekunden: u64 },
    /// The start itself failed; the engine's own words.
    Start { name: String, grund: String },
}

impl LadeFehler {
    pub fn message(&self) -> String {
        match self {
            LadeFehler::Belegt { name, sekunden } => format!(
                "The LU Engine is still answering with another model, so 'lu/{}' could not be loaded within {} s. Send the request again when that answer is done.",
                name, sekunden
            ),
            LadeFehler::Start { name, grund } => format!(
                "The LU Engine could not load 'lu/{}': {}. Open LU → Models to load it by hand and see the details.",
                name,
                grund.trim().trim_end_matches('.')
            ),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            LadeFehler::Belegt { .. } => "engine_busy",
            LadeFehler::Start { .. } => "model_load_failed",
        }
    }
}

/// How long a swap waits for the engine to finish the answer it is writing.
pub const WARTEN_AUF_FREI: Duration = Duration::from_secs(300);
/// How long an engine that is still loading the right model is waited for.
pub const WARTEN_AUF_BEREIT: Duration = Duration::from_secs(180);

/// One request at a time decides about loading. Two clients that ask for two
/// models at once would otherwise stop each other's start.
pub type LadeSchloss = Arc<tokio::sync::Mutex<()>>;

/// The state of the loaded engine, asked over HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Zustand {
    Bereit,
    LaedtNoch,
    Weg,
}

async fn zustand(http: &reqwest::Client, port: u16) -> Zustand {
    // `/health` answers without a key in every llama.cpp LU ships.
    match http
        .get(format!("http://127.0.0.1:{}/health", port))
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Zustand::Bereit,
        Ok(r) if r.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => Zustand::LaedtNoch,
        Ok(_) => Zustand::Bereit,
        Err(_) => Zustand::Weg,
    }
}

/// Is a slot of the engine on `port` writing an answer? `/slots` wants the
/// engine key. An engine that does not say counts as free: a swap must not
/// hang on an engine that is gone.
async fn beschaeftigt(http: &reqwest::Client, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/slots", port);
    let r = http
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, super::engine_key::bearer())
        .timeout(Duration::from_secs(3))
        .send()
        .await;
    let Ok(r) = r else { return false };
    let Ok(v) = r.json::<serde_json::Value>().await else { return false };
    super::engine_idle::slot_activity(&v).map(|a| a.busy).unwrap_or(false)
}

/// Makes `ziel` the model the engine holds, and gives back the port it answers
/// on. Loads only when needed; the fast path (right model, healthy) asks the
/// engine once.
pub async fn bereitstellen(
    host: Arc<dyn EngineHost>,
    schloss: &LadeSchloss,
    http: &reqwest::Client,
    ziel: &EngineModell,
    warten_frei: Duration,
    warten_bereit: Duration,
) -> Result<u16, LadeFehler> {
    let _g = schloss.lock().await;

    if let Some((pfad, port)) = host.geladen() {
        if pfad == ziel.path || name_aus_pfad(&pfad) == ziel.name {
            let bis = tokio::time::Instant::now() + warten_bereit;
            loop {
                match zustand(http, port).await {
                    Zustand::Bereit => return Ok(port),
                    Zustand::Weg => break, // dead process: start it below
                    Zustand::LaedtNoch if tokio::time::Instant::now() < bis => {
                        tokio::time::sleep(Duration::from_millis(500)).await
                    }
                    Zustand::LaedtNoch => break,
                }
            }
        } else {
            // Another model is loaded. Let it finish what it is writing.
            let bis = tokio::time::Instant::now() + warten_frei;
            while beschaeftigt(http, port).await {
                if tokio::time::Instant::now() >= bis {
                    return Err(LadeFehler::Belegt { name: ziel.name.clone(), sekunden: warten_frei.as_secs() });
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    let pfad = ziel.path.clone();
    let h = Arc::clone(&host);
    match tokio::task::spawn_blocking(move || h.laden(&pfad)).await {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(grund)) => Err(LadeFehler::Start { name: ziel.name.clone(), grund }),
        Err(e) => Err(LadeFehler::Start { name: ziel.name.clone(), grund: format!("the start task failed: {e}") }),
    }
}

/// What the local API knows about how the app starts its engine: the folders
/// named under Storage, and the user's engine tuning. Handed over by the
/// frontend when it starts the API.
#[derive(Debug, Clone, Default)]
pub struct EngineVorgaben {
    pub ordner: Vec<String>,
    pub tuning: Option<crate::commands::engine::EngineTuning>,
}

/// The app's engine.
#[cfg(desktop)]
pub struct AppEngine {
    pub app: tauri::AppHandle,
    pub vorgaben: std::sync::RwLock<EngineVorgaben>,
}

#[cfg(desktop)]
impl EngineHost for AppEngine {
    fn installiert(&self) -> Vec<EngineModell> {
        use crate::commands::engine::{bundled_scan_dirs, builtin_models_dir, scan_gguf_roots, ScanRoot, MAX_CUSTOM_SCAN_DEPTH, MAX_SCAN_DEPTH};
        let Ok(dir) = builtin_models_dir() else { return Vec::new() };
        let ordner = self.vorgaben.read().map(|v| v.ordner.clone()).unwrap_or_default();
        let dirs = bundled_scan_dirs(&dir, &ordner);
        let roots: Vec<ScanRoot> = dirs
            .iter()
            .enumerate()
            .map(|(i, d)| ScanRoot { dir: d.as_path(), max_depth: if i == 0 { MAX_SCAN_DEPTH } else { MAX_CUSTOM_SCAN_DEPTH } })
            .collect();
        scan_gguf_roots(&roots)
            .models
            .into_iter()
            .map(|m| EngineModell { name: m.name, path: m.path })
            .collect()
    }

    fn geladen(&self) -> Option<(String, u16)> {
        use tauri::Manager;
        let st = self.app.state::<crate::state::AppState>();
        let g = st.bundled_engine.lock().ok()?;
        g.as_ref().map(|e| (e.model_path.clone(), e.port))
    }

    fn laden(&self, path: &str) -> Result<u16, String> {
        use tauri::Manager;
        let tuning = self.vorgaben.read().ok().and_then(|v| v.tuning.clone());
        let st = self.app.state::<crate::state::AppState>();
        let antwort = crate::commands::engine::start_bundled_engine_blocking(&self.app, &st, path.to_string(), tuning, None)?;
        let port = antwort
            .get("port")
            .and_then(|p| p.as_u64())
            .and_then(|p| u16::try_from(p).ok())
            .or_else(|| self.geladen().map(|(_, p)| p))
            .ok_or_else(|| "the engine started but did not say on which port".to_string())?;
        // The app's own chat needs no word: its pre-send check
        // (api/builtin-ensure.ts) asks the engine what it holds and swaps back
        // when the user's chat wants another model.
        Ok(port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(name: &str, path: &str) -> EngineModell {
        EngineModell { name: name.into(), path: path.into() }
    }

    #[test]
    fn der_katalog_fuehrt_installierte_und_geladene_modelle_ohne_embedder() {
        let inst = vec![
            m("qwen3-8b", "/m/qwen3-8b.gguf"),
            m("nomic-embed-text-v1.5.Q4_K_M", "/m/nomic-embed-text-v1.5.Q4_K_M.gguf"),
            m("Gemma-3-4b", "/m/Gemma-3-4b.gguf"),
        ];
        let k = engine_katalog(&inst, Some("/elsewhere/Llama-3.2-1B-Q4_K_M.gguf"));
        let namen: Vec<&str> = k.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(namen, vec!["Gemma-3-4b", "Llama-3.2-1B-Q4_K_M", "qwen3-8b"]);
        // The loaded one is not listed twice when it is also installed.
        let k = engine_katalog(&inst, Some("/m/qwen3-8b.gguf"));
        assert_eq!(k.iter().filter(|m| m.name == "qwen3-8b").count(), 1);
        // A split set is named after its base.
        let k = engine_katalog(&[], Some("/m/big-00001-of-00003.gguf"));
        assert_eq!(k[0].name, "big");
    }

    #[test]
    fn eine_alte_id_mit_pfad_findet_ihr_modell() {
        assert_eq!(alte_engine_id_lesen("lu//Users/x/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf").as_deref(), Some("lu/Qwen2.5-0.5B-Instruct-Q8_0"));
        assert_eq!(alte_engine_id_lesen("lu/C:\\AI\\m\\a.gguf").as_deref(), Some("lu/a"));
        assert_eq!(alte_engine_id_lesen("lu/qwen3-8b"), None);
        assert_eq!(alte_engine_id_lesen("ollama/huihui_ai/qwen3:4b"), None);
    }

    #[test]
    fn die_fehler_sagen_was_zu_tun_ist() {
        let e = LadeFehler::Start { name: "q".into(), grund: "Model file not found: /x.".into() };
        assert_eq!(e.code(), "model_load_failed");
        assert!(e.message().contains("'lu/q'") && e.message().contains("Model file not found: /x") && e.message().contains("Models"));
        let b = LadeFehler::Belegt { name: "q".into(), sekunden: 300 };
        assert_eq!(b.code(), "engine_busy");
        assert!(b.message().contains("300 s"));
    }
}
