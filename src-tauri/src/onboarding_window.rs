//! Das Onboarding bekommt ein eigenes, kleines, mittiges Fenster.
//!
//! Der Wunsch des Eigentümers: „das onboarding ein separates kleines fenster,
//! immer mittig vom betriebssystem gespawnt, und die eigentliche LU app soll
//! dann das normale große fenster sein. mac und windows."
//!
//! ── Wer entscheidet ────────────────────────────────────────────────────────
//!
//! RUST, und zwar bevor das erste Pixel erscheint. Das Hauptfenster startet
//! seit jeher unsichtbar (`visible: false` in `tauri.conf.json`) und wird erst
//! gezeigt, wenn das Frontend `show_window` ruft. Genau an dieser Stelle
//! greift dieses Modul: `reveal()` zeigt ein Fenster nur, wenn es dran ist.
//!
//! Die eine Wahrheit ist die Markerdatei `onboarding_done` (siehe
//! `commands::system::is_onboarding_done`). Die Fenster FOLGEN dem Marker:
//!
//!   Start, Marker fehlt   → `open()` erzeugt das Fenster `onboarding`, klein,
//!                            mittig, nicht größenveränderbar. Das Hauptfenster
//!                            bleibt unsichtbar; sein Frontend wartet
//!                            (`src/main.tsx`) und lädt KEINEN Store, damit es
//!                            später frisch liest, was der Assistent geschrieben
//!                            hat.
//!   Start, Marker da      → wie bisher. Kein zweites Fenster, auch nicht kurz.
//!   Marker wird gesetzt   → `follow_marker(true)`: das Hauptfenster erfährt es
//!                            per Ereignis, bootet, ruft `show_window`, und
//!                            `reveal()` zeigt es ZUERST und schließt das
//!                            Onboarding-Fenster DANACH. Andersherum sähe der
//!                            Nutzer einen Moment lang kein Fenster.
//!   Marker wird gelöscht  → `follow_marker(false)`: „Onboarding zurücksetzen"
//!                            in den Einstellungen. Das kleine Fenster kommt
//!                            wieder; das große verschwindet, sobald das kleine
//!                            sichtbar ist (dieselbe Reihenfolge, andere
//!                            Richtung).
//!   Onboarding-Fenster zu, Marker fehlt → die App beendet sich. Das
//!                            Onboarding ist nicht fertig; ein unsichtbares
//!                            Hauptfenster wäre eine App ohne Fenster.
//!
//! ── Warum das Hauptfenster trotzdem existiert ─────────────────────────────
//!
//! Es steht in `tauri.conf.json`, und daran hängen Tray, Einzelinstanz und
//! die Zur-Leiste-statt-Schließen-Logik in `main.rs`. Es unsichtbar zu lassen
//! ist billiger und sicherer, als es nachträglich zu erzeugen: alles, was
//! `get_webview_window("main")` ruft, findet es weiterhin.
//!
//! ── Plattformabhängig ─────────────────────────────────────────────────────
//!
//! Die Dekoration folgt dem Rezept des Hauptfensters DER JEWEILIGEN PLATTFORM
//! (`tauri.macos.conf.json` bzw. `tauri.windows.conf.json`), damit das erste
//! Fenster der App nicht wie eine andere App aussieht:
//!
//!   macOS    `decorations: true`, `titleBarStyle: Overlay`, `hiddenTitle`:
//!            die nativen Ampeln links, kein Titel, der Inhalt läuft bis oben
//!            durch. Die Ziehfläche ist der Systembalken selbst.
//!   Windows  `decorations: false`, `transparent: true`, kein DWM-Schatten:
//!            die App ersetzt den Systembalken; das Onboarding zeichnet
//!            Minimieren und Schließen selbst (kein Maximieren — das Fenster
//!            ist nicht größenveränderbar). Die Ziehfläche ist der
//!            `data-tauri-drag-region`-Streifen in `Onboarding.tsx`.
//!
//! Die `#[cfg]`-Zeilen in `open()` sind die einzigen plattformabhängigen
//! Zeilen dieses Moduls.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::system::{is_onboarding_done, restore_stores, write_onboarding_marker};
use crate::state::AppState;

