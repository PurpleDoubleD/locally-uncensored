//! Which card each service runs on (3.0.8, A2, .molot's two-GPU wish).
//!
//! The Hardware tab had one pick for everything: the same
//! CUDA_VISIBLE_DEVICES went to Ollama, to the LU Engine and to ComfyUI, so a
//! video and the chat always shared a card. A role pins one service to one
//! card:
//!
//!   * `comfy`: ComfyUI. Forwarded as the vendor's visibility variable
//!     (`apply_gpu_env`), the same way the global pick always was. ComfyUI's
//!     torch reads it on import, and with a single visible card it calls that
//!     card `cuda:0`, so nothing else has to know.
//!   * `chat`: Ollama and the LU Engine. Ollama gets the visibility variable
//!     like ComfyUI. The LU Engine is a Vulkan build on Windows and Linux
//!     (scripts/build-llama.sh), and Vulkan does not read CUDA_VISIBLE_DEVICES
//!     at all. It gets `--device VulkanN` instead, where N is found by asking
//!     the engine itself (`--list-devices`) and matching the card by name.
//!
//! No role set: the global pick applies exactly as before 3.0.8, which is
//! what every machine with one card gets, since the Hardware tab only offers
//! roles with two or more cards.
//!
//! Card order. nvidia-smi numbers the cards in PCI bus order; CUDA's own
//! default is fastest first, and Vulkan numbers them in whatever order the
//! loader enumerates them. Three orders for the same two cards, and on
//! Windows they do differ. So nothing here passes a bare number across
//! orders: CUDA gets the card's UUID (`cuda_visible_devices_value`, with
//! CUDA_DEVICE_ORDER=PCI_BUS_ID as the fallback net), Vulkan gets the device
//! whose name is the card's name. Two cards of the same model are told apart
//! by their position among the cards of that name, in both lists, which holds
//! as long as the Vulkan loader keeps two identical cards in bus order. It
//! is the one assumption left, and the log line of every start says which
//! device it picked, so a wrong pick is visible in the first support log.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::gpu::{names_agree, DetectedGpu, GpuSelection};
use crate::state::AppState;

/// One card, as the Hardware tab detected it. `index` is vendor-scoped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuRef {
    pub vendor: String,
    pub index: u32,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuRoles {
    #[serde(default)]
    pub chat: Option<GpuRef>,
    #[serde(default)]
    pub comfy: Option<GpuRef>,
    /// 3.1.0 (C56): one picture or video model across two cards. Set, it
    /// wins over `comfy` for ComfyUI: ComfyUI sees both cards, `model` first.
    #[serde(default, rename = "comfySplit", alias = "comfy_split")]
    pub comfy_split: Option<ComfySplit>,
}

/// One ComfyUI over two cards (3.1.0, C56).
///
/// ComfyUI gets both cards, `model` first, so torch calls it `cuda:0` and
/// ComfyUI's own default device: the diffusion model and the sampling stay
/// there. `helper` becomes `cuda:1`, which ComfyUI's own nodes call `gpu:1`;
/// the app puts ComfyUI's core nodes "Select CLIP Device" and "Select VAE
/// Device" (comfy_extras/nodes_multigpu.py, in ComfyUI since 0.42) with
/// `gpu:1` behind every text encoder and VAE loader of a workflow
/// (src/lib/comfy-split.ts). No custom node, no foreign code.
///
/// NVIDIA only: the order of two cards is pinned by their UUIDs in
/// CUDA_VISIBLE_DEVICES, which nothing guarantees for HIP or oneAPI, and on
/// Windows ComfyUI forces a single card unless CUDA_VISIBLE_DEVICES is set
/// (main.py), which this sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComfySplit {
    /// The diffusion model and the sampling.
    pub model: GpuRef,
    /// The text encoder and the VAE.
    pub helper: GpuRef,
}

