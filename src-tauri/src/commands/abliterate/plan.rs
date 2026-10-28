//! What a refusal-removal run needs, decided before anything is downloaded.
//!
//! Pure functions only: where the original weights of a GGUF live, whether
//! its license lets LU offer the tool, which graphics device can carry the
//! run, and how much memory, disk and time it takes. The numbers are the
//! ones measured in the A14 prototype (Qwen3-4B on an M5 Pro, 20.10.2026,
//! KONZEPT-ABLITERATION.md section 1) and scaled by parameter count; the
//! dialog says they are estimates.

use crate::commands::gguf::GeneralFacts;
use serde::Serialize;

/// What LU writes into `general.description` of every model it made. The
/// model list reads it for the badge, and the tool refuses to run twice.
pub const DESCRIPTION_MARK: &str = "Refusals removed in LU";

/// Above this the local tool is not offered (concept: locally up to 14B).
/// 15 leaves room for models that round their size label down.
pub const MAX_LOCAL_PARAMS: u64 = 15_000_000_000;

// ── Where the original weights live ───────────────────────────────────────

/// `Org/Repo` from a Hugging Face URL, or None for anything else.
pub fn hf_repo_from_url(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("https://huggingface.co/")
        .or_else(|| url.trim().strip_prefix("http://huggingface.co/"))
        .or_else(|| url.trim().strip_prefix("huggingface.co/"))?;
    let mut parts = rest.split(['/', '?', '#']).filter(|p| !p.is_empty());
    let org = parts.next()?;
    let repo = parts.next()?;
    // Datasets and spaces are not models.
    if matches!(org, "datasets" | "spaces" | "api" | "docs" | "blog") {
        return None;
    }
    valid_repo_id(&format!("{org}/{repo}"))
}

/// A repo id as the hub accepts it, or None. Also the gate for what the user
/// types: it ends up in a URL path and on a command line.
pub fn valid_repo_id(id: &str) -> Option<String> {
    let id = id.trim().trim_matches('/');
    let (org, repo) = id.split_once('/')?;
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 96
            && !s.starts_with(['.', '-'])
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !s.contains("..")
    };
    (ok(org) && ok(repo)).then(|| format!("{org}/{repo}"))
}

/// A repo of GGUF files is a place the user downloaded from, never the source.
pub fn is_gguf_repo(repo: &str) -> bool {
    let r = repo.to_ascii_lowercase();
    r.ends_with("-gguf") || r.ends_with("_gguf") || r.ends_with(".gguf") || r.contains("-gguf-")
}

/// Why a repo was proposed, for the dialog.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceGuess {
    pub repo: String,
    pub from: &'static str,
}

/// A few files LU's own catalog offers whose headers carry no usable link.
/// The key is the file stem in lower case up to the quantization.
const KNOWN: &[(&str, &str)] = &[
    ("qwen3-4b-instruct-2507", "Qwen/Qwen3-4B-Instruct-2507"),
    ("qwen3-4b-thinking-2507", "Qwen/Qwen3-4B-Thinking-2507"),
    ("qwen2.5-0.5b-instruct", "Qwen/Qwen2.5-0.5B-Instruct"),
    ("qwen2.5-1.5b-instruct", "Qwen/Qwen2.5-1.5B-Instruct"),
    ("qwen2.5-7b-instruct", "Qwen/Qwen2.5-7B-Instruct"),
    ("qwen2.5-14b-instruct", "Qwen/Qwen2.5-14B-Instruct"),
    ("qwen3-0.6b", "Qwen/Qwen3-0.6B"),
    ("qwen3-1.7b", "Qwen/Qwen3-1.7B"),
    ("qwen3-4b", "Qwen/Qwen3-4B"),
    ("qwen3-8b", "Qwen/Qwen3-8B"),
    ("qwen3-14b", "Qwen/Qwen3-14B"),
    ("mistral-7b-instruct-v0.3", "mistralai/Mistral-7B-Instruct-v0.3"),
];

