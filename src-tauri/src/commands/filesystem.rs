use crate::os_error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::Engine;
use glob::glob as glob_match;
use once_cell::sync::Lazy;
use regex::RegexBuilder;
use walkdir::WalkDir;

/// Strip duplicate drive-letter prefixes, e.g.
/// `D:/a/D:/a/file.txt` → `D:/a/file.txt`. See commands/agent.rs for
/// the full rationale — same bug surface for fs_list / fs_search.
fn normalize_duplicate_drive_prefix(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() < 3 { return path.to_string(); }
    let mut last_drive_idx: Option<usize> = None;
    let mut i = 1;
    while i + 1 < bytes.len() {
        if bytes[i] == b':'
            && bytes[i - 1].is_ascii_alphabetic()
            && (bytes[i + 1] == b'/' || bytes[i + 1] == b'\\')
        {
            last_drive_idx = Some(i - 1);
        }
        i += 1;
    }
    match last_drive_idx {
        Some(idx) if idx > 0 => path[idx..].to_string(),
        _ => path.to_string(),
    }
}

/// Lexically normalize a path (resolve `.` / `..` segments without touching
/// the filesystem) so containment can be checked deterministically even for a
/// path that doesn't exist yet (e.g. a file about to be created).
fn lexical_normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve symlinks as far as the path actually exists, then re-attach the
/// rest verbatim.
///
/// Plain `canonicalize` is unusable here because half the paths that reach the
/// jail don't exist yet (`file_write` creating a new file), and plain lexical
/// normalization is unusable as a *boundary* because it believes the path
/// string: a symlink inside the workspace pointing at `~/.ssh` reads as
/// `<root>/link/id_rsa` and sails through containment while the open() behind
/// it lands outside. Canonicalizing the deepest EXISTING ancestor covers both —
/// the link is resolved, the not-yet-created tail is kept.
fn resolve_existing_prefix(p: &Path) -> PathBuf {
    let normalized = lexical_normalize(p);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = normalized.clone();
    loop {
        if let Ok(real) = fs::canonicalize(&cur) {
            let mut out = real;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return out;
        }
        let name = match cur.file_name() {
            Some(n) => n.to_os_string(),
            None => return normalized, // hit a root / prefix: nothing exists
        };
        let parent = match cur.parent() {
            Some(par) if par != cur && !par.as_os_str().is_empty() => par.to_path_buf(),
            _ => return normalized,
        };
        tail.push(name);
        cur = parent;
    }
}

/// True when `cand` is `root` or lives under it, compared on normalized paths
/// with a component boundary so `…/foo` never matches `…/foobar`.
fn is_within(root: &Path, cand: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive; compare lowercased. Both sides go
        // through the SAME key builder (which strips any `\\?\` verbatim prefix)
        // so an extended-length root and a plain candidate — or vice versa —
        // still compare equal.
        let r = win_compare_key(root);
        let c = win_compare_key(cand);
        c == r || c.starts_with(&format!("{}/", r))
    }
    #[cfg(not(windows))]
    {
        cand == root || cand.starts_with(root)
    }
}

/// Jail `candidate` to `root`: return the normalized path when it stays inside
/// `root`, otherwise an error. Absolute paths are allowed ONLY when they fall
/// within `root`, so the desktop coding agent can still use absolute paths
/// inside the user-picked project folder (#62).
///
/// The DECISION is made on symlink-resolved paths, the RETURNED path is the
/// lexical one the caller asked for: canonicalize() hands back `\\?\C:\…` on
/// Windows and `/private/var/…` on macOS, and that string is echoed to the UI
/// and compared in the frontend.
///
/// What this actually guarantees, and what it does not:
///
/// * It answers ONE question — does this path string, with `..` resolved and
///   with the symlinks of its deepest existing ancestor followed, stay under
///   `root`. That is enough for the traversal shapes a prompt-injected model
///   sends (`../../.ssh/id_rsa`) and for a symlink planted inside the
///   workspace, which is what `resolve_existing_prefix` is for.
/// * It is a path check, not a permission check. Whether the caller-supplied
///   ROOT may be a jail at all is `check_workspace_root`'s question, and
///   nothing here asks it.
/// * The check and the later `open()` are separate syscalls on a filesystem
///   other processes can write. A component replaced by a symlink in between
///   escapes it (TOCTOU); so does a hard link inside the workspace pointing at
///   a file outside, which is indistinguishable from the file itself. Closing
///   those needs `openat`/`O_NOFOLLOW` on a directory handle, not a string
///   comparison — the workspace is assumed not to be attacker-writable while
///   an operation is in flight.
pub(crate) fn contain_within(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let nroot = lexical_normalize(root);
    let ncand = lexical_normalize(candidate);
    let within = is_within(&nroot, &ncand)
        && is_within(
            &resolve_existing_prefix(&nroot),
            &resolve_existing_prefix(&ncand),
        );
    if within {
        Ok(ncand)
    } else {
        // Surface BOTH sides: the #1 support question on this error is "which
        // folder does it think the workspace is?" — the raw root answers it.
        Err(format!(
            "Path escapes the allowed workspace.\n  workspace root: {}\n  requested path: {}",
            root.display(),
            candidate.display()
        ))
    }
}

/// Windows containment-comparison key: lowercase, forward-slashed, `\\?\`
/// verbatim prefix stripped, trailing slash trimmed. rfd's folder picker returns
/// extended-length (`\\?\C:\…`, `\\?\UNC\srv\share`) paths for selections past
/// MAX_PATH, but `workspace_root` stores the raw string — without normalizing
/// both sides identically here, a legitimately-picked folder fails containment
/// with "Path escapes the allowed workspace" (#79, DarkLordCmd / thecakeisnaoh).
#[cfg(windows)]
fn win_compare_key(p: &Path) -> String {
    let s = p.to_string_lossy().to_lowercase().replace('\\', "/");
    let s = if let Some(rest) = s.strip_prefix("//?/unc/") {
        format!("//{}", rest) // verbatim UNC → plain UNC (\\srv\share)
    } else if let Some(rest) = s.strip_prefix("//?/") {
        rest.to_string() // verbatim disk → plain (C:\…)
    } else {
        s
    };
    s.trim_end_matches('/').to_string()
}

/// The jail root for a file op: a configured folder workspace `working_dir`
/// (the repo the user picked, threaded from the frontend as `workingDirectory`)
/// when set; otherwise the per-chat sandbox `~/agent-workspace/<chat_id>/`.
///
/// The `chat_id` slug goes through `agent::sanitize_chat_slug`, which is the
/// ONLY sanitiser in the tree that drops `.`. This function used to keep its
/// own copy that allowed it, so a chat id of `".."` made the root
/// `~/agent-workspace/..` == `$HOME` and every containment check below it
/// passed for the whole home directory (audit IPC-1) — the hole was fixed in
/// agent.rs and left standing in this copy.
///
/// NOTE: this is a path derivation, not a permission check. A caller-supplied
/// `working_dir` is only trustworthy once `check_workspace_root` has passed;
/// `resolve_path` does that, direct callers must decide for themselves.
pub(crate) fn workspace_root(chat_id: Option<&str>, working_dir: Option<&str>) -> PathBuf {
    if let Some(wd) = working_dir.map(str::trim).filter(|w| !w.is_empty()) {
        return PathBuf::from(wd);
    }
    let slug = crate::commands::agent::sanitize_chat_slug(chat_id.unwrap_or("default"));
    crate::os_paths::agent_workspace_root().join(slug)
}

/// THE ALLOWLIST: folders the user chose in a native folder dialog.
///
/// Kept on disk, because a pick is a decision about a project and not about a
/// run: the workspace the user selected last week arrives from the frontend's
/// persisted state on the next launch, and an in-memory list would refuse it
/// and force a re-pick every single start.
///
/// The file is only ever written from `remember_picked_root`, i.e. from the
/// native dialog, and every entry is re-checked against
/// `may_be_a_picked_root` when it is read back — an edited file cannot add `/`
/// or `~/.ssh` to the allowlist.
static PICKED_ROOTS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(load_picked_roots()));

fn picked_roots_file() -> PathBuf {
    crate::os_paths::data_dir().join("workspace-roots.json")
}

fn load_picked_roots() -> Vec<PathBuf> {
    load_roots_from(&picked_roots_file())
}

/// Read the allowlist back, re-checking every entry.
///
/// The file is data, not authority: a corrupted or edited one may shrink the
/// allowlist but must not be able to grow it past what a dialog could have
/// produced — so `/` or `~/.ssh` in the file is dropped on the way in, exactly
/// as a click on them would have been.
fn load_roots_from(file: &Path) -> Vec<PathBuf> {
    let raw = fs::read_to_string(file).unwrap_or_default();
    serde_json::from_str::<Vec<String>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .map(|s| lexical_normalize(Path::new(&s)))
        .filter(|p| may_be_a_picked_root(p).is_ok())
        .collect()
}

fn save_picked_roots(roots: &[PathBuf]) {
    save_roots_to(&picked_roots_file(), roots)
}

fn save_roots_to(file: &Path, roots: &[PathBuf]) {
    let list: Vec<String> = roots.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let Ok(json) = serde_json::to_string_pretty(&list) else { return };
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(file, json);
}

/// Test-only stand-in for the native dialog.
///
/// Same gate as `remember_picked_root` — a root a real pick could not produce
/// is rejected here too — but it does not persist: a test run must not write
/// its temp folders into the user's real allowlist.
#[cfg(test)]
pub(crate) fn allow_root_for_test(root: &Path) {
    let norm = lexical_normalize(root);
    may_be_a_picked_root(&norm).expect("a test root must be a folder a pick could produce");
    let mut roots = PICKED_ROOTS.lock().expect("allowlist");
    if !roots.iter().any(|r| r == &norm) {
        roots.push(norm);
    }
}