impl ComfySplit {
    /// Two different NVIDIA cards; anything else is no split.
    pub fn usable(&self) -> bool {
        self.model.vendor == "nvidia" && self.helper.vendor == "nvidia" && self.model.index != self.helper.index
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuRole {
    /// Ollama, the LU Engine and its embedding server.
    Chat,
    /// ComfyUI.
    Comfy,
}

fn known_vendor(v: &str) -> bool {
    matches!(v, "nvidia" | "amd" | "intel")
}

impl GpuRoles {
    fn get(&self, role: GpuRole) -> Option<&GpuRef> {
        let r = match role {
            GpuRole::Chat => self.chat.as_ref(),
            GpuRole::Comfy => self.comfy.as_ref(),
        };
        r.filter(|r| known_vendor(&r.vendor))
    }

    /// The split, when it can be applied.
    pub fn split(&self) -> Option<&ComfySplit> {
        self.comfy_split.as_ref().filter(|s| s.usable())
    }
}

/// What a service is started with: its role's card when one is set, the
/// global pick otherwise. Pure, so the whole matrix is a unit test.
pub fn selection_for_role(role: GpuRole, global: &GpuSelection, roles: &GpuRoles) -> GpuSelection {
    // C56: the split gives ComfyUI both cards, the model card first. The
    // order is the point: it is what makes the model card `cuda:0`.
    if role == GpuRole::Comfy {
        if let Some(split) = roles.split() {
            return GpuSelection { vendor: "nvidia".into(), indices: vec![split.model.index, split.helper.index] };
        }
    }
    match roles.get(role) {
        Some(card) => GpuSelection { vendor: card.vendor.clone(), indices: vec![card.index] },
        None => global.clone(),
    }
}

/// The selection for one service, read from the app state. The locks are
/// held only for the clone, never across `apply_gpu_env`, which may shell out
/// (the B2 rule in gpu.rs).
pub fn effective_selection(state: &AppState, role: GpuRole) -> Option<GpuSelection> {
    let global = state.gpu_selection.lock().ok().map(|s| s.clone())?;
    let roles = state.gpu_roles.lock().ok().map(|r| r.clone()).unwrap_or_default();
    Some(selection_for_role(role, &global, &roles))
}

/// The split, when one is set and usable.
pub fn comfy_split(state: &AppState) -> Option<ComfySplit> {
    state.gpu_roles.lock().ok().and_then(|r| r.split().cloned())
}

/// The ComfyUI line of the readout when the split is on, in words.
pub fn split_note(split: &ComfySplit) -> String {
    format!(
        "One model across two cards: the diffusion model on #{} {}, text encoders and VAE on #{} {} (ComfyUI calls it gpu:1).",
        split.model.index, split.model.name, split.helper.index, split.helper.name
    )
}

/// The chat role's card, when one is set.
pub fn chat_card(state: &AppState) -> Option<GpuRef> {
    state.gpu_roles.lock().ok().and_then(|r| r.get(GpuRole::Chat).cloned())
}

#[tauri::command]
pub fn set_gpu_roles(state: State<'_, AppState>, roles: GpuRoles) -> Result<(), String> {
    {
        let mut r = state.gpu_roles.lock().map_err(|e| e.to_string())?;
        *r = roles.clone();
    }
    // A device found for the old pick must not be reused for the new one.
    clear_device_cache();
    persist_pick(CONFIG_KEY_ROLES, &roles);
    Ok(())
}

// ── The picks across a restart ─────────────────────────────────────────
//
// Until 3.1.0 both picks lived only in memory and came down from the
// frontend after the window loaded. The boot path starts ComfyUI and Ollama
// before that (lib.rs, auto_start_*), and neither start applied a card at all,
// so "Card per task" (3.0.8) never reached a ComfyUI or an Ollama that LU
// started together with itself; LU's own ComfyUI install turns that
// autostart on. Now every pick is also written to config.json, read back
// into AppState when the app starts, and both boot starts apply it the same
// way the manual starts do. The frontend stays the source: its sync on every
// boot writes the same values again.

pub const CONFIG_KEY_SELECTION: &str = "gpu_selection";
pub const CONFIG_KEY_ROLES: &str = "gpu_roles";

/// The picks stored in a config.json value. Anything missing or unreadable
/// is "no pick", which is what a machine that never set one has.
pub fn picks_from_config(config: &serde_json::Value) -> (GpuSelection, GpuRoles) {
    let selection = config
        .get(CONFIG_KEY_SELECTION)
        .and_then(|v| serde_json::from_value::<GpuSelection>(v.clone()).ok())
        .unwrap_or_default();
    let roles = config
        .get(CONFIG_KEY_ROLES)
        .and_then(|v| serde_json::from_value::<GpuRoles>(v.clone()).ok())
        .unwrap_or_default();
    (selection, roles)
}

/// The picks stored in the config file at `path`.
pub fn picks_from_file(path: &std::path::Path) -> (GpuSelection, GpuRoles) {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(|v| picks_from_config(&v))
        .unwrap_or_default()
}

/// The picks of this install, for AppState at startup.
pub fn load_persisted_picks() -> (GpuSelection, GpuRoles) {
    picks_from_file(&crate::os_paths::app_config_json())
}

/// Write one pick into the config file at `path`, only when it changed (the
/// frontend sends both on every boot). Other keys stay as they are.
pub fn persist_pick_in<T: Serialize>(path: &std::path::Path, key: &str, value: &T) {
    let Ok(value) = serde_json::to_value(value) else { return };
    let mut config = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if config.get(key) == Some(&value) {
        return;
    }
    config[key] = value;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(&config).unwrap_or_default());
}

pub fn persist_pick<T: Serialize>(key: &str, value: &T) {
    persist_pick_in(&crate::os_paths::app_config_json(), key, value);
}

/// Put the card of `role` on a command about to start ComfyUI (`Comfy`) or
/// Ollama (`Chat`). The one place both the manual and the boot starts go
/// through, so the two can no longer drift apart. Returns the split when it
/// applies, for the start log.
pub fn apply_role_env(state: &AppState, role: GpuRole, cmd: &mut std::process::Command) -> Option<ComfySplit> {
    // The roles are cloned out of their lock inside effective_selection;
    // apply_gpu_env may run nvidia-smi and must never hold a lock (B2).
    let selection = effective_selection(state, role);
    let split = if role == GpuRole::Comfy { comfy_split(state) } else { None };
    if let Some(sel) = selection {
        crate::commands::gpu::apply_gpu_env(cmd, &sel);
    }
    split
}

#[tauri::command]
pub fn get_gpu_roles(state: State<'_, AppState>) -> Result<GpuRoles, String> {
    let r = state.gpu_roles.lock().map_err(|e| e.to_string())?;
    Ok(r.clone())
}

// ── The LU Engine's device ─────────────────────────────────────────────

/// One line of `llama-server --list-devices`:
/// `  Vulkan1: NVIDIA GeForce RTX 3060 (12288 MiB, 11873 MiB free)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlamaDevice {
    /// What `--device` takes: `Vulkan1`, `CUDA0`.
    pub id: String,
    pub description: String,
    pub total_mib: u64,
    pub free_mib: u64,
}

