//! Remove Background on a Mac.
//!
//! On Windows and Linux the cutout is a ComfyUI graph around the RMBG node.
//! A Mac has no ComfyUI, and macOS 14 brings what the node does: Vision finds
//! the subject of a picture (`VNGenerateForegroundInstanceMaskRequest`) and
//! hands back its mask at the size of the image. No model to download, no
//! Python, and on Apple Silicon well under a second for a megapixel.
//!
//! The run: the staged image is read with the `image` crate, Vision is asked
//! for the mask of every subject it sees, the mask becomes the alpha channel,
//! and the PNG is written where the Mac's other stills land (`images_root`).
//! The answer has the shape of `mlx_generate`: base64, path, width, height.
//!
//! The path comes from the interface, so it is taken only when it names a
//! file in the folder Create stages images in, as an edit does
//! (`edit_images` in `image_mflux.rs`).
//!
//! Elsewhere the command is there and says that it is for a Mac.

// The helpers are the Mac's, and tested on every system.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::CmdResult;
use crate::state::AppState;

pub(crate) const NO_IMAGE: &str = "Add an image to remove its background.";
const GONE: &str = "The image to cut out is no longer on disk. Add it again.";
pub(crate) const NO_SUBJECT: &str =
    "No subject was found in this image, so there is nothing to cut out. Try a picture with a clear main subject.";
#[cfg(not(target_os = "macos"))]
const MAC_ONLY: &str = "This Remove Background runs on a Mac only. Here it runs through ComfyUI.";

/// The folder Create stages an image in before a run reads it
/// (`video_stage_start_image`). A cutout takes its image from there alone.
pub(crate) fn staged_images_dir() -> PathBuf {
    crate::commands::video::outputs_root().join("start-images")
}

/// The image of a cutout as it may be read, or the sentence for the user.
pub(crate) fn staged_input(asked: &str, staged: &Path) -> Result<PathBuf, String> {
    if asked.trim().is_empty() {
        return Err(NO_IMAGE.to_string());
    }
    let staged = staged.canonicalize().map_err(|_| GONE.to_string())?;
    Path::new(asked)
        .canonicalize()
        .ok()
        .filter(|p| p.is_file() && p.starts_with(&staged))
        .ok_or_else(|| GONE.to_string())
}

/// The subject mask at the size of the image: one value from 0 (background)
/// to 1 (subject) per pixel, row by row.
struct Mask {
    width: u32,
    height: u32,
    values: Vec<f32>,
}

/// Whether a mask holds a subject at all. Vision answers with an empty set
/// when it sees none, and a mask without one firm pixel would be written as
/// an empty picture.
fn has_subject(values: &[f32]) -> bool {
    values.iter().any(|&m| m >= 0.5)
}

/// The mask as the alpha channel of `image`. What was transparent in the
/// source stays transparent: the mask scales the alpha the pixel has.
fn apply_mask(image: &mut image::RgbaImage, mask: &Mask) -> Result<(), String> {
    if image.dimensions() != (mask.width, mask.height) || mask.values.len() != image.pixels().len() {
        return Err(format!(
            "The subject mask is {}x{}, the image {}x{}.",
            mask.width,
            mask.height,
            image.width(),
            image.height()
        ));
    }
    for (pixel, &m) in image.pixels_mut().zip(&mask.values) {
        let share = if m.is_finite() { m.clamp(0.0, 1.0) } else { 0.0 };
        pixel[3] = (f32::from(pixel[3]) * share).round() as u8;
    }
    Ok(())
}

/// The staged image, upright, and whether it had to be turned for that. A
/// photo straight from a phone is stored on its side with a note to turn it;
/// the cutout is of the picture as it is seen.
fn read_upright(path: &Path) -> Result<(image::DynamicImage, bool), String> {
    use image::ImageDecoder as _;
    let unreadable = |e: image::ImageError| format!("The image could not be read ({e}). Use a PNG, JPG or WebP file.");
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("The image could not be opened: {}", crate::os_error::english(&e)))?
        .with_guessed_format()
        .map_err(|e| format!("The image could not be opened: {}", crate::os_error::english(&e)))?;
    let mut decoder = reader.into_decoder().map_err(unreadable)?;
    let orientation = decoder.orientation().map_err(unreadable)?;
    let mut picture = image::DynamicImage::from_decoder(decoder).map_err(unreadable)?;
    let turned = orientation != image::metadata::Orientation::NoTransforms;
    picture.apply_orientation(orientation);
    Ok((picture, turned))
}

