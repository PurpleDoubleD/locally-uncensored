//! Repo-Map — Aider-style PageRank over the working-directory import graph.
//!
//! Walks the repo, parses imports per language (TS/JS/Rust/Python), builds
//! a directed graph (file → files it imports), runs PageRank, and returns
//! the top-N ranked files. The Codex/Agent loop fetches this once per turn
//! and injects the result into the system prompt so even an 8B local model
//! gets to "see" the relevant subset of a huge repo without us having to
//! page-feed every file.
//!
//! Architectural note: we deliberately keep the parser regex-based. A real
//! AST per language would be more accurate but adds ~10× build time and
//! ~50 deps for marginal precision — the imports we miss with regex are
//! the same ones a human reader would miss in a quick skim, which is the
//! scope this map serves anyway.
//!
//! Ported 1:1 from uselu's `apps/bridge/src/commands/repo_map.rs` — the
//! PageRank algorithm and per-language import regexes are battle-tested
//! upstream. Only the outermost `repo_map` function is wrapped in
//! `#[tauri::command]` for the desktop IPC bridge.

use crate::commands::{bad_request, internal, CmdResult};
use crate::state::AppState;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Deserialize)]
struct RepoMapArgs {
    #[serde(default, rename = "workingDirectory")]
    working_directory: Option<String>,
    /// Optional substring filter — only files whose normalized rel-path
    /// contains the query (case-insensitive) survive the post-rank filter.
    /// Empty / missing = return the global top-N by PageRank.
    #[serde(default)]
    query: Option<String>,
    /// Cap on how many entries to return. Defaults to 20 — enough to fit a
    /// useful slice of even a large repo into a system-prompt header
    /// without blowing the context window.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize)]
pub struct FileEntry {
    pub path: String,
    pub score: f64,
    pub snippet: String,
}

/// Directories that should never appear in the map. Hard-coded so the
/// command works without a `.gitignore` in the repo — we want to be
/// useful on freshly cloned repos and on subtrees too.
const IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    "out",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".idea",
    ".vscode",
    "coverage",
    "test-results",
    "playwright-report",
];

/// Source-file extensions we know how to parse imports from. Anything not
/// in this list still appears in the walk (so the map isn't blind to it),
/// but contributes only out-edges from neighbours that import it.
const SOURCE_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go",
];

/// Skip files larger than this for import parsing. Generated bundles,
/// lockfiles, and minified blobs blow the regex out without contributing
/// meaningful edges. Walking still includes them so they can be ranking
/// targets if something imports them — we just don't read them.
const MAX_PARSE_BYTES: u64 = 512 * 1024;

/// Upper bound on how many files the walk collects. The working directory is
/// whatever folder the user picked — pointing Code mode at a home directory
/// instead of a repo is an easy mistake, and without a bound the walk
/// enumerated the whole tree and then read and parsed every source file in it,
/// for a map that returns at most 200 entries. Same lock-up class the ComfyUI
/// detection had to bound (install.rs, 200k-file home dir).
const MAX_WALK_FILES: usize = 20_000;

// ── Import-parsing regexes ─────────────────────────────────────────

static RE_TS_FROM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)^\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]"#).unwrap()
});
static RE_TS_REQUIRE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"require\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap());
static RE_TS_DYNAMIC: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"import\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap());

static RE_RS_USE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*use\s+(crate|super|self)::([A-Za-z0-9_:]+)").unwrap());
static RE_RS_MOD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;").unwrap()
});

static RE_PY_FROM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*from\s+(\.+)?([A-Za-z_][A-Za-z0-9_.]*)\s+import").unwrap()
});
static RE_PY_IMPORT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)").unwrap());

// ── Walking ────────────────────────────────────────────────────────

/// Returns `true` if `name` is a directory we never want to descend into.
fn is_ignored_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name) || name.starts_with('.') && name != "." && name != ".."
}

