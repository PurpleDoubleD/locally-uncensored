//! Assembles the mobile client page out of `mobile-client/`.
//!
//! Until now the page a phone receives was a 2 964-line `r#"…"#` literal in
//! `commands/remote.rs`: HTML, CSS and 2 606 lines of JavaScript walled into a
//! Rust string. `tsc`, `eslint`, `prettier` and `vitest` cannot see inside a
//! Rust string, so none of them ever ran on it, and the tests that claimed to
//! cover it were hand-written TypeScript re-implementations sitting next to
//! it — two copies of the same rules, one of them maintained.
//!
//! Now `mobile-client/` holds real `.html`, `.css` and `.js` files, this
//! module glues them back into exactly the same bytes, and `build.rs` runs it
//! on every build.
//!
//! ── Why the glue lives in Rust and not in a Node script ──
//!
//! Because `cargo build` needs the result. A Node step would have to be
//! remembered by whoever runs cargo, and the thing it forgets to run produces
//! a file that is still lying there from last time. One assembler, run by the
//! build that consumes it, is the only arrangement where a stale page is not
//! reachable. The output goes to `OUT_DIR`, never into the repository, so
//! there is no checked-in copy that could go stale in the first place, and a
//! missing or broken source aborts the build instead of falling back to
//! whatever was there before.
//!
//! ── The two marker shapes ──
//!
//! `/*@@LU_TOOLING_ONLY@@*/ … /*@@LU_END@@*/` wraps the `import` / `export`
//! statements that make the four `.js` files a real module graph for tsc,
//! eslint and vitest. A classic `<script>` cannot carry those, so the
//! assembler cuts every such block out.
//!
//! `//@@LU_CAVEMAN@@` and friends are single marker lines that name where one
//! file is spliced into another. The spliced text lands at exactly the offset
//! the marker line occupied, which is what keeps the assembled page byte for
//! byte identical to the string it replaces.

use std::path::{Path, PathBuf};

/// The file `build.rs` writes into `OUT_DIR` and `remote.rs` embeds.
pub const EMBED_NAME: &str = "mobile-client.html";

/// Every file the assembler reads. Nothing else in `mobile-client/` reaches
/// the phone.
///
/// The list is checked from both ends by the tests below: each entry must be
/// genuinely required (deleting it has to break `assemble`), and every
/// `.html` / `.css` / `.js` file actually lying in the directory has to be on
/// it. A page source that is on neither side of that ledger is a file someone
/// edits while the phone never sees the edit.
pub const SOURCES: &[&str] = &[
    "index.html",
    "styles.css",
    "caveman.js",
    "personas.js",
    "agent-core.js",
    "client.js",
];

const TOOLING_START: &str = "/*@@LU_TOOLING_ONLY@@*/";
const TOOLING_END: &str = "/*@@LU_END@@*/";

/// `(marker line, file spliced in its place)`, in the order the assembler
/// applies them. The first three build the page's `<script>`; the last two
/// drop the stylesheet and that script into the document.
const SCRIPT_SPLICES: &[(&str, &str)] = &[
    ("  //@@LU_CAVEMAN@@", "caveman.js"),
    ("  //@@LU_PERSONAS@@", "personas.js"),
    ("  //@@LU_AGENT_CORE@@", "agent-core.js"),
];
const STYLE_MARKER: &str = "/*@@LU_STYLES@@*/";
const SCRIPT_MARKER: &str = "//@@LU_SCRIPT@@";

/// `<repo>/mobile-client`, derived from the crate's own manifest directory so
/// it follows a checkout wherever it sits.
pub fn client_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("mobile-client")
}

/// The page exactly as it goes over the wire, or the reason it could not be
/// built. There is deliberately no third answer: a caller cannot accidentally
/// end up with a half-assembled or previously-assembled page.
pub fn assemble(dir: &Path) -> Result<String, String> {
    let mut script = body(dir, "client.js")?;
    for (marker, part) in SCRIPT_SPLICES {
        script = splice(&script, "client.js", marker, &body(dir, part)?)?;
    }
    let page = body(dir, "index.html")?;
    let page = splice(&page, "index.html", STYLE_MARKER, &body(dir, "styles.css")?)?;
    splice(&page, "index.html", SCRIPT_MARKER, &script)
}

/// One source file, tooling blocks removed and trailing newlines trimmed.
///
/// The trim is what lets every source file end with a newline like a normal
/// text file while the spliced result still lands on the exact byte the
/// marker line started at.
fn body(dir: &Path, name: &str) -> Result<String, String> {
    let path = dir.join(name);
    let raw = std::fs::read_to_string(&path).map_err(|kind| {
        // The io::ErrorKind, not the error's own text. Windows words that text
        // in the system language (the whole point of os_error.rs), and this
        // string lands in a build log and in test output that is read in
        // English. The kind plus the path says everything that matters here.
        format!(
            "{} could not be read ({:?}).\n\
             It is one of the {} files listed in mobile_page::SOURCES; the \
             mobile client page cannot be built without it.",
            path.display(),
            kind.kind(),
            SOURCES.len()
        )
    })?;
    Ok(strip_tooling_blocks(&raw, name)?
        .trim_end_matches('\n')
        .to_string())
}

