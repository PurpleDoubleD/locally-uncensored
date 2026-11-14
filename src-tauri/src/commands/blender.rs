//! Create, 3D: hand a model to Blender (3.1.0).
//!
//! Three things, all on the desktop only:
//!
//! * `blender_status` finds an installed Blender. Only the places Blender's
//!   own installers, the stores and the package managers put it are looked at
//!   (see `candidates`). A path never comes from the frontend, a web page or a
//!   model file: what runs is always a binary found here.
//! * `blender_open` saves the GLB into LU's own folder and starts Blender with
//!   its window and our script, which imports the model, names it and frames
//!   the view. LU does not wait for it.
//! * `blender_convert` runs Blender in the background (`-b --factory-startup`,
//!   so the user's own preferences and add-ons stay out of it and are never
//!   written) to make a `.blend` with the textures packed in, or an `.fbx`.
//!   Time limit, can be stopped with `blender_cancel`. The bytes go back to
//!   the frontend, which saves them through the same Save dialog as every
//!   other download.
//!
//! The script (`blender_lu.py`) is embedded in the app, so it cannot be
//! missing or swapped between releases. Everything it gets (the model file,
//! the name, the output file) is passed as an argument after `--`; Blender
//! stops reading options there, and the script treats them as plain data.
//!
//! Files go to `<app data>/blender/`, not to the system temp folder: a Flatpak
//! Blender has the home folder but its own private `/tmp`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::Manager;

const SCRIPT: &str = include_str!("blender_lu.py");
const SCRIPT_NAME: &str = "lu_blender.py";

/// Older Blenders lack what the script uses (`temp_override` came in 3.2);
/// 3.3 is the oldest LTS that has it.
const MIN_VERSION: (u32, u32) = (3, 3);
/// The heaviest test model (700k triangles, 50 MB) takes 3 s on a Mac; a
/// slow laptop and a much bigger file still fit well within ten minutes.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(target_os = "macos")]
const SPOTLIGHT_TIMEOUT: Duration = Duration::from_secs(4);
/// A GLB larger than this is not something LU made.
const MAX_GLB_BYTES: usize = 1024 * 1024 * 1024;
/// Models handed to "Open in Blender" that stay in LU's folder.
const KEEP_OPENED: usize = 20;
const MAX_NAME_CHARS: usize = 60;

pub const NOT_FOUND: &str = "Blender is not installed on this computer.";
pub const CANCELLED: &str = "Stopped.";
const NOT_A_MODEL: &str = "This is not a 3D model LU can hand to Blender.";

// ── Finding Blender ─────────────────────────────────────────────────────────

/// One installed Blender. `exe` runs in the background, `gui` opens the
/// window (on Windows `blender-launcher.exe`, which has no console).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub exe: PathBuf,
    pub gui: PathBuf,
    pub source: &'static str,
}

#[cfg(unix)]
fn is_runnable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_runnable(p: &Path) -> bool {
    p.is_file()
}

/// Folders in `dir` whose name starts with `prefix` (any case), newest
/// version first ("Blender 5.2" before "Blender 4.2").
fn dirs_starting_with(dir: &Path, prefix: &str, suffix: &str) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = read
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            n.starts_with(&prefix.to_lowercase()) && n.ends_with(&suffix.to_lowercase())
        })
        .map(|e| e.path())
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(version_key(&p.file_name().unwrap_or_default().to_string_lossy())));
    out
}

/// The numbers in a name, for sorting "Blender 4.10" after "Blender 4.9".
fn version_key(name: &str) -> Vec<u32> {
    name.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect()
}

/// macOS: `Blender.app` (or `Blender 4.2.app` and the like) in /Applications
/// and ~/Applications, then what Spotlight knows by Blender's bundle id. Every
/// bundle must say it is Blender in its Info.plist.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn mac_candidates(app_dirs: &[PathBuf], spotlight: &[PathBuf]) -> Vec<Install> {
    let mut apps: Vec<PathBuf> = Vec::new();
    for d in app_dirs {
        apps.push(d.join("Blender.app"));
        apps.extend(dirs_starting_with(d, "blender", ".app"));
    }
    apps.extend(spotlight.iter().filter(|p| mac_place_ok(p)).cloned());
    let mut out = Vec::new();
    for app in apps {
        let exe = app.join("Contents/MacOS/Blender");
        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap_or_default();
        if plist.contains("<string>org.blenderfoundation.blender</string>") && is_runnable(&exe) {
            push_unique(&mut out, Install { gui: exe.clone(), exe, source: "app" });
        }
    }
    out
}

/// A Spotlight hit in the Trash or on a mounted disk image is not an install.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_place_ok(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.ends_with(".app") && !s.contains("/.Trash/") && !s.starts_with("/Volumes/") && !s.contains("/AppTranslocation/")
}

