//! OS keychain storage for provider API keys (security fix H5) and the LU
//! Cloud session.
//!
//! Provider keys used to live in localStorage under reversible base64
//! (providerStore.ts). On Windows + macOS we store them in the OS credential
//! vault instead — Windows Credential Manager / macOS Keychain, via the
//! `keyring` crate. Both backends ship with the OS, so no extra system library
//! is pulled in, and the secret is bound to the user's login.
//!
//! Windows caps a single credential blob at CRED_MAX_CREDENTIAL_BLOB_SIZE
//! (2560 bytes = 1280 UTF-16 units) and keyring pre-flights every write
//! against it, so the ~2–4 KB supabase session JSON can never fit in one
//! entry. Values over the per-entry budget are therefore split across
//! `account#0`, `account#1`, … with a short `__lu_chunks__:<n>` marker under
//! the base account. macOS has no such limit and keeps single-entry writes;
//! short values are stored identically on both platforms, and plain values
//! written by older builds read back unchanged.
//!
//! Linux desktop (since 3.1.0, GitHub #226) stores through the desktop's
//! Secret Service, with a 0600 file in the app's data folder where none
//! answers: `secret_linux` and `secret_file`. The web build has no Rust side;
//! there the frontend keeps its obfuscated-localStorage path.

/// Keychain service name. The "account" is the provider id (ollama / openai /
/// anthropic). Keep this stable: changing it would orphan stored keys.
///
/// Der Name ist KEIN Pfad, gehört aber zur selben Sammelstelle. Ein Build mit
/// abweichendem Service-Namen liest die echten API-Schlüssel des Nutzers nicht
/// mehr und legt beim nächsten Speichern einen zweiten Satz daneben. Deshalb
/// kommt er aus `crate::app_identity`, wo ein Test seinen Wert festhält, und
/// nicht als Literal aus dieser Datei.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const SERVICE: &str = crate::app_identity::KEYCHAIN_SERVICE;

// ── T-61: the account name is an argument, so it needs an allowlist ─────────
//
// `secret_set` / `secret_get` / `secret_delete` take the account straight from
// the frontend, and the invoke bridge is reachable from any script that gets to
// run in the webview (`__TAURI_INTERNALS__.invoke`; `withGlobalTauri: false`
// removed the convenience wrapper, not the bridge). Without a check on the
// name, one script-execution bug reads the whole vault — the Supabase session
// and every provider key — and can write anything into it under a name the app
// will never look at again.
//
// The list below is ERHOBEN, nicht geraten: every entry has exactly one call
// site in the frontend, and `the_allowlist_covers_every_account_the_frontend_uses`
// re-derives it from those files on every test run.
//
//   ollama / openai / anthropic     `PROVIDER_IDS` in stores/providerStore.ts,
//                                   the ids `setProviderApiKey` stores keys for
//   huggingface-token               `HF_TOKEN_ACCOUNT` in api/mlx-image.ts
//   lu-cloud-session                `SESSION_ACCOUNT` in api/cloud/supabase.ts
//   lu-cloud-session-code-verifier  the PKCE verifier: supabase-js writes it
//                                   through the same storage adapter under
//                                   `${storageKey}-code-verifier`
//
// On a phone only (`PHONE_ACCOUNTS`, the desktop refuses the name as v3.0.5
// did, because nothing on the desktop stores under it):
//   lu-remote-token                 `REMOTE_TOKEN_ACCOUNT` in lib/lu-native.ts,
//                                   the session token of the phone as a
//                                   Remote client (createSecureTokenVault)
//
// HAZARD, named on purpose: this is an exact-match list, so a supabase-js
// upgrade that routes a THIRD key through `keychainStorage` would be refused
// here and would break sign-in. That is why a refusal is logged at warn level
// with the offending name — the failure has to be diagnosable from the rolling
// log, not just visible as a dead login. The alternative (a `lu-cloud-session*`
// prefix family) was rejected: it would leave a writable corner of the vault
// open, which is the half of the finding about writes.
const ALLOWED_ACCOUNTS: [&str; 6] = [
    "ollama",
    "openai",
    "anthropic",
    "huggingface-token",
    "lu-cloud-session",
    "lu-cloud-session-code-verifier",
];