/// Walks `root` and returns relative paths (POSIX-style, forward slashes)
/// for every regular file we can plausibly want to map, plus whether the walk
/// stopped at `MAX_WALK_FILES`. Symlinks are NOT followed — a link pointing at
/// a parent directory would otherwise walk forever. Hidden files outside
/// `.gitignore`-style heuristics are dropped — they're noise.
pub fn walk_repo(root: &Path) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 0 {
                return true; // root itself
            }
            !is_ignored_dir(&name)
        });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !rel.is_empty() {
                out.push(rel);
            }
        }
        if out.len() >= MAX_WALK_FILES {
            truncated = true;
            break;
        }
    }
    (out, truncated)
}

// ── Import resolution ──────────────────────────────────────────────

fn ext_of(path: &str) -> Option<&str> {
    Path::new(path).extension().and_then(|e| e.to_str())
}

/// Resolves a JS/TS specifier (`./foo`, `../bar/baz`, `@scope/pkg`) into
/// a concrete repo-relative path if one exists in `files`. Non-relative
/// specifiers (npm packages, bare names) return None — they're not in our
/// graph by design.
pub fn resolve_ts_import(
    specifier: &str,
    from: &str,
    files: &HashSet<String>,
) -> Option<String> {
    if !specifier.starts_with('.') {
        return None; // bare module — outside the repo graph
    }
    let from_dir = Path::new(from).parent().unwrap_or(Path::new(""));
    let joined = from_dir.join(specifier);
    let normalized = normalize_rel(&joined);
    // Try extensions, then `/index.*`.
    let candidates: Vec<String> = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .flat_map(|ext| {
            vec![
                format!("{}{}", normalized, ext),
                format!("{}/index{}", normalized, ext),
            ]
        })
        .collect();
    candidates.into_iter().find(|c| files.contains(c))
}

/// Normalizes `a/b/./c/../d` → `a/b/d`. Pure string work — we never touch
/// the filesystem here; `files` is the ground truth.
///
/// Splits on BOTH `/` and `\\` so Windows-host runs work — `Path::join`
/// uses `\\` on Windows, which would otherwise survive into the file-set
/// lookup and miss every match. The lookup set is always POSIX-style.
/// uselu's Linux-only test fixture never exposed this divergence.
pub fn normalize_rel(p: &Path) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in p.to_str().unwrap_or("").split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Maps a Rust `use crate::a::b::C` to the file `src/a/b.rs` or
/// `src/a/b/mod.rs` if either exists. `from` is the rust file emitting
/// the use — we use it to anchor `super::`/`self::` lookups.
fn resolve_rust_use(prefix: &str, path: &str, from: &str, files: &HashSet<String>) -> Option<String> {
    // Strip everything after the last `::` (that's the item, not the file).
    let segments: Vec<&str> = path.split("::").collect();
    if segments.is_empty() {
        return None;
    }
    let path_segs = &segments[..segments.len().saturating_sub(1)];
    if path_segs.is_empty() {
        return None;
    }

    let crate_root = guess_rust_crate_root(from);
    let base = match prefix {
        "crate" => crate_root.clone(),
        "self" => Path::new(from)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        "super" => Path::new(from)
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        _ => return None,
    };

    let joined = if base.is_empty() {
        path_segs.join("/")
    } else {
        format!("{}/{}", base, path_segs.join("/"))
    };
    [format!("{}.rs", joined), format!("{}/mod.rs", joined)]
        .into_iter()
        .find(|cand| files.contains(cand))
}

/// Heuristic: the crate root for a Rust file is the closest ancestor that
/// is itself named `lib.rs` or `main.rs`. We approximate by walking up
/// until we see `src/`.
fn guess_rust_crate_root(from: &str) -> String {
    let parts: Vec<&str> = from.split('/').collect();
    if let Some(idx) = parts.iter().position(|p| *p == "src") {
        return parts[..=idx].join("/");
    }
    String::new()
}

