import argparse, os, re, subprocess, sys, tempfile
from typing import List, Tuple
import matplotlib.pyplot as plt

# ---------------- Utility ----------------
def run(cmd: List[str], **kw):
    return subprocess.run(cmd, **kw)

def ffprobe_duration(path: str) -> float:
    return float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path
    ]).decode().strip())

# ---------------- Argument Parsing ----------------
def parse_args():
    p = argparse.ArgumentParser(description="Cut low-volume pauses from video (lossless).")
    p.add_argument("input", help="Input video file")
    p.add_argument("--noise", default="-20dB", help="Silence threshold, e.g. -35dB / -40dB")
    p.add_argument("--silence", type=float, help="Min silence duration (sec)")
    p.add_argument("--pad", type=float, help="Pad before/after speech (sec)")
    p.add_argument("--keep", type=float, help="Drop kept clips shorter than this (sec)")
    p.add_argument("--outdir", default="out", help="Output directory")
    p.add_argument("--hist", action="store_true", help="Generate histogram of RMS levels")
    p.add_argument("--bins", type=int, default=5, help="Histogram bin width in dB")
    p.add_argument("--min_db", type=int, default=-90, help="Minimum dB for histogram")
    p.add_argument("--max_db", type=int, default=0, help="Maximum dB for histogram")
    return p.parse_args()

# ---------------- Filename Builder ----------------
def build_output_name(input_path, args):
    base = os.path.splitext(os.path.basename(input_path))[0]

    # format parameters cleanly for filename
    noise_val = str(args.noise).lower().replace("db", "").replace("-", "n")
    suffix = "_".join([noise_val])
    return f"{base}_{suffix}.mp4"

# ---------------- Silence Detection ----------------

def _noise_for_ffmpeg(noise: str) -> str:
    """
    Accept -21 / -21dB / 21 / 21dB and return '-21dB'.
    Ensures the required 'dB' suffix and a leading minus.
    """
    s = str(noise).strip()
    if not s.lower().endswith("db"):
        s += "dB"
    # if user typed '21dB' or '21', make it negative
    if re.fullmatch(r"\d+(?:\.\d+)?dB", s, re.I):
        s = "-" + s
    return s


def detect_silences(input_path: str, noise: str, min_silence: float) -> Tuple[List[float], List[float], str]:
    noise_norm = _noise_for_ffmpeg(noise)
    with tempfile.TemporaryDirectory() as td:
        slog = os.path.join(td, "silence.log")
        # ensure the file is closed/flushed before we read it
        with open(slog, "w", encoding="utf-8") as err:
            run([
                "ffmpeg","-hide_banner","-nostats","-y","-i", input_path,
                "-af", f"silencedetect=noise={noise_norm}:d={min_silence}",
                "-f","null","-"
            ], stderr=err)
        txt = open(slog, "r", encoding="utf-8", errors="ignore").read()

    starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
    ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)",   txt)]
    print(f"[silence] noise={noise_norm} silence={min_silence} → {len(starts)} starts, {len(ends)} ends")
    return starts, ends, txt

# ---------------- Segment Building ----------------
def build_speaking_segments(starts: List[float], ends: List[float], dur: float,
                            pad: float, keep: float) -> List[Tuple[float, float]]:
    if not starts and not ends:
        return [(0.0, dur)]
    if not starts or (ends and ends[0] < starts[0]):
        starts = [0.0] + starts
    if len(ends) < len(starts):
        ends = ends + [dur]

    pairs = list(zip(starts, ends))
    speaking = []
    t = 0.0
    for s, e in pairs:
        if s - t > 0.05:
            new_start = max(0, t - pad)
            new_end = min(dur, s + pad)
            if speaking and new_start < speaking[-1][1]:
                speaking[-1] = (speaking[-1][0], max(speaking[-1][1], new_end))
            else:
                speaking.append((new_start, new_end))
        t = e
    if dur - t > 0.05:
        new_start = max(0, t - pad)
        if speaking and new_start < speaking[-1][1]:
            speaking[-1] = (speaking[-1][0], dur)
        else:
            speaking.append((new_start, dur))
    # Remove overlaps
    merged = []
    for seg in speaking:
        if not merged or seg[0] > merged[-1][1]:
            merged.append(seg)
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], seg[1]))
    return [(x, y) for x, y in merged if (y - x) >= keep]

