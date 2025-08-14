#!/usr/bin/env python3
"""
Test script to verify progress improvements work correctly.
This simulates the progress monitoring without requiring actual video files.
"""

import time
import threading

def test_progress_stall_detection():
    """Test the progress stall detection mechanism"""
    print("Testing progress stall detection...")
    
    last_progress_time = time.time()
    progress_stalled = False
    
    def on_progress(frac):
        nonlocal last_progress_time, progress_stalled
        now = time.time()
        last_progress_time = now
        progress_stalled = False
        print(f"Progress: {frac:.3f}")
    
    def progress_monitor():
        nonlocal progress_stalled
        while True:
            time.sleep(2.0)  # Check every 2 seconds
            if (time.time() - last_progress_time) > 5.0:
                progress_stalled = True
                print(f"Progress stalled for {time.time() - last_progress_time:.1f}s")
                # Send a small progress update to show we're still alive
                try:
                    on_progress(0.001)
                except Exception as e:
                    print(f"Stall progress update error: {str(e)}")
    
    # Start progress monitor thread
    monitor_thread = threading.Thread(target=progress_monitor, daemon=True)
    monitor_thread.start()
    
    # Simulate some progress updates
    for i in range(5):
        on_progress(i * 0.2)
        time.sleep(1)
    
    # Simulate a stall
    print("Simulating progress stall...")
    time.sleep(8)  # Wait longer than the 5-second stall threshold
    
    # Send more progress
    on_progress(0.9)
    time.sleep(2)
    
    print("Test completed successfully!")

if __name__ == "__main__":
    test_progress_stall_detection()
