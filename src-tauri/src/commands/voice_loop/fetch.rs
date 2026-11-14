//! Download one file, resumably, and do not keep it unless its sha256 matches.
//!
//! The bytes go to a `.download` twin next to the target. A run that is cut
//! short leaves the twin behind and the next run continues it with an HTTP
//! Range request. Only a file that has the announced size and the pinned
//! digest is renamed to its real name, so a file under its real name is
//! always a verified one. A digest mismatch deletes the twin: resuming a
//! corrupt file can never repair it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::commands::install::{digest_matches, sha256_file};
use crate::os_error;

use super::layout::twin;
use super::manifest::RemoteFile;

const ATTEMPTS: u32 = 4;

#[derive(Debug, PartialEq)]
pub enum FetchError {
    Cancelled,
    /// The transfer failed or ended early. The twin is kept, a retry resumes.
    Network(String),
    /// The server answered with an error status.
    Http(u16),
    /// Writing to disk failed.
    Disk(String),
    /// The finished file does not have the pinned digest. It was deleted.
    Checksum,
    /// The server sent more bytes than the manifest announces. Deleted.
    TooLarge,
}

impl FetchError {
    fn worth_a_retry(&self) -> bool {
        match self {
            FetchError::Network(_) => true,
            FetchError::Http(status) => *status == 408 || *status == 429 || *status >= 500,
            _ => false,
        }
    }

    /// The sentence the user reads. `what` names the file in plain words.
    pub fn user_message(&self, what: &str) -> String {
        match self {
            FetchError::Cancelled => "cancelled".to_string(),
            FetchError::Network(detail) => format!(
                "The download of {what} was interrupted ({detail}). Check your internet connection and run the setup again, it continues where it stopped."
            ),
            FetchError::Http(status) => format!(
                "The download server refused {what} (HTTP {status}). Try the setup again later."
            ),
            FetchError::Disk(detail) => format!(
                "{what} could not be written to disk: {detail}. Check the free space and the folder permissions, then run the setup again."
            ),
            FetchError::Checksum => format!(
                "The download of {what} did not match its checksum and was deleted. Run the setup again to fetch it once more. If it keeps happening, a proxy or security program is changing the download."
            ),
            FetchError::TooLarge => format!(
                "The download of {what} was larger than expected and was deleted. Run the setup again. If it keeps happening, a proxy or security program is changing the download."
            ),
        }
    }
}

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent_for(crate::app_identity::APP_VERSION))
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(30))
        // Bounds a stalled transfer and not the size of the file.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("The download client could not be created: {}.", os_error::english(&e)))
}

/// Is `dest` already the verified file?
pub fn is_verified(dest: &Path, remote: &RemoteFile) -> bool {
    let size_ok = std::fs::metadata(dest).map(|m| m.is_file() && m.len() == remote.size).unwrap_or(false);
    size_ok && sha256_file(dest).map(|actual| digest_matches(&remote.sha256, &actual)).unwrap_or(false)
}

fn disk(e: &std::io::Error) -> FetchError {
    FetchError::Disk(os_error::io_english(e))
}

fn remove_if_present(path: &Path) -> Result<(), FetchError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(disk(&e)),
    }
}

/// `bytes 100-199/200` starts at 100.
fn content_range_start(value: &str) -> Option<u64> {
    value.trim().strip_prefix("bytes ")?.split('-').next()?.trim().parse().ok()
}

/// Fetch `remote` to `dest`, resuming a twin from an earlier run, with a few
/// attempts for failures that a second try can fix.
///
/// `on_progress` receives the bytes of this file that are on disk.
pub async fn fetch_verified(
    client: &reqwest::Client,
    remote: &RemoteFile,
    dest: &Path,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    fetch_verified_as(client, remote, dest, None, cancel, on_progress).await
}

/// `fetch_verified` with a Hugging Face token, for a gated repository. The
/// token goes out only to `huggingface.co` itself; reqwest drops the header
/// when the hub redirects to its storage host.
pub async fn fetch_verified_as(
    client: &reqwest::Client,
    remote: &RemoteFile,
    dest: &Path,
    hub_token: Option<&str>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    let bearer = hub_token.filter(|_| crate::commands::download::is_huggingface_host(&remote.url));
    let mut wait = Duration::from_secs(2);
    let mut attempt = 1;
    loop {
        match fetch_once(client, remote, dest, bearer, cancel, on_progress).await {
            Err(e) if e.worth_a_retry() && attempt < ATTEMPTS => {
                tracing::warn!(attempt, "voice loop download attempt failed, retrying: {e:?}");
                let mut waited = Duration::ZERO;
                while waited < wait {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(FetchError::Cancelled);
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    waited += Duration::from_millis(100);
                }
                wait *= 3;
                attempt += 1;
            }
            other => return other,
        }
    }
}

