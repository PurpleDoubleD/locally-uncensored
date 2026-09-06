//! Eine Datei holen — und prüfen, bevor sie ausgeführt wird.
//!
//! Der geteilte Zustand ist die heruntergeladene Datei selbst. Sie entsteht in
//! `download_file_blocking` und wird in `verify_downloaded_installer` wieder
//! aufgemacht: Größe, angehefteter Prüfwert, Authenticode-Signatur. Beide
//! Hälften an einem Ort zu halten ist der ganze Punkt dieser Naht — der
//! Fehler, den sie verhindert, entsteht genau dazwischen. Ein Portal-Login
//! oder eine abgeschnittene Uebertragung kommt als HTTP 200 an, wird
//! klaglos auf die Platte geschrieben und danach mit `/S` gestartet.
//!
//! Die Regeln sind absichtlich einzeln und rein: `installer_size_verdict` ist
//! der generische Boden, `installer_exact_size_verdict` die scharfe Regel für
//! eine unveränderliche URL, `parse_authenticode_status` die Abbildung der
//! Windows-Statusnamen. So bleibt jede von ihnen auf einem Mac prüfbar,
//! obwohl nur Windows eine Signatur zu lesen hat.
//!
//! Welche Prüfwerte für welches Produkt gelten, steht NICHT hier, sondern
//! beim jeweiligen Installer — die Zahl und die URL, aus der sie gemessen
//! wurde, müssen zusammen wandern.

use std::fs;
use std::io::Read as IoRead;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tracing::info;

use crate::os_error;
use crate::state::InstallState;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Shared helper: download a file with progress tracking ────────────────────

pub(super) fn download_file_blocking(
    url: &str,
    dest: &PathBuf,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("LocallyUncensored/2.3")
        .redirect(reqwest::redirect::Policy::limited(10))
        // This path pulls installers and archives (hundreds of MB), so the
        // whole-request deadline still fits. The blocking client has no
        // read_timeout; the model downloader, which handles the 40 GB+ files,
        // uses the async client and bounds the stall instead of the size.
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| format!("HTTP client error: {}", os_error::english(&e)))?;

    let response = client.get(url).send().map_err(|e| format!("Request failed: {}", os_error::english(&e)))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    if let Ok(mut s) = install_state.lock() {
        s.download_total = total;
        s.status = "downloading".to_string();
    }

    let mut file = fs::File::create(dest).map_err(|e| format!("Create file: {}", os_error::english(&e)))?;
    let mut reader = std::io::BufReader::new(response);
    let mut downloaded: u64 = 0;
    let start = Instant::now();
    let mut last_update = Instant::now();
    let mut buf = [0u8; 65536]; // 64KB chunks

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Read error: {}", os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n])
            .map_err(|e| format!("Write: {}", os_error::english(&e)))?;
        downloaded += n as u64;

        if last_update.elapsed().as_millis() > 500 {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
            if let Ok(mut s) = install_state.lock() {
                s.download_progress = downloaded;
                s.download_speed = speed;
            }
            last_update = Instant::now();
        }
    }

    // Final update
    if let Ok(mut s) = install_state.lock() {
        s.download_progress = downloaded;
        s.download_total = downloaded; // in case Content-Length was missing
        s.download_speed = 0.0;
    }

    Ok(())
}

// ── OI-8: nothing we downloaded gets executed unverified ────────────────────

/// Smallest plausible size for a Windows installer LU downloads. Anything
/// under it is not an installer: it is an error page, a captive-portal login,
/// or a truncated transfer — and `download_file_blocking` writes all three to
/// disk without complaint, because all three arrive as HTTP 200.
pub(super) const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// Hex SHA-256 of a file, streamed in chunks — a 570 MB installer must not
/// need 570 MB of memory to be checked.
pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Could not open {} to hash it: {}", path.display(), os_error::english(&e)))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Could not read {} while hashing: {}", path.display(), os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Digest comparison that tolerates the shapes people paste: upper or lower
/// case, and `certutil`'s space-separated groups.
pub(crate) fn digest_matches(expected: &str, actual: &str) -> bool {
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(|c| c.to_lowercase())
            .collect()
    };
    let (e, a) = (norm(expected), norm(actual));
    !e.is_empty() && e == a
}

/// What `Get-AuthenticodeSignature` said about a file.
///
/// Compiled everywhere so the status mapping stays under test on the machines
/// LU is developed on; only Windows has a signature to read.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum SignatureVerdict {
    /// Signed by a trusted publisher and the file matches its signature.
    Valid,
    /// Signed, but the signature does not hold — tampered, or the publisher
    /// is not trusted on this machine.
    Invalid,
    /// No signature at all.
    Unsigned,
    /// The check itself did not produce an answer we can read.
    Unknown,
}

