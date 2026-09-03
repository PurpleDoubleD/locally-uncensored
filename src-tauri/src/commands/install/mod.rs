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
//! Drei Module fehlen in dieser Liste, und zwar mit Absicht: `pip`,
//! `download` und `env_check` werden über ihren eigenen Pfad gerufen, nicht
//! über diese Fläche. Ein
//! Re-Export wäre ein toter Import, den `-D warnings` zu Recht ablehnt, und
//! der einzige Weg daran vorbei wäre ein `#[allow]`. Wer sie braucht, nimmt
//! `super::pip::…`, `super::download::…` bzw. `super::env_check::…` — das
//! steht ohnehin in jedem Geschwistermodul, das sie benutzt. `pip` steht auf
//! `pub(crate)`, weil `process.rs` und `trainer.rs` seine Fehlerdeutung
//! mitbenutzen: sie starten eigene pip-Läufe und sollen deren Ausgabe nicht
//! ein zweites Mal deuten. Sie schreiben den vollen Pfad,
//! `crate::commands::install::pip::…`, damit an der Aufrufstelle steht, wessen
//! Deutung das ist.

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;


mod children;
pub(crate) mod pip;
mod torch;
mod venv;
mod download;
mod git;
mod comfy_job;
mod comfy_install;
mod comfy_repair;
mod env_check;
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

#[cfg(test)]
mod tests {
    /// Jede Datei dieses Baums, mit ihrem Namen. `include_str!` löst relativ
    /// zu dieser Datei auf, die Prüfungen unten lesen also genau die Module,
    /// die daneben liegen. Wer ein Modul hinzufügt, trägt es hier ein; der
    /// Test darunter merkt es, wenn nicht.
    const BAUM: &[(&str, &str)] = &[
        ("children.rs", include_str!("children.rs")),
        ("comfy_install.rs", include_str!("comfy_install.rs")),
        ("comfy_job.rs", include_str!("comfy_job.rs")),
        ("comfy_repair.rs", include_str!("comfy_repair.rs")),
        ("custom_nodes.rs", include_str!("custom_nodes.rs")),
        ("download.rs", include_str!("download.rs")),
        ("env_check.rs", include_str!("env_check.rs")),
        ("git.rs", include_str!("git.rs")),
        ("lmstudio.rs", include_str!("lmstudio.rs")),
        ("lmstudio_install.rs", include_str!("lmstudio_install.rs")),
        ("ollama.rs", include_str!("ollama.rs")),
        ("pip.rs", include_str!("pip.rs")),
        ("python.rs", include_str!("python.rs")),
        ("torch.rs", include_str!("torch.rs")),
        ("venv.rs", include_str!("venv.rs")),
        ("voice.rs", include_str!("voice.rs")),
    ];

    /// Nur die ausgelieferte Hälfte einer Datei. Die Prüfungen unten zitieren
    /// die Zeichenketten, die sie verbieten, und diese Zitate stehen in
    /// Testcode. Ohne den Schnitt fänden sie sich selbst.
    fn ausgeliefert(quelle: &str) -> &str {
        quelle.split("#[cfg(test)]").next().unwrap_or(quelle)
    }

