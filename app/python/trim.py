# python/trim.py
import argparse, os, re, subprocess, sys, threading, time, math
from typing import List, Tuple
from collections import Counter

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

# ---- Globals -----------------------------------------------------------------

CANCEL = threading.Event()

# Matches "time=HH:MM:SS.xx" seen on stderr when -progress isn't present
STDERR_TIME_RE = re.compile(r'time=(\d{2}):(\d{2}):(\d{2})[.,](\d{2})')

# ---- Small utilities ---------------------------------------------------------

def _positive_float(x: str) -> float:
    f = float(x)
    if not math.isfinite(f) or f <= 0.0:
        raise argparse.ArgumentTypeError("--bins must be a positive, finite number")
    return f

def _popen_hidden_kwargs():
    if os.name == "nt" and (getattr(sys, "frozen", False) or getattr(sys, "stderr", None) is None):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        CREATE_NO_WINDOW = 0x08000000
        return {"startupinfo": si, "creationflags": CREATE_NO_WINDOW}
    return {}

def _patch_ffmpeg_path():
    base = getattr(sys, "_MEIPASS",
                   os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
                   else os.path.dirname(__file__))
    ffdir = os.path.join(base, "ffmpeg")
    if os.path.isdir(ffdir):
        os.environ["PATH"] = ffdir + os.pathsep + os.environ.get("PATH", "")
_patch_ffmpeg_path()

def ffprobe_duration(path: str) -> float:
    return float(subprocess.check_output(
        ["ffprobe","-v","error","-show_entries","format=duration",
         "-of","default=noprint_wrappers=1:nokey=1", path],
        text=True, **_popen_hidden_kwargs()
    ).strip())

def _hms_cs_to_seconds(h, m, s, cs) -> float:
    return int(h)*3600 + int(m)*60 + int(s) + int(cs)/100.0

# ---- FFmpeg execution with progress ------------------------------------------

def _parse_progress_time(val: str):
    """Accept out_time_ms/us or out_time=HH:MM:SS.sss."""
    v = val.strip()
    if v == "N/A":
        return None
    # out_time_ms / out_time_us: integer microseconds
    try:
        # if pure number treat as microseconds
        if v.isdigit():
            return float(v) / 1_000_000.0
    except Exception:
        pass
    # out_time=HH:MM:SS.sss
    try:
        hh, mm, ss = v.split(":")
        return int(hh) * 3600 + int(mm) * 60 + float(ss)
    except Exception:
        return None

def run_ffmpeg_progress(cmd: List[str], total: float, desc: str,
                        on_progress=None, on_rms=None) -> Tuple[int, str]:
    """
    Run ffmpeg with -progress pipe:1 and stream progress from stdout.
    Drain stderr on a background thread and collect it (used for silencedetect).
    Returns (returncode, collected_stderr).
    """
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, **_popen_hidden_kwargs()
    )

    stderr_buf = []
    last_progress_time = time.time()

    # optional RMS extraction from stderr (used by analyze_levels)
    rms_pat = re.compile(r"lavfi\.astats\.(?:\d+|Overall)\.RMS_level(?:=|:\s*)([-+]?\d+(?:\.\d+)?)") \
              if on_rms else None

    def _stderr_reader():
        for line in proc.stderr:
            stderr_buf.append(line)
            if on_rms and rms_pat:
                m = rms_pat.search(line)
                if m:
                    try:
                        on_rms(float(m.group(1)))
                    except Exception:
                        pass

    t = threading.Thread(target=_stderr_reader, daemon=True)
    t.start()

    try:
        if on_progress:
            try: on_progress(0.0)
            except Exception: pass

        while True:
            if CANCEL.is_set():
                try: proc.terminate()
                except Exception: pass
                raise RuntimeError("CANCELLED")

            line = proc.stdout.readline()
            if line == "" and proc.poll() is not None:
                break

            if not line:
                # keep UI alive if stdout stalls
                if on_progress and (time.time() - last_progress_time) > 2.0 and total > 0:
                    try: on_progress(0.001)
                    except Exception: pass
                time.sleep(0.05)
                continue

            line = line.strip()
            if not line or "=" not in line:
                continue

            key, val = line.split("=", 1)
            if key in ("out_time_ms", "out_time_us", "out_time"):
                tval = _parse_progress_time(val)
                if tval is not None and total > 0 and on_progress:
                    frac = max(0.0, min(1.0, tval / total))
                    try: on_progress(frac)
                    except Exception: pass
                    last_progress_time = time.time()

            # stderr sometimes mirrors time=HH:MM:SS.xx; fallback parse if needed
            if key == "progress" and val == "end" and on_progress:
                try: on_progress(1.0)
                except Exception: pass

    finally:
        try: proc.wait()
        except Exception: pass
        try: t.join(timeout=0.3)
        except Exception: pass

    return proc.returncode or 0, "".join(stderr_buf)

