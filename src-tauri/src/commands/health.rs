// B7 — system_health Tauri command. Returns a structured probe of every
// local backend LU cares about plus a couple of host facts, so the
// Settings → Troubleshoot panel can render an "everything in one
// glance" diagnostic. Each probe is bounded by a short HTTP timeout and
// classified into one of `ok` / `unreachable` / `not_installed` /
// `error` so the UI can colour-code without re-parsing strings.
//
// This is intentionally a one-shot synchronous probe (300 ms per
// backend, ~1 s total worst case) — Settings opens infrequently and a
// long-lived background poll would be more code for less value. The
// v2.4.5 "60s actionable ComfyUI panel" stays where it is; this is the
// broader picture.

use crate::state::AppState;
use serde::Serialize;
use std::process::Command;
use std::time::Duration;
use sysinfo::{Disks, System};
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // NotInstalled reserved for future "binary not on PATH" probes
pub enum ProbeStatus {
    Ok,
    Unreachable,
    NotInstalled,
    Error,
}

#[derive(Debug, Serialize)]
pub struct BackendProbe {
    pub status: ProbeStatus,
    /// Free-form detail (HTTP status code, error string head). Empty when ok.
    pub detail: String,
    /// Endpoint that was probed. Useful for the "wait, was I looking at
    /// the wrong port?" debugging case.
    pub endpoint: String,
}

#[derive(Debug, Serialize)]
pub struct HostFacts {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_count: u32,
    /// Total physical memory, in GB rounded to 1 decimal.
    pub ram_gb: f64,
    /// Free disk space on the LU install drive, in GB.
    pub disk_free_gb: f64,
    /// Total VRAM of the (highest-memory) NVIDIA GPU, in GB rounded to 1
    /// decimal. `None` when nvidia-smi is absent / non-NVIDIA GPU / probe
    /// fails — the UI renders "—" in that case. Same soft-fail posture as
    /// the backend probes: a missing GPU never errors the whole report.
    pub vram_total_gb: Option<f64>,
    /// Free VRAM right now, in GB. `None` under the same conditions as
    /// `vram_total_gb`.
    pub vram_free_gb: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct SystemHealthReport {
    pub version: String,
    pub host: HostFacts,
    pub ollama: BackendProbe,
    pub comfyui: BackendProbe,
    pub lm_studio: BackendProbe,
}

// NOTE: this is `async` and uses the ASYNC reqwest client on purpose.
// system_health is a `#[tauri::command] async fn`, so its body runs on a
// tokio worker thread. `reqwest::blocking` builds (and on drop, tears down)
// its own internal runtime; doing that from inside an async context panics
// with "Cannot drop a runtime in a context where blocking is not allowed",
// the command future is aborted, and the IPC response is never sent — the
// Troubleshoot panel then hangs on "Probing…" forever. The async client
// shares the existing runtime and has no such problem.
async fn probe_http(url: &str) -> BackendProbe {
    let endpoint = url.to_string();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return BackendProbe {
                status: ProbeStatus::Error,
                detail: format!("client build failed: {}", e),
                endpoint,
            };
        }
    };
    match client.get(url).send().await {
        Ok(resp) => {
            let code = resp.status();
            if code.is_success() {
                BackendProbe { status: ProbeStatus::Ok, detail: String::new(), endpoint }
            } else {
                BackendProbe {
                    status: ProbeStatus::Error,
                    detail: format!("HTTP {}", code.as_u16()),
                    endpoint,
                }
            }
        }
        Err(e) => {
            // Connection-refused is the dominant "backend not running"
            // case — we classify it as `unreachable` instead of `error`
            // so the UI can render a friendlier hint.
            let msg = e.to_string();
            let head = msg.chars().take(160).collect::<String>();
            // `is_connect()` covers connection-refused / timeout-on-connect
            // cross-platform (Windows reports "os error 10061 / actively
            // refused", not the Unix "Connection refused" string). A request
            // timeout (backend up but wedged) also reads as "not usable now",
            // so we treat both as Unreachable for a friendlier UI hint.
            if e.is_connect() || e.is_timeout()
                || msg.contains("Connection refused")
                || msg.contains("ConnectFailed")
                || msg.contains("actively refused")
            {
                BackendProbe { status: ProbeStatus::Unreachable, detail: head, endpoint }
            } else {
                BackendProbe { status: ProbeStatus::Error, detail: head, endpoint }
            }
        }
    }
}

// ── VRAM probe (§17 — "disk/VRAM" host facts) ───────────────────────────────

/// Parse `nvidia-smi --query-gpu=memory.total,memory.free
/// --format=csv,noheader,nounits` output. Each line is one GPU:
/// `"24576, 23000"` (values in MiB, `nounits` strips the " MiB"). Returns
/// `(total_gb, free_gb)` for the GPU with the most total memory — picking the
/// biggest card matches the "what can I fit a model into?" question and
/// mirrors the ComfyUI installer taking the highest compute-cap across GPUs.
///
/// Returns `None` on empty / unparseable output. Conversion uses 1024 MiB =
/// 1 GiB (nvidia-smi reports MiB), rounded to 1 decimal to match ram_gb.
fn parse_nvidia_vram_csv(s: &str) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split(',').map(|p| p.trim());
        let total_mib = parts.next().and_then(|t| t.parse::<f64>().ok());
        let free_mib = parts.next().and_then(|f| f.parse::<f64>().ok());
        let Some(total_mib) = total_mib else { continue };
        // free may be absent if the caller only queried memory.total; default 0.
        let free_mib = free_mib.unwrap_or(0.0);
        let to_gb = |mib: f64| (mib / 1024.0 * 10.0).round() / 10.0;
        let candidate = (to_gb(total_mib), to_gb(free_mib));
        if best.map(|(bt, _)| candidate.0 > bt).unwrap_or(true) {
            best = Some(candidate);
        }
    }
    best
}

