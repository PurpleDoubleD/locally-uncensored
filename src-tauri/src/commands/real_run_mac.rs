//! The real run on the Mac: the app's own commands against real engines and
//! real models, in the order the interface calls them.
//!
//! Every other test of the media lanes stops where a model would be loaded.
//! This one does not: it installs the engines, downloads packs of many
//! gigabytes into the app's own folders and generates with them. It is the
//! proof that the code the app runs produces an image and a video, for the
//! nights when nobody can click through the window.
//!
//! It runs only when asked for by name, with the variable set:
//!
//! ```sh
//! LU_REAL_RUN=1 cargo test real_run_mac::status -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Without both it reads as ignored, and `os_paths::test_storage::real_run`
//! keeps every other test in scratch storage.
//!
//! What it calls are the functions behind the Tauri commands
//! (`commands::mlx::*`, `commands::video::*`, `media_cmds::video_stage_start_image`),
//! with the argument object the interface builds (`src/api/mlx-image.ts`,
//! `src/api/mlx-video.ts`, the MLX branch of `src/hooks/useCreate.ts`).
//!
//! What it does NOT cover:
//!   - the wrappers in `media_cmds` (`off_main`, the blocking pool) and the
//!     way through IPC and the WebView,
//!   - everything the interface does before it calls: the stores, the tiles,
//!     the progress line, the gallery, the blob URL of a video,
//!   - the settings of the installed app: the Python the user picked and a
//!     Hugging Face token (both are read from scratch storage here, so the
//!     run takes the Python it finds and no token),
//!   - the two engine installs alone: the app has no command for them, they
//!     arrive with the first model. `engine_mflux` and `engine_ltx2` go
//!     through the same function on the same slot, one step below the command.
//!
//! The steps are steered by variables so that one binary serves every run:
//! `LU_REAL_MODEL`, `LU_REAL_PROMPT`, `LU_REAL_NEGATIVE`, `LU_REAL_LORAS` (`name:strength|...`), `LU_REAL_STEPS`,
//! `LU_REAL_GUIDANCE`, `LU_REAL_SEED`, `LU_REAL_WIDTH`, `LU_REAL_HEIGHT`, `LU_REAL_STALL_SECS`,
//! `LU_REAL_IMAGES` (paths, separated by `|`), `LU_REAL_MOTION` (the motion
//! video of a Motion Control run), `LU_REAL_RESOLUTION` (the side
//! an edit scales its images to), `LU_REAL_SECONDS`, `LU_REAL_AUDIO` (the voice
//! of a Talking Character run, which makes it the engine's `a2v`),
//! `LU_REAL_CANCEL_AFTER` (seconds into an install or a video),
//! `LU_REAL_CANCEL_AT_STEP` (an image), `LU_REAL_NAME` (the name the result is
//! kept under), `LU_REAL_OUT` (the folder for results and the record),
//! `LU_REAL_ANY_POWER` (`1`: do not wait for mains) and `LU_REAL_RUN_HOME`
//! (an absolute folder the run takes as the app's data, config and cache
//! folders, so the real app's folders on this Mac stay untouched; the 3D
//! runs use it, see `mesh_install`).

use super::{media_cmds, mesh3d, mlx, music, video, CmdResult};
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ── The switch ────────────────────────────────────────────────────────

/// Whether this is the real run. Says so when it is not, so an ignored test
/// that was started by hand does not pass in silence.
fn on() -> bool {
    if !crate::os_paths::test_storage::real_run() {
        eprintln!("real run skipped: set LU_REAL_RUN=1 and name real_run_mac as the only filter");
        return false;
    }
    let data = crate::os_paths::data_dir();
    match crate::os_paths::test_storage::real_run_home() {
        // `LU_REAL_RUN_HOME`: a test folder of its own, never the app's.
        Some(home) => assert!(
            data.starts_with(&home) && !data.to_string_lossy().contains("Library/Application Support"),
            "the real run is not looking at its own folder: {}",
            data.display()
        ),
        None => assert!(
            data.ends_with("Library/Application Support/lu-labs"),
            "the real run is not looking at the app's data folder: {}",
            data.display()
        ),
    }
    // What the app does at its start: the models an earlier build left in
    // the cache folder move to the data folder, unless something is at work
    // on them (a running app's download shows on its command line).
    static SETTLED: std::sync::Once = std::sync::Once::new();
    SETTLED.call_once(|| crate::media_store::settle(&|_| false));
    true
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn number<T: std::str::FromStr>(name: &str) -> Option<T> {
    var(name).and_then(|v| v.trim().parse().ok())
}

/// Never dropped: dropping an `AppState` sweeps the port of the image
/// sidecar, and on this Mac that can be the one of the running app.
fn state() -> &'static AppState {
    Box::leak(Box::new(AppState::new()))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime")
}

// ── The record ────────────────────────────────────────────────────────

fn out_dir() -> PathBuf {
    let dir = var("LU_REAL_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("lu-real-run"));
    std::fs::create_dir_all(&dir).expect("the folder for the results");
    dir
}

/// One line per finished step, appended, so a run that dies later has still
/// left what it measured.
fn record(step: &str, what: Value) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = json!({ "step": step, "at": stamp, "result": what });
    println!("\n=== {step} ===\n{}\n", serde_json::to_string_pretty(&line).unwrap());
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out_dir().join("echtlauf.jsonl"))
        .expect("the record of the real run");
    writeln!(file, "{line}").expect("write the record");
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

fn seconds(since: Instant) -> f64 {
    (since.elapsed().as_millis() as f64 / 100.0).round() / 10.0
}

fn shorten(line: &str) -> String {
    let line = line.trim();
    if line.chars().count() <= 220 {
        return line.to_string();
    }
    let head: String = line.chars().take(100).collect();
    let tail: String = line.chars().rev().take(110).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head} … {tail}")
}

// ── The limits of the night ───────────────────────────────────────────

