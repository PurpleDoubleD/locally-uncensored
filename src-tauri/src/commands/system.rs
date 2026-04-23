use base64::Engine;
use sysinfo::System;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub fn system_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostname": hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        "username": whoami::username(),
        "totalMemory": System::new_all().total_memory(),
        "cpuCount": num_cpus::get(),
    }))
}

#[tauri::command]
pub fn process_list() -> Result<serde_json::Value, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut processes: Vec<serde_json::Value> = sys
        .processes()
        .values()
        .map(|p| {
            serde_json::json!({
                "name": p.name().to_string_lossy(),
                "pid": p.pid().as_u32(),
                "memory": p.memory(),
                "cpu": p.cpu_usage(),
            })
        })
        .collect();

    // Sort by memory desc, limit to top 50
    processes.sort_by(|a, b| {
        b.get("memory")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(
                &a.get("memory")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            )
    });
    processes.truncate(50);

    Ok(serde_json::json!({ "processes": processes, "count": processes.len() }))
}

#[tauri::command]
pub fn screenshot() -> Result<serde_json::Value, String> {
    // Use PowerShell to capture screen on Windows
    #[cfg(target_os = "windows")]
    {
        let tmp = std::env::temp_dir().join("lu-screenshot.png");
        let ps_script = format!(
            r#"
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
            $bitmap.Save('{}')
            $graphics.Dispose()
            $bitmap.Dispose()
            "#,
            tmp.to_string_lossy().replace('\\', "\\\\")
        );

        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Screenshot failed: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Screenshot failed: {}", stderr));
        }

        let bytes = std::fs::read(&tmp).map_err(|e| format!("Read screenshot: {}", e))?;
        let _ = std::fs::remove_file(&tmp);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(serde_json::json!({ "image": b64, "format": "png", "encoding": "base64" }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Screenshot not implemented for this platform yet".to_string())
    }
}

#[tauri::command]
pub async fn pick_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref p) = default_path {
        dialog = dialog.set_directory(p);
    }
    let result = dialog.pick_folder().await;
    Ok(result.map(|f| f.path().to_string_lossy().to_string()))
}

/// Exit the app (used by auto-updater to let NSIS installer run)
#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

/// Get the persistent settings dir (%APPDATA%/Locally Uncensored/) — outside NSIS install dir
fn persistent_dir() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA not set".to_string())?;
    Ok(std::path::PathBuf::from(appdata).join("Locally Uncensored"))
}

