//! Git per Knopf, für einen Rechner ohne git (3.1.3, Davids Wunsch 21.11.).
//!
//! Auf einem frischen Windows bricht die ComfyUI-Installation ab, weil
//! `git clone` nicht da ist. Statt auf eine Webseite zu schicken, holt
//! „Install Git“ das, was das Betriebssystem ohne Adminrechte hergibt:
//!
//! * Windows: MinGit, die offizielle portable Ausgabe von Git for Windows
//!   (Releases von git-for-windows/git auf GitHub), Version und SHA-256 hier
//!   fest. Es wird in den LU-Datenordner entpackt (`<data>/git`), nichts wird
//!   im System installiert. LU stellt `<data>/git/cmd` in seinem eigenen
//!   PATH nach vorn, beim Start und gleich nach der Installation; so finden
//!   alle git-Aufrufe (Klon, Update, Custom Nodes, pip mit `git+`) und der
//!   ComfyUI-Prozess dieses git, ohne dass eine Aufrufstelle es kennen muss.
//! * Mac: `xcode-select --install` öffnet den Dialog von macOS für die
//!   Command Line Tools, darin ist git. LU wartet, bis `git --version` geht.
//! * Linux: LU ruft nichts mit Root auf. Es nennt den Paketbefehl der
//!   Distribution zum Kopieren.
//!
//! Der Zustand läuft durch einen eigenen `InstallState` (`AppState::git_install`)
//! und wird wie die anderen Installer abgefragt (`install_git_status`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::State;

use crate::os_error;
use crate::state::{AppState, InstallState};

/// The MinGit release LU fetches. Read from the release page and the GitHub
/// API (asset digest) on 21.11.2026; both name the same SHA-256.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const MINGIT_VERSION: &str = "2.56.1";

/// One MinGit archive: where it lives, its exact size and its SHA-256.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MinGit {
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub(crate) const MINGIT_X64: MinGit = MinGit {
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip",
    bytes: 39_849_768,
    sha256: "4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd",
};

pub(crate) const MINGIT_ARM64: MinGit = MinGit {
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-arm64.zip",
    bytes: 37_983_254,
    sha256: "96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c",
};

/// The archive for this processor (`std::env::consts::ARCH`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn mingit_for(arch: &str) -> Option<&'static MinGit> {
    match arch {
        "x86_64" => Some(&MINGIT_X64),
        "aarch64" => Some(&MINGIT_ARM64),
        _ => None,
    }
}

/// Where LU's own git lives: `<data>/git`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn root_in(data: &Path) -> PathBuf {
    data.join("git")
}

/// The folder that goes on PATH: MinGit's `cmd`, which holds the `git.exe`
/// meant to be called from outside.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn cmd_dir_in(root: &Path) -> PathBuf {
    root.join("cmd")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn git_exe_in(root: &Path) -> PathBuf {
    cmd_dir_in(root).join("git.exe")
}

/// `current` PATH with `dir` in front, and nowhere else in it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn path_with_first(dir: &Path, current: Option<&std::ffi::OsStr>) -> Result<OsString, String> {
    let rest = current.map(|c| std::env::split_paths(c).collect::<Vec<_>>()).unwrap_or_default();
    let all = std::iter::once(dir.to_path_buf()).chain(rest.into_iter().filter(|p| p != dir && !p.as_os_str().is_empty()));
    std::env::join_paths(all).map_err(|e| format!("PATH: {e}"))
}

/// Windows: when LU's own git is there, put its `cmd` folder first on the
/// PATH of this process, which every child inherits. Called at start and
/// right after an install. Returns whether it did.
pub(crate) fn put_own_git_on_path() -> bool {
    #[cfg(target_os = "windows")]
    {
        let root = root_in(&crate::os_paths::data_dir());
        if !git_exe_in(&root).is_file() {
            return false;
        }
        match path_with_first(&cmd_dir_in(&root), std::env::var_os("PATH").as_deref()) {
            Ok(path) => {
                std::env::set_var("PATH", path);
                tracing::info!("[git] LU's own git is on PATH: {}", cmd_dir_in(&root).display());
                true
            }
            Err(e) => {
                tracing::warn!("[git] could not put LU's own git on PATH: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// The downloaded archive is the one pinned above: exact size, then SHA-256.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn verify_archive(path: &Path, want: &MinGit) -> Result<(), String> {
    let bytes = std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| format!("The Git download is missing: {}", os_error::english(&e)))?;
    let refuse = "The downloaded Git did not match the expected file, so LU did not use it. Press Install Git to try again.";
    if bytes != want.bytes {
        tracing::warn!("[git] MinGit has {bytes} bytes, expected {}", want.bytes);
        return Err(refuse.to_string());
    }
    let got = super::download::sha256_file(path)?;
    if !super::download::digest_matches(want.sha256, &got) {
        tracing::warn!("[git] MinGit sha256 {got}, expected {}", want.sha256);
        return Err(refuse.to_string());
    }
    Ok(())
}

/// Unpack `zip` into `dest` (made fresh). Entries whose names would leave
/// `dest` are refused, not skipped: a MinGit archive has none.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn unpack(zip: &Path, dest: &Path) -> Result<(), String> {
    let fail = |e: &dyn std::fmt::Display| format!("Unpacking Git did not work: {e}");
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| fail(&os_error::english(&e)))?;
    }
    std::fs::create_dir_all(dest).map_err(|e| fail(&os_error::english(&e)))?;
    let file = std::fs::File::open(zip).map_err(|e| fail(&os_error::english(&e)))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| fail(&e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| fail(&e))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(fail(&format!("the archive names a path outside its folder ({})", entry.name().map(|n| n.to_string()).unwrap_or_default())));
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| fail(&os_error::english(&e)))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| fail(&os_error::english(&e)))?;
        }
        let mut to = std::fs::File::create(&out).map_err(|e| fail(&os_error::english(&e)))?;
        std::io::copy(&mut entry, &mut to).map_err(|e| fail(&os_error::english(&e)))?;
    }
    Ok(())
}