/// Read the device list llama.cpp prints (common/arg.cpp, `--list-devices`).
/// Lines that do not have the shape are skipped, so a header, a driver
/// warning on stdout or a future extra line cannot break it.
pub fn parse_list_devices(raw: &str) -> Vec<LlamaDevice> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (id, rest) = line.split_once(": ")?;
            if id.is_empty() || id.contains(char::is_whitespace) {
                return None;
            }
            // The memory part is the LAST parenthesis: a card name can hold
            // one of its own ("Radeon(TM)").
            let open = rest.rfind(" (")?;
            let description = rest[..open].trim().to_string();
            let mem = rest[open + 2..].strip_suffix(')')?;
            let (total, free) = mem.split_once(", ")?;
            let total_mib: u64 = total.strip_suffix(" MiB")?.trim().parse().ok()?;
            let free_mib: u64 = free.strip_suffix(" MiB free")?.trim().parse().ok()?;
            Some(LlamaDevice { id: id.to_string(), description, total_mib, free_mib })
        })
        .collect()
}

/// Which engine device is the chosen card.
///
/// By name first: the device whose description is the card's name. Two
/// devices of that name (two identical cards): the one at the card's position
/// among the detected cards of that name, both lists in their own order (see
/// the module comment for the one assumption this makes). `same_vendor` is the
/// detected cards of the card's vendor, used only to work out that position.
///
/// No device of that name at all: `Err` with the reason, and the caller starts
/// the engine without a pin rather than on a guessed card.
pub fn pick_llama_device<'a>(card: &GpuRef, same_vendor: &[DetectedGpu], devices: &'a [LlamaDevice]) -> Result<&'a LlamaDevice, String> {
    let name = if card.name.trim().is_empty() {
        same_vendor.iter().find(|g| g.index == card.index).map(|g| g.name.clone()).unwrap_or_default()
    } else {
        card.name.clone()
    };
    if name.trim().is_empty() {
        return Err(format!("the chosen card ({} #{}) has no name to look for", card.vendor, card.index));
    }
    let candidates: Vec<&LlamaDevice> = devices.iter().filter(|d| names_agree(&d.description, &name)).collect();
    match candidates.len() {
        0 => Err(format!(
            "no engine device is called \"{name}\" (the engine sees: {})",
            if devices.is_empty() {
                "nothing".to_string()
            } else {
                devices.iter().map(|d| format!("{} {}", d.id, d.description)).collect::<Vec<_>>().join(", ")
            }
        )),
        1 => Ok(candidates[0]),
        _ => {
            let mut twins: Vec<&DetectedGpu> = same_vendor.iter().filter(|g| names_agree(&g.name, &name)).collect();
            twins.sort_by_key(|g| g.index);
            let rank = twins.iter().position(|g| g.index == card.index).ok_or_else(|| {
                format!("{} cards are called \"{name}\" and the chosen one (#{}) was not among the detected ones", candidates.len(), card.index)
            })?;
            candidates.get(rank).copied().ok_or_else(|| {
                format!("the chosen card is number {} of the cards called \"{name}\", the engine sees only {}", rank + 1, candidates.len())
            })
        }
    }
}