/// Das Label des Hauptfensters (`tauri.conf.json`).
pub const MAIN: &str = "main";
/// Das Label des Onboarding-Fensters. Das Frontend liest es über
/// `getCurrentWebviewWindow().label` (`src/lib/host-window.ts`) — es steht dort
/// noch einmal als Literal, und ein Test hält beide Literale gleich.
pub const ONBOARDING: &str = "onboarding";
/// Das Ereignis, mit dem das wartende Hauptfenster erfährt, dass es dran ist.
pub const DONE_EVENT: &str = "onboarding:done";

/// Gemessen, nicht geraten (Playwright, 640 px breit, `--ui-scale 1.15`):
/// der längste erreichbare Bildschirm ist der Maschinen-Schritt mit
/// aufgeklapptem „Use another engine" — 531 px Inhalt. Dazu die Ziehfläche
/// (37 px) und der Rand (18 px): 586 px. 640 lässt 54 px Luft, damit die
/// Fortschrittspunkte nicht unter den Streifen rutschen. Die Breite trägt den
/// Modell-Schritt (`max-w-xl`, 603 px gerendert) ohne Umbruch, und 640 ist
/// zugleich Tailwinds `sm`-Schwelle, ab der die Modellkarten zweispaltig
/// laufen. Was darüber hinausgeht (aufgeklappte Alternativlisten,
/// Installations-Protokolle), scrollt in der Karte — `Onboarding.tsx`.
pub const ONBOARDING_WIDTH: f64 = 640.0;
pub const ONBOARDING_HEIGHT: f64 = 640.0;

/// Wie lange das Frontend Zeit hat, `show_window` zu rufen, bevor Rust das
/// vorderste Fenster von sich aus zeigt (Bug D, siehe `main.rs`).
pub const FORCE_SHOW_DELAY: Duration = Duration::from_secs(10);
/// Wie lange nach dem Setzen des Markers das Hauptfenster Zeit hat, sich zu
/// melden, bevor Rust die Übergabe selbst erzwingt. Länger als der Kaltstart
/// des Frontends (Keychain bis 3 s + React-Mount), kürzer als ein Nutzer auf
/// einen Knopf starrt, der „Opening LU…" sagt.
pub const HANDOVER_GRACE: Duration = Duration::from_secs(15);

/// Welches Fenster beim Start als erstes sichtbar wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstWindow {
    Main,
    Onboarding,
}

/// Die reine Entscheidung. `marker` ist die Markerdatei, `backup_says_done`
/// die Aussage des Store-Backups (siehe `onboarding_done_in_backup`).
///
/// Das Backup zählt, weil die Markerdatei jünger ist als das Onboarding:
/// eine Installation von vor dem Marker hat `onboardingDone: true` im Store
/// und im Backup, aber keine Datei. `AppShell.tsx` schrieb den Marker in dem
/// Fall beim Boot nach — zu spät für eine Entscheidung, die VOR dem ersten
/// Fenster fällt. Also zieht Rust dieselbe Migration hier vor.
pub fn first_window(marker: bool, backup_says_done: bool) -> FirstWindow {
    if marker || backup_says_done {
        FirstWindow::Main
    } else {
        FirstWindow::Onboarding
    }
}

