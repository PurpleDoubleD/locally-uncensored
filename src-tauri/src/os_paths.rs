//! Cross-platform path helpers — Python lookup, LM Studio CLI, common
//! install destinations. Mirrors the path-resolution logic from the old
//! Locally Uncensored Tauri binary.
//!
//! Jeder app-eigene Verzeichnisname kommt aus [`crate::app_identity`] und wird
//! hier NICHT noch einmal als Literal geschrieben. Auf diesem Branch trägt er
//! einen Suffix, damit der Experiment-Build die Daten der echten App weder
//! liest noch überschreibt — die Begründung steht in `app_identity`.

#[cfg_attr(mobile, allow(unused_imports))]
use crate::app_identity::{AGENT_WORKSPACE_DIR, APP_CONFIG_DIR, APP_DIR, APP_DISPLAY_DIR};
use std::path::PathBuf;

// Every build calls this: `commands::plugin_rea` (REA's Node lookup) has no
// cfg of its own. Before REA the Windows test build had no caller left
// (`agent_workspace_root` sits behind cfg(not(test)), `find_lms_cli` behind
// cfg(not(target_os = "windows"))) and the function was gated out there; with
// that gate the Windows test build did not compile (d307-k, 19.10.2026).
// A phone has its own `home` further down.
#[cfg(any(desktop, test))]
pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(all(not(test), desktop))]
pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

#[cfg(all(not(test), desktop))]
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

/// `config_dir()`-Zweig desselben Verzeichnisses. Unter macOS/Windows fällt er
/// mit [`data_dir`] zusammen, unter Linux ist es `~/.config/<APP_DIR>` — dort
/// liegen die erzeugten Bilder (`commands::mlx`) und Videos
/// (`commands::video`).
#[cfg(all(not(test), desktop))]
pub fn config_root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

/// Ordner der `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis, Trainer-Root).
/// Historisch ein anderer Name als [`data_dir`] — deshalb eine eigene
/// Konstante statt eines zweiten Literals.
#[cfg(all(not(test), desktop))]
pub fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_CONFIG_DIR)
}

/// Die `config.json` selbst.
pub fn app_config_json() -> PathBuf {
    app_config_dir().join("config.json")
}

/// Ablage für Hilfsbinaries, die die App selbst herunterlädt (`cloudflared`).
#[cfg(all(not(test), desktop))]
pub fn tools_bin_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_CONFIG_DIR)
        .join("bin")
}

/// Modellordner der eingebauten Engine. Bewusst `dirs::data_dir()` (unter
/// Windows also `%APPDATA%`, nicht `%LOCALAPPDATA%`) — das ist der Pfad, den
/// `detect_model_path("builtin")` seit jeher zurückgibt.
#[cfg(all(not(test), desktop))]
pub fn builtin_models_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DISPLAY_DIR)
        .join("models")
}

/// Sandkasten-Wurzel der Agenten. Pro Chat entsteht darin ein Unterordner;
/// `commands::filesystem::contain_within` lässt nichts darüber hinaus.
#[cfg(all(not(test), desktop))]
pub fn agent_workspace_root() -> PathBuf {
    home().join(AGENT_WORKSPACE_DIR)
}

// ── Android and iOS ──────────────────────────────────────────────────────────
//
// A phone has no home folder the `dirs` crate could answer from. On Android
// the process has no HOME and no XDG variable and its working directory is
// `/`, so every function above would come back as `./<name>` against a root
// the app cannot write, and fail without a word: no model folder, no store
// backup, no agent workspace (old Android branch, findings F2 and A14). iOS
// does have a container HOME, but the two phones get ONE rule on purpose.
//
// The rule: the system hands the app one data folder and one cache folder
// (`app.path().app_data_dir()` and `app_cache_dir()`), `lib.rs` stores them
// here in `setup`, and every path helper of this module derives from them.
// Nothing else in the crate may build an app-owned path from `dirs`.
//
// Where things land under the data folder is the layout the old Android
// branch already used (`models`, `stores`, `agent-workspace`), so an update
// from that app finds its files again.

/// The two folders a phone gives the app, and everything derived from them.
/// Pure, so the layout is tested on a desktop (`mobile_layout_tests`).
#[cfg(any(mobile, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MobileLayout {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config_root: PathBuf,
    pub app_config_dir: PathBuf,
    pub tools_bin_dir: PathBuf,
    pub builtin_models_dir: PathBuf,
    pub agent_workspace_root: PathBuf,
}

