//! Feature steering with official sparse autoencoders (Gemma Scope 2).
//!
//! An SAE splits a layer's activity into many features; each feature has a
//! decoder row, a direction in that layer. Turning a feature up means adding
//! its decoder row to the layer, which is exactly what a control vector with
//! one layer does, so llama-server applies it without anything new.
//!
//! LU fetches only what it needs from the official files, by byte range:
//! the decoder (`w_dec`, ~42 MB for Gemma 3 270M) and the ten tokens each
//! feature pushes most (`top_tokens`, 655 KB). The rest of the 900 MB is not
//! downloaded. Each piece is checked against a SHA-256 measured from the
//! official repo at a pinned revision, so a changed file on the hub is
//! refused instead of used.
//!
//! Feature names are those ten tokens, read through the model's own
//! vocabulary. Some features read clearly ("locations | areas | sites"),
//! many do not; the search says so instead of inventing labels.

use super::model::ModelFacts;
use std::path::{Path, PathBuf};

pub struct Slice {
    pub file: &'static str,
    pub start: u64,
    /// Inclusive, as an HTTP range.
    pub end: u64,
    pub sha256: &'static str,
}

impl Slice {
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}

pub struct SaeSpec {
    pub id: &'static str,
    pub title: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub folder: &'static str,
    /// Block whose output the SAE reads (`model.layers.N.output`), which is
    /// `direction.N` for llama.cpp.
    pub layer: usize,
    pub width: usize,
    pub arch: &'static str,
    pub n_embd: usize,
    pub n_layer: usize,
    pub w_dec: Slice,
    pub top_tokens: Slice,
    pub license: &'static str,
}

impl SaeSpec {
    pub fn url(&self, slice: &Slice) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}/{}", self.repo, self.revision, self.folder, slice.file)
    }
    pub fn bytes(&self) -> u64 {
        self.w_dec.len() + self.top_tokens.len()
    }
}

/// Measured 28.10.2026 from the official repos (cc-by-4.0, not gated):
/// header lengths read with a range request, offsets from the safetensors
/// header, hashes over the downloaded slices.
pub const CATALOG: &[SaeSpec] = &[
    SaeSpec {
        id: "gemma-scope-2-270m-it-l9",
        title: "Gemma Scope 2 · Gemma 3 270M IT · layer 9 · 16k features",
        repo: "google/gemma-scope-2-270m-it",
        revision: "49801301620db3e196553c903380aa21f42506fa",
        folder: "resid_post/layer_9_width_16k_l0_medium",
        layer: 9,
        width: 16384,
        arch: "gemma3",
        n_embd: 640,
        n_layer: 18,
        w_dec: Slice {
            file: "params.safetensors",
            start: 134_008,
            end: 42_077_047,
            sha256: "b2b51626b92db50428795e41b5f91dd767eac08a8e0c419e7b7efb6a53f9c709",
        },
        top_tokens: Slice {
            file: "examples.safetensors",
            start: 816_102_160,
            end: 816_757_519,
            sha256: "02ba06ca55d57cdd135f93b253c1e908f2907bf32ddf7ee277e3f6632ac5ba93",
        },
        license: "CC-BY-4.0 (Google DeepMind, Gemma Scope 2)",
    },
    SaeSpec {
        id: "gemma-scope-2-1b-it-l13",
        title: "Gemma Scope 2 · Gemma 3 1B IT · layer 13 · 16k features",
        repo: "google/gemma-scope-2-1b-it",
        revision: "b0fa29457c3601df0a70c48a15534c738d7c10e0",
        folder: "resid_post/layer_13_width_16k_l0_medium",
        layer: 13,
        width: 16384,
        arch: "gemma3",
        n_embd: 1152,
        n_layer: 26,
        w_dec: Slice {
            file: "params.safetensors",
            start: 136_056,
            end: 75_633_527,
            sha256: "bc26b182c0f8c698b9473df623dd4631fd574a71503bfdcac3f574c2f5e77d08",
        },
        top_tokens: Slice {
            file: "examples.safetensors",
            start: 817_498_984,
            end: 818_154_343,
            sha256: "fea501741b19bd650447a530f06dfe7be1018910149c0991674255a5ee7b1751",
        },
        license: "CC-BY-4.0 (Google DeepMind, Gemma Scope 2)",
    },
];

