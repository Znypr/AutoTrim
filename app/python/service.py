# python/service.py

import sys, json, os, traceback, subprocess, base64, tempfile, signal, time, shutil, shlex, tempfile
import trim
import threading, uuid, re
import collections, math
from concurrent.futures import ThreadPoolExecutor
import concurrent.futures

MAX_WORKERS = max(1, os.cpu_count() // 2)
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
JOBS = {}

PARAM_CONFIG = {
    "noise_db": {"min": -50.0, "max": 0.0,   "step": 0.5, "default": -25.0},
    "silence":  {"min": 0.1,   "max": 1.0,   "step": 0.1, "default": 0.1},
    "pad":      {"min": 0.0,   "max": 1.0,   "step": 0.01,"default": 0.10},
    "keep":     {"min": 0.1,   "max": 1.0,   "step": 0.05, "default": 0.50},
}

CREATE_NO_WINDOW = 0x08000000 if os.name == 'nt' else 0

def cleanup_old_partials():
    """Deletes partial files older than 24 hours from the temp directory."""
    try:
        partial_dir = os.path.join(tempfile.gettempdir(), "autotrim_partials")
        if not os.path.isdir(partial_dir):
            return

        cutoff = time.time() - (24 * 60 * 60)

        for filename in os.listdir(partial_dir):
            if ".partial" in filename:
                file_path = os.path.join(partial_dir, filename)
                try:
                    if os.path.getmtime(file_path) < cutoff:
                        os.remove(file_path)
                except OSError:
                    pass
    except Exception:
        pass

def _is_nvenc_open_error(stderr_txt:str) -> bool:
    s = (stderr_txt or "").lower()
    return ("openencodesessionex failed" in s or
            "could not open encoder" in s or
            "error while opening encoder" in s or
            "h264_nvenc" in s and "invalid argument" in s)

def _has_nvenc():
    try:
        out = subprocess.check_output(["ffmpeg","-hide_banner","-encoders"], text=True, creationflags=CREATE_NO_WINDOW)
        return "h264_nvenc" in out
    except Exception:
        return False

def _gpu_decode_args():
    """Return ffmpeg args to enable GPU decoding when available."""
    try:
        out = subprocess.check_output([
            "ffmpeg", "-hide_banner", "-hwaccels"
        ], text=True, creationflags=CREATE_NO_WINDOW)
        if "cuda" in out:
            return ["-hwaccel", "cuda"]
    except Exception:
        pass
    return []

def _new_job_id():
    return uuid.uuid4().hex[:8]

def send(evt, **data):
    sys.stdout.write(json.dumps({"event": evt, **data}) + "\n")
    sys.stdout.flush()

def _detect_silences(path, dur, noise, silence, on_progress_callback):
    """
    Runs FFmpeg silencedetect using a simplified, direct analysis method to improve reliability.
    """
    detect_cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "info", "-progress", "pipe:1", "-nostdin",
        "-i", path,
        "-af", f"silencedetect=noise={noise}dB:d={silence}",
        "-vn",          # Ignore video stream
        "-f", "null", "-"
    ]
    rc, detect_txt = trim.run_ffmpeg_progress(detect_cmd, dur, "detect", on_progress=on_progress_callback)
    if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")

    if rc != 0 and "silence_start" not in detect_txt:
        if "Stream specifier" in detect_txt and "does not match any streams" in detect_txt:
             raise RuntimeError("The input file does not contain an audio stream.")
        raise RuntimeError({"cmd": detect_cmd, "stderr": detect_txt})

    starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+\.?\d*)", detect_txt)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*(\d+\.?\d*)", detect_txt)]
    if not starts and not ends:
        starts, ends = [], [dur]
    
    return starts, ends

def _render_trimmed_video(path, tmp_out, clips, total_dur, use_nvenc, has_audio, hwaccel_args, on_progress_callback):
    """
    Single-pass render using trim/atrim + concat to avoid per-clip AAC priming and PTS drift.
    """
    vcodec_nv = ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"]
    vcodec_sw = ["-c:v", "libx264",   "-preset", "veryfast", "-crf", "23"]
    acodec    = (["-c:a", "aac", "-b:a", "160k"] if has_audio else [])

    # Build filtergraph:
    # Normalize starting PTS for both streams, then create per-clip trims, then concat.
    parts = []
    parts.append("[0:v]setpts=PTS-STARTPTS[v_in]")
    if has_audio:
        parts.append("[0:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a_in]")

    for i, (st, et) in enumerate(clips):
        parts.append(f"[v_in]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            parts.append(f"[a_in]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")

    if has_audio:
        concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
        parts.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[vout][aout]")
    else:
        concat_inputs = "".join(f"[v{i}]" for i in range(len(clips)))
        parts.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[vout]")

    filter_complex = ";".join(parts)

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-y",
           *hwaccel_args, "-i", path,
           "-filter_complex", filter_complex,
           "-map", "[vout]"]
    if has_audio:
        cmd += ["-map", "[aout]"]

    if use_nvenc:
        cmd += vcodec_nv
    else:
        cmd += vcodec_sw
    cmd += acodec
    cmd += ["-movflags", "+faststart", tmp_out]

    rc, err = trim.run_ffmpeg_progress(cmd, total_dur, "render", on_progress_callback)
    if rc != 0:
        raise RuntimeError(f"Failed: {' '.join(cmd)}\n{err}")

