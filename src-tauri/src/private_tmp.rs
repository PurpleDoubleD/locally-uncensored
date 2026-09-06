//! One private temp file, done once.
//!
//! Two places in this app hand a file to a child process it has to read back:
//! the agent's Python script (`commands::agent`) and a dictation take's audio
//! (`commands::whisper`). Both started the same way — `<shared temp>/<name>-<
//! millisecond timestamp>.<ext>`, written with `fs::write` — and both had the
//! same two problems.
//!
//! * The system temp directory is world-readable (0777+t on Unix, and every
//!   local account can list it). The agent's script carries whatever the user
//!   or the model put in it; a dictation take is a recording of the user's
//!   voice. Neither is something every account on the machine gets to read.
//! * A millisecond timestamp is not a name, it is a guess anyone can make. A
//!   local process that guesses it can pre-place the path (so the write lands
//!   in a file it owns) or swap it between the write and the read — the second
//!   one is the classic temp race, and here the swapped-in content is executed
//!   by an interpreter or transcribed and put in the user's chat.
//!
//! The fix was made once for the script and left un-made for the audio. It
//! lives here now so there is nothing left to make twice: a directory created
//! by `mkdir(0700)` — the mode goes to the syscall, not to a chmod afterwards,
//! so the directory is never briefly readable — holding a file created with
//! `create_new` (a pre-placed name is an error, never a target) and 0600. The
//! returned `TempDir` owns the lifetime: dropping it removes the directory and
//! its contents, including on every early return of the caller.

use crate::os_error;
use std::path::PathBuf;

/// Write `bytes` to `file_name` inside a fresh 0700 temp directory.
///
/// The caller must keep the returned `TempDir` alive for as long as the file is
/// needed — dropping it deletes both.
pub fn write_private_temp(
    dir_prefix: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<(tempfile::TempDir, PathBuf), String> {
    use std::io::Write;
    let mut builder = tempfile::Builder::new();
    builder.prefix(dir_prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let dir = builder
        .tempdir()
        .map_err(|e| format!("Create temp dir: {}", os_error::english(&e)))?;
    let path = dir.path().join(file_name);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&path)
        .map_err(|e| format!("Write temp file: {}", os_error::english(&e)))?;
    file.write_all(bytes)
        .map_err(|e| format!("Write temp file: {}", os_error::english(&e)))?;
    Ok((dir, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_lands_in_a_private_directory_under_an_unguessable_name() {
        let (dir_a, path_a) = write_private_temp("lu-test-", "payload.bin", b"a").expect("write");
        let (dir_b, _path_b) = write_private_temp("lu-test-", "payload.bin", b"b").expect("write");
        assert_eq!(std::fs::read(&path_a).unwrap(), b"a");
        assert_ne!(dir_a.path(), dir_b.path(), "two calls shared a directory");
        let name = dir_a.path().file_name().unwrap().to_string_lossy().to_string();
        let suffix = name.trim_start_matches("lu-test-");
        assert!(suffix.len() >= 6, "name is too short to be unguessable: {name}");
        assert!(
            !suffix.chars().all(|c| c.is_ascii_digit()),
            "the name is a plain number again: {name}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn nothing_outside_this_user_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, path) = write_private_temp("lu-test-", "secret.wav", b"voice").expect("write");
        let dmode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700, "temp dir is {dmode:o}, not 0700");
        let fmode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(fmode & 0o077, 0, "file is group/world accessible: {fmode:o}");
    }

    #[test]
    fn dropping_the_handle_removes_the_directory() {
        let (dir, path) = write_private_temp("lu-test-", "x.txt", b"x").expect("write");
        let dir_path = dir.path().to_path_buf();
        drop(dir);
        assert!(!path.exists());
        assert!(!dir_path.exists());
    }

    #[test]
    fn an_existing_name_is_an_error_and_not_a_target() {
        let (dir, path) = write_private_temp("lu-test-", "once.txt", b"first").expect("write");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        assert!(opts.open(&path).is_err(), "create_new accepted an existing path");
        drop(dir);
    }
}
