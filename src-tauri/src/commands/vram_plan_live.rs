//! The plan against a real engine on a real card (3.0.8, A25).
//!
//! Ignored by default: it starts lu-llama-server once per case and needs the
//! engine binary and models on disk. It works the plan out exactly as a start
//! of the app does (`model_shape`, `plan_request`, `decide`, `server_args`),
//! starts the engine with that argv, and puts three readings side by side:
//!
//!   * what the plan said would go on the card and stay in RAM,
//!   * what llama-server says it allocated (`-lv 4`, `parse_engine_report`),
//!   * what the machine saw: nvidia-smi's free memory before and after, and
//!     the engine's working set and the machine's available RAM.
//!
//! Run (Windows box, PowerShell):
//!
//!   $env:LU_LIVE_ENGINE = "C:\Program Files\Locally Uncensored\lu-llama-server.exe"
//!   $env:LU_LIVE_MODELS = "C:\...\a.gguf;C:\...\b.gguf"
//!   $env:LU_LIVE_CASES  = "8192:f16,16384:f16,65536:f16,8192:q8_0,65536:q8_0"
//!   $env:LU_LIVE_OUT    = "C:\lu-work\a25\live.jsonl"
//!   cargo test --release live_plan_against_the_real_engine -- --ignored --nocapture --test-threads 1

use crate::commands::engine::{model_shape, plan_request, server_args, EngineTuning};
use crate::commands::vram_plan::{decide, parse_engine_report, Budget, Calibration, Card, Host, ImagePart, MIB};
use std::io::Write;
use std::process::Stdio;
use std::time::{Duration, Instant};

fn mib(b: u64) -> u64 {
    b / MIB
}

fn healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .is_some_and(|r| r.status().is_success())
}

fn available_ram() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.available_memory()
}

fn working_set(pid: u32) -> u64 {
    let mut sys = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}

