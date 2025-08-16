# python/service.py

import sys, json, os, traceback, subprocess, base64, tempfile, signal, time, shutil
import trim
import threading, uuid, re
import collections, math

PARAM_CONFIG = {
    "noise_db": {"min": -50.0, "max": 0.0,   "step": 0.5, "default": -35.0},
    "silence":  {"min": 0.1,   "max": 1.0,   "step": 0.1, "default": 0.1},
    "pad":      {"min": 0.0,   "max": 1.0,   "step": 0.01,"default": 0.12},
    "keep":     {"min": 0.1,   "max": 1.0,   "step": 0.05, "default": 0.50},
}

JOBS = {}  # job_id -> {"cancel": threading.Event(), "thread": Thread}

def cleanup_old_partials():
    """Deletes partial files older than 24 hours from the temp directory."""
    try:
        partial_dir = os.path.join(tempfile.gettempdir(), "autotrim_partials")
        if not os.path.isdir(partial_dir):
            return

        cutoff = time.time() - (24 * 60 * 60)  # 24 hours ago

        for filename in os.listdir(partial_dir):
            if ".partial" in filename:
                file_path = os.path.join(partial_dir, filename)
                try:
                    if os.path.getmtime(file_path) < cutoff:
                        os.remove(file_path)
                except OSError:
                    # File might be in use or already deleted
                    pass
    except Exception:
        # Do not crash the app if cleanup fails for any reason
        pass

def _has_nvenc():
    try:
        out = subprocess.check_output(["ffmpeg","-hide_banner","-encoders"], text=True)
        return "h264_nvenc" in out
    except Exception:
        return False
def _new_job_id():
    return uuid.uuid4().hex[:8]

