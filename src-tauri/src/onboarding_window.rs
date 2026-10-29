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
//!   Dasselbe beim erneuten Durchlauf → kein Beenden. Die App WAR schon
//!                            eingerichtet, der Nutzer bricht nur ab: der Marker
//!                            wird wieder geschrieben und die Fenster folgen
//!                            ihm wie nach einem Abschluss (`follow_marker(true)`).
//!                            Woran Rust das erkennt: `follow_marker(false)`
//!                            merkt es sich (`RERUN`), denn nur „Onboarding
//!                            zurücksetzen" löscht den Marker. Die Erstinstallation
//!                            kommt nie dort vorbei und beendet weiter.
//!
//! ── Warum das Hauptfenster trotzdem existiert ─────────────────────────────
//!
//! Es steht in `tauri.conf.json`, und daran hängen Tray, Einzelinstanz und
//! die Zur-Leiste-statt-Schließen-Logik in `lib.rs`. Es unsichtbar zu lassen
//! ist billiger und sicherer, als es nachträglich zu erzeugen: alles, was
//! `get_webview_window("main")` ruft, findet es weiterhin.
//!
//! ── Plattformabhängig ─────────────────────────────────────────────────────
//!
//! Die Dekoration folgt dem Rezept des Hauptfensters DER JEWEILIGEN PLATTFORM
//! (`tauri.macos.conf.json`, `tauri.windows.conf.json`, `tauri.linux.conf.json`), damit das erste
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
//!   Linux    `decorations: false` wie Windows, aber DECKEND. Ein
//!            transparentes WebKitGTK-Fenster malt auf aktuellen Mesa- und
//!            WebKit-Staenden seinen Hintergrund nicht und verschwindet,
//!            sobald es den Fokus hat (GH #145, Bazzite, RX 9060 XT, Wayland
//!            und X11). Die Oberflaeche nutzt die Transparenz nirgends.
//!
//! Die `#[cfg]`-Zeilen in `open()` sind die einzigen plattformabhängigen
//! Zeilen dieses Moduls.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

// Ein Handy baut und zeigt kein Fenster (siehe unten), dort bleibt die Haelfte ungenutzt.
#[cfg_attr(mobile, allow(unused_imports))]
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::system::{is_onboarding_done, read_store_backup, write_onboarding_marker};
#[cfg_attr(mobile, allow(unused_imports))]
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
/// vorderste Fenster von sich aus zeigt (Bug D, siehe `lib.rs`).
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
        && matches!(read_store_backup(), Ok(Some(json)) if onboarding_done_in_backup(&json));
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false).transparent(true);
    #[cfg(target_os = "linux")]
    let builder = builder.decorations(false);

    let window = while_building(|| builder.build())?;

    // Wie beim Hauptfenster in `lib.rs`: ohne das zeichnet DWM einen
    // 1-mm-Rand um ein rahmenloses Fenster.
    #[cfg(target_os = "windows")]
    let _ = window.set_shadow(false);

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            match on_close(is_onboarding_done(), RERUN.load(Ordering::SeqCst)) {
                OnClose::Nothing => {}
                OnClose::Quit => quit(&handle),
                OnClose::BackToTheApp => back_to_the_app(&handle),
            }
        }
    });

    Ok(window)
}

/// Läuft gerade ein freiwilliger erneuter Durchlauf? Gesetzt von
/// `follow_marker(false)` (nur „Onboarding zurücksetzen" löscht den Marker),
/// gelöscht, sobald der Marker wieder steht. Nur im Speicher: ein Neustart
/// mitten im Durchlauf findet den Abschluss im Store-Backup, weil die
/// Einstellungen `onboardingDone` dafür nicht mehr umlegen
/// (`SettingsPage.tsx`), und `decide_first_window` schreibt den Marker nach.
#[cfg_attr(mobile, allow(dead_code))]
static RERUN: AtomicBool = AtomicBool::new(false);

/// Was das Schließen des Onboarding-Fensters auslöst.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    /// Der Marker steht: das Onboarding ist fertig, nichts zu tun.
    Nothing,
    /// Erstinstallation abgebrochen: die App beendet sich.
    Quit,
    /// Erneuter Durchlauf abgebrochen: zurück in die eingerichtete App.
    BackToTheApp,
}

