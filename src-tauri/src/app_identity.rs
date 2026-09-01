//! Die Namen der app-eigenen Verzeichnisse — an EINER Stelle.
//!
//! ## Warum es diese Datei gibt
//!
//! Dieser Branch (`experiment/audits-komplett`) hat **bewusst ein eigenes
//! Datenverzeichnis** und teilt nichts mit der installierten echten App.
//!
//! Am 2026-08-31 hat der erste echte Start des Experiment-Builds
//! (`npm run tauri dev`) in `~/Library/Application Support/lu-labs/`
//! geschrieben — dem Datenverzeichnis der ECHTEN App. Dabei wurde
//! `stores/store_backup.json` überschrieben und `lu-providers` auf einen
//! Zustand aus einem fremden Lauf zurückgesetzt (`lu-cloud` von `enabled:
//! true` auf `false`). Dass die 6,7 MB echter Chats überlebt haben, lag
//! allein an der Merge-Rettung in `commands::system` (`keys_lost` /
//! `merged_backup`) — das ist ein Sicherheitsnetz, keine Isolation.
//!
//! Die Ursache: der Verzeichnisname wird auf der Rust-Seite **nicht** aus der
//! Tauri-`identifier` abgeleitet, sondern war als String an acht Stellen
//! hartkodiert. Ein eigener `identifier` in `tauri.conf.json` trennt daher
//! WebView-Speicher und Single-Instance-Socket, aber eben nicht die Pfade, die
//! sich aus `dirs::*` und einem angehängten Literal zusammensetzen.
//!
//! ## Wie es jetzt läuft
//!
//! [`branch_dir_suffix!`] ist der einzige Schalter. Er hängt an jeden Namen,
//! den diese App auf der Platte (und im Schlüsselbund) besitzt. Für die
//! **echte App gehört hier `""` hin** — `lu-labs`, `locally-uncensored`,
//! `Locally Uncensored` und `agent-workspace` sind dort die richtigen Namen
//! und dürfen sich nicht ändern. Nur dieser Branch setzt einen Suffix.
//!
//! Wer den Suffix auf `""` zurückdreht, fällt in
//! [`tests::keiner_der_namen_ist_der_name_der_echten_app`] und
//! [`tests::kein_abgeleiteter_pfad_zeigt_in_ein_verzeichnis_der_echten_app`]
//! durch. Das ist Absicht.
//!
//! ## Was hier NICHT drin steht
//!
//! * Die Tauri-`identifier` (`tauri.conf.json`) — sie steuert
//!   `app_data_dir()`/`app_config_dir()`, den Single-Instance-Socket und den
//!   WebView-Speicher **gebündelter** Builds; die ist bereits getrennt.
//! * Der Binärname (`Cargo.toml`, `[package] name`) — er steuert unter macOS
//!   im `tauri dev`-Modus das WebKit-Verzeichnis (`~/Library/WebKit/<Name>`).
//!   Die ausführliche Begründung steht als Kommentar in `Cargo.toml`;
//!   festgenagelt wird er von
//!   [`tests::der_binaername_ist_nicht_der_der_echten_app`].

/// **Der einzige Schalter.** Suffix an jedem app-eigenen Verzeichnisnamen.
///
/// * Echte App / upstream: `""`
/// * Branch `experiment/audits-komplett`: `"-experiment"`
///
/// Ein Makro (und nicht eine `const`), weil `concat!` nur Literale
/// zusammensetzen kann — so bleibt jeder Name unten eine echte
/// Compile-Zeit-Konstante statt eines `format!` zur Laufzeit.
macro_rules! branch_dir_suffix {
    () => {
        "-experiment"
    };
}

/// Haupt-Datenverzeichnis dieser App unter `data_local_dir()`, `cache_dir()`
/// und `config_dir()`.
///
/// * macOS:   `~/Library/Application Support/<APP_DIR>`
/// * Windows: `%LOCALAPPDATA%\<APP_DIR>`
/// * Linux:   `~/.local/share/<APP_DIR>`, `~/.cache/<APP_DIR>`,
///   `~/.config/<APP_DIR>`
pub const APP_DIR: &str = concat!("lu-labs", branch_dir_suffix!());

/// Älterer Ordner unter `config_dir()` bzw. `data_local_dir()`: hält
/// `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis, Trainer-Root) und
/// `bin/cloudflared`.
pub const APP_CONFIG_DIR: &str = concat!("locally-uncensored", branch_dir_suffix!());

/// Die Anzeige-Schreibweise desselben Namens. Zwei Verwendungen:
/// `%APPDATA%\<APP_DISPLAY_DIR>` (Store-Backups + Onboarding-Marker, Windows)
/// und `<data_dir>/<APP_DISPLAY_DIR>/models` (Modelle der eingebauten Engine).
pub const APP_DISPLAY_DIR: &str = concat!("Locally Uncensored", branch_dir_suffix!());

/// Sandkasten-Wurzel der Agenten unter `$HOME`. Pro Chat entsteht darin ein
/// Unterordner; der Agent darf nichts außerhalb anfassen.
pub const AGENT_WORKSPACE_DIR: &str = concat!("agent-workspace", branch_dir_suffix!());

