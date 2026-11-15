//! Gallery delete reaches the file too (Discord 2026-09-25:
//! "when deleting files in app from gallery, they are still in output
//! folder, which is getting bigger and bigger").
//!
//! The render goes to the Recycle Bin / Trash, not into oblivion: a misclick
//! in the gallery must stay recoverable. Only files inside ComfyUI's output
//! folder are touched, by the same path rules as the model probes (no
//! absolute paths, no `..`, media extensions only).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::download::{safe_subfolder, sanitize_filename};
use crate::state::AppState;

const MEDIA_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "mkv", "wav", "mp3", "flac", "ogg", "glb"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// The file was found and moved to the Recycle Bin / Trash.
    pub trashed: bool,
    /// Nothing to do: the file was not there (already gone, or ComfyUI writes
    /// to an output folder this app does not know).
    pub missing: bool,
}

/// The file a gallery entry names, inside `output_dir`, or None when the name
/// tries to leave it or is not a media file.
pub fn output_file(output_dir: &Path, filename: &str, subfolder: &str) -> Option<PathBuf> {
    if filename.is_empty() || sanitize_filename(filename) != filename {
        return None;
    }
    if !subfolder.is_empty() && safe_subfolder(subfolder).is_err() {
        return None;
    }
    let ext = Path::new(filename).extension()?.to_str()?.to_ascii_lowercase();
    if !MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let dir = if subfolder.is_empty() { output_dir.to_path_buf() } else { output_dir.join(subfolder.replace('\\', "/")) };
    Some(dir.join(filename))
}

#[tauri::command]
pub async fn trash_comfy_output(filename: String, subfolder: String, state: State<'_, AppState>) -> Result<TrashResult, String> {
    let comfy_path = {
        let mut p = state.comfy_path.lock().map_err(|e| e.to_string())?;
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                *p = Some(found);
            }
        }
        p.clone()
    };
    let Some(base) = comfy_path else {
        return Ok(TrashResult { trashed: false, missing: true });
    };
    // GH #183: the output folder the user set for ComfyUI (start script or
    // ComfyUI Desktop), which is where a ComfyUI LU starts writes now too.
    let output_dir = crate::commands::comfy_user_paths::UserComfyPaths::discover(Path::new(&base))
        .output_dir_or(&PathBuf::from(&base));
    let path = output_file(&output_dir, &filename, &subfolder)
        .ok_or_else(|| "That gallery entry does not name a file in the ComfyUI output folder.".to_string())?;
    if !path.is_file() {
        return Ok(TrashResult { trashed: false, missing: true });
    }
    tauri::async_runtime::spawn_blocking(move || trash::delete(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not move the file to the trash: {e}"))?;
    Ok(TrashResult { trashed: true, missing: false })
}

// ── Restore from the output folder (3.1.0, C27) ──────────────────────────────
//
// Discord 01.11.2026: the gallery had lost a user's entries while the
// files were still in ComfyUI's output folder. This lists that folder so the
// gallery can take the files back, with the prompt where the file carries it:
// ComfyUI writes the graph it ran as a PNG text chunk "prompt", A1111-style
// tools write "parameters". Read only; nothing on disk is touched. The text
// chunks are read without decoding the picture, and the walk stops at fixed
// limits, so a huge or odd folder cannot hang the app.

/** Most files one scan lists. */
const SCAN_MAX_FILES: usize = 20_000;
/** How deep the scan goes below the output folder. */
const SCAN_MAX_DEPTH: usize = 4;
/** Longest text chunk kept (a graph of a big workflow is well under this). */
const PNG_TEXT_MAX: usize = 2 * 1024 * 1024;
/** Bytes of a PNG read at most while looking for its text chunks. */
const PNG_READ_MAX: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub filename: String,
    /// Below the output folder, with "/" between the parts; "" for the folder itself.
    pub subfolder: String,
    /// "image", "video", "audio" or "3d" (a GLB model).
    pub kind: &'static str,
    pub modified_ms: u64,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// The ComfyUI graph the picture was made with (PNG text "prompt").
    pub prompt: Option<String>,
    /// A1111-style settings (PNG text "parameters").
    pub parameters: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutputScan {
    /// False when LU cannot read this ComfyUI's output folder: none set up, a
    /// ComfyUI on another machine, the Mac.
    pub reachable: bool,
    pub folder: String,
    pub files: Vec<OutputFile>,
    /// The scan stopped at SCAN_MAX_FILES.
    pub truncated: bool,
}

fn kind_of(ext: &str) -> Option<&'static str> {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => Some("image"),
        "mp4" | "webm" | "mov" | "mkv" => Some("video"),
        "wav" | "mp3" | "flac" | "ogg" => Some("audio"),
        // A 3D model as Create writes it (3.1.0). The gallery calls it "3d".
        "glb" => Some("3d"),
        _ => None,
    }
}

