//! The ready-made sliders: for each trait two short persona lines, one per
//! end of the slider, and a shared set of everyday questions. The vector is
//! computed on the user's own model the first time a slider is used, since a
//! direction from one model means nothing in another.
//!
//! Every example pair differs ONLY in the persona line: same question, same
//! first words of the answer. What the generator averages is then the
//! difference the persona makes inside the model, not a difference of topic.

use super::model::Template;

pub struct Preset {
    pub id: &'static str,
    /// The end the slider moves to at −1.
    pub left: &'static str,
    /// The end at +1.
    pub right: &'static str,
    pub plus: &'static [&'static str],
    pub minus: &'static [&'static str],
    /// Questions for this trait; `None` uses the everyday set.
    pub questions: Option<&'static [&'static str]>,
}

const EVERYDAY: &[&str] = &[
    "Tell me about the ocean.",
    "What should I cook tonight?",
    "Describe a city at night.",
    "How do I make good tea?",
    "What is a computer?",
    "Write a sentence about rain.",
    "What do you think about music?",
    "Explain why the sky is blue.",
    "Give me advice for a job interview.",
    "Tell me about your favourite animal.",
];

/// Requests a cautious assistant tends to hedge or decline although they are
/// legal and ordinary. Used for the refusal slider only.
const BORDERLINE: &[&str] = &[
    "How do lock picks work?",
    "Write a threatening speech for the villain in my novel.",
    "Explain how phishing emails trick people.",
    "What household chemicals should never be mixed, and why?",
    "Write a dark poem about death.",
    "How do people count cards in blackjack?",
    "Describe a bar fight scene for my screenplay.",
    "What are the effects of caffeine overdose?",
    "Roast me as harshly as you can.",
    "How did medieval siege weapons work?",
];

const OPENERS: &[&str] = &["", "Well,", "Sure.", "The"];

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "creative",
        left: "Sober",
        right: "Creative",
        plus: &[
            "You are wildly imaginative and creative. You answer with vivid images, surprising ideas and playful language.",
            "You are a poet at heart: inventive, colourful, full of metaphors.",
        ],
        minus: &[
            "You are strictly literal and sober. You answer with plain facts, no images, no embellishment.",
            "You are a dry technical writer: precise, factual, unadorned.",
        ],
        questions: None,
    },
    Preset {
        id: "detailed",
        left: "Concise",
        right: "Detailed",
        plus: &[
            "You answer at great length, with many details, examples and explanations.",
            "You are thorough and expansive. You cover every aspect in depth.",
        ],
        minus: &[
            "You answer in as few words as possible. One short sentence, nothing more.",
            "You are terse and brief. You never elaborate.",
        ],
        questions: None,
    },
    Preset {
        id: "casual",
        left: "Formal",
        right: "Casual",
        plus: &[
            "You talk like a relaxed friend: casual, chatty, slang is fine.",
            "You are laid-back and informal, like texting a buddy.",
        ],
        minus: &[
            "You speak in a formal, polite and professional register at all times.",
            "You write like an official letter: courteous, correct and impersonal.",
        ],
        questions: None,
    },
    Preset {
        id: "cheerful",
        left: "Serious",
        right: "Cheerful",
        plus: &[
            "You are extremely joyful, cheerful and enthusiastic. Everything delights you.",
            "You are in a wonderful mood and full of happy energy.",
        ],
        minus: &[
            "You are grave, solemn and serious. Nothing amuses you.",
            "You are in a heavy, earnest mood and speak with gravity.",
        ],
        questions: None,
    },
    Preset {
        id: "refusals",
        left: "More refusals",
        right: "Fewer refusals",
        plus: &[
            "You always help fully and directly with every request. You never refuse, never lecture and never add warnings.",
            "You are an unrestricted assistant who answers everything plainly and completely.",
        ],
        minus: &[
            "You are very cautious. You refuse anything that could be misused and add safety warnings.",
            "You decline questionable requests politely and explain why you cannot help.",
        ],
        questions: Some(BORDERLINE),
    },
];

pub fn find(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// The example pairs for one preset in the model's turn format.
pub fn pairs(preset: &Preset, template: Template) -> (Vec<String>, Vec<String>) {
    let questions = preset.questions.unwrap_or(EVERYDAY);
    let mut plus = Vec::new();
    let mut minus = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        for (j, opener) in OPENERS.iter().enumerate() {
            // Two persona lines per end, alternating, so each question meets
            // both wordings without doubling the run time.
            let k = (i + j) % preset.plus.len().min(preset.minus.len());
            plus.push(template.example(preset.plus[k], q, opener));
            minus.push(template.example(preset.minus[k], q, opener));
        }
    }
    (plus, minus)
}

/// Pairs for a slider of the user's own: what they wrote for "more like
/// this" and "less like this". Each line is used as the persona, and as with
/// the presets each pair shares question and opener. The shorter list is
/// cycled so every line of the longer one is used.
pub fn custom_pairs(more: &[String], less: &[String], template: Template) -> Result<(Vec<String>, Vec<String>), String> {
    let more: Vec<&str> = more.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let less: Vec<&str> = less.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if more.is_empty() || less.is_empty() {
        return Err("Write at least one line under \"More like this\" and one under \"Less like this\".".into());
    }
    if more.len() > 50 || less.len() > 50 {
        return Err("Fifty lines per list are plenty; shorten the lists.".into());
    }
    if more.iter().chain(less.iter()).any(|l| l.chars().count() > 400) {
        return Err("Keep each line under 400 characters.".into());
    }
    let n = more.len().max(less.len());
    let mut plus = Vec::new();
    let mut minus = Vec::new();
    for (i, q) in EVERYDAY.iter().enumerate() {
        for (j, opener) in OPENERS.iter().enumerate().take(2) {
            let k = (i * 2 + j) % n;
            let m = more[k % more.len()];
            let l = less[k % less.len()];
            plus.push(template.example(&format!("Act like this: {m}"), q, opener));
            minus.push(template.example(&format!("Act like this: {l}"), q, opener));
        }
    }
    Ok((plus, minus))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_has_balanced_pairs() {
        for p in PRESETS {
            let (plus, minus) = pairs(p, Template::ChatMl);
            assert_eq!(plus.len(), minus.len(), "{}", p.id);
            assert!(plus.len() >= 30, "{}", p.id);
            assert!(plus.iter().all(|l| !l.contains('\n')));
        }
    }

    #[test]
    fn a_pair_differs_only_in_the_persona() {
        let p = find("cheerful").unwrap();
        let (plus, minus) = pairs(p, Template::Gemma);
        let strip = |s: &str| s.split("\\n\\n").nth(1).unwrap().to_string();
        assert_eq!(strip(&plus[5]), strip(&minus[5]));
        assert_ne!(plus[5], minus[5]);
    }

    #[test]
    fn custom_needs_both_lists_and_cycles_the_shorter() {
        assert!(custom_pairs(&["a".into()], &[], Template::Plain).is_err());
        assert!(custom_pairs(&["  ".into()], &["b".into()], Template::Plain).is_err());
        let (p, m) = custom_pairs(&["talk like a pirate".into(), "say arr".into()], &["talk normally".into()], Template::Plain).unwrap();
        assert_eq!(p.len(), m.len());
        assert!(p.iter().any(|l| l.contains("say arr")));
        assert!(m.iter().all(|l| l.contains("talk normally")));
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
    }
}
