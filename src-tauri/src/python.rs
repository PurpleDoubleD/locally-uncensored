use std::path::Path;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Resolve the real Python binary path, filtering out Windows Store alias.
pub fn get_python_bin() -> String {
    if cfg!(not(target_os = "windows")) {
        // On Linux/macOS, try python3 first, then python
        for bin in &["python3", "python"] {
            if let Ok(output) = Command::new(bin).arg("--version").output() {
                if output.status.success() {
                    return bin.to_string();
                }
            }
        }
        return "python3".to_string();
    }

    // Windows: use `where python` and filter out WindowsApps alias
    let mut where_cmd = Command::new("where");
    where_cmd.arg("python");
    #[cfg(target_os = "windows")]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let path = line.trim();
                if !path.is_empty() && !path.contains("WindowsApps") {
                    // Verify it actually runs
                    let mut check_cmd = Command::new(path);
                    check_cmd.arg("--version");
                    #[cfg(target_os = "windows")]
                    check_cmd.creation_flags(CREATE_NO_WINDOW);
                    if let Ok(check) = check_cmd.output() {
                        if check.status.success() {
                            println!("[Python] Found via `where`: {}", path);
                            return path.to_string();
                        }
                    }
                }
            }
        }
    }

    // Check common Windows Python install locations
    let common_paths = [
        // Standard Python.org installers
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ];

    for p in &common_paths {
        if Path::new(p).exists() {
            println!("[Python] Found at fixed path: {}", p);
            return p.to_string();
        }
    }

    // Check user-local Python (AppData\Local\Programs\Python)
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let programs_python = Path::new(&localappdata).join("Programs").join("Python");
        if programs_python.exists() {
            // Scan for Python3xx directories, newest first
            if let Ok(entries) = std::fs::read_dir(&programs_python) {
                let mut dirs: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().ok().map_or(false, |ft| ft.is_dir()))
                    .collect();
                dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

                for dir in dirs {
                    let python_exe = dir.path().join("python.exe");
                    if python_exe.exists() {
                        let path = python_exe.to_string_lossy().to_string();
                        println!("[Python] Found in AppData: {}", path);
                        return path;
                    }
                }
            }
        }
    }

    // Check Conda environments
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let conda_paths = [
            Path::new(&userprofile).join("miniconda3").join("python.exe"),
            Path::new(&userprofile).join("anaconda3").join("python.exe"),
            Path::new(&userprofile).join("miniconda3").join("Scripts").join("python.exe"),
            Path::new(&userprofile).join("anaconda3").join("Scripts").join("python.exe"),
        ];
        for p in &conda_paths {
            if p.exists() {
                let path = p.to_string_lossy().to_string();
                println!("[Python] Found Conda: {}", path);
                return path;
            }
        }
    }

    println!("[Python] WARNING: No reliable Python found, falling back to 'python'");
    "python".to_string()
}