/// Resolves a Python `from .foo import bar` or `import foo.bar`. Relative
/// imports use the dot prefix to walk up directories; absolute imports
/// scan from any `src/` or package root in the tree.
fn resolve_python_import(
    dots: Option<&str>,
    module: &str,
    from: &str,
    files: &HashSet<String>,
) -> Option<String> {
    let module_path = module.replace('.', "/");
    let base = if let Some(dots) = dots {
        let levels = dots.len();
        let from_path = Path::new(from);
        let mut up = from_path.parent()?.to_path_buf();
        for _ in 1..levels {
            up = up.parent()?.to_path_buf();
        }
        up.to_string_lossy().to_string()
    } else {
        // Absolute import — try the root and any `src/` prefix
        String::new()
    };
    let joined = if base.is_empty() {
        module_path.clone()
    } else {
        format!("{}/{}", base, module_path)
    };
    [
        format!("{}.py", joined),
        format!("{}/__init__.py", joined),
        format!("src/{}.py", module_path),
    ]
    .into_iter()
    .find(|cand| files.contains(cand))
}

/// Extracts all repo-internal imports a file declares. Pure on top of
/// the textual content + the set of known files — never touches the FS.
pub fn parse_imports(file: &str, content: &str, files: &HashSet<String>) -> HashSet<String> {
    let mut out = HashSet::new();
    let ext = ext_of(file).unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            for re in [&*RE_TS_FROM, &*RE_TS_REQUIRE, &*RE_TS_DYNAMIC] {
                for cap in re.captures_iter(content) {
                    if let Some(m) = cap.get(1) {
                        if let Some(resolved) = resolve_ts_import(m.as_str(), file, files) {
                            out.insert(resolved);
                        }
                    }
                }
            }
        }
        "rs" => {
            for cap in RE_RS_USE.captures_iter(content) {
                if let (Some(prefix), Some(path)) = (cap.get(1), cap.get(2)) {
                    if let Some(resolved) =
                        resolve_rust_use(prefix.as_str(), path.as_str(), file, files)
                    {
                        out.insert(resolved);
                    }
                }
            }
            // `mod foo;` — declares a sibling module file
            let from_dir = Path::new(file).parent().unwrap_or(Path::new(""));
            for cap in RE_RS_MOD.captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    let stem = m.as_str();
                    let sibling = from_dir.join(format!("{}.rs", stem));
                    let modfile = from_dir.join(stem).join("mod.rs");
                    for p in [sibling, modfile] {
                        let s = p.to_string_lossy().replace('\\', "/");
                        if files.contains(&s) {
                            out.insert(s);
                        }
                    }
                }
            }
        }
        "py" => {
            for cap in RE_PY_FROM.captures_iter(content) {
                let dots = cap.get(1).map(|m| m.as_str());
                if let Some(module) = cap.get(2) {
                    if let Some(resolved) =
                        resolve_python_import(dots, module.as_str(), file, files)
                    {
                        out.insert(resolved);
                    }
                }
            }
            for cap in RE_PY_IMPORT.captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    if let Some(resolved) = resolve_python_import(None, m.as_str(), file, files)
                    {
                        out.insert(resolved);
                    }
                }
            }
        }
        _ => {}
    }
    out
}

// ── PageRank ───────────────────────────────────────────────────────

/// Standard PageRank — `d = 0.85`, 50 iterations or until L1 delta drops
/// below `epsilon`. Nodes with no outbound edges distribute their score
/// uniformly across all nodes (the "dangling" correction).
pub fn pagerank(graph: &HashMap<String, HashSet<String>>) -> HashMap<String, f64> {
    let n = graph.len();
    if n == 0 {
        return HashMap::new();
    }
    let d = 0.85;
    let eps = 1e-6;
    let base = 1.0 / n as f64;
    let mut score: HashMap<String, f64> =
        graph.keys().map(|k| (k.clone(), base)).collect();

    // Inbound adjacency for fast neighbour lookup during iteration.
    let mut inbound: HashMap<&str, Vec<&str>> = HashMap::new();
    for (src, dsts) in graph {
        for dst in dsts {
            inbound.entry(dst.as_str()).or_default().push(src.as_str());
        }
    }

    for _ in 0..50 {
        // Dangling mass: nodes with zero out-edges distribute uniformly.
        let dangling: f64 = graph
            .iter()
            .filter(|(_, out)| out.is_empty())
            .map(|(k, _)| score[k])
            .sum();
        let mut next: HashMap<String, f64> = HashMap::with_capacity(n);
        let mut delta = 0.0_f64;
        for node in graph.keys() {
            let mut sum_inbound = 0.0;
            if let Some(preds) = inbound.get(node.as_str()) {
                for p in preds {
                    let out_count = graph.get(*p).map(|s| s.len()).unwrap_or(0);
                    if out_count > 0 {
                        sum_inbound += score[*p] / out_count as f64;
                    }
                }
            }
            let new = (1.0 - d) / n as f64 + d * (sum_inbound + dangling / n as f64);
            delta += (score[node] - new).abs();
            next.insert(node.clone(), new);
        }
        score = next;
        if delta < eps {
            break;
        }
    }
    score
}