/// Windows: what the installer registered, Program Files, Steam libraries.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_candidates(registered: &[PathBuf], program_dirs: &[PathBuf], steam_libs: &[PathBuf]) -> Vec<Install> {
    let mut dirs: Vec<(PathBuf, &'static str)> = Vec::new();
    for d in registered {
        dirs.push((d.clone(), "installer"));
    }
    for pf in program_dirs {
        for d in dirs_starting_with(&pf.join("Blender Foundation"), "blender", "") {
            dirs.push((d, "program files"));
        }
    }
    for lib in steam_libs {
        dirs.push((lib.join("steamapps").join("common").join("Blender"), "steam"));
    }
    let mut out = Vec::new();
    for (d, source) in dirs {
        let exe = d.join("blender.exe");
        if exe.is_file() {
            let launcher = d.join("blender-launcher.exe");
            let gui = if launcher.is_file() { launcher } else { exe.clone() };
            push_unique(&mut out, Install { exe, gui, source });
        }
    }
    out
}

/// Linux: the package manager's binary on PATH, the usual fixed places,
/// Flatpak and Snap, Steam, and an unpacked download in /opt or ~/Applications.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn linux_candidates(home: Option<&Path>, path_dirs: &[PathBuf]) -> Vec<Install> {
    let mut files: Vec<(PathBuf, &'static str)> = Vec::new();
    for d in path_dirs {
        files.push((d.join("blender"), "path"));
    }
    for f in ["/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender"] {
        files.push((PathBuf::from(f), "system"));
    }
    files.push((PathBuf::from("/var/lib/flatpak/exports/bin/org.blender.Blender"), "flatpak"));
    if let Some(h) = home {
        files.push((h.join(".local/share/flatpak/exports/bin/org.blender.Blender"), "flatpak"));
        files.push((h.join(".local/share/Steam/steamapps/common/Blender/blender"), "steam"));
        files.push((h.join(".steam/steam/steamapps/common/Blender/blender"), "steam"));
    }
    let mut unpacked = dirs_starting_with(Path::new("/opt"), "blender", "");
    if let Some(h) = home {
        unpacked.extend(dirs_starting_with(&h.join("Applications"), "blender", ""));
    }
    for d in unpacked {
        files.push((d.join("blender"), "download"));
    }
    let mut out = Vec::new();
    for (f, source) in files {
        if is_runnable(&f) {
            push_unique(&mut out, Install { gui: f.clone(), exe: f, source });
        }
    }
    out
}

fn push_unique(list: &mut Vec<Install>, item: Install) {
    let key = std::fs::canonicalize(&item.exe).unwrap_or_else(|_| item.exe.clone());
    if !list.iter().any(|i| std::fs::canonicalize(&i.exe).unwrap_or_else(|_| i.exe.clone()) == key) {
        list.push(item);
    }
}

/// The library folders in Steam's `libraryfolders.vdf` (`"path" "D:\\Steam"`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn steam_library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('"').collect();
            // ["\t", "path", "\t\t", "D:\\SteamLibrary", ""]
            (parts.len() >= 4 && parts[1].eq_ignore_ascii_case("path")).then(|| PathBuf::from(parts[3].replace("\\\\", "\\")))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn spotlight() -> Vec<PathBuf> {
    let mut cmd = crate::process_util::foreign_system_command("/usr/bin/mdfind");
    cmd.arg("kMDItemCFBundleIdentifier == 'org.blenderfoundation.blender'");
    run_capture(cmd, SPOTLIGHT_TIMEOUT).map(|(_, out)| out.lines().map(PathBuf::from).collect()).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn windows_registered() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut out = Vec::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(un) = RegKey::predef(hive).open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall") else { continue };
        for name in un.enum_keys().flatten() {
            let Ok(k) = un.open_subkey(&name) else { continue };
            let display: String = k.get_value("DisplayName").unwrap_or_default();
            let publisher: String = k.get_value("Publisher").unwrap_or_default();
            if display.to_lowercase().starts_with("blender") && publisher.to_lowercase().contains("blender foundation") {
                let loc: String = k.get_value("InstallLocation").unwrap_or_default();
                if !loc.trim().is_empty() {
                    out.push(PathBuf::from(loc.trim().trim_matches('"')));
                }
            }
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn windows_steam_libraries() -> Vec<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(p) = k.get_value::<String, _>("SteamPath") {
            roots.push(PathBuf::from(p.replace('/', "\\")));
        }
    }
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(pf86).join("Steam"));
    }
    let mut libs = roots.clone();
    for r in &roots {
        if let Ok(vdf) = std::fs::read_to_string(r.join("steamapps").join("libraryfolders.vdf")) {
            libs.extend(steam_library_paths(&vdf));
        }
    }
    libs
}