fn shell(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Heavy work runs on mains power only. On battery this waits, and asks
/// again every five minutes.
fn on_mains() -> bool {
    any_power() || shell("pmset", &["-g", "batt"]).contains("AC Power")
}

/// `LU_REAL_ANY_POWER=1`: the owner has said to run on the battery too.
fn any_power() -> bool {
    var("LU_REAL_ANY_POWER").is_some_and(|v| v == "1")
}

fn wait_for_mains() {
    loop {
        if any_power() {
            return;
        }
        let battery = shell("pmset", &["-g", "batt"]);
        if battery.contains("AC Power") {
            return;
        }
        println!("on battery, waiting five minutes: {}", battery.lines().next().unwrap_or(""));
        std::thread::sleep(Duration::from_secs(300));
    }
}

/// Downloads go one after the other. While the image probe of another run
/// is loading models, a large download here waits.
fn wait_for_the_line() {
    loop {
        let other = shell("pgrep", &["-f", "probe_bild.py"]);
        if other.trim().is_empty() {
            return;
        }
        println!("another run is downloading (probe_bild.py, pid {}), waiting five minutes", other.trim().replace('\n', " "));
        std::thread::sleep(Duration::from_secs(300));
    }
}

fn free_disk_gb() -> f64 {
    crate::commands::system::volume_space_for(&crate::os_paths::data_dir())
        .map(|(free, _, _)| (free as f64 / 1e8).round() / 10.0)
        .unwrap_or(-1.0)
}

/// Memory the system counts as free, by its own word (`memory_pressure`).
/// `sysinfo` answered 0.0 here for whole runs while the kernel said a third
/// was free: it leaves out what macOS can take back at once.
fn available_memory_gb() -> f64 {
    let percent = shell("memory_pressure", &[])
        .lines()
        .find_map(|line| line.strip_prefix("System-wide memory free percentage:")?.trim().trim_end_matches('%').parse::<f64>().ok());
    match percent {
        Some(percent) => (crate::commands::system::total_memory_bytes() as f64 / 1_073_741_824.0 * percent / 10.0).round() / 10.0,
        None => -1.0,
    }
}

fn dir_gb(dir: &Path) -> f64 {
    (crate::install_state::dir_size(dir) as f64 / 1e7).round() / 100.0
}

// ── Processes ─────────────────────────────────────────────────────────

/// Every process below this test, as (pid, command line).
fn descendants() -> Vec<(u32, String)> {
    let listing = shell("ps", &["-axo", "pid=,ppid=,command="]);
    let rows: Vec<(u32, u32, String)> = listing
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let parent = parts.next()?.parse().ok()?;
            Some((pid, parent, parts.collect::<Vec<_>>().join(" ")))
        })
        .collect();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut frontier = vec![std::process::id()];
    while let Some(parent) = frontier.pop() {
        for (pid, of, command) in &rows {
            // `ps` itself is a child for the moment it runs.
            if *of == parent && !command.starts_with("ps ") {
                frontier.push(*pid);
                found.push((*pid, command.clone()));
            }
        }
    }
    found
}

fn alive(pid: u32) -> bool {
    // Signal 0 asks whether the process is there and sends nothing.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn rss_kb(pid: u32) -> u64 {
    shell("ps", &["-o", "rss=", "-p", &pid.to_string()]).trim().parse().unwrap_or(0)
}

/// What Activity Monitor calls "Memory": the footprint, which counts the
/// memory MLX holds on the GPU side. `ps` reports the resident set alone.
fn footprint_kb(pid: u32) -> u64 {
    shell("footprint", &["-p", &pid.to_string(), "-f", "bytes"])
        .lines()
        .find_map(|line| line.split("Footprint: ").nth(1)?.split_whitespace().next()?.parse::<u64>().ok())
        .map(|bytes| bytes / 1024)
        .unwrap_or(0)
}

struct Sampler {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<Value>,
}

impl Sampler {
    fn finish(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.join().unwrap_or(Value::Null)
    }
}

/// Watch the memory of the child that `find` names, twice a second, until
/// told to stop. The resident set every time, the footprint every fourth.
fn sample_memory(find: impl Fn() -> Option<u32> + Send + 'static) -> Sampler {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::spawn(move || {
        let (mut pid, mut peak_rss, mut peak_footprint, mut samples, mut least_available) = (None, 0u64, 0u64, 0u32, f64::MAX);
        while !flag.load(Ordering::SeqCst) {
            if pid.is_none() {
                pid = find();
            }
            if let Some(pid) = pid {
                if alive(pid) {
                    peak_rss = peak_rss.max(rss_kb(pid));
                    if samples % 4 == 0 {
                        peak_footprint = peak_footprint.max(footprint_kb(pid));
                        least_available = least_available.min(available_memory_gb());
                    }
                    samples += 1;
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let gb = |kb: u64| (kb as f64 / 1_048_576.0 * 100.0).round() / 100.0;
        json!({
            "pid": pid,
            "samples": samples,
            "peakRssGB": gb(peak_rss),
            "peakFootprintGB": gb(peak_footprint),
            "leastAvailableGB": if least_available == f64::MAX { Value::Null } else { json!(least_available) },
        })
    });
    Sampler { stop, thread }
}

// ── Status, as the Model Manager opens ────────────────────────────────

fn timed(call: impl FnOnce() -> CmdResult) -> (Value, f64) {
    let started = Instant::now();
    let answer = call().unwrap_or_else(|e| json!({ "ERROR": e }));
    (answer, (started.elapsed().as_micros() as f64 / 100.0).round() / 10.0)
}

fn models_of(list: &Value, family: Option<&str>) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|m| family.is_none_or(|f| m["family"] == f))
        .map(|m| json!({ "id": m["id"], "sizeGB": m["sizeGB"], "minRamGB": m["minRamGB"], "installed": m["installed"] }))
        .collect()
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn status() {
    if !on() {
        return;
    }
    let state = state();
    let none = json!({});
    let rt = runtime();
    let (mlx_status, a) = timed(|| rt.block_on(mlx::mlx_status(state, &none)));
    let (image_models, b) = timed(|| mlx::mlx_image_models(state, &none));
    let (video_status, c) = timed(|| video::video_status(state, &none));
    let (video_models, d) = timed(|| video::video_list_models(state, &none));
    record(
        "status",
        json!({
            "ms": { "mlx_status": a, "mlx_image_models": b, "video_status": c, "video_list_models": d },
            "mlx_status": mlx_status,
            "video_status": video_status,
            "mflux_models": models_of(&image_models, Some("mflux")),
            "image_models_installed": models_of(&image_models, None).into_iter().filter(|m| m["installed"] == true).collect::<Vec<_>>(),
            "ltx_2q_models": models_of(&video_models, Some("ltx_2q")),
            "video_models_installed": models_of(&video_models, None).into_iter().filter(|m| m["installed"] == true).collect::<Vec<_>>(),
            "install_slots": {
                "image_model": mlx::mlx_image_install_status(state, &none).unwrap()["status"],
                "image_engine": mlx::install_mlx_diffusion_status(state, &none).unwrap()["status"],
                "video_model": video::video_install_model_status(state, &none).unwrap()["status"],
                "video_engine": video::video_install_mlx_status(state, &none).unwrap()["status"],
            },
            "freeDiskGB": free_disk_gb(),
            "availableMemoryGB": available_memory_gb(),
        }),
    );
}

// ── Install ───────────────────────────────────────────────────────────

/// The three commands of a lane's install, and the folder its weights land in.
struct Lane {
    name: &'static str,
    install: fn(&AppState, &Value) -> CmdResult,
    status: fn(&AppState, &Value) -> CmdResult,
    cancel: fn(&AppState, &Value) -> CmdResult,
    weights: PathBuf,
}

fn image_lane() -> Lane {
    Lane {
        name: "image",
        install: mlx::mlx_image_install_model,
        status: mlx::mlx_image_install_status,
        cancel: mlx::mlx_image_cancel_install,
        weights: crate::media_store::active_root(crate::media_store::Store::Mflux),
    }
}

/// The music lane installs its engine and its weights on one slot.
fn music_lane() -> Lane {
    Lane {
        name: "music",
        install: music::music_install,
        status: music::music_install_status,
        cancel: music::music_cancel_install,
        weights: crate::os_paths::data_dir().join("acestep").join("checkpoints"),
    }
}

/// The 3D lane installs its engine, its source and its weights on one slot.
fn mesh_lane() -> Lane {
    Lane {
        name: "mesh3d",
        install: mesh3d::mesh3d_install,
        status: mesh3d::mesh3d_install_status,
        cancel: mesh3d::mesh3d_cancel_install,
        weights: crate::os_paths::data_dir().join("mesh3d").join("weights"),
    }
}