/// Read the `.Status` line PowerShell prints for a signature check.
///
/// Kept separate from the process spawn so the mapping is testable on a Mac,
/// where `Get-AuthenticodeSignature` does not exist. The status names come
/// from `System.Management.Automation.SignatureStatus`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_authenticode_status(stdout: &str) -> SignatureVerdict {
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase();
    match line.as_str() {
        "valid" => SignatureVerdict::Valid,
        "notsigned" => SignatureVerdict::Unsigned,
        "hashmismatch" | "nottrusted" | "unknownerror" | "notsupportedfileformat"
        | "incompatible" => SignatureVerdict::Invalid,
        _ => SignatureVerdict::Unknown,
    }
}

/// Is this file big enough to be an installer at all?
///
/// Pulled out as its own rule because it is the check that catches the case
/// nobody thinks about: a proxy or captive portal answering the download with
/// a 2 KB HTML login page, saved as `OllamaSetup.exe` and then executed.
pub(crate) fn installer_size_verdict(bytes: u64) -> Result<(), String> {
    if bytes >= MIN_INSTALLER_BYTES {
        return Ok(());
    }
    Err(format!(
        "The downloaded installer is only {} bytes, far too small to be one — the \
         download was probably intercepted by a proxy or captive portal, or cut short. \
         LU will not run it. Download the installer yourself from the vendor's site \
         instead.",
        bytes
    ))
}

/// Ask Windows whether an executable's Authenticode signature is valid.
///
/// Windows PowerShell 5.1 ships with every Windows 10/11, so the check is
/// always available on the only platform that runs these installers. A file
/// that is not `Valid` is not executed: the point of the check is that LU
/// refuses, not that it warns and proceeds anyway.
#[cfg(target_os = "windows")]
fn authenticode_verdict(path: &Path) -> SignatureVerdict {
    // -LiteralPath so a path with brackets is not read as a wildcard; single
    // quotes doubled so a quote in the path cannot end the string early.
    let escaped = path.to_string_lossy().replace('\'', "''");
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-AuthenticodeSignature -LiteralPath '{escaped}').Status"),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            parse_authenticode_status(&String::from_utf8_lossy(&o.stdout))
        }
        _ => SignatureVerdict::Unknown,
    }
}

/// Is this file exactly the size the immutable URL is known to serve?
///
/// Only ever called for a URL whose bytes are supposed to never change. A
/// mismatch means one of two things and both are refusals: the transfer was
/// cut short / rewritten, or the vendor replaced a file LU treats as fixed.
pub(crate) fn installer_exact_size_verdict(expected: u64, actual: u64, label: &str) -> Result<(), String> {
    if expected == actual {
        return Ok(());
    }
    Err(format!(
        "The downloaded {label} installer is {actual} bytes; the version-pinned \
         download URL is known to serve exactly {expected}. Either the transfer \
         was altered or cut short, or the vendor replaced a file at a URL that \
         is supposed to be immutable. LU will not run it — install {label} from \
         the vendor's own site instead."
    ))
}

