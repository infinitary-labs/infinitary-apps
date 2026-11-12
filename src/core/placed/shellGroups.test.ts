import { describe, expect, it } from "vitest";
import { inCrewShell } from "./loopbackCaller";
import { type ProcessReading, processesFromPs } from "./processResources";
import { claimShellGroup, ShellGroups } from "./shellGroups";

// The captain's choice on the command door's review (INF-3901): a program in a
// crewmate shell's process group is the crew's until its task closes, so a
// command the shell left running with & or nohup is refused. Rows are in the
// process table's own format (number, parent, group, processor time, resident
// KiB, start, state), shaped like the live proof: crewmate shell 59297 led its
// own group and left two programs, which the system adopted when it ended.
const SHELL = 59297;
const LEFT_RUNNING = `    1     0     1 460:48.22  25040 Tue Oct 27 20:05:43 2026     Ss
59302     1 59297   0:00.01   1216 Thu Nov 12 09:25:58 2026     S
59304     1 59297   0:00.01   1232 Thu Nov 12 09:25:58 2026     S`;
// Later, once every program of that group ended, the system gave the number to
// a new program outside the crew, which leads a group of its own and started one.
const REUSED = `    1     0     1 460:49.02  25040 Tue Oct 27 20:05:43 2026     Ss
59297     1 59297   0:00.02   2304 Thu Nov 12 10:41:07 2026     Ss
59310 59297 59297   0:00.00   1180 Thu Nov 12 10:41:08 2026     S`;

function table(text: string): Map<number, ProcessReading> {
  const rows = processesFromPs(text);
  if (!rows) throw new Error("the process table did not read");
  return new Map(rows.map((row) => [row.pid, row]));
}

function row(byPid: Map<number, ProcessReading>, pid: number): ProcessReading {
  const found = byPid.get(pid);
  if (!found) throw new Error(`no program ${pid}`);
  return found;
}

describe("a crewmate shell's process group", () => {
  it("keeps what the shell left running the crew's after the shell ended, while its task is open", () => {
    const open = new Set(["task-a"]);
    const groups = new ShellGroups((owner) => open.has(owner));
    groups.add(SHELL, "task-a")();
    const byPid = table(LEFT_RUNNING);
    const shells = (group: number) => groups.of(group);
    expect(inCrewShell(row(byPid, 59302), byPid, shells)).toBe(true);
    expect(inCrewShell(row(byPid, 59304), byPid, shells)).toBe(true);

    // Its task closed: the same programs are no longer the crew's.
    open.delete("task-a");
    expect(inCrewShell(row(byPid, 59302), byPid, shells)).toBe(false);
  });

  it("reads a living leader with the shell's number, after the shell ended, as another group", () => {
    const groups = new ShellGroups();
    groups.add(SHELL, "task-a")();
    const byPid = table(REUSED);
    // A regression here would refuse a person's own terminal that took the number.
    expect(inCrewShell(row(byPid, 59310), byPid, (group) => groups.of(group))).toBe(false);
  });

  it("gives a reused group number to its new shell alone", () => {
    const open = new Set(["task-a", "task-b"]);
    const groups = new ShellGroups((owner) => open.has(owner));
    const firstEnded = groups.add(SHELL, "task-a");
    firstEnded();
    groups.add(SHELL, "task-b");
    expect(groups.of(SHELL)).toEqual({ owner: "task-b", shellEnded: false });

    // The first shell's end, heard late, and its task's close leave the new shell's group as it is.
    firstEnded();
    open.delete("task-a");
    groups.forgetClosed(["task-a"]);
    expect(groups.of(SHELL)).toEqual({ owner: "task-b", shellEnded: false });
  });

  it("forgets a closed task's groups and keeps an open task's through its other changes", () => {
    const open = new Set(["task-a", "task-b"]);
    const groups = new ShellGroups((owner) => open.has(owner));
    groups.add(SHELL, "task-a")();
    groups.add(60001, "task-b");

    // A task changes without closing: its groups stay the crew's.
    groups.forgetClosed(["task-a", "task-b"]);
    expect(groups.of(SHELL)).toEqual({ owner: "task-a", shellEnded: true });

    open.delete("task-a");
    groups.forgetClosed(["task-a", "task-b"]);
    // Opened again, the task does not get back a group it had before it closed.
    open.add("task-a");
    expect(groups.of(SHELL)).toBeUndefined();
    expect(groups.of(60001)).toEqual({ owner: "task-b", shellEnded: false });
  });
});

