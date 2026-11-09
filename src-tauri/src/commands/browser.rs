//! The LU browser: a window next to LU that a model may READ (P-L, 3.1.0).
//!
//! Step one, as David decided on 09.11.2026: open a page, read it, scroll,
//! follow a plain link, take a screenshot. The user can take over at any time.
//! Typing, forms, logins and downloads are not part of this step; they come
//! later and only behind a yes card.
//!
//! What keeps a page in its place:
//!
//! - The window has NO Tauri capability. Every file in `capabilities/` names
//!   its windows, none names `lu-browser`, and none has a `remote` scope, so a
//!   page in here cannot call a single command of the app.
//! - Its own data store, gone when it closes (`incognito`): no cookie, no
//!   login and no storage of the user's other sessions is in it.
//! - Every navigation is checked (`nav_allowed`): http(s) only, no local or
//!   private address. An address the model chose is checked once more with a
//!   real DNS answer before the window goes there (`web_reach::model_url_addrs`).
//! - Downloads are refused, new windows are refused (a link meant for a new
//!   window opens here, after the same check).
//! - What the page says is read by a script of ours. On macOS it runs in its
//!   own JavaScript world (`WKContentWorld`), where the page's scripts cannot
//!   see or change it. What it answers is still the page's text: DATA. The
//!   frontend wraps it as such (`src/lib/web-evidence.ts`).
//! - A link is followed by its address, never by a click event: a page's own
//!   click handlers (a form, a "buy" button dressed as a link) never run on
//!   the model's word.
//!
//! macOS and Windows. Linux and the phone answer that the browser is not there
//! yet; the tools are not offered there (`src/lib/browser-tools.ts`).

#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code, unused_imports))]

use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

pub(crate) const LABEL: &str = "lu-browser";
/// How long a page may take to load before the tool answers with what is there.
const LOAD_DEADLINE: Duration = Duration::from_secs(30);
/// How long a script in the page may take.
const EVAL_DEADLINE: Duration = Duration::from_secs(10);
/// Characters of page text one snapshot hands over.
const SNAPSHOT_CHARS: usize = 9_000;

#[derive(Default)]
struct BrowserState {
    /// The user took the browser over; the model's tools wait.
    user_has_control: bool,
    /// The addresses of the links of the last snapshot, by number (L1 = index 0).
    links: Vec<String>,
    /// Count of finished page loads, to wait for the next one.
    loads: u64,
}

static STATE: LazyLock<Mutex<BrowserState>> = LazyLock::new(|| Mutex::new(BrowserState::default()));

fn state() -> std::sync::MutexGuard<'static, BrowserState> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Hosts a page in the LU browser may never go to, judged on the address
/// alone (no DNS: this runs for every navigation, on the UI thread).
pub(crate) fn nav_allowed(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        // `about:blank` is the empty start page and harmless.
        return url.as_str() == "about:blank";
    }
    let Some(host) = url.host() else { return false };
    match host {
        url::Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            !(d == "localhost"
                || d.ends_with(".localhost")
                || d.ends_with(".local")
                || d.ends_with(".internal")
                || d.ends_with(".lan")
                || d.ends_with(".home.arpa")
                || !d.contains('.'))
        }
        url::Host::Ipv4(ip) => !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.octets()[0] == 100 && (ip.octets()[1] & 0xC0) == 64 || ip.octets()[0] == 169),
        url::Host::Ipv6(ip) => !(ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80),
    }
}

