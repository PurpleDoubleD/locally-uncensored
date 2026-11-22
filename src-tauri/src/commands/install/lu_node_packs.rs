//! Der Weg, auf dem der Chat ein Node-Paket nachziehen darf (C60-S5).
//!
//! `install_custom_node` nimmt jeden https-Link zu github, gitlab oder
//! codeberg, weil die Paketverwaltung in den Einstellungen einen Link des
//! Nutzers annehmen soll. Der Chat darf das nicht: ein Workflow aus dem Netz
//! oder eine Webseite könnte dem Modell sonst jedes Repo unterschieben, und
//! ein Klon führt `pip install -r requirements.txt` aus, also fremden Code.
//!
//! Deshalb nimmt dieser Befehl nur einen SCHLÜSSEL aus LUs eigener Liste.
//! Repo, Ordnername und Commit kommen aus der Tabelle unten, nie vom Aufrufer.
//! Die Tabelle ist eine Abschrift von `CUSTOM_NODE_REGISTRY`
//! (`src/api/model-bundles.ts`); ein vitest (`lu-node-packs-rust.test.ts`)
//! liest beide Dateien und wird rot, sobald sie auseinanderlaufen.

use tauri::State;

use crate::state::AppState;

/// Ein Paket der LU-Liste: Schlüssel, Repo, Ordnername, gepinnter Commit.
pub(crate) struct LuNodePack {
    pub key: &'static str,
    pub repo: &'static str,
    pub name: &'static str,
    pub commit: Option<&'static str>,
}

/// Abschrift von `CUSTOM_NODE_REGISTRY`, gleiche Reihenfolge.
pub(crate) const LU_NODE_PACKS: &[LuNodePack] = &[
    LuNodePack { key: "animatediff-evolved", repo: "https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved", name: "ComfyUI-AnimateDiff-Evolved", commit: None },
    LuNodePack { key: "cogvideox-wrapper", repo: "https://github.com/kijai/ComfyUI-CogVideoXWrapper", name: "ComfyUI-CogVideoXWrapper", commit: None },
    LuNodePack { key: "framepack-wrapper", repo: "https://github.com/kijai/ComfyUI-FramePackWrapper", name: "ComfyUI-FramePackWrapper", commit: None },
    LuNodePack { key: "pyramidflow-wrapper", repo: "https://github.com/kijai/ComfyUI-PyramidFlowWrapper", name: "ComfyUI-PyramidFlowWrapper", commit: None },
    LuNodePack { key: "allegro", repo: "https://github.com/bombax-xiaoice/ComfyUI-Allegro", name: "ComfyUI-Allegro", commit: None },
    LuNodePack { key: "videohelpersuite", repo: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", name: "ComfyUI-VideoHelperSuite", commit: None },
    LuNodePack { key: "rmbg", repo: "https://github.com/1038lab/ComfyUI-RMBG", name: "ComfyUI-RMBG", commit: Some("58f1947a11567a9f8b707223185570850e773856") },
    LuNodePack { key: "gguf", repo: "https://github.com/city96/ComfyUI-GGUF", name: "ComfyUI-GGUF", commit: Some("6ea2651e7df66d7585f6ffee804b20e92fb38b8a") },
    LuNodePack { key: "controlnet-aux", repo: "https://github.com/Fannovel16/comfyui_controlnet_aux", name: "comfyui_controlnet_aux", commit: Some("c2655d2970d810d8a3d71deed204cdf416b66132") },
];

/// Das Paket zu einem Schlüssel, oder die Ablehnung in Worten.
pub(crate) fn lu_node_pack(key: &str) -> Result<&'static LuNodePack, String> {
    LU_NODE_PACKS
        .iter()
        .find(|p| p.key == key)
        .ok_or_else(|| format!(
            "Refusing to install: \"{}\" is not in LU's own node pack list. Packs outside the list are installed by the user in Settings, ComfyUI node packs.",
            key.chars().take(64).collect::<String>()
        ))
}

/// Ein Paket der LU-Liste installieren, für den Chat. Nimmt nur den Schlüssel.
#[tauri::command]
pub async fn install_lu_node_pack(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    key: String,
) -> Result<serde_json::Value, String> {
    let pack = lu_node_pack(key.trim())?;
    super::custom_nodes::install_custom_node(
        state,
        app,
        pack.repo.to_string(),
        pack.name.to_string(),
        pack.commit.map(str::to_string),
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nimmt_nur_schluessel_der_liste() {
        assert_eq!(lu_node_pack("gguf").unwrap().name, "ComfyUI-GGUF");
        assert!(lu_node_pack("gguf").unwrap().commit.is_some());
        for fremd in [
            "https://github.com/evil/ComfyUI-Evil",
            "ComfyUI-Evil",
            "../gguf",
            "gguf ",
            "GGUF",
            "",
        ] {
            assert!(lu_node_pack(fremd).is_err(), "{fremd} darf nicht durch");
        }
    }

    #[test]
    fn jedes_paket_ist_ein_erlaubter_link() {
        for p in LU_NODE_PACKS {
            assert!(super::super::custom_node_packs::node_repo_from_url(p.repo).is_ok(), "{}", p.repo);
            if let Some(c) = p.commit {
                assert_eq!(c.len(), 40, "{}", p.key);
                assert!(c.chars().all(|ch| ch.is_ascii_hexdigit()), "{}", p.key);
            }
        }
    }
}
