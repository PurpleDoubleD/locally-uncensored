// The tray menu (T2, 3.0.9): a short Claude-Desktop-style menu instead of
// "Show" / "Quit".
//
//   LU Cloud · Signed in              Local · LU Engine
//   ● Pro plan · active               ● Qwen3 8B · ready
//   1,240 credits left · …            GPU memory 9.2 of 24 GB
//   ─────────                         ─────────
//   Plan & Credits…                   Models…
//   ─────────                         ─────────
//   Open LU                           Open LU
//   Quit LU                           Quit LU
//
// The grey lines are disabled items. The frontend knows the account, the
// engine and the model, so it sends the lines (`tray_update`); this side
// only checks and lays them out. The action is one of two fixed actions with
// labels from here, so a page can change what the menu says but never what
// a click does. Hovering or clicking the icon emits `lu-tray-opened`, and
// the frontend answers with fresh lines; it also refreshes on its own timer.
//
// An open menu does NOT change on a Mac (test build, 31.10.): while it is
// open, AppKit's menu loop holds the main thread, and the update lands when
// the menu has closed. So the lines have to be fresh before the click, which
// is what the hover and the timer are for.
//
// Texts, dots and the action's label change in place; only a different
// number of grey lines builds a new menu. The page keeps that number at
// three, so the menu is built once and then only relabelled.

use serde::Deserialize;

/// The id the tray is built with, so `tray_update` finds it again.
pub(crate) const TRAY_ID: &str = "lu-tray";
/// Emitted on a click on (or the pointer entering) the tray icon.
pub(crate) const OPENED_EVENT: &str = "lu-tray-opened";
/// Emitted with "plan" or "models" when the action item is clicked.
pub(crate) const ACTION_EVENT: &str = "lu-tray-action";

pub(crate) const OPEN_ID: &str = "open";
/// The one action item: "Plan & Credits…" or "Models…", whichever the
/// current status names.
pub(crate) const ACTION_ID: &str = "tray-action";
pub(crate) const QUIT_ID: &str = "quit";
const INFO_ID_PREFIX: &str = "info-";

/// At most this many grey lines: the menu stays as short as the mock.
pub(crate) const MAX_LINES: usize = 3;
/// Longer lines are cut with "…" (a model file name can be very long).
pub(crate) const MAX_LINE_CHARS: usize = 44;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrayDot {
    Green,
    Amber,
    Grey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrayAction {
    Plan,
    Models,
}

impl TrayAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            // `&&`: a single `&` marks a keyboard mnemonic in a native menu
            // and disappears ("Plan  Credits…" in the first Mac build).
            TrayAction::Plan => "Plan && Credits…",
            TrayAction::Models => "Models…",
        }
    }
    /// The payload of `lu-tray-action`.
    pub(crate) fn event_name(self) -> &'static str {
        match self {
            TrayAction::Plan => "plan",
            TrayAction::Models => "models",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct TrayLine {
    pub text: String,
    #[serde(default)]
    pub dot: Option<TrayDot>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub(crate) struct TrayStatus {
    #[serde(default)]
    pub lines: Vec<TrayLine>,
    #[serde(default)]
    pub action: Option<TrayAction>,
}

/// One line as the menu shows it: no control characters (a newline would
/// break a native menu item), no padding, cut to `MAX_LINE_CHARS`, and every
/// `&` doubled, because a single one is a mnemonic marker to the native menu
/// and would vanish from a model name like "R&D-7B".
pub(crate) fn clean_line(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = if flat.chars().count() <= MAX_LINE_CHARS {
        flat
    } else {
        let mut cut: String = flat.chars().take(MAX_LINE_CHARS - 1).collect();
        cut.truncate(cut.trim_end().len());
        cut.push('…');
        cut
    };
    cut.replace('&', "&&")
}

/// What the frontend sent, made safe to show: empty lines dropped, at most
/// `MAX_LINES`.
pub(crate) fn sanitize(status: TrayStatus) -> TrayStatus {
    let lines = status
        .lines
        .into_iter()
        .map(|l| TrayLine { text: clean_line(&l.text), dot: l.dot })
        .filter(|l| !l.text.is_empty())
        .take(MAX_LINES)
        .collect();
    TrayStatus { lines, action: status.action }
}

/// The rows of the menu, top to bottom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Row {
    Info(TrayLine),
    Separator,
    Action(TrayAction),
    Open,
    Quit,
}

pub(crate) fn layout(status: &TrayStatus) -> Vec<Row> {
    let mut rows: Vec<Row> = status.lines.iter().cloned().map(Row::Info).collect();
    if let Some(action) = status.action {
        if !rows.is_empty() {
            rows.push(Row::Separator);
        }
        rows.push(Row::Action(action));
    }
    if !rows.is_empty() {
        rows.push(Row::Separator);
    }
    rows.push(Row::Open);
    rows.push(Row::Quit);
    rows
}

/// Two statuses with the same shape differ only in texts, dots and which
/// action the action item names, all of which change in place. Anything else
/// needs a new menu.
pub(crate) fn same_shape(a: &TrayStatus, b: &TrayStatus) -> bool {
    a.lines.len() == b.lines.len() && a.action.is_some() == b.action.is_some()
}

#[cfg(desktop)]
fn memory_line(label: &'static str, used_gb: f64, total_gb: f64) -> TrayMemory {
    TrayMemory { label, used_gb: used_gb.clamp(0.0, total_gb), total_gb }
}

/// A filled circle as RGBA, the dot in front of a status line.
pub(crate) fn dot_rgba(dot: TrayDot, size: u32) -> Vec<u8> {
    let (r, g, b) = match dot {
        TrayDot::Green => (0x30, 0xd1, 0x58),
        TrayDot::Amber => (0xff, 0xb3, 0x40),
        TrayDot::Grey => (0x98, 0x98, 0x9d),
    };
    // The circle sits in the middle third of the square, about the size of
    // a text bullet; the rest stays clear so the icon column keeps its width.
    let c = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 * 0.22;
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            // One pixel of soft edge.
            let a = (radius + 0.5 - d).clamp(0.0, 1.0);
            out.extend_from_slice(&[r, g, b, (a * 255.0) as u8]);
        }
    }
    out
}

