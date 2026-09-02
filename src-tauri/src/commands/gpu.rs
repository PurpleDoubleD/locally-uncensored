// Bug BB v2.5.0 — BobbyT Discord 2026-05-26. BobbyT has AMD RX 6800XT 16GB +
// Intel Arc Pro B60 24GB and wants to pin the Arc Pro for inference. LU
// previously had no GPU picker — Ollama and ComfyUI just used whatever the
// driver picked first, which on multi-vendor / multi-GPU systems is often
// not what the user wants. This module adds:
//   1. `detect_gpus` — a one-shot probe that lists every NVIDIA / AMD / Intel
//      GPU the system can see (via nvidia-smi / rocm-smi / system_profiler /
//      lspci, best-effort).
//   2. `set_gpu_selection` — persists the user's pick into AppState. The
//      next `start_ollama` / `start_comfyui` reads from that state and sets
//      CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR
//      accordingly.
//
// Adversarial note: GPU detection on Windows without WMI is necessarily
// imprecise — we lean on the vendor CLIs (nvidia-smi, rocm-smi) and treat
// anything else as "unknown vendor, manual override required." This keeps
// the binary small and avoids the WMI dependency creep.

use crate::state::AppState;
use serde::Serialize;
use std::process::Command;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Clone)]
pub struct DetectedGpu {
    /// Zero-based device index inside the vendor's view (this is what we
    /// pass via CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES — vendor-scoped,
    /// NOT a global index across vendors).
    pub index: u32,
    pub vendor: String, // "nvidia" | "amd" | "intel" | "apple" | "unknown"
    pub name: String,
    /// Total memory in MiB if we can read it. None when the probe couldn't
    /// extract it (e.g. lspci output has no memory field).
    pub memory_mib: Option<u64>,
    /// Probe source that produced this entry. Useful for the UI tooltip
    /// ("from nvidia-smi" / "from rocm-smi" / "from lspci").
    pub source: String,
    /// Set when the card was found but its compute stack was not, so the
    /// settings can say that instead of showing a card as if it were ready.
    /// numbrain (forum help-image-gen) had a correctly configured RX 9070 XT
    /// the picker did not list at all, and spent days breaking his install
    /// trying to fix what looked like a driver problem.
    pub note: Option<String>,
    /// The card's compute architecture as the vendor's own tool names it
    /// ("gfx1201"), when a tool named it. Nothing derives this from the model
    /// name: the mapping from marketing name to gfx target is AMD's to publish
    /// and ours to read, never to guess.
    pub arch: Option<String>,
}

fn run_cmd(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Bounded — nvidia-smi on a wedged driver, wmic on a busy WMI service and
    // lspci on a slow bus scan all block indefinitely, and Command::output()
    // would wait for all of it while the hardware picker shows a spinner.
    crate::commands::shell::output_bounded(cmd, std::time::Duration::from_secs(5))
}

fn detect_nvidia() -> Vec<DetectedGpu> {
    // `nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits`
    // is portable across Linux and Windows. Output line: "0, NVIDIA GeForce RTX 4070, 12282"
    let raw = match run_cmd(
        "nvidia-smi",
        &["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
    ) {
        Some(s) => s,
        None => return vec![],
    };
    raw.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() < 3 { return None }
            let index: u32 = parts[0].parse().ok()?;
            let name = parts[1].to_string();
            let memory_mib: Option<u64> = parts[2].parse().ok();
            Some(DetectedGpu {
                index,
                vendor: "nvidia".into(),
                name,
                memory_mib,
                source: "nvidia-smi".into(),
                note: None,
                arch: None,
            })
        })
        .collect()
}

fn detect_amd() -> Vec<DetectedGpu> {
    // rocm-smi exists on Linux + (rarely) Windows with ROCm-on-Windows. Output
    // varies wildly between versions; we try the simplest invocation and
    // parse loosely. Format with `--showid --showproductname`:
    //   GPU[0] : Product Name: AMD Radeon RX 6800 XT
    //   GPU[0] : Memory: 16368 MiB
    let raw = match run_cmd("rocm-smi", &["--showid", "--showproductname", "--showmeminfo", "vram", "--csv"]) {
        Some(s) => s,
        None => return vec![],
    };
    // Try CSV parse first (newer rocm-smi). Header line then card lines.
    let mut gpus: Vec<DetectedGpu> = Vec::new();
    let mut lines = raw.lines().filter(|l| !l.trim().is_empty());
    if let Some(header) = lines.next() {
        let cols: Vec<&str> = header.split(',').map(|s| s.trim()).collect();
        let card_col = cols.iter().position(|c| c.eq_ignore_ascii_case("device") || c.eq_ignore_ascii_case("card"));
        let name_col = cols.iter().position(|c| c.to_lowercase().contains("product"));
        let mem_col = cols.iter().position(|c| c.to_lowercase().contains("vram") && c.to_lowercase().contains("total"));
        for line in lines {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            let index: u32 = card_col
                .and_then(|i| parts.get(i))
                .and_then(|s| s.trim_start_matches("card").parse::<u32>().ok())
                .unwrap_or(gpus.len() as u32);
            let name = name_col
                .and_then(|i| parts.get(i))
                .map(|s| s.to_string())
                .unwrap_or_else(|| "AMD GPU".into());
            // Memory comes as bytes; convert to MiB
            let memory_mib = mem_col
                .and_then(|i| parts.get(i))
                .and_then(|s| s.parse::<u64>().ok())
                .map(|bytes| bytes / 1024 / 1024);
            gpus.push(DetectedGpu {
                index,
                vendor: "amd".into(),
                name,
                memory_mib,
                source: "rocm-smi".into(),
                note: None,
                arch: None,
            });
        }
    }
    gpus
}

