//! REA, "Reverse Engineer Anything" (github.com/morluto/rea, MIT), as a
//! plugin of the agents: a local MCP server over stdio that the WebView starts
//! with npx, as it starts every external MCP server (api/mcp/external-client).
//!
//! What runs is one package, fixed here: the official npm tarball of one
//! version, checked against the sha512 the registry publishes for it. This
//! module fetches that file into the plugin's folder and checks it again
//! before every start, so npx is handed a file on disk and never resolves a
//! name on the registry (the project warns of look-alike repositories). Its
//! own `setup`, which writes the configuration of other apps, is never run.
//!
//! The rest of what a start needs comes from here too: the folder it works
//! in, the PATH a Mac app started from the Finder lacks (see `finder_path`),
//! and whether this Node is one the package runs on.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The version LU runs. A new one is a change here, with its integrity.
pub const REA_VERSION: &str = "6.5.0";
/// The official tarball of that version on the npm registry.
pub const REA_TARBALL_URL: &str = "https://registry.npmjs.org/rea-agents/-/rea-agents-6.5.0.tgz";
/// `dist.integrity` of rea-agents 6.5.0 on the registry (17.10.2026).
pub const REA_INTEGRITY: &str =
    "sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==";
/// The tarball is 5.6 MB; anything far past that is not it.
const MAX_TARBALL_BYTES: u64 = 64 * 1024 * 1024;
/// `engines.node` of 6.5.0: ^22.19.0 || ^24.11.0 || >=26.0.0.
const NODE_RANGE: &str = "22.19 or newer within 22, 24.11 or newer within 24, or 26 and later";

/// The plugin's folder: the tarball and the folder REA works in.
pub fn plugin_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("plugins").join("rea")
}

fn tarball_path(dir: &Path) -> PathBuf {
    dir.join(format!("rea-agents-{REA_VERSION}.tgz"))
}

fn work_dir(dir: &Path) -> PathBuf {
    dir.join("work")
}

/// The integrity string of `bytes` in the registry's form.
pub fn integrity_of(bytes: &[u8]) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha512};
    format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)))
}

/// Is the file at `path` the pinned tarball?
pub fn tarball_verified(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => integrity_of(&bytes) == REA_INTEGRITY,
        Err(_) => false,
    }
}

/// Does this `node --version` run the package?
pub fn node_fits(version: &str) -> bool {
    let v = version.trim().trim_start_matches('v');
    let mut parts = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    match major {
        22 => minor >= 19,
        24 => minor >= 11,
        m => m >= 26,
    }
}

/// The PATH the REA process gets: the user's own on a Mac, where a Finder
/// start has only the launchd one; elsewhere the app's, unchanged.
fn child_path() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some(crate::finder_path::child_path().to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The PATH every external MCP server starts with (api/mcp/external-client,
/// `spawnEnv`): the login shell's on a Mac, where a Finder start has only
/// launchd's and an installed uvx or npx is not found; None elsewhere.
#[tauri::command]
pub async fn mcp_child_path() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(child_path).await.map_err(|e| e.to_string())
}

/// The file name of Node on this platform.
const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// `node --version` on that PATH, or None where there is no Node.
///
/// A foreign program: in a Linux AppImage the child must not inherit the
/// bundle's library path (process_util::foreign_system_command).
fn node_version(path: Option<&str>) -> Option<String> {
    let mut cmd = crate::process_util::foreign_system_command(NODE_EXE);
    cmd.arg("--version");
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    crate::process_util::suppress_window(&mut cmd);
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The folders a Node.js version manager keeps its versions in, newest
/// first. A Mac app started from the Finder gets the login shell's PATH, and
/// nvm, fnm and asdf set theirs up in the interactive shell only: on such a
/// Mac `node` works in the terminal and is not on that PATH (found on the
/// owner's Mac with nvm, 17.10.2026). A Linux app started from the menu is in
/// the same place: `.bashrc` is where nvm and fnm put their lines, and a
/// desktop session never reads it (A37, xxcoder on LMDE, 26.10.2026: REA said
/// no Node, `node -v` in the terminal said 24.22).
fn manager_node_dirs(home: &Path) -> Vec<PathBuf> {
    let mut versioned: Vec<PathBuf> = Vec::new();
    let mut roots = vec![
        home.join(".nvm/versions/node"),
        home.join(".config/nvm/versions/node"),
        home.join(".local/state/fnm_multishells"),
        home.join(".fnm/node-versions"),
        home.join(".local/share/fnm/node-versions"),
        home.join("Library/Application Support/fnm/node-versions"),
        home.join(".asdf/installs/nodejs"),
        home.join(".local/share/mise/installs/node"),
        home.join(".nodenv/versions"),
    ];
    if let Ok(nvm_dir) = std::env::var("NVM_DIR") {
        roots.insert(0, PathBuf::from(nvm_dir).join("versions/node"));
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        // nvm-windows keeps node.exe in the version folder itself.
        roots.push(appdata.join("nvm"));
        roots.push(appdata.join("fnm/node-versions"));
    }
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let base = e.path();
                for bin in [base.join("bin"), base.join("installation/bin"), base.join("installation"), base.clone()] {
                    if bin.join(NODE_EXE).is_file() && !versioned.contains(&bin) {
                        versioned.push(bin);
                    }
                }
            }
        }
    }
    // Newest first, by the version in the folder name (v24.15.0 before v22.1.0).
    versioned.sort_by_key(|p| std::cmp::Reverse(version_key(p)));
    let mut dirs = versioned;
    let fixed = [
        home.join(".volta/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        home.join(".linuxbrew/bin"),
        home.join(".local/bin"),
        PathBuf::from("/snap/bin"),
    ];
    for dir in fixed.into_iter().chain(windows_node_dirs()) {
        if dir.join(NODE_EXE).is_file() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Where the Node.js installer and Volta put node.exe on Windows.
#[cfg(windows)]
fn windows_node_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(|p| PathBuf::from(p).join("nodejs")))
        .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Volta/bin"));
    }
    dirs
}

