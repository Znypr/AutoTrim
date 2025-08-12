#!/usr/bin/env python3
"""Build a standalone AutoTrim.exe using PyInstaller.
Run this on Windows after installing PyInstaller:

    pip install pyinstaller
    python build_exe.py
"""
import shutil
import subprocess
import sys


def main() -> None:
    if shutil.which("pyinstaller") is None:
        print("PyInstaller is required. Install it with 'pip install pyinstaller'.")
        sys.exit(1)
    cmd = [
        "pyinstaller",
        "--onefile",
        "--windowed",
        "--name", "AutoTrim",
        "gui.py",
    ]
    subprocess.check_call(cmd)
    print("Executable created at dist/AutoTrim.exe")


if __name__ == "__main__":
    main()
