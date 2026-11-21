//! The plan against real model heads and against llama.cpp's own numbers.
//!
//! fixtures/gguf-heads holds the heads of twelve models and two image parts,
//! fetched with scripts/fetch-gguf-head.mjs (HTTP range reads from Hugging
//! Face, tokenizer arrays emptied, gzipped; a few KB each). heads.json names
//! where each came from and the file's real size. oracle-b9949.json is what
//! the pinned llama.cpp says about the same files: `llama-fit-params
//! --fit-print on -np 4 -kvu` (the server's 4 slots on one cache) against
//! each head written into a sparse file of the model's full size, so the
//! loader sees the real tensor table and no weights. The KV cache and the
//! weights per device are exact in llama.cpp and have to be exact here.

use super::*;
use crate::commands::gguf::parse_head;
use std::io::Read;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("gguf-heads")
}

fn manifest() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("heads.json")).expect("heads.json")).expect("heads.json is JSON")
}

fn oracle() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("oracle-b9949.json")).expect("oracle")).expect("oracle is JSON")
}

pub(crate) fn head_of(name: &str) -> GgufHead {
    let gz = std::fs::read(fixtures().join(format!("{name}.head.gguf.gz"))).unwrap_or_else(|e| panic!("{name}: {e}"));
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut raw).expect("gunzip");
    parse_head(&mut &raw[..]).unwrap_or_else(|| panic!("{name}: head does not parse"))
}

pub(crate) fn shape_of(name: &str) -> ModelShape {
    let bytes = manifest()[name]["fileBytes"].as_u64().expect("fileBytes");
    ModelShape::from_head(&head_of(name), bytes).unwrap_or_else(|| panic!("{name}: no shape"))
}

const MODELS: &[&str] = &[
    "gemma-4-31B-it-Q4_K_M",
    "gemma-4-12b-it-Q4_K_M",
    "gemma4-12B-hauhau-Q4_K_M",
    "gemma-4-26B-A4B-it-UD-Q4_K_M",
    "llama-3.1-8B-Instruct-Q4_K_M",
    "qwen3-8B-Q4_K_M",
    "qwen3-30B-A3B-Q4_K_M",
    "qwen3.5-27B-Q4_K_M",
    "qwen3-next-80B-A3B-Q4_K_M",
    "granite-4.0-h-tiny-Q4_K_M",
    "glm-4.7-flash-Q4_K_M",
    "gpt-oss-20b-MXFP4",
];

fn mib_floor(b: u64) -> i64 {
    (b / MIB) as i64
}

#[test]
fn every_fixture_head_parses_into_a_shape_with_a_full_tensor_table() {
    for name in MODELS {
        let s = shape_of(name);
        assert!(!s.unknown_types, "{name}: a tensor type the table does not know");
        assert!(s.n_layer() > 0, "{name}");
        // The tensors add up to the file, minus the head and alignment.
        let file = manifest()[*name]["fileBytes"].as_u64().unwrap();
        let tied_copy = s.output.saturating_sub(s.output.min(s.input));
        let _ = tied_copy;
        let sum = s.weights();
        assert!(sum <= file + s.output, "{name}: tensors {sum} > file {file}");
    }
}

#[test]
fn the_kv_cache_is_exactly_what_llama_cpp_allocates_for_every_head_context_and_type() {
    let o = oracle();
    let mut checked = 0;
    for name in MODELS {
        let s = shape_of(name);
        let cases = o["models"][*name]["cache"].as_object().unwrap_or_else(|| panic!("{name}: no oracle"));
        for (key, want) in cases {
            let mut it = key.split('|');
            let ctx: u32 = it.next().unwrap().parse().unwrap();
            let kv = it.next().unwrap();
            let fa = it.next().unwrap();
            let cfg = CacheConfig::new(ctx, kv, kv, fa);
            let got = mib_floor(s.cache_bytes(&cfg));
            let want = want.as_i64().unwrap();
            assert!((got - want).abs() <= 1, "{name} ctx {ctx} {kv} fa {fa}: plan {got} MiB, llama.cpp {want} MiB");
            checked += 1;
        }
    }
    assert!(checked >= 100, "only {checked} cases");
}

