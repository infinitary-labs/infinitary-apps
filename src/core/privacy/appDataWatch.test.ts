import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppDataWatch,
  PRIVACY_WORDS,
  type PrivacyLogRun,
  type ProcessReader,
  readPrivacyLogLine,
  taskOfProcess,
} from "./appDataWatch";

/**
 * INF-1217, direction A (the captain chose "Build A: fewer searches,
 * explain and record"): a crewmate's search that makes macOS ask about
 * other apps' data is recorded on its task, which shows it waits on macOS.
 *
 * The fixture is this Mac's own privacy log as `log show --style ndjson`
 * printed it on 2026-10-24 at 12:53 PM, when INF-1169's `find /` reached
 * other apps' data: a Full Disk Access request macOS refused by policy
 * (4855.319), then an app-data request answered at once (4855.321). Only
 * the home folder's name is changed.
 */
const LOG = readFileSync(
  join(__dirname, "../../../tests/fixtures/privacy-log/whole-disk-search.ndjson"),
  "utf8",
)
  .split("\n")
  .filter(Boolean);

/** The app's process and the crewmate's, as that log names them. */
const APP = 58701;
const CREWMATE = 35236;

/** The app-data request's lines, in the order tccd wrote them. */
const APP_DATA = LOG.filter((line) => line.includes("msgID=4855.321,"));
const FULL_DISK = LOG.filter((line) => line.includes("msgID=4855.319,"));

/** The same lines with its result held back, as a live dialog holds it. */
const withoutResult = (lines: string[]) => lines.filter((line) => !line.includes("AUTHREQ_RESULT"));
const resultOf = (lines: string[]) => lines.find((line) => line.includes("AUTHREQ_RESULT"))!;

/** A result line with macOS's answer changed, as a person's Don't Allow would write it. */
const refused = (line: string) => line.replace("authValue=2", "authValue=0");

function watch(found: string | null = "task-1", self = APP) {
  const notes: { taskId: string; text: string; facts: Record<string, unknown> }[] = [];
  let release: (() => void) | undefined;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const asked: number[] = [];
  let reader: Parameters<PrivacyLogRun>[0] | undefined;
  const subject = new AppDataWatch({
    run: ((heard) => {
      reader = heard;
      return { stop: () => {} };
    }) satisfies PrivacyLogRun,
    self,
    findTask: async (pid) => {
      asked.push(pid);
      await pending;
      return found ?? undefined;
    },
    note: (taskId, text, facts) => notes.push({ taskId, text, facts }),
  });
  /** Let the task lookup finish, as the reader's `ps` and `lsof` would. */
  const look = async () => {
    release?.();
    await pending;
    await Promise.resolve();
  };
  /** The log reader ends on its own, as `log stream` does when it exits. */
  const end = () => reader?.ended();
  return { subject, notes, asked, look, end };
}

describe("reading macOS's privacy log", () => {
  it("reads the service, the processes and the answer of a real request", () => {
    expect(APP_DATA.map(readPrivacyLogLine)).toEqual([
      { kind: "context", request: "4855.321", service: "kTCCServiceSystemPolicyAppData" },
      { kind: "attribution", request: "4855.321", responsible: APP, accessing: CREWMATE },
      // The subject line names no process and no answer.
      undefined,
      { kind: "result", request: "4855.321", answer: "allowed" },
    ]);
    expect(readPrivacyLogLine(resultOf(FULL_DISK))).toEqual({
      kind: "result",
      request: "4855.319",
      answer: "refused",
    });
  });

  it("passes over what is not a request line", () => {
    expect(readPrivacyLogLine('Filtering the log data using "subsystem == ..."')).toBeUndefined();
    expect(readPrivacyLogLine('{"count":28,"finished":1}')).toBeUndefined();
    expect(readPrivacyLogLine("{not json")).toBeUndefined();
  });
});