/// Cut the subject out of the image at `input` and write the PNG into
/// `out_dir`. Answers with the file and its size.
#[cfg(target_os = "macos")]
pub(crate) fn cut_out(input: &Path, out_dir: &Path) -> Result<(PathBuf, u32, u32), String> {
    let (picture, turned) = read_upright(input)?;
    // Vision reads the file as it is stored and the mask has to fit the
    // pixels read above. A picture that had to be turned is handed over
    // turned, as a PNG in memory.
    let mask = if turned {
        let mut png = std::io::Cursor::new(Vec::new());
        picture
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| format!("The image could not be prepared for the cutout ({e})."))?;
        vision::subject_mask(vision::Source::Bytes(png.get_ref()))?
    } else {
        vision::subject_mask(vision::Source::File(input))?
    };
    let Some(mask) = mask.filter(|m| has_subject(&m.values)) else {
        return Err(NO_SUBJECT.to_string());
    };
    let mut rgba = picture.into_rgba8();
    apply_mask(&mut rgba, &mask)?;

    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("Could not create {}: {}", out_dir.display(), crate::os_error::english(&e)))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let out = out_dir.join(format!("cutout-{stamp}-{}.png", std::process::id()));
    rgba.save_with_format(&out, image::ImageFormat::Png)
        .map_err(|e| format!("Could not write the cutout ({e})."))?;
    Ok((out, rgba.width(), rgba.height()))
}