/// The page-reading script. One expression that answers a JSON string.
/// Text from the current scroll position down, in reading order, links marked
/// `[L3]` behind their words, the links listed with their addresses.
pub(crate) fn snapshot_script() -> String {
    format!(
        r#"(() => {{
  const MAX = {max};
  const startY = window.scrollY;
  const viewH = window.innerHeight;
  const styles = new Map();
  const cs = (el) => {{ let s = styles.get(el); if (!s) {{ s = getComputedStyle(el); styles.set(el, s); }} return s; }};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','IFRAME','HEAD','CANVAS','SELECT','OPTION','BUTTON','TEXTAREA']);
  const hidden = (el) => {{ for (let e = el; e && e !== document.documentElement; e = e.parentElement) {{ if (SKIP.has(e.tagName)) return true; const s = cs(e); if (s.display === 'none' || s.visibility === 'hidden') return true; if (e.getAttribute && e.getAttribute('aria-hidden') === 'true') return true; }} return false; }};
  const blockOf = (el) => {{ for (let e = el; e && e !== document.body; e = e.parentElement) {{ const d = cs(e).display; if (d && !d.startsWith('inline') && d !== 'contents') return e; }} return document.body; }};
  const links = []; const byHref = new Map();
  let text = ''; let lastBlock = null; let openLink = null; let cut = false;
  const closeLink = () => {{ if (openLink) {{ text += ' [L' + openLink + ']'; openLink = null; }} }};
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {{
    const raw = n.nodeValue; if (!raw || !raw.trim()) continue;
    const el = n.parentElement; if (!el || hidden(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 && cs(el).position !== 'fixed') continue;
    const a = el.closest('a[href]');
    let ref = null;
    if (a) {{
      let href = '';
      try {{ href = new URL(a.getAttribute('href'), document.baseURI).href; }} catch (e) {{}}
      if (/^https?:/i.test(href)) {{
        href = href.split('#')[0];
        ref = byHref.get(href);
        if (!ref && links.length < 120) {{ links.push({{ ref: 'L' + (links.length + 1), text: (a.innerText || a.title || '').trim().slice(0, 100), href }}); ref = links.length; byHref.set(href, ref); }}
      }}
    }}
    if (openLink && openLink !== ref) closeLink();
    const b = blockOf(el);
    if (b !== lastBlock) {{ closeLink(); text += '\n'; const h = /^H[1-6]$/.test(b.tagName) ? '#'.repeat(+b.tagName[1]) + ' ' : (b.tagName === 'LI' ? '- ' : ''); text += h; lastBlock = b; }}
    text += raw.replace(/\s+/g, ' ');
    if (ref) openLink = ref;
    if (text.length > MAX) {{ cut = true; break; }}
  }}
  closeLink();
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{{3,}}/g, '\n\n').trim().slice(0, MAX);
  return JSON.stringify({{
    url: location.href, title: document.title || '', lang: document.documentElement.lang || '',
    text, cut, links,
    scroll: {{ y: Math.round(startY), height: Math.round(document.documentElement.scrollHeight), view: Math.round(viewH) }},
    forms: document.forms.length,
    passwordFields: document.querySelectorAll('input[type=password]').length,
  }});
}})()"#,
        max = SNAPSHOT_CHARS
    )
}