# ---- CLI args / filenames -----------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Cut low-volume pauses from video (single re-encode).")
    p.add_argument("input", help="Input video file")
    p.add_argument("--noise", default="-20dB", help="Silence threshold, e.g. -35dB / -40dB")
    p.add_argument("--silence", type=float, default=0.5, help="Min silence duration (sec)")
    p.add_argument("--pad", type=float, default=0.15, help="Pad before/after speech (sec)")
    p.add_argument("--keep", type=float, default=0.25, help="Drop kept clips shorter than this (sec)")
    p.add_argument("--outdir", default="out", help="Output directory")
    p.add_argument("--hist", action="store_true", help="Generate histogram of RMS levels")
    p.add_argument("--bins", "--bin", dest="bins", type=_positive_float, default=1.0,
                   help="Histogram bin width in dB (e.g., 0.5, 1, 2)")
    p.add_argument("--min_db", type=int, default=-60, help="Minimum dB for histogram")
    p.add_argument("--max_db", type=int, default=0, help="Maximum dB for histogram")
    return p.parse_args()

def build_output_name(input_path, args):
    base = os.path.splitext(os.path.basename(input_path))[0]
    noise_val = str(args.noise).lower()
    return f"{base}_{noise_val}.mp4"

# ---- Silence detection / segments --------------------------------------------

def _noise_for_ffmpeg(noise: str) -> str:
    s = str(noise).strip()
    if not s.lower().endswith("db"):
        s += "dB"
    if re.fullmatch(r"\d+(?:\.\d+)?dB", s, re.I):
        s = "-" + s
    return s

def detect_silences(input_path: str, noise: str, min_silence: float,
                    dur: float) -> Tuple[List[float], List[float], str]:
    noise_norm = _noise_for_ffmpeg(noise)
    cmd = [
        "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",
        "-i", input_path,
        "-af", f"silencedetect=noise={noise_norm}:d={min_silence}",
        "-f","null","-"
    ]
    rc, txt = run_ffmpeg_progress(cmd, dur, "detect")
    starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
    ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)",   txt)]
    return starts, ends, txt

def build_speaking_segments(starts: List[float], ends: List[float], dur: float,
                            pad: float, keep: float) -> List[Tuple[float, float]]:
    if not starts and not ends:
        return [(0.0, dur)]
    if not starts or (ends and ends[0] < starts[0]):
        starts = [0.0] + starts
    if len(ends) < len(starts):
        ends = ends + [dur]

    speaking = []
    t = 0.0
    for s, e in zip(starts, ends):
        gap = s - t
        if gap > 0.01:
            a = max(0.0, t - pad)
            b = min(dur, s + pad)
            if speaking and a < speaking[-1][1]:
                speaking[-1] = (speaking[-1][0], max(speaking[-1][1], b))
            else:
                speaking.append((a, b))
        t = e

    # final tail
    gap = dur - t
    if gap > 0.01:
        a = max(0.0, t - pad)
        if speaking and a < speaking[-1][1]:
            speaking[-1] = (speaking[-1][0], dur)
        else:
            speaking.append((a, dur))

    # merge overlaps and filter by keep
    merged: List[Tuple[float, float]] = []
    for s, e in sorted(speaking):
        if not merged or s > merged[-1][1]:
            merged.append((s, e))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
    return [(s, e) for s, e in merged if (e - s) >= keep]

# ---- Cutting & concatenation (single encode) ---------------------------------

def cut_and_concat(input_path: str, segments: List[Tuple[float, float]],
                   output_path: str, progress=None):
    def _coalesce(segs, eps=0.03):
        if not segs: return []
        out = []
        for s, e in sorted(segs):
            if not out or s > out[-1][1] + eps:
                out.append([s, e])
            else:
                out[-1][1] = max(out[-1][1], e)
        return [(round(s, 3), round(e, 3)) for s, e in out]

    clips = [(max(0.0, s), max(0.0, e - 0.010)) for s, e in _coalesce(segments) if (e - s) > 0.010]
    if not clips:
        print("No valid segments to cut.")
        sys.exit(0)

    vf, af = [], []
    for i, (st, et) in enumerate(clips):
        vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
        af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
    cat = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
    filter_complex = ";".join(vf + af + [f"{cat}concat=n={len(clips)}:v=1:a=1[v][a]"])

    total_len = sum(et - st for st, et in clips)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    cmd = [
        "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",
        "-i", input_path,
        "-filter_complex", filter_complex,
        "-map","[v]","-map","[a]",
        "-c:v","libx264","-preset","veryfast","-crf","20",
        "-c:a","aac","-b:a","160k",
        "-movflags","+faststart",
        output_path
    ]

    rc, _ = run_ffmpeg_progress(cmd, total_len, "render", on_progress=progress)
    if rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)

