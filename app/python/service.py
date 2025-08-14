#python/service.py

import sys, json, os, tempfile, traceback
import trim
import threading, time, uuid, re

JOBS = {}  # job_id -> {"cancel": threading.Event(), "thread": Thread}

def _event(payload:dict):
    # newline-delimited JSON event for the renderer
    payload.setdefault('ts', time.time())
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def _reply(payload:dict):
    # newline-delimited JSON reply for main.js queue (no "event" key)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def _new_job_id():
    return uuid.uuid4().hex[:8]

def send(evt, **data):
    sys.stdout.write(json.dumps({"event": evt, **data}) + "\n")
    sys.stdout.flush()

def cmd_analyze(payload):
    import collections, math
    path   = payload["path"]

    # --- sanitize inputs ---
    try:
        min_db = float(payload.get("min_db", -60))
    except Exception:
        min_db = -60.0
    try:
        max_db = float(payload.get("max_db", 0))
    except Exception:
        max_db = 0.0
    if not math.isfinite(min_db): min_db = -60.0
    if not math.isfinite(max_db): max_db = 0.0
    if max_db <= min_db:
        max_db = min_db + 60.0  # ensure a valid span

    try:
        bins = float(payload.get("bins", 1.0))
    except Exception:
        bins = 1.0
    if not math.isfinite(bins) or bins <= 0.0:
        bins = 1.0  # avoid ZeroDivisionError

    send("progress", stage="analyze", value=0.01)
    dur = trim.ffprobe_duration(path)

    vals = trim.analyze_levels(
        path, dur,
        on_progress=lambda fr: send("progress", stage="analyze",
                                    value=min(0.95, max(0.0, fr))))
    vals = [v for v in vals if math.isfinite(v)]
    if not vals:
        send("progress", stage="analyze", value=1.0)
        return {"ok": False, "error": "no audio levels parsed"}

    # --- binning consistent with trim.py ---
    tenth = [round(v, 1) for v in vals]

    def bin_start(x):
        # floor to the left edge aligned to min_db, step=bins
        return round(min_db + math.floor((x - min_db) / bins) * bins, 1)

    counts = collections.Counter()
    for x in tenth:
        if min_db <= x <= max_db:
            counts[bin_start(x)] += 1

    # build edges
    edges = []
    e = min_db
    # guard loop even if bins is tiny
    max_steps = 10000
    steps = 0
    while e <= max_db + 1e-9 and steps < max_steps:
        edges.append(round(e, 1))
        e += bins
        steps += 1
    if len(edges) < 2:
        edges = [min_db, max_db]  # minimal 1 bin

    total = sum(counts.values())
    if total <= 0:
        # nothing fell inside range → return flat zeros
        ys = [0.0] * (len(edges) - 1)
        send("progress", stage="analyze", value=1.0)
        return {"ok": True, "x": edges[:-1], "y": ys}

    ys = [(counts.get(s, 0) / total) * 100.0 for s in edges[:-1]]

    send("progress", stage="analyze", value=1.0)
    return {"ok": True, "x": edges[:-1], "y": ys}



def cmd_trim(payload):
    path    = payload["path"]
    noise   = float(payload.get("noise_db", -23))
    silence = float(payload.get("silence", 0.5))
    pad     = float(payload.get("pad", 0.15))
    keep    = float(payload.get("keep", 0.75))

    out = os.path.join(os.path.expanduser("~"), "Downloads",
                       f"{os.path.splitext(os.path.basename(path))[0]}_trimmed.mp4")

    job_id    = _new_job_id()
    cancel_ev = threading.Event()

    def worker():
        try:
            # point trim’s global CANCEL at this job’s event
            trim.CANCEL = cancel_ev

            dur = trim.ffprobe_duration(path)
            def on_detect(fr): send("progress", stage="detect", value=fr)

            # detect silences
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
                send("job", id=job_id, status="error", error="No keepable segments.")
                return

            # concat filter
            eps = 0.010
            clips = [(max(0.0, s), max(0.0, e - eps)) for s, e in segs if e - s > eps]
            vf, af = [], []
            for i, (st, et) in enumerate(clips):
                vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
                af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
            concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
            fc = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])
            total = sum(et - st for st, et in clips)

            def on_render(fr): send("progress", stage="render", value=fr)

            trim.run_ffmpeg_progress(
                ["ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y","-i", path,
                 "-filter_complex", fc, "-map","[v]","-map","[a]",
                 "-c:v","libx264","-preset","veryfast","-crf","20",
                 "-c:a","aac","-b:a","160k","-movflags","+faststart", out],
                total, "render", on_progress=on_render
            )

            send("job", id=job_id, status="finished", ok=True, output=out)

        except RuntimeError as e:
            if "CANCELLED" in str(e):
                send("job", id=job_id, status="cancelled")
            else:
                send("job", id=job_id, status="error", error=str(e))
        except Exception as e:
            send("job", id=job_id, status="error", error=str(e))
        finally:
            JOBS.pop(job_id, None)
            try: cancel_ev.clear()
            except: pass

    t = threading.Thread(target=worker, daemon=True)
    JOBS[job_id] = {"cancel": cancel_ev, "thread": t}
    t.start()

    send("job", id=job_id, status="started", kind="trim")
    return {"ok": True, "job": job_id}

def cmd_cancel(payload):
    job = payload.get("job")
    j = JOBS.get(job)
    if not j:
        return {"ok": False, "error": "Unknown job"}
    j["cancel"].set()
    return {"ok": True, "job": job}

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
            elif cmd == "cancel":
                res = cmd_cancel(req)
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
