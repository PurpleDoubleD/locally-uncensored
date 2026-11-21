//! Wo das Hauptfenster steht (3.1.3, Davids Wunsch 21.11., gesehen auf purple).
//!
//! Das Onboarding-Fenster stand mittig (`.center()` in `onboarding_window`),
//! das Hauptfenster danach etwas nach links versetzt. Ursache: das
//! Hauptfenster aus `tauri.conf.json` hat keine Position, also setzt das
//! System es an seine Standardstelle (Windows: die Kaskade ab links oben),
//! und LU hat sich die Position des Nutzers nie gemerkt, auch nicht für
//! spätere Starts.
//!
//! Jetzt, einmal pro Prozess, bevor das Hauptfenster zum ersten Mal
//! erscheint:
//! * nach dem Onboarding: genau mittig auf dem Monitor, auf dem das
//!   Onboarding lag; passt die Standardgröße nicht auf dessen Arbeitsfläche,
//!   maximiert;
//! * bei einem Start: die gemerkte Stelle des Nutzers, solange ihr Kopf noch
//!   auf einem Monitor liegt; sonst (erster Start, Monitor weg) mittig wie
//!   oben, auf dem Monitor, auf dem das Fenster gerade steht.
//!
//! Gemerkt wird die Stelle in `<data>/window-place.json` (physische Pixel),
//! beim Verschieben und Größeziehen, gedrosselt, und beim Beenden.
//! Die Entscheidung ist rein (`decide`) und hier getestet; der Rest setzt sie
//! nur um.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The main window's size from `tauri.conf.json`, in logical pixels.
pub const DEFAULT_WIDTH: f64 = 1280.0;
pub const DEFAULT_HEIGHT: f64 = 800.0;

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What is remembered of the main window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    #[serde(flatten)]
    pub bounds: Bounds,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moment {
    /// The onboarding just finished in its own window.
    AfterOnboarding,
    /// The app starts and shows its main window.
    Start,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// The user's own place from the last run.
    Keep(Saved),
    /// Centred on a work area.
    Center(Bounds),
    /// The default size does not fit: maximized on this work area.
    Maximize(Bounds),
}

/// `width` x `height` centred on `work`, or maximized there when it does not fit.
pub fn centered(work: Bounds, width: u32, height: u32) -> Place {
    if width > work.width || height > work.height {
        return Place::Maximize(work);
    }
    Place::Center(Bounds {
        x: work.x + ((work.width - width) / 2) as i32,
        y: work.y + ((work.height - height) / 2) as i32,
        width,
        height,
    })
}

fn overlap(a: Bounds, b: Bounds) -> u64 {
    let left = a.x.max(b.x) as i64;
    let right = (a.x as i64 + a.width as i64).min(b.x as i64 + b.width as i64);
    let top = a.y.max(b.y) as i64;
    let bottom = (a.y as i64 + a.height as i64).min(b.y as i64 + b.height as i64);
    if right <= left || bottom <= top {
        return 0;
    }
    ((right - left) * (bottom - top)) as u64
}

/// Whether the top of a saved window, where it is dragged, still lies on
/// one of `works` far enough to be grabbed (a monitor can be gone since).
pub fn still_reachable(saved: Bounds, works: &[Bounds]) -> bool {
    let head = Bounds { height: saved.height.min(40), ..saved };
    let need = (saved.width.min(160) as u64) * (head.height.min(24) as u64);
    saved.width > 0 && saved.height > 0 && works.iter().any(|w| overlap(head, *w) >= need)
}

/// Where the main window goes. `home` is the work area of the monitor that
/// counts (the onboarding's, or the one the window stands on), `works` every
/// monitor's, `size` the default size in physical pixels of `home`.
pub fn decide(moment: Moment, saved: Option<Saved>, works: &[Bounds], home: Bounds, size: (u32, u32)) -> Place {
    match (moment, saved) {
        (Moment::Start, Some(s)) if still_reachable(s.bounds, works) => Place::Keep(s),
        _ => centered(home, size.0, size.1),
    }
}

// ── The window itself ──────────────────────────────────────────────────

static PLACED: AtomicBool = AtomicBool::new(false);

fn work_of(m: &Monitor) -> Bounds {
    let w = m.work_area();
    let tauri_says = Bounds { x: w.position.x, y: w.position.y, width: w.size.width, height: w.size.height };
    #[cfg(target_os = "macos")]
    if let Some(real) = mac::visible_frame(m) {
        return real;
    }
    tauri_says
}

/// Pure: an AppKit screen (bottom-left origin, points, y up from the bottom
/// of the primary screen) to Tauri's physical top-left coordinates.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn appkit_to_top_left(x: f64, y: f64, width: f64, height: f64, primary_height: f64, scale: f64) -> Bounds {
    Bounds {
        x: (x * scale).round() as i32,
        y: ((primary_height - y - height) * scale).round() as i32,
        width: (width * scale).round() as u32,
        height: (height * scale).round() as u32,
    }
}