#[test]
fn the_weights_on_the_card_are_exactly_llama_cpp_s_for_all_layers_and_for_ten() {
    let o = oracle();
    let cfg = CacheConfig::new(8192, "f16", "f16", "on");
    for name in MODELS {
        let s = shape_of(name);
        let all = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &cfg, &ImagePart::default());
        let want = o["models"][*name]["cardWeightsAll"].as_i64().unwrap();
        let got = mib_floor(all.card.weights);
        assert!((got - want).abs() <= 2, "{name} all layers: plan {got} MiB, llama.cpp {want} MiB");
        let ten = s.split(Placement { ngl: 10, cpu_moe: 0, cpu_ffn: 0 }, &cfg, &ImagePart::default());
        let want = o["models"][*name]["cardWeightsNgl10"].as_i64().unwrap();
        let got = mib_floor(ten.card.weights);
        assert!((got - want).abs() <= 2, "{name} -ngl 10: plan {got} MiB, llama.cpp {want} MiB");
        for (ctx, want) in o["models"][*name]["cacheOnCardNgl10"].as_object().unwrap() {
            let c = CacheConfig::new(ctx.parse().unwrap(), "f16", "f16", "on");
            let got = mib_floor(s.split(Placement { ngl: 10, cpu_moe: 0, cpu_ffn: 0 }, &c, &ImagePart::default()).card.cache);
            let want = want.as_i64().unwrap();
            assert!((got - want).abs() <= 1, "{name} -ngl 10 ctx {ctx}: cache on the card {got} MiB, llama.cpp {want} MiB");
        }
    }
}

#[test]
fn gemma_4_31b_reads_as_fifty_window_layers_and_ten_global_ones() {
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    assert_eq!(s.n_layer(), 60);
    assert_eq!(s.window, Window::Sliding(1024));
    let swa: Vec<&Layer> = s.layers.iter().filter(|l| l.swa).collect();
    assert_eq!(swa.len(), 50);
    assert!(swa.iter().all(|l| l.k == 16 * 256 && l.v == 16 * 256), "{:?}", swa[0]);
    let global: Vec<&Layer> = s.layers.iter().filter(|l| !l.swa).collect();
    assert!(global.iter().all(|l| l.k == 4 * 512 && l.v == 4 * 512), "{:?}", global[0]);
    // 4 slots on one cache: 1024 * 4 + 512 cells for the window layers.
    assert_eq!(s.cells(65536), (65536, 4608));
    // The numbers of the A21 report: 4.1 / 4.8 / 6.0 / 8.5 GiB at f16.
    let gib = |ctx| s.cache_bytes(&CacheConfig::new(ctx, "f16", "f16", "auto")) as f64 / GIB as f64;
    assert_eq!(format!("{:.1} {:.1} {:.1} {:.1}", gib(8192), gib(16384), gib(32768), gib(65536)), "4.1 4.8 6.0 8.5");
}

#[test]
fn an_mla_model_keeps_only_its_latent_key_and_a_hybrid_only_its_attention_layers() {
    let glm = shape_of("glm-4.7-flash-Q4_K_M");
    assert!(glm.layers.iter().all(|l| l.v == 0), "MLA keeps no V");
    assert!(glm.layers.iter().all(|l| l.k == 576), "{:?}", glm.layers[0]);

    let q = shape_of("qwen3.5-27B-Q4_K_M");
    let attn = q.layers.iter().filter(|l| l.k > 0).count();
    let rec = q.layers.iter().filter(|l| l.state > 0).count();
    assert_eq!((attn, rec), (16, 48), "every fourth layer attends");
    // The Mac log of 802ccfe75: "recurrent state 599 MB".
    let state: u64 = q.layers.iter().map(|l| l.state).sum();
    assert_eq!(state / MIB, 598);

    let g = shape_of("granite-4.0-h-tiny-Q4_K_M");
    assert!(g.layers.iter().filter(|l| l.k > 0).count() < g.layers.len() / 4);
    assert!(g.is_moe());

    let oss = shape_of("gpt-oss-20b-MXFP4");
    assert_eq!(oss.window, Window::Sliding(128));
    assert_eq!(oss.layers.iter().filter(|l| l.swa).count(), oss.layers.len() / 2);
}