def _run_trim_job(payload, job_id, cancel_ev):
    """Orchestrates the trimming process by calling helper functions."""
    def ffprobe_has_stream(path:str, kind:str) -> bool:
        try:
            # accept any stream of the kind, not only index 0
            sel = "a" if kind == "a" else "v"
            out = subprocess.check_output(
                ["ffprobe","-v","error","-select_streams", sel,
                "-show_entries","stream=index","-of","csv=p=0", path],
                text=True, creationflags=CREATE_NO_WINDOW
            ).strip()
            return bool(out)
        except Exception:
            return False


    def send_ffmpeg_error(where:str, cmd:list[str], stderr_txt:str):
        head = "\n".join((stderr_txt or "").splitlines()[:30])
        cmd_str = ' '.join(shlex.quote(a) for a in cmd)
        sys.stderr.write(f"[svc] ffmpeg {where} failed\n[svc] CMD: {cmd_str}\n[svc] STDERR:\n{head}\n")
        sys.stderr.flush()
        send("job",id=job_id,status="error",error=f"{where} failed. See logs.\n{head}",kind="trim",source_path=payload.get("path"))

    try:
        # 1. Setup
        trim.CANCEL = cancel_ev
        path, out = payload.get("path"), payload.get("out")
        noise, silence = float(payload.get("noise_db")), float(payload.get("silence"))
        pad, keep = float(payload.get("pad")), float(payload.get("keep"))

        # 2. Determine unique output path
        if os.path.exists(out):
            directory, filename = os.path.split(out)
            base_name, extension = os.path.splitext(filename)
            counter = 2
            while os.path.exists(out):
                out = os.path.join(directory, f"{base_name}-{counter}{extension}")
                counter += 1

        partial_dir = os.path.join(tempfile.gettempdir(), "autotrim_partials")
        os.makedirs(partial_dir, exist_ok=True)
        tmp_out = os.path.join(partial_dir, f"{job_id}.partial{os.path.splitext(out)[1]}")
        dur = trim.ffprobe_duration(path)

        # 3. Stage 1: Detect Silences (on CPU)
        def on_detect(fr): send("progress", stage="detect", value=fr, hint_total=dur, job_id=job_id, source_path=path, kind="trim")
        send("progress", stage="detect", value=0.01, hint_total=dur, job_id=job_id, source_path=path, kind="trim")
        starts, ends = _detect_silences(path, dur, noise, silence, on_detect)
        
        # 4. Build Segments
        segs = trim.build_speaking_segments(starts, ends, dur, pad, keep)
        if not segs: raise RuntimeError("No keepable segments found.")
        clips = [(max(0.0, s), max(s + 0.01, e - 0.01)) for s, e in segs if (e - s) > 0.01]
        total_dur = max(0.001, sum(e - s for s, e in clips))

        # 5. Stage 2: Render Video (on CPU for reliability)
        def on_render(fr): send("progress", stage="render", value=fr, hint_total=total_dur, job_id=job_id, source_path=path, kind="trim")
        send("progress", stage="render", value=0.0, hint_total=total_dur, job_id=job_id, source_path=path, kind="trim")
        
        # -- MODIFICATION: Hardware acceleration is disabled to improve reliability --
        use_hw_accel = True
        _render_trimmed_video(path, tmp_out, clips, total_dur, 
                              use_nvenc=(use_hw_accel and _has_nvenc()), 
                              has_audio=ffprobe_has_stream(path, "a"), 
                              hwaccel_args=(_gpu_decode_args() if use_hw_accel and _has_nvenc() else []), 
                              on_progress_callback=on_render)
        
        # 6. Finalize
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        shutil.move(tmp_out, out)
        send("job", id=job_id, status="finished", ok=True, kind="trim", output=out, source_path=path)

    except Exception as e:
        error_str = str(e)
        if "CANCELLED" in error_str:
            send("job", id=job_id, status="cancelled", kind="trim", source_path=payload.get("path"))
        elif isinstance(e, RuntimeError) and isinstance(e.args[0], dict):
            ffmpeg_error = e.args[0]
            send_ffmpeg_error("operation", ffmpeg_error["cmd"], ffmpeg_error["stderr"])
        else:
            send("job", id=job_id, status="error", error=str(e), kind="trim", source_path=payload.get("path"))
            traceback.print_exc(file=sys.stderr)
    finally:
        JOBS.pop(job_id, None)

