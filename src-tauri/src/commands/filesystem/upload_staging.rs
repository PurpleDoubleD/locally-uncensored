//! Binary attachments never reopen a pathname supplied by the workspace.
//!
//! Each upload owns an exclusive file in a random, private, same-filesystem
//! directory. Retained handles and identity/link checks reject a poisoned old
//! `.name.lu-part` and substitutions between chunks. Publication is no-clobber.
//! As with the surrounding pathname jail, these checks do not isolate a process
//! continuously racing filesystem operations as the same OS user; the checks
//! before and after hard_link are deliberately not called an atomic race guard.

use super::*;
use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

const MAX_UPLOADS: usize = 64;
const IDLE: Duration = Duration::from_secs(30 * 60);
static UPLOADS: Lazy<Mutex<HashMap<PathBuf, Upload>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy)]
struct Identity {
    device: u64,
    file: u64,
    links: u64,
}

impl Identity {
    fn same(self, other: Self) -> bool {
        self.device == other.device && self.file == other.file
    }
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> Identity {
    use std::os::unix::fs::MetadataExt;
    Identity {
        device: metadata.dev(),
        file: metadata.ino(),
        links: metadata.nlink(),
    }
}

#[cfg(windows)]
fn file_identity(file: &fs::File) -> std::io::Result<Identity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // The handle remains owned by `file`, and Windows fills this fixed struct.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(Identity {
        device: info.dwVolumeSerialNumber as u64,
        file: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        links: info.nNumberOfLinks as u64,
    })
}

#[cfg(unix)]
fn file_identity(file: &fs::File) -> std::io::Result<Identity> {
    file.metadata().map(|metadata| metadata_identity(&metadata))
}

fn path_identity(path: &Path) -> std::io::Result<Identity> {
    #[cfg(unix)]
    {
        fs::symlink_metadata(path).map(|metadata| metadata_identity(&metadata))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        // Inspect the entry itself, including directory entries, without
        // following a substituted symlink/junction to its destination.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        file_identity(&file)
    }
}

fn io_error(error: std::io::Error) -> String {
    format!("Write error: {}", os_error::english(&error))
}
fn changed() -> String {
    "Upload staging file was changed; restart the upload".to_string()
}

struct Upload {
    directory: PathBuf,
    path: PathBuf,
    file: Option<fs::File>,
    identity: Identity,
    directory_identity: Identity,
    touched: Instant,
}