#[test]
fn a_dense_model_has_no_experts_and_an_moe_model_is_mostly_experts() {
    assert!(!shape_of("llama-3.1-8B-Instruct-Q4_K_M").is_moe());
    let q = shape_of("qwen3-30B-A3B-Q4_K_M");
    let w: u64 = q.layers.iter().map(|l| l.weights).sum();
    let e: u64 = q.layers.iter().map(|l| l.experts).sum();
    assert!(e * 10 > w * 9, "experts {e} of {w}");
}

// ── the start decision ───────────────────────────────────────────────────

fn req(ctx: u32, kv: &str, chosen: bool) -> Request {
    Request { cache: CacheConfig::new(ctx, kv, kv, "auto"), ctx_chosen: chosen, typed_layers: None }
}

fn pc(ram_gib: u64) -> Host {
    Host { total_ram: ram_gib * GIB, mac: false }
}

fn free(mib: u64) -> Card {
    Card::Measured(Budget { bytes: mib * MIB, free: true, learned_overhead: 0 })
}

/// The image part of the Discord report's gemma-4-31B, 1.2 GB BF16.
fn gemma31_part() -> ImagePart {
    ImagePart::from_head(manifest()["gemma-4-31B-mmproj-BF16"]["fileBytes"].as_u64().unwrap(), Some(&head_of("gemma-4-31B-mmproj-BF16")))
}

#[test]
fn an_image_part_is_priced_like_llama_cpp_prices_it() {
    // llama-server -lv 4 (b9949): "[mtmd] estimated worst-case memory usage
    // of mmproj is 1302.47 MiB" for gemma-4-31B's part.
    let p = gemma31_part();
    let total = (p.bytes + p.compute) / MIB;
    assert!((1302..=1340).contains(&total), "{total} MiB");
    // A part with pictures and sound: 359 MiB in llama.cpp's estimate.
    let both = ImagePart::from_head(manifest()["gemma4-12B-hauhau-mmproj-BF16"]["fileBytes"].as_u64().unwrap(), Some(&head_of("gemma4-12B-hauhau-mmproj-BF16")));
    let total = (both.bytes + both.compute) / MIB;
    assert!((359..=420).contains(&total), "{total} MiB");
    assert_eq!(ImagePart::of(0), ImagePart::default());
}

#[test]
fn discord_22_10_gemma_4_31b_at_64k_gets_more_layers_than_3_0_7_gave_and_the_advice_names_the_numbers() {
    // 22.10.2026: RTX 5070 Ti, 14092 MiB free, 32 GB RAM, 64K chosen, f16.
    // 3.0.7 put 22 of 60 layers on the card.
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    let d = decide(&s, &req(65536, "f16", true), free(14092), pc(32), gemma31_part(), Calibration::default());
    assert_eq!(d.ctx, 65536, "a chosen context is never changed");
    let ngl = d.ngl.expect("does not fit whole");
    assert!(ngl > 22 + 1, "more than 3.0.7's 22 layers: -ngl {ngl}");
    let plan = d.plan.unwrap();
    assert!(plan.card.total() <= (14092 - 768) * MIB, "{} MiB", plan.card.total() / MIB);
    let a = d.advice.expect("advice");
    assert!(a.text.starts_with("With 64K context, "), "{}", a.text);
    assert!(a.text.contains(" of 60 layers fit on the graphics card"), "{}", a.text);
    let labels: Vec<&str> = a.actions.iter().map(|x| x.label.as_str()).collect();
    assert!(labels.contains(&"KV q8_0"), "{labels:?}");
    assert!(labels.iter().any(|l| l.starts_with("Context ")), "{labels:?}");
    eprintln!("Discord 22.10. 64K f16: -ngl {ngl}; {}", a.text);
}