/// Die reine Regel hinter dem CloseRequested-Handler.
pub fn on_close(marker: bool, rerun: bool) -> OnClose {
    match (marker, rerun) {
        (true, _) => OnClose::Nothing,
        (false, false) => OnClose::Quit,
        (false, true) => OnClose::BackToTheApp,
    }
}

/// Der erneute Durchlauf wurde abgebrochen: Marker zurück, und die Fenster
/// folgen ihm wie nach einem Abschluss. Das wartende Hauptfenster bootet auf
/// `DONE_EVENT` und zeigt sich. Scheitert das Schreiben, bleibt nur der
/// alte Weg, sonst stünde ein unsichtbares Hauptfenster ohne Gegenüber da.
#[cfg(desktop)]
fn back_to_the_app(app: &AppHandle) {
    tracing::info!("re-run of the onboarding closed, back to the set-up app");
    match write_onboarding_marker(true) {
        Ok(()) => follow_marker(app, true),
        Err(e) => {
            tracing::error!("onboarding marker could not be restored: {e}");
            quit(app);
        }
    }
}

/// Das Onboarding-Fenster wurde geschlossen, bevor das Onboarding fertig war:
/// derselbe Weg wie „Quit" im Tray, damit kein Kindprozess zurückbleibt.
#[cfg(desktop)]
fn quit(app: &AppHandle) {
    tracing::info!("onboarding window closed before setup finished — quitting");
    if let Some(state) = app.try_state::<AppState>() {
        state.shutdown_subprocesses();
    }
    app.exit(0);
}

/// Wie viele Bauten des Onboarding-Fensters gerade laufen (`while_building`).
static BUILDING: AtomicUsize = AtomicUsize::new(0);

/// Führt `build` aus und meldet das Onboarding-Fenster solange schon als da.
///
/// A24 (A12-Echtlauf auf der Box, 21.10.2026): Unter Windows wartet `build()`
/// auf WebView2 und pumpt dabei eine geschachtelte Nachrichtenschleife auf
/// dem Hauptfaden (derselbe Mechanismus wie beim Hänger in
/// `set_onboarding_done_baut_das_fenster_nicht_auf_dem_hauptfaden`). Das
/// Hauptfenster lädt zu dem Zeitpunkt schon, und seine Frage
/// `onboarding_window_open` wird MITTEN in dieser Schleife beantwortet, bevor
/// Tauri das neue Fenster eingetragen hat: „nein". Das Hauptfenster bootete
/// darauf die App mit leeren Stores, zeichnete den Assistenten unsichtbar
/// selbst, und der Notweg `handover_fallback` zeigte nach dem Abschluss im
/// kleinen Fenster genau diesen alten Stand: das Onboarding ein zweites Mal.
fn while_building<T>(build: impl FnOnce() -> T) -> T {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            BUILDING.fetch_sub(1, Ordering::SeqCst);
        }
    }
    BUILDING.fetch_add(1, Ordering::SeqCst);
    let _guard = Guard;
    build()
}

/// Die Antwort auf `onboarding_window_open`: das Fenster ist eingetragen ODER
/// wird gerade gebaut. Ein Fenster, dessen Bau scheitert, lässt das `setup`
/// scheitern (`open(app.handle())?` in `main.rs`) — ein „ja" zu viel kann so
/// kein Hauptfenster ohne Gegenüber zurücklassen.
fn delegated(window_registered: bool) -> bool {
    window_registered || BUILDING.load(Ordering::SeqCst) > 0
}

/// Läuft das Onboarding gerade in seinem eigenen Fenster? Das Hauptfenster
/// fragt das beim Boot (`src/main.tsx`) und wartet dann, statt die App zu
/// laden.
#[tauri::command]
pub fn onboarding_window_open(app: AppHandle) -> bool {
    delegated(app.get_webview_window(ONBOARDING).is_some())
}

