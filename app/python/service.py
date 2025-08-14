#python/service.py

import sys, json, os, traceback, subprocess, base64
import trim
import threading, time, uuid, re

JOBS = {}  # job_id -> {"cancel": threading.Event(), "thread": Thread}


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
        out = os.path.join(os.path.expanduser("~"), "Downloads",
                           f"{os.path.splitext(os.path.basename(path))[0]}_trimmed.mp4")

    job_id    = _new_job_id()
    cancel_ev = threading.Event()

    def worker():
        try:
            sys.stderr.write(f"[svc] Starting trim job {job_id} for {path}\n"); sys.stderr.flush()
            # point trim's global CANCEL at this job's event
            trim.CANCEL = cancel_ev

            dur = trim.ffprobe_duration(path)
            sys.stderr.write(f"[svc] Video duration: {dur:.3f}s\n"); sys.stderr.flush()

            # Probe whether the input has an audio stream
            def input_has_audio(p):
                try:
                    out = subprocess.check_output([
                        "ffprobe","-v","error","-select_streams","a:0",
                        "-show_entries","stream=index","-of","csv=p=0", p
                    ], text=True)
                    return bool(out.strip())
                except Exception:
                    return True  # assume yes if probing fails
            has_audio = input_has_audio(path)
            def on_detect(fr): send("progress", stage="detect", value=fr)

            # detect silences
            # nudge UI immediately
            # Log detect info
            try:
                sys.stderr.write(f"[svc] detect dur={dur:.3f}s noise={noise}dB silence={silence}s\n"); sys.stderr.flush()
            except Exception: pass
            send("progress", stage="detect", value=0.01)
            
            # Add timeout for detect stage to prevent hanging
            
            detect_result = {"rc": None, "txt": "", "error": None}
            detect_complete = threading.Event()
            detect_progress_stalled = False
            last_detect_progress = time.time()
            
            def detect_worker():
                try:
                    sys.stderr.write("[svc] detect worker starting...\n"); sys.stderr.flush()
                    
                    def on_detect_progress(frac):
                        try:
                            nonlocal last_detect_progress, detect_progress_stalled
                            now = time.time()
                            last_detect_progress = now
                            detect_progress_stalled = False
                            
                            sys.stderr.write(f"[svc] detect progress: {frac:.3f}\n"); sys.stderr.flush()
                            on_detect(frac)
                        except Exception as e:
                            sys.stderr.write(f"[svc] progress callback error: {str(e)}\n"); sys.stderr.flush()
                    
                    # For silence detection, we'll simulate progress based on time elapsed
                    # since FFmpeg silencedetect doesn't provide reliable progress output
                    start_time = time.time()
                    progress_sent = False
                    last_output_time = time.time()
                    output_received = False
                    
                    def simulate_progress():
                        nonlocal progress_sent
                        while not detect_complete.is_set():
                            time.sleep(0.5)  # Update every 500ms
                            if not detect_complete.is_set():
                                elapsed = time.time() - start_time
                                # Estimate progress based on elapsed time vs expected duration
                                # Silence detection typically takes 1/3 to 1/2 of video duration
                                # depending on complexity and audio characteristics
                                expected_time = max(10.0, min(dur * 0.5, 90.0))  # Between 10s and 90s, or 50% of duration
                                if expected_time > 0:
                                    progress = min(0.98, elapsed / expected_time)  # Cap at 98% instead of 95%
                                    try:
                                        on_detect_progress(progress)
                                        progress_sent = True
                                    except Exception as e:
                                        sys.stderr.write(f"[svc] simulated progress error: {str(e)}\n"); sys.stderr.flush()
                                
                                # If we've been running for too long, cap progress at 98%
                                if elapsed > 180.0:  # 3 minutes max (increased from 2)
                                    try:
                                        on_detect_progress(0.98)
                                    except Exception:
                                        pass
                                    # Don't break, keep monitoring until FFmpeg completes
                                    pass
                        
                        # When we exit the loop, FFmpeg has completed - send final progress
                        # Wait a moment for detect_result to be populated
                        time.sleep(0.1)
                        if detect_result.get("rc") == 0:
                            try:
                                sys.stderr.write("[svc] FFmpeg completed successfully, sending final progress\n"); sys.stderr.flush()
                                on_detect(1.0)
                            except Exception as e:
                                sys.stderr.write(f"[svc] final progress from simulation error: {str(e)}\n"); sys.stderr.flush()
                    
                    # Start progress simulation thread
                    progress_thread = threading.Thread(target=simulate_progress, daemon=True)
                    progress_thread.start()
                    
                    # Add progress stall detection
                    def progress_monitor():
                        nonlocal detect_progress_stalled
                        while not detect_complete.is_set():
                            time.sleep(5.0)  # Check every 5 seconds (increased from 2)
                            if not detect_complete.is_set() and (time.time() - last_detect_progress) > 10.0:  # Increased from 5s to 10s
                                detect_progress_stalled = True
                                sys.stderr.write(f"[svc] detect progress stalled for {time.time() - last_detect_progress:.1f}s\n"); sys.stderr.flush()
                                # Send a small progress update to show we're still alive
                                try:
                                    on_detect(0.001)
                                except Exception as e:
                                    sys.stderr.write(f"[svc] stall progress update error: {str(e)}\n"); sys.stderr.flush()
                    
                    # Start progress monitor thread
                    monitor_thread = threading.Thread(target=progress_monitor, daemon=True)
                    monitor_thread.start()
                    
                    # Add FFmpeg process monitoring to detect if it's actually stuck
                    def ffmpeg_monitor():
                        while not detect_complete.is_set():
                            time.sleep(10.0)  # Check every 10 seconds (less aggressive)
                            if not detect_complete.is_set():
                                elapsed = time.time() - start_time
                                
                                # If we've been running for more than 5 minutes, something is wrong
                                if elapsed > 300.0:  # 5 minutes (increased from 3)
                                    sys.stderr.write(f"[svc] FFmpeg detect running for {elapsed:.1f}s, likely stuck\n"); sys.stderr.flush()
                                    # Force completion to prevent infinite hanging
                                    detect_complete.set()
                                    break
                                
                                # If we haven't received any output for 60 seconds, FFmpeg might be stuck
                                # (increased from 30s to be less aggressive)
                                if output_received and (time.time() - last_output_time) > 60.0:
                                    sys.stderr.write(f"[svc] FFmpeg detect no output for {time.time() - last_output_time:.1f}s, may be stuck\n"); sys.stderr.flush()
                                    # Don't force completion immediately, just log the warning
                                    # Silence detection can legitimately take time between outputs
                                    pass
                    
                    # Start FFmpeg monitor thread
                    ffmpeg_monitor_thread = threading.Thread(target=ffmpeg_monitor, daemon=True)
                    ffmpeg_monitor_thread.start()
                    
                    # Track when we receive output from FFmpeg
                    def on_ffmpeg_output():
                        nonlocal last_output_time, output_received
                        last_output_time = time.time()
                        output_received = True
                    
                    # Create a custom progress callback that tracks FFmpeg output
                    def on_detect_progress_with_output(frac):
                        nonlocal last_detect_progress, detect_progress_stalled, last_output_time, output_received
                        now = time.time()
                        last_detect_progress = now
                        last_output_time = now
                        detect_progress_stalled = False
                        output_received = True
                        
                        try:
                            sys.stderr.write(f"[svc] detect progress: {frac:.3f}\n"); sys.stderr.flush()
                            on_detect(frac)
                        except Exception as e:
                            sys.stderr.write(f"[svc] progress callback error: {str(e)}\n"); sys.stderr.flush()
                    
                    # Also track when we receive actual silence detection output
                    silence_detected = False
                    def on_silence_output(line):
                        nonlocal silence_detected, last_output_time, output_received
                        if "silence_start:" in line or "silence_end:" in line:
                            silence_detected = True
                            last_output_time = time.time()
                            output_received = True
                            sys.stderr.write(f"[svc] silence output: {line.strip()}\n"); sys.stderr.flush()
                    
                    # Track meaningful FFmpeg output (not just metadata)
                    meaningful_output_received = False
                    def on_meaningful_output(line):
                        nonlocal meaningful_output_received, last_output_time, output_received
                        # Look for actual processing output, not just metadata
                        if any(keyword in line for keyword in ["silence_start:", "silence_end:", "frame=", "fps=", "time="]):
                            meaningful_output_received = True
                            last_output_time = time.time()
                            output_received = True
                            sys.stderr.write(f"[svc] meaningful output: {line.strip()}\n"); sys.stderr.flush()
                    
                    detect_cmd = [
                        "ffmpeg","-hide_banner","-progress","pipe:1","-y","-i", path,
                        "-af", f"silencedetect=noise={trim._noise_for_ffmpeg(f'{noise}dB')}:d={silence}",
                        "-f","null","-"
                    ]
                    sys.stderr.write("[svc] detect cmd: " + " ".join(detect_cmd) + "\n"); sys.stderr.flush()
                    
                    # Run FFmpeg and capture output
                    rc, txt = trim.run_ffmpeg_progress(detect_cmd, dur, "detect", on_progress=on_detect_progress_with_output)
                    
                    
                    # Send final progress update to show completion
                    try:
                        on_detect(1.0)
                    except Exception as e:
                        sys.stderr.write(f"[svc] final progress update error: {str(e)}\n"); sys.stderr.flush()
                    
                    sys.stderr.write(f"[svc] detect worker finished: rc={rc}, txt_len={len(txt)}\n"); sys.stderr.flush()
                    detect_result["rc"] = rc
                    detect_result["txt"] = txt
                    
                    # Ensure progress simulation thread gets the completion signal
                    # by waiting a moment for it to process the final progress
                    time.sleep(0.2)
                    
                    # Double-check that final progress was sent
                    if detect_result.get("rc") == 0:
                        try:
                            sys.stderr.write("[svc] ensuring final progress is sent\n"); sys.stderr.flush()
                            on_detect(1.0)
                        except Exception as e:
                            sys.stderr.write(f"[svc] fallback final progress error: {str(e)}\n"); sys.stderr.flush()
                except Exception as e:
                    sys.stderr.write(f"[svc] detect worker error: {str(e)}\n"); sys.stderr.flush()
                    detect_result["error"] = str(e)
                finally:
                    detect_complete.set()
            
            detect_thread = threading.Thread(target=detect_worker, daemon=True)
            detect_thread.start()
            
            # Wait for detect to complete with 5 minute timeout
            if not detect_complete.wait(timeout=300):
                send("job", id=job_id, status="error", error="Detect stage timed out after 5 minutes")
                return
            
            if detect_result["error"]:
                send("job", id=job_id, status="error", error=f"Detect stage failed: {detect_result['error']}")
                return
                
            rc, txt = detect_result["rc"], detect_result["txt"]
            if rc != 0:
                # Check if this was a timeout/forced completion
                if "CANCELLED" in txt or "timeout" in txt.lower():
                    send("job", id=job_id, status="error", error="Detect stage was cancelled or timed out")
                else:
                    send("job", id=job_id, status="error", error="ffmpeg detect failed")
                return
                
            # Parse silence detection results
            try:
                sys.stderr.write(f"[svc] parsing silence results from {len(txt)} chars\n"); sys.stderr.flush()
                # Fix regex to match actual FFmpeg output format: "silence_start: 0.0434583"
                starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
                ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)",   txt)]
                sys.stderr.write(f"[svc] found {len(starts)} starts, {len(ends)} ends\n"); sys.stderr.flush()
                
                # Debug: show the actual text being parsed
                sys.stderr.write(f"[svc] silence detection output (first 500 chars): {txt[:500]}\n"); sys.stderr.flush()
                
                # Debug: show what the regex is finding
                sys.stderr.write("[svc] regex pattern: silence_start:\\s*(\\d+(?:\\.\\d+)?)\n"); sys.stderr.flush()
                silence_start_pattern = r'silence_start:\s*(\d+(?:\.\d+)?)'
                silence_end_pattern = r'silence_end:\s*(\d+(?:\.\d+)?)'
                sys.stderr.write(f"[svc] all matches found: {re.findall(silence_start_pattern, txt)}\n"); sys.stderr.flush()
                sys.stderr.write(f"[svc] all matches found: {re.findall(silence_end_pattern, txt)}\n"); sys.stderr.flush()
                
                if not starts or not ends:
                    sys.stderr.write("[svc] no silence detected, using full video\n"); sys.stderr.flush()
                    # If no silence detected, use the full video
                    starts = [0.0]
                    ends = [dur]
                    
            except Exception as e:
                sys.stderr.write(f"[svc] error parsing silence results: {str(e)}\n"); sys.stderr.flush()
                send("job", id=job_id, status="error", error=f"Failed to parse silence detection results: {str(e)}")
                return
                
            # Ensure we have valid segments even if no silence was detected
            if not starts or not ends:
                sys.stderr.write("[svc] fallback: using full video as single segment\n"); sys.stderr.flush()
                starts = [0.0]
                ends = [dur]
            
            sys.stderr.write(f"[svc] calling build_speaking_segments with starts={starts}, ends={ends}, dur={dur}, pad={pad}, keep={keep}\n"); sys.stderr.flush()
            segs = trim.build_speaking_segments(starts, ends, dur, pad, keep)
            sys.stderr.write(f"[svc] built {len(segs)} segments\n"); sys.stderr.flush()
            
            # If no segments were built, create a fallback segment for the full video
            if not segs:
                sys.stderr.write("[svc] no segments built, creating fallback full video segment\n"); sys.stderr.flush()
                # Create a single segment for the full video
                # The segment must be at least 'keep' seconds long
                if dur >= keep:
                    segs = [(0.0, dur)]
                    sys.stderr.write(f"[svc] created fallback segment: {segs[0]} (duration: {dur:.3f}s, keep threshold: {keep:.3f}s)\n"); sys.stderr.flush()
                else:
                    # If video is too short, create a segment that meets the keep threshold
                    # by extending beyond the video duration if necessary
                    extended_dur = max(dur, keep + 0.1)  # Add small buffer
                    segs = [(0.0, extended_dur)]
                    sys.stderr.write(f"[svc] created extended fallback segment: {segs[0]} (original: {dur:.3f}s, extended: {extended_dur:.3f}s)\n"); sys.stderr.flush()
            
            if not segs:
                send("job", id=job_id, status="error", error="No keepable segments.")
                return

            # concat filter
            eps = 0.010
            clips = [(max(0.0, s), max(s + eps, e - eps)) for s, e in segs if e - s > eps]
            vf, af = [], []
            for i, (st, et) in enumerate(clips):
                vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
                if has_audio:
                    af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
            if has_audio:
                concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
                fc = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])
            else:
                concat_inputs = "".join(f"[v{i}]" for i in range(len(clips)))
                fc = ";".join(vf + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[v]"])
            total = max(0.001, sum(et - st for st, et in clips))

            # Debug info to stderr for diagnosis in dev
            try:
                sys.stderr.write(f"[svc] clips={len(clips)} total={total:.3f}s has_audio={has_audio}\n")
                sys.stderr.flush()
            except Exception:
                pass

            def on_render(fr): send("progress", stage="render", value=fr)

            send("progress", stage="render", value=0.01)
            
            # Add timeout for render stage
            render_result = {"rc": None, "stderr_txt": "", "error": None}
            render_complete = threading.Event()
            render_start_time = time.time()
            
            # Add progress stall detection for render stage
            render_progress_stalled = False
            last_render_progress = time.time()
            
            # Progress monitor for render stage
            def render_progress_monitor():
                nonlocal render_progress_stalled
                while not render_complete.is_set():
                    time.sleep(5.0)  # Check every 5 seconds (less aggressive)
                    if not render_complete.is_set() and (time.time() - last_render_progress) > 10.0:  # Increased from 5s to 10s
                        render_progress_stalled = True
                        sys.stderr.write(f"[svc] render progress stalled for {time.time() - last_render_progress:.1f}s\n"); sys.stderr.flush()
                        # Send a small progress update to show we're still alive
                        try:
                            on_render(0.001)
                        except Exception as e:
                            sys.stderr.write(f"[svc] render stall progress update error: {str(e)}\n"); sys.stderr.flush()
                    else:
                        render_progress_stalled = False
                # Exit when render completes
                sys.stderr.write("[svc] render progress monitor exiting\n"); sys.stderr.flush()
            
            # Start render progress monitor thread
            render_monitor_thread = threading.Thread(target=render_progress_monitor, daemon=True)
            render_monitor_thread.start()
            
            # Re-encode output (required when using filter_complex). Write to temp then move.
            tmp_out = out + ".partial.mp4"
            try:
                if os.path.exists(tmp_out):
                    os.remove(tmp_out)
            except Exception:
                pass

            # Choose faster encoder
            use_nvenc = _has_nvenc()
            if use_nvenc:
                vcodec_args_many = ["-c:v","h264_nvenc","-preset","p1","-cq","23"]   # very fast NVENC
                vcodec_args_one  = ["-c:v","h264_nvenc","-preset","p1","-cq","23"]
            else:
                vcodec_args_many = ["-c:v","libx264","-preset","ultrafast","-crf","23"]
                vcodec_args_one  = ["-c:v","libx264","-preset","ultrafast","-crf","23"]


            if len(clips) == 1:
                st, et = clips[0]
                dur_cut = max(0.001, et - st)
                cmd = [
                    "ffmpeg","-hide_banner","-progress","pipe:1","-y",
                    "-ss", f"{st:.6f}", "-t", f"{dur_cut:.6f}", "-i", path,
                ]
                cmd += vcodec_args_one
                if has_audio:
                    cmd += ["-c:a","aac","-b:a","160k"]
                cmd += ["-movflags","+faststart", tmp_out]

            else:
                cmd = [
                    "ffmpeg","-hide_banner","-progress","pipe:1","-y","-i", path,
                    "-filter_complex", fc, "-map","[v]",
                ]
                if has_audio:
                    cmd += ["-map","[a]"]
                cmd += vcodec_args_many
                if has_audio:
                    cmd += ["-c:a","aac","-b:a","160k"]
                cmd += ["-movflags","+faststart", tmp_out]

            try:
                sys.stderr.write("[svc] ffmpeg cmd: " + " ".join(cmd) + "\n")
                sys.stderr.flush()
            except Exception:
                pass

            # Emit periodic tick if ffmpeg progress stalls (UI feedback)
            last_tick = time.time()
            def heartbeat(frac):
                nonlocal last_tick
                now = time.time()
                if now - last_tick > 1.0:
                    last_tick = now
                    try: on_render(min(0.99, frac))
                    except Exception: pass
            
            # Start heartbeat thread for render progress
            def heartbeat_worker():
                while not render_complete.is_set():
                    time.sleep(1.0)
                    try:
                        heartbeat(0.001)  # Send small progress updates
                    except Exception:
                        pass
            
            heartbeat_thread = threading.Thread(target=heartbeat_worker, daemon=True)
            heartbeat_thread.start()
            
            def render_worker():
                try:
                    sys.stderr.write("[svc] render worker starting...\n"); sys.stderr.flush()
                    rc, stderr_txt = trim.run_ffmpeg_progress(cmd, total if len(clips)>1 else dur_cut, "render", on_progress=on_render)
                    render_result["rc"] = rc
                    render_result["stderr_txt"] = stderr_txt
                    sys.stderr.write(f"[svc] render worker finished: rc={rc}, txt_len={len(stderr_txt)}\n"); sys.stderr.flush()
                except Exception as e:
                    render_result["error"] = str(e)
                    sys.stderr.write(f"[svc] render worker error: {str(e)}\n"); sys.stderr.flush()
                finally:
                    render_complete.set()
            
            render_thread = threading.Thread(target=render_worker, daemon=True)
            render_thread.start()
            
            # Wait for render to complete with 10 minute timeout
            if not render_complete.wait(timeout=600):
                sys.stderr.write("[svc] render timeout after 600s\n"); sys.stderr.flush()
                send("job", id=job_id, status="error", error="Render stage timed out after 10 minutes")
                return
            
            # Ensure we got a result
            if render_result["rc"] is None and render_result["error"] is None:
                sys.stderr.write("[svc] render completed but no result\n"); sys.stderr.flush()
                send("job", id=job_id, status="error", error="Render stage completed but no result")
                return
            
            if render_result["error"]:
                send("job", id=job_id, status="error", error=f"Render stage failed: {render_result['error']}")
                return
            
            rc, stderr_txt = render_result["rc"], render_result["stderr_txt"]
            if rc != 0:
                err = (stderr_txt or "ffmpeg render failed").strip().splitlines()[-1] if stderr_txt else "ffmpeg render failed"
                send("job", id=job_id, status="error", error=err)
                return
            try:
                if os.path.exists(out):
                    os.remove(out)
                os.replace(tmp_out, out)
            except Exception as e:
                send("job", id=job_id, status="error", error=f"finalize failed: {e}")
                return

            send("job", id=job_id, status="finished", ok=True, output=out)

        except RuntimeError as e:
            if "CANCELLED" in str(e):
                send("job", id=job_id, status="cancelled")
            else:
                send("job", id=job_id, status="error", error=str(e))
        except Exception as e:
            send("job", id=job_id, status="error", error=str(e))
        finally:
            locals_snapshot = locals()
            for name in (
                'render_monitor_thread',
                'monitor_thread',
                'progress_thread',
                'ffmpeg_monitor_thread',
                'render_thread',
                'heartbeat_thread',
            ):
                t = locals_snapshot.get(name)
                if t:
                    try:
                        t.join(timeout=1.0)
                    except Exception:
                        pass
            JOBS.pop(job_id, None)
            try:
                cancel_ev.clear()
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
        # single JPEG frame from start
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

def main():
    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "analyze":
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
    main()