#[test]
fn at_8k_the_same_card_gets_fewer_layers_than_the_flat_rate_would_have_given() {
    // The flat 4 MiB per layer per 1K priced 8K at 1.9 GiB; it is 4.1. The
    // plan must not put more on the card than fits.
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    let d = decide(&s, &req(8192, "f16", true), free(14092), pc(32), gemma31_part(), Calibration::default());
    let plan = d.plan.unwrap();
    assert!(plan.card.total() <= (14092 - 768) * MIB);
    // The 3.0.7 formula: 18.3 GB file / 60 + 32 MiB per layer = 323 MiB, so
    // (14092 - 512 - 1143) / 323 = 38 layers. Truth is fewer.
    assert!(d.ngl.unwrap() < 38, "-ngl {:?}", d.ngl);
}

#[test]
fn the_default_context_is_raised_only_while_everything_still_fits() {
    let s = shape_of("qwen3-8B-Q4_K_M");
    // A 24 GB card with nothing on it: 8K becomes 32K, never more.
    let d = decide(&s, &req(8192, "f16", false), free(23_000), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!((d.ctx, d.ngl), (32768, None));
    assert!(d.why.contains("set to 32768, the most that fits"), "{}", d.why);
    // A 8 GB card: 5 GB of weights plus 1.1 GB of cache at 8K fits, 16K
    // (2.3 GB of cache) does not.
    let d = decide(&s, &req(8192, "f16", false), free(7_600), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!((d.ctx, d.ngl), (8192, None), "{}", d.why);
    // A chosen 8K stays 8K on the big card.
    let d = decide(&s, &req(8192, "f16", true), free(23_000), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!(d.ctx, 8192);
}

#[test]
fn an_moe_model_that_does_not_fit_keeps_every_layer_and_moves_experts() {
    let s = shape_of("qwen3-30B-A3B-Q4_K_M");
    let d = decide(&s, &req(8192, "f16", false), free(12_000), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!(d.ngl, None, "every layer: {}", d.why);
    assert!(d.cpu_moe > 0 && d.cpu_moe < s.n_layer(), "{}", d.cpu_moe);
    assert!(d.why.contains("--n-cpu-moe"), "{}", d.why);
    let plan = d.plan.unwrap();
    assert!(plan.card.total() <= (12_000 - 768) * MIB);
    // One layer's experts fewer would not fit.
    let tighter = s.split(Placement { ngl: s.all_layers(), cpu_moe: d.cpu_moe - 1, cpu_ffn: 0 }, &CacheConfig::new(8192, "f16", "f16", "auto"), &ImagePart::default());
    assert!(tighter.card.total() > (12_000 - 768) * MIB);
}

#[test]
fn a_part_that_would_push_a_fitting_model_off_the_card_is_left_out() {
    let s = shape_of("gemma-4-12b-it-Q4_K_M");
    let part = ImagePart::of(manifest()["gemma4-12B-hauhau-mmproj-BF16"]["fileBytes"].as_u64().unwrap());
    let with = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &CacheConfig::new(8192, "f16", "f16", "auto"), &part).card.total();
    let without = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &CacheConfig::new(8192, "f16", "f16", "auto"), &ImagePart::default()).card.total();
    // A card between the two.
    let card = (with + without) / 2 / MIB + 768;
    let d = decide(&s, &req(8192, "f16", true), free(card), pc(32), part, Calibration::default());
    assert_eq!((d.ngl, d.with_image_part), (None, false), "{}", d.why);
    assert!(d.why.contains("without image input"), "{}", d.why);
}

#[test]
fn a_typed_layer_count_and_a_machine_without_a_card_are_left_alone() {
    let s = shape_of("llama-3.1-8B-Instruct-Q4_K_M");
    let mut r = req(65536, "f16", true);
    r.typed_layers = Some(20);
    let d = decide(&s, &r, free(4_000), pc(16), ImagePart::default(), Calibration::default());
    assert_eq!((d.ngl, d.ctx, d.cpu_moe), (Some(20), 65536, 0));
    let d = decide(&s, &req(8192, "f16", false), Card::None, pc(16), ImagePart::default(), Calibration::default());
    assert_eq!((d.ngl, d.ctx), (None, 8192));
}

#[test]
fn a_mac_keeps_every_layer_raises_only_the_default_context_and_warns_with_numbers() {
    assert_eq!(mac_gpu_budget(32 * GIB, 0) / GIB, 21);
    assert_eq!(mac_gpu_budget(48 * GIB, 0) / GIB, 36);
    assert_eq!(mac_gpu_budget(48 * GIB, 40_000) / MIB, 40_000);
    // qwen3-8B at 64K on a 16 GB Mac: 4.4 GB of weights and 9 GB of cache
    // against the 10.7 GB Metal gives one program.
    let s = shape_of("qwen3-8B-Q4_K_M");
    let mac = Host { total_ram: 16 * GIB, mac: true };
    let d = decide(&s, &req(65536, "f16", true), Card::Unified { budget: mac_gpu_budget(16 * GIB, 0) }, mac, ImagePart::default(), Calibration::default());
    assert_eq!((d.ngl, d.ctx), (None, 65536));
    let a = d.advice.expect("advice");
    assert_eq!(a.text, "With 64K context this model needs about 14 GB, more than the 11 GB this Mac can give it without slowing down. 32K needs 9.0 GB.");
    assert!(a.actions.iter().any(|x| x.ctx == Some(32768)), "{:?}", a.actions);
    assert!(a.actions.iter().any(|x| x.kv == Some("q8_0")), "{:?}", a.actions);
    // 48 GB: the default 8K grows, nothing to say.
    let big = Host { total_ram: 48 * GIB, mac: true };
    let d = decide(&s, &req(8192, "f16", false), Card::Unified { budget: mac_gpu_budget(48 * GIB, 0) }, big, ImagePart::default(), Calibration::default());
    assert_eq!(d.ctx, 32768);
    assert!(d.advice.is_none());
}

#[test]
fn a_tight_ram_pc_caps_the_prompt_cache_and_says_so() {
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    let d = decide(&s, &req(65536, "f16", true), free(6_000), pc(32), ImagePart::default(), Calibration::default());
    let cap = d.cache_ram_mib.expect("capped");
    assert!((512..8192).contains(&cap), "{cap}");
    assert!(d.advice.unwrap().text.contains("RAM busy"));
}

#[test]
fn a_plan_that_came_out_low_is_corrected_by_what_the_engine_reported() {
    let s = shape_of("llama-3.1-8B-Instruct-Q4_K_M");
    let cfg = CacheConfig::new(8192, "f16", "f16", "auto");
    let plan = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &cfg, &ImagePart::default());
    let mut report = EngineReport { card: plan.card, host: plan.host, ..Default::default() };
    report.card.compute += 600 * MIB;
    let c = learn(&plan, &report, Some(10_000 * MIB), Some(10_000 * MIB - report.card.total() - 400 * MIB));
    assert_eq!(c.extra / MIB, 600);
    assert_eq!(c.overhead / MIB, 400);
    // Noise is not a lesson.
    report.card.compute = plan.card.compute + 40 * MIB;
    assert_eq!(learn(&plan, &report, None, None), Calibration::default());
}

#[test]
fn the_engine_report_is_read_from_llama_server_s_own_lines() {
    let text = "\
0.00.408.204 I load_tensors: offloaded 22/61 layers to GPU
0.00.408.205 I load_tensors:   CPU_Mapped model buffer size =   281.81 MiB
0.00.408.206 I load_tensors:        CUDA0 model buffer size =  6694.30 MiB
0.00.409.535 I llama_context:  CUDA_Host  output buffer size =     3.96 MiB
0.00.568.063 I llama_kv_cache:      CUDA0 KV buffer size =  3272.00 MiB
0.00.568.063 I llama_kv_cache:        CPU KV buffer size =  5448.00 MiB
0.00.820.739 I sched_reserve:      CUDA0 compute buffer size =   533.01 MiB
0.00.820.741 I sched_reserve:  CUDA_Host compute buffer size =    80.01 MiB
0.00.900.000 I clip_model_loader: model size:     1143.50 MiB
0.00.950.000 I reserve_compute_meta:      CUDA0 compute buffer size =   300.00 MiB
0.00.950.001 I reserve_compute_meta:        CPU compute buffer size =     6.77 MiB
";
    let r = parse_engine_report(text).expect("report");
    assert_eq!(r.offloaded, Some((22, 61)));
    assert_eq!(r.card.weights / MIB, 6694);
    assert_eq!(r.card.cache / MIB, 3272);
    assert_eq!(r.card.compute / MIB, 533);
    assert_eq!(r.host.cache / MIB, 5448);
    assert_eq!(r.host.weights / MIB, 281);
    assert_eq!(r.image_part / MIB, 1443);
    // The encoder's host buffer is not on the card, and its weights are
    // counted once however many encoders name them.
    let twice = format!("{text}0.01.000 I load_hparams: model size:     1143.50 MiB\n");
    assert_eq!(parse_engine_report(&twice).unwrap().image_part / MIB, 1443);
    assert!(parse_engine_report("srv  load_model: loading model\n").is_none());
}

#[test]
#[ignore = "prints the shape numbers the work buffer fit is made from"]
fn print_shapes_for_the_fit() {
    for name in MODELS {
        let s = shape_of(name);
        let kmax = s.layers.iter().map(|l| l.k).max().unwrap_or(0);
        let vmax = s.layers.iter().map(|l| l.v).max().unwrap_or(0);
        let max_tensor_layer = s.layers.iter().map(|l| l.weights).max().unwrap_or(0);
        let max_exp = s.layers.iter().map(|l| l.experts).max().unwrap_or(0);
        println!("LARGEST {name} {}", s.layers.iter().map(|l| l.largest).max().unwrap_or(0) / MIB);
        println!(
            "SHAPE {name} {{\"n_embd\":{},\"n_ff\":{},\"q_width\":{},\"n_vocab\":{},\"kmax\":{},\"vmax\":{},\"layer_max\":{},\"exp_max\":{},\"swa\":{},\"n_layer\":{},\"output\":{},\"input\":{}}}",
            s.n_embd, s.n_ff, s.q_width, s.n_vocab, kmax, vmax, max_tensor_layer, max_exp,
            match s.window { Window::Sliding(n) => n, Window::None => 0 }, s.n_layer(), s.output, s.input
        );
    }
}

#[test]
fn the_work_buffers_follow_what_llama_server_reported_and_err_high() {
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("server-compute-b9949-metal.json")).unwrap()).unwrap();
    let mut worst_low = 0i64;
    let mut n = 0;
    for name in MODELS {
        let Some(cases) = data["models"][*name].as_object() else { continue };
        let s = shape_of(name);
        for (key, v) in cases {
            let mut it = key.split('|');
            let ctx: u32 = it.next().unwrap().parse().unwrap();
            let kv = it.next().unwrap();
            let ngl: u32 = it.next().unwrap().parse().unwrap();
            // Metal does not copy a processor layer's cache to the card.
            let cfg = CacheConfig { offload_copies_cache: false, ..CacheConfig::new(ctx, kv, kv, "auto") };
            let (card, host) = s.compute_bytes_placed(Placement { ngl: ngl.min(s.all_layers()), cpu_moe: 0, cpu_ffn: 0 }, &cfg);
            let want_card = v[0].as_f64().unwrap() as i64;
            let want_host = v[1].as_f64().unwrap() as i64;
            for (what, got, want) in [("card", (card / MIB) as i64, want_card), ("host", (host / MIB) as i64, want_host)] {
                // With every layer on the processor nothing is planned for
                // the card; whether ggml still borrows it for a long prompt
                // differs between backends and models.
                if what == "card" && ngl == 0 {
                    continue;
                }
                let low = want - got;
                worst_low = worst_low.max(low);
                assert!(low <= 24, "{name} {key} {what}: plan {got} MiB, llama-server {want} MiB (too low)");
                let high = got - want;
                // Too high costs a layer on the card or some RAM, never the
                // start; the card side is held closer than the host side.
                let room = if what == "card" { 96.max(want / 2) } else { 160.max(want) };
                assert!(high <= room, "{name} {key} {what}: plan {got} MiB, llama-server {want} MiB (far too high)");
                n += 1;
            }
        }
    }
    assert!(n >= 250, "{n} cases");
    eprintln!("work buffers: {n} cases, worst underestimate {worst_low} MiB");
}