/// Removes every `/*@@LU_TOOLING_ONLY@@*/ … /*@@LU_END@@*/` region, marker
/// lines included.
///
/// Unbalanced markers are an error rather than a best-effort cut: a stray
/// opener would otherwise silently swallow the rest of the file and ship a
/// page that is missing half its script.
fn strip_tooling_blocks(source: &str, name: &str) -> Result<String, String> {
    let mut kept: Vec<&str> = Vec::new();
    let mut open_at: Option<usize> = None;
    for (i, line) in source.lines().enumerate() {
        match line.trim_end() {
            TOOLING_START => {
                if let Some(at) = open_at {
                    return Err(format!(
                        "{name}:{}: {TOOLING_START} inside the block opened on line {}",
                        i + 1,
                        at + 1
                    ));
                }
                open_at = Some(i);
            }
            TOOLING_END => {
                if open_at.take().is_none() {
                    return Err(format!(
                        "{name}:{}: {TOOLING_END} without a matching {TOOLING_START}",
                        i + 1
                    ));
                }
            }
            _ => {
                if open_at.is_none() {
                    kept.push(line);
                }
            }
        }
    }
    if let Some(at) = open_at {
        return Err(format!(
            "{name}:{}: {TOOLING_START} is never closed by {TOOLING_END}",
            at + 1
        ));
    }
    Ok(kept.join("\n"))
}