/// The accounts only the Android and iOS builds store under. The desktop has
/// no caller for them, so there they stay what they were in v3.0.5: refused.
const PHONE_ACCOUNTS: [&str; 1] = ["lu-remote-token"];

/// The rule itself, with the platform as an argument so both halves can be
/// tested on any machine.
fn account_allowed(account: &str, phone: bool) -> bool {
    ALLOWED_ACCOUNTS.contains(&account) || (phone && PHONE_ACCOUNTS.contains(&account))
}

/// Reject an account name the app never stores under.
///
/// Deliberately NOT phrased like the two strings the frontend treats as "there
/// is no keychain here" (`keychainMissing` in api/cloud/supabase.ts matches
/// "keychain unavailable" / "keychain unsupported"). A refused NAME must not
/// latch the adapter onto its plaintext-localStorage fallback — that would turn
/// a rejected write into a downgrade, which is worse than the write.
fn check_account(account: &str) -> Result<(), String> {
    if account_allowed(account, cfg!(mobile)) {
        return Ok(());
    }
    tracing::warn!(
        account = %account,
        "refused a secret operation for an account this app does not store"
    );
    let mut known: Vec<&str> = ALLOWED_ACCOUNTS.to_vec();
    if cfg!(mobile) {
        known.extend(PHONE_ACCOUNTS);
    }
    Err(format!(
        "refused: '{account}' is not one of the accounts this app stores ({})",
        known.join(", ")
    ))
}

// ── R9: parked keys for a displaced OpenAI-compatible backend's key ────────
//
// When one OpenAI-compatible-slot backend takes over the slot from another
// (openai-slot-handover.ts, chat branch), the displaced backend's API key had
// nowhere safe to go: ALLOWED_ACCOUNTS above is a fixed six-entry list with no
// room for "whichever backend just lost the slot", and letting the caller
// name an arbitrary vault account here would reopen exactly what T-61 closed.
// This adds a narrow second door instead: one fixed prefix, plus a backend id
// that must pass a strict pattern, never a free-form account name and never a
// path (review 2026-09-18, R9).
//
// The prefix and the pattern together also rule out collisions: no
// ALLOWED_ACCOUNTS entry contains ':', and the internal chunk-shape suffix
// (`account#N`, chunked::chunk_account) uses '#', which the pattern below
// forbids in a backend id, so a parked account string can never be mistaken
// for a plain account or a chunk fragment, and vice versa.

/// Fixed prefix for a parked key's vault account name.
const PARKED_PREFIX: &str = "parked-key:";

/// Longest backend id accepted. Generous for any real provider slug
/// ("lmstudio", "openai-compatible", "local-vllm", ...); short enough that
/// this cannot be used to smuggle large data through an "id".
const MAX_BACKEND_ID_LEN: usize = 64;