/// The repo to download, from what the file says about itself, in order of
/// trust. None when nothing points anywhere (the dialog then asks).
pub fn guess_source(facts: &GeneralFacts, file_stem: &str) -> Option<SourceGuess> {
    let pick = |url: Option<&str>| url.and_then(hf_repo_from_url).filter(|r| !is_gguf_repo(r));
    if let Some(repo) = pick(facts.get("general.source.repo_url")).or_else(|| pick(facts.get("general.source.url"))) {
        return Some(SourceGuess { repo, from: "source" });
    }
    // The license link is written from the original model card
    // (".../Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE").
    if let Some(repo) = pick(facts.get("general.license.link")) {
        return Some(SourceGuess { repo, from: "license" });
    }
    let stem = file_stem.to_ascii_lowercase();
    let mut known: Vec<&(&str, &str)> = KNOWN.iter().filter(|(k, _)| stem.starts_with(k)).collect();
    known.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
    if let Some((_, repo)) = known.first() {
        return Some(SourceGuess { repo: (*repo).to_string(), from: "catalog" });
    }
    // A base model is only the source when this file is not a finetune of
    // it: the official Qwen GGUFs of the Instruct models name the BASE model
    // there, and abliterating the base would hand back a different model.
    if let Some(repo) = pick(facts.get("general.base_model.0.repo_url")) {
        let fits = match facts.get("general.finetune") {
            None => true,
            Some(f) => repo.to_ascii_lowercase().contains(&f.to_ascii_lowercase()),
        };
        if fits {
            return Some(SourceGuess { repo, from: "base_model" });
        }
    }
    None
}

/// Did LU make this file?
pub fn made_by_lu(facts: &GeneralFacts) -> bool {
    facts.get("general.description").is_some_and(|d| d.starts_with(DESCRIPTION_MARK))
}

// ── License ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseKind {
    /// On the list: the tool runs without a question.
    Free,
    /// Runs locally after the user has read the note. Never in the cloud.
    Notice,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseVerdict {
    pub id: Option<String>,
    pub kind: LicenseKind,
    pub label: String,
    pub link: Option<String>,
    pub note: Option<String>,
    /// A later cloud run or a catalog copy: only for free licenses (concept 5).
    pub cloud_allowed: bool,
}

const FREE: &[(&str, &str)] = &[
    ("apache-2.0", "Apache 2.0"),
    ("mit", "MIT"),
    ("bsd-2-clause", "BSD 2-Clause"),
    ("bsd-3-clause", "BSD 3-Clause"),
    ("cc-by-4.0", "CC BY 4.0"),
    ("cc-by-sa-4.0", "CC BY-SA 4.0"),
    ("cc0-1.0", "CC0"),
    ("unlicense", "Unlicense"),
];

/// The verdict for a license id as the hub writes it (`cardData.license`,
/// or the `license:` tag), with the repo for the link.
pub fn license_verdict(id: Option<&str>, license_name: Option<&str>, repo: &str) -> LicenseVerdict {
    let link = Some(format!("https://huggingface.co/{repo}"));
    let id_lc = id.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    let Some(lc) = id_lc else {
        return LicenseVerdict {
            id: None,
            kind: LicenseKind::Notice,
            label: "No license given".into(),
            link,
            note: Some(
                "The model card names no license. Check what it allows before you change the model."
                    .into(),
            ),
            cloud_allowed: false,
        };
    };
    if let Some((_, label)) = FREE.iter().find(|(k, _)| *k == lc) {
        return LicenseVerdict {
            id: Some(lc),
            kind: LicenseKind::Free,
            label: (*label).to_string(),
            link,
            note: None,
            cloud_allowed: true,
        };
    }
    let name = license_name.map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let (label, note) = if lc.starts_with("llama") || name.contains("llama") {
        (
            "Llama Community License".to_string(),
            "Meta's license and Acceptable Use Policy keep applying to the changed copy. A copy you \
             share must start its name with \"Llama\" and say \"Built with Llama\". You are \
             responsible for staying within them.",
        )
    } else if lc == "gemma" || name.contains("gemma") {
        (
            "Gemma Terms of Use".to_string(),
            "Google's terms and its Prohibited Use Policy keep applying to the changed copy, and that \
             policy has rules about getting around safety features. Read it before you go on; you \
             are responsible for staying within it.",
        )
    } else if lc.contains("-nc") || lc.contains("noncommercial") || lc.contains("research") {
        (
            license_label(&lc, license_name),
            "This license limits how the model may be used (for example no commercial use). The \
             changed copy carries the same limits.",
        )
    } else {
        (
            license_label(&lc, license_name),
            "This is not one of the open licenses LU checks for. Read it before you change the \
             model; the changed copy carries the same terms.",
        )
    };
    LicenseVerdict { id: Some(lc), kind: LicenseKind::Notice, label, link, note: Some(note.into()), cloud_allowed: false }
}