fn video_lane() -> Lane {
    Lane {
        name: "video",
        install: video::video_install_model,
        status: video::video_install_model_status,
        cancel: video::video_cancel_model_install,
        weights: video::models_root(),
    }
}

/// Poll a lane's install slot the way the interface does (every 1.2 s) until
/// it leaves "installing" or `until` says to stop. Prints what the slot says
/// as it changes, and returns the last answer with what was seen on the way.
fn follow_install(lane: &Lane, state: &AppState, started: Instant, until: Option<Duration>) -> (Value, Value) {
    let none = json!({});
    let (mut printed, mut last_note) = (0usize, Instant::now() - Duration::from_secs(60));
    let (mut first_bytes_at, mut first_bytes, mut top_speed) = (None::<f64>, 0u64, 0u64);
    let mut backwards = 0u32;
    let mut before = 0u64;
    loop {
        let snap = (lane.status)(state, &none).expect("the install status");
        let status = snap["status"].as_str().unwrap_or("").to_string();
        let logs = snap["logs"].as_array().cloned().unwrap_or_default();
        for line in logs.iter().skip(printed).filter_map(Value::as_str) {
            println!("[{:>7.1}s] log: {}", seconds(started), shorten(line));
        }
        printed = logs.len();
        let (done, total, speed) = (
            snap["download_progress"].as_u64().unwrap_or(0),
            snap["download_total"].as_u64().unwrap_or(0),
            snap["download_speed"].as_u64().unwrap_or(0),
        );
        if done > 0 && first_bytes_at.is_none() {
            first_bytes_at = Some(seconds(started));
            first_bytes = done;
        }
        if done < before {
            backwards += 1;
        }
        before = done;
        top_speed = top_speed.max(speed);
        if last_note.elapsed() > Duration::from_secs(30) {
            last_note = Instant::now();
            println!(
                "[{:>7.1}s] {status}: {:.2} of {:.2} GB, {:.1} MB/s, {} on disk",
                seconds(started),
                done as f64 / 1e9,
                total as f64 / 1e9,
                speed as f64 / 1e6,
                dir_gb(&lane.weights)
            );
        }
        let seen = json!({
            "firstBytesAtS": first_bytes_at,
            "firstBytesGB": (first_bytes as f64 / 1e7).round() / 100.0,
            "lastBytesGB": (done as f64 / 1e7).round() / 100.0,
            "totalGB": (total as f64 / 1e7).round() / 100.0,
            "topSpeedMBs": (top_speed as f64 / 1e5).round() / 10.0,
            "progressWentBackwards": backwards,
            "logLines": printed,
        });
        // A download does not run on battery. Seen here, the caller stops it
        // and starts it again once the Mac is back on mains.
        let on_battery = status == "installing" && last_note.elapsed() < Duration::from_secs(2) && !on_mains();
        if status != "installing" || on_battery || until.is_some_and(|limit| started.elapsed() >= limit) {
            return (snap, seen);
        }
        std::thread::sleep(Duration::from_millis(1200));
    }
}

