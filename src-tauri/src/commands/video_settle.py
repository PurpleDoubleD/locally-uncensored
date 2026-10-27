"""Colour settle for a video made of several sections laid end to end.

LU writes this file into a private temp folder and runs it with ComfyUI's own
Python (``python -I video_settle.py --input A --output B --boundaries 81,157
--window 5``). Only numpy and PyAV (``av``) are imported besides the standard
library; both are in ComfyUI's requirements.txt.

Every boundary is the index of the first frame of a new section. Each section
is matched to the one before it, as that one looks AFTER its own correction:
the last ``window`` corrected frames before the boundary are the reference,
the first ``window`` frames of the new section the sample. Per channel

    gain = clamp(std_ref / std_cur, 0.8, 1.25)
    f'   = (f - mean_cur) * gain + mean_ref

is applied to every frame from the boundary to the next one (or the end).
Chained like this, every section hangs on the first one and the corrections
do not add up their own errors.

The video is streamed: at most ``window`` corrected frames and ``window``
uncorrected ones are held at a time, so the length of the video does not
decide the memory it needs. Frames above MAX_PIXELS are refused outright.

The result goes to stdout as one JSON line, the last line printed. An error
is the same shape with ``ok: false`` and exit code 2.
"""

import argparse
import json
import sys
from collections import deque
from fractions import Fraction

import av
import numpy as np

GAIN_MIN = 0.8
GAIN_MAX = 1.25
# 4096 x 2304: far above anything LU renders, low enough that 2 x window
# frames in float stay well under a gigabyte.
MAX_PIXELS = 4096 * 2304
MAX_WINDOW = 60


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


def channel_stats(frames):
    """Mean and standard deviation per channel over a list of HxWx3 uint8."""
    stack = np.stack(frames).astype(np.float64)
    flat = stack.reshape(-1, 3)
    return flat.mean(axis=0), flat.std(axis=0)


def make_transform(ref_frames, cur_frames):
    ref_mean, ref_std = channel_stats(ref_frames)
    cur_mean, cur_std = channel_stats(cur_frames)
    gain = np.ones(3)
    for c in range(3):
        if cur_std[c] > 1e-6:
            gain[c] = ref_std[c] / cur_std[c]
    gain = np.clip(gain, GAIN_MIN, GAIN_MAX)
    seam = {
        "refMean": [round(float(v), 3) for v in ref_mean],
        "curMean": [round(float(v), 3) for v in cur_mean],
        "refStd": [round(float(v), 3) for v in ref_std],
        "curStd": [round(float(v), 3) for v in cur_std],
        "gain": [round(float(v), 4) for v in gain],
        "refFrames": len(ref_frames),
        "curFrames": len(cur_frames),
    }
    return (cur_mean, gain, ref_mean), seam


def apply_transform(frame, transform):
    if transform is None:
        return frame
    cur_mean, gain, ref_mean = transform
    out = (frame.astype(np.float32) - cur_mean.astype(np.float32)) * gain.astype(np.float32)
    out += ref_mean.astype(np.float32)
    np.clip(out, 0.0, 255.0, out=out)
    return np.rint(out).astype(np.uint8)


def add_audio_stream(output, in_audio):
    """A remux copy of the input's audio stream, or None with the reason."""
    try:
        if hasattr(output, "add_stream_from_template"):
            return output.add_stream_from_template(in_audio), None
        return output.add_stream(template=in_audio), None
    except Exception as exc:  # the container may not take this codec
        return None, "audio not copied: %s" % exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--boundaries", default="")
    parser.add_argument("--window", type=int, default=5)
    parser.add_argument("--crf", type=int, default=18)
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
    in_audio = source.streams.audio[0] if source.streams.audio else None
    width = in_video.codec_context.width
    height = in_video.codec_context.height
    if width * height > MAX_PIXELS:
        fail("Frames of %dx%d are larger than this step handles." % (width, height))
    rate = in_video.average_rate or in_video.guessed_rate or Fraction(24, 1)
    rate = Fraction(rate)
    # yuv420p needs even sides; an odd one loses its last row or column.
    out_w, out_h = width - (width % 2), height - (height % 2)

    output = av.open(args.output, mode="w")
    out_video = output.add_stream("h264", rate=rate)
    out_video.width = out_w
    out_video.height = out_h
    out_video.pix_fmt = "yuv420p"
    try:
        out_video.options = {"crf": str(args.crf)}
    except Exception:
        pass
    time_base = Fraction(1, 1) / rate
    out_audio, audio_note = (None, None)
    if in_audio is not None:
        out_audio, audio_note = add_audio_stream(output, in_audio)

    written = 0

    def write(frame_array):
        nonlocal written
        if frame_array.shape[1] != out_w or frame_array.shape[0] != out_h:
            frame_array = frame_array[:out_h, :out_w]
        vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(frame_array), format="rgb24")
        vf.pts = written
        vf.time_base = time_base
        for packet in out_video.encode(vf):
            output.mux(packet)
        written += 1

    pending = deque(requested)
    while pending and pending[0] <= 0:
        pending.popleft()
    ignored = [b for b in requested if b <= 0]
    seams = []
    recent = deque(maxlen=window)  # last corrected frames
    transform = None
    sample = None  # raw frames collected after a boundary
    sample_start = None
    sample_end = None
    index = 0

    def close_sample():
        nonlocal transform, sample, sample_start
        new_transform, seam = make_transform(list(recent), sample)
        seam["frame"] = sample_start
        seams.append(seam)
        transform = new_transform
        for raw in sample:
            fixed = apply_transform(raw, transform)
            write(fixed)
            recent.append(fixed)
        sample = None
        sample_start = None

    try:
        for frame in source.decode(in_video):
            raw = frame.to_ndarray(format="rgb24")
            if pending and index == pending[0]:
                if sample is not None:
                    close_sample()
                pending.popleft()
                sample, sample_start = [], index
                # The sample stays inside its own section.
                sample_end = min(index + window, pending[0] if pending else index + window)
            if sample is not None:
                sample.append(raw)
                if index + 1 >= sample_end:
                    close_sample()
            else:
                fixed = apply_transform(raw, transform)
                write(fixed)
                recent.append(fixed)
            index += 1
        if sample is not None:
            close_sample()
        for packet in out_video.encode():
            output.mux(packet)
    except SystemExit:
        raise
    except Exception as exc:
        output.close()
        fail("Processing failed at frame %d: %s" % (index, exc))

    ignored.extend(pending)
    source.close()

    audio_copied = False
    if out_audio is not None:
        try:
            with av.open(args.input) as again:
                stream = again.streams.audio[0]
                for packet in again.demux(stream):
                    if packet.dts is None:
                        continue
                    packet.stream = out_audio
                    output.mux(packet)
            audio_copied = True
        except Exception as exc:
            audio_note = "audio not copied: %s" % exc
    output.close()

    print(json.dumps({
        "ok": True,
        "frames": written,
        "width": out_w,
        "height": out_h,
        "fps": float(rate),
        "window": window,
        "seams": seams,
        "ignoredBoundaries": ignored,
        "audio": audio_copied,
        "note": audio_note,
    }))


if __name__ == "__main__":
    main()