#[cfg(not(windows))]
fn windows_node_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// `dir` in front of `path` (or of the app's own PATH), with the platform's
/// separator: a colon on Windows broke every folder it joined.
fn path_with(dir: &Path, path: Option<&str>) -> String {
    let rest = path.map(str::to_string).unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let mut all = vec![dir.to_path_buf()];
    all.extend(std::env::split_paths(&rest));
    std::env::join_paths(all).map(|p| p.to_string_lossy().into_owned()).unwrap_or(rest)
}

/// The PATH the user's login shell has, where the app's own lacks Node. Only
/// asked on Linux, and only then: the Mac's PATH comes from `finder_path`
/// already, and Windows has no login shell.
#[cfg(all(unix, not(target_os = "macos")))]
fn login_shell_path() -> Option<String> {
    crate::finder_path::linux_login_path()
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn login_shell_path() -> Option<String> {
    None
}

fn version_key(dir: &Path) -> (u32, u32, u32) {
    let name = dir.ancestors().find_map(|a| {
        let n = a.file_name()?.to_string_lossy().to_string();
        n.trim_start_matches('v').split('.').next()?.parse::<u32>().ok().map(|_| n)
    });
    let name = name.unwrap_or_default();
    let mut parts = name.trim_start_matches('v').split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// The PATH and the Node REA starts with: the app's PATH where its Node
/// fits, otherwise the newest fitting Node of a version manager put in front.
fn path_and_node(path: Option<String>, home: &Path) -> (Option<String>, Option<String>) {
    path_and_node_in(path, manager_node_dirs(home), login_shell_path)
}

/// [`path_and_node`] with the folders and the login shell passed in, so a test
/// does not depend on the Node of the machine it runs on.
fn path_and_node_in(
    path: Option<String>,
    dirs: Vec<PathBuf>,
    login: impl FnOnce() -> Option<String>,
) -> (Option<String>, Option<String>) {
    let on_path = node_version(path.as_deref());
    if on_path.as_deref().is_some_and(node_fits) {
        return (path, on_path);
    }
    for dir in dirs {
        let joined = path_with(&dir, path.as_deref());
        let found = node_version(Some(&joined));
        if found.as_deref().is_some_and(node_fits) {
            return (Some(joined), found);
        }
    }
    // Last, the login shell: a PATH set in ~/.profile (a Node in a folder
    // of its own, a manager LU does not know) is there and nowhere else.
    if let Some(login) = login() {
        let found = node_version(Some(&login));
        if found.as_deref().is_some_and(node_fits) {
            return (Some(login), found);
        }
    }
    (path, on_path)
}

/// Everything the WebView needs to show the plugin and start it.
pub fn status_in(dir: &Path, path: Option<String>, node: Option<String>) -> Value {
    let tarball = tarball_path(dir);
    let ready = tarball_verified(&tarball);
    let node_ok = node.as_deref().is_some_and(node_fits);
    json!({
        "version": REA_VERSION,
        "ready": ready,
        "tarball": ready.then(|| tarball.to_string_lossy().into_owned()),
        "workDir": work_dir(dir).to_string_lossy(),
        "path": path,
        "node": node,
        "nodeOk": node_ok,
        "nodeRange": NODE_RANGE,
    })
}

/// Keep `bytes` as the tarball when they are the pinned one: written beside
/// it first, so a broken write never leaves a file that reads as fetched.
pub fn keep_tarball(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let got = integrity_of(bytes);
    if got != REA_INTEGRITY {
        return Err(format!(
            "The REA package that came down is not the official {REA_VERSION} (its checksum differs), so it was not kept."
        ));
    }
    std::fs::create_dir_all(work_dir(dir)).map_err(|e| format!("Could not create the plugin folder: {}", crate::os_error::english(&e)))?;
    let target = tarball_path(dir);
    let part = target.with_extension("tgz.part");
    std::fs::write(&part, bytes).map_err(|e| format!("Could not write the REA package: {}", crate::os_error::english(&e)))?;
    std::fs::rename(&part, &target).map_err(|e| format!("Could not keep the REA package: {}", crate::os_error::english(&e)))?;
    Ok(target)
}

// ── Ghidra, and its decompiler on this machine ─────────────────────────────
//
// REA uses a Ghidra the user installed (LU installs none) and finds it through
// GHIDRA_INSTALL_DIR or a `ghidra`/`ghidraRun` launcher on the PATH. Two
// things went wrong on a Mac (B11, A37 run 27.10.2026):
//
//  1. The official Ghidra download carries its native decompiler only for
//     Windows and Linux x86-64. On Apple Silicon (and Intel Macs, Linux ARM)
//     Ghidra's own "Getting Started" says to build it once with
//     `support/gradle` + `gradle buildNatives`. Without that, REA answers every
//     decompile with `executable_missing … os/mac_arm_64/decompile` and the
//     user reads it as REA being broken.
//  2. A Mac app started from the Finder has neither GHIDRA_INSTALL_DIR nor a
//     terminal's PATH, so a Ghidra unpacked into the home folder was not found
//     at all.
//
// LU now looks for the install, says whether its decompiler is there, and
// hands REA the folder it found. It builds nothing and downloads nothing: the
// build is the user's step, in Terminal, with Ghidra's own instructions.

/// The version REA 6.5.0 is validated against (`SUPPORTED_GHIDRA_VERSION`).
pub const GHIDRA_FOR_REA: &str = "12.1.4";

/// Ghidra's folder name for this machine's native tools, as REA and Ghidra
/// name them (`Ghidra/Features/Decompiler/os/<dir>`).
pub fn ghidra_native_dir() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("mac_arm_64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("mac_x86_64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux_x86_64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("linux_arm_64")
    } else if cfg!(windows) {
        // Windows on ARM runs the x86-64 build under emulation (Ghidra docs).
        Some("win_x86_64")
    } else {
        None
    }
}

const DECOMPILER_EXE: &str = if cfg!(windows) { "decompile.exe" } else { "decompile" };

/// A folder is a Ghidra install when it has the two files REA checks first.
fn is_ghidra_root(dir: &Path) -> bool {
    let headless = if cfg!(windows) { "analyzeHeadless.bat" } else { "analyzeHeadless" };
    dir.join("Ghidra").join("application.properties").is_file() && dir.join("support").join(headless).is_file()
}

/// `application.version` from `Ghidra/application.properties`.
pub fn ghidra_version(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join("Ghidra").join("application.properties")).ok()?;
    raw.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (k.trim() == "application.version").then(|| v.trim().to_string())
    })
}