#[cfg(any(mobile, test))]
pub(crate) fn mobile_layout(data: &std::path::Path, cache: &std::path::Path) -> MobileLayout {
    MobileLayout {
        // There is no home. Code that asks for one gets the app's own folder,
        // which is the only place it may look in anyway.
        home: data.to_path_buf(),
        data_dir: data.to_path_buf(),
        cache_dir: cache.join(APP_DIR),
        config_root: data.to_path_buf(),
        app_config_dir: data.join("config"),
        tools_bin_dir: data.join("bin"),
        builtin_models_dir: data.join("models"),
        agent_workspace_root: data.join(AGENT_WORKSPACE_DIR),
    }
}

#[cfg(mobile)]
static MOBILE_DIRS: std::sync::OnceLock<(PathBuf, PathBuf)> = std::sync::OnceLock::new();

/// Called once from `setup` in `lib.rs`. A folder the system could not name
/// leaves the fallback below in place; the first value wins.
#[cfg(mobile)]
pub fn set_mobile_dirs(data: Option<PathBuf>, cache: Option<PathBuf>) {
    let Some(data) = data else {
        tracing::error!("the system named no app data folder, models and chats cannot be stored");
        return;
    };
    let cache = cache.unwrap_or_else(|| data.join("cache"));
    tracing::info!(data = %data.display(), cache = %cache.display(), "app folders");
    let _ = MOBILE_DIRS.set((data, cache));
}

/// The layout for this run. Before `setup` has stored the folders (nothing
/// that writes runs that early) this answers from the temp folder instead of
/// from `/`, so a too-early caller fails in a place that is at least app-owned
/// on iOS and visibly wrong on Android.
#[cfg(all(not(test), mobile))]
fn mobile() -> MobileLayout {
    match MOBILE_DIRS.get() {
        Some((data, cache)) => mobile_layout(data, cache),
        None => {
            let tmp = std::env::temp_dir().join(APP_DIR);
            mobile_layout(&tmp, &tmp.join("cache"))
        }
    }
}

#[cfg(all(not(test), mobile))]
pub fn home() -> PathBuf { mobile().home }
#[cfg(all(not(test), mobile))]
pub fn data_dir() -> PathBuf { mobile().data_dir }
#[cfg(all(not(test), mobile))]
pub fn cache_dir() -> PathBuf { mobile().cache_dir }
#[cfg(all(not(test), mobile))]
pub fn config_root() -> PathBuf { mobile().config_root }
#[cfg(all(not(test), mobile))]
pub fn app_config_dir() -> PathBuf { mobile().app_config_dir }
#[cfg(all(not(test), mobile))]
pub fn tools_bin_dir() -> PathBuf { mobile().tools_bin_dir }
#[cfg(all(not(test), mobile))]
pub fn builtin_models_dir() -> PathBuf { mobile().builtin_models_dir }
#[cfg(all(not(test), mobile))]
pub fn agent_workspace_root() -> PathBuf { mobile().agent_workspace_root }

#[cfg(test)]
mod mobile_layout_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn everything_a_phone_stores_hangs_under_the_two_folders_it_was_given() {
        let data = Path::new("/data/user/0/com.example.app");
        let cache = Path::new("/data/user/0/com.example.app/cache");
        let l = mobile_layout(data, cache);
        for p in [&l.home, &l.data_dir, &l.config_root, &l.app_config_dir, &l.tools_bin_dir,
            &l.builtin_models_dir, &l.agent_workspace_root] {
            assert!(p.starts_with(data), "{} left the app data folder", p.display());
        }
        assert!(l.cache_dir.starts_with(cache));
        // The model folder the old Android app used, so an update keeps its
        // models, and the one `detect_model_path("builtin")` answers with.
        assert_eq!(l.builtin_models_dir, data.join("models"));
        assert_eq!(l.agent_workspace_root, data.join(AGENT_WORKSPACE_DIR));
        // Never relative: `./models` against a cwd of `/` is the old bug.
        // `has_root`, not `is_absolute`: on a Windows host `/data/...` has a
        // root but no drive, and this test runs there too.
        assert!(l.builtin_models_dir.has_root() && l.data_dir.has_root());
    }

    /// Every app-owned path function has a phone twin, and none of the twins
    /// reaches for `dirs`. A function added later without one compiles for
    /// the desktop and breaks the phone build, or worse, answers `./x`.
    #[test]
    fn every_path_helper_has_a_phone_arm_that_does_not_ask_dirs() {
        let src = include_str!("os_paths.rs");
        for name in ["home", "data_dir", "cache_dir", "config_root", "app_config_dir",
            "tools_bin_dir", "builtin_models_dir", "agent_workspace_root"] {
            let twin = format!("#[cfg(all(not(test), mobile))]\npub fn {name}() -> PathBuf {{ mobile().");
            assert!(src.contains(&twin), "{name}() has no phone arm");
        }
        let resolver = &src[src.find("fn mobile() -> MobileLayout {").expect("exists")..];
        let resolver = &resolver[..resolver.find("\n}\n").expect("ends")];
        assert!(!resolver.contains("dirs::"), "the phone resolver must not ask the dirs crate:\n{resolver}");
        let layout = &src[src.find("pub(crate) fn mobile_layout(").expect("exists")..];
        let layout = &layout[..layout.find("\n}\n").expect("ends")];
        assert!(!layout.contains("dirs::"), "{layout}");
    }
}