fn license_label(id: &str, name: Option<&str>) -> String {
    match (id, name) {
        ("other", Some(n)) if !n.trim().is_empty() => n.trim().to_string(),
        _ => id.to_string(),
    }
}

// ── Devices ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Apple,
    Nvidia,
    Amd,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOption {
    /// "apple", "nvidia:0", "amd:1": what the start command gets back.
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    /// Graphics memory, or the unified memory of a Mac.
    pub memory_bytes: Option<u64>,
    /// NVIDIA compute capability, for the torch build and bf16.
    #[serde(skip)]
    pub capability: Option<(u32, u32)>,
    pub supported: bool,
    pub note: Option<String>,
}

/// Which devices the tool offers on this OS. `os` is "macos", "windows" or
/// "linux". The concept carries NVIDIA everywhere, Apple Silicon (measured)
/// and AMD on Linux (ROCm, not yet run end to end); AMD on Windows has no
/// PyTorch build the tool can rely on, and Intel is untested.
pub fn device_support(kind: DeviceKind, os: &str) -> (bool, Option<String>) {
    match (kind, os) {
        (DeviceKind::Apple, "macos") => (true, None),
        (DeviceKind::Nvidia, "windows" | "linux") => (true, None),
        (DeviceKind::Amd, "linux") => (
            true,
            Some("AMD cards run through ROCm. This has not been tested end to end yet.".into()),
        ),
        (DeviceKind::Amd, _) => (
            false,
            Some("Not on Windows yet: there is no PyTorch build for AMD cards the tool can rely on.".into()),
        ),
        _ => (false, Some("This device is not supported.".into())),
    }
}

// ── Estimates ─────────────────────────────────────────────────────────────

const GB: f64 = 1_000_000_000.0;

/// What the output is quantized to: the same type as the file it came from,
/// so the copy fits where the original fit and the check compares like with
/// like. Unknown types get Q4_K_M, the concept's default.
pub fn output_quant(file_type: Option<u32>) -> &'static str {
    match file_type {
        Some(7) => "Q8_0",
        Some(18) => "Q6_K",
        Some(17) => "Q5_K_M",
        Some(16) => "Q5_K_S",
        Some(14) => "Q4_K_S",
        Some(15) => "Q4_K_M",
        Some(1) => "F16",
        Some(32) => "BF16",
        _ => "Q4_K_M",
    }
}

/// Bytes per parameter of a quantized GGUF, roughly.
pub fn quant_bytes_per_param(quant: &str) -> f64 {
    match quant {
        "Q8_0" => 1.07,
        "Q6_K" => 0.82,
        "Q5_K_M" => 0.71,
        "Q5_K_S" => 0.69,
        "Q4_K_S" => 0.57,
        "F16" | "BF16" => 2.0,
        _ => 0.61,
    }
}