def send(evt, **data):
    sys.stdout.write(json.dumps({"event": evt, **data}) + "\n")
    sys.stdout.flush()

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

            send("progress", stage="analyze", value=0.01)
            dur = trim.ffprobe_duration(path)

            def on_analyze_progress(frac):
                send("progress", stage="analyze", value=min(0.99, max(0.0, frac)))

            vals = trim.analyze_levels(path, dur, on_progress=on_analyze_progress)
            vals = [v for v in vals if math.isfinite(v)]
            if not vals:
                raise RuntimeError("No audio levels parsed from video.")

            tenth = [round(v, 1) for v in vals]
            def bin_start(x): return round(min_db + math.floor((x - min_db) / bins) * bins, 1)
            counts = collections.Counter(bin_start(x) for x in tenth if min_db <= x <= max_db)

            edges = [round(e, 1) for e in np.arange(min_db, max_db + 1e-9, bins)]
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
    # --- Use default values from the central config ---
    noise         = float(payload.get("noise_db", PARAM_CONFIG["noise_db"]["default"]))
    silence       = float(payload.get("silence",  PARAM_CONFIG["silence"]["default"]))
    pad           = float(payload.get("pad",      PARAM_CONFIG["pad"]["default"]))
    keep          = float(payload.get("keep",     PARAM_CONFIG["keep"]["default"]))
    path          = payload["path"]

    # Validate input file exists and is accessible
    if not os.path.exists(path):
        return {"ok": False, "error": f"Input file not found: {path}"}
    
    if not os.access(path, os.R_OK):
        return {"ok": False, "error": f"Cannot read input file: {path}"}
    
    # Check if FFmpeg is available
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=10)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return {"ok": False, "error": "FFmpeg not found or not working. Please ensure FFmpeg is installed and accessible."}
    
    # Validate parameters
    if silence <= 0:
        return {"ok": False, "error": "Silence duration must be positive"}
    
    if pad < 0:
        return {"ok": False, "error": "Pad duration cannot be negative"}
    
    if keep <= 0:
        return {"ok": False, "error": "Keep threshold must be positive"}

    # Optional custom output path (from UI). If not provided, default to Downloads
    out = payload.get("out")
    if out:
        try:
            out_dir = os.path.dirname(out) or "."
            os.makedirs(out_dir, exist_ok=True)
        except Exception:
            pass
    else:
        base_name = os.path.splitext(os.path.basename(path))[0]
        
        # Format parameter values for the filename
        n_val = abs(int(noise))
        s_val = int(silence * 100)
        p_val = int(pad * 100)
        k_val = int(keep * 100)

        # Construct the new filename (using 'C' for 'keep' as per the example)
        new_filename = f"{base_name}-N{n_val}-S{s_val}-P{p_val}-C{k_val}.mp4"

        out = os.path.join(os.path.expanduser("~"), "Downloads", new_filename)

    job_id    = _new_job_id()
    cancel_ev = threading.Event()

    def worker():
        try:
            sys.stderr.write(f"[svc] Starting trim job {job_id} for {path}\n"); sys.stderr.flush()
            trim.CANCEL = cancel_ev

            # Create and define path for the temporary partial file
            partial_dir = os.path.join(tempfile.gettempdir(), "autotrim_partials")
            os.makedirs(partial_dir, exist_ok=True)
            
            out_base, out_ext = os.path.splitext(out)
            tmp_out = os.path.join(partial_dir, f"{job_id}.partial{out_ext}")

            dur = trim.ffprobe_duration(path)
            
            def input_has_audio(p):
                try:
                    out = subprocess.check_output([
                        "ffprobe","-v","error","-select_streams","a:0",
                        "-show_entries","stream=index","-of","csv=p=0", p
                    ], text=True)
                    return bool(out.strip())
                except Exception:
                    return True
            has_audio = input_has_audio(path)
            def on_detect(fr): send("progress", stage="detect", value=fr)

            sys.stderr.write(f"[svc] detect dur={dur:.3f}s noise={noise}dB silence={silence}s\n"); sys.stderr.flush()
            send("progress", stage="detect", value=0.01)

            detect_cmd = [
                "ffmpeg","-hide_banner","-progress","pipe:1","-y","-i", path,
                "-af", f"silencedetect=noise={trim._noise_for_ffmpeg(f'{noise}dB')}:d={silence}",
                "-f","null","-"
            ]
            
            rc, txt = trim.run_ffmpeg_progress(detect_cmd, dur, "detect", on_progress=on_detect)

            if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")
            
            if rc != 0:
                send("job", id=job_id, status="error", error="ffmpeg detect failed")
                return
            send("progress", stage="detect", value=1.0)
            
            starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+\.?\d*)", txt)]
            ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+\.?\d*)",   txt)]
            
            if not starts and not ends:
                starts, ends = [], [dur]
            
            segs = trim.build_speaking_segments(starts, ends, dur, pad, keep)
            
            if not segs:
                send("job", id=job_id, status="error", error="No keepable segments.")
                return

            eps = 0.010
            clips = [(max(0.0, s), max(s + eps, e - eps)) for s, e in segs if e - s > eps]
            total_dur = max(0.001, sum(e - s for s, e in clips))

            def on_render(fr): send("progress", stage="render", value=fr)
            send("progress", stage="render", value=0.01)

            use_nvenc = _has_nvenc()
            vcodec_args = ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "23"] if use_nvenc else \
                          ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]
            acodec_args = ["-c:a","aac","-b:a","160k"] if has_audio else []

            rc = 1
            stderr_txt = ""
            filter_script_path = None
            try:
                if len(clips) == 1:
                    st, et = clips[0]
                    render_dur = max(0.001, et - st)
                    cmd = ["ffmpeg","-hide_banner","-progress","pipe:1","-y",
                           "-ss", f"{st:.6f}", "-to", f"{et:.6f}", "-i", path] + \
                           vcodec_args + acodec_args + ["-movflags","+faststart", tmp_out]
                else:
                    vf, af = [], []
                    for i, (st, et) in enumerate(clips):
                        vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
                        if has_audio:
                            af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
                    if has_audio:
                        concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
                        fc = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])
                        map_args = ["-map","[v]","-map","[a]"]
                    else:
                        concat_inputs = "".join(f"[v{i}]" for i in range(len(clips)))
                        fc = ";".join(vf + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[v]"])
                        map_args = ["-map","[v]"]
                    
                    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt', encoding='utf-8') as f:
                        filter_script_path = f.name
                        f.write(fc)

                    cmd = ["ffmpeg","-hide_banner","-progress","pipe:1","-y","-i", path,
                           "-filter_complex_script", filter_script_path] + map_args + vcodec_args + acodec_args + \
                           ["-movflags","+faststart", tmp_out]
                    render_dur = total_dur
                
                rc, stderr_txt = trim.run_ffmpeg_progress(cmd, render_dur, "render", on_progress=on_render)
            finally:
                if filter_script_path and os.path.exists(filter_script_path):
                    try:
                        os.remove(filter_script_path)
                    except Exception:
                        pass # Don't crash if cleanup fails

            if trim.CANCEL.is_set(): raise RuntimeError("CANCELLED")

            if rc != 0:
                err = (stderr_txt or "ffmpeg render failed").strip().splitlines()[-1] if stderr_txt else "ffmpeg render failed"
                send("job", id=job_id, status="error", error=err)
                return
            
            try:
                # Use shutil.move for a robust move from temp dir to final destination
                shutil.move(tmp_out, out)
            except Exception as e:
                send("job", id=job_id, status="error", error=f"finalize failed: {e}")
                return

            send("job", id=job_id, status="finished", ok=True, output=out)

        except RuntimeError as e:
            if "CANCELLED" in str(e): send("job", id=job_id, status="cancelled")
            else: send("job", id=job_id, status="error", error=str(e))
        except Exception as e:
            traceback.print_exc()
            send("job", id=job_id, status="error", error=str(e))
        finally:
            JOBS.pop(job_id, None)
            try: cancel_ev.clear()
            except Exception: pass
            # Clean up the partial file if it still exists (e.g., on error)
            if os.path.exists(tmp_out):
                try:
                    os.remove(tmp_out)
                except Exception:
                    pass

    t = threading.Thread(target=worker, daemon=True)
    JOBS[job_id] = {"cancel": cancel_ev, "thread": t}
    t.start()
    send("job", id=job_id, status="started", kind="trim")
    return {"ok": True, "job": job_id}

def cmd_thumb(payload):
    path = payload["path"]
    try:
        img = subprocess.check_output([
            "ffmpeg","-hide_banner","-nostats","-y",
            "-ss","0","-i", path,
            "-frames:v","1","-f","mjpeg","pipe:1"
        ], stderr=subprocess.DEVNULL)
        b64 = base64.b64encode(img).decode("ascii")
        return {"ok": True, "dataUrl": f"data:image/jpeg;base64,{b64}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def cmd_cancel(payload):
    job = payload.get("job")
    j = JOBS.get(job)
    if not j:
        return {"ok": False, "error": "Unknown job"}
    j["cancel"].set()
    return {"ok": True, "job": job}

def cleanup_and_exit(signum, frame):
    """Signal handler to kill all ffmpeg processes before exiting."""
    trim.kill_all_active_processes()
    sys.exit(0)

def main():
    # Run cleanup once at startup
    cleanup_old_partials()

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)

    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "get_params_config":
                res = {"ok": True, "config": PARAM_CONFIG}
            elif cmd == "analyze":
                res = cmd_analyze(req)
            elif cmd == "probe":
                try:
                    p = req.get("path")
                    d = trim.ffprobe_duration(p)
                    res = {"ok": True, "duration": d}
                except Exception as e:
                    res = {"ok": False, "error": str(e)}
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
    import numpy as np
    main()