/// Every Blender found on this computer, the most likely first.
pub fn find_all() -> Vec<Install> {
    #[cfg(target_os = "macos")]
    {
        let mut dirs = vec![PathBuf::from("/Applications")];
        if let Some(h) = dirs::home_dir() {
            dirs.push(h.join("Applications"));
        }
        mac_candidates(&dirs, &spotlight())
    }
    #[cfg(target_os = "windows")]
    {
        let mut pf: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        pf.dedup();
        windows_candidates(&windows_registered(), &pf, &windows_steam_libraries())
    }
    #[cfg(target_os = "linux")]
    {
        let path_dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        linux_candidates(dirs::home_dir().as_deref(), &path_dirs)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
}

// ── Version ─────────────────────────────────────────────────────────────────

/// "Blender 5.2.1 LTS" (first line of `--version`) or a plist's
/// "5.2.1" to "5.2.1".
pub(crate) fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let word = line.strip_prefix("Blender ").unwrap_or(line).split_whitespace().next()?;
    let ok = word.split('.').count() >= 2 && word.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| word.to_string())
}

pub(crate) fn too_old(version: &str) -> bool {
    let k = version_key(version);
    let (major, minor) = (k.first().copied().unwrap_or(0), k.get(1).copied().unwrap_or(0));
    (major, minor) < MIN_VERSION
}

fn mac_plist_version(exe: &Path) -> Option<String> {
    let plist = std::fs::read_to_string(exe.parent()?.parent()?.join("Info.plist")).ok()?;
    let after = plist.split("<key>CFBundleShortVersionString</key>").nth(1)?;
    let value = after.split("<string>").nth(1)?.split("</string>").next()?;
    parse_version(value)
}

/// Per binary: its change time when asked, and the version it gave.
type VersionCache = HashMap<PathBuf, (Option<SystemTime>, Option<String>)>;
static VERSIONS: LazyLock<Mutex<VersionCache>> = LazyLock::new(Default::default);

/// The version of one install. Asked once per binary (and again after an
/// update changes the file).
fn version_of(install: &Install) -> Option<String> {
    let stamp = std::fs::metadata(&install.exe).and_then(|m| m.modified()).ok();
    if let Some((s, v)) = VERSIONS.lock().ok()?.get(&install.exe) {
        if *s == stamp {
            return v.clone();
        }
    }
    let v = mac_plist_version(&install.exe).or_else(|| {
        let mut cmd = crate::process_util::foreign_system_command(&install.exe);
        cmd.args(["--factory-startup", "--version"]);
        crate::process_util::suppress_window(&mut cmd);
        run_capture(cmd, VERSION_TIMEOUT).ok().and_then(|(_, out)| parse_version(&out))
    });
    if let Ok(mut m) = VERSIONS.lock() {
        m.insert(install.exe.clone(), (stamp, v.clone()));
    }
    v
}

/// Run a short command, stdout as text, with a time limit.
fn run_capture(mut cmd: std::process::Command, timeout: Duration) -> Result<(bool, String), String> {
    use std::io::Read;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| crate::os_error::english(&e))?;
    let mut pipe = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = pipe.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = crate::process_util::kill_tree(&mut child);
                return Err("timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(crate::os_error::english(&e)),
        }
    };
    Ok((status.success(), reader.join().unwrap_or_default()))
}

// ── Names and arguments ─────────────────────────────────────────────────────

/// The name the model gets in Blender: printable, trimmed, at most 60 chars.
pub(crate) fn blender_name(raw: &str) -> String {
    let clean: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = clean.chars().take(MAX_NAME_CHARS).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() { "LU model".into() } else { cut }
}

/// A file name part from the model's name: ASCII letters, digits, dashes.
pub(crate) fn file_stem(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "lu-model".into() } else { out }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Blend,
    Fbx,
}

impl Format {
    pub(crate) fn parse(s: &str) -> Result<Self, String> {
        match s {
            "blend" => Ok(Self::Blend),
            "fbx" => Ok(Self::Fbx),
            _ => Err(format!("Blender cannot make a {s} file here.")),
        }
    }
    fn ext(self) -> &'static str {
        match self {
            Self::Blend => "blend",
            Self::Fbx => "fbx",
        }
    }
}

/// Background run: no window, factory settings (the user's preferences and
/// add-ons are neither read nor written), a failed script exits 1.
pub(crate) fn background_args(script: &Path, format: Format, glb: &Path, name: &str, out: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["-b", "--factory-startup", "--python-exit-code", "1", "-P"].iter().map(OsString::from).collect();
    a.push(script.into());
    a.push("--".into());
    a.push(format.ext().into());
    a.push(glb.into());
    a.push(name.into());
    a.push(out.into());
    a
}