/// Record a folder the USER chose in a native dialog as a legitimate workspace
/// root. The ONE caller is `system::pick_folder` — the dialog itself.
///
/// It must stay that way. Recording is what makes a folder a jail root, so a
/// command the WebView can call with a path of its choosing (that is what
/// `set_chat_workspace_override` is) must never record: it would hand the
/// allowlist back to the caller it exists to constrain. Those callers
/// VALIDATE against the list instead (`validate_workspace_root`).
///
/// Returns an error for the handful of folders that are not workspaces even
/// when a human clicked them; see `may_be_a_picked_root`.
pub(crate) fn remember_picked_root(root: &Path) -> Result<(), String> {
    let norm = lexical_normalize(root);
    may_be_a_picked_root(&norm)?;
    if let Ok(mut roots) = PICKED_ROOTS.lock() {
        if !roots.iter().any(|r| r == &norm) {
            roots.push(norm);
            save_picked_roots(&roots);
        }
    }
    Ok(())
}

/// The app's OWN working directories — the per-chat sandboxes under
/// `~/agent-workspace/`. They are roots nobody picks in a dialog because the
/// app derives them itself (`workspace_root`), so the allowlist has to know
/// them or a plain sandbox chat could not read its own files.
fn is_app_work_dir(norm: &Path) -> bool {
    let base = lexical_normalize(&crate::os_paths::agent_workspace_root());
    is_within(&base, norm)
}

/// Directories that are never a project workspace, only a target.
fn forbidden_root_prefixes() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let mut system: Vec<PathBuf> = Vec::new();
    #[cfg(not(windows))]
    for p in [
        "/etc", "/private/etc", "/dev", "/proc", "/sys", "/boot", "/root",
        "/var/root", "/usr", "/bin", "/sbin", "/System", "/Library",
    ] {
        system.push(PathBuf::from(p));
    }
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        for rel in ["Windows", "Program Files", "Program Files (x86)", "ProgramData"] {
            system.push(PathBuf::from(format!("{}\\{}", drive, rel)));
        }
    }
    // A "system" directory that CONTAINS the user's home is not a system
    // directory for this user: with HOME=/root (containers, some Linux setups)
    // the agent workspace itself lives under /root.
    let mut out: Vec<PathBuf> = system
        .into_iter()
        .filter(|p| match &home {
            Some(h) => !is_within(&lexical_normalize(p), &lexical_normalize(h)),
            None => true,
        })
        .collect();
    if let Some(home) = home {
        // The credential stores an escaped jail was worth escaping FOR.
        for rel in [
            ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".lu",
            "Library/Keychains", "AppData",
        ] {
            out.push(home.join(rel));
        }
    }
    out
}

/// Directories that hold OTHER people's homes or every mounted volume. Denied
/// as an exact root only — the folders inside them are ordinary workspaces.
fn forbidden_exact_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ["/Users", "/home", "/Volumes", "/mnt", "/media"]
        .iter()
        .map(PathBuf::from)
        .collect();
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        out.push(PathBuf::from(format!("{}\\Users", drive)));
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home);
    }
    out
}

/// Count of NAMED components — `/` and `C:\` are 0, `/etc` is 1.
fn named_depth(p: &Path) -> usize {
    p.components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count()
}

/// The folders that may never be a jail root, however they got proposed.
///
/// Second gate, not the first one: `check_workspace_root` decides membership of
/// the allowlist, this decides whether the member is a sane workspace at all. A
/// dialog click is consent to expose ONE project folder; the dialog opens
/// wherever it was last pointed, and one mis-click on `$HOME`, `/Volumes` or
/// `~/.ssh` would otherwise turn "the agent may work in this folder" into "the
/// agent may read every credential on the machine" — permanently, because the
/// pick is remembered.
fn may_be_a_picked_root(norm: &Path) -> Result<(), String> {
    let refuse = |why: &str| {
        Err(format!(
            "Not an allowed workspace folder ({}): {}",
            why,
            norm.display()
        ))
    };
    // `/` and `C:\` have no named component at all.
    if named_depth(norm) == 0 {
        return refuse("a drive or filesystem root is not a workspace");
    }
    // Mutual containment == equality, and it stays case-insensitive on Windows
    // the way every other comparison in this file is.
    let same = |a: &Path, b: &Path| is_within(a, b) && is_within(b, a);
    for bad in forbidden_exact_roots() {
        if same(&lexical_normalize(&bad), norm) {
            return refuse("a home or mount container is not a workspace");
        }
    }
    for bad in forbidden_root_prefixes() {
        if is_within(&lexical_normalize(&bad), norm) {
            return refuse("system or credential directory");
        }
    }
    Ok(())
}

/// Is this frontend-supplied path allowed to BE a jail root?
///
/// `contain_within` only ever answered "does the path stay inside the root" —
/// the root itself arrived from the WebView on every call and was taken on
/// faith, so `fs_read("/etc/shadow", null, "/")` passed containment perfectly
/// and read the file. The jail was only ever as narrow as the string the caller
/// chose for it.
///
/// This is an ALLOWLIST, and it has to be one. The threat model this package
/// writes down in `capabilities/default.json` is a script-execution bug in the
/// WebView — a compromised renderer calling the IPC commands with arguments of
/// its choosing. Against that caller a deny-list is the wrong shape: it has to
/// enumerate every directory worth stealing on three operating systems, and one
/// omission (`~/.mozilla`, `~/.thunderbird`, `~/Library/Messages`, a password
/// manager's export folder, the user's whole `Documents`) is a full read of it.
/// A renderer cannot open a native folder dialog and click in it, so the list of
/// folders a human picked there is a boundary it cannot cross at all.
///
/// Two gates, in this order:
///   1. the allowlist — an app work dir, or a folder the user picked in the
///      native dialog (this run or an earlier one; see `PICKED_ROOTS`);
///   2. `may_be_a_picked_root` — the handful of folders that are not a
///      workspace even when a human clicked them.
///
/// Upgrade note: a workspace picked by a build older than this one was never
/// recorded, so the first use after the update is refused until the user picks
/// the folder again. That is one dialog, once, per folder — the alternative is
/// trusting a path the WebView sent us, which is the hole being closed.
fn check_workspace_root(root: &Path) -> Result<(), String> {
    let norm = lexical_normalize(root);
    if is_app_work_dir(&norm) {
        return Ok(());
    }
    let picked = PICKED_ROOTS
        .lock()
        .map(|roots| roots.iter().any(|r| is_within(r, &norm)))
        .unwrap_or(false);
    if !picked {
        return Err(format!(
            "Not an allowed workspace folder (only a folder you chose in LU's folder picker \
             can be a workspace — pick it again to allow it): {}",
            root.display()
        ));
    }
    may_be_a_picked_root(&norm)
}

/// `check_workspace_root` for callers outside this module (the Remote dispatch
/// folder picker validates the folder before storing it as an override).
///
/// Validate, never record: the path these callers hold came over IPC from the
/// WebView, and a caller that could add its own argument to the allowlist would
/// be the hole the allowlist exists to close. Only `system::pick_folder` — the
/// native dialog — records.
pub(crate) fn validate_workspace_root(root: &Path) -> Result<(), String> {
    check_workspace_root(root)
}

/// Resolve + CONTAIN a tool-call path. A relative path resolves against the
/// workspace root (folder workspace #62, else the per-chat sandbox); an
/// absolute path is accepted only when it falls inside that root.
///
/// Two checks, and they are not the same one: `check_workspace_root` decides
/// whether the caller-supplied root may be a jail at all, `contain_within`
/// decides whether the path stays inside it. Only both together are the
/// security boundary for fs_read/fs_write/fs_list/fs_search/fs_info.
fn resolve_path(path: &str, chat_id: Option<&str>, working_dir: Option<&str>) -> Result<PathBuf, String> {
    let cleaned = normalize_duplicate_drive_prefix(path);
    let root = workspace_root(chat_id, working_dir);
    if working_dir.map(str::trim).is_some_and(|w| !w.is_empty()) {
        check_workspace_root(&root)?;
    }
    let p = Path::new(&cleaned);
    let candidate = if p.is_absolute() { p.to_path_buf() } else { root.join(&cleaned) };
    contain_within(&root, &candidate)
}

/// True when `path` LOOKS like the workspace ROOT itself ("", ".", "./",
/// trailing slashes) rather than a named subpath. Used to decide whether a
/// missing directory should be auto-created as the per-chat sandbox root.
///
/// A guess on the raw string, and it is wrong in both directions: it misses
/// `"unterordner/.."` (which resolves to the root) and it claims `"  "` and
/// `".\\"` (which resolve to ordinary files inside it, on a platform where a
/// backslash is an ordinary character). That is affordable for its ONE caller —
/// `fs_list`, where the answer only decides whether an empty directory gets
/// created and a wrong guess costs nothing. It is NOT affordable for a write;
/// see `reject_root_as_write_target`.
fn is_workspace_root_path(path: &str) -> bool {
    let t = path.trim().replace('\\', "/");
    let t = t.trim_end_matches('/');
    t.is_empty() || t == "."
}

