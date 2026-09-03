//! Ein Node-Paket in ComfyUIs `custom_nodes/` bringen und lauffähig halten.
//!
//! Der geteilte Zustand ist ein einzelnes Verzeichnis unter `custom_nodes/`,
//! das in drei Zuständen angetroffen werden kann: gar nicht da, als
//! git-Checkout, oder als Rest eines abgebrochenen Versuchs. Alle Funktionen
//! hier arbeiten an diesem einen Verzeichnis, und die Naht läuft genau darum
//! herum.
//!
//! Aus #72 stammt die Regel, die das Modul zusammenhält: der Klon-Weg und der
//! Aktualisierungs-Weg müssen BEIDE die `requirements.txt` einspielen. Solange
//! nur der Klon das tat, konnte sich ein Paket, dessen Requirements einmal
//! gescheitert waren, nie wieder erholen — ComfyUI meldete weiter IMPORT
//! FAILED, und der Knoten tauchte nie auf. Deshalb ist
//! `install_node_requirements` eine eigene Funktion und wird von beiden Wegen
//! gerufen.
//!
//! Warum die Rechte-Erkennung NICHT mehr hier steht: sie deutet eine
//! pip-Ausgabe, und das tut `pip`. Der Fall, den sie rettet, ist trotzdem
//! genau dieser hier — eine python.org-Installation unter Program Files hat
//! ein Administrator-eigenes `site-packages`, und dort scheitert das erste
//! Paket, das ein NEUES Wheel zieht, während Pakete mit schon vorhandenen
//! Abhängigkeiten durchlaufen. Deshalb ruft dieses Modul
//! `super::pip::is_permission_denied_pip_error` und deutet nichts selbst.

use std::fs;
use std::path::PathBuf;
use crate::python::python_command;
use super::pip::is_permission_denied_pip_error;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::{error, info};

use crate::os_error;
use crate::state::AppState;

use super::pip::diagnose_pip_error;
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub async fn install_custom_node(
    state: State<'_, AppState>,
    repoUrl: String,
    nodeName: String,
) -> Result<serde_json::Value, String> {
    // Snapshot the state the blocking worker needs before spawning it: a Tauri
    // `State` (and the MutexGuard behind it) is not Send, so clone the values
    // out and move owned copies into the worker.
    let comfy_path = { state.comfy_path.lock().unwrap().clone() };
    let fallback_python = { state.python_bin.lock().unwrap().clone() };
    // Freeze fix (David 2026-07-04): the git clone + pip below are blocking. As
    // a plain sync #[command] they ran on the Tauri main thread and froze the
    // WebView2 window for the entire 30s-2min install with no feedback ("hängt
    // sich auf, keine Rückmeldung"). Run them on the blocking pool so the UI
    // stays responsive and the staged status messages actually paint — the JS
    // caller still awaits this command's result exactly as before.
    tauri::async_runtime::spawn_blocking(move || {
        install_custom_node_blocking(repoUrl, nodeName, comfy_path, &fallback_python)
    })
    .await
    .map_err(|e| format!("Custom node install task failed to run: {e}"))?
}