/// Can this quant be written without `llama-quantize`? The converter itself
/// writes these three.
pub fn convert_writes(quant: &str) -> Option<&'static str> {
    match quant {
        "Q8_0" => Some("q8_0"),
        "F16" => Some("f16"),
        "BF16" => Some("bf16"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Quantization {
    None,
    Bnb4bit,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub fits: bool,
    pub why_not: Option<String>,
    pub quantization: Quantization,
    pub memory_needed_bytes: u64,
    pub memory_available_bytes: Option<u64>,
    pub disk_needed_bytes: u64,
    pub disk_after_bytes: u64,
    pub disk_free_bytes: Option<u64>,
    pub download_bytes: u64,
    pub minutes_low: u64,
    pub minutes_high: u64,
    pub output_quant: String,
    pub output_bytes: u64,
    /// Heretic's batch search stops here, so the peak stays near the estimate.
    pub max_batch_size: u32,
}

pub struct EstimateInput<'a> {
    pub params: u64,
    pub download_bytes: u64,
    pub device: &'a DeviceOption,
    pub trials: u32,
    pub output_quant: &'static str,
    pub disk_free: Option<u64>,
    /// The environment still has to be installed (PyTorch and the rest).
    pub env_missing: bool,
}

/// Memory of a search in bf16: weights at 2 bytes each plus activations and
/// the adapter. Measured 19.6 GB for 4B at batch 128 and about 10-12 GB with
/// a smaller batch, so 2 x P + 3 GB with a batch of 32.
fn bf16_need(p_b: f64) -> f64 {
    2.0 * p_b + 3.0
}

/// The same with the weights loaded in 4 bit (bitsandbytes, NVIDIA): 10.1 GB
/// measured for 4B at batch 128.
fn bnb4_need(p_b: f64) -> f64 {
    0.7 * p_b + 4.0
}

/// What part of a device's memory a run may plan with. A Mac shares it with
/// everything else, and macOS lets the GPU wire about three quarters.
fn usable(device: &DeviceOption) -> Option<f64> {
    let m = device.memory_bytes? as f64 / GB;
    Some(match device.kind {
        DeviceKind::Apple => m * 0.70,
        _ => (m - 0.6).max(0.0),
    })
}

/// Seconds per trial and billion parameters. Mac: 28 s for 4B measured.
/// NVIDIA: Heretic's "RTX 3090, 4B: 20-30 min" for 100 trials, about 11 s.
/// AMD: no measurement, placed between the two.
fn secs_per_trial_per_b(kind: DeviceKind, q: Quantization) -> f64 {
    let base = match kind {
        DeviceKind::Apple => 7.0,
        DeviceKind::Nvidia => 2.8,
        DeviceKind::Amd => 4.5,
    };
    if q == Quantization::Bnb4bit { base * 1.3 } else { base }
}

/// Small models do not get faster below a point: every trial still answers
/// the same prompts. The box (RTX 3060, 0.5B) took about 25 s per trial.
fn min_secs_per_trial(kind: DeviceKind) -> f64 {
    match kind {
        DeviceKind::Apple => 12.0,
        DeviceKind::Nvidia => 20.0,
        DeviceKind::Amd => 25.0,
    }
}

pub fn estimate(input: &EstimateInput<'_>) -> Estimate {
    let p_b = input.params as f64 / GB;
    let device = input.device;
    let avail = usable(device);
    let bf16 = bf16_need(p_b);
    let bnb4 = bnb4_need(p_b);
    let (quantization, need, mem_fits) = match avail {
        Some(a) if bf16 <= a => (Quantization::None, bf16, true),
        // 4 bit is the way out on NVIDIA only: bitsandbytes is unproven on
        // ROCm here, and the prototype's 4-bit run on the Mac never got to
        // the export.
        Some(a) if device.kind == DeviceKind::Nvidia && bnb4 <= a => (Quantization::Bnb4bit, bnb4, true),
        Some(_) => (Quantization::None, bf16, false),
        // Memory unknown: go ahead in bf16 and say so in the dialog.
        None => (Quantization::None, bf16, true),
    };
    let headroom = avail.map(|a| a - need).unwrap_or(0.0);
    let max_batch_size = if headroom >= 10.0 { 128 } else if headroom >= 4.0 { 64 } else { 32 };

    let d = input.download_bytes as f64;
    let output_bytes = (input.params as f64 * quant_bytes_per_param(input.output_quant)) as u64;
    // Original, merged copy and the 16-bit GGUF lie side by side for a moment
    // (concept: about three times the download), then the output.
    let env = if input.env_missing {
        match device.kind {
            DeviceKind::Apple => 2.5 * GB,
            _ => 7.0 * GB,
        }
    } else {
        0.0
    };
    let disk_needed = (3.0 * d + output_bytes as f64 + env + 1.5 * GB) as u64;

    let per_trial = (secs_per_trial_per_b(device.kind, quantization) * p_b).max(min_secs_per_trial(device.kind));
    let search = per_trial * input.trials as f64;
    // Loading, the refusal directions, the shard merge, conversion and the
    // two checks of 100 short prompts and 200 one-letter MMLU answers each.
    let fixed = 180.0 + 60.0 * p_b + 2.0 * (90.0 + 45.0 * p_b);
    let minutes = (search + fixed) / 60.0;
    let minutes_low = (minutes * 0.7).ceil().max(5.0) as u64;
    let minutes_high = (minutes * 1.8).ceil().max(minutes_low as f64 + 5.0) as u64;

    let mut why_not = None;
    if input.params > MAX_LOCAL_PARAMS {
        why_not = Some(format!(
            "Too large for this machine: the tool runs locally for models up to 14B, this one has about {:.0}B parameters.",
            p_b
        ));
    } else if !device.supported {
        why_not = device.note.clone().or(Some("This device is not supported.".into()));
    } else if !mem_fits {
        why_not = Some(format!(
            "Too large for this machine: the run needs about {:.0} GB of {}, and {} has {:.0} GB it can use.",
            need.ceil(),
            if device.kind == DeviceKind::Apple { "memory" } else { "graphics memory" },
            device.name,
            avail.unwrap_or(0.0).floor()
        ));
    } else if let Some(free) = input.disk_free {
        if free < disk_needed {
            why_not = Some(format!(
                "Not enough free disk space: the run needs about {:.0} GB for a while, {:.0} GB are free.",
                (disk_needed as f64 / GB).ceil(),
                (free as f64 / GB).floor()
            ));
        }
    }

    Estimate {
        fits: why_not.is_none(),
        why_not,
        quantization,
        memory_needed_bytes: (need * GB) as u64,
        memory_available_bytes: avail.map(|a| (a * GB) as u64),
        disk_needed_bytes: disk_needed,
        disk_after_bytes: output_bytes,
        disk_free_bytes: input.disk_free,
        download_bytes: input.download_bytes,
        minutes_low,
        minutes_high,
        output_quant: input.output_quant.to_string(),
        output_bytes,
        max_batch_size,
    }
}

// ── Modes ─────────────────────────────────────────────────────────────────

/// The KL limit of a mode. Prototype lesson: KL 0.35 cost 3.5 MMLU points
/// while KL 0.17 removed almost as many refusals, so Balanced is 0.2.
pub fn kl_limit(mode: &str) -> Option<f64> {
    match mode {
        "gentle" => Some(0.1),
        "balanced" => Some(0.2),
        "strong" => Some(0.4),
        _ => None,
    }
}

/// 200 trials is Heretic's default and where the prototype's best trials
/// were (101-149). 100 halves the time.
pub fn valid_trials(n: u32) -> bool {
    n == 100 || n == 200
}

// ── Names ─────────────────────────────────────────────────────────────────

/// The file name of the copy, next to the original: `<stem>-refusals-removed`
/// with the quant after it, and a counter when that file exists already.
pub fn output_stem(source_stem: &str, quant: &str) -> String {
    let mut base = source_stem.to_string();
    // Drop the original's own quant suffix, the copy gets its own.
    for q in ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_K_S", "Q4_0", "F16", "BF16", "IQ4_XS"] {
        for sep in ['-', '.', '_'] {
            let suffix = format!("{sep}{q}");
            if base.to_ascii_uppercase().ends_with(&suffix.to_ascii_uppercase()) {
                base.truncate(base.len() - suffix.len());
            }
        }
    }
    format!("{base}-refusals-removed-{quant}")
}

