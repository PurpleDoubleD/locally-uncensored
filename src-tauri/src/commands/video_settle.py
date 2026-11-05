"""Colour settle for a video made of several sections laid end to end.

LU writes this file into a private temp folder and runs it with ComfyUI's own
Python (``python -I video_settle.py --input A --output B --boundaries 157
--anchor-end 81 --window 8``). Only numpy and PyAV (``av``) are imported
besides the standard library; both are in ComfyUI's requirements.txt.

Every boundary is the index of the first frame of a new section. The frames
before the first boundary pass through as they are; from it on every frame is
matched to the anchor, frames 0..anchor_end-1 (without ``--anchor-end``: all
frames before the first boundary). The anchor is the clip's first section, so
every later one hangs on it and no correction builds on another.

Why per frame and not once per seam (P5, 3.0.9): in the B18 box runs a Wan
section continued from frames came out about a fifth more saturated and half
again as sharp within its first 15 frames, then stayed there, and the next
section started from that and added its own step. Matching the first frames
of a section to the last ones of the section before only carried every step
over. Here, per frame and per plane of the video's own YUV,

    f' = (f - mean_t) * clamp(std_anchor / std_t) + mean_t + clamp(mean_anchor - mean_t)

where mean_t and std_t are smoothed over ``window`` frames on each side
(never across a boundary), so a quick change in the picture stays and only
the slow drift goes. U and V carry the saturation. Sharpness is the mean
absolute Laplacian of Y; a frame sharper than the anchor is blended towards a
slightly blurred copy of itself by just enough to meet it (softened only,
never sharpened).

Everything stays in YUV 4:2:0, the format the h264 file has anyway. A detour
through RGB lost about 1.2 levels of brightness on every pass with PyAV, and
a long clip passes through here once per section.

``--base`` (P5 box run, 30 s): the file this step wrote last time. ComfyUI
hands back the WHOLE clip with every section, and its copy of the frames
already there went through its own RGB round trip: +1.3 to +1.6 levels of Y
and 3 to 4 % more saturation per section, the first section included. Matched
to the first section, every section looked even while the whole clip grew
brighter (Y 74.8 -> 83.8 over six sections). With ``--base`` the frames before
the newest boundary come from that file instead, so only the new section is
ComfyUI's. When the base does not have exactly that many frames of the same
size, it is left out and the report says why.

The output carries the colour tags of the input (range, matrix, primaries,
transfer). Without them ComfyUI read the next clip with another matrix.

Two passes over the video: statistics first, then the corrected frames. Only
per-frame numbers are kept between them, so the length of the video does not
decide the memory it needs. Frames above MAX_PIXELS are refused outright.

The result goes to stdout as one JSON line, the last line printed. An error
is the same shape with ``ok: false`` and exit code 2.
"""

import argparse
import json
import sys
from fractions import Fraction

import av
import numpy as np

# 4096 x 2304: far above anything LU renders.
MAX_PIXELS = 4096 * 2304
MAX_WINDOW = 60
# The drift this takes out builds up over sections; the clamp only stops a
# scene that really changed from being forced back. Chroma is wider (P5 box
# run, 30 s): a short last section of A14B + lightx2v came out with U and V
# 20 to 27 levels off the anchor and needed gains near 0.35.
Y_GAIN = (0.75, 1.25)
C_GAIN = (0.35, 1.5)
Y_SHIFT = 30.0
C_SHIFT = 30.0
SOFTEN_MAX = 0.85
# Every 2nd pixel in each direction is enough for the statistics.
STEP = 2


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(2)


def parse_boundaries(text):
    out = set()
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.add(int(part))
        except ValueError:
            fail("Boundary is not a frame number: %r" % part)
    return sorted(out)