fn scroll_script(down: bool) -> String {
    format!(
        "(() => {{ window.scrollBy(0, {}Math.round(window.innerHeight * 0.85)); return JSON.stringify({{ y: Math.round(window.scrollY) }}); }})()",
        if down { "" } else { "-" }
    )
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn unavailable() -> String {
    "The LU browser is available on macOS and Windows; this system does not have it yet. Use web_research or web_fetch.".to_string()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform {
    use super::*;
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    pub(super) fn window(app: &AppHandle) -> Option<WebviewWindow> {
        app.get_webview_window(LABEL)
    }

    /// Run `expr` (one expression that answers a JSON string) in the page and
    /// answer that string.
    pub(super) async fn eval_json(win: &WebviewWindow, expr: String) -> Result<String, String> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
        let send = move |r: Result<String, String>| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(r);
            }
        };
        win.with_webview(move |pw| eval_native(pw, expr, Box::new(send))).map_err(|e| e.to_string())?;
        match tokio::time::timeout(EVAL_DEADLINE, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("the page did not answer".to_string()),
            Err(_) => Err("the page did not answer in time".to_string()),
        }
    }

    type Done = Box<dyn Fn(Result<String, String>) + Send + 'static>;

    #[cfg(target_os = "macos")]
    fn eval_native(pw: tauri::webview::PlatformWebview, expr: String, done: Done) {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::MainThreadMarker;
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};
        let Some(mtm) = MainThreadMarker::new() else {
            done(Err("not on the main thread".into()));
            return;
        };
        // SAFETY: Tauri hands out the WKWebView of this window, alive for the
        // duration of the closure; the block below keeps no borrow of it.
        let wk: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
        // Our own world: the page's scripts cannot reach this one.
        let world: Retained<WKContentWorld> = unsafe { WKContentWorld::defaultClientWorld(mtm) };
        let body = NSString::from_str(&format!("return {expr};"));
        let block = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: a non-null NSError from WebKit.
                let e = unsafe { &*error };
                done(Err(format!("the page script failed: {}", e.localizedDescription())));
                return;
            }
            if result.is_null() {
                done(Err("the page script answered nothing".into()));
                return;
            }
            // SAFETY: the script answers JSON.stringify(...), a string.
            let obj = unsafe { &*result };
            match obj.downcast_ref::<NSString>() {
                Some(s) => done(Ok(s.to_string())),
                None => done(Err("the page script answered no text".into())),
            }
        });
        unsafe {
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(&body, None, None, &world, Some(&block));
        }
    }

    #[cfg(target_os = "windows")]
    fn eval_native(pw: tauri::webview::PlatformWebview, expr: String, done: Done) {
        use webview2_com::ExecuteScriptCompletedHandler;
        use windows::core::HSTRING;
        let core = match unsafe { pw.controller().CoreWebView2() } {
            Ok(c) => c,
            Err(e) => {
                done(Err(e.to_string()));
                return;
            }
        };
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |res, json: String| {
            match res {
                // ExecuteScript answers the value as JSON: our string, quoted.
                Ok(()) => match serde_json::from_str::<String>(&json) {
                    Ok(s) => done(Ok(s)),
                    Err(_) => done(Err("the page script answered no text".into())),
                },
                Err(e) => done(Err(e.to_string())),
            }
            Ok(())
        }));
        if let Err(e) = unsafe { core.ExecuteScript(&HSTRING::from(expr), &handler) } {
            // The handler is never called then; nobody else answers.
            let _ = e;
        }
    }

    /// The page as PNG bytes.
    pub(super) async fn screenshot(win: &WebviewWindow) -> Result<Vec<u8>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
        let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
        let send = move |r: Result<Vec<u8>, String>| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(r);
            }
        };
        win.with_webview(move |pw| shot_native(pw, Box::new(send))).map_err(|e| e.to_string())?;
        match tokio::time::timeout(EVAL_DEADLINE, rx).await {
            Ok(Ok(r)) => r,
            _ => Err("the screenshot did not come back in time".to_string()),
        }
    }

    type ShotDone = Box<dyn Fn(Result<Vec<u8>, String>) + Send + 'static>;

    #[cfg(target_os = "macos")]
    fn shot_native(pw: tauri::webview::PlatformWebview, done: ShotDone) {
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
        use objc2_foundation::{NSDictionary, NSError};
        use objc2_web_kit::WKWebView;
        // SAFETY: as in eval_native.
        let wk: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
        let block = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            if image.is_null() || !error.is_null() {
                done(Err("the browser could not take a screenshot".into()));
                return;
            }
            // SAFETY: a non-null NSImage from WebKit.
            let image = unsafe { &*image };
            let png = unsafe {
                image.TIFFRepresentation().and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff)).and_then(|rep| {
                    rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
                })
            };
            match png {
                Some(data) => done(Ok(data.to_vec())),
                None => done(Err("the screenshot could not be turned into a PNG".into())),
            }
        });
        unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &block) };
    }

    #[cfg(target_os = "windows")]
    fn shot_native(pw: tauri::webview::PlatformWebview, done: ShotDone) {
        use webview2_com::CapturePreviewCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
        use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};
        use windows::Win32::UI::Shell::SHCreateMemStream;
        let core = match unsafe { pw.controller().CoreWebView2() } {
            Ok(c) => c,
            Err(e) => {
                done(Err(e.to_string()));
                return;
            }
        };
        let Some(stream): Option<IStream> = (unsafe { SHCreateMemStream(None) }) else {
            done(Err("no memory stream for the screenshot".into()));
            return;
        };
        let read_back = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
            if let Err(e) = res {
                done(Err(e.to_string()));
                return Ok(());
            }
            let bytes = (|| -> windows::core::Result<Vec<u8>> {
                let mut stat = Default::default();
                unsafe { read_back.Stat(&mut stat, STATFLAG_NONAME)? };
                let len = stat.cbSize as usize;
                unsafe { read_back.Seek(0, STREAM_SEEK_SET, None)? };
                let mut buf = vec![0u8; len];
                let mut got = 0u32;
                unsafe { read_back.Read(buf.as_mut_ptr() as *mut _, len as u32, Some(&mut got)).ok()? };
                buf.truncate(got as usize);
                Ok(buf)
            })();
            match bytes {
                Ok(b) if !b.is_empty() => done(Ok(b)),
                Ok(_) => done(Err("the screenshot came back empty".into())),
                Err(e) => done(Err(e.to_string())),
            }
            Ok(())
        }));
        if let Err(e) = unsafe { core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) } {
            let _ = e;
        }
    }

    /// The window, made when it is not there. Placed to the right of LU.
    pub(super) fn ensure_window(app: &AppHandle, first: &url::Url) -> Result<(WebviewWindow, bool), String> {
        if let Some(w) = window(app) {
            return Ok((w, false));
        }
        let nav_app = app.clone();
        let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(first.clone()))
            .title("LU Browser · agent reading")
            .inner_size(1060.0, 820.0)
            .min_inner_size(480.0, 360.0)
            .incognito(true)
            .focused(false)
            .on_navigation(nav_allowed)
            .on_download(|_, _| false)
            .on_new_window(move |u, _| {
                // A link meant for a new tab opens here, after the same check.
                if nav_allowed(&u) {
                    if let Some(w) = window(&nav_app) {
                        let _ = w.navigate(u);
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .on_page_load(|_, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    state().loads += 1;
                }
            });
        if let Some(main) = app.get_webview_window("main") {
            if let (Ok(pos), Ok(size), Ok(scale)) = (main.outer_position(), main.outer_size(), main.scale_factor()) {
                let x = (pos.x as f64 + size.width as f64 * 0.55) / scale;
                let y = pos.y as f64 / scale + 40.0;
                b = b.position(x, y);
            }
        }
        let w = b.build().map_err(|e| format!("the browser window could not open: {e}"))?;
        w.on_window_event(|ev| {
            if matches!(ev, tauri::WindowEvent::Destroyed) {
                let mut s = state();
                s.user_has_control = false;
                s.links.clear();
            }
        });
        Ok((w, true))
    }
}

