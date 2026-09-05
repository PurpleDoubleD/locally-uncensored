//! Die Namen der app-eigenen Verzeichnisse — an EINER Stelle.
//!
//! ## Warum es diese Datei gibt
//!
//! Der Verzeichnisname wird auf der Rust-Seite **nicht** aus der
//! Tauri-`identifier` abgeleitet. Er stand als String an acht Stellen im
//! Quelltext, jede davon ein `dirs::*` plus ein angehängtes Literal. Ein
//! eigener `identifier` in `tauri.conf.json` trennt deshalb WebView-Speicher
//! und Single-Instance-Socket, aber eben nicht diese Pfade.
//!
//! Was daran gefährlich ist, hat sich am 2026-08-31 gezeigt: ein Build, der
//! sich für eine andere App hielt, schrieb in
//! `~/Library/Application Support/lu-labs/`, überschrieb dort
//! `stores/store_backup.json` und setzte `lu-providers` auf den Zustand eines
//! fremden Laufs zurück. Dass 6,7 MB echter Chats überlebt haben, lag allein
//! an der Merge-Rettung in `commands::system` (`keys_lost` / `merged_backup`)
//! — ein Sicherheitsnetz, keine Trennung.
//!
//! ## Wie es jetzt läuft
//!
//! Jeder Name, den diese App auf der Platte und im Schlüsselbund besitzt,
//! steht genau einmal hier und wird überall von hier geholt. Diese Konstanten
//! sind die Namen der echten App und dürfen sich nicht ändern: ein anderer
//! `APP_DIR` lässt die App die Daten des Nutzers nicht mehr finden, ein
//! anderer `KEYCHAIN_SERVICE` verwaist seine gespeicherten Schlüssel.
//!
//! Festgenagelt wird beides von zwei Tests:
//! [`tests::die_namen_sind_die_der_echten_app`] hält die fünf Werte fest, und
//! [`tests::keine_quelldatei_baut_einen_pfad_der_echten_app_von_hand`] liest
//! alle eigenen Quellen und findet jede Stelle, die einen dieser Namen wieder
//! selbst zusammensetzt statt ihn hier zu holen. Der zweite ist der
//! eigentliche Zweck der Datei: eine Sammelstelle, an der niemand vorbeikommt,
//! ist eine Sammelstelle, die nur so lange hält, wie das jemand prüft.
//!
//! ## Was hier NICHT drin steht
//!
//! * Die Tauri-`identifier` (`tauri.conf.json`) — sie steuert
//!   `app_data_dir()`/`app_config_dir()`, den Single-Instance-Socket und den
//!   WebView-Speicher **gebündelter** Builds.
//! * Der Binärname (`Cargo.toml`, `[package] name`) — er steuert unter macOS
//!   im `tauri dev`-Modus das WebKit-Verzeichnis (`~/Library/WebKit/<Name>`).

/// Haupt-Datenverzeichnis dieser App unter `data_local_dir()`, `cache_dir()`
/// und `config_dir()`.
///
/// * macOS:   `~/Library/Application Support/<APP_DIR>`
/// * Windows: `%LOCALAPPDATA%\<APP_DIR>`
/// * Linux:   `~/.local/share/<APP_DIR>`, `~/.cache/<APP_DIR>`,
///   `~/.config/<APP_DIR>`
pub const APP_DIR: &str = "lu-labs";

/// Älterer Ordner unter `config_dir()` bzw. `data_local_dir()`: hält
/// `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis, Trainer-Root) und
/// `bin/cloudflared`.
pub const APP_CONFIG_DIR: &str = "locally-uncensored";

/// Die Anzeige-Schreibweise desselben Namens. Zwei Verwendungen:
/// `%APPDATA%\<APP_DISPLAY_DIR>` (Store-Backups + Onboarding-Marker, Windows)
/// und `<data_dir>/<APP_DISPLAY_DIR>/models` (Modelle der eingebauten Engine).
pub const APP_DISPLAY_DIR: &str = "Locally Uncensored";

/// Sandkasten-Wurzel der Agenten unter `$HOME`. Pro Chat entsteht darin ein
/// Unterordner; der Agent darf nichts außerhalb anfassen.
pub const AGENT_WORKSPACE_DIR: &str = "agent-workspace";

/// Service-Name im OS-Schlüsselbund (macOS Keychain / Windows Credential
/// Manager) für Provider-Schlüssel und die Cloud-Sitzung.
///
/// Gehört hierher, obwohl es kein Pfad ist: der Name war ebenfalls
/// hartkodiert, und wer ihn ändert, verwaist alle Schlüssel, die der Nutzer
/// unter dem alten Namen gespeichert hat. Ein Build mit einem abweichenden
/// Service-Namen liest und **überschreibt** außerdem fremde Einträge.
// Only the Windows and macOS keychain paths read this; Linux has no keychain
// backend yet, and its clippy gate runs with -D warnings.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub const KEYCHAIN_SERVICE: &str = "com.locallyuncensored.providerkeys";

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Namen, die dieser App gehören.
    ///
    /// Bewusst als eigene Literale wiederholt und **nicht** aus den
    /// Konstanten oben abgeleitet: ein Test, der seine Erwartung aus dem holt,
    /// was er absichern soll, prüft nichts.
    const NAMEN_DER_ECHTEN_APP: [&str; 4] = [
        "lu-labs",
        "locally-uncensored",
        "Locally Uncensored",
        "agent-workspace",
    ];

    /// Ein Build, der unter einem anderen Namen läuft, findet die Daten des
    /// Nutzers nicht mehr und legt daneben neue an. Genau das ist am
    /// 2026-08-31 passiert, nur in die andere Richtung. Die fünf Werte stehen
    /// deshalb doppelt: einmal als Auslieferungscode, einmal hier.
    #[test]
    fn die_namen_sind_die_der_echten_app() {
        assert_eq!(APP_DIR, "lu-labs");
        assert_eq!(APP_CONFIG_DIR, "locally-uncensored");
        assert_eq!(APP_DISPLAY_DIR, "Locally Uncensored");
        assert_eq!(AGENT_WORKSPACE_DIR, "agent-workspace");
        assert_eq!(KEYCHAIN_SERVICE, "com.locallyuncensored.providerkeys");
        // Und kein Name trägt einen Anhang: ein Build aus einem
        // Experimentierzweig darf nicht versehentlich ausgeliefert werden.
        for name in [APP_DIR, APP_CONFIG_DIR, APP_DISPLAY_DIR, AGENT_WORKSPACE_DIR] {
            assert!(
                NAMEN_DER_ECHTEN_APP.contains(&name),
                "'{name}' ist keiner der Namen dieser App"
            );
        }
    }

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
