//! The folders the user told ComfyUI to use, read the way ComfyUI reads them.
//!
//! GH #183 (Windows 11): ComfyUI at `d:\ComfyUI\Comfy\ComfyUI`, a shared model
//! folder `d:\comfyui\model` set up for it, and every download, every LoRA LU
//! trained and every input and output still landed in the instance's own
//! `models`, `input` and `output` folders. LU knew one model folder per
//! install: `<ComfyUI>/models/<key>`, or whatever a RUNNING ComfyUI answered on
//! `/internal/folder_paths` (comfy_folders.rs). The second answer lists the
//! shared folder too, but behind the instance folder of the same name, and
//! nothing at all is known while ComfyUI is shut down, which is when the Model
//! Manager downloads most.
//!
//! ComfyUI's own sources, all read here as files:
//!   * `extra_model_paths.yaml` beside `main.py`. ComfyUI loads it on every
//!     start (`apply_custom_paths` in main.py, `load_extra_path_config` in
//!     utils/extra_config.py). Sections with an optional `base_path` and
//!     `is_default`, then one entry per folder key, several paths per key one
//!     per line. Relative `base_path` against the file's folder, relative
//!     entries against `base_path`.
//!   * The start script of a portable install (`run_nvidia_gpu.bat` and its
//!     siblings beside the instance), for `--extra-model-paths-config`,
//!     `--input-directory` and `--output-directory`. LU starts ComfyUI itself
//!     with `python main.py`, so those flags never reached a ComfyUI that LU
//!     started; `launch_args` hands them on now.
//!   * ComfyUI Desktop: `%APPDATA%\ComfyUI\extra_models_config.yaml` and the
//!     `basePath` in `%APPDATA%\ComfyUI\config.json`, when the ComfyUI folder
//!     LU uses is that install.
//!   * Comfy Desktop, the launcher with several installs side by side (GH
//!     #196 point 5): it starts an install with `--extra-model-paths-config
//!     %APPDATA%\Comfy Desktop\instance-model-paths\inst-*.yaml`, one file
//!     per install, listed in `installations.json` beside it. A ComfyUI that
//!     LU started saw none of that file's shared folders, so a model the
//!     launcher's ComfyUI listed was downloaded again. The file of the install
//!     LU uses is read and handed on like a start script's.
//!
//! The rule for a write target, per key: the entry marked `is_default` (the
//! last one loaded, because ComfyUI moves each to the front in turn), else the
//! first extra entry for that key, else nothing and the caller keeps its old
//! rule (the engine's answer, then `<ComfyUI>/models/<key>`). A file that is
//! missing, unreadable or broken YAML costs only itself: no entries from it,
//! the instance folders stay the answer.
//!
//! Not handed on: `--base-directory`. It moves `custom_nodes` along with the
//! models, and LU installs nodes into `<ComfyUI>/custom_nodes`; passing it on
//! would hide every node LU installed from the ComfyUI LU starts.

use std::path::{Path, PathBuf};

/// Larger than any real config or start script by far, small enough that a
/// stray multi-gigabyte file named like one is never read into memory.
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_SCRIPTS: usize = 24;

/// ComfyUI's `map_legacy` in folder_paths.py: two old key names that are
/// stored under the new ones.
pub(crate) fn map_legacy(key: &str) -> String {
    let k = key.trim().to_ascii_lowercase();
    match k.as_str() {
        "unet" => "diffusion_models".to_string(),
        "clip" => "text_encoders".to_string(),
        _ => k,
    }
}

/// A key that can name a folder: letters, digits, `_`, `-`. Everything else
/// (a key with a separator, `..`, an empty one) is not a ComfyUI folder key and
/// is never used to pick a write target.
fn plain_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// One path ComfyUI was told to scan for one key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigEntry {
    /// After `map_legacy`.
    pub key: String,
    pub path: PathBuf,
    pub is_default: bool,
    /// The file the entry came from, for the Settings line.
    pub source: PathBuf,
}

// ── paths as strings ─────────────────────────────────────────────────────────
//
// The paths come out of files written on Windows and the tests run on a Mac,
// so the joins and the normalisation work on both spellings instead of on the
// rules of the platform this build runs on.

fn windows_style(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with("\\\\") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || cfg!(windows)
}

/// The root of an absolute path and the rest, or `None` for a relative one.
fn split_root(s: &str) -> Option<(String, &str)> {
    let b = s.as_bytes();
    if s.starts_with("\\\\") || s.starts_with("//") {
        // \\server\share\rest
        let rest = &s[2..];
        let mut parts = rest.splitn(3, ['\\', '/']);
        let server = parts.next().filter(|p| !p.is_empty())?;
        let share = parts.next().filter(|p| !p.is_empty())?;
        let tail = parts.next().unwrap_or("");
        return Some((format!("\\\\{server}\\{share}"), tail));
    }
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return Some((s[..2].to_string(), &s[3..]));
    }
    if b.first() == Some(&b'/') {
        return Some((String::new(), &s[1..]));
    }
    None
}

pub(crate) fn is_absolute_any(s: &str) -> bool {
    split_root(s).is_some()
}