/// KF-15 / KF-12: refuse a write whose target IS the workspace root.
///
/// A write path that names no file — `""`, `"."`, `"./"`, `"unterordner/.."` —
/// resolves to the root itself, and the write path does not turn that into a
/// root: `create_dir_all(parent)` creates the root's PARENT and `write_atomic`
/// renames a temp file onto the root's name, leaving a regular FILE where the
/// next real write needs a directory. Measured before this guard existed, with
/// `workingDirectory` pointing at a workspace folder that did not exist yet:
/// `fs_write("", "GEHEIM", …)` answered `{"status":"saved","bytes":6}` and left
/// a 6-byte file containing `GEHEIM` at the workspace root. The caller chose
/// both the place and the content.
///
/// ON THE RESOLVED PATH, NOT ON THE STRING. `is_workspace_root_path` above is a
/// string guess with errors in both directions; a write cannot pay for either.
/// The resolved path has already been through `contain_within`, so comparing it
/// to the root is exact.
///
/// MUTUAL CONTAINMENT, NOT `==`. Same idiom as `may_be_a_picked_root`'s `same`
/// closure — it is the only comparison in this file that folds case on Windows
/// and strips a `\\?\` prefix that may sit on one side only.
///
/// THE WORDING IS DELIBERATE. "Path escapes the allowed workspace" has exactly
/// one meaning in this file (`contain_within`, and its echo in `fs_list`'s
/// pattern guard): the path left the jail. It did not — it is inside the
/// workspace, it just is not a file. The siblings' answer for an argument that
/// names the wrong KIND of thing is `"Not a directory: …"` (`fs_list:689`,
/// `fs_search:768`); this is its mirror image, and it names the path, the way
/// `"File not found: …"` (`fs_read`) and `"Path not found: …"` (`fs_info`) do.
///
/// EXPLICITLY NOT "create the root as a directory instead". The ordinary write
/// already does that — `fs_write("notiz.txt", …)` runs `create_dir_all` over
/// the root and puts the file inside (measured, and pinned by
/// `an_ordinary_write_still_creates_the_root_as_a_directory`). A write that
/// names no file would gain nothing from it and would only get a second, silent
/// behaviour.
pub(crate) fn reject_root_as_write_target(root: &Path, target: &Path) -> Result<(), String> {
    let nroot = lexical_normalize(root);
    let ntarget = lexical_normalize(target);
    if is_within(&nroot, &ntarget) && is_within(&ntarget, &nroot) {
        return Err(format!(
            "Not a file: {} is the workspace root itself — a write needs a file INSIDE the workspace",
            ntarget.display()
        ));
    }
    Ok(())
}

fn file_meta(path: &Path) -> serde_json::Value {
    let meta = fs::metadata(path);
    let (size, modified, is_dir) = match meta {
        Ok(m) => (
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            m.is_dir(),
        ),
        Err(_) => (0, 0, false),
    };
    serde_json::json!({
        "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "size": size,
        "isDir": is_dir,
        "modified": modified,
    })
}

/// Reading a file is unbounded blocking IO — a multi-gigabyte model file on a
/// slow external disk takes as long as it takes. As a plain sync `#[command]`
/// that ran on the Tauri main thread, so the whole window froze for the
/// duration; the work goes to the blocking pool instead (same treatment as
/// `execute_code` and the shell tool).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn fs_read(
    path: String,
    chatId: Option<String>,
    workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || fs_read_sync(path, chatId, workingDirectory))
        .await
        .map_err(|e| format!("fs_read task failed to run: {e}"))?
}

#[allow(non_snake_case)]
pub(crate) fn fs_read_sync(path: String, chatId: Option<String>, workingDirectory: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    if !full.exists() {
        return Err(format!("File not found: {}", full.display()));
    }

    // Text, or a binary MARKER — never the binary payload.
    //
    // This used to base64-encode the whole file and ship it over IPC. Every
    // consumer discards it: the model-facing file_read turns it into a "binary,
    // not shown" line, and both file_edit paths refuse outright. So a 500 MB
    // model file cost ~667 MB of base64 in Rust plus the JSON and JS copies of
    // it, all to be thrown away — the desktop half of a guard the phone relay
    // already had (f3542ff).
    match fs::read_to_string(&full) {
        Ok(content) => Ok(serde_json::json!({ "content": content, "encoding": "utf8" })),
        Err(_) => {
            let bytes = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
            Ok(serde_json::json!({ "encoding": "binary", "bytes": bytes }))
        }
    }
}

/// The cap for a single `fs_read_bytes` call. A preview is a picture on a
/// 280px panel, not a payload: base64 over IPC costs 4/3 of the file in Rust
/// plus a copy in the WebView, so the ceiling stays low on purpose.
const READ_BYTES_CAP: u64 = 16 * 1024 * 1024;

/// Raw bytes of ONE file, base64, through the SAME jail as every other fs
/// command (`resolve_path` -> `contain_within`).
///
/// This exists for the Explorer panel's image preview (2.6.6 C3). The obvious
/// alternative, a static Tauri asset scope plus convertFileSrc, knows nothing
/// about the jail: a scope wide enough to cover whatever folder the user picks
/// is a read surface NEXT TO the workspace jail rather than inside it. Bytes
/// through this command become a blob URL in the WebView instead.
///
/// `fs_read` deliberately refuses to carry binary payloads (it answers with a
/// marker), and it stays that way: this is a separate, capped, opt-in door
/// that only the panel walks through.
#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_read_bytes(
    path: String,
    chatId: Option<String>,
    workingDirectory: Option<String>,
    maxBytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    if !full.is_file() {
        return Err(format!("File not found: {}", full.display()));
    }
    let cap = maxBytes.unwrap_or(READ_BYTES_CAP).min(READ_BYTES_CAP);
    let size = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if size > cap {
        return Err(format!(
            "File is too large to preview: {} bytes (limit {})",
            size, cap
        ));
    }
    let bytes = fs::read(&full).map_err(|e| format!("Read error: {}", os_error::english(&e)))?;
    Ok(serde_json::json!({
        "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "bytes": bytes.len(),
    }))
}

/// Match new content to the EXISTING file's line-ending + BOM convention so an
/// edit produces a minimal diff instead of flipping every line. Local coding
/// models emit `\n`; on a Windows repo whose files are CRLF, writing that raw
/// turned every edit into a whole-file whitespace diff. For a NEW file we honor
/// exactly what the caller sent — there is no convention to match.
pub(crate) fn normalize_to_existing_style(existing: Option<&[u8]>, new: &str) -> Vec<u8> {
    const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
    let existing = match existing {
        Some(e) => e,
        None => return new.as_bytes().to_vec(),
    };
    let had_bom = existing.starts_with(&BOM);
    // The file is treated as CRLF if it contains any CRLF pair.
    let existing_crlf = existing.windows(2).any(|w| w == b"\r\n");
    // Normalize incoming to LF first (idempotent), then to the target style.
    let lf = new.replace("\r\n", "\n");
    let bodied = if existing_crlf { lf.replace('\n', "\r\n") } else { lf };
    let mut out = Vec::with_capacity(bodied.len() + 3);
    if had_bom && !bodied.as_bytes().starts_with(&BOM) {
        out.extend_from_slice(&BOM);
    }
    out.extend_from_slice(bodied.as_bytes());
    out
}

/// Write bytes to `target` atomically: a temp file in the SAME directory, then
/// rename over the target. A crash or interrupt can never leave a half-written
/// (truncated) file where the original was — std::fs::rename replaces the
/// destination on both Unix and Windows.
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = target.parent().ok_or_else(|| "No parent directory".to_string())?;
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{}.tmp{}-{}", base, std::process::id(), seq));
    fs::write(&tmp, bytes).map_err(|e| format!("Write error: {}", os_error::english(&e)))?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Write error (rename): {}", e));
    }
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_write(path: String, content: String, chatId: Option<String>, workingDirectory: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    // KF-15. Before any directory is created and before write_atomic drops its
    // temp file into the target's parent — which for a root-as-target is one
    // level ABOVE the workspace.
    reject_root_as_write_target(
        &workspace_root(chatId.as_deref(), workingDirectory.as_deref()),
        &full,
    )?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", os_error::english(&e)))?;
    }
    // Read the current bytes (if any) to preserve the file's EOL/BOM convention
    // and to detect a no-op write.
    let existing = fs::read(&full).ok();
    let out_bytes = normalize_to_existing_style(existing.as_deref(), &content);

    if let Some(ref old) = existing {
        if old.as_slice() == out_bytes.as_slice() {
            // Nothing changed — skip the write so there is no spurious mtime
            // bump and no misleading "saved" for an identical file.
            return Ok(serde_json::json!({
                "status": "unchanged",
                "path": full.to_string_lossy(),
                "bytes": out_bytes.len(),
            }));
        }
    }

    write_atomic(&full, &out_bytes)?;
    Ok(serde_json::json!({
        "status": "saved",
        "path": full.to_string_lossy(),
        "bytes": out_bytes.len(),
    }))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_list(
    path: String,
    recursive: Option<bool>,
    pattern: Option<String>,
    chatId: Option<String>,
    workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    if !dir.is_dir() {
        // A fresh per-chat agent sandbox (~/agent-workspace/<chat_id>) may not
        // exist yet. When the model lists the workspace ROOT with a relative
        // "." / "" path, create it so `file_list .` returns an empty listing
        // instead of "Not a directory" — small models otherwise climb to an
        // absolute drive-root path. Mirrors shell.rs (create_dir_all on cwd).
        // ONLY the sandbox root is auto-created; absolute or sub paths error.
        let cleaned = normalize_duplicate_drive_prefix(&path);
        if is_workspace_root_path(&cleaned) && !Path::new(&cleaned).is_absolute() {
            let _ = fs::create_dir_all(&dir);
        }
        if !dir.is_dir() {
            return Err(format!("Not a directory: {}", dir.display()));
        }
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let max_entries = 500;

    if let Some(ref pat) = pattern {
        // The pattern is a second path channel and gets the same jail as `path`.
        // Without this, `pattern: "../../.ssh/*"` listed the keys that
        // `path: "../../.ssh"` refuses — and an ABSOLUTE pattern skipped the
        // guessing entirely, because Path::join throws the base away when the
        // joined component is absolute. glob 0.3 also follows `..` literally and
        // matches dotfiles, so both had to be shut: reject the escape up front
        // for a clear error, and re-check every match, since a glob result is a
        // real path we never authorised.
        // Prefix / RootDir / ParentDir are exactly the components that make
        // `join` discard or climb out of the base — including the Windows-only
        // shapes ("\.ssh\*" keeps only the drive, "C:foo\*" replaces the lot).
        {
            use std::path::Component;
            let escapes = Path::new(pat.as_str()).components().any(|c| {
                matches!(c, Component::Prefix(_) | Component::RootDir | Component::ParentDir)
            });
            if escapes {
                return Err("Pattern escapes the allowed workspace".to_string());
            }
        }
        let glob_pattern = dir.join(pat).to_string_lossy().to_string();
        if let Ok(paths) = glob_match(&glob_pattern) {
            for entry in paths.flatten() {
                if entries.len() >= max_entries {
                    break;
                }
                if contain_within(&dir, &entry).is_err() {
                    continue;
                }
                entries.push(file_meta(&entry));
            }
        }
    } else if recursive.unwrap_or(false) {
        for entry in WalkDir::new(&dir).max_depth(5).into_iter().filter_map(|e| e.ok()) {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(entry.path()));
        }
    } else {
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("Read dir: {}", os_error::english(&e)))?;
        for entry in read_dir.flatten() {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(&entry.path()));
        }
    }

    Ok(serde_json::json!({ "entries": entries, "count": entries.len() }))
}