/// The decompiler Ghidra will use, built (`build/os`) before shipped (`os`),
/// the order Ghidra and REA prefer.
pub fn ghidra_decompiler(root: &Path, native_dir: &str) -> Option<PathBuf> {
    let base = root.join("Ghidra").join("Features").join("Decompiler");
    [base.join("build").join("os").join(native_dir), base.join("os").join(native_dir)]
        .into_iter()
        .map(|d| d.join(DECOMPILER_EXE))
        .find(|p| p.is_file())
}

/// Folders a Ghidra is unpacked into without a terminal's help. Not Desktop,
/// Documents or Downloads: on a Mac the first touch of each asks the user for
/// permission (see `find_comfyui_path`), and a status poll must not do that.
fn ghidra_search_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![home.to_path_buf(), home.join("Applications"), home.join("tools"), home.join("opt")];
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Applications"));
        // Homebrew's cask keeps the unpacked release one level down.
        for cask in ["/opt/homebrew/Caskroom/ghidra", "/usr/local/Caskroom/ghidra"] {
            if let Ok(rd) = std::fs::read_dir(cask) {
                dirs.extend(rd.flatten().map(|e| e.path()));
            }
        }
    } else if cfg!(windows) {
        dirs.push(PathBuf::from("C:\\ghidra"));
        dirs.push(PathBuf::from("C:\\Program Files"));
    } else {
        dirs.push(PathBuf::from("/opt"));
        dirs.push(PathBuf::from("/usr/share"));
    }
    dirs
}

