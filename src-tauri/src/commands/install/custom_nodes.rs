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
use super::pip::{is_permission_denied_pip_error, user_site_allowed};
use super::venv::is_venv_python;
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};
use tracing::{error, info};

use crate::os_error;
use crate::state::AppState;

use super::pip::diagnose_pip_error;
use super::custom_node_packs::{node_log, node_repo_from_url};
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub async fn install_custom_node(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    repoUrl: String,
    nodeName: String,
    commit: Option<String>,
    freshOnly: Option<bool>,
) -> Result<serde_json::Value, String> {
    // Snapshot the state the blocking worker needs before spawning it: a Tauri
    // `State` (and the MutexGuard behind it) is not Send, so clone the values
    // out and move owned copies into the worker.
    // A ComfyUI on another machine loads its node packs from THAT machine's
    // custom_nodes folder, which nothing here can reach (GH #143). Cloning into
    // a ComfyUI found on this PC helped nobody; say what to do instead.
    if let Some(remote) = crate::commands::download::remote_comfy(&state) {
        return Err(format!(
            "Your ComfyUI runs on {} and LU cannot install node packs on another machine. Install {} there (ComfyUI-Manager, or git clone {} into its custom_nodes folder), then restart that ComfyUI.",
            remote.host, nodeName, repoUrl
        ));
    }
    let comfy_path = { state.comfy_path.lock().unwrap().clone() };
    let fallback_python = { state.python_bin.lock().unwrap().clone() };
    // Freeze fix (2026-07-04): the git clone + pip below are blocking. As
    // a plain sync #[command] they ran on the Tauri main thread and froze the
    // WebView2 window for the entire 30s-2min install with no feedback ("hängt
    // sich auf, keine Rückmeldung"). Run them on the blocking pool so the UI
    // stays responsive and the staged status messages actually paint — the JS
    // caller still awaits this command's result exactly as before.
    tauri::async_runtime::spawn_blocking(move || {
        // Re-resolved here: a `State` borrow cannot cross into the blocking
        // pool, and the pause below stops and starts ComfyUI through it.
        let state = app.state::<AppState>();
        let _row = crate::install_state::begin_activity(format!("node:{nodeName}"), format!("Node pack {nodeName}"));
        let pause = ComfyPause {
            stop: &|| super::comfy_repair::stop_own_idle_comfyui(&state),
            start: &|| {
                if let Err(e) = crate::commands::process::start_comfyui_blocking(&state) {
                    error!(error = %e, "comfyui did not start again after a node pack install");
                }
            },
        };
        let result = install_custom_node_blocking(repoUrl, nodeName, commit, freshOnly.unwrap_or(false), comfy_path, &fallback_python, &pause);
        if let Err(e) = &result {
            node_log(e);
        }
        result
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
    commit: Option<String>,
    fresh_only: bool,
    comfy_path: Option<String>,
    fallback_python: &str,
    pause: &ComfyPause<'_>,
) -> Result<serde_json::Value, String> {
    let node_name = nodeName;

    // Security review 2.5.7: this clones `repo_url` and joins `node_name` under
    // custom_nodes/. Every in-app caller passes a hardcoded registry entry, so
    // these are trusted today — but a single renderer foothold could call the
    // command with a hostile value, so validate defensively. Reject anything that
    // isn't a plain https:// URL: git's `ext::`/`file::`/`ssh` transports execute
    // commands, and a leading `-` would be parsed as a git flag. Reject any path
    // syntax in `node_name` (`/`, `\`, `..`, `:`, leading `-`/`.`) — an absolute
    // or `..` component makes `custom_nodes_dir.join(node_name)` escape the dir.
    //
    // Since the node pack manager (GitHub wish #14) a pasted link reaches this
    // command too, so the link has to be a plain https link to a repository on
    // github.com, gitlab.com or codeberg.org (custom_node_packs.rs). Every
    // registry entry is one.
    let repo_url = match node_repo_from_url(&repoUrl) {
        Ok(repo) => repo.url,
        Err(reason) => return Err(format!("Refusing to install: {reason}")),
    };
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
    // A pin is a full commit id and nothing else: it ends up as a git
    // argument, and a branch name or a leading `-` has no business there.
    if let Some(c) = &commit {
        if !is_full_commit_id(c) {
            return Err("Refusing to install: the pinned commit must be a full 40 character commit id.".to_string());
        }
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

    // A pasted link must never turn into an update of whatever already sits
    // under that name: that folder can come from a different repository.
    if fresh_only && std::fs::symlink_metadata(&target_dir).is_ok() {
        return Err(format!(
            "A node pack named {node_name} is already in the custom_nodes folder. Update it from the list instead."
        ));
    }

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

    // Linux setup stolpstein (BERICHT-5-APPIMAGE.md): fresh Debian 13 and
    // Fedora 43 cloud/desktop images ship no git at all. Probe before
    // spending any bytes on the clone/pull below.
    if let Some(hint) = super::git::git_download_preflight() {
        return Err(hint);
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
            node_log(&format!("{node_name} is already there, updating it (git pull)"));
            // A pinned pack is set to its commit further down and never
            // pulled: a pull is exactly what brings in the newer state the
            // pin is there to keep out.
            if commit.is_none() {
                // A checkout that sat on a pin has no branch to pull into.
                // This is how a pin is released: take it out of the registry
                // and the next install is back on the default branch.
                return_to_default_branch(&target_dir).map_err(|e| format!(
                    "Failed to update {} (git checkout): {}\n\nIf this keeps failing, \
                     delete the folder {} and try the install again.",
                    node_name, e, target_dir.to_string_lossy()
                ))?;
                let output = git_in(&target_dir, &["pull"])
                    .map_err(|e| format!("Git pull failed: {e}"))?;
                log_git_output(&output);
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    error!(node = %node_name, "custom node git pull failed");
                    return Err(format!(
                        "Failed to update {} (git pull): {}\n\nIf this keeps failing, \
                         delete the folder {} and try the install again.",
                        node_name, stderr.trim(), target_dir.to_string_lossy()
                    ));
                }
            }
            fresh_clone = false;
        } else {
            // Not a git repo — pull can never succeed. Move it aside and re-clone.
            let moved_to = move_aside_broken_node_dir(&target_dir)?;
            node_log(&format!(
                "{} exists but is not a git checkout, moved it aside to {} and cloning again",
                node_name,
                moved_to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            ));
        }
    }

    if fresh_clone {
        node_log(&format!("Cloning {repo_url} into custom_nodes/{node_name}"));
        let mut cmd = crate::process_util::foreign_system_command("git");
        cmd.args(["clone", "--", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        quiet_git(&mut cmd);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", os_error::english(&e)))?;
        log_git_output(&output);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(node = %node_name, "custom node clone failed");
            return Err(format!("Failed to clone {}: {}", node_name, stderr));
        }
    }

    // Fresh clone or a checkout that was already there: a pinned pack ends up
    // on its commit either way, so a clone that ran ahead of the pin (every
    // install before the pin existed) is set back by the same click.
    if let Some(c) = &commit {
        node_log(&format!("Setting {node_name} to its tested version {}", &c[..7]));
        checkout_pinned_commit(&target_dir, c).map_err(|e| {
            error!(node = %node_name, "custom node pin checkout failed");
            format!(
                "Failed to set {} to its tested version (git checkout): {}\n\nIf this keeps failing, \
                 delete the folder {} and try the install again.",
                node_name, e, target_dir.to_string_lossy()
            )
        })?;
    }

    // A node pack never replaces torch: its requirements go in against a pin
    // of the torch family this ComfyUI runs on, so a pack that asks for
    // another torch fails by name instead of trading the CUDA build for a
    // CPU wheel. numpy stays free here (unlike the post-repair restore),
    // packs legitimately move it.
    let constraints = node_python(&comfy_dir, fallback_python)
        .and_then(|python| write_package_constraints(&python, &TORCH_PACKAGES));
    let installed = install_requirements_freeing_locked_files(
        &|| install_node_requirements(&comfy_dir, &target_dir, &node_name, fallback_python, constraints.as_deref()),
        pause,
    );
    if let Some(c) = &constraints {
        let _ = fs::remove_file(c);
    }
    installed?;
    node_log(&format!("{node_name} is ready. Restart ComfyUI to load it."));

    Ok(serde_json::json!({
        "status": if fresh_clone { "installed" } else { "updated" },
        "path": target_dir.to_string_lossy(),
    }))
}

/// A full, lowercase or uppercase, 40 character hexadecimal commit id.
fn is_full_commit_id(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One git call inside a node pack's checkout, output captured, no console
/// window on Windows.
pub(super) fn git_in(dir: &std::path::Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = crate::process_util::foreign_system_command("git");
    cmd.args(args).current_dir(dir).stdout(Stdio::piped()).stderr(Stdio::piped());
    quiet_git(&mut cmd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map_err(|e| os_error::english(&e))
}

/// No git may wait for a password nobody can type: a mistyped or private
/// repository answers with a login request, and without a terminal the
/// install would hang there (or the credential manager would open a window).
fn quiet_git(cmd: &mut std::process::Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never");
}

/// What git printed, line by line, into the node pack log. Progress output
/// separates its updates with carriage returns; only the last one counts.
fn log_git_output(output: &std::process::Output) {
    for text in [&output.stdout, &output.stderr] {
        for line in String::from_utf8_lossy(text).lines() {
            let line = line.rsplit('\r').next().unwrap_or(line).trim();
            if !line.is_empty() {
                node_log(line);
            }
        }
    }
}

/// `git_in`, where anything but success is the error text git printed.
fn git_ok(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = git_in(dir, args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Put a node pack's checkout on the commit the registry pins it to.
///
/// The box, 03.10.2026, ComfyUI-RMBG: the pack's head of 30.09.2026 no longer
/// loads on Windows, and the installer cloned whatever the head was. A pinned
/// pack is set to a commit that was seen loading instead. Nothing is fetched
/// when the commit is already there, so a second click works offline.
fn checkout_pinned_commit(target_dir: &std::path::Path, commit: &str) -> Result<(), String> {
    if git_ok(target_dir, &["rev-parse", "HEAD"]).is_ok_and(|head| head.eq_ignore_ascii_case(commit)) {
        return Ok(());
    }
    let object = format!("{commit}^{{commit}}");
    if git_ok(target_dir, &["cat-file", "-e", &object]).is_err() {
        git_ok(target_dir, &["fetch", "origin"])?;
    }
    git_ok(target_dir, &["checkout", "--detach", commit]).map(|_| ())
}

/// Bring a checkout that sits on a bare commit back onto the default branch
/// of its origin, so that a pull has a branch to update. A checkout that is
/// on a branch already is left alone.
fn return_to_default_branch(target_dir: &std::path::Path) -> Result<(), String> {
    if git_ok(target_dir, &["symbolic-ref", "-q", "HEAD"]).is_ok() {
        return Ok(());
    }
    let remote_head = git_ok(target_dir, &["rev-parse", "--abbrev-ref", "origin/HEAD"])?;
    let branch = remote_head.strip_prefix("origin/").unwrap_or(&remote_head);
    git_ok(target_dir, &["checkout", branch]).map(|_| ())
}

/// How the installer takes this app's own ComfyUI out of the way and brings
/// it back. Closures, so the rule below is provable without a process.
pub(crate) struct ComfyPause<'a> {
    pub(crate) stop: &'a dyn Fn() -> super::comfy_repair::OwnComfyStop,
    pub(crate) start: &'a dyn Fn(),
}

/// Install a node pack's requirements, and when pip cannot write a file
/// because a running ComfyUI holds it open, stop that ComfyUI, install again
/// and start it again.
///
/// The box, 03.10.2026, ComfyUI-RMBG: its requirements bring
/// opencv-python-headless, which writes `cv2\cv2.pyd`. The running ComfyUI
/// had that file loaded (VideoHelperSuite imports cv2), Windows refused the
/// write with WinError 5, and four attempts ended on "close any open Python
/// REPLs" while the only Python on the machine was the ComfyUI this app had
/// started itself. The same command went through with ComfyUI stopped.
///
/// Only this app's own, idle ComfyUI is stopped. A render in progress and a
/// ComfyUI started outside the app are left alone, and the message then
/// names them instead of sending the customer after a Python that is not
/// there.
fn install_requirements_freeing_locked_files(
    install: &dyn Fn() -> Result<(), String>,
    pause: &ComfyPause<'_>,
) -> Result<(), String> {
    use super::comfy_repair::OwnComfyStop;
    let reason = match install() {
        Ok(()) => return Ok(()),
        Err(reason) => reason,
    };
    if !is_permission_denied_pip_error(&reason) {
        return Err(reason);
    }
    match (pause.stop)() {
        OwnComfyStop::Stopped => {
            node_log("A running ComfyUI held a file the requirements replace. Stopped it, installing again.");
            let second = install();
            // Back up whether the second try worked or not: it was running
            // before this install touched it.
            (pause.start)();
            second
        }
        OwnComfyStop::Busy => Err(format!(
            "ComfyUI is generating something right now and has a file open that this node pack \
             replaces. Wait for the render to finish, then install again.\n\n{reason}"
        )),
        OwnComfyStop::Foreign => Err(format!(
            "A ComfyUI this app did not start is running and has a file open that this node pack \
             replaces. Close that ComfyUI, then install again.\n\n{reason}"
        )),
        OwnComfyStop::NotRunning
        | OwnComfyStop::QueueUnknown(_)
        | OwnComfyStop::StopFailed(_)
        | OwnComfyStop::StillRunning => Err(reason),
    }
}

/// A ComfyUI without a venv runs on the Python that holds its torch, not on
/// whatever LU resolves as its default today (Discord 14.10.2026), so its
/// node packs go there too. The default stays the answer when no Python has
/// torch: ComfyUI cannot start then anyway, and the start says why.
fn venvless_python(comfy_dir: &std::path::Path, fallback_python: &str) -> String {
    if fallback_python.is_empty() {
        return String::new();
    }
    crate::commands::process::bound_comfy_python(comfy_dir, fallback_python).unwrap_or_else(|| fallback_python.to_string())
}

/// The Python a node pack's requirements go into: ComfyUI's venv when it has
/// a usable one, the fallback otherwise. None for a broken venv, which
/// `install_node_requirements` reports in its own words.
fn node_python(comfy_dir: &std::path::Path, fallback_python: &str) -> Option<String> {
    match crate::python::comfy_venv_state(comfy_dir) {
        crate::python::ComfyVenv::Usable(p) => Some(p),
        crate::python::ComfyVenv::Broken { .. } => None,
        crate::python::ComfyVenv::Absent if fallback_python.is_empty() => None,
        crate::python::ComfyVenv::Absent => Some(venvless_python(comfy_dir, fallback_python)),
    }
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
pub(crate) fn install_node_requirements(
    comfy_dir: &std::path::Path,
    target_dir: &std::path::Path,
    node_name: &str,
    fallback_python: &str,
    constraints: Option<&std::path::Path>,
) -> Result<(), String> {
    let reqs = target_dir.join("requirements.txt");
    if !reqs.exists() {
        return Ok(());
    }
    // P3, dritte Stelle mit derselben Frage: ein venv ohne Interpreter ist
    // nicht "kein venv". Die Anforderungen des Knotens landeten sonst im
    // System-Python, aus dem dieses ComfyUI nie startet, und der Knoten fehlt
    // beim naechsten Lauf trotzdem.
    let python_bin = match crate::python::comfy_venv_state(comfy_dir) {
        crate::python::ComfyVenv::Usable(p) => p,
        crate::python::ComfyVenv::Broken { venv_dir, interpreter } => {
            return Err(crate::commands::process::comfy_broken_venv_message(&venv_dir, &interpreter));
        }
        crate::python::ComfyVenv::Absent => venvless_python(comfy_dir, fallback_python),
    };
    if python_bin.is_empty() {
        return Err(format!(
            "Custom node {} cloned, but cannot install requirements: \
             no Python available. Install Python first \
             (Settings → ComfyUI → Install Python).",
            node_name
        ));
    }
    node_log(&format!("Installing the requirements of {node_name} with {python_bin}"));
    let run_pip = |extra: &[&str]| -> Result<std::process::Output, String> {
        let mut pip = python_command(&python_bin);
        pip.args(["-m", "pip", "install", "--no-input"]);
        // Runde 6, Folgeposten (a) (review Runde 5, F2): a node's own
        // requirements.txt must not be allowed to quietly downgrade the
        // core packages a repair just verified (`numpy<2`, an unpinned old
        // torch, ...). With `-c`, pip refuses to install anything that
        // conflicts with a constraint instead of silently changing it, so
        // THIS install fails, loudly, by name, through the ordinary
        // per-node failure path below.
        if let Some(c) = constraints {
            pip.arg("-c").arg(c);
        }
        pip.args(extra);
        pip.arg("-r").arg(&reqs);
        // Line by line into the node pack log while pip runs, so the Settings
        // list shows what a long install is doing instead of a still spinner.
        pip.env("PYTHONUNBUFFERED", "1");
        output_logging_lines(pip)
            .map_err(|e| format!("Failed to spawn pip for {} requirements: {}", node_name, os_error::english(&e)))
    };
    let pip_out = run_pip(&[])?;
    if !pip_out.status.success() {
        let stderr = String::from_utf8_lossy(&pip_out.stderr);
        let stdout = String::from_utf8_lossy(&pip_out.stdout);
        // The words of the operating system are ours to answer for: a German
        // Windows hands pip "Zugriff verweigert", and the line is shown in an
        // English app. What pip wrote itself stays as it is.
        let combined: String = format!("{}{}", stdout, stderr)
            .lines()
            .map(|line| os_error::english_child_text(line).into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        // python.org installs under Program Files have an admin-only
        // site-packages: the first node pack whose requirements pull a NEW
        // wheel dies with a permission error, while packs whose deps are
        // already present sail through (why RMBG/VHS installs passed and
        // controlnet_aux stranded the Motion install card, 2026-07-19).
        // Retry into the per-user site — the same interpreter imports from
        // there, no admin needed. The Windows twin of the PEP 668 --user
        // escape above; if the retry fails too we surface the original
        // diagnosis. A venv is asked first and never retried: pip refuses
        // `--user` there, whether it is ComfyUI's own venv or a fallback
        // Python that happens to be one.
        if is_permission_denied_pip_error(&combined)
            && user_site_allowed(is_venv_python(&python_bin))
        {
            node_log(&format!(
                "{node_name} requirements hit a permission error, retrying into the user site (--user)"
            ));
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


/// `Command::output`, with every line of stdout and stderr also handed to the
/// node pack log as it arrives. The collected bytes are the same as
/// `output()` would return, so the diagnosis below reads what it always read.
fn output_logging_lines(mut cmd: std::process::Command) -> std::io::Result<std::process::Output> {
    use std::io::{BufRead, BufReader, Read};
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    fn pump(stream: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let Some(stream) = stream else { return all };
            let mut reader = BufReader::new(stream);
            let mut line = Vec::new();
            while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim_end();
                if !text.is_empty() {
                    node_log(text);
                }
                all.extend_from_slice(&line);
                line.clear();
            }
            all
        })
    }
    let out = pump(child.stdout.take());
    let err = pump(child.stderr.take());
    let status = child.wait()?;
    Ok(std::process::Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// Runde 6, Folgeposten (a) (review Runde 5, F2): the core packages a
/// repair just spent four steps building and verifying, as a `pip freeze`
/// snapshot a caller can hand to [`install_node_requirements`] as a
/// constraints file so pip REFUSES to let a node's own requirements.txt
/// quietly change any of them.
pub(crate) const CORE_PACKAGES: [&str; 4] = ["torch", "torchvision", "torchaudio", "numpy"];

/// What a single node pack install must never replace (see
/// `install_custom_node_blocking`).
const TORCH_PACKAGES: [&str; 3] = ["torch", "torchvision", "torchaudio"];

/// Write the current, exact versions of `packages` (from `pip freeze`
/// against `python_bin`) to a fresh temp file in pip's constraints format
/// (one `name==version` per line) and return its path. `None` when `pip
/// freeze` itself fails to run, or when none of the core packages turn out
/// to be installed. A ComfyUI venv should always have torch, but this must
/// never invent a pin rather than silently skip constraining.
///
/// The caller owns the returned file and is responsible for deleting it once
/// the node loop that uses it is done; this function only ever creates one.
pub(crate) fn write_package_constraints(python_bin: &str, packages: &[&str]) -> Option<PathBuf> {
    let mut cmd = python_command(python_bin);
    cmd.args(["-m", "pip", "freeze"]).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let freeze = String::from_utf8_lossy(&out.stdout);
    let core_lines = constraint_lines(&freeze, packages);
    if core_lines.is_empty() {
        return None;
    }
    let path = std::env::temp_dir().join(format!(
        "lu-node-constraints-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    fs::write(&path, core_lines.join("\n")).ok()?;
    Some(path)
}

/// Pure: the subset of a `pip freeze` listing that names one of
/// `packages`, for exactly the reason every other network- or
/// process-touching function in this codebase splits its parsing out:
/// testable against a canned string, no pip and no venv required.
///
/// Runde 6, F14 (review Runde 6, Abschnitt 9): `pip freeze` prints a package
/// installed from a local wheel or a direct URL as a PEP 508 direct
/// reference, `torch @ file:///.../torch-2.7.0-cp312-cp312-linux_x86_64.whl`
/// rather than `torch==2.7.0`. The name-matching filter still finds "torch"
/// in that line (the split on `' '` catches the name before the `@` is ever
/// reached), so it used to sail into the constraints file unchanged. pip
/// refuses a `@` line in a CONSTRAINTS file outright ("links are not allowed
/// as constraints"), and that refusal is not per-package: it fails the whole
/// `-c <file>` argument, so EVERY custom node's own install would start
/// failing, not just the one node that happens to touch a core package. A
/// venv built the normal way, from the index, never produces this shape (see
/// `write_package_constraints`'s own doc: it only ever reads THIS
/// venv's `pip freeze` after this repair's own build), so this is a defensive
/// skip for a shape that should not occur today, not a shape this file
/// exercises against a real freeze.
fn constraint_lines<'a>(freeze: &'a str, packages: &[&str]) -> Vec<&'a str> {
    freeze
        .lines()
        .filter(|line| {
            let name = line
                .split(['=', '@', ' ', '<', '>', '~', '!'])
                .next()
                .unwrap_or("")
                .to_lowercase();
            packages.contains(&name.as_str()) && !line.contains('@')
        })
        .collect()
}

/// What a custom-node dependency restore actually did, so the caller can
/// tell a customer which nodes came back, which did not, and whether the
/// user cancelled partway rather than every node simply having run.
pub(crate) struct NodeReinstallOutcome {
    /// Node folder names whose requirements installed cleanly.
    pub(crate) reinstalled: Vec<String>,
    /// Node folder name plus the reason, for every one that failed.
    pub(crate) failures: Vec<(String, String)>,
    /// True when the cancel flag was seen between nodes and the loop
    /// stopped early; `reinstalled`/`failures` only cover what ran before
    /// that point.
    pub(crate) cancelled: bool,
}

impl NodeReinstallOutcome {
    /// Runde 6, F13 (review Runde 6, Abschnitt 5): the second verification
    /// gate after the node loop used to run only when EVERY node succeeded
    /// (`failures.is_empty()`), so one unrelated node failure skipped the
    /// gate even though a DIFFERENT node had already installed something and
    /// could have quietly downgraded a core package. What decides whether
    /// there is anything new to re-verify is whether at least one node's
    /// requirements actually got installed, not whether every node did.
    pub(crate) fn needs_reverification(&self) -> bool {
        !self.reinstalled.is_empty()
    }
}

/// Runde 5 (review-engine.md Runde 4, Folgeposten): after the repair
/// rebuilds `ComfyUI/venv` from nothing, every EXISTING `custom_nodes/*`
/// folder's own `requirements.txt` (RMBG, VHS, controlnet_aux, whatever the
/// customer had cloned in) is gone from the fresh venv, unlike ComfyUI's own
/// core requirements, which the repair already reinstalls. The repair's own
/// log line and the "Repair environment" tooltip both say "custom nodes stay
/// untouched", true for the FOLDERS but not for what those nodes need to
/// import; without this, "untouched" is a promise the repair does not keep.
///
/// Reuses [`install_node_requirements`], the SAME function `install_custom_node`
/// itself calls (#72's rule: one function for every path that installs a
/// node's requirements, so a fix never lands in only one of them), nothing
/// here re-implements pip or PEP 668 handling.
///
/// One folder's failure never stops the rest: a customer with five nodes and
/// one broken one should get four working nodes back, not zero, and the
/// caller is told which one(s) failed so it can say so instead of silently
/// claiming success.
///
/// Runde 6, Folgeposten (a) and (b) (review Runde 5, F2/F3): `constraints`
/// (from [`write_package_constraints`]) is passed straight through to
/// every node's own install so none of them can quietly downgrade torch or
/// numpy; `cancel` is read BETWEEN nodes so a customer with twenty of them
/// can actually stop the run instead of the Cancel button doing nothing
/// (F3); and `on_progress` is called with each node's name before it starts,
/// so the log carries one line per node instead of a single blanket
/// sentence for the whole batch.
pub(crate) fn reinstall_all_node_requirements(
    comfy_dir: &std::path::Path,
    fallback_python: &str,
    constraints: Option<&std::path::Path>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
    mut on_progress: impl FnMut(&str),
) -> NodeReinstallOutcome {
    let nodes_dir = comfy_dir.join("custom_nodes");
    let Ok(entries) = fs::read_dir(&nodes_dir) else {
        return NodeReinstallOutcome { reinstalled: Vec::new(), failures: Vec::new(), cancelled: false };
    };
    let mut failures = Vec::new();
    let mut reinstalled = Vec::new();
    let mut names: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // The move-aside convention above: a folder ComfyUI itself never
            // loads must not be reinstalled into either, it is not a live
            // node. `__pycache__` is not a node folder; harmless to skip.
            if name.ends_with(".disabled") || name == "__pycache__" {
                None
            } else {
                Some((name, e.path()))
            }
        })
        .collect();
    // Deterministic order: a real folder listing order is filesystem- and
    // platform-dependent, and a customer-facing failure list that reorders
    // itself between runs reads as flaky even when the underlying cause is
    // stable.
    names.sort();
    for (name, target_dir) in names {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
            return NodeReinstallOutcome { reinstalled, failures, cancelled: true };
        }
        on_progress(&name);
        if let Err(e) = install_node_requirements(comfy_dir, &target_dir, &name, fallback_python, constraints) {
            error!(node = %name, error = %e, "custom node requirements could not be restored after a repair");
            failures.push((name, e));
        } else {
            reinstalled.push(name);
        }
    }
    NodeReinstallOutcome { reinstalled, failures, cancelled: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── A file the running ComfyUI holds open (the box, 03.10.2026) ─────

    use super::super::comfy_repair::OwnComfyStop;
    use std::cell::{Cell, RefCell};

    /// What the app said on the box, with pip's real last line in it.
    const LOCKED: &str = "Custom node ComfyUI-RMBG is cloned, but its requirements install failed.\n\n\
        Permission denied. Make sure no other process is using Python, then retry.\n\n--- pip output ---\n\
        ERROR: Could not install packages due to an OSError: [WinError 5] access is denied: \
        'C:\\\\Users\\\\alice\\\\ComfyUI\\\\venv\\\\Lib\\\\site-packages\\\\cv2\\\\cv2.pyd'\nCheck the permissions.";

    /// Runs the rule with a pip that fails `failures` times on the locked
    /// file, and records the order of everything that happened.
    fn run_locked(failures: usize, found: fn() -> OwnComfyStop) -> (Result<(), String>, Vec<&'static str>) {
        let events = RefCell::new(Vec::new());
        let left = Cell::new(failures);
        let install = || {
            events.borrow_mut().push("pip");
            if left.get() > 0 {
                left.set(left.get() - 1);
                Err(LOCKED.to_string())
            } else {
                Ok(())
            }
        };
        let stop = || {
            events.borrow_mut().push("stop");
            found()
        };
        let start = || events.borrow_mut().push("start");
        let result = install_requirements_freeing_locked_files(&install, &ComfyPause { stop: &stop, start: &start });
        (result, events.into_inner())
    }

    #[test]
    fn a_file_held_by_the_apps_own_comfyui_is_freed_and_the_install_goes_through() {
        let (result, events) = run_locked(1, || OwnComfyStop::Stopped);
        assert_eq!(result, Ok(()));
        assert_eq!(events, ["pip", "stop", "pip", "start"]);
    }

    #[test]
    fn comfyui_comes_back_up_even_when_the_second_try_fails_too() {
        let (result, events) = run_locked(2, || OwnComfyStop::Stopped);
        assert_eq!(result, Err(LOCKED.to_string()));
        assert_eq!(events, ["pip", "stop", "pip", "start"], "a ComfyUI this install stopped must be started again");
    }

    #[test]
    fn an_install_that_works_never_touches_comfyui() {
        let (result, events) = run_locked(0, || OwnComfyStop::Stopped);
        assert_eq!(result, Ok(()));
        assert_eq!(events, ["pip"]);
    }

    #[test]
    fn a_failure_that_is_no_locked_file_never_stops_comfyui() {
        let events = RefCell::new(Vec::new());
        let install = || -> Result<(), String> {
            events.borrow_mut().push("pip");
            Err("ERROR: No matching distribution found for decord".to_string())
        };
        let stop = || {
            events.borrow_mut().push("stop");
            OwnComfyStop::Stopped
        };
        let start = || events.borrow_mut().push("start");
        let result = install_requirements_freeing_locked_files(&install, &ComfyPause { stop: &stop, start: &start });
        assert_eq!(result, Err("ERROR: No matching distribution found for decord".to_string()));
        assert_eq!(events.into_inner(), ["pip"]);
    }

    #[test]
    fn a_render_in_progress_is_not_interrupted_and_the_message_says_so() {
        let (result, events) = run_locked(1, || OwnComfyStop::Busy);
        let msg = result.unwrap_err();
        assert!(msg.starts_with("ComfyUI is generating something right now"), "got: {msg}");
        assert!(msg.contains("cv2.pyd"), "pip's own line with the file is gone: {msg}");
        assert_eq!(events, ["pip", "stop"], "no second pip and no start for a ComfyUI nobody stopped");
    }

    #[test]
    fn a_comfyui_started_outside_the_app_is_named_instead_of_a_python_repl() {
        let (result, events) = run_locked(1, || OwnComfyStop::Foreign);
        let msg = result.unwrap_err();
        assert!(msg.starts_with("A ComfyUI this app did not start is running"), "got: {msg}");
        assert!(msg.contains("Close that ComfyUI, then install again."), "got: {msg}");
        assert_eq!(events, ["pip", "stop"]);
    }

    #[test]
    fn with_no_comfyui_on_the_port_the_plain_reason_stands() {
        let (result, events) = run_locked(1, || OwnComfyStop::NotRunning);
        assert_eq!(result, Err(LOCKED.to_string()));
        assert_eq!(events, ["pip", "stop"]);
    }

    /// The pin a single node pack install runs against is the torch family
    /// only: a pack may move numpy, it never replaces torch.
    #[test]
    fn a_node_pack_is_held_to_the_installed_torch_and_free_on_numpy() {
        let freeze = "numpy==2.4.6\ntorch==2.14.0+cu130\ntorchaudio==2.14.0+cu130\ntorchvision==0.29.0+cu130\nopencv-python==5.0.0.93\n";
        assert_eq!(
            constraint_lines(freeze, &TORCH_PACKAGES),
            ["torch==2.14.0+cu130", "torchaudio==2.14.0+cu130", "torchvision==0.29.0+cu130"]
        );
    }

    /// Source guard: the rule above is worth nothing if the command does not
    /// run its pip through it, with the pin.
    #[test]
    fn install_custom_node_runs_its_requirements_through_the_rule_with_the_torch_pin() {
        let src = include_str!("custom_nodes.rs");
        let start = src.find("fn install_custom_node_blocking(").expect("install_custom_node_blocking is gone");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("install_custom_node_blocking has no end")];
        assert!(body.contains("install_requirements_freeing_locked_files("), "the install no longer frees a locked file");
        assert!(body.contains("&TORCH_PACKAGES"), "the install no longer pins torch");
    }

    // ── A pinned node pack (the box, 03.10.2026, ComfyUI-RMBG) ──────────

    fn test_git(dir: &std::path::Path, args: &[&str]) -> String {
        let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
        all.extend_from_slice(args);
        git_ok(dir, &all).unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
    }

    /// An origin with two commits and a clone of it that sits on the newer
    /// one, the state every install before the pin left behind. Returns the
    /// temp dir, the clone and the two commit ids, older first.
    fn origin_and_clone() -> (tempfile::TempDir, PathBuf, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir(&origin).unwrap();
        test_git(&origin, &["init", "-b", "main"]);
        std::fs::write(origin.join("node.py"), "good").unwrap();
        test_git(&origin, &["add", "."]);
        test_git(&origin, &["commit", "-m", "good"]);
        let good = test_git(&origin, &["rev-parse", "HEAD"]);
        std::fs::write(origin.join("node.py"), "broken").unwrap();
        test_git(&origin, &["commit", "-am", "broken"]);
        let broken = test_git(&origin, &["rev-parse", "HEAD"]);
        let clone = tmp.path().join("clone");
        test_git(tmp.path(), &["clone", &origin.to_string_lossy(), &clone.to_string_lossy()]);
        (tmp, clone, good, broken)
    }

    #[test]
    fn a_clone_that_ran_ahead_is_set_back_to_the_pinned_commit() {
        let (_tmp, clone, good, broken) = origin_and_clone();
        assert_eq!(test_git(&clone, &["rev-parse", "HEAD"]), broken);

        checkout_pinned_commit(&clone, &good).unwrap();

        assert_eq!(test_git(&clone, &["rev-parse", "HEAD"]), good);
        assert_eq!(std::fs::read_to_string(clone.join("node.py")).unwrap(), "good");
        // A second click finds the pin in place and has nothing to do.
        checkout_pinned_commit(&clone, &good).unwrap();
        assert_eq!(test_git(&clone, &["rev-parse", "HEAD"]), good);
    }

    #[test]
    fn a_pin_the_clone_has_not_seen_yet_is_fetched_first() {
        let (tmp, clone, _good, _broken) = origin_and_clone();
        let origin = tmp.path().join("origin");
        std::fs::write(origin.join("node.py"), "fixed").unwrap();
        test_git(&origin, &["commit", "-am", "fixed"]);
        let fixed = test_git(&origin, &["rev-parse", "HEAD"]);

        checkout_pinned_commit(&clone, &fixed).unwrap();

        assert_eq!(std::fs::read_to_string(clone.join("node.py")).unwrap(), "fixed");
    }

    #[test]
    fn a_pin_that_does_not_exist_is_an_error_and_leaves_the_checkout_alone() {
        let (_tmp, clone, _good, broken) = origin_and_clone();
        let err = checkout_pinned_commit(&clone, "0123456789012345678901234567890123456789").unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(test_git(&clone, &["rev-parse", "HEAD"]), broken);
    }

    #[test]
    fn a_released_pin_goes_back_to_the_default_branch_and_pulls_again() {
        let (_tmp, clone, good, broken) = origin_and_clone();
        checkout_pinned_commit(&clone, &good).unwrap();
        assert!(git_ok(&clone, &["symbolic-ref", "-q", "HEAD"]).is_err(), "the pin leaves no branch checked out");

        return_to_default_branch(&clone).unwrap();

        assert_eq!(test_git(&clone, &["symbolic-ref", "--short", "HEAD"]), "main");
        test_git(&clone, &["pull"]);
        assert_eq!(test_git(&clone, &["rev-parse", "HEAD"]), broken);
        // On a branch already: nothing to do, and no error.
        return_to_default_branch(&clone).unwrap();
    }

    #[test]
    fn only_a_full_commit_id_is_a_pin() {
        assert!(is_full_commit_id("58f1947a11567a9f8b707223185570850e773856"));
        assert!(!is_full_commit_id("58f1947"));
        assert!(!is_full_commit_id("main"));
        assert!(!is_full_commit_id("--upload-pack=touch /tmp/x; aaaaaaaaaaaaaaaa"));
        assert!(!is_full_commit_id("58f1947a11567a9f8b707223185570850e77385g"));
    }

    /// Source guard: the pin is worth nothing if the command pulls a pinned
    /// pack forward or never runs the checkout.
    #[test]
    fn install_custom_node_sets_a_pinned_pack_to_its_commit_and_never_pulls_it() {
        let src = include_str!("custom_nodes.rs");
        let start = src.find("fn install_custom_node_blocking(").expect("install_custom_node_blocking is gone");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("install_custom_node_blocking has no end")];
        let at_guard = body.find("if commit.is_none() {").expect("the pull is no longer skipped for a pinned pack");
        let at_pull = body.find("\"pull\"").expect("the pull is gone");
        assert!(at_guard < at_pull, "the pull must sit inside the unpinned branch");
        let at_pin = body.find("checkout_pinned_commit(").expect("a pinned pack is no longer set to its commit");
        let at_reqs = body.find("install_requirements_freeing_locked_files(").expect("the requirements install is gone");
        assert!(at_pin < at_reqs, "the requirements must be the pinned commit's, so the checkout comes first");
    }

    // ── The node pack manager (GitHub wish #14) on this path ────────────

    fn no_pause() -> (impl Fn() -> OwnComfyStop, impl Fn()) {
        (|| OwnComfyStop::NotRunning, || {})
    }

    /// A ComfyUI folder with a fake venv Python that answers every pip call
    /// with two lines, a bare repository as the origin, and a checkout of it
    /// in custom_nodes/Pack that is one commit behind. No network, no pip.
    #[cfg(unix)]
    fn comfy_with_a_pack_behind() -> (tempfile::TempDir, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let python = comfy.join("venv/bin/python");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "#!/bin/sh\necho 'Collecting gguf'\necho 'Successfully installed gguf-0.1'\n").unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();

        let work = tmp.path().join("work");
        std::fs::create_dir(&work).unwrap();
        test_git(&work, &["init", "-b", "main"]);
        std::fs::write(work.join("__init__.py"), "v1").unwrap();
        test_git(&work, &["add", "."]);
        test_git(&work, &["commit", "-m", "v1"]);
        let bare = tmp.path().join("origin.git");
        test_git(tmp.path(), &["clone", "--bare", &work.to_string_lossy(), &bare.to_string_lossy()]);
        let pack = comfy.join("custom_nodes/Pack");
        test_git(tmp.path(), &["clone", &bare.to_string_lossy(), &pack.to_string_lossy()]);

        std::fs::write(work.join("__init__.py"), "v2").unwrap();
        std::fs::write(work.join("requirements.txt"), "gguf\n").unwrap();
        test_git(&work, &["add", "."]);
        test_git(&work, &["commit", "-m", "v2"]);
        test_git(&work, &["push", &bare.to_string_lossy(), "main"]);
        (tmp, comfy, pack)
    }

    #[cfg(unix)]
    #[test]
    fn an_update_pulls_the_pack_installs_its_requirements_and_logs_both() {
        let (_tmp, comfy, pack) = comfy_with_a_pack_behind();
        let (stop, start) = no_pause();
        let mark = super::super::custom_node_packs::tests_log_mark();
        let result = install_custom_node_blocking(
            "https://github.com/someone/Pack".into(), "Pack".into(), None, false,
            Some(comfy.to_string_lossy().into_owned()), "", &ComfyPause { stop: &stop, start: &start },
        )
        .unwrap();
        assert_eq!(result["status"], "updated");
        assert_eq!(std::fs::read_to_string(pack.join("__init__.py")).unwrap(), "v2");
        let log = super::super::custom_node_packs::tests_log_since(mark).join("\n");
        assert!(log.contains("Pack is already there, updating it (git pull)"), "{log}");
        assert!(log.contains("Installing the requirements of Pack"), "{log}");
        assert!(log.contains("Successfully installed gguf-0.1"), "{log}");
        assert!(log.contains("Pack is ready. Restart ComfyUI to load it."), "{log}");
    }

    #[cfg(unix)]
    #[test]
    fn a_pasted_link_never_updates_a_folder_that_is_already_there() {
        let (_tmp, comfy, pack) = comfy_with_a_pack_behind();
        let (stop, start) = no_pause();
        let err = install_custom_node_blocking(
            "https://github.com/someone-else/Pack".into(), "Pack".into(), None, true,
            Some(comfy.to_string_lossy().into_owned()), "", &ComfyPause { stop: &stop, start: &start },
        )
        .unwrap_err();
        assert!(err.contains("already in the custom_nodes folder"), "{err}");
        assert_eq!(std::fs::read_to_string(pack.join("__init__.py")).unwrap(), "v1", "it was pulled anyway");
    }

    #[test]
    fn a_link_to_another_host_is_refused_before_anything_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (stop, start) = no_pause();
        for url in ["https://example.com/a/Pack", "http://github.com/a/Pack", "https://github.com/a/Pack/tree/main"] {
            let err = install_custom_node_blocking(
                url.into(), "Pack".into(), None, true,
                Some(tmp.path().to_string_lossy().into_owned()), "", &ComfyPause { stop: &stop, start: &start },
            )
            .unwrap_err();
            assert!(err.starts_with("Refusing to install:"), "{url}: {err}");
        }
        assert!(!tmp.path().join("custom_nodes").exists(), "a refused link still created the folder");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_logged_line_by_line_still_returns_all_its_output() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo one; echo two >&2; echo three; exit 3"]);
        let out = output_logging_lines(cmd).unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "one\nthree\n");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "two\n");
    }

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
        assert!(install_node_requirements(&comfy, &node, "NoReqs", "", None).is_ok());
    }

    #[test]
    fn requirements_install_without_python_is_actionable() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        let node = tmp.path().join("comfy/custom_nodes/WithReqs");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("requirements.txt"), "imageio-ffmpeg").unwrap();

        let err = install_node_requirements(&comfy, &node, "WithReqs", "", None).unwrap_err();
        assert!(err.contains("no Python available"), "got: {err}");
    }

    // ── Runde 6, Folgeposten (a): core-package constraints (review Runde 5,
    // F2) ─────────────────────────────────────────────────────────────────

    #[test]
    fn constraint_lines_keeps_only_the_core_packages() {
        let freeze = "torch==2.7.0\n\
                      torchvision==0.22.0\n\
                      numpy==1.26.4\n\
                      Pillow==11.0.0\n\
                      comfyui-frontend-package==1.2.3\n\
                      torchaudio==2.7.0\n";
        let lines = constraint_lines(freeze, &CORE_PACKAGES);
        assert_eq!(lines, vec!["torch==2.7.0", "torchvision==0.22.0", "numpy==1.26.4", "torchaudio==2.7.0"]);
        // Negative control: neither Pillow nor comfyui-frontend-package,
        // both real ComfyUI-venv packages, may leak into the constraints.
        assert!(!lines.iter().any(|l| l.to_lowercase().starts_with("pillow")));
        assert!(!lines.iter().any(|l| l.to_lowercase().starts_with("comfyui")));
    }

    #[test]
    fn constraint_lines_is_empty_for_a_freeze_with_no_core_packages() {
        // Negativkontrolle: a venv that somehow has no torch at all must not
        // invent a pin; an empty result is what tells the caller not to
        // write a constraints file.
        assert!(constraint_lines("Pillow==11.0.0\nrequests==2.32.0\n", &CORE_PACKAGES).is_empty());
        assert!(constraint_lines("", &CORE_PACKAGES).is_empty());
    }

    #[test]
    fn constraint_lines_is_not_fooled_by_a_name_prefix() {
        // "torch" must not match "torchsde" or "torchdiffeq", real
        // dependencies in a ComfyUI venv that are not the core packages this
        // constraints file exists to protect.
        let freeze = "torchsde==0.2.6\ntorchdiffeq==0.2.4\ntorch==2.7.0\n";
        let lines = constraint_lines(freeze, &CORE_PACKAGES);
        assert_eq!(lines, vec!["torch==2.7.0"]);
    }

    /// Runde 6, F14 (review Runde 6, Abschnitt 9): a package installed from a
    /// local wheel or a direct URL freezes as a PEP 508 direct reference
    /// (`torch @ file:///...`). pip's own name-splitting still finds "torch"
    /// in that line, so without the `@` check this line would sail into the
    /// constraints file, and pip refuses a `@` line in a constraints file
    /// outright ("links are not allowed as constraints"), failing every
    /// node's install, not only the one that touches torch.
    #[test]
    fn a_direct_url_reference_line_is_skipped_even_though_its_name_matches() {
        let freeze = "torch @ file:///tmp/torch-2.7.0-cp312-cp312-linux_x86_64.whl\n\
                      numpy==1.26.4\n";
        let lines = constraint_lines(freeze, &CORE_PACKAGES);
        assert_eq!(lines, vec!["numpy==1.26.4"], "the @ line must not appear in the constraints at all: {lines:?}");
    }

    // ── permission-denied → --user retry (Motion install card, 2026-07-19) ──

    // ── Runde 6, Folgeposten (b): cancel + per-node progress ──────────────

    #[test]
    fn the_node_loop_stops_early_when_cancelled_and_reports_it() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        for name in ["AlphaNode", "BetaNode"] {
            std::fs::create_dir_all(comfy.join("custom_nodes").join(name)).unwrap();
            // No requirements.txt: a node that WOULD succeed instantly if
            // reached, so a green "cancelled" result here is only possible
            // because the loop actually stopped before reaching it.
        }
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut seen: Vec<String> = Vec::new();
        let outcome = reinstall_all_node_requirements(&comfy, "", None, Some(&cancel), |name| seen.push(name.to_string()));

        assert!(outcome.cancelled, "a pre-set cancel flag did not stop the loop");
        assert!(seen.is_empty(), "a node was started after cancel was already set: {seen:?}");
        assert!(outcome.reinstalled.is_empty());
        assert!(outcome.failures.is_empty());
    }

    #[test]
    fn a_negative_control_without_cancel_runs_every_node_and_reports_none_cancelled() {
        // Negativkontrolle for the test above: without a raised flag, every
        // node folder is visited and none is reported as cancelled.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        for name in ["AlphaNode", "BetaNode", "__pycache__", "GammaNode.disabled"] {
            std::fs::create_dir_all(comfy.join("custom_nodes").join(name)).unwrap();
        }
        let mut seen: Vec<String> = Vec::new();
        let outcome = reinstall_all_node_requirements(&comfy, "", None, None, |name| seen.push(name.to_string()));

        assert!(!outcome.cancelled);
        // Deterministic, sorted order; __pycache__ and the disabled node are
        // never real nodes and must not be visited at all.
        assert_eq!(seen, vec!["AlphaNode", "BetaNode"]);
        assert_eq!(outcome.reinstalled, vec!["AlphaNode", "BetaNode"]);
        assert!(outcome.failures.is_empty());
    }

    // ── Runde 6, F13: the second verification gate must run whenever
    // anything was actually installed, even if a DIFFERENT node failed ──────

    #[test]
    fn needs_reverification_is_true_even_when_one_node_also_failed() {
        // The exact F13 case: node A installed cleanly (and could have
        // downgraded a core package), node B failed for its own unrelated
        // reason. The old `failures.is_empty()` gate would have skipped
        // re-verification here solely because of node B, over damage node A
        // may have already done.
        let outcome = NodeReinstallOutcome {
            reinstalled: vec!["AlphaNode".to_string()],
            failures: vec![("BetaNode".to_string(), "pip exited 1".to_string())],
            cancelled: false,
        };
        assert!(outcome.needs_reverification());
    }

    #[test]
    fn needs_reverification_is_false_when_nothing_installed_even_with_failures() {
        // Negative control: every node failed outright, nothing was ever
        // installed, so there is nothing new for a second gate to catch.
        let outcome = NodeReinstallOutcome {
            reinstalled: Vec::new(),
            failures: vec![("BetaNode".to_string(), "pip exited 1".to_string())],
            cancelled: false,
        };
        assert!(!outcome.needs_reverification());
    }

    #[test]
    fn needs_reverification_is_true_on_a_clean_run() {
        let outcome = NodeReinstallOutcome {
            reinstalled: vec!["AlphaNode".to_string()],
            failures: Vec::new(),
            cancelled: false,
        };
        assert!(outcome.needs_reverification());
    }
}

