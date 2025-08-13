import sys, json, os, tempfile, traceback
import trim

def send(evt, **data):
    sys.stdout.write(json.dumps({"event": evt, **data}) + "\n")
    sys.stdout.flush()

def cmd_analyze(payload):
    path   = payload["path"]
    min_db = int(payload.get("min_db", -50))
    max_db = int(payload.get("max_db", 0))
    bins   = float(payload.get("bins", 0.5))

    dur = trim.ffprobe_duration(path)
    vals = trim.analyze_levels(path, dur)
    if not vals:
        return {"ok": False, "error": "No audio levels parsed."}

    # Build histogram as 0.1dB density → line chart points
    import math, collections
    tenth = [round(v,1) for v in vals if math.isfinite(v)]
    counts = collections.Counter([x for x in tenth if min_db <= x <= max_db])
    xs = [x/10 for x in range(int(min_db*10), int(max_db*10)+1, 1)]  # 0.1 steps
    ys = []
    total = sum(counts.values()) or 1
    for x in xs:
        ys.append(100.0 * counts.get(round(x,1), 0) / total)
    return {"ok": True, "x": xs, "y": ys}

def cmd_trim(payload):
    path    = payload["path"]
    noise   = float(payload.get("noise_db", -23))
    silence = float(payload.get("silence", 0.5))
    pad     = float(payload.get("pad", 0.15))
    keep    = float(payload.get("keep", 0.75))

    out = os.path.join(os.path.expanduser("~"), "Downloads",
                       f"{os.path.splitext(os.path.basename(path))[0]}_trimmed.mp4")

    dur = trim.ffprobe_duration(path)
    def on_detect(fr):
        send("progress", stage="detect", value=fr)
    # run detect (same pipeline as GUI)
    import re, subprocess
    txt = trim.run_ffmpeg_progress(
        ["ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y","-i", path,
         "-af", f"silencedetect=noise={trim._noise_for_ffmpeg(f'{noise}dB')}:d={silence}",
         "-f","null","-"],
        dur, "detect", on_progress=on_detect
    )
    starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
    ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)",   txt)]
    segs = trim.build_speaking_segments(starts, ends, dur, pad, keep)
    if not segs:
        return {"ok": False, "error": "No keepable segments."}

    # render
    eps = 0.010
    clips = [(max(0.0, s), max(0.0, e - eps)) for s, e in segs if e - s > eps]
    vf, af = [], []
    for i, (st, et) in enumerate(clips):
        vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
        af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
    concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
    fc = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])
    total = sum(et - st for st, et in clips)

    def on_render(fr):
        send("progress", stage="render", value=fr)

    trim.run_ffmpeg_progress(
        ["ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y","-i", path,
         "-filter_complex", fc, "-map","[v]","-map","[a]",
         "-c:v","libx264","-preset","veryfast","-crf","20",
         "-c:a","aac","-b:a","160k","-movflags","+faststart", out],
        total, "render", on_progress=on_render
    )
    return {"ok": True, "output": out}

def main():
    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "analyze":
                res = cmd_analyze(req)
            elif cmd == "trim":
                res = cmd_trim(req)
            elif cmd == "ping":
                res = {"ok": True, "pong": True}
            else:
                res = {"ok": False, "error": "Unknown cmd"}
        except Exception as e:
            traceback.print_exc()
            res = {"ok": False, "error": str(e)}
        sys.stdout.write(json.dumps(res) + "\n"); sys.stdout.flush()

if __name__ == "__main__":
    main()
