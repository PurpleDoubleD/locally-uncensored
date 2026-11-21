//! Windows Firewall and the Wi-Fi way to Remote.
//!
//! For a new LU exe Windows can file two "Block" rules (inbound, TCP and UDP)
//! without asking anybody: when its question was clicked away, after an
//! update (new path, new signature), or by policy. Remote then listens on its
//! port and every packet from the Wi-Fi is dropped; the phone only sees a
//! timeout. This module finds that out when Remote starts and, on the
//! person's click and a UAC prompt, puts in one allow rule for this exe.
//!
//! Everything that reads text is pure and tested on every platform: the
//! parser of `netsh advfirewall firewall show rule name=all verbose` (English
//! and German), the verdict for the active network profile and the command
//! the button runs. Only [`check`] and [`allow`] touch the system, and only
//! on Windows. Nothing is changed without the click.

// The system half runs on Windows only; elsewhere only the tests use the rest.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};

/// The Windows network profiles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NetProfile {
    Domain,
    Private,
    Public,
}

impl NetProfile {
    fn index(self) -> usize {
        match self {
            NetProfile::Domain => 0,
            NetProfile::Private => 1,
            NetProfile::Public => 2,
        }
    }

    /// The word netsh takes for `profile=`.
    pub(crate) fn netsh(self) -> &'static str {
        match self {
            NetProfile::Domain => "domain",
            NetProfile::Private => "private",
            NetProfile::Public => "public",
        }
    }

    /// `NetworkCategory` of Get-NetConnectionProfile (always English).
    pub(crate) fn from_category(s: &str) -> Option<NetProfile> {
        match s.trim() {
            "Private" => Some(NetProfile::Private),
            "Public" => Some(NetProfile::Public),
            "DomainAuthenticated" | "Domain" => Some(NetProfile::Domain),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Allow,
    Block,
}

/// One rule as netsh lists it, the fields that matter here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FwRule {
    pub name: String,
    pub enabled: bool,
    pub inbound: bool,
    pub action: Option<Action>,
    /// Domain, private, public.
    pub profiles: [bool; 3],
    /// `None` for "Any": the rule is not about one program.
    pub program: Option<String>,
}

/// Which field a line of netsh names, in English or German.
fn field(key: &str) -> Option<&'static str> {
    match key.trim() {
        "Rule Name" | "Regelname" => Some("name"),
        "Enabled" | "Aktiviert" => Some("enabled"),
        "Direction" | "Richtung" => Some("direction"),
        "Profiles" | "Profile" => Some("profiles"),
        "Action" | "Aktion" => Some("action"),
        "Program" | "Programm" => Some("program"),
        _ => None,
    }
}

/// "Any" in either language.
fn is_any(v: &str) -> bool {
    matches!(v.trim(), "Any" | "Beliebig" | "Alle")
}

/// Profiles by ASCII parts only: netsh writes German in the console's code
/// page, so "Öffentlich" and "Domäne" may arrive with any byte for the umlaut.
fn parse_profiles(v: &str) -> [bool; 3] {
    if is_any(v) {
        return [true; 3];
    }
    let mut out = [false; 3];
    for p in v.split(',') {
        let p = p.trim();
        if p.starts_with("Dom") {
            out[0] = true;
        } else if p.starts_with("Priv") {
            out[1] = true;
        } else if p.starts_with("Public") || p.contains("ffentlich") {
            out[2] = true;
        }
    }
    out
}

/// The rules of `netsh advfirewall firewall show rule name=all verbose`.
pub(crate) fn parse_netsh_rules(text: &str) -> Vec<FwRule> {
    let mut rules = Vec::new();
    let mut cur: Option<FwRule> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match field(key) {
            Some("name") => {
                if let Some(r) = cur.take() {
                    rules.push(r);
                }
                cur = Some(FwRule { name: value.to_string(), enabled: false, inbound: false, action: None, profiles: [false; 3], program: None });
            }
            Some(f) => {
                let Some(r) = cur.as_mut() else { continue };
                match f {
                    "enabled" => r.enabled = matches!(value, "Yes" | "Ja"),
                    "direction" => r.inbound = matches!(value, "In" | "Eingehend"),
                    "profiles" => r.profiles = parse_profiles(value),
                    "action" => {
                        r.action = match value {
                            "Allow" | "Zulassen" | "Bypass" | "Umgehen" => Some(Action::Allow),
                            "Block" | "Blockieren" => Some(Action::Block),
                            _ => None,
                        }
                    }
                    "program" => r.program = (!is_any(value) && !value.is_empty()).then(|| value.to_string()),
                    _ => {}
                }
            }
            None => {}
        }
    }
    if let Some(r) = cur {
        rules.push(r);
    }
    rules
}

