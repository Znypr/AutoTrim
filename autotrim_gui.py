import os
import sys
import tempfile
import threading
import subprocess

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import trim

SPOTIFY_BG = "#121212"
SPOTIFY_CARD = "#181818"
SPOTIFY_TXT = "#EAEAEA"
SPOTIFY_MUTE = "#AAAAAA"
SPOTIFY_ACCENT = "#1DB954"

def resource_path(rel_path: str) -> str:
    # Works in dev and PyInstaller
    base = getattr(sys, "_MEIPASS", os.path.dirname(__file__))
    return os.path.join(base, rel_path)


def _hidden_popen_kwargs():
    import os, sys, subprocess
    if os.name == "nt" and (getattr(sys, "frozen", False) or getattr(sys, "stderr", None) is None):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        CREATE_NO_WINDOW = 0x08000000
        return {"startupinfo": si, "creationflags": CREATE_NO_WINDOW}
    return {}

def _ff_kwargs():
    return getattr(trim, "_popen_hidden_kwargs", _hidden_popen_kwargs)()


def _fmt_size(nbytes):
    units = ["B","KB","MB","GB","TB"]
    i = 0
    v = float(nbytes)
    while v >= 1024 and i < len(units)-1:
        v /= 1024.0; i += 1
    return f"{v:.1f} {units[i]}"