def cmd_analyze(payload):
    job_id = _new_job_id()
    cancel_ev = threading.Event()

    def worker():
        try:
            trim.CANCEL = cancel_ev
            path   = payload["path"]
            min_db = float(payload.get("min_db", -60))
            max_db = float(payload.get("max_db", 0))
            bins = float(payload.get("bins", 1.0))
            if not math.isfinite(bins) or bins <= 0:
                raise RuntimeError("Invalid bin width")

            dur = trim.ffprobe_duration(path)
            send("progress", stage="analyze", value=0.01, hint_total=dur, job_id=job_id)

            def on_analyze_progress(frac):
                send("progress", stage="analyze", value=min(0.99, max(0.0, frac)), hint_total=dur, job_id=job_id)

            vals = trim.analyze_levels(path, dur, on_progress=on_analyze_progress)
            vals = [v for v in vals if math.isfinite(v)]
            if not vals:
                raise RuntimeError("No audio levels parsed from video.")

            tenth = [round(v, 1) for v in vals]
            def bin_start(x):
                return round(min_db + math.floor((x - min_db) / bins) * bins, 1)

            counts = collections.Counter(bin_start(x) for x in tenth if min_db <= x <= max_db)
            edges = []
            e = min_db
            while e <= max_db + 1e-9:
                edges.append(round(e, 1))
                e += bins

            total = sum(counts.values()) or 1
            ys = [(counts.get(s, 0) / total) * 100.0 for s in edges[:-1]]
            send("analysis_result", ok=True, x=edges[:-1], y=ys, job_id=job_id)
            send("job", id=job_id, status="finished", ok=True, kind="analyze")
        except RuntimeError as e:
            if "CANCELLED" in str(e):
                send("job", id=job_id, status="cancelled", kind="analyze")
            else:
                send("job", id=job_id, status="error", error=str(e), kind="analyze")
        except Exception as e:
            send("job", id=job_id, status="error", error=str(e), kind="analyze")
            traceback.print_exc(file=sys.stderr)
        finally:
            JOBS.pop(job_id, None)

    t = threading.Thread(target=worker, daemon=True)
    JOBS[job_id] = {"cancel": cancel_ev, "thread": t}
    t.start()
    send("job", id=job_id, status="started", kind="analyze")
    return {"ok": True, "job": job_id}

def cmd_trim(payload):
    """Submits a trim job to the thread pool executor."""
    job_id = _new_job_id()
    cancel_ev = threading.Event()
    future = executor.submit(_run_trim_job, payload, job_id, cancel_ev)
    JOBS[job_id] = {"cancel": cancel_ev, "future": future}
    send("job", id=job_id, status="started", kind="trim", source_path=payload.get("path"))
    return {"ok": True, "job": job_id}

def cmd_thumb(payload):
    path = payload["path"]
    try:
        img = subprocess.check_output([
            "ffmpeg","-hide_banner","-nostats","-y",
            "-ss","0","-i", path,
            "-frames:v","1","-f","mjpeg","pipe:1"
        ], stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
        b64 = base64.b64encode(img).decode("ascii")
        return {"ok": True, "dataUrl": f"data:image/jpeg;base64,{b64}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def cmd_cancel(payload):
    job_id = payload.get("job")
    j = JOBS.get(job_id)
    if not j:
        send("job", id=job_id, status="cancelled", kind="unknown")
        return {"ok": True}
    try:
        j["cancel"].set()
        return {"ok": True}
    except Exception as e:
        send("job", id=job_id, status="error", error=str(e), kind="cancel")
        return {"ok": False, "error": str(e)}

def cleanup_and_exit(signum, frame):
    """Signal handler to kill all ffmpeg processes before exiting."""
    trim.kill_all_active_processes()
    executor.shutdown(wait=True)
    sys.exit(0)

def cmd_get_params_config(_payload=None):
    return {"ok": True, "config": PARAM_CONFIG}

def cmd_probe(payload):
    path = payload.get("path")
    if not path or not os.path.exists(path):
        return {"ok": False, "error": f"Input file not found: {path!r}"}
    try:
        dur = trim.ffprobe_duration(path)
        size_mb = round(os.path.getsize(path) / (1024*1024), 2)
        return {"ok": True, "duration": float(dur), "size_mb": size_mb}
    except Exception as e:
        return {"ok": False, "error": f"ffprobe failed: {e}"}

def main():
    try:
        cleanup_old_partials()
    except Exception:
        pass

    signal.signal(signal.SIGTERM, cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)

    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "shutdown":
                cleanup_and_exit(None, None)
                break # Exit the main loop
            elif cmd == "get_params_config":
                res = {"ok": True, "config": PARAM_CONFIG}
            elif cmd == "analyze":
                res = cmd_analyze(req)
            elif cmd == "probe":
                res = cmd_probe(req)
            elif cmd == "thumb":
                res = cmd_thumb(req)
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