/// Service-Name im OS-Schlüsselbund (macOS Keychain / Windows Credential
/// Manager) für Provider-Schlüssel und die Cloud-Sitzung.
///
/// Gehört hierher, obwohl es kein Pfad ist: der Name war ebenfalls
/// hartkodiert, und ohne Suffix läse und **überschriebe** der
/// Experiment-Build die echten API-Schlüssel des Nutzers. In der echten App
/// muss er stabil bleiben — ein geänderter Service-Name verwaist die dort
/// gespeicherten Schlüssel.
pub const KEYCHAIN_SERVICE: &str =
    concat!("com.locallyuncensored.providerkeys", branch_dir_suffix!());

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Component, Path};

    /// Die Namen, die der ECHTEN App gehören.
    ///
    /// Bewusst als eigene Literale wiederholt und **nicht** aus den
    /// Konstanten oben abgeleitet: ein Test, der seine Erwartung aus dem
    /// prüft, was er absichern soll, prüft nichts.
    const NAMEN_DER_ECHTEN_APP: [&str; 4] = [
        "lu-labs",
        "locally-uncensored",
        "Locally Uncensored",
        "agent-workspace",
    ];

    /// Mutationsprobe: `branch_dir_suffix!()` auf `""` zurückdrehen lässt
    /// genau diesen Test rot werden.
    #[test]
    fn keiner_der_namen_ist_der_name_der_echten_app() {
        for name in [
            APP_DIR,
            APP_CONFIG_DIR,
            APP_DISPLAY_DIR,
            AGENT_WORKSPACE_DIR,
        ] {
            assert!(
                !NAMEN_DER_ECHTEN_APP.contains(&name),
                "'{name}' ist der Verzeichnisname der ECHTEN App — dieser Build \
                 würde in die Daten des Nutzers schreiben. branch_dir_suffix!() prüfen."
            );
        }
        assert_ne!(
            KEYCHAIN_SERVICE, "com.locallyuncensored.providerkeys",
            "der Experiment-Build teilte sonst den Schlüsselbund-Eintrag der echten App"
        );
    }

    /// Der WebView-Speicher hängt unter macOS im `tauri dev`-Modus NICHT an
    /// der Tauri-`identifier`, sondern am Namen der laufenden Datei: ein nicht
    /// gebündeltes Programm hat keine Bundle-ID, also nimmt WebKit
    /// `processName` (= Dateiname) und legt localStorage/IndexedDB unter
    /// `~/Library/WebKit/<Dateiname>/` ab. `cargo run` benennt die Datei nach
    /// `[package] name`.
    ///
    /// Solange der `locally-uncensored` hieß, teilte dieser Build denselben
    /// localStorage mit jedem `tauri dev` aus dem echten Repo. Deshalb steht
    /// der Name hier unter Test — er ist Isolation, nicht Kosmetik.
    #[test]
    fn der_binaername_ist_nicht_der_der_echten_app() {
        assert_ne!(
            env!("CARGO_PKG_NAME"),
            "locally-uncensored",
            "der Dateiname der ausführbaren Datei bestimmt unter macOS das \
             WebKit-Verzeichnis im dev-Modus — mit diesem Namen teilt der \
             Experiment-Build localStorage mit dem echten Repo"
        );
        if let Some(bin) = option_env!("CARGO_BIN_NAME") {
            assert_ne!(bin, "locally-uncensored");
        }
    }

    /// Der Suffix muss auch wirklich trennen und nicht nur anders aussehen.
    #[test]
    fn suffix_ist_nicht_leer_und_haengt_an_jedem_namen() {
        let suffix = branch_dir_suffix!();
        assert!(!suffix.is_empty(), "ohne Suffix gibt es keine Trennung");
        for name in [
            APP_DIR,
            APP_CONFIG_DIR,
            APP_DISPLAY_DIR,
            AGENT_WORKSPACE_DIR,
            KEYCHAIN_SERVICE,
        ] {
            assert!(
                name.ends_with(suffix),
                "'{name}' trägt den Branch-Suffix nicht"
            );
        }
    }

    /// Ein Pfadbestandteil, der einem Verzeichnis der echten App entspricht.
    ///
    /// Verglichen wird **komponentenweise und exakt**, nicht mit `starts_with`
    /// auf dem ganzen Pfad: `lu-labs-experiment` ist erlaubt, `lu-labs` nicht,
    /// und ein Präfix-Vergleich könnte die beiden nicht auseinanderhalten.
    /// Zusätzlich case-insensitiv, weil macOS (APFS) und Windows
    /// Groß-/Kleinschreibung in Pfaden nicht unterscheiden — `LU-LABS` wäre
    /// dort dasselbe Verzeichnis.
    fn kollidierende_komponente(pfad: &Path) -> Option<String> {
        for c in pfad.components() {
            if let Component::Normal(os) = c {
                let s = os.to_string_lossy();
                if let Some(hit) = NAMEN_DER_ECHTEN_APP
                    .iter()
                    .find(|n| n.eq_ignore_ascii_case(&s))
                {
                    return Some((*hit).to_string());
                }
            }
        }
        None
    }

    /// Jeder Pfad, den dieser Build sich selbst zusammenbaut — einmal
    /// aufgezählt, einmal geprüft. Kommt eine neue Ableitung dazu, gehört sie
    /// hier hinein.
    fn alle_abgeleiteten_pfade() -> Vec<(&'static str, std::path::PathBuf)> {
        use crate::os_paths as p;
        vec![
            ("data_dir", p::data_dir()),
            ("cache_dir", p::cache_dir()),
            ("config_root", p::config_root()),
            ("log_dir", p::log_dir()),
            ("app_config_dir", p::app_config_dir()),
            ("app_config_json", p::app_config_json()),
            ("tools_bin_dir", p::tools_bin_dir()),
            ("builtin_models_dir", p::builtin_models_dir()),
            ("agent_workspace_root", p::agent_workspace_root()),
            ("default_comfyui_dir", p::default_comfyui_dir()),
            ("mlx_root", p::data_dir().join("mlx")),
            ("stores_dir", p::data_dir().join("stores")),
            ("crash_log", crate::crash_report::crash_log_path()),
            ("images_root", crate::commands::mlx::images_root()),
            ("video_models_root", crate::commands::video::models_root()),
            ("video_outputs_root", crate::commands::video::outputs_root()),
            (
                "persistent_dir",
                crate::commands::system::persistent_dir().expect("persistent_dir"),
            ),
        ]
    }

    /// Mutationsprobe: `branch_dir_suffix!()` auf `""` zurückdrehen lässt auch
    /// diesen Test rot werden — und zwar für jeden einzelnen Pfad.
    #[test]
    fn kein_abgeleiteter_pfad_zeigt_in_ein_verzeichnis_der_echten_app() {
        // Alle Verstöße sammeln statt beim ersten abzubrechen: wer den Suffix
        // zurückdreht, soll die ganze Liste sehen und nicht einen Pfad nach
        // dem anderen.
        let mut verstoesse: Vec<String> = Vec::new();
        for (name, pfad) in alle_abgeleiteten_pfade() {
            if let Some(treffer) = kollidierende_komponente(&pfad) {
                verstoesse.push(format!("{name} = {} (via '{treffer}')", pfad.display()));
            }
        }
        assert!(
            verstoesse.is_empty(),
            "diese Pfade zeigen in ein Verzeichnis der ECHTEN App — dieser Build \
             darf dort weder lesen noch schreiben:\n  {}",
            verstoesse.join("\n  ")
        );
    }

    /// Gegenprobe zur Prüfmethode selbst: sie muss einen Treffer auch finden.
    /// Ohne das wäre ein immer-`None` liefernder Prüfer ein grüner Test.
    #[test]
    fn die_pruefung_erkennt_einen_echten_treffer() {
        let echt = Path::new("/Users/x/Library/Application Support/lu-labs/stores");
        assert_eq!(kollidierende_komponente(echt).as_deref(), Some("lu-labs"));

        let gross = Path::new("/Users/x/AppData/Local/LU-LABS/logs");
        assert_eq!(kollidierende_komponente(gross).as_deref(), Some("lu-labs"));

        // …und ein Suffix-Name ist ausdrücklich KEIN Treffer.
        let unser = Path::new("/Users/x/Library/Application Support/lu-labs-experiment/stores");
        assert_eq!(kollidierende_komponente(unser), None);
    }

    /// Die Präfix-Falle: `lu-labs-experiment` fängt mit `lu-labs` an. Sobald
    /// irgendwo im Code ein Präfix-Vergleich oder ein Glob auf dem nackten
    /// Namen steht, erwischt das beide Verzeichnisse und die Trennung ist
    /// wieder weg. Genauso wandert ein neu angehängtes Literal an der
    /// Konstante vorbei.
    ///
    /// Deshalb scannt dieser Test die eigenen Quellen. Die Nadeln werden zur
    /// Laufzeit gebaut, damit der Test sich nicht selbst findet.
    #[test]
    fn keine_quelldatei_baut_einen_pfad_der_echten_app_von_hand() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut funde: Vec<String> = Vec::new();

        for eintrag in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
        {
            let Ok(inhalt) = std::fs::read_to_string(eintrag.path()) else {
                continue;
            };
            for name in NAMEN_DER_ECHTEN_APP {
                for nadel in [
                    format!(".join(\"{name}\")"),
                    format!("starts_with(\"{name}\")"),
                    format!("\"{name}*\""),
                    format!("\"{name}/"),
                    format!("\"{name}\\\\"),
                ] {
                    if inhalt.contains(&nadel) {
                        funde.push(format!(
                            "{}: {nadel}",
                            eintrag.path().strip_prefix(&src).unwrap_or(eintrag.path()).display()
                        ));
                    }
                }
            }
        }

        assert!(
            funde.is_empty(),
            "Pfade der ECHTEN App im Quelltext zusammengebaut — jeder dieser Namen \
             gehört über die Konstanten in app_identity abgeleitet:\n  {}",
            funde.join("\n  ")
        );
    }
}