// ── Snippet extraction ─────────────────────────────────────────────

/// Returns a 1–2 line description of a file: the first non-empty line(s)
/// that look like a comment or docstring, otherwise the first non-empty
/// line of code. Bounded to 160 chars so the JSON payload stays tight.
fn extract_snippet(content: &str) -> String {
    let mut taken = String::new();
    for line in content.lines().take(40) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Doc-comments / `//!` / `///` / `#` / `"""`
        if trimmed.starts_with("//")
            || trimmed.starts_with("#")
            || trimmed.starts_with("/*")
            || trimmed.starts_with("*")
            || trimmed.starts_with("\"\"\"")
        {
            taken.push_str(trimmed);
            taken.push(' ');
            if taken.len() > 120 {
                break;
            }
        } else if taken.is_empty() {
            taken = trimmed.to_string();
            break;
        } else {
            break;
        }
    }
    if taken.len() > 160 {
        let mut cut = 160;
        while !taken.is_char_boundary(cut) && cut > 0 {
            cut -= 1;
        }
        taken.truncate(cut);
        taken.push('…');
    }
    taken.trim().to_string()
}

// ── Public entry — pure (no &AppState) for tests ───────────────────

/// Builds the repo map for `root`. Returns top-N ranked files filtered by
/// optional `query`. Pure on the filesystem at `root` — no global state.
pub fn build_repo_map(root: &Path, query: Option<&str>, limit: usize) -> (Vec<FileEntry>, bool) {
    let (files, truncated) = walk_repo(root);
    let file_set: HashSet<String> = files.iter().cloned().collect();

    // Build edges. Skip non-source files for parsing, but they still
    // count as nodes — anything that imports them lifts their score.
    let mut graph: HashMap<String, HashSet<String>> = HashMap::new();
    for f in &files {
        graph.insert(f.clone(), HashSet::new());
    }
    for f in &files {
        let ext = match ext_of(f) {
            Some(e) => e,
            None => continue,
        };
        if !SOURCE_EXTS.contains(&ext) {
            continue;
        }
        let full = root.join(f);
        let meta = match fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_PARSE_BYTES {
            continue;
        }
        let content = match fs::read_to_string(&full) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let edges = parse_imports(f, &content, &file_set);
        if let Some(slot) = graph.get_mut(f) {
            *slot = edges;
        }
    }

    let scores = pagerank(&graph);

    let mut entries: Vec<(String, f64)> = scores.into_iter().collect();
    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        let qlower = q.to_lowercase();
        entries.retain(|(p, _)| p.to_lowercase().contains(&qlower));
    }
    entries.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    entries.truncate(limit);

    let out = entries
        .into_iter()
        .map(|(path, score)| {
            let snippet = fs::read_to_string(root.join(&path))
                .ok()
                .as_deref()
                .map(extract_snippet)
                .unwrap_or_default();
            FileEntry {
                path,
                score,
                snippet,
            }
        })
        .collect();
    (out, truncated)
}

// ── Tauri command ─────────────────────────────────────────────────

