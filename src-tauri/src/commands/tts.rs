//! Local neural Text-to-Speech via Piper (rhasspy/piper, `piper-tts` on PyPI).
//!
//! 100% local — no cloud. We shell out to the same Python LU installs
//! faster-whisper into (ComfyUI venv → system Python) running the Piper CLI
//! one-shot per utterance: `python -m piper -m voice.onnx -c voice.onnx.json
//! -f out.wav` with the text on stdin. One-shot (vs a persistent server) costs
//! ~1-2 s of ONNX model load per "speak", which is acceptable for chat TTS and
//! avoids a long-lived process + version-specific Python API. Voice models are
//! downloaded on demand into `<app_data>/piper_voices/`.

use crate::os_error;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use tauri::{Manager, State};

use crate::state::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The default Piper voice LU downloads + speaks with. Medium-quality English,
/// ~63 MB. Files land in `<app_data>/piper_voices/`.
pub const PIPER_VOICE: &str = "en_US-lessac-medium";

/// Reject voice names that aren't a plain Piper voice id (defence-in-depth — the
/// name is interpolated into a download URL + a file path). Real ids look like
/// `en_US-lessac-medium` / `en_GB-alba-medium`.
fn is_valid_voice(voice: &str) -> bool {
    !voice.is_empty()
        && voice.len() < 64
        && voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn piper_voices_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", crate::os_error::english(&e)))?
        .join("piper_voices");
    Ok(dir)
}

/// `(model.onnx, model.onnx.json)` for a voice id under the piper_voices dir.
pub fn piper_voice_paths(app: &tauri::AppHandle, voice: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = piper_voices_dir(app)?;
    Ok((
        dir.join(format!("{}.onnx", voice)),
        dir.join(format!("{}.onnx.json", voice)),
    ))
}

/// A voice is only usable when BOTH halves are on disk and non-empty. Piper
/// needs the config next to the model, and `synthesize` refuses without it —
/// but the badge, the picker and the download check all used to look at the
/// `.onnx` alone. A voice whose config never landed therefore read as installed
/// everywhere while every read-aloud failed with `no_voice` and fell back to the
/// system voice: green check, chosen voice, still Microsoft George (#77).
pub(crate) fn voice_is_complete(app: &tauri::AppHandle, voice: &str) -> bool {
    match piper_voices_dir(app) {
        Ok(dir) => voice_is_complete_in(&dir, voice),
        Err(_) => false,
    }
}

/// The AppHandle-free half, so the rule behind #77 can actually be tested.
pub(crate) fn voice_is_complete_in(dir: &std::path::Path, voice: &str) -> bool {
    let nonempty = |p: PathBuf| std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false);
    nonempty(dir.join(format!("{}.onnx", voice))) && nonempty(dir.join(format!("{}.onnx.json", voice)))
}

/// Whether neural TTS is usable: the `piper` package is installed AND a voice
/// model is present. The Settings badge + the chat SpeakerButton gate on this.
#[tauri::command]
pub fn tts_status(
    voice: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let python = crate::commands::install::resolve_lu_python(state.inner());

    let mut piper_importable = false;
    if !python.is_empty() && crate::python::is_real_python(&python) {
        let mut cmd = Command::new(&python);
        // find_spec, not a full `import piper`, so the badge stays a cheap
        // installability check that can't stall on a heavy import (mirrors
        // whisper_package_installed — see #78).
        cmd.args([
            "-c",
            "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('piper') else 1)",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        piper_importable = cmd.output().map(|o| o.status.success()).unwrap_or(false);
    }

    // Ready if the SELECTED voice is complete — or, when the caller names none,
    // if any complete voice exists. Checking "any .onnx anywhere" (#77, first
    // pass) still lied twice over: a half-downloaded voice counted, and a user
    // who picked voice B while only voice A was on disk got a green badge for a
    // voice that could never speak.
    let voice_ready = match voice.as_deref().filter(|v| is_valid_voice(v)) {
        Some(v) => voice_is_complete(&app, v),
        None => installed_voice_ids(&app).iter().any(|v| voice_is_complete(&app, v)),
    };

    Ok(serde_json::json!({
        "available": piper_importable && voice_ready,
        "piper": piper_importable,
        "voice": voice_ready,
    }))
}

/// Voice ids already downloaded under the piper_voices dir (file stems of the
/// `*.onnx` models). The Settings picker marks these as installed.
#[tauri::command]
pub fn installed_piper_voices(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // Only voices that can actually speak — a model without its config would
    // otherwise show up as installed and then fail at synthesis time.
    Ok(installed_voice_ids(&app)
        .into_iter()
        .filter(|v| voice_is_complete(&app, v))
        .collect())
}

/// Every voice id that has a `.onnx` in the voices dir, complete or not.
fn installed_voice_ids(app: &tauri::AppHandle) -> Vec<String> {
    match piper_voices_dir(app) {
        Ok(dir) => installed_voice_ids_in(&dir),
        Err(_) => vec![],
    }
}

fn installed_voice_ids_in(dir: &std::path::Path) -> Vec<String> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".onnx") {
                out.push(stem.to_string());
            }
        }
    }
    out
}