/// Walks up to eight directory levels and reads every file under a megabyte:
/// on a real repo that is seconds of blocking IO, and as a plain sync
/// `#[command]` every one of those seconds was spent on the Tauri main thread
/// with the window frozen.
///
/// `#[command(async)]` — not an `async fn` — because this is also called
/// directly (not awaited) from the Remote bridge; the attribute keeps the
/// signature synchronous while Tauri runs the command off the main thread.
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn fs_search(
    path: String,
    pattern: String,
    max_results: Option<u32>,
    chatId: Option<String>,
    workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    // Bound the compiled regex so a pathological pattern can't blow up memory.
    // (The `regex` crate is already linear-time, so there's no catastrophic
    // backtracking; this caps the compiled-program size.)
    let re = RegexBuilder::new(&pattern)
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 20)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))?;
    let max = max_results.unwrap_or(50) as usize;
    let mut results: Vec<serde_json::Value> = Vec::new();

    for entry in WalkDir::new(&dir).max_depth(8).into_iter().filter_map(|e| e.ok()) {
        if results.len() >= max {
            break;
        }
        let p = entry.path();
        if !p.is_file() {
            continue;
        }

        // Skip binary / large files
        let meta = fs::metadata(p);
        if let Ok(m) = &meta {
            if m.len() > 1_000_000 {
                continue;
            }
        }

        if let Ok(content) = fs::read_to_string(p) {
            let mut matches: Vec<serde_json::Value> = Vec::new();
            for (line_num, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    matches.push(serde_json::json!({
                        "line": line_num + 1,
                        "text": if line.len() > 200 { line.chars().take(200).collect::<String>() } else { line.to_string() },
                    }));
                    if matches.len() >= 10 {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                results.push(serde_json::json!({
                    "file": p.to_string_lossy(),
                    "matches": matches,
                }));
            }
        }
    }

    Ok(serde_json::json!({ "results": results, "count": results.len() }))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_info(path: String, chatId: Option<String>, workingDirectory: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref(), workingDirectory.as_deref())?;
    if !full.exists() {
        return Err(format!("Path not found: {}", full.display()));
    }
    let meta = fs::metadata(&full).map_err(|e| format!("Metadata error: {}", os_error::english(&e)))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "path": full.to_string_lossy(),
        "size": meta.len(),
        "isDir": meta.is_dir(),
        "isFile": meta.is_file(),
        "modified": modified,
        "created": created,
        "readonly": meta.permissions().readonly(),
    }))
}

