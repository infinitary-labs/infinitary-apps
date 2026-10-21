#!/usr/bin/env python3
"""CI build/test lease: parallel shared commands, exclusive native commands.

INF-79 review-cap choice: desktop journeys keep running side by side; phones
wait for them and for one another. The kernel's file lock is the lease: only
this helper holds it, as the command's parent, so it ends when the command
ends, whatever the command left running (INF-649).

A record beside the lock says who holds the lease, since when and for how long
at most. It never grants or blocks anything; a waiting check reads it to take
the lease back from a holder whose command has ended, or one held past its
limit, and to stop a command whose holder died. Waiting checks print why.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

# How often a waiting check tries the lock, and how often it reads the records.
POLL = 0.2
SWEEP = 1.0
# How long a command being stopped gets between SIGTERM and SIGKILL. GitHub's
# own cancellation gives 10 seconds; a phone gate deletes its simulator.
GRACE = 30
# A command whose lease was taken back fails with timeout(1)'s status.
TAKEN_BACK = 124
FORWARDED = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def lock_file(path):
    # Never unlink these files: all runner slots must keep locking the same inode.
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        raise RuntimeError("The Mac check lease must be a regular file owned by this runner user")
    return os.fdopen(fd, "rb", buffering=0)


def records_folder(lock):
    folder = lock.with_name(lock.name + ".holders")
    try:
        folder.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = os.lstat(folder)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("The Mac check lease's records must be a folder owned by this runner user")
    return folder


def duration(text):
    match = re.fullmatch(r"(\d+)([smh])", text)
    if not match or int(match[1]) == 0:
        raise argparse.ArgumentTypeError("give a whole number of s, m or h, such as 40m")
    return int(match[1]) * {"s": 1, "m": 60, "h": 3600}[match[2]]


def span(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    hours, minutes = divmod(seconds // 60, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m"


def started(pid):
    """When a live process started, which tells it from a later one given the same id."""
    out = subprocess.run(
        ["ps", "-o", "stat=", "-o", "lstart=", "-p", str(pid)],
        capture_output=True,
        text=True,
        env={**os.environ, "LC_ALL": "C"},
    ).stdout
    fields = out.split(None, 1)
    if len(fields) < 2 or fields[0].startswith("Z"):
        return None
    return " ".join(fields[1].split())


def signal_group(group, number):
    try:
        os.killpg(group, number)
    except (ProcessLookupError, PermissionError):
        pass


def remove(path):
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def write(path, data):
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(data, out)
    os.replace(temp, path)


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def command_text(record):
    command = " ".join(record["command"].split())
    return command if len(command) <= 80 else command[:77] + "..."


def describe(record):
    job = f" in {record['job']}" if record.get("job") else ""
    return f"pid {record['pid']} ({command_text(record)}){job}"


class Sweep:
    """What one check has done about the records, so it acts and speaks once."""

    def __init__(self, me):
        self.me = me
        self.ended = set()
        self.killed = set()
        self.acted = False

    def stop(self, record, note, line, reason):
        """SIGTERM the record's command once for every check; SIGKILL it after GRACE."""
        try:
            fd = os.open(note, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            asked = (read(note) or {}).get("asked", time.time())
            if time.time() - asked > GRACE and record["pid"] not in self.killed:
                self.killed.add(record["pid"])
                print(
                    f"Mac checks: {describe(record)} did not stop within {span(GRACE)}; killing it",
                    flush=True,
                )
                signal_group(record["group"], signal.SIGKILL)
            return
        with os.fdopen(fd, "w") as out:
            json.dump({"asked": time.time(), "reason": reason}, out)
        print(line, flush=True)
        self.acted = True
        signal_group(record["group"], signal.SIGTERM)

    def run(self, folder, waiting):
        """Act on every record; return the live holders and the count of dead holders' running commands."""
        holders, orphans = [], 0
        self.acted = False
        for path in sorted(folder.glob("*.json")):
            record = read(path)
            # A record that cannot tell its processes from later ones given the same ids is left alone.
            if not record or record["pid"] == self.me:
                continue
            if not record["started"] or not record["groupStarted"]:
                continue
            note = path.with_suffix(".taken")
            running = started(record["group"]) == record["groupStarted"]
            if started(record["pid"]) != record["started"]:
                # The kernel freed a dead holder's lease. A command it left must not run on without it.
                if running:
                    orphans += 1
                    self.stop(
                        record,
                        note,
                        f"Mac checks: stopping {command_text(record)} (process group {record['group']}),"
                        f" whose holder pid {record['pid']} is gone",
                        "its holder is gone",
                    )
                elif remove(path):
                    remove(note)
                    print(
                        f"Mac checks: cleared the record of {describe(record)}, whose holder is gone",
                        flush=True,
                    )
                continue
            if not waiting:
                continue
            identity = (record["pid"], record["started"])
            if not running:
                # Seen twice, a second apart, so a holder that is just finishing is left to finish.
                if identity in self.ended:
                    print(
                        f"Mac checks: taking the lease back from {describe(record)}: its command has ended",
                        flush=True,
                    )
                    try:
                        os.kill(record["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    remove(path)
                    remove(note)
                    self.acted = True
                else:
                    self.ended.add(identity)
                continue
            self.ended.discard(identity)
            held = time.time() - record["admitted"]
            if held > record["maxHold"]:
                reason = f"held {span(held)}, over its {span(record['maxHold'])} limit"
                line = f"Mac checks: taking the lease back from {describe(record)}: {reason}"
                self.stop(record, note, line, reason)
            holders.append(record)
        return holders, orphans


def try_lock(lock, mode):
    try:
        fcntl.flock(lock, mode | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def wait_for(lock, mode, line, folder, sweep, at_lease):
    """Take a lock, saying so first if it has to wait, and reclaiming what the records show is stale."""
    if try_lock(lock, mode):
        return
    print(line, flush=True)
    began = looked = time.monotonic()
    sweep.run(folder, waiting=True)
    told = False
    while not try_lock(lock, mode):
        if time.monotonic() - looked >= SWEEP:
            holders, _ = sweep.run(folder, waiting=True)
            # After a second, so a holder admitted a moment ago has written its record,
            # and not while a lease this check just took back is still being let go.
            if not told and not sweep.acted and time.monotonic() - began >= SWEEP:
                told = True
                for record in holders:
                    since = time.strftime("%H:%M:%S %Z", time.localtime(record["admitted"]))
                    print(
                        f"Mac checks: held by {record['access']} {describe(record)} since {since},"
                        f" limit {span(record['maxHold'])}",
                        flush=True,
                    )
                if at_lease and not holders:
                    print(
                        "Mac checks: no record names the lease's holder, so no check can take it back",
                        flush=True,
                    )
            looked = time.monotonic()
        time.sleep(POLL)


def job():
    workflow, run = os.environ.get("GITHUB_WORKFLOW"), os.environ.get("GITHUB_RUN_ID")
    return f"{workflow} run {run}" if workflow and run else None


def hold(access, max_hold, command, lease, folder):
    """Run the command as a child that never inherits the lease; end the lease when it exits."""
    me = os.getpid()
    record = folder / f"{me}.json"
    note = record.with_suffix(".taken")
    child = None
    pending = []

    def forward(number, _frame):
        if child is None:
            pending.append(number)
        else:
            signal_group(child.pid, number)

    for number in FORWARDED:
        signal.signal(number, forward)
    # Its own session, so taking the lease back can stop everything the command started.
    child = subprocess.Popen(command, start_new_session=True)
    for number in pending:
        signal_group(child.pid, number)
    remove(note)
    try:
        write(
            record,
            {
                "pid": me,
                "started": started(me),
                "group": child.pid,
                "groupStarted": started(child.pid),
                "access": access,
                "admitted": time.time(),
                "maxHold": max_hold,
                "command": " ".join(command),
                "job": job(),
            },
        )
    except OSError as error:
        print(f"Mac checks: could not record this lease, so no check can take it back: {error}", flush=True)
    try:
        status = child.wait()
    finally:
        lease.close()
        taken = read(note)
        remove(record)
        remove(note)
    if taken:
        print(f"Mac checks: a waiting check took this lease back: {taken['reason']}", flush=True)
        sys.exit(TAKEN_BACK)
    if status < 0:
        # End the way the command ended, so the caller sees the same signal.
        signal.signal(-status, signal.SIG_DFL)
        os.kill(me, -status)
        sys.exit(128 - status)
    sys.exit(status)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-hold",
        type=duration,
        required=True,
        help="how long the command may hold the lease before a waiting check takes it back, such as 40m",
    )
    parser.add_argument("access", choices=("shared", "exclusive"))
    parser.add_argument("lock", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a command after --")
    args.lock.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = records_folder(args.lock)
    sweep = Sweep(os.getpid())
    lease = lock_file(args.lock)
    # A pending exclusive command holds this entry lock while readers drain.
    # New readers cannot continually pass it, but admitted readers run together.
    with lock_file(args.lock.with_name(args.lock.name + ".entry")) as entry:
        queued = f"Mac checks: {args.access} waiting for checks queued ahead"
        wait_for(entry, fcntl.LOCK_EX, queued, folder, sweep, False)
        wait_for(
            lease,
            fcntl.LOCK_SH if args.access == "shared" else fcntl.LOCK_EX,
            f"Mac checks: {args.access} waiting for active checks",
            folder,
            sweep,
            True,
        )
    # A dead holder's lease is already free; stop any command it left before this one starts.
    began = time.monotonic()
    while sweep.run(folder, waiting=False)[1]:
        if time.monotonic() - began > 2 * GRACE:
            print("Mac checks: a dead holder's command is still running; starting anyway", flush=True)
            break
        time.sleep(POLL)
    print(f"Mac checks: {args.access} admitted", flush=True)
    hold(args.access, args.max_hold, command, lease, folder)


if __name__ == "__main__":
    main()