/// Review Runde 2, B1: nothing may delete the Linux git preflight in
/// `install_custom_node_blocking` or move it after the pull or the clone it
/// is meant to guard, without a test going red. Same technique as
/// process_util.rs's `the_argv_matchers_share_one_refresh`.
#[cfg(test)]
mod git_preflight_call_site_guard {
    #[test]
    fn install_custom_node_checks_git_before_pull_and_before_clone() {
        let src = include_str!("custom_nodes.rs");
        let fn_start = src
            .find("fn install_custom_node_blocking(")
            .expect("install_custom_node_blocking is gone from custom_nodes.rs");
        let body = &src[fn_start..];

        let at_preflight = body.find("git_download_preflight()").expect(
            "install_custom_node_blocking no longer calls git_download_preflight(): \
             a fresh Debian 13 or Fedora 43 box without git would clone or pull \
             straight into a cryptic spawn error again",
        );
        let at_pull = body
            .find("\"pull\"")
            .expect("the git pull literal (update branch) is gone from install_custom_node_blocking");
        let at_clone = body
            .find("\"clone\"")
            .expect("the git clone literal (fresh install branch) is gone from install_custom_node_blocking");

        assert!(
            at_preflight < at_pull,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             update pull (byte {at_pull}), not after"
        );
        assert!(
            at_preflight < at_clone,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             fresh clone (byte {at_clone}), not after"
        );
    }
}