/// Run nvidia-smi and return `(total_gb, free_gb)` for the biggest GPU, or
/// `None` on any failure (no nvidia-smi, non-NVIDIA box, non-zero exit,
/// unparseable output). Soft-fail like the HTTP probes — a short window is
/// fine since this is one local subprocess, but we still hide the console
/// window on Windows so it doesn't flash.
fn query_nvidia_vram() -> Option<(f64, f64)> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=memory.total,memory.free",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Bounded: every OTHER probe in this report has a timeout, but this one
    // used Command::output() and a wedged driver makes nvidia-smi hang for
    // minutes — leaving the Troubleshoot panel spinning on exactly the machine
    // whose owner opened it because something was wrong.
    let s = crate::commands::shell::output_bounded(cmd, Duration::from_secs(3))?;
    parse_nvidia_vram_csv(&s)
}

fn collect_host_facts() -> HostFacts {
    let mut sys = System::new_all();
    sys.refresh_memory();
    let total_kb = sys.total_memory(); // bytes in sysinfo 0.33
    let ram_gb = (total_kb as f64) / 1_073_741_824.0;
    let cpu_count = num_cpus::get() as u32;
    let os = std::env::consts::OS.to_string();
    let os_version = System::os_version().unwrap_or_else(|| "unknown".to_string());
    let arch = std::env::consts::ARCH.to_string();
    // Free space on the drive that holds $HOME (or the closest mount
    // point sysinfo reports for it). Covers the "is the model dir
    // running out?" question without needing a separate probe.
    let disk_free_gb = {
        let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        let disks = Disks::new_with_refreshed_list();
        // Pick the longest mount-point prefix that matches HOME — that's
        // the drive HOME actually lives on (vs. some unrelated drive
        // sysinfo also enumerated).
        let mut best: Option<(usize, u64)> = None;
        for disk in disks.list() {
            let mp = disk.mount_point();
            if let Some(s) = mp.to_str() {
                if home.starts_with(s) {
                    let len = s.len();
                    if best.map(|(b, _)| len > b).unwrap_or(true) {
                        best = Some((len, disk.available_space()));
                    }
                }
            }
        }
        let bytes = best.map(|(_, b)| b).unwrap_or(0);
        (bytes as f64) / 1_073_741_824.0
    };
    let (vram_total_gb, vram_free_gb) = match query_nvidia_vram() {
        Some((total, free)) => (Some(total), Some(free)),
        None => (None, None),
    };
    HostFacts {
        os,
        os_version,
        arch,
        cpu_count,
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        disk_free_gb: (disk_free_gb * 10.0).round() / 10.0,
        vram_total_gb,
        vram_free_gb,
    }
}

#[tauri::command]
pub async fn system_health(_state: State<'_, AppState>) -> Result<SystemHealthReport, String> {
    // Probe all three backends concurrently — each is bounded by a 300 ms
    // client timeout, so worst case is ~300 ms total instead of 900 ms
    // serial. Async client (see probe_http note) — never reqwest::blocking
    // here.
    let (ollama, comfyui, lm_studio) = tokio::join!(
        probe_http("http://127.0.0.1:11434/api/tags"),
        probe_http("http://127.0.0.1:8188/system_stats"),
        probe_http("http://127.0.0.1:1234/v1/models"),
    );

    // collect_host_facts is blocking (sysinfo refresh + nvidia-smi
    // subprocess). Run it off the async worker so it neither stalls the
    // runtime nor — like reqwest::blocking — panics inside it.
    let host = tokio::task::spawn_blocking(collect_host_facts)
        .await
        .map_err(|e| format!("host facts probe failed: {}", e))?;

    Ok(SystemHealthReport {
        version: env!("CARGO_PKG_VERSION").to_string(),
        host,
        ollama,
        comfyui,
        lm_studio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_nvidia_vram_csv (§17 — VRAM host fact) ────────────────────────

    #[test]
    fn vram_parses_single_gpu_total_and_free() {
        // 24576 MiB = 24 GiB, 23000 MiB ≈ 22.5 GiB
        assert_eq!(parse_nvidia_vram_csv("24576, 23000\n"), Some((24.0, 22.5)));
    }

    #[test]
    fn vram_parses_without_trailing_newline() {
        assert_eq!(parse_nvidia_vram_csv("8192, 4096"), Some((8.0, 4.0)));
    }

    #[test]
    fn vram_multi_gpu_picks_largest_total() {
        // 8 GiB card then 24 GiB card — biggest (24) wins, with its own free.
        let out = "8192, 1024\n24576, 20480\n";
        assert_eq!(parse_nvidia_vram_csv(out), Some((24.0, 20.0)));
    }

    #[test]
    fn vram_tolerates_total_only_lines() {
        // memory.free omitted → free defaults to 0.
        assert_eq!(parse_nvidia_vram_csv("16384\n"), Some((16.0, 0.0)));
    }

    #[test]
    fn vram_skips_blank_and_unparseable_lines() {
        let out = "\n[N/A]\n12288, 6144\n";
        assert_eq!(parse_nvidia_vram_csv(out), Some((12.0, 6.0)));
    }

    #[test]
    fn vram_returns_none_for_empty_output() {
        assert_eq!(parse_nvidia_vram_csv(""), None);
        assert_eq!(parse_nvidia_vram_csv("\n  \n"), None);
    }

    #[test]
    fn vram_rounds_to_one_decimal() {
        // 11264 MiB = 11.0 GiB exactly; 6000 MiB ≈ 5.859 → 5.9
        assert_eq!(parse_nvidia_vram_csv("11264, 6000"), Some((11.0, 5.9)));
    }
}