/// What a PNG says about itself before its picture data: size and text chunks.
#[derive(Debug, Default, PartialEq)]
pub struct PngInfo {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub texts: Vec<(String, String)>,
}

fn inflate_limited(data: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(data).take(PNG_TEXT_MAX as u64 + 1).read_to_end(&mut out).ok()?;
    if out.len() > PNG_TEXT_MAX {
        return None;
    }
    String::from_utf8(out).ok()
}

/// The text chunks (tEXt, zTXt, iTXt) and the size of a PNG, read from
/// `reader` up to the first picture chunk. Anything malformed ends the read
/// with what was found so far.
pub fn read_png_info<R: std::io::Read>(mut reader: R) -> PngInfo {
    let mut info = PngInfo::default();
    let mut sig = [0u8; 8];
    if reader.read_exact(&mut sig).is_err() || sig != [137, 80, 78, 71, 13, 10, 26, 10] {
        return info;
    }
    let mut read: u64 = 8;
    loop {
        let mut head = [0u8; 8];
        if reader.read_exact(&mut head).is_err() {
            break;
        }
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let kind = [head[4], head[5], head[6], head[7]];
        read += 8 + len + 4;
        if &kind == b"IDAT" || &kind == b"IEND" || read > PNG_READ_MAX {
            break;
        }
        let wanted = matches!(&kind, b"IHDR" | b"tEXt" | b"zTXt" | b"iTXt") && len as usize <= PNG_TEXT_MAX * 2;
        if !wanted {
            if std::io::copy(&mut <&mut R as std::io::Read>::take(&mut reader, len + 4), &mut std::io::sink()).ok() != Some(len + 4) {
                break;
            }
            continue;
        }
        let mut data = vec![0u8; len as usize];
        let mut crc = [0u8; 4];
        if reader.read_exact(&mut data).is_err() || reader.read_exact(&mut crc).is_err() {
            break;
        }
        match &kind {
            b"IHDR" if data.len() >= 8 => {
                info.width = Some(u32::from_be_bytes([data[0], data[1], data[2], data[3]]));
                info.height = Some(u32::from_be_bytes([data[4], data[5], data[6], data[7]]));
            }
            b"tEXt" => {
                if let Some(nul) = data.iter().position(|&b| b == 0) {
                    let key: String = data[..nul].iter().map(|&b| b as char).collect();
                    // Latin-1 by the PNG rules; ComfyUI's JSON is ASCII-escaped anyway.
                    let value: String = data[nul + 1..].iter().map(|&b| b as char).collect();
                    if value.len() <= PNG_TEXT_MAX {
                        info.texts.push((key, value));
                    }
                }
            }
            b"zTXt" => {
                if let Some(nul) = data.iter().position(|&b| b == 0) {
                    let key: String = data[..nul].iter().map(|&b| b as char).collect();
                    if let Some(value) = data.get(nul + 2..).and_then(inflate_limited) {
                        info.texts.push((key, value));
                    }
                }
            }
            b"iTXt" => {
                // key \0 flag method lang \0 translated \0 text
                let Some(nul) = data.iter().position(|&b| b == 0) else { continue };
                let key = String::from_utf8_lossy(&data[..nul]).to_string();
                let Some(&compressed) = data.get(nul + 1) else { continue };
                let rest = data.get(nul + 3..).unwrap_or(&[]);
                let Some(lang_end) = rest.iter().position(|&b| b == 0) else { continue };
                let rest = &rest[lang_end + 1..];
                let Some(tr_end) = rest.iter().position(|&b| b == 0) else { continue };
                let text = &rest[tr_end + 1..];
                let value = if compressed == 1 {
                    inflate_limited(text)
                } else {
                    String::from_utf8(text.to_vec()).ok().filter(|v| v.len() <= PNG_TEXT_MAX)
                };
                if let Some(v) = value {
                    info.texts.push((key, v));
                }
            }
            _ => {}
        }
    }
    info
}