/// `mlx_cutout`: `args.image` is the path of a staged image. Answers like
/// `mlx_generate`: `image_base64`, `output`, `width`, `height`.
pub fn mlx_cutout(_state: &AppState, args: &Value) -> CmdResult {
    let asked = args.get("image").and_then(Value::as_str).unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;
        let input = staged_input(asked, &staged_images_dir()).map_err(crate::commands::bad_request)?;
        let started = std::time::Instant::now();
        let (out, width, height) =
            cut_out(&input, &crate::commands::mlx::images_root()).map_err(crate::commands::bad_request)?;
        tracing::info!("[cutout] {width}x{height} in {} ms", started.elapsed().as_millis());
        let bytes = std::fs::read(&out)
            .map_err(|e| crate::commands::internal(format!("read {}: {}", out.display(), crate::os_error::english(&e))))?;
        Ok(serde_json::json!({
            "image_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "width": width,
            "height": height,
            "output": out.to_string_lossy(),
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = asked;
        Err(crate::commands::bad_request(MAC_ONLY))
    }
}

/// The mask from Vision. Everything that touches Objective-C is in here.
#[cfg(target_os = "macos")]
mod vision {
    use std::path::Path;

    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread as _;
    use objc2_core_video::{
        kCVPixelFormatType_OneComponent32Float, kCVReturnSuccess, CVPixelBuffer, CVPixelBufferGetBaseAddress,
        CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    };
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSURL};
    use objc2_image_io::CGImagePropertyOrientation;
    use objc2_vision::{VNGenerateForegroundInstanceMaskRequest, VNImageOption, VNImageRequestHandler, VNRequest};

    use super::Mask;

    pub(super) enum Source<'a> {
        File(&'a Path),
        Bytes(&'a [u8]),
    }

    fn said(error: &NSError) -> String {
        error.localizedDescription().to_string()
    }

    /// The mask of every subject Vision finds, at the size of the image, or
    /// `None` when it finds none.
    pub(super) fn subject_mask(source: Source<'_>) -> Result<Option<Mask>, String> {
        autoreleasepool(|_| {
            let options = NSDictionary::<VNImageOption, AnyObject>::new();
            // The orientation is given as Up: it overrides any note in the
            // file, so the mask has the pixels' own layout (see `cut_out`).
            let handler = match source {
                Source::File(path) => {
                    let url = NSURL::from_file_path(path).ok_or("The image path could not be handed to Vision.")?;
                    // SAFETY: the options dictionary is empty, so its types hold.
                    unsafe {
                        VNImageRequestHandler::initWithURL_orientation_options(
                            VNImageRequestHandler::alloc(),
                            &url,
                            CGImagePropertyOrientation::Up,
                            &options,
                        )
                    }
                }
                Source::Bytes(bytes) => {
                    let data = NSData::with_bytes(bytes);
                    // SAFETY: the options dictionary is empty, so its types hold.
                    unsafe {
                        VNImageRequestHandler::initWithData_orientation_options(
                            VNImageRequestHandler::alloc(),
                            &data,
                            CGImagePropertyOrientation::Up,
                            &options,
                        )
                    }
                }
            };
            // SAFETY: a plain request without a completion handler.
            let request = unsafe { VNGenerateForegroundInstanceMaskRequest::new() };
            let as_request: &VNRequest = &request;
            handler
                .performRequests_error(&NSArray::from_slice(&[as_request]))
                .map_err(|e| format!("Vision could not look at the image: {}", said(&e)))?;
            // SAFETY: read after the request has been performed, on this thread.
            let Some(observation) = (unsafe { request.results() }).and_then(|r| r.firstObject()) else {
                return Ok(None);
            };
            // SAFETY: a getter of the observation.
            let instances = unsafe { observation.allInstances() };
            if instances.count() == 0 {
                return Ok(None);
            }
            // SAFETY: the instances are the observation's own, and the
            // handler is the one that produced it.
            let buffer = unsafe { observation.generateScaledMaskForImageForInstances_fromRequestHandler_error(&instances, &handler) }
                .map_err(|e| format!("Vision could not make the subject mask: {}", said(&e)))?;
            read_mask(&buffer).map(Some)
        })
    }

    /// The values of a one channel float buffer, row by row.
    fn read_mask(buffer: &CVPixelBuffer) -> Result<Mask, String> {
        if CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_OneComponent32Float {
            return Err("Vision answered with a mask in an unexpected format.".to_string());
        }
        // SAFETY: the buffer is alive for the whole call, and every lock is
        // matched by the unlock below.
        if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) } != kCVReturnSuccess {
            return Err("The subject mask could not be read.".to_string());
        }
        let read = (|| {
            let (width, height) = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer));
            let stride = CVPixelBufferGetBytesPerRow(buffer);
            let base = CVPixelBufferGetBaseAddress(buffer).cast::<u8>().cast_const();
            let row_bytes = width.checked_mul(std::mem::size_of::<f32>()).ok_or("The subject mask is too large.")?;
            if base.is_null() || stride < row_bytes || base.align_offset(std::mem::align_of::<f32>()) != 0 || !stride.is_multiple_of(std::mem::size_of::<f32>()) {
                return Err("The subject mask could not be read.".to_string());
            }
            let mut values = Vec::with_capacity(width * height);
            for y in 0..height {
                // SAFETY: the buffer is locked, holds `height` rows of
                // `stride` bytes from `base`, and each row starts with
                // `width` aligned floats (checked above).
                let row = unsafe { std::slice::from_raw_parts(base.add(y * stride).cast::<f32>(), width) };
                values.extend_from_slice(row);
            }
            let width = u32::try_from(width).map_err(|_| "The subject mask is too large.")?;
            let height = u32::try_from(height).map_err(|_| "The subject mask is too large.")?;
            Ok(Mask { width, height, values })
        })();
        // SAFETY: matches the lock above.
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) };
        read
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(width: u32, height: u32, values: Vec<f32>) -> Mask {
        Mask { width, height, values }
    }

    #[test]
    fn the_mask_becomes_the_alpha_and_the_colour_stays() {
        let mut img = image::RgbaImage::from_raw(2, 2, vec![
            10, 20, 30, 255, 40, 50, 60, 255, //
            70, 80, 90, 255, 1, 2, 3, 128,
        ])
        .unwrap();
        apply_mask(&mut img, &mask(2, 2, vec![1.0, 0.0, 0.5, 1.0])).unwrap();
        assert_eq!(img.as_raw(), &vec![
            10, 20, 30, 255, 40, 50, 60, 0, //
            70, 80, 90, 128, 1, 2, 3, 128,
        ]);
    }

    #[test]
    fn values_outside_the_range_are_clamped_and_nan_is_background() {
        let mut img = image::RgbaImage::from_pixel(4, 1, image::Rgba([9, 9, 9, 200]));
        apply_mask(&mut img, &mask(4, 1, vec![-1.0, 2.0, f32::NAN, f32::INFINITY])).unwrap();
        let alphas: Vec<u8> = img.pixels().map(|p| p[3]).collect();
        assert_eq!(alphas, vec![0, 200, 0, 0]);
    }

    #[test]
    fn a_mask_of_another_size_is_refused() {
        let mut img = image::RgbaImage::new(3, 2);
        let err = apply_mask(&mut img, &mask(2, 3, vec![1.0; 6])).unwrap_err();
        assert!(err.contains("2x3") && err.contains("3x2"), "{err}");
        let err = apply_mask(&mut img, &mask(3, 2, vec![1.0; 5])).unwrap_err();
        assert!(err.contains("3x2"), "{err}");
    }

    #[test]
    fn a_mask_without_a_firm_pixel_holds_no_subject() {
        assert!(!has_subject(&[]));
        assert!(!has_subject(&[0.0, 0.2, 0.49]));
        assert!(!has_subject(&[f32::NAN]));
        assert!(has_subject(&[0.0, 0.5]));
        assert!(has_subject(&[0.0, 0.97, 0.1]));
    }

    #[test]
    fn only_a_file_in_the_stage_folder_is_read() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("start-images");
        std::fs::create_dir_all(&staged).unwrap();
        let inside = staged.join("a.png");
        std::fs::write(&inside, b"png").unwrap();
        let outside = root.path().join("b.png");
        std::fs::write(&outside, b"png").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert_eq!(staged_input(&s(&inside), &staged).unwrap(), inside.canonicalize().unwrap());
        // Beside the folder, out of it by `..`, the folder itself, a file
        // that is gone, and nothing at all.
        assert_eq!(staged_input(&s(&outside), &staged).unwrap_err(), GONE);
        assert_eq!(staged_input(&s(&staged.join("..").join("b.png")), &staged).unwrap_err(), GONE);
        assert_eq!(staged_input(&s(&staged), &staged).unwrap_err(), GONE);
        assert_eq!(staged_input(&s(&staged.join("gone.png")), &staged).unwrap_err(), GONE);
        assert_eq!(staged_input("relative.png", &staged).unwrap_err(), GONE);
        assert_eq!(staged_input("", &staged).unwrap_err(), NO_IMAGE);
        assert_eq!(staged_input("  ", &staged).unwrap_err(), NO_IMAGE);
        // No stage folder yet: nothing was ever staged.
        assert_eq!(staged_input(&s(&inside), &root.path().join("missing")).unwrap_err(), GONE);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_stage_folder_to_a_file_outside_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("start-images");
        std::fs::create_dir_all(&staged).unwrap();
        let outside = root.path().join("secret.png");
        std::fs::write(&outside, b"png").unwrap();
        let link = staged.join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(staged_input(&link.to_string_lossy(), &staged).unwrap_err(), GONE);
    }

    #[test]
    fn a_photo_stored_on_its_side_is_read_upright() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.png");
        image::RgbaImage::new(3, 2).save(&path).unwrap();
        let (picture, turned) = read_upright(&path).unwrap();
        assert_eq!((picture.width(), picture.height(), turned), (3, 2, false));
        let junk = dir.path().join("junk.png");
        std::fs::write(&junk, b"not an image").unwrap();
        assert!(read_upright(&junk).unwrap_err().contains("PNG, JPG or WebP"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_the_command_says_it_is_for_a_mac() {
        let state = crate::state::AppState::new();
        let err = mlx_cutout(&state, &serde_json::json!({ "image": "/x.png" })).unwrap_err();
        assert_eq!(err, MAC_ONLY);
    }

    /// Vision on a real picture. Run on a Mac with
    /// `LU_CUTOUT_IMAGE=/path/to/photo.png cargo test cutout_on_a_real_image -- --ignored --nocapture`;
    /// the PNG is written to `LU_CUTOUT_OUT` (a folder) or a temporary one.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "runs Vision on a picture named by LU_CUTOUT_IMAGE"]
    fn cutout_on_a_real_image() {
        let input = PathBuf::from(std::env::var("LU_CUTOUT_IMAGE").expect("LU_CUTOUT_IMAGE names a picture"));
        let keep = std::env::var("LU_CUTOUT_OUT").ok().map(PathBuf::from);
        let temp = tempfile::tempdir().unwrap();
        let out_dir = keep.unwrap_or_else(|| temp.path().to_path_buf());
        let started = std::time::Instant::now();
        let (out, width, height) = cut_out(&input, &out_dir).unwrap();
        let took = started.elapsed();
        let made = image::open(&out).unwrap().into_rgba8();
        assert_eq!(made.dimensions(), (width, height));
        let clear = made.pixels().filter(|p| p[3] == 0).count();
        let solid = made.pixels().filter(|p| p[3] == 255).count();
        let all = made.pixels().len();
        println!(
            "cutout {} {width}x{height} in {:.2} s, {clear} clear and {solid} solid of {all} pixels",
            out.display(),
            took.as_secs_f64()
        );
        assert!(clear > 0 && solid > 0, "a cutout has both background and subject");
    }
}
