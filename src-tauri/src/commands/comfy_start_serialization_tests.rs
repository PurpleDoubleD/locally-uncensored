use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

// A subprocess of the test harness gives us a real Child that stays alive
// without binding any application port or importing an installed Python.
#[test]
#[ignore = "stand-in child invoked only by the lifecycle tests"]
fn stand_in_child() {
    std::thread::sleep(std::time::Duration::from_secs(15));
}

fn child() -> std::process::Child {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "commands::process::comfy_start_serialization_tests::stand_in_child",
            "--ignored",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::process_util::suppress_window(&mut command);
    command.spawn().unwrap()
}

struct Cleanup(Arc<Mutex<Option<std::process::Child>>>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn concurrent_starts_keep_one_live_child_before_it_binds_a_port() {
    static GATE: Mutex<()> = Mutex::new(());
    let process = Arc::new(Mutex::new(None));
    let _cleanup = Cleanup(process.clone());
    let spawns = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..12 {
            let process = process.clone();
            let spawns = spawns.clone();
            scope.spawn(move || {
                let _guard = start_gate(&GATE);
                if tracked_comfy_child_alive(&process) {
                    return;
                }
                *process.lock().unwrap() = Some(child());
                spawns.fetch_add(1, Ordering::SeqCst);
            });
        }
    });
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
    assert!(tracked_comfy_child_alive(&process));
}

#[test]
fn confirmed_exit_releases_the_handle_for_a_new_start() {
    let mut child = child();
    child.kill().unwrap();
    child.wait().unwrap();
    let process = Mutex::new(Some(child));
    assert!(!tracked_comfy_child_alive(&process));
    assert!(process.lock().unwrap().is_none());
}

#[test]
fn auto_and_manual_entry_points_share_the_gated_launch_and_diagnostics() {
    let source = include_str!("process.rs");
    let body = |name: &str| {
        let from = source.find(name).unwrap();
        &source[from..from + source[from..].find("\n}\n").unwrap()]
    };
    let auto = body("pub fn auto_start_comfyui(");
    assert!(auto.contains("start_comfyui_blocking(state)"));
    assert!(!auto.contains(".spawn()"));
    let manual = body("pub(crate) fn start_comfyui_blocking(");
    for required in [
        "start_gate(&COMFY_START)",
        "tracked_comfy_child_alive(",
        "launch_python(",
        "apply_gpu_env(",
        "comfy_start_at.lock()",
        "comfy_output.lock()",
    ] {
        assert!(manual.contains(required), "shared launcher lost {required}");
    }
    assert!(
        manual.find("tracked_comfy_child_alive(").unwrap() < manual.find("cmd.spawn()").unwrap()
    );
}