/// Download a specific Piper voice model into the piper_voices dir. Blocking —
/// the frontend awaits it with a spinner (no separate progress channel; a voice
/// is ~63 MB). Idempotent: re-downloading an existing voice just no-ops fast.
#[tauri::command]
pub async fn download_voice(
    voice: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !is_valid_voice(&voice) {
        return Err(format!("invalid voice id: {}", voice));
    }
    // Resolve the interpreter while we still hold the State borrow, then hand
    // owned values to the blocking pool: the download itself is tens of MB over
    // the network and used to run on the Tauri MAIN thread, so the window was
    // frozen for the whole transfer.
    let python = crate::commands::install::resolve_lu_python(state.inner());
    if python.is_empty() || !crate::python::is_real_python(&python) {
        return Err("no_python: install Python first.".to_string());
    }
    tokio::task::spawn_blocking(move || download_voice_blocking(voice, python, app))
        .await
        .map_err(|e| format!("download_voice task: {e}"))?
}

fn download_voice_blocking(
    voice: String,
    python: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let dir = piper_voices_dir(&app)?;
    let _ = std::fs::create_dir_all(&dir);

    let mut cmd = Command::new(&python);
    cmd.args([
        "-m",
        "piper.download_voices",
        &voice,
        "--download-dir",
        &dir.to_string_lossy(),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("could not start voice download: {}", os_error::english(&e)))?;
    if !output.status.success() {
        return Err(format!("voice download failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    // Verify BOTH halves. The downloader exiting 0 with only the model on disk
    // is the state that made the badge green while synthesis kept failing (#77).
    let (onnx, config) = piper_voice_paths(&app, &voice)?;
    if !onnx.exists() {
        return Err("voice download reported success but the model is missing".to_string());
    }
    if !voice_is_complete(&app, &voice) {
        let _ = std::fs::remove_file(&onnx);
        let _ = std::fs::remove_file(&config);
        return Err(format!(
            "the '{}' voice downloaded incomplete (its config file is missing) — try again",
            voice
        ));
    }
    Ok(serde_json::json!({ "ok": true, "voice": voice }))
}

/// Synthesize `text` to a WAV and return it base64-encoded for the frontend to
/// play. `voice` is an optional Piper voice id (defaults to PIPER_VOICE). Runs
/// the Piper CLI one-shot.
#[tauri::command]
pub async fn synthesize(
    text: String,
    voice: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    // Piper is a cold-started Python process: importing onnxruntime and loading
    // the voice takes seconds, and read-aloud calls this once per chunk. As a
    // sync #[command] every one of those seconds was spent on the Tauri main
    // thread with the window frozen — the same class fixed for the engine and
    // the agent tools.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        synthesize_blocking(text, voice, &state, &app)
    })
    .await
    .map_err(|e| format!("Speech task failed to run: {e}"))?
}

fn synthesize_blocking(
    text: String,
    voice: Option<String>,
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".to_string());
    }

    let voice = match voice {
        Some(v) if is_valid_voice(&v) => v,
        _ => PIPER_VOICE.to_string(),
    };

    let python = crate::commands::install::resolve_lu_python(state.inner());
    if python.is_empty() || !crate::python::is_real_python(&python) {
        return Err("no_python: install Python first.".to_string());
    }

    let (onnx, config) = piper_voice_paths(app, &voice)?;
    if !onnx.exists() || !config.exists() {
        return Err(format!(
            "no_voice: the '{}' voice isn't downloaded — pick/install it in Settings → Voice & Remote.",
            voice
        ));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_wav = std::env::temp_dir().join(format!("lu-tts-{}.wav", stamp));

    let mut cmd = Command::new(&python);
    cmd.args([
        "-m",
        "piper",
        "-m",
        &onnx.to_string_lossy(),
        "-c",
        &config.to_string_lossy(),
        "-f",
        &out_wav.to_string_lossy(),
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start piper: {}", os_error::english(&e)))?;
    // Feed stdin from its own thread. Writing the whole text inline and only
    // then draining piper's pipes deadlocks once the text outgrows the pipe
    // buffer: piper blocks writing its log while we block writing the text.
    // The thread ends by dropping stdin, which is what tells piper to start.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("piper wait failed: {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&out_wav);
        return Err(format!(
            "piper synthesis failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let bytes = std::fs::read(&out_wav).map_err(|e| format!("read wav: {}", os_error::english(&e)))?;
    let _ = std::fs::remove_file(&out_wav);
    if bytes.is_empty() {
        return Err("piper produced an empty WAV".to_string());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "audio_base64": b64, "mime": "audio/wav" }))
}

/// Synthesize `text` via a user-configured external HTTP TTS engine and return
/// it base64-encoded for the frontend to play (GitHub #58). The endpoint is an
/// OpenAI-compatible `/v1/audio/speech` URL — e.g. Kokoro-FastAPI on
/// `http://localhost:8880/v1/audio/speech`, or any OpenAI-compatible TTS server.
///
/// SSRF note: unlike `proxy::fetch_external`, this deliberately does NOT run the
/// localhost/private-IP block. The endpoint comes from the Settings UI (the
/// user's own voice config), never from model output or chat content, so there
/// is no attacker-controlled-URL vector — and pointing at a LOCAL engine
/// (localhost:8880) is the entire point, exactly like LU's local Ollama /
/// ComfyUI / LM Studio connections.
#[tauri::command]
pub async fn synthesize_external(
    text: String,
    url: String,
    voice: Option<String>,
) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".to_string());
    }

    // Light validation only — must be a well-formed http(s) URL. Localhost/LAN
    // is allowed on purpose (see the SSRF note above).
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("invalid TTS endpoint URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("TTS endpoint must be http or https, got '{}'", other)),
    }

    // OpenAI-compatible engines require a voice. Default to OpenAI's "alloy";
    // Kokoro users set their own (e.g. "af_bella") in Settings.
    let voice = voice
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "alloy".to_string());

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // OpenAI-compatible TTS request body. Kokoro-FastAPI + OpenAI both accept it.
    let body = serde_json::json!({
        "model": "tts-1",
        "input": text,
        "voice": voice,
        "response_format": "wav",
    });

    let resp = client
        .post(parsed.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("external TTS request failed: {}", os_error::english(&e)))?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let detail = resp.text().await.unwrap_or_default();
        let snippet: String = detail.chars().take(200).collect();
        return Err(format!("external TTS HTTP {}: {}", code, snippet));
    }

    // Honor whatever audio type the engine returns (wav/mp3/…). The browser
    // <audio> element plays both from a data URL, so pass the Content-Type
    // through as the mime instead of forcing a single format.
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        .filter(|s| s.starts_with("audio/"))
        .unwrap_or_else(|| "audio/wav".to_string());

    let bytes = resp.bytes().await.map_err(|e| os_error::english(&e))?;
    if bytes.is_empty() {
        return Err("external TTS returned no audio".to_string());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "audio_base64": b64, "mime": mime }))
}