// The captain's choice to cover Claude crewmates too: their client starts each
// command's shell in a group of its own, and the crew shell program it runs
// first names its process to the app. Shaped like a live run: the app 40001
// started Claude client 40010, whose shell 61200 leads its own group and ran
// the crew shell program as itself; the command then left 61207 running. The
// client also ran a server, 40020, through the program inside its own group.
const APP = 40001;
const CLAUDE_SHELL = 61200;
const CLAUDE_SERVER = 40020;
const CLAUDE_RUNNING = `    1     0     1 460:48.22  25040 Tue Oct 27 20:05:43 2026     Ss
40001     1 40001   1:12.40 412000 Thu Nov 12 08:02:11 2026     S
40010 40001 40001   0:41.87 301000 Thu Nov 12 09:40:02 2026     S
40020 40010 40001   0:00.30  18300 Thu Nov 12 09:40:03 2026     S
61200 40010 61200   0:00.01   1984 Thu Nov 12 09:51:30 2026     Ss
61207 61200 61200   0:00.00   1216 Thu Nov 12 09:51:30 2026     S`;
// The shell ended; the system adopted what it left running.
const CLAUDE_LEFT = `    1     0     1 460:48.40  25040 Tue Oct 27 20:05:43 2026     Ss
40001     1 40001   1:12.52 412000 Thu Nov 12 08:02:11 2026     S
40010 40001 40001   0:42.01 301000 Thu Nov 12 09:40:02 2026     S
61207     1 61200   0:00.00   1216 Thu Nov 12 09:51:30 2026     S`;
// Later the number went to a program outside the crew, born at another time.
const CLAUDE_REUSED = `    1     0     1 460:49.02  25040 Tue Oct 27 20:05:43 2026     Ss
61200     1 61200   0:00.02   2304 Thu Nov 12 11:03:41 2026     Ss
61215 61200 61200   0:00.00   1180 Thu Nov 12 11:03:42 2026     S`;

const reading = (text: string) => async () => processesFromPs(text);

describe("a Claude crewmate's shell that names itself", () => {
  it("keeps the group of a program the app started, and what it leaves running is the crew's", async () => {
    const groups = new ShellGroups();
    expect(
      await claimShellGroup(groups, "task-c", CLAUDE_SHELL, {
        appPid: APP,
        read: reading(CLAUDE_RUNNING),
      }),
    ).toBe(true);
    const shells = (group: number) => groups.of(group);
    // The shell itself, still running, leads the group with the stamp the app read.
    const running = table(CLAUDE_RUNNING);
    expect(inCrewShell(row(running, 61207), running, shells)).toBe(true);
    // The app never hears the shell end; its leftover is still the crew's.
    const left = table(CLAUDE_LEFT);
    expect(inCrewShell(row(left, 61207), left, shells)).toBe(true);
    // A program born later under the same number leads another group.
    const reused = table(CLAUDE_REUSED);
    expect(inCrewShell(row(reused, 61215), reused, shells)).toBe(false);
  });

  it("keeps the group of a shell that started the program as its child", async () => {
    // A shell whose start-up files leave it running the program as a child,
    // rather than replacing itself with it: the program 61201 is in the group
    // its parent 61200 leads.
    const childOfShell = `    1     0     1 460:48.22  25040 Tue Oct 27 20:05:43 2026     Ss
40001     1 40001   1:12.40 412000 Thu Nov 12 08:02:11 2026     S
40010 40001 40001   0:41.87 301000 Thu Nov 12 09:40:02 2026     S
61200 40010 61200   0:00.01   1984 Thu Nov 12 09:51:30 2026     Ss
61201 61200 61200   0:00.00   1104 Thu Nov 12 09:51:30 2026     S`;
    const groups = new ShellGroups();
    expect(
      await claimShellGroup(groups, "task-c", 61201, { appPid: APP, read: reading(childOfShell) }),
    ).toBe(true);
    expect(groups.of(CLAUDE_SHELL)).toEqual({
      owner: "task-c",
      shellEnded: false,
      started: "Thu Nov 12 09:51:30 2026",
    });
  });

  it("keeps nothing for a program the app did not start, or one that neither it nor its parent leads a group for", async () => {
    const groups = new ShellGroups();
    // The same table read by an app that is not 40001: nothing above the shell is it.
    expect(
      await claimShellGroup(groups, "task-c", CLAUDE_SHELL, {
        appPid: 52000,
        read: reading(CLAUDE_RUNNING),
      }),
    ).toBe(false);
    expect(groups.of(CLAUDE_SHELL)).toBeUndefined();
    // The client's server is in the app's own group: keeping it would make the
    // app's group the crew's, and a person's script sharing it would be refused.
    expect(
      await claimShellGroup(groups, "task-c", CLAUDE_SERVER, {
        appPid: APP,
        read: reading(CLAUDE_RUNNING),
      }),
    ).toBe(false);
    expect(groups.of(APP)).toBeUndefined();
  });
});
