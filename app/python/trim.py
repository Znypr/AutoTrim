# python/trim.py
import os, re, subprocess, sys, threading, time, math, signal
from typing import List, Tuple
from queue import Queue, Empty
import atexit

try:
    import numpy as np
except ImportError:
    print("Error: numpy is required for audio analysis. Please run 'pip install numpy'", file=sys.stderr)
    sys.exit(1)

# ---- Globals -----------------------------------------------------------------
CANCEL = threading.Event()
ACTIVE_PROCESSES = []

# ---- Small utilities ---------------------------------------------------------

def kill_all_active_processes():
    """Terminates all registered ffmpeg processes and their process groups."""
    for proc in ACTIVE_PROCESSES:
        try:
            if os.name == 'nt':
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except:
                pass
    ACTIVE_PROCESSES.clear()

atexit.register(kill_all_active_processes)

def _noise_for_ffmpeg(noise: str) -> str:
    s = str(noise).strip()
    if not s.lower().endswith("db"):
        s += "dB"
    if re.fullmatch(r"\d+(?:\.\d+)?dB", s, re.I):
        s = "-" + s
    return s

def _popen_creation_flags():
    """Returns Popen kwargs for a hidden window on Windows."""
    if os.name == "nt":
        CREATE_NO_WINDOW = 0x08000000
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        return {"creationflags": CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP}
    else:
        return {"preexec_fn": os.setsid}

def _patch_ffmpeg_path():
    base = getattr(sys, "_MEIPASS",
                   os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
                   else os.path.dirname(__file__))
    ffdir = os.path.join(base, "ffmpeg")
    if os.path.isdir(ffdir):
        os.environ["PATH"] = ffdir + os.pathsep + os.environ.get("PATH", "")
_patch_ffmpeg_path()

def ffprobe_duration(path: str) -> float:
    si = None
    flags = 0
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        flags = 0x08000000 # CREATE_NO_WINDOW
    
    return float(subprocess.check_output(
        ["ffprobe","-v","error","-show_entries","format=duration",
         "-of","default=noprint_wrappers=1:nokey=1", path],
        text=True, startupinfo=si, creationflags=flags
    ).strip())

# ---- FFmpeg execution with progress ------------------------------------------

def _parse_progress_time(val: str):
    """Accept out_time_ms/us or out_time=HH:MM:SS.sss."""
    v = val.strip()
    if v == "N/A":
        return None
    try:
        if v.isdigit():
            return float(v) / 1_000_000.0
    except Exception:
        pass
    try:
        hh, mm, ss = v.split(":")
        return int(hh) * 3600 + int(mm) * 60 + float(ss)
    except Exception:
        return None

def run_ffmpeg_progress(cmd: List[str], total: float, desc: str,
                        on_progress=None) -> Tuple[int, str]:
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL, 
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True, encoding='utf-8', errors='replace', bufsize=1,
        **_popen_creation_flags()
    )
    
    ACTIVE_PROCESSES.append(proc)
    
    try:
        q_out, q_err = Queue(), Queue()

        def _reader_thread(pipe, queue):
            try:
                for line in iter(pipe.readline, ''):
                    queue.put(line)
            finally:
                pipe.close()
                queue.put(None)

        threading.Thread(target=_reader_thread, args=(proc.stdout, q_out), daemon=True).start()
        threading.Thread(target=_reader_thread, args=(proc.stderr, q_err), daemon=True).start()

        stderr_buf = []
        stdout_closed = False
        stderr_closed = False

        if on_progress:
            try: on_progress(0.0)
            except Exception: pass

        while not stdout_closed or not stderr_closed:
            if CANCEL.is_set():
                try:
                    if os.name == 'nt':
                        proc.send_signal(signal.CTRL_BREAK_EVENT)
                    else:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
                raise RuntimeError("CANCELLED")

            try:
                line_out = q_out.get_nowait()
                if line_out is None:
                    stdout_closed = True
                else:
                    line_out = line_out.strip()
                    if "=" in line_out:
                        key, val = line_out.split("=", 1)
                        if key in ("out_time_ms", "out_time_us", "out_time"):
                            tval = _parse_progress_time(val)
                            if tval is not None and total > 0 and on_progress:
                                frac = max(0.0, min(1.0, tval / total))
                                on_progress(frac)
                        elif key == "progress" and val == "end" and on_progress:
                            on_progress(1.0)
            except Empty:
                pass

            try:
                line_err = q_err.get_nowait()
                if line_err is None:
                    stderr_closed = True
                else:
                    stderr_buf.append(line_err)
            except Empty:
                pass
            
            if q_out.empty() and q_err.empty():
                time.sleep(0.2)   

        proc.wait()
        return proc.returncode or 0, "".join(stderr_buf)
    finally:
        if proc in ACTIVE_PROCESSES:
            ACTIVE_PROCESSES.remove(proc)