#[test]
fn a_card_only_its_total_is_known_of_gets_no_layer_numbers_in_the_advice() {
    // AMD and Intel on Windows and Linux: llama.cpp's own fit picks the
    // layers there (GH #156), so the advice must not promise a count.
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    let total = Card::Measured(Budget { bytes: 16_368 * MIB, free: false, learned_overhead: 0 });
    let d = decide(&s, &req(65536, "f16", true), total, pc(64), ImagePart::default(), Calibration::default());
    assert!(d.advice.is_none(), "{:?}", d.advice);
    // And the default context is not raised against a total either.
    let d = decide(&shape_of("qwen3-8B-Q4_K_M"), &req(8192, "f16", false), Card::Measured(Budget { bytes: 24_000 * MIB, free: false, learned_overhead: 0 }), pc(64), ImagePart::default(), Calibration::default());
    assert_eq!(d.ctx, 8192);
}

#[test]
fn a_context_nobody_chose_is_as_much_as_fits_between_its_floor_and_32k() {
    // Up while everything fits.
    assert_eq!(auto_ctx(8192, 131072, |_| true), 32768);
    // The trained context is the ceiling.
    assert_eq!(auto_ctx(8192, 16384, |_| true), 16384);
    // Down to the house default, never below.
    assert_eq!(auto_ctx(8192, 131072, |c| c <= 8192), 8192);
    assert_eq!(auto_ctx(8192, 131072, |_| false), 8192);
    // The agent mode's 32K: lowered to what fits, never below 16K.
    assert_eq!(auto_ctx(32768, 131072, |c| c <= 16384), 16384);
    assert_eq!(auto_ctx(32768, 131072, |_| false), 16384);
    assert_eq!(auto_ctx(32768, 131072, |_| true), 32768);
    // A model trained for less than the default keeps its own.
    assert_eq!(auto_ctx(4096, 4096, |_| true), 4096);
}

