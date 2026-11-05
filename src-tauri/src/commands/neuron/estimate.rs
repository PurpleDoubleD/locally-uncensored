//! How long one slider takes, said before it starts.
//!
//! The vector tool reads every example pair through the whole model, so its
//! time grows with the model file and the number of pairs. How fast it is
//! depends on the build that ships: the Mac's runs on Metal, the Windows and
//! Linux tool comes out of the server build with its CPU variants (E1,
//! 31.10.2026; the static K1-baseline tool before it took ~25 min where this
//! one takes half a minute). After the first run on a PC LU knows that PC's
//! real speed and uses it, keyed to the tool file, so a new tool is measured
//! anew.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Seconds per GB of model file and example pair for the Windows and Linux
/// tool with E1's CPU variants. I1 on the box: LFM3 1.7B Q4_K_M (1.10 GB),
/// 40 pairs, 31 s in all with the strength check. A Vulkan card is faster,
/// which the measured speed then shows.
pub const SHIPPED_TOOL_CPU: f64 = 0.5;

/// The same for the Mac's Metal tool: Qwen3.5 9B Q4_K_M (6.8 GB), 40 pairs,
/// 30 s in all with the strength check (P11, FEHLER 10).
pub const SHIPPED_TOOL_METAL: f64 = 0.05;

/// The strength check after the tool runs on the chat engine: up to 11 short
/// answers of a few tokens each. Ten seconds or so on the Mac and the box;
/// the top of the range must stay under the 2 min the page speaks up at, or
/// every quick run gets the "takes a while" note (Zentrale, 31.10.2026).
const CHECK_SECS: (f64, f64) = (8.0, 40.0);

pub fn shipped_speed() -> f64 {
    if cfg!(target_os = "macos") { SHIPPED_TOOL_METAL } else { SHIPPED_TOOL_CPU }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub low_secs: u64,
    pub high_secs: u64,
    /// From a run on this PC with this tool, not from the shipped default.
    pub measured: bool,
}

/// The range for one slider. A measured speed is close; the shipped default
/// is a guess for a PC LU has never seen, so its range is wide.
pub fn estimate(model_bytes: u64, pairs: usize, measured: Option<f64>) -> Estimate {
    let gb = model_bytes as f64 / 1e9;
    let (speed, low, high) = match measured {
        Some(s) => (s, 0.8, 1.5),
        None => (shipped_speed(), 0.5, 2.0),
    };
    let tool = speed * gb * pairs as f64;
    Estimate {
        low_secs: (tool * low + CHECK_SECS.0).round() as u64,
        high_secs: (tool * high + CHECK_SECS.1).round() as u64,
        measured: measured.is_some(),
    }
}

/// What one finished tool run says about this PC.
pub fn speed_of_run(secs: f64, model_bytes: u64, pairs: usize) -> Option<f64> {
    let work = model_bytes as f64 / 1e9 * pairs as f64;
    (work > 0.0 && secs > 0.0).then(|| secs / work)
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Remembered {
    tool: String,
    secs_per_gb_pair: f64,
}

/// The tool file as it is now: size and change time. Another build (an
/// update, E1's fast tool) gives another key, and its speed is not assumed.
pub fn tool_key(tool: &Path) -> Option<String> {
    let m = std::fs::metadata(tool).ok()?;
    let at = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(format!("{:x}-{at:x}", m.len()))
}

pub fn remembered(file: &Path, tool: &str) -> Option<f64> {
    let r: Remembered = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (r.tool == tool && r.secs_per_gb_pair.is_finite() && r.secs_per_gb_pair > 0.0).then_some(r.secs_per_gb_pair)
}

pub fn remember(file: &Path, tool: &str, secs_per_gb_pair: f64) {
    let r = Remembered { tool: tool.into(), secs_per_gb_pair };
    if let Ok(bytes) = serde_json::to_vec_pretty(&r) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_measured_runs_fall_inside_their_range() {
        // I1 on the box with E1's fast tool (CPU variants): LFM3 1.7B, 31 s.
        let e = estimate(1_099_627_808, 40, Some(SHIPPED_TOOL_CPU));
        assert!(e.low_secs <= 31 && e.high_secs >= 31, "{e:?}");
        // The Mac (Metal): Qwen3.5 9B, 30 s.
        let mac = estimate(6_828_993_824, 40, Some(SHIPPED_TOOL_METAL));
        assert!(mac.low_secs <= 30 && mac.high_secs >= 30, "{mac:?}");
    }

    #[test]
    fn a_quick_run_stays_under_the_line_the_page_says_something_at() {
        // Zentrale, 31.10.2026: the "takes a while" note showed on every Mac,
        // because the range itself never came out under 2 min. lib/neuron's
        // buildTimeNote says nothing below 120 s.
        for bytes in [400_000_000, 1_100_000_000, 6_828_993_824, 9_000_000_000] {
            assert!(estimate(bytes, 40, None).high_secs < 120 || !cfg!(target_os = "macos"), "Mac, {bytes} bytes");
            assert!(estimate(bytes, 40, Some(SHIPPED_TOOL_METAL)).high_secs < 120, "Metal, {bytes} bytes");
        }
        assert!(estimate(1_099_627_808, 40, Some(SHIPPED_TOOL_CPU)).high_secs < 120, "fast tool, 1.7B");
        // A slow PC, measured, still gets the note.
        assert!(estimate(1_099_627_808, 40, Some(33.0)).high_secs > 120);
    }

    #[test]
    fn a_default_is_wider_than_a_measurement_and_says_which_it_is() {
        let d = estimate(1_100_000_000, 40, None);
        let m = estimate(1_100_000_000, 40, Some(shipped_speed()));
        assert!(!d.measured && m.measured);
        assert!(d.low_secs < m.low_secs && d.high_secs > m.high_secs);
    }

    #[test]
    fn a_run_is_turned_into_a_speed_and_back() {
        let s = speed_of_run(1440.0, 1_100_000_000, 40).unwrap();
        assert!((s - 32.727).abs() < 0.01);
        assert_eq!(speed_of_run(10.0, 0, 40), None);
        assert_eq!(speed_of_run(0.0, 1, 40), None);
    }

    #[test]
    fn a_remembered_speed_counts_only_for_the_same_tool() {
        let dir = std::env::temp_dir().join(format!("lu-neuron-speed-{}", std::process::id()));
        let file = dir.join("tool-speed.json");
        assert_eq!(remembered(&file, "a"), None);
        remember(&file, "a", 12.5);
        assert_eq!(remembered(&file, "a"), Some(12.5));
        assert_eq!(remembered(&file, "b"), None, "a new tool build is measured anew");
        std::fs::write(&file, b"{\"tool\":\"a\",\"secsPerGbPair\":-1}").unwrap();
        assert_eq!(remembered(&file, "a"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