/// `%ProgramFiles%\...` with the variables of this process filled in.
fn expand_env(p: &str) -> String {
    let mut out = String::new();
    let mut rest = p;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let var = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match std::env::var(var) {
            Ok(v) if !var.is_empty() => out.push_str(&v),
            _ => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

/// Windows paths compare without case and with either slash.
pub(crate) fn same_program(rule_program: &str, exe: &Path) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').replace('/', "\\").to_lowercase();
    norm(&expand_env(rule_program)) == norm(&exe.to_string_lossy())
}

/// What the firewall does with packets from the network for this exe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Allowed, or the firewall is off for this profile.
    Open,
    /// A block rule for this exe and profile; block wins over allow.
    Blocked { block_rules: Vec<String> },
    /// No rule allows it, and inbound traffic is blocked by default.
    NoAllow,
}

pub(crate) fn verdict(rules: &[FwRule], exe: &Path, profile: NetProfile, firewall_on: bool) -> Verdict {
    if !firewall_on {
        return Verdict::Open;
    }
    let mine = |r: &&FwRule| r.enabled && r.inbound && r.profiles[profile.index()] && r.program.as_deref().is_some_and(|p| same_program(p, exe));
    let mut block_rules: Vec<String> = rules.iter().filter(mine).filter(|r| r.action == Some(Action::Block)).map(|r| r.name.clone()).collect();
    if !block_rules.is_empty() {
        block_rules.dedup();
        return Verdict::Blocked { block_rules };
    }
    if rules.iter().filter(mine).any(|r| r.action == Some(Action::Allow)) {
        Verdict::Open
    } else {
        Verdict::NoAllow
    }
}

/// The name of the rule LU puts in.
pub(crate) const ALLOW_RULE_NAME: &str = "LU Remote (Wi-Fi)";

/// A rule name or path that is safe inside double quotes on a cmd line.
fn quotable(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c == '"' || c == '%' || c.is_control())
}

/// The one command line the "Allow LU" button runs elevated: the block rules
/// of exactly this exe switched off, LU's own allow rule put in anew for the
/// current profile. Block rules whose names cannot be quoted safely are left
/// as they are (the line says so by leaving them out).
pub(crate) fn allow_command(exe: &Path, profile: NetProfile, block_rules: &[String]) -> Result<String, String> {
    let program = exe.to_string_lossy();
    if !quotable(&program) {
        return Err("The path of LU cannot be written into a firewall rule.".to_string());
    }
    let mut parts: Vec<String> = block_rules
        .iter()
        .filter(|n| quotable(n))
        .map(|n| format!("netsh advfirewall firewall set rule name=\"{n}\" dir=in program=\"{program}\" new enable=no"))
        .collect();
    parts.push(format!("netsh advfirewall firewall delete rule name=\"{ALLOW_RULE_NAME}\" program=\"{program}\""));
    parts.push(format!(
        "netsh advfirewall firewall add rule name=\"{ALLOW_RULE_NAME}\" dir=in action=allow program=\"{program}\" protocol=TCP profile={} enable=yes",
        profile.netsh()
    ));
    Ok(parts.join(" & "))
}