/// Show a native "Save As…" dialog and write the given text content to the
/// chosen path. Used by Export Chat (markdown / JSON). Returns the chosen
/// path, or null when the user cancelled.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_text_file_dialog(
    content: String,
    defaultName: Option<String>,
    extension: Option<String>,
    ext_label: Option<String>,
) -> Result<Option<String>, String> {
    let default_name = defaultName.unwrap_or_else(|| "export.txt".to_string());
    let ext = extension.unwrap_or_else(|| "txt".to_string());
    let label = ext_label.unwrap_or_else(|| format!("{} file", ext.to_uppercase()));

    // rfd::AsyncFileDialog runs the native Windows/macOS/Linux save dialog
    // without any extra Tauri plugin.
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path().to_path_buf();
            std::fs::write(&path, content).map_err(|e| format!("Write failed: {}", os_error::english(&e)))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Binary counterpart to `save_text_file_dialog`. Used by the Download
/// buttons in the Create view's Gallery / OutputDisplay / MediaViewer.
///
/// Why a dedicated Rust command instead of the JS `<a download>` trick?
/// In Tauri's Webview2 the blob-URL anchor-click pattern is unreliable
/// — most of the time the webview simply navigates to the blob URL
/// instead of saving it, so the user saw "nothing happens". Going
/// through a native Save As dialog guarantees the bytes hit the disk.
///
/// `bytes` is expected as a raw number[] over the Tauri IPC (the JS
/// side passes `Array.from(new Uint8Array(blob))`). Returns the chosen
/// path, or null when the user cancelled.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_binary_file_dialog(
    bytes: Vec<u8>,
    defaultName: Option<String>,
    extension: Option<String>,
    ext_label: Option<String>,
) -> Result<Option<String>, String> {
    let default_name = defaultName.unwrap_or_else(|| "download.bin".to_string());
    let ext = extension.unwrap_or_else(|| {
        // Infer from defaultName if caller didn't tell us — cheap split.
        default_name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_else(|| "bin".to_string())
    });
    let label = ext_label.unwrap_or_else(|| format!("{} file", ext.to_uppercase()));

    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path().to_path_buf();
            std::fs::write(&path, &bytes).map_err(|e| format!("Write failed: {}", os_error::english(&e)))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{allow_root_for_test, is_workspace_root_path, normalize_to_existing_style, resolve_path};
    use crate::os_paths::test_dir;
    use std::path::Path;

    // ── #11: fs_write preserves the existing file's EOL + BOM convention ──
    #[test]
    fn new_file_keeps_content_verbatim() {
        // No existing file → honor exactly what the caller sent (LF).
        assert_eq!(normalize_to_existing_style(None, "a\nb\n"), b"a\nb\n");
        // Even CRLF the caller explicitly sent is preserved for a new file.
        assert_eq!(normalize_to_existing_style(None, "a\r\nb"), b"a\r\nb");
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_debris() {
        use super::write_atomic;
        use std::fs;
        let dir = test_dir("atomic");
        let target = dir.join("notes.txt");
        fs::write(&target, b"old").unwrap();

        write_atomic(&target, b"new content").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");

        // The temp twin must be gone — a leftover .notes.txt.tmpNNN would show
        // up in the user's repo and in file_list.
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "notes.txt")
            .collect();
        assert!(leftovers.is_empty(), "left behind: {:?}", leftovers);
    }

    #[test]
    fn crlf_file_gets_lf_content_converted() {
        let existing = b"old\r\nlines\r\n";
        assert_eq!(
            normalize_to_existing_style(Some(existing), "new\nlines\n"),
            b"new\r\nlines\r\n"
        );
    }

    #[test]
    fn lf_file_stays_lf() {
        let existing = b"old\nlines\n";
        assert_eq!(
            normalize_to_existing_style(Some(existing), "new\nlines\n"),
            b"new\nlines\n"
        );
    }

    #[test]
    fn crlf_conversion_is_idempotent() {
        let existing = b"x\r\ny\r\n";
        // Caller already sent CRLF — must not become \r\r\n.
        assert_eq!(
            normalize_to_existing_style(Some(existing), "a\r\nb\r\n"),
            b"a\r\nb\r\n"
        );
    }

    #[test]
    fn existing_bom_is_preserved() {
        let existing = b"\xEF\xBB\xBFhello\n";
        let out = normalize_to_existing_style(Some(existing), "world\n");
        assert_eq!(out, b"\xEF\xBB\xBFworld\n");
        // Not doubled when the new content already carries the BOM.
        let out2 = normalize_to_existing_style(Some(existing), "\u{feff}world\n");
        assert_eq!(out2, b"\xEF\xBB\xBFworld\n");
    }

    #[test]
    fn no_bom_stays_no_bom() {
        let existing = b"plain\n";
        assert_eq!(normalize_to_existing_style(Some(existing), "x\n"), b"x\n");
    }

    #[test]
    fn workspace_root_paths_match() {
        for p in ["", ".", "./", ".\\", "  .  ", "/", "\\"] {
            assert!(is_workspace_root_path(p), "expected root-ish: {:?}", p);
        }
    }

    #[test]
    fn named_subpaths_are_not_root() {
        for p in ["src", "./src", "package.json", "a/b", ".git", ".."] {
            assert!(!is_workspace_root_path(p), "expected NOT root-ish: {:?}", p);
        }
    }

    // ── #62: relative paths must honor the folder workspace ──────────
    #[test]
    fn relative_path_resolves_against_working_dir() {
        allow_root_for_test(Path::new("D:/Projects/site"));
        let got = resolve_path("src/main.rs", Some("chat-1"), Some("D:/Projects/site")).unwrap();
        let s = got.to_string_lossy().replace('\\', "/");
        assert_eq!(s, "D:/Projects/site/src/main.rs");
    }

    #[test]
    fn relative_path_without_working_dir_uses_sandbox() {
        let got = resolve_path("notes.md", Some("chat-1"), None).unwrap();
        let s = got.to_string_lossy().replace('\\', "/");
        // Der Ordnername kommt aus app_identity, damit diese Zusicherung den
        // Branch-Suffix nicht gegen sich selbst ausspielt.
        let erwartet = format!("{}/chat-1/notes.md", crate::app_identity::AGENT_WORKSPACE_DIR);
        assert!(s.contains(&erwartet), "got: {}", s);
    }

    #[test]
    fn blank_working_dir_falls_back_to_sandbox() {
        let got = resolve_path("a.txt", Some("c"), Some("   ")).unwrap();
        let s = got.to_string_lossy().replace('\\', "/");
        let erwartet = format!("{}/c/a.txt", crate::app_identity::AGENT_WORKSPACE_DIR);
        assert!(s.contains(&erwartet), "got: {}", s);
    }

    // ── Path-jail (security): absolute paths are allowed only inside the root ──
    #[test]
    fn absolute_path_inside_working_dir_is_allowed() {
        let (root, abs) = if cfg!(windows) {
            ("D:/Projects/site", "D:/Projects/site/src/main.rs")
        } else {
            ("/projects/site", "/projects/site/src/main.rs")
        };
        allow_root_for_test(Path::new(root));
        let got = resolve_path(abs, Some("chat-1"), Some(root)).unwrap();
        let s = got.to_string_lossy().replace('\\', "/");
        assert_eq!(s, abs);
    }

    #[test]
    fn absolute_path_outside_working_dir_is_rejected() {
        let abs = if cfg!(windows) { "C:/Windows/System32/x.txt" } else { "/etc/passwd" };
        assert!(resolve_path(abs, Some("chat-1"), Some("D:/Projects/site")).is_err());
    }

    #[test]
    fn dotdot_traversal_out_of_sandbox_is_rejected() {
        // relative path that climbs out of the per-chat sandbox
        assert!(resolve_path("../../../../Windows/x.txt", Some("chat-1"), None).is_err());
    }

    #[test]
    fn dotdot_traversal_out_of_working_dir_is_rejected() {
        allow_root_for_test(Path::new("D:/Projects/site"));
        assert!(resolve_path("../../secret.txt", Some("c"), Some("D:/Projects/site")).is_err());
    }

    // ── #79: rfd's folder picker hands back extended-length (`\\?\`) roots for
    // selections past MAX_PATH. The root then carries the verbatim prefix while
    // the candidate is stripped of it — before the symmetric win_compare_key
    // fix, a legitimately-picked folder failed containment. ────────────────

    /// Der Pick, den diese vier Tests voraussetzen: rfd liefert die Wurzel in
    /// der Verbatim-Form, und GENAU die landet auf der Erlaubnisliste.
    ///
    /// Das stand hier vorher nicht — die Tests lebten davon, dass
    /// `absolute_path_inside_working_dir_is_allowed` vorher lief und dabei
    /// `D:/Projects/site` eingetragen hatte. Eine Reihenfolge-Abhängigkeit
    /// zwischen Tests, und `absolute_op_under_verbatim_root_is_allowed` steht
    /// alphabetisch VOR dem Eintragenden: dieser eine Test war deshalb auf
    /// Windows zuverlässig rot ("only a folder you chose in LU's folder
    /// picker"), die anderen drei nur zufällig grün. Jeder Test trägt seine
    /// Wurzel jetzt selbst ein.
    #[cfg(windows)]
    fn pick_verbatim_root() -> &'static str {
        const ROOT: &str = r"\\?\D:\Projects\site";
        allow_root_for_test(Path::new(ROOT)); // stands in for the native dialog
        ROOT
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_prefixed_root_allows_browsing_itself() {
        // FileTree browse passes path == workingDirectory == the picked folder.
        let root = pick_verbatim_root();
        let got = resolve_path(root, Some("c"), Some(root))
            .expect("verbatim root must contain itself");
        let s = got.to_string_lossy().to_lowercase().replace('\\', "/");
        assert!(s.ends_with("d:/projects/site"), "got: {}", s);
    }

    #[cfg(windows)]
    #[test]
    fn relative_path_under_verbatim_root_is_allowed() {
        let got = resolve_path("src/main.rs", Some("c"), Some(pick_verbatim_root()))
            .expect("relative op under a verbatim root must resolve");
        let s = got.to_string_lossy().to_lowercase().replace('\\', "/");
        assert!(s.ends_with("d:/projects/site/src/main.rs"), "got: {}", s);
    }

    #[cfg(windows)]
    #[test]
    fn absolute_op_under_verbatim_root_is_allowed() {
        // The agent addresses files with plain absolute paths; the root is verbatim.
        let got = resolve_path(r"D:\Projects\site\README.md", Some("c"), Some(pick_verbatim_root()))
            .expect("plain absolute inside a verbatim root must be allowed");
        let s = got.to_string_lossy().to_lowercase().replace('\\', "/");
        assert!(s.ends_with("d:/projects/site/readme.md"), "got: {}", s);
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_root_still_rejects_escape() {
        // Normalizing the prefix must not weaken the jail. Die Wurzel ist hier
        // eingetragen, damit die Ablehnung aus der Umschliessungsprüfung kommt
        // und nicht schon daraus, dass niemand den Ordner gepickt hat.
        let root = pick_verbatim_root();
        assert!(resolve_path(r"..\..\secret.txt", Some("c"), Some(root)).is_err());
        assert!(resolve_path(r"C:\Windows\System32\x.txt", Some("c"), Some(root)).is_err());
    }
}

#[cfg(test)]
mod jail_adversarial_tests {
    use super::*;

    /// The jail is the ONLY boundary between a prompt-injected model and the
    /// user's home. These are the shapes an attacker actually sends, run
    /// against the real function rather than reasoned about.
    #[test]
    fn traversal_out_of_the_workspace_is_refused() {
        let root = Path::new("/Users/dave/project");
        for evil in [
            "../secrets.txt",
            "../../.ssh/id_rsa",
            "../../../../../../etc/passwd",
            "sub/../../outside.txt",
            "./../../outside.txt",
            "/etc/passwd",
            "/Users/dave/.ssh/id_rsa",
            // sibling directory whose name merely STARTS with the root's name
            "/Users/dave/project-evil/x.txt",
            "/Users/dave/projectevil",
        ] {
            let cand = if Path::new(evil).is_absolute() {
                PathBuf::from(evil)
            } else {
                root.join(evil)
            };
            assert!(
                contain_within(root, &cand).is_err(),
                "jail let {evil:?} through",
            );
        }
    }

    /// Enough `..` pops the root component itself, turning an absolute path
    /// into a relative one. That must still not compare as "inside".
    #[test]
    fn popping_past_the_filesystem_root_does_not_land_inside() {
        let root = Path::new("/Users/dave/project");
        let cand = root.join("../../../../../../../../etc/passwd");
        let out = contain_within(root, &cand);
        assert!(out.is_err(), "escaped to {:?}", out);
    }

    /// The legitimate cases must keep working, or the coding agent breaks.
    #[test]
    fn ordinary_paths_inside_the_workspace_still_resolve() {
        let root = Path::new("/Users/dave/project");
        for good in ["src/main.rs", "./src/main.rs", "a/b/../c.txt", "."] {
            assert!(
                contain_within(root, &root.join(good)).is_ok(),
                "jail refused a legitimate path: {good:?}",
            );
        }
        // An absolute path inside the workspace is allowed on purpose (#62).
        assert!(contain_within(root, Path::new("/Users/dave/project/src/x.rs")).is_ok());
        // The root itself.
        assert!(contain_within(root, root).is_ok());
    }

    /// Security review 2026-07-30. Every payload above was only ever sent
    /// through `path`. `pattern` is a SECOND path channel and had no jail at
    /// all: fs_list refused `path: "../../.ssh"` and then globbed
    /// `pattern: "../../.ssh/*"` for the same directory, handing back names,
    /// sizes and absolute paths. Run against the real fs_list on a real
    /// directory, because the bug lived in the wiring, not in contain_within.
    #[test]
    fn a_glob_pattern_cannot_walk_out_of_the_workspace() {
        use std::fs;
        let base = crate::os_paths::test_dir("globjail");
        let ws = base.join("workspace");
        fs::create_dir_all(&ws).unwrap();
        fs::write(base.join("secret.txt"), b"private").unwrap();
        fs::write(ws.join("inside.txt"), b"ok").unwrap();
        allow_root_for_test(&ws); // stands in for the user picking this folder
        let wd = Some(ws.to_string_lossy().to_string());

        // `*` matches dotfiles too (require_literal_leading_dot is false), so
        // "../*" was enough to enumerate a sibling .ssh by name.
        for evil in ["../*", "../secret.txt", "../../*", "sub/../../*"] {
            let out = fs_list(".".into(), None, Some(evil.to_string()), None, wd.clone());
            let listed = out.map(|v| v.to_string()).unwrap_or_default();
            assert!(!listed.contains("secret.txt"), "pattern {evil:?} leaked: {listed}");
        }

        // An absolute pattern needed no depth guessing at all: Path::join
        // discards the base when the joined component is absolute.
        let abs = base.join("*").to_string_lossy().to_string();
        assert!(
            fs_list(".".into(), None, Some(abs), None, wd.clone()).is_err(),
            "absolute pattern accepted",
        );

        // The legitimate case must keep working.
        let ok = fs_list(".".into(), None, Some("*.txt".into()), None, wd).expect("glob");
        assert_eq!(ok["count"], 1);
        assert!(ok.to_string().contains("inside.txt"));
    }
}

/// The root itself used to be taken on faith. `contain_within` answered
/// "does this path stay inside the root" perfectly — and the root arrived from
/// the WebView on every single call, so the jail was only ever as narrow as the
/// string the caller picked for it.
#[cfg(test)]
mod workspace_root_guard_tests {
    use super::*;

    #[test]
    fn a_root_that_is_not_a_project_folder_is_refused() {
        let home = dirs::home_dir().unwrap_or_default();
        let sensitive = home.join(".ssh").to_string_lossy().to_string();
        let home_s = home.to_string_lossy().to_string();
        let roots: Vec<&str> = if cfg!(windows) {
            vec!["C:/", "C:/Windows", "C:/Program Files", "C:/Users", &home_s, &sensitive]
        } else {
            vec!["/", "/etc", "/usr", "/Library", "/Users", "/home", &home_s, &sensitive]
        };
        for root in roots {
            let probe = if cfg!(windows) { "Windows/win.ini" } else { "hosts" };
            let got = resolve_path(probe, None, Some(root));
            assert!(got.is_err(), "root {root:?} was accepted as a workspace: {got:?}");
        }
    }

    /// The reported shape, verbatim: a root of `/` turns the containment check
    /// into a formality, because everything is inside `/`.
    #[test]
    #[cfg(not(windows))]
    fn the_filesystem_root_cannot_be_used_to_read_etc_shadow() {
        let err = resolve_path("/etc/shadow", None, Some("/")).expect_err("must refuse");
        assert!(err.contains("Not an allowed workspace folder"), "got: {err}");
    }

    /// The ordinary project folders — the cases that must keep working.
    #[test]
    fn an_ordinary_project_folder_is_still_a_valid_root() {
        let home = dirs::home_dir().unwrap_or_default();
        let under_home = home.join("dev").join("site").to_string_lossy().to_string();
        let mut roots = vec![under_home];
        if cfg!(windows) {
            // A second drive is a normal Windows layout and only ONE component
            // deep — the depth rule must not refuse it.
            roots.push("D:/Projects".to_string());
            roots.push("D:/Projects/site".to_string());
        } else {
            roots.push("/projects/site".to_string());
            roots.push("/Volumes/Work/site".to_string());
        }
        for root in roots {
            // Each one stands for a folder the user chose in the dialog — the
            // only way any of them becomes a workspace now.
            allow_root_for_test(Path::new(&root));
            assert!(
                resolve_path("src/main.rs", Some("c"), Some(&root)).is_ok(),
                "root {root:?} was refused",
            );
        }
    }

    /// A folder the user picked in the native dialog is trusted verbatim, even
    /// when the structural rules would have refused it.
    #[test]
    fn a_folder_the_user_picked_is_trusted() {
        let odd = crate::os_paths::test_dir("picked");
        allow_root_for_test(&odd);
        let root = odd.to_string_lossy().to_string();
        assert!(resolve_path("notes.md", None, Some(&root)).is_ok());
        // Registering a root does NOT widen the jail inside it.
        assert!(resolve_path("../elsewhere.md", None, Some(&root)).is_err());
    }

    /// filesystem.rs kept its own copy of the chat-id sanitiser, and that copy
    /// still allowed `.` — so a chat id of ".." made the sandbox root
    /// `~/agent-workspace/..` == `$HOME` (audit IPC-1, fixed in agent.rs only).
    #[test]
    fn a_dotdot_chat_id_cannot_move_the_sandbox_root_to_home() {
        let home = dirs::home_dir().unwrap_or_default();
        assert_eq!(
            workspace_root(Some(".."), None),
            crate::os_paths::agent_workspace_root().join("__"),
        );
        for id in ["..", ".", "../.."] {
            let target = home.join(".ssh").join("id_rsa");
            assert!(
                resolve_path(&target.to_string_lossy(), Some(id), None).is_err(),
                "chat id {id:?} still reaches {target:?}",
            );
        }
    }

    /// A path that does not exist yet must still resolve — file_write creates
    /// files, and the symlink hardening must not break that.
    #[test]
    fn a_file_that_does_not_exist_yet_still_resolves() {
        let ws = crate::os_paths::test_dir("newfile");
        allow_root_for_test(&ws);
        let root = ws.to_string_lossy().to_string();
        let got = resolve_path("deep/new/dir/notes.md", None, Some(&root)).expect("new path");
        assert!(got.ends_with("deep/new/dir/notes.md"), "got: {got:?}");
    }

    /// Lexical normalization believes the path string. A symlink inside the
    /// workspace reads as `<root>/link/…` and passed containment, while the
    /// open() behind it landed wherever the link pointed.
    #[test]
    #[cfg(unix)]
    fn a_symlink_pointing_out_of_the_workspace_is_refused() {
        let base = crate::os_paths::test_dir("symjail");
        let ws = base.join("workspace");
        let outside = base.join("outside");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"private").unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("escape")).unwrap();
        allow_root_for_test(&ws);
        let root = ws.to_string_lossy().to_string();

        assert!(
            resolve_path("escape/secret.txt", None, Some(&root)).is_err(),
            "a symlink walked out of the workspace",
        );
        assert!(
            fs_read_sync("escape/secret.txt".into(), None, Some(root.clone())).is_err(),
            "fs_read followed the symlink out",
        );
        // A symlink that stays INSIDE the workspace is still fine.
        let inner = ws.join("real");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("ok.txt"), b"fine").unwrap();
        std::os::unix::fs::symlink(&inner, ws.join("alias")).unwrap();
        assert!(resolve_path("alias/ok.txt", None, Some(&root)).is_ok());
    }
}

