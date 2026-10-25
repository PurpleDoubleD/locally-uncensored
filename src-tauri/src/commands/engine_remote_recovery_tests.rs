use super::{
    ensure_remote_engine_with, remember_engine_request, EngineRecoveryRecipe, EngineTuning,
    REMOTE_ENGINE_STOPPED,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc, Barrier, Mutex,
};
use std::time::Duration;

const MODEL: &str = "C:/models/current.gguf";

fn recipe() -> EngineRecoveryRecipe {
    EngineRecoveryRecipe {
        model_path: MODEL.into(),
        tuning: EngineTuning::default(),
        port: 8127,
    }
}

#[test]
fn latest_success_keeps_256k_context_all_requested_tuning_and_actual_fallback_port() {
    let recipes = Mutex::new(Some(recipe()));
    let stopped = AtomicBool::new(false);
    let tuning = EngineTuning {
        ctx: 262_144,
        flash_attn: "on".into(),
        cache_type_k: "q8_0".into(),
        cache_type_v: "q4_0".into(),
        threads: 12,
        gpu_layers: -1,
        mlock: true,
        no_mmap: true,
    };
    let answer = Ok(serde_json::json!({ "status": "started", "port": 8131 }));

    remember_engine_request(&recipes, &stopped, MODEL.into(), tuning.clone(), &answer);

    assert_eq!(
        *recipes.lock().unwrap(),
        Some(EngineRecoveryRecipe {
            model_path: MODEL.into(),
            tuning,
            port: 8131,
        })
    );
}

#[test]
fn failed_model_swap_preserves_the_previous_successful_recipe() {
    let previous = recipe();
    let recipes = Mutex::new(Some(previous.clone()));
    let answer = Err("The new model failed; the previous model is running again.".into());

    remember_engine_request(
        &recipes,
        &AtomicBool::new(false),
        "C:/models/broken.gguf".into(),
        EngineTuning {
            ctx: 262_144,
            ..EngineTuning::default()
        },
        &answer,
    );

    assert_eq!(*recipes.lock().unwrap(), Some(previous));
}

#[test]
fn stopped_start_result_is_not_a_successful_recipe() {
    let previous = recipe();
    let recipes = Mutex::new(Some(previous.clone()));
    let answer = Ok(serde_json::json!({ "status": "stopped", "port": 8131 }));

    remember_engine_request(
        &recipes,
        &AtomicBool::new(false),
        "C:/models/not-started.gguf".into(),
        EngineTuning::default(),
        &answer,
    );

    assert_eq!(*recipes.lock().unwrap(), Some(previous));
}

#[test]
fn stop_after_success_prevents_recording_the_just_stopped_request() {
    let previous = recipe();
    let recipes = Mutex::new(Some(previous.clone()));
    let answer = Ok(serde_json::json!({ "status": "started", "port": 8131 }));

    remember_engine_request(
        &recipes,
        &AtomicBool::new(true),
        "C:/models/stopped.gguf".into(),
        EngineTuning::default(),
        &answer,
    );

    assert_eq!(*recipes.lock().unwrap(), Some(previous));
}

#[test]
fn already_running_answer_records_the_current_successful_port() {
    let recipes = Mutex::new(None);
    let answer = Ok(serde_json::json!({ "status": "already_running", "port": 8130 }));

    remember_engine_request(
        &recipes,
        &AtomicBool::new(false),
        MODEL.into(),
        EngineTuning::default(),
        &answer,
    );

    assert_eq!(recipes.lock().unwrap().as_ref().unwrap().port, 8130);
}