#[cfg(test)]
mod voice_completeness_tests {
    use super::*;
    use std::fs;

    fn voices_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lu-tts-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    /// #77 in one assertion: the badge, the picker and the download check all
    /// looked at the `.onnx` alone, so a voice whose config never landed read as
    /// installed everywhere while every read-aloud fell back to the system voice.
    #[test]
    fn a_voice_without_its_config_is_not_complete() {
        let dir = voices_dir("noconfig");
        fs::write(dir.join("en_US-lessac-medium.onnx"), b"model bytes").unwrap();

        assert!(
            !voice_is_complete_in(&dir, "en_US-lessac-medium"),
            "a model without its .onnx.json must never read as usable",
        );
        // It IS still listed by the raw scan — that is the contract; both
        // callers filter it out afterwards.
        assert_eq!(installed_voice_ids_in(&dir), vec!["en_US-lessac-medium"]);

        fs::write(dir.join("en_US-lessac-medium.onnx.json"), b"{}").unwrap();
        assert!(voice_is_complete_in(&dir, "en_US-lessac-medium"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A torn download leaves a 0-byte file. Present-but-empty must not count,
    /// or the same green-check-that-cannot-speak comes back.
    #[test]
    fn an_empty_half_does_not_count() {
        let dir = voices_dir("empty");
        fs::write(dir.join("v.onnx"), b"model").unwrap();
        fs::write(dir.join("v.onnx.json"), b"").unwrap();
        assert!(!voice_is_complete_in(&dir, "v"), "0-byte config counted as usable");

        fs::write(dir.join("w.onnx"), b"").unwrap();
        fs::write(dir.join("w.onnx.json"), b"{}").unwrap();
        assert!(!voice_is_complete_in(&dir, "w"), "0-byte model counted as usable");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_voice_and_a_missing_dir_are_both_incomplete() {
        let dir = voices_dir("missing");
        assert!(!voice_is_complete_in(&dir, "not-downloaded"));
        assert!(installed_voice_ids_in(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
        assert!(!voice_is_complete_in(&dir, "anything"), "gone dir must not be complete");
        assert!(installed_voice_ids_in(&dir).is_empty());
    }

    /// The scan keys on `.onnx`; a stray config without its model is not a voice.
    #[test]
    fn a_config_alone_is_not_listed_as_a_voice() {
        let dir = voices_dir("orphan");
        fs::write(dir.join("orphan.onnx.json"), b"{}").unwrap();
        assert!(installed_voice_ids_in(&dir).is_empty(), "listed a config as a voice");
        assert!(!voice_is_complete_in(&dir, "orphan"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The id is interpolated into a download URL and a file path.
    #[test]
    fn voice_ids_that_are_not_plain_piper_ids_are_refused() {
        for bad in ["", "../../etc/passwd", "a/b", "a b", "a;rm -rf /", &"x".repeat(64)] {
            assert!(!is_valid_voice(bad), "accepted {bad:?}");
        }
        for good in ["en_US-lessac-medium", "en_GB-alba-medium", "de_DE-thorsten-high"] {
            assert!(is_valid_voice(good), "refused {good:?}");
        }
    }
}