#[test]
fn an_agent_raise_that_would_cost_layers_is_lowered_and_a_chosen_context_is_not() {
    // gemma-4-31B on the 16 GB card of the Discord report: the agent mode's
    // 32K does not fit whole, nor does 16K, so the plan takes the floor.
    let s = shape_of("gemma-4-31B-it-Q4_K_M");
    let d = decide(&s, &req(32768, "f16", false), free(14092), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!(d.ctx, 16384, "{}", d.why);
    let d = decide(&s, &req(32768, "f16", true), free(14092), pc(32), ImagePart::default(), Calibration::default());
    assert_eq!(d.ctx, 32768);
}

#[test]
fn on_vulkan_and_cuda_a_partial_offload_pays_for_a_processor_layer_s_cache_on_the_card() {
    // RTX 3060, Vulkan, Qwen3-4B at 64K with 34 of 37 layers on the card:
    // the work buffer was 479 MiB, not the 83 of a full offload, because the
    // attention of the processor layers ran on the card with their cache.
    let s = shape_of("llama-3.1-8B-Instruct-Q4_K_M");
    let vulkan = CacheConfig { offload_copies_cache: true, ..CacheConfig::new(65536, "f16", "f16", "auto") };
    let metal = CacheConfig { offload_copies_cache: false, ..vulkan };
    let part = Placement { ngl: 20, cpu_moe: 0, cpu_ffn: 0 };
    let layer = s.layer_cache(0, &vulkan);
    let (v, _) = s.compute_bytes_placed(part, &vulkan);
    let (m, _) = s.compute_bytes_placed(part, &metal);
    assert_eq!(v - m, layer + 64 * MIB);
    // Every layer on the card: nothing to copy.
    let all = Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 };
    assert_eq!(s.compute_bytes_placed(all, &vulkan), s.compute_bytes_placed(all, &metal));
}

