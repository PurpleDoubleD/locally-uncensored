//! Which PyTorch wheels belong on THIS machine.
//!
//! Two environments in the app build a Python venv and put torch in it: the
//! ComfyUI environment (`install.rs`) and the character trainer (`trainer.rs`).
//! Both used to ask `nvidia-smi` and nothing else, so an AMD card was
//! indistinguishable from a machine with no card at all and got the wheels a
//! card-less box gets. On the ComfyUI side that is exactly what numbrain,
//! lapbo, petermanmancusso and sancora reported: ComfyUI installs, starts,
//! and renders on the processor, and forcing the GPU produces
//! "Torch not compiled with CUDA enabled" because the wheels really are
//! CUDA-only.
//!
//! The decisions live here as pure functions with the probes injected, so a
//! test can drive every branch on a machine that has none of the hardware.
//! We own no AMD card, so the ROCm side of this file is researched against
//! download.pytorch.org and ComfyUI's own README rather than measured.

use std::time::Duration;

/// PyTorch's ROCm channels, the one we want most first.
///
/// Listing read from download.pytorch.org on 2026-08-28: rocm7.2 and rocm7.1
/// both carry torch up to 2.13.0, rocm6.4 stops at 2.9.1, and every single
/// wheel in every ROCm channel is `manylinux_2_28_x86_64`. There is no
/// win_amd64 ROCm wheel anywhere, which is the whole reason the Windows
/// branch below installs processor wheels instead of pretending. ComfyUI's
/// own README names rocm7.2 as the AMD install line, so that one leads and
/// the two older channels are there to catch a channel that gets retired.
pub(crate) const ROCM_CHANNELS: &[&str] = &[
    "https://download.pytorch.org/whl/rocm7.2",
    "https://download.pytorch.org/whl/rocm7.1",
    "https://download.pytorch.org/whl/rocm6.4",
];

/// AMD's own ROCm wheels for Windows. RESEARCHED, NOT PROVEN.
///
/// pytorch.org really does publish Linux ROCm wheels only, and the comment
/// above still holds for it. What changed is the conclusion drawn from that:
/// AMD publishes win_amd64 ROCm wheels from its own indexes, and this is the
/// one ComfyUI Desktop ships against, which is the closest thing to a field
/// proof this path has. Read 2026-08-30: it serves win_amd64 torch up to
/// 2.13.0+rocm7.14.0 and is described in Comfy-Desktop's own
/// `torch-index-stacks.md` as the only mechanism serving Windows ROCm wheels.
///
/// We own no AMD card. Nobody here has watched this install finish, let alone
/// render. That is why the plan built from it falls back to the processor
/// wheels when the index does not answer, instead of doing what the pytorch.org
/// ladders do and using the last entry regardless.
pub(crate) const ROCM_WINDOWS_CHANNELS: &[&str] = &["https://repo.amd.com/rocm/whl-multi-arch/"];

/// What pip installs when the index is a plain PyTorch channel.
pub(crate) const TORCH_TRIO: &[&str] = &["torch", "torchvision", "torchaudio"];

/// AMD's multi-arch index serves a slim `torch` plus one device package per
/// gfx target, selected through an extra. Installing bare `torch` from it would
/// produce an environment with no kernels for any card, so the extra is not
/// optional here. `device-all` is what AMD documents and what Comfy-Desktop
/// pins. RESEARCHED, NOT PROVEN, like the channel itself.
pub(crate) const TORCH_TRIO_AMD_WINDOWS: &[&str] =
    &["torch[device-all]", "torchvision", "torchaudio"];

/// Blackwell and newer: CUDA 12.6 has no sm_120 kernels at all, so cu126 is
/// not a fallback for these cards, it is a broken install. Only channels that
/// carry the kernel may appear here.
pub(crate) const CUDA_BLACKWELL_CHANNELS: &[&str] = &[
    "https://download.pytorch.org/whl/cu130",
    "https://download.pytorch.org/whl/cu128",
];

/// Turing (compute capability 7.5) up to Ada and Hopper.
///
/// ComfyUI moved its own recommendation on 2026-08-16 and its README now says
/// a cu130 or newer PyTorch is REQUIRED on 20 series cards and above, while
/// the cu126 portable is labelled for 10 series and older with a written
/// warning not to use it on anything newer. NVIDIA's CUDA 13.0 release notes
/// give the same line from the other side: support was removed for Maxwell,
/// Pascal and Volta, meaning everything below Turing, so cu130 starts exactly
/// at 7.5 and cu126 is what stays behind for the cards below it.
///
/// Index listings read on 2026-08-28: cu130 carries torch 2.9.1 through
/// 2.13.0 for manylinux_2_28_x86_64, manylinux_2_28_aarch64 and win_amd64,
/// with matching torchvision and torchaudio. cu128 has stopped at 2.11.0,
/// which is why it now sits behind cu130 rather than in front of it, and
/// cu126 still moves (2.13.0) so it remains a real fallback for this range.
pub(crate) const CUDA_MODERN_CHANNELS: &[&str] = &[
    "https://download.pytorch.org/whl/cu130",
    "https://download.pytorch.org/whl/cu128",
    "https://download.pytorch.org/whl/cu126",
];