/// `os.path.normpath` for an absolute path: `.` and empty segments dropped,
/// `..` taken back. `None` when `..` climbs above the root.
fn normalize_abs(s: &str) -> Option<String> {
    let (root, rest) = split_root(s)?;
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(['\\', '/']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    let sep = if windows_style(s) { "\\" } else { "/" };
    Some(if root.is_empty() {
        format!("/{}", parts.join("/"))
    } else if parts.is_empty() {
        format!("{root}{sep}")
    } else {
        format!("{root}{sep}{}", parts.join(sep))
    })
}

/// `os.path.join` then `normpath`. An absolute `rel` replaces the base, as in
/// Python.
fn join_norm(base: &str, rel: &str) -> Option<String> {
    if is_absolute_any(rel) {
        return normalize_abs(rel);
    }
    let sep = if windows_style(base) { '\\' } else { '/' };
    normalize_abs(&format!("{}{}{}", base.trim_end_matches(['\\', '/']), sep, rel))
}

/// Segments of a normalised absolute path, compared without case on Windows.
fn segments(s: &str) -> Vec<String> {
    let win = windows_style(s);
    let (root, rest) = split_root(s).unwrap_or((String::new(), s));
    let mut out = vec![if win { root.to_ascii_lowercase() } else { root }];
    for seg in rest.split(['\\', '/']).filter(|p| !p.is_empty()) {
        out.push(if win { seg.to_ascii_lowercase() } else { seg.to_string() });
    }
    out
}

/// Is `inner` the folder `outer` or below it? Both normalised.
fn is_within(inner: &str, outer: &str) -> bool {
    let i = segments(inner);
    let o = segments(outer);
    i.len() >= o.len() && i[..o.len()] == o[..]
}

/// A drive or share root, or `/`. Never a write target: a model file in `D:\`
/// is a file no ComfyUI key will ever list.
fn is_root(s: &str) -> bool {
    match split_root(s) {
        Some((_, rest)) => rest.split(['\\', '/']).all(|p| p.is_empty()),
        None => false,
    }
}

/// `os.path.expandvars(os.path.expanduser(...))`, the part of it a config
/// actually uses: `~`, `%VAR%`, `$VAR`, `${VAR}`. An unknown variable stays as
/// written, as in Python.
fn expand(s: &str, home: Option<&str>, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut s = s.to_string();
    if let Some(h) = home {
        if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
            s = format!("{}{}", h.trim_end_matches(['\\', '/']), &s[1..]);
        }
    }
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '%' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '%') {
                let name: String = chars[i + 1..i + 1 + end].iter().collect();
                if !name.is_empty() {
                    if let Some(v) = env(&name) {
                        out.push_str(&v);
                        i += end + 2;
                        continue;
                    }
                }
            }
        } else if c == '$' {
            let (name, used) = if chars.get(i + 1) == Some(&'{') {
                match chars[i + 2..].iter().position(|&x| x == '}') {
                    Some(end) => (chars[i + 2..i + 2 + end].iter().collect::<String>(), end + 3),
                    None => (String::new(), 0),
                }
            } else {
                let n: String = chars[i + 1..]
                    .iter()
                    .take_while(|x| x.is_ascii_alphanumeric() || **x == '_')
                    .collect();
                let len = n.chars().count();
                (n, len + 1)
            };
            if !name.is_empty() {
                if let Some(v) = env(&name) {
                    out.push_str(&v);
                    i += used;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Python truthiness, because ComfyUI tests `is_default` with a bare `if`.
fn truthy(v: &serde_yaml::Value) -> bool {
    use serde_yaml::Value;
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Sequence(s) => !s.is_empty(),
        Value::Mapping(m) => !m.is_empty(),
        Value::Tagged(t) => truthy(&t.value),
    }
}

/// One `extra_model_paths.yaml`, in ComfyUI's order. `yaml_dir` is the
/// folder the file sits in, absolute.
///
/// Stricter than ComfyUI in one place on purpose: a RELATIVE entry must stay
/// inside its `base_path` (or the file's folder when there is none). ComfyUI
/// would follow `loras: ../../../Windows` too; LU writes files into these
/// folders and does not follow an entry out of the tree it was written for.
/// An absolute entry is the user's explicit choice and is taken as written,
/// except a bare drive root.
pub(crate) fn parse_extra_model_paths(
    text: &str,
    yaml_dir: &str,
    source: &Path,
    home: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<ConfigEntry>, String> {
    let doc: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| format!("not readable YAML: {e}"))?;
    let Some(sections) = doc.as_mapping() else {
        // An empty file is `null`, which ComfyUI would trip over; nothing to
        // take from it either way.
        return Ok(Vec::new());
    };
    let yaml_dir = normalize_abs(yaml_dir).ok_or("the config folder is not an absolute path")?;
    let mut out = Vec::new();
    for (_, conf) in sections {
        let Some(conf) = conf.as_mapping() else { continue };
        let mut base: Option<String> = None;
        let mut is_default = false;
        if let Some(b) = conf.get("base_path").and_then(|v| v.as_str()) {
            let b = expand(b.trim(), home, env);
            // `"D:\bad"` is valid YAML with a backspace in it. No folder.
            if b.chars().any(|c| c.is_control()) {
                continue;
            }
            base = if is_absolute_any(&b) { normalize_abs(&b) } else { join_norm(&yaml_dir, &b) };
            if base.is_none() {
                continue;
            }
        }
        if let Some(v) = conf.get("is_default") {
            is_default = truthy(v);
        }
        let anchor = base.clone().unwrap_or_else(|| yaml_dir.clone());
        for (k, v) in conf {
            let Some(k) = k.as_str() else { continue };
            if k == "base_path" || k == "is_default" {
                continue;
            }
            let key = map_legacy(k);
            if !plain_key(&key) {
                continue;
            }
            let Some(list) = v.as_str() else { continue };
            for line in list.split('\n') {
                let line = line.trim();
                if line.is_empty() || line.chars().any(|c| c.is_control()) {
                    continue;
                }
                let full = if is_absolute_any(line) {
                    match normalize_abs(line) {
                        Some(p) => p,
                        None => continue,
                    }
                } else {
                    match join_norm(&anchor, line) {
                        Some(p) if is_within(&p, &anchor) => p,
                        _ => continue,
                    }
                };
                if is_root(&full) {
                    continue;
                }
                out.push(ConfigEntry {
                    key: key.clone(),
                    path: PathBuf::from(full),
                    is_default,
                    source: source.to_path_buf(),
                });
            }
        }
    }
    Ok(out)
}

// ── start scripts ────────────────────────────────────────────────────────────

/// The three flags of one start script that LU hands on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ScriptArgs {
    pub extra_configs: Vec<String>,
    pub input_dir: Option<String>,
    pub output_dir: Option<String>,
}

/// cmd.exe style words: whitespace separated, double quotes group.
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The ComfyUI flags of a `.bat` that starts `main.py`, `None` when it does
/// not. `script_dir` is the script's folder: what a double click runs it in,
/// so a relative value is relative to that, and what `%~dp0` stands for.
pub(crate) fn parse_start_script(
    text: &str,
    script_dir: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<ScriptArgs> {
    // `^` at the end of a line continues it.
    let joined = text.replace("^\r\n", " ").replace("^\n", " ");
    let dir_with_sep = format!("{}\\", script_dir.trim_end_matches(['\\', '/']));
    let resolve = |raw: &str| -> Option<String> {
        let v = raw.replace("%~dp0", &dir_with_sep);
        let v = expand(&v, None, env);
        if v.contains('%') || v.chars().any(|c| c.is_control()) {
            return None;
        }
        let p = if is_absolute_any(&v) { normalize_abs(&v)? } else { join_norm(script_dir, &v)? };
        if is_root(&p) { None } else { Some(p) }
    };
    let mut found: Option<ScriptArgs> = None;
    for line in joined.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("rem ") || lower.starts_with("::") || lower.starts_with("echo ") {
            continue;
        }
        let w = words(t);
        let Some(at) = w.iter().position(|x| {
            x.rsplit(['\\', '/']).next().map(|s| s.eq_ignore_ascii_case("main.py")).unwrap_or(false)
        }) else {
            continue;
        };
        let mut args = ScriptArgs::default();
        let mut i = at + 1;
        while i < w.len() {
            let (flag, inline) = match w[i].split_once('=') {
                Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
                _ => (w[i].clone(), None),
            };
            let mut values: Vec<String> = Vec::new();
            match inline {
                Some(v) => {
                    values.push(v);
                    i += 1;
                }
                None => {
                    i += 1;
                    while i < w.len() && !w[i].starts_with("--") {
                        values.push(w[i].clone());
                        i += 1;
                        // Only the paths flag takes several values.
                        if flag != "--extra-model-paths-config" {
                            break;
                        }
                    }
                }
            }
            match flag.as_str() {
                "--extra-model-paths-config" => {
                    args.extra_configs.extend(values.iter().filter_map(|v| resolve(v)));
                }
                "--input-directory" => args.input_dir = values.first().and_then(|v| resolve(v)),
                "--output-directory" => args.output_dir = values.first().and_then(|v| resolve(v)),
                _ => {}
            }
        }
        // The last line that starts ComfyUI is the one the script ends up
        // running.
        found = Some(args);
    }
    found
}

/// Several scripts, one answer: a flag counts when every script that sets it
/// sets it to the same value. A portable install ships `run_cpu.bat` and
/// `run_nvidia_gpu.bat`, and the user edits the one they use; the other one
/// staying silent is no disagreement. Two different values are, and LU then
/// guesses neither.
pub(crate) fn agree(scripts: &[ScriptArgs]) -> (ScriptArgs, Vec<&'static str>) {
    fn one<T: Clone + PartialEq>(vals: Vec<T>) -> Result<Option<T>, ()> {
        let mut it = vals.into_iter();
        let Some(first) = it.next() else { return Ok(None) };
        if it.all(|v| v == first) { Ok(Some(first)) } else { Err(()) }
    }
    let mut notes = Vec::new();
    let mut out = ScriptArgs::default();
    match one(scripts.iter().filter(|s| !s.extra_configs.is_empty()).map(|s| s.extra_configs.clone()).collect()) {
        Ok(v) => out.extra_configs = v.unwrap_or_default(),
        Err(()) => notes.push("--extra-model-paths-config"),
    }
    match one(scripts.iter().filter_map(|s| s.input_dir.clone()).collect()) {
        Ok(v) => out.input_dir = v,
        Err(()) => notes.push("--input-directory"),
    }
    match one(scripts.iter().filter_map(|s| s.output_dir.clone()).collect()) {
        Ok(v) => out.output_dir = v,
        Err(()) => notes.push("--output-directory"),
    }
    (out, notes)
}

// ── putting it together ──────────────────────────────────────────────────────

/// Where the files come from. A struct so a test can point every lookup at a
/// temp folder instead of the machine's real `%APPDATA%`.
/// Looks up one environment variable.
pub(crate) type VarLookup = Box<dyn Fn(&str) -> Option<String>>;

pub(crate) struct Env {
    pub home: Option<String>,
    pub appdata: Option<PathBuf>,
    pub localappdata: Option<PathBuf>,
    pub var: VarLookup,
}

impl Env {
    pub(crate) fn real() -> Self {
        Env {
            home: dirs::home_dir().map(|h| h.to_string_lossy().to_string()),
            appdata: std::env::var_os("APPDATA").map(PathBuf::from),
            localappdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            var: Box::new(|k| std::env::var(k).ok()),
        }
    }
}

/// What the user set up for one ComfyUI folder.
#[derive(Clone, Debug, Default)]
pub struct UserComfyPaths {
    entries: Vec<ConfigEntry>,
    /// From the start script (or the Desktop app), already normalised.
    pub input_dir: Option<PathBuf>,
    pub output_dir: Option<PathBuf>,
    /// Config files named by the start script, for `launch_args`.
    pub script_configs: Vec<PathBuf>,
    /// Every file that was read with something in it, for the Settings line.
    pub sources: Vec<PathBuf>,
    /// Files that were there and could not be used, with the reason.
    pub problems: Vec<String>,
}

fn read_small(path: &Path) -> Option<Result<String, String>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() > MAX_CONFIG_BYTES {
        return Some(Err("too large to be a config".to_string()));
    }
    Some(std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| crate::os_error::english(&e)))
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (normalize_abs(&a.to_string_lossy()), normalize_abs(&b.to_string_lossy())) {
        (Some(x), Some(y)) => segments(&x) == segments(&y),
        _ => false,
    }
}