/// Sagt das Store-Backup (`store_backup.json`, Form `{ "<key>": "<raw
/// localStorage-String>" }`), dass das Onboarding schon durch war?
///
/// Der Eintrag `chat-settings` ist der zustand-persist-Umschlag
/// `{"state":{"settings":{"onboardingDone":true,…}},"version":n}` — als
/// String im String, deshalb zweimal parsen. Alles, was nicht genau so
/// aussieht, heißt „nein": im Zweifel lieber ein Onboarding zu viel als eine
/// App, die ohne Einrichtung startet.
pub fn onboarding_done_in_backup(backup_json: &str) -> bool {
    let outer: serde_json::Value = match serde_json::from_str(backup_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let raw = match outer.get("chat-settings").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return false,
    };
    let inner: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    inner
        .pointer("/state/settings/onboardingDone")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Die Entscheidung mit ihren Eingaben von der Platte — einmal, im `setup`.
/// Schreibt den Marker nach, wenn nur das Backup ihn kannte, damit jeder
/// spätere Start die kurze Frage stellt.
pub fn decide_first_window() -> FirstWindow {
    let marker = is_onboarding_done();
    let backup_says_done = !marker
        && matches!(restore_stores(), Ok(Some(json)) if onboarding_done_in_backup(&json));
    if backup_says_done {
        if let Err(e) = write_onboarding_marker(true) {
            tracing::warn!("onboarding marker could not be migrated from the backup: {e}");
        }
    }
    first_window(marker, backup_says_done)
}

/// Was `reveal()` mit einem Fenster tut, das sich zeigen will.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reveal {
    /// Zeigen. Für das Onboarding-Fenster heißt das zusätzlich: das
    /// Hauptfenster verstecken, falls es sichtbar war (Zurücksetzen aus den
    /// Einstellungen) — erst zeigen, dann verstecken, nie andersherum.
    Show,
    /// Das Hauptfenster zeigen und DANACH das Onboarding-Fenster schließen.
    ShowAndCloseOnboarding,
    /// Das Hauptfenster bleibt unsichtbar: das Onboarding läuft noch, in
    /// seinem eigenen Fenster.
    KeepHidden,
}

/// Die reine Regel hinter `reveal()`. Ein Fenster ohne Stellvertreter wird
/// immer gezeigt — ein Nutzer ohne Fenster ist der schlimmste Zustand, und
/// das Hauptfenster kann das Onboarding zur Not selbst zeichnen
/// (`AppShell.tsx`, der bisherige Weg).
pub fn reveal_decision(label: &str, onboarding_done: bool, onboarding_window_exists: bool) -> Reveal {
    if label == ONBOARDING {
        return Reveal::Show;
    }
    match (onboarding_done, onboarding_window_exists) {
        (_, false) => Reveal::Show,
        (true, true) => Reveal::ShowAndCloseOnboarding,
        (false, true) => Reveal::KeepHidden,
    }
}

/// `show_window` aus dem Frontend landet hier, für JEDES Fenster.
pub fn reveal(window: &WebviewWindow) {
    let app = window.app_handle();
    let onboarding = app.get_webview_window(ONBOARDING);
    match reveal_decision(window.label(), is_onboarding_done(), onboarding.is_some()) {
        Reveal::KeepHidden => {
            tracing::info!("main window stays hidden: the onboarding runs in its own window");
        }
        Reveal::Show => {
            let _ = window.show();
            let _ = window.set_focus();
            open_devtools_in_debug(window);
            if window.label() == ONBOARDING {
                if let Some(main) = app.get_webview_window(MAIN) {
                    if main.is_visible().unwrap_or(false) {
                        let _ = main.hide();
                    }
                }
            }
        }
        Reveal::ShowAndCloseOnboarding => {
            // Reihenfolge ist Absicht: erst das große Fenster, dann das kleine
            // weg. Beide Aufrufe gehen als Nachrichten an die Ereignisschleife
            // und werden in dieser Reihenfolge abgearbeitet.
            let _ = window.show();
            let _ = window.set_focus();
            open_devtools_in_debug(window);
            if let Some(o) = onboarding {
                // `destroy`, nicht `close`: `close` löst CloseRequested aus,
                // und der Handler darunter würde „Onboarding nicht fertig"
                // prüfen — es IST fertig, aber der Weg soll gar nicht erst
                // durch die Frage führen.
                let _ = o.destroy();
            }
        }
    }
}

