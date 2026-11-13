//! What the tweaker needs to know about a GGUF: its shape, how its chat
//! turns are written, and (for a model with a sparse autoencoder) its
//! vocabulary.

use super::cvec::fixed_size;
use crate::commands::gguf::{read_model_head, Meta};
use std::io::Read;
use std::path::Path;

/// How a model writes a chat turn. The example prompts are wrapped in it so
/// the generator reads them the way the model reads a chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Template {
    ChatMl,
    Gemma,
    Llama3,
    Mistral,
    Plain,
}

impl Template {
    /// Picks the turn format from the GGUF's chat template, by the markers
    /// each format cannot do without.
    pub fn detect(chat_template: Option<&str>, arch: &str) -> Self {
        let t = chat_template.unwrap_or("");
        if t.contains("<|im_start|>") {
            Template::ChatMl
        } else if t.contains("<start_of_turn>") {
            Template::Gemma
        } else if t.contains("<|start_header_id|>") {
            Template::Llama3
        } else if t.contains("[INST]") {
            Template::Mistral
        } else if arch.starts_with("qwen") {
            Template::ChatMl
        } else if arch.starts_with("gemma") {
            Template::Gemma
        } else {
            Template::Plain
        }
    }

    /// One example as a single line for cvector-generator, which reads one
    /// prompt per line and turns `\n` back into a line break
    /// (`string_process_escapes`). The assistant turn is opened and begun
    /// with `opener`, so the difference is read where the model writes.
    pub fn example(self, system: &str, user: &str, opener: &str) -> String {
        let (s, u, o) = (escape(system), escape(user), escape(opener));
        match self {
            Template::ChatMl => format!("<|im_start|>system\\n{s}<|im_end|>\\n<|im_start|>user\\n{u}<|im_end|>\\n<|im_start|>assistant\\n{o}"),
            // Gemma has no system turn; its own template puts it in front of
            // the first user message.
            Template::Gemma => format!("<start_of_turn>user\\n{s}\\n\\n{u}<end_of_turn>\\n<start_of_turn>model\\n{o}"),
            Template::Llama3 => format!(
                "<|start_header_id|>system<|end_header_id|>\\n\\n{s}<|eot_id|><|start_header_id|>user<|end_header_id|>\\n\\n{u}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\\n\\n{o}"
            ),
            Template::Mistral => format!("[INST] {s}\\n\\n{u} [/INST] {o}"),
            Template::Plain => format!("{s}\\n\\nUser: {u}\\nAssistant: {o}"),
        }
    }
}

/// Text from the user goes into a line-based file: no raw line breaks, and a
/// backslash must stay a backslash after the generator's unescaping.
pub fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace(['\r', '\n'], " ").trim().to_string()
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFacts {
    pub arch: String,
    pub n_layer: usize,
    pub n_embd: usize,
    pub template: Template,
    pub name: String,
    /// Why this model looks changed before (abliterated, merge, …); empty
    /// for an original. The view says "works best with original, untweaked
    /// models" before computing when it is not empty.
    pub tweaked: Vec<&'static str>,
    /// The original to offer instead, family and size ("Qwen3.5 9B").
    pub original: Option<String>,
}

/// What a GGUF head says about where a model came from.
pub struct Signs<'a> {
    pub file: &'a str,
    pub name: &'a str,
    pub finetune: Option<&'a str>,
    pub base_names: &'a [String],
    pub base_count: i64,
    pub nextn: i64,
}

/// Words in a name that mean the weights were changed after the maker's
/// release. Lower case, matched inside the name.
const TWEAK_WORDS: [(&str, &str); 7] = [
    ("abliterat", "abliterated"),
    ("obliterat", "abliterated"),
    ("heretic", "heretic"),
    ("uncensor", "uncensored"),
    ("decensor", "uncensored"),
    ("merge", "merge"),
    ("-mtp", "MTP"),
];

/// A maker's own fine-tunes (Qwen's "instruct", Gemma's "it") are originals.
const MAKER_FINETUNES: [&str; 6] = ["instruct", "it", "chat", "base", "thinking", "reasoning"];

