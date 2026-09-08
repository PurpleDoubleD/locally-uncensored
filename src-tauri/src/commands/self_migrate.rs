//! Moving an install the updater plugin cannot serve onto an AppImage it can.
//!
//! `install_method.rs` answers who owns the running file. Three of its answers
//! mean the plugin's install path would fail or would be wrong:
//!
//! * `pacman`: the AUR package `locally-uncensored-bin` unpacks our `.deb`
//!   into `/usr`, the binary keeps the `DEB` marker the bundler patched in, and
//!   the plugin runs `pkexec dpkg -i` on a box with no dpkg. Even with dpkg it
//!   would write past the pacman database.
//! * `unknown` on Linux: the same deb, hand unpacked, with no package manager
//!   claiming the files.
//! * `appimage` in a folder the user cannot write to: the plugin's first step
//!   is a `rename` inside that folder and it fails with EACCES.
//!
//! On those three LU installs itself into the home folder as an AppImage:
//! download, minisign check, atomic rename, a start menu entry of its own, and
//! a detached start of the new file. From then on `APPIMAGE` is set to a path
//! under `$XDG_DATA_HOME`, the folder is writable, and every later update is
//! the plugin's ordinary in place swap. Nothing is left for the user to do and
//! nothing is left for the user to read.
//!
//! Same rule as its neighbour: nothing from tauri in here. The whole sequence
//! has to be runnable inside an Arch container against the real AUR package,
//! which is what UPDATER-LINUX-BEFUND.md records. HTTP lives in
//! `self_migrate_cmd.rs`, everything else lives here.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::install_method::{on_path, InstallKind};
use crate::app_identity::APP_CONFIG_DIR;
// Every message below carries an os_error::english() and not the io::Error
// itself: on a German Windows the OS words its own errors, and this app
// answers in English wherever the sentence came from (src/os_error.rs).
use crate::os_error;

/// The key in `latest.json` that holds the bare AppImage. `linux-x86_64`
/// without a suffix is the `.tar.gz` the plugin unpacks, which is not what we
/// want on disk.
pub const APPIMAGE_PLATFORM: &str = "linux-x86_64-appimage";

/// The name the AppImage gets in the home folder. Deliberately without a
/// version: the plugin replaces this exact file on every later update, and a
/// versioned name would leave the start menu entry pointing at 2.6.8 forever.
pub const APPIMAGE_FILE: &str = "Locally.Uncensored.AppImage";

/// The half written download. Same folder as the finished file, because the
/// last step is a rename and a rename across two filesystems is not atomic.
pub const STAGED_FILE: &str = "Locally.Uncensored.AppImage.part";

/// The file name the `.deb` uses under `usr/share/applications`. It has to
/// match to the letter: XDG matches menu entries by their file name, and only
/// an identical name in `$XDG_DATA_HOME` covers up the system one instead of
/// showing up next to it.
pub const DESKTOP_FILE: &str = "Locally Uncensored.desktop";

/// The icon name inside the desktop entry, and the icon file name in the theme
/// tree. This is the bundler's name for the binary, not the data folder that
/// happens to read the same: `app_identity` owns the folder, the tauri bundle
/// owns this.
pub const ICON_NAME: &str = "locally-uncensored";

/// The sizes the `.deb` ships under `usr/share/icons/hicolor`.
pub const ICON_SIZES: [&str; 4] = ["32x32", "128x128", "256x256@2", "512x512"];

/// True when the in-app updater cannot serve this install and LU has to move
/// itself into the home folder instead.
///
/// Linux only in practice: `report()` answers `Msi` on Windows, and on macOS
/// there is no build. The caller decides that, this decides the rest.
pub fn migrates_itself(kind: InstallKind, exe_dir_writable: bool) -> bool {
    match kind {
        // A package database owns the files, or nobody does.
        InstallKind::Pacman | InstallKind::Unknown => true,
        // The plugin renames inside this folder. It may, or it may not.
        InstallKind::AppImage => !exe_dir_writable,
        // These the plugin handles, password prompt and all.
        InstallKind::Deb | InstallKind::Rpm | InstallKind::Msi => false,
    }
}

