"""INF-1145: a parent blocked in vfork while its child waits before exec.

glibc's posix_spawn clones with CLONE_VFORK; the child's file action opens a
FIFO and waits there, before exec, until a sibling opens the other end.
"""
import os
import sys
import time

gate = sys.argv[1]
os.mkfifo(gate)
print(f"fixture root {os.getpid()}", flush=True)
opener = os.fork()
if opener == 0:
    # Long enough for several freezes to find the parent in its vfork wait.
    time.sleep(1)
    os.close(os.open(gate, os.O_WRONLY))
    os._exit(0)
child = os.posix_spawn(sys.executable, [sys.executable, "-c", "pass"], os.environ,
                       file_actions=[(os.POSIX_SPAWN_OPEN, 0, gate, os.O_RDONLY, 0)])
_, status = os.waitpid(child, 0)
_, opened = os.waitpid(opener, 0)
if status != 0 or opened != 0:
    sys.exit(1)
print("completed root", flush=True)