/// A PowerShell script as `-EncodedCommand` takes it (UTF-16LE, base64): no
/// quoting of the script on the command line at all.
pub(crate) fn encoded_powershell(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Start `cmd /c <line>` elevated (UAC) and wait for it.
pub(crate) fn elevated_script(cmd_line: &str) -> String {
    let arg = format!("/c {cmd_line}").replace('\'', "''");
    format!("$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '{arg}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode")
}

/// The script that names the profile of the network with `lan_ip` (or of
/// the first connected one) and whether the firewall is on for it.
pub(crate) fn profile_script(lan_ip: Option<&str>) -> String {
    let ip = lan_ip.filter(|ip| ip.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')).unwrap_or("");
    format!(
        "$i = $null; if ('{ip}') {{ try {{ $i = (Get-NetIPAddress -IPAddress '{ip}' -ErrorAction Stop | Select-Object -First 1).InterfaceIndex }} catch {{}} }}; \
         if ($i) {{ $p = Get-NetConnectionProfile -InterfaceIndex $i | Select-Object -First 1 }} else {{ $p = Get-NetConnectionProfile | Select-Object -First 1 }}; \
         $c = [string]$p.NetworkCategory; $n = if ($c -eq 'Private') {{ 'Private' }} elseif ($c -eq 'Public') {{ 'Public' }} else {{ 'Domain' }}; \
         $f = (Get-NetFirewallProfile -Name $n).Enabled; Write-Output \"$c|$f\""
    )
}

/// `Private|True` from [`profile_script`].
pub(crate) fn parse_profile_line(out: &str) -> Option<(NetProfile, bool)> {
    let line = out.lines().map(str::trim).rfind(|l| l.contains('|'))?;
    let (cat, on) = line.split_once('|')?;
    Some((NetProfile::from_category(cat)?, !on.trim().eq_ignore_ascii_case("False")))
}

/// What the window and the phone are told.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FirewallStatus {
    /// The check ran (Windows only).
    pub checked: bool,
    /// The phone cannot reach this computer on the Wi-Fi.
    pub blocked: bool,
    /// "blocked" (a block rule) or "no_allow".
    pub reason: Option<&'static str>,
    /// "private", "public" or "domain".
    pub profile: Option<&'static str>,
}

impl FirewallStatus {
    pub(crate) fn not_checked() -> Self {
        FirewallStatus { checked: false, blocked: false, reason: None, profile: None }
    }

    pub(crate) fn from_verdict(v: &Verdict, profile: NetProfile) -> Self {
        let (blocked, reason) = match v {
            Verdict::Open => (false, None),
            Verdict::Blocked { .. } => (true, Some("blocked")),
            Verdict::NoAllow => (true, Some("no_allow")),
        };
        FirewallStatus { checked: true, blocked, reason, profile: Some(profile.netsh()) }
    }
}

/// 0: not known, 1: open, 2: blocked. For `status/full` (`lan_blocked`).
static LAN: AtomicU8 = AtomicU8::new(0);

pub(crate) fn lan_blocked() -> bool {
    LAN.load(Ordering::SeqCst) == 2
}

fn remember(status: &FirewallStatus) {
    LAN.store(if !status.checked { 0 } else if status.blocked { 2 } else { 1 }, Ordering::SeqCst);
}

#[cfg(windows)]
mod system {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn run(mut cmd: Command, timeout: Duration) -> Option<(bool, Vec<u8>)> {
        crate::process_util::suppress_window(&mut cmd);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            let _ = (&mut stdout).take(16 * 1024 * 1024).read_to_end(&mut buf);
            buf
        });
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some((status.success(), reader.join().ok()?)),
                Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }

    fn powershell(script: &str, timeout: Duration) -> Option<(bool, Vec<u8>)> {
        let mut cmd = crate::process_util::hidden_command("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_powershell(script)]);
        run(cmd, timeout)
    }

    pub(super) fn profile(lan_ip: Option<&str>) -> Option<(NetProfile, bool)> {
        let (_, out) = powershell(&profile_script(lan_ip), Duration::from_secs(20))?;
        parse_profile_line(&String::from_utf8_lossy(&out))
    }

    pub(super) fn rules() -> Option<Vec<FwRule>> {
        let mut cmd = crate::process_util::hidden_command("netsh");
        cmd.args(["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"]);
        let (_, out) = run(cmd, Duration::from_secs(30))?;
        Some(parse_netsh_rules(&String::from_utf8_lossy(&out)))
    }

    pub(super) fn elevated(cmd_line: &str) -> Result<(), String> {
        // Waits for the UAC answer; no timeout that would leave it half done.
        match powershell(&elevated_script(cmd_line), Duration::from_secs(600)) {
            Some((true, _)) => Ok(()),
            Some((false, _)) => Err("Windows did not allow the change. Try again and answer the Windows question with Yes.".to_string()),
            None => Err("Windows did not answer in time.".to_string()),
        }
    }
}

/// Looks at the firewall for this exe on the network with `lan_ip`. Blocks
/// (PowerShell, netsh): run it on a blocking thread.
pub(crate) fn check(lan_ip: Option<&str>) -> FirewallStatus {
    #[cfg(windows)]
    {
        let status = (|| {
            let exe = std::env::current_exe().ok()?;
            let (profile, on) = system::profile(lan_ip)?;
            let rules = system::rules()?;
            Some(FirewallStatus::from_verdict(&verdict(&rules, &exe, profile, on), profile))
        })()
        .unwrap_or_else(FirewallStatus::not_checked);
        remember(&status);
        status
    }
    #[cfg(not(windows))]
    {
        let _ = lan_ip;
        let status = FirewallStatus::not_checked();
        remember(&status);
        status
    }
}