/// Blocking half of `install_custom_node`, run on the blocking pool. Holds all
/// the ComfyUI-path resolution, git clone/pull healing (#72) and pip work so
/// the async command above never stalls the UI thread.
#[allow(non_snake_case)]
fn install_custom_node_blocking(
    repoUrl: String,
    nodeName: String,
    comfy_path: Option<String>,
    fallback_python: &str,
) -> Result<serde_json::Value, String> {
    let repo_url = repoUrl;
    let node_name = nodeName;

    // Security review 2.5.7: this clones `repo_url` and joins `node_name` under
    // custom_nodes/. Every in-app caller passes a hardcoded registry entry, so
    // these are trusted today — but a single renderer foothold could call the
    // command with a hostile value, so validate defensively. Reject anything that
    // isn't a plain https:// URL: git's `ext::`/`file::`/`ssh` transports execute
    // commands, and a leading `-` would be parsed as a git flag. Reject any path
    // syntax in `node_name` (`/`, `\`, `..`, `:`, leading `-`/`.`) — an absolute
    // or `..` component makes `custom_nodes_dir.join(node_name)` escape the dir.
    if !repo_url.starts_with("https://")
        || repo_url.len() > 512
        || repo_url.contains(|c: char| c.is_whitespace() || c.is_control())
    {
        return Err("Refusing to install: repository URL must be a plain https:// URL.".to_string());
    }
    if node_name.is_empty()
        || node_name.len() > 128
        || node_name.contains('/')
        || node_name.contains('\\')
        || node_name.contains("..")
        || node_name.contains(':')
        || node_name.starts_with('-')
        || node_name.starts_with('.')
    {
        return Err("Refusing to install: invalid custom-node name.".to_string());
    }

    info!(node = %node_name, "custom node install start");

    let comfy_dir = match comfy_path {
        Some(p) => PathBuf::from(p),
        None => {
            // Try to find it
            match crate::commands::process::find_comfyui_path() {
                Some(p) => PathBuf::from(p),
                None => {
                    error!(node = %node_name, "custom node install failed: comfyui not found");
                    return Err("ComfyUI not found. Install ComfyUI first.".to_string());
                }
            }
        }
    };

    let custom_nodes_dir = comfy_dir.join("custom_nodes");
    let target_dir = custom_nodes_dir.join(&node_name);

    // Create custom_nodes dir if it doesn't exist
    if !custom_nodes_dir.exists() {
        fs::create_dir_all(&custom_nodes_dir)
            .map_err(|e| format!("Failed to create custom_nodes directory: {}", os_error::english(&e)))?;
    }

    // Bug N — same git probe as install_comfyui. Block on missing git, log
    // a soft hint when a non-native git is first on PATH.
    #[cfg(target_os = "windows")]
    {
        let probe = windows_git_probe();
        if probe == WindowsGitState::Missing {
            return Err(windows_git_install_hint(&probe).unwrap_or_default());
        }
        if probe == WindowsGitState::NonNative {
            if let Some(hint) = windows_git_install_hint(&probe) {
                println!("[Install] {}", hint);
            }
        }
    }

    // #72 (bob, discussion 72): three silent failure modes lived here.
    //  1. A leftover non-repo dir (aborted clone, manual unzip) made `git pull`
    //     fail forever, and the failure came back as Ok(status="update_failed")
    //     — the UI treated it as success, so the install dialog looped with no
    //     error and video gen kept falling back to .webp.
    //  2. The exists/update path never installed requirements.txt, so a repo
    //     whose requirements failed once could never heal (ComfyUI keeps
    //     reporting IMPORT FAILED and the node never shows up).
    // Now: a non-repo leftover is moved aside (".disabled" so ComfyUI ignores
    // it) and re-cloned, a failed pull is a real Err, and requirements are
    // ensured on BOTH the clone and the update path.
    let mut fresh_clone = true;
    if target_dir.exists() {
        if target_dir.join(".git").exists() {
            println!("[Install] Custom node {} already exists, updating...", node_name);
            let mut cmd = Command::new("git");
            cmd.args(["pull"]).current_dir(&target_dir)
                .stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = cmd.output()
                .map_err(|e| format!("Git pull failed: {}", os_error::english(&e)))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!(node = %node_name, "custom node git pull failed");
                return Err(format!(
                    "Failed to update {} (git pull): {}\n\nIf this keeps failing, \
                     delete the folder {} and try the install again.",
                    node_name, stderr.trim(), target_dir.to_string_lossy()
                ));
            }
            fresh_clone = false;
        } else {
            // Not a git repo — pull can never succeed. Move it aside and re-clone.
            let moved_to = move_aside_broken_node_dir(&target_dir)?;
            println!(
                "[Install] Custom node {} folder exists but is not a git repo — moved aside to {}, re-cloning",
                node_name,
                moved_to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            );
        }
    }

    if fresh_clone {
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let mut cmd = Command::new("git");
        cmd.args(["clone", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", os_error::english(&e)))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(node = %node_name, "custom node clone failed");
            return Err(format!("Failed to clone {}: {}", node_name, stderr));
        }
    }

    install_node_requirements(&comfy_dir, &target_dir, &node_name, fallback_python)?;

    Ok(serde_json::json!({
        "status": if fresh_clone { "installed" } else { "updated" },
        "path": target_dir.to_string_lossy(),
    }))
}

/// Move a non-repo custom-node leftover out of the way so a fresh clone can
/// land. The ".disabled" suffix matches the ComfyUI(-Manager) convention, so
/// ComfyUI never tries to load the moved-aside folder as a node pack.
fn move_aside_broken_node_dir(target_dir: &std::path::Path) -> Result<PathBuf, String> {
    let base = target_dir.to_string_lossy().into_owned();
    let mut backup = PathBuf::from(format!("{}.broken.disabled", base));
    let mut n = 1;
    while backup.exists() {
        n += 1;
        backup = PathBuf::from(format!("{}.broken{}.disabled", base, n));
    }
    fs::rename(target_dir, &backup).map_err(|e| {
        format!(
            "The folder {} exists but is not a valid git checkout, and it could \
             not be moved aside: {}. Delete it manually and try again.",
            target_dir.display(),
            os_error::english(&e)
        )
    })?;
    Ok(backup)
}