/// Stop a running install and measure what the owner asked about: how fast
/// the command answers, how fast the slot is free, how fast the processes
/// are gone.
fn stop_install(lane: &Lane, state: &AppState) -> Value {
    let none = json!({});
    let children = descendants();
    let on_disk = dir_gb(&lane.weights);
    let started = Instant::now();
    let answer = (lane.cancel)(state, &none).unwrap_or_else(|e| json!({ "ERROR": e }));
    let answered = started.elapsed().as_micros() as f64 / 1000.0;
    let (mut slot_free, mut gone) = (None::<u64>, None::<u64>);
    while started.elapsed() < Duration::from_secs(90) && (slot_free.is_none() || gone.is_none()) {
        if slot_free.is_none() && (lane.status)(state, &none).unwrap()["status"] != "installing" {
            slot_free = Some(ms(started));
        }
        if gone.is_none() && children.iter().all(|(pid, _)| !alive(*pid)) {
            gone = Some(ms(started));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let after = (lane.status)(state, &none).unwrap();
    json!({
        "children": children.iter().map(|(pid, command)| format!("{pid} {}", shorten(command))).collect::<Vec<_>>(),
        "cancelAnswer": answer,
        "cancelAnsweredMs": answered,
        "slotFreeMs": slot_free,
        "processesGoneMs": gone,
        "survivors": children.iter().filter(|(pid, _)| alive(*pid)).map(|(pid, _)| *pid).collect::<Vec<_>>(),
        "slotAfter": { "status": after["status"], "error": after["error"], "lastLog": after["logs"].as_array().and_then(|l| l.last()).cloned() },
        "onDiskAtStopGB": on_disk,
    })
}

/// Get, as the tile does it: the install command, then the slot until it is
/// through. With `LU_REAL_CANCEL_AFTER` the download is stopped once on the
/// way and started again in the same process, where the slot and its stop
/// flag are the same objects, as in the app.
fn install_model(lane: Lane) {
    let id = var("LU_REAL_MODEL").expect("LU_REAL_MODEL names the model to install");
    let state = state();
    wait_for_mains();
    wait_for_the_line();
    let free_before = free_disk_gb();
    println!("installing {id}: {free_before} GB free, {} GB in {}", dir_gb(&lane.weights), lane.weights.display());

    let mut stopped = Value::Null;
    let mut first = Value::Null;
    let started = Instant::now();
    let answer = (lane.install)(state, &json!({ "id": id }));
    let answered = started.elapsed().as_micros() as f64 / 1000.0;
    println!("install answered after {answered} ms: {answer:?}");
    let answer = answer.unwrap_or_else(|e| json!({ "ERROR": e }));

    if let Some(after) = number::<u64>("LU_REAL_CANCEL_AFTER") {
        let (snap, seen) = follow_install(&lane, state, started, Some(Duration::from_secs(after)));
        if snap["status"] == "installing" {
            stopped = stop_install(&lane, state);
            println!("stopped: {stopped}");
            first = seen;
            // The second Get. The interface holds it back until the slot is free.
            wait_for_mains();
            let again = Instant::now();
            let second = (lane.install)(state, &json!({ "id": id }));
            stopped["secondInstallAnswer"] = json!(format!("{second:?}"));
            stopped["secondInstallAnsweredMs"] = json!(again.elapsed().as_micros() as f64 / 1000.0);
        } else {
            println!("the install was through before the stop was due");
        }
    }
    let resumed = Instant::now();
    let mut battery_stops: Vec<Value> = Vec::new();
    let (snap, seen) = loop {
        let (snap, seen) = follow_install(&lane, state, resumed, None);
        if snap["status"] != "installing" {
            break (snap, seen);
        }
        println!("the Mac went to battery, stopping the download");
        let mut stop = stop_install(&lane, state);
        stop["seenBeforeStop"] = seen;
        wait_for_mains();
        stop["secondInstallAnswer"] = json!(format!("{:?}", (lane.install)(state, &json!({ "id": id }))));
        battery_stops.push(stop);
    };
    record(
        &format!("install {} {id}", lane.name),
        json!({
            "installAnswer": answer,
            "installAnsweredMs": answered,
            "status": snap["status"],
            "error": snap["error"],
            "lastLogs": snap["logs"].as_array().map(|l| l.iter().rev().take(6).rev().cloned().collect::<Vec<_>>()),
            "totalSeconds": seconds(started),
            "beforeStop": first,
            "stop": stopped,
            "afterStopOrWhole": seen,
            "stoppedOnBattery": battery_stops,
            "freeDiskBeforeGB": free_before,
            "freeDiskAfterGB": free_disk_gb(),
            "weightsFolderGB": dir_gb(&lane.weights),
        }),
    );
    assert_eq!(snap["status"], "complete", "the install did not complete: {}", snap["error"]);
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn install_image_model() {
    if on() {
        install_model(image_lane());
    }
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn install_video_model() {
    if on() {
        install_model(video_lane());
    }
}

/// An engine alone, on the slot of its lane. `claim` is the door one step
/// below the model install.
fn install_engine(lane: Lane, what: &str, claim: fn(&AppState) -> bool, venv: PathBuf) {
    let state = state();
    wait_for_mains();
    let free_before = free_disk_gb();
    let started = Instant::now();
    assert!(claim(state), "the install slot of the {} lane is taken", lane.name);
    let mut stopped = Value::Null;
    if let Some(after) = number::<u64>("LU_REAL_CANCEL_AFTER") {
        let (snap, _) = follow_install(&lane, state, started, Some(Duration::from_secs(after)));
        if snap["status"] == "installing" {
            stopped = stop_install(&lane, state);
            println!("stopped: {stopped}");
            assert!(claim(state), "the slot was not free for the second start");
        }
    }
    let (snap, _) = follow_install(&lane, state, started, None);
    let none = json!({});
    let rt = runtime();
    record(
        &format!("engine {what}"),
        json!({
            "status": snap["status"],
            "error": snap["error"],
            "lastLogs": snap["logs"].as_array().map(|l| l.iter().rev().take(4).rev().cloned().collect::<Vec<_>>()),
            "totalSeconds": seconds(started),
            "stop": stopped,
            "venv": venv,
            "venvGB": dir_gb(&venv),
            "freeDiskBeforeGB": free_before,
            "freeDiskAfterGB": free_disk_gb(),
            "mlx_status": rt.block_on(mlx::mlx_status(state, &none)).unwrap_or_default(),
            "video_status": video::video_status(state, &none).unwrap_or_default(),
        }),
    );
    assert_eq!(snap["status"], "complete", "the engine install did not complete: {}", snap["error"]);
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn engine_mflux() {
    if on() {
        let venv = crate::os_paths::data_dir().join("mlx").join("venv-mflux");
        install_engine(image_lane(), "mflux", mlx::real_run_install_mflux_engine, venv);
    }
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn engine_ltx2() {
    if on() {
        let venv = crate::os_paths::data_dir().join("mlx-video").join("venv-ltx2");
        install_engine(video_lane(), "ltx-2-mlx", video::real_run_install_ltx2_engine, venv);
    }
}

// ── Images ────────────────────────────────────────────────────────────

/// Stage a picture the way Create does before a run reads it: the bytes go
/// through `video_stage_start_image`, and the path it answers with is what
/// the generate command is handed.
fn stage(path: &str) -> String {
    use base64::Engine as _;
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let staged = media_cmds::video_stage_start_image(json!({ "data": data })).expect("stage the image");
    staged["path"].as_str().expect("the staged path").to_string()
}

fn png_size(path: &str) -> (u32, u32) {
    let head = std::fs::read(path).expect("read the png");
    assert_eq!(&head[12..16], b"IHDR", "{path} is not a PNG");
    let side = |at: usize| u32::from_be_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]);
    (side(16), side(20))
}

/// `editCanvas` of `src/lib/image-engines.ts`: the pixel budget in the shape
/// of the image that is edited, on the grid of 32.
fn edit_canvas(side: u32, source: (u32, u32)) -> (u32, u32) {
    let ratio = source.0 as f64 / source.1 as f64;
    let width = ((side as f64) * (side as f64) * ratio).sqrt();
    let grid = |v: f64| ((v / 32.0).round() as u32 * 32).max(32);
    (grid(width), grid(width / ratio))
}

/// `qwenEditResolution` of `src/api/dynamic-workflow.ts`.
fn edit_resolution(width: u32, height: u32) -> u32 {
    let side = ((width as f64) * (height as f64)).sqrt();
    (((side / 32.0).round() as u32) * 32).clamp(32, 4096)
}

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn image() {
    if !on() {
        return;
    }
    let state = state();
    let rt = runtime();
    let none = json!({});
    let id = var("LU_REAL_MODEL").expect("LU_REAL_MODEL names the model");
    let name = var("LU_REAL_NAME").unwrap_or_else(|| format!("{id}-run"));
    wait_for_mains();

    // Create opens: status and the list, and the model's own line of it.
    let status = rt.block_on(mlx::mlx_status(state, &none)).expect("mlx_status");
    let list = mlx::mlx_image_models(state, &none).expect("mlx_image_models");
    let model = list.as_array().unwrap().iter().find(|m| m["id"] == id.as_str()).cloned().expect("the model is in the catalogue");
    assert_eq!(model["installed"], true, "{id} is not installed");
    let user_sampling = model["userSampling"] == true;

    // The values of Create: the catalogue's where nothing else is asked for.
    let width = number::<u32>("LU_REAL_WIDTH").unwrap_or(model["defaultSize"].as_u64().unwrap() as u32);
    let height = number::<u32>("LU_REAL_HEIGHT").unwrap_or(width);
    let steps = number::<u32>("LU_REAL_STEPS").unwrap_or(model["steps"].as_u64().unwrap() as u32);
    let guidance = number::<f64>("LU_REAL_GUIDANCE").unwrap_or(model["guidance"].as_f64().unwrap());
    let seed = number::<u64>("LU_REAL_SEED").unwrap_or(42);
    let prompt = var("LU_REAL_PROMPT").expect("LU_REAL_PROMPT");
    let sources: Vec<String> = var("LU_REAL_IMAGES").map(|v| v.split('|').map(str::to_string).collect()).unwrap_or_default();

    // The argument object of `mlxGenerate`, built as `useCreate` builds it.
    let mut args = json!({ "prompt": prompt, "model": id, "seed": seed });
    if user_sampling {
        args["steps"] = json!(steps);
        args["guidance"] = json!(guidance);
    } else if model["family"] == "diffusers" {
        // A model of the sidecar takes Create's steps and no guidance
        // (`generateMlxImageDataUrl`, the `plain` request).
        args["steps"] = json!(steps);
    }
    if let Some(negative) = var("LU_REAL_NEGATIVE") {
        args["negative_prompt"] = json!(negative);
    }
    // `LU_REAL_STALL_SECS`: Settings' Image timeout for a sidecar model (C71).
    if let Some(stall) = number::<u64>("LU_REAL_STALL_SECS") {
        args["stall_timeout_secs"] = json!(stall);
    }
    // `LU_REAL_LORAS`: names in LU's LoRA folder, each with its strength
    // after a colon, separated by `|`, as the stack of Create sends them.
    if let Some(stack) = var("LU_REAL_LORAS") {
        let loras: Vec<Value> = stack
            .split('|')
            .map(|one| {
                let (name, strength) = one.rsplit_once(':').unwrap_or((one, "1"));
                json!({ "name": name, "strength": strength.parse::<f64>().expect("a strength is a number") })
            })
            .collect();
        args["loras"] = json!(loras);
    }
    if sources.is_empty() {
        args["width"] = json!(width);
        args["height"] = json!(height);
    } else {
        let staged: Vec<String> = sources.iter().map(|p| stage(p)).collect();
        let side = number::<u32>("LU_REAL_RESOLUTION").unwrap_or_else(|| edit_resolution(width, height));
        args["resolution"] = json!(side);
        if staged.len() > 1 {
            let (w, h) = edit_canvas(side, png_size(&sources[0]));
            args["width"] = json!(w);
            args["height"] = json!(h);
        }
        args["images"] = json!(staged);
    }
    println!("mlx_generate {args}");
    // A model of the sidecar: start it and wait for its port, as Create does
    // (`mlxStart`, `waitForMlxRunning`). It is ended again below.
    let sidecar = model["family"] == "diffusers";
    if sidecar {
        mlx::mlx_start(state, &none).expect("mlx_start");
        let up = Instant::now();
        while !mlx::real_run_sidecar_up() {
            assert!(up.elapsed() < Duration::from_secs(120), "the sidecar did not come up");
            std::thread::sleep(Duration::from_millis(250));
        }
        println!("sidecar up after {:.1}s", seconds(up));
    }

    let images_before = std::fs::read_dir(mlx::images_root()).map(|d| d.count()).unwrap_or(0);
    let available_before = available_memory_gb();
    let sampler = sample_memory(|| descendants().into_iter().find(|(_, command)| command.contains("mflux.models")).map(|(pid, _)| pid));
    let cancel_at = number::<u32>("LU_REAL_CANCEL_AT_STEP");

    let started = Instant::now();
    let call_args = args.clone();
    let job = rt.spawn(async move { mlx::mlx_generate(state, &call_args).await });

    // The interface asks once a second. This asks four times, to see every
    // step go by, and notes when each was first reported.
    let mut steps_seen: Vec<(f64, u64, u64)> = Vec::new();
    let mut first_running = None::<f64>;
    let mut odd: Vec<String> = Vec::new();
    let mut stop = Value::Null;
    while !job.is_finished() {
        let p = mlx::mlx_generate_progress(state, &none).expect("mlx_generate_progress");
        if p["running"] == true {
            first_running.get_or_insert(seconds(started));
            let (step, of) = (p["step"].as_u64().unwrap_or(0), p["steps"].as_u64().unwrap_or(0));
            if steps_seen.last().is_none_or(|(_, last, _)| *last != step) {
                if steps_seen.last().is_some_and(|(_, last, _)| *last > step) {
                    odd.push(format!("the step went back to {step} at {}s", seconds(started)));
                }
                println!("[{:>6.1}s] step {step}/{of}", seconds(started));
                steps_seen.push((seconds(started), step, of));
            }
            if stop.is_null() && cancel_at.is_some_and(|at| step >= at as u64) {
                let children = descendants();
                let at = Instant::now();
                let answer = mlx::mlx_generate_cancel(state, &none).unwrap_or_else(|e| json!({ "ERROR": e }));
                let answered = at.elapsed().as_micros() as f64 / 1000.0;
                let mut gone = None::<u64>;
                while at.elapsed() < Duration::from_secs(30) && gone.is_none() {
                    if children.iter().all(|(pid, _)| !alive(*pid)) {
                        gone = Some(ms(at));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let right_after = available_memory_gb();
                std::thread::sleep(Duration::from_secs(3));
                stop = json!({
                    "atStep": step,
                    "cancelAnswer": answer,
                    "cancelAnsweredMs": answered,
                    "processGoneMs": gone,
                    "availableBeforeRunGB": available_before,
                    "availableRightAfterGB": right_after,
                    "availableThreeSecondsLaterGB": available_memory_gb(),
                    "progressAfter": mlx::mlx_generate_progress(state, &none).unwrap(),
                });
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let answer = rt.block_on(job).expect("the generate task");
    let took = seconds(started);
    if sidecar {
        mlx::real_run_stop_sidecar();
    }
    let memory = sampler.finish();

    let stepping: Vec<f64> = steps_seen.windows(2).filter(|w| w[1].1 == w[0].1 + 1).map(|w| w[1].0 - w[0].0).collect();
    let per_step = if stepping.is_empty() { Value::Null } else { json!((stepping.iter().sum::<f64>() / stepping.len() as f64 * 100.0).round() / 100.0) };
    let mut result = json!({
        "args": args,
        "mlxStatusBefore": { "mfluxInstalled": status["mfluxInstalled"], "running": status["running"], "modelLoaded": status["modelLoaded"] },
        "seconds": took,
        "firstRunningAtS": first_running,
        "firstStepAtS": steps_seen.iter().find(|(_, step, _)| *step >= 1).map(|(at, _, _)| *at),
        "stepsReported": steps_seen.iter().map(|(_, step, _)| *step).collect::<Vec<_>>(),
        "stepsOf": steps_seen.last().map(|(_, _, of)| *of),
        "secondsPerStep": per_step,
        "oddProgress": odd,
        "memory": memory,
        "availableBeforeGB": available_before,
        "availableAfterGB": available_memory_gb(),
        "stop": stop,
        "progressAfter": mlx::mlx_generate_progress(state, &none).unwrap(),
        "imagesWritten": std::fs::read_dir(mlx::images_root()).map(|d| d.count()).unwrap_or(0) as i64 - images_before as i64,
    });
    match &answer {
        Ok(made) => {
            let output = made["output"].as_str().unwrap_or("").to_string();
            let kept = out_dir().join(format!("{name}.png"));
            std::fs::copy(&output, &kept).expect("keep the image");
            result["answer"] = json!({
                "width": made["width"], "height": made["height"], "steps": made["steps"], "guidance": made["guidance"],
                "output": output,
                "base64Bytes": made["image_base64"].as_str().map(str::len),
                "fileBytes": std::fs::metadata(&output).map(|m| m.len()).ok(),
            });
            result["kept"] = json!(kept);
        }
        Err(why) => result["error"] = json!(why),
    }
    record(&format!("image {name}"), result);
    if cancel_at.is_some() {
        let why = answer.expect_err("a stopped run answers with an error");
        assert!(why.contains("stopped the engine"), "the stopped run said: {why}");
    } else {
        answer.expect("the image");
    }
}

// ── Video ─────────────────────────────────────────────────────────────

#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn video_run() {
    if !on() {
        return;
    }
    let state = state();
    let none = json!({});
    let id = var("LU_REAL_MODEL").expect("LU_REAL_MODEL names the model");
    let name = var("LU_REAL_NAME").unwrap_or_else(|| format!("{id}-run"));
    wait_for_mains();

    let status = video::video_status(state, &none).expect("video_status");
    let list = video::video_list_models(state, &none).expect("video_list_models");
    let model = list.as_array().unwrap().iter().find(|m| m["id"] == id.as_str()).cloned().expect("the model is in the catalogue");
    assert_eq!(model["installed"], true, "{id} is not installed");

    // The argument object of `generateVideo` in `src/api/mlx-video.ts`.
    let mut args = json!({ "id": id, "prompt": var("LU_REAL_PROMPT").expect("LU_REAL_PROMPT"), "seed": number::<i64>("LU_REAL_SEED").unwrap_or(42) });
    if let Some(seconds) = number::<f64>("LU_REAL_SECONDS") {
        args["seconds"] = json!(seconds);
    }
    if let Some(negative) = var("LU_REAL_NEGATIVE") {
        args["negative_prompt"] = json!(negative);
    }
    // Size, steps and the LoRA stack, as `generateVideo` sends them since the
    // second engine takes them (`mlxVideoRunSize`, `mlxVideoRunSteps`).
    if let (Some(width), Some(height)) = (number::<u32>("LU_REAL_WIDTH"), number::<u32>("LU_REAL_HEIGHT")) {
        args["width"] = json!(width);
        args["height"] = json!(height);
    }
    if let Some(steps) = number::<u32>("LU_REAL_STEPS") {
        args["steps"] = json!(steps);
    }
    if let Some(stack) = var("LU_REAL_LORAS") {
        let loras: Vec<Value> = stack
            .split('|')
            .map(|one| {
                let (name, strength) = one.rsplit_once(':').unwrap_or((one, "1"));
                json!({ "name": name, "strength": strength.parse::<f64>().expect("a strength is a number") })
            })
            .collect();
        args["loras"] = json!(loras);
    }
    if let Some(image) = var("LU_REAL_IMAGES") {
        assert_eq!(model["acceptsImage"], true, "{id} takes no start image by the catalogue");
        args["init_image"] = json!(stage(&image));
    }
    // Talking Character: the voice is staged the way the interface stages it
    // (`media_cmds::video_stage_voice`), and the clip is as long as it.
    if let Some(audio) = var("LU_REAL_AUDIO") {
        assert_eq!(model["talkingReady"], true, "{id} has no Talking Character part on disk");
        let bytes = std::fs::read(&audio).expect("the voice");
        let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        let staged = media_cmds::video_stage_voice(json!({ "data": data })).expect("stage the voice");
        args["audio"] = staged["path"].clone();
    }
    // Motion Control: the clip goes to disk the way the interface stages it
    // (`video_stage_motion_video`), and the run follows its motion.
    if let Some(clip) = var("LU_REAL_MOTION") {
        assert_eq!(model["motion"], true, "{id} cannot follow a motion video by the catalogue");
        assert_eq!(status["motionInstalled"], true, "the Motion Control LoRA is not installed");
        let bytes = std::fs::read(&clip).expect("read the motion video");
        let staged = media_cmds::stage_motion_video_in(&video::outputs_root().join("motion-videos"), &bytes).expect("stage the motion video");
        args["motion_video"] = json!(staged);
    }
    println!("video_generate {args}");

    let available_before = available_memory_gb();
    let started = Instant::now();
    let answer = video::video_generate(state, &args);
    let answered = started.elapsed().as_micros() as f64 / 1000.0;
    let Ok(job) = answer else {
        record(&format!("video {name}"), json!({ "args": args, "error": answer.unwrap_err(), "answeredMs": answered }));
        panic!("video_generate refused");
    };
    let pid = job["pid"].as_u64().unwrap_or(0) as u32;
    let sampler = sample_memory(move || Some(pid));
    let cancel_after = number::<u64>("LU_REAL_CANCEL_AFTER");

    let mut printed = 0usize;
    let mut stop = Value::Null;
    let last = loop {
        let p = video::video_progress(state, &none).expect("video_progress");
        let logs = p["logs"].as_array().cloned().unwrap_or_default();
        for line in logs.iter().skip(printed).filter_map(Value::as_str) {
            println!("[{:>6.1}s] {}", seconds(started), shorten(line));
        }
        printed = logs.len();
        if p["running"] != true {
            break p;
        }
        if stop.is_null() && cancel_after.is_some_and(|after| started.elapsed() >= Duration::from_secs(after)) {
            let children = descendants();
            let at = Instant::now();
            let cancelled = video::video_cancel(state, &none).unwrap_or_else(|e| json!({ "ERROR": e }));
            let answered = at.elapsed().as_micros() as f64 / 1000.0;
            let mut gone = None::<u64>;
            while at.elapsed() < Duration::from_secs(30) && gone.is_none() {
                if children.iter().all(|(pid, _)| !alive(*pid)) {
                    gone = Some(ms(at));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let right_after = available_memory_gb();
            std::thread::sleep(Duration::from_secs(3));
            stop = json!({
                "afterSeconds": cancel_after,
                "cancelAnswer": cancelled,
                "cancelAnsweredMs": answered,
                "processesGoneMs": gone,
                "survivors": children.iter().filter(|(pid, _)| alive(*pid)).map(|(pid, _)| *pid).collect::<Vec<_>>(),
                "availableBeforeRunGB": available_before,
                "availableRightAfterGB": right_after,
                "availableThreeSecondsLaterGB": available_memory_gb(),
            });
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    let took = seconds(started);
    let memory = sampler.finish();
    let output = job["output"].as_str().unwrap_or("").to_string();
    let mut result = json!({
        "args": args,
        "videoStatusBefore": { "ltx2MlxInstalled": status["ltx2MlxInstalled"], "ltx2MlxVersion": status["ltx2MlxVersion"], "running": status["running"] },
        "answeredMs": answered,
        "seconds": took,
        "status": last["status"],
        "error": last["error"],
        "lastLogs": last["logs"].as_array().map(|l| l.iter().rev().take(12).rev().filter_map(Value::as_str).map(shorten).collect::<Vec<_>>()),
        "logLines": printed,
        "memory": memory,
        "availableBeforeGB": available_before,
        "availableAfterGB": available_memory_gb(),
        "stop": stop,
        "output": output,
        "outputBytes": std::fs::metadata(&output).map(|m| m.len()).ok(),
    });
    if Path::new(&output).is_file() {
        let kept = out_dir().join(format!("{name}.mp4"));
        std::fs::copy(&output, &kept).expect("keep the video");
        result["kept"] = json!(kept);
    }
    record(&format!("video {name}"), result);
    if cancel_after.is_some() {
        assert!(!Path::new(&output).is_file(), "a cancelled run left a video behind");
    } else {
        assert_eq!(last["status"], "complete", "the video did not complete: {}", last["error"]);
    }
}

// ── Music ─────────────────────────────────────────────────────────────

/// The install of the music lane: the engine into its venv, then the
/// weights. `LU_REAL_MODEL` is `acestep-v15-turbo`, the one entry.
#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn install_music_model() {
    if on() {
        install_model(music_lane());
    }
}

/// One track, as Create makes it: the argument object of `generateMusic` in
/// `src/api/mlx-music.ts`, then the progress every two seconds until it is
/// through. `LU_REAL_PROMPT` is the style, `LU_REAL_LYRICS` the lyrics
/// (empty: an instrumental), `LU_REAL_SECONDS` the length,
/// `LU_REAL_CANCEL_AFTER` stops it on the way.
#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn music_run() {
    if !on() {
        return;
    }
    let state = state();
    let none = json!({});
    let name = var("LU_REAL_NAME").unwrap_or_else(|| "music-run".to_string());
    wait_for_mains();
    let status = music::music_status(state, &none).expect("mlx_music_status");
    assert_eq!(status["installed"], true, "the music model is not installed: {status}");
    let mut args = json!({
        "prompt": var("LU_REAL_PROMPT").expect("LU_REAL_PROMPT"),
        "seed": number::<i64>("LU_REAL_SEED").unwrap_or(42),
        "seconds": number::<f64>("LU_REAL_SECONDS").unwrap_or(30.0),
        "run": "real-run",
    });
    if let Some(lyrics) = var("LU_REAL_LYRICS") {
        args["lyrics"] = json!(lyrics);
    }
    println!("mlx_music_generate {args}");
    let available_before = available_memory_gb();
    let started = Instant::now();
    let answer = runtime().block_on(music::music_generate(state, &args));
    let Ok(job) = answer else {
        record(&format!("music {name}"), json!({ "args": args, "error": answer.unwrap_err() }));
        panic!("mlx_music_generate refused");
    };
    let pid = job["pid"].as_u64().unwrap_or(0) as u32;
    let sampler = sample_memory(move || Some(pid));
    let cancel_after = number::<u64>("LU_REAL_CANCEL_AFTER");
    let mut stop = Value::Null;
    let mut printed = String::new();
    let last = loop {
        let p = music::music_progress(state, &none).expect("mlx_music_progress");
        let line = format!("{} {}% {} {}/{}", p["phase"], p["percent"], p["detail"], p["step"], p["steps"]);
        if line != printed {
            println!("[{:>6.1}s] {line}", seconds(started));
            printed = line;
        }
        if p["running"] != true {
            break p;
        }
        if stop.is_null() && cancel_after.is_some_and(|after| started.elapsed() >= Duration::from_secs(after)) {
            let at = Instant::now();
            let answer = music::music_cancel(state, &json!({ "run": "real-run" })).unwrap_or_else(|e| json!({ "ERROR": e }));
            let mut gone = None::<u64>;
            while at.elapsed() < Duration::from_secs(30) && gone.is_none() {
                if !alive(pid) {
                    gone = Some(ms(at));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            stop = json!({ "afterSeconds": cancel_after, "cancelAnswer": answer, "processGoneMs": gone });
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    let memory = sampler.finish();
    let output = job["output"].as_str().unwrap_or("").to_string();
    let mut result = json!({
        "args": args,
        "job": job,
        "seconds": seconds(started),
        "progress": last,
        "view": music::real_run_view(),
        "memory": memory,
        "availableBeforeGB": available_before,
        "availableAfterGB": available_memory_gb(),
        "stop": stop,
        "outputBytes": std::fs::metadata(&output).map(|m| m.len()).ok(),
    });
    if Path::new(&output).is_file() {
        let kept = out_dir().join(format!("{name}.wav"));
        std::fs::copy(&output, &kept).expect("keep the track");
        result["kept"] = json!(kept);
    }
    record(&format!("music {name}"), result);
    if cancel_after.is_some() {
        assert!(!Path::new(&output).is_file(), "a cancelled run left a track behind");
    } else {
        assert_eq!(last["status"], "complete", "the track did not complete: {}", last["error"]);
    }
}

/// A character trained on this Mac, as Create trains it: the photos of
/// `LU_REAL_IMAGES` (a folder) staged one by one with the caption Create
/// writes, then `mlx_train_start` with the trigger word `LU_REAL_NAME` and
/// `LU_REAL_STEPS` steps, then the progress every two seconds until it is
/// through. `LU_REAL_CANCEL_AFTER` stops it on the way. The character is
/// copied to the results folder.
#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn train_run() {
    if !on() {
        return;
    }
    let state = state();
    let none = json!({});
    let trigger = var("LU_REAL_NAME").unwrap_or_else(|| "luxfox".to_string());
    wait_for_mains();
    let status = mlx::train::train_status(state, &none).expect("mlx_train_status");
    println!("mlx_train_status {status}");
    assert!(status["base"].is_string(), "no Z-Image Turbo pack: {status}");

    let folder = var("LU_REAL_IMAGES").expect("LU_REAL_IMAGES names the folder of the photos");
    let mut photos: Vec<PathBuf> = std::fs::read_dir(&folder)
        .expect("the folder of the photos")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "png" || x == "jpg"))
        .collect();
    photos.sort();
    mlx::train::train_clear(state, &json!({ "set": trigger })).expect("mlx_train_clear");
    // The caption Create writes (`buildTrainCaption` in src/lib/train-captions.ts):
    // the plain line, and the description of the photo after it where a
    // `<photo>.txt` lies next to it.
    for photo in &photos {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(std::fs::read(photo).expect("a photo"));
        let description = std::fs::read_to_string(photo.with_extension("txt")).unwrap_or_default();
        let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
        let description = description.trim_end_matches([',', '.', ';', ' ']);
        let caption = if description.is_empty() {
            format!("{trigger}, a photo of {trigger}")
        } else {
            format!("{trigger}, a photo of {trigger}, {description}")
        };
        mlx::train::train_stage(state, &json!({ "set": trigger, "data": data, "caption": caption })).expect("mlx_train_stage");
    }

    let args = json!({ "set": trigger, "trigger": trigger, "steps": number::<u32>("LU_REAL_STEPS"), "run": "real-run" });
    println!("mlx_train_start {args}");
    let available_before = available_memory_gb();
    let started = Instant::now();
    let answer = runtime().block_on(mlx::train::train_start(state, &args));
    let Ok(job) = answer else {
        record(&format!("train {trigger}"), json!({ "args": args, "error": answer.unwrap_err() }));
        panic!("mlx_train_start refused");
    };
    println!("{job}");
    let pid = job["pid"].as_u64().unwrap_or(0) as u32;
    let sampler = sample_memory(move || Some(pid));
    let cancel_after = number::<u64>("LU_REAL_CANCEL_AFTER");
    let mut stop = Value::Null;
    let mut printed = String::new();
    let mut phases: Vec<(f64, String)> = Vec::new();
    let last = loop {
        let p = mlx::train::train_progress(state, &none).expect("mlx_train_progress");
        let phase = p["phase"].as_str().unwrap_or("").to_string();
        if phases.last().is_none_or(|(_, last)| *last != phase) {
            phases.push((seconds(started), phase));
        }
        let line = format!("{} {}% {}/{}", p["phase"], p["percent"], p["step"], p["steps"]);
        if line != printed {
            println!("[{:>6.1}s] {line}", seconds(started));
            printed = line;
        }
        if p["running"] != true {
            break p;
        }
        if stop.is_null() && cancel_after.is_some_and(|after| started.elapsed() >= Duration::from_secs(after)) {
            let at = Instant::now();
            let answer = mlx::train::train_cancel(state, &json!({ "run": "real-run" })).unwrap_or_else(|e| json!({ "ERROR": e }));
            let mut gone = None::<u64>;
            while at.elapsed() < Duration::from_secs(30) && gone.is_none() {
                if !alive(pid) {
                    gone = Some(ms(at));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            stop = json!({ "afterSeconds": cancel_after, "cancelAnswer": answer, "processGoneMs": gone });
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    let memory = sampler.finish();
    let output = job["output"].as_str().unwrap_or("").to_string();
    let mut result = json!({
        "args": args,
        "job": job,
        "seconds": seconds(started),
        "phases": phases,
        "progress": last,
        "view": mlx::train::real_run_view(),
        "memory": memory,
        "availableBeforeGB": available_before,
        "availableAfterGB": available_memory_gb(),
        "stop": stop,
        "outputBytes": std::fs::metadata(&output).map(|m| m.len()).ok(),
    });
    if cancel_after.is_none() && Path::new(&output).is_file() {
        let kept = out_dir().join(format!("{trigger}.safetensors"));
        std::fs::copy(&output, &kept).expect("keep the character");
        result["kept"] = json!(kept);
    }
    record(&format!("train {trigger}"), result);
    if cancel_after.is_some() {
        assert_eq!(last["status"], "cancelled", "the run was not cancelled: {last}");
    } else {
        assert_eq!(last["status"], "complete", "the training did not complete: {}", last["error"]);
    }
}

// ── 3D ────────────────────────────────────────────────────────────────

/// The 3D runs write only below `LU_REAL_RUN_HOME`: they are not to touch
/// the app's own folders on this Mac.
fn own_folder_only() -> bool {
    if crate::os_paths::test_storage::real_run_home().is_none() {
        eprintln!("the 3D real run needs LU_REAL_RUN_HOME, an absolute folder of its own");
        return false;
    }
    true
}

/// The install of the 3D lane: LU's Python, the venv, the TripoSR source and
/// the weights. `LU_REAL_MODEL` is `triposr`, the one entry.
///
/// ```sh
/// LU_REAL_RUN=1 LU_REAL_RUN_HOME=/path/to/test LU_REAL_MODEL=triposr \
///   cargo test real_run_mac::mesh_install -- --ignored --nocapture --test-threads=1
/// ```
#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn mesh_install() {
    if on() && own_folder_only() {
        install_model(mesh_lane());
        let root = mesh3d::real_run_root();
        record("mesh3d folders", json!({ "venvGB": dir_gb(&root.join("venv")), "weightsGB": dir_gb(&root.join("weights")), "sourceGB": dir_gb(&root.join("source")) }));
    }
}

/// One model from one picture, as Create makes it: the picture of
/// `LU_REAL_IMAGES` staged, then `mlx_mesh3d_generate` with the argument
/// object of `generateMesh3d` in `src/api/mlx-3d.ts`, then the progress every
/// second until it is through. `LU_REAL_RESOLUTION` is the grid,
/// `LU_REAL_CANCEL_AFTER` stops it on the way and then looks that no process
/// of the run is left.
#[test]
#[ignore = "the real run: needs LU_REAL_RUN=1"]
fn mesh_run() {
    if !on() || !own_folder_only() {
        return;
    }
    let state = state();
    let none = json!({});
    let name = var("LU_REAL_NAME").unwrap_or_else(|| "mesh-run".to_string());
    wait_for_mains();
    let status = mesh3d::mesh3d_status(state, &none).expect("mlx_mesh3d_status");
    assert_eq!(status["installed"], true, "the 3D model is not installed: {status}");
    let picture = var("LU_REAL_IMAGES").expect("LU_REAL_IMAGES names the picture");
    let staged = stage(&picture);
    let run = format!("real-run-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let mut args = json!({ "run": run, "imagePath": staged });
    if let Some(resolution) = number::<u32>("LU_REAL_RESOLUTION") {
        args["resolution"] = json!(resolution);
    }
    println!("mlx_mesh3d_generate {args}");
    let available_before = available_memory_gb();
    let started = Instant::now();
    let answer = runtime().block_on(mesh3d::mesh3d_generate(state, &args));
    let Ok(job) = answer else {
        record(&format!("mesh3d {name}"), json!({ "args": args, "error": answer.unwrap_err() }));
        panic!("mlx_mesh3d_generate refused");
    };
    let sampler = sample_memory(move || mesh3d::mesh3d_progress(state, &json!({})).ok().and_then(|p| p["pid"].as_u64()).map(|p| p as u32));
    let cancel_after = number::<u64>("LU_REAL_CANCEL_AFTER");
    let mut stop = Value::Null;
    let mut printed = String::new();
    let mut seen_pid = None::<u32>;
    let last = loop {
        let p = mesh3d::mesh3d_progress(state, &none).expect("mlx_mesh3d_progress");
        if let Some(pid) = p["pid"].as_u64() {
            seen_pid = Some(pid as u32);
        }
        let line = format!("{} {}% {} {}", p["phase"], p["percent"], p["detail"], p["device"]);
        if line != printed {
            println!("[{:>6.1}s] {line}", seconds(started));
            printed = line;
        }
        if p["running"] != true {
            break p;
        }
        if stop.is_null() && cancel_after.is_some_and(|after| started.elapsed() >= Duration::from_secs(after)) {
            let children = descendants();
            let at = Instant::now();
            let answer = mesh3d::mesh3d_cancel(state, &json!({ "run": run })).unwrap_or_else(|e| json!({ "ERROR": e }));
            let mut gone = None::<u64>;
            while at.elapsed() < Duration::from_secs(30) && gone.is_none() {
                if children.iter().all(|(pid, _)| !alive(*pid)) {
                    gone = Some(ms(at));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            stop = json!({
                "afterSeconds": cancel_after,
                "phaseAtStop": p["phase"],
                "cancelAnswer": answer,
                "children": children.iter().map(|(pid, command)| format!("{pid} {}", shorten(command))).collect::<Vec<_>>(),
                "processesGoneMs": gone,
                "survivors": children.iter().filter(|(pid, _)| alive(*pid)).map(|(pid, _)| *pid).collect::<Vec<_>>(),
            });
        }
        std::thread::sleep(Duration::from_secs(1));
    };
    let memory = sampler.finish();
    let output = job["output"].as_str().unwrap_or("").to_string();
    let left = descendants();
    let mut result = json!({
        "args": args,
        "job": job,
        "seconds": seconds(started),
        "progress": last,
        "view": mesh3d::real_run_view(),
        "memory": memory,
        "availableBeforeGB": available_before,
        "availableAfterGB": available_memory_gb(),
        "stop": stop,
        "pid": seen_pid,
        "processesLeft": left.iter().map(|(pid, command)| format!("{pid} {}", shorten(command))).collect::<Vec<_>>(),
        "outputBytes": std::fs::metadata(&output).map(|m| m.len()).ok(),
    });
    if Path::new(&output).is_file() {
        let kept = out_dir().join(format!("{name}.glb"));
        std::fs::copy(&output, &kept).expect("keep the model");
        result["kept"] = json!(kept);
    }
    record(&format!("mesh3d {name}"), result);
    assert!(seen_pid.is_none_or(|pid| !alive(pid)), "the engine's process outlived the run");
    if cancel_after.is_some() {
        assert_eq!(last["status"], "cancelled", "the run was not cancelled: {}", last["error"]);
        assert!(!Path::new(&output).is_file(), "a cancelled run left a model behind");
        assert!(left.is_empty(), "a process of the run is left: {left:?}");
    } else {
        assert_eq!(last["status"], "complete", "the model did not complete: {}", last["error"]);
    }
}
