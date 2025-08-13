from collections import Counter
import argparse, math, os, re, subprocess, sys, threading
from typing import List, Tuple
import json
import numpy as np
import math
from collections import Counter
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

# ---------------- Utility ----------------

def _popen_hidden_kwargs():
    # Hide console windows on Windows when running as a GUI app
    if os.name == "nt" and (getattr(sys, "frozen", False) or getattr(sys, "stderr", None) is None):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        CREATE_NO_WINDOW = 0x08000000
        return {"startupinfo": si, "creationflags": CREATE_NO_WINDOW}
    return {}

def ffprobe_duration(path: str) -> float:
    return float(subprocess.check_output(
        ["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", path],
        text=True, **_popen_hidden_kwargs()
    ).strip())


def _patch_ffmpeg_path():
    import sys, os
    base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(__file__))
    ffdir = os.path.join(base, "ffmpeg")
    if os.path.isdir(ffdir):
        os.environ["PATH"] = ffdir + os.pathsep + os.environ.get("PATH", "")
_patch_ffmpeg_path()


def run_ffmpeg_progress(cmd: List[str], total: float, desc: str, on_progress=None) -> str:
    """Run ffmpeg command and display a simple progress bar.
    If on_progress is provided, it will be called with a float in [0,1].
    """
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, bufsize=1, **_popen_hidden_kwargs())


    err_lines: List[str] = []

    def _stderr_reader():
        for line in proc.stderr:
            err_lines.append(line)

    threading.Thread(target=_stderr_reader, daemon=True).start()

    # console may be None in a windowed app
    err_stream = sys.stderr if getattr(sys, "stderr", None) else None

    bar_len = 40
    if err_stream:
        print(f"{desc}:", file=err_stream)

    def _parse_hms(s: str):
        s = s.strip()
        if s == "N/A":
            return None
        hh, mm, ss = s.split(":")
        return int(hh) * 3600 + int(mm) * 60 + float(ss)

    while True:
        line = proc.stdout.readline()
        if line == "" and proc.poll() is not None:
            break

        out_time = None
        if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
            val = line.split("=", 1)[1].strip()
            if val != "N/A":
                out_time = float(val) / 1_000_000.0
        elif line.startswith("out_time="):
            sec = _parse_hms(line.split("=", 1)[1])
            if sec is not None:
                out_time = sec

        if out_time is None:
            continue

        frac = 0.0
        if total and total > 0:
            frac = min(max(out_time / total, 0.0), 1.0)

        # console progress (only if a console exists)
        if err_stream:
            filled = int(bar_len * frac)
            bar = "#" * filled + "-" * (bar_len - filled)
            err_stream.write(f"\r[{bar}] {frac*100:5.1f}%")
            err_stream.flush()

        # GUI callback
        if on_progress:
            try:
                on_progress(frac)
            except Exception:
                pass

    if err_stream:
        err_stream.write("\n")
        err_stream.flush()

    proc.wait()
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)
    return "".join(err_lines)


# ---------------- Argument Parsing ----------------
def parse_args():
    p = argparse.ArgumentParser(description="Cut low-volume pauses from video (lossless).")
    p.add_argument("input", help="Input video file")
    p.add_argument("--noise", default="-20dB", help="Silence threshold, e.g. -35dB / -40dB")
    p.add_argument("--silence", type=float, default=0.5, help="Min silence duration (sec)")  # ← default
    p.add_argument("--pad", type=float, default=0.15, help="Pad before/after speech (sec)")  # ← default
    p.add_argument("--keep", type=float, default=0.25, help="Drop kept clips shorter than this (sec)")  # ← default
    p.add_argument("--outdir", default="out", help="Output directory")
    p.add_argument("--hist", action="store_true", help="Generate histogram of RMS levels")
    p.add_argument(
    "--bins", "--bin", dest="bins",
    type=float,            # was: int
    default=1.0,           # any default you like
    help="Histogram bin width in dB (e.g., 0.5, 1, 2)"
)
    p.add_argument("--min_db", type=int, default=-60, help="Minimum dB for histogram")        # ← default
    p.add_argument("--max_db", type=int, default=0, help="Maximum dB for histogram")          # ← default
    return p.parse_args()

# ---------------- Filename Builder ----------------
def build_output_name(input_path, args):
    base = os.path.splitext(os.path.basename(input_path))[0]

    # format parameters cleanly for filename
    noise_val = str(args.noise).lower()
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