impl UserComfyPaths {
    /// Everything for the ComfyUI in `comfy_dir` (the folder with `main.py`).
    /// Never fails: a file that cannot be used is noted and skipped.
    pub fn discover(comfy_dir: &Path) -> Self {
        let mut me = Self::discover_with(comfy_dir, &Env::real());
        me.take_lu_storage(&crate::commands::storage::lu_choice(), &crate::os_paths::app_config_json());
        me
    }

    /// Settings → Storage (commands/storage.rs): the folders chosen in LU come
    /// last and win, because they are the newest explicit choice. ComfyUI
    /// downloads go below the model folder, in the layout that is there, and
    /// the gallery is ComfyUI's output folder. What the user configured for
    /// ComfyUI itself stays in the lists, so a file there is still found and
    /// still deleted from where it is.
    pub(crate) fn take_lu_storage(&mut self, choice: &crate::commands::storage::LuChoice, source: &Path) {
        if let Some(root) = &choice.downloads_root {
            for key in crate::commands::custom_models::COMFY_MODEL_FOLDERS {
                let dir = crate::commands::storage::comfy_dir_below(root, key);
                // The two old key names only for a folder that is there:
                // they map onto the new names and would shadow them.
                if (*key == "clip" || *key == "unet") && !dir.is_dir() {
                    continue;
                }
                self.entries.push(ConfigEntry { key: map_legacy(key), path: dir, is_default: true, source: source.to_path_buf() });
            }
            if !self.sources.iter().any(|s| s == source) {
                self.sources.push(source.to_path_buf());
            }
        }
        if let Some(gallery) = &choice.gallery {
            self.output_dir = Some(gallery.clone());
        }
    }