/// Below Turing, and the machine whose capability probe stayed silent. cu126
/// is the living channel ComfyUI documents for this silicon (torch 2.6+,
/// sm_50 through sm_90). A silent probe means an nvidia-smi too old to answer
/// `--query-gpu=compute_cap`, which points at an old driver on an old card,
/// so the wide channel is the honest guess rather than the narrow new one.
pub(crate) const CUDA_LEGACY_CHANNELS: &[&str] = &[
    "https://download.pytorch.org/whl/cu126",
];

/// Where CUDA 13 begins. NVIDIA removed every architecture below Turing in
/// CUDA 13.0, and Turing is 7.5 while Volta is 7.0, so the minor number is
/// what decides here.
pub(crate) const CU130_MIN_CAP: (u32, u32) = (7, 5);

/// What the pip step should do about torch.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WheelPlan {
    /// Install from the first of these indexes that answers. The list is
    /// never empty, and its last entry is the fallback that gets used even
    /// when nothing answers, so a blocked network cannot leave the installer
    /// without a channel.
    Index {
        candidates: &'static [&'static str],
        note: String,
    },
    /// Try these indexes, and install the PROCESSOR wheels if none answers.
    ///
    /// The difference from `Index` is the dead-network case, and it is
    /// deliberate: this variant exists for a channel nobody here has ever run,
    /// so an unreachable channel falls back to what the app did before rather
    /// than to a guess.
    IndexOrCpu {
        candidates: &'static [&'static str],
        /// What pip installs from that index. Not every channel serves the
        /// same package names, so the plan carries them.
        packages: &'static [&'static str],
        note: String,
        /// The sentence the fallback shows when no candidate answered.
        cpu_note: String,
    },
    /// Install the plain PyPI wheels, which run on the processor. No index.
    Cpu { note: String },
}

// `WheelPlan::note()` used to be the accessor the installer read its sentence
// from. It is gone because a plan can now change its mind: `IndexOrCpu` falls
// back to the processor wheels when its channel does not answer, and then the
// sentence to show is the fallback's. `resolve_plan` hands out the index and
// the note together so the two can never drift apart.

/// What is known about an AMD card LU can only see by the name the OS gives it.
///
/// Nothing here is a guess about silicon: the gfx targets behind these ranges
/// were read out of the published wheels on 2026-08-30 (the code object list in
/// libtorch, which is what `torch.cuda.get_arch_list()` reports) and matched
/// against AMD's own compatibility matrix.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum AmdCoverage {
    /// The wheels carry this family's gfx target and AMD supports it here.
    Supported,
    /// Wheels for this family exist on this OS, but AMD makes no support
    /// promise for it, so LU will not send the user down that road.
    NotPromised,
    /// No official wheel carries this family's gfx target at all. The install
    /// SUCCEEDS and the first kernel then dies.
    NoKernels,
    /// The name says AMD and nothing more. An APU that reports itself as
    /// "AMD Radeon(TM) Graphics" lands here, and so does a workstation card.
    Unknown,
}