#[test]
fn recovery_still_works_after_the_dead_child_handle_has_been_reaped() {
    let expected = EngineRecoveryRecipe {
        tuning: EngineTuning {
            ctx: 262_144,
            ..EngineTuning::default()
        },
        port: 8131,
        ..recipe()
    };
    let recipes = Mutex::new(Some(expected.clone()));
    let starts = AtomicUsize::new(0);

    let port = ensure_remote_engine_with(
        &Mutex::new(()),
        &AtomicBool::new(false),
        &recipes,
        MODEL,
        || None,
        |saved| {
            assert_eq!(saved, &expected);
            starts.fetch_add(1, Ordering::SeqCst);
            Ok(saved.port)
        },
    )
    .unwrap();

    assert_eq!(port, 8131);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_remote_requests_start_only_one_replacement_engine() {
    const REQUESTS: usize = 8;
    let gate = Arc::new(Mutex::new(()));
    let stopped = Arc::new(AtomicBool::new(false));
    let recipes = Arc::new(Mutex::new(Some(recipe())));
    let alive = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));
    let ready = Arc::new(Barrier::new(REQUESTS));
    let threads: Vec<_> = (0..REQUESTS)
        .map(|_| {
            let gate = Arc::clone(&gate);
            let stopped = Arc::clone(&stopped);
            let recipes = Arc::clone(&recipes);
            let alive = Arc::clone(&alive);
            let starts = Arc::clone(&starts);
            let ready = Arc::clone(&ready);
            std::thread::spawn(move || {
                ready.wait();
                ensure_remote_engine_with(
                    &gate,
                    &stopped,
                    &recipes,
                    MODEL,
                    || {
                        alive
                            .load(Ordering::SeqCst)
                            .then(|| (MODEL.into(), 8127, true))
                    },
                    |saved| {
                        starts.fetch_add(1, Ordering::SeqCst);
                        alive.store(true, Ordering::SeqCst);
                        Ok(saved.port)
                    },
                )
            })
        })
        .collect();

    for thread in threads {
        assert_eq!(thread.join().unwrap().unwrap(), 8127);
    }
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[test]
fn stop_interrupts_a_recovery_queued_behind_the_start_gate() {
    let gate = Arc::new(Mutex::new(()));
    let held_gate = gate.lock().unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let worker_gate = Arc::clone(&gate);
    let worker_stopped = Arc::clone(&stopped);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        entered_tx.send(()).unwrap();
        let result = ensure_remote_engine_with(
            &worker_gate,
            &worker_stopped,
            &Mutex::new(Some(recipe())),
            MODEL,
            || panic!("a stopped queued request must not inspect or start an engine"),
            |_| panic!("a queued request must never clear Stop and restart the engine"),
        );
        finished_tx.send(result).unwrap();
    });

    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    stopped.store(true, Ordering::SeqCst);
    // Stop must be observed while the gate is still held, not after a lengthy
    // desktop model load releases it.
    let result = finished_rx.recv_timeout(Duration::from_secs(5));
    drop(held_gate);
    worker.join().unwrap();
    assert_eq!(result.unwrap().unwrap_err(), REMOTE_ENGINE_STOPPED);
}

#[test]
fn desktop_model_swap_rejects_an_old_remote_dispatch() {
    let mut latest = recipe();
    latest.model_path = "C:/models/desktop-new.gguf".into();
    let result = ensure_remote_engine_with(
        &Mutex::new(()),
        &AtomicBool::new(false),
        &Mutex::new(Some(latest)),
        MODEL,
        || panic!("an obsolete dispatch must be rejected before a probe"),
        |_| panic!("Remote must not undo the desktop model swap"),
    );

    assert!(result.unwrap_err().contains("Dispatch Remote Access again"));
}

#[test]
fn unexpected_live_model_is_never_replaced_by_a_remote_recovery() {
    let result = ensure_remote_engine_with(
        &Mutex::new(()),
        &AtomicBool::new(false),
        &Mutex::new(Some(recipe())),
        MODEL,
        || Some(("C:/models/desktop-new.gguf".into(), 8129, true)),
        |_| panic!("Remote must not replace a different live desktop model"),
    );

    assert!(result.unwrap_err().contains("Dispatch Remote Access again"));
}

#[test]
fn an_alive_but_unhealthy_engine_is_left_running() {
    let result = ensure_remote_engine_with(
        &Mutex::new(()),
        &AtomicBool::new(false),
        &Mutex::new(Some(recipe())),
        MODEL,
        || Some((MODEL.into(), 8131, false)),
        |_| panic!("an unresponsive live engine must not be killed or restarted"),
    );

    assert!(result.unwrap_err().contains("running but is not ready"));
}

#[test]
fn a_stop_during_the_probe_still_prevents_recovery() {
    let stopped = AtomicBool::new(false);
    let result = ensure_remote_engine_with(
        &Mutex::new(()),
        &stopped,
        &Mutex::new(Some(recipe())),
        MODEL,
        || {
            stopped.store(true, Ordering::SeqCst);
            None
        },
        |_| panic!("Stop received during inspection must prevent restart"),
    );

    assert_eq!(result.unwrap_err(), REMOTE_ENGINE_STOPPED);
}

#[test]
fn a_missing_recovery_recipe_never_guesses_a_model_or_defaults() {
    let result = ensure_remote_engine_with(
        &Mutex::new(()),
        &AtomicBool::new(false),
        &Mutex::new(None),
        MODEL,
        || panic!("without a successful recipe there is nothing to recover"),
        |_| panic!("without a successful recipe no default model may be started"),
    );

    assert!(result.unwrap_err().contains("no previously loaded model"));
}
