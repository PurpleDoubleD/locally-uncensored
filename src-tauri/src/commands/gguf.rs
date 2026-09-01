//! Minimal, defensive GGUF header reader (ENG-6c).
//!
//! The bundled llama-server exposes neither `n_ctx_train` on `/props` nor any
//! model metadata on `/v1/models` (verified against b1-049326a), so the only
//! source for a model's TRAINED context limit is the GGUF header itself:
//! `general.architecture` = "<arch>", then `<arch>.context_length`. The
//! Context dropdown uses it to cap its presets — without it a 32k model
//! happily "accepts" -c 131072 and degrades silently (llama.cpp only warns).
//!
//! Deliberately paranoid: this runs against user-downloaded files inside
//! `list_bundled_models`, so it must NEVER panic or stall the listing —
//! every failure path is `None`, reads are bounded, and only the header is
//! touched (a few KB of a multi-GB file).

use std::fs::File;
use std::io::{BufReader, Read};

const GGUF_MAGIC: &[u8; 4] = b"GGUF";
/// Real models carry a few dozen KV pairs; hundreds is already absurd.
const MAX_KV: u64 = 4096;
/// Longest key/string value we are willing to read (keys are ~30 chars).
const MAX_STR: u64 = 64 * 1024;
/// Longest metadata array we are willing to SKIP element-by-element
/// (tokenizer vocabularies easily reach 150k entries).
const MAX_ARR: u64 = 10_000_000;

struct R<'a>(&'a mut dyn Read);

impl R<'_> {
    fn u8(&mut self) -> Option<u8> {
        let mut b = [0u8; 1];
        self.0.read_exact(&mut b).ok()?;
        Some(b[0])
    }
    fn u32(&mut self) -> Option<u32> {
        let mut b = [0u8; 4];
        self.0.read_exact(&mut b).ok()?;
        Some(u32::from_le_bytes(b))
    }
    fn u64(&mut self) -> Option<u64> {
        let mut b = [0u8; 8];
        self.0.read_exact(&mut b).ok()?;
        Some(u64::from_le_bytes(b))
    }
    fn skip(&mut self, n: u64) -> Option<()> {
        // io::copy into a sink honors non-seekable readers and bounds memory.
        // (&mut *) reborrows the trait object as a Sized `&mut dyn Read` so
        // `take` can consume it.
        let copied = std::io::copy(&mut (&mut *self.0).take(n), &mut std::io::sink()).ok()?;
        (copied == n).then_some(())
    }
    fn string(&mut self, max: u64) -> Option<String> {
        let len = self.u64()?;
        if len > max {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        self.0.read_exact(&mut buf).ok()?;
        String::from_utf8(buf).ok()
    }
}

/// GGUF metadata value types (spec v3). Returns the byte size of FIXED-width
/// types; strings/arrays are handled by the caller.
fn fixed_size(ty: u32) -> Option<u64> {
    match ty {
        0 | 1 | 7 => Some(1), // u8 / i8 / bool
        2 | 3 => Some(2),     // u16 / i16
        4 | 5 | 6 => Some(4), // u32 / i32 / f32
        10 | 11 | 12 => Some(8), // u64 / i64 / f64
        _ => None,            // 8 = string, 9 = array, unknown
    }
}

enum Val {
    UInt(u64),
    Str(String),
    Other,
}