// ── Where everything goes ─────────────────────────────────────

/// The user's own data tree, and every path we write inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub data_home: PathBuf,
}

impl Layout {
    pub fn at(data_home: impl Into<PathBuf>) -> Self {
        Self { data_home: data_home.into() }
    }

    /// `$XDG_DATA_HOME`, or `$HOME/.local/share` when it is unset, which is
    /// what the spec says and what every desktop actually reads.
    pub fn from_env() -> Result<Self, String> {
        if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
            if !x.is_empty() {
                return Ok(Self::at(PathBuf::from(x)));
            }
        }
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .ok_or_else(|| "HOME is not set, so there is no home folder to install into".to_string())?;
        Ok(Self::at(PathBuf::from(home).join(".local").join("share")))
    }

    pub fn install_dir(&self) -> PathBuf {
        self.data_home.join(APP_CONFIG_DIR)
    }
    pub fn appimage(&self) -> PathBuf {
        self.install_dir().join(APPIMAGE_FILE)
    }
    pub fn staged(&self) -> PathBuf {
        self.install_dir().join(STAGED_FILE)
    }
    pub fn applications_dir(&self) -> PathBuf {
        self.data_home.join("applications")
    }
    pub fn desktop_file(&self) -> PathBuf {
        self.applications_dir().join(DESKTOP_FILE)
    }
    pub fn icon_dir(&self, size: &str) -> PathBuf {
        self.data_home.join("icons").join("hicolor").join(size).join("apps")
    }
    pub fn icon_file(&self, size: &str) -> PathBuf {
        self.icon_dir(size).join(format!("{ICON_NAME}.png"))
    }
}

// ── latest.json ───────────────────────────────────────────────

/// The one entry we can install: the bare `.AppImage` and its signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub signature: String,
}

/// Read the AppImage entry out of the same `latest.json` the plugin reads.
///
/// The plugin picks `{os}-{arch}-{installer}` from the marker burned into the
/// binary, which is the whole bug: on the AUR install that marker says deb.
/// Here the key is a constant, because the file we are about to write is an
/// AppImage no matter what this copy was packaged as.
pub fn pick_appimage(latest_json: &str) -> Result<Release, String> {
    let root: serde_json::Value = serde_json::from_str(latest_json)
        .map_err(|e| format!("the update server did not answer with valid JSON: {e}"))?;

    let version = root
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or("the update manifest has no version")?;

    let entry = root
        .get("platforms")
        .and_then(|p| p.get(APPIMAGE_PLATFORM))
        .ok_or_else(|| format!("the update manifest has no {APPIMAGE_PLATFORM} download"))?;

    let url = entry
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("the {APPIMAGE_PLATFORM} download has no url"))?;
    let signature = entry
        .get("signature")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("the {APPIMAGE_PLATFORM} download has no signature"))?;

    Ok(Release {
        version: version.to_string(),
        url: url.to_string(),
        signature: signature.to_string(),
    })
}

/// The placeholders tauri allows in an updater endpoint. Ours has none, but a
/// configuration that grows one must not turn into a 404 nobody can explain.
pub fn resolve_endpoint(raw: &str, current_version: &str) -> String {
    raw.replace("{{target}}", tauri_target())
        .replace("{{arch}}", std::env::consts::ARCH)
        .replace("{{current_version}}", current_version)
}

fn tauri_target() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

// ── The signature ─────────────────────────────────────────────