/// The name in the model list: what the file calls itself, with the mark.
pub fn display_name(general_name: Option<&str>, stem: &str) -> String {
    format!("{} (refusals removed)", general_name.unwrap_or(stem))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn facts(pairs: &[(&str, &str)]) -> GeneralFacts {
        GeneralFacts {
            strings: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(),
            file_type: None,
        }
    }

    fn mac(mem_gb: u64) -> DeviceOption {
        DeviceOption {
            id: "apple".into(),
            kind: DeviceKind::Apple,
            name: "this Mac".into(),
            memory_bytes: Some(mem_gb * 1_000_000_000),
            capability: None,
            supported: true,
            note: None,
        }
    }

    fn nvidia(mem_gb: u64) -> DeviceOption {
        DeviceOption {
            id: "nvidia:0".into(),
            kind: DeviceKind::Nvidia,
            name: "RTX test".into(),
            memory_bytes: Some(mem_gb * 1_000_000_000),
            capability: Some((8, 9)),
            supported: true,
            note: None,
        }
    }

    #[test]
    fn the_official_qwen_gguf_points_at_the_instruct_repo_not_the_base() {
        // What Qwen2.5-0.5B-Instruct-Q8_0.gguf on the Mac says, 25.10.2026.
        let f = facts(&[
            ("general.name", "Qwen2.5 0.5B Instruct"),
            ("general.finetune", "Instruct"),
            ("general.license", "apache-2.0"),
            ("general.license.link", "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE"),
            ("general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen2.5-0.5B"),
        ]);
        let g = guess_source(&f, "Qwen2.5-0.5B-Instruct-Q8_0").unwrap();
        assert_eq!(g.repo, "Qwen/Qwen2.5-0.5B-Instruct");
        assert_eq!(g.from, "license");
    }

    #[test]
    fn a_base_model_link_of_a_finetune_is_not_taken() {
        let f = facts(&[
            ("general.finetune", "Instruct"),
            ("general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen2.5-0.5B"),
        ]);
        assert_eq!(guess_source(&f, "something-else"), None);
        let f = facts(&[
            ("general.finetune", "Instruct"),
            ("general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct"),
        ]);
        assert_eq!(guess_source(&f, "x").unwrap().repo, "Qwen/Qwen2.5-7B-Instruct");
    }

    #[test]
    fn gguf_repos_are_never_the_source() {
        let f = facts(&[("general.source.url", "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF")]);
        assert_eq!(guess_source(&f, "zzz"), None);
        assert!(is_gguf_repo("unsloth/Qwen3-4B-GGUF"));
        assert!(!is_gguf_repo("Qwen/Qwen3-4B"));
    }

    #[test]
    fn the_catalog_list_takes_the_longest_match() {
        let f = facts(&[]);
        assert_eq!(guess_source(&f, "Qwen3-4B-Instruct-2507-Q4_K_M").unwrap().repo, "Qwen/Qwen3-4B-Instruct-2507");
        assert_eq!(guess_source(&f, "Qwen3-4B-Q4_K_M").unwrap().repo, "Qwen/Qwen3-4B");
    }

    #[test]
    fn repo_ids_from_urls_and_typed_text() {
        assert_eq!(hf_repo_from_url("https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE").as_deref(), Some("Qwen/Qwen3-4B"));
        assert_eq!(hf_repo_from_url("https://huggingface.co/datasets/a/b"), None);
        assert_eq!(hf_repo_from_url("https://example.com/Qwen/Qwen3-4B"), None);
        assert_eq!(valid_repo_id(" Qwen/Qwen2.5-0.5B-Instruct ").as_deref(), Some("Qwen/Qwen2.5-0.5B-Instruct"));
        assert_eq!(valid_repo_id("../etc/passwd"), None);
        assert_eq!(valid_repo_id("a/b/c"), None);
        assert_eq!(valid_repo_id("a/b c"), None);
        assert_eq!(valid_repo_id("a/--x"), None);
    }

    #[test]
    fn free_licenses_run_without_a_question_others_need_the_note() {
        let v = license_verdict(Some("apache-2.0"), None, "Qwen/Qwen3-4B");
        assert_eq!(v.kind, LicenseKind::Free);
        assert!(v.cloud_allowed);
        let v = license_verdict(Some("llama3.1"), None, "meta-llama/Llama-3.1-8B-Instruct");
        assert_eq!(v.kind, LicenseKind::Notice);
        assert!(!v.cloud_allowed);
        assert!(v.note.unwrap().contains("Built with Llama"));
        let v = license_verdict(Some("gemma"), None, "google/gemma-3-4b-it");
        assert_eq!(v.kind, LicenseKind::Notice);
        assert!(v.note.unwrap().contains("Prohibited Use Policy"));
        let v = license_verdict(Some("cc-by-nc-4.0"), None, "x/y");
        assert_eq!(v.kind, LicenseKind::Notice);
        let v = license_verdict(None, None, "x/y");
        assert_eq!(v.kind, LicenseKind::Notice);
        assert_eq!(v.label, "No license given");
        let v = license_verdict(Some("other"), Some("qwen-research"), "Qwen/Qwen2.5-3B-Instruct");
        assert_eq!(v.kind, LicenseKind::Notice);
        assert_eq!(v.label, "qwen-research");
    }

    #[test]
    fn devices_follow_the_concept() {
        assert!(device_support(DeviceKind::Apple, "macos").0);
        assert!(device_support(DeviceKind::Nvidia, "windows").0);
        assert!(device_support(DeviceKind::Nvidia, "linux").0);
        assert!(device_support(DeviceKind::Amd, "linux").0);
        assert!(!device_support(DeviceKind::Amd, "windows").0);
    }

    fn input<'a>(params: u64, device: &'a DeviceOption, free: Option<u64>) -> EstimateInput<'a> {
        EstimateInput {
            params,
            download_bytes: params * 2,
            device,
            trials: 200,
            output_quant: "Q4_K_M",
            disk_free: free,
            env_missing: false,
        }
    }

    #[test]
    fn a_4b_model_on_the_48_gb_mac_fits_and_lands_near_the_measured_time() {
        let d = mac(48);
        let e = estimate(&input(4_000_000_000, &d, Some(96_000_000_000)));
        assert!(e.fits, "{:?}", e.why_not);
        assert_eq!(e.quantization, Quantization::None);
        // 93 min measured for 200 trials.
        assert!(e.minutes_low <= 93 && 93 <= e.minutes_high, "{}..{}", e.minutes_low, e.minutes_high);
        // About 8 GB download, three times that for a moment, plus the output.
        assert!(e.disk_needed_bytes > 24_000_000_000 && e.disk_needed_bytes < 30_000_000_000);
        assert!(e.disk_after_bytes < 3_000_000_000);
    }

    #[test]
    fn a_half_b_model_on_the_box_lands_near_the_measured_time() {
        let d = nvidia(12);
        let mut i = input(494_000_000, &d, None);
        i.trials = 100;
        let e = estimate(&i);
        // RTX 3060: 53 min search, about 58 min with merge, conversion and checks.
        assert!(e.minutes_low <= 58 && 58 <= e.minutes_high, "{}..{}", e.minutes_low, e.minutes_high);
    }

    #[test]
    fn a_small_card_falls_back_to_4_bit_and_a_too_small_one_says_so() {
        let d = nvidia(12);
        let e = estimate(&input(8_000_000_000, &d, None));
        assert!(e.fits);
        assert_eq!(e.quantization, Quantization::Bnb4bit);
        let d = nvidia(6);
        let e = estimate(&input(14_000_000_000, &d, None));
        assert!(!e.fits);
        assert!(e.why_not.unwrap().starts_with("Too large for this machine"));
    }

    #[test]
    fn a_mac_never_gets_4_bit_and_big_models_are_refused() {
        let d = mac(16);
        let e = estimate(&input(8_000_000_000, &d, None));
        assert!(!e.fits);
        assert_eq!(e.quantization, Quantization::None);
        let d = mac(192);
        let e = estimate(&input(27_000_000_000, &d, None));
        assert!(e.why_not.unwrap().contains("up to 14B"));
    }

    #[test]
    fn too_little_disk_is_said_before_the_download() {
        let d = mac(48);
        let e = estimate(&input(4_000_000_000, &d, Some(10_000_000_000)));
        assert!(e.why_not.unwrap().starts_with("Not enough free disk space"));
    }

    #[test]
    fn the_copy_keeps_the_quant_of_the_original_and_gets_its_own_name() {
        assert_eq!(output_quant(Some(7)), "Q8_0");
        assert_eq!(output_quant(Some(15)), "Q4_K_M");
        assert_eq!(output_quant(None), "Q4_K_M");
        assert_eq!(output_stem("Qwen2.5-0.5B-Instruct-Q8_0", "Q8_0"), "Qwen2.5-0.5B-Instruct-refusals-removed-Q8_0");
        assert_eq!(output_stem("qwen3-4b.Q4_K_M", "Q4_K_M"), "qwen3-4b-refusals-removed-Q4_K_M");
        assert_eq!(display_name(Some("Qwen2.5 0.5B Instruct"), "x"), "Qwen2.5 0.5B Instruct (refusals removed)");
        assert_eq!(convert_writes("Q8_0"), Some("q8_0"));
        assert_eq!(convert_writes("Q4_K_M"), None);
    }

    #[test]
    fn modes_and_trials() {
        assert_eq!(kl_limit("balanced"), Some(0.2));
        assert_eq!(kl_limit("strong"), Some(0.4));
        assert_eq!(kl_limit("x"), None);
        assert!(valid_trials(200) && valid_trials(100) && !valid_trials(7));
    }

    #[test]
    fn a_file_lu_made_is_recognised() {
        assert!(made_by_lu(&facts(&[("general.description", "Refusals removed in LU from Qwen/Qwen3-4B")])));
        assert!(!made_by_lu(&facts(&[("general.description", "a model")])));
    }
}