// ── dense models: FFN weights in RAM instead of whole layers (--n-cpu-ffn) ──

#[test]
fn the_dense_ffn_weights_are_read_from_the_head_and_experts_are_not() {
    let dense = shape_of("qwen3-8B-Q4_K_M");
    assert!(!dense.is_moe());
    assert!(dense.layers.iter().all(|l| l.ffn > 0 && l.ffn < l.weights));
    let moe = shape_of("qwen3-30B-A3B-Q4_K_M");
    assert!(moe.is_moe());
    assert!(moe.layers.iter().all(|l| l.ffn + l.experts <= l.weights));
}

#[test]
fn the_ffn_split_keeps_every_layer_and_moves_as_few_as_fit() {
    let s = shape_of("qwen3.5-27B-Q4_K_M");
    let cfg = CacheConfig::new(8192, "f16", "f16", "auto");
    let none = ImagePart::default();
    let whole = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &cfg, &none).card.total();
    let usable = whole - whole / 6;
    let p = place_with(&s, &cfg, &none, usable, true);
    assert_eq!((p.ngl, p.cpu_moe), (s.all_layers(), 0));
    assert!(p.cpu_ffn > 0 && p.cpu_ffn <= s.n_layer());
    assert!(s.split(p, &cfg, &none).card.total() <= usable);
    let fewer = Placement { cpu_ffn: p.cpu_ffn - 1, ..p };
    assert!(s.split(fewer, &cfg, &none).card.total() > usable);
    // Moving weights moves bytes, it does not make any.
    let (a, b) = (s.split(p, &cfg, &none), s.split(Placement { cpu_ffn: 0, ..p }, &cfg, &none));
    assert_eq!(a.card.weights + a.host.weights, b.card.weights + b.host.weights);
}