/// DevTools in Debug-Builds — auf dem Hauptfenster, sobald es gezeigt wird,
/// und erst dann. Gemessen (macOS, Debug-Bundle, 01.09.2026): auf einem noch
/// unsichtbaren Fenster geöffnet, dockt WebKit den Inspector ins Fenster
/// und holt es damit nach vorn — das versteckte Hauptfenster stand neben dem
/// Onboarding-Fenster auf dem Bildschirm. Deshalb nicht mehr im `setup`.
///
/// Nur das Hauptfenster: im 640×640-Fenster nähme der gedockte Inspector
/// die halbe Fläche (ebenfalls gemessen). Wer ihn dort braucht, öffnet ihn
/// mit Cmd/Ctrl+Shift+I — Debug-Builds erlauben das.
fn open_devtools_in_debug(window: &WebviewWindow) {
    #[cfg(debug_assertions)]
    if window.label() == MAIN {
        window.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = window;
}

/// Erzeugt das Onboarding-Fenster — unsichtbar, bis sein Frontend
/// `show_window` ruft (derselbe Weg wie beim Hauptfenster, aus demselben
/// Grund: kein weißer Blitz vor dem ersten Frame). Gibt ein schon
/// vorhandenes zurück statt ein zweites zu bauen.
pub fn open(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(ONBOARDING) {
        return Ok(existing);
    }

    let builder = WebviewWindowBuilder::new(app, ONBOARDING, WebviewUrl::default())
        .title("LU")
        .inner_size(ONBOARDING_WIDTH, ONBOARDING_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .center()
        .visible(false)
        // Anders als das Hauptfenster (`dragDropEnabled: false`) lässt dieses
        // Fenster Tauris Drop-Handler auf dem Standard: der Assistent hat
        // keine Ablagefläche (die drei der App — Composer, Trainings-Board,
        // RAG-Panel — liegen alle hinter dem Onboarding), also gibt es hier
        // nichts, was der Handler stören könnte. Kommt je eine dazu, greift
        // `html5-drop-enabled.test.ts` und macht den Tausch ausdrücklich.
        .focused(true);

    // ── plattformabhängig: das Dekorationsrezept des jeweiligen Hauptfensters ──
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build()?;

    // Wie beim Hauptfenster in `main.rs`: ohne das zeichnet DWM einen
    // 1-mm-Rand um ein rahmenloses Fenster.
    #[cfg(target_os = "windows")]
    let _ = window.set_shadow(false);

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            if !is_onboarding_done() {
                quit(&handle);
            }
        }
    });

    Ok(window)
}

/// Das Onboarding-Fenster wurde geschlossen, bevor das Onboarding fertig war:
/// derselbe Weg wie „Quit" im Tray, damit kein Kindprozess zurückbleibt.
fn quit(app: &AppHandle) {
    tracing::info!("onboarding window closed before setup finished — quitting");
    if let Some(state) = app.try_state::<AppState>() {
        state.shutdown_subprocesses();
    }
    app.exit(0);
}

/// Läuft das Onboarding gerade in seinem eigenen Fenster? Das Hauptfenster
/// fragt das beim Boot (`src/main.tsx`) und wartet dann, statt die App zu
/// laden.
#[tauri::command]
pub fn onboarding_window_open(app: AppHandle) -> bool {
    app.get_webview_window(ONBOARDING).is_some()
}

/// Die Fenster folgen dem Marker — aufgerufen von `set_onboarding_done`,
/// NACH dem erfolgreichen Schreiben.
pub fn follow_marker(app: &AppHandle, done: bool) {
    let onboarding = app.get_webview_window(ONBOARDING);
    if done {
        if onboarding.is_none() {
            // Die Migration aus `AppShell.tsx` (Marker nachschreiben) oder ein
            // Onboarding, das noch im Hauptfenster lief. Nichts zu wechseln.
            return;
        }
        // Rundruf, kein `emit_to`: das Hauptfenster hört mit dem Standardziel
        // (`Any`), und ein zweiter Hörer existiert für dieses Ereignis nicht.
        if let Err(e) = app.emit(DONE_EVENT, ()) {
            tracing::warn!("could not tell the main window the onboarding is done: {e}");
        }
        handover_fallback(app.clone(), HANDOVER_GRACE);
    } else if onboarding.is_none() {
        // „Onboarding zurücksetzen": das kleine Fenster kommt wieder. Das
        // Hauptfenster bleibt sichtbar, bis das kleine sich gezeigt hat —
        // `reveal()` versteckt es dann.
        if let Err(e) = open(app) {
            tracing::error!("could not open the onboarding window: {e}");
        }
    }
}