/// The workspace root is an ALLOWLIST, not a deny-list.
///
/// The old guard accepted any path that LOOKED like a project folder. Under the
/// threat model this package writes down — a script-execution bug in the
/// WebView calling the IPC commands with arguments of its choosing — that is
/// the wrong shape: `~/Documents`, `~/.mozilla`, a password manager's export
/// folder and a mounted backup disk all look exactly like a project folder, and
/// a deny-list has to name every one of them on three operating systems to hold.
#[cfg(test)]
mod workspace_allowlist_tests {
    use super::*;

    use crate::os_paths::{TestDir, test_dir};

    fn unique(tag: &str) -> TestDir {
        test_dir(&format!("allow-{tag}"))
    }

    #[test]
    fn a_folder_nobody_picked_is_refused_however_ordinary_it_looks() {
        // Structurally impeccable: deep, under the user's home, not a system or
        // credential directory, not a mount container. The deny-list guard
        // accepted it — and this is where the interesting files are.
        let home = dirs::home_dir().unwrap_or_default();
        for never_picked in [
            home.join("Documents").join("Tax-2026"),
            home.join("Desktop"),
            home.join("Downloads").join("statements"),
        ] {
            let s = never_picked.to_string_lossy().to_string();
            let got = check_workspace_root(&never_picked);
            assert!(got.is_err(), "{never_picked:?} was accepted without anyone picking it");
            // And the whole file API is closed for it, not just the predicate.
            assert!(
                resolve_path("passport.pdf", Some("c"), Some(&s)).is_err(),
                "{never_picked:?} still resolved a file op",
            );
        }
    }

    #[test]
    fn a_folder_the_user_picked_in_the_dialog_becomes_a_root() {
        let dir = unique("picked");
        assert!(check_workspace_root(&dir).is_err(), "the test root was allowed before the pick");
        allow_root_for_test(&dir);
        assert!(check_workspace_root(&dir).is_ok(), "a picked folder was refused");
        // Subfolders of a picked root are roots too — the same project.
        assert!(check_workspace_root(&dir.join("packages").join("api")).is_ok());
    }

    #[test]
    fn the_apps_own_sandbox_is_a_root_without_anyone_picking_it() {
        // The per-chat sandbox is derived, never chosen, so the allowlist has
        // to know it or a plain sandbox chat cannot read its own files.
        let sandbox = workspace_root(Some("chat-1"), None);
        assert!(check_workspace_root(&sandbox).is_ok(), "the agent sandbox is not a root");
    }

    #[test]
    fn even_a_dialog_click_cannot_make_the_home_directory_a_workspace() {
        // The dialog opens wherever it was last pointed. One mis-click on $HOME
        // or a credential store must not turn "work in this folder" into "read
        // every secret on the machine" — permanently, because picks are kept.
        let home = dirs::home_dir().unwrap_or_default();
        for bad in [home.clone(), home.join(".ssh"), home.join(".aws"), PathBuf::from("/")] {
            assert!(
                remember_picked_root(&bad).is_err(),
                "{bad:?} was recorded as a workspace root",
            );
            assert!(check_workspace_root(&bad).is_err(), "{bad:?} passed as a root");
        }
    }

    #[test]
    fn a_tampered_allowlist_file_cannot_grant_what_a_dialog_could_not() {
        // The file is data, not authority.
        let dir = unique("file");
        let file = dir.join("workspace-roots.json");
        let home = dirs::home_dir().unwrap_or_default();
        let good = dir.join("project");
        let payload = serde_json::to_string(&vec![
            "/".to_string(),
            home.to_string_lossy().to_string(),
            home.join(".ssh").to_string_lossy().to_string(),
            good.to_string_lossy().to_string(),
        ])
        .unwrap();
        fs::write(&file, payload).unwrap();

        let loaded = load_roots_from(&file);
        assert_eq!(loaded, vec![lexical_normalize(&good)], "a forbidden root survived the read");
    }

    #[test]
    fn a_pick_survives_a_restart() {
        // Why the list is on disk at all: the frontend keeps the last workspace
        // and sends it again on the next launch. An in-memory allowlist would
        // refuse it and demand a fresh pick on every single start.
        let dir = unique("restart");
        let file = dir.join("workspace-roots.json");
        let project = dir.join("site");
        save_roots_to(&file, &[lexical_normalize(&project)]);
        assert_eq!(load_roots_from(&file), vec![lexical_normalize(&project)]);
    }