async fn repo_map_impl(args: &Value) -> CmdResult {
    let a: RepoMapArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let root_str = a
        .working_directory
        .ok_or_else(|| bad_request("workingDirectory is required"))?;
    let root = PathBuf::from(&root_str);
    if !root.is_dir() {
        return Err(bad_request(format!(
            "workingDirectory is not a directory: {}",
            root.display()
        )));
    }
    let limit = a.limit.unwrap_or(20).clamp(1, 200);
    let (entries, truncated) = tokio::task::spawn_blocking(move || {
        build_repo_map(&root, a.query.as_deref(), limit)
    })
    .await
    .map_err(|e| internal(format!("repo_map task: {}", e)))?;

    Ok(json!({
        "files": entries.iter().map(|e| json!({
            "path": e.path,
            "score": e.score,
            "snippet": e.snippet,
        })).collect::<Vec<_>>(),
        "count": entries.len(),
        // Say it when the walk stopped early, so a map of a home directory
        // isn't mistaken for a complete picture of a project.
        "truncated": truncated,
        "note": if truncated {
            Some(format!(
                "Only the first {} files were scanned — this folder is far larger than a project. Point the working directory at the project root for a complete map.",
                MAX_WALK_FILES
            ))
        } else {
            None
        },
    }))
}

