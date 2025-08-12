import json
import os
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:  # fallback if tkinterdnd2 isn't installed
    TkinterDnD = tk.Tk  # type: ignore
    DND_FILES = "DND_Files"

import trim
from taskbar import TaskbarProgress


def _load_defaults():
    cfg_path = os.path.join(os.path.dirname(__file__), ".vscode", "launch.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    inputs = {i["id"]: i for i in data.get("inputs", [])}
    def _range(id_):
        opts = [float(o) for o in inputs[id_]["options"]]
        return min(opts), max(opts)
    defaults = {
        "noise": float(inputs["noiseValue"]["default"]),
        "silence": float(inputs["minSilence"]["default"]),
        "pad": float(inputs["pad"]["default"]),
        "keep": float(inputs["minKeep"]["default"]),
    }
    ranges = {
        "noise": (-30.0, -20.0),  # expanded range
        "silence": _range("minSilence"),
        "pad": _range("pad"),
        "keep": _range("minKeep"),
    }
    return defaults, ranges


class AutoTrimApp(TkinterDnD):
    def __init__(self):
        super().__init__()
        self.title("AutoTrim")
        defaults, ranges = _load_defaults()

        self.video_path = tk.StringVar()
        self.noise = tk.DoubleVar(value=defaults["noise"])
        self.silence = tk.DoubleVar(value=defaults["silence"])
        self.pad = tk.DoubleVar(value=defaults["pad"])
        self.keep = tk.DoubleVar(value=defaults["keep"])
        self.progress = tk.DoubleVar(value=0.0)
        self._taskbar = TaskbarProgress(self.winfo_id())

        self._build_ui(ranges)

    def _build_ui(self, ranges):
        frame = ttk.Frame(self)
        frame.pack(fill="both", expand=True, padx=10, pady=10)

        entry = ttk.Entry(frame, textvariable=self.video_path, width=60)
        entry.pack(fill="x")
        try:
            entry.drop_target_register(DND_FILES)
            entry.dnd_bind("<<Drop>>", self._on_drop)
        except Exception:
            pass
        ttk.Button(frame, text="Browse", command=self._browse).pack(pady=5)

        self._add_slider(frame, "Noise threshold (dB)", self.noise, ranges["noise"], 0.1)
        self._add_slider(frame, "Min silence (s)", self.silence, ranges["silence"], 0.01)
        self._add_slider(frame, "Padding (s)", self.pad, ranges["pad"], 0.01)
        self._add_slider(frame, "Min keep (s)", self.keep, ranges["keep"], 0.01)

        self.progress_bar = ttk.Progressbar(frame, variable=self.progress, maximum=100)
        self.progress_bar.pack(fill="x", pady=10)

        ttk.Button(frame, text="Trim", command=self._start).pack()

    def _add_slider(self, parent, label, var, rng, step):
        box = ttk.Frame(parent)
        box.pack(fill="x", pady=5)
        ttk.Label(box, text=label).pack(anchor="w")
        scale = ttk.Scale(box, from_=rng[0], to=rng[1], variable=var, orient="horizontal")
        scale.pack(fill="x")
        val = ttk.Label(box)
        val.pack(anchor="e")
        def update(*_):
            val.config(text=f"{var.get():.2f}")
        var.trace_add("write", update)
        update()

    def _on_drop(self, event):
        self.video_path.set(event.data.strip("{}"))

    def _browse(self):
        path = filedialog.askopenfilename(filetypes=[("Videos", "*.mp4;*.mov;*.mkv;*.avi"), ("All", "*.*")])
        if path:
            self.video_path.set(path)

    def _start(self):
        if not self.video_path.get():
            messagebox.showerror("Error", "Please select a video file.")
            return
        threading.Thread(target=self._run_trim, daemon=True).start()

    def _run_trim(self):
        try:
            self.progress_bar.config(mode="indeterminate")
            self.progress_bar.start()
            self._taskbar.indeterminate()
            output_dir = os.path.join(os.path.expanduser("~"), "Downloads")
            base = os.path.splitext(os.path.basename(self.video_path.get()))[0]
            out_path = os.path.join(output_dir, f"{base}_trimmed.mp4")

            def update_prog(p):
                self.progress.set(p * 100)
                self._taskbar.set(int(p * 100), 100)

            # detection + trimming
            starts, ends, _ = trim.detect_silences(self.video_path.get(), self.noise.get(), self.silence.get())
            dur = trim.ffprobe_duration(self.video_path.get())
            segs = trim.build_speaking_segments(starts, ends, dur, self.pad.get(), self.keep.get())

            self.progress_bar.stop()
            self.progress_bar.config(mode="determinate")
            self.progress.set(0)
            self._taskbar.set(0, 100)
            trim.cut_and_concat(self.video_path.get(), segs, out_path, progress=update_prog)
            messagebox.showinfo("Done", f"Saved to {out_path}")
        except Exception as e:
            messagebox.showerror("Error", str(e))
        finally:
            self.progress.set(0)
            self.progress_bar.stop()
            self._taskbar.clear()


if __name__ == "__main__":
    app = AutoTrimApp()
    app.mainloop()