/// Why a card shows up without its vendor tool. Only AMD gets one today: the
/// NVIDIA fallback path is unreachable (nvidia-smi ships with the driver) and
/// Intel never had a CLI probe to begin with.
fn note_for(vendor: &str) -> Option<String> {
    if vendor == "amd" {
        Some(
            "Found without ROCm tools, so LU cannot confirm the compute backend. Ollama and ComfyUI can still use the card if their ROCm or ZLUDA build is installed."
                .to_string(),
        )
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn detect_other_via_lspci(have_rocm: bool) -> Vec<DetectedGpu> {
    // Best-effort fallback for Intel iGPUs / Intel Arc / Apple-Silicon-in-VM
    // when neither nvidia-smi nor rocm-smi cover them. `lspci -nn | grep VGA`
    // gives "00:02.0 VGA compatible controller [0300]: Intel Corporation
    // AlderLake-S GT1 [Intel UHD Graphics 770] [8086:4680]". We parse the
    // vendor ID ([8086:...] = Intel, [10de:...] = NVIDIA fallback,
    // [1002:...] = AMD).
    let raw = match run_cmd("lspci", &["-nn"]) {
        Some(s) => s,
        None => return vec![],
    };
    detect_other_via_lspci_from(&raw, have_rocm)
}

/// The parser, split from the command so it can be run against real captured
/// `lspci -nn` output instead of whatever the build machine happens to have.
/// Deliberately NOT gated on Linux: a parser that only compiles on the target
/// is a parser only the target ever proves, and the CI runners are not Linux.
fn detect_other_via_lspci_from(raw: &str, have_rocm: bool) -> Vec<DetectedGpu> {
    let mut gpus: Vec<DetectedGpu> = Vec::new();
    // Per-vendor counters: HIP_VISIBLE_DEVICES and ONEAPI_DEVICE_SELECTOR are
    // both vendor-scoped, so a machine with an Intel iGPU and an AMD card must
    // not hand the AMD card the iGPU's number. The old code counted Intel only
    // and would have given every AMD card index 0.
    let mut next: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for line in raw.lines() {
        let lower = line.to_lowercase();
        if !(lower.contains("vga") || lower.contains("3d controller") || lower.contains("display controller")) { continue }
        let vendor = if lower.contains("[8086:") { "intel" }
                     else if lower.contains("[10de:") { "nvidia" }
                     else if lower.contains("[1002:") { "amd" }
                     else { "unknown" };
        // nvidia-smi ships with the driver, so its entry is always the better
        // one. rocm-smi does NOT: it comes with the ROCm dev packages, which a
        // customer running a ROCm Ollama or a ZLUDA ComfyUI has no reason to
        // install. Skipping AMD unconditionally is why numbrain's RX 9070 XT
        // was invisible in the picker while his system reported it correctly.
        if vendor == "nvidia" { continue }
        if vendor == "amd" && have_rocm { continue }
        let index = next.entry(vendor).or_insert(0);
        gpus.push(DetectedGpu {
            index: *index,
            vendor: vendor.into(),
            name: lspci_device_name(line),
            memory_mib: None,
            source: "lspci".into(),
            note: note_for(vendor),
            arch: None,
        });
        *index += 1;
    }
    gpus
}

/// The human name out of one `lspci -nn` line.
///
/// ```text
/// 03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. \
///   [AMD/ATI] Navi 48 [Radeon RX 9070 XT] [1002:7550] (rev c0)
/// ```
///
/// Splitting on ':' and taking the last field (what this did while the branch
/// was Intel-only) yields "7550] (rev c0)". Harmless when nobody reached the
/// branch, useless the moment AMD cards flow through it, so the model name is
/// parsed properly: drop everything up to the class-code colon, then drop the
/// trailing `[vendor:device]` and revision.
fn lspci_device_name(line: &str) -> String {
    let after_class = line
        .find("]: ")
        .map(|i| &line[i + 3..])
        .unwrap_or(line);
    let mut name = after_class;
    if let Some(i) = name.rfind(" (rev ") {
        name = &name[..i];
    }
    // The id bracket is the LAST one and always `[hhhh:hhhh]`; a marketing
    // bracket like "[Radeon RX 9070 XT]" has no colon and must survive.
    let trimmed = name.trim();
    if trimmed.ends_with(']') {
        if let Some(open) = trimmed.rfind('[') {
            if trimmed[open..].contains(':') {
                name = &trimmed[..open];
            }
        }
    }
    let out = name.trim().trim_end_matches(',').trim().to_string();
    if out.is_empty() { "GPU".to_string() } else { out }
}

#[cfg(not(target_os = "linux"))]
fn detect_other_via_lspci(_have_rocm: bool) -> Vec<DetectedGpu> { vec![] }

#[cfg(target_os = "macos")]
fn detect_macos() -> Vec<DetectedGpu> {
    // macOS uses Metal/MPS via the unified GPU. We surface a single entry so
    // the picker isn't empty, but selection has no effect (CUDA/HIP/ONEAPI
    // env-vars don't apply on Apple Silicon).
    let name = run_cmd("sysctl", &["-n", "machdep.cpu.brand_string"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Apple GPU".into());
    vec![DetectedGpu {
        index: 0,
        vendor: "apple".into(),
        name,
        memory_mib: None,
        source: "system".into(),
        note: None,
        arch: None,
    }]
}

#[cfg(not(target_os = "macos"))]
fn detect_macos() -> Vec<DetectedGpu> { vec![] }

/// Vendor from an adapter's human name. Shared by both Windows probes so the
/// registry branch and the wmic branch can never disagree about a card.
fn vendor_from_adapter_name(name: &str) -> &'static str {
    let lname = name.to_lowercase();
    if lname.contains("intel") { "intel" }
    else if lname.contains("amd") || lname.contains("radeon") { "amd" }
    else if lname.contains("nvidia") || lname.contains("geforce") || lname.contains("rtx") || lname.contains("gtx") { "nvidia" }
    else { "unknown" }
}

/// The Windows adapter list straight out of the display-driver registry branch.
///
/// This is the probe that replaced wmic. `DriverDesc` carries the card's name
/// under the same numbered subkey `HardwareInformation.qwMemorySize` carries
/// its true size, so one branch answers both questions the picker asks, and
/// `reg.exe` is not going anywhere. Pure over the two parsed queries for the
/// same reason the wmic parser is: the CI runners are not Windows.
///
/// The order is not the registry's. This is the second registry hole from the
/// AMD deep-dive of 2026-08-31: a card that was pulled out of the machine keeps
/// its numbered subkey and its `DriverDesc`, and the registry has no flag that
/// says present or not present. Firefox and System Informer both leave the
/// registry for this and ask SetupAPI with `DIGCF_PRESENT` or CfgMgr32 instead.
///
/// What is done about it here, and it is a ranking and not a detector: an entry
/// whose subkey also carries a readable `HardwareInformation.qwMemorySize` has
/// positive evidence that a miniport driver measured real hardware there, so it
/// sorts ahead of an entry that has none. Index 0 of a vendor then goes to the
/// card we have evidence for rather than to whichever subkey was numbered first
/// by installation order, and that index is what the picker shows first and
/// what `HIP_VISIBLE_DEVICES` names.
///
/// Where this stops, written down rather than glossed over:
///
/// - Nothing is dropped. An AMD or Intel iGPU legitimately has no
///   `qwMemorySize` (the value is undocumented and often absent on integrated
///   parts), so a filter would delete real cards. It only loses its head start.
/// - It does not identify a leftover. A card that ran on this machine and was
///   then removed keeps the value it once wrote, so it carries the same
///   evidence a present card does. The ranking helps where a leftover never
///   ran here; it does nothing for the case the deep-dive named as the worst
///   one.
/// - Closing that case for real means SetupAPI or CfgMgr32, which is a new
///   Windows dependency and a different change than this one.
fn detect_other_via_registry_from(
    names: &[(String, String)],
    sizes: &[(String, String)],
    have_rocm: bool,
) -> Vec<DetectedGpu> {
    // (has presence evidence, vendor, name, VRAM), before the ranking.
    let mut rows: Vec<(bool, &'static str, String, Option<u64>)> = Vec::new();
    for (key, raw_name) in names {
        let name = raw_name.trim().to_string();
        if name.is_empty() { continue }
        let vendor = vendor_from_adapter_name(&name);
        // See the lspci path: nvidia-smi ships with the driver so its entry is
        // always richer, and rocm-smi does NOT ship with the AMD driver, so an
        // AMD card must survive its absence.
        if vendor == "nvidia" { continue }
        if vendor == "amd" && have_rocm { continue }
        let memory_mib = sizes
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| parse_reg_hex(v))
            .filter(|b| *b > 0)
            .map(|b| b / 1024 / 1024);
        rows.push((memory_mib.is_some(), vendor, name, memory_mib));
    }
    // Stable, so entries that carry the same amount of evidence keep the
    // registry's own order among themselves.
    rows.sort_by_key(|(has_evidence, ..)| !has_evidence);

    let mut gpus = Vec::new();
    // Per-vendor counters, exactly as on the other two paths: HIP_VISIBLE_DEVICES
    // and ONEAPI_DEVICE_SELECTOR are vendor-scoped.
    let mut next: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for (_, vendor, name, memory_mib) in rows {
        let index = next.entry(vendor).or_insert(0);
        gpus.push(DetectedGpu {
            index: *index,
            vendor: vendor.into(),
            name,
            memory_mib,
            source: "registry".into(),
            note: note_for(vendor),
            arch: None,
        });
        *index += 1;
    }
    gpus
}

/// Which of the two Windows probes decides, given what each one produced.
///
/// The registry answers first and wmic is only reached when the registry said
/// nothing AT ALL. Splitting the choice out as a pure function is what lets a
/// test drive the case that matters (`wmic_raw: None`, which is every Windows
/// 11 from 23H2 on) without a Windows box.
fn windows_fallback_from(
    registry_names: &[(String, String)],
    registry_sizes: &[(String, String)],
    wmic_raw: Option<&str>,
    have_rocm: bool,
) -> Vec<DetectedGpu> {
    if !registry_names.is_empty() {
        return detect_other_via_registry_from(registry_names, registry_sizes, have_rocm);
    }
    match wmic_raw {
        Some(raw) => detect_other_via_wmic_from(raw, have_rocm, &[]),
        None => vec![],
    }
}

#[cfg(target_os = "windows")]
fn detect_other_on_windows(have_rocm: bool) -> Vec<DetectedGpu> {
    // Microsoft disabled wmic.exe by default in Windows 11 23H2 and 24H2 and
    // removed it outright in the August 2026 servicing update, where it is no
    // longer even a Feature on Demand. It used to be this module's only way to
    // see a card without a vendor CLI, which meant an AMD card on any current
    // Windows was invisible: no entry in the picker, and `plan_pytorch_install`
    // deciding as if the machine had no GPU at all.
    //
    // The display-driver registry branch is the replacement, and it was already
    // half in use here for VRAM sizes. wmic stays behind it for the older
    // Windows where it still exists and for the case where `reg query` itself
    // comes back empty.
    let names = run_cmd("reg", &["query", DISPLAY_CLASS_KEY, "/s", "/v", "DriverDesc"])
        .map(|s| parse_reg_query(&s, "DriverDesc"))
        .unwrap_or_default();
    let sizes = run_cmd(
        "reg",
        &["query", DISPLAY_CLASS_KEY, "/s", "/v", "HardwareInformation.qwMemorySize"],
    )
    .map(|s| parse_reg_query(&s, "HardwareInformation.qwMemorySize"))
    .unwrap_or_default();
    if !names.is_empty() {
        return windows_fallback_from(&names, &sizes, None, have_rocm);
    }
    // Only now is wmic worth its five second ceiling.
    let wmic = run_cmd(
        "wmic",
        &["path", "Win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"],
    );
    windows_fallback_from(&names, &sizes, wmic.as_deref(), have_rocm)
}

/// The parser, split out the same way the lspci one is: wmic only exists on
/// Windows and the CI runners are not Windows, so the part that can be wrong
/// quietly gets to be tested everywhere.
fn detect_other_via_wmic_from(
    raw: &str,
    have_rocm: bool,
    registry_vram: &[(String, u64)],
) -> Vec<DetectedGpu> {
    let mut gpus = Vec::new();
    // Per-vendor counters, exactly as on the lspci path. HIP_VISIBLE_DEVICES
    // and ONEAPI_DEVICE_SELECTOR are vendor-scoped, so a box with an Intel
    // iGPU listed first and an AMD card second must not hand the AMD card the
    // number 1: it is the only HIP device there is, and HIP device 1 does not
    // exist. That is lapbo's machine (Win11 plus ZLUDA, no rocm-smi), which is
    // the whole reason this branch lists AMD at all.
    let mut next: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    // wmic `/format:csv` emits a LEADING blank line before the header row
    // ("Node,AdapterRAM,Name"). A bare `.skip(1)` would skip that blank line and
    // then parse the header itself as a device → a phantom GPU literally named
    // "Name". Filter empty lines FIRST (same as detect_amd), THEN skip the
    // header, and defensively drop the header label if the format ever shifts.
    for line in raw.lines().filter(|l| !l.trim().is_empty()).skip(1) {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        // Format: Node, AdapterRAM, Name
        if parts.len() < 3 { continue }
        let ram_bytes: Option<u64> = parts[1].parse().ok();
        let name = parts[2].to_string();
        if name.is_empty() || name.eq_ignore_ascii_case("name") { continue }
        let vendor = vendor_from_adapter_name(&name);
        // See the lspci path: rocm-smi is not part of the AMD driver, so an
        // AMD card must survive its absence. ROCm on Windows is rare and ZLUDA
        // users have no rocm-smi at all (lapbo, Win11 + ZLUDA).
        if vendor == "nvidia" { continue }
        if vendor == "amd" && have_rocm { continue }
        let from_registry = registry_vram
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(&name))
            .map(|(_, mib)| *mib);
        let (memory_mib, source) = match from_registry {
            Some(mib) => (Some(mib), "registry"),
            // No registry match. A capped AdapterRAM is worse than no number at
            // all, because the app sizes models against it, so only pass a
            // value through when it is safely inside what uint32 can hold.
            None => match ram_bytes {
                Some(b) if b < 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024 => (Some(b / 1024 / 1024), "wmic"),
                _ => (None, "wmic"),
            },
        };
        let index = next.entry(vendor).or_insert(0);
        gpus.push(DetectedGpu {
            index: *index,
            vendor: vendor.into(),
            name,
            memory_mib,
            source: source.into(),
            note: note_for(vendor),
            arch: None,
        });
        *index += 1;
    }
    gpus
}

#[cfg(not(target_os = "windows"))]
fn detect_other_on_windows(_have_rocm: bool) -> Vec<DetectedGpu> { vec![] }

/// Class GUID of the display-adapter registry branch, lowercase, as
/// `adapter_subkey` matches it. Microsoft lists it as the "Display Adapters"
/// setup class, and the software key of every display adapter is created under
/// it.
const DISPLAY_CLASS_GUID: &str = "{4d36e968-e325-11ce-bfc1-08002be10318}";

/// The same branch as a full key path for `reg query`. Every installed GPU
/// driver gets a numbered subkey (0000, 0001, …) under it.
#[allow(dead_code)]
const DISPLAY_CLASS_KEY: &str =
    r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

/// The numbered adapter subkey out of one `reg query` key line, or `None` when
/// the line is not an adapter at all.
///
/// This is the first of the two registry holes the AMD deep-dive of 2026-08-31
/// found. MEASURED on the Windows box: `reg query <CLASS> /s` returns 27 keys
/// and exactly one of them is an adapter. The branch also carries
/// `<CLASS>\Configuration` with a whole subtree under it
/// (`Control\Video\$VideoId\Video`, `Device`, `Driver`,
/// `Services\$Service\Video`, `Variables\…`) and `<CLASS>\Properties`, which is
/// closed even to administrators (`reg query /s` skips it silently and still
/// exits 0, so there is no error to handle and none that should be raised).
///
/// The rule that holds: exactly one path segment after the class GUID, and
/// that segment is four digits. Anything deeper or differently named is part
/// of the branch's own bookkeeping, not a card. `/v DriverDesc` already keeps
/// most of it out, because `reg query` then prints only keys that carry the
/// value, but "most" is not a rule, and a `Configuration\…\Video` that carried
/// a `DriverDesc` would have been counted as a GPU.
fn adapter_subkey(key_line: &str) -> Option<&str> {
    let at = key_line.to_ascii_lowercase().find(DISPLAY_CLASS_GUID)?;
    // to_ascii_lowercase never changes byte lengths, so the index is valid in
    // the original line too.
    let sub = key_line[at + DISPLAY_CLASS_GUID.len()..].strip_prefix('\\')?;
    // Four digits and nothing else. A deeper path fails this on the backslash
    // it still carries, so one check covers both halves of the rule.
    if sub.len() == 4 && sub.bytes().all(|b| b.is_ascii_digit()) {
        Some(sub)
    } else {
        None
    }
}

/// Pull `<subkey> → <value>` pairs out of `reg query … /s /v <name>` output.
///
/// The layout is a key line at column 0 followed by indented value lines:
///
/// ```text
/// HKEY_LOCAL_MACHINE\SYSTEM\…\Class\{4d36e968-…}\0000
///     DriverDesc    REG_SZ    Intel(R) Arc(TM) Pro B60 Graphics
/// ```
///
/// Keeping this a pure function over the text means the join below is testable
/// on any platform, which matters because the machine that reproduces the bug
/// is not the machine the tests run on. Value data may contain spaces, so only
/// the name and type columns are split off.
fn parse_reg_query(raw: &str, value_name: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with(char::is_whitespace) {
            // Key line. Remember the numbered subkey ("0000"), which is what
            // the two queries have in common. Everything that is not an adapter
            // key clears it, which is also what happens to
            // "End of search: N match(es) found." and its localized twins.
            current = adapter_subkey(trimmed).map(|s| s.to_string());
            continue;
        }
        let Some(key) = current.as_ref() else { continue };
        let mut parts = trimmed.split_whitespace();
        let Some(name) = parts.next() else { continue };
        if !name.eq_ignore_ascii_case(value_name) {
            continue;
        }
        let Some(_reg_type) = parts.next() else { continue };
        // Rejoin: the value itself can hold spaces ("Intel(R) Arc(TM) Pro B60").
        let rest = parts.collect::<Vec<_>>().join(" ");
        if rest.is_empty() {
            continue;
        }
        out.push((key.clone(), rest));
    }
    out
}

/// Parse a REG_QWORD / REG_DWORD payload ("0x600000000") into bytes.
fn parse_reg_hex(value: &str) -> Option<u64> {
    let v = value.trim();
    let hex = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X"))?;
    u64::from_str_radix(hex, 16).ok()
}

// The name → VRAM join that used to live here is gone: the registry branch is
// no longer a side probe that patches wmic's broken uint32 AdapterRAM, it IS
// the adapter list, so `detect_other_via_registry_from` reads both values off
// the same subkey directly. WMI's `AdapterRAM` cannot express more than 4 GiB
// (bobbyt5667's 24 GB Arc Pro B60 came out of it as 2 GB), which is why the
// qword is still the number we believe.

// ── ROCm on Windows: the HIP SDK, not rocm-smi ────────────────────────
//
// Zhorts, GitHub #123 (2026-09-01, Windows 11, RX 9070 XT, HIP SDK 7.1.1):
// the SDK was installed correctly, `hipinfo.exe` reported gfx1201, and LU still
// told him "Found without ROCm tools". `detect_amd()` above is the only thing
// that ever set that verdict and it runs one command, `rocm-smi`, which the
// Windows HIP SDK does not ship at all. On Windows the SDK installs
// `hipinfo.exe` under its own tree and exports HIP_PATH, so that is what has to
// be asked. Linux keeps rocm-smi, macOS has neither and is untouched.
//
// Nothing here writes down a version. Zhorts' own suspicion was a renamed DLL
// (`amdhip64.dll` became `amdhip64_7.dll` in 7.1.1), which is exactly what a
// hardcoded name does to a detector a year later, so the install root comes out
// of the environment or out of a directory listing, and the version is read off
// whatever directory was found.

/// One device as `hipinfo` reports it.
#[derive(Debug, Clone, PartialEq)]
struct HipDevice {
    index: u32,
    name: String,
    /// `gcnArchName`, e.g. "gfx1201". This is the value a ROCm PyTorch build
    /// has to carry kernels for, which is what A12 (RDNA4 image generation
    /// dying on hipErrorInvalidValue) turns on.
    arch: Option<String>,
    /// `totalGlobalMem`. Read, but barely trusted: see HIPINFO_MIN_TRUSTED_MIB.
    total_global_mem_mib: Option<u64>,
}

/// What the HIP SDK probe found, as one bundle.
#[derive(Debug, Clone, PartialEq)]
struct RocmFacts {
    /// Version as the install directory names it ("7.1"), or None when the root
    /// carried no version-shaped segment. Read, never assumed.
    version: Option<String>,
    devices: Vec<HipDevice>,
}

/// The floor under `hipinfo`'s own VRAM number.
///
/// ROCm issue #5105: hipinfo on Windows printed `totalGlobalMem: 0.16 GB` for a
/// 16 GB RX 6950 XT under HIP SDK 6.2. The field is therefore not a source the
/// fit check may rest on. It is used only where nothing else answered at all,
/// and only above a floor no discrete card HIP will run on falls below. Below
/// it the size stays unknown, because unknown is honest and 0.16 GB is not.
const HIPINFO_MIN_TRUSTED_MIB: u64 = 1024;

/// Parse `hipinfo` output.
///
/// The tool prints one block per device. Every row is a label padded to 34
/// columns and then the value, and `device#` is the one row printed WITHOUT a
/// colon (`cout << setw(34) << "device#" << deviceId`), which is what separates
/// the blocks:
///
/// ```text
/// --------------------------------------------------------------------------
/// device#                           0
/// Name:                             AMD Radeon RX 9070 XT
/// totalGlobalMem:                   15.98 GB
/// gcnArchName:                      gfx1201
/// peers:
/// non-peers:                        device#0
///
/// memInfo.total:                    15.98 GB
/// ```
///
/// Only four rows are read and every other one is ignored by name, so a future
/// SDK adding, dropping or reordering fields cannot break this. Pure over the
/// text for the reason every other parser in this file is: the machine that
/// reproduces the bug is not the machine the tests run on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_hipinfo(raw: &str) -> Vec<HipDevice> {
    let mut out: Vec<HipDevice> = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('-') {
            continue;
        }
        // The block header. `non-peers: device#0` also contains "device#" but
        // not at the start of the line, so the prefix test is enough.
        if let Some(rest) = t.strip_prefix("device#") {
            if let Ok(index) = rest.trim().parse::<u32>() {
                out.push(HipDevice { index, name: String::new(), arch: None, total_global_mem_mib: None });
                continue;
            }
        }
        let Some((key, value)) = t.split_once(':') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        // A value row before the first `device#` belongs to nothing.
        let Some(dev) = out.last_mut() else { continue };
        match key.trim().to_ascii_lowercase().as_str() {
            "name" => dev.name = value.to_string(),
            // The field is a plain string today. Taking the first token keeps a
            // future ":sramecc+:xnack-" suffix out of a comparison that is only
            // ever about the target.
            "gcnarchname" => {
                dev.arch = value.split_whitespace().next().map(|s| s.trim_end_matches(':').to_string())
            }
            "totalglobalmem" => dev.total_global_mem_mib = parse_hip_size_mib(value),
            _ => {}
        }
    }
    // A block that named neither the card nor its architecture carries nothing
    // worth reporting.
    out.retain(|d| !d.name.is_empty() || d.arch.is_some());
    out
}