/// Check an address a model gave with a real DNS answer, off the UI thread.
async fn model_url_ok(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| format!("Invalid URL: {raw}"))?;
    if !nav_allowed(&url) || url.as_str() == "about:blank" {
        return Err(format!("Blocked: {url} is not a public web address."));
    }
    let check = url.to_string();
    tokio::task::spawn_blocking(move || crate::commands::web_reach::model_url_addrs(&check))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Blocked: {e}"))?;
    Ok(url)
}

fn taken_over() -> Option<String> {
    state().user_has_control.then(|| {
        "The user has taken over the LU browser. Wait until they hand it back, or ask them what they found.".to_string()
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn wait_for_load(win: &tauri::WebviewWindow, before: u64) {
    let started = std::time::Instant::now();
    while started.elapsed() < LOAD_DEADLINE {
        if state().loads > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    // Pages that build themselves after `load` get a short moment more.
    let _ = win;
    tokio::time::sleep(Duration::from_millis(600)).await;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn snapshot_of(win: &tauri::WebviewWindow) -> Result<Value, String> {
    let raw = platform::eval_json(win, snapshot_script()).await?;
    let mut v: Value = serde_json::from_str(&raw).map_err(|_| "the page answered something unreadable".to_string())?;
    let links: Vec<String> = v["links"]
        .as_array()
        .map(|a| a.iter().filter_map(|l| l["href"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    state().links = links;
    let text = v["text"].as_str().unwrap_or("").to_string();
    let suspect = !crate::commands::computer::desk::injection::scan(&text).is_empty();
    v["text"] = json!(crate::commands::web_research::defuse(&text));
    v["flags"] = if suspect { json!(["injection-suspect"]) } else { json!([]) };
    v["userHasControl"] = json!(state().user_has_control);
    Ok(v)
}

#[tauri::command]
pub async fn browser_open(app: tauri::AppHandle, url: String) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(why) = taken_over() {
            return Err(why);
        }
        let target = model_url_ok(&url).await?;
        let before = state().loads;
        let (win, fresh) = platform::ensure_window(&app, &target)?;
        if !fresh {
            win.navigate(target).map_err(|e| e.to_string())?;
        }
        let _ = win.show();
        wait_for_load(&win, before).await;
        snapshot_of(&win).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, url);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn browser_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(why) = taken_over() {
            return Err(why);
        }
        let win = platform::window(&app).ok_or("The LU browser is not open. Call browser_open with an address first.")?;
        snapshot_of(&win).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn browser_scroll(app: tauri::AppHandle, direction: Option<String>) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(why) = taken_over() {
            return Err(why);
        }
        let win = platform::window(&app).ok_or("The LU browser is not open. Call browser_open with an address first.")?;
        let down = !matches!(direction.as_deref().map(str::trim), Some("up"));
        platform::eval_json(&win, scroll_script(down)).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        snapshot_of(&win).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, direction);
        Err(unavailable())
    }
}

/// Follow link `L<n>` of the last snapshot by its address.
#[tauri::command]
pub async fn browser_click_link(app: tauri::AppHandle, link: String) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(why) = taken_over() {
            return Err(why);
        }
        let win = platform::window(&app).ok_or("The LU browser is not open. Call browser_open with an address first.")?;
        let n: usize = link
            .trim()
            .trim_start_matches(['L', 'l'])
            .parse()
            .map_err(|_| format!("{link} is no link of the last snapshot. Links are named L1, L2, …"))?;
        let href = state()
            .links
            .get(n.wrapping_sub(1))
            .cloned()
            .ok_or_else(|| format!("L{n} is not in the last snapshot. Take a new browser_snapshot."))?;
        let target = model_url_ok(&href).await?;
        let before = state().loads;
        win.navigate(target).map_err(|e| e.to_string())?;
        wait_for_load(&win, before).await;
        snapshot_of(&win).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, link);
        Err(unavailable())
    }
}

/// A PNG of the visible page, base64. The frontend shows it to the user.
#[tauri::command]
pub async fn browser_screenshot(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use base64::Engine;
        let win = platform::window(&app).ok_or("The LU browser is not open. Call browser_open with an address first.")?;
        let png = platform::screenshot(&win).await?;
        let url = win.url().map(|u| u.to_string()).unwrap_or_default();
        Ok(json!({ "url": url, "title": win.title().unwrap_or_default(), "png": base64::engine::general_purpose::STANDARD.encode(png) }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

/// The user's controls: `take_over`, `hand_back`, `close`, or `status`.
#[tauri::command]
pub async fn browser_control(app: tauri::AppHandle, action: String) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let win = platform::window(&app);
        match action.as_str() {
            "take_over" => {
                state().user_has_control = true;
                if let Some(w) = &win {
                    let _ = w.set_title("LU Browser · you have control");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "hand_back" => {
                state().user_has_control = false;
                if let Some(w) = &win {
                    let _ = w.set_title("LU Browser · agent reading");
                }
            }
            "close" => {
                if let Some(w) = &win {
                    let _ = w.destroy();
                }
                let mut s = state();
                s.user_has_control = false;
                s.links.clear();
            }
            "status" => {}
            other => return Err(format!("unknown browser action: {other}")),
        }
        let open = action != "close" && platform::window(&app).is_some();
        let url = if open { platform::window(&app).and_then(|w| w.url().ok()).map(|u| u.to_string()) } else { None };
        Ok(json!({ "open": open, "url": url, "userHasControl": state().user_has_control }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, action);
        Ok(json!({ "open": false, "available": false }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        nav_allowed(&url::Url::parse(s).unwrap())
    }

    #[test]
    fn the_browser_goes_to_public_web_pages_only() {
        assert!(ok("https://example.com/a?b=c"));
        assert!(ok("http://news.ycombinator.com/"));
        assert!(ok("about:blank"));
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://printer.local/",
            "http://router/",
            "http://127.0.0.1:8080/",
            "http://192.168.1.1/",
            "http://10.0.0.5/",
            "http://172.16.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.101.102.103/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://0.0.0.0/",
            "ftp://example.com/",
        ] {
            assert!(!ok(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn the_snapshot_script_is_one_expression_that_answers_json() {
        let s = snapshot_script();
        assert!(s.starts_with("(() => {") && s.ends_with("})()"));
        assert!(s.contains("JSON.stringify"));
        assert!(s.contains(&SNAPSHOT_CHARS.to_string()));
        // Reads, never acts.
        for verb in [".click(", ".submit(", "dispatchEvent", "fetch(", "XMLHttpRequest", ".value ="] {
            assert!(!s.contains(verb), "the snapshot script must not {verb}");
        }
    }

    #[tokio::test]
    async fn a_model_address_is_checked_before_the_window_goes_there() {
        assert!(model_url_ok("http://127.0.0.1/").await.is_err());
        assert!(model_url_ok("file:///etc/hosts").await.is_err());
        assert!(model_url_ok("about:blank").await.is_err());
        assert!(model_url_ok("not a url").await.is_err());
    }

    #[test]
    fn a_taken_over_browser_tells_the_model_to_wait() {
        state().user_has_control = true;
        assert!(taken_over().unwrap().contains("taken over"));
        state().user_has_control = false;
        assert!(taken_over().is_none());
    }
}
