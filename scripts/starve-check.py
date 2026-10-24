#!/usr/bin/env python3
"""INF-886: scheduling starvation on the command's owned process tree.

Detached sessions (including Playwright's Electron) stay descendants. Simulator
services started by launchd do not. Never signal a shared service or a lease.
The requested experiment has its own limit; ordinary test budgets stay unchanged.
"""
import argparse
import ctypes
import errno
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def positive(text):
    value = float(text)
    if not 0 < value < float("inf"):
        raise argparse.ArgumentTypeError("give a finite positive number of seconds")
    return value


class BsdInfo(ctypes.Structure):
    # Darwin's sys/proc_info.h: proc_bsdinfo, including the SDK's 16-byte comm.
    _fields_ = [
        (name, ctypes.c_uint32) for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
            "rgid", "svuid", "svgid", "reserved",
        )
    ] + [
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
        ("jobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64),
    ]


class DarwinProcesses:
    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                         ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listchildpids.restype = ctypes.c_int

    def info(self, pid):
        value = BsdInfo()
        # PROC_PIDTBSDINFO = 3; unlike sysctl kern.proc, this does not iterate
        # unrelated processes and wait for each one's exec transit (INF-982).
        size = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value))
        if size <= 0 and ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
            return None
        # Another user's process, such as the set-user-ID `ps` a journey's quit
        # runs: this user may neither read nor signal it, so it is not owned.
        if size <= 0 and ctypes.get_errno() == errno.EPERM:
            return None
        if size != ctypes.sizeof(value) or value.pid != pid:
            raise OSError(ctypes.get_errno(), f"Could not read owned process {pid}")
        # sys/proc.h: SSTOP = 4, SZOMB = 5. Other live states need no distinction.
        state = "T" if value.status == 4 else "Z" if value.status == 5 else "R"
        return (value.ppid, value.pgid, state, (value.start_sec, value.start_usec))

    def children(self, pid):
        # libproc returns a PID count, not bytes; its size query may overestimate.
        capacity = max(1, self.lib.proc_listchildpids(pid, None, 0))
        while True:
            values = (ctypes.c_int * capacity)()
            count = self.lib.proc_listchildpids(pid, values, ctypes.sizeof(values))
            if count < 0:
                if ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
                    return []
                raise OSError(ctypes.get_errno(), f"Could not list children of {pid}")
            if count < capacity:
                return [value for value in values[:count] if value > 0]
            capacity *= 2


class LinuxProcesses:
    def info(self, pid):
        try:
            # /proc's comm may contain spaces and ')'; the fields follow its last ')'.
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            return None
        state = "T" if fields[0] in ("T", "t") else fields[0]
        return (int(fields[1]), int(fields[2]), state, fields[19])

    def children(self, pid):
        # A child may have been forked by any thread of this owned process.
        try:
            threads = list(Path(f"/proc/{pid}/task").iterdir())
        except (FileNotFoundError, ProcessLookupError):
            return []
        found = set()
        for thread in threads:
            try:
                found.update(int(value) for value in (thread / "children").read_text().split())
            except (FileNotFoundError, ProcessLookupError):
                pass
        return sorted(found)


def process_reader():
    if sys.platform == "darwin":
        return DarwinProcesses()
    if sys.platform.startswith("linux"):
        return LinuxProcesses()
    raise RuntimeError("Owned-process starvation requires macOS or Linux")