/// Why a model looks tweaked, in the order the note names it (P11 FEHLER 10:
/// the vector tool works best on original models; David, 31.10.2026).
pub fn tweak_signs(s: &Signs) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let mut add = |w: &'static str| if !out.contains(&w) { out.push(w) };
    if let Some(ft) = s.finetune {
        let low = ft.to_lowercase();
        let maker = low.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| MAKER_FINETUNES.contains(&w));
        if !low.is_empty() && !maker { add("fine-tune") }
    }
    if s.base_count > 1 { add("merge") }
    let text = std::iter::once(s.file).chain(std::iter::once(s.name)).chain(s.base_names.iter().map(String::as_str))
        .collect::<Vec<_>>().join(" ").to_lowercase();
    for (needle, word) in TWEAK_WORDS {
        if text.contains(needle) { add(word) }
    }
    if s.nextn > 0 { add("MTP") }
    out
}

/// The original to offer: the family and size the head names.
pub fn original_of(basename: Option<&str>, size: Option<&str>) -> Option<String> {
    Some(format!("{} {}", basename?.trim(), size?.trim())).filter(|s| s.len() > 2)
}

/// Embedding and diffusion models (the architectures llama.cpp gives no
/// cache) have no chat turn to steer, and the vector tool aborts on them.
pub fn is_chat_arch(arch: &str) -> bool {
    !crate::commands::vram_plan::NO_CACHE_ARCHS.contains(&arch)
}