/// Everything that has to be true before LU executes a file it downloaded:
/// it is big enough to be an installer, it is exactly the size an immutable
/// URL is known to serve (when there is one), it matches its pinned digest if
/// one exists, and on Windows it carries a valid Authenticode signature.
///
/// `label` names the product in the error text — the user has to know which
/// download to fetch by hand when LU refuses.
pub(super) fn verify_downloaded_installer(
    path: &Path,
    expected_sha256: Option<&str>,
    expected_bytes: Option<u64>,
    label: &str,
) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("Could not stat the downloaded {label} installer: {}", os_error::english(&e)))?
        .len();
    installer_size_verdict(size)?;

    if let Some(expected) = expected_bytes {
        installer_exact_size_verdict(expected, size, label)?;
        info!(label, bytes = size, "installer matched its pinned size");
    }

    if let Some(pin) = expected_sha256 {
        let actual = sha256_file(path)?;
        if !digest_matches(pin, &actual) {
            return Err(format!(
                "The downloaded {label} installer does not match its pinned SHA-256, so LU \
                 will not run it.\nexpected: {pin}\ngot:      {actual}\nDownload {label} \
                 from the vendor's site by hand instead."
            ));
        }
        info!(label, "installer matched its pinned sha-256");
    }

    #[cfg(target_os = "windows")]
    {
        match authenticode_verdict(path) {
            SignatureVerdict::Valid => {}
            verdict => {
                return Err(format!(
                    "The downloaded {label} installer has no valid code signature \
                     ({verdict:?}), so LU will not run it. Download {label} from the \
                     vendor's own site and install it yourself."
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-8: nothing downloaded is executed unverified ───────────────────
    //
    // Runnable here: the digest, the comparison, the size rule and the
    // signature-status mapping. NOT runnable here: the Authenticode check
    // itself — `Get-AuthenticodeSignature` is Windows-only, and this was
    // written on macOS, so the spawn is verified by review only.

    #[test]
    fn sha256_matches_the_published_vector_for_abc() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("abc.bin");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_of_an_empty_file_is_the_known_empty_digest() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("empty.bin");
        std::fs::write(&f, b"").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_streams_a_file_larger_than_its_buffer() {
        // The buffer is 1 MiB; a 570 MB installer must not be read in one go,
        // so the chunk loop has to be right across a boundary.
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("big.bin");
        std::fs::write(&f, vec![0x5au8; (1 << 20) + 12345]).unwrap();
        let digest = sha256_file(&f).unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sha256_of_a_missing_file_is_an_error_not_a_panic() {
        assert!(sha256_file(Path::new("/definitely/not/here.exe")).is_err());
    }

    #[test]
    fn digests_compare_across_the_shapes_people_paste() {
        let lower = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(digest_matches(lower, lower));
        assert!(digest_matches(&lower.to_uppercase(), lower));
        // certutil prints space-separated groups.
        assert!(digest_matches("ba78 16bf 8f01 cfea", "ba7816bf8f01cfea"));
        // Negative controls: a different digest, and an empty pin, which must
        // never read as "matches everything".
        assert!(!digest_matches(lower, &lower.replace("ba78", "ba79")));
        assert!(!digest_matches("", lower));
        assert!(!digest_matches("   ", lower));
    }

    #[test]
    fn a_captive_portal_login_page_is_not_an_installer() {
        // The case the size rule exists for: HTTP 200, 2 KB of HTML, saved as
        // OllamaSetup.exe and then executed.
        let err = installer_size_verdict(2_048).unwrap_err();
        assert!(err.contains("2048"), "{err}");
        assert!(err.to_lowercase().contains("will not run it"), "{err}");
        assert!(installer_size_verdict(0).is_err());
        // A real installer passes.
        assert!(installer_size_verdict(570_000_000).is_ok());
        assert!(installer_size_verdict(MIN_INSTALLER_BYTES).is_ok());
    }

    #[test]
    fn only_a_valid_authenticode_status_reads_as_valid() {
        assert_eq!(parse_authenticode_status("Valid\n"), SignatureVerdict::Valid);
        assert_eq!(parse_authenticode_status("  valid  "), SignatureVerdict::Valid);
        assert_eq!(parse_authenticode_status("NotSigned"), SignatureVerdict::Unsigned);
        for bad in ["HashMismatch", "NotTrusted", "UnknownError", "NotSupportedFileFormat"] {
            assert_eq!(
                parse_authenticode_status(bad),
                SignatureVerdict::Invalid,
                "{bad} must not pass"
            );
        }
        // Anything unreadable is Unknown, and Unknown is not Valid — the
        // caller refuses on everything that is not Valid.
        assert_eq!(parse_authenticode_status(""), SignatureVerdict::Unknown);
        assert_eq!(parse_authenticode_status("\n\n"), SignatureVerdict::Unknown);
        assert_eq!(
            parse_authenticode_status("The term 'Get-AuthenticodeSignature' is not recognized"),
            SignatureVerdict::Unknown
        );
    }

    #[test]
    fn a_truncated_download_is_refused_before_it_is_executed() {
        // End to end over the parts that run off-Windows: a file that is too
        // small never gets as far as the digest or the signature.
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("Setup.exe");
        std::fs::write(&f, b"<html>captive portal</html>").unwrap();
        let err = verify_downloaded_installer(&f, None, None, "LM Studio").unwrap_err();
        assert!(err.to_lowercase().contains("too small"), "{err}");
    }

    #[test]
    fn a_wrong_pinned_digest_refuses_and_shows_both_hashes() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("Setup.exe");
        std::fs::write(&f, vec![0u8; MIN_INSTALLER_BYTES as usize + 1]).unwrap();
        let err = verify_downloaded_installer(&f, Some("deadbeef"), None, "LM Studio").unwrap_err();
        assert!(err.contains("deadbeef"), "{err}");
        assert!(err.contains("expected") && err.contains("got"), "{err}");
        assert!(err.contains("LM Studio"), "{err}");
    }

    #[test]
    fn the_exact_size_rule_passes_only_on_an_exact_match() {
        assert!(installer_exact_size_verdict(221_768_208, 221_768_208, "LM Studio").is_ok());
        assert!(installer_exact_size_verdict(221_768_208, 221_768_207, "LM Studio").is_err());
        assert!(installer_exact_size_verdict(221_768_208, 221_768_209, "LM Studio").is_err());
        assert!(installer_exact_size_verdict(221_768_208, 0, "LM Studio").is_err());
    }

}