/// Where the Ghidra REA will use is, and how LU found it.
///
/// The order is REA's own: an explicit GHIDRA_INSTALL_DIR wins even when it
/// is wrong (REA does not look further either), then a launcher on the PATH
/// REA gets, then the fixed folders, newest version first.
pub fn find_ghidra(env_dir: Option<&str>, path: Option<&str>, search: &[PathBuf]) -> Option<(PathBuf, &'static str)> {
    if let Some(d) = env_dir.map(str::trim).filter(|d| !d.is_empty()) {
        return Some((PathBuf::from(d), "env"));
    }
    if let Some(path) = path {
        let launchers: &[&str] = if cfg!(windows) { &["ghidraRun.bat", "ghidra.bat"] } else { &["ghidraRun", "ghidra"] };
        for dir in std::env::split_paths(path) {
            for l in launchers {
                if let Ok(real) = std::fs::canonicalize(dir.join(l)) {
                    if let Some(root) = real.parent().filter(|r| is_ghidra_root(r)) {
                        return Some((root.to_path_buf(), "path"));
                    }
                }
            }
        }
    }
    let mut found: Vec<PathBuf> = search
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.flatten().map(|e| e.path()))
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_ascii_lowercase().starts_with("ghidra"))
                && is_ghidra_root(p)
        })
        .collect();
    found.sort_by_key(|p| std::cmp::Reverse(ghidra_version(p).map(|v| version_triple(&v))));
    found.into_iter().next().map(|p| (p, "folder"))
}

fn version_triple(v: &str) -> (u32, u32, u32) {
    let mut it = v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).map(|s| s.parse().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// What the plugin row says about Ghidra. `null` fields where nothing was
/// found; `needsNatives` is the Apple Silicon case B11 is about.
pub fn ghidra_status_in(found: Option<(PathBuf, &'static str)>, native_dir: Option<&str>) -> Value {
    let Some((root, how)) = found else {
        return json!({ "found": false, "nativeDir": native_dir, "wantVersion": GHIDRA_FOR_REA });
    };
    let complete = is_ghidra_root(&root);
    let decompiler = native_dir.and_then(|n| ghidra_decompiler(&root, n));
    json!({
        "found": complete,
        "installDir": root.to_string_lossy(),
        "foundBy": how,
        "version": ghidra_version(&root),
        "wantVersion": GHIDRA_FOR_REA,
        "nativeDir": native_dir,
        "decompiler": decompiler.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "needsNatives": complete && decompiler.is_none(),
        "buildDir": root.join("support").join("gradle").to_string_lossy(),
    })
}

fn ghidra_status(path: Option<&str>) -> Value {
    let env_dir = std::env::var("GHIDRA_INSTALL_DIR").ok();
    let home = crate::os_paths::home();
    ghidra_status_in(find_ghidra(env_dir.as_deref(), path, &ghidra_search_dirs(&home)), ghidra_native_dir())
}

#[tauri::command]
pub async fn plugin_rea_status() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| {
        let (path, node) = path_and_node(child_path(), &crate::os_paths::home());
        let ghidra = ghidra_status(path.as_deref().or(std::env::var("PATH").ok().as_deref()));
        let mut status = status_in(&plugin_dir(&crate::os_paths::data_dir()), path, node);
        status["ghidra"] = ghidra;
        status
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_rea_fetch() -> Result<Value, String> {
    let dir = plugin_dir(&crate::os_paths::data_dir());
    if !tarball_verified(&tarball_path(&dir)) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(REA_TARBALL_URL)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Could not download REA {REA_VERSION}: {}", crate::os_error::english(&e)))?;
        if resp.content_length().is_some_and(|n| n > MAX_TARBALL_BYTES) {
            return Err("The REA package is far larger than the official one, so it was not downloaded.".into());
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Could not download REA {REA_VERSION}: {}", crate::os_error::english(&e)))?;
        if bytes.len() as u64 > MAX_TARBALL_BYTES {
            return Err("The REA package is far larger than the official one, so it was not kept.".into());
        }
        let keep_dir = dir.clone();
        tokio::task::spawn_blocking(move || keep_tarball(&keep_dir, &bytes))
            .await
            .map_err(|e| e.to_string())??;
    }
    // The folder REA starts in: a spawn into a missing one fails.
    std::fs::create_dir_all(work_dir(&dir)).map_err(|e| format!("Could not create the plugin folder: {}", crate::os_error::english(&e)))?;
    plugin_rea_status().await
}

// ── REA does not analyze LU itself ──────────────────────────────────────────
//
// David, 27.10.2026: REA and Ghidra are not pointed at Locally Uncensored's
// own programs, nor at lu-labs.ai or LU Cloud. A hurdle, not a lock: the
// desktop app is open source (AGPL), anyone can read it without REA. What
// actually protects LU is that the client carries no secrets. The check
// runs before every REA call, on every string the model passed.

/// What the model is told instead of a result. One sentence, English.
pub const LU_TARGET_REFUSAL: &str = "REA does not analyze LU itself (its app, its helper programs, lu-labs.ai or LU Cloud), so this call was not run; any other program or site works as usual.";

/// Names only LU's own files, folders and services carry. Desktop only: the
/// long name stays out of a phone build (mobile-name-im-programm.test.ts),
/// and REA does not run on a phone.
#[cfg(not(mobile))]
const LU_NAMES: &[&str] = &[
    "locally uncensored",
    "locally-uncensored",
    "locally_uncensored",
    "lu-llama-server",
    "lu-llama-quantize",
    "lu-labs.ai",
    "lrrhheztdytyfpizvuup",
];

#[cfg(mobile)]
const LU_NAMES: &[&str] = &["lu-labs.ai"];

/// The bundle identifier of the Mac app and every test build of it.
#[cfg(not(mobile))]
const LU_BUNDLE_ID: &str = "com.purpledoubled.locally-uncensored";
#[cfg(mobile)]
const LU_BUNDLE_ID: &str = "lu-labs.ai";

/// Larger files are not hashed: no LU program is near this size.
const MAX_HASHED_BYTES: u64 = 512 * 1024 * 1024;

fn sha256_of(path: &Path) -> Option<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_HASHED_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(hasher.finalize().into())
}

/// The programs this LU ships: its own executable and the files beside it
/// (the llama.cpp sidecars). Hashed once, so a copy under another name is
/// still recognised.
fn own_program_hashes() -> &'static Vec<[u8; 32]> {
    static HASHES: std::sync::OnceLock<Vec<[u8; 32]>> = std::sync::OnceLock::new();
    HASHES.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else { return Vec::new() };
        let mut out: Vec<[u8; 32]> = sha256_of(&exe).into_iter().collect();
        if let Some(dir) = exe.parent() {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p != exe {
                        if let Some(h) = sha256_of(&p) {
                            out.push(h);
                        }
                    }
                }
            }
        }
        out
    })
}