/// The Radeon RX model number out of an adapter name, if it carries one.
///
/// Every probe spells it differently. wmic and the registry give
/// "AMD Radeon RX 6700 XT", lspci gives
/// "Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT]", and
/// rocm-smi gives the product name. All three contain "RX <four digits>", so
/// that is what is read, and nothing else is inferred.
fn radeon_rx_model(name: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("rx") {
        let at = from + rel;
        // "rx" has to be a word of its own, or "Firepro Sx" style names and
        // any word ending in rx would start matching digits after them.
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        if before_ok {
            let digits: String = lower[at + 2..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.len() == 4 {
                if let Ok(n) = digits.parse::<u32>() {
                    return Some(n);
                }
            }
        }
        from = at + 2;
    }
    None
}

/// What one AMD card can expect from the wheels this OS has.
///
/// Measured wheel contents, 2026-08-30. Linux, torch 2.10 and up: gfx1030,
/// 1100, 1101, 1102, 1200, 1201, 950, 1150, 1151 are in, and gfx1010, 1012,
/// 1031, 1032, 1033 to 1036 and 90c are in NO official wheel. Windows: AMD's
/// support promise covers RDNA 3, 3.5 and 4 and stops there. RDNA 2 wheels are
/// built for Windows but with hipBLASLt, composable_kernel and rocWMMA
/// excluded from every gfx103X target, and AMD promises nothing for them.
pub(crate) fn amd_coverage(name: &str, os: &str) -> AmdCoverage {
    let Some(model) = radeon_rx_model(name) else {
        return AmdCoverage::Unknown;
    };
    match (os, model) {
        // RDNA1. In no wheel on either OS.
        (_, 5000..=5999) => AmdCoverage::NoKernels,
        // RX 6400 to 6750 are gfx1031/1032/1034, in no official wheel anywhere.
        (_, 6000..=6799) => AmdCoverage::NoKernels,
        // RX 6800 and up are gfx1030: in the Linux wheels and sound over the
        // rocBLAS path, but outside AMD's Windows promise.
        ("linux", 6800..=6999) => AmdCoverage::Supported,
        (_, 6800..=6999) => AmdCoverage::NotPromised,
        // RDNA3 (gfx1100/1101/1102) and RDNA4 (gfx1200/1201).
        (_, 7000..=7999) | (_, 9000..=9999) => AmdCoverage::Supported,
        _ => AmdCoverage::Unknown,
    }
}

/// The verdict for a whole machine. The best card wins, for the same reason
/// NVIDIA wins over AMD: the plan has to serve the card the user renders on.
/// A card we cannot place never overrides one we can.
pub(crate) fn amd_fleet_coverage(names: &[&str], os: &str) -> AmdCoverage {
    let mut verdict = AmdCoverage::Unknown;
    for name in names {
        match amd_coverage(name, os) {
            AmdCoverage::Supported => return AmdCoverage::Supported,
            AmdCoverage::NoKernels => verdict = AmdCoverage::NoKernels,
            AmdCoverage::NotPromised if verdict != AmdCoverage::NoKernels => {
                verdict = AmdCoverage::NotPromised
            }
            _ => {}
        }
    }
    verdict
}

/// Which vendors this machine has, from the same probe the hardware picker
/// uses, so a card that shows up in Settings is a card the installers know
/// about. That probe survives a missing rocm-smi, which is the only reason an
/// AMD card is visible here at all.
pub(crate) fn gpu_vendors_present() -> (bool, bool) {
    let (nvidia, amd, _) = gpu_vendor_facts();
    (nvidia, amd)
}

/// The same probe, plus the names of the AMD cards it found. The names are what
/// `amd_coverage` reads, and they are the only thing we have: no probe here
/// reports a gfx target, and rocm-smi, which could, is exactly the tool the
/// affected machines do not have installed.
pub(crate) fn gpu_vendor_facts() -> (bool, bool, Vec<String>) {
    let gpus = crate::commands::gpu::detect_gpus().unwrap_or_default();
    let amd_names: Vec<String> = gpus
        .iter()
        .filter(|g| g.vendor == "amd")
        .map(|g| g.name.clone())
        .collect();
    (
        gpus.iter().any(|g| g.vendor == "nvidia"),
        !amd_names.is_empty(),
        amd_names,
    )
}

/// The torch plan for the ComfyUI environment.
///
/// NVIDIA wins on a box that has both cards: it is the one every ComfyUI
/// feature is proven on. macOS never reaches this code, local media there is
/// MLX and `install_comfyui` refuses before it starts.
pub(crate) fn comfy_wheel_plan(
    has_nvidia: bool,
    nvidia_cap: Option<(u32, u32)>,
    has_amd: bool,
    amd_names: &[&str],
    os: &str,
) -> WheelPlan {
    if has_nvidia || nvidia_cap.is_some() {
        return nvidia_plan(nvidia_cap);
    }
    if has_amd {
        let coverage = amd_fleet_coverage(amd_names, os);
        if os == "linux" {
            // The card families no wheel carries would INSTALL fine here and
            // then die at the first kernel, which is worse than what 2.6.6 did
            // for them (slow, but running). Only cards we can actually name are
            // held back; a card we cannot place keeps the ROCm wheels, because
            // guessing the other way would take the fix away from the cards it
            // was built for.
            if coverage == AmdCoverage::NoKernels {
                return WheelPlan::Cpu {
                    note: amd_uncovered_linux_note(amd_names),
                };
            }
            return WheelPlan::Index {
                candidates: ROCM_CHANNELS,
                note: "AMD GPU detected, installing the ROCm build of PyTorch. \
                       ComfyUI will run on the card instead of the processor once this finishes."
                    .to_string(),
            };
        }
        if os == "windows" && coverage == AmdCoverage::Supported {
            return WheelPlan::IndexOrCpu {
                candidates: ROCM_WINDOWS_CHANNELS,
                packages: TORCH_TRIO_AMD_WINDOWS,
                note: "AMD GPU detected. Installing AMD's own ROCm build of PyTorch for \
                       Windows, from the index ComfyUI Desktop installs from. Researched, \
                       not proven: LU owns no AMD card, so this path has never run on our \
                       hardware. If the index does not answer, the processor build is \
                       installed instead and this stays exactly as slow as it was before."
                    .to_string(),
                cpu_note: format!(
                    "AMD's Windows ROCm index did not answer. {}",
                    amd_without_rocm_note(os),
                ),
            };
        }
        return WheelPlan::Cpu {
            note: amd_without_rocm_note(os),
        };
    }
    WheelPlan::Cpu {
        note: "No GPU detected, installing the processor build of PyTorch.".to_string(),
    }
}

fn nvidia_plan(cap: Option<(u32, u32)>) -> WheelPlan {
    match cap {
        Some((major, minor)) if major >= 12 => WheelPlan::Index {
            candidates: CUDA_BLACKWELL_CHANNELS,
            note: format!(
                "NVIDIA Blackwell GPU detected (compute capability {major}.{minor}), \
                 installing CUDA PyTorch."
            ),
        },
        Some(cap) if cap >= CU130_MIN_CAP => WheelPlan::Index {
            candidates: CUDA_MODERN_CHANNELS,
            note: format!(
                "NVIDIA GPU detected (compute capability {}.{}), installing CUDA PyTorch.",
                cap.0, cap.1,
            ),
        },
        Some((major, minor)) => WheelPlan::Index {
            candidates: CUDA_LEGACY_CHANNELS,
            note: format!(
                "NVIDIA GPU detected (compute capability {major}.{minor}, below Turing), \
                 installing the CUDA PyTorch that still carries kernels for it."
            ),
        },
        None => WheelPlan::Index {
            candidates: CUDA_LEGACY_CHANNELS,
            note: "NVIDIA GPU detected (the compute capability probe stayed silent), \
                   installing the CUDA PyTorch that covers the widest range of cards."
                .to_string(),
        },
    }
}

/// What an AMD card can and cannot do on an operating system PyTorch ships no
/// ROCm wheels for. Windows is the case that matters (all four reporters of
/// the AMD bundle who are not on Linux are there); anything else that is not
/// Linux gets the same honest answer minus the Windows-only names.
/// What an AMD card gets told on Linux when the ROCm wheels have no kernels
/// for it.
///
/// The install itself would succeed, which is the trap: pip is happy, the venv
/// looks right, and the first sampler step dies with "HIP error: invalid device
/// function" or a rocBLAS complaint about a missing TensileLibrary. For these
/// cards the ROCm wheels are 3 GB of download that ends worse than the
/// processor build they replaced.
pub(crate) fn amd_uncovered_linux_note(names: &[&str]) -> String {
    let head = "AMD GPU detected, but no official ROCm wheel carries kernels for this card \
                (checked 2026-08-30 against the code object lists inside the published \
                wheels: gfx1010, gfx1012, gfx1031, gfx1032 and gfx1034 appear in none of \
                them). Installing the ROCm build would download about 3 GB and then fail \
                at the first render with \"HIP error: invalid device function\", so LU is \
                installing the processor build instead, which is slow but works.";
    // RDNA 2 below the 6800 is the one family with a real workaround, because
    // gfx1030 kernels ARE in the wheels and the runtime can be pointed at them.
    // RDNA 1 has no such neighbour, so it is not offered one.
    let has_rdna2 = names
        .iter()
        .any(|n| matches!(radeon_rx_model(n), Some(6000..=6799)));
    if has_rdna2 {
        format!(
            "{head} If you want to try the card anyway, the community route is to set \
             HSA_OVERRIDE_GFX_VERSION=10.3.0 before starting ComfyUI, which makes an \
             RDNA 2 card use the gfx1030 kernels. LU does not do that for you, because \
             AMD does not support it and we cannot test it."
        )
    } else {
        head.to_string()
    }
}

pub(crate) fn amd_without_rocm_note(os: &str) -> String {
    let head = "AMD GPU detected, but pytorch.org publishes ROCm wheels for Linux only \
                (checked 2026-08-28: every wheel in the rocm7.2, rocm7.1 and rocm6.4 \
                channels is a Linux wheel). ComfyUI is being installed with the \
                processor build, which works but is slow.";
    if os == "windows" {
        // The old version of this sentence said PyTorch has no Windows ROCm
        // wheels at all, full stop, and sent the reader to DirectML first. Both
        // halves were wrong by 2026-08-30: AMD publishes its own Windows ROCm
        // wheels, LU installs them for the cards AMD supports, and torch-directml
        // has not seen a release since 2024-09-15, pins torch 2.4.1 and is in
        // Microsoft's declared maintenance mode. A customer who reads ComfyUI's
        // README finds the AMD channel in a minute, so claiming it does not
        // exist costs us the whole answer.
        format!(
            "{head} AMD publishes its own Windows ROCm wheels, and LU installs those for \
             the RDNA 3, 3.5 and 4 cards AMD supports there, but not for this card. \
             To drive it anyway you need a ComfyUI of your own on ZLUDA or DirectML, \
             then point LU at it and set Settings > Hardware > ComfyUI GPU to force GPU. \
             ZLUDA stands in for the CUDA runtime, it is not a CUDA PyTorch build, so it \
             only helps a ComfyUI that was set up for it, and DirectML has been frozen on \
             an old PyTorch since 2024."
        )
    } else {
        format!("{head} Linux with ROCm is the supported way to use this card for image and video.")
    }
}

/// The first candidate that answers, otherwise the last one.
///
/// Pure over the probe, so a test can drive both ends without a network. The
/// fallback is deliberate: an install behind a proxy that blocks our probe
/// still gets a channel to try, which is the behaviour the app had before any
/// of this existed.
pub(crate) fn first_live_index<'a>(
    candidates: &[&'a str],
    mut alive: impl FnMut(&str) -> bool,
) -> Option<&'a str> {
    if candidates.is_empty() {
        return None;
    }
    for c in candidates {
        if alive(c) {
            return Some(c);
        }
    }
    candidates.last().copied()
}