def detect_silences(input_path: str, noise: str, min_silence: float,
                    dur: float) -> Tuple[List[float], List[float], str]:
    noise_norm = _noise_for_ffmpeg(noise)
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-progress", "pipe:1", "-y",
        "-i", input_path,
        "-af", f"silencedetect=noise={noise_norm}:d={min_silence}",
        "-f", "null", "-"
    ]
    txt = run_ffmpeg_progress(cmd, dur, "detect")
    starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
    ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)",   txt)]
    print(f"[silence] noise={noise_norm} silence={min_silence} \u2192 {len(starts)} starts, {len(ends)} ends")
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
def cut_and_concat(input_path: str, segments: List[Tuple[float, float]],
                   output_path: str, progress=None):
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

    total_len = sum(et - st for st, et in clips)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cmd = [

        "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",

        "-i", input_path,
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        output_path,
    ]

    if progress:
        progress(0.0)
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, bufsize=1) as proc:
            for line in proc.stdout:
                if line.startswith("out_time_ms="):
                    out_ms = int(line.strip().split("=", 1)[1])
                    progress(min(out_ms / (total_len * 1_000_000), 1.0))
            rc = proc.wait()
    else:
        rc = subprocess.run(cmd).returncode
    if rc != 0:
        sys.exit(rc)

    total = sum(et - st for st, et in clips)
    try:
        run_ffmpeg_progress(cmd, total, "render")
    except subprocess.CalledProcessError as e:
        sys.exit(e.returncode)


def trim_video(input_path: str, noise: str, silence: float, pad: float,
               keep: float, output_path: str, progress=None) -> str:
    """Trim a video using provided parameters and write ``output_path``.

    ``progress`` receives a float between 0 and 1 representing
    concatenation progress.
    """
    dur = ffprobe_duration(input_path)
    starts, ends, _ = detect_silences(input_path, noise, silence, dur)
    segments = build_speaking_segments(starts, ends, dur, pad, keep)
    if not segments:
        raise RuntimeError("No keepable segments; nothing to output.")
    cut_and_concat(input_path, segments, output_path, progress)
    return output_path


# ---------------- Histogram ----------------

def _lavfi_escape_path(p: str) -> str:
    # Escape characters that break filter args: \ : , '
    return "'" + p.replace("\\", "\\\\").replace(":", "\\:").replace(",", "\\,").replace("'", r"\'") + "'"


def analyze_levels(input_path: str, dur: float) -> List[float]:
    """
    Return one RMS dBFS per decoded audio frame (channels averaged).
    Uses ffprobe over a lavfi graph for reliable per-frame tags.
    Falls back to overall RMS if per-frame tags aren't available.
    """
    # --- Preferred: ffprobe + lavfi(amovie -> astats) ---
    try:
        abs_path = os.path.abspath(input_path)
        esc = _lavfi_escape_path(abs_path)
        graph = f"amovie={esc},astats=metadata=1:reset=1"
        cmd = [
            "ffprobe", "-hide_banner", "-v", "error",
            "-f", "lavfi", "-i", graph,
            "-show_frames", "-of", "json"
        ]
        out = subprocess.check_output(cmd, text=True, **_popen_hidden_kwargs())
        data = json.loads(out)

        per_frame_vals: List[float] = []
        for fr in data.get("frames", []):
            tags = fr.get("tags", {})
            # Collect all channel RMS tags in this frame
            ch_vals = []
            for k, v in tags.items():
                # Keys look like "lavfi.astats.0.RMS_level", "...1.RMS_level", etc.
                if k.endswith(".RMS_level"):
                    try:
                        ch_vals.append(float(v))
                    except ValueError:
                        pass
            if ch_vals:
                # Average channels to a single RMS dBFS per frame
                per_frame_vals.append(sum(ch_vals) / len(ch_vals))

        if per_frame_vals:
            return per_frame_vals
    except Exception:
        pass  # fall back below

    # --- Fallback: ffmpeg stderr overall RMS (last resort, avoids crash) ---
    def run_fg(fg: str) -> str:
        cmd = [
            "ffmpeg", "-hide_banner", "-nostats", "-progress", "pipe:1", "-y",
            "-i", input_path, "-map", "0:a:0?", "-vn", "-sn", "-dn",
            "-af", fg, "-f", "null", "-"
        ]
        return run_ffmpeg_progress(cmd, dur, "levels")

    txt = run_fg("astats=metadata=1:reset=1")
    m = re.findall(r"Overall(?:\.RMS_level| RMS level dB)(?:=|:)\s*([-+]?\d+(?:\.\d+)?)", txt)
    if m:
        ov = float(m[0])
        return [ov] * 50  # synthetic tiny distribution so plotting still works

    return []

