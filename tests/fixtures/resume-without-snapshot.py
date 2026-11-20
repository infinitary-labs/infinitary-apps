"""INF-886: release an observed stopped child even if fresh discovery cannot answer."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys

spec = importlib.util.spec_from_file_location(
    "starve_check", Path(__file__).resolve().parents[2] / "scripts/starve-check.py"
)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
marker = sys.argv[1]
child = subprocess.Popen(
    [sys.executable, "-c", """
import os, signal, sys
from pathlib import Path
print("ready", flush=True)
os.kill(os.getpid(), signal.SIGSTOP)
Path(sys.argv[1]).write_text("resumed work completed")
""", marker],
    stdout=subprocess.PIPE, text=True, start_new_session=True,
)
tree = controller.OwnedTree(child)
original_live = tree.live
try:
    assert child.stdout.readline().strip() == "ready"
    # Readiness precedes the child's own SIGSTOP. Observe that stop first, or
    # freeze/resume can finish before the child executes a second, later stop.
    pid, status = os.waitpid(child.pid, os.WUNTRACED)
    assert pid == child.pid and os.WIFSTOPPED(status)
    assert os.WSTOPSIG(status) == signal.SIGSTOP
    stopped = tree.freeze(lambda: False)
    assert "T" in stopped[child.pid][2]

    def unavailable():
        raise RuntimeError("A fresh process inspection cannot answer while the child is stopped")

    tree.live = unavailable
    tree.resume()
    assert child.wait(timeout=5) == 0
finally:
    tree.live = original_live
    tree.close()
    child.stdout.close()