/// macOS: Tauri's `work_area` takes the height of the visible frame but keeps
/// the top of the screen as its y (tauri-runtime-wry 2.10, monitor/macos.rs),
/// so a window centred on it sat half a menu bar too high. The real visible
/// frame comes from NSScreen. Main thread only; elsewhere `None` and Tauri's
/// area stands.
#[cfg(target_os = "macos")]
mod mac {
    use super::{appkit_to_top_left, Bounds};
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;

    pub fn visible_frame(m: &tauri::Monitor) -> Option<Bounds> {
        let mtm = MainThreadMarker::new()?;
        let screens = NSScreen::screens(mtm);
        let primary_height = screens.firstObject()?.frame().size.height;
        for screen in screens.iter() {
            let scale = screen.backingScaleFactor();
            let f = screen.frame();
            let full = appkit_to_top_left(f.origin.x, f.origin.y, f.size.width, f.size.height, primary_height, scale);
            if full.x == m.position().x && full.y == m.position().y && full.width == m.size().width {
                let v = screen.visibleFrame();
                return Some(appkit_to_top_left(v.origin.x, v.origin.y, v.size.width, v.size.height, primary_height, scale));
            }
        }
        None
    }
}

fn file() -> std::path::PathBuf {
    crate::os_paths::data_dir().join("window-place.json")
}

fn load() -> Option<Saved> {
    serde_json::from_str(&std::fs::read_to_string(file()).ok()?).ok()
}

/// Put the main window in its place before it is first shown in this
/// process; after an onboarding (also a re-run from Settings) every time.
/// `home` is the onboarding's monitor after the onboarding.
pub fn place_once(window: &WebviewWindow, moment: Moment, home: Option<Monitor>) {
    if PLACED.swap(true, Ordering::SeqCst) && moment == Moment::Start {
        return;
    }
    let _ = window.unmaximize();
    let monitors = window.available_monitors().unwrap_or_default();
    let works: Vec<Bounds> = monitors.iter().map(work_of).collect();
    let Some(home) = home.or_else(|| window.current_monitor().ok().flatten()).or_else(|| window.primary_monitor().ok().flatten()) else {
        tracing::warn!("[window] no monitor known, the main window stays where the system put it");
        return;
    };
    let scale = home.scale_factor();
    let size = ((DEFAULT_WIDTH * scale).round() as u32, (DEFAULT_HEIGHT * scale).round() as u32);
    let place = decide(moment, if moment == Moment::Start { load() } else { None }, &works, work_of(&home), size);
    match place {
        Place::Keep(s) => {
            put(window, s.bounds);
            if s.maximized {
                let _ = window.maximize();
            }
        }
        Place::Center(b) => put(window, b),
        Place::Maximize(work) => {
            let _ = window.set_position(PhysicalPosition::new(work.x, work.y));
            let _ = window.maximize();
        }
    }
    tracing::info!(
        "[window] {moment:?}: {place:?} on work area {:?} (scale {scale}); now at {:?} size {:?}",
        work_of(&home),
        window.outer_position().ok(),
        window.outer_size().ok()
    );
}

/// Position, size, position: a move onto a monitor with another scale makes
/// the system resize the window, so the position is set once more after.
fn put(window: &WebviewWindow, b: Bounds) {
    let _ = window.set_position(PhysicalPosition::new(b.x, b.y));
    let _ = window.set_size(PhysicalSize::new(b.width, b.height));
    let _ = window.set_position(PhysicalPosition::new(b.x, b.y));
}

struct Memory {
    last: Option<Saved>,
    written: Option<Instant>,
}

static MEMORY: Mutex<Memory> = Mutex::new(Memory { last: None, written: None });

/// After a move or a resize of the main window: remember where it is. A
/// maximized window keeps the place it had before, plus the flag.
pub fn remember(window: &WebviewWindow) {
    if !PLACED.load(Ordering::SeqCst) || !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut m = MEMORY.lock().unwrap_or_else(|e| e.into_inner());
    let bounds = match (maximized, m.last) {
        (true, Some(prev)) => prev.bounds,
        _ => match (window.outer_position(), window.outer_size()) {
            (Ok(p), Ok(s)) => Bounds { x: p.x, y: p.y, width: s.width, height: s.height },
            _ => return,
        },
    };
    m.last = Some(Saved { bounds, maximized });
    if m.written.is_none_or(|t| t.elapsed() > Duration::from_millis(500)) {
        m.written = Some(Instant::now());
        write(m.last);
    }
}

/// Write the last place down (at quit and on close).
pub fn flush() {
    let m = MEMORY.lock().unwrap_or_else(|e| e.into_inner());
    write(m.last);
}

