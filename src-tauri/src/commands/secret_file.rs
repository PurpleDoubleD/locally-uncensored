//! The file the keychain commands fall back to on Linux (GitHub #226).
//!
//! Linux has no credential store every desktop ships. Most run a Secret
//! Service (GNOME Keyring, KWallet 6, KeePassXC), and `secret_linux` uses it
//! whenever one answers. A tiling-WM setup, a minimal install or a fresh
//! Omarchy box may have none, and before this the HF token, the provider keys
//! and the LU Cloud session could then not be stored by Rust at all.
//!
//! This is the same posture `huggingface-cli` takes with
//! `~/.cache/huggingface/token`, and ssh with `~/.ssh/id_*`: one JSON object
//! of account → value in the app's data folder, mode 0600 in a folder only
//! the user can enter. It keeps the value from other local users, not from
//! code running as the same user, and the Settings page says so when this
//! file is what took the value (`secret_store_info`).
//!
//! Writes go to a fresh temporary file created with 0600 and are renamed over
//! the old one, so a crash mid-write never leaves half a file or a moment
//! with looser permissions. The caller serializes access.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Name of the file inside the app's data folder.
pub const FILE_NAME: &str = "secrets.json";

#[derive(Debug, Clone)]
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.load()?.remove(account))
    }

    pub fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let mut map = self.load_for_write()?;
        map.insert(account.to_string(), value.to_string());
        self.save(&map)
    }

    pub fn delete(&self, account: &str) -> Result<(), String> {
        let mut map = self.load_for_write()?;
        if map.remove(account).is_none() {
            return Ok(());
        }
        self.save(&map)
    }

    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(format!("could not read {}: {}", self.path.display(), crate::os_error::english(&e))),
        };
        self.tighten();
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("{} is not a valid secret file: {e}", self.path.display()))
    }

    /// Like `load`, but a damaged file does not block every later save
    /// forever: it is moved aside (kept, never deleted) and the write starts
    /// from an empty store.
    fn load_for_write(&self) -> Result<BTreeMap<String, String>, String> {
        match self.load() {
            Ok(m) => Ok(m),
            Err(e) if self.path.exists() => {
                let aside = self.path.with_extension(format!(
                    "json.damaged-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                ));
                tracing::warn!(error = %e, aside = %aside.display(), "moved a damaged secret file aside");
                fs::rename(&self.path, &aside).map_err(|e| format!("could not move the damaged secret file aside: {}", crate::os_error::english(&e)))?;
                Ok(BTreeMap::new())
            }
            Err(e) => Err(e),
        }
    }

    fn save(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        if map.is_empty() {
            return match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("could not remove {}: {}", self.path.display(), crate::os_error::english(&e))),
            };
        }
        let dir = self
            .path
            .parent()
            .ok_or_else(|| format!("{} has no parent folder", self.path.display()))?;
        create_private_dir(dir)?;
        let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
        // A leftover from a crash keeps its old mode through `open`, so it goes first.
        let _ = fs::remove_file(&tmp);
        let json = serde_json::to_vec_pretty(map).map_err(|_| "could not encode the secret file".to_string())?;
        let write = || -> std::io::Result<()> {
            let mut f = private_create(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
            fs::rename(&tmp, &self.path)
        };
        write().map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("could not write {}: {}", self.path.display(), crate::os_error::english(&e))
        })
    }

    /// A file copied in from elsewhere, or written by a looser umask before
    /// this existed, is brought back to 0600 whenever it is read.
    fn tighten(&self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.path) {
                if meta.permissions().mode() & 0o077 != 0 {
                    let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
                }
            }
        }
    }
}

fn private_create(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {}", dir.display(), crate::os_error::english(&e)))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, FileStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = FileStore::new(dir.path().join("lu").join(FILE_NAME));
        (dir, s)
    }

    #[test]
    fn set_get_delete_round_trip() {
        let (_d, s) = store();
        assert_eq!(s.get("huggingface-token").unwrap(), None);
        s.set("huggingface-token", "hf_abc").unwrap();
        s.set("openai", "sk-1").unwrap();
        assert_eq!(s.get("huggingface-token").unwrap().as_deref(), Some("hf_abc"));
        s.set("huggingface-token", "hf_new").unwrap();
        assert_eq!(s.get("huggingface-token").unwrap().as_deref(), Some("hf_new"));
        s.delete("huggingface-token").unwrap();
        assert_eq!(s.get("huggingface-token").unwrap(), None);
        assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-1"));
        s.delete("openai").unwrap();
        assert!(!s.path().exists(), "an empty store leaves no file behind");
        s.delete("never-there").unwrap();
    }

    #[test]
    fn long_values_are_kept_whole() {
        // The Cloud session JSON is several KB; nothing here chunks it.
        let (_d, s) = store();
        let big = "x".repeat(16 * 1024);
        s.set("lu-cloud-session", &big).unwrap();
        assert_eq!(s.get("lu-cloud-session").unwrap().as_deref(), Some(big.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_0600_and_a_new_folder_0700() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, s) = store();
        s.set("huggingface-token", "hf_abc").unwrap();
        let mode = fs::metadata(s.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(s.path().parent().unwrap()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_loose_file_is_tightened_on_read() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, s) = store();
        s.set("openai", "sk-1").unwrap();
        fs::set_permissions(s.path(), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-1"));
        let mode = fs::metadata(s.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_damaged_file_is_moved_aside_not_lost() {
        let (_d, s) = store();
        fs::create_dir_all(s.path().parent().unwrap()).unwrap();
        fs::write(s.path(), b"{not json").unwrap();
        assert!(s.get("openai").is_err(), "a read reports the damage");
        s.set("openai", "sk-2").unwrap();
        assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-2"));
        let kept = fs::read_dir(s.path().parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("damaged"));
        assert!(kept, "the damaged file is kept next to the new one");
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let (_d, s) = store();
        s.set("openai", "sk-1").unwrap();
        let names: Vec<String> = fs::read_dir(s.path().parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()]);
    }
}