/// "15.98 GB" and friends into MiB. A bare number is bytes, which is what
/// older builds print.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_hip_size_mib(value: &str) -> Option<u64> {
    let mut it = value.split_whitespace();
    let num: f64 = it.next()?.parse().ok()?;
    if !num.is_finite() || num <= 0.0 {
        return None;
    }
    let unit = it.next().map(|u| u.to_ascii_uppercase());
    let mib = match unit.as_deref() {
        Some(u) if u.starts_with("GB") || u.starts_with("GIB") => num * 1024.0,
        Some(u) if u.starts_with("MB") || u.starts_with("MIB") => num,
        Some(u) if u.starts_with("KB") || u.starts_with("KIB") => num / 1024.0,
        Some(u) if u.starts_with('B') => num / 1024.0 / 1024.0,
        None => num / 1024.0 / 1024.0,
        // An unit nobody here knows is not a number to guess at.
        Some(_) => return None,
    };
    if mib < 1.0 {
        return None;
    }
    Some(mib.round() as u64)
}

/// HIP install roots the environment already names.
///
/// The Windows SDK exports HIP_PATH, and a side-by-side install adds versioned
/// twins (HIP_PATH_57 and the like), so any variable whose name starts with
/// HIP_PATH counts. ROCM_PATH is the Linux spelling and costs nothing to accept.
/// Order is kept, duplicates are dropped, and no version appears in this file.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn hip_roots_from_env(vars: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (k, v) in vars {
        let ku = k.to_ascii_uppercase();
        if !(ku.starts_with("HIP_PATH") || ku == "ROCM_PATH" || ku.starts_with("ROCM_PATH_")) {
            continue;
        }
        let root = v.trim().trim_end_matches(['\\', '/']).to_string();
        if root.is_empty() {
            continue;
        }
        if !out.iter().any(|r| r.eq_ignore_ascii_case(&root)) {
            out.push(root);
        }
    }
    out
}