    #[test]
    fn a_missing_or_corrupt_allowlist_file_is_an_empty_allowlist() {
        // Fail CLOSED: no file, or garbage in it, must not mean "allow anything".
        let dir = unique("corrupt");
        assert!(load_roots_from(&dir.join("nope.json")).is_empty());
        let file = dir.join("workspace-roots.json");
        fs::write(&file, b"{ not json").unwrap();
        assert!(load_roots_from(&file).is_empty());
    }
}

/// The two file tools that block for seconds run OFF the Tauri main thread.
#[cfg(test)]
mod off_main_thread_tests {
    const FILESYSTEM_RS: &str = include_str!("filesystem.rs");

    /// The attributes and doc comment directly above `sig`.
    fn preamble_of(sig: &str) -> &'static str {
        let at = FILESYSTEM_RS.find(sig).unwrap_or_else(|| panic!("{sig} is gone"));
        let head = &FILESYSTEM_RS[..at];
        let start = head.rfind("\n\n").map(|i| i + 2).unwrap_or(0);
        &head[start..]
    }

    /// `fs_search` walks eight directory levels and reads every file under a
    /// megabyte — seconds of blocking IO on a real repo, and as a plain
    /// `#[tauri::command]` every one of those seconds was spent on the main
    /// thread with the window frozen.
    ///
    /// This is a source guard, and deliberately so: the fix is which attribute
    /// Tauri's macro sees. It changes how the COMMAND is dispatched, not what
    /// the Rust function does, so no in-process call can observe it — awaiting
    /// `fs_search` from a test runs the same code either way. The attribute is
    /// pinned instead, on this function, so dropping it fails here rather than
    /// in a bug report about a frozen window.
    #[test]
    fn fs_search_is_dispatched_off_the_main_thread() {
        let pre = preamble_of("pub fn fs_search(");
        assert!(
            pre.contains("#[tauri::command(async)]"),
            "fs_search lost its off-main-thread dispatch: {pre}",
        );
        assert!(
            !pre.contains("#[tauri::command]"),
            "fs_search is back on the plain (main-thread) command attribute: {pre}",
        );
    }

    /// The guard on the guard: `preamble_of` must return the attributes of the
    /// function asked for and not the whole file.
    #[test]
    fn the_preamble_slicer_reads_one_signature() {
        let pre = preamble_of("pub fn fs_search(");
        assert!(pre.len() < 2_000, "the slice ran past the attribute block");
        assert!(!pre.contains("pub fn fs_info("), "the slice ran into another function");
        // fs_read takes the other route to the same place: an `async fn` that
        // hands the blocking work to spawn_blocking.
        assert!(preamble_of("pub async fn fs_read(").contains("#[tauri::command]"));
        assert!(FILESYSTEM_RS.contains("spawn_blocking(move || fs_read_sync("));
    }
}

#[cfg(test)]
mod binary_read_tests {
    use super::*;
    use std::fs;

    fn ws(tag: &str) -> crate::os_paths::TestDir {
        let d = crate::os_paths::test_dir(&format!("fsread-{tag}"));
        allow_root_for_test(&d); // stands in for the user picking this folder
        d
    }

    /// A binary must come back as a MARKER, not as a payload. Every consumer
    /// discards the bytes, so encoding them only bought a memory spike
    /// proportional to the file — the phone relay already refused to do it.
    #[tokio::test]
    async fn a_binary_file_reports_its_size_and_no_content() {
        let dir = ws("bin");
        // Invalid UTF-8 — what read_to_string rejects.
        fs::write(dir.join("model.gguf"), [0xff, 0xfe, 0x00, 0x01, 0x80]).unwrap();

        let v = fs_read(
            "model.gguf".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
        )
        .await
        .expect("read");

        assert_eq!(v["encoding"], "binary");
        assert_eq!(v["bytes"], 5);
        assert!(v.get("content").is_none(), "the payload must not be shipped");
    }

    #[tokio::test]
    async fn a_text_file_still_comes_back_verbatim() {
        let dir = ws("txt");
        fs::write(dir.join("a.txt"), "hallo\nwelt\n").unwrap();

        let v = fs_read("a.txt".into(), None, Some(dir.to_string_lossy().to_string()))
            .await
            .expect("read");

        assert_eq!(v["encoding"], "utf8");
        assert_eq!(v["content"], "hallo\nwelt\n");
    }

    /// The whole point: cost must not scale with the file any more.
    #[tokio::test]
    async fn a_large_binary_is_cheap_to_read() {
        let dir = ws("big");
        let mut big = vec![0x80u8; 8 * 1024 * 1024]; // 8 MiB, invalid UTF-8
        big[0] = 0xff;
        fs::write(dir.join("big.bin"), &big).unwrap();

        let started = std::time::Instant::now();
        let v = fs_read("big.bin".into(), None, Some(dir.to_string_lossy().to_string()))
            .await
            .expect("read");
        let took = started.elapsed();

        assert_eq!(v["bytes"], 8 * 1024 * 1024_u64);
        assert!(v.get("content").is_none());
        assert!(took < std::time::Duration::from_millis(200), "took {took:?}");
    }
}

/// The Explorer panel's image preview reads bytes, and it must read them
/// through the same jail as everything else (2.6.6 C3 security review).
#[cfg(test)]
mod explorer_byte_read_tests {
    use super::*;
    use std::fs;

    fn ws(tag: &str) -> crate::os_paths::TestDir {
        let d = crate::os_paths::test_dir(&format!("fsbytes-{tag}"));
        allow_root_for_test(&d); // stands in for the user picking this folder
        d
    }