def planes(frame, w, h):
    """Y (h x w), U and V (h/2 x w/2) of a decoded frame, as uint8."""
    if frame.format.name != "yuv420p":
        frame = frame.reformat(format="yuv420p")
    a = frame.to_ndarray(format="yuv420p")
    fw = frame.width
    fh = frame.height
    y = a[:fh, :fw]
    qw, qh = fw // 2, fh // 2
    u = a[fh:fh + fh // 4].reshape(-1)[: qw * qh].reshape(qh, qw)
    v = a[fh + fh // 4:].reshape(-1)[: qw * qh].reshape(qh, qw)
    return y[:h, :w], u[: h // 2, : w // 2], v[: h // 2, : w // 2]


def to_frame(y, u, v):
    h, w = y.shape
    a = np.empty((h * 3 // 2, w), dtype=np.uint8)
    a[:h] = y
    a[h:h + h // 4] = u.reshape(h // 4, w)
    a[h + h // 4:] = v.reshape(h // 4, w)
    return av.VideoFrame.from_ndarray(a, format="yuv420p")


def blur(img):
    """5-tap binomial blur along both axes, edges repeated."""
    out = img.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (2, 2)
        p = np.pad(out, pad, mode="edge")
        n = out.shape[axis]
        acc = np.zeros_like(out)
        for i, w in enumerate((1.0, 4.0, 6.0, 4.0, 1.0)):
            acc += w * np.take(p, range(i, i + n), axis=axis)
        out = acc / 16.0
    return out


def sharpness(y):
    y = y.astype(np.float32)
    lap = 4 * y[1:-1, 1:-1] - y[:-2, 1:-1] - y[2:, 1:-1] - y[1:-1, :-2] - y[1:-1, 2:]
    return float(np.abs(lap).mean())


COLOR_FIELDS = ("color_range", "colorspace", "color_primaries", "color_trc")


def read_color(source):
    """The colour tags of a codec context or frame that PyAV exposes."""
    tags = {}
    for name in COLOR_FIELDS:
        try:
            tags[name] = getattr(source, name)
        except Exception:
            pass
    return tags


def apply_color(tags, target):
    """Set the tags on a codec context or frame; older PyAV lacks some."""
    for name, value in tags.items():
        try:
            setattr(target, name, value)
        except Exception:
            pass


def frame_count_and_size(path):
    with av.open(path) as c:
        s = c.streams.video[0]
        n = sum(1 for _ in c.decode(s))
        return n, s.codec_context.width, s.codec_context.height


def frame_stats(y, u, v, with_blur):
    sub = [p[::STEP, ::STEP].astype(np.float64) for p in (y, u, v)]
    row = {
        "mean": np.array([p.mean() for p in sub]),
        "std": np.array([p.std() for p in sub]),
        "sharp": sharpness(y),
    }
    if with_blur:
        row["sharpBlur"] = sharpness(blur(y))
    return row


def smooth(values, window, cuts):
    """Centred moving average over `window` frames each side, never across a
    cut (indices where a new section starts)."""
    arr = np.asarray(values, dtype=np.float64)
    out = np.empty_like(arr)
    edges = [0] + [c for c in cuts if 0 < c < len(arr)] + [len(arr)]
    for lo_seg, hi_seg in zip(edges, edges[1:]):
        for i in range(lo_seg, hi_seg):
            lo, hi = max(lo_seg, i - window), min(hi_seg, i + window + 1)
            out[i] = arr[lo:hi].mean(axis=0)
    return out


def plan_frames(stats, anchor_end, start, window, boundaries):
    """Per frame from `start` on: (mean_t, gain, target, soften), and the
    anchor's numbers."""
    anchor = stats[:anchor_end]
    a_mean = np.mean([r["mean"] for r in anchor], axis=0)
    a_std = np.mean([r["std"] for r in anchor], axis=0)
    a_sharp = float(np.mean([r["sharp"] for r in anchor]))
    rest = stats[start:]
    cuts = [b - start for b in boundaries if b > start]
    m = smooth([r["mean"] for r in rest], window, cuts)
    sd = smooth([r["std"] for r in rest], window, cuts)
    sh = smooth([r["sharp"] for r in rest], window, cuts)
    sb = smooth([r["sharpBlur"] for r in rest], window, cuts)
    plan = []
    for i in range(len(rest)):
        gain = np.ones(3)
        for c in range(3):
            if sd[i][c] > 1e-6:
                gain[c] = a_std[c] / sd[i][c]
        gain[0] = min(max(gain[0], Y_GAIN[0]), Y_GAIN[1])
        gain[1:] = np.clip(gain[1:], C_GAIN[0], C_GAIN[1])
        target = m[i].copy()
        target[0] += float(np.clip(a_mean[0] - m[i][0], -Y_SHIFT, Y_SHIFT))
        target[1:] += np.clip(a_mean[1:] - m[i][1:], -C_SHIFT, C_SHIFT)
        # The Laplacian scales with the Y gain; blending towards the blurred
        # copy moves it linearly between the two.
        s_now, s_soft = gain[0] * sh[i], gain[0] * sb[i]
        soften = 0.0
        if s_now > a_sharp and s_now - s_soft > 1e-6:
            soften = min(SOFTEN_MAX, (s_now - a_sharp) / (s_now - s_soft))
        plan.append((m[i], gain, target, soften))
    anchor_info = {
        "mean": [round(float(x), 3) for x in a_mean],
        "std": [round(float(x), 3) for x in a_std],
        "sharp": round(a_sharp, 3),
    }
    return plan, anchor_info


def apply_plan(y, u, v, step):
    mean_t, gain, target, soften = step
    out = []
    for c, p in enumerate((y, u, v)):
        f = (p.astype(np.float32) - np.float32(mean_t[c])) * np.float32(gain[c]) + np.float32(target[c])
        if soften > 0:
            f += np.float32(soften) * (blur(f) - f)
        np.clip(f, 0.0, 255.0, out=f)
        out.append(np.rint(f).astype(np.uint8))
    return out


def add_audio_stream(output, in_audio):
    """A remux copy of the input's audio stream, or None with the reason."""
    try:
        if hasattr(output, "add_stream_from_template"):
            return output.add_stream_from_template(in_audio), None
        return output.add_stream(template=in_audio), None
    except Exception as exc:  # the container may not take this codec
        return None, "audio not copied: %s" % exc


def copy_audio(input_path, output, out_audio):
    """Remux the source's audio behind the video. Returns (copied, note)."""
    try:
        with av.open(input_path) as again:
            stream = again.streams.audio[0]
            for packet in again.demux(stream):
                if packet.dts is None:
                    continue
                packet.stream = out_audio
                output.mux(packet)
        return True, None
    except Exception as exc:
        return False, "audio not copied: %s" % exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--boundaries", default="")
    parser.add_argument("--anchor-end", type=int, default=0)
    parser.add_argument("--window", type=int, default=8)
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--base", default="")
    args = parser.parse_args()

    window = args.window
    if window < 1 or window > MAX_WINDOW:
        fail("window must be between 1 and %d" % MAX_WINDOW)
    requested = parse_boundaries(args.boundaries)

    try:
        source = av.open(args.input)
    except Exception as exc:
        fail("Cannot open the video: %s" % exc)
    if not source.streams.video:
        fail("The file has no video stream.")
    in_video = source.streams.video[0]
    has_audio = bool(source.streams.audio)
    width = in_video.codec_context.width
    height = in_video.codec_context.height
    if width * height > MAX_PIXELS:
        fail("Frames of %dx%d are larger than this step handles." % (width, height))
    rate = Fraction(in_video.average_rate or in_video.guessed_rate or Fraction(24, 1))
    # yuv420p needs even sides; an odd one loses its last row or column.
    out_w, out_h = width - (width % 2), height - (height % 2)

    color = read_color(in_video.codec_context)
    # The input's frame count first: whether the base fits depends on it.
    try:
        total = sum(1 for _ in source.decode(in_video))
    except Exception as exc:
        fail("Reading failed: %s" % exc)
    source.close()

    inside = [b for b in requested if 0 < b < total]
    base_frames, base_note = 0, None
    if args.base:
        newest = inside[-1] if inside else 0
        try:
            n, bw, bh = frame_count_and_size(args.base)
        except Exception as exc:
            n, bw, bh = -1, 0, 0
            base_note = "base not read: %s" % exc
        if base_note is None:
            if newest < 1 or n != newest or (bw - bw % 2, bh - bh % 2) != (out_w, out_h):
                base_note = "base left out: %d frames of %dx%d, the clip needs %d of %dx%d" % (n, bw, bh, newest, out_w, out_h)
            else:
                base_frames = newest

    def frames_in_order():
        """Planes of every frame: the first base_frames from the base, the
        rest from the input."""
        if base_frames:
            with av.open(args.base) as b:
                for i, frame in enumerate(b.decode(b.streams.video[0])):
                    if i >= base_frames:
                        break
                    yield planes(frame, out_w, out_h)
        with av.open(args.input) as c:
            for i, frame in enumerate(c.decode(c.streams.video[0])):
                if i >= base_frames:
                    yield planes(frame, out_w, out_h)

    # Pass 1: numbers per frame.
    stats = []
    try:
        for p in frames_in_order():
            stats.append(frame_stats(*p, with_blur=True))
    except Exception as exc:
        fail("Reading failed at frame %d: %s" % (len(stats), exc))
    total = len(stats)

    ignored = [b for b in requested if b not in inside]
    anchor_end = args.anchor_end if args.anchor_end > 0 else (inside[0] if inside else 0)
    after = [b for b in inside if b >= anchor_end]
    ignored.extend(b for b in inside if b < anchor_end)
    start = after[0] if after else None
    if start is None or anchor_end < 1 or anchor_end >= total:
        start = total  # nothing to correct: a plain copy
        plan, anchor_info = [], None
    else:
        plan, anchor_info = plan_frames(stats, anchor_end, start, window, after)

    output = av.open(args.output, mode="w")
    out_video = output.add_stream("h264", rate=rate)
    out_video.width = out_w
    out_video.height = out_h
    out_video.pix_fmt = "yuv420p"
    apply_color(color, out_video.codec_context)
    try:
        out_video.options = {"crf": str(args.crf)}
    except Exception:
        pass
    time_base = Fraction(1, 1) / rate
    out_audio, audio_note = (None, None)
    if has_audio:
        with av.open(args.input) as probe:
            out_audio, audio_note = add_audio_stream(output, probe.streams.audio[0])

    # Pass 2: write.
    index = 0
    try:
        for y, u, v in frames_in_order():
            if index >= start:
                y, u, v = apply_plan(y, u, v, plan[index - start])
            vf = to_frame(y, u, v)
            apply_color(color, vf)
            vf.pts = index
            vf.time_base = time_base
            for packet in out_video.encode(vf):
                output.mux(packet)
            index += 1
        for packet in out_video.encode():
            output.mux(packet)
    except Exception as exc:
        output.close()
        fail("Processing failed at frame %d: %s" % (index, exc))

    audio_copied = False
    if out_audio is not None:
        audio_copied, note = copy_audio(args.input, output, out_audio)
        audio_note = note or audio_note
    output.close()

    seams = []
    if anchor_info is not None:
        cuts = after + [total]
        for lo, hi in zip(cuts, cuts[1:]):
            part = plan[lo - start:hi - start]
            raw = stats[lo:hi]
            softens = [p[3] for p in part]
            seams.append({
                "frame": lo,
                "space": "yuv",
                "refMean": anchor_info["mean"],
                "refStd": anchor_info["std"],
                "curMean": [round(float(x), 3) for x in np.mean([r["mean"] for r in raw], axis=0)],
                "curStd": [round(float(x), 3) for x in np.mean([r["std"] for r in raw], axis=0)],
                "gain": [round(float(x), 4) for x in np.mean([p[1] for p in part], axis=0)],
                "refFrames": anchor_end,
                "curFrames": hi - lo,
                "refSharp": anchor_info["sharp"],
                "curSharp": round(float(np.mean([r["sharp"] for r in raw])), 3),
                "soften": round(float(np.mean(softens)), 4),
                "softenMax": round(float(np.max(softens)), 4),
            })

    print(json.dumps({
        "ok": True,
        "frames": index,
        "width": out_w,
        "height": out_h,
        "fps": float(rate),
        "window": window,
        "seams": seams,
        "ignoredBoundaries": sorted(ignored),
        "audio": audio_copied,
        "note": audio_note,
        "base": base_frames,
        "baseNote": base_note,
    }))


if __name__ == "__main__":
    main()
