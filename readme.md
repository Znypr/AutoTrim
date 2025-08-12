# Trim Silence from Video

A Python tool to automatically remove low-volume pauses from a video using FFmpeg, producing a clean, concise version without altering quality.

## Features
- Detects and trims silence based on a user-defined noise threshold.
- Adjustable parameters: silence threshold, min silence length, padding, and min clip keep length.
- Lossless cutting using FFmpeg (no re-encoding).
- Optional audio loudness histogram generation.
- Progress bar for detection, processing, and rendering steps.
- Windows taskbar progress indicator when the window is minimized.

## Requirements
- Python 3.8+
- FFmpeg installed and available in PATH
- Python packages:
  - matplotlib (only if using `--hist`)

## Installation
pip install matplotlib  # optional, only for histogram support

## Usage
Basic example:
python trim_silence.py input.mp4 --noise=-21dB --silence=0.2 --pad=0.125 --keep=1.25

With histogram:
python trim_silence.py input.mp4 --noise=-21dB --silence=0.2 --pad=0.125 --keep=1.25 --hist --bins=3 --min_db=-40 --max_db=0

## License
MIT License