/// The version-numbered directory names under an install tree, newest first.
///
/// `C:\Program Files\AMD\ROCm\` holds one directory per installed SDK ("6.4",
/// "7.1"). Which ones exist is the installer's business, so they are listed and
/// sorted, never named. Anything that is not version-shaped sorts last instead
/// of being dropped, because a directory this code does not recognise is still a
/// better guess than nothing.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn rocm_dirs_newest_first(entries: &[String]) -> Vec<String> {
    let mut v: Vec<&String> = entries.iter().collect();
    v.sort_by(|a, b| match (version_key(a), version_key(b)) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    });
    v.into_iter().cloned().collect()
}

/// "7.1.1" into [7, 1, 1], or None when the name is not a version at all.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn version_key(name: &str) -> Option<Vec<u64>> {
    let n = name.trim();
    if n.is_empty() {
        return None;
    }
    let parts: Vec<&str> = n.split('.').collect();
    let mut key = Vec::with_capacity(parts.len());
    for p in parts {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        key.push(p.parse::<u64>().ok()?);
    }
    Some(key)
}

/// The SDK version an install root spells out in its last path segment, when it
/// spells one out. `C:\Program Files\AMD\ROCm\7.1` gives "7.1"; a root the user
/// put somewhere of their own gives None, and the note then simply says less.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn hip_version_from_root(root: &str) -> Option<String> {
    let seg = root.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next()?;
    version_key(seg).map(|_| seg.to_string())
}

/// The note an AMD card carries once the HIP SDK has answered.
///
/// Both halves are read, never assumed: the version comes off the install
/// directory and the architecture out of `hipinfo`. The second sentence is what
/// A12 needs (artoriuskurokami, RX 9070 XT, image generation dying with
/// hipErrorInvalidValue on RDNA4): the card being visible to ROCm and the
/// PyTorch in the ComfyUI environment having kernels for it are two different
/// things, and the user has no way to tell them apart from the raw HIP error.
fn rocm_note(version: Option<&str>, arch: Option<&str>) -> Option<String> {
    let head = match version {
        Some(v) => format!("ROCm {v} is installed"),
        None => "A ROCm HIP SDK is installed".to_string(),
    };
    match arch {
        Some(a) => Some(format!(
            "{head} and reports this card as {a}. Image and video generation additionally need a PyTorch ROCm build carrying kernels for {a}; without them the first step of a render stops with hipErrorInvalidValue. Read what the installed build covers with: python -c \"import torch; print(torch.cuda.get_arch_list())\""
        )),
        None => Some(format!(
            "{head} and can see this card, but it did not report an architecture. If a render stops with hipErrorInvalidValue, the PyTorch ROCm build in the ComfyUI environment has no kernels for this chip."
        )),
    }
}

/// Fold what `hipinfo` said into the card list.
///
/// Two jobs, and deliberately not a third: the AMD cards another probe already
/// found keep their VRAM number and only gain the architecture and a note that
/// is true, and a card no other probe saw is appended so the picker is not
/// empty. What this never does is overwrite a VRAM number, because the registry
/// qword is measured by the miniport driver and hipinfo's is the field ROCm
/// issue #5105 caught printing 0.16 GB for a 16 GB card.
///
/// Matching is by name first and by position second. On Windows both probes read
/// the same adapter string, so the name path is the normal one; the positional
/// fallback exists for the day they disagree, and it can only ever attach a note
/// to the wrong card of the same vendor, never a wrong size.
fn apply_rocm_facts(gpus: &mut Vec<DetectedGpu>, facts: Option<&RocmFacts>) {
    let Some(facts) = facts else { return };
    if facts.devices.is_empty() {
        return;
    }
    let version = facts.version.as_deref();
    let mut used = vec![false; facts.devices.len()];

    for gpu in gpus.iter_mut().filter(|g| g.vendor == "amd") {
        let by_name = facts
            .devices
            .iter()
            .enumerate()
            .position(|(i, d)| !used[i] && !d.name.is_empty() && names_agree(&gpu.name, &d.name));
        let pick = by_name.or_else(|| used.iter().position(|u| !u));
        let Some(i) = pick else { continue };
        used[i] = true;
        gpu.arch = facts.devices[i].arch.clone();
        gpu.note = rocm_note(version, gpu.arch.as_deref());
    }

    // Anything hipinfo saw and nobody else did. On a box where the display
    // registry is unreadable this is the only entry the picker gets, so it is
    // added rather than dropped.
    let mut next_index = gpus.iter().filter(|g| g.vendor == "amd").count() as u32;
    for (i, dev) in facts.devices.iter().enumerate() {
        if used[i] {
            continue;
        }
        let arch = dev.arch.clone();
        gpus.push(DetectedGpu {
            index: next_index,
            vendor: "amd".into(),
            name: if dev.name.is_empty() { "AMD GPU".to_string() } else { dev.name.clone() },
            // Only above the floor, and only because nothing else answered.
            memory_mib: dev.total_global_mem_mib.filter(|m| *m >= HIPINFO_MIN_TRUSTED_MIB),
            source: "hipinfo".into(),
            note: rocm_note(version, arch.as_deref()),
            arch,
        });
        next_index += 1;
    }
}

/// Whether two adapter strings are the same card. Containment either way,
/// case-insensitively: the registry writes "AMD Radeon RX 9070 XT" and hipinfo
/// writes the same string, but one of them gaining a "(TM)" must not split one
/// card into two.
fn names_agree(a: &str, b: &str) -> bool {
    let a = a.to_ascii_lowercase();
    let b = b.to_ascii_lowercase();
    a == b || a.contains(&b) || b.contains(&a)
}

/// `hipinfo` under one install root, if it is there. Both spellings are probed
/// because the sample is named hipInfo upstream and ships lowercase in the SDK,
/// and a case-insensitive filesystem is not something to rely on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn hipinfo_under(root: &str) -> Option<std::path::PathBuf> {
    let base = std::path::Path::new(root);
    for rel in ["bin/hipinfo.exe", "bin/hipInfo.exe", "hipinfo.exe", "bin/hipinfo", "bin/hipInfo"] {
        let p = base.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Ask the Windows HIP SDK. `None` when there is no SDK, which is the answer
/// the old code gave every Windows user whether or not one was installed.
#[cfg(target_os = "windows")]
fn detect_rocm_facts() -> Option<RocmFacts> {
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let mut roots = hip_roots_from_env(&vars);
    // Then the default tree, listed rather than named. `HIP_PATH` is set by the
    // installer, but a repair or an in-place upgrade has been seen to leave it
    // behind, and the directory is the ground truth either way.
    for base_var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        let Some(base) = std::env::var_os(base_var) else { continue };
        let dir = std::path::Path::new(&base).join("AMD").join("ROCm");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        for name in rocm_dirs_newest_first(&names) {
            let root = dir.join(&name).to_string_lossy().into_owned();
            if !roots.iter().any(|r| r.eq_ignore_ascii_case(&root)) {
                roots.push(root);
            }
        }
    }
    for root in roots {
        let Some(exe) = hipinfo_under(&root) else { continue };
        let Some(raw) = run_cmd(&exe.to_string_lossy(), &[]) else { continue };
        let devices = parse_hipinfo(&raw);
        if devices.is_empty() {
            continue;
        }
        return Some(RocmFacts { version: hip_version_from_root(&root), devices });
    }
    None
}

/// Linux answers through rocm-smi and macOS has no ROCm at all, so neither one
/// pays for this probe.
#[cfg(not(target_os = "windows"))]
fn detect_rocm_facts() -> Option<RocmFacts> {
    None
}