    pub(crate) fn discover_with(comfy_dir: &Path, env: &Env) -> Self {
        let mut me = UserComfyPaths::default();
        let comfy_str = comfy_dir.to_string_lossy().to_string();
        if !is_absolute_any(&comfy_str) {
            return me;
        }

        // 1. The file ComfyUI loads on its own.
        me.load_yaml(&comfy_dir.join("extra_model_paths.yaml"), env);

        // 2. The start scripts of a portable install: beside the instance
        //    folder (`ComfyUI_windows_portable\run_nvidia_gpu.bat`) and in it.
        let mut scripts: Vec<ScriptArgs> = Vec::new();
        let mut dirs: Vec<PathBuf> = vec![comfy_dir.to_path_buf()];
        if let Some(parent) = comfy_dir.parent() {
            dirs.insert(0, parent.to_path_buf());
        }
        let mut seen = 0usize;
        for dir in &dirs {
            let Ok(list) = std::fs::read_dir(dir) else { continue };
            let mut bats: Vec<PathBuf> = list
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("bat")).unwrap_or(false))
                .collect();
            bats.sort();
            for bat in bats {
                if seen >= MAX_SCRIPTS {
                    break;
                }
                seen += 1;
                let Some(Ok(text)) = read_small(&bat) else { continue };
                if let Some(args) = parse_start_script(&text, &dir.to_string_lossy(), &*env.var) {
                    scripts.push(args);
                }
            }
        }
        let (args, disagree) = agree(&scripts);
        for flag in disagree {
            me.problems.push(format!("The start scripts beside ComfyUI disagree on {flag}, so LU uses neither value."));
        }
        for cfg in &args.extra_configs {
            let p = PathBuf::from(cfg);
            if same_path(&p, &comfy_dir.join("extra_model_paths.yaml")) {
                continue;
            }
            if me.load_yaml(&p, env) {
                me.script_configs.push(p);
            }
        }
        me.input_dir = args.input_dir.map(PathBuf::from);
        me.output_dir = args.output_dir.map(PathBuf::from);

        // 3. ComfyUI Desktop, when this folder is that install.
        if let Some(appdata) = &env.appdata {
            let desktop = appdata.join("ComfyUI");
            let base = read_small(&desktop.join("config.json"))
                .and_then(|r| r.ok())
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("basePath").and_then(|b| b.as_str()).map(|s| s.to_string()))
                .filter(|b| is_absolute_any(b));
            let resources = env.localappdata.as_ref().map(|l| l.join("Programs").join("ComfyUI"));
            let is_desktop = base.as_deref().map(|b| same_path(comfy_dir, Path::new(b))).unwrap_or(false)
                || resources
                    .as_ref()
                    .and_then(|r| normalize_abs(&r.to_string_lossy()))
                    .zip(normalize_abs(&comfy_str))
                    .map(|(r, c)| is_within(&c, &r))
                    .unwrap_or(false);
            if is_desktop {
                me.load_yaml(&desktop.join("extra_models_config.yaml"), env);
                if let Some(b) = base.and_then(|b| normalize_abs(&b)) {
                    if me.input_dir.is_none() {
                        me.input_dir = join_norm(&b, "input").map(PathBuf::from);
                    }
                    if me.output_dir.is_none() {
                        me.output_dir = join_norm(&b, "output").map(PathBuf::from);
                    }
                }
            }
        }

        // 4. Comfy Desktop, the launcher: the model-paths file of this install.
        if let Some(appdata) = &env.appdata {
            let launcher = appdata.join("Comfy Desktop");
            let installs_root = env.localappdata.as_ref().map(|l| l.join("Comfy-Desktop").join("ComfyUI-Installs"));
            match comfy_desktop_instance_yaml(&launcher, installs_root.as_deref(), comfy_dir) {
                Ok(Some(yaml)) => {
                    if !me.script_configs.iter().any(|c| same_path(c, &yaml)) && me.load_yaml(&yaml, env) {
                        me.script_configs.push(yaml);
                    }
                }
                Ok(None) => {}
                Err(note) => me.problems.push(note),
            }
        }
        me
    }

    /// Read one config into `entries`. True when the file was there and read.
    fn load_yaml(&mut self, path: &Path, env: &Env) -> bool {
        let Some(read) = read_small(path) else { return false };
        let name = path.display().to_string();
        let text = match read {
            Ok(t) => t,
            Err(e) => {
                self.problems.push(format!("{name}: {e}"));
                return false;
            }
        };
        let dir = path.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        match parse_extra_model_paths(&text, &dir, path, env.home.as_deref(), &*env.var) {
            Ok(list) => {
                self.entries.extend(list);
                self.sources.push(path.to_path_buf());
                true
            }
            Err(e) => {
                self.problems.push(format!("{name}: {e}"));
                false
            }
        }
    }

    #[cfg(test)]
    pub fn entries(&self) -> &[ConfigEntry] {
        &self.entries
    }

    /// Every configured folder for `key`, in ComfyUI's scan order: each
    /// `is_default` entry moved to the front as it loads, the rest appended.
    pub fn dirs_for(&self, key: &str) -> Vec<PathBuf> {
        let key = map_legacy(key);
        let mut out: Vec<PathBuf> = Vec::new();
        for e in self.entries.iter().filter(|e| e.key == key) {
            if let Some(at) = out.iter().position(|p| same_path(p, &e.path)) {
                if e.is_default {
                    let p = out.remove(at);
                    out.insert(0, p);
                }
                continue;
            }
            if e.is_default {
                out.insert(0, e.path.clone());
            } else {
                out.push(e.path.clone());
            }
        }
        out
    }

    /// The configured folder a new file of `key` goes into, with the file it
    /// was configured in. `None` when the user configured nothing for the key
    /// (the caller keeps its own rule then).
    pub fn preferred(&self, key: &str) -> Option<(PathBuf, PathBuf)> {
        let key = map_legacy(key);
        let first = self.dirs_for(&key).into_iter().next()?;
        let src = self
            .entries
            .iter()
            .filter(|e| e.key == key && same_path(&e.path, &first))
            .map(|e| e.source.clone())
            .next_back()?;
        Some((first, src))
    }

    /// `preferred`, and only when the folder can be written into here: it is
    /// there, or the folder it would be created in is. A shared drive that is
    /// unplugged must not turn into an error in front of a download; the
    /// instance folder is the answer then, as it always was.
    pub fn write_dir(&self, key: &str) -> Option<PathBuf> {
        let (dir, _) = self.preferred(key)?;
        if dir.is_dir() || dir.parent().map(|p| p.is_dir()).unwrap_or(false) {
            Some(dir)
        } else {
            None
        }
    }

    /// Every folder named anywhere, for the delete and the existence checks.
    pub fn all_dirs(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for e in &self.entries {
            if !out.iter().any(|p| same_path(p, &e.path)) {
                out.push(e.path.clone());
            }
        }
        out
    }

    /// The flags for a ComfyUI that LU starts, so it scans and writes where the
    /// user's own start script would have. Only what exists on disk: a stale
    /// script line must not keep ComfyUI from starting.
    pub fn launch_args(&self) -> Vec<String> {
        let mut out = Vec::new();
        for c in &self.script_configs {
            if c.is_file() {
                out.push("--extra-model-paths-config".to_string());
                out.push(c.to_string_lossy().to_string());
            }
        }
        if let Some(d) = self.input_dir.as_ref().filter(|d| d.is_dir()) {
            out.push("--input-directory".to_string());
            out.push(d.to_string_lossy().to_string());
        }
        if let Some(d) = self.output_dir.as_ref().filter(|d| d.is_dir()) {
            out.push("--output-directory".to_string());
            out.push(d.to_string_lossy().to_string());
        }
        out
    }

    /// The output folder of this ComfyUI.
    pub fn output_dir_or(&self, comfy_dir: &Path) -> PathBuf {
        self.output_dir.clone().unwrap_or_else(|| comfy_dir.join("output"))
    }

    pub fn input_dir_or(&self, comfy_dir: &Path) -> PathBuf {
        self.input_dir.clone().unwrap_or_else(|| comfy_dir.join("input"))
    }
}

/// The `instance-model-paths` file Comfy Desktop starts the install in
/// `comfy_dir` with, or `Ok(None)` when this ComfyUI is no install of it.
///
/// `installations.json` is the launcher's own file and its layout is not
/// documented, so it is read for what it must contain without naming keys: a
/// path that holds `comfy_dir` (the install folder or the ComfyUI in it) and,
/// in the same entry, a string that names one of the files in
/// `instance-model-paths` (`inst-abc.yaml` for `inst-abc` or `abc`). The
/// smallest entry that has both decides, so a list of installs never hands
/// one install another's folders. Without `installations.json`, an install
/// under `ComfyUI-Installs` with exactly one such file takes that file.
/// Anything that does not settle on one file is a note, never a guess.
fn comfy_desktop_instance_yaml(launcher: &Path, installs_root: Option<&Path>, comfy_dir: &Path) -> Result<Option<PathBuf>, String> {
    let dir = launcher.join("instance-model-paths");
    let Ok(list) = std::fs::read_dir(&dir) else { return Ok(None) };
    let mut stems: Vec<(String, PathBuf)> = list
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map(|x| x.eq_ignore_ascii_case("yaml") || x.eq_ignore_ascii_case("yml")).unwrap_or(false))
        .filter_map(|p| p.file_stem().map(|s| (s.to_string_lossy().to_string(), p.clone())))
        .collect();
    stems.sort();
    if stems.is_empty() {
        return Ok(None);
    }
    let Some(comfy) = normalize_abs(&comfy_dir.to_string_lossy()) else { return Ok(None) };
    let names = |s: &str| -> Option<usize> {
        stems.iter().position(|(stem, _)| stem.eq_ignore_ascii_case(s) || stem.eq_ignore_ascii_case(&format!("inst-{s}")))
    };
    let holds_comfy = |s: &str| -> bool {
        is_absolute_any(s) && !is_root(s) && normalize_abs(s).map(|n| is_within(&comfy, &n)).unwrap_or(false)
    };

    let listed = launcher.join("installations.json");
    if let Some(read) = read_small(&listed) {
        let raw = read.map_err(|e| format!("{}: {e}", listed.display()))?;
        let json: serde_json::Value = serde_json::from_str(&raw).map_err(|_| format!("{}: not readable as JSON, its model folders are not used.", listed.display()))?;
        // (holds this ComfyUI, the files named below, the files of the
        // smallest entry that has both)
        fn walk(v: &serde_json::Value, holds: &dyn Fn(&str) -> bool, names: &dyn Fn(&str) -> Option<usize>) -> (bool, Vec<usize>, Option<Vec<usize>>) {
            match v {
                serde_json::Value::String(s) => (holds(s), names(s).into_iter().collect(), None),
                serde_json::Value::Array(a) => fold(a.iter(), holds, names),
                serde_json::Value::Object(o) => fold(o.values(), holds, names),
                _ => (false, Vec::new(), None),
            }
        }
        fn fold<'a>(items: impl Iterator<Item = &'a serde_json::Value>, holds: &dyn Fn(&str) -> bool, names: &dyn Fn(&str) -> Option<usize>) -> (bool, Vec<usize>, Option<Vec<usize>>) {
            let (mut hit, mut ids, mut found) = (false, Vec::new(), None);
            for item in items {
                let (h, i, f) = walk(item, holds, names);
                hit |= h;
                for x in i {
                    if !ids.contains(&x) {
                        ids.push(x);
                    }
                }
                if found.is_none() {
                    found = f;
                }
            }
            if found.is_none() && hit && !ids.is_empty() {
                found = Some(ids.clone());
            }
            (hit, ids, found)
        }
        let (hit, _, found) = walk(&json, &holds_comfy, &names);
        return match found {
            Some(ids) if ids.len() == 1 => Ok(Some(stems[ids[0]].1.clone())),
            Some(_) => Err(format!("{}: this ComfyUI matches several Comfy Desktop installs, so LU uses none of their model folders.", listed.display())),
            None if hit && stems.len() == 1 => Ok(Some(stems[0].1.clone())),
            None if hit => Err(format!("{}: this ComfyUI is listed, but LU cannot tell which file in {} is its own.", listed.display(), dir.display())),
            None => Ok(None),
        };
    }
    let under_installs = installs_root
        .and_then(|r| normalize_abs(&r.to_string_lossy()))
        .map(|r| is_within(&comfy, &r))
        .unwrap_or(false);
    Ok(if under_installs && stems.len() == 1 { Some(stems[0].1.clone()) } else { None })
}

