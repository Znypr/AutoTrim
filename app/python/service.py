# python/service.py

import sys, json, os, traceback, subprocess, base64, tempfile, signal, time, shutil
import trim
import threading, uuid, re
import collections, math
from concurrent.futures import ThreadPoolExecutor

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
            return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    except Exception:
        pass
    return []

def _new_job_id():
    return uuid.uuid4().hex[:8]

def send(evt, **data):
    sys.stdout.write(json.dumps({"event": evt, **data}) + "\n")
    sys.stdout.flush()

def _run_trim_job(payload, job_id):
    """This function contains the actual ffmpeg work for a single trim job."""
    def shell_join(args:list[str]) -> str:
        import shlex
        return " ".join(shlex.quote(a) for a in args)

    def ffprobe_has_stream(path:str, kind:str) -> bool:
        try:
            out = subprocess.check_output(
                ["ffprobe","-v","error","-select_streams", f"{kind}:0",
                 "-show_entries","stream=index","-of","csv=p=0", path],
                text=True, creationflags=CREATE_NO_WINDOW
            )
            return bool(out.strip())
        except Exception:
            return False

    def send_ffmpeg_error(job_id, where:str, cmd:list[str], stderr_txt:str):
        head = "\n".join((stderr_txt or "").splitlines()[:30]) 
        sys.stderr.write(f"[svc] ffmpeg {where} failed\n[svc] CMD: {shell_join(cmd)}\n[svc] STDERR:\n{head}\n")
        sys.stderr.flush()
        send("job", id=job_id, status="error",
             error=f"{where} failed. See logs.\n{head}", kind="trim", source_path=payload.get("path"))

    try:
        cleanup_old_partials()
        cancel_ev = JOBS[job_id]["cancel"]
        trim.CANCEL = cancel_ev

        noise   = float(payload.get("noise_db", PARAM_CONFIG["noise_db"]["default"]))
        silence = float(payload.get("silence",  PARAM_CONFIG["silence"]["default"]))
        pad     = float(payload.get("pad",      PARAM_CONFIG["pad"]["default"]))
        keep    = float(payload.get("keep",     PARAM_CONFIG["keep"]["default"]))
        path    = payload.get("path")
        out     = payload.get("out")

        if os.path.exists(out):
            directory, filename = os.path.split(out)
            base_name, extension = os.path.splitext(filename)
            counter = 2
            while os.path.exists(out):
                new_filename = f"{base_name}-{counter}{extension}"
                out = os.path.join(directory, new_filename)
                counter += 1

        partial_dir = os.path.join(tempfile.gettempdir(), "autotrim_partials")
        os.makedirs(partial_dir, exist_ok=True)
        _, out_ext = os.path.splitext(out)
        tmp_out = os.path.join(partial_dir, f"{job_id}.partial{out_ext}")

        dur = trim.ffprobe_duration(path)
        has_video = ffprobe_has_stream(path, "v")
        has_audio = ffprobe_has_stream(path, "a")
        if not has_video:
            send("job", id=job_id, status="error", error="Input has no video stream.", kind="trim", source_path=path)
            return

        use_nvenc = _has_nvenc()
        hwaccel_args = _gpu_decode_args() if use_nvenc else []

        # ---------- Stage 1: detect ----------
        def on_detect(fr): send("progress", stage="detect", value=max(0.0, min(1.0, fr)), hint_total=dur, job_id=job_id, source_path=path)
        send("progress", stage="detect", value=0.01, hint_total=dur, job_id=job_id, source_path=path)

        detect_cmd = [
            "ffmpeg","-hide_banner","-loglevel","info","-progress","pipe:1","-nostdin","-y",
            *hwaccel_args, "-threads","0", "-i", path,
            # FIX: Build the filter string directly instead of using the removed trim._noise_for_ffmpeg()
            "-af", f"silencedetect=noise={noise}dB:d={silence}",
            "-f","null","-"
        ]
        rc, detect_txt = trim.run_ffmpeg_progress(detect_cmd, dur, "detect", on_progress=on_detect)
        if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")

        # FIX: Only treat as a failure if the return code is bad AND we got no silence data.
        if rc != 0 and "silence_start" not in detect_txt:
            send_ffmpeg_error(job_id, "detect", detect_cmd, detect_txt)
            return

        starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+\.?\d*)", detect_txt)]
        ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+\.?\d*)",   detect_txt)]
        if not starts and not ends:
            starts, ends = [], [dur]

        segs = trim.build_speaking_segments(starts, ends, dur, pad, keep)
        if not segs:
            send("job", id=job_id, status="error", error="No keepable segments.", kind="trim", source_path=path)
            return

        eps = 0.010
        clips = [(max(0.0, s), max(s + eps, e - eps)) for s, e in segs if (e - s) > eps]
        total_dur = max(0.001, sum(e - s for s, e in clips))

        # ---------- Stage 2: render ----------
        def on_render(fr): send("progress", stage="render", value=max(0.0, min(1.0, fr)), hint_total=total_dur, job_id=job_id, source_path=path)
        send("progress", stage="render", value=0.0, hint_total=total_dur, job_id=job_id, source_path=path)

        vcodec_args = (["-c:v","h264_nvenc","-preset","p1","-cq","23"] if use_nvenc
                       else ["-c:v","libx264","-preset","ultrafast","-crf","23"])
        acodec_args = (["-c:a","aac","-b:a","160k"] if has_audio else [])

        if len(clips) == 1:
            st, et = clips[0]
            render_len = max(0.001, et - st)
            base = [
                "ffmpeg","-hide_banner","-loglevel","verbose","-progress","pipe:1","-nostdin","-y",
                *hwaccel_args, "-threads","0",
                "-ss", f"{st:.6f}", "-i", path,
                "-t", f"{render_len:.6f}",
            ]
            maps = ["-map","0:v:0"]
            if has_audio: maps += ["-map","0:a:0"]
            else: maps += ["-an"]
            cmd = base + ["-threads","0"] + maps + vcodec_args + (acodec_args if has_audio else []) + ["-movflags","+faststart", tmp_out]
            rc, stderr_txt = trim.run_ffmpeg_progress(cmd, total=render_len, desc="render", on_progress=on_render)
            if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")
            if rc != 0:
                send_ffmpeg_error(job_id, "render", cmd, stderr_txt)
                if os.path.isfile(tmp_out): os.remove(tmp_out)
                return
        else:
            render_len = total_dur
            vf_parts, af_parts = [], []
            for idx, (st, et) in enumerate(clips):
                vf_parts.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{idx}]")
                if has_audio:
                    af_parts.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS,aresample=async=1[a{idx}]")
            concat_inputs = []
            for idx in range(len(clips)):
                concat_inputs.append(f"[v{idx}]")
                if has_audio: concat_inputs.append(f"[a{idx}]")
            fc_parts = []
            fc_parts.extend(vf_parts)
            if has_audio: fc_parts.extend(af_parts)
            if has_audio:
                fc_parts.append(f"{''.join(concat_inputs)}concat=n={len(clips)}:v=1:a=1[v][a]")
                maps = ["-map", "[v]", "-map", "[a]"]
            else:
                fc_parts.append(f"{''.join(concat_inputs)}concat=n={len(clips)}:v=1:a=0[v]")
                maps = ["-map", "[v]", "-an"]
            cmd = [
                "ffmpeg", "-hide_banner", "-loglevel", "verbose", "-progress", "pipe:1", "-nostdin", "-y",
                "-threads","0", "-i", path, "-filter_complex", ";".join(fc_parts),
                *maps, *vcodec_args, *(acodec_args if has_audio else []),
                "-movflags", "+faststart", tmp_out
            ]
            rc, stderr_txt = trim.run_ffmpeg_progress(cmd, total=render_len, desc="render", on_progress=on_render)
            if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")
            if rc != 0:
                send_ffmpeg_error(job_id, "render", cmd, stderr_txt)
                if os.path.isfile(tmp_out): os.remove(tmp_out)
                return

        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        shutil.move(tmp_out, out)
        send("job", id=job_id, status="finished", ok=True, kind="trim", output=out, source_path=path)

    except RuntimeError as e:
        if "CANCELLED" in str(e):
            send("job", id=job_id, status="cancelled", kind="trim", source_path=payload.get("path"))
        else:
            send("job", id=job_id, status="error", error=str(e), kind="trim", source_path=payload.get("path"))
    except Exception as e:
        send("job", id=job_id, status="error", error=str(e), kind="trim", source_path=payload.get("path"))
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
    future = executor.submit(_run_trim_job, payload, job_id)
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