fn read_value(r: &mut R, ty: u32) -> Option<Val> {
    match ty {
        4 => Some(Val::UInt(r.u32()? as u64)),
        10 => Some(Val::UInt(r.u64()?)),
        0 => Some(Val::UInt(r.u8()? as u64)),
        2 => {
            let mut b = [0u8; 2];
            r.0.read_exact(&mut b).ok()?;
            Some(Val::UInt(u16::from_le_bytes(b) as u64))
        }
        8 => Some(Val::Str(r.string(MAX_STR)?)),
        9 => {
            // array: elem type + count, then elements — skip it whole.
            let elem_ty = r.u32()?;
            let count = r.u64()?;
            if count > MAX_ARR {
                return None;
            }
            if let Some(sz) = fixed_size(elem_ty) {
                r.skip(count.checked_mul(sz)?)?;
            } else if elem_ty == 8 {
                for _ in 0..count {
                    let len = r.u64()?;
                    if len > MAX_STR {
                        return None;
                    }
                    r.skip(len)?;
                }
            } else {
                return None; // nested arrays / unknown — bail out
            }
            Some(Val::Other)
        }
        _ => {
            r.skip(fixed_size(ty)?)?;
            Some(Val::Other)
        }
    }
}

/// The context length the model was TRAINED with (`<arch>.context_length`),
/// or `None` when the file is missing, not GGUF, truncated, or simply does
/// not carry the key. Never panics, never reads past the header.
pub fn context_length(path: &str) -> Option<u32> {
    let file = File::open(path).ok()?;
    let mut buf = BufReader::new(file);
    let mut r = R(&mut buf);

    let mut magic = [0u8; 4];
    r.0.read_exact(&mut magic).ok()?;
    if &magic != GGUF_MAGIC {
        return None;
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return None;
    }
    let _tensor_count = r.u64()?;
    let kv_count = r.u64()?;
    if kv_count > MAX_KV {
        return None;
    }

    let mut arch: Option<String> = None;
    let mut ctx_by_key: Option<(String, u64)> = None;

    for _ in 0..kv_count {
        let key = r.string(MAX_STR)?;
        let ty = r.u32()?;
        let val = read_value(&mut r, ty)?;
        match val {
            Val::Str(s) if key == "general.architecture" => arch = Some(s),
            Val::UInt(n) if key.ends_with(".context_length") => {
                ctx_by_key = Some((key, n));
            }
            _ => {}
        }
        // Early exit once both halves are known and they agree.
        if let (Some(a), Some((k, n))) = (&arch, &ctx_by_key) {
            if k == &format!("{a}.context_length") {
                return u32::try_from(*n).ok();
            }
        }
    }

    // Architecture key came AFTER the context key (order is unspecified), or
    // the arch never showed up — accept any single *.context_length match.
    match (arch, ctx_by_key) {
        (Some(a), Some((k, n))) if k == format!("{a}.context_length") => u32::try_from(n).ok(),
        (None, Some((_, n))) => u32::try_from(n).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::context_length;
    use std::io::Write;

    // Tiny hand-rolled GGUF v3 writer — just enough for the header path.
    struct W(Vec<u8>);
    impl W {
        fn new(kv_count: u64) -> Self {
            let mut v = Vec::new();
            v.extend_from_slice(b"GGUF");
            v.extend_from_slice(&3u32.to_le_bytes()); // version
            v.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
            v.extend_from_slice(&kv_count.to_le_bytes());
            W(v)
        }
        fn str_field(&mut self, key: &str, val: &str) {
            self.key(key);
            self.0.extend_from_slice(&8u32.to_le_bytes());
            self.0.extend_from_slice(&(val.len() as u64).to_le_bytes());
            self.0.extend_from_slice(val.as_bytes());
        }
        fn u32_field(&mut self, key: &str, val: u32) {
            self.key(key);
            self.0.extend_from_slice(&4u32.to_le_bytes());
            self.0.extend_from_slice(&val.to_le_bytes());
        }
        fn arr_str_field(&mut self, key: &str, items: &[&str]) {
            self.key(key);
            self.0.extend_from_slice(&9u32.to_le_bytes()); // array
            self.0.extend_from_slice(&8u32.to_le_bytes()); // of strings
            self.0.extend_from_slice(&(items.len() as u64).to_le_bytes());
            for s in items {
                self.0.extend_from_slice(&(s.len() as u64).to_le_bytes());
                self.0.extend_from_slice(s.as_bytes());
            }
        }
        fn key(&mut self, key: &str) {
            self.0.extend_from_slice(&(key.len() as u64).to_le_bytes());
            self.0.extend_from_slice(key.as_bytes());
        }
        fn write_to(&self, path: &std::path::Path) {
            let mut f = std::fs::File::create(path).unwrap();
            f.write_all(&self.0).unwrap();
        }
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("lu-gguf-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn reads_context_length_behind_skipped_values() {
        let mut w = W::new(4);
        w.str_field("general.name", "unit test model");
        w.arr_str_field("tokenizer.ggml.tokens", &["a", "b", "c"]);
        w.str_field("general.architecture", "qwen2");
        w.u32_field("qwen2.context_length", 32768);
        let p = tmp("ok.gguf");
        w.write_to(&p);
        assert_eq!(context_length(p.to_str().unwrap()), Some(32768));
    }

    #[test]
    fn context_key_before_architecture_still_resolves() {
        let mut w = W::new(2);
        w.u32_field("llama.context_length", 8192);
        w.str_field("general.architecture", "llama");
        let p = tmp("reversed.gguf");
        w.write_to(&p);
        assert_eq!(context_length(p.to_str().unwrap()), Some(8192));
    }

    #[test]
    fn garbage_missing_and_truncated_files_are_none() {
        let p = tmp("garbage.gguf");
        std::fs::write(&p, b"MZ\x90definitely not a gguf").unwrap();
        assert_eq!(context_length(p.to_str().unwrap()), None);
        assert_eq!(context_length("/nonexistent/nope.gguf"), None);

        // Valid magic, then the file just ends mid-header.
        let t = tmp("truncated.gguf");
        std::fs::write(&t, b"GGUF\x03\x00\x00\x00").unwrap();
        assert_eq!(context_length(t.to_str().unwrap()), None);
    }

    // ── The one check in this file against a GGUF this module did not write ──
    //
    // Everything above parses bytes produced by `W`, the writer twenty lines
    // up. That cannot catch the failure both halves share a wrong assumption
    // about; only a file llama.cpp produced can. So this probe is worth
    // keeping — but the way it was written, it was worth nothing:
    //
    //     let home = std::env::var("HOME").unwrap_or_default();
    //     let p = format!("{home}/Library/Application Support/Locally \
    //                      Uncensored/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf");
    //     if Path::new(&p).exists() { assert_eq!(...) }
    //
    // Two things were wrong with that.
    //
    // 1. It built the path by hand, so it was macOS-only and it named the
    //    directory of the PRODUCTION app directly instead of going through
    //    `os_paths`, which is the single place that knows the app directory
    //    and, on this branch, its isolation suffix. Reading is not a violation
    //    — but a hand-built copy of a path is how a WRITE ends up in the
    //    user's real data later.
    // 2. It turned itself off in silence. On every machine without that exact
    //    file — CI, Windows, Linux, a fresh checkout — it passed while
    //    asserting nothing, and said so nowhere. A test that quietly checks
    //    nothing is worse than a red one: the red one gets fixed.
    //
    // What replaces it: the path build is pinned by a test that always runs
    // and always asserts, and the file-dependent half announces its skip on a
    // stream the test harness does not capture.

    /// The model the built-in engine ships with. Its trained context length is
    /// a property of the file, not of this repo.
    const REAL_MODEL_FILE: &str = "Qwen2.5-0.5B-Instruct-Q8_0.gguf";
    const REAL_MODEL_CONTEXT: u32 = 32768;

    /// The production app's directory name.
    ///
    /// A literal on purpose, and the only one in this file: derived from
    /// `APP_DISPLAY_DIR` it would follow whatever that constant becomes, and
    /// the assertion below — that this build's directory is NOT the
    /// production one — would then be checking itself. Same reasoning as
    /// `NAMEN_DER_ECHTEN_APP` in `app_identity`.
    const PRODUCTION_DISPLAY_DIR: &str = "Locally Uncensored";

    /// Where a real GGUF may be found, most-owned first.
    ///
    /// 1. This build's own model directory, straight from `os_paths`.
    /// 2. The production install's model directory — same parent, same
    ///    `models` leaf, directory name without this branch's suffix. READ
    ///    ONLY: on a dev machine that is the only place a real model is, and
    ///    the isolated build never downloads one.
    fn real_gguf_candidates() -> Vec<std::path::PathBuf> {
        let own = crate::os_paths::builtin_models_dir();
        let mut out = vec![own.join(REAL_MODEL_FILE)];
        // <data_dir>/<APP_DISPLAY_DIR>/models -> <data_dir>/<production>/models
        if let Some(data_dir) = own.parent().and_then(|p| p.parent()) {
            out.push(
                data_dir
                    .join(PRODUCTION_DISPLAY_DIR)
                    .join("models")
                    .join(REAL_MODEL_FILE),
            );
        }
        out
    }

    /// Always runs, always asserts: the probe looks where `os_paths` says, and
    /// this build's own directory is not the production one.
    #[test]
    fn the_real_gguf_probe_goes_through_the_central_path_builder() {
        use crate::app_identity::APP_DISPLAY_DIR;

        let candidates = real_gguf_candidates();
        assert_eq!(candidates.len(), 2, "{candidates:?}");

        // #1 is os_paths' own answer, not a string built here.
        assert_eq!(
            candidates[0],
            crate::os_paths::builtin_models_dir().join(REAL_MODEL_FILE)
        );

        // The isolation suffix is real and this build carries it.
        assert_ne!(
            APP_DISPLAY_DIR, PRODUCTION_DISPLAY_DIR,
            "this build reads and would write the production app's model directory"
        );
        let own_dir = candidates[0]
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .expect("no app directory in the built path");
        assert_eq!(own_dir, APP_DISPLAY_DIR);

        // #2 differs from #1 in exactly that one component.
        let prod_dir = candidates[1]
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .expect("no app directory in the production path");
        assert_eq!(prod_dir, PRODUCTION_DISPLAY_DIR);
        assert_eq!(
            candidates[0].parent().and_then(|p| p.parent()).and_then(|p| p.parent()),
            candidates[1].parent().and_then(|p| p.parent()).and_then(|p| p.parent()),
            "the two candidates are not siblings under the same data dir"
        );
        assert!(candidates.iter().all(|c| c.ends_with(REAL_MODEL_FILE)));
    }

    /// Parses a real GGUF when one is on this machine — and says out loud when
    /// there is none, instead of passing in silence.
    ///
    /// The skip notice is written straight to `stderr` rather than through
    /// `eprintln!`: libtest's capture swaps the sink the print macros use, so
    /// a macro line from a PASSING test is swallowed, while a direct write to
    /// the handle reaches the terminal. Verified on this machine, 2026-09-01.
    #[test]
    fn a_real_gguf_parses_or_the_run_says_why_it_could_not() {
        let candidates = real_gguf_candidates();
        match candidates.iter().find(|p| p.exists()) {
            Some(path) => {
                assert_eq!(
                    context_length(path.to_str().expect("non-UTF-8 model path")),
                    Some(REAL_MODEL_CONTEXT),
                    "parsing the real model at {} gave the wrong context length",
                    path.display()
                );
            }
            None => {
                use std::io::Write;
                let looked: Vec<String> =
                    candidates.iter().map(|p| p.display().to_string()).collect();
                let _ = writeln!(
                    std::io::stderr(),
                    "\n  SKIPPED gguf::a_real_gguf_parses_or_the_run_says_why_it_could_not\n  \
                     reason: no real {REAL_MODEL_FILE} on this machine, so the parser was \
                     not checked against a file llama.cpp produced.\n  looked at:\n    {}\n  \
                     to run it for real, download the built-in engine's model once.\n",
                    looked.join("\n    ")
                );
            }
        }
    }
}