def _fmt_dur(sec):
    sec = float(sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


# --- Ensure correct taskbar icon / grouping on Windows ---
import ctypes
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Znypr.AutoTrim")
except Exception:
    pass


class AutoTrimApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("AutoTrim")

        # set window icon (works in dev + frozen)
        try:
            self.iconbitmap(default=resource_path("autotrim.ico"))
        except Exception:
            pass

        self.configure(bg=SPOTIFY_BG)

        # sensible default; will expand to content
        self.geometry("880x720")
        self.after(50, self._fit_to_content)

        self.selected_file = tk.StringVar(value="")
        self.noise_db = tk.DoubleVar(value=-20.0)
        self.silence_s = tk.DoubleVar(value=0.5)
        self.pad_s     = tk.DoubleVar(value=0.17)
        self.keep_s    = tk.DoubleVar(value=0.75)
        self.progress  = tk.DoubleVar(value=0.0)
        self.status_txt= tk.StringVar(value="Idle.")
        self.thumb_img = None
        self.thumb_path = None
        self._build_style()
        self._build_ui()



        self.is_running = False

    def _fit_to_content(self):
        self.update_idletasks()
        self.minsize(self.winfo_reqwidth()+24, self.winfo_reqheight()+24)


    def _card(self, parent, title):
        frame = ttk.Frame(parent, style="Card.TFrame", padding=16)
        lab = ttk.Label(frame, text=title, style="Label.TLabel", font=("Segoe UI", 11, "bold"))
        lab.pack(anchor="w", pady=(0,10))
        frame.pack(fill="x", padx=16, pady=12)
        return frame

    def _build_style(self):
        style = ttk.Style(self)

        try: style.theme_use("clam")
        except: pass

        # Minimal dark theme
        self.configure(bg=SPOTIFY_BG)
        style.configure(".", background=SPOTIFY_BG, foreground=SPOTIFY_TXT)
        style.configure("Toolbar.TFrame", background="#0F0F0F")
        style.configure("Card.TFrame", background="#161616")
        style.configure("Muted.TLabel", background="#161616", foreground="#9EA0A6")
        style.configure("Title.TLabel", background=SPOTIFY_BG, font=("Segoe UI", 13, "semibold"))
        style.configure("TButton", background=SPOTIFY_ACCENT, foreground="#000",
                        font=("Segoe UI", 10, "bold"), padding=8)
        style.map("TButton", background=[("active", "#1ed760")])
        style.configure("Thin.Horizontal.TProgressbar", troughcolor="#232323", background=SPOTIFY_ACCENT)
        style.configure("Compact.Horizontal.TScale", troughcolor="#232323", background="#2a2a2a")

    def _build_ui(self):
        # WINDOW
        self.geometry("980x620")
        self.grid_rowconfigure(1, weight=1)
        self.grid_columnconfigure(0, weight=1)

        # HEADER
        head = ttk.Frame(self, style="Toolbar.TFrame", padding=(16, 10))
        head.grid(row=0, column=0, sticky="ew")
        head.grid_columnconfigure(1, weight=1)

        ttk.Label(head, text="AutoTrim", style="Title.TLabel").grid(row=0, column=0, sticky="w", padx=(0,12))
        # select + meta inline
        self.pick_btn = ttk.Button(head, text="Select video…", command=self._select_file)
        self.pick_btn.grid(row=0, column=2, sticky="e")
        self.meta_lbl = ttk.Label(head, text="", style="Muted.TLabel")
        self.meta_lbl.grid(row=0, column=1, sticky="w")

        # MAIN: two columns
        main = ttk.Frame(self, style="Card.TFrame", padding=14)
        main.grid(row=1, column=0, sticky="nsew", padx=16, pady=12)
        main.grid_columnconfigure(0, weight=1)   # preview
        main.grid_columnconfigure(1, weight=0)   # controls
        main.grid_rowconfigure(0, weight=1)

        # LEFT: preview
        left = ttk.Frame(main, style="Card.TFrame")
        left.grid(row=0, column=0, sticky="nsew", padx=(0,14))
        self.thumb_canvas = tk.Label(left, bg="#161616")
        self.thumb_canvas.pack(anchor="w", fill="both", expand=True)

        # RIGHT: controls (compact)
        right = ttk.Frame(main, style="Card.TFrame")
        right.grid(row=0, column=1, sticky="n", ipadx=6)

        def slider_row(parent, label, var, fr, to, step, suffix=""):
            wrap = ttk.Frame(parent, style="Card.TFrame")
            wrap.pack(fill="x", pady=6)
            top = ttk.Frame(wrap, style="Card.TFrame")
            top.pack(fill="x")
            ttk.Label(top, text=label).pack(side="left")
            val = ttk.Label(top, text="", style="Muted.TLabel")
            val.pack(side="right")
            def fmt(*_):
                v = var.get()
                txt = f"{v:.2f}{suffix}" if (abs(v) < 1 and not suffix) else f"{v:.1f}{suffix}"
                val.config(text=txt)
            s = ttk.Scale(wrap, from_=fr, to=to, orient="horizontal",
                        variable=var, command=lambda _ : fmt(), style="Compact.Horizontal.TScale", length=320)
            s.pack(fill="x")
            fmt()

        ttk.Label(right, text="Parameters", font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(0,4))
        slider_row(right, "Noise threshold (dBFS)", self.noise_db, -30.0, -20.0, 0.1, " dB")
        slider_row(right, "Min silence (s)", self.silence_s, 0.2, 2.0, 0.05)
        slider_row(right, "Pad (s)", self.pad_s, 0.00, 0.50, 0.01)
        slider_row(right, "Min clip (s)", self.keep_s, 0.25, 5.0, 0.05)

        # FOOTER: status bar
        foot = ttk.Frame(self, style="Toolbar.TFrame", padding=(16, 10))
        foot.grid(row=2, column=0, sticky="ew")
        foot.grid_columnconfigure(0, weight=1)
        self.out_lbl = ttk.Label(foot, text="Output → (select a file)", style="Muted.TLabel")
        self.out_lbl.grid(row=0, column=0, sticky="w")
        self.start_btn = ttk.Button(foot, text="Start", command=self._start, state="disabled")
        self.start_btn.grid(row=0, column=1, sticky="e")

        # Progress line (thin)
        self.status_lbl = ttk.Label(foot, textvariable=self.status_txt, style="Muted.TLabel")
        self.status_lbl.grid(row=1, column=0, sticky="w", pady=(6,0))
        self.prog = ttk.Progressbar(foot, variable=self.progress, maximum=1.0,
                                    mode="determinate", style="Thin.Horizontal.TProgressbar")
        self.prog.grid(row=1, column=1, sticky="ew", padx=(12,0))


    def _add_slider(self, parent, label, var, fr, to, step, suffix=""):
        row = ttk.Frame(parent, style="Card.TFrame")
        row.pack(fill="x", pady=8)
        ttk.Label(row, text=label, style="Label.TLabel").pack(anchor="w")
        wrap = ttk.Frame(row, style="Card.TFrame")
        wrap.pack(fill="x")
        val = ttk.Label(wrap, text="", style="Small.TLabel")
        val.pack(side="right")
        def update_val(*_):
            v = var.get()
            val.config(text=f"{v:.2f}{suffix}" if abs(v) < 1 and not suffix else f"{v:.1f}{suffix}")
        s = ttk.Scale(wrap, from_=fr, to=to, orient="horizontal", variable=var, command=lambda _ : update_val())
        s.pack(fill="x", padx=4, pady=2)
        s.configure(length=520)
        update_val()

    def _select_file(self):
        f = filedialog.askopenfilename(
            title="Choose a video",
            filetypes=[("Video files", "*.mp4 *.mov *.mkv *.m4v *.avi *.webm"), ("All files", "*.*")]
        )
        if not f: return
        self._set_file(f)

    def _set_file(self, path):
        self.selected_file.set(path)
        out = os.path.join(os.path.expanduser("~"), "Downloads",
                           f"{os.path.splitext(os.path.basename(path))[0]}_trimmed.mp4")
        self.out_lbl.config(text=f"Output → {out}")
        self.start_btn.config(state="normal")
        # metadata + thumbnail
        try:
            dur = trim.ffprobe_duration(path)
            size = os.path.getsize(path)
            title = os.path.basename(path)
            self.meta_lbl.config(text=f"{title}   •   {_fmt_dur(dur)}   •   {_fmt_size(size)}")
            self._make_thumbnail(path)
        except Exception as e:
            self.meta_lbl.config(text=f"(metadata error: {e})")
        self._fit_to_content()

    def _make_thumbnail(self, path):
        # extract one frame to PNG (no console window)
        tmp = os.path.join(tempfile.gettempdir(), "autotrim_thumb.png")
        cmd = ["ffmpeg","-hide_banner","-y","-ss","00:00:01","-i", path, "-frames:v","1","-vf","scale=480:-1", tmp]
        try:
            # use hidden popen from trim helper
            kwargs = _ff_kwargs()


            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
            self.thumb_path = tmp
            self.thumb_img = tk.PhotoImage(file=tmp)
            self.thumb_canvas.configure(image=self.thumb_img, width=self.thumb_img.width(), height=self.thumb_img.height())
        except Exception:
            self.thumb_canvas.configure(image="", width=0, height=0)

    def _update_step(self, label: str, frac: float) -> None:
        self.progress.set(frac)
        self.status_txt.set(f"{label} {int(frac*100)}%")

    def _finish_message(self, msg: str) -> None:
        self.status_txt.set(msg)
        self.start_btn.config(state="normal")
        self.is_running = False

    def _finish_success(self, out_path: str) -> None:
        self.progress.set(1.0)
        self._finish_message(f"\u2714 Done. Saved to: {out_path}")

    def _finish_error(self, err) -> None:
        self._finish_message(f"Error: {err}")
        messagebox.showerror("AutoTrim error", str(err))

    # ----- run pipeline -----
    def _start(self):
        if self.is_running:
            return
        path = self.selected_file.get()
        if not path:
            messagebox.showwarning("No file", "Please select a video.")
            return
        self.is_running = True
        self._update_step("Step 1/2 — Detecting silences…", 0.0)
        self.start_btn.config(state="disabled")
        threading.Thread(target=self._run_pipeline, args=(path,), daemon=True).start()

    def _run_pipeline(self, input_path):
        try:
            dur = trim.ffprobe_duration(input_path)

            # Step 1: detect (reusing progress bar with textual status)
            def on_detect(frac):
                self.after(0, self._update_step, "Step 1/2 — Detecting silences…", frac)
            # Run ffmpeg detection with progress
            noise = f"{self.noise_db.get()}dB"
            silence = float(self.silence_s.get())
            # Build command exactly like detect_silences, but pass our on_progress
            cmd = [
                "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",
                "-i", input_path,
                "-af", f"silencedetect=noise={trim._noise_for_ffmpeg(noise)}:d={silence}",
                "-f","null","-"
            ]
            txt = trim.run_ffmpeg_progress(cmd, dur, "detect", on_progress=on_detect)
            import re
            starts = [float(x) for x in re.findall(r"silence_start:\s*(\d+(?:\.\d+)?)", txt)]
            ends   = [float(x) for x in re.findall(r"silence_end:\s*(\d+(?:\.\d+)?)", txt)]

            pad  = float(self.pad_s.get())
            keep = float(self.keep_s.get())
            segments = trim.build_speaking_segments(starts, ends, dur, pad, keep)
            if not segments:
                self.after(0, self._finish_message, "No keepable segments found.")
                return

            # Step 2: render
            self.after(0, self._update_step, "Step 2/2 — Rendering…", 0.0)
            out = os.path.join(os.path.expanduser("~"), "Downloads",
                               f"{os.path.splitext(os.path.basename(input_path))[0]}_trimmed.mp4")

            eps = 0.010
            clips = [(max(0.0, s), max(0.0, e - eps)) for s, e in segments if e - s > eps]
            vf, af = [], []
            for i, (st, et) in enumerate(clips):
                vf.append(f"[0:v]trim=start={st:.6f}:end={et:.6f},setpts=PTS-STARTPTS[v{i}]")
                af.append(f"[0:a]atrim=start={st:.6f}:end={et:.6f},asetpts=PTS-STARTPTS[a{i}]")
            concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
            filter_complex = ";".join(vf + af + [f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v][a]"])
            total = sum(et - st for st, et in clips)

            cmd = [
                "ffmpeg","-hide_banner","-nostats","-progress","pipe:1","-y",
                "-i", input_path,
                "-filter_complex", filter_complex,
                "-map","[v]","-map","[a]",
                "-c:v","libx264","-preset","veryfast","-crf","20",
                "-c:a","aac","-b:a","160k",
                "-movflags","+faststart",
                out
            ]
            def on_render(frac):
                self.after(0, self._update_step, "Step 2/2 — Rendering…", frac)
            trim.run_ffmpeg_progress(cmd, total, "render", on_progress=on_render)
            self.after(0, self._finish_success, out)
        except Exception as e:
            self.after(0, self._finish_error, e)

            
if __name__ == "__main__":
    try:
        app = AutoTrimApp()
        app.mainloop()
    except Exception as e:
        import traceback, tkinter as tk
        from tkinter import messagebox
        tk.Tk().withdraw()
        messagebox.showerror("AutoTrim startup error", traceback.format_exc())