#[cfg(test)]
pub use test_storage::{
    agent_workspace_root, app_config_dir, builtin_models_dir, cache_dir,
    config_root, data_dir, tools_bin_dir,
};

// No environment switch or test storage implementation exists in a release build.
#[cfg(test)]
pub(crate) mod test_storage {
    use super::*;
    use std::path::Path;
    use std::sync::OnceLock;

    pub fn root() -> &'static Path {
        static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
        ROOT.get_or_init(|| {
            let parent = test_scratch_root();
            std::fs::create_dir_all(&parent).expect("create native test scratch parent");
            tempfile::Builder::new().prefix("lu-native-test-storage-")
                .tempdir_in(parent).expect("create isolated native test storage")
        }).path()
    }

    // Shared across worker threads, with a unique directory for each test process.
    // Static roots survive process exit; the test runner must remove its owned scratch parent.
    fn roaming_base() -> PathBuf {
        root().join(if cfg!(windows) { "roaming" } else { "local" })
    }
    fn config_base() -> PathBuf {
        if cfg!(target_os = "linux") { root().join("config") } else { roaming_base() }
    }
    /// Whether this test process is the real run on the Mac
    /// (`commands::real_run_mac`): the commands of the app against the app's
    /// own folders, with real engines and real models.
    ///
    /// Two things have to be true, and one alone is not enough: the variable
    /// is set, AND every test filter on the command line names the real run.
    /// A plain `cargo test` with the variable left over in the shell stays in
    /// the scratch storage, where the other tests write and delete freely.
    pub fn real_run() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| {
            let filters: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-') && a.parse::<u64>().is_err())
                .collect();
            cfg!(target_os = "macos")
                && std::env::var("LU_REAL_RUN").as_deref() == Ok("1")
                && !filters.is_empty()
                && filters.iter().all(|f| f.contains("real_run_mac"))
        })
    }

    /// A folder of its own for the real run instead of the app's folders on
    /// this Mac: `LU_REAL_RUN_HOME`, an absolute path. Read only in the real
    /// run, and only in a test build: a release build has no such switch.
    /// The data and the config folder are one there, as on a Mac, the cache
    /// is beside them.
    pub fn real_run_home() -> Option<PathBuf> {
        if !real_run() {
            return None;
        }
        std::env::var_os("LU_REAL_RUN_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
    }

    /// The three folders the media engines live in are the app's own in the
    /// real run, or those under `LU_REAL_RUN_HOME` when it names one.
    /// Everything else (settings, stores, workspace) stays scratch.
    fn real(dir: Option<PathBuf>, kind: &str) -> Option<PathBuf> {
        if !real_run() {
            return None;
        }
        match real_run_home() {
            Some(home) => Some(home.join(kind).join(APP_DIR)),
            None => dir.map(|d| d.join(APP_DIR)),
        }
    }

    pub fn data_dir() -> PathBuf {
        real(dirs::data_local_dir(), "support").unwrap_or_else(|| root().join("local").join(APP_DIR))
    }
    pub fn cache_dir() -> PathBuf {
        real(dirs::cache_dir(), "cache")
            .unwrap_or_else(|| root().join(if cfg!(windows) { "local" } else { "cache" }).join(APP_DIR))
    }
    pub fn config_root() -> PathBuf {
        real(dirs::config_dir(), "support").unwrap_or_else(|| config_base().join(APP_DIR))
    }
    pub fn app_config_dir() -> PathBuf { config_base().join(APP_CONFIG_DIR) }
    pub fn tools_bin_dir() -> PathBuf { root().join("local").join(APP_CONFIG_DIR).join("bin") }
    pub fn display_data_dir() -> PathBuf { roaming_base().join(APP_DISPLAY_DIR) }
    pub fn builtin_models_dir() -> PathBuf { display_data_dir().join("models") }
    pub fn agent_workspace_root() -> PathBuf { root().join("home").join(AGENT_WORKSPACE_DIR) }

    #[test]
    fn app_owned_test_paths_never_use_user_storage() {
        for path in [data_dir(), cache_dir(), config_root(), app_config_dir(), tools_bin_dir(),
            builtin_models_dir(), agent_workspace_root(), super::app_config_json(), super::log_dir()] {
            assert!(path.starts_with(root()), "app-owned test path escaped scratch storage");
        }
        assert!(root().starts_with(test_scratch_root()));
        assert_eq!(data_dir(), std::thread::spawn(data_dir).join().unwrap());
        if cfg!(target_os = "macos") { assert_eq!(data_dir(), config_root()); }
        if cfg!(windows) { assert_eq!(data_dir(), cache_dir()); }
        // Outside the real run the switch of its own folder is not read.
        assert_eq!(real_run_home(), None);
    }

    #[test]
    fn secondary_app_writers_use_the_same_isolated_storage() {
        let persistent = crate::commands::system::persistent_dir().unwrap();
        let model_paths = crate::commands::custom_models::extra_model_paths_file().unwrap();
        assert!(persistent.starts_with(root()));
        if !cfg!(windows) { assert_eq!(persistent, data_dir().join("stores")); }
        assert!(model_paths.starts_with(root()));
        assert!(model_paths.ends_with("lu_extra_model_paths.yaml"));
        let fixture = r#"{"native-isolation-fixture":"owned"}"#.to_string();
        crate::commands::system::backup_stores(fixture.clone()).unwrap();
        assert_eq!(std::fs::read_to_string(persistent.join("store_backup.json")).unwrap(), fixture);
        assert_eq!(crate::commands::system::read_store_backup().unwrap(), Some(fixture));
    }
}

