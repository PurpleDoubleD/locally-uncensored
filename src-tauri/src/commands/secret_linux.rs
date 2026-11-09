//! The keychain commands on Linux (GitHub #226).
//!
//! Until 3.1.0 every `secret_*` command on Linux answered "keychain
//! unsupported on this platform". The provider keys and the Cloud session had
//! a localStorage fallback in the frontend, the Hugging Face token had none,
//! so on Linux it could not be saved at all.
//!
//! Now the store of record is the desktop's Secret Service
//! (org.freedesktop.secrets: GNOME Keyring, KWallet 6, KeePassXC, …) over the
//! session bus, with the secret encrypted in transit as libsecret does it.
//! Where none answers, or it has no default collection, the value goes to
//! `secret_file` (0600 in the app's data folder) instead, and
//! `secret_store_info` tells the Settings page so it can say where the value
//! went.
//!
//! The frontend needed no change for the move: `hydrateProviderKeys` and the
//! Cloud storage adapter already migrate a localStorage copy into the vault
//! the first time the vault answers, exactly as they did on Windows and macOS.
//!
//! Rules:
//!   * Reads ask the Secret Service first. A value found only in the file
//!     (written while no Secret Service ran) is moved into it.
//!   * A dismissed unlock prompt or a Secret Service error is reported, never
//!     answered by a silent write to the file: the user said no to the
//!     keyring, not yes to a file.
//!   * No error text here contains "keychain unavailable" or "keychain
//!     unsupported". Those two make the frontend latch onto its localStorage
//!     path for the rest of the session (`keychainMissing`), and this backend
//!     always has somewhere to put a value.

use std::collections::HashMap;
use std::time::Duration;

use secret_service::{EncryptionType, Error as SsError, SecretService};

use super::secret_file::FileStore;

/// How long the session bus gets to hand out a Secret Service session. A
/// missing bus or provider fails at once; this only bounds a hung one.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// A whole operation, unlock prompt included. The prompt waits on the user.
const OP_TIMEOUT: Duration = Duration::from_secs(180);

/// Where a write lands right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    /// The desktop's Secret Service.
    Keyring,
    /// The 0600 file.
    File,
}

pub struct LinuxVault {
    service: String,
    file: FileStore,
}

fn err(e: SsError) -> String {
    match e {
        SsError::Prompt => "keyring locked: the unlock prompt was dismissed".into(),
        SsError::PromptDisconnected => "keyring locked: the unlock prompt went away without an answer".into(),
        SsError::Locked => "keyring locked".into(),
        e => format!("keyring error: {e}"),
    }
}

impl LinuxVault {
    pub fn new(service: impl Into<String>, file: FileStore) -> Self {
        Self { service: service.into(), file }
    }

    pub fn file(&self) -> &FileStore {
        &self.file
    }