    fn datei(name: &str) -> &'static str {
        BAUM.iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("{name} steht nicht in BAUM"))
            .1
    }

    /// Der Waechter über dem Waechter: eine neue Datei im Verzeichnis, die
    /// niemand in `BAUM` eingetragen hat, wäre von allem hier unbeobachtet.
    /// Die Prüfung läuft nur, wenn der Quelltext beim Testlauf wirklich
    /// dort liegt; fehlt er, prüfen die anderen Tests trotzdem weiter.
    #[test]
    fn jede_datei_dieses_baums_steht_in_der_liste() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("install");
        let Ok(eintraege) = std::fs::read_dir(&dir) else { return };
        let mut fehlen = Vec::new();
        for e in eintraege.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name == "mod.rs" {
                continue;
            }
            if !BAUM.iter().any(|(n, _)| *n == name) {
                fehlen.push(name);
            }
        }
        assert!(
            fehlen.is_empty(),
            "diese Module stehen in {} und in keiner Baum-Liste: {:?}",
            dir.display(),
            fehlen
        );
    }

    // ── A3: die drei Wege enden auf der Umgebungspruefung ──────────────────

    #[test]
    fn install_and_repair_both_end_on_the_environment_check() {
        // Quelltext-Anker, wie ihn der Trainer für seine Sackgassen hat: die
        // Prüfung ist wertlos, wenn einer der drei Wege ohne sie bis
        // "complete" kommt. Seit der Zerlegung stehen die Wege in zwei
        // Dateien, also liest der Wächter beide.
        for (name, marker, was) in [
            (
                "comfy_install.rs",
                "update(\"complete\", \"ComfyUI installed successfully!\");",
                "the install",
            ),
            ("comfy_repair.rs", "\"Environment repaired.", "the repair"),
            (
                "comfy_repair.rs",
                "\"ComfyUI updated. Restart ComfyUI",
                "the update",
            ),
        ] {
            let src = ausgeliefert(datei(name));
            let before = src.split(marker).next().expect(was);
            let last_check = before
                .rfind("verify_and_heal_environment(")
                .unwrap_or_else(|| panic!("{was} never checks the environment"));
            let between = &before[last_check..];
            assert!(
                !between.contains("\nfn ") && !between.contains("\npub fn "),
                "{was} runs the check in a different function than the one that declares success",
            );
            assert!(
                between.contains("update(\"error\""),
                "{was} does not stop when the check fails",
            );
        }

        for (name, src) in BAUM {
            let src = ausgeliefert(src);
            assert!(
                !src.contains("non-critical, ComfyUI should still start"),
                "{name}: a failed requirements install is still waved through as non-critical",
            );
            assert!(
                !src.contains("Some optional dependencies had warnings (non-critical)"),
                "{name}: the repair still waves a failed requirements install through",
            );
            // Jeder Weg gibt der Prüfung das Abbruch-Fähnchen mit. Eine Prüfung
            // mit Frist, aber ohne Cancel, sind fünf Minuten, aus denen der
            // Nutzer nicht herauskommt.
            assert!(
                !src.contains("verify_and_heal_environment(&python_bin, &reqs, &install_status, None)"),
                "{name}: a path runs the environment check with no way to cancel it",
            );
        }

        // Der Install muss nach einem vorhandenen venv greifen, bevor er nach
        // dem System-Python greift: Launcher und Updater benutzen dieses venv,
        // also legt ein Install daran vorbei die Pakete in den falschen
        // Interpreter.
        let install_body = ausgeliefert(datei("comfy_install.rs"))
            .split("pub fn install_comfyui(")
            .nth(1)
            .expect("install_comfyui");
        let venv_at = install_body
            .find("resolve_comfyui_venv_python")
            .expect("install_comfyui ignores an existing venv");
        let pep_at = install_body
            .find("is_pep668_protected")
            .expect("the PEP 668 branch");
        assert!(
            venv_at < pep_at,
            "the venv is only considered after the PEP 668 branch"
        );
    }

    // ── Ticket 003: jeder Python-Start setzt die Kodierung ─────────────────

    #[test]
    fn every_python_start_in_this_tree_goes_through_python_command() {
        // anglefire (Ticket 003, 03.09.): sein Windows-Benutzer heisst
        // "1 בוגר", also stehen in jedem Pfad, den ein Kind druckt, Zeichen
        // ausserhalb der alten Codepage. Genau eine Startstelle hat sich davor
        // geschuetzt, run_import_probe_bounded, und ihre Begruendung gilt
        // woertlich fuer jede andere: ein Python-Kind mit umgeleiteter Ausgabe
        // kodiert unter Windows mit der alten Codepage, und ein Text mit einem
        // Zeichen ausserhalb von ASCII bricht den Lauf dann mit einem
        // UnicodeEncodeError ab. Fuenf von sechs Stellen waren ungeschuetzt,
        // darunter beide pip-Laeufe, die am meisten Pfade drucken.
        let mut daneben: Vec<String> = Vec::new();
        let mut ueber_die_hilfe = 0usize;
        for (name, src) in BAUM {
            let src = ausgeliefert(src);
            ueber_die_hilfe += src.matches("python_command(").count();
            for line in src.lines() {
                let Some(at) = line.find("Command::new(") else {
                    continue;
                };
                let rest = &line[at + "Command::new(".len()..];
                let arg = rest.split(')').next().unwrap_or(rest).to_ascii_lowercase();
                if arg.contains("python") || arg.contains("pip") {
                    daneben.push(format!("{name}: {}", line.trim()));
                }
            }
            // Und niemand setzt die beiden Variablen noch einmal von Hand:
            // zwei Pfade, einer gepflegt, ist genau die Krankheit dieses Falls.
            for var in ["PYTHONIOENCODING", "PYTHONUTF8"] {
                assert!(
                    !src.contains(var),
                    "{var} wird in {name} von Hand gesetzt statt in python_command",
                );
            }
        }
        assert!(
            daneben.is_empty(),
            "diese Python-Starts gehen an python_command vorbei und laufen ohne \
             PYTHONIOENCODING/PYTHONUTF8:\n{}",
            daneben.join("\n"),
        );
        // Der Waechter muss die Starts auch wirklich sehen: die Hilfsfunktion
        // wird oft genug benutzt, dass ein stilles Zurueckdrehen auffaellt.
        assert!(
            ueber_die_hilfe >= 8,
            "es gibt weniger Python-Starts ueber die Hilfsfunktion als erwartet \
             ({ueber_die_hilfe}), wurde einer wieder direkt gebaut?",
        );
    }
}
