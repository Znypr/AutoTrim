# file: debug_audio.py
import subprocess
import sys
import re
import math
import os

def _popen_creation_flags():
    """Returns Popen kwargs for a hidden window on Windows."""
    if os.name == "nt":
        return {"creationflags": 0x08000000}
    return {}

def run_test(video_path):
    """Runs a standalone FFmpeg test to diagnose the audio analysis issue."""
    if not os.path.exists(video_path):
        print(f"--- ERROR: File not found at '{video_path}'")
        return

    print("--- Starting FFmpeg Audio Analysis Test ---")

    # This is the command we are testing.
    command = [
        "ffmpeg", "-hide_banner", "-y",
        "-fflags", "+genpts",
        "-i", video_path,
        "-af", "astats=metadata=1:reset=1,ametadata=mode=print:file=-:key=lavfi.astats.RMS_level",
        "-f", "null", "-"
    ]

    print("\n[1] Running FFmpeg with the following command:")
    # Use shlex.quote for safe printing
    try:
        import shlex
        print("    " + " ".join(shlex.quote(c) for c in command))
    except ImportError:
        print("    " + str(command))


    try:
        # Run the command and capture all output
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            **_popen_creation_flags()
        )

        print("\n[2] FFmpeg process finished.")
        print(f"    Return Code: {result.returncode}")

        print("\n[3] Raw Standard Error (stderr) from FFmpeg:")
        print("    " + "-"*50)
        # Indent stderr for readability
        stderr_output = result.stderr.strip()
        if not stderr_output:
            print("    (stderr was empty)")
        else:
            for line in stderr_output.splitlines():
                print(f"    {line}")
        print("    " + "-"*50)


        print("\n[4] Raw Standard Output (stdout) from FFmpeg:")
        print("    " + "-"*50)
        # Indent stdout for readability
        stdout_output = result.stdout.strip()
        if not stdout_output:
             print("    (stdout was empty)")
        else:
            for line in stdout_output.splitlines():
                print(f"    {line}")
        print("    " + "-"*50)


        print("\n[5] Parsing stdout for RMS values...")
        vals = []
        pat = re.compile(r"lavfi\.astats\.RMS_level=([-+]?\d+(?:\.\d+)?)")
        for line in stdout_output.splitlines():
            if m := pat.search(line):
                try:
                    vals.append(float(m.group(1)))
                except (ValueError, IndexError):
                    continue
        
        print(f"    Found {len(vals)} RMS values.")


    except FileNotFoundError:
        print("\n--- FATAL ERROR ---")
        print("    'ffmpeg' was not found in your system's PATH.")
        print("    Please ensure FFmpeg is installed and accessible.")
    except Exception as e:
        print(f"\n--- An unexpected Python error occurred: {e}")

    print("\n--- Test Complete ---")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python debug_audio.py \"C:\\path\\to\\your\\video.mp4\"")
    else:
        run_test(sys.argv[1])