async fn fetch_once(
    client: &reqwest::Client,
    remote: &RemoteFile,
    dest: &Path,
    bearer: Option<&str>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(FetchError::Cancelled);
    }
    if is_verified(dest, remote) {
        on_progress(remote.size);
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| disk(&e))?;
    }
    // A file under the real name that is not the verified one is a leftover
    // of something else. It must not survive next to a fresh download.
    remove_if_present(dest)?;

    let partial = twin(dest);
    let mut have = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    if have > remote.size {
        remove_if_present(&partial)?;
        have = 0;
    }

    if have < remote.size {
        let mut request = client.get(&remote.url);
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let response = request.send().await.map_err(|e| FetchError::Network(network_text(&e)))?;
        let status = response.status();

        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // The twin does not fit what the server has. Start over.
            remove_if_present(&partial)?;
            return Err(FetchError::Network("the server could not continue the partial file".to_string()));
        }
        if !status.is_success() {
            return Err(FetchError::Http(status.as_u16()));
        }

        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT
            && response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(content_range_start)
                == Some(have);
        if have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT && !resumed {
            // A range that does not start where the twin ends would be
            // appended at the wrong place.
            remove_if_present(&partial)?;
            return Err(FetchError::Network("the server continued at the wrong position".to_string()));
        }
        if !resumed {
            // A 200 carries the whole body, whatever was asked for.
            have = 0;
        }

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&partial)
            .await
            .map_err(|e| disk(&e))?;
        on_progress(have);

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                let _ = file.flush().await;
                return Err(FetchError::Cancelled);
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let _ = file.flush().await;
                    return Err(FetchError::Network(network_text(&e)));
                }
            };
            have += chunk.len() as u64;
            if have > remote.size {
                drop(file);
                remove_if_present(&partial)?;
                return Err(FetchError::TooLarge);
            }
            file.write_all(&chunk).await.map_err(|e| disk(&e))?;
            on_progress(have);
        }
        file.flush().await.map_err(|e| disk(&e))?;
        file.sync_all().await.map_err(|e| disk(&e))?;
        drop(file);

        if have < remote.size {
            return Err(FetchError::Network(format!(
                "the connection closed after {have} of {} bytes",
                remote.size
            )));
        }
    }

    let actual = sha256_file(&partial).map_err(FetchError::Disk)?;
    if !digest_matches(&remote.sha256, &actual) {
        remove_if_present(&partial)?;
        return Err(FetchError::Checksum);
    }
    std::fs::rename(&partial, dest).map_err(|e| disk(&e))?;
    on_progress(remote.size);
    Ok(())
}

/// A transport error without the URL. The address of a model file is not a
/// secret, but a redirect target can carry a signed query string.
fn network_text(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the connection timed out".to_string()
    } else if e.is_connect() {
        "the server could not be reached".to_string()
    } else if e.is_body() || e.is_decode() {
        "the transfer broke off".to_string()
    } else {
        "the request failed".to_string()
    }
}