fn write(saved: Option<Saved>) {
    let Some(saved) = saved else { return };
    if let Ok(json) = serde_json::to_string(&saved) {
        let path = file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: Bounds = Bounds { x: 0, y: 0, width: 1920, height: 1040 };
    const RIGHT: Bounds = Bounds { x: 1920, y: 0, width: 2560, height: 1400 };

    #[test]
    fn after_the_onboarding_the_window_is_exactly_centred_on_the_onboardings_monitor() {
        let place = decide(Moment::AfterOnboarding, None, &[FHD, RIGHT], RIGHT, (1280, 800));
        assert_eq!(place, Place::Center(Bounds { x: 1920 + 640, y: 300, width: 1280, height: 800 }));
        // A saved place does not count after the onboarding.
        let saved = Saved { bounds: Bounds { x: 10, y: 10, width: 900, height: 700 }, maximized: false };
        assert_eq!(decide(Moment::AfterOnboarding, Some(saved), &[FHD, RIGHT], RIGHT, (1280, 800)), place);
    }

    #[test]
    fn a_default_size_larger_than_the_work_area_is_maximized() {
        let small = Bounds { x: 0, y: 0, width: 1366, height: 728 };
        assert_eq!(decide(Moment::AfterOnboarding, None, &[small], small, (1280, 800)), Place::Maximize(small));
        // 150 %: 1920 x 1200 physical on a 1920 x 1040 work area.
        assert_eq!(centered(FHD, 1920, 1200), Place::Maximize(FHD));
    }

    #[test]
    fn a_later_start_keeps_the_users_place_and_the_first_one_is_centred() {
        let saved = Saved { bounds: Bounds { x: 2100, y: 120, width: 1500, height: 1000 }, maximized: true };
        assert_eq!(decide(Moment::Start, Some(saved), &[FHD, RIGHT], FHD, (1280, 800)), Place::Keep(saved));
        assert_eq!(
            decide(Moment::Start, None, &[FHD, RIGHT], FHD, (1280, 800)),
            Place::Center(Bounds { x: 320, y: 120, width: 1280, height: 800 })
        );
    }

    #[test]
    fn a_saved_place_on_a_monitor_that_is_gone_is_centred_instead() {
        let saved = Saved { bounds: Bounds { x: 2100, y: 120, width: 1500, height: 1000 }, maximized: false };
        assert!(matches!(decide(Moment::Start, Some(saved), &[FHD], FHD, (1280, 800)), Place::Center(_)));
        // Only its lower part on screen, the head above the top edge: not reachable.
        let above = Bounds { x: 100, y: -900, width: 1200, height: 1000 };
        assert!(!still_reachable(above, &[FHD]));
        // The head half off the left edge is still fine.
        assert!(still_reachable(Bounds { x: -600, y: 50, width: 1200, height: 800 }, &[FHD]));
    }

    #[test]
    fn an_appkit_screen_turns_into_top_left_pixels() {
        // MacBook Pro 16", 1728 x 1117 pt at 2x: menu bar 37 pt on top, Dock 60 pt below.
        let visible = appkit_to_top_left(0.0, 60.0, 1728.0, 1020.0, 1117.0, 2.0);
        assert_eq!(visible, Bounds { x: 0, y: 74, width: 3456, height: 2040 });
        // A second screen above the primary one has a negative top.
        assert_eq!(appkit_to_top_left(0.0, 1117.0, 1920.0, 1080.0, 1117.0, 1.0), Bounds { x: 0, y: -1080, width: 1920, height: 1080 });
    }

    #[test]
    fn the_saved_file_reads_back() {
        let saved = Saved { bounds: Bounds { x: -10, y: 5, width: 1280, height: 800 }, maximized: true };
        let json = serde_json::to_string(&saved).unwrap();
        assert_eq!(json, r#"{"x":-10,"y":5,"width":1280,"height":800,"maximized":true}"#);
        assert_eq!(serde_json::from_str::<Saved>(&json).unwrap(), saved);
        let old: Saved = serde_json::from_str(r#"{"x":1,"y":2,"width":3,"height":4}"#).unwrap();
        assert!(!old.maximized);
    }

    #[test]
    fn reveal_places_the_main_window_before_it_shows_it() {
        let src = include_str!("onboarding_window.rs");
        let reveal = &src[src.find("pub fn reveal(window: &WebviewWindow) {").unwrap()..];
        let reveal = &reveal[..reveal.find("\n}\n").unwrap()];
        let place = reveal.find("place_main(").expect("reveal places the window");
        assert!(place < reveal.find("window.show()").unwrap());
        let lib = include_str!("lib.rs");
        assert!(lib.contains("window_place::remember(&w)"), "moves are remembered");
        assert!(lib.contains("window_place::flush()"), "and written at the end");
    }
}