# ---------------- Cutting & Concatenation ----------------
def cut_and_concat(input_path: str, segments: List[Tuple[float, float]], output_path: str):
    """
    Frame-accurate trimming via trim/atrim + concat (single re-encode).
    Eliminates duplicate/overlapping audio-video at joins.
    """
    # safety: sort + merge tiny gaps/overlaps
    def _coalesce(segs, eps=0.03):
        if not segs: return []
        out = []
        for s,e in sorted(segs):
            if not out or s > out[-1][1] + eps:
                out.append([s,e])
            else:
                out[-1][1] = max(out[-1][1], e)
        return [(round(s,3), round(e,3)) for s,e in out]

    segments = _coalesce(segments)

    eps = 0.010  # shave 10 ms off each tail to avoid clicks
    clips = [(max(0.0, s), max(0.0, e - eps)) for s,e in segments if e - s > eps]
    if not clips:
        print("No valid segments to cut."); sys.exit(0)

    vf, af = [], []
    for i,(st,et) in enumerate(clips):
        vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
        af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
    concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
    filter_complex = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cmd = [
        "ffmpeg","-hide_banner","-nostats","-y",
        "-i", input_path,
        "-filter_complex", filter_complex,
        "-map","[v]","-map","[a]",
        "-c:v","libx264","-preset","veryfast","-crf","20",
        "-c:a","aac","-b:a","160k",
        "-movflags","+faststart",
        output_path
    ]
    rc = subprocess.run(cmd).returncode
    if rc != 0:
        sys.exit(rc)


# ---------------- Histogram ----------------
def analyze_levels(input_path: str) -> List[float]:
    def run_fg(fg: str) -> str:
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "levels.log")
            with open(path, "w", encoding="utf-8") as f:
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-nostats", "-y",
                    "-i", input_path, "-vn", "-sn",
                    "-af", fg, "-f", "null", "-"
                ], stdout=f, stderr=f)
            return open(path, "r", encoding="utf-8", errors="ignore").read()

    txt = run_fg("aformat=channel_layouts=mono,"
                 "astats=metadata=1:reset=1,"
                 "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:entry=frame")
    vals = [float(x) for x in re.findall(r"RMS_level=([-+]?\d+(?:\.\d+)?)", txt)]
    if not vals:
        txt = run_fg("astats=metadata=1:reset=1,"
                     "ametadata=mode=print:key=lavfi.astats.1.RMS_level:entry=frame")
        vals = [float(x) for x in re.findall(r"RMS_level=([-+]?\d+(?:\.\d+)?)", txt)]
    return vals

def plot_histogram(vals: List[float], binsize: int, min_db: int, max_db: int, outpath: str):
    if not vals:
        print("[hist] No audio levels found, skipping histogram.")
        return
    plt.hist(vals, bins=range(min_db, max_db + binsize, binsize), edgecolor="black")
    plt.xlabel("RMS Level (dBFS)")
    plt.ylabel("Frame Count")
    plt.title("Audio Loudness Distribution")
    plt.savefig(outpath)
    plt.close()
    print(f"[hist] Histogram saved to {outpath}")

# ---------------- Main ----------------
def main():
    a = parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    out_final = os.path.join(a.outdir, build_output_name(a.input, a))

    if a.hist:
        vals = analyze_levels(a.input)
        plot_histogram(vals, a.bins, a.min_db, a.max_db,
                       os.path.join(a.outdir, os.path.splitext(os.path.basename(out_final))[0] + "_hist.png"))

    starts, ends, _ = detect_silences(a.input, a.noise, a.silence)
    dur = ffprobe_duration(a.input)
    segments = build_speaking_segments(starts, ends, dur, a.pad, a.keep)

    if not segments:
        print("No keepable segments; nothing to output.")
        sys.exit(0)

    cut_and_concat(a.input, segments, out_final)
    print(f"✔ Wrote {out_final}")

if __name__ == "__main__":
    main()