/// Replaces the single occurrence of `marker` in `host` with `part`.
///
/// Exactly one, never "the first one" and never "none, carry on": a marker
/// that moved or was duplicated during an edit has to stop the build, because
/// the alternative is a page that is quietly missing a third of its script.
fn splice(host: &str, host_name: &str, marker: &str, part: &str) -> Result<String, String> {
    match host.matches(marker).count() {
        1 => Ok(host.replacen(marker, part, 1)),
        n => Err(format!(
            "mobile-client/{host_name}: the splice marker `{marker}` appears {n} times, \
             expected exactly once. The assembler puts one source file at that spot; \
             without the marker that file would simply not reach the phone."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What counts as a page source when the ledger test audits the
    /// directory. Test-side on purpose: the assembler reads `SOURCES` by
    /// name, this is only the net that catches a file `SOURCES` forgot.
    const SOURCE_EXTENSIONS: &[&str] = &["html", "css", "js"];

    /// A working copy of `mobile-client/` a test may break.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lu-mobile-page-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for name in SOURCES {
                std::fs::copy(client_dir().join(name), dir.join(name)).unwrap();
            }
            Scratch(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn edit(&self, name: &str, f: impl Fn(String) -> String) {
            let p = self.0.join(name);
            let s = std::fs::read_to_string(&p).unwrap();
            std::fs::write(&p, f(s)).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_real_sources_assemble_into_a_whole_html_document() {
        let page = assemble(&client_dir()).expect("mobile-client/ does not assemble");
        assert!(page.starts_with("<!DOCTYPE html>"), "{}", &page[..40]);
        assert!(page.ends_with("</html>"), "{}", &page[page.len() - 40..]);
        // The three spliced modules and the stylesheet all really landed.
        for needle in [
            "var CAVEMAN_PROMPTS = {",
            "var PERSONAS = [",
            "var AGENT_TOOLS = [",
            "function compactApiMessages(",
            ".drawer-backdrop",
        ] {
            assert!(page.contains(needle), "assembled page is missing {needle}");
        }
        // And nothing that only exists for the tooling survived the trip.
        for leftover in [TOOLING_START, TOOLING_END, STYLE_MARKER, SCRIPT_MARKER] {
            assert!(
                !page.contains(leftover),
                "the assembled page still carries {leftover}"
            );
        }
        for (marker, _) in SCRIPT_SPLICES {
            assert!(
                !page.contains(marker),
                "the assembled page still carries {marker}"
            );
        }
        assert!(
            !page.contains("import {") && !page.contains("export {"),
            "an ES-module statement reached the classic <script> — it would be a SyntaxError on the phone"
        );
    }

    /// Both directions of the ledger. Neither half alone is enough: the first
    /// catches a file that is listed but no longer used, the second a file
    /// that is used — edited, believed shipped — but never read.
    #[test]
    fn every_declared_source_is_required_and_every_present_source_is_declared() {
        // 1. Every entry in SOURCES is genuinely load-bearing.
        for name in SOURCES {
            let scratch = Scratch::new("required");
            std::fs::remove_file(scratch.path().join(name)).unwrap();
            let err = assemble(scratch.path()).expect_err(&format!(
                "mobile-client/{name} is listed in SOURCES but the page assembles without it"
            ));
            assert!(err.contains(name), "{err}");
        }

        // 2. Every page source lying in the directory is on the list. A new
        //    .js next to these that nobody reads is a file whose edits never
        //    reach the phone, and nothing else would ever say so.
        let mut found: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(client_dir()).expect("mobile-client/ is not there") {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_source = Path::new(&name)
                .extension()
                .map(|e| SOURCE_EXTENSIONS.contains(&e.to_string_lossy().as_ref()))
                .unwrap_or(false);
            if entry.file_type().unwrap().is_file() && is_source {
                found.push(name);
            }
        }
        found.sort();
        let mut declared: Vec<String> = SOURCES.iter().map(|s| s.to_string()).collect();
        declared.sort();
        assert_eq!(
            found, declared,
            "mobile-client/ and mobile_page::SOURCES disagree. Every .html/.css/.js in that \
             directory has to be read by the assembler, or it is a file someone edits while \
             the phone keeps seeing the old page."
        );
    }

    #[test]
    fn a_missing_splice_marker_stops_the_build() {
        let scratch = Scratch::new("nomarker");
        scratch.edit("client.js", |s| s.replace("  //@@LU_PERSONAS@@", ""));
        let err = assemble(scratch.path()).expect_err(
            "client.js lost its personas.js splice marker and the page assembled anyway — \
             the phone would have received a script without PERSONAS",
        );
        assert!(err.contains("LU_PERSONAS"), "{err}");
        assert!(err.contains("appears 0 times"), "{err}");
    }

    #[test]
    fn a_duplicated_splice_marker_stops_the_build() {
        let scratch = Scratch::new("dupmarker");
        scratch.edit("client.js", |s| {
            s.replace("  //@@LU_CAVEMAN@@", "  //@@LU_CAVEMAN@@\n  //@@LU_CAVEMAN@@")
        });
        let err = assemble(scratch.path()).expect_err("a duplicated marker assembled anyway");
        assert!(err.contains("appears 2 times"), "{err}");
    }

    #[test]
    fn an_unterminated_tooling_block_stops_the_build() {
        // personas.js carries exactly one block, so dropping its end marker
        // leaves the file genuinely unterminated. agent-core.js has two, and
        // dropping the first one there produces the nesting error instead —
        // also refused, but a different sentence.
        let scratch = Scratch::new("unterminated");
        scratch.edit("personas.js", |s| s.replacen(TOOLING_END, "", 1));
        let err = assemble(scratch.path()).expect_err(
            "an unclosed tooling block assembled anyway — it would have eaten the rest of the file",
        );
        assert!(err.contains("never closed"), "{err}");
    }

    #[test]
    fn a_nested_tooling_block_stops_the_build() {
        let scratch = Scratch::new("nested");
        scratch.edit("agent-core.js", |s| s.replacen(TOOLING_END, "", 1));
        let err = assemble(scratch.path()).expect_err("a nested tooling block assembled anyway");
        assert!(err.contains("inside the block opened on line"), "{err}");
    }

    #[test]
    fn a_stray_end_marker_stops_the_build() {
        let scratch = Scratch::new("strayend");
        scratch.edit("caveman.js", |s| format!("{TOOLING_END}\n{s}"));
        let err = assemble(scratch.path()).expect_err("a stray end marker assembled anyway");
        assert!(err.contains("without a matching"), "{err}");
    }

    /// The tooling blocks are the whole reason the split is safe: they are
    /// what tsc, eslint and vitest read the module graph from. A file that
    /// lost its block still assembles — so only this says it is gone.
    #[test]
    fn every_javascript_source_declares_its_module_graph() {
        for name in SOURCES.iter().filter(|n| n.ends_with(".js")) {
            let raw = std::fs::read_to_string(client_dir().join(name)).unwrap();
            assert!(
                raw.contains(TOOLING_START) && raw.contains(TOOLING_END),
                "mobile-client/{name} has no {TOOLING_START} block, so nothing outside the \
                 assembled page can import from it and no test can reach its functions"
            );
        }
    }

    /// `strip_tooling_blocks` removes the block and nothing else — including
    /// the blank line the block does not own.
    #[test]
    fn stripping_a_tooling_block_leaves_the_rest_byte_for_byte() {
        let src = format!("a\nb\n{TOOLING_START}\nexport {{ a }}\n{TOOLING_END}\nc\n");
        assert_eq!(strip_tooling_blocks(&src, "t.js").unwrap(), "a\nb\nc");
    }
}