/// Das vorderste Fenster: das Onboarding, solange es existiert, sonst das
/// Hauptfenster. Tray-„Show", Doppelklick aufs Tray-Symbol und ein zweiter
/// Start der App holen dieses Fenster nach vorn.
pub fn front_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(ONBOARDING)
        .or_else(|| app.get_webview_window(MAIN))
}

pub fn bring_to_front(app: &AppHandle) {
    if let Some(window) = front_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bug D (`main.rs`): ruft das Frontend nie `show_window`, zeigt Rust das
/// vorderste Fenster nach `delay` von sich aus. Geht durch `reveal()`, damit
/// auch der Notweg die Regel kennt — ein Hauptfenster, das während des
/// Onboardings aufpoppt, wäre genau der Blitz, den das Ganze verhindern soll.
pub fn force_show_after(app: AppHandle, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Some(window) = front_window(&app) {
            if !window.is_visible().unwrap_or(false) {
                println!(
                    "[Window] Force-show fallback fired for '{}' (frontend never called show_window)",
                    window.label()
                );
                reveal(&window);
            }
        }
    });
}

/// Meldet sich das Hauptfenster nach dem Marker nicht (Boot hängt, Keychain
/// klemmt), erzwingt Rust die Übergabe: Hauptfenster zeigen, Onboarding zu.
fn handover_fallback(app: AppHandle, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Some(main) = app.get_webview_window(MAIN) {
            if !main.is_visible().unwrap_or(false) && is_onboarding_done() {
                println!("[Window] Handover fallback fired (main never called show_window after onboarding)");
                reveal(&main);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN_RS: &str = include_str!("main.rs");
    const PROCESS_RS: &str = include_str!("commands/process.rs");
    const SYSTEM_RS: &str = include_str!("commands/system.rs");

    // ── Die Entscheidung vor dem ersten Pixel ─────────────────────────────

    #[test]
    fn ohne_marker_und_ohne_backup_kommt_das_onboarding_fenster() {
        assert_eq!(first_window(false, false), FirstWindow::Onboarding);
    }

    #[test]
    fn mit_marker_kommt_das_hauptfenster_und_sonst_nichts() {
        assert_eq!(first_window(true, false), FirstWindow::Main);
        assert_eq!(first_window(true, true), FirstWindow::Main);
    }

    #[test]
    fn ein_backup_von_vor_dem_marker_zaehlt_wie_der_marker() {
        // Die Migration aus AppShell.tsx, vorgezogen: sonst sähe jeder
        // Aufsteiger von einer Version ohne Markerdatei den Assistenten
        // noch einmal.
        assert_eq!(first_window(false, true), FirstWindow::Main);
    }

    #[test]
    fn das_backup_wird_zweimal_geparst_weil_der_store_ein_string_im_string_ist() {
        let inner = r#"{"state":{"settings":{"theme":"dark","onboardingDone":true}},"version":7}"#;
        let backup = serde_json::json!({ "chat-settings": inner, "lu-providers": "{}" }).to_string();
        assert!(onboarding_done_in_backup(&backup));
    }

    #[test]
    fn im_zweifel_sagt_das_backup_nein() {
        let cases = [
            "",
            "not json",
            "{}",
            r#"{"chat-settings": 42}"#,
            r#"{"chat-settings": "not json"}"#,
            r#"{"chat-settings": "{\"state\":{\"settings\":{}}}"}"#,
            r#"{"chat-settings": "{\"state\":{\"settings\":{\"onboardingDone\":false}}}"}"#,
            r#"{"chat-settings": "{\"state\":{\"settings\":{\"onboardingDone\":\"true\"}}}"}"#,
        ];
        for c in cases {
            assert!(!onboarding_done_in_backup(c), "must be false for {c:?}");
        }
    }

    // ── Die Regel hinter show_window ──────────────────────────────────────

    #[test]
    fn das_onboarding_fenster_darf_sich_immer_zeigen() {
        assert_eq!(reveal_decision(ONBOARDING, false, true), Reveal::Show);
        assert_eq!(reveal_decision(ONBOARDING, true, true), Reveal::Show);
    }

    #[test]
    fn das_hauptfenster_bleibt_unsichtbar_solange_das_onboarding_in_seinem_fenster_laeuft() {
        assert_eq!(reveal_decision(MAIN, false, true), Reveal::KeepHidden);
    }

    #[test]
    fn nach_dem_marker_zeigt_sich_das_hauptfenster_und_schliesst_das_kleine() {
        assert_eq!(reveal_decision(MAIN, true, true), Reveal::ShowAndCloseOnboarding);
    }

    #[test]
    fn ohne_stellvertreter_wird_das_hauptfenster_immer_gezeigt() {
        // Marker fehlt, aber es gibt kein Onboarding-Fenster: das
        // Hauptfenster zeichnet den Assistenten selbst (AppShell), so wie
        // vor diesem Modul. Ein Nutzer ohne Fenster ist keine Option.
        assert_eq!(reveal_decision(MAIN, false, false), Reveal::Show);
        assert_eq!(reveal_decision(MAIN, true, false), Reveal::Show);
    }

    #[test]
    fn ein_fremdes_label_wird_wie_das_hauptfenster_behandelt() {
        // Ein Fenster, das dieses Modul nicht kennt (DevTools-Fenster
        // haben kein Webview-Label; ein künftiges Fenster hätte eines),
        // darf das Onboarding nicht überdecken.
        assert_eq!(reveal_decision("something-else", false, true), Reveal::KeepHidden);
    }

    // ── Maße und Fristen ──────────────────────────────────────────────────

    #[test]
    fn das_fenster_traegt_den_laengsten_gemessenen_schritt() {
        // 531 px Inhalt + 37 px Ziehfläche + 18 px Rand, gemessen am
        // 01.09.2026 (siehe Kommentar an den Konstanten). Kleiner als das
        // Hauptfenster in beiden Richtungen, sonst wäre es kein „kleines".
        let longest_step_px: f64 = 531.0 + 37.0 + 18.0;
        let (w, h) = (ONBOARDING_WIDTH, ONBOARDING_HEIGHT);
        assert!(h >= longest_step_px, "{h} does not hold the longest step ({longest_step_px})");
        assert!(w < 1280.0 && h < 800.0, "{w}x{h} is not smaller than the main window");
        // Die `sm`-Schwelle von Tailwind: darunter würde der Modell-Schritt
        // einspaltig und damit höher als gemessen.
        assert!(w >= 640.0, "{w} is below Tailwind's sm breakpoint");
    }

    #[test]
    fn die_uebergabefrist_ist_laenger_als_ein_kaltstart_und_kuerzer_als_geduld() {
        // Keychain-Hydration ist auf 3 s gedeckelt (main.tsx), der
        // React-Mount braucht 1-2 s: unter 5 s würde der Notweg gesunde
        // Starts überholen. Über 60 s starrt der Nutzer auf „Opening LU…".
        let secs = HANDOVER_GRACE.as_secs();
        assert!((5..=60).contains(&secs), "handover grace out of range: {secs}s");
        assert!(FORCE_SHOW_DELAY.as_secs() >= 5);
    }

    // ── Verdrahtung: die Regel wird auch benutzt ──────────────────────────

    #[test]
    fn show_window_geht_fuer_jedes_fenster_durch_reveal() {
        let f = &PROCESS_RS[PROCESS_RS.find("pub fn show_window(").expect("show_window exists")..];
        let f = &f[..f.find("\n}\n").expect("show_window ends")];
        assert!(
            f.contains("window: tauri::WebviewWindow") && f.contains("onboarding_window::reveal(&window)"),
            "show_window must reveal the CALLING window through the rule:\n{f}"
        );
        assert!(
            !f.contains("get_webview_window(\"main\")"),
            "show_window must not hard-wire the main window any more:\n{f}"
        );
    }

    #[test]
    fn das_setup_entscheidet_vor_dem_ersten_fenster() {
        let setup = &MAIN_RS[MAIN_RS.find(".setup(|app| {").expect("setup exists")..];
        let setup = &setup[..setup.find(".build(tauri::generate_context!())").expect("build follows setup")];
        assert!(
            setup.contains("onboarding_window::decide_first_window()"),
            "setup must ask the marker before any window is shown"
        );
        assert!(
            setup.contains("onboarding_window::open(app.handle())?"),
            "a failed onboarding window must fail setup loudly, not leave a hidden main window"
        );
        assert!(
            setup.contains("onboarding_window::force_show_after("),
            "the force-show fallback must go through the rule"
        );
        assert!(
            !setup.contains("std::thread::sleep(std::time::Duration::from_secs(10))"),
            "the old main-only force-show thread must be gone"
        );
        assert!(
            !setup.contains("open_devtools()"),
            "devtools on a hidden window make it visible (measured on macOS) — they open in reveal()"
        );
    }

    #[test]
    fn devtools_oeffnen_nur_auf_dem_fenster_das_gezeigt_wird() {
        let src = include_str!("onboarding_window.rs");
        let reveal_fn = &src[src.find("pub fn reveal(").expect("reveal exists")..];
        let reveal_fn = &reveal_fn[..reveal_fn.find("\n}\n").expect("reveal ends")];
        assert_eq!(reveal_fn.matches("open_devtools_in_debug(window)").count(), 2);
        let hidden = &reveal_fn[reveal_fn.find("Reveal::KeepHidden =>").unwrap()..reveal_fn.find("Reveal::Show =>").unwrap()];
        assert!(!hidden.contains("open_devtools"), "never on the window that stays hidden");
    }

    #[test]
    fn tray_und_zweiter_start_holen_das_vorderste_fenster_nach_vorn() {
        let main_fn = &MAIN_RS[MAIN_RS.find("\nfn main() {").expect("main exists")..];
        let main_fn = &main_fn[..main_fn.find("\n}\n").expect("main ends")];
        assert_eq!(
            main_fn.matches("onboarding_window::bring_to_front(").count(),
            3,
            "single-instance, tray Show and tray double-click must all use bring_to_front"
        );
    }

    #[test]
    fn das_kommando_ist_registriert() {
        assert!(
            MAIN_RS.contains("onboarding_window::onboarding_window_open,"),
            "onboarding_window_open is not in generate_handler!"
        );
    }

    #[test]
    fn set_onboarding_done_laesst_die_fenster_dem_marker_folgen() {
        let f = &SYSTEM_RS[SYSTEM_RS.find("pub fn set_onboarding_done(").expect("exists")..];
        let f = &f[..f.find("\n}\n").expect("ends")];
        let write = f.find("write_onboarding_marker(").expect("the command writes the marker");
        let follow = f.find("onboarding_window::follow_marker(").expect("the command moves the windows");
        assert!(write < follow, "the marker is written BEFORE the windows follow it");
        assert!(f.contains("?;"), "a failed write must not move the windows — the marker is the truth");
    }

    #[test]
    fn das_onboarding_fenster_schliesst_sich_nur_per_destroy() {
        // `close()` würde CloseRequested auslösen; der Handler darunter
        // beendet die App, wenn der Marker fehlt. Der Handover geht daran
        // vorbei.
        let src = include_str!("onboarding_window.rs");
        let reveal_fn = &src[src.find("pub fn reveal(").expect("reveal exists")..];
        let reveal_fn = &reveal_fn[..reveal_fn.find("\n}\n").expect("reveal ends")];
        assert!(reveal_fn.contains("o.destroy()"));
        assert!(!reveal_fn.contains("o.close()"));
    }

    #[test]
    fn die_frontend_seite_kennt_dasselbe_label() {
        let host = include_str!("../../src/lib/host-window.ts");
        assert!(
            host.contains(&format!("'{ONBOARDING}'")),
            "src/lib/host-window.ts must read the label {ONBOARDING:?}"
        );
        assert!(
            host.contains(&format!("'{DONE_EVENT}'")),
            "src/lib/host-window.ts must listen for {DONE_EVENT:?}"
        );
        let cap = include_str!("../capabilities/onboarding.json");
        let cap: serde_json::Value = serde_json::from_str(cap).expect("capability is JSON");
        assert_eq!(cap["windows"], serde_json::json!([ONBOARDING]));
    }
}