/// "Allow LU": one elevated command for this exe and the current profile.
/// Then looks again and answers what it sees now.
pub(crate) fn allow(lan_ip: Option<&str>) -> Result<FirewallStatus, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| crate::os_error::english(&e))?;
        let (profile, _) = system::profile(lan_ip).ok_or_else(|| "The network profile could not be read.".to_string())?;
        let rules = system::rules().unwrap_or_default();
        let block_rules = match verdict(&rules, &exe, profile, true) {
            Verdict::Blocked { block_rules } => block_rules,
            _ => Vec::new(),
        };
        system::elevated(&allow_command(&exe, profile, &block_rules)?)?;
        Ok(check(lan_ip))
    }
    #[cfg(not(windows))]
    {
        let _ = lan_ip;
        Err("Only on Windows.".to_string())
    }
}

/// The last check, for the Remote panel; `refresh` looks again.
#[tauri::command]
pub async fn remote_firewall_status(refresh: Option<bool>) -> Result<FirewallStatus, String> {
    let _ = refresh;
    let ip = crate::commands::lan_address::lan_ip().map(|ip| ip.to_string());
    tokio::task::spawn_blocking(move || check(ip.as_deref())).await.map_err(|e| e.to_string())
}

/// The "Allow LU" button. Only from the window, only on a click.
#[tauri::command]
pub async fn remote_firewall_allow() -> Result<FirewallStatus, String> {
    let ip = crate::commands::lan_address::lan_ip().map(|ip| ip.to_string());
    tokio::task::spawn_blocking(move || allow(ip.as_deref())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const EXE: &str = r"C:\Users\someone\AppData\Local\LU\lu.exe";

    const ENGLISH: &str = r"
Rule Name:                            Locally Uncensored
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       No
Program:                              C:\Users\someone\AppData\Local\LU\lu.exe
InterfaceTypes:                       Any
Security:                             NotRequired
Rule source:                          Local Setting
Action:                               Block

Rule Name:                            Locally Uncensored
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             UDP
Program:                              C:\Users\someone\AppData\Local\LU\lu.exe
Action:                               Block

Rule Name:                            Core Networking - DHCP
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
Program:                              %SystemRoot%\system32\svchost.exe
Action:                               Allow

Rule Name:                            Remote Desktop
----------------------------------------------------------------------
Enabled:                              No
Direction:                            In
Profiles:                             Any
Program:                              Any
Action:                               Allow
Ok.
";

    // As netsh prints it on a German Windows, the umlauts in the console's
    // code page (here as a replacement character).
    const GERMAN: &str = "
Regelname:                            Locally Uncensored
----------------------------------------------------------------------
Aktiviert:                            Ja
Richtung:                             Eingehend
Profile:                              Privat
Gruppierung:
Lokale IP:                            Beliebig
Remote-IP:                            Beliebig
Protokoll:                            TCP
Lokaler Port:                         Beliebig
Remoteport:                           Beliebig
Edgeausnahme:                         Nein
Programm:                             c:\\users\\someone\\appdata\\local\\lu\\LU.EXE
Schnittstellentypen:                  Beliebig
Sicherheit:                           NotRequired
Regelquelle:                          Lokale Einstellung
Aktion:                               Blockieren

Regelname:                            LU Remote (Wi-Fi)
----------------------------------------------------------------------
Aktiviert:                            Ja
Richtung:                             Eingehend
Profile:                              Dom\u{FFFD}ne,\u{FFFD}ffentlich
Programm:                             C:/Users/someone/AppData/Local/LU/lu.exe
Aktion:                               Zulassen
OK.
";

    #[test]
    fn netsh_output_is_read_in_english() {
        let rules = parse_netsh_rules(ENGLISH);
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[0], FwRule {
            name: "Locally Uncensored".into(), enabled: true, inbound: true, action: Some(Action::Block),
            profiles: [false, true, false], program: Some(EXE.into()),
        });
        assert_eq!(rules[2].profiles, [true, true, true]);
        assert_eq!(rules[3].program, None, "Any is no program");
        assert!(!rules[3].enabled);
    }

    #[test]
    fn netsh_output_is_read_in_german_whatever_the_code_page() {
        let rules = parse_netsh_rules(GERMAN);
        assert_eq!(rules.len(), 2);
        assert!(rules[0].enabled && rules[0].inbound);
        assert_eq!(rules[0].action, Some(Action::Block));
        assert_eq!(rules[0].profiles, [false, true, false]);
        assert_eq!(rules[1].action, Some(Action::Allow));
        assert_eq!(rules[1].profiles, [true, false, true], "Domäne and Öffentlich without their umlauts");
    }

    #[test]
    fn the_verdict_for_the_active_profile() {
        let exe = PathBuf::from(EXE);
        let en = parse_netsh_rules(ENGLISH);
        assert_eq!(verdict(&en, &exe, NetProfile::Private, true), Verdict::Blocked { block_rules: vec!["Locally Uncensored".into()] });
        assert_eq!(verdict(&en, &exe, NetProfile::Public, true), Verdict::NoAllow, "no rule for public at all");
        assert_eq!(verdict(&en, &exe, NetProfile::Private, false), Verdict::Open, "firewall off");
        // German: the block for private, the allow for public (path in other case and slashes).
        let de = parse_netsh_rules(GERMAN);
        assert!(matches!(verdict(&de, &exe, NetProfile::Private, true), Verdict::Blocked { .. }));
        assert_eq!(verdict(&de, &exe, NetProfile::Public, true), Verdict::Open);
        // Another exe (an older install) does not count.
        assert_eq!(verdict(&en, Path::new(r"C:\Program Files\LU\lu.exe"), NetProfile::Private, true), Verdict::NoAllow);
    }

    #[test]
    fn the_button_runs_one_line_for_exactly_this_exe_and_profile() {
        let exe = PathBuf::from(EXE);
        let line = allow_command(&exe, NetProfile::Private, &["Locally Uncensored".into(), "bad\"name".into()]).unwrap();
        assert_eq!(
            line,
            format!(
                "netsh advfirewall firewall set rule name=\"Locally Uncensored\" dir=in program=\"{EXE}\" new enable=no & \
                 netsh advfirewall firewall delete rule name=\"LU Remote (Wi-Fi)\" program=\"{EXE}\" & \
                 netsh advfirewall firewall add rule name=\"LU Remote (Wi-Fi)\" dir=in action=allow program=\"{EXE}\" protocol=TCP profile=private enable=yes"
            )
        );
        assert!(allow_command(Path::new(r"C:\a%PATH%\lu.exe"), NetProfile::Private, &[]).is_err());
        let script = elevated_script("netsh x name=\"it's\"");
        assert!(script.contains("-Verb RunAs") && script.contains("'/c netsh x name=\"it''s\"'"));
        // UTF-16LE, base64: "a" is "YQA=".
        assert_eq!(encoded_powershell("a"), "YQA=");
    }

    #[test]
    fn the_profile_line_and_its_script() {
        assert_eq!(parse_profile_line("Private|True\r\n"), Some((NetProfile::Private, true)));
        assert_eq!(parse_profile_line("noise\nPublic|False"), Some((NetProfile::Public, false)));
        assert_eq!(parse_profile_line("DomainAuthenticated|True"), Some((NetProfile::Domain, true)));
        assert_eq!(parse_profile_line(""), None);
        assert!(profile_script(Some("192.168.1.20")).contains("'192.168.1.20'"));
        assert!(!profile_script(Some("1.2.3.4'; Remove-Item x")).contains("Remove-Item"), "only an address goes in");
    }

    #[test]
    fn a_rule_path_with_a_variable_is_expanded() {
        std::env::set_var("LU_FW_TEST_ROOT", r"C:\Users\someone\AppData\Local");
        assert!(same_program(r"%LU_FW_TEST_ROOT%\LU\lu.exe", Path::new(EXE)));
        assert!(!same_program(r"%LU_FW_NOT_SET%\LU\lu.exe", Path::new(EXE)));
    }

    #[test]
    fn the_status_says_blocked_only_after_a_check() {
        let s = FirewallStatus::not_checked();
        remember(&s);
        assert!(!lan_blocked());
        let b = FirewallStatus::from_verdict(&Verdict::NoAllow, NetProfile::Public);
        assert_eq!((b.blocked, b.reason, b.profile), (true, Some("no_allow"), Some("public")));
        remember(&b);
        assert!(lan_blocked());
        remember(&FirewallStatus::from_verdict(&Verdict::Open, NetProfile::Private));
        assert!(!lan_blocked());
    }
}