/// Every media file below `dir`, newest first, at most `max_files`. Links are
/// not followed, hidden folders are skipped, names that the gallery could not
/// name safely (output_file) are left out.
pub fn scan_output_dir(dir: &Path, max_files: usize) -> (Vec<OutputFile>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(dir.to_path_buf(), String::new(), 0)];
    'walk: while let Some((folder, sub, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        let mut names: Vec<_> = entries.flatten().collect();
        names.sort_by_key(|e| e.file_name());
        for entry in names {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                if depth < SCAN_MAX_DEPTH {
                    let next = if sub.is_empty() { name.clone() } else { format!("{sub}/{name}") };
                    stack.push((entry.path(), next, depth + 1));
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let Some(kind) = kind_of(&ext) else { continue };
            if output_file(dir, &name, &sub).is_none() {
                continue;
            }
            if files.len() >= max_files {
                truncated = true;
                break 'walk;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let mut file = OutputFile { filename: name, subfolder: sub.clone(), kind, modified_ms, bytes: meta.len(), ..Default::default() };
            if ext == "png" {
                if let Ok(f) = std::fs::File::open(entry.path()) {
                    let info = read_png_info(std::io::BufReader::new(f));
                    file.width = info.width;
                    file.height = info.height;
                    for (key, value) in info.texts {
                        match key.as_str() {
                            "prompt" if file.prompt.is_none() => file.prompt = Some(value),
                            "parameters" if file.parameters.is_none() => file.parameters = Some(value),
                            _ => {}
                        }
                    }
                }
            }
            files.push(file);
        }
    }
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.subfolder.cmp(&b.subfolder)).then_with(|| a.filename.cmp(&b.filename)));
    (files, truncated)
}