/// Where the rolling application log is written (`init_tracing` in lib.rs,
/// read back by the `log_file_path` command).
///
/// Deliberately NOT Tauri's `app_log_dir()`, for two reasons:
///
/// 1. Lifetime. `app_log_dir()` needs an `AppHandle`, which only exists once
///    `tauri::Builder::build()` has run. Tracing is initialised before that —
///    it has to be, or every line the app emits while starting up (the very
///    window where the hard-to-reproduce failures live) would be written to a
///    subscriber that does not exist yet. The `WorkerGuard` for the file
///    writer has the same problem: it must be created before the first event.
/// 2. Support. `crash.log` already lives in `data_dir()` (crash_report.rs).
///    Putting the rolling log in a sibling folder means one directory holds
///    every artefact a support request needs, instead of the panic record and
///    the log being two unrelated places on three different operating systems.
///
/// macOS:   ~/Library/Application Support/<APP_DIR>/logs
/// Windows: %LOCALAPPDATA%\<APP_DIR>\logs
/// Linux:   ~/.local/share/<APP_DIR>/logs
///
/// `<APP_DIR>` ist `lu-labs` in der echten App und trägt auf diesem Branch
/// einen Suffix — siehe [`crate::app_identity`].
pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Locate a usable Python interpreter. Returns the absolute path to the
/// binary, or `None` if no real Python is on the system.
///
/// On Windows we explicitly skip the WindowsApps stub that opens the
/// Microsoft Store instead of running Python, and every candidate is
/// verified with `--version` before we commit to it — a path that exists
/// but doesn't run (broken uninstall leftovers, the Store stub) must not
/// poison the cached python. Probe order: `where` → the `py -3` launcher
/// (present even when "Add to PATH" was skipped) → `C:\PythonXX` →
/// `C:\Program Files\Python*` (all-users installs) → `%LOCALAPPDATA%`.
pub fn find_python() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        find_python_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        // PATH first, then the directories a Finder-started app does not have
        // on it (`python::fixed_python_dirs`).
        unix_python_candidates()
            .iter()
            .find_map(|c| crate::python::python_paths_for(c).into_iter().next())
    }
}