/// Install a custom node's requirements.txt (when present) into the Python
/// that ComfyUI actually runs with. Shared by the clone AND the update path
/// of `install_custom_node` — #72 was partly caused by the update path
/// skipping this entirely.
///
/// Bug F (discovered during Arch live test on 2026-05-17): ComfyUI was
/// installed into a venv by the Bug E path, but this used to call pip against
/// `state.python_bin` (the system Python). On Arch / Debian 12+ / Fedora 38+
/// that hits PEP 668's `externally-managed-environment` and the requirements
/// install silently fails. Prefer the ComfyUI venv's Python (matches the
/// launcher in `process.rs::start_comfyui` and the installer in
/// `install_comfyui`) so requirements land in the same site-packages ComfyUI
/// actually imports from, and surface a useful error when pip fails.
fn install_node_requirements(
    comfy_dir: &std::path::Path,
    target_dir: &std::path::Path,
    node_name: &str,
    fallback_python: &str,
) -> Result<(), String> {
    let reqs = target_dir.join("requirements.txt");
    if !reqs.exists() {
        return Ok(());
    }
    let venv_python = crate::python::resolve_comfyui_venv_python(comfy_dir);
    let python_bin = venv_python.unwrap_or_else(|| fallback_python.to_string());
    if python_bin.is_empty() {
        return Err(format!(
            "Custom node {} cloned, but cannot install requirements: \
             no Python available. Install Python first \
             (Settings → ComfyUI → Install Python).",
            node_name
        ));
    }
    println!("[Install] Installing requirements for {} via {}", node_name, python_bin);
    let run_pip = |extra: &[&str]| -> Result<std::process::Output, String> {
        let mut pip = python_command(&python_bin);
        pip.args(["-m", "pip", "install", "--no-input"]);
        pip.args(extra);
        pip.arg("-r").arg(&reqs);
        pip.stdout(Stdio::piped()).stderr(Stdio::piped());
        pip.output()
            .map_err(|e| format!("Failed to spawn pip for {} requirements: {}", node_name, os_error::english(&e)))
    };
    let pip_out = run_pip(&[])?;
    if !pip_out.status.success() {
        let stderr = String::from_utf8_lossy(&pip_out.stderr);
        let stdout = String::from_utf8_lossy(&pip_out.stdout);
        let combined = format!("{}{}", stdout, stderr);
        // python.org installs under Program Files have an admin-only
        // site-packages: the first node pack whose requirements pull a NEW
        // wheel dies with a permission error, while packs whose deps are
        // already present sail through (why RMBG/VHS installs passed and
        // controlnet_aux stranded the Motion install card, 2026-07-19).
        // Retry into the per-user site — the same interpreter imports from
        // there, no admin needed. The Windows twin of the PEP 668 --user
        // escape above; a venv Python never hits a permission error here,
        // and if the retry fails too we surface the original diagnosis.
        if is_permission_denied_pip_error(&combined) {
            println!(
                "[Install] {} requirements hit a permission error — retrying into the user site (--user)",
                node_name
            );
            if let Ok(user_out) = run_pip(&["--user"]) {
                if user_out.status.success() {
                    return Ok(());
                }
            }
        }
        // Reuse the install_comfyui diagnose path so PEP 668 +
        // friends produce actionable messages here too.
        let diagnosis = diagnose_pip_error(&combined);
        error!(node = %node_name, "custom node requirements install failed");
        return Err(format!(
            "Custom node {} is cloned, but its requirements install failed.\n\n{}",
            node_name, diagnosis
        ));
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    // ── install_custom_node helpers (#72 bob: VHS install loop) ─────────

    #[test]
    fn move_aside_renames_non_repo_dir_to_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let node_dir = tmp.path().join("ComfyUI-VideoHelperSuite");
        std::fs::create_dir(&node_dir).unwrap();
        std::fs::write(node_dir.join("leftover.txt"), "junk").unwrap();

        let moved = move_aside_broken_node_dir(&node_dir).unwrap();

        assert!(!node_dir.exists(), "original dir must be gone");
        assert!(moved.exists(), "moved-aside dir must exist");
        let name = moved.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.ends_with(".disabled"),
            "must end with .disabled so ComfyUI never loads it, got {name}"
        );
        assert!(moved.join("leftover.txt").exists(), "content preserved");
    }

    #[test]
    fn move_aside_picks_a_fresh_name_when_backup_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let node_dir = tmp.path().join("SomeNode");
        std::fs::create_dir(&node_dir).unwrap();
        // First backup slot already taken
        std::fs::create_dir(tmp.path().join("SomeNode.broken.disabled")).unwrap();

        let moved = move_aside_broken_node_dir(&node_dir).unwrap();

        assert!(!node_dir.exists());
        let name = moved.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "SomeNode.broken2.disabled");
    }

    #[test]
    fn requirements_install_is_a_noop_without_requirements_txt() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        let node = tmp.path().join("comfy/custom_nodes/NoReqs");
        std::fs::create_dir_all(&node).unwrap();

        // No requirements.txt → must succeed without ever spawning pip
        // (an empty fallback python would otherwise be an instant Err).
        assert!(install_node_requirements(&comfy, &node, "NoReqs", "").is_ok());
    }

    #[test]
    fn requirements_install_without_python_is_actionable() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        let node = tmp.path().join("comfy/custom_nodes/WithReqs");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("requirements.txt"), "imageio-ffmpeg").unwrap();

        let err = install_node_requirements(&comfy, &node, "WithReqs", "").unwrap_err();
        assert!(err.contains("no Python available"), "got: {err}");
    }

    // ── permission-denied → --user retry (Motion install card, 2026-07-19) ──



}