impl Upload {
    fn create(target: &Path) -> Result<Self, String> {
        let parent = target
            .parent()
            .ok_or_else(|| "No parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let parent = fs::canonicalize(parent).map_err(io_error)?;
        let directory = tempfile::Builder::new()
            .prefix(".lu-upload-")
            .tempdir_in(parent)
            .map_err(io_error)?;
        let path = directory.path().join("bytes");
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(io_error)?;
        let identity = file_identity(&file).map_err(io_error)?;
        let directory_identity = path_identity(directory.path()).map_err(io_error)?;
        // Cleanup below removes only our entry and the empty directory. A
        // TempDir's recursive destructor is inappropriate after substitutions.
        let directory = directory.keep();
        Ok(Self {
            directory,
            path,
            file: Some(file),
            identity,
            directory_identity,
            touched: Instant::now(),
        })
    }

    fn assert_owned(&self, links: u64) -> Result<u64, String> {
        let directory = fs::symlink_metadata(&self.directory).map_err(io_error)?;
        let path = fs::symlink_metadata(&self.path).map_err(io_error)?;
        let file = self.file.as_ref().ok_or_else(changed)?;
        let identity = file_identity(file).map_err(io_error)?;
        let entry = path_identity(&self.path).map_err(io_error)?;
        if !directory.is_dir()
            || directory.file_type().is_symlink()
            || !path.is_file()
            || path.file_type().is_symlink()
            || !path_identity(&self.directory)
                .map_err(io_error)?
                .same(self.directory_identity)
            || !identity.same(self.identity)
            || !entry.same(self.identity)
            || identity.links != links
            || entry.links != links
        {
            return Err(changed());
        }
        file.metadata()
            .map(|metadata| metadata.len())
            .map_err(io_error)
    }

    fn publish(&self, target: &Path) -> Result<(), String> {
        self.publish_with(target, |source, target| fs::hard_link(source, target))
    }

    fn publish_with(
        &self,
        target: &Path,
        link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        self.assert_owned(1)?;
        match link(&self.path, target) {
            Ok(()) => {}
            Err(error) if no_hardlinks(&error) => return self.publish_without_hardlinks(target),
            Err(error) => return Err(publication_error(target, error)),
        }
        let published_identity = path_identity(target).map_err(io_error)?;
        let published = (|| {
            let metadata = fs::symlink_metadata(target).map_err(io_error)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || !published_identity.same(self.identity)
            {
                return Err(changed());
            }
            self.assert_owned(2).map(|_| ())
        })();
        if published.is_err() {
            unlink_if_owned(target, published_identity);
        }
        published
    }

    fn publish_without_hardlinks(&self, target: &Path) -> Result<(), String> {
        self.assert_owned(1)?;
        // tempfile's locked implementation uses MoveFileExW without
        // REPLACE_EXISTING on Windows and renameat2/renamex_np NOREPLACE on
        // Linux/macOS. These preserve complete-or-absent visibility on FAT /
        // exFAT as well as NTFS/APFS/ext4. Never use std::fs::rename here.
        let path = tempfile::TempPath::try_from_path(self.path.clone()).map_err(io_error)?;
        path.persist_noclobber(target)
            .map_err(|error| publication_error(target, error.error))?;
        let published_identity = path_identity(target).map_err(io_error)?;
        let published = (|| {
            let entry = fs::symlink_metadata(target).map_err(io_error)?;
            let file = self.file.as_ref().ok_or_else(changed)?;
            let identity = file_identity(file).map_err(io_error)?;
            let directory = fs::symlink_metadata(&self.directory).map_err(io_error)?;
            if !entry.is_file()
                || entry.file_type().is_symlink()
                // A filesystem can change its file identifier on rename.
                // The retained handle, rather than the old pathname's cached
                // identifier, is the authority after the no-replace move.
                || !published_identity.same(identity)
                || identity.links != 1
                || published_identity.links != 1
                || !directory.is_dir()
                || directory.file_type().is_symlink()
                || !path_identity(&self.directory)
                    .map_err(io_error)?
                    .same(self.directory_identity)
            {
                return Err(changed());
            }
            Ok(())
        })();
        if published.is_err() {
            unlink_if_owned(target, published_identity);
        }
        published
    }
}

fn publication_error(target: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        format!("File already exists: {}", target.display())
    } else {
        io_error(error)
    }
}

fn no_hardlinks(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::Unsupported
            | std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::CrossesDevices
    ) {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED};
        return error.raw_os_error().is_some_and(|code| {
            code == ERROR_INVALID_FUNCTION as i32 || code == ERROR_NOT_SUPPORTED as i32
        });
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn unlink_if_owned(target: &Path, identity: Identity) {
    if path_identity(target).is_ok_and(|current| current.same(identity)) {
        let _ = fs::remove_file(target);
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.file.take(); // Close before cleanup, including on Windows.
        if fs::symlink_metadata(&self.directory)
            .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            && path_identity(&self.directory).is_ok_and(|id| id.same(self.directory_identity))
        {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(&self.directory); // Never recursively delete unexpected entries.
        }
    }
}

fn upload_key(target: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(super::win_compare_key(target))
    }
    #[cfg(not(windows))]
    {
        target.to_path_buf()
    }
}