#[cfg(target_os = "windows")]
fn find_python_windows() -> Option<PathBuf> {
    python_via_where()
        .or_else(python_via_py_launcher)
        .or_else(python_in_fixed_paths)
        .or_else(python_in_program_files)
        .or_else(python_in_appdata)
}

/// Run a candidate interpreter and confirm it's real (exits 0 — the MS Store
/// stub prints an install nag and exits non-zero).
#[cfg(target_os = "windows")]
fn verify_python_path(path: &str) -> bool {
    if path.is_empty() || path.to_lowercase().contains("windowsapps") {
        return false;
    }
    let mut cmd = crate::python::python_command(path);
    cmd.arg("--version");
    crate::process_util::suppress_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// `where python` on PATH, skipping the WindowsApps Store-stub alias.
#[cfg(target_os = "windows")]
fn python_via_where() -> Option<PathBuf> {
    let mut cmd = crate::process_util::foreign_system_command("where");
    cmd.arg("python");
    crate::process_util::suppress_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let p = line.trim();
        if !p.is_empty() && verify_python_path(p) {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// The Windows `py -3` launcher (C:\Windows\py.exe) is installed system-wide
/// by the python.org installer regardless of the "Add to PATH" checkbox and
/// the install dir, so it finds Pythons that `where` + fixed-path scans miss.
/// We ask Python for its own `sys.executable` so we return the concrete
/// python.exe (needed for venv creation / pip), not the launcher shim.
#[cfg(target_os = "windows")]
fn python_via_py_launcher() -> Option<PathBuf> {
    let mut cmd = crate::python::python_command("py");
    cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
    crate::process_util::suppress_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if verify_python_path(&path) {
        Some(PathBuf::from(path))
    } else {
        None
    }
}

/// Standard single-version python.org install dirs at the drive root.
#[cfg(target_os = "windows")]
fn python_in_fixed_paths() -> Option<PathBuf> {
    for ver in ["313", "312", "311", "310", "39"] {
        let p = PathBuf::from(format!("C:\\Python{ver}\\python.exe"));
        if p.exists() && verify_python_path(&p.to_string_lossy()) {
            return Some(p);
        }
    }
    None
}

/// All-users python.org installs land in `C:\Program Files\PythonXX` (and the
/// 32-bit build under Program Files (x86)) — invisible to `where` when "Add
/// to PATH" was skipped.
#[cfg(target_os = "windows")]
fn python_in_program_files() -> Option<PathBuf> {
    for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            if let Some(p) = scan_python_subdirs(std::path::Path::new(&base)) {
                return Some(p);
            }
        }
    }
    None
}

/// Per-user python.org installs: `%LOCALAPPDATA%\Programs\Python\Python3xx`.
#[cfg(target_os = "windows")]
fn python_in_appdata() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    scan_python_subdirs(&std::path::Path::new(&local).join("Programs").join("Python"))
}

/// Scan `base` for `Python*\python.exe`, newest version first, verifying each
/// candidate actually runs before returning it.
#[cfg(target_os = "windows")]
fn scan_python_subdirs(base: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(base).ok()?;
    let mut dirs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                && e.file_name().to_string_lossy().to_lowercase().starts_with("python")
        })
        .collect();
    dirs.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for dir in dirs {
        let exe = dir.path().join("python.exe");
        if exe.exists() && verify_python_path(&exe.to_string_lossy()) {
            return Some(exe);
        }
    }
    None
}