/// The configured folders for the ComfyUI LU uses right now, or nothing.
pub fn for_comfy(comfy_path: &Option<String>) -> UserComfyPaths {
    match comfy_path {
        Some(p) if !p.trim().is_empty() => UserComfyPaths::discover(Path::new(p.trim())),
        _ => UserComfyPaths::default(),
    }
}

/// The keys the Settings panel names, in the order it names them.
const SHOWN_KEYS: &[&str] = &["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "upscale_models"];

/// For Settings → ComfyUI: which folder LU writes into per kind of model, and
/// why. Answers `{shown: false}` where there is nothing to show (no ComfyUI
/// folder, a ComfyUI on another machine, the Mac).
#[tauri::command]
pub async fn comfy_folder_targets(state: tauri::State<'_, crate::state::AppState>) -> Result<serde_json::Value, String> {
    if !crate::commands::process::comfy_supported_here() || crate::commands::download::remote_comfy(&state).is_some() {
        return Ok(serde_json::json!({ "shown": false }));
    }
    let comfy_path = state.comfy_path.lock().map(|p| p.clone()).unwrap_or(None);
    let Some(comfy) = comfy_path.clone().filter(|p| !p.trim().is_empty()) else {
        return Ok(serde_json::json!({ "shown": false }));
    };
    let engine = crate::commands::download::engine_folders(&state).await;
    tauri::async_runtime::spawn_blocking(move || {
        let user = for_comfy(&comfy_path);
        let comfy_dir = PathBuf::from(comfy.trim());
        Ok(targets_json(&user, engine.as_ref(), &comfy_dir))
    })
    .await
    .map_err(|e| format!("comfy_folder_targets task: {e}"))?
}

pub(crate) fn targets_json(
    user: &UserComfyPaths,
    engine: Option<&crate::commands::comfy_folders::ComfyFolders>,
    comfy_dir: &Path,
) -> serde_json::Value {
    let mut rows = Vec::new();
    for key in SHOWN_KEYS {
        let (dir, source) = if let Some(d) = user.write_dir(key) {
            let src = user.preferred(key).map(|(_, s)| s.display().to_string()).unwrap_or_default();
            (d, src)
        } else if let Some(d) = engine.and_then(|f| f.dir_for(key)) {
            (d, "running ComfyUI".to_string())
        } else {
            (comfy_dir.join("models").join(key), "ComfyUI folder".to_string())
        };
        rows.push(serde_json::json!({ "key": key, "dir": dir.to_string_lossy(), "source": source }));
    }
    serde_json::json!({
        "shown": true,
        "models": rows,
        "input": user.input_dir_or(comfy_dir).to_string_lossy(),
        "output": user.output_dir_or(comfy_dir).to_string_lossy(),
        "sources": user.sources.iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "problems": user.problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn parse(text: &str, dir: &str) -> Vec<ConfigEntry> {
        parse_extra_model_paths(text, dir, Path::new("cfg.yaml"), None, &no_env).unwrap()
    }

    fn keyed(list: &[ConfigEntry], key: &str) -> Vec<String> {
        list.iter().filter(|e| e.key == key).map(|e| e.path.to_string_lossy().to_string()).collect()
    }

    /// The reporter's layout: instance in `d:\ComfyUI\Comfy\ComfyUI`, the
    /// shared folder `d:\comfyui\model`, written the way ComfyUI's own
    /// example file suggests (plain scalars, Windows backslashes, trailing
    /// slashes, comments).
    const ISSUE_183: &str = r#"
# shared folder for every ComfyUI on this box
comfyui:
    base_path: d:\comfyui\model
    # is_default: true
    checkpoints: checkpoints/
    diffusion_models: |
        diffusion_models
        unet
    loras: loras/
    vae: vae/
    text_encoders: |
        text_encoders/
        clip/
    upscale_models: upscale_models/
    custom_nodes: custom_nodes/
"#;

    #[test]
    fn the_shared_folder_of_the_report_is_read_per_key() {
        let list = parse(ISSUE_183, "d:\\ComfyUI\\Comfy\\ComfyUI");
        assert_eq!(keyed(&list, "loras"), vec!["d:\\comfyui\\model\\loras"]);
        assert_eq!(keyed(&list, "checkpoints"), vec!["d:\\comfyui\\model\\checkpoints"]);
        assert_eq!(
            keyed(&list, "diffusion_models"),
            vec!["d:\\comfyui\\model\\diffusion_models", "d:\\comfyui\\model\\unet"],
        );
        assert_eq!(keyed(&list, "text_encoders").len(), 2);
        assert!(list.iter().all(|e| !e.is_default));
    }

    #[test]
    fn legacy_keys_land_on_the_new_names() {
        let list = parse("a:\n  base_path: D:/m\n  clip: clip\n  unet: unet\n", "C:\\c");
        assert_eq!(keyed(&list, "text_encoders"), vec!["D:\\m\\clip"]);
        assert_eq!(keyed(&list, "diffusion_models"), vec!["D:\\m\\unet"]);
        assert!(keyed(&list, "clip").is_empty());
    }

    #[test]
    fn a_relative_base_path_is_read_against_the_file() {
        // The file beside main.py, base_path two levels up and over.
        let list = parse("x:\n  base_path: ..\\..\\model\n  loras: loras\n", "D:\\ComfyUI\\Comfy\\ComfyUI");
        assert_eq!(keyed(&list, "loras"), vec!["D:\\ComfyUI\\model\\loras"]);
        // No base_path: entries against the file's folder.
        let list = parse("x:\n  loras: shared/loras\n", "/opt/comfy");
        assert_eq!(keyed(&list, "loras"), vec!["/opt/comfy/shared/loras"]);
    }

    #[test]
    fn an_absolute_entry_ignores_base_path() {
        let list = parse("x:\n  base_path: D:\\a\n  loras: E:\\loras\n", "C:\\c");
        assert_eq!(keyed(&list, "loras"), vec!["E:\\loras"]);
    }

    #[test]
    fn is_default_is_read_as_python_reads_it() {
        let list = parse("x:\n  base_path: D:\\a\n  is_default: true\n  loras: loras\n", "C:\\c");
        assert!(list[0].is_default);
        let list = parse("x:\n  base_path: D:\\a\n  is_default: false\n  loras: loras\n", "C:\\c");
        assert!(!list[0].is_default);
        // ComfyUI tests it with a bare `if`, so a non empty string is true.
        let list = parse("x:\n  base_path: D:\\a\n  is_default: 'no'\n  loras: loras\n", "C:\\c");
        assert!(list[0].is_default);
    }

    /// LU writes into these folders, so a relative entry may not walk out of
    /// the tree it belongs to.
    #[test]
    fn a_relative_entry_cannot_leave_its_base() {
        let list = parse(
            "x:\n  base_path: D:\\models\n  loras: ..\\..\\Windows\\System32\n  vae: ok\\..\\vae\n",
            "C:\\c",
        );
        assert!(keyed(&list, "loras").is_empty());
        assert_eq!(keyed(&list, "vae"), vec!["D:\\models\\vae"]);
        // Climbing above the drive root is no path at all.
        let list = parse("x:\n  loras: E:\\..\\..\\x\n", "C:\\c");
        assert!(list.is_empty());
        // A drive root is never a model folder.
        let list = parse("x:\n  loras: 'D:\\'\n", "C:\\c");
        assert!(list.is_empty());
    }

    #[test]
    fn keys_that_cannot_name_a_folder_are_dropped() {
        let list = parse("x:\n  base_path: D:\\m\n  '../loras': loras\n  'a/b': ab\n  loras: loras\n", "C:\\c");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "loras");
    }

    #[test]
    fn broken_or_empty_files_give_nothing_and_say_why() {
        // A double quoted Windows path is an invalid escape in YAML; PyYAML
        // refuses it the same way.
        let bad = "x:\n  base_path: \"D:\\comfy\\model\"\n  loras: loras\n";
        assert!(parse_extra_model_paths(bad, "C:\\c", Path::new("f"), None, &no_env).is_err());
        assert!(parse("", "C:\\c").is_empty());
        assert!(parse("# only a comment\n", "C:\\c").is_empty());
        assert!(parse("- a\n- b\n", "C:\\c").is_empty());
        // A section that is not a mapping, and a list value ComfyUI cannot split.
        assert!(parse("x: null\ny: 3\nz:\n  loras: [a, b]\n", "C:\\c").is_empty());
    }

    #[test]
    fn variables_and_home_in_base_path() {
        let env = |k: &str| if k == "MODELS" { Some("E:\\AI".to_string()) } else { None };
        let list = parse_extra_model_paths("x:\n  base_path: '%MODELS%\\comfy'\n  loras: loras\n", "C:\\c", Path::new("f"), None, &env).unwrap();
        assert_eq!(keyed(&list, "loras"), vec!["E:\\AI\\comfy\\loras"]);
        let list = parse_extra_model_paths("x:\n  base_path: ~/ai\n  vae: vae\n", "/opt/c", Path::new("f"), Some("/home/u"), &no_env).unwrap();
        assert_eq!(keyed(&list, "vae"), vec!["/home/u/ai/vae"]);
    }

    fn with(entries: Vec<ConfigEntry>) -> UserComfyPaths {
        UserComfyPaths { entries, ..Default::default() }
    }

    fn entry(key: &str, path: &str, is_default: bool, src: &str) -> ConfigEntry {
        ConfigEntry { key: key.into(), path: PathBuf::from(path), is_default, source: PathBuf::from(src) }
    }

    #[test]
    fn the_first_extra_entry_is_the_target_and_is_default_wins() {
        let u = with(vec![entry("loras", "D:\\a\\loras", false, "1"), entry("loras", "E:\\b\\loras", false, "2")]);
        assert_eq!(u.preferred("loras").unwrap().0, PathBuf::from("D:\\a\\loras"));
        let u = with(vec![
            entry("loras", "D:\\a\\loras", false, "1"),
            entry("loras", "E:\\b\\loras", true, "2"),
            entry("loras", "F:\\c\\loras", false, "3"),
        ]);
        assert_eq!(u.preferred("loras").unwrap(), (PathBuf::from("E:\\b\\loras"), PathBuf::from("2")));
        // Two defaults: the one loaded last is in front, as in ComfyUI.
        let u = with(vec![entry("vae", "D:\\x", true, "1"), entry("vae", "E:\\y", true, "2")]);
        assert_eq!(u.dirs_for("vae"), vec![PathBuf::from("E:\\y"), PathBuf::from("D:\\x")]);
        // Nothing configured: no opinion.
        assert!(u.preferred("loras").is_none());
        // Legacy key asked for.
        let u = with(vec![entry("text_encoders", "D:\\te", false, "1")]);
        assert_eq!(u.preferred("clip").unwrap().0, PathBuf::from("D:\\te"));
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("lu-comfy-user-paths").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn test_env() -> Env {
        Env { home: None, appdata: None, localappdata: None, var: Box::new(|_| None) }
    }

    /// The whole report on disk: portable install, shared folder in the YAML,
    /// input and output in the start script.
    #[test]
    fn a_portable_install_with_shared_folders_is_found_on_disk() {
        let root = scratch("portable");
        let comfy = root.join("Comfy").join("ComfyUI");
        let shared = root.join("model");
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::create_dir_all(shared.join("loras")).unwrap();
        std::fs::create_dir_all(root.join("io").join("in")).unwrap();
        std::fs::create_dir_all(root.join("io").join("out")).unwrap();
        std::fs::write(
            comfy.join("extra_model_paths.yaml"),
            format!("comfyui:\n  base_path: '{}'\n  loras: loras/\n  checkpoints: checkpoints/\n", shared.display()),
        )
        .unwrap();
        std::fs::write(
            root.join("Comfy").join("run_nvidia_gpu.bat"),
            format!(
                ".\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --input-directory \"{}\" --output-directory={}\r\npause\r\n",
                root.join("io").join("in").display(),
                root.join("io").join("out").display(),
            ),
        )
        .unwrap();
        std::fs::write(root.join("Comfy").join("run_cpu.bat"), ".\\python_embeded\\python.exe -s ComfyUI\\main.py --cpu\r\n").unwrap();

        let u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert_eq!(u.write_dir("loras"), Some(shared.join("loras")));
        // checkpoints/ does not exist yet, but the shared folder does.
        assert_eq!(u.write_dir("checkpoints"), Some(shared.join("checkpoints")));
        assert_eq!(u.write_dir("vae"), None);
        assert_eq!(u.input_dir, Some(root.join("io").join("in")));
        assert_eq!(u.output_dir_or(&comfy), root.join("io").join("out"));
        let args = u.launch_args();
        assert!(args.contains(&"--output-directory".to_string()), "{args:?}");
        assert!(!args.iter().any(|a| a == "--base-directory"));
        assert!(u.problems.is_empty(), "{:?}", u.problems);
    }

    /// Settings → Storage: the folder chosen in LU takes the ComfyUI downloads
    /// and the gallery, ahead of what the user set up for ComfyUI itself,
    /// which stays in the lists so files there are still found.
    #[test]
    fn the_lu_storage_folder_takes_the_downloads_and_the_gallery() {
        let root = scratch("lu-storage");
        let comfy = root.join("ComfyUI");
        let shared = root.join("shared");
        std::fs::create_dir_all(shared.join("loras")).unwrap();
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::write(
            comfy.join("extra_model_paths.yaml"),
            format!("mine:\n  base_path: '{}'\n  loras: loras\n", shared.display()),
        )
        .unwrap();
        let models = root.join("D").join("LU").join("Models");
        let gallery = root.join("D").join("LU").join("Gallery");
        std::fs::create_dir_all(models.join("loras")).unwrap();
        std::fs::create_dir_all(&gallery).unwrap();
        let config = root.join("config.json");

        let mut u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert_eq!(u.write_dir("loras"), Some(shared.join("loras")), "before: the user's own folder");
        let choice = crate::commands::storage::LuChoice { downloads_root: Some(models.clone()), gallery: Some(gallery.clone()) };
        u.take_lu_storage(&choice, &config);
        assert_eq!(u.write_dir("loras"), Some(models.join("loras")));
        // A folder not made yet, below a model folder that is there.
        assert_eq!(u.write_dir("vae"), Some(models.join("vae")));
        assert_eq!(u.write_dir("text_encoders"), Some(models.join("text_encoders")));
        // The user's folder is still searched.
        assert!(u.dirs_for("loras").contains(&shared.join("loras")));
        assert!(u.all_dirs().contains(&shared.join("loras")));
        assert_eq!(u.output_dir_or(&comfy), gallery);
        let args = u.launch_args();
        let at = args.iter().position(|a| a == "--output-directory").expect("the gallery is handed to ComfyUI");
        assert_eq!(args[at + 1], gallery.to_string_lossy());
        assert_eq!(args.iter().filter(|a| *a == "--output-directory").count(), 1);
    }

    #[test]
    fn without_a_choice_nothing_changes() {
        let root = scratch("lu-storage-none");
        let comfy = root.join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let mut u = UserComfyPaths::discover_with(&comfy, &test_env());
        u.take_lu_storage(&crate::commands::storage::LuChoice::default(), &root.join("config.json"));
        assert!(u.entries().is_empty());
        assert_eq!(u.output_dir_or(&comfy), comfy.join("output"));
        assert!(u.launch_args().is_empty());
    }

    /// Missing, broken, or pointing at an unplugged drive: the instance stays
    /// the answer, nothing panics, the reason is kept.
    #[test]
    fn nothing_usable_falls_back_to_the_instance() {
        let root = scratch("fallback");
        let comfy = root.join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert!(u.entries().is_empty() && u.problems.is_empty());
        assert_eq!(u.output_dir_or(&comfy), comfy.join("output"));
        assert!(u.launch_args().is_empty());

        std::fs::write(comfy.join("extra_model_paths.yaml"), "a:\n  base_path: \"D:\\comfy\"\n  loras: x\n").unwrap();
        let u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert!(u.entries().is_empty());
        assert_eq!(u.problems.len(), 1, "{:?}", u.problems);

        // Valid YAML, but the escape turned the path into a control character.
        std::fs::write(comfy.join("extra_model_paths.yaml"), "a:\n  base_path: \"D:\\bad\"\n  loras: x\n").unwrap();
        let u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert!(u.entries().is_empty());

        std::fs::write(comfy.join("extra_model_paths.yaml"), "a:\n  base_path: /nonexistent-lu-drive/x/y\n  loras: loras\n").unwrap();
        let u = UserComfyPaths::discover_with(&comfy, &test_env());
        assert!(u.preferred("loras").is_some());
        assert_eq!(u.write_dir("loras"), None, "an unplugged drive is no write target");
    }

    #[test]
    fn start_scripts_agree_or_are_ignored() {
        let env = |_: &str| None;
        let a = parse_start_script("python main.py --output-directory D:\\out\n", "C:\\p", &env).unwrap();
        let b = parse_start_script("python main.py --output-directory E:\\out\n", "C:\\p", &env).unwrap();
        let (got, notes) = agree(&[a.clone(), b]);
        assert_eq!(got.output_dir, None);
        assert_eq!(notes, vec!["--output-directory"]);
        let c = parse_start_script("python main.py --cpu\n", "C:\\p", &env).unwrap();
        let (got, notes) = agree(&[a, c]);
        assert_eq!(got.output_dir.as_deref(), Some("D:\\out"));
        assert!(notes.is_empty());
    }

    #[test]
    fn start_script_details() {
        let env = |k: &str| if k == "DATA" { Some("F:\\data".to_string()) } else { None };
        // %~dp0, a relative value, a ^ continuation, two configs, a comment line.
        let text = "@echo off\r\nrem python main.py --output-directory X:\\no\r\n.\\python_embeded\\python.exe -s ComfyUI\\main.py ^\r\n --extra-model-paths-config %~dp0a.yaml \"%DATA%\\b.yaml\" --input-directory in --output-directory %UNKNOWN%\\o\r\n";
        let got = parse_start_script(text, "D:\\Comfy", &env).unwrap();
        assert_eq!(got.extra_configs, vec!["D:\\Comfy\\a.yaml".to_string(), "F:\\data\\b.yaml".to_string()]);
        assert_eq!(got.input_dir.as_deref(), Some("D:\\Comfy\\in"));
        // An unresolved variable is not guessed at.
        assert_eq!(got.output_dir, None);
        // A script that does not start ComfyUI says nothing.
        assert!(parse_start_script("echo hello\r\n", "D:\\Comfy", &env).is_none());
        // A drive root as output is refused.
        let got = parse_start_script("python main.py --output-directory D:\\\n", "C:\\p", &env).unwrap();
        assert_eq!(got.output_dir, None);
    }

    #[test]
    fn comfyui_desktop_config_is_read_for_its_own_install() {
        let root = scratch("desktop");
        let appdata = root.join("AppData").join("Roaming");
        let base = root.join("Documents").join("ComfyUI");
        std::fs::create_dir_all(appdata.join("ComfyUI")).unwrap();
        std::fs::create_dir_all(base.join("models").join("loras")).unwrap();
        std::fs::write(
            appdata.join("ComfyUI").join("config.json"),
            serde_json::json!({ "basePath": base.to_string_lossy() }).to_string(),
        )
        .unwrap();
        std::fs::write(
            appdata.join("ComfyUI").join("extra_models_config.yaml"),
            format!("comfyui_desktop:\n  base_path: '{}'\n  is_default: true\n  loras: models/loras/\n", base.display()),
        )
        .unwrap();
        let env = Env { home: None, appdata: Some(appdata.clone()), localappdata: None, var: Box::new(|_| None) };
        let u = UserComfyPaths::discover_with(&base, &env);
        assert_eq!(u.write_dir("loras"), Some(base.join("models").join("loras")));
        assert_eq!(u.output_dir_or(&base), base.join("output"));
        // Another ComfyUI on the same machine does not inherit the Desktop app's folders.
        let other = root.join("Other").join("ComfyUI");
        std::fs::create_dir_all(&other).unwrap();
        let u = UserComfyPaths::discover_with(&other, &env);
        assert!(u.entries().is_empty());
        assert_eq!(u.output_dir_or(&other), other.join("output"));
    }

    /// GH #196 point 5: a Comfy Desktop launcher with two installs, each with
    /// its own model-paths file.
    fn launcher(name: &str, listed: Option<serde_json::Value>) -> (PathBuf, Env, PathBuf, PathBuf) {
        let root = scratch(name);
        let appdata = root.join("AppData").join("Roaming");
        let local = root.join("AppData").join("Local");
        let launcher = appdata.join("Comfy Desktop");
        let inst = launcher.join("instance-model-paths");
        std::fs::create_dir_all(&inst).unwrap();
        let shared = root.join("Comfy-Desktop").join("ComfyUI-Shared");
        std::fs::create_dir_all(shared.join("models").join("vae")).unwrap();
        std::fs::write(
            inst.join("inst-a1.yaml"),
            format!("comfy_desktop_shared:\n  base_path: '{}'\n  is_default: true\n  vae: models/vae/\n  loras: models/loras/\n", shared.display()),
        )
        .unwrap();
        let other = root.join("Elsewhere");
        std::fs::create_dir_all(other.join("vae")).unwrap();
        std::fs::write(inst.join("inst-b2.yaml"), format!("other:\n  base_path: '{}'\n  vae: vae/\n", other.display())).unwrap();
        let installs = local.join("Comfy-Desktop").join("ComfyUI-Installs");
        let a = installs.join("LTX").join("ComfyUI");
        let b = installs.join("Flux").join("ComfyUI");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        if let Some(j) = listed {
            let text = j.to_string()
                .replace("@A", &installs.join("LTX").to_string_lossy().replace('\\', "\\\\"))
                .replace("@B", &installs.join("Flux").to_string_lossy().replace('\\', "\\\\"));
            std::fs::write(launcher.join("installations.json"), text).unwrap();
        }
        let env = Env { home: None, appdata: Some(appdata), localappdata: Some(local), var: Box::new(|_| None) };
        (a, env, shared, b)
    }

    #[test]
    fn comfy_desktop_launcher_install_reads_its_own_model_paths_file() {
        let listed = serde_json::json!({ "installations": [
            { "id": "inst-a1", "name": "LTX", "path": "@A" },
            { "id": "inst-b2", "name": "Flux", "path": "@B" },
        ] });
        let (a, env, shared, b) = launcher("launcher-listed", Some(listed));
        let u = UserComfyPaths::discover_with(&a, &env);
        assert_eq!(u.write_dir("vae"), Some(shared.join("models").join("vae")));
        assert_eq!(u.script_configs.len(), 1);
        assert!(u.script_configs[0].ends_with("inst-a1.yaml"));
        let args = u.launch_args();
        assert_eq!(args[0], "--extra-model-paths-config");
        assert!(args[1].ends_with("inst-a1.yaml"));
        // The other install gets its own file, not this one's.
        let u = UserComfyPaths::discover_with(&b, &env);
        assert!(u.script_configs[0].ends_with("inst-b2.yaml"));
        assert!(u.problems.is_empty(), "{:?}", u.problems);
    }

    #[test]
    fn comfy_desktop_ids_without_the_prefix_and_paths_deeper_in_the_entry() {
        let listed = serde_json::json!([
            { "installId": "a1", "location": { "installPath": "@A" } },
            { "installId": "b2", "location": { "installPath": "@B" } },
        ]);
        let (a, env, shared, _) = launcher("launcher-nested", Some(listed));
        let u = UserComfyPaths::discover_with(&a, &env);
        assert_eq!(u.write_dir("vae"), Some(shared.join("models").join("vae")));
    }

    #[test]
    fn comfy_desktop_without_a_clear_answer_takes_nothing() {
        // Listed, but the entry names no file and there are two: a note.
        let listed = serde_json::json!({ "installations": [{ "path": "@A" }] });
        let (a, env, _, _) = launcher("launcher-unclear", Some(listed));
        let u = UserComfyPaths::discover_with(&a, &env);
        assert!(u.script_configs.is_empty());
        assert!(u.problems.iter().any(|p| p.contains("cannot tell which file")), "{:?}", u.problems);
        // Broken JSON: a note, nothing used.
        let (a, env, _, _) = launcher("launcher-broken", None);
        let launcher_dir = env.appdata.as_ref().unwrap().join("Comfy Desktop");
        std::fs::write(launcher_dir.join("installations.json"), "{ not json").unwrap();
        let u = UserComfyPaths::discover_with(&a, &env);
        assert!(u.script_configs.is_empty());
        assert!(u.problems.iter().any(|p| p.contains("not readable as JSON")), "{:?}", u.problems);
        // Not listed at all, and two files: nothing, no note.
        std::fs::write(launcher_dir.join("installations.json"), "[]").unwrap();
        let u = UserComfyPaths::discover_with(&a, &env);
        assert!(u.script_configs.is_empty() && u.problems.is_empty());
        // A ComfyUI that is no install of the launcher is left alone.
        let elsewhere = scratch("launcher-foreign").join("ComfyUI");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert!(UserComfyPaths::discover_with(&elsewhere, &env).script_configs.is_empty());
    }

    #[test]
    fn comfy_desktop_without_installations_json_and_one_file() {
        let (a, env, shared, _) = launcher("launcher-one", None);
        let inst = env.appdata.as_ref().unwrap().join("Comfy Desktop").join("instance-model-paths");
        std::fs::remove_file(inst.join("inst-b2.yaml")).unwrap();
        let u = UserComfyPaths::discover_with(&a, &env);
        assert_eq!(u.write_dir("vae"), Some(shared.join("models").join("vae")));
    }

    #[test]
    fn path_helpers() {
        assert_eq!(normalize_abs("D:\\a\\.\\b\\..\\c\\").as_deref(), Some("D:\\a\\c"));
        assert_eq!(normalize_abs("\\\\nas\\ai\\models\\..\\x").as_deref(), Some("\\\\nas\\ai\\x"));
        assert_eq!(normalize_abs("/a/../../b"), None);
        assert!(is_within("D:\\Models\\loras", "d:\\models"));
        assert!(!is_within("D:\\Modelsx", "D:\\Models"));
        assert!(is_root("D:\\") && is_root("/") && !is_root("D:\\a"));
    }

    #[test]
    fn the_settings_answer_names_folder_and_reason() {
        let comfy = PathBuf::from("/c/ComfyUI");
        let root = scratch("targets");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        let u = with(vec![ConfigEntry {
            key: "loras".into(),
            path: root.join("loras"),
            is_default: false,
            source: PathBuf::from("/c/ComfyUI/extra_model_paths.yaml"),
        }]);
        let v = targets_json(&u, None, &comfy);
        let rows = v["models"].as_array().unwrap();
        let loras = rows.iter().find(|r| r["key"] == "loras").unwrap();
        assert_eq!(loras["dir"], root.join("loras").to_string_lossy().to_string());
        assert!(loras["source"].as_str().unwrap().ends_with("extra_model_paths.yaml"));
        let vae = rows.iter().find(|r| r["key"] == "vae").unwrap();
        assert_eq!(vae["source"], "ComfyUI folder");
        assert_eq!(v["output"], comfy.join("output").to_string_lossy().to_string());
    }
}