/// Lowercase ascii letters, digits and hyphen only, never uppercase (so a
/// case-varied near-miss cannot alias a real id), never '/', '\\', ':', '.'
/// or whitespace (so this can never be read as a path or collide with the
/// prefix separator or the chunk-shape suffix).
fn is_valid_backend_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_BACKEND_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Build the vault account name for a parked key, or reject the id. The ONLY
/// place a parked account string is constructed, so every command below runs
/// through the same check, same shape as `check_account` above, deliberately
/// kept separate from it because a parked id is not drawn from a fixed list.
///
/// Logs only the id's length, never the id or any secret value: the id itself
/// is not secret, but a refusal log is not the place to start making that
/// judgment call per caller.
fn parked_account(backend_id: &str) -> Result<String, String> {
    if !is_valid_backend_id(backend_id) {
        tracing::warn!(
            backend_id_len = backend_id.len(),
            "refused a parked-key operation for a backend id that failed validation"
        );
        return Err(
            "refused: backend id must be 1-64 lowercase letters, digits and hyphens only"
                .to_string(),
        );
    }
    Ok(format!("{PARKED_PREFIX}{backend_id}"))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod chunked {
    use super::SERVICE;

    /// Per-entry budget in UTF-16 units, or `None` where the platform's store
    /// has no per-entry limit at all. keyring's windows-native backend rejects
    /// blobs over 2560 bytes (1280 units) — stay comfortably under. macOS has
    /// no limit, so it never chunks and writes stay single-entry.
    ///
    /// "No limit" is `None` and not `usize::MAX` on purpose. With the sentinel,
    /// the `count() <= MAX_UNITS` in `set` was a comparison against the maximum
    /// of the type on every non-Windows target, i.e. always true —
    /// `clippy::absurd_extreme_comparisons`, which is deny-by-default, so this
    /// one line made `cargo clippy` exit non-zero for the whole crate even
    /// without `-D warnings`. `Option` states the same fact without a value
    /// that only pretends to be a bound.
    const MAX_UNITS: Option<usize> = if cfg!(target_os = "windows") {
        Some(1000)
    } else {
        None
    };

    /// Head marker for a chunked value. No provider key or session JSON ever
    /// starts with this, so plain pre-existing entries read back unchanged.
    const MARKER: &str = "__lu_chunks__:";

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }

    fn chunk_account(account: &str, i: usize) -> String {
        format!("{account}#{i}")
    }

    fn delete_entry(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Upper bound for the chunk sweep. 64 × MAX_UNITS is far beyond any
    /// credential this app stores; it only stops a runaway loop.
    const MAX_CHUNKS: usize = 64;

    /// Delete chunk entries from `from` upward until one is missing.
    ///
    /// Sweeps the entries THEMSELVES instead of trusting the head's recorded
    /// count. A chunked write that failed before the marker landed leaves
    /// fragments the head never points at, and a count-driven cleanup could
    /// not see them — so they survived every later delete. Secret material
    /// outliving the deletion the user asked for is the one outcome this
    /// module must not have.
    fn sweep_chunks_from(account: &str, from: usize) -> Result<(), String> {
        for i in from..MAX_CHUNKS {
            let acct = chunk_account(account, i);
            match entry(&acct)?.get_password() {
                Ok(_) => delete_entry(&acct)?,
                Err(keyring::Error::NoEntry) => break,
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    pub(super) fn parse_marker(head: &str) -> Option<usize> {
        head.strip_prefix(MARKER)?.parse().ok()
    }

    /// Split at char boundaries so every piece stays within `max_units`
    /// UTF-16 units — the unit keyring measures the blob size in.
    pub(super) fn split_units(value: &str, max_units: usize) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut cur = String::new();
        let mut units = 0usize;
        for ch in value.chars() {
            let n = ch.len_utf16();
            if units + n > max_units && !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
                units = 0;
            }
            cur.push(ch);
            units += n;
        }
        if !cur.is_empty() {
            chunks.push(cur);
        }
        chunks
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        // Only Windows carries a budget, and the bound sits next to the
        // platform that needs it. No budget means the value always fits in the
        // head; with a budget, measure before deciding to chunk.
        let Some(max_units) = MAX_UNITS.filter(|max| value.encode_utf16().count() > *max) else {
            entry(account)?.set_password(value).map_err(|e| e.to_string())?;
            // Drop every chunk: this value lives in the head alone now.
            let _ = sweep_chunks_from(account, 0);
            return Ok(());
        };
        // Chunks first, marker last — a torn write keeps the old head (and
        // thus the old value) readable.
        let parts = split_units(value, max_units);
        for (i, part) in parts.iter().enumerate() {
            entry(&chunk_account(account, i))?
                .set_password(part)
                .map_err(|e| e.to_string())?;
        }
        entry(account)?
            .set_password(&format!("{MARKER}{}", parts.len()))
            .map_err(|e| e.to_string())?;
        // Anything past the new tail is left over from a longer previous value.
        let _ = sweep_chunks_from(account, parts.len());
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        let head = match entry(account)?.get_password() {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let Some(count) = parse_marker(&head) else {
            return Ok(Some(head));
        };
        let mut value = String::new();
        for i in 0..count {
            match entry(&chunk_account(account, i))?.get_password() {
                Ok(part) => value.push_str(&part),
                // A missing chunk is a torn write — report absent, not corrupt.
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(Some(value))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        delete_entry(account)?;
        sweep_chunks_from(account, 0)
    }
}

/// Test-only kill switch for the OS keychain. A rebuilt ad-hoc-signed app gets a
/// fresh code-signing hash, so macOS re-prompts for the login password on the
/// first keychain read after every rebuild — which stalls unattended
/// rebuild→open test loops. When `LU_NO_KEYCHAIN` is set (env var, or a
/// `~/.lu-no-keychain` marker file), the secret commands report the keychain as
/// unavailable; the frontend adapters (supabase.ts session, providerStore keys)
/// then latch to their localStorage path and never touch the keychain.
///
/// SECURITY (review 2.5.7): this bypass is gated behind the `insecure-test-keychain`
/// Cargo feature, which is NOT in any default and is never enabled in a shipped
/// build. In a release binary the whole env/marker check compiles out to `false`,
/// so a same-user process cannot drop `~/.lu-no-keychain` (or set the env var) to
/// silently downgrade the Supabase session + provider keys to plaintext
/// localStorage. Only builds made with `--features insecure-test-keychain` honor it.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn keychain_disabled() -> bool {
    #[cfg(not(feature = "insecure-test-keychain"))]
    {
        false
    }
    #[cfg(feature = "insecure-test-keychain")]
    {
        if let Some(v) = std::env::var_os("LU_NO_KEYCHAIN") {
            if !v.is_empty() {
                return true;
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if std::path::Path::new(&home).join(".lu-no-keychain").exists() {
                return true;
            }
        }
        false
    }
}

// The OS keychain can BLOCK for minutes: macOS shows a password prompt when
// the login keychain is locked (or, in dev, after every re-sign), Windows can
// stall on a locked vault. As sync commands these ran on the platform main
// thread, so one pending prompt froze the entire app — window never shown,
// even the force-show fallback deadlocked behind it (its is_visible()/show()
// dispatch to the same blocked thread). async + spawn_blocking keeps the UI
// alive; only the caller's own invoke waits.
//
// The lock preserves the serialization the main thread used to provide for
// free: the chunked write protocol (chunks first, marker last, sweep tail)
// assumes writes to one account never interleave.
#[cfg(any(target_os = "windows", target_os = "macos"))]
static KEYCHAIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn run_keychain<T: Send + 'static>(
    op: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _serialized = KEYCHAIN_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        op()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    check_account(&account)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || {
        // An empty value means "no key" — delete rather than store an empty
        // secret, so a cleared key never lingers in the vault.
        if value.is_empty() {
            return chunked::delete(&account);
        }
        chunked::set(&account, &value)
    })
    .await
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    check_account(&account)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || chunked::get(&account)).await
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    check_account(&account)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || chunked::delete(&account)).await
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_park_set(backend_id: String, value: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || {
        // Same "empty means delete" rule as secret_set: a cleared parked key
        // never lingers in the vault.
        if value.is_empty() {
            return chunked::delete(&account);
        }
        chunked::set(&account, &value)
    })
    .await
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_park_get(backend_id: String) -> Result<Option<String>, String> {
    let account = parked_account(&backend_id)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || chunked::get(&account)).await
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
pub async fn secret_park_delete(backend_id: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    run_keychain(move || chunked::delete(&account)).await
}

// ── The desktop key of the sealed remote channel ───────────────────────
//
// commands/remote_sealed.rs keeps one 32 byte secret here, from which the
// channel's X25519 and Ed25519 keys are derived (REMOTE-PROTOKOLL v2,
// section 3). The account is NOT in ALLOWED_ACCOUNTS on purpose: the webview
// can neither read nor overwrite it, only Rust code in this crate reaches it,
// through the two functions below. Both block (the keychain may prompt), so
// callers run them on a blocking thread.

/// Vault account of the remote channel key. Keep it stable: a new name would
/// mean a new desktop key and every paired phone pairing again.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const REMOTE_CHANNEL_ACCOUNT: &str = "remote-channel-key";

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) fn remote_channel_key_get() -> Result<Option<String>, String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    let _serialized = KEYCHAIN_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    chunked::get(REMOTE_CHANNEL_ACCOUNT)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) fn remote_channel_key_set(value: &str) -> Result<(), String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    let _serialized = KEYCHAIN_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    chunked::set(REMOTE_CHANNEL_ACCOUNT, value)
}