# ---- Silence detection / segments --------------------------------------------

def build_speaking_segments(starts: List[float], ends: List[float], dur: float,
                            pad: float, keep: float) -> List[Tuple[float, float]]:
    if not starts and not ends:
        return [(0.0, dur)] if dur >= keep else []

    silent_intervals = list(zip(starts, ends))
    points = sorted(list(set([0.0, dur] + starts + ends)))
    speaking_intervals = []
    for i in range(len(points) - 1):
        start_point, end_point = points[i], points[i+1]
        if end_point - start_point < 0.01:
            continue
        mid_point = start_point + (end_point - start_point) / 2.0
        is_silent = any(s_start <= mid_point < s_end for s_start, s_end in silent_intervals)
        if not is_silent:
            speaking_intervals.append((start_point, end_point))

    if not speaking_intervals:
        return []

    padded: List[Tuple[float, float]] = []
    for s, e in speaking_intervals:
        padded_s = max(0.0, s - pad)
        padded_e = min(dur, e + pad)
        if not padded or padded_s > padded[-1][1]:
            padded.append((padded_s, padded_e))
        else:
            padded[-1] = (padded[-1][0], max(padded[-1][1], padded_e))

    return [(s, e) for s, e in padded if (e - s) >= keep]

# ---- Histogram Analysis ------------------------------------------------------

def analyze_levels(input_path: str, dur: float, on_progress=None) -> List[float]:
    """
    Analyzes audio levels by decoding the audio to raw PCM and calculating RMS
    values in Python with numpy. This method is highly reliable.
    """
    vals = []
    sample_rate = 8000
    chunk_duration = 0.2
    bytes_per_sample = 2
    chunk_size = int(sample_rate * chunk_duration * bytes_per_sample)
    total_bytes = int(dur * sample_rate * bytes_per_sample)

    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", input_path,
        "-f", "s16le",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-nostats",
        "-"
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **_popen_creation_flags()
    )
    ACTIVE_PROCESSES.append(proc)

    bytes_read = 0
    try:
        while not CANCEL.is_set():
            chunk = proc.stdout.read(chunk_size)
            if not chunk:
                break
            
            bytes_read += len(chunk)
            samples = np.frombuffer(chunk, dtype=np.int16)
            
            if samples.size > 0:
                rms = np.sqrt(np.mean(np.square(samples.astype(np.float64))))
                if rms > 0:
                    db = 20 * math.log10(rms / 32767.0)
                    vals.append(db)
                else:
                    vals.append(-120.0)

            if on_progress and total_bytes > 0:
                frac = min(1.0, bytes_read / total_bytes)
                on_progress(frac)
        
        if CANCEL.is_set():
            raise RuntimeError("CANCELLED")
    finally:
        try:
            proc.kill()
        except:
            pass
        if proc in ACTIVE_PROCESSES:
            ACTIVE_PROCESSES.remove(proc)
        proc.stdout.read()
        proc.stderr.read()
        proc.wait()
        
    if not vals and not CANCEL.is_set():
        stderr = proc.stderr.read().decode('utf-8', errors='replace')
        if "No such file or directory" in stderr or "Invalid argument" in stderr:
             raise RuntimeError(f"FFmpeg failed to open the file: {input_path}")
        if "Stream specifier" in stderr and "matches no streams" in stderr:
             raise RuntimeError("The input file does not contain an audio stream.")
        raise RuntimeError("Audio analysis failed: FFmpeg produced no audio data.")

    return vals