/// Swap a freshly unpacked `staged` folder in as `root`: the old one goes
/// only once the new one is complete.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn take_staged(staged: &Path, root: &Path) -> Result<(), String> {
    if !git_exe_in(staged).is_file() {
        return Err("The Git archive has no cmd\\git.exe, so LU did not use it.".to_string());
    }
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(|e| format!("Could not replace the old Git folder: {}", os_error::english(&e)))?;
    }
    std::fs::rename(staged, root).map_err(|e| format!("Could not move Git into place: {}", os_error::english(&e)))
}

/// Download, check, unpack and put on PATH. Windows only in production; the
/// pieces above are tested on every host.
#[cfg(target_os = "windows")]
fn install_mingit(state: &Arc<Mutex<InstallState>>, log: &dyn Fn(&str, &str)) -> Result<String, String> {
    let asset = mingit_for(std::env::consts::ARCH)
        .ok_or_else(|| format!("LU has Git for x64 and ARM64 Windows; this one is {}.", std::env::consts::ARCH))?;
    let data = crate::os_paths::data_dir();
    let work = data.join("git-download");
    let staged = data.join("git.new");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("Could not make a folder for the Git download: {}", os_error::english(&e)))?;
    let zip = work.join(format!("MinGit-{MINGIT_VERSION}.zip"));
    log("downloading", &format!("Downloading Git {MINGIT_VERSION} (about {} MB)...", asset.bytes / 1_000_000));
    let result = (|| {
        super::download::download_file_blocking(asset.url, &zip, state)
            .map_err(|e| format!("Downloading Git did not work ({e}). Check the internet connection and press Install Git again."))?;
        verify_archive(&zip, asset)?;
        log("installing", "Unpacking Git...");
        unpack(&zip, &staged)?;
        take_staged(&staged, &root_in(&data))?;
        put_own_git_on_path();
        super::git::git_version_string().ok_or_else(|| "Git was unpacked but does not start. Press Install Git to try again.".to_string())
    })();
    let _ = std::fs::remove_dir_all(&work);
    let _ = std::fs::remove_dir_all(&staged);
    result
}

fn busy(status: &str) -> bool {
    matches!(status, "downloading" | "installing")
}