#[tauri::command]
pub fn detect_gpus() -> Result<Vec<DetectedGpu>, String> {
    let mut gpus = Vec::new();
    gpus.extend(detect_nvidia());
    let amd = detect_amd();
    // The fallbacks list AMD cards only when rocm-smi produced nothing, so a
    // machine WITH ROCm keeps the richer entry (it carries VRAM) and a machine
    // without it still sees its card instead of an empty picker.
    let have_rocm = !amd.is_empty();
    gpus.extend(amd);
    gpus.extend(detect_other_via_lspci(have_rocm));
    gpus.extend(detect_other_on_windows(have_rocm));
    gpus.extend(detect_macos());
    // The HIP SDK answers LAST and never suppresses a probe, which is the whole
    // difference to `have_rocm` above. rocm-smi is a full replacement for the
    // fallbacks (it carries VRAM); hipinfo is not (ROCm #5105), so it enriches
    // the entries the registry already measured instead of replacing them, and
    // only appends a card nobody else saw.
    apply_rocm_facts(&mut gpus, detect_rocm_facts().as_ref());
    Ok(gpus)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GpuSelection {
    /// Vendor whose env-var family to set ("nvidia" | "amd" | "intel" | "auto").
    /// "auto" leaves env-vars unset and lets the runtime pick its default.
    pub vendor: String,
    /// Zero-based, vendor-scoped indices of the GPUs to expose. Empty list
    /// means "all available" (env-var unset).
    pub indices: Vec<u32>,
}

#[tauri::command]
pub fn set_gpu_selection(state: State<'_, AppState>, selection: GpuSelection) -> Result<(), String> {
    let mut sel = state.gpu_selection.lock().map_err(|e| e.to_string())?;
    *sel = selection;
    Ok(())
}

#[tauri::command]
pub fn get_gpu_selection(state: State<'_, AppState>) -> Result<GpuSelection, String> {
    let sel = state.gpu_selection.lock().map_err(|e| e.to_string())?;
    Ok(sel.clone())
}

/// Apply the persisted GPU selection to a Command's env, ahead of `.spawn()`.
/// No-op when vendor is "auto" or indices are empty — the runtime falls back
/// to driver-decided device order, which is the previous (pre-v2.5.0)
/// behaviour.
pub fn apply_gpu_env(cmd: &mut Command, selection: &GpuSelection) {
    if selection.indices.is_empty() { return }
    let csv: String = selection.indices.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    match selection.vendor.as_str() {
        "nvidia" => { cmd.env("CUDA_VISIBLE_DEVICES", &csv); }
        "amd" => {
            // HIP_VISIBLE_DEVICES is the official ROCm name; ROCR_VISIBLE_DEVICES
            // is the lower-level Runtime equivalent that some older builds
            // honour. Setting both is harmless.
            cmd.env("HIP_VISIBLE_DEVICES", &csv);
            cmd.env("ROCR_VISIBLE_DEVICES", &csv);
        }
        "intel" => {
            // SYCL / oneAPI selector. Format: "level_zero:0,1" or "opencl:0".
            // We default to level_zero which is what Intel's IPEX-LLM uses.
            let sycl: String = selection.indices.iter().map(|i| format!("level_zero:{}", i)).collect::<Vec<_>>().join(",");
            cmd.env("ONEAPI_DEVICE_SELECTOR", &sycl);
        }
        _ => {} // auto / unknown — leave env untouched
    }
}

impl Default for GpuSelection {
    fn default() -> Self {
        GpuSelection { vendor: "auto".into(), indices: vec![] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `reg query … /s /v DriverDesc` shape from a two-GPU box: an Arc Pro
    /// alongside a Radeon (bobbyt5667's machine, Discord 2026-07-28).
    const DRIVER_DESC_OUT: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    DriverDesc    REG_SZ    Intel(R) Arc(TM) Pro B60 Graphics

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0001
    DriverDesc    REG_SZ    AMD Radeon RX 6800 XT

End of search: 2 match(es) found.
";

    /// 0x600000000 = 24 GiB, 0x400000000 = 16 GiB.
    const QW_MEMORY_OUT: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0001
    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000

End of search: 2 match(es) found.
";

    #[test]
    fn parse_reg_query_pairs_each_subkey_with_its_value() {
        let got = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        assert_eq!(
            got,
            vec![
                ("0000".to_string(), "Intel(R) Arc(TM) Pro B60 Graphics".to_string()),
                ("0001".to_string(), "AMD Radeon RX 6800 XT".to_string()),
            ]
        );
    }

    #[test]
    fn parse_reg_query_ignores_the_trailing_summary_line() {
        // "End of search: …" sits at column 0 but is not a key, so it must not
        // become one and swallow the next value.
        let got = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        assert!(got.iter().all(|(k, _)| k == "0000" || k == "0001"));
    }

    #[test]
    fn parse_reg_query_skips_other_value_names() {
        assert!(parse_reg_query(DRIVER_DESC_OUT, "HardwareInformation.qwMemorySize").is_empty());
    }

    // ── Runde 20: the two registry holes from the AMD deep-dive ───────────

    /// The branch as it really looks. MEASURED on the Windows box on
    /// 2026-08-31: `reg query <CLASS> /s` returns 27 keys and exactly one of
    /// them is an adapter; the rest is `<CLASS>\Configuration` with its subtree
    /// and `<CLASS>\Properties`. The `DriverDesc` values sitting inside the
    /// Configuration subtree here are the constructed worst case, not a
    /// measured one: `/v DriverDesc` keeps that subtree out only as long as
    /// nothing in it carries that value, which is likely but not a rule.
    const NOISY_DRIVER_DESC_OUT: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    DriverDesc    REG_SZ    AMD Radeon RX 7900 XTX

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\Configuration\AMD_RADEON_RX_7900_XTX\00\00\Control\Video\{9f7f7c19-1111-2222-3333-444444444444}\Video
    DriverDesc    REG_SZ    Configuration subtree, not an adapter

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\Configuration\AMD_RADEON_RX_7900_XTX\00\00\Services\amdkmdap\Video
    DriverDesc    REG_SZ    Services subtree, not an adapter either

End of search: 3 match(es) found.
";

    #[test]
    fn only_a_four_digit_subkey_under_the_class_guid_counts_as_an_adapter() {
        let got = parse_reg_query(NOISY_DRIVER_DESC_OUT, "DriverDesc");
        assert_eq!(got, vec![("0000".to_string(), "AMD Radeon RX 7900 XTX".to_string())]);

        // NEGATIVE CONTROL, backwards: the rule this replaced was "leaf name of
        // any line starting with HKEY_". Run it over the same text and the box
        // grows two cards it does not have.
        let old_rule: Vec<String> = NOISY_DRIVER_DESC_OUT
            .lines()
            .filter(|l| l.starts_with("HKEY_"))
            .filter_map(|l| l.rsplit('\\').next().map(|s| s.to_string()))
            .collect();
        assert_eq!(old_rule.len(), 3, "the old rule took every key line: {old_rule:?}");
        assert!(old_rule.contains(&"Video".to_string()), "{old_rule:?}");
    }

    #[test]
    fn the_subkey_rule_takes_the_numbered_keys_and_nothing_around_them() {
        let base = r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
        assert_eq!(adapter_subkey(&format!(r"{base}\0000")), Some("0000"));
        assert_eq!(adapter_subkey(&format!(r"{base}\0013")), Some("0013"));
        // Case: reg.exe is not required to echo the GUID in lowercase.
        let shouting = format!(r"{}\0001", base.to_ascii_uppercase());
        assert_eq!(adapter_subkey(&shouting), Some("0001"));
        // Everything the branch carries besides adapters.
        assert_eq!(adapter_subkey(&format!(r"{base}\Configuration")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\Properties")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\Configuration\X\00\00\Video")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\0000\Session\vbios")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\000")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\00001")), None);
        assert_eq!(adapter_subkey(&format!(r"{base}\00a0")), None);
        assert_eq!(adapter_subkey(base), None);
        // A different device class entirely, in case a query is ever widened.
        assert_eq!(
            adapter_subkey(r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}\0000"),
            None,
        );
        assert_eq!(adapter_subkey("End of search: 3 match(es) found."), None);
    }

    #[test]
    fn an_entry_with_no_sign_of_present_hardware_sorts_behind_one_that_has_it() {
        // 0000 is the leftover of a card that is no longer in the box: the
        // subkey and its DriverDesc survive removal, and the size query has
        // nothing for it. 0001 is the card that is actually installed. 0002 is
        // the Microsoft basic display driver, which the deep-dive measured out
        // of C:\Windows\INF\display.inf.
        let names = vec![
            ("0000".to_string(), "AMD Radeon RX 6800 XT".to_string()),
            ("0001".to_string(), "AMD Radeon RX 9070 XT".to_string()),
            ("0002".to_string(), "Microsoft Basic Display Adapter".to_string()),
        ];
        let sizes = vec![("0001".to_string(), "0x400000000".to_string())];
        let found = detect_other_via_registry_from(&names, &sizes, false);

        // The card with evidence leads its vendor, so index 0 and the first row
        // in the picker are the one we can show a measurement for.
        assert_eq!(found[0].name, "AMD Radeon RX 9070 XT");
        assert_eq!((found[0].index, found[0].memory_mib), (0, Some(16384)));
        assert_eq!(found[1].name, "AMD Radeon RX 6800 XT");
        assert_eq!((found[1].index, found[1].memory_mib), (1, None));

        // NEGATIVE CONTROL, backwards: registry order alone put the leftover
        // first, which is what HIP_VISIBLE_DEVICES=0 would then have named.
        assert_ne!(found[0].name, names[0].1, "still ranking by subkey number");

        // The ranking demotes, it never deletes: an integrated card has no
        // qwMemorySize either and has to stay in the list.
        assert_eq!(found.len(), 3, "{found:?}");
        // And the basic display driver stays "unknown" instead of being talked
        // into a vendor, because without a vendor driver ROCm cannot run anyway.
        assert_eq!(found[2].vendor, "unknown");
        assert_eq!(found[2].index, 0, "vendors are counted separately");
    }

    #[test]
    fn parse_reg_hex_reads_qword_payloads() {
        assert_eq!(parse_reg_hex("0x600000000"), Some(25_769_803_776));
        assert_eq!(parse_reg_hex("  0x400000000 "), Some(17_179_869_184));
        assert_eq!(parse_reg_hex("24 GB"), None);
    }

    /// The bug: WMI's uint32 AdapterRAM reported 2 GB for a 24 GB Arc Pro B60.
    /// The registry qword has the real number, and the registry probe reads it
    /// off the same subkey the name came from.
    #[test]
    fn the_registry_reports_the_true_size_of_a_card_larger_than_uint32() {
        let names = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        let sizes = parse_reg_query(QW_MEMORY_OUT, "HardwareInformation.qwMemorySize");
        let found = detect_other_via_registry_from(&names, &sizes, false);
        let sized: Vec<(String, Option<u64>)> =
            found.iter().map(|g| (g.name.clone(), g.memory_mib)).collect();
        assert_eq!(
            sized,
            vec![
                ("Intel(R) Arc(TM) Pro B60 Graphics".to_string(), Some(24576)),
                ("AMD Radeon RX 6800 XT".to_string(), Some(16384)),
            ]
        );
        // NEGATIVE CONTROL: wmic's own number for that card. Anything that
        // rounds a 24 GB card down to 2 GB must not be what the picker shows.
        assert_ne!(sized[0].1, Some(2048));
    }

    #[test]
    fn the_registry_leaves_the_size_open_when_there_is_none_to_read() {
        let names = vec![
            ("0000".to_string(), "Intel(R) Arc(TM) Pro B60 Graphics".to_string()),
            ("0001".to_string(), "Microsoft Basic Display Adapter".to_string()),
            ("0002".to_string(), "Some Virtual Adapter".to_string()),
        ];
        let sizes = vec![
            ("0000".to_string(), "0x600000000".to_string()),
            ("0002".to_string(), "0x0".to_string()),
        ];
        let found = detect_other_via_registry_from(&names, &sizes, false);
        // A missing or zero qword means "size unknown", never a made-up number:
        // the app sizes models against this.
        assert_eq!(found[0].memory_mib, Some(24576));
        assert_eq!(found[1].memory_mib, None);
        assert_eq!(found[2].memory_mib, None);
    }

    #[test]
    fn apply_gpu_env_sets_cuda_for_nvidia() {
        let sel = GpuSelection { vendor: "nvidia".into(), indices: vec![1, 2] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        // We can inspect envs via get_envs (Rust 1.69+).
        let has_cuda = cmd.get_envs().any(|(k, v)| k == "CUDA_VISIBLE_DEVICES" && v.map(|s| s == "1,2").unwrap_or(false));
        assert!(has_cuda, "CUDA_VISIBLE_DEVICES should be set to 1,2");
    }

    #[test]
    fn apply_gpu_env_sets_hip_and_rocr_for_amd() {
        let sel = GpuSelection { vendor: "amd".into(), indices: vec![0] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let hip = cmd.get_envs().any(|(k, v)| k == "HIP_VISIBLE_DEVICES" && v.map(|s| s == "0").unwrap_or(false));
        let rocr = cmd.get_envs().any(|(k, v)| k == "ROCR_VISIBLE_DEVICES" && v.map(|s| s == "0").unwrap_or(false));
        assert!(hip, "HIP_VISIBLE_DEVICES should be set");
        assert!(rocr, "ROCR_VISIBLE_DEVICES should be set");
    }

    #[test]
    fn apply_gpu_env_sets_oneapi_for_intel() {
        let sel = GpuSelection { vendor: "intel".into(), indices: vec![0, 1] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let sycl = cmd.get_envs().any(|(k, v)| k == "ONEAPI_DEVICE_SELECTOR" && v.map(|s| s == "level_zero:0,level_zero:1").unwrap_or(false));
        assert!(sycl, "ONEAPI_DEVICE_SELECTOR should be set to level_zero:0,level_zero:1");
    }


    // ── AMD without ROCm tools (numbrain forum help-image-gen, lapbo Win11 +
    // ZLUDA, nosferatue412 asking before buying a 9060 XT) ────────────────
    //
    // numbrain's RX 9070 XT was reported correctly by his system and did not
    // appear in LU's picker at all, so he spent days rebuilding his install
    // chasing a driver problem that was not there. rocm-smi is not part of the
    // AMD driver; it ships with the ROCm dev packages, which nobody running a
    // prebuilt ROCm Ollama or a ZLUDA ComfyUI has a reason to install.

    /// numbrain's card, in the exact shape `lspci -nn` prints it.
    const LSPCI_AMD: &str = "03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070 XT] [1002:7550] (rev c0)";
    const LSPCI_INTEL: &str = "00:02.0 VGA compatible controller [0300]: Intel Corporation AlderLake-S GT1 [Intel UHD Graphics 770] [8086:4680]";
    const LSPCI_NVIDIA: &str = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA104 [GeForce RTX 3060] [10de:2487] (rev a1)";

    #[test]
    fn the_card_gets_its_marketing_name_not_the_pci_id() {
        use super::lspci_device_name;
        // NEGATIVE CONTROL: the old expression, which was fine while only
        // Intel reached this branch and is nonsense for anything else.
        let old_rule = LSPCI_AMD.split(':').last().unwrap();
        assert_eq!(old_rule.trim(), "7550] (rev c0)");

        assert_eq!(
            lspci_device_name(LSPCI_AMD),
            "Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070 XT]"
        );
        assert_eq!(
            lspci_device_name(LSPCI_INTEL),
            "Intel Corporation AlderLake-S GT1 [Intel UHD Graphics 770]"
        );
        assert_eq!(
            lspci_device_name(LSPCI_NVIDIA),
            "NVIDIA Corporation GA104 [GeForce RTX 3060]"
        );
    }

    #[test]
    fn a_line_in_an_unexpected_shape_never_yields_an_empty_name() {
        use super::lspci_device_name;
        assert_eq!(lspci_device_name("garbage"), "garbage");
        assert_eq!(lspci_device_name("00:02.0 VGA compatible controller [0300]: [1002:7550]"), "GPU");
    }

    #[test]
    fn an_amd_card_found_without_rocm_says_so_and_an_nvidia_one_has_nothing_to_say() {
        use super::note_for;
        let note = note_for("amd").expect("amd needs a note");
        assert!(note.contains("ROCm"));
        // It must not read as "your card does not work": ROCm Ollama and ZLUDA
        // ComfyUI both drive the card fine without rocm-smi anywhere.
        assert!(note.contains("can still use the card"));
        assert!(note_for("nvidia").is_none());
        assert!(note_for("intel").is_none());
    }

    #[test]
    fn lspci_lists_the_amd_card_when_rocm_smi_answered_nothing() {
        use super::detect_other_via_lspci_from;
        let raw = format!("{LSPCI_NVIDIA}\n{LSPCI_AMD}\n{LSPCI_INTEL}\n");

        // No rocm-smi: the AMD card MUST show up, or the picker is empty and
        // the customer concludes LU cannot see his hardware.
        let found = detect_other_via_lspci_from(&raw, false);
        let amd: Vec<_> = found.iter().filter(|g| g.vendor == "amd").collect();
        assert_eq!(amd.len(), 1);
        assert!(amd[0].name.contains("9070 XT"));
        assert!(amd[0].note.is_some());
        // Vendor-scoped indices: the AMD card is HIP device 0 even though the
        // Intel iGPU came first in the list.
        assert_eq!(amd[0].index, 0);
        assert_eq!(found.iter().find(|g| g.vendor == "intel").unwrap().index, 0);

        // rocm-smi answered: its entry carries VRAM, so this one would be a
        // worse duplicate.
        let deduped = detect_other_via_lspci_from(&raw, true);
        assert!(!deduped.iter().any(|g| g.vendor == "amd"));

        // nvidia-smi ships with the driver, so NVIDIA is never taken from here.
        assert!(!found.iter().any(|g| g.vendor == "nvidia"));
    }

    /// The Windows fallback must count per vendor for the same reason lspci
    /// does. HIP_VISIBLE_DEVICES is vendor-scoped, so on a box that lists an
    /// Intel iGPU first and an AMD card second, a shared counter hands the AMD
    /// card the number 1 while it is the only HIP device there is. That is
    /// lapbo's machine (Win11 plus ZLUDA, no rocm-smi), which is the entire
    /// reason this branch reports AMD at all.
    #[test]
    fn wmic_counts_per_vendor_not_across_them() {
        use super::detect_other_via_wmic_from;
        let raw = "\r\nNode,AdapterRAM,Name\r\nBOX,1073741824,Intel(R) UHD Graphics 770\r\nBOX,4293918720,AMD Radeon RX 7900 XTX\r\n";
        let found = detect_other_via_wmic_from(raw, false, &[]);
        assert_eq!(found.len(), 2, "both cards listed");
        let amd = found.iter().find(|g| g.vendor == "amd").expect("amd present");
        let intel = found.iter().find(|g| g.vendor == "intel").expect("intel present");
        assert_eq!(amd.index, 0, "the only AMD card is HIP device 0");
        assert_eq!(intel.index, 0, "the only Intel card is device 0 in its own view");
    }

    #[test]
    fn wmic_still_numbers_two_cards_of_one_vendor_in_order() {
        use super::detect_other_via_wmic_from;
        let raw = "\r\nNode,AdapterRAM,Name\r\nBOX,1073741824,AMD Radeon RX 7900 XTX\r\nBOX,1073741824,AMD Radeon RX 6800\r\n";
        let found = detect_other_via_wmic_from(raw, false, &[]);
        assert_eq!(found[0].index, 0);
        assert_eq!(found[1].index, 1);
    }

    #[test]
    fn wmic_skips_nvidia_and_honours_rocm() {
        use super::detect_other_via_wmic_from;
        let raw = "\r\nNode,AdapterRAM,Name\r\nBOX,1073741824,NVIDIA GeForce RTX 3060\r\nBOX,1073741824,AMD Radeon RX 7900 XTX\r\n";
        assert_eq!(detect_other_via_wmic_from(raw, true, &[]).len(), 0, "rocm-smi already reported it");
        let without = detect_other_via_wmic_from(raw, false, &[]);
        assert_eq!(without.len(), 1);
        assert_eq!(without[0].vendor, "amd");
        assert_eq!(without[0].index, 0);
    }

    #[test]
    fn wmic_header_and_blank_lines_are_not_devices() {
        use super::detect_other_via_wmic_from;
        let raw = "\r\nNode,AdapterRAM,Name\r\n\r\nBOX,1073741824,Intel(R) Arc A770\r\n";
        let found = detect_other_via_wmic_from(raw, false, &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Intel(R) Arc A770");
    }

    // ── Windows 11 23H2 and newer: wmic is gone ───────────────────────────
    //
    // Microsoft disabled wmic.exe by default in 23H2/24H2 and removed it in the
    // August 2026 servicing update, where it is not even a Feature on Demand
    // any more. It was this module's only Windows probe that did not need a
    // vendor CLI, and rocm-smi is not part of the AMD driver, so on a current
    // Windows an AMD card fell out of detection entirely: no entry in the
    // picker, and every decision downstream taken as if the box had no GPU.

    /// `reg query … /v DriverDesc` on lapbo's kind of box: one AMD card, no
    /// vendor CLI anywhere.
    const DRIVER_DESC_AMD_ONLY: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    DriverDesc    REG_SZ    AMD Radeon RX 7900 XTX

End of search: 1 match(es) found.
";

    #[test]
    fn an_amd_card_is_still_found_on_a_windows_that_has_no_wmic() {
        let names = parse_reg_query(DRIVER_DESC_AMD_ONLY, "DriverDesc");
        let found = windows_fallback_from(&names, &[], None, false);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].vendor, "amd");
        assert_eq!(found[0].name, "AMD Radeon RX 7900 XTX");
        assert_eq!(found[0].index, 0, "the only AMD card is HIP device 0");
        assert_eq!(found[0].source, "registry");
        assert!(found[0].note.is_some(), "found without ROCm tools, say so");

        // NEGATIVE CONTROL: the same machine as the code saw it before this
        // change, where wmic was the only probe. Nothing at all comes back,
        // which is the whole bug.
        assert!(windows_fallback_from(&[], &[], None, false).is_empty());
    }

    #[test]
    fn wmic_still_answers_on_the_older_windows_that_still_has_it() {
        // The registry stays first, but nothing may regress for a box where
        // `reg query` comes back empty and wmic is alive.
        let raw = "\r\nNode,AdapterRAM,Name\r\nBOX,1073741824,AMD Radeon RX 7900 XTX\r\n";
        let found = windows_fallback_from(&[], &[], Some(raw), false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].vendor, "amd");
        assert_eq!(found[0].source, "wmic");
    }

    #[test]
    fn the_registry_wins_over_wmic_when_both_answer() {
        // Same card from both probes must not become two cards, and the entry
        // that carries a real VRAM number is the one to keep.
        let names = parse_reg_query(DRIVER_DESC_AMD_ONLY, "DriverDesc");
        let sizes = vec![("0000".to_string(), "0x600000000".to_string())];
        let wmic = "\r\nNode,AdapterRAM,Name\r\nBOX,1073741824,AMD Radeon RX 7900 XTX\r\n";
        let found = windows_fallback_from(&names, &sizes, Some(wmic), false);
        assert_eq!(found.len(), 1, "one card, not one per probe: {found:?}");
        assert_eq!(found[0].source, "registry");
        assert_eq!(found[0].memory_mib, Some(24576));
    }

    /// The test gap this round was asked to close.
    ///
    /// `force_gpu_warning` already has a test forbidding the "Reinstall the
    /// ComfyUI environment" advice for a Windows AMD box, because no rebuild
    /// can produce a wheel that does not exist. That test mocks `has_amd` to
    /// true and so stayed green while the product answered the opposite: on a
    /// wmic-less Windows the detection handed it `false`, and the message fell
    /// into the generic branch that gives exactly the forbidden advice.
    ///
    /// This one runs the real detection first and feeds its verdict in, so the
    /// two halves can no longer disagree.
    #[test]
    fn windows_amd_never_gets_reinstall_advice_when_the_detection_is_the_real_one() {
        use crate::commands::process::{force_gpu_warning, ComfyGpuMode};
        let names = parse_reg_query(DRIVER_DESC_AMD_ONLY, "DriverDesc");
        let has_amd = windows_fallback_from(&names, &[], None, false)
            .iter()
            .any(|g| g.vendor == "amd");
        assert!(has_amd, "the detection has to see the card for any of this to work");
        let warn = force_gpu_warning(ComfyGpuMode::ForceGpu, Some(false), has_amd, "windows")
            .expect("a forced GPU on a torch without one is worth a word");
        assert!(
            !warn.contains("Reinstall the ComfyUI environment"),
            "advice no rebuild can deliver: {warn}",
        );

        // NEGATIVE CONTROL: the wmic-only detection, which is what every
        // Windows 11 from 23H2 on had. It reports no AMD card, and the product
        // then gives the user precisely the advice the older test forbids.
        let blind = windows_fallback_from(&[], &[], None, false)
            .iter()
            .any(|g| g.vendor == "amd");
        assert!(!blind, "wmic is gone, so this probe is blind");
        let wrong = force_gpu_warning(ComfyGpuMode::ForceGpu, Some(false), blind, "windows")
            .expect("still a warning, just the wrong one");
        assert!(
            wrong.contains("Reinstall the ComfyUI environment"),
            "if this ever stops holding the negative control has rotted: {wrong}",
        );
    }


    // ── A5: the Windows HIP SDK, GitHub #123 (Zhorts, RX 9070 XT, 7.1.1) ──
    //
    // Zhorts had a correct HIP SDK 7.1.1 install and LU said "Found without
    // ROCm tools" anyway, because the only ROCm probe in this file ran
    // `rocm-smi`, which the Windows SDK does not ship. The output below is the
    // shape hipinfo really prints: labels padded to 34 columns, `device#`
    // without a colon, and a trailing memInfo block. The 0.16 GB in the second
    // device is not a typo, it is ROCm issue #5105 verbatim (hipinfo on Windows
    // reporting 0.16 GB for a 16 GB RX 6950 XT under HIP SDK 6.2), kept here so
    // the "do not trust this field" rule has something to be proven against.
    const HIPINFO_ONE_CARD: &str = "\
--------------------------------------------------------------------------------
device#                           0
Name:                             AMD Radeon RX 9070 XT
pciBusID:                         3
pciDeviceID:                      0
multiProcessorCount:              32
clockRate:                        2970 Mhz
memoryBusWidth:                   256
totalGlobalMem:                   15.98 GB
totalConstMem:                    2147483647
sharedMemPerBlock:                64.00 KB
warpSize:                         32
major:                            12
minor:                            0
isIntegrated:                     0
arch.hasGlobalInt32Atomics:       1
gcnArchName:                      gfx1201
peers:
non-peers:                        device#0

memInfo.total:                    15.98 GB
memInfo.free:                     15.44 GB (97%)
";

    const HIPINFO_BROKEN_SIZE: &str = "\
--------------------------------------------------------------------------------
device#                           0
Name:                             AMD Radeon RX 6950 XT
totalGlobalMem:                   0.16 GB
gcnArchName:                      gfx1030
peers:
non-peers:                        device#0
";

    #[test]
    fn hipinfo_yields_the_card_its_architecture_and_its_size() {
        let devs = parse_hipinfo(HIPINFO_ONE_CARD);
        assert_eq!(devs.len(), 1, "{devs:?}");
        assert_eq!(devs[0].index, 0);
        assert_eq!(devs[0].name, "AMD Radeon RX 9070 XT");
        assert_eq!(devs[0].arch.as_deref(), Some("gfx1201"));
        assert_eq!(devs[0].total_global_mem_mib, Some(16364));

        // NEGATIVE CONTROL: `non-peers: device#0` is a value row, not a second
        // device, and the trailing memInfo block is not a third. A parser that
        // split on "device#" anywhere in the line would grow both.
        assert!(HIPINFO_ONE_CARD.contains("non-peers:                        device#0"));
        assert_eq!(devs.len(), 1);
    }

    #[test]
    fn hipinfo_blocks_do_not_bleed_into_each_other() {
        let two = format!("{HIPINFO_ONE_CARD}{HIPINFO_BROKEN_SIZE}");
        let devs = parse_hipinfo(&two);
        assert_eq!(devs.len(), 2, "{devs:?}");
        assert_eq!(devs[0].arch.as_deref(), Some("gfx1201"));
        assert_eq!(devs[1].name, "AMD Radeon RX 6950 XT");
        assert_eq!(devs[1].arch.as_deref(), Some("gfx1030"));
    }

    #[test]
    fn hipinfo_that_says_nothing_yields_nothing() {
        // NEGATIVE CONTROLS: a tool that is not there, a tool that errored, and
        // a block with no fields worth reading must all come back empty rather
        // than as a phantom card.
        assert!(parse_hipinfo("").is_empty());
        assert!(parse_hipinfo("hipinfo.exe is not recognized as an internal or external command").is_empty());
        assert!(parse_hipinfo("device#                           0\npciBusID:  3\n").is_empty());
        // A value row before any device# header belongs to no device.
        assert!(parse_hipinfo("Name:  AMD Radeon RX 9070 XT\n").is_empty());
    }

    #[test]
    fn hip_sizes_are_read_in_whatever_unit_the_build_printed() {
        assert_eq!(parse_hip_size_mib("15.98 GB"), Some(16364));
        assert_eq!(parse_hip_size_mib("64.00 KB"), None, "under a MiB is not a card size");
        assert_eq!(parse_hip_size_mib("16384 MB"), Some(16384));
        // Older builds print the raw byte count with no unit at all.
        assert_eq!(parse_hip_size_mib("17163091968"), Some(16368));
        // NEGATIVE CONTROLS: nothing invented out of a shape nobody planned for.
        assert_eq!(parse_hip_size_mib("unknown"), None);
        assert_eq!(parse_hip_size_mib("0.00 GB"), None);
        assert_eq!(parse_hip_size_mib("15.98 furlongs"), None);
        assert_eq!(parse_hip_size_mib(""), None);
    }

    #[test]
    fn the_install_root_comes_out_of_the_environment_with_no_version_written_down() {
        let vars = vec![
            ("PATH".to_string(), r"C:\Windows".to_string()),
            ("HIP_PATH".to_string(), r"C:\Program Files\AMD\ROCm\7.1\".to_string()),
            ("HIP_PATH_57".to_string(), r"C:\Program Files\AMD\ROCm\5.7".to_string()),
            ("ROCM_PATH".to_string(), "/opt/rocm".to_string()),
            ("HIP_PLATFORM".to_string(), "amd".to_string()),
        ];
        let roots = hip_roots_from_env(&vars);
        assert_eq!(
            roots,
            vec![
                r"C:\Program Files\AMD\ROCm\7.1".to_string(),
                r"C:\Program Files\AMD\ROCm\5.7".to_string(),
                "/opt/rocm".to_string(),
            ],
            "trailing separator dropped, HIP_PLATFORM is not a path",
        );
        // NEGATIVE CONTROL: an environment with no HIP in it names no root, so
        // the probe stays silent instead of guessing at a default path.
        assert!(hip_roots_from_env(&[("PATH".to_string(), r"C:\Windows".to_string())]).is_empty());
        assert!(hip_roots_from_env(&[("HIP_PATH".to_string(), "   ".to_string())]).is_empty());
    }

    #[test]
    fn the_newest_installed_sdk_is_tried_first() {
        let dirs = vec!["5.7".to_string(), "7.1".to_string(), "6.4".to_string(), "7.1.1".to_string()];
        assert_eq!(rocm_dirs_newest_first(&dirs), vec!["7.1.1", "7.1", "6.4", "5.7"]);
        // A directory that is not a version is kept, just last: an unknown name
        // is still a better guess than no probe at all.
        let mixed = vec!["nightly".to_string(), "6.4".to_string()];
        assert_eq!(rocm_dirs_newest_first(&mixed), vec!["6.4", "nightly"]);
        // NEGATIVE CONTROL: a plain string sort puts 7.1.1 behind 5.7 the moment
        // a two-digit component shows up, which is how a version pin creeps in.
        let ten = vec!["7.1".to_string(), "7.10".to_string()];
        assert_eq!(rocm_dirs_newest_first(&ten), vec!["7.10", "7.1"]);
    }

    #[test]
    fn the_version_is_read_off_the_directory_never_assumed() {
        assert_eq!(hip_version_from_root(r"C:\Program Files\AMD\ROCm\7.1"), Some("7.1".into()));
        assert_eq!(hip_version_from_root(r"C:\Program Files\AMD\ROCm\7.1\"), Some("7.1".into()));
        assert_eq!(hip_version_from_root("/opt/rocm-6.4.1"), None, "not a bare version segment");
        assert_eq!(hip_version_from_root("/opt/rocm"), None);
    }

    /// The bug as Zhorts hit it, end to end through the pure halves: a Windows
    /// box whose registry reports the card and its true 16 GB, and a HIP SDK
    /// that rocm-smi knows nothing about.
    #[test]
    fn a_windows_card_with_the_hip_sdk_stops_claiming_rocm_is_missing() {
        let names = vec![("0000".to_string(), "AMD Radeon RX 9070 XT".to_string())];
        let sizes = vec![("0000".to_string(), "0x400000000".to_string())];
        let mut gpus = windows_fallback_from(&names, &sizes, None, false);

        // NEGATIVE CONTROL: this is the message Zhorts saw, and the state the
        // fix has to leave behind.
        assert_eq!(gpus.len(), 1);
        assert!(gpus[0].note.as_deref().unwrap().contains("Found without ROCm tools"));
        assert_eq!(gpus[0].arch, None);

        let facts = RocmFacts { version: Some("7.1".into()), devices: parse_hipinfo(HIPINFO_ONE_CARD) };
        apply_rocm_facts(&mut gpus, Some(&facts));

        assert_eq!(gpus.len(), 1, "one card, not one per probe: {gpus:?}");
        assert_eq!(gpus[0].arch.as_deref(), Some("gfx1201"));
        let note = gpus[0].note.as_deref().unwrap();
        assert!(!note.contains("Found without ROCm tools"), "{note}");
        assert!(note.contains("ROCm 7.1 is installed"), "{note}");
        // A12: the note has to say that a visible card and a usable PyTorch are
        // two different things, and name the architecture the build must carry.
        assert!(note.contains("gfx1201"), "{note}");
        assert!(note.contains("hipErrorInvalidValue"), "{note}");

        // The registry's measured 16 GB survives untouched. hipinfo's own
        // number is never allowed to overwrite it (ROCm #5105).
        assert_eq!(gpus[0].memory_mib, Some(16384));
        assert_eq!(gpus[0].source, "registry");
    }

    #[test]
    fn hipinfos_own_vram_number_never_overwrites_a_measured_one() {
        // Same card, and hipinfo is having the #5105 day: 0.16 GB for a 16 GB
        // board. The registry measured 16 GB, and that is what has to survive.
        let names = vec![("0000".to_string(), "AMD Radeon RX 6950 XT".to_string())];
        let sizes = vec![("0000".to_string(), "0x400000000".to_string())];
        let mut gpus = windows_fallback_from(&names, &sizes, None, false);
        let facts = RocmFacts { version: Some("6.2".into()), devices: parse_hipinfo(HIPINFO_BROKEN_SIZE) };
        apply_rocm_facts(&mut gpus, Some(&facts));
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].memory_mib, Some(16384), "the miniport's qword, not hipinfo's 0.16 GB");
        assert_eq!(gpus[0].arch.as_deref(), Some("gfx1030"));

        // NEGATIVE CONTROL: with no other probe to lean on, the broken number is
        // still refused. Unknown is honest; 0.16 GB would size models against a
        // card that does not exist.
        let mut alone: Vec<DetectedGpu> = vec![];
        apply_rocm_facts(&mut alone, Some(&facts));
        assert_eq!(alone.len(), 1, "the card is still listed: {alone:?}");
        assert_eq!(alone[0].memory_mib, None, "below the trust floor, so unknown");
        assert_eq!(alone[0].source, "hipinfo");
        assert_eq!(alone[0].vendor, "amd");
    }

    #[test]
    fn a_card_only_the_hip_sdk_can_see_is_still_listed() {
        // Registry unreadable, no wmic, no rocm-smi. Before this the picker was
        // empty; now the SDK's own answer is the entry.
        let mut gpus = windows_fallback_from(&[], &[], None, false);
        assert!(gpus.is_empty(), "NEGATIVE CONTROL: nothing else answered");
        let facts = RocmFacts { version: Some("7.1".into()), devices: parse_hipinfo(HIPINFO_ONE_CARD) };
        apply_rocm_facts(&mut gpus, Some(&facts));
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].vendor, "amd");
        assert_eq!(gpus[0].index, 0, "the only AMD card is HIP device 0");
        assert_eq!(gpus[0].name, "AMD Radeon RX 9070 XT");
        // 15.98 GB is above the floor, so here it IS the best number available.
        assert_eq!(gpus[0].memory_mib, Some(16364));
        assert_eq!(gpus[0].source, "hipinfo");
    }

    #[test]
    fn no_hip_sdk_changes_nothing_at_all() {
        // Linux and macOS take this path on every run, and so does every Windows
        // box without the SDK. The list must come out exactly as it went in.
        let names = parse_reg_query(DRIVER_DESC_AMD_ONLY, "DriverDesc");
        let before = windows_fallback_from(&names, &[], None, false);
        let mut after = before.clone();
        apply_rocm_facts(&mut after, None);
        assert_eq!(after.len(), before.len());
        assert_eq!(after[0].note, before[0].note);
        assert_eq!(after[0].arch, None);
        // An SDK that answered with no devices is the same as no SDK.
        let empty = RocmFacts { version: Some("7.1".into()), devices: vec![] };
        let mut after2 = before.clone();
        apply_rocm_facts(&mut after2, Some(&empty));
        assert_eq!(after2[0].note, before[0].note);
    }

    #[test]
    fn only_amd_cards_are_touched_by_the_hip_probe() {
        // An Intel iGPU next to the Radeon. HIP has nothing to say about it and
        // must not be given a note that mentions ROCm.
        let names = vec![
            ("0000".to_string(), "Intel(R) UHD Graphics 770".to_string()),
            ("0001".to_string(), "AMD Radeon RX 9070 XT".to_string()),
        ];
        let mut gpus = windows_fallback_from(&names, &[], None, false);
        let facts = RocmFacts { version: Some("7.1".into()), devices: parse_hipinfo(HIPINFO_ONE_CARD) };
        apply_rocm_facts(&mut gpus, Some(&facts));
        let intel = gpus.iter().find(|g| g.vendor == "intel").unwrap();
        let amd = gpus.iter().find(|g| g.vendor == "amd").unwrap();
        assert_eq!(intel.arch, None);
        assert!(!intel.note.clone().unwrap_or_default().contains("ROCm 7.1"));
        assert_eq!(amd.arch.as_deref(), Some("gfx1201"));
        // And the vendor-scoped index is still the AMD card's own.
        assert_eq!(amd.index, 0);
    }

    #[test]
    fn two_amd_cards_each_get_their_own_architecture() {
        let names = vec![
            ("0000".to_string(), "AMD Radeon RX 6950 XT".to_string()),
            ("0001".to_string(), "AMD Radeon RX 9070 XT".to_string()),
        ];
        let mut gpus = windows_fallback_from(&names, &[], None, false);
        // hipinfo lists them in the other order on purpose: matching is by name
        // first, so the order the two probes disagree on must not matter.
        let two = format!("{HIPINFO_ONE_CARD}{HIPINFO_BROKEN_SIZE}");
        let facts = RocmFacts { version: Some("7.1".into()), devices: parse_hipinfo(&two) };
        apply_rocm_facts(&mut gpus, Some(&facts));
        assert_eq!(gpus.len(), 2, "no card invented, none lost: {gpus:?}");
        let by_name = |n: &str| gpus.iter().find(|g| g.name == n).unwrap().arch.clone();
        assert_eq!(by_name("AMD Radeon RX 6950 XT").as_deref(), Some("gfx1030"));
        assert_eq!(by_name("AMD Radeon RX 9070 XT").as_deref(), Some("gfx1201"));
    }

    #[test]
    fn the_note_says_less_rather_than_more_when_the_sdk_said_less() {
        // No version directory to read and no architecture reported. The note
        // still has to be true, and must not fill either gap with a number.
        let note = rocm_note(None, None).unwrap();
        assert!(note.starts_with("A ROCm HIP SDK is installed"), "{note}");
        assert!(!note.contains("gfx"), "{note}");
        // NEGATIVE CONTROL: no version string may leak in from this file.
        for v in ["7.1", "6.4", "5.7"] {
            assert!(!note.contains(v), "a version was written down in the code: {note}");
        }
        let with_arch = rocm_note(None, Some("gfx1200")).unwrap();
        assert!(with_arch.contains("gfx1200"), "{with_arch}");
        assert!(with_arch.contains("get_arch_list"), "point at the tool, not at a version: {with_arch}");
    }

    #[test]
    fn apply_gpu_env_is_noop_when_auto() {
        let sel = GpuSelection { vendor: "auto".into(), indices: vec![1] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        // "auto" doesn't match any vendor branch — env should be empty (no GPU vars)
        let any_gpu_env = cmd.get_envs().any(|(k, _)| {
            let key = k.to_string_lossy().to_string();
            key.contains("VISIBLE_DEVICES") || key == "ONEAPI_DEVICE_SELECTOR"
        });
        assert!(!any_gpu_env, "auto vendor must not set any GPU env-var");
    }

    #[test]
    fn apply_gpu_env_is_noop_when_indices_empty() {
        let sel = GpuSelection { vendor: "nvidia".into(), indices: vec![] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let any_gpu_env = cmd.get_envs().any(|(k, _)| {
            let key = k.to_string_lossy().to_string();
            key.contains("VISIBLE_DEVICES") || key == "ONEAPI_DEVICE_SELECTOR"
        });
        assert!(!any_gpu_env, "empty indices must not set any GPU env-var");
    }
}