// ── Android and iOS ──────────────────────────────────────────────────────
// The same six commands, answered by the native layer (plugins/lu-native):
// the Android Keystore (an AES-GCM key that never leaves it, the values
// encrypted in a file only this app can read) and the iOS Keychain
// (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly). Until this existed a
// phone fell into the stub below and the Cloud session sat in the webview's
// localStorage. The plugin has no command of its own for this on purpose:
// these six, with their name checks, are the only way from JavaScript to a
// stored value.

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_set(app: tauri::AppHandle, account: String, value: String) -> Result<(), String> {
    check_account(&account)?;
    crate::commands::mobile_native::vault(app, move |v| {
        // An empty value means "no key", as on the desktop.
        if value.is_empty() {
            return v.secret_delete(&account);
        }
        v.secret_set(&account, &value)
    })
    .await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_get(app: tauri::AppHandle, account: String) -> Result<Option<String>, String> {
    check_account(&account)?;
    crate::commands::mobile_native::vault(app, move |v| v.secret_get(&account)).await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_delete(app: tauri::AppHandle, account: String) -> Result<(), String> {
    check_account(&account)?;
    crate::commands::mobile_native::vault(app, move |v| v.secret_delete(&account)).await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_park_set(app: tauri::AppHandle, backend_id: String, value: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    crate::commands::mobile_native::vault(app, move |v| {
        if value.is_empty() {
            return v.secret_delete(&account);
        }
        v.secret_set(&account, &value)
    })
    .await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_park_get(app: tauri::AppHandle, backend_id: String) -> Result<Option<String>, String> {
    let account = parked_account(&backend_id)?;
    crate::commands::mobile_native::vault(app, move |v| v.secret_get(&account)).await
}

#[cfg(mobile)]
#[tauri::command]
pub async fn secret_park_delete(app: tauri::AppHandle, backend_id: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    crate::commands::mobile_native::vault(app, move |v| v.secret_delete(&account)).await
}

// ── Linux desktop (GitHub #226) ─────────────────────────────────────────
// The Secret Service, or the 0600 file where none answers. One async lock
// serializes the operations, as KEYCHAIN_LOCK does on Windows and macOS: the
// file is read, changed and written back whole.

#[cfg(all(desktop, target_os = "linux"))]
static LINUX_VAULT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(all(desktop, target_os = "linux"))]
fn linux_vault() -> super::secret_linux::LinuxVault {
    super::secret_linux::LinuxVault::new(
        SERVICE,
        super::secret_file::FileStore::new(crate::os_paths::data_dir().join(super::secret_file::FILE_NAME)),
    )
}

#[cfg(all(desktop, target_os = "linux"))]
fn linux_disabled() -> Result<(), String> {
    if keychain_disabled() {
        return Err("keychain unavailable (LU_NO_KEYCHAIN test mode)".into());
    }
    Ok(())
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    check_account(&account)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().set(&account, &value).await.map(|_| ())
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    check_account(&account)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().get(&account).await
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    check_account(&account)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().delete(&account).await
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_park_set(backend_id: String, value: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().set(&account, &value).await.map(|_| ())
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_park_get(backend_id: String) -> Result<Option<String>, String> {
    let account = parked_account(&backend_id)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().get(&account).await
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_park_delete(backend_id: String) -> Result<(), String> {
    let account = parked_account(&backend_id)?;
    linux_disabled()?;
    let _serialized = LINUX_VAULT_LOCK.lock().await;
    linux_vault().delete(&account).await
}

// ── Where secrets go on this machine ────────────────────────────────────
// For the hint under the Hugging Face token field. `kind` is "os" (the
// platform's credential store), "file" (Linux without a Secret Service:
// `path` names the 0600 file) or "none" (no Rust-side store at all).

#[derive(serde::Serialize)]
pub struct SecretStoreInfo {
    kind: &'static str,
    path: Option<String>,
}

#[cfg(all(desktop, target_os = "linux"))]
#[tauri::command]
pub async fn secret_store_info() -> SecretStoreInfo {
    if keychain_disabled() {
        return SecretStoreInfo { kind: "none", path: None };
    }
    let vault = linux_vault();
    match vault.target().await {
        super::secret_linux::Where::Keyring => SecretStoreInfo { kind: "os", path: None },
        super::secret_linux::Where::File => SecretStoreInfo {
            kind: "file",
            path: Some(vault.file().path().display().to_string()),
        },
    }
}

#[cfg(not(all(desktop, target_os = "linux")))]
#[tauri::command]
pub async fn secret_store_info() -> SecretStoreInfo {
    let kind = if cfg!(any(mobile, target_os = "windows", target_os = "macos")) { "os" } else { "none" };
    SecretStoreInfo { kind, path: None }
}

// ── Other desktop systems ───────────────────────────────────────────────
// LU ships for none, the stub only keeps the crate building there. The
// frontend treats the error as "no keychain" and keeps its localStorage path.

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_set(account: String, _value: String) -> Result<(), String> {
    check_account(&account)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    check_account(&account)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    check_account(&account)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_park_set(backend_id: String, _value: String) -> Result<(), String> {
    parked_account(&backend_id)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_park_get(backend_id: String) -> Result<Option<String>, String> {
    parked_account(&backend_id)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos", target_os = "linux"))))]
#[tauri::command]
pub fn secret_park_delete(backend_id: String) -> Result<(), String> {
    parked_account(&backend_id)?;
    Err("keychain unsupported on this platform".into())
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::chunked::{parse_marker, split_units};

    #[test]
    fn short_value_stays_whole() {
        assert_eq!(split_units("abc", 1000), vec!["abc".to_string()]);
        assert!(split_units("", 1000).is_empty());
    }

    #[test]
    fn split_respects_utf16_budget_and_rejoins_losslessly() {
        // Multi-unit chars near the boundary must not be torn apart.
        let value = format!("{}é🦀 tail", "x".repeat(2500));
        let parts = split_units(&value, 1000);
        assert!(parts.len() >= 3);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= 1000));
        assert_eq!(parts.concat(), value);
    }

    #[test]
    fn marker_parses_and_plain_values_pass_through() {
        assert_eq!(parse_marker("__lu_chunks__:4"), Some(4));
        assert_eq!(parse_marker("__lu_chunks__:x"), None);
        assert_eq!(parse_marker("eyJhbGciOiJIUzI1NiJ9.payload.sig"), None);
    }
}

/// T-61 — the account allowlist. Compiled on every platform on purpose: the
/// commands take the same argument everywhere, so the rule that decides which
/// names reach the vault has to be under test everywhere too.
#[cfg(test)]
mod account_allowlist_tests {
    use super::*;

    /// Pull the value out of `… <needle>'value'`, the shape every one of these
    /// account constants has in the frontend.
    fn quoted_after(src: &str, needle: &str) -> String {
        let rest = src
            .split_once(needle)
            .unwrap_or_else(|| panic!("'{needle}' is gone from the frontend source"))
            .1;
        let rest = rest
            .split_once('\'')
            .unwrap_or_else(|| panic!("no opening quote after '{needle}'"))
            .1;
        rest.split_once('\'')
            .unwrap_or_else(|| panic!("no closing quote after '{needle}'"))
            .0
            .to_string()
    }

    #[test]
    fn every_account_the_app_uses_is_accepted() {
        for account in ALLOWED_ACCOUNTS {
            assert!(
                check_account(account).is_ok(),
                "'{account}' is in the allowlist but was refused"
            );
        }
    }

    /// The token of the phone as a Remote client has a place in the vault of
    /// a phone and none on the desktop: v3.0.5 refused the name, and the
    /// desktop has no caller that stores under it.
    #[test]
    fn the_remote_token_of_the_phone_is_a_phone_account_only() {
        for account in PHONE_ACCOUNTS {
            assert!(account_allowed(account, true), "{account} on a phone");
            assert!(!account_allowed(account, false), "{account} on the desktop");
            assert_eq!(check_account(account).is_ok(), cfg!(mobile), "{account} in this build");
            assert!(!ALLOWED_ACCOUNTS.contains(&account), "{account} is in both lists");
        }
        // The six of the desktop are the six of the phone.
        for account in ALLOWED_ACCOUNTS {
            assert!(account_allowed(account, true) && account_allowed(account, false), "{account}");
        }
        assert!(!account_allowed("anything-else", true));
    }

    #[test]
    fn a_foreign_account_is_refused_and_never_reaches_the_vault() {
        // The three names the finding is actually about: anything the caller
        // invents, plus a near-miss of a real one, plus the internal chunk
        // shape (built inside this module from an already-checked base — a
        // caller must not be able to address it directly).
        for account in [
            "evil",
            "",
            "lu-cloud-session-code-verifier-x",
            "LU-CLOUD-SESSION",
            "lu-cloud-session#0",
            "openai ",
        ] {
            let err = match check_account(account) {
                Ok(()) => panic!("'{account}' was accepted"),
                Err(e) => e,
            };
            assert!(err.starts_with("refused:"), "{err}");
        }
    }

    /// A refused NAME must not read as "there is no keychain here".
    ///
    /// `keychainMissing` in `src/api/cloud/supabase.ts` matches exactly these
    /// two substrings and latches the session onto obfuscated localStorage
    /// when it sees one. If the refusal said either of them, blocking a write
    /// would have DOWNGRADED the refresh token to disk — the opposite of what
    /// this check is for.
    #[test]
    fn the_refusal_is_not_a_keychain_availability_answer() {
        let err = check_account("evil").unwrap_err();
        assert!(!err.contains("keychain unavailable"), "{err}");
        assert!(!err.contains("keychain unsupported"), "{err}");
    }

    /// The allowlist is only worth having if it tracks the frontend. This
    /// re-derives every account from the files that call the commands, so
    /// adding a keychain account in TypeScript without adding it here is a red
    /// test rather than a broken feature on the next release.
    #[test]
    fn the_allowlist_covers_every_account_the_frontend_uses() {
        const PROVIDER_STORE: &str = include_str!("../../../src/stores/providerStore.ts");
        const MLX_IMAGE: &str = include_str!("../../../src/api/mlx-image.ts");
        const SUPABASE: &str = include_str!("../../../src/api/cloud/supabase.ts");
        const LU_NATIVE: &str = include_str!("../../../src/lib/lu-native.ts");

        let mut wanted: Vec<String> = Vec::new();

        // stores/providerStore.ts — the ids hydrateProviderKeys probes and
        // setProviderApiKey writes.
        let list = PROVIDER_STORE
            .split_once("const PROVIDER_IDS: ProviderId[] = [")
            .expect("PROVIDER_IDS is gone from providerStore.ts")
            .1
            .split_once(']')
            .expect("PROVIDER_IDS list is not closed")
            .0;
        for part in list.split(',') {
            if let Some(id) = part.trim().strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
                wanted.push(id.to_string());
            }
        }
        assert_eq!(wanted.len(), 3, "PROVIDER_IDS changed shape: {list}");

        // api/mlx-image.ts — the HuggingFace token.
        wanted.push(quoted_after(MLX_IMAGE, "HF_TOKEN_ACCOUNT ="));

        // api/cloud/supabase.ts — the session, plus the PKCE verifier that
        // supabase-js writes through the same adapter under
        // `${storageKey}-code-verifier` (keychainAccount preserves the suffix).
        let session = quoted_after(SUPABASE, "const SESSION_ACCOUNT =");
        assert!(
            SUPABASE.contains("-code-verifier"),
            "supabase.ts no longer mentions the PKCE verifier key — re-derive the suffix"
        );
        wanted.push(format!("{session}-code-verifier"));
        wanted.push(session);

        // lib/lu-native.ts: the token of the phone as a Remote client. Its
        // only callers live in the phone interface, so it is a phone account.
        wanted.push(quoted_after(LU_NATIVE, "const REMOTE_TOKEN_ACCOUNT ="));

        for account in &wanted {
            assert!(
                account_allowed(account.as_str(), true),
                "the frontend stores a secret under '{account}', which the allowlist refuses"
            );
        }
        // …and nothing sits in the allowlist that no caller uses. An account
        // nobody writes is an account nobody notices being read.
        for allowed in ALLOWED_ACCOUNTS.iter().chain(PHONE_ACCOUNTS.iter()) {
            assert!(
                wanted.iter().any(|w| w == allowed),
                "'{allowed}' is allowlisted but no frontend call site stores under it"
            );
        }
    }

    /// Every command body checks the name before it does anything else.
    /// Twenty-four value commands: the original three (account allowlist)
    /// plus the three R9 parked-key commands (backend-id pattern), each
    /// present once for Windows/macOS, once for the phones, once for Linux
    /// (GitHub #226) and once for the stub platforms. Plus the two
    /// `secret_store_info` variants, which take no name and touch no value.
    #[test]
    fn no_command_reaches_the_vault_without_the_check() {
        const SECRET_RS: &str = include_str!("secret.rs");
        // Needles are split so these lines do not match themselves: the file
        // being counted is this one.
        let commands = SECRET_RS.matches(concat!("#[tauri", "::command]")).count();
        let account_checks = SECRET_RS
            .matches(concat!("check_account", "(&account)?;"))
            .count();
        let parked_checks = SECRET_RS
            .matches(concat!("parked_account", "(&backend_id)?;"))
            .count();
        let info = SECRET_RS.matches(concat!("pub async fn secret_store", "_info()")).count();
        assert_eq!(info, 2, "secret_store_info changed, recount the checks");
        assert_eq!(commands - info, 24, "command count changed, recount the checks");
        assert_eq!(
            account_checks, 12,
            "a plain secret command runs without the account name check"
        );
        assert_eq!(
            parked_checks, 12,
            "a parked-key command runs without the backend-id check"
        );
    }
}

/// R9: the parked-key backend-id validation. Separate module from
/// `account_allowlist_tests` above: that one is about a fixed, enumerable
/// list; this one is about a pattern with no enumeration at all, so its
/// negative cases are different in kind (path characters, length, case),
/// not just different values.
#[cfg(test)]
mod parked_key_tests {
    use super::*;

    #[test]
    fn ordinary_backend_ids_are_accepted() {
        for id in ["lmstudio", "openai-compatible", "local-vllm", "a", "9-9-9"] {
            assert!(
                parked_account(id).is_ok(),
                "'{id}' should be a valid backend id"
            );
        }
    }

    #[test]
    fn the_account_string_carries_the_fixed_prefix_and_the_id_unchanged() {
        assert_eq!(
            parked_account("lmstudio").unwrap(),
            "parked-key:lmstudio"
        );
    }

    /// Negative control target: every one of these must be refused. Run with
    /// `is_valid_backend_id` temporarily patched to `!id.is_empty()` only
    /// (accepting almost everything) to confirm this test actually exercises
    /// the validation and is not vacuously green (see rust2.md for the
    /// genuinely-run negative control and the exact failures it produced).
    #[test]
    fn path_characters_are_rejected() {
        for id in [
            "../ollama",
            "a/b",
            "a\\b",
            "lmstudio/../openai",
            "C:\\lmstudio",
            "/etc/passwd",
        ] {
            assert!(
                parked_account(id).is_err(),
                "'{id}' contains a path character and must be refused"
            );
        }
    }

    #[test]
    fn the_empty_string_is_rejected() {
        assert!(parked_account("").is_err());
    }

    #[test]
    fn an_overlength_id_is_rejected() {
        let exactly_at_cap = "a".repeat(MAX_BACKEND_ID_LEN);
        assert!(
            parked_account(&exactly_at_cap).is_ok(),
            "the cap itself must still be accepted"
        );
        let one_over = "a".repeat(MAX_BACKEND_ID_LEN + 1);
        assert!(
            parked_account(&one_over).is_err(),
            "one character past the cap must be refused"
        );
    }

    /// A foreign prefix embedded in the id itself must not let a caller reach
    /// an unrelated vault entry by constructing the account string from the
    /// inside, trying to walk into ALLOWED_ACCOUNTS' namespace or the
    /// chunk-shape suffix by choosing an id that happens to contain them.
    #[test]
    fn ids_that_try_to_smuggle_another_namespace_are_rejected() {
        for id in [
            "ollama",       // valid pattern, but this test documents that a
            // plain ALLOWED_ACCOUNTS name is still accepted as a backend id:
            // it lands at "parked-key:ollama", never at the real "ollama"
            // account, so no collision is possible; kept here as a witness,
            // not a rejection case (checked explicitly right below).
            "parked-key:ollama",   // colon: rejected by the pattern
            "lmstudio#0",          // chunk-shape suffix: rejected
            "LMSTUDIO",            // uppercase: rejected
            "lm studio",           // whitespace: rejected
        ] {
            if id == "ollama" {
                assert!(parked_account(id).is_ok());
                assert_eq!(parked_account(id).unwrap(), "parked-key:ollama");
                assert_ne!(parked_account(id).unwrap(), "ollama");
                continue;
            }
            assert!(
                parked_account(id).is_err(),
                "'{id}' must be refused"
            );
        }
    }

    /// The refusal text must never echo a value that could be secret. The
    /// backend id itself is not the secret (the stored key is), but the
    /// error is still built from a fixed string plus the length only, never
    /// the id or any value passed alongside it.
    #[test]
    fn the_refusal_never_echoes_the_rejected_id() {
        let smuggled = "path/../../../etc/passwd";
        let err = parked_account(smuggled).unwrap_err();
        assert!(
            !err.contains(smuggled),
            "the refusal must not echo the rejected id back: {err}"
        );
    }
}