/// The SAE trained for this model, by shape. Base (pt) models have the same
/// shape; the SAEs here were trained on the instruction-tuned ones and work
/// less well on a base model, which the info line says.
pub fn for_model(facts: &ModelFacts) -> Option<&'static SaeSpec> {
    CATALOG.iter().find(|s| s.arch == facts.arch && s.n_embd == facts.n_embd && s.n_layer == facts.n_layer)
}

pub fn by_id(id: &str) -> Option<&'static SaeSpec> {
    CATALOG.iter().find(|s| s.id == id)
}

pub fn dir(root: &Path, spec: &SaeSpec) -> PathBuf {
    root.join("sae").join(spec.id)
}

pub fn is_downloaded(root: &Path, spec: &SaeSpec) -> bool {
    let d = dir(root, spec);
    file_len(&d.join("w_dec.f32")) == Some(spec.w_dec.len()) && file_len(&d.join("top_tokens.i32")) == Some(spec.top_tokens.len())
}

fn file_len(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

/// The decoder row of one feature, as a one-layer control vector.
pub fn feature_vector(root: &Path, spec: &SaeSpec, feature: usize) -> Result<super::cvec::ControlVector, String> {
    use std::io::{Read, Seek, SeekFrom};
    if feature >= spec.width {
        return Err(format!("Feature {feature} does not exist (0–{}).", spec.width - 1));
    }
    let mut f = std::fs::File::open(dir(root, spec).join("w_dec.f32")).map_err(|_| "The feature data is not downloaded yet.".to_string())?;
    f.seek(SeekFrom::Start((feature * spec.n_embd * 4) as u64)).map_err(|e| crate::os_error::english(&e))?;
    let mut b = vec![0u8; spec.n_embd * 4];
    f.read_exact(&mut b).map_err(|e| crate::os_error::english(&e))?;
    let row: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut cv = super::cvec::ControlVector::new(spec.n_embd);
    cv.layers.insert(spec.layer, row);
    Ok(cv)
}

/// A token as a person reads it: SentencePiece's word marker becomes a space,
/// byte tokens and control tokens become nothing.
pub fn readable(token: &str) -> String {
    if token.starts_with("<0x") || (token.starts_with('<') && token.ends_with('>')) {
        return String::new();
    }
    token.replace(['\u{2581}', '\u{0120}'], " ").trim().to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub feature: usize,
    pub label: String,
    pub score: u32,
}

/// Labels for every feature: its ten top tokens, readable and de-duplicated.
pub fn labels(top_tokens: &[i32], vocab: &[String]) -> Vec<Vec<String>> {
    top_tokens
        .chunks(10)
        .map(|row| {
            let mut seen = Vec::<String>::new();
            for t in row {
                let word = vocab.get(*t as usize).map(|s| readable(s)).unwrap_or_default();
                if !word.is_empty() && !seen.iter().any(|w| w.eq_ignore_ascii_case(&word)) {
                    seen.push(word);
                }
            }
            seen
        })
        .collect()
}

/// Features whose top tokens are the word searched for, ranked by how many
/// of them match and how high. A token matches when it is the word, or
/// starts with it ("location" for "locat"), or is a longer form of it
/// ("dogs" for "dog"), never a mere fragment inside ("rate" is not "pirate").
/// `#123` finds feature 123.
pub fn search(labels: &[Vec<String>], query: &str, limit: usize) -> Vec<Hit> {
    let q = query.trim().to_lowercase();
    if let Some(n) = q.strip_prefix('#').and_then(|n| n.parse::<usize>().ok()) {
        return labels.get(n).map(|l| vec![Hit { feature: n, label: l.join(" · "), score: 100 }]).unwrap_or_default();
    }
    let words: Vec<&str> = q.split_whitespace().filter(|w| w.chars().count() >= 2).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<Hit> = labels
        .iter()
        .enumerate()
        .filter_map(|(i, toks)| {
            let mut score = 0u32;
            for (rank, tok) in toks.iter().enumerate() {
                let t = tok.to_lowercase();
                for w in &words {
                    let exact = t == *w;
                    let longer = t.chars().count() >= 3 && t.starts_with(w);
                    if exact {
                        score += 3 * (10 - rank as u32);
                    } else if longer {
                        score += 10 - rank as u32;
                    }
                }
            }
            (score > 0).then(|| Hit { feature: i, label: toks.join(" · "), score })
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.feature.cmp(&b.feature)));
    hits.truncate(limit);
    hits
}

pub fn read_i32s(path: &Path) -> Result<Vec<i32>, String> {
    let b = std::fs::read(path).map_err(|_| "The feature data is not downloaded yet.".to_string())?;
    Ok(b.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(arch: &str, n_embd: usize, n_layer: usize) -> ModelFacts {
        ModelFacts { arch: arch.into(), n_layer, n_embd, template: super::super::model::Template::Gemma, name: "x".into(), tweaked: Vec::new(), original: None }
    }

    #[test]
    fn catalog_matches_by_shape_only() {
        assert_eq!(for_model(&facts("gemma3", 640, 18)).unwrap().id, "gemma-scope-2-270m-it-l9");
        assert_eq!(for_model(&facts("gemma3", 1152, 26)).unwrap().id, "gemma-scope-2-1b-it-l13");
        assert!(for_model(&facts("qwen2", 896, 24)).is_none());
        assert!(for_model(&facts("gemma3", 2560, 34)).is_none());
    }

    #[test]
    fn slices_have_the_size_of_their_tensors() {
        for s in CATALOG {
            assert_eq!(s.w_dec.len(), (s.width * s.n_embd * 4) as u64, "{}", s.id);
            assert_eq!(s.top_tokens.len(), (s.width * 10 * 4) as u64, "{}", s.id);
            assert!(s.layer >= 1 && s.layer < s.n_layer);
            assert_eq!(s.w_dec.sha256.len(), 64);
            assert!(s.url(&s.w_dec).starts_with("https://huggingface.co/google/gemma-scope-2-"));
            assert!(s.url(&s.w_dec).contains(s.revision));
        }
    }

    #[test]
    fn readable_drops_markers() {
        assert_eq!(readable("\u{2581}love"), "love");
        assert_eq!(readable("<0x0A>"), "");
        assert_eq!(readable("<unused12>"), "");
        assert_eq!(readable("Love"), "Love");
    }

    fn lab(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect()
    }

    #[test]
    fn search_ranks_exact_words_and_ignores_fragments() {
        let l = lab(&[
            &["rate", "scores", "loops"],
            &["locations", "Locations", "location", "areas"],
            &["sides", "margins", "underdog"],
            &["dog", "puppy"],
        ]);
        assert!(search(&l, "pirate", 10).is_empty());
        let loc = search(&l, "location", 10);
        assert_eq!(loc[0].feature, 1);
        let dog = search(&l, "dog", 10);
        assert_eq!(dog.len(), 1, "underdog is not a dog");
        assert_eq!(dog[0].feature, 3);
        assert_eq!(search(&l, "#2", 10)[0].feature, 2);
        assert!(search(&l, "#99", 10).is_empty());
        assert!(search(&l, " ", 10).is_empty());
    }

    #[test]
    fn labels_read_tokens_through_the_vocabulary() {
        let vocab: Vec<String> = vec!["<pad>".into(), "\u{2581}love".into(), "Love".into(), "love".into()];
        let tops = vec![1, 2, 3, 0, 1, 1, 1, 1, 1, 1];
        assert_eq!(labels(&tops, &vocab), vec![vec!["love".to_string()]]);
    }

    #[test]
    fn feature_vector_reads_one_row_into_its_layer() {
        let dir = tempfile::tempdir().unwrap();
        let spec = &CATALOG[0];
        let d = super::dir(dir.path(), spec);
        std::fs::create_dir_all(&d).unwrap();
        // Two rows are enough to read the second.
        let mut b = vec![0u8; spec.n_embd * 4 * 2];
        b[spec.n_embd * 4..spec.n_embd * 4 + 4].copy_from_slice(&1.5f32.to_le_bytes());
        std::fs::write(d.join("w_dec.f32"), &b).unwrap();
        let cv = feature_vector(dir.path(), spec, 1).unwrap();
        assert_eq!(cv.layers.keys().copied().collect::<Vec<_>>(), vec![9]);
        assert_eq!(cv.layers[&9][0], 1.5);
        assert!(feature_vector(dir.path(), spec, 16384).is_err());
    }
}