/// Whether `pick_llama_device` needs the detected cards: only to tell two
/// devices of the same name apart, or to find the name of a card stored
/// without one. The full sweep costs seconds on an AMD or Intel box.
pub fn needs_detection(card: &GpuRef, devices: &[LlamaDevice]) -> bool {
    card.name.trim().is_empty() || devices.iter().filter(|d| names_agree(&d.description, &card.name)).count() > 1
}

/// The engine device found for a card, kept for the life of the process: the
/// card's name does not change, and every start would otherwise pay one more
/// engine launch. Keyed by the binary and the card, cleared on a new pick.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheKey {
    binary: String,
    card: GpuRef,
}

static DEVICE_CACHE: std::sync::Mutex<Option<(CacheKey, String)>> = std::sync::Mutex::new(None);

pub fn clear_device_cache() {
    if let Ok(mut c) = DEVICE_CACHE.lock() {
        *c = None;
    }
}

pub fn cached_device(binary: &str, card: &GpuRef) -> Option<String> {
    let c = DEVICE_CACHE.lock().ok()?;
    let (key, id) = c.as_ref()?;
    (key.binary == binary && &key.card == card).then(|| id.clone())
}

pub fn remember_device(binary: &str, card: &GpuRef, id: &str) {
    if let Ok(mut c) = DEVICE_CACHE.lock() {
        *c = Some((CacheKey { binary: binary.to_string(), card: card.clone() }, id.to_string()));
    }
}

/// The detected cards of one vendor. NVIDIA through nvidia-smi alone (fast,
/// and the only probe its index means anything in), the others through the
/// full sweep.
pub fn detected_of_vendor(vendor: &str) -> Vec<DetectedGpu> {
    if vendor == "nvidia" {
        return crate::commands::gpu::detect_nvidia_cards();
    }
    crate::commands::gpu::detect_gpus()
        .unwrap_or_default()
        .into_iter()
        .filter(|g| g.vendor == vendor)
        .collect()
}

// ── What the Hardware tab shows ────────────────────────────────────────

/// What a service will be started with, in words, for the readout under the
/// role pickers and for a support log.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RolePlan {
    pub service: String,
    /// The environment variables the service gets, `NAME=value`.
    pub env: Vec<String>,
    /// Extra arguments (the LU Engine's `--device`).
    pub args: Vec<String>,
    /// Set when the pick cannot be applied to this service, said plainly.
    pub note: Option<String>,
}