#[cfg(desktop)]
pub(crate) use desktop::*;

#[cfg(desktop)]
mod desktop {
    use super::*;
    use std::sync::Mutex;
    use tauri::{
        image::Image,
        menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
        AppHandle, Manager, Runtime,
    };

    const DOT_SIZE: u32 = 32;

    /// The live menu: its shape and the items whose text changes.
    pub(crate) struct TrayMenuState<R: Runtime> {
        inner: Mutex<Option<Live<R>>>,
    }

    struct Live<R: Runtime> {
        status: TrayStatus,
        items: MenuItems<R>,
    }

    /// The items whose text changes in place.
    pub(crate) struct MenuItems<R: Runtime> {
        infos: Vec<IconMenuItem<R>>,
        action: Option<MenuItem<R>>,
    }

    impl<R: Runtime> Default for TrayMenuState<R> {
        fn default() -> Self {
            Self { inner: Mutex::new(None) }
        }
    }

    fn dot_image(dot: Option<TrayDot>) -> Option<Image<'static>> {
        dot.map(|d| Image::new_owned(dot_rgba(d, DOT_SIZE), DOT_SIZE, DOT_SIZE))
    }

    /// Build the menu for `status`. Returns the menu and the items that
    /// change in place.
    pub(crate) fn build_menu<R: Runtime, M: Manager<R>>(
        app: &M,
        status: &TrayStatus,
    ) -> tauri::Result<(Menu<R>, MenuItems<R>)> {
        let menu = Menu::new(app)?;
        let mut infos = Vec::new();
        let mut action = None;
        for (i, row) in layout(status).into_iter().enumerate() {
            match row {
                Row::Info(line) => {
                    let item = IconMenuItem::with_id(
                        app,
                        format!("{INFO_ID_PREFIX}{i}"),
                        &line.text,
                        false,
                        dot_image(line.dot),
                        None::<&str>,
                    )?;
                    menu.append(&item)?;
                    infos.push(item);
                }
                Row::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
                Row::Action(a) => {
                    let item = MenuItem::with_id(app, ACTION_ID, a.label(), true, None::<&str>)?;
                    menu.append(&item)?;
                    action = Some(item);
                }
                Row::Open => menu.append(&MenuItem::with_id(app, OPEN_ID, "Open LU", true, None::<&str>)?)?,
                Row::Quit => {
                    // ⌘Q next to Quit, as in every Mac menu. On Windows and
                    // Linux a tray menu has no shortcuts.
                    #[cfg(target_os = "macos")]
                    let accel = Some("CmdOrCtrl+Q");
                    #[cfg(not(target_os = "macos"))]
                    let accel = None::<&str>;
                    menu.append(&MenuItem::with_id(app, QUIT_ID, "Quit LU", true, accel)?)?
                }
            }
        }
        Ok((menu, MenuItems { infos, action }))
    }

    /// Show `status` in the tray menu. Same shape: texts and dots change in
    /// place. Otherwise a new menu is set. No tray (Linux without
    /// AppIndicator, GH #204): nothing happens.
    pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, status: TrayStatus) -> tauri::Result<()> {
        let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
        let Some(state) = app.try_state::<TrayMenuState<R>>() else { return Ok(()) };
        let status = sanitize(status);
        let mut live = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cur) = live.as_mut().filter(|cur| same_shape(&cur.status, &status)) {
            for (item, (old, new)) in cur.items.infos.iter().zip(cur.status.lines.iter().zip(&status.lines)) {
                if old.text != new.text {
                    item.set_text(&new.text)?;
                }
                if old.dot != new.dot {
                    item.set_icon(dot_image(new.dot))?;
                }
            }
            if let (Some(item), Some(new)) = (&cur.items.action, status.action) {
                if cur.status.action != Some(new) {
                    item.set_text(new.label())?;
                }
            }
            cur.status = status;
            return Ok(());
        }
        let (menu, items) = build_menu(app, &status)?;
        tray.set_menu(Some(menu))?;
        *live = Some(Live { status, items });
        Ok(())
    }

    /// The action the action item names right now.
    pub(crate) fn current_action<R: Runtime>(app: &AppHandle<R>) -> Option<TrayAction> {
        let state = app.try_state::<TrayMenuState<R>>()?;
        let live = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        live.as_ref()?.status.action
    }

    /// Record the menu the tray was built with, so the first update can
    /// change it in place.
    pub(crate) fn remember<R: Runtime>(app: &AppHandle<R>, status: TrayStatus, items: MenuItems<R>) {
        if let Some(state) = app.try_state::<TrayMenuState<R>>() {
            *state.inner.lock().unwrap_or_else(|e| e.into_inner()) = Some(Live { status, items });
        }
    }

    /// Memory in use for the menu's third line: an NVIDIA card through
    /// nvidia-smi ("GPU memory"), otherwise the computer's memory through
    /// sysinfo ("Memory"; on a Mac that is where the model lives, the
    /// unified memory). `None` only when neither can be read.
    #[derive(Debug, Clone, PartialEq, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct TrayMemory {
        pub label: &'static str,
        pub used_gb: f64,
        pub total_gb: f64,
    }

    #[tauri::command]
    pub(crate) async fn tray_memory() -> Option<TrayMemory> {
        tauri::async_runtime::spawn_blocking(measure_memory).await.ok().flatten()
    }

    fn measure_memory() -> Option<TrayMemory> {
        const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
        if let Some((free, total)) = crate::commands::gpu::nvidia_memory_mib() {
            return Some(memory_line("GPU memory", (total - free) as f64 / 1024.0, total as f64 / 1024.0));
        }
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let total = sys.total_memory() as f64 / GIB;
        (total > 0.0).then(|| memory_line("Memory", sys.used_memory() as f64 / GIB, total))
    }

    /// The frontend's lines for the tray menu.
    #[tauri::command]
    pub(crate) fn tray_update(app: AppHandle, status: TrayStatus) -> Result<(), String> {
        apply(&app, status).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(t: &str) -> TrayLine {
        TrayLine { text: t.into(), dot: None }
    }

    #[test]
    fn cloud_menu_matches_the_mock() {
        let s = TrayStatus {
            lines: vec![
                line("LU Cloud · Signed in"),
                TrayLine { text: "Pro plan · active".into(), dot: Some(TrayDot::Green) },
                line("1,240 credits left · renews Nov 14"),
            ],
            action: Some(TrayAction::Plan),
        };
        let rows = layout(&sanitize(s.clone()));
        assert_eq!(
            rows,
            vec![
                Row::Info(s.lines[0].clone()),
                Row::Info(s.lines[1].clone()),
                Row::Info(s.lines[2].clone()),
                Row::Separator,
                Row::Action(TrayAction::Plan),
                Row::Separator,
                Row::Open,
                Row::Quit,
            ]
        );
    }

    #[test]
    fn before_the_frontend_speaks_the_menu_is_open_and_quit() {
        assert_eq!(layout(&TrayStatus::default()), vec![Row::Open, Row::Quit]);
    }

    #[test]
    fn lines_without_an_action_still_get_one_separator() {
        let s = TrayStatus { lines: vec![line("Local · Ollama")], action: None };
        assert_eq!(layout(&s), vec![Row::Info(line("Local · Ollama")), Row::Separator, Row::Open, Row::Quit]);
    }

    #[test]
    fn at_most_three_lines_and_no_empty_ones() {
        let s = TrayStatus {
            lines: vec![line("a"), line("  "), line("b"), line("c"), line("d")],
            action: None,
        };
        let texts: Vec<_> = sanitize(s).lines.into_iter().map(|l| l.text).collect();
        assert_eq!(texts, ["a", "b", "c"]);
    }

    #[test]
    fn a_newline_or_tab_cannot_break_the_menu_item() {
        assert_eq!(clean_line("Qwen3\n8B\t· ready\r"), "Qwen3 8B · ready");
    }

    #[test]
    fn an_ampersand_survives_the_native_menu() {
        assert_eq!(clean_line("R&D-7B · ready"), "R&&D-7B · ready");
    }

    #[test]
    fn a_long_model_name_is_cut_with_an_ellipsis() {
        let long = "Llama-3.3-70B-Instruct-abliterated-Q4_K_M-imatrix-final.gguf · ready";
        let cut = clean_line(long);
        assert_eq!(cut.chars().count(), MAX_LINE_CHARS);
        assert!(cut.ends_with('…'));
        assert!(long.starts_with(cut.trim_end_matches('…')));
    }

    #[test]
    fn the_action_comes_from_a_fixed_list() {
        // Labels and ids live here; the page only names one of two actions.
        assert!(serde_json::from_str::<TrayStatus>(r#"{"action":"delete-everything"}"#).is_err());
        let s: TrayStatus = serde_json::from_str(r#"{"lines":[{"text":"x","dot":"green"}],"action":"models"}"#).unwrap();
        assert_eq!(s.action, Some(TrayAction::Models));
        assert_eq!(TrayAction::Plan.label(), "Plan && Credits…", "a single & would vanish");
        assert_eq!(TrayAction::Models.event_name(), "models");
    }

    #[test]
    fn texts_dots_and_the_action_change_in_place_but_a_new_line_count_rebuilds() {
        // A rebuild closes a menu that is open, so Local ↔ Cloud with three
        // lines each must not be one.
        let a = TrayStatus { lines: vec![line("x"), line("y")], action: Some(TrayAction::Models) };
        let mut b = a.clone();
        b.lines[1] = TrayLine { text: "z".into(), dot: Some(TrayDot::Amber) };
        assert!(same_shape(&a, &b));
        let c = TrayStatus { action: Some(TrayAction::Plan), ..a.clone() };
        assert!(same_shape(&a, &c));
        b.lines.push(line("w"));
        assert!(!same_shape(&a, &b));
        assert!(!same_shape(&a, &TrayStatus { action: None, ..a.clone() }));
    }

    #[test]
    fn the_dot_is_a_round_spot_in_a_clear_square() {
        let px = dot_rgba(TrayDot::Green, 32);
        assert_eq!(px.len(), 32 * 32 * 4);
        let alpha = |x: usize, y: usize| px[(y * 32 + x) * 4 + 3];
        assert_eq!(alpha(16, 16), 255, "the middle is solid");
        assert_eq!(alpha(0, 0), 0, "the corner is clear");
        assert_eq!(alpha(16, 2), 0, "the circle does not touch the edge");
    }

    #[test]
    fn the_tray_is_built_with_the_id_and_the_menu_from_here() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("TrayIconBuilder::with_id(tray_menu::TRAY_ID)"));
        assert!(lib.contains("tray_menu::tray_update"), "tray_update is not in generate_handler!");
        assert!(!lib.contains("\"Show\""), "the old Show item is gone");
    }
}