/// The same check the plugin runs before it installs anything
/// (tauri-plugin-updater-2.10.1/src/updater.rs, `verify_signature`): both the
/// public key and the signature travel base64 wrapped around minisign's own
/// text format, and the key is the one out of `tauri.conf.json`.
///
/// A file that fails here is deleted by the caller and never becomes an
/// executable in the user's home folder.
pub fn verify_signature(data: &[u8], signature_b64: &str, pub_key_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let unwrap_b64 = |what: &str, s: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .map_err(|e| format!("the {what} is not valid base64: {e}"))?;
        String::from_utf8(raw).map_err(|_| format!("the {what} is not valid text"))
    };

    let key_text = unwrap_b64("public key", pub_key_b64)?;
    let public_key = minisign_verify::PublicKey::decode(&key_text)
        .map_err(|e| format!("the public key could not be read: {e}"))?;

    let signature_text = unwrap_b64("signature", signature_b64)?;
    let signature = minisign_verify::Signature::decode(&signature_text)
        .map_err(|e| format!("the signature could not be read: {e}"))?;

    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("the signature does not match the downloaded file: {e}"))
}

// ── Putting the file in place ─────────────────────────────────

/// Make the staged download executable and move it onto the final name in one
/// step. Same folder, so the rename is atomic: either the old AppImage is
/// still there or the new one is, never half of either.
pub fn place_appimage(staged: &Path, dest: &Path) -> Result<(), String> {
    make_executable(staged)?;
    std::fs::rename(staged, dest).map_err(|e| {
        format!("could not move the download to {}: {}", dest.display(), os_error::english(&e))
    })
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| {
        format!("could not make {} executable: {}", path.display(), os_error::english(&e))
    })
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

// ── The start menu entry ──────────────────────────────────────

/// The entry that has to cover up the system one.
///
/// Same name, same icon, same window class as the `.deb` ships, so the menu
/// keeps one Locally Uncensored and the window keeps its icon. Only `Exec`
/// differs, and it is the whole point: it names the AppImage in the home
/// folder instead of the `/usr/bin` copy a package manager owns.
pub fn desktop_entry(exec: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Locally Uncensored\n\
         Comment=LU by LU Labs, private, local AI chat, image, and video generation\n\
         Exec={}\n\
         Icon={ICON_NAME}\n\
         Terminal=false\n\
         Categories=Development;\n\
         StartupWMClass={ICON_NAME}\n",
        quote_exec(exec)
    )
}