/// Die Fenster folgen dem Marker — aufgerufen von `set_onboarding_done`,
/// NACH dem erfolgreichen Schreiben.
#[cfg(desktop)]
pub fn follow_marker(app: &AppHandle, done: bool) {
    let onboarding = app.get_webview_window(ONBOARDING);
    RERUN.store(!done, Ordering::SeqCst);
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
#[cfg(desktop)]
pub fn front_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(ONBOARDING)
        .or_else(|| app.get_webview_window(MAIN))
}

#[cfg(desktop)]
pub fn bring_to_front(app: &AppHandle) {
    if let Some(window) = front_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bug D (`lib.rs`): ruft das Frontend nie `show_window`, zeigt Rust das
/// vorderste Fenster nach `delay` von sich aus. Geht durch `reveal()`, damit
/// auch der Notweg die Regel kennt — ein Hauptfenster, das während des
/// Onboardings aufpoppt, wäre genau der Blitz, den das Ganze verhindern soll.
#[cfg(desktop)]
pub fn force_show_after(app: AppHandle, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Some(window) = front_window(&app) {
            if !window.is_visible().unwrap_or(false) {
                println!(
                    "[Window] Force-show fallback fired for '{}' (frontend never called show_window)",
                    window.label()
                );
                // Bug g (2026-09-04): on Linux this moment IS the "no
                // window" report, and 2.6.7 spent it in silence. `show()` below
                // cannot help when the web process is already dead, so the
                // console gets the two commands that tell the causes apart.
                if let Some(hint) = crate::linux_no_window_hint(
                    cfg!(target_os = "linux"),
                    crate::is_wayland_session(
                        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
                        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
                    ),
                    std::env::var_os("APPDIR").is_some(),
                ) {
                    println!("{hint}");
                }
                reveal(&window);
            }
        }
    });
}

/// Meldet sich das Hauptfenster nach dem Marker nicht (Boot hängt, Keychain
/// klemmt), erzwingt Rust die Übergabe: Hauptfenster zeigen, Onboarding zu.
#[cfg(desktop)]
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

// ── Ein Handy hat genau ein Fenster ──────────────────────────────────────────
//
// Alles oben, was ein Fenster zeigt, versteckt, baut oder schliesst, ist
// `cfg(desktop)`: `show`, `hide`, `destroy` und der Fenster-Builder mit Titel
// und Groesse gibt es in Tauri fuer Android und iOS gar nicht. Wichtiger als
// der Baufehler ist die Regel dahinter. Auf dem Handy darf NIE ein zweites
// Webview fuer das Onboarding entstehen: es laege unsichtbar hinter dem
// einzigen Fenster, und das Hauptfenster wuerde ewig darauf warten.
//
// Deshalb gibt es `open()` dort nicht, `onboarding_window_open` antwortet
// immer `false` (es findet kein Fenster mit dem Label), und der Assistent
// laeuft im Hauptwebview, so wie `AppShell.tsx` ihn seit jeher zeichnen kann.
// Die zwei Funktionen hier halten nur die Aufrufer aus `commands` am Leben.

/// `show_window` auf dem Handy: nichts zu tun, das eine Fenster ist von Anfang
/// an sichtbar (`visible: true` in tauri.android.conf.json und
/// tauri.ios.conf.json).
#[cfg(mobile)]
pub fn reveal(_window: &WebviewWindow) {}