describe("the privacy watch", () => {
  it("writes that a task waits on macOS while its question is open, then that macOS has the answer", async () => {
    const { subject, notes, asked, look } = watch();
    for (const line of withoutResult(APP_DATA)) subject.heard(line);
    expect(asked).toEqual([CREWMATE]);
    await look();
    expect(notes).toEqual([
      {
        taskId: "task-1",
        text: PRIVACY_WORDS.waiting,
        facts: { macosPrivacy: "waiting", service: "kTCCServiceSystemPolicyAppData" },
      },
    ]);
    subject.heard(resultOf(APP_DATA));
    expect(notes.at(-1)).toEqual({
      taskId: "task-1",
      text: PRIVACY_WORDS.answered.allowed,
      facts: {
        macosPrivacy: "answered",
        service: "kTCCServiceSystemPolicyAppData",
        answer: "allowed",
      },
    });
  });

  it("says Don't Allow when that was the answer", async () => {
    const { subject, notes, look } = watch();
    for (const line of withoutResult(APP_DATA)) subject.heard(line);
    await look();
    subject.heard(refused(resultOf(APP_DATA)));
    expect(notes.map((note) => note.text)).toEqual([
      PRIVACY_WORDS.waiting,
      PRIVACY_WORDS.answered.refused,
    ]);
  });

  it("writes nothing for a request macOS answered from an earlier choice, as it did on 2026-10-24", async () => {
    const { subject, notes, look } = watch();
    for (const line of APP_DATA) subject.heard(line);
    await look();
    expect(notes).toEqual([]);
  });

  it("keeps out another service, another app's request and a process no task owns", async () => {
    const fullDisk = watch();
    for (const line of withoutResult(FULL_DISK)) fullDisk.subject.heard(line);
    await fullDisk.look();
    expect(fullDisk.asked).toEqual([]);

    const otherApp = watch("task-1", 4242);
    for (const line of withoutResult(APP_DATA)) otherApp.subject.heard(line);
    await otherApp.look();
    expect(otherApp.asked).toEqual([]);

    const noTask = watch(null);
    for (const line of withoutResult(APP_DATA)) noTask.subject.heard(line);
    await noTask.look();
    noTask.subject.heard(resultOf(APP_DATA));
    expect(noTask.notes).toEqual([]);
  });

  // INF-3307 audit: a task's "Waiting on macOS" line never got a closing line
  // once the log reader ended, so it stood as the task's Now for good.
  it("closes a task's waiting line when the log reader ends with its question still open", async () => {
    const { subject, notes, look, end } = watch();
    subject.start();
    for (const line of withoutResult(APP_DATA)) subject.heard(line);
    await look();
    expect(notes.map((note) => note.text)).toEqual([PRIVACY_WORDS.waiting]);
    end();
    expect(notes.at(-1)).toEqual({
      taskId: "task-1",
      text: PRIVACY_WORDS.unheard,
      facts: { macosPrivacy: "unheard", service: "kTCCServiceSystemPolicyAppData" },
    });
    // The answer it can no longer hear writes nothing more.
    subject.heard(resultOf(APP_DATA));
    expect(notes).toHaveLength(2);
  });

  it("writes no waiting line for a question whose task is found after the log reader ended", async () => {
    const { subject, notes, look, end } = watch();
    subject.start();
    for (const line of withoutResult(APP_DATA)) subject.heard(line);
    end();
    await look();
    expect(notes).toEqual([]);
  });

  it("writes one waiting line and one answered line for one search's several questions", async () => {
    const { subject, notes, look } = watch();
    const second = APP_DATA.map((line) => line.replaceAll("4855.321", "4855.322"));
    for (const line of [...withoutResult(APP_DATA), ...withoutResult(second)]) subject.heard(line);
    await look();
    subject.heard(resultOf(APP_DATA));
    expect(notes.map((note) => note.text)).toEqual([PRIVACY_WORDS.waiting]);
    subject.heard(resultOf(second));
    expect(notes.map((note) => note.text)).toEqual([
      PRIVACY_WORDS.waiting,
      PRIVACY_WORDS.answered.allowed,
    ]);
  });
});

describe("finding the task a process belongs to", () => {
  /** The process tree of INF-1169's search: bfs under the crewmate's shell, under its Claude program. */
  const tree: Record<number, { parent?: number; cwd?: string }> = {
    900: { parent: 899, cwd: "/" },
    899: { parent: CREWMATE, cwd: "/" },
    [CREWMATE]: { parent: APP, cwd: "/work/worktrees/896f57e4" },
    [APP]: { parent: 1, cwd: "/" },
  };
  const reader: ProcessReader = {
    parent: async (pid) => tree[pid]?.parent,
    cwd: async (pid) => tree[pid]?.cwd,
  };
  const places = [
    { taskId: "896f57e4", dir: "/work/worktrees/896f57e4" },
    { taskId: "6f76ba99", dir: "/work/worktrees/6f76ba99" },
  ];

  it("finds it through a parent that works in the task's working copy", async () => {
    await expect(taskOfProcess(900, { reader, places, self: APP })).resolves.toBe("896f57e4");
  });

  it("finds none at or above the app itself", async () => {
    await expect(
      taskOfProcess(APP, { reader, places: [{ taskId: "home", dir: "/" }], self: APP }),
    ).resolves.toBeUndefined();
  });

  it("does not take a folder that only shares a name's start", async () => {
    await expect(
      taskOfProcess(CREWMATE, {
        reader,
        places: [{ taskId: "other", dir: "/work/worktrees/896f" }],
        self: APP,
      }),
    ).resolves.toBeUndefined();
  });
});