/// Does this wheel index actually serve torch right now?
///
/// Runs on its own thread: a blocking HTTP client panics inside a tokio
/// runtime, and this is called from both a plain worker thread and a Tauri
/// command, so the thread makes the call site irrelevant.
pub(crate) fn index_serves_torch(index: &str) -> bool {
    let url = format!("{}/torch/", index.trim_end_matches('/'));
    std::thread::spawn(move || {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .ok()
            .and_then(|c| c.get(&url).send().ok())
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
    .join()
    .unwrap_or(false)
}

/// The first candidate that answers, and nothing if none does.
///
/// The strict twin of `first_live_index`, for a channel that has never been
/// proven here: handing out an unreachable index would leave the user with a
/// failed install where the old behaviour gave a working, slow one.
pub(crate) fn first_live_index_strict<'a>(
    candidates: &[&'a str],
    mut alive: impl FnMut(&str) -> bool,
) -> Option<&'a str> {
    candidates.iter().copied().find(|c| alive(c))
}

/// Resolve a plan into (index, packages, note). A `None` index means the plain
/// PyPI wheels, which is what `pytorch_pip_args(None, ..)` installs. The note
/// comes back with it because a plan that falls back to the processor has a
/// different sentence to show than the one it started with.
pub(crate) fn resolve_plan(plan: &WheelPlan) -> (Option<&'static str>, &'static [&'static str], String) {
    match plan {
        WheelPlan::Cpu { note } => (None, TORCH_TRIO, note.clone()),
        WheelPlan::Index { candidates, note } => (
            first_live_index(candidates, index_serves_torch),
            TORCH_TRIO,
            note.clone(),
        ),
        WheelPlan::IndexOrCpu { candidates, packages, note, cpu_note } => {
            match first_live_index_strict(candidates, index_serves_torch) {
                Some(url) => (Some(url), packages, note.clone()),
                None => (None, TORCH_TRIO, cpu_note.clone()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_amd_linux_box_gets_rocm_wheels_not_processor_wheels() {
        match comfy_wheel_plan(false, None, true, &[], "linux") {
            WheelPlan::Index { candidates, note } => {
                assert_eq!(candidates, ROCM_CHANNELS);
                assert!(candidates[0].contains("rocm"), "first candidate is a ROCm channel");
                assert!(note.contains("AMD"), "the log says what was detected: {note}");
            }
            other => panic!("AMD on Linux must get wheels, got {other:?}"),
        }
    }

    #[test]
    fn an_amd_box_without_rocm_wheels_is_told_the_truth_instead_of_getting_cuda() {
        // Negative control: no ROCm channel exists for Windows, so the plan
        // must NOT hand out an index at all, and it must not claim CUDA.
        for os in ["windows", "freebsd"] {
            match comfy_wheel_plan(false, None, true, &[], os) {
                WheelPlan::Cpu { note } => {
                    assert!(
                        !note.contains("installing CUDA PyTorch"),
                        "{os}: promised CUDA wheels to an AMD card",
                    );
                    assert!(note.contains("AMD"), "{os}: never named the card");
                }
                other => panic!("{os} has no ROCm wheels, got {other:?}"),
            }
        }
        assert!(amd_without_rocm_note("windows").contains("DirectML"));
        assert!(!amd_without_rocm_note("linux").contains("DirectML"));
    }

    #[test]
    fn an_nvidia_card_still_wins_over_an_amd_card_in_the_same_box() {
        match comfy_wheel_plan(true, Some((8, 6)), true, &[], "linux") {
            WheelPlan::Index { candidates, .. } => {
                assert!(candidates.iter().all(|c| c.contains("/cu")), "{candidates:?}");
            }
            other => panic!("expected CUDA wheels, got {other:?}"),
        }
    }

    #[test]
    fn a_box_with_no_card_at_all_keeps_the_processor_build() {
        match comfy_wheel_plan(false, None, false, &[], "linux") {
            WheelPlan::Cpu { note } => assert!(note.contains("No GPU")),
            other => panic!("expected processor wheels, got {other:?}"),
        }
    }

    #[test]
    fn blackwell_never_gets_a_channel_without_its_kernels() {
        // Negative control: cu126 has no sm_120 kernel, so it may not appear
        // in the Blackwell ladder even as a last fallback.
        match comfy_wheel_plan(true, Some((12, 0)), false, &[], "windows") {
            WheelPlan::Index { candidates, .. } => {
                assert!(!candidates.iter().any(|c| c.ends_with("cu126")), "{candidates:?}");
            }
            other => panic!("expected CUDA wheels, got {other:?}"),
        }
    }

    #[test]
    fn the_first_answering_index_wins_and_a_dead_network_still_yields_one() {
        let list = ["a", "b", "c"];
        assert_eq!(first_live_index(&list, |i| i == "a"), Some("a"));
        assert_eq!(first_live_index(&list, |i| i == "b"), Some("b"));
        // Negative control: nothing answers, so the last entry is handed out
        // rather than nothing at all.
        assert_eq!(first_live_index(&list, |_| false), Some("c"));
        assert_eq!(first_live_index(&[], |_| true), None);
    }

    /// The channel a plan would try first.
    fn first_channel(cap: Option<(u32, u32)>) -> &'static str {
        match comfy_wheel_plan(true, cap, false, &[], "windows") {
            WheelPlan::Index { candidates, .. } => candidates[0],
            other => panic!("an NVIDIA card must get wheels, got {other:?}"),
        }
    }

    #[test]
    fn turing_and_newer_ride_cu130_and_older_cards_stay_on_cu126() {
        // ComfyUI 2026-08-16: cu130 or newer is required on 20 series and up.
        // NVIDIA CUDA 13.0: everything below Turing was removed. Turing is
        // 7.5, Volta is 7.0, so the line runs between those two.
        assert!(first_channel(Some((7, 5))).ends_with("cu130"), "Turing");
        assert!(first_channel(Some((8, 6))).ends_with("cu130"), "Ampere, the 3060 in the box");
        assert!(first_channel(Some((8, 9))).ends_with("cu130"), "Ada");
        assert!(first_channel(Some((9, 0))).ends_with("cu130"), "Hopper");
        assert!(first_channel(Some((12, 0))).ends_with("cu130"), "Blackwell");
        assert!(first_channel(Some((7, 0))).ends_with("cu126"), "Volta");
        assert!(first_channel(Some((6, 1))).ends_with("cu126"), "Pascal, a 1080");
        assert!(first_channel(Some((5, 2))).ends_with("cu126"), "Maxwell");
    }

    #[test]
    fn a_card_cuda_13_dropped_is_never_offered_cu130_at_all() {
        // Negative control, and the reason the minor number is read: a card
        // below Turing must not reach cu130 even as a fallback further down
        // the list, because CUDA 13 ships no kernel for it.
        for cap in [(5, 2), (6, 1), (7, 0)] {
            match comfy_wheel_plan(true, Some(cap), false, &[], "linux") {
                WheelPlan::Index { candidates, .. } => assert!(
                    !candidates.iter().any(|c| c.ends_with("cu130")),
                    "cap {cap:?} was offered cu130: {candidates:?}",
                ),
                other => panic!("expected wheels, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_silent_capability_probe_keeps_the_wide_channel() {
        // An nvidia-smi too old to answer --query-gpu=compute_cap points at an
        // old driver on an old card, so the guess that covers the most cards
        // wins over the newest channel.
        assert!(first_channel(None).ends_with("cu126"));
        match comfy_wheel_plan(true, None, false, &[], "linux") {
            WheelPlan::Index { candidates, .. } => {
                assert!(!candidates.iter().any(|c| c.ends_with("cu130")), "{candidates:?}");
            }
            other => panic!("expected wheels, got {other:?}"),
        }
    }

    #[test]
    fn cu126_stays_reachable_as_a_fallback_for_the_cards_it_can_still_drive() {
        // The switch may not turn into a hard wire: a Turing to Hopper card
        // that cannot reach cu130 has to land somewhere that works.
        match comfy_wheel_plan(true, Some((8, 6)), false, &[], "linux") {
            WheelPlan::Index { candidates, .. } => {
                assert_eq!(candidates.last().copied(), Some("https://download.pytorch.org/whl/cu126"));
                assert!(candidates.len() > 1, "a single entry is a hard wire: {candidates:?}");
            }
            other => panic!("expected wheels, got {other:?}"),
        }
    }

    // ── Windows plus AMD, Runde 12 ────────────────────────────────────────
    //
    // "PyTorch ships ROCm wheels for Linux only" was true about pytorch.org and
    // false about the world. AMD publishes win_amd64 ROCm wheels from its own
    // indexes, ComfyUI documents them in its README, and ComfyUI Desktop
    // installs them. LU was the only one of the five products compared on
    // 2026-08-30 with no GPU path at all for Windows AMD.
    //
    // RESEARCHED, NOT PROVEN throughout: we own no AMD card.

    const RX_7900: &str = "AMD Radeon RX 7900 XTX";
    const RX_9070: &str = "Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070 XT]";
    const RX_6700: &str = "AMD Radeon RX 6700 XT";
    const RX_6800: &str = "AMD Radeon RX 6800 XT";
    const RX_5700: &str = "AMD Radeon RX 5700 XT";
    const APU: &str = "AMD Radeon(TM) Graphics";

    #[test]
    fn a_supported_amd_card_on_windows_gets_amds_own_wheels_not_processor_wheels() {
        for name in [RX_7900, RX_9070] {
            match comfy_wheel_plan(false, None, true, &[name], "windows") {
                WheelPlan::IndexOrCpu { candidates, packages, note, cpu_note } => {
                    assert_eq!(candidates, ROCM_WINDOWS_CHANNELS);
                    assert!(candidates[0].contains("repo.amd.com"), "{candidates:?}");
                    // The device extra is not optional on this index.
                    assert!(packages.iter().any(|p| p.contains("[device-")), "{packages:?}");
                    // Honesty is part of the message, not just the comment.
                    assert!(note.to_lowercase().contains("researched, not proven"), "{note}");
                    assert!(cpu_note.contains("did not answer"), "{cpu_note}");
                }
                other => panic!("{name} must get AMD's Windows wheels, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_unreachable_amd_channel_falls_back_to_exactly_what_the_app_did_before() {
        // NEGATIVE CONTROL for the whole feature: this path has never run on
        // real hardware, so a dead index may not leave the user worse off than
        // 2.6.6 did. No index, the processor wheels, and the fallback sentence.
        let plan = comfy_wheel_plan(false, None, true, &[RX_7900], "windows");
        let WheelPlan::IndexOrCpu { candidates, cpu_note, .. } = &plan else {
            panic!("expected the AMD Windows plan, got {plan:?}");
        };
        assert_eq!(first_live_index_strict(candidates, |_| false), None);
        assert_eq!(first_live_index_strict(candidates, |_| true), Some(candidates[0]));
        assert!(cpu_note.contains("processor build"), "{cpu_note}");
        // and the ladder variant would have done the opposite, which is why
        // this plan is a different variant and not a longer candidate list
        assert_eq!(first_live_index(candidates, |_| false), Some(candidates[0]));
    }

    #[test]
    fn a_card_amd_does_not_support_on_windows_keeps_the_processor_wheels() {
        // RDNA1 and the RX 6400 to 6750 range are in no official wheel at all,
        // and RDNA2 above them is built for Windows but with hipBLASLt,
        // composable_kernel and rocWMMA stripped out and no promise attached.
        // Sending any of them to the AMD index would be a guess with a 3 GB
        // download and a broken environment at the end.
        for name in [RX_6700, RX_6800, RX_5700, APU] {
            match comfy_wheel_plan(false, None, true, &[name], "windows") {
                WheelPlan::Cpu { note } => {
                    assert!(note.contains("AMD"), "{name}: never named the card");
                    assert!(!note.contains("installing CUDA"), "{name}: {note}");
                }
                other => panic!("{name} has no supported Windows wheel, got {other:?}"),
            }
        }
        // A machine with both still gets the channel, for the card that can use it.
        assert!(matches!(
            comfy_wheel_plan(false, None, true, &[RX_6700, RX_7900], "windows"),
            WheelPlan::IndexOrCpu { .. },
        ));
    }

    // ── Linux, the families no wheel carries, Runde 12 ────────────────────
    //
    // The gfx targets in the published wheels were read out of the wheels
    // themselves on 2026-08-30. gfx1010, 1012, 1031, 1032 and 1034 are in none
    // of them. For those cards the ROCm wheels install cleanly and the first
    // kernel dies, which is WORSE than 2.6.6, where the same machine rendered
    // on the processor: slow, but finishing.

    #[test]
    fn a_linux_card_with_no_kernels_anywhere_keeps_the_processor_wheels() {
        for name in [RX_6700, RX_5700, "AMD Radeon RX 6600 XT", "AMD Radeon RX 6500 XT"] {
            match comfy_wheel_plan(false, None, true, &[name], "linux") {
                WheelPlan::Cpu { note } => {
                    assert!(note.contains("no official ROCm wheel carries kernels"), "{name}: {note}");
                    // The reason has to be IN the step message, not only in a log
                    assert!(note.contains("invalid device function"), "{name}: {note}");
                    assert!(note.contains("processor build"), "{name}: {note}");
                }
                other => panic!("{name} would die at the first kernel, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_rdna2_workaround_is_named_only_where_it_can_work() {
        // gfx1030 kernels ARE in the wheels, so an RDNA 2 card can be pointed
        // at them. RDNA 1 has no such neighbour and must not be sent chasing one.
        assert!(amd_uncovered_linux_note(&[RX_6700]).contains("HSA_OVERRIDE_GFX_VERSION=10.3.0"));
        assert!(!amd_uncovered_linux_note(&[RX_5700]).contains("HSA_OVERRIDE"));
        // and it is offered, never done for the user
        assert!(amd_uncovered_linux_note(&[RX_6700]).contains("LU does not do that for you"));
    }

    #[test]
    fn the_cards_the_linux_fix_was_built_for_still_get_the_rocm_wheels() {
        // NEGATIVE CONTROL for the brake: it may only catch the families that
        // were measured as uncovered. Everything else, INCLUDING a card whose
        // name tells us nothing, keeps the wheels 57196b31 gave it.
        for name in [RX_7900, RX_9070, RX_6800, APU, "AMD Radeon Pro W7900", "AMD Radeon Graphics"] {
            match comfy_wheel_plan(false, None, true, &[name], "linux") {
                WheelPlan::Index { candidates, .. } => assert_eq!(candidates, ROCM_CHANNELS, "{name}"),
                other => panic!("{name} must keep the ROCm wheels, got {other:?}"),
            }
        }
        // A box with an uncovered card AND a covered one renders on the covered
        // one, so the brake must not take the wheels away from it.
        assert!(matches!(
            comfy_wheel_plan(false, None, true, &[RX_6700, RX_7900], "linux"),
            WheelPlan::Index { .. },
        ));
        // and the brake is an AMD brake: it cannot reach an NVIDIA box
        assert!(matches!(
            comfy_wheel_plan(true, Some((8, 6)), true, &[RX_6700], "linux"),
            WheelPlan::Index { candidates, .. } if candidates[0].contains("/cu"),
        ));
    }

    #[test]
    fn the_card_name_is_read_and_never_guessed() {
        // The three probes spell the same card three ways, and all three have
        // to land on the same verdict or the plan depends on which tool ran.
        assert_eq!(radeon_rx_model("AMD Radeon RX 7900 XTX"), Some(7900));
        assert_eq!(radeon_rx_model(RX_9070), Some(9070));
        assert_eq!(radeon_rx_model("Radeon RX 6600"), Some(6600));
        // NEGATIVE CONTROL: nothing is invented out of a name without a model.
        assert_eq!(radeon_rx_model(APU), None);
        assert_eq!(radeon_rx_model("AMD Radeon Pro W7900"), None);
        assert_eq!(radeon_rx_model("Intel(R) UHD Graphics 770"), None);
        assert_eq!(amd_coverage(APU, "windows"), AmdCoverage::Unknown);
        // and a name whose "rx" is part of another word must not match
        assert_eq!(radeon_rx_model("Matrox G7900"), None);
    }

    #[test]
    fn the_windows_text_no_longer_claims_a_wheel_that_exists_does_not() {
        // The old sentence said PyTorch has no Windows ROCm wheels, period, and
        // led with DirectML. A customer who reads ComfyUI's README finds the
        // AMD channel in a minute, and then the whole answer is worthless.
        let note = amd_without_rocm_note("windows");
        assert!(note.contains("pytorch.org publishes ROCm wheels for Linux only"), "{note}");
        assert!(note.contains("AMD publishes its own Windows ROCm wheels"), "{note}");
        // DirectML may still be named as a last resort, but not before ZLUDA
        // and not without saying it has been frozen.
        assert!(note.contains("DirectML"));
        assert!(note.find("ZLUDA") < note.find("DirectML"), "{note}");
        assert!(note.contains("frozen"), "{note}");
        assert!(!amd_without_rocm_note("linux").contains("DirectML"));
    }

    #[test]
    fn nvidia_and_linux_are_untouched_by_the_windows_amd_channel() {
        // The point of the whole change is that it adds a branch. Nothing that
        // worked before may route through AMD's index or through its extras.
        for (nv, cap, amd, names, os) in [
            (true, Some((8, 6)), false, &[][..], "windows"),
            (true, Some((12, 0)), false, &[][..], "windows"),
            (true, None, false, &[][..], "linux"),
            (true, Some((8, 6)), true, &[RX_7900][..], "windows"),
            (false, None, true, &[RX_7900][..], "linux"),
            (false, None, true, &[RX_6700][..], "linux"),
        ] {
            let plan = comfy_wheel_plan(nv, cap, amd, names, os);
            assert!(
                !matches!(plan, WheelPlan::IndexOrCpu { .. }),
                "{os} {names:?} nvidia={nv} must not reach the AMD Windows plan: {plan:?}",
            );
            let (index, packages, _) = match &plan {
                WheelPlan::Index { candidates, note } => {
                    (first_live_index(candidates, |_| true), TORCH_TRIO, note)
                }
                WheelPlan::Cpu { note } => (None, TORCH_TRIO, note),
                other => panic!("{other:?}"),
            };
            assert!(
                index.is_none_or(|u| u.contains("download.pytorch.org")),
                "{os} {names:?} left pytorch.org: {index:?}",
            );
            assert_eq!(packages, TORCH_TRIO, "{os} {names:?} got a foreign package list");
        }
        // and a no-GPU box is still a no-GPU box
        assert!(matches!(
            comfy_wheel_plan(false, None, false, &[], "windows"),
            WheelPlan::Cpu { .. },
        ));
    }

    #[test]
    fn a_processor_plan_never_resolves_to_an_index() {
        let plan = WheelPlan::Cpu { note: "x".to_string() };
        let (index, packages, note) = resolve_plan(&plan);
        assert_eq!(index, None);
        assert_eq!(packages, TORCH_TRIO);
        assert_eq!(note, "x");
    }
}