/// The env a selection produces, without spawning anything: `apply_gpu_env`
/// on a throwaway command, read back.
pub fn env_of(selection: &GpuSelection) -> Vec<String> {
    let mut cmd = crate::process_util::hidden_command("lu-gpu-plan-never-run");
    crate::commands::gpu::apply_gpu_env(&mut cmd, selection);
    let mut out: Vec<String> = cmd
        .get_envs()
        .filter_map(|(k, v)| v.map(|v| format!("{}={}", k.to_string_lossy(), v.to_string_lossy())))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(index: u32, name: &str) -> DetectedGpu {
        DetectedGpu {
            index,
            vendor: "nvidia".into(),
            name: name.into(),
            memory_mib: Some(12288),
            source: "nvidia-smi".into(),
            note: None,
            note_severity: None,
            arch: None,
            uuid: Some(format!("GPU-{index}{index}{index}")),
            shared_memory_mib: None,
        }
    }

    fn card(index: u32, name: &str) -> GpuRef {
        GpuRef { vendor: "nvidia".into(), index, name: name.into() }
    }

    /// `--list-devices` of a machine with two different cards, in the order
    /// the Vulkan loader found them: the SMALLER card first, the opposite of
    /// nvidia-smi's bus order on this simulated box.
    const TWO_DIFFERENT: &str = "\
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (NVIDIA) | uma: 0 | fp16: 1 | warp size: 32
ggml_vulkan: 1 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | fp16: 1 | warp size: 32
Available devices:
  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11873 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4090 (24564 MiB, 23020 MiB free)
";

    #[test]
    fn the_device_list_is_read_and_its_noise_is_skipped() {
        let d = parse_list_devices(TWO_DIFFERENT);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], LlamaDevice { id: "Vulkan0".into(), description: "NVIDIA GeForce RTX 3060".into(), total_mib: 12288, free_mib: 11873 });
        assert_eq!(d[1].id, "Vulkan1");
        assert_eq!(d[1].free_mib, 23020);
    }

    #[test]
    fn a_name_with_its_own_parenthesis_keeps_it() {
        let d = parse_list_devices("  Vulkan0: AMD Radeon(TM) RX 7900 XTX (24560 MiB, 24000 MiB free)\n");
        assert_eq!(d[0].description, "AMD Radeon(TM) RX 7900 XTX");
        assert_eq!(d[0].total_mib, 24560);
    }

    #[test]
    fn nothing_listed_is_an_empty_list_not_a_panic() {
        assert!(parse_list_devices("").is_empty());
        assert!(parse_list_devices("Available devices:\n").is_empty());
        assert!(parse_list_devices("error: unknown argument: --list-devices\n").is_empty());
    }

    /// The Windows order case: nvidia-smi says #0 = 4090 (bus order), Vulkan
    /// lists the 3060 first. A bare index would put the chat on the wrong card.
    #[test]
    fn two_different_cards_are_matched_by_name_not_by_number() {
        let detected = [gpu(0, "NVIDIA GeForce RTX 4090"), gpu(1, "NVIDIA GeForce RTX 3060")];
        let devices = parse_list_devices(TWO_DIFFERENT);
        let picked = pick_llama_device(&card(0, "NVIDIA GeForce RTX 4090"), &detected, &devices).unwrap();
        assert_eq!(picked.id, "Vulkan1");
        let picked = pick_llama_device(&card(1, "NVIDIA GeForce RTX 3060"), &detected, &devices).unwrap();
        assert_eq!(picked.id, "Vulkan0");
    }

    #[test]
    fn two_identical_cards_are_told_apart_by_their_position() {
        let detected = [gpu(0, "NVIDIA GeForce RTX 3090"), gpu(1, "NVIDIA GeForce RTX 3090")];
        let devices = parse_list_devices(
            "  Vulkan0: NVIDIA GeForce RTX 3090 (24576 MiB, 24000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 3090 (24576 MiB, 20000 MiB free)\n",
        );
        assert_eq!(pick_llama_device(&card(0, "NVIDIA GeForce RTX 3090"), &detected, &devices).unwrap().id, "Vulkan0");
        assert_eq!(pick_llama_device(&card(1, "NVIDIA GeForce RTX 3090"), &detected, &devices).unwrap().id, "Vulkan1");
    }

    #[test]
    fn an_integrated_gpu_in_the_list_does_not_shift_the_match() {
        let detected = [gpu(0, "NVIDIA GeForce RTX 3060"), gpu(1, "NVIDIA GeForce RTX 3060")];
        let devices = parse_list_devices(
            "  Vulkan0: Intel(R) UHD Graphics 770 (16000 MiB, 15000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 3060 (12288 MiB, 12000 MiB free)\n  Vulkan2: NVIDIA GeForce RTX 3060 (12288 MiB, 12000 MiB free)\n",
        );
        assert_eq!(pick_llama_device(&card(1, "NVIDIA GeForce RTX 3060"), &detected, &devices).unwrap().id, "Vulkan2");
    }

    #[test]
    fn a_card_the_engine_does_not_see_is_an_error_not_a_guess() {
        let detected = [gpu(0, "NVIDIA GeForce RTX 4090")];
        let devices = parse_list_devices("  Vulkan0: AMD Radeon RX 6800 XT (16368 MiB, 16000 MiB free)\n");
        let err = pick_llama_device(&card(0, "NVIDIA GeForce RTX 4090"), &detected, &devices).unwrap_err();
        assert!(err.contains("RTX 4090") && err.contains("Vulkan0"), "{err}");
        assert!(pick_llama_device(&card(0, "x"), &detected, &[]).unwrap_err().contains("nothing"));
    }

    #[test]
    fn a_card_without_a_stored_name_is_looked_up_by_its_index() {
        let detected = [gpu(0, "NVIDIA GeForce RTX 4090"), gpu(1, "NVIDIA GeForce RTX 3060")];
        let devices = parse_list_devices(TWO_DIFFERENT);
        assert_eq!(pick_llama_device(&card(1, ""), &detected, &devices).unwrap().id, "Vulkan0");
    }

    #[test]
    fn no_role_keeps_the_global_pick_exactly() {
        let global = GpuSelection { vendor: "nvidia".into(), indices: vec![0, 1] };
        let none = GpuRoles::default();
        for role in [GpuRole::Chat, GpuRole::Comfy] {
            let s = selection_for_role(role, &global, &none);
            assert_eq!((s.vendor.as_str(), s.indices.as_slice()), ("nvidia", [0u32, 1].as_slice()));
        }
        let auto = GpuSelection::default();
        let s = selection_for_role(GpuRole::Comfy, &auto, &none);
        assert_eq!((s.vendor.as_str(), s.indices.len()), ("auto", 0));
    }

    #[test]
    fn each_service_gets_its_own_card() {
        let global = GpuSelection::default();
        let roles = GpuRoles { chat: Some(card(0, "A")), comfy: Some(card(1, "B")), ..Default::default() };
        assert_eq!(selection_for_role(GpuRole::Chat, &global, &roles).indices, vec![0]);
        assert_eq!(selection_for_role(GpuRole::Comfy, &global, &roles).indices, vec![1]);
        // One role set: the other service keeps the global pick.
        let only_comfy = GpuRoles { chat: None, comfy: Some(card(1, "B")), ..Default::default() };
        assert_eq!(selection_for_role(GpuRole::Chat, &global, &only_comfy).vendor, "auto");
        assert_eq!(selection_for_role(GpuRole::Comfy, &global, &only_comfy).indices, vec![1]);
    }

    fn split(model: u32, helper: u32) -> Option<ComfySplit> {
        Some(ComfySplit { model: card(model, "RTX 4090"), helper: card(helper, "RTX 5080") })
    }

    /// C56: the 4090 + 5080 machine from Discord, simulated. ComfyUI gets
    /// both UUIDs, the model card FIRST, whatever the bus order says.
    #[test]
    fn the_split_gives_comfyui_both_cards_model_card_first() {
        let global = GpuSelection::default();
        let roles = GpuRoles { comfy_split: split(1, 0), ..Default::default() };
        let s = selection_for_role(GpuRole::Comfy, &global, &roles);
        assert_eq!((s.vendor.as_str(), s.indices.as_slice()), ("nvidia", [1u32, 0].as_slice()));
        // The chat is not touched by the split.
        assert_eq!(selection_for_role(GpuRole::Chat, &global, &roles).vendor, "auto");
    }

    #[test]
    fn the_split_wins_over_the_comfy_card_and_leaves_the_chat_card() {
        let global = GpuSelection::default();
        let roles = GpuRoles { chat: Some(card(2, "C")), comfy: Some(card(1, "B")), comfy_split: split(0, 1) };
        assert_eq!(selection_for_role(GpuRole::Comfy, &global, &roles).indices, vec![0, 1]);
        assert_eq!(selection_for_role(GpuRole::Chat, &global, &roles).indices, vec![2]);
    }

    #[test]
    fn a_split_that_cannot_work_changes_nothing() {
        let global = GpuSelection { vendor: "nvidia".into(), indices: vec![0] };
        // The same card twice.
        let same = GpuRoles { comfy_split: split(0, 0), ..Default::default() };
        assert_eq!(selection_for_role(GpuRole::Comfy, &global, &same).indices, vec![0]);
        // Not NVIDIA.
        let amd = GpuRoles {
            comfy_split: Some(ComfySplit {
                model: GpuRef { vendor: "amd".into(), index: 0, name: "RX".into() },
                helper: GpuRef { vendor: "amd".into(), index: 1, name: "RX".into() },
            }),
            comfy: Some(GpuRef { vendor: "amd".into(), index: 1, name: "RX".into() }),
            ..Default::default()
        };
        let s = selection_for_role(GpuRole::Comfy, &global, &amd);
        assert_eq!((s.vendor.as_str(), s.indices.as_slice()), ("amd", [1u32].as_slice()), "the comfy card applies as before");
    }

    #[test]
    fn the_split_env_pins_the_order_without_an_nvidia_smi() {
        // No nvidia-smi on this test machine: the fallback is the bare
        // indices in the given order, plus the bus order net.
        let roles = GpuRoles { comfy_split: split(1, 0), ..Default::default() };
        let env = env_of(&selection_for_role(GpuRole::Comfy, &GpuSelection::default(), &roles));
        assert!(env.contains(&"CUDA_DEVICE_ORDER=PCI_BUS_ID".to_string()), "{env:?}");
        let cvd = env.iter().find(|e| e.starts_with("CUDA_VISIBLE_DEVICES=")).expect("CUDA_VISIBLE_DEVICES");
        let value = cvd.trim_start_matches("CUDA_VISIBLE_DEVICES=");
        let parts: Vec<&str> = value.split(',').collect();
        assert_eq!(parts.len(), 2, "{value}");
        if !parts[0].starts_with("GPU-") {
            assert_eq!(parts, ["1", "0"]);
        }
    }

    #[test]
    fn the_split_from_the_frontend_deserializes() {
        let r: GpuRoles = serde_json::from_str(
            r#"{"chat":null,"comfy":null,"comfySplit":{"model":{"vendor":"nvidia","index":0,"name":"RTX 4090"},"helper":{"vendor":"nvidia","index":1,"name":"RTX 5080"}}}"#,
        )
        .unwrap();
        assert_eq!(r.split().map(|s| (s.model.index, s.helper.index)), Some((0, 1)));
        // A roles value from 3.0.8 has no split at all.
        let old: GpuRoles = serde_json::from_str(r#"{"chat":null,"comfy":{"vendor":"nvidia","index":1}}"#).unwrap();
        assert_eq!(old.comfy_split, None);
        assert!(split_note(r.split().unwrap()).contains("gpu:1"));
    }

    /// The autostart fix: a pick written by set_gpu_* comes back after a
    /// restart, other config keys survive, garbage reads as "no pick".
    #[test]
    fn the_picks_survive_a_restart_through_config_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"comfyui_autostart":true,"comfyui_port":8188}"#).unwrap();
        let roles = GpuRoles { chat: Some(card(0, "RTX 4090")), comfy: Some(card(1, "RTX 3060")), ..Default::default() };
        let selection = GpuSelection { vendor: "nvidia".into(), indices: vec![0, 1] };
        persist_pick_in(&path, CONFIG_KEY_ROLES, &roles);
        persist_pick_in(&path, CONFIG_KEY_SELECTION, &selection);
        let (s, r) = picks_from_file(&path);
        assert_eq!(r, roles);
        assert_eq!((s.vendor.as_str(), s.indices.as_slice()), ("nvidia", [0u32, 1].as_slice()));
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["comfyui_autostart"], serde_json::json!(true), "other keys are kept");
        // The split too, under the frontend's name.
        let with_split = GpuRoles { comfy_split: split(1, 0), ..Default::default() };
        persist_pick_in(&path, CONFIG_KEY_ROLES, &with_split);
        assert!(std::fs::read_to_string(&path).unwrap().contains("comfySplit"));
        assert_eq!(picks_from_file(&path).1, with_split);
    }

    #[test]
    fn no_file_or_a_broken_one_is_no_pick() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r) = picks_from_file(&dir.path().join("missing.json"));
        assert_eq!((s.vendor.as_str(), s.indices.len(), r), ("auto", 0, GpuRoles::default()));
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, r#"{"gpu_roles":"nonsense","gpu_selection":{"vendor":5}}"#).unwrap();
        let (s, r) = picks_from_file(&bad);
        assert_eq!((s.vendor.as_str(), r), ("auto", GpuRoles::default()));
        // A config that is not an object is not overwritten into one silently
        // with lost keys: it was unreadable anyway, the pick starts it fresh.
        std::fs::write(&bad, "[]").unwrap();
        persist_pick_in(&bad, CONFIG_KEY_ROLES, &GpuRoles::default());
        assert!(serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&bad).unwrap()).unwrap().is_object());
    }

    /// The autostart path and the manual one put the same card on the
    /// command, because both go through apply_role_env.
    #[test]
    fn apply_role_env_puts_the_comfy_card_and_the_chat_card_on_the_command() {
        let state = AppState::new();
        *state.gpu_selection.lock().unwrap() = GpuSelection::default();
        *state.gpu_roles.lock().unwrap() =
            GpuRoles { chat: Some(GpuRef { vendor: "amd".into(), index: 0, name: "RX A".into() }), comfy: Some(GpuRef { vendor: "amd".into(), index: 1, name: "RX B".into() }), ..Default::default() };
        let env = |cmd: &std::process::Command| -> Vec<String> {
            let mut v: Vec<String> = cmd.get_envs().filter_map(|(k, v)| v.map(|v| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))).collect();
            v.sort();
            v
        };
        let mut comfy = std::process::Command::new("never-run");
        assert_eq!(apply_role_env(&state, GpuRole::Comfy, &mut comfy), None);
        assert!(env(&comfy).contains(&"HIP_VISIBLE_DEVICES=1".to_string()), "{:?}", env(&comfy));
        let mut chat = std::process::Command::new("never-run");
        apply_role_env(&state, GpuRole::Chat, &mut chat);
        assert!(env(&chat).contains(&"HIP_VISIBLE_DEVICES=0".to_string()), "{:?}", env(&chat));
        // With the split, ComfyUI gets both NVIDIA cards and says so.
        *state.gpu_roles.lock().unwrap() = GpuRoles { comfy_split: split(1, 0), ..Default::default() };
        let mut comfy = std::process::Command::new("never-run");
        assert!(apply_role_env(&state, GpuRole::Comfy, &mut comfy).is_some());
        assert!(env(&comfy).iter().any(|e| e.starts_with("CUDA_VISIBLE_DEVICES=")), "{:?}", env(&comfy));
        // No pick at all: no variable, exactly as before 3.0.8.
        *state.gpu_roles.lock().unwrap() = GpuRoles::default();
        let mut none = std::process::Command::new("never-run");
        apply_role_env(&state, GpuRole::Comfy, &mut none);
        assert!(env(&none).iter().all(|e| !e.contains("VISIBLE_DEVICES")), "{:?}", env(&none));
    }

    #[test]
    fn a_role_with_an_unknown_vendor_is_ignored() {
        let global = GpuSelection { vendor: "amd".into(), indices: vec![0] };
        let roles = GpuRoles { chat: Some(GpuRef { vendor: "apple".into(), index: 0, name: "M3".into() }), comfy: None, ..Default::default() };
        assert_eq!(selection_for_role(GpuRole::Chat, &global, &roles).vendor, "amd");
    }

    #[test]
    fn an_amd_role_is_forwarded_as_hip() {
        let roles = GpuRoles { chat: None, comfy: Some(GpuRef { vendor: "amd".into(), index: 1, name: "RX".into() }), ..Default::default() };
        let env = env_of(&selection_for_role(GpuRole::Comfy, &GpuSelection::default(), &roles));
        assert!(env.contains(&"HIP_VISIBLE_DEVICES=1".to_string()), "{env:?}");
        assert!(env.contains(&"ROCR_VISIBLE_DEVICES=1".to_string()), "{env:?}");
    }

    #[test]
    fn roles_from_the_frontend_deserialize_with_missing_parts() {
        let r: GpuRoles = serde_json::from_str(r#"{"chat":{"vendor":"nvidia","index":1}}"#).unwrap();
        assert_eq!(r.chat, Some(GpuRef { vendor: "nvidia".into(), index: 1, name: String::new() }));
        assert_eq!(r.comfy, None);
        let r: GpuRoles = serde_json::from_str(r#"{"chat":null,"comfy":null}"#).unwrap();
        assert_eq!(r, GpuRoles::default());
    }

    #[test]
    fn the_device_cache_answers_only_for_the_same_binary_and_card() {
        clear_device_cache();
        let a = card(0, "A");
        remember_device("/bin/llama", &a, "Vulkan1");
        assert_eq!(cached_device("/bin/llama", &a).as_deref(), Some("Vulkan1"));
        assert_eq!(cached_device("/bin/other", &a), None);
        assert_eq!(cached_device("/bin/llama", &card(1, "A")), None);
        clear_device_cache();
        assert_eq!(cached_device("/bin/llama", &a), None);
    }

    /// The pick on a real machine with two or more NVIDIA cards, through the
    /// same calls a start makes: nvidia-smi's cards, the engine's own
    /// `--list-devices`, `pick_llama_device` and the env ComfyUI would get.
    /// Ignored by default; the rented two-card run (A2) uses it:
    ///
    ///   LU_LIVE_ENGINE=/path/lu-llama-server LU_LIVE_OUT=/tmp/a2-pick.tsv \
    ///   cargo test --release live_every_card_finds_its_engine_device -- --ignored --nocapture
    ///
    /// LU_LIVE_OUT gets one line per card: index, name, uuid, device, env.
    #[test]
    #[ignore]
    fn live_every_card_finds_its_engine_device() {
        let engine = std::env::var("LU_LIVE_ENGINE").expect("LU_LIVE_ENGINE");
        let cards = crate::commands::gpu::detect_nvidia_cards();
        assert!(cards.len() >= 2, "nvidia-smi sees {} card(s), the run needs two", cards.len());
        let out = std::process::Command::new(&engine).arg("--list-devices").output().expect("the engine runs");
        let raw = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        println!("{raw}");
        let devices = parse_list_devices(&raw);
        let mut lines = Vec::new();
        let mut picked = Vec::new();
        for g in &cards {
            let card = GpuRef { vendor: "nvidia".into(), index: g.index, name: g.name.clone() };
            let device = pick_llama_device(&card, &cards, &devices).unwrap_or_else(|e| panic!("card {} {}: {e}", g.index, g.name));
            let env = env_of(&GpuSelection { vendor: "nvidia".into(), indices: vec![g.index] }).join(" ");
            println!("card {} {} ({}) -> --device {} / {env}", g.index, g.name, g.uuid.as_deref().unwrap_or("-"), device.id);
            lines.push(format!("{}\t{}\t{}\t{}\t{env}", g.index, g.name, g.uuid.as_deref().unwrap_or("-"), device.id));
            picked.push(device.id.clone());
        }
        picked.sort();
        picked.dedup();
        assert_eq!(picked.len(), cards.len(), "two cards were given the same engine device");
        if let Ok(path) = std::env::var("LU_LIVE_OUT") {
            std::fs::write(path, lines.join("\n") + "\n").expect("LU_LIVE_OUT is writable");
        }
    }
}