/// Backup all localStorage stores to %APPDATA% (survives NSIS updates)
/// Uses atomic write (temp file + rename) to prevent corruption on crash
#[tauri::command]
pub fn backup_stores(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("store_backup.json");
    let tmp = dir.join("store_backup.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore stores from %APPDATA% backup
#[tauri::command]
pub fn restore_stores() -> Result<Option<String>, String> {
    let path = persistent_dir()?.join("store_backup.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

/// Check if onboarding was completed (marker file in %APPDATA%, survives NSIS updates)
#[tauri::command]
pub fn is_onboarding_done() -> bool {
    persistent_dir()
        .map(|dir| dir.join("onboarding_done").exists())
        .unwrap_or(false)
}

/// Persist onboarding completion to %APPDATA% (outside NSIS install dir).
/// Pass `done: false` to clear the marker so the first-launch wizard runs again.
#[tauri::command]
pub fn set_onboarding_done(done: Option<bool>) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("onboarding_done");
    if done.unwrap_or(true) {
        std::fs::write(&path, "1").map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the current local date/time/timezone. Agents should call this
/// instead of googling "what day is it" — the info is free and exact.
#[tauri::command]
pub fn get_current_time() -> Result<serde_json::Value, String> {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let unix = now.as_secs();

    // Format via chrono if available (transitive dep via jsonwebtoken); else
    // do a hand-rolled ISO-8601 fallback. Both produce stable output.
    let (iso_local, iso_utc, tz_name, tz_offset_minutes) = format_datetime(unix);

    Ok(serde_json::json!({
        "unix":              unix,
        "iso_local":         iso_local,      // e.g. "2026-04-15 01:23:45"
        "iso_utc":           iso_utc,        // e.g. "2026-04-14T23:23:45Z"
        "timezone":          tz_name,        // e.g. "CEST" or "+0200"
        "timezone_offset":   tz_offset_minutes,
    }))
}

fn format_datetime(unix_secs: u64) -> (String, String, String, i32) {
    // Derive local offset from system. `time` crate would be cleaner but
    // isn't in our dep tree; use std + sysinfo hints. On both supported
    // platforms std::time::SystemTime is unaware of timezones, so we read
    // the offset from a known local -> utc conversion.
    use std::time::{Duration, UNIX_EPOCH};
    let t = UNIX_EPOCH + Duration::from_secs(unix_secs);

    // UTC parts (manual, no chrono dep pulled in just for this)
    let (y, mo, d, h, mi, s) = unix_to_utc_parts(unix_secs);
    let iso_utc = format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s);

    // Local parts — use SystemTime relative to a known local calendar date.
    // The simplest portable trick: format via C lib through `humantime` isn't
    // installed either. We use a small offset probe.
    let offset_minutes = local_offset_minutes();
    let local_unix = (unix_secs as i64) + (offset_minutes as i64) * 60;
    let (ly, lmo, ld, lh, lmi, ls) = unix_to_utc_parts(local_unix.max(0) as u64);
    let iso_local = format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", ly, lmo, ld, lh, lmi, ls);

    let sign = if offset_minutes >= 0 { '+' } else { '-' };
    let abs = offset_minutes.unsigned_abs();
    let tz_name = format!("{}{:02}{:02}", sign, abs / 60, abs % 60);

    let _ = t;
    (iso_local, iso_utc, tz_name, offset_minutes)
}

fn local_offset_minutes() -> i32 {
    // Spawn `date +%z` on Unix, `Get-Date` on Windows — very cheap, no deps.
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-Date).ToString('zzz')"])
            .creation_flags(0x0800_0000)
            .output();
        if let Ok(o) = out {
            if let Ok(s) = String::from_utf8(o.stdout) {
                let s = s.trim();
                return parse_offset_to_minutes(s).unwrap_or(0);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        let out = Command::new("date").arg("+%z").output();
        if let Ok(o) = out {
            if let Ok(s) = String::from_utf8(o.stdout) {
                return parse_offset_to_minutes(s.trim()).unwrap_or(0);
            }
        }
    }
    0
}

fn parse_offset_to_minutes(s: &str) -> Option<i32> {
    // Accepts +HH:MM, +HHMM, -HH:MM, -HHMM
    let bytes = s.as_bytes();
    if bytes.is_empty() { return None; }
    let sign = match bytes[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = s[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 3 { return None; }
    let hh: i32 = digits[..2].parse().ok()?;
    let mm: i32 = digits[2..4.min(digits.len())].parse().ok().unwrap_or(0);
    Some(sign * (hh * 60 + mm))
}

/// Minimal date math — good enough for display without pulling chrono in
/// just for this tool. Valid for dates after 1970.
fn unix_to_utc_parts(mut unix: u64) -> (i32, u32, u32, u32, u32, u32) {
    let secs_of_day = (unix % 86_400) as u32;
    unix /= 86_400; // days since epoch
    let h = secs_of_day / 3600;
    let mi = (secs_of_day / 60) % 60;
    let s = secs_of_day % 60;

    // Zeller-ish: walk forward year by year
    let mut year: i32 = 1970;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if unix < days_in_year as u64 { break; }
        unix -= days_in_year as u64;
        year += 1;
    }
    let leap = is_leap(year);
    let days_per_month = [31u64, if leap {29} else {28}, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month: u32 = 1;
    for dm in &days_per_month {
        if unix < *dm { break; }
        unix -= dm;
        month += 1;
    }
    let day = unix as u32 + 1;
    (year, month, day, h, mi, s)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}