#[test]
#[ignore = "starts the real engine; set LU_LIVE_ENGINE and LU_LIVE_MODELS"]
fn live_plan_against_the_real_engine() {
    let (Ok(engine), Ok(models)) = (std::env::var("LU_LIVE_ENGINE"), std::env::var("LU_LIVE_MODELS")) else {
        eprintln!("LU_LIVE_ENGINE / LU_LIVE_MODELS not set, nothing to run");
        return;
    };
    let cases = std::env::var("LU_LIVE_CASES").unwrap_or_else(|_| "8192:f16,16384:f16,65536:f16,8192:q8_0,65536:q8_0".into());
    let out_path = std::env::var("LU_LIVE_OUT").ok();
    let mut out = out_path.as_ref().map(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).expect("output file"));
    let port: u16 = std::env::var("LU_LIVE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(18127);
    let windows = cfg!(target_os = "windows");
    let mac = cfg!(target_os = "macos");
    let engine_dir = std::path::Path::new(&engine).parent().map(|p| p.to_path_buf());

    for model in models.split(';').filter(|m| !m.trim().is_empty()) {
        let model = model.trim();
        let shape = model_shape(model);
        let part = crate::commands::engine::existing_mmproj(model);
        let part_head = part.as_deref().and_then(crate::commands::gguf::read_model_head);
        let part_bytes = part.as_deref().map(crate::commands::gguf::model_file_bytes).unwrap_or(0);
        for case in cases.split(',') {
            let (ctx, kv) = case.split_once(':').unwrap_or((case, "f16"));
            let ctx: u32 = ctx.parse().expect("ctx");
            let tuning = EngineTuning { ctx, ctx_chosen: true, cache_type_k: kv.into(), cache_type_v: kv.into(), ..Default::default() };
            let reading = crate::commands::gpu::engine_vram_reading();
            let host = Host { total_ram: crate::commands::system::total_memory_bytes(), mac };
            let card = if mac {
                Card::Unified { budget: crate::commands::vram_plan::mac_gpu_budget(host.total_ram, 0) }
            } else {
                reading.as_ref().map(|r| Card::Measured(Budget { bytes: r.bytes, free: r.free, learned_overhead: 0 })).unwrap_or(Card::None)
            };
            let d = decide(&shape, &plan_request(&tuning), card, host, ImagePart::from_head(part_bytes, part_head.as_ref()), Calibration::default());
            let planned = EngineTuning { ctx: d.ctx, plan_cpu_moe: d.cpu_moe, plan_cache_ram_mib: d.cache_ram_mib, ..tuning.clone() };
            let mmproj = if d.with_image_part { part.as_deref() } else { None };
            let args = server_args(model, &planned, port, None, mmproj, d.ngl, windows);
            let ram_before = available_ram();
            let free_before = reading.as_ref().filter(|r| r.free).map(|r| r.bytes);

            let mut cmd = crate::process_util::hidden_command(&engine);
            cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            if let Some(dir) = &engine_dir {
                cmd.current_dir(dir);
            }
            let started = Instant::now();
            let mut child = cmd.spawn().expect("spawn engine");
            let (buf, _done) = crate::commands::shell::drain(child.stderr.take().expect("stderr"));
            let mut up = false;
            while started.elapsed() < Duration::from_secs(600) {
                if healthy(port) {
                    up = true;
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            // Let the allocations settle before reading the machine.
            std::thread::sleep(Duration::from_secs(2));
            let free_after = crate::commands::gpu::engine_vram_reading().filter(|r| r.free).map(|r| r.bytes);
            let ws = working_set(child.id());
            let ram_after = available_ram();
            let _ = child.kill();
            let _ = child.wait();
            let text = crate::commands::shell::captured_text(&buf);
            let report = parse_engine_report(&text);
            let plan = d.plan.unwrap_or_default();
            let row = serde_json::json!({
                "model": std::path::Path::new(model).file_name().map(|f| f.to_string_lossy().to_string()),
                "arch": shape.arch,
                "layers": shape.n_layer(),
                "ctx": d.ctx,
                "kv": kv,
                "up": up,
                "loadSeconds": started.elapsed().as_secs(),
                "ngl": d.ngl,
                "cpuMoe": d.cpu_moe,
                "imagePart": mmproj.is_some(),
                "freeBeforeMiB": free_before.map(mib),
                "plan": {
                    "cardMiB": mib(plan.card.total()), "cardWeights": mib(plan.card.weights), "cardCache": mib(plan.card.cache), "cardWork": mib(plan.card.compute),
                    "hostMiB": mib(plan.host.total()), "hostWeights": mib(plan.host.weights), "hostCache": mib(plan.host.cache), "hostWork": mib(plan.host.compute),
                },
                "llama": report.as_ref().map(|r| serde_json::json!({
                    "cardMiB": mib(r.card.total()), "cardWeights": mib(r.card.weights), "cardCache": mib(r.card.cache), "cardWork": mib(r.card.compute),
                    "hostMiB": mib(r.host.total()), "imagePartMiB": mib(r.image_part), "offloaded": r.offloaded,
                })),
                "machine": {
                    "cardUsedMiB": match (free_before, free_after) { (Some(b), Some(a)) if b >= a => Some(mib(b - a)), _ => None },
                    "engineWorkingSetMiB": mib(ws),
                    "ramTakenMiB": mib(ram_before.saturating_sub(ram_after)),
                },
                "advice": d.advice.as_ref().map(|a| a.text.clone()),
                "why": d.why,
            });
            println!("LIVE {row}");
            if let Some(f) = out.as_mut() {
                let _ = writeln!(f, "{row}");
            }
            if !up {
                let tail: Vec<&str> = text.lines().rev().take(15).collect();
                println!("LIVE-FAIL {}", tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
            }
            // The card needs a moment to hand the memory back.
            std::thread::sleep(Duration::from_secs(3));
        }
    }
}