/// Candidate interpreter names for macOS/Linux, ordered so a known-good minor
/// (3.12 / 3.11 — they have torch/mlx/diffusers wheels) beats a bare `python3`,
/// which on some machines is 3.14, too new for ML wheels (BUG-008). Keeps the
/// video + RAG path on the same interpreter the MLX image install picks.
///
/// `pub(crate)` because the ORDER is the fix, and until 2.6.8 it was reachable
/// only through `find_python`, which returns a single hit. The installer's
/// `python::get_python_bin` and the carcass probe in `commands::process` both
/// need to walk the same list themselves — one to apply its own `--version`
/// gate, the other to collect every interpreter, not just the first.
#[cfg(not(target_os = "windows"))]
pub(crate) fn unix_python_candidates() -> [&'static str; 5] {
    ["python3.12", "python3.11", "python3.13", "python3", "python"]
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod python_candidate_tests {
    #[cfg(not(target_os = "windows"))]
    use super::unix_python_candidates;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn prefers_3_12_and_3_11_over_bare_python3() {
        let c = unix_python_candidates();
        let i312 = c.iter().position(|x| *x == "python3.12").unwrap();
        let i311 = c.iter().position(|x| *x == "python3.11").unwrap();
        let i3 = c.iter().position(|x| *x == "python3").unwrap();
        assert!(
            i312 < i3 && i311 < i3,
            "must prefer python3.12/3.11 over a bare python3 (BUG-008)"
        );
    }

    // ── Windows resolver (upstream 68de216) ─────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn verify_rejects_stub_and_empty() {
        assert!(!super::verify_python_path(""));
        assert!(!super::verify_python_path(
            "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        ));
        assert!(!super::verify_python_path("C:\\no\\such\\python.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_prefers_newest_and_verifies() {
        // A dir tree with a fake (non-runnable) python.exe: exists() passes
        // but --version fails → the scan must reject it, not return it blind.
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("Python312");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("python.exe"), b"not a real exe").unwrap();
        assert!(super::scan_python_subdirs(tmp.path()).is_none());
    }

    #[test]
    fn find_python_returns_verified_or_none() {
        // Cross-platform smoke: whatever comes back must exist on disk.
        if let Some(p) = super::find_python() {
            assert!(p.exists(), "find_python returned a non-existent path: {p:?}");
        }
    }
}

/// Look for the LM Studio CLI (`lms`). Three locations:
/// 1. Post-bootstrap install (`~/.lmstudio/bin/lms`)
/// 2. Pre-bootstrap (Windows package layout)
/// 3. PATH
// Its only caller (install/lmstudio.rs) delegates here on everything but
// Windows; on Windows the function was dead and clippy -D warnings said so.
#[cfg(not(target_os = "windows"))]
pub fn find_lms_cli() -> Option<PathBuf> {
    let ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let post = home().join(".lmstudio").join("bin").join(format!("lms{ext}"));
    if post.exists() {
        return Some(post);
    }
    if cfg!(target_os = "windows") {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let pre = PathBuf::from(local)
                .join("Programs")
                .join("LM Studio")
                .join("resources")
                .join("app")
                .join(".webpack")
                .join("lms.exe");
            if pre.exists() {
                return Some(pre);
            }
        }
    }
    which::which("lms").ok()
}

// ── REMOVED on 01.09.2026: the second engine-detection apparatus (KF-19) ──
//
// Gone from here: `lmstudio_installed`, `ollama_installed`,
// `comfyui_search_roots`, and the three helpers that only they kept alive —
// `find_lmstudio_app`, `find_ollama_app`, `find_ollama_bin` and
// `spotlight_app` (the `mdfind` lookup, whose only two callers were the two
// `find_*_app` functions).
//
// The three named ones were counted before removing: no Rust caller, no
// `#[tauri::command]` wrapper, no line in `lib.rs`, and no occurrence of the
// NAME as a string anywhere under `src/`, `dev-server/`, `e2e/` or
// `mobile-client/`. The three helpers had exactly one caller each, and that
// caller was one of the three.
//
// They are not a gap: every question they answered is already answered on a
// path that runs, and by different code — which is the whole point of the
// finding.
//
//   * "Is Ollama there?" — the production paths call `Command::new("ollama")`
//     straight off PATH (`process.rs::start_ollama` / `auto_start_ollama`), and
//     the installer probes with `which ollama`
//     (`commands/install/ollama.rs`). Neither ever consulted
//     `find_ollama_bin`'s richer search (Homebrew prefixes, the app bundle's
//     three internal layouts, Spotlight).
//   * "Is LM Studio there?" — `commands/install/lmstudio.rs::lmstudio_lms_path`,
//     which handles the Windows layouts itself and delegates to
//     `find_lms_cli` (kept, and still called) everywhere else.
//   * "Where might ComfyUI be?" — `process.rs::find_comfyui_path`, which keeps
//     its own, longer and actually maintained list of roots: the env var, the
//     config file, the fixed locations, a depth-7 home scan, then the drive
//     roots. `comfyui_search_roots` listed four home folders plus
//     `%USERPROFILE%\StabilityMatrix` and `…\Packages` — the wrong shape for
//     Stability Matrix, which nests as `StabilityMatrix\Packages\ComfyUI`, and
//     nobody noticed because nobody called it.
//
// Wiring them instead would have meant choosing WHICH of the two detections
// each question gets — the very fork this finding is about — and the callers
// that would have to change are in `src/`.

/// Default ComfyUI install target — where install_comfyui will drop the
/// portable bundle on Windows / clone the repo on macOS+Linux.
///
/// The `allow` here is NOT the standing "decide later" the block above just
/// removed, and the difference is the whole point of KF-19: this function HAS a
/// caller — `alle_abgeleiteten_pfade` in `app_identity.rs`, which asserts that
/// no path this build derives points into the real app's directories. It is
/// therefore alive in the `test` target and dead only in the `bin` one, and
/// `dead_code` cannot see across the two. Remove the caller and this becomes a
/// deletion like the others.
#[allow(dead_code)]
pub fn default_comfyui_dir() -> PathBuf {
    data_dir().join("ComfyUI")
}

// ── Testwurzeln ───────────────────────────────────────────────────────────

/// Basis für die Wegwerf-Verzeichnisse der Tests.
///
/// Unter macOS/Linux ist das weiterhin `std::env::temp_dir()`: dort liegt temp
/// bei `/var/folders/…` bzw. `/tmp`, also ausserhalb von `$HOME` — nichts
/// ändert sich.
///
/// Unter WINDOWS darf es `std::env::temp_dir()` NICHT sein, und das ist der
/// ganze Grund, warum diese Funktion existiert. Dort ist temp
/// `%LOCALAPPDATA%\Temp` == `C:\Users\<user>\AppData\Local\Temp`, und `AppData`
/// steht in `commands::filesystem::forbidden_root_prefixes()` als PRÄFIX auf
/// der Sperrliste — darunter liegen Browserprofile, Token und Zugangsdaten,
/// und genau die zu sperren ist der Zweck der Wurzel-Härtung. Damit ist jede
/// Testwurzel unter `temp_dir()` "Not an allowed workspace folder", und
/// `allow_root_for_test` paniert, bevor der Test überhaupt anfängt. Die Regel
/// ist richtig, der ORT der Testverzeichnisse war es nicht — wer das hier auf
/// `temp_dir()` zurückdreht, macht 15 Windows-Tests wieder rot.
///
/// Der Ersatz ist das `target`-Verzeichnis der Kiste: es liegt im Repo (also
/// im Benutzerprofil, aber NICHT unter `AppData` — von der Regel ausdrücklich
/// erlaubt, weil `forbidden_exact_roots()` `C:\Users` und `$HOME` nur EXAKT
/// sperrt), ist beschreibbar, gitignoriert und gehört ohnehin zum Build.
/// Echte Nutzerverzeichnisse (`Documents`, `Desktop`) kommen nicht in Frage:
/// Tests schreiben nicht dorthin, wo der Nutzer arbeitet.
#[cfg(test)]
pub(crate) fn test_scratch_root() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("lu-test-scratch")
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
    }
}

/// Ein Wegwerf-Testverzeichnis, das sich beim Verlassen selbst wieder abräumt.
///
/// Der Aufräum-Schritt hängt am `Drop`, nicht an einer letzten Zeile im Test:
/// ein `let _ = fs::remove_dir_all(…)` am Ende läuft bei einem gescheiterten
/// `assert!` nie, und unter `target/` bliebe der Rest liegen.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct TestDir(PathBuf);

#[cfg(test)]
impl std::ops::Deref for TestDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl AsRef<std::path::Path> for TestDir {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Legt ein frisches, leeres Testverzeichnis unter [`test_scratch_root`] an.
///
/// Der Name trägt Prozess-ID und ThreadId — dieselbe Machart wie die
/// `lu-…-<pid>-<thread>`-Namen, die im Bestand schon so gebaut waren —, damit
/// parallel laufende Tests sich nicht in dasselbe Verzeichnis setzen.
#[cfg(test)]
pub(crate) fn test_dir(tag: &str) -> TestDir {
    let thread: String = format!("{:?}", std::thread::current().id())
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    let path = test_scratch_root().join(format!("lu-{}-{}-{}", tag, std::process::id(), thread));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("Testverzeichnis anlegen");
    TestDir(path)
}
