#!/usr/bin/env python3
"""CI build/test lease: parallel shared commands, exclusive native commands.

INF-79 review-cap choice: desktop journeys keep running side by side; phones
wait for them and for one another. Use the kernel, not stale PID/marker files.
"""
import argparse
import fcntl
import os
from pathlib import Path
import stat


def lock_file(path):
    # Never unlink these files: all runner slots must keep locking the same inode.
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        raise RuntimeError("The Mac check lease must be a regular file owned by this runner user")
    return os.fdopen(fd, "rb", buffering=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("access", choices=("shared", "exclusive"))
    parser.add_argument("lock", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a command after --")
    args.lock.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_file(args.lock) as lease:
        # A pending exclusive command holds this entry lock while readers drain.
        # New readers cannot continually pass it, but admitted readers run together.
        with lock_file(args.lock.with_name(args.lock.name + ".entry")) as entry:
            fcntl.flock(entry, fcntl.LOCK_EX)
            print(f"Mac checks: {args.access} waiting for active checks", flush=True)
            fcntl.flock(lease, fcntl.LOCK_SH if args.access == "shared" else fcntl.LOCK_EX)
        # Replace this process, keeping the descriptor in the command. Failure,
        # cancellation or process death releases it; there is no lease daemon.
        os.set_inheritable(lease.fileno(), True)
        print(f"Mac checks: {args.access} admitted", flush=True)
        os.execvp(command[0], command)


if __name__ == "__main__":
    main()