/// The folders the running LU lives in: beside its executable, and the
/// whole .app on a Mac.
fn own_install_dirs() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = exe.parent().map(Path::to_path_buf).into_iter().collect();
    if let Some(app) = exe.ancestors().find(|a| a.extension().is_some_and(|x| x == "app")) {
        dirs.push(app.to_path_buf());
    }
    dirs
}

/// A .app on the way to `path` whose Info.plist names LU's bundle id.
fn inside_lu_app_bundle(path: &Path) -> bool {
    path.ancestors()
        .filter(|a| a.extension().is_some_and(|x| x == "app"))
        .any(|app| {
            std::fs::read(app.join("Contents/Info.plist"))
                .map(|b| String::from_utf8_lossy(&b).contains(LU_BUNDLE_ID))
                .unwrap_or(false)
        })
}

/// Is this one string an LU target? `own_dirs` and `own_hashes` are passed
/// in so a test does not depend on the binary running it.
pub fn is_lu_target(s: &str, own_dirs: &[PathBuf], own_hashes: &[[u8; 32]]) -> bool {
    let lower = s.to_lowercase();
    if LU_NAMES.iter().any(|n| lower.contains(n)) {
        return true;
    }
    let path = Path::new(s.trim());
    if !path.is_absolute() {
        return false;
    }
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if own_dirs.iter().any(|d| real.starts_with(d)) || inside_lu_app_bundle(&real) {
        return true;
    }
    if own_hashes.is_empty() {
        return false;
    }
    sha256_of(&real).is_some_and(|h| own_hashes.contains(&h))
}

/// The refusal when any of `strings` is an LU target, else None.
pub fn lu_target_refusal(strings: &[String], own_dirs: &[PathBuf], own_hashes: &[[u8; 32]]) -> Option<&'static str> {
    strings
        .iter()
        .any(|s| is_lu_target(s, own_dirs, own_hashes))
        .then_some(LU_TARGET_REFUSAL)
}