// Tauri command entry point — kept name-aligned with the frontend
// `backendCall('repo_map', …)` in `src/api/agents/repo-map.ts`. Earlier
// drafts used a `_cmd` suffix which produced a silent "command not
// found" at runtime because the frontend hadn't been wired up yet
// (codexRepoMapEnabled was a stub). When the flag is consumed in
// useCodex, the name has to match exactly.
#[tauri::command]
pub async fn repo_map(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    repo_map_impl(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    fn fixture(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().expect("tempdir");
        for (path, body) in files {
            let full = dir.path().join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&full, body).unwrap();
        }
        dir
    }

    #[test]
    fn walks_files_and_skips_ignored_dirs() {
        let dir = fixture(&[
            ("src/a.ts", "// a"),
            ("src/b.ts", "// b"),
            ("node_modules/junk.ts", "// junk"),
            (".git/HEAD", "ref: refs/heads/main"),
            ("target/debug/zz.rs", "// build artifact"),
            (".next/cache/x.bin", "x"),
        ]);
        let (mut files, truncated) = walk_repo(dir.path());
        assert!(!truncated, "a six-file fixture must not hit the walk cap");
        files.sort();
        assert!(files.contains(&"src/a.ts".to_string()));
        assert!(files.contains(&"src/b.ts".to_string()));
        for f in &files {
            assert!(
                !f.starts_with("node_modules/")
                    && !f.starts_with(".git/")
                    && !f.starts_with("target/")
                    && !f.starts_with(".next/"),
                "ignored dir leaked through: {}",
                f
            );
        }
    }

    #[test]
    fn the_walk_stops_at_the_cap_and_says_so() {
        // A folder that is not a project (a home directory) must not drag the
        // whole tree into a map that returns at most 200 entries.
        let files: Vec<(String, String)> = (0..(MAX_WALK_FILES + 50))
            .map(|i| (format!("f{}.txt", i), String::from("x")))
            .collect();
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let dir = fixture(&refs);
        let (walked, truncated) = walk_repo(dir.path());
        assert!(truncated, "cap was not reported");
        assert_eq!(walked.len(), MAX_WALK_FILES);
    }

    #[test]
    fn normalize_rel_collapses_dot_segments() {
        assert_eq!(normalize_rel(Path::new("a/b/./c")), "a/b/c");
        assert_eq!(normalize_rel(Path::new("a/b/../c")), "a/c");
        assert_eq!(normalize_rel(Path::new("./a")), "a");
    }

    #[test]
    fn ts_relative_imports_resolve_via_extension_or_index() {
        let files: HashSet<String> = ["src/a.ts", "src/util/index.ts", "src/foo/bar.tsx"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            resolve_ts_import("./util", "src/a.ts", &files).as_deref(),
            Some("src/util/index.ts")
        );
        assert_eq!(
            resolve_ts_import("./foo/bar", "src/a.ts", &files).as_deref(),
            Some("src/foo/bar.tsx")
        );
        // Bare modules — npm-style — do not resolve into the repo graph.
        assert_eq!(resolve_ts_import("react", "src/a.ts", &files), None);
    }

    #[test]
    fn parse_imports_extracts_ts_from_require_dynamic() {
        let files: HashSet<String> = ["a.ts", "b.ts", "c.ts", "d.ts"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let content = r#"
            import { x } from './b'
            const y = require('./c')
            const z = import('./d')
            import 'react'
        "#;
        let out = parse_imports("a.ts", content, &files);
        assert!(out.contains("b.ts"));
        assert!(out.contains("c.ts"));
        assert!(out.contains("d.ts"));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn parse_imports_handles_python_relative_and_absolute() {
        let files: HashSet<String> = ["pkg/a.py", "pkg/b.py", "pkg/sub/c.py"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let content = "from .b import thing\nimport pkg.sub.c\n";
        let out = parse_imports("pkg/a.py", content, &files);
        assert!(out.contains("pkg/b.py"));
        // Absolute `import pkg.sub.c` lands on pkg/sub/c.py.
        assert!(out.contains("pkg/sub/c.py"));
    }

    #[test]
    fn parse_imports_handles_rust_use_and_mod() {
        let files: HashSet<String> = [
            "apps/bridge/src/main.rs",
            "apps/bridge/src/commands/mod.rs",
            "apps/bridge/src/commands/repo_map.rs",
            "apps/bridge/src/commands/shell.rs",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let content = "use crate::commands::shell::ShellThing;\nmod repo_map;\n";
        let out = parse_imports("apps/bridge/src/commands/mod.rs", content, &files);
        assert!(out.contains("apps/bridge/src/commands/shell.rs"));
        assert!(out.contains("apps/bridge/src/commands/repo_map.rs"));
    }

    #[test]
    fn pagerank_ranks_a_hub_node_higher_than_its_callers() {
        // a, b, c all import hub. Hub has no out-edges. Hub must win.
        let mut g: HashMap<String, HashSet<String>> = HashMap::new();
        g.insert("hub.ts".into(), HashSet::new());
        g.insert("a.ts".into(), ["hub.ts".to_string()].into_iter().collect());
        g.insert("b.ts".into(), ["hub.ts".to_string()].into_iter().collect());
        g.insert("c.ts".into(), ["hub.ts".to_string()].into_iter().collect());
        let scores = pagerank(&g);
        let hub = scores["hub.ts"];
        for leaf in ["a.ts", "b.ts", "c.ts"] {
            assert!(
                hub > scores[leaf],
                "hub should outrank {}: hub={} leaf={}",
                leaf,
                hub,
                scores[leaf]
            );
        }
        // PageRank scores must sum to ~1.
        let total: f64 = scores.values().sum();
        assert!(
            (total - 1.0).abs() < 0.05,
            "scores should normalize near 1, got {}",
            total
        );
    }

    #[test]
    fn pagerank_handles_empty_graph() {
        let g: HashMap<String, HashSet<String>> = HashMap::new();
        let out = pagerank(&g);
        assert!(out.is_empty());
    }

    #[test]
    fn build_repo_map_ranks_a_hub_first_and_filters_by_query() {
        let dir = fixture(&[
            ("src/hub.ts", "export const k = 1\n"),
            ("src/a.ts", "import { k } from './hub'\n"),
            ("src/b.ts", "import { k } from './hub'\n"),
            ("src/unrelated/x.ts", "export const x = 0\n"),
        ]);
        // Global top — hub should be #1.
        let (global, _) = build_repo_map(dir.path(), None, 5);
        assert!(!global.is_empty());
        assert_eq!(global[0].path, "src/hub.ts");

        // Query filter — only files matching `unrelated` survive.
        let (filtered, _) = build_repo_map(dir.path(), Some("unrelated"), 5);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].path, "src/unrelated/x.ts");
    }

    #[test]
    fn snippets_prefer_leading_comments() {
        let s = extract_snippet("// hello there\n// second line\nfn x() {}\n");
        assert!(s.starts_with("// hello"));
        assert!(s.contains("second"));

        // Pure code — first non-empty line wins.
        let s2 = extract_snippet("\n\nexport function f() {}\n");
        assert_eq!(s2, "export function f() {}");

        // Empty file is safe.
        assert_eq!(extract_snippet(""), "");
    }

    #[test]
    fn limit_is_respected_and_capped() {
        let mut files = vec![];
        for i in 0..30 {
            files.push((Box::leak(format!("src/f{}.ts", i).into_boxed_str()) as &str, ""));
        }
        let dir = fixture(&files);
        let (out, _) = build_repo_map(dir.path(), None, 5);
        assert_eq!(out.len(), 5);
    }
}