#[cfg(test)]
pub(crate) mod test_server {
    //! A loopback file server for the download tests: Range support that can
    //! be switched off, a body that can be cut short, and a request log.

    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{header, HeaderMap, Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    #[derive(Clone, Default)]
    pub struct Behaviour {
        /// Answer a Range request with the whole body and a 200.
        pub ignore_range: bool,
        /// Send only this many bytes of the body for the first request, then
        /// close the connection.
        pub cut_first_response_at: Option<usize>,
        pub status: Option<u16>,
    }

    #[derive(Clone)]
    struct Served {
        body: Arc<Vec<u8>>,
        behaviour: Arc<Mutex<Behaviour>>,
        ranges: Arc<Mutex<Vec<Option<String>>>>,
    }

    pub struct TestServer {
        pub url: String,
        pub behaviour: Arc<Mutex<Behaviour>>,
        /// The Range header of every request, in order.
        pub ranges: Arc<Mutex<Vec<Option<String>>>>,
    }

    async fn serve(State(s): State<Served>, headers: HeaderMap) -> Response<Body> {
        let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let request_no = {
            let mut log = s.ranges.lock().unwrap();
            log.push(range.clone());
            log.len()
        };
        let behaviour = s.behaviour.lock().unwrap().clone();
        if let Some(status) = behaviour.status {
            return Response::builder().status(status).body(Body::empty()).unwrap();
        }
        let total = s.body.len();
        let start = range
            .as_deref()
            .filter(|_| !behaviour.ignore_range)
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.split('-').next())
            .and_then(|n| n.parse::<usize>().ok());
        let (status, from) = match start {
            Some(n) if n >= total => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Body::empty())
                    .unwrap();
            }
            Some(n) => (StatusCode::PARTIAL_CONTENT, n),
            None => (StatusCode::OK, 0),
        };
        let mut body = s.body[from..].to_vec();
        let mut builder = Response::builder().status(status).header(header::CONTENT_LENGTH, body.len());
        if status == StatusCode::PARTIAL_CONTENT {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes {from}-{}/{total}", total - 1));
        }
        if let (Some(cut), 1) = (behaviour.cut_first_response_at, request_no) {
            // Content-Length promises the whole body, the stream ends early:
            // the client sees a broken transfer.
            body.truncate(cut);
            // The pause lets the first part reach the client before the
            // connection is torn down.
            use futures_util::StreamExt;
            let stream = futures_util::stream::iter(vec![
                Ok::<_, std::io::Error>(axum::body::Bytes::from(body)),
                Err(std::io::Error::other("cut")),
            ])
            .then(|part| async move {
                if part.is_err() {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
                part
            });
            return builder.body(Body::from_stream(stream)).unwrap();
        }
        builder.body(Body::from(body)).unwrap()
    }

    pub async fn start(body: Vec<u8>) -> TestServer {
        let behaviour = Arc::new(Mutex::new(Behaviour::default()));
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let served = Served { body: Arc::new(body), behaviour: behaviour.clone(), ranges: ranges.clone() };
        let app = Router::new().route("/file", get(serve)).with_state(served);
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        TestServer { url: format!("http://{addr}/file"), behaviour, ranges }
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::start;
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn remote(url: &str, bytes: &[u8]) -> RemoteFile {
        RemoteFile { url: url.to_string(), size: bytes.len() as u64, sha256: sha(bytes) }
    }

    async fn run(remote: &RemoteFile, dest: &Path) -> (Result<(), FetchError>, Vec<u64>) {
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let result = fetch_once(&http_client().unwrap(), remote, dest, None, &cancel, &mut |n| seen.push(n)).await;
        (result, seen)
    }

    #[tokio::test]
    async fn a_fresh_download_is_verified_and_leaves_no_twin() {
        let data = body(300_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("deep").join("model.bin");
        let (result, seen) = run(&remote(&server.url, &data), &dest).await;
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(!twin(&dest).exists());
        assert_eq!(seen.last(), Some(&300_000));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress went backwards");
        assert_eq!(*server.ranges.lock().unwrap(), vec![None]);
    }

    #[tokio::test]
    async fn a_partial_file_is_continued_with_a_range_request() {
        let data = body(200_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(twin(&dest), &data[..120_000]).unwrap();
        let (result, seen) = run(&remote(&server.url, &data), &dest).await;
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(*server.ranges.lock().unwrap(), vec![Some("bytes=120000-".to_string())]);
        assert_eq!(seen.first(), Some(&120_000), "progress must start at the resumed offset");
    }

    #[tokio::test]
    async fn a_server_without_range_support_restarts_the_file() {
        let data = body(150_000);
        let server = start(data.clone()).await;
        server.behaviour.lock().unwrap().ignore_range = true;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        // Garbage in the twin: appending the full body to it would corrupt it.
        std::fs::write(twin(&dest), vec![0xEE; 70_000]).unwrap();
        let (result, _) = run(&remote(&server.url, &data), &dest).await;
        result.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn a_complete_twin_is_verified_without_a_request() {
        let data = body(50_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(twin(&dest), &data).unwrap();
        run(&remote(&server.url, &data), &dest).await.0.unwrap();
        assert!(dest.exists() && !twin(&dest).exists());
        assert!(server.ranges.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_verified_file_is_left_alone() {
        let data = body(50_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(&dest, &data).unwrap();
        run(&remote(&server.url, &data), &dest).await.0.unwrap();
        assert!(server.ranges.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_wrong_checksum_deletes_the_file_and_says_so() {
        let data = body(80_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        let mut wrong = remote(&server.url, &data);
        wrong.sha256 = sha(b"something else");
        let (result, _) = run(&wrong, &dest).await;
        assert_eq!(result, Err(FetchError::Checksum));
        assert!(!dest.exists(), "an unverified file must never get its real name");
        assert!(!twin(&dest).exists(), "a corrupt twin must not be resumed");
        let text = FetchError::Checksum.user_message("the speech model");
        assert!(text.contains("checksum") && text.contains("deleted") && text.contains("the speech model"), "{text}");
    }

    #[tokio::test]
    async fn a_corrupt_twin_of_the_right_size_is_deleted() {
        let data = body(60_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(twin(&dest), vec![7u8; 60_000]).unwrap();
        let (result, _) = run(&remote(&server.url, &data), &dest).await;
        assert_eq!(result, Err(FetchError::Checksum));
        assert!(!twin(&dest).exists() && !dest.exists());
        // The next run starts clean and succeeds.
        run(&remote(&server.url, &data), &dest).await.0.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn an_unverified_file_under_the_real_name_is_replaced() {
        let data = body(40_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(&dest, vec![1u8; 40_000]).unwrap();
        run(&remote(&server.url, &data), &dest).await.0.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn a_body_larger_than_announced_is_refused_and_deleted() {
        let data = body(90_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        let mut small = remote(&server.url, &data);
        small.size = 10_000;
        let (result, _) = run(&small, &dest).await;
        assert_eq!(result, Err(FetchError::TooLarge));
        assert!(!twin(&dest).exists() && !dest.exists());
    }

    #[tokio::test]
    async fn a_broken_transfer_keeps_the_twin_and_the_retry_finishes_it() {
        let data = body(400_000);
        let server = start(data.clone()).await;
        server.behaviour.lock().unwrap().cut_first_response_at = Some(150_000);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        let cancel = AtomicBool::new(false);
        let spec = remote(&server.url, &data);
        fetch_verified(&http_client().unwrap(), &spec, &dest, &cancel, &mut |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        let ranges = server.ranges.lock().unwrap().clone();
        assert_eq!(ranges.len(), 2, "{ranges:?}");
        assert_eq!(ranges[0], None);
        assert!(ranges[1].as_deref().is_some_and(|r| r.starts_with("bytes=") && r != "bytes=0-"), "{ranges:?}");
    }

    #[tokio::test]
    async fn a_refused_download_reports_the_status_and_is_not_retried() {
        let data = body(1_000);
        let server = start(data.clone()).await;
        server.behaviour.lock().unwrap().status = Some(404);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        let cancel = AtomicBool::new(false);
        let spec = remote(&server.url, &data);
        let result = fetch_verified(&http_client().unwrap(), &spec, &dest, &cancel, &mut |_| {}).await;
        assert_eq!(result, Err(FetchError::Http(404)));
        assert_eq!(server.ranges.lock().unwrap().len(), 1);
        assert!(FetchError::Http(404).user_message("the voice").contains("HTTP 404"));
    }

    #[tokio::test]
    async fn a_cancelled_download_stops_and_keeps_what_it_has() {
        let data = body(100_000);
        let server = start(data.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.bin");
        std::fs::write(twin(&dest), &data[..10_000]).unwrap();
        let cancel = AtomicBool::new(true);
        let spec = remote(&server.url, &data);
        let result = fetch_verified(&http_client().unwrap(), &spec, &dest, &cancel, &mut |_| {}).await;
        assert_eq!(result, Err(FetchError::Cancelled));
        assert_eq!(std::fs::metadata(twin(&dest)).unwrap().len(), 10_000);
    }

    #[test]
    fn the_resume_position_is_read_from_content_range() {
        assert_eq!(content_range_start("bytes 100-199/200"), Some(100));
        assert_eq!(content_range_start("bytes 0-0/1"), Some(0));
        assert_eq!(content_range_start("bytes */200"), None);
        assert_eq!(content_range_start("items 1-2/3"), None);
    }

    #[test]
    fn only_failures_a_second_try_can_fix_are_retried() {
        assert!(FetchError::Network("x".into()).worth_a_retry());
        assert!(FetchError::Http(503).worth_a_retry());
        assert!(FetchError::Http(429).worth_a_retry());
        assert!(!FetchError::Http(404).worth_a_retry());
        assert!(!FetchError::Checksum.worth_a_retry());
        assert!(!FetchError::Cancelled.worth_a_retry());
        assert!(!FetchError::Disk("x".into()).worth_a_retry());
    }
}