/// Exec quoting per the desktop entry spec: the reserved characters have to be
/// escaped inside the double quotes, and a home folder with a space in it is
/// the ordinary case this exists for.
fn quote_exec(exec: &Path) -> String {
    let mut out = String::from("\"");
    for ch in exec.to_string_lossy().chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

pub fn write_desktop_entry(layout: &Layout, exec: &Path) -> Result<PathBuf, String> {
    let dir = layout.applications_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {}", dir.display(), os_error::english(&e)))?;
    let file = layout.desktop_file();
    std::fs::write(&file, desktop_entry(exec))
        .map_err(|e| format!("could not write {}: {}", file.display(), os_error::english(&e)))?;
    Ok(file)
}

/// Where a copy of our icon can already be found on this machine.
///
/// `APPDIR` is set while an AppImage runs and holds the whole bundle, so it is
/// the right source for the AppImage in a read only folder. The other two are
/// the system tree the deb and the AUR package write into. First hit wins per
/// size.
pub fn icon_source_roots(appdir: Option<String>, xdg_data_dirs: Option<String>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = appdir.filter(|d| !d.is_empty()) {
        roots.push(PathBuf::from(dir).join("usr").join("share"));
    }
    let dirs = xdg_data_dirs
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let path = PathBuf::from(dir);
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

/// Copy every icon size we can find into the user's own theme tree.
///
/// Best effort by design: a menu entry with no icon is a cosmetic loss, and it
/// is not worth failing an update over. Returns what was copied so the caller
/// can report it.
pub fn copy_icons(layout: &Layout, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut written = Vec::new();
    for size in ICON_SIZES {
        let Some(source) = roots
            .iter()
            .map(|r| r.join("icons").join("hicolor").join(size).join("apps").join(format!("{ICON_NAME}.png")))
            .find(|p| p.is_file())
        else {
            continue;
        };
        let dir = layout.icon_dir(size);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let target = layout.icon_file(size);
        if std::fs::copy(&source, &target).is_ok() {
            written.push(target);
        }
    }
    written
}

/// Tell the desktop that the menu changed. Absent on a bare install, and the
/// entry works without it once the menu is next rebuilt, so a failure here is
/// nothing to report.
pub fn refresh_desktop_database(layout: &Layout) {
    if !on_path("update-desktop-database") {
        return;
    }
    let _ = Command::new("update-desktop-database")
        .arg(layout.applications_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ── Handing over to the new file ──────────────────────────────

/// The shell line that starts the new AppImage once this process is gone.
///
/// It cannot simply be started: LU runs `tauri-plugin-single-instance`, so a
/// second process with the same identifier finds this one, focuses its window
/// and exits. The new AppImage would die on the spot and the user would be
/// left on the old build.
///
/// So the helper waits for our pid to disappear, then execs the AppImage. The
/// cap is twenty seconds, after which it starts anyway rather than lingering
/// as a process nobody asked for.
pub fn relaunch_script(exe: &Path, pid: u32) -> String {
    format!(
        "n=0; while [ $n -lt 200 ] && kill -0 {pid} 2>/dev/null; do sleep 0.1; n=$((n+1)); done; exec {}",
        shell_quote(exe)
    )
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Start the new AppImage in a session of its own and return.
///
/// `setsid` gives it its own process group, so the exit of this app cannot
/// take it with it, and all three streams go to /dev/null because the parent's
/// are about to close. The AppImage runtime exports `APPIMAGE`, `APPDIR`,
/// `OWD` and `ARGV0` into every child it starts: they describe THIS bundle and
/// would make the new process report the old path, so they are dropped.
pub fn launch_after_exit(exe: &Path, pid: u32) -> Result<(), String> {
    let script = relaunch_script(exe, pid);
    let mut command = if on_path("setsid") {
        let mut c = Command::new("setsid");
        c.arg("sh").arg("-c").arg(&script);
        c
    } else {
        // Without util-linux the process still survives: it is reparented to
        // init when we exit, and a windowed app has no controlling terminal to
        // be signalled from.
        let mut c = Command::new("sh");
        c.arg("-c").arg(&script);
        c
    };
    for stale in ["APPIMAGE", "APPDIR", "OWD", "ARGV0"] {
        command.env_remove(stale);
    }
    command
        .current_dir(exe.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            format!("could not start the new version at {}: {}", exe.display(), os_error::english(&e))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LATEST: &str = r#"{
      "version": "2.6.8",
      "platforms": {
        "linux-x86_64": { "url": "https://example.test/LU.AppImage.tar.gz", "signature": "tarball" },
        "linux-x86_64-appimage": { "url": "https://example.test/LU.AppImage", "signature": "sig" },
        "linux-x86_64-deb": { "url": "https://example.test/LU.deb", "signature": "deb" }
      }
    }"#;

    #[test]
    fn the_three_installs_the_plugin_cannot_serve_migrate() {
        // The Zen case, and the deb nobody unpacked with a package manager.
        assert!(migrates_itself(InstallKind::Pacman, false));
        assert!(migrates_itself(InstallKind::Unknown, false));
        // An AppImage in /opt: the plugin renames inside a folder it may not
        // write to.
        assert!(migrates_itself(InstallKind::AppImage, false));
    }

    #[test]
    fn the_installs_that_work_are_left_alone() {
        // deb and rpm run a package install with a password prompt, and that
        // is the normal Linux way. Windows has its own installer.
        assert!(!migrates_itself(InstallKind::Deb, false));
        assert!(!migrates_itself(InstallKind::Rpm, false));
        assert!(!migrates_itself(InstallKind::Msi, true));
        // And the AppImage the user owns keeps swapping itself in place.
        assert!(!migrates_itself(InstallKind::AppImage, true));
    }

    #[test]
    fn after_the_move_the_updater_is_allowed_again() {
        // The whole point of the migration: the new file lives where the
        // plugin's rename works, so detect() has to answer AppImage and the
        // folder has to be writable. That pair is what `migrates_itself`
        // reads, and it must come out false or the next update would migrate
        // all over again.
        let layout = Layout::at("/home/zen/.local/share");
        let migrated = layout.appimage();
        let probes = super::super::install_method::Probes {
            appimage_env: Some(migrated.to_string_lossy().to_string()),
            exe_path: migrated.clone(),
            exe_dir_writable: true,
            ..Default::default()
        };
        let kind = super::super::install_method::detect(&probes);
        assert_eq!(kind, InstallKind::AppImage);
        assert!(!migrates_itself(kind, probes.exe_dir_writable));
    }

    #[test]
    fn the_layout_is_the_users_own_tree() {
        let layout = Layout::at("/home/zen/.local/share");
        assert_eq!(
            layout.appimage(),
            PathBuf::from("/home/zen/.local/share/locally-uncensored/Locally.Uncensored.AppImage")
        );
        // Staged next to it, or the rename is a copy across filesystems.
        assert_eq!(layout.staged().parent(), layout.appimage().parent());
        assert_eq!(
            layout.desktop_file(),
            PathBuf::from("/home/zen/.local/share/applications/Locally Uncensored.desktop")
        );
        assert_eq!(
            layout.icon_file("128x128"),
            PathBuf::from("/home/zen/.local/share/icons/hicolor/128x128/apps/locally-uncensored.png")
        );
    }

    #[test]
    fn the_desktop_file_is_named_exactly_like_the_one_in_the_deb() {
        // Checked against the real 2.6.8 deb: ar x + tar -xzf data.tar.gz puts
        // "Locally Uncensored.desktop" under usr/share/applications. A
        // different name would add a second menu entry instead of covering the
        // first.
        assert_eq!(DESKTOP_FILE, "Locally Uncensored.desktop");
    }

    #[test]
    fn the_entry_points_at_the_appimage_and_survives_a_space() {
        let exec = PathBuf::from("/home/max mustermann/.local/share/locally-uncensored/x.AppImage");
        let text = desktop_entry(&exec);
        assert!(text.starts_with("[Desktop Entry]\n"));
        assert!(text.contains("Exec=\"/home/max mustermann/.local/share/locally-uncensored/x.AppImage\"\n"));
        assert!(text.contains("Name=Locally Uncensored\n"));
        assert!(text.contains("Icon=locally-uncensored\n"));
        assert!(text.contains("StartupWMClass=locally-uncensored\n"));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn a_hostile_path_cannot_break_out_of_the_exec_line() {
        let text = desktop_entry(Path::new("/home/a\"b$c`d\\e/LU.AppImage"));
        assert!(text.contains("Exec=\"/home/a\\\"b\\$c\\`d\\\\e/LU.AppImage\"\n"));
        // One Exec line, not two.
        assert_eq!(text.lines().filter(|l| l.starts_with("Exec=")).count(), 1);
    }

    #[test]
    fn the_appimage_entry_is_the_one_that_gets_picked() {
        let release = pick_appimage(LATEST).expect("appimage entry");
        assert_eq!(release.version, "2.6.8");
        assert_eq!(release.url, "https://example.test/LU.AppImage");
        assert_eq!(release.signature, "sig");
    }

    #[test]
    fn a_manifest_without_an_appimage_says_so_instead_of_guessing() {
        let only_deb = r#"{"version":"2.6.8","platforms":{"linux-x86_64-deb":{"url":"u","signature":"s"}}}"#;
        let err = pick_appimage(only_deb).unwrap_err();
        assert!(err.contains("linux-x86_64-appimage"), "{err}");
        assert!(pick_appimage("not json at all").unwrap_err().contains("valid JSON"));
        assert!(pick_appimage(r#"{"platforms":{}}"#).unwrap_err().contains("no version"));
    }

    #[test]
    fn an_endpoint_with_placeholders_is_filled_in() {
        let url = resolve_endpoint(
            "https://example.test/{{target}}/{{arch}}/{{current_version}}/latest.json",
            "2.6.8",
        );
        assert!(url.contains(std::env::consts::ARCH));
        assert!(url.ends_with("/2.6.8/latest.json"));
        assert!(!url.contains("{{"));
        // The endpoint we actually ship has none of them and comes back whole.
        let plain = "https://github.com/x/y/releases/latest/download/latest.json";
        assert_eq!(resolve_endpoint(plain, "2.6.8"), plain);
    }

    #[test]
    fn a_signature_that_does_not_belong_to_the_file_is_refused() {
        // The real 2.6.8 key and the real 2.6.8 AppImage signature out of
        // latest.json, against bytes that are not that AppImage. Everything
        // about this is valid except the data, which is the case that matters:
        // a download that got swapped on the way.
        let key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZDNkRFNzJFRjhFNkIxNDcKUldSSHNlYjRMdWR0YklwQlJhTUR4TXBTTE1xKzFUcWVVTEpTL0hZMi9ldmlOcW5BWFZWeUdzRGMK";
        let sig = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSSHNlYjRMdWR0YklZalVUbGZSSDJ6Y1VYMmNrcmJwZUhwbHFoRFN6Qi84MjRTQ1ROaUdYaE43S2NjODNSU24rclIzVEF2cktpeThpN216QnRQRG1pWEFGQm1rZ2dBbWdzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg4NzI1Njk2CWZpbGU6TG9jYWxseSBVbmNlbnNvcmVkXzIuNi44X2FtZDY0LkFwcEltYWdlCjEzRkxyQ0lWNlZ2YWdjdTJ0WGZOMUJNUXRmQWdmRVE5ZmlUTzk5TTM3V29EMXV3NERBSE5nZTd0bkQ2dEcvNVVlVWNTdFNsVFpnbGduclNxY1pBbkJBPT0K";
        let err = verify_signature(b"this is not the AppImage", sig, key).unwrap_err();
        assert!(err.contains("does not match"), "{err}");

        // And the two ways the inputs themselves can be wrong.
        assert!(verify_signature(b"x", "not base64!!", key).unwrap_err().contains("signature"));
        assert!(verify_signature(b"x", sig, "not base64!!").unwrap_err().contains("public key"));
    }

    /// The real proof, against the file GitHub serves.
    ///
    /// A 46 MB AppImage does not belong in the repository, so this test runs
    /// only when it is pointed at one:
    ///
    ///     LU_APPIMAGE_FIXTURE=/path/to/Locally.Uncensored_2.6.8_amd64.AppImage \
    ///       cargo test the_real_appimage -- --nocapture
    ///
    /// It checks both directions: the untouched download is accepted, and the
    /// same bytes with one byte flipped are refused.
    #[test]
    fn the_real_appimage_is_accepted_and_one_flipped_byte_is_not() {
        let Some(path) = std::env::var_os("LU_APPIMAGE_FIXTURE") else {
            eprintln!("skipped: set LU_APPIMAGE_FIXTURE to the 2.6.8 AppImage to run this");
            return;
        };
        let signature = std::env::var("LU_APPIMAGE_SIGNATURE")
            .expect("LU_APPIMAGE_SIGNATURE: the linux-x86_64-appimage signature out of latest.json");
        let key = std::env::var("LU_APPIMAGE_PUBKEY")
            .expect("LU_APPIMAGE_PUBKEY: the pubkey out of tauri.conf.json");

        let mut bytes = std::fs::read(&path).expect("the fixture");
        verify_signature(&bytes, &signature, &key).expect("the real download must be accepted");
        eprintln!("accepted {} bytes from {:?}", bytes.len(), path);

        let middle = bytes.len() / 2;
        bytes[middle] ^= 0x01;
        let err = verify_signature(&bytes, &signature, &key)
            .expect_err("one flipped byte must be refused");
        eprintln!("refused after flipping byte {middle}: {err}");
    }

    #[test]
    fn the_icon_sources_start_inside_the_running_appimage() {
        let roots = icon_source_roots(Some("/tmp/.mount_LU".into()), None);
        assert_eq!(roots[0], PathBuf::from("/tmp/.mount_LU/usr/share"));
        // The default search path when the desktop does not set one.
        assert!(roots.contains(&PathBuf::from("/usr/share")));

        // XDG_DATA_DIRS wins over the default, and a repeated entry is not
        // searched twice.
        let roots = icon_source_roots(None, Some("/usr/share:/usr/share:/opt/share".into()));
        assert_eq!(roots, vec![PathBuf::from("/usr/share"), PathBuf::from("/opt/share")]);
        assert!(icon_source_roots(Some(String::new()), Some(String::new()))
            .contains(&PathBuf::from("/usr/share")));
    }

    #[test]
    fn the_relaunch_waits_for_this_process_to_be_gone() {
        // Without the wait the new AppImage meets single-instance, focuses
        // this window and exits, and the user stays on the old build.
        let script = relaunch_script(Path::new("/home/zen/.local/share/x/LU.AppImage"), 4242);
        assert!(script.contains("kill -0 4242"));
        assert!(script.contains("exec '/home/zen/.local/share/x/LU.AppImage'"));
        // Not forever: twenty seconds at a tenth of a second each.
        assert!(script.contains("[ $n -lt 200 ]"));
        // A quote in the path cannot end the quoting.
        assert!(relaunch_script(Path::new("/home/o'brien/LU.AppImage"), 1).contains("'/home/o'\\''brien/LU.AppImage'"));
    }

    #[test]
    fn a_real_migration_lands_where_it_says_it_does() {
        // The file moves, it is executable, the entry names it, and the icon
        // that was found on the machine is in the user's own theme tree.
        let tmp = std::env::temp_dir().join(format!("lu-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let layout = Layout::at(tmp.join("data"));
        let fake_system = tmp.join("system");
        let icon_source = fake_system.join("icons").join("hicolor").join("128x128").join("apps");
        std::fs::create_dir_all(&icon_source).expect("icon source");
        std::fs::write(icon_source.join(format!("{ICON_NAME}.png")), b"PNG").expect("icon");
        std::fs::create_dir_all(layout.install_dir()).expect("install dir");
        std::fs::write(layout.staged(), b"#!/bin/sh\nexit 0\n").expect("staged download");

        place_appimage(&layout.staged(), &layout.appimage()).expect("place");
        assert!(!layout.staged().exists(), "the staged file is gone");
        assert!(layout.appimage().is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(layout.appimage()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "the AppImage has to be executable");
        }

        let entry = write_desktop_entry(&layout, &layout.appimage()).expect("entry");
        let text = std::fs::read_to_string(&entry).expect("entry text");
        // The Exec line carries the path in freedesktop quoting, so a Windows
        // temp path with backslashes appears escaped; the contract is the quoted
        // form, and that is what the assertion reads.
        assert!(text.contains(&quote_exec(&layout.appimage())));

        let icons = copy_icons(&layout, std::slice::from_ref(&fake_system));
        assert_eq!(icons, vec![layout.icon_file("128x128")]);
        assert_eq!(std::fs::read(layout.icon_file("128x128")).unwrap(), b"PNG");
        // A machine with no icon anywhere is not a failed update.
        assert!(copy_icons(&layout, &[tmp.join("nothing-here")]).is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