def plot_histogram(vals, binsize, min_db, max_db, outpath):


    vals = [v for v in vals if math.isfinite(v)]
    if not vals:
        print("[hist] No audio levels found, skipping histogram.")
        return

    # round to 0.1 dB, then bin to requested width
    tenth = [round(v, 1) for v in vals]
    b = float(binsize)
    lo, hi = float(min_db), float(max_db)

    def bin_start(x):  # align to grid starting at lo
        return round(lo + math.floor((x - lo) / b) * b, 1)

    from collections import Counter
    bin_counts = Counter()
    for x in tenth:
        if lo <= x <= hi:
            bin_counts[bin_start(x)] += 1

    # build edges and percent values
    edges = []
    e = lo
    while e <= hi + 1e-9:
        edges.append(round(e, 1))
        e += b
    counts = [bin_counts.get(s, 0) for s in edges[:-1]]
    total = sum(counts) if sum(counts) > 0 else 1
    percent = [c / total * 100.0 for c in counts]

    # --- pretty plot ---
    plt.figure(figsize=(11, 4))  # landscape
    try:
        # connected bins, filled area (Matplotlib >= 3.4)
        plt.stairs(percent, edges, fill=True, linewidth=0.8)
    except Exception:
        # fallback: full-width bars so they touch
        plt.bar(edges[:-1], percent, width=b, align="edge", linewidth=0.4)

    # grid behind data
    ax = plt.gca()
    ax.grid(True, axis="y", linestyle="--", linewidth=0.6, alpha=0.5)
    ax.grid(True, axis="x", linestyle=":", linewidth=0.4, alpha=0.35)
    ax.set_axisbelow(True)  # ensure grid is behind

    # cleaner frame & ticks
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.yaxis.set_major_formatter(PercentFormatter())
    # x ticks ~1 dB apart for readability
    ax.set_xticks(np.arange(math.ceil(lo), math.floor(hi)+1, 1.0))
    plt.xticks(rotation=90)

    plt.xlabel(f"RMS Level (dBFS) — bin width {b:.1f} dB")
    plt.ylabel("Percent of frames")
    plt.title("Audio Loudness Distribution (RMS, per-frame)")
    plt.tight_layout()
    plt.savefig(outpath)
    plt.close()
    print(f"[hist] Histogram saved to {outpath}")

def print_histogram_table(vals: List[float], min_db: int, max_db: int, top_n: int = 30):
    rounded = [round(v, 1) for v in vals if math.isfinite(v)]
    if not rounded:
        print("[hist] No finite audio levels found.")
        return
    counts = Counter(rounded)
    total = sum(counts.values())
    rows = sorted(((lvl, cnt, 100.0 * cnt / total) for lvl, cnt in counts.items()
                   if min_db <= lvl <= max_db),
                  key=lambda r: (-r[1], r[0]))
    print("Top levels (dBFS to 0.1) — count & percent:")
    for lvl, cnt, pct in rows[:top_n]:
        print(f"{lvl:>6.1f} dB  {cnt:>7d}  {pct:6.2f}%")

# ---------------- Main ----------------
def main():
    a = parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    dur = ffprobe_duration(a.input)
    out_final = os.path.join(a.outdir, build_output_name(a.input, a))

    if a.hist:
        vals = analyze_levels(a.input, dur)

        plot_histogram(
            vals,
            a.bins,
            a.min_db,
            a.max_db,
            os.path.join(
                a.outdir,
                os.path.splitext(os.path.basename(out_final))[0] + "_hist.png",
            ),
        )


    try:
        trim_video(a.input, a.noise, a.silence, a.pad, a.keep, out_final)
    except RuntimeError as e:
        print(e)

    starts, ends, _ = detect_silences(a.input, a.noise, a.silence, dur)
    segments = build_speaking_segments(starts, ends, dur, a.pad, a.keep)

    if not segments:
        print("No keepable segments; nothing to output.")

        sys.exit(0)
    print(f"✔ Wrote {out_final}")

if __name__ == "__main__":
    main()