/// Der Marker wurde geschrieben oder geloescht. Auf dem Handy folgt ihm kein
/// Fenster, das Frontend liest den Marker selbst.
#[cfg(mobile)]
pub fn follow_marker(_app: &AppHandle, _done: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    const LIB_RS: &str = include_str!("lib.rs");
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

    // ── Schließen des Onboarding-Fensters ─────────────────────────────────

    #[test]
    fn erstinstallation_abgebrochen_beendet_die_app() {
        assert_eq!(on_close(false, false), OnClose::Quit);
    }

    #[test]
    fn erneuter_durchlauf_abgebrochen_fuehrt_zurueck_in_die_app() {
        assert_eq!(on_close(false, true), OnClose::BackToTheApp);
    }

    #[test]
    fn fertiges_onboarding_schliesst_ohne_folgen() {
        assert_eq!(on_close(true, false), OnClose::Nothing);
        assert_eq!(on_close(true, true), OnClose::Nothing);
    }

    #[test]
    fn nur_das_zuruecksetzen_merkt_sich_den_erneuten_durchlauf() {
        let src = include_str!("onboarding_window.rs");
        let follow = &src[src.find("pub fn follow_marker(app: &AppHandle, done: bool)").unwrap()..];
        let body = &follow[..follow.find("\n}\n").unwrap()];
        assert!(body.contains("RERUN.store(!done"), "follow_marker must record the re-run");
        let handler = &src[src.find("window.on_window_event").unwrap()..];
        assert!(handler[..400].contains("on_close(is_onboarding_done(), RERUN.load"));
    }

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

    /// Auf dem Handy darf kein zweites Fenster entstehen. Der Handy-Bau laeuft
    /// nicht in diesem Testlauf, also wird gelesen, was er uebersetzen wuerde.
    #[test]
    fn ein_handy_bekommt_kein_zweites_fenster() {
        let src = include_str!("onboarding_window.rs");
        // Jede Funktion, die ein Fenster baut, zeigt, versteckt oder schliesst.
        for signatur in [
            "pub fn reveal(window: &WebviewWindow) {",
            "pub fn open(app: &AppHandle) -> tauri::Result<WebviewWindow> {",
            "fn quit(app: &AppHandle) {",
            "pub fn follow_marker(app: &AppHandle, done: bool) {",
            "pub fn bring_to_front(app: &AppHandle) {",
            "pub fn force_show_after(app: AppHandle, delay: Duration) {",
            "fn handover_fallback(app: AppHandle, delay: Duration) {",
        ] {
            assert!(
                src.contains(&format!("#[cfg(desktop)]\n{signatur}")),
                "{signatur} muss cfg(desktop) sein"
            );
        }
        // Was das Handy stattdessen hat, baut nichts.
        let handy = &src[src.find("// ── Ein Handy hat genau ein Fenster").expect("Abschnitt da")
            ..src.find("#[cfg(test)]\nmod tests {").expect("Tests folgen")];
        assert!(handy.contains("#[cfg(mobile)]\npub fn reveal(_window: &WebviewWindow) {}"));
        assert!(handy.contains("#[cfg(mobile)]\npub fn follow_marker(_app: &AppHandle, _done: bool) {}"));
        let code: String = handy.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for verboten in ["WebviewWindowBuilder::new", "open(", ".build()", ".show()"] {
            assert!(!code.contains(verboten), "der Handy-Teil darf kein Fenster bauen: {verboten}");
        }
        // Und das Setup ruft die Entscheidung und den Notweg nur am Desktop.
        let setup = &LIB_RS[LIB_RS.find(".setup(|app| {").expect("setup exists")..];
        let setup = &setup[..setup.find(".build(tauri::generate_context!())").expect("build follows setup")];
        assert!(setup.contains(
            "#[cfg(desktop)]\n            if onboarding_window::decide_first_window() == onboarding_window::FirstWindow::Onboarding {"
        ));
        assert!(setup.contains("#[cfg(desktop)]\n            onboarding_window::force_show_after("));
        // Das Kommando, das das Frontend fragt, bleibt auf jeder Plattform da
        // und antwortet auf dem Handy mangels Fenster mit false.
        assert!(src.contains("#[tauri::command]\npub fn onboarding_window_open(app: AppHandle) -> bool {"));
    }

    #[test]
    fn das_setup_entscheidet_vor_dem_ersten_fenster() {
        let setup = &LIB_RS[LIB_RS.find(".setup(|app| {").expect("setup exists")..];
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
        let main_fn = &LIB_RS[LIB_RS.find("\npub fn run() {").expect("run exists")..];
        let main_fn = &main_fn[..main_fn.find("\n}\n").expect("main ends")];
        assert_eq!(
            main_fn.matches("onboarding_window::bring_to_front(").count(),
            4,
            "single-instance, tray Show, tray double-click and the Dock click must all use bring_to_front"
        );
    }

    // ── A24: die Frage des Hauptfensters mitten im Fensterbau ─────────────

    #[test]
    fn die_frage_mitten_im_fensterbau_bekommt_ja() {
        // Der Ablauf vom 21.10. ohne WebView2: das Hauptfenster fragt,
        // während `build()` noch läuft und das Fenster noch nicht
        // eingetragen ist. Vorher hieß die Antwort hier „nein".
        let mut asked_during_build = None;
        while_building(|| asked_during_build = Some(delegated(false)));
        assert_eq!(asked_during_build, Some(true), "the main window must wait for the onboarding being built");
        // Danach zählt wieder nur das eingetragene Fenster: ein Neuladen nach
        // der Übergabe (Fenster zerstört) bootet die App sofort.
        assert!(!delegated(false));
        assert!(delegated(true));
    }

    #[test]
    fn der_bau_zaehlt_auch_wenn_er_scheitert_nicht_weiter() {
        let result: Result<(), &str> = while_building(|| Err("webview2 failed"));
        assert!(result.is_err());
        assert!(!delegated(false), "a failed build must not leave the main window waiting forever");
    }

    #[test]
    fn open_baut_das_fenster_im_waechter_und_das_kommando_fragt_beides() {
        let src = include_str!("onboarding_window.rs");
        let open_fn = &src[src.find("pub fn open(").expect("open exists")..];
        let open_fn = &open_fn[..open_fn.find("\n}\n").expect("open ends")];
        assert!(open_fn.contains("while_building(|| builder.build())?"), "{open_fn}");
        assert_eq!(open_fn.matches(".build()").count(), 1, "every build must run inside while_building");
        let cmd = &src[src.find("pub fn onboarding_window_open(").expect("command exists")..];
        let cmd = &cmd[..cmd.find("\n}\n").expect("command ends")];
        assert!(cmd.contains("delegated(app.get_webview_window(ONBOARDING).is_some())"), "{cmd}");
    }

    #[test]
    fn das_kommando_ist_registriert() {
        assert!(
            LIB_RS.contains("onboarding_window::onboarding_window_open,"),
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

    /// Der Fensterbau gehört NICHT in den synchronen IPC-Handler.
    ///
    /// `set_onboarding_done` ist der einzige Befehl, der zur Laufzeit ein
    /// zweites WebView-Fenster baut: `follow_marker(false)` ruft `open()`,
    /// und das ist der einzige `WebviewWindowBuilder` der App. Ein
    /// synchroner Tauri-Befehl läuft im Faden des AUFRUFERS, und der ist auf
    /// Windows der Hauptfaden mitten im WebResourceRequested-Handler von
    /// WebView2, mit offenem Deferral für genau die IPC-Anfrage, die er
    /// beantworten soll. Ein Fensterbau pumpt dort eine geschachtelte
    /// Windows-Nachrichtenschleife und wartet auf denselben Browserprozess,
    /// der auf diese Antwort wartet. Der Befehl kehrt nie zurück, und mit ihm
    /// antwortet die GANZE Befehlsschicht auf nichts mehr: gemessen auf der
    /// Testbox am 11.09.2026 (T11, Punkt 2) als vier leere Chatantworten,
    /// Models-Tab dauerhaft auf `Loading models`, das Fensterkreuz ohne
    /// Wirkung, und nur `taskkill /F /T` half.
    ///
    /// Quelltextwächter mit Absicht: der Fix ist, welches Attribut Tauris
    /// Makro sieht. Er ändert, wie der BEFEHL ausgeliefert wird, nicht was
    /// die Rust-Funktion tut, also kann kein Aufruf im Prozess ihn
    /// beobachten. Gleiches Vorbild: `fs_search_is_dispatched_off_the_main_thread`
    /// in `commands/filesystem.rs`.
    #[test]
    fn set_onboarding_done_baut_das_fenster_nicht_auf_dem_hauptfaden() {
        let at = SYSTEM_RS.find("pub fn set_onboarding_done(").expect("exists");
        let head = &SYSTEM_RS[..at];
        let preamble = &head[head.rfind("\n\n").map(|i| i + 2).unwrap_or(0)..];
        assert!(
            preamble.contains("#[tauri::command(async)]"),
            "set_onboarding_done builds a window and must not run on the main thread:\n{preamble}",
        );
        assert!(
            !preamble.contains("#[tauri::command]"),
            "set_onboarding_done is back on the plain (main-thread) command attribute:\n{preamble}",
        );
        assert!(preamble.len() < 2_000, "the slice ran past the attribute block");
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
