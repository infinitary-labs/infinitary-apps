"""INF-965: real detached children stopped at launch, including a later grandchild."""
import os
from pathlib import Path
import signal
import subprocess
import sys

mode, role, marker = sys.argv[1:]
if mode == "hold":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(f"fixture {role} {os.getpid()}", flush=True)
if role != "root":
    # Reproduce the observed Electron state, without relying on a spawn race.
    os.kill(os.getpid(), signal.SIGSTOP)
if role == "grandchild":
    if mode == "hold":
        while True:
            signal.pause()
    Path(marker).write_text("detached work completed")
else:
    child = subprocess.Popen(
        [sys.executable, __file__, mode, "child" if role == "root" else "grandchild", marker],
        start_new_session=True,
    )
    code = child.wait()
    if code != 0:
        sys.exit(1)
print(f"completed {role}", flush=True)