#[tauri::command]
pub async fn scan_comfy_output(state: State<'_, AppState>) -> Result<OutputScan, String> {
    if !crate::commands::process::comfy_supported_here() || crate::commands::download::remote_comfy(&state).is_some() {
        return Ok(OutputScan::default());
    }
    let comfy_path = {
        let mut p = state.comfy_path.lock().map_err(|e| e.to_string())?;
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                *p = Some(found);
            }
        }
        p.clone()
    };
    let Some(base) = comfy_path.filter(|p| !p.trim().is_empty()) else {
        return Ok(OutputScan::default());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(base.trim());
        let output_dir = crate::commands::comfy_user_paths::UserComfyPaths::discover(&base).output_dir_or(&base);
        if !output_dir.is_dir() {
            return OutputScan { reachable: false, folder: output_dir.to_string_lossy().to_string(), ..Default::default() };
        }
        let (files, truncated) = scan_output_dir(&output_dir, SCAN_MAX_FILES);
        OutputScan { reachable: true, folder: output_dir.to_string_lossy().to_string(), files, truncated }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    fn png(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
        let mut ihdr = 832u32.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&1216u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        out.extend(chunk(b"IHDR", &ihdr));
        for c in chunks {
            out.extend_from_slice(c);
        }
        out.extend(chunk(b"IDAT", &[1, 2, 3]));
        // A text chunk after the picture data is not read.
        out.extend(chunk(b"tEXt", b"late\0x"));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    #[test]
    fn png_text_chunks_and_size_are_read_up_to_the_picture() {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(b"steps: 20").unwrap();
        let packed = z.finish().unwrap();
        let mut ztxt = b"ztext\0\0".to_vec();
        ztxt.extend(packed);
        let mut itxt = b"workflow\0\0\0\0\0".to_vec();
        itxt.extend("{\"a\":\"\u{e4}\"}".as_bytes());
        let bytes = png(&[
            chunk(b"tEXt", b"prompt\0{\"3\":{\"class_type\":\"KSampler\"}}"),
            chunk(b"zTXt", &ztxt),
            chunk(b"iTXt", &itxt),
            chunk(b"bKGD", &[0, 0]),
        ]);
        let info = read_png_info(&bytes[..]);
        assert_eq!(info.width, Some(832));
        assert_eq!(info.height, Some(1216));
        assert_eq!(
            info.texts,
            vec![
                ("prompt".to_string(), "{\"3\":{\"class_type\":\"KSampler\"}}".to_string()),
                ("ztext".to_string(), "steps: 20".to_string()),
                ("workflow".to_string(), "{\"a\":\"\u{e4}\"}".to_string()),
            ]
        );
    }

    #[test]
    fn broken_or_foreign_files_give_what_was_found() {
        assert_eq!(read_png_info(&b"GIF89a....."[..]), PngInfo::default());
        let mut bytes = png(&[chunk(b"tEXt", b"prompt\0ok")]);
        // Cut in the middle of the picture data.
        bytes.truncate(bytes.len() - 20);
        assert_eq!(read_png_info(&bytes[..]).texts, vec![("prompt".to_string(), "ok".to_string())]);
        // A chunk length past the end.
        let mut odd = vec![137, 80, 78, 71, 13, 10, 26, 10];
        odd.extend_from_slice(&u32::MAX.to_be_bytes());
        odd.extend_from_slice(b"tEXt");
        assert_eq!(read_png_info(&odd[..]), PngInfo::default());
    }

    #[test]
    fn the_scan_lists_media_below_the_output_folder_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path();
        std::fs::write(out.join("a.png"), png(&[chunk(b"tEXt", b"parameters\0a cat\nSteps: 20")])).unwrap();
        std::fs::create_dir_all(out.join("video/deep")).unwrap();
        std::fs::write(out.join("video/clip.mp4"), b"x").unwrap();
        std::fs::write(out.join("video/deep/s.wav"), b"x").unwrap();
        std::fs::create_dir_all(out.join("3d")).unwrap();
        std::fs::write(out.join("3d/chair.glb"), b"glTF").unwrap();
        std::fs::write(out.join("notes.txt"), b"x").unwrap();
        std::fs::write(out.join("model.safetensors"), b"x").unwrap();
        std::fs::create_dir_all(out.join(".cache")).unwrap();
        std::fs::write(out.join(".cache/c.png"), b"x").unwrap();
        let (files, truncated) = scan_output_dir(out, 100);
        assert!(!truncated);
        let mut names: Vec<_> = files.iter().map(|f| format!("{}|{}|{}", f.subfolder, f.filename, f.kind)).collect();
        names.sort();
        assert_eq!(names, vec!["3d|chair.glb|3d", "video/deep|s.wav|audio", "video|clip.mp4|video", "|a.png|image"]);
        let a = files.iter().find(|f| f.filename == "a.png").unwrap();
        assert_eq!(a.parameters.as_deref(), Some("a cat\nSteps: 20"));
        assert_eq!((a.width, a.height), (Some(832), Some(1216)));
        let (few, cut) = scan_output_dir(out, 2);
        assert_eq!(few.len(), 2);
        assert!(cut);
    }

    #[cfg(unix)]
    #[test]
    fn the_scan_does_not_follow_links_out_of_the_folder() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), b"x").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.png"), dir.path().join("s.png")).unwrap();
        let (files, _) = scan_output_dir(dir.path(), 100);
        assert!(files.is_empty());
    }

    #[test]
    fn only_media_files_inside_the_output_folder() {
        let out = PathBuf::from("/comfy/output");
        assert_eq!(output_file(&out, "locally_uncensored_00001_.png", ""), Some(out.join("locally_uncensored_00001_.png")));
        assert_eq!(output_file(&out, "clip.mp4", "video"), Some(out.join("video").join("clip.mp4")));
        assert_eq!(output_file(&out, "../../secret.png", ""), None);
        assert_eq!(output_file(&out, "x.png", "../.."), None);
        assert_eq!(output_file(&out, "x.png", "/etc"), None);
        assert_eq!(output_file(&out, "model.safetensors", ""), None);
        assert_eq!(output_file(&out, "chair.glb", "3d"), Some(out.join("3d").join("chair.glb")), "a 3D model goes to the Trash too");
        assert_eq!(output_file(&out, "noext", ""), None);
        assert_eq!(output_file(&out, "", ""), None);
    }
}