/// The window the user works in: their own Blender with their own settings.
pub(crate) fn open_args(script: &Path, glb: &Path, name: &str) -> Vec<OsString> {
    vec!["--python".into(), script.into(), "--".into(), "open".into(), glb.into(), name.into()]
}

pub(crate) fn is_glb(bytes: &[u8]) -> bool {
    bytes.len() >= 20 && bytes.len() <= MAX_GLB_BYTES && &bytes[..4] == b"glTF" && u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) == 2
}

/// The `LU_BLENDER {json}` line the script prints last.
pub(crate) fn parse_report(stdout: &str) -> Option<serde_json::Value> {
    stdout.lines().rev().find_map(|l| l.strip_prefix("LU_BLENDER ")).and_then(|j| serde_json::from_str(j).ok())
}

// ── Files ───────────────────────────────────────────────────────────────────

fn create_private_dir(dir: &Path) -> Result<(), String> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir).map_err(|e| format!("Could not make LU's Blender folder: {}", crate::os_error::english(&e)))
}

/// Write a file under a hidden name, then move it into place.
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_file_name(format!(".{}.part", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Could not save the model for Blender: {}", crate::os_error::english(&e))
        })
}

/// Keep the newest `keep` models in the "Open in Blender" folder.
pub(crate) fn prune_opened(dir: &Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut glbs: Vec<(SystemTime, PathBuf)> = read
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "glb"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    glbs.sort_by_key(|g| std::cmp::Reverse(g.0));
    for (_, p) in glbs.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// Removes a conversion's work folder however the run ends.
struct WorkDir(PathBuf);
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── Runs ────────────────────────────────────────────────────────────────────

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

fn first_usable() -> Result<(Install, Option<String>), String> {
    let all = find_all();
    let first = all.first().cloned().ok_or_else(|| NOT_FOUND.to_string())?;
    // A newer install wins over an older one that happens to come first.
    let mut best = (first.clone(), version_of(&first));
    for i in all.into_iter().skip(1) {
        let v = version_of(&i);
        if best.1.as_deref().is_none_or(too_old) && v.as_deref().is_some_and(|v| !too_old(v)) {
            best = (i, v);
        }
    }
    if let Some(v) = best.1.as_deref() {
        if too_old(v) {
            return Err(format!("Your Blender is {v}. LU needs Blender {}.{} or newer.", MIN_VERSION.0, MIN_VERSION.1));
        }
    }
    Ok(best)
}

pub(crate) fn convert_blocking(root: &Path, job: &str, format: Format, name: &str, glb: &[u8]) -> Result<Vec<u8>, String> {
    convert_with(root, job, format, name, glb, &first_usable()?.0, CONVERT_TIMEOUT)
}

fn convert_with(root: &Path, job: &str, format: Format, name: &str, glb: &[u8], install: &Install, timeout: Duration) -> Result<Vec<u8>, String> {
    if !is_glb(glb) {
        return Err(NOT_A_MODEL.into());
    }
    let name = blender_name(name);
    let dir = root.join("work").join(uuid::Uuid::new_v4().simple().to_string());
    create_private_dir(&dir)?;
    let _cleanup = WorkDir(dir.clone());
    let src = dir.join("model.glb");
    let script = dir.join(SCRIPT_NAME);
    let out = dir.join(format!("model.{}", format.ext()));
    write_file(&src, glb)?;
    write_file(&script, SCRIPT.as_bytes())?;
    let log_out = std::fs::File::create(dir.join("stdout.txt")).map_err(|e| crate::os_error::english(&e))?;
    let log_err = std::fs::File::create(dir.join("stderr.txt")).map_err(|e| crate::os_error::english(&e))?;

    let mut cmd = crate::process_util::foreign_system_command(&install.exe);
    cmd.args(background_args(&script, format, &src, &name, &out))
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(log_out)
        .stderr(log_err);
    crate::process_util::suppress_window(&mut cmd);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut jobs) = JOBS.lock() {
        jobs.insert(job.to_string(), cancel.clone());
    }
    let result = (|| {
        let mut child = cmd.spawn().map_err(|e| format!("Could not start Blender: {}", crate::os_error::english(&e)))?;
        wait_or_stop(&mut child, &cancel, timeout)
    })();
    if let Ok(mut jobs) = JOBS.lock() {
        jobs.remove(job);
    }
    let success = result?;
    let stdout = std::fs::read_to_string(dir.join("stdout.txt")).unwrap_or_default();
    let report = parse_report(&stdout);
    let ok = report.as_ref().and_then(|r| r.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !success || !ok {
        let reason = report.as_ref().and_then(|r| r.get("error")).and_then(|v| v.as_str()).map(str::to_string);
        tracing::warn!(target: "blender", ?reason, "blender convert failed");
        return Err(match reason {
            Some(r) if !r.is_empty() => format!("Blender could not make the file: {r}"),
            _ => "Blender could not make the file.".to_string(),
        });
    }
    tracing::info!(target: "blender", format = format.ext(), report = %report.unwrap_or_default(), "blender convert done");
    std::fs::read(&out).map_err(|_| "Blender finished but wrote no file.".to_string())
}

fn wait_or_stop(child: &mut Child, cancel: &AtomicBool, timeout: Duration) -> Result<bool, String> {
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = crate::process_util::kill_tree(child);
            return Err(CANCELLED.into());
        }
        match child.try_wait() {
            Ok(Some(s)) => return Ok(s.success()),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = crate::process_util::kill_tree(child);
                return Err(format!("Blender took longer than {} minutes and was stopped.", timeout.as_secs() / 60));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(crate::os_error::english(&e)),
        }
    }
}