    /// Search attributes. `service` + `username` is the layout keyring-rs and
    /// most other tools use, so `secret-tool lookup service … username …`
    /// finds the entry too.
    fn attrs<'a>(&'a self, account: &'a str) -> HashMap<&'a str, &'a str> {
        HashMap::from([("service", self.service.as_str()), ("username", account)])
    }

    /// A Secret Service session, or None when there is none to be had.
    async fn connect(&self) -> Option<SecretService<'static>> {
        for (enc, name) in [(EncryptionType::Dh, "dh"), (EncryptionType::Plain, "plain")] {
            match tokio::time::timeout(CONNECT_TIMEOUT, SecretService::connect(enc)).await {
                Ok(Ok(ss)) => return Some(ss),
                // No bus, no provider on it: nothing a second try changes.
                Ok(Err(SsError::Unavailable)) => {
                    tracing::debug!("no Secret Service on the session bus");
                    return None;
                }
                Ok(Err(e)) => tracing::debug!(error = %e, session = name, "Secret Service session refused"),
                Err(_) => {
                    tracing::warn!("Secret Service did not answer within {CONNECT_TIMEOUT:?}");
                    return None;
                }
            }
        }
        None
    }

    async fn bounded<T>(fut: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::time::timeout(OP_TIMEOUT, fut)
            .await
            .unwrap_or_else(|_| Err(format!("keyring did not answer within {} s", OP_TIMEOUT.as_secs())))
    }

    pub async fn get(&self, account: &str) -> Result<Option<String>, String> {
        Self::bounded(async {
            let Some(ss) = self.connect().await else {
                return self.file.get(account);
            };
            if let Some(v) = self.keyring_get(&ss, account).await? {
                return Ok(Some(v));
            }
            // Written in a session that had no Secret Service: move it over.
            let Some(v) = self.file.get(account)? else { return Ok(None) };
            match self.keyring_set(&ss, account, &v).await {
                Ok(true) => {
                    if let Err(e) = self.file.delete(account) {
                        tracing::warn!(error = %e, "moved a secret into the keyring, the file copy stays");
                    }
                }
                Ok(false) => {}
                Err(e) => tracing::debug!(error = %e, "could not move a secret from the file into the keyring yet"),
            }
            Ok(Some(v))
        })
        .await
    }

    /// Stores `value` (empty means delete) and says where it went.
    pub async fn set(&self, account: &str, value: &str) -> Result<Where, String> {
        if value.is_empty() {
            self.delete(account).await?;
            return Ok(self.target().await);
        }
        Self::bounded(async {
            if let Some(ss) = self.connect().await {
                if self.keyring_set(&ss, account, value).await? {
                    // An older file copy would otherwise outlive the new value.
                    self.file.delete(account)?;
                    return Ok(Where::Keyring);
                }
            }
            self.file.set(account, value)?;
            Ok(Where::File)
        })
        .await
    }

    pub async fn delete(&self, account: &str) -> Result<(), String> {
        Self::bounded(async {
            if let Some(ss) = self.connect().await {
                let found = ss.search_items(self.attrs(account)).await.map_err(err)?;
                for item in found.unlocked.iter().chain(found.locked.iter()) {
                    if item.is_locked().await.map_err(err)? {
                        item.unlock().await.map_err(err)?;
                    }
                    item.delete().await.map_err(err)?;
                }
            }
            self.file.delete(account)
        })
        .await
    }

    /// Where a write would land right now, for the Settings hint.
    pub async fn target(&self) -> Where {
        let Some(ss) = self.connect().await else { return Where::File };
        match tokio::time::timeout(CONNECT_TIMEOUT, ss.get_default_collection()).await {
            Ok(Ok(_)) => Where::Keyring,
            _ => Where::File,
        }
    }

    async fn keyring_get(&self, ss: &SecretService<'_>, account: &str) -> Result<Option<String>, String> {
        let found = ss.search_items(self.attrs(account)).await.map_err(err)?;
        let item = match (found.unlocked.first(), found.locked.first()) {
            (Some(i), _) => i,
            (None, Some(i)) => {
                i.unlock().await.map_err(err)?;
                i
            }
            (None, None) => return Ok(None),
        };
        let bytes = item.get_secret().await.map_err(err)?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "keyring error: the stored value is not text".into())
    }

    /// Ok(false): the Secret Service runs but has no default collection to
    /// write into (KeePassXC with no group exposed, a keyring never set up).
    /// Creating one would pop up a "new keyring password" dialog nobody asked
    /// for, so the caller uses the file instead.
    async fn keyring_set(&self, ss: &SecretService<'_>, account: &str, value: &str) -> Result<bool, String> {
        let coll = match ss.get_default_collection().await {
            Ok(c) => c,
            Err(SsError::NoResult) => return Ok(false),
            Err(e) => return Err(err(e)),
        };
        if coll.is_locked().await.map_err(err)? {
            coll.unlock().await.map_err(err)?;
        }
        let label = format!("{}: {account}", crate::app_identity::PRODUCT_NAME);
        let created = coll
            .create_item(&label, self.attrs(account), value.as_bytes(), true, "text/plain")
            .await
            .map_err(err)?;
        // `replace` only replaces inside the default collection. A copy in
        // another collection would shadow the new value on the next read.
        let created_path = created.item_path.clone();
        let found = ss.search_items(self.attrs(account)).await.map_err(err)?;
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            if item.item_path != created_path {
                if let Err(e) = item.delete().await {
                    tracing::warn!(error = %e, "could not remove an older keyring copy");
                }
            }
        }
        Ok(true)
    }
}