pub(super) fn write_chunk(
    target: &Path,
    bytes: &[u8],
    offset: u64,
    last: bool,
) -> Result<(), String> {
    let key = upload_key(target);
    let mut uploads = UPLOADS
        .lock()
        .map_err(|_| "Upload state is unavailable".to_string())?;
    uploads.retain(|_, upload| upload.touched.elapsed() <= IDLE);
    if offset == 0 {
        uploads.remove(&key); // Preserve restart after an abandoned first attempt.
        if uploads.len() >= MAX_UPLOADS {
            if let Some(oldest) = uploads
                .iter()
                .min_by_key(|(_, upload)| upload.touched)
                .map(|(key, _)| key.clone())
            {
                uploads.remove(&oldest);
            }
        }
        uploads.insert(key.clone(), Upload::create(target)?);
    }
    let Some(upload) = uploads.get_mut(&key) else {
        return Err(format!(
            "Upload out of order: expected the chunk at byte 0, got the one at byte {offset}"
        ));
    };
    let have = match upload.assert_owned(1) {
        Ok(have) => have,
        Err(error) => {
            uploads.remove(&key);
            return Err(error);
        }
    };
    if have != offset {
        return Err(format!(
            "Upload out of order: expected the chunk at byte {have}, got the one at byte {offset}"
        ));
    }
    let result = (|| {
        upload
            .file
            .as_mut()
            .ok_or_else(changed)?
            .write_all(bytes)
            .map_err(io_error)?;
        upload.touched = Instant::now();
        if last {
            upload.publish(target)?;
        }
        Ok(())
    })();
    if last || result.is_err() {
        uploads.remove(&key);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_hardlinks_use_atomic_no_replace_publication() {
        let dir = crate::os_paths::test_dir("upload-no-hardlinks");
        for bytes in [&b"attachment\0\xff\r\n"[..], &b""[..]] {
            let target = dir.join(format!("rom-{}.bin", bytes.len()));
            let mut upload = Upload::create(&target).unwrap();
            upload.file.as_mut().unwrap().write_all(bytes).unwrap();
            upload
                .publish_with(&target, |_, _| Err(std::io::ErrorKind::Unsupported.into()))
                .unwrap();
            assert_eq!(fs::read(&target).unwrap(), bytes);
            assert!(
                !upload.path.exists(),
                "the no-replace move consumes the owned stage name"
            );
        }
    }

    #[test]
    fn no_hardlinks_fallback_preserves_a_destination_created_during_publication() {
        let dir = crate::os_paths::test_dir("upload-no-hardlinks-collision");
        let target = dir.join("rom.bin");
        let mut upload = Upload::create(&target).unwrap();
        upload
            .file
            .as_mut()
            .unwrap()
            .write_all(b"attachment")
            .unwrap();
        let error = upload
            .publish_with(&target, |_, destination| {
                fs::write(destination, b"existing project file")?;
                Err(std::io::ErrorKind::Unsupported.into())
            })
            .expect_err("fallback must not overwrite");
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"existing project file");
    }

    #[test]
    fn no_hardlinks_fallback_rechecks_the_source_entry() {
        let dir = crate::os_paths::test_dir("upload-no-hardlinks-substitution");
        let target = dir.join("rom.bin");
        let victim = dir.join("outside");
        fs::write(&victim, b"outside unchanged").unwrap();
        let mut upload = Upload::create(&target).unwrap();
        upload
            .file
            .as_mut()
            .unwrap()
            .write_all(b"attachment")
            .unwrap();
        let error = upload
            .publish_with(&target, |source, _| {
                fs::remove_file(source)?;
                fs::hard_link(&victim, source)?;
                Err(std::io::ErrorKind::Unsupported.into())
            })
            .expect_err("fallback must recheck the stage");
        assert!(error.contains("staging file was changed"), "{error}");
        assert_eq!(fs::read(&victim).unwrap(), b"outside unchanged");
        assert!(!target.exists());
    }

    #[test]
    fn publication_itself_never_replaces_a_destination() {
        let dir = crate::os_paths::test_dir("upload-no-clobber");
        let target = dir.join("rom.bin");
        let mut upload = Upload::create(&target).unwrap();
        upload
            .file
            .as_mut()
            .unwrap()
            .write_all(b"attachment")
            .unwrap();
        fs::write(&target, b"existing project file").unwrap();
        let error = upload.publish(&target).expect_err("atomic no-replace");
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"existing project file");
    }

    #[test]
    fn publication_rejects_a_replaced_source_entry() {
        let dir = crate::os_paths::test_dir("upload-publish-substitution");
        let target = dir.join("rom.bin");
        let victim = dir.join("outside");
        fs::write(&victim, b"outside unchanged").unwrap();
        let mut upload = Upload::create(&target).unwrap();
        upload
            .file
            .as_mut()
            .unwrap()
            .write_all(b"attachment")
            .unwrap();
        fs::remove_file(&upload.path).unwrap();
        fs::hard_link(&victim, &upload.path).unwrap();
        assert!(upload.publish(&target).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"outside unchanged");
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn publication_never_replaces_a_dangling_symlink() {
        let dir = crate::os_paths::test_dir("upload-dangling-target");
        let target = dir.join("rom.bin");
        let missing = dir.join("missing-outside");
        let upload = Upload::create(&target).unwrap();
        std::os::unix::fs::symlink(&missing, &target).unwrap();
        assert!(upload
            .publish(&target)
            .unwrap_err()
            .contains("already exists"));
        assert!(fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!missing.exists());
    }
}