#[test]
fn with_the_split_off_a_dense_model_moves_whole_layers_as_before() {
    let s = shape_of("qwen3.5-27B-Q4_K_M");
    let cfg = CacheConfig::new(8192, "f16", "f16", "auto");
    let none = ImagePart::default();
    let whole = s.split(Placement { ngl: s.all_layers(), cpu_moe: 0, cpu_ffn: 0 }, &cfg, &none).card.total();
    let p = place_with(&s, &cfg, &none, whole - whole / 6, false);
    assert_eq!(p.cpu_ffn, 0);
    assert!(p.ngl < s.all_layers());
}

#[test]
fn the_ffn_split_never_touches_an_moe_model_or_one_that_fits() {
    let cfg = CacheConfig::new(8192, "f16", "f16", "auto");
    let none = ImagePart::default();
    let moe = shape_of("qwen3-30B-A3B-Q4_K_M");
    let p = place_with(&moe, &cfg, &none, 11_000 * MIB, true);
    assert_eq!(p.cpu_ffn, 0);
    assert!(p.cpu_moe > 0);
    let dense = shape_of("qwen3-8B-Q4_K_M");
    let p = place_with(&dense, &cfg, &none, 64_000 * MIB, true);
    assert_eq!(p, Placement { ngl: dense.all_layers(), cpu_moe: 0, cpu_ffn: 0 });
}

#[test]
fn a_model_far_too_big_for_the_card_is_told_of_a_better_file() {
    let s = shape_of("qwen3.5-27B-Q4_K_M");
    let cfg = CacheConfig::new(8192, "q8_0", "q8_0", "auto");
    let none = ImagePart::default();
    let usable = 4_000 * MIB;
    let p = place(&s, &cfg, &none, usable);
    let plan = s.split(p, &cfg, &none);
    let r = Request { cache: cfg, typed_layers: None, ctx_chosen: true };
    let a = card_advice(&s, &r, &cfg, &none, usable, p, &plan, pc(64));
    assert!(a.text.contains("smaller quantization"), "{}", a.text);
    assert!(!a.text.trim_end().ends_with("for you."), "{}", a.text);
}