/// "Install Git": what this system allows without admin rights.
#[tauri::command]
pub fn install_git(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let slot = state.git_install.clone();
    {
        let mut s = slot.lock().unwrap_or_else(|e| e.into_inner());
        if busy(&s.status) {
            return Ok(json!({ "status": "already_installing" }));
        }
        *s = InstallState::default();
    }
    let log = {
        let slot = slot.clone();
        move |status: &str, line: &str| {
            let mut s = slot.lock().unwrap_or_else(|e| e.into_inner());
            s.status = status.to_string();
            s.phase = line.to_string();
            s.logs.push(line.to_string());
        }
    };

    #[cfg(target_os = "windows")]
    {
        log("downloading", "Getting Git...");
        std::thread::spawn(move || match install_mingit(&slot, &log) {
            Ok(version) => {
                tracing::info!("[git] {version} installed into the LU data folder");
                log("complete", &format!("{version} is ready."));
            }
            Err(e) => {
                tracing::error!("[git] install failed: {e}");
                log("error", &e);
            }
        });
        Ok(json!({ "status": "downloading" }))
    }
    #[cfg(target_os = "macos")]
    {
        if super::git::is_git_present() {
            log("complete", "Git is ready.");
            return Ok(json!({ "status": "complete" }));
        }
        match crate::process_util::foreign_system_command("xcode-select").arg("--install").output() {
            Ok(_) => {
                log(
                    "installing",
                    "macOS asks to install its Command Line Tools, which include Git. Press Install in that window; it takes a few minutes.",
                );
                Ok(json!({ "status": "installing" }))
            }
            Err(e) => {
                let why = format!("Could not ask macOS for its Command Line Tools: {}", os_error::english(&e));
                log("error", &why);
                Ok(json!({ "status": "error", "error": why }))
            }
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let os_release = super::git::read_os_release();
        log("manual", &super::git::linux_git_missing_message(&os_release));
        Ok(json!({ "status": "manual", "command": super::git::linux_git_command(&os_release) }))
    }
}

/// The state of "Install Git". `installed` is asked fresh, so a Mac whose
/// Command Line Tools finished, or a Linux after the copied command, reads
/// as complete.
#[tauri::command]
pub fn install_git_status(state: State<'_, AppState>) -> serde_json::Value {
    let installed = super::git::is_git_present();
    let mut s = state.git_install.lock().unwrap_or_else(|e| e.into_inner());
    if installed && matches!(s.status.as_str(), "installing" | "manual") {
        s.status = "complete".to_string();
        s.logs.push("Git is ready.".to_string());
    }
    let mut answer = serde_json::to_value(&*s).unwrap_or_else(|_| json!({}));
    answer["installed"] = json!(installed);
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        answer["command"] = json!(super::git::linux_git_command(&super::git::read_os_release()));
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn the_pinned_archives_are_the_official_mingit_of_this_version() {
        for (asset, arch) in [(&MINGIT_X64, "64-bit"), (&MINGIT_ARM64, "arm64")] {
            assert_eq!(
                asset.url,
                format!("https://github.com/git-for-windows/git/releases/download/v{MINGIT_VERSION}.windows.1/MinGit-{MINGIT_VERSION}-{arch}.zip")
            );
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.sha256.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
            assert!(asset.bytes > 30_000_000 && asset.bytes < 60_000_000);
        }
        assert_eq!(mingit_for("x86_64"), Some(&MINGIT_X64));
        assert_eq!(mingit_for("aarch64"), Some(&MINGIT_ARM64));
        assert_eq!(mingit_for("x86"), None);
    }

    #[test]
    fn the_checksum_decides_and_a_wrong_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("MinGit.zip");
        std::fs::write(&file, b"hello git").unwrap();
        let good: &'static str = Box::leak(super::super::download::sha256_file(&file).unwrap().into_boxed_str());
        let want = MinGit { url: "u", bytes: 9, sha256: good };
        assert_eq!(verify_archive(&file, &want), Ok(()));
        let wrong_sum = MinGit { url: "u", bytes: 9, sha256: "0000000000000000000000000000000000000000000000000000000000000000" };
        assert!(verify_archive(&file, &wrong_sum).unwrap_err().contains("did not match"));
        let wrong_size = MinGit { url: "u", bytes: 10, sha256: good };
        assert!(verify_archive(&file, &wrong_size).unwrap_err().contains("did not match"));
        assert!(verify_archive(&dir.path().join("absent.zip"), &want).unwrap_err().contains("missing"));
    }

    #[test]
    fn git_lives_in_the_data_folder_and_its_cmd_goes_first_on_path() {
        let data = Path::new("/data/lu-labs");
        let root = root_in(data);
        assert_eq!(root, data.join("git"));
        assert_eq!(git_exe_in(&root), data.join("git").join("cmd").join("git.exe"));
        let cmd = cmd_dir_in(&root);
        let current = std::env::join_paths([Path::new("/usr/bin"), cmd.as_path(), Path::new("/bin")]).unwrap();
        let path = path_with_first(&cmd, Some(&current)).unwrap();
        let parts: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(parts, vec![cmd.clone(), PathBuf::from("/usr/bin"), PathBuf::from("/bin")], "first, and only once");
        let alone: Vec<_> = std::env::split_paths(&path_with_first(&cmd, None).unwrap()).collect();
        assert_eq!(alone, vec![cmd]);
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut w = zip::ZipWriter::new(file.reopen().unwrap());
        for (name, body) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap();
        file
    }

    #[test]
    fn an_archive_is_unpacked_staged_and_swapped_in_whole() {
        let dir = tempfile::tempdir().unwrap();
        let zip = zip_with(&[("cmd/git.exe", b"MZ"), ("mingw64/bin/git.exe", b"MZ"), ("etc/gitconfig", b"[core]")]);
        let staged = dir.path().join("git.new");
        let root = root_in(dir.path());
        std::fs::create_dir_all(root.join("old")).unwrap();
        unpack(zip.path(), &staged).unwrap();
        take_staged(&staged, &root).unwrap();
        assert!(git_exe_in(&root).is_file());
        assert!(root.join("etc/gitconfig").is_file());
        assert!(!root.join("old").exists(), "the old git is replaced");
        assert!(!staged.exists());
    }

    #[test]
    fn an_archive_without_git_or_with_a_path_outside_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("git.new");
        let root = root_in(dir.path());
        unpack(zip_with(&[("readme.txt", b"x")]).path(), &staged).unwrap();
        assert!(take_staged(&staged, &root).unwrap_err().contains("git.exe"));
        assert!(!root.exists(), "nothing half put in place");
        let evil = zip_with(&[("../evil.exe", b"MZ")]);
        assert!(unpack(evil.path(), &staged).unwrap_err().contains("outside"));
        assert!(!dir.path().join("evil.exe").exists());
    }
}