/// Asked before every REA call with every string of its arguments.
#[tauri::command]
pub async fn plugin_rea_guard(strings: Vec<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        lu_target_refusal(&strings, &own_install_dirs(), own_program_hashes()).map(str::to_string)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("lu-rea-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rand_suffix() -> String {
        // Tests run in parallel: the clock alone gave two of them one folder.
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("{}-{n}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
    }

    #[test]
    fn the_integrity_is_written_the_way_the_registry_writes_it() {
        // sha512 of the empty input, base64, as `npm view x dist.integrity` shows it.
        assert_eq!(
            integrity_of(b""),
            "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="
        );
        assert!(REA_INTEGRITY.starts_with("sha512-") && REA_TARBALL_URL.ends_with(&format!("-{REA_VERSION}.tgz")));
        assert!(REA_TARBALL_URL.starts_with("https://registry.npmjs.org/rea-agents/"));
    }

    #[test]
    fn a_package_that_is_not_the_pinned_one_is_not_kept() {
        let dir = temp();
        let err = keep_tarball(&dir, b"a look-alike package").unwrap_err();
        assert!(err.contains("not the official 6.5.0"), "{err}");
        assert!(!tarball_path(&dir).exists());
        assert!(!tarball_path(&dir).with_extension("tgz.part").exists());
        // The status then offers no file to start.
        let s = status_in(&dir, None, Some("v24.11.0".into()));
        assert_eq!(s["ready"], false);
        assert!(s["tarball"].is_null());
    }

    #[test]
    fn a_file_changed_after_the_fetch_reads_as_not_ready() {
        let dir = temp();
        std::fs::write(tarball_path(&dir), b"changed on disk").unwrap();
        assert!(!tarball_verified(&tarball_path(&dir)));
        assert_eq!(status_in(&dir, None, None)["ready"], false);
    }

    #[test]
    fn the_node_range_is_the_packages_own() {
        for ok in ["v22.19.0", "v22.20.1", "v24.11.0", "v24.12.0", "v26.0.0", "v27.1.0"] {
            assert!(node_fits(ok), "{ok}");
        }
        for not in ["v20.18.0", "v22.18.9", "v23.5.0", "v24.10.0", "v25.2.0", "", "garbage"] {
            assert!(!node_fits(not), "{not}");
        }
    }

    /// A Ghidra tree as the official zip unpacks it, with or without the
    /// decompiler for `native`.
    fn fake_ghidra(parent: &Path, name: &str, version: &str, native: Option<&str>) -> PathBuf {
        let root = parent.join(name);
        std::fs::create_dir_all(root.join("Ghidra")).unwrap();
        std::fs::create_dir_all(root.join("support")).unwrap();
        std::fs::write(root.join("Ghidra/application.properties"), format!("application.name=Ghidra\napplication.version={version}\n")).unwrap();
        let headless = if cfg!(windows) { "analyzeHeadless.bat" } else { "analyzeHeadless" };
        std::fs::write(root.join("support").join(headless), b"#!/bin/sh\n").unwrap();
        if let Some(n) = native {
            let d = root.join("Ghidra/Features/Decompiler/os").join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(DECOMPILER_EXE), b"x").unwrap();
        }
        root
    }

    /// B11: the official zip on Apple Silicon. It has linux_x86_64 and
    /// win_x86_64 and nothing for mac_arm_64; the row has to say so.
    #[test]
    fn a_ghidra_without_this_machines_decompiler_needs_natives() {
        let home = temp();
        let root = fake_ghidra(&home, "ghidra_12.1.4_PUBLIC", "12.1.4", Some("linux_x86_64"));
        let s = ghidra_status_in(find_ghidra(None, None, std::slice::from_ref(&home)), Some("mac_arm_64"));
        assert_eq!(s["found"], true);
        assert_eq!(s["foundBy"], "folder");
        assert_eq!(s["version"], "12.1.4");
        assert_eq!(s["needsNatives"], true);
        assert!(s["decompiler"].is_null());
        assert_eq!(s["buildDir"], root.join("support").join("gradle").to_string_lossy().as_ref());
    }

    /// After `gradle buildNatives` the decompiler sits under build/os, which
    /// Ghidra prefers over os/.
    #[test]
    fn a_built_decompiler_counts() {
        let home = temp();
        let root = fake_ghidra(&home, "ghidra_12.1.4_PUBLIC", "12.1.4", None);
        let built = root.join("Ghidra/Features/Decompiler/build/os/mac_arm_64");
        std::fs::create_dir_all(&built).unwrap();
        std::fs::write(built.join(DECOMPILER_EXE), b"x").unwrap();
        let s = ghidra_status_in(find_ghidra(None, None, &[home]), Some("mac_arm_64"));
        assert_eq!(s["needsNatives"], false);
        assert!(s["decompiler"].as_str().unwrap().contains("build"));
    }

    #[test]
    fn the_newest_ghidra_in_a_folder_wins_and_an_explicit_dir_wins_over_all() {
        let home = temp();
        fake_ghidra(&home, "ghidra_11.4_PUBLIC", "11.4", None);
        fake_ghidra(&home, "ghidra_12.1.4_PUBLIC", "12.1.4", None);
        fake_ghidra(&home, "not-ghidra", "99.0", None);
        let (root, how) = find_ghidra(None, None, std::slice::from_ref(&home)).unwrap();
        assert!(root.ends_with("ghidra_12.1.4_PUBLIC"));
        assert_eq!(how, "folder");
        let (root, how) = find_ghidra(Some("/somewhere/else"), None, &[home]).unwrap();
        assert_eq!((root, how), (PathBuf::from("/somewhere/else"), "env"));
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_on_the_path_leads_to_its_install() {
        // Homebrew's cask: /opt/homebrew/bin/ghidraRun is a link into the tree.
        let home = temp();
        let root = fake_ghidra(&home, "ghidra_12.1.4_PUBLIC", "12.1.4", None);
        std::fs::write(root.join("ghidraRun"), b"#!/bin/sh\n").unwrap();
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(root.join("ghidraRun"), bin.join("ghidraRun")).unwrap();
        let (found, how) = find_ghidra(None, Some(&bin.to_string_lossy()), &[]).unwrap();
        assert_eq!(how, "path");
        assert_eq!(std::fs::canonicalize(found).unwrap(), std::fs::canonicalize(root).unwrap());
    }

    #[test]
    fn no_ghidra_is_a_plain_not_found() {
        let s = ghidra_status_in(find_ghidra(None, None, &[temp()]), Some("mac_arm_64"));
        assert_eq!(s["found"], false);
        assert!(s.get("needsNatives").is_none());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn this_mac_looks_for_mac_arm_64() {
        assert_eq!(ghidra_native_dir(), Some("mac_arm_64"));
    }

    #[test]
    fn the_status_names_the_folder_the_path_and_the_node() {
        let dir = temp();
        let s = status_in(&dir, Some("/opt/homebrew/bin:/usr/bin".into()), Some("v24.11.0".into()));
        assert_eq!(s["version"], REA_VERSION);
        assert_eq!(s["nodeOk"], true);
        assert_eq!(s["path"], "/opt/homebrew/bin:/usr/bin");
        assert!(s["workDir"].as_str().unwrap().ends_with("work"));
        assert_eq!(status_in(&dir, None, None)["nodeOk"], false);
    }

    #[test]
    fn a_node_of_a_version_manager_is_found_newest_first() {
        let home = temp();
        for v in ["v22.1.0", "v24.15.0", "v20.18.0"] {
            let bin = home.join(".nvm/versions/node").join(v).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join(NODE_EXE), b"").unwrap();
        }
        // Only the version folders under this home: the fixed folders after
        // them (Homebrew, /usr/local/bin) belong to the machine running the test.
        let dirs: Vec<_> = manager_node_dirs(&home).into_iter().filter(|d| d.starts_with(&home)).collect();
        let names: Vec<String> = dirs.iter().map(|d| d.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["v24.15.0", "v22.1.0", "v20.18.0"]);
    }

    /// A stand-in `node` that prints `version`, in a folder of its own.
    #[cfg(unix)]
    fn fake_node(version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = temp().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[test]
    fn a_node_only_the_login_shell_knows_is_found() {
        // A37: started from the Linux menu the app's PATH has no Node, the
        // terminal (and so the login shell) has one LU's folder list misses.
        let bin = fake_node("v24.22.0");
        let login = format!("{}:/usr/bin:/bin", bin.display());
        let (path, node) = path_and_node_in(Some("/nonexistent-a37".into()), Vec::new(), || Some(login.clone()));
        assert_eq!(node.as_deref(), Some("v24.22.0"));
        assert_eq!(path.as_deref(), Some(login.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn a_found_folder_goes_in_front_of_the_path_with_the_platform_separator() {
        let bin = fake_node("v22.19.0");
        let (path, node) = path_and_node_in(Some("/nonexistent-a37".into()), vec![bin.clone()], || None);
        assert_eq!(node.as_deref(), Some("v22.19.0"));
        let parts: Vec<PathBuf> = std::env::split_paths(path.as_deref().unwrap()).collect();
        assert_eq!(parts, [bin, PathBuf::from("/nonexistent-a37")]);
    }

    #[test]
    fn the_separator_is_the_platforms_own() {
        let joined = path_with(Path::new("first"), Some(&std::env::join_paths(["a", "b"]).unwrap().to_string_lossy()));
        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(parts, [PathBuf::from("first"), PathBuf::from("a"), PathBuf::from("b")]);
    }

    #[test]
    fn the_newer_fnm_and_mise_folders_are_searched() {
        let home = temp();
        for (root, v) in [(".local/share/fnm/node-versions", "v24.22.0"), (".local/share/mise/installs/node", "22.20.0")] {
            let base = home.join(root).join(v);
            let bin = if root.contains("fnm") { base.join("installation/bin") } else { base.join("bin") };
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join(NODE_EXE), b"").unwrap();
        }
        let dirs: Vec<_> = manager_node_dirs(&home).into_iter().filter(|d| d.starts_with(&home)).collect();
        assert_eq!(dirs.len(), 2, "{dirs:?}");
        assert!(dirs[0].to_string_lossy().contains("v24.22.0"), "newest first: {dirs:?}");
    }

    #[test]
    fn lu_itself_is_refused_by_name_folder_bundle_and_hash() {
        let dir = temp();
        // Its own folder, as the running app sees it.
        let own = dir.join("LU-install");
        std::fs::create_dir_all(&own).unwrap();
        let exe = own.join("lu-main");
        std::fs::write(&exe, b"pretend LU executable").unwrap();
        let dirs = vec![own.canonicalize().unwrap()];
        let hashes = vec![sha256_of(&exe).unwrap()];
        for target in [
            exe.to_string_lossy().into_owned(),
            "/Applications/Locally Uncensored.app/Contents/MacOS/locally-uncensored".into(),
            r"C:\Program Files\Locally Uncensored\lu-llama-server-x86_64-pc-windows-msvc.exe".into(),
            "https://lu-labs.ai/blog/some-post".into(),
            "https://lrrhheztdytyfpizvuup.supabase.co/rest/v1/".into(),
        ] {
            assert_eq!(lu_target_refusal(std::slice::from_ref(&target), &dirs, &hashes), Some(LU_TARGET_REFUSAL), "{target}");
        }
        // A copy under another name is recognised by its hash.
        let copy = dir.join("innocent.bin");
        std::fs::copy(&exe, &copy).unwrap();
        assert!(is_lu_target(&copy.to_string_lossy(), &dirs, &hashes));
        // A .app whose Info.plist carries LU's bundle id, wherever it lies.
        let app = dir.join("Renamed.app/Contents");
        std::fs::create_dir_all(app.join("MacOS")).unwrap();
        std::fs::write(app.join("Info.plist"), format!("<string>{LU_BUNDLE_ID}.a37</string>")).unwrap();
        std::fs::write(app.join("MacOS/x"), b"x").unwrap();
        assert!(is_lu_target(&app.join("MacOS/x").to_string_lossy(), &dirs, &hashes));
    }

    #[test]
    fn any_other_program_passes() {
        let dir = temp();
        let own = dir.join("LU-install");
        std::fs::create_dir_all(&own).unwrap();
        let exe = own.join("lu-main");
        std::fs::write(&exe, b"pretend LU executable").unwrap();
        let dirs = vec![own.canonicalize().unwrap()];
        let hashes = vec![sha256_of(&exe).unwrap()];
        let other = dir.join("a37probe");
        std::fs::write(&other, b"some other program").unwrap();
        let other_app = dir.join("Other.app/Contents");
        std::fs::create_dir_all(&other_app).unwrap();
        std::fs::write(other_app.join("Info.plist"), b"<string>com.example.other</string>").unwrap();
        let strings: Vec<String> = vec![
            other.to_string_lossy().into_owned(),
            other_app.to_string_lossy().into_owned(),
            "/usr/bin/ls".into(),
            "GIFAnimator.exe".into(),
            "https://example.com".into(),
            "decompile main".into(),
            "lu".into(),
            "/Users/someone/projects/lucid/app".into(),
        ];
        assert_eq!(lu_target_refusal(&strings, &dirs, &hashes), None);
    }

    #[test]
    #[ignore = "reads this machine's Node: LU_REAL_RUN=1"]
    fn a_finder_start_finds_a_fitting_node_on_this_machine() {
        if std::env::var("LU_REAL_RUN").as_deref() != Ok("1") {
            return;
        }
        // The PATH a Finder start has, and nothing a shell profile adds.
        let (path, node) = path_and_node(Some("/usr/bin:/bin:/usr/sbin:/sbin".into()), &crate::os_paths::home());
        println!("node {node:?} path {path:?}");
        assert!(node.as_deref().is_some_and(node_fits), "{node:?}");
    }

    #[test]
    #[ignore = "downloads the real package: LU_REAL_RUN=1"]
    fn the_real_tarball_on_the_registry_is_the_pinned_one() {
        if std::env::var("LU_REAL_RUN").as_deref() != Ok("1") {
            return;
        }
        let bytes = reqwest::blocking::get(REA_TARBALL_URL).unwrap().bytes().unwrap();
        let dir = temp();
        keep_tarball(&dir, &bytes).unwrap();
        assert_eq!(status_in(&dir, None, None)["ready"], true);
    }
}