def trim_video(input_path: str, noise: str, silence: float, pad: float,
               keep: float, output_path: str, progress=None) -> str:
    dur = ffprobe_duration(input_path)
    starts, ends, _ = detect_silences(input_path, noise, silence, dur)
    segments = build_speaking_segments(starts, ends, dur, pad, keep)
    if not segments:
        raise RuntimeError("No keepable segments; nothing to output.")
    cut_and_concat(input_path, segments, output_path, progress)
    return output_path

# ---- Histogram ---------------------------------------------------------------

def analyze_levels(input_path: str, dur: float, on_progress=None) -> List[float]:
    """Collect per-frame RMS dBFS while streaming progress."""
    vals: List[float] = []

    cmd = [
        "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",
        "-i", input_path,
        "-map","0:a?","-vn","-sn","-dn",
        "-af","pan=mono|c0=0.5*c0+0.5*c1,astats=metadata=1:reset=1,ametadata=print:mode=print",
        "-f","null","-"
    ]

    def _on_rms(v: float):
        if math.isfinite(v):
            vals.append(v)

    rc, _ = run_ffmpeg_progress(cmd, dur, "levels", on_progress=on_progress, on_rms=_on_rms)
    if rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)
    return vals

def plot_histogram(vals: List[float], binsize: float, min_db: float, max_db: float, outpath: str):
    vals = [v for v in vals if math.isfinite(v)]
    if not vals:
        print("[hist] No audio levels found, skipping histogram.")
        return

    tenth = [round(v, 1) for v in vals]
    b = float(binsize)
    lo, hi = float(min_db), float(max_db)

    def bin_start(x):
        return round(lo + math.floor((x - lo) / b) * b, 1)

    bin_counts = Counter()
    for x in tenth:
        if lo <= x <= hi:
            bin_counts[bin_start(x)] += 1

    edges = []
    e = lo
    while e <= hi + 1e-9:
        edges.append(round(e, 1))
        e += b

    counts = [bin_counts.get(s, 0) for s in edges[:-1]]
    total = sum(counts) or 1
    percent = [c / total * 100.0 for c in counts]

    plt.figure(figsize=(11, 4))
    try:
        plt.stairs(percent, edges, fill=True, linewidth=0.8)
    except Exception:
        plt.bar(edges[:-1], percent, width=b, align="edge", linewidth=0.4)

    ax = plt.gca()
    ax.grid(True, axis="y", linestyle="--", linewidth=0.6, alpha=0.5)
    ax.grid(True, axis="x", linestyle=":",  linewidth=0.4, alpha=0.35)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.yaxis.set_major_formatter(PercentFormatter())
    ax.set_xticks(np.arange(math.ceil(lo), math.floor(hi)+1, 1.0))
    plt.xticks(rotation=90)

    plt.xlabel(f"RMS Level (dBFS) — bin width {b:.1f} dB")
    plt.ylabel("Percent of frames")
    plt.title("Audio Loudness Distribution (RMS, per-frame)")
    plt.tight_layout(pad=0.8)
    plt.savefig(outpath)
    plt.close()
    print(f"[hist] Histogram saved to {outpath}")

# ---- CLI ---------------------------------------------------------------------

def main():
    a = parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    dur = ffprobe_duration(a.input)
    out_final = os.path.join(a.outdir, build_output_name(a.input, a))

    if a.hist:
        vals = analyze_levels(a.input, dur)
        plot_histogram(
            vals, a.bins, a.min_db, a.max_db,
            os.path.join(a.outdir, os.path.splitext(os.path.basename(out_final))[0] + "_hist.png"),
        )

    try:
        trim_video(a.input, a.noise, a.silence, a.pad, a.keep, out_final)
    except RuntimeError as e:
        print(e)

    # Extra: quick summary in CLI usage
    starts, ends, _ = detect_silences(a.input, a.noise, a.silence, dur)
    segments = build_speaking_segments(starts, ends, dur, a.pad, a.keep)
    if not segments:
        print("No keepable segments; nothing to output.")
        sys.exit(0)

    print(f"✔ Wrote {out_final}")

if __name__ == "__main__":
    main()