class OwnedTree:
    def __init__(self, child):
        self.child = child
        self.known = {}
        self.paused = {}
        self.reader = process_reader()
        row = self.reader.info(child.pid)
        if row:
            self.known[child.pid] = row[3]

    def live(self):
        owned = {}
        pending = list(self.known.items())
        # Query only known identities and their children, never the whole Mac.
        # Known children remain owned after reparenting or changing session.
        while pending:
            pid, started = pending.pop()
            row = self.reader.info(pid)
            if not row or row[3] != started or row[2] == "Z":
                if self.known.get(pid) == started:
                    self.known.pop(pid, None)
                continue
            if pid in owned:
                continue
            children = self.reader.children(pid)
            parent = self.reader.info(pid)
            if not parent or parent[3] != started or parent[2] == "Z":
                continue
            owned[pid] = parent
            for child in children:
                if child in owned:
                    continue
                value = self.reader.info(child)
                if not value or value[0] != pid or value[2] == "Z":
                    continue
                if self.known.get(child) != value[3]:
                    print(f"Starvation: tracking descendant {child}, parent {pid}, group {value[1]}", flush=True)
                self.known[child] = value[3]
                pending.append((child, value[3]))
        return owned

    @staticmethod
    def send(rows, number):
        for pid in rows:
            try:
                os.kill(pid, number)
            except ProcessLookupError:
                pass

    def freeze(self, stopping):
        # Stop observed parents, then rescan until every descendant is stopped.
        # Individual signals cannot strand a child changing its process group
        # between a group SIGSTOP and SIGCONT (INF-965).
        while not stopping():
            rows = self.live()
            # Remember the exact owned pause set before sending STOP, including
            # children already stopped at exec. A later inspection may fail.
            self.paused = rows
            running = {pid: row for pid, row in rows.items() if "T" not in row[2]}
            if not running:
                return rows
            self.send(running, signal.SIGSTOP)
            time.sleep(0)  # Yield while the observed processes enter their stopped state.
        return {}

    def resume(self):
        # No new discovery is needed to release a captured pause. Still recheck
        # each owned identity: an external kill must not let PID reuse signal a stranger.
        current = {}
        for pid, paused in self.paused.items():
            row = self.reader.info(pid)
            if row and row[3] == paused[3] and row[2] != "Z":
                current[pid] = row
        self.send(current, signal.SIGCONT)
        self.paused = {}

    def close(self):
        self.resume()
        # GitHub cancellation allows ten seconds. Give the owned command five
        # to clean up, then kill survivors, including stopped detached children.
        ending = time.monotonic() + 5
        signalled = set()
        while True:
            rows = self.live()
            if not rows:
                break
            fresh = {pid: row for pid, row in rows.items() if pid not in signalled}
            self.send(fresh, signal.SIGTERM)
            signalled.update(fresh)
            self.send(rows, signal.SIGCONT)
            if time.monotonic() >= ending:
                self.send(rows, signal.SIGKILL)
                break
            self.child.poll()
            time.sleep(0.05)
        self.child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=positive, required=True, help="experiment limit in seconds")
    parser.add_argument("--run-seconds", type=positive, default=0.1)
    parser.add_argument("--pause-seconds", type=positive, default=0.2)
    parser.add_argument("--stall-every", type=positive, default=20)
    parser.add_argument("--stall-seconds", type=positive, default=65)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("pass the check command after --")

    interrupted = None

    def interrupt(number, _frame):
        nonlocal interrupted
        interrupted = number

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupt)

    started = time.monotonic()
    deadline = started + args.timeout
    print(f"Starvation: run {args.run_seconds}s, pause {args.pause_seconds}s, "
          f"stall {args.stall_seconds}s after each {args.stall_every}s of throttled execution; "
          f"owned descendants including detached sessions; experiment limit {args.timeout}s", flush=True)
    # Record the root before it can spawn children or finish. If inspection
    # fails, closing the pipe ends the gate without ever starting the command.
    gate_read, gate_write = os.pipe()
    gate = """
import os, signal, sys
for number in (signal.SIGINT, signal.SIGPIPE, signal.SIGXFSZ):
    signal.signal(number, signal.SIG_DFL)
fd = int(sys.argv[1])
go = os.read(fd, 1)
os.close(fd)
if not go:
    sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
"""
    child = subprocess.Popen(
        [sys.executable, "-c", gate, str(gate_read), *command],
        pass_fds=(gate_read,), start_new_session=True,
    )
    os.close(gate_read)
    try:
        tree = OwnedTree(child)
        os.write(gate_write, b"1")
    finally:
        os.close(gate_write)

    def stopping():
        return interrupted is not None or time.monotonic() >= deadline or child.poll() is not None

    def rest(seconds):
        until = min(time.monotonic() + seconds, deadline)
        while not stopping() and time.monotonic() < until:
            time.sleep(min(0.05, max(0, until - time.monotonic())))

    next_stall = started + args.stall_every
    stalls = 0
    status = 1
    try:
        while not stopping():
            rest(args.run_seconds)
            stopped = tree.freeze(stopping)
            now = time.monotonic()
            pause = args.pause_seconds
            if now >= next_stall and not stopping():
                pause = args.stall_seconds
                next_stall = now + pause + args.stall_every
                stalls += 1
                states = ",".join(f"{pid}:{row[2]}" for pid, row in stopped.items())
                print(f"Starvation: stall {stalls} at {now - started:.1f}s; stopped {states}", flush=True)
            rest(pause)
            tree.resume()
        if interrupted is not None:
            status = 128 + interrupted
        elif child.poll() is not None:
            status = child.returncode if child.returncode >= 0 else 128 - child.returncode
        else:
            print("Starvation: experiment limit reached; stopping the owned process tree", flush=True)
            status = 124
    finally:
        tree.close()
    print(f"Starvation: command exited {status}; {stalls} long stalls; owned tree cleaned", flush=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