pub fn facts(path: &str) -> Result<ModelFacts, String> {
    let head = read_model_head(path).ok_or("LU cannot read this file as a GGUF model.")?;
    let arch = head.arch().ok_or("The model file names no architecture.")?.to_string();
    if !is_chat_arch(&arch) {
        return Err(format!("This is not a chat model ({arch}: embeddings or diffusion). The Neuron tweaker works on chat models."));
    }
    let n_layer = head.arch_int("block_count").filter(|n| *n > 1).ok_or("The model file names no layer count.")? as usize;
    let n_embd = head.arch_int("embedding_length").filter(|n| *n > 0).ok_or("The model file names no width.")? as usize;
    let template_text = match head.keys.get("tokenizer.chat_template") {
        Some(Meta::Str(s)) => Some(s.as_str()),
        _ => None,
    };
    let name = match head.keys.get("general.name") {
        Some(Meta::Str(s)) => s.clone(),
        _ => Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    let text = |k: &str| match head.keys.get(k) {
        Some(Meta::Str(s)) => Some(s.as_str()),
        _ => None,
    };
    let base_count = match head.keys.get("general.base_model.count") {
        Some(Meta::Int(n)) => *n,
        _ => 0,
    };
    let base_names: Vec<String> = (0..base_count.clamp(0, 16)).filter_map(|i| text(&format!("general.base_model.{i}.name")).map(str::to_string)).collect();
    let file = Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let tweaked = tweak_signs(&Signs {
        file: &file,
        name: &name,
        finetune: text("general.finetune"),
        base_names: &base_names,
        base_count,
        nextn: head.arch_int("nextn_predict_layers").unwrap_or(0),
    });
    let original = original_of(text("general.basename"), text("general.size_label"));
    Ok(ModelFacts { template: Template::detect(template_text, &arch), arch, n_layer, n_embd, name, tweaked, original })
}

/// Reads one string array (`tokenizer.ggml.tokens`) out of a GGUF head,
/// skipping everything else. The shared head reader keeps only the length of
/// such arrays.
pub fn string_array(path: &Path, wanted: &str) -> Result<Vec<String>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {}", path.display(), crate::os_error::english(&e)))?;
    let mut r = std::io::BufReader::new(f);
    let mut b4 = [0u8; 4];
    let mut b8 = [0u8; 8];
    let short = |_| "The model file ends too early.".to_string();
    r.read_exact(&mut b4).map_err(short)?;
    if &b4 != b"GGUF" {
        return Err("Not a GGUF file.".into());
    }
    r.read_exact(&mut b4).map_err(short)?;
    r.read_exact(&mut b8).map_err(short)?; // tensors
    r.read_exact(&mut b8).map_err(short)?;
    let n_kv = u64::from_le_bytes(b8);
    fn read_u32(r: &mut dyn Read) -> Result<u32, String> {
        let mut b = [0u8; 4];
        r.read_exact(&mut b).map_err(|_| "The model file ends too early.".to_string())?;
        Ok(u32::from_le_bytes(b))
    }
    fn read_u64(r: &mut dyn Read) -> Result<u64, String> {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).map_err(|_| "The model file ends too early.".to_string())?;
        Ok(u64::from_le_bytes(b))
    }
    fn read_str(r: &mut dyn Read) -> Result<String, String> {
        let len = read_u64(r)?;
        if len > 1 << 20 {
            return Err("A string in the model file is too long.".into());
        }
        let mut b = vec![0u8; len as usize];
        r.read_exact(&mut b).map_err(|_| "The model file ends too early.".to_string())?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }
    fn skip(r: &mut dyn Read, n: u64) -> Result<(), String> {
        let got = std::io::copy(&mut r.take(n), &mut std::io::sink()).map_err(|e| crate::os_error::english(&e))?;
        if got == n { Ok(()) } else { Err("The model file ends too early.".into()) }
    }
    fn skip_val(r: &mut dyn Read, ty: u32) -> Result<(), String> {
        if let Some(n) = fixed_size(ty) {
            return skip(r, n);
        }
        match ty {
            8 => {
                let n = read_u64(r)?;
                skip(r, n)
            }
            9 => {
                let mut b = [0u8; 4];
                r.read_exact(&mut b).map_err(|_| "The model file ends too early.".to_string())?;
                let elem = u32::from_le_bytes(b);
                let count = read_u64(r)?;
                if let Some(n) = fixed_size(elem) {
                    return skip(r, count.saturating_mul(n));
                }
                for _ in 0..count {
                    skip_val(r, elem)?;
                }
                Ok(())
            }
            _ => Err(format!("Unknown value type {ty} in the model file.")),
        }
    }
    for _ in 0..n_kv.min(65_536) {
        let key = read_str(&mut r)?;
        let ty = read_u32(&mut r)?;
        if key == wanted && ty == 9 {
            let elem = read_u32(&mut r)?;
            let count = read_u64(&mut r)?;
            if elem != 8 || count > 2_000_000 {
                return Err(format!("{wanted} is not a list of strings."));
            }
            let mut out = Vec::with_capacity(count as usize);
            for _ in 0..count {
                out.push(read_str(&mut r)?);
            }
            return Ok(out);
        }
        skip_val(&mut r, ty)?;
    }
    Err(format!("The model file has no {wanted}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_follows_the_markers() {
        assert_eq!(Template::detect(Some("{{'<|im_start|>' + role}}"), "llama"), Template::ChatMl);
        assert_eq!(Template::detect(Some("<start_of_turn>user"), "gemma3"), Template::Gemma);
        assert_eq!(Template::detect(Some("<|start_header_id|>"), "llama"), Template::Llama3);
        assert_eq!(Template::detect(Some("[INST]"), "llama"), Template::Mistral);
        assert_eq!(Template::detect(None, "qwen3"), Template::ChatMl);
        assert_eq!(Template::detect(None, "phi3"), Template::Plain);
    }

    #[test]
    fn example_is_one_line_with_escaped_breaks() {
        let line = Template::ChatMl.example("Be happy.\nVery.", "Hi \\o/", "Well,");
        assert!(!line.contains('\n'));
        assert!(line.starts_with("<|im_start|>system\\nBe happy. Very.<|im_end|>"));
        assert!(line.contains("Hi \\\\o/"));
        assert!(line.ends_with("<|im_start|>assistant\\nWell,"));
        let g = Template::Gemma.example("S", "U", "O");
        assert_eq!(g, "<start_of_turn>user\\nS\\n\\nU<end_of_turn>\\n<start_of_turn>model\\nO");
    }

    fn put_str(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u64).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn string_array_finds_the_vocabulary_behind_other_keys() {
        let mut b = Vec::new();
        b.extend_from_slice(b"GGUF");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&0u64.to_le_bytes());
        b.extend_from_slice(&3u64.to_le_bytes());
        put_str(&mut b, "general.architecture");
        b.extend_from_slice(&8u32.to_le_bytes());
        put_str(&mut b, "gemma3");
        put_str(&mut b, "tokenizer.ggml.scores");
        b.extend_from_slice(&9u32.to_le_bytes());
        b.extend_from_slice(&6u32.to_le_bytes());
        b.extend_from_slice(&2u64.to_le_bytes());
        b.extend_from_slice(&[0u8; 8]);
        put_str(&mut b, "tokenizer.ggml.tokens");
        b.extend_from_slice(&9u32.to_le_bytes());
        b.extend_from_slice(&8u32.to_le_bytes());
        b.extend_from_slice(&2u64.to_le_bytes());
        put_str(&mut b, "<pad>");
        put_str(&mut b, "\u{2581}love");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.gguf");
        std::fs::write(&p, &b).unwrap();
        assert_eq!(string_array(&p, "tokenizer.ggml.tokens").unwrap(), vec!["<pad>".to_string(), "\u{2581}love".to_string()]);
        assert!(string_array(&p, "nope").is_err());
    }

    fn head_file(dir: &Path, arch: &str) -> std::path::PathBuf {
        let mut b = Vec::new();
        b.extend_from_slice(b"GGUF");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&0u64.to_le_bytes());
        b.extend_from_slice(&3u64.to_le_bytes());
        put_str(&mut b, "general.architecture");
        b.extend_from_slice(&8u32.to_le_bytes());
        put_str(&mut b, arch);
        for (key, v) in [("block_count", 12u32), ("embedding_length", 768)] {
            put_str(&mut b, &format!("{arch}.{key}"));
            b.extend_from_slice(&4u32.to_le_bytes());
            b.extend_from_slice(&v.to_le_bytes());
        }
        let p = dir.join(format!("{arch}.gguf"));
        std::fs::write(&p, &b).unwrap();
        p
    }

    /// T1 (3.0.9): an embedding model in the models folder was offered and
    /// the vector tool aborted on it.
    #[test]
    fn an_embedding_model_is_refused_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let err = facts(head_file(dir.path(), "nomic-bert").to_str().unwrap()).unwrap_err();
        assert!(err.contains("not a chat model"), "{err}");
        let ok = facts(head_file(dir.path(), "qwen2").to_str().unwrap()).unwrap();
        assert_eq!((ok.n_layer, ok.n_embd), (12, 768));
        assert!(!is_chat_arch("bert") && !is_chat_arch("gemma-embedding") && is_chat_arch("gemma3"));
    }
    /// P11 FEHLER 10 (David, 31.10.2026): a model that was changed before
    /// (abliterated, heretic, uncensored fine-tunes, merges, MTP) gets a note
    /// before computing, "works best with original, untweaked models".
    #[test]
    fn a_tweaked_model_is_recognised_and_an_original_is_not() {
        // David's model: Qwen3.5-9B-The-Defiant, a fine-tune merged from six
        // models, three of them "Uncensored Heretic".
        let bases: Vec<String> = vec![
            "Qwen3.5 9B TNG PKD Qwopus Coder".into(),
            "Qwen3.5 9B Pro Writer 1984 Orwell Uncensored Heretic".into(),
        ];
        let defiant = tweak_signs(&Signs {
            file: "Qwen3.5-9B-The-Defiant-Q4_K_M", name: "Qwen3.5 9B DS9 USS Defiant NM",
            finetune: Some("DS9-USS-Defiant-NM"), base_names: &bases, base_count: 6, nextn: 0,
        });
        assert!(defiant.contains(&"fine-tune") && defiant.contains(&"merge") && defiant.contains(&"heretic") && defiant.contains(&"uncensored"), "{defiant:?}");
        // Abliterated in the file name alone, and an MTP block alone.
        assert_eq!(tweak_signs(&Signs { file: "Llama-3.1-8B-Instruct-abliterated.Q4_K_M", name: "", finetune: None, base_names: &[], base_count: 0, nextn: 0 }), vec!["abliterated"]);
        assert_eq!(tweak_signs(&Signs { file: "Qwen3.5-9B", name: "Qwen3.5 9B", finetune: None, base_names: &[], base_count: 0, nextn: 1 }), vec!["MTP"]);
        // The originals on this Mac: Qwen's instruct and Gemma's "it" with
        // their one base model are no tweak.
        assert!(tweak_signs(&Signs { file: "qwen2.5-0.5b-instruct-q8_0", name: "qwen2.5-0.5b-instruct", finetune: Some("qwen2.5-0.5b-instruct"), base_names: &[], base_count: 0, nextn: 0 }).is_empty());
        let gemma_base: Vec<String> = vec!["Gemma 3 270m".into()];
        assert!(tweak_signs(&Signs { file: "gemma-3-270m-it-Q8_0", name: "Gemma 3 270m It", finetune: Some("it"), base_names: &gemma_base, base_count: 1, nextn: 0 }).is_empty());
        assert!(tweak_signs(&Signs { file: "Qwen3-4B-Thinking-2507-Q4_K_M", name: "Qwen3 4B Thinking 2507", finetune: Some("Thinking-2507"), base_names: &[], base_count: 0, nextn: 0 }).is_empty());
    }

    #[test]
    fn the_original_to_offer_is_family_and_size() {
        assert_eq!(original_of(Some("Qwen3.5"), Some("9B")), Some("Qwen3.5 9B".into()));
        assert_eq!(original_of(Some("gemma-3"), Some("270M")), Some("gemma-3 270M".into()));
        assert_eq!(original_of(None, Some("9B")), None);
    }
}
