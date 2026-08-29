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
    /// Install the plain PyPI wheels, which run on the processor. No index.
    Cpu { note: String },
}

impl WheelPlan {
    /// The sentence the install log shows while this plan runs.
    pub(crate) fn note(&self) -> &str {
        match self {
            WheelPlan::Index { note, .. } => note,
            WheelPlan::Cpu { note } => note,
        }
    }
}

/// Which vendors this machine has, from the same probe the hardware picker
/// uses, so a card that shows up in Settings is a card the installers know
/// about. That probe survives a missing rocm-smi, which is the only reason an
/// AMD card is visible here at all.
pub(crate) fn gpu_vendors_present() -> (bool, bool) {
    let gpus = crate::commands::gpu::detect_gpus().unwrap_or_default();
    (
        gpus.iter().any(|g| g.vendor == "nvidia"),
        gpus.iter().any(|g| g.vendor == "amd"),
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
    os: &str,
) -> WheelPlan {
    if has_nvidia || nvidia_cap.is_some() {
        return nvidia_plan(nvidia_cap);
    }
    if has_amd {
        if os == "linux" {
            return WheelPlan::Index {
                candidates: ROCM_CHANNELS,
                note: "AMD GPU detected, installing the ROCm build of PyTorch. \
                       ComfyUI will run on the card instead of the processor once this finishes."
                    .to_string(),
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
pub(crate) fn amd_without_rocm_note(os: &str) -> String {
    let head = "AMD GPU detected, but PyTorch ships ROCm wheels for Linux only \
                (checked 2026-08-28: every wheel in the rocm7.2, rocm7.1 and rocm6.4 \
                channels is a Linux wheel). ComfyUI is being installed with the \
                processor build, which works but is slow.";
    if os == "windows" {
        format!(
            "{head} To drive the card on Windows you need a ComfyUI of your own on \
             DirectML or ZLUDA, then point LU at it and set \
             Settings > Hardware > ComfyUI GPU to force GPU. ZLUDA stands in for the \
             CUDA runtime, it is not a CUDA PyTorch build, so it only helps a ComfyUI \
             that was set up for it."
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

/// Resolve a plan into the index pip should use. `None` means the plain PyPI
/// wheels, which is what `pytorch_pip_args(None)` installs.
pub(crate) fn resolve_plan_index(plan: &WheelPlan) -> Option<&'static str> {
    match plan {
        WheelPlan::Cpu { .. } => None,
        WheelPlan::Index { candidates, .. } => first_live_index(candidates, index_serves_torch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_amd_linux_box_gets_rocm_wheels_not_processor_wheels() {
        match comfy_wheel_plan(false, None, true, "linux") {
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
            match comfy_wheel_plan(false, None, true, os) {
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
        match comfy_wheel_plan(true, Some((8, 6)), true, "linux") {
            WheelPlan::Index { candidates, .. } => {
                assert!(candidates.iter().all(|c| c.contains("/cu")), "{candidates:?}");
            }
            other => panic!("expected CUDA wheels, got {other:?}"),
        }
    }

    #[test]
    fn a_box_with_no_card_at_all_keeps_the_processor_build() {
        match comfy_wheel_plan(false, None, false, "linux") {
            WheelPlan::Cpu { note } => assert!(note.contains("No GPU")),
            other => panic!("expected processor wheels, got {other:?}"),
        }
    }

    #[test]
    fn blackwell_never_gets_a_channel_without_its_kernels() {
        // Negative control: cu126 has no sm_120 kernel, so it may not appear
        // in the Blackwell ladder even as a last fallback.
        match comfy_wheel_plan(true, Some((12, 0)), false, "windows") {
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
        match comfy_wheel_plan(true, cap, false, "windows") {
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
            match comfy_wheel_plan(true, Some(cap), false, "linux") {
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
        match comfy_wheel_plan(true, None, false, "linux") {
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
        match comfy_wheel_plan(true, Some((8, 6)), false, "linux") {
            WheelPlan::Index { candidates, .. } => {
                assert_eq!(candidates.last().copied(), Some("https://download.pytorch.org/whl/cu126"));
                assert!(candidates.len() > 1, "a single entry is a hard wire: {candidates:?}");
            }
            other => panic!("expected wheels, got {other:?}"),
        }
    }

    #[test]
    fn a_processor_plan_never_resolves_to_an_index() {
        let plan = WheelPlan::Cpu { note: "x".to_string() };
        assert_eq!(resolve_plan_index(&plan), None);
    }
}
