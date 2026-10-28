//! How strong is "full strength" for one vector on one model?
//!
//! A direction from cvector-generator has length 1 in every layer, a decoder
//! row of an SAE has length 1 in its one layer, and the activity it is added
//! to is a few times to a few hundred times larger depending on the model.
//! A fixed number would be timid on one model and break another. So LU
//! measures it: the vector goes in at growing scales until the answer to a
//! fixed question stops being language (Qwen2.5-0.5B: fine at 0.8, number
//! salad at 1.2; Gemma 3 270M with an SAE feature: fine at 350, empty at
//! 500). Slider ±1 is just under the last scale that still read well.

/// Is this answer still language? `engine_sanity::judge` catches a broken
/// card (question marks, one character); steering breaks differently, into
/// loops: "Iip. Iip. Iip.", "the people of the world, including the people
/// of the world", "2 2 2 2", "120000000000000000". An empty answer is broken
/// too: the model gave up at once.
pub fn coherent(text: &str) -> bool {
    use crate::commands::engine_sanity::{judge, Sanity};
    if matches!(judge(text), Sanity::Garbled(_)) {
        return false;
    }
    let words: Vec<String> = text
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() < 3 {
        return false;
    }
    // A run of one character: digits after a number, a letter stretched.
    let mut run = 1;
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    for w in chars.windows(2) {
        run = if w[0] == w[1] { run + 1 } else { 1 };
        if run >= 8 {
            return false;
        }
    }
    // The same word three times in a row.
    if words.windows(3).any(|w| w[0] == w[1] && w[1] == w[2]) {
        return false;
    }
    // A phrase of four words coming back three times.
    if words.len() >= 12 {
        let mut seen = std::collections::HashMap::<&[String], u32>::new();
        for g in words.windows(4) {
            let n = seen.entry(g).or_insert(0);
            *n += 1;
            if *n >= 3 {
                return false;
            }
        }
        let distinct: std::collections::HashSet<&String> = words.iter().collect();
        if (distinct.len() as f32) / (words.len() as f32) < 0.4 {
            return false;
        }
    }
    true
}

/// The largest scale (×0.9) at which `probe` still answers coherently.
/// Doubles from `start`, then narrows once between the last good and the
/// first bad scale. If even `start` breaks, halves down four times.
/// `Err` when nothing tried was coherent, which also covers a model that
/// does not answer coherently without any steering.
pub fn find_unit(start: f32, mut probe: impl FnMut(f32) -> Result<bool, String>) -> Result<f32, String> {
    let mut good: Option<f32> = None;
    let mut bad: Option<f32> = None;
    let mut s = start;
    for _ in 0..10 {
        if probe(s)? {
            good = Some(s);
            s *= 2.0;
        } else {
            bad = Some(s);
            break;
        }
    }
    if good.is_none() {
        let mut s = start;
        for _ in 0..4 {
            s /= 2.0;
            if probe(s)? {
                good = Some(s);
                bad = Some(s * 2.0);
                break;
            }
        }
    }
    let Some(mut g) = good else {
        return Err("Even a small push breaks this model's answers. This vector cannot be used here.".into());
    };
    if let Some(b) = bad {
        let mid = (g * b).sqrt();
        if probe(mid)? {
            g = mid;
        }
    }
    Ok(g * 0.9)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measured_answers_are_judged_like_a_reader_would() {
        // Real answers of Qwen2.5-0.5B with the cheerful vector (P11 scan).
        assert!(coherent("Rain is a natural phenomenon that brings joy and vitality to the world, bringing fresh life and a sense of freshness and vitality to the world."));
        assert!(coherent("The sky over the world is covered in a thick, dark cloud, and the raindrops are heavy and heavy, making the world seem like it's going to rain."));
        assert!(!coherent("The joy of the morning is a vibrant and diverse array of activities, including the morning activities of the people of the world, including the people of the world, including the people of the 12000000000000000000000000000000"));
        assert!(!coherent("I cannot write a direct, personal or emotional onessy sentence about the state of the world. Iip. Iip. Iip. Iip. Iip. Iplee. Iplee. Iplee."));
        assert!(!coherent("11 am, the morning of the first day 2 The 2022 members are 2022 members 2022 2 2 2 2 2 2 2 2 2 2"));
        assert!(!coherent(""));
        assert!(!coherent("ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂ja不懂òiòiòiòiòiòiòiòiòi"));
    }

    #[test]
    fn unit_is_just_under_the_break() {
        // Breaks above 1.0: start 0.25 → 0.5 → 1.0 good, 2.0 bad, mid 1.41 bad.
        let u = find_unit(0.25, |s| Ok(s <= 1.0)).unwrap();
        assert!((u - 0.9).abs() < 1e-4, "{u}");
        // Mid point good: breaks above 1.5.
        let u = find_unit(0.25, |s| Ok(s <= 1.5)).unwrap();
        assert!((u - 2f32.sqrt() * 0.9).abs() < 1e-3, "{u}");
    }

    #[test]
    fn start_too_high_halves_down() {
        let mut tried = Vec::new();
        let u = find_unit(100.0, |s| {
            tried.push(s);
            Ok(s <= 30.0)
        })
        .unwrap();
        assert!(u > 20.0 && u < 32.0, "{u}");
        assert_eq!(tried[0], 100.0);
        assert_eq!(tried[1], 50.0);
    }

    #[test]
    fn nothing_coherent_is_an_error_and_errors_pass_through() {
        assert!(find_unit(1.0, |_| Ok(false)).is_err());
        assert_eq!(find_unit(1.0, |_| Err("stopped".to_string())).unwrap_err(), "stopped");
    }

    #[test]
    fn never_breaking_stops_after_ten_doublings() {
        let mut n = 0;
        let u = find_unit(1.0, |_| {
            n += 1;
            Ok(true)
        })
        .unwrap();
        assert_eq!(n, 10);
        assert!((u - 512.0 * 0.9).abs() < 1e-2);
    }
}
