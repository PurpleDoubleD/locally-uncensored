//! Alles, was LU für den Nutzer nachinstalliert — ComfyUI, Ollama, LM Studio,
//! Python, die Sprachpakete und die Custom Nodes.
//!
//! Diese Datei ist die öffentliche Fläche und sonst nichts: der Modulbaum,
//! der Re-Export der Namen, die früher direkt hier standen, und die eine
//! Konstante, die wirklich alle brauchen. Kein Aufrufer außerhalb dieses
//! Baums muss sich ändern — `crate::commands::install::…` führt weiterhin zu
//! jedem Symbol, das von dort gebraucht wird.
//!
//! Geschnitten wurde nach GETEILTEM ZUSTAND, nicht nach Themen. Drei Gruppen
//! ergeben sich daraus:
//!
//! * Das Werkzeug, das alle Installer benutzen: `pip` führt einen pip-Lauf
//!   durch und deutet sein Scheitern, `torch` wählt das PyTorch-Rad, `venv`
//!   weiß, welcher Python gemeint ist, `download` holt eine Datei und prüft
//!   sie vor der Ausführung, `git` beantwortet, ob geklont werden kann, und
//!   `children` führt Buch über die laufenden Kindprozesse.
//!
//! * ComfyUI, dessen drei Aufträge sich ein Verzeichnis und einen
//!   Statuskanal teilen: `comfy_job` hält das Schloss und die Bedienfläche,
//!   `comfy_install` baut neu, `comfy_repair` greift in Bestehendes ein.
//!
//! * Je ein Modul pro fremdem Produkt, das seinen eigenen `InstallState` hat:
//!   `ollama`, `lmstudio` (der laufende Dienst) und `lmstudio_install` (der
//!   Windows-Installer), `python`, `voice`, `custom_nodes`.
//!
//! Der Re-Export steht bewusst als Glob. Ein `#[tauri::command]` erzeugt
//! neben der Funktion ein gleichnamiges `__cmd__`-Makro, und `generate_handler!`
//! in `main.rs` sucht beides unter DIESEM Pfad — ein Glob nimmt beide mit,
//! ohne dass jeder Befehl zweimal aufgezählt werden muss.
//!
//! Sie steht auf `pub(crate)` und nicht auf `pub`, weil genau das ihre Aufgabe
//! ist: `main.rs`, `state.rs`, `tts.rs`, `whisper.rs` und `trainer.rs` sollen
//! `crate::commands::install::…` weiter auflösen können. Nach außen war
//! hier ohnehin nie etwas erreichbar — dies ist eine Binärkiste ohne
//! lib-Ziel —, und ein `pub` hätte die gemessene öffentliche Fläche um eine
//! Zeile wachsen lassen, ohne dass ein einziges Symbol dazugekommen wäre.
//!
//! Zwei Module fehlen in dieser Liste, und zwar mit Absicht: `pip` und
//! `download` haben außerhalb dieses Baums keinen einzigen Nutzer. Ein
//! Re-Export wäre ein toter Import, den `-D warnings` zu Recht ablehnt, und
//! der einzige Weg daran vorbei wäre ein `#[allow]`. Wer sie braucht, nimmt
//! `super::pip::…` bzw. `super::download::…` — das steht ohnehin in jedem
//! Geschwistermodul, das sie benutzt.

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;


mod children;
mod pip;
mod torch;
mod venv;
mod download;
mod git;
mod comfy_job;
mod comfy_install;
mod comfy_repair;
mod ollama;
mod lmstudio;
mod lmstudio_install;
mod python;
mod voice;
mod custom_nodes;

pub(crate) use self::{
    children::*,
    torch::*,
    venv::*,
    git::*,
    comfy_job::*,
    comfy_install::*,
    comfy_repair::*,
    ollama::*,
    lmstudio::*,
    lmstudio_install::*,
    python::*,
    voice::*,
    custom_nodes::*,
};