pub(crate) fn cancel_job(job: &str) -> bool {
    JOBS.lock().ok().and_then(|j| j.get(job).cloned()).map(|c| c.store(true, Ordering::SeqCst)).is_some()
}

pub(crate) fn open_blocking(root: &Path, name: &str, glb: &[u8]) -> Result<u32, String> {
    open_with(root, name, glb, &first_usable()?.0)
}

fn open_with(root: &Path, name: &str, glb: &[u8], install: &Install) -> Result<u32, String> {
    if !is_glb(glb) {
        return Err(NOT_A_MODEL.into());
    }
    let name = blender_name(name);
    let dir = root.join("open");
    create_private_dir(&dir)?;
    let short = uuid::Uuid::new_v4().simple().to_string();
    let src = dir.join(format!("{}-{}.glb", file_stem(&name), &short[..8]));
    write_file(&src, glb)?;
    let script = dir.join(SCRIPT_NAME);
    write_file(&script, SCRIPT.as_bytes())?;
    prune_opened(&dir, KEEP_OPENED);

    let mut cmd = crate::process_util::foreign_system_command(&install.gui);
    cmd.args(open_args(&script, &src, &name)).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        // Its own process group: closing LU does not close the user's Blender.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // blender.exe without its launcher would open a console window.
        let flags = if install.gui == install.exe { crate::process_util::no_window() } else { DETACHED_PROCESS };
        cmd.creation_flags(flags | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Blender: {}", crate::os_error::english(&e)))?;
    let pid = child.id();
    // LU does not wait for Blender; this only collects the exit so no zombie stays.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    tracing::info!(target: "blender", pid, "opened a model in Blender");
    Ok(pid)
}

fn blender_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| crate::os_error::english(&e))?.join("blender"))
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlenderStatus {
    pub found: bool,
    pub version: Option<String>,
    pub too_old: bool,
    pub source: Option<String>,
}