    #[test]
    fn bytes_inside_the_workspace_come_back_base64() {
        let dir = ws("inside");
        // A one-pixel PNG header is enough: the point is byte fidelity.
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        fs::write(dir.join("pixel.png"), &raw).unwrap();

        let v = fs_read_bytes(
            "pixel.png".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
            None,
        )
        .expect("read");

        assert_eq!(v["bytes"], raw.len());
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(v["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, raw);
    }

    /// The jail, from both directions: a `..` climb and an absolute path that
    /// points somewhere else entirely.
    #[test]
    fn bytes_outside_the_workspace_are_refused() {
        let dir = ws("outside");
        // Ausserhalb der Wurzel (die ist `dir/repo`), aber INNERHALB des
        // Testverzeichnisses — sonst raeumt der Drop-Aufraeumer es nicht mit ab.
        let secret = dir.join("lu-fsbytes-secret.txt");
        fs::write(&secret, b"private").unwrap();
        let root = dir.join("repo");
        fs::create_dir_all(&root).unwrap();

        let climb = fs_read_bytes(
            "../lu-fsbytes-secret.txt".into(),
            None,
            Some(root.to_string_lossy().to_string()),
            None,
        );
        assert!(climb.is_err(), "a .. climb must not read bytes");

        let absolute = fs_read_bytes(
            secret.to_string_lossy().to_string(),
            None,
            Some(root.to_string_lossy().to_string()),
            None,
        );
        assert!(absolute.is_err(), "an outside absolute path must not read bytes");
    }

    #[test]
    fn a_file_over_the_cap_is_refused_instead_of_shipped() {
        let dir = ws("cap");
        fs::write(dir.join("wide.bin"), vec![0u8; 4096]).unwrap();

        let err = fs_read_bytes(
            "wide.bin".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
            Some(1024),
        )
        .expect_err("over the cap");
        assert!(err.contains("too large"), "got: {err}");

        // The caller cannot raise the ceiling past the built-in one either.
        let v = fs_read_bytes(
            "wide.bin".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
            Some(u64::MAX),
        )
        .expect("under the built-in cap");
        assert_eq!(v["bytes"], 4096);
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_empty_blob() {
        let dir = ws("missing");
        let err = fs_read_bytes(
            "nope.png".into(),
            None,
            Some(dir.to_string_lossy().to_string()),
            None,
        )
        .expect_err("missing");
        assert!(err.contains("File not found"), "got: {err}");
    }
}

/// KF-15 — `fs_write` and the workspace ROOT itself.
///
/// The dev-server half of this was closed in a50fddef; this is the same hole on
/// the Rust route, i.e. in the SHIPPED build. A write whose path does not name a
/// file resolves to the workspace root, and `write_atomic` does not make a root
/// out of that — it makes a FILE. Both directions are pinned here: the refusal,
/// and every ordinary write that has to keep working.
#[cfg(test)]
mod write_needs_a_target_tests {
    use super::*;
    use std::fs;

    /// A folder the user picked in the native dialog. The workspace ROOT in
    /// these tests is a CHILD of it that does not exist yet — the shape a fresh
    /// per-chat sandbox (`~/agent-workspace/<chat_id>`) has before the first
    /// write of a chat, reproduced without touching the real home directory.
    fn picked(tag: &str) -> crate::os_paths::TestDir {
        let d = crate::os_paths::test_dir(&format!("kf15-{tag}"));
        allow_root_for_test(&d); // stands in for the user picking this folder
        d
    }

    /// Every spelling that RESOLVES to the workspace root. The first three are
    /// the ones the string predicate `is_workspace_root_path` knows; the last
    /// three it does not — they only collapse once `..` is applied.
    const ROOT_SPELLINGS: [&str; 6] = ["", ".", "./", "./.", "unterordner/..", "a/b/../.."];

    /// The sharp form: the caller picks BOTH the place and the content.
    ///
    /// `workingDirectory` names a workspace folder that does not exist yet
    /// (every chat's first write), `path` names no file. Before the guard this
    /// answered `{"status":"saved"}` and left the workspace root on disk as a
    /// regular file holding the caller's bytes.
    #[test]
    fn a_caller_cannot_write_the_workspace_root_as_a_file() {
        let parent = picked("sharp");
        // Two levels down, and NOTHING of it exists yet. That is what makes the
        // ORDER visible: a guard placed after `create_dir_all(parent)` would
        // still refuse the write, but only after leaving `nested/` behind — a
        // refused request must not create directories.
        let root = parent.join("nested").join("chat-7");
        let root_arg = root.to_string_lossy().to_string();

        let got = fs_write("".into(), "GEHEIM".into(), None, Some(root_arg));

        assert!(got.is_err(), "a write with no target was accepted: {got:?}");
        assert!(
            !root.is_file(),
            "the workspace root landed on disk as a FILE ({} bytes, content {:?})",
            fs::metadata(&root).map(|m| m.len()).unwrap_or(0),
            fs::read_to_string(&root).ok(),
        );
        // And nothing outside the cage either: `write_atomic` puts its temp file
        // in the target's PARENT, which for a root-as-target is one level ABOVE
        // the workspace.
        let debris: Vec<String> = fs::read_dir(&*parent)
            .expect("read parent")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(debris.is_empty(), "a refused write left something behind: {debris:?}");
    }

    /// Same refusal for every spelling of "no file", including the two the
    /// string predicate cannot see.
    #[test]
    fn no_spelling_of_the_root_is_a_write_target() {
        for (i, spelling) in ROOT_SPELLINGS.iter().enumerate() {
            let parent = picked(&format!("spell{i}"));
            let root = parent.join("ws");
            let root_arg = root.to_string_lossy().to_string();

            let got = fs_write((*spelling).into(), "X".into(), None, Some(root_arg));

            assert!(got.is_err(), "path {spelling:?} was accepted as a write target: {got:?}");
            assert!(
                !root.is_file(),
                "path {spelling:?} turned the workspace root into a file",
            );
        }
    }

    /// An EXISTING root cannot be overwritten either, and the refusal has to be
    /// the guard's, not an accident of `rename` failing on a directory.
    #[test]
    fn an_existing_root_directory_is_refused_before_anything_is_attempted() {
        let root = picked("existing");
        let root_arg = root.to_string_lossy().to_string();

        let got = fs_write(".".into(), "X".into(), None, Some(root_arg));

        assert!(got.is_err(), "writing over an existing root was accepted: {got:?}");
        assert!(root.is_dir(), "the workspace root stopped being a directory");
        let err = got.unwrap_err();
        assert!(
            !err.contains("rename"),
            "the refusal came from the filesystem, not from the guard: {err}",
        );
    }

    /// The refusal must NOT claim an escape. In this file
    /// "Path escapes the allowed workspace" has exactly one meaning —
    /// `contain_within` refused to let the path leave the jail — and that is not
    /// what happened here: the path is inside the workspace, it is just not a
    /// file. The siblings' wording for an argument that names the wrong KIND of
    /// thing is "Not a directory: …" (`fs_list`, `fs_search`); this is its
    /// mirror image.
    #[test]
    fn the_refusal_reads_like_a_bad_argument_and_not_like_an_escape() {
        let parent = picked("wording");
        let root = parent.join("ws");
        let err = fs_write("".into(), "X".into(), None, Some(root.to_string_lossy().to_string()))
            .expect_err("the guard did not fire");

        assert!(!err.contains("escapes"), "an in-cage path was reported as an escape: {err}");
        assert!(err.starts_with("Not a file:"), "the refusal lost its sibling wording: {err}");
        assert!(
            err.contains(&root.to_string_lossy().to_string()),
            "the refusal does not say WHICH path it means: {err}",
        );
    }

    // ── The other direction: everything that was allowed stays allowed ──────

    /// The ordinary write already does the thing a "create the root instead"
    /// fix would have added: it creates the workspace root as a DIRECTORY and
    /// puts the file inside it. Measured, not assumed — this is the reason the
    /// guard refuses instead of auto-creating.
    #[test]
    fn an_ordinary_write_still_creates_the_root_as_a_directory() {
        let parent = picked("ordinary");
        let root = parent.join("ws"); // does not exist yet
        let root_arg = root.to_string_lossy().to_string();

        let v = fs_write("notiz.txt".into(), "hallo".into(), None, Some(root_arg))
            .expect("an ordinary write was refused");

        assert_eq!(v["status"], "saved");
        assert!(root.is_dir(), "the workspace root was not created as a directory");
        assert_eq!(fs::read_to_string(root.join("notiz.txt")).unwrap(), "hallo");
    }

    /// Deep subfolders keep working, and so does a name that only LOOKS like it
    /// climbs out — `a/b/../c.txt` is a file, not the root.
    #[test]
    fn deep_subfolders_and_harmless_dotdot_still_write() {
        let root = picked("deep");
        let root_arg = root.to_string_lossy().to_string();

        fs_write("a/b/c/tief.txt".into(), "tief".into(), None, Some(root_arg.clone()))
            .expect("a deep write was refused");
        assert_eq!(fs::read_to_string(root.join("a/b/c/tief.txt")).unwrap(), "tief");

        fs_write("a/b/../flach.txt".into(), "flach".into(), None, Some(root_arg))
            .expect("a dotdot that stays inside was refused");
        assert_eq!(fs::read_to_string(root.join("a/flach.txt")).unwrap(), "flach");
    }

    /// The unchanged-write shortcut and the second write to the same file are
    /// on the far side of the guard and must still be reachable.
    #[test]
    fn rewriting_the_same_file_still_reports_unchanged() {
        let root = picked("unchanged");
        let root_arg = root.to_string_lossy().to_string();

        fs_write("x.txt".into(), "eins".into(), None, Some(root_arg.clone())).expect("first write");
        let again = fs_write("x.txt".into(), "eins".into(), None, Some(root_arg.clone()))
            .expect("second write");
        assert_eq!(again["status"], "unchanged");

        let changed = fs_write("x.txt".into(), "zwei".into(), None, Some(root_arg)).expect("third");
        assert_eq!(changed["status"], "saved");
        assert_eq!(fs::read_to_string(root.join("x.txt")).unwrap(), "zwei");
    }

    /// READING the root is a legitimate request and stays one. `fs_list(".")`
    /// on a workspace that does not exist yet still creates it as a DIRECTORY
    /// and answers with an empty listing — the guard is on the write door only.
    #[test]
    fn listing_the_root_is_still_allowed_and_still_creates_it_as_a_directory() {
        let parent = picked("list");
        let root = parent.join("ws");
        let root_arg = root.to_string_lossy().to_string();

        for spelling in ["", "."] {
            let v = fs_list(spelling.into(), None, None, None, Some(root_arg.clone()))
                .unwrap_or_else(|e| panic!("fs_list({spelling:?}) was refused: {e}"));
            assert_eq!(v["count"], 0);
            assert!(root.is_dir(), "fs_list({spelling:?}) did not create the root as a directory");
        }
    }

    // ── Why the guard measures the RESOLVED path and not the string ─────────

    /// The string predicate is wrong in BOTH directions, which is why the guard
    /// does not use it.
    ///
    /// * `"unterordner/.."` resolves to the root and the predicate says no.
    /// * `"  "` and `".\\"` resolve to ordinary FILES inside the root (on Unix a
    ///   backslash is an ordinary character) and the predicate says yes — a
    ///   guard built on it would refuse two legitimate writes.
    ///
    /// `is_workspace_root_path` keeps its one caller, `fs_list`, where it only
    /// decides whether to auto-create a directory and a wrong answer costs
    /// nothing.
    #[test]
    fn the_string_predicate_disagrees_with_the_resolved_path() {
        assert!(is_workspace_root_path(""));
        assert!(is_workspace_root_path("."));
        assert!(is_workspace_root_path("./"));
        // Misses a root: `..` is never applied.
        assert!(!is_workspace_root_path("unterordner/.."));
        assert!(!is_workspace_root_path("a/b/../.."));

        let root = picked("predicate");
        let root_arg = root.to_string_lossy().to_string();
        let resolve = |p: &str| resolve_path(p, None, Some(&root_arg)).expect("resolve");
        assert_eq!(resolve("unterordner/.."), lexical_normalize(&root));
        assert_eq!(resolve("a/b/../.."), lexical_normalize(&root));

        // Claims a root where the resolved path is a named child.
        #[cfg(not(windows))]
        {
            assert!(is_workspace_root_path("  "));
            assert!(is_workspace_root_path(".\\"));
            assert_ne!(resolve("  "), lexical_normalize(&root));
            assert_ne!(resolve(".\\"), lexical_normalize(&root));
            // …and those writes still go through.
            fs_write("  ".into(), "leerzeichen".into(), None, Some(root_arg.clone()))
                .expect("a file named with a space was refused");
            fs_write(".\\".into(), "backslash".into(), None, Some(root_arg))
                .expect("a file named with a backslash was refused");
        }
    }

    /// A COMPLETELY MISSING `path` — the dev-server's `{}` body — cannot reach
    /// this function at all: `path` is a plain `String`, and Tauri deserializes
    /// every command argument before the body runs.
    ///
    /// What this proves and what it does not: it pins the TYPE (a missing key
    /// deserializes for `Option<String>` and fails for `String`) and it pins the
    /// signature in the source. It does not drive Tauri's IPC — that needs the
    /// `tauri` `test` feature, which this crate does not build with. The three
    /// spellings that DO get through (`""`, `"."`, and the `..` shapes) are
    /// covered by real calls above.
    #[test]
    fn a_missing_path_argument_cannot_reach_the_body() {
        use serde_json::Value;
        assert!(serde_json::from_value::<String>(Value::Null).is_err());
        assert!(serde_json::from_value::<Option<String>>(Value::Null).is_ok());

        const SRC: &str = include_str!("filesystem.rs");
        let at = SRC.find("pub fn fs_write(").expect("fs_write is gone");
        let sig = &SRC[at..at + SRC[at..].find(')').expect("unterminated signature")];
        assert!(sig.contains("path: String"), "fs_write's path became optional: {sig}");
        assert!(sig.contains("chatId: Option<String>"), "the Option siblings moved: {sig}");
    }
}