#[tauri::command]
pub async fn blender_status() -> Result<BlenderStatus, String> {
    tokio::task::spawn_blocking(|| {
        Ok(match first_usable() {
            Ok((i, v)) => BlenderStatus { found: true, version: v, too_old: false, source: Some(i.source.into()) },
            Err(e) if e == NOT_FOUND => BlenderStatus { found: false, version: None, too_old: false, source: None },
            Err(_) => {
                let i = find_all().into_iter().next();
                let v = i.as_ref().and_then(version_of);
                BlenderStatus { found: true, version: v, too_old: true, source: i.map(|i| i.source.to_string()) }
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn header(request: &tauri::ipc::Request<'_>, key: &str) -> String {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok())
        .map(|v| v.into_owned())
        .unwrap_or_default()
}

fn body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err(NOT_A_MODEL.into()),
    }
}

/// Body: the GLB. Header `x-lu-name`: the model's name (URI-encoded).
/// Answers the process id of the Blender it started.
#[tauri::command]
pub async fn blender_open(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<u32, String> {
    let glb = body(&request)?;
    let name = header(&request, "x-lu-name");
    let root = blender_root(&app)?;
    tokio::task::spawn_blocking(move || open_blocking(&root, &name, &glb)).await.map_err(|e| e.to_string())?
}

/// Body: the GLB. Headers `x-lu-name`, `x-lu-format` (blend or fbx) and
/// `x-lu-job` (for `blender_cancel`). Answers the bytes of the file.
#[tauri::command]
pub async fn blender_convert(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let glb = body(&request)?;
    let name = header(&request, "x-lu-name");
    let job = header(&request, "x-lu-job");
    let format = Format::parse(&header(&request, "x-lu-format"))?;
    let root = blender_root(&app)?;
    let bytes = tokio::task::spawn_blocking(move || convert_blocking(&root, &job, format, &name, &glb))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn blender_cancel(job: String) -> bool {
    cancel_job(&job)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[cfg(unix)]
    fn exe(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn exe(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn mac_app(dir: &Path, name: &str, bundle: &str, version: &str) -> PathBuf {
        let app = dir.join(name);
        exe(&app.join("Contents/MacOS/Blender"));
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!("<plist><dict><key>CFBundleIdentifier</key>\n\t<string>{bundle}</string>\n<key>CFBundleShortVersionString</key>\n\t<string>{version}</string></dict></plist>"),
        )
        .unwrap();
        app
    }

    #[test]
    fn mac_finds_blender_bundles_and_nothing_that_only_has_the_name() {
        let t = tmp();
        let apps = t.path().join("Applications");
        mac_app(&apps, "Blender.app", "org.blenderfoundation.blender", "5.2.1");
        mac_app(&apps, "Blender 4.2.app", "org.blenderfoundation.blender", "4.2.0");
        mac_app(&apps, "Blender Helper.app", "com.example.notblender", "1.0");
        let found = mac_candidates(std::slice::from_ref(&apps), &[]);
        let names: Vec<String> = found.iter().map(|i| i.exe.to_string_lossy().into_owned()).collect();
        assert_eq!(found.len(), 2, "{names:?}");
        assert!(names[0].contains("/Blender.app/"));
        assert!(names[1].contains("/Blender 4.2.app/"));
        assert_eq!(mac_plist_version(&found[0].exe).as_deref(), Some("5.2.1"));
    }

    #[test]
    fn mac_skips_spotlight_hits_in_the_trash_or_on_a_disk_image() {
        let t = tmp();
        let trash = mac_app(&t.path().join(".Trash"), "Blender.app", "org.blenderfoundation.blender", "5.0");
        assert!(!mac_place_ok(&trash));
        assert!(!mac_place_ok(Path::new("/Volumes/Blender/Blender.app")));
        let other = mac_app(&t.path().join("Tools"), "Blender.app", "org.blenderfoundation.blender", "5.0");
        assert_eq!(mac_candidates(&[], &[trash, other.clone()]).len(), 1);
    }

    #[test]
    fn windows_prefers_the_registered_install_and_the_launcher_for_the_window() {
        let t = tmp();
        let pf = t.path().join("Program Files");
        exe(&pf.join("Blender Foundation/Blender 4.2/blender.exe"));
        exe(&pf.join("Blender Foundation/Blender 5.2/blender.exe"));
        exe(&pf.join("Blender Foundation/Blender 5.2/blender-launcher.exe"));
        let steam = t.path().join("SteamLibrary");
        exe(&steam.join("steamapps/common/Blender/blender.exe"));
        let found = windows_candidates(&[], std::slice::from_ref(&pf), std::slice::from_ref(&steam));
        assert_eq!(found.len(), 3);
        assert!(found[0].exe.to_string_lossy().contains("Blender 5.2"), "newest first: {:?}", found[0]);
        assert!(found[0].gui.ends_with("blender-launcher.exe"));
        assert_eq!(found[2].source, "steam");
        assert_eq!(found[2].gui, found[2].exe, "no launcher, the exe opens the window");
        let registered = windows_candidates(&[pf.join("Blender Foundation/Blender 4.2")], std::slice::from_ref(&pf), &[]);
        assert_eq!(registered[0].source, "installer");
        assert_eq!(registered.len(), 2, "the same install is listed once");
    }

    #[test]
    fn steam_library_folders_are_read_from_the_vdf() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}";
        let libs = steam_library_paths(vdf);
        assert_eq!(libs, vec![PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("D:\\SteamLibrary")]);
    }

    #[cfg(unix)]
    #[test]
    fn linux_finds_path_flatpak_and_steam_but_not_a_plain_file() {
        let t = tmp();
        let home = t.path().join("home");
        let bin = t.path().join("bin");
        exe(&bin.join("blender"));
        exe(&home.join(".local/share/flatpak/exports/bin/org.blender.Blender"));
        exe(&home.join(".steam/steam/steamapps/common/Blender/blender"));
        exe(&home.join("Applications/blender-5.2.1-linux-x64/blender"));
        let not_runnable = t.path().join("other/blender");
        std::fs::create_dir_all(not_runnable.parent().unwrap()).unwrap();
        std::fs::write(&not_runnable, b"x").unwrap();
        let found = linux_candidates(Some(&home), &[bin.clone(), not_runnable.parent().unwrap().to_path_buf()]);
        let ours: Vec<&Install> = found.iter().filter(|i| i.exe.starts_with(t.path())).collect();
        let sources: Vec<&str> = ours.iter().map(|i| i.source).collect();
        assert_eq!(sources, vec!["path", "flatpak", "steam", "download"], "{ours:?}");
        assert_eq!(ours[0].exe, bin.join("blender"));
    }

    #[test]
    fn versions_are_read_and_old_ones_refused() {
        assert_eq!(parse_version("Blender 5.2.1 LTS\n\tbuild date: 2026-08-25\n").as_deref(), Some("5.2.1"));
        assert_eq!(parse_version("\nBlender 3.6.0\n").as_deref(), Some("3.6.0"));
        assert_eq!(parse_version("4.2").as_deref(), Some("4.2"));
        assert_eq!(parse_version("Read prefs: x"), None);
        assert_eq!(parse_version(""), None);
        assert!(too_old("2.93.1"));
        assert!(too_old("3.2.0"));
        assert!(!too_old("3.3.0"));
        assert!(!too_old("5.2.1"));
        assert!(!too_old("4.10"));
    }

    #[test]
    fn names_stay_names() {
        assert_eq!(blender_name("  a red\tmug \n"), "a red mug");
        assert_eq!(blender_name("\u{1b}[31mred"), "[31mred");
        assert_eq!(blender_name(""), "LU model");
        assert_eq!(blender_name(&"x".repeat(200)).chars().count(), 60);
        assert_eq!(file_stem("A small, friendly Robot!"), "a-small-friendly-robot");
        assert_eq!(file_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(file_stem("日本"), "lu-model");
        assert!(file_stem(&"ab ".repeat(100)).len() <= 41);
    }

    #[test]
    fn background_runs_never_touch_the_users_settings_and_take_paths_as_data() {
        let a = background_args(Path::new("/s/lu_blender.py"), Format::Fbx, Path::new("/w/model.glb"), "--python evil.py", Path::new("/w/model.fbx"));
        let a: Vec<String> = a.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(a[..5], ["-b", "--factory-startup", "--python-exit-code", "1", "-P"]);
        assert_eq!(a[5], "/s/lu_blender.py");
        let sep = a.iter().position(|s| s == "--").unwrap();
        assert_eq!(sep, 6, "every value comes after --, where Blender stops reading options");
        assert_eq!(a[sep + 1..], ["fbx", "/w/model.glb", "--python evil.py", "/w/model.fbx"]);

        let o: Vec<String> = open_args(Path::new("/s/lu_blender.py"), Path::new("/o/m.glb"), "Mug").iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(o, ["--python", "/s/lu_blender.py", "--", "open", "/o/m.glb", "Mug"]);
        assert!(!o.iter().any(|s| s == "--factory-startup"), "the window is the user's own Blender");
    }

    #[test]
    fn the_script_reads_its_arguments_as_data_only() {
        for bad in ["eval(", "exec(", "compile(", "__import__", "subprocess", "os.system", "--python-expr"] {
            assert!(!SCRIPT.contains(bad), "blender_lu.py contains {bad}");
        }
        assert!(SCRIPT.contains("import_scene.gltf"));
        assert!(SCRIPT.contains("pack_all"));
        assert!(SCRIPT.contains("embed_textures=True"));
    }

    #[test]
    fn only_glb_files_go_to_blender() {
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend([0u8; 12]);
        assert!(is_glb(&glb));
        assert!(!is_glb(b"glTF"));
        assert!(!is_glb(b"<?php system($_GET['c']); ?>........"));
        let mut v1 = glb.clone();
        v1[4] = 1;
        assert!(!is_glb(&v1));
    }

    #[test]
    fn formats_and_reports() {
        assert_eq!(Format::parse("blend"), Ok(Format::Blend));
        assert_eq!(Format::parse("fbx"), Ok(Format::Fbx));
        assert!(Format::parse("py").is_err());
        let out = "Read blend\nLU_BLENDER {\"ok\": true, \"objects\": 1}\nBlender quit\n";
        assert_eq!(parse_report(out).unwrap()["objects"], 1);
        assert!(parse_report("nothing").is_none());
    }

    #[test]
    fn only_the_newest_opened_models_stay() {
        let t = tmp();
        for i in 0..5 {
            let p = t.path().join(format!("m{i}.glb"));
            std::fs::write(&p, b"x").unwrap();
            let when = SystemTime::now() - Duration::from_secs(100 - i * 10);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(when).unwrap();
        }
        std::fs::write(t.path().join(SCRIPT_NAME), b"x").unwrap();
        prune_opened(t.path(), 2);
        let mut left: Vec<String> = std::fs::read_dir(t.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["lu_blender.py", "m3.glb", "m4.glb"]);
    }

    #[test]
    fn a_missing_or_failing_blender_is_an_error_and_leaves_no_files() {
        let t = tmp();
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend([0u8; 12]);
        let gone = Install { exe: t.path().join("nope/blender"), gui: t.path().join("nope/blender"), source: "test" };
        let err = convert_with(t.path(), "j1", Format::Blend, "x", &glb, &gone, Duration::from_secs(5)).unwrap_err();
        assert!(err.starts_with("Could not start Blender"), "{err}");
        assert_eq!(std::fs::read_dir(t.path().join("work")).unwrap().count(), 0, "the work folder is cleaned up");
        assert!(convert_with(t.path(), "j2", Format::Blend, "x", b"not a model", &gone, Duration::from_secs(5)).unwrap_err() == NOT_A_MODEL);
    }

    #[cfg(unix)]
    #[test]
    fn a_run_can_be_stopped_and_a_slow_one_times_out() {
        let t = tmp();
        let fake = t.path().join("bin/blender");
        std::fs::create_dir_all(fake.parent().unwrap()).unwrap();
        std::fs::write(&fake, b"#!/bin/sh\nsleep 30\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let install = Install { exe: fake.clone(), gui: fake, source: "test" };
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend([0u8; 12]);
        let root = t.path().to_path_buf();
        let i2 = install.clone();
        let g2 = glb.clone();
        let started = Instant::now();
        let run = std::thread::spawn(move || convert_with(&root, "stop-me", Format::Fbx, "x", &g2, &i2, Duration::from_secs(60)));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cancel_job("stop-me") {
            assert!(Instant::now() < deadline, "the job never registered");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(run.join().unwrap().unwrap_err(), CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!cancel_job("stop-me"), "a finished job is gone");

        let err = convert_with(t.path(), "slow", Format::Blend, "x", &glb, &install, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("took longer"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_script_that_reports_failure_is_an_error() {
        let t = tmp();
        let fake = t.path().join("bin/blender");
        std::fs::create_dir_all(fake.parent().unwrap()).unwrap();
        std::fs::write(&fake, b"#!/bin/sh\necho 'LU_BLENDER {\"ok\": false, \"error\": \"The model file holds nothing to show.\"}'\nexit 1\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let install = Install { exe: fake.clone(), gui: fake, source: "test" };
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend([0u8; 12]);
        let err = convert_with(t.path(), "f", Format::Blend, "x", &glb, &install, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err, "Blender could not make the file: The model file holds nothing to show.");
    }

    /// Opens the real Blender with its window and prints its process id, for
    /// a look and a screenshot; whoever runs it closes that one Blender.
    /// LU_BLENDER_TEST_GLB as above, LU_BLENDER_TEST_ROOT a folder of one's own.
    #[test]
    #[ignore]
    fn real_blender_opens_a_window() {
        let (Ok(path), Ok(root)) = (std::env::var("LU_BLENDER_TEST_GLB"), std::env::var("LU_BLENDER_TEST_ROOT")) else { return };
        let glb = std::fs::read(path).unwrap();
        let (install, _) = first_usable().expect("no Blender on this computer");
        let pid = open_with(Path::new(&root), "LU test chair", &glb, &install).unwrap();
        eprintln!("BLENDER_PID {pid}");
        let opened: Vec<_> = std::fs::read_dir(Path::new(&root).join("open")).unwrap().flatten().map(|e| e.file_name()).collect();
        eprintln!("opened folder: {opened:?}");
    }

    /// The real Blender of this computer, when there is one:
    /// `cargo test --lib blender -- --ignored`. Set LU_BLENDER_TEST_GLB to a
    /// GLB made by LU.
    #[test]
    #[ignore]
    fn real_blender_makes_a_blend_and_an_fbx() {
        let Ok(path) = std::env::var("LU_BLENDER_TEST_GLB") else { return };
        let glb = std::fs::read(path).unwrap();
        let (install, version) = first_usable().expect("no Blender on this computer");
        eprintln!("Blender {version:?} at {}", install.exe.display());
        let t = tmp();
        for format in [Format::Blend, Format::Fbx] {
            let started = Instant::now();
            let out = convert_with(t.path(), "real", format, "LU test model", &glb, &install, CONVERT_TIMEOUT).unwrap();
            eprintln!("{} {} bytes in {:?}", format.ext(), out.len(), started.elapsed());
            match format {
                Format::Blend => assert!(out.starts_with(b"BLENDER") || out.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]), "a .blend (plain or zstd)"),
                Format::Fbx => assert!(out.starts_with(b"Kaydara FBX Binary"), "a binary FBX"),
            }
        }
    }
}
