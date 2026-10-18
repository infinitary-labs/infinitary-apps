import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath, resetLoginPathForTests } from "../hostEnv";
import { plantProgram, writeLoginShellStub } from "../loginShellStub";
import { renderWake } from "../orchestrator/wakes";
import { initOverflowDir } from "../overflow";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { atUtilityQos } from "../utilityQos";
import { type JobExit, JobManager, jobExitWake } from "./jobManager";

// A job's live output spills to the overflow dir; the app wires userData's
// at boot, so this file wires a scratch one.
beforeAll(() => initOverflowDir(scratchDir("infinitary-job-overflow-")));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One event-loop turn: I/O callbacks run, and a fake clock does not move. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

function manager(now?: () => number) {
  const exits: JobExit[] = [];
  const db = openInMemoryDatabase();
  const jobs = new JobManager({ db, onExit: (exit) => exits.push(exit), ...(now ? { now } : {}) });
  return { jobs, exits, db };
}

describe("JobManager (R2: the exit is the wake)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a quick command synchronously, exactly like ordinary bash", async () => {
    const { jobs, exits } = manager();
    const outcome = await jobs.run({ ownerId: "t1", command: "echo hello", cwd: "/tmp" });
    expect(outcome).toEqual({ kind: "done", exitCode: 0, output: "hello" });
    expect(exits).toEqual([]);
    expect(jobs.hasRunningJobs("t1")).toBe(false);
  });

  it("tells a command the cap it answers within, and lays the session's shell over the host's", async () => {
    const { jobs } = manager();
    const outcome = await jobs.run({
      ownerId: "t1",
      command:
        'printf "%s|%s|" "$INFINITARY_SHELL_CAP_MS" "$INFINITARY_AXI_KEY"; echo "$PATH" | cut -d: -f1',
      cwd: "/tmp",
      shell: { env: { INFINITARY_AXI_KEY: "/channel/t1.key" }, path: ["/app/axi-bin"] },
    });
    expect(outcome).toEqual({
      kind: "done",
      exitCode: 0,
      output: "3000|/channel/t1.key|/app/axi-bin",
    });
    // A command started in the background has no cap to keep.
    const background = await jobs.run({
      ownerId: "t1",
      command: 'printf "%s" "$INFINITARY_SHELL_CAP_MS"',
      cwd: "/tmp",
      background: true,
    });
    expect(background.kind).toBe("job");
  });

  it("tells a command when its shell started, on the wall clock the channel reads", async () => {
    // INF-181: the channel compares this stamp with Date.now(), not the ticker.
    const before = Date.now();
    const { jobs } = manager(() => 1_700_000_000_000);
    const outcome = await jobs.run({
      ownerId: "t1",
      command: 'printf "%s|%s" "$INFINITARY_SHELL_STARTED_MS" "$INFINITARY_SHELL_CAP_MS"',
      cwd: "/tmp",
    });
    const after = Date.now();
    if (outcome.kind !== "done") throw new Error("expected a finished command");
    const [started, cap] = outcome.output.split("|");
    const stamp = Number(started);
    expect(cap).toBe("3000");
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
    expect(stamp).not.toBe(1_700_000_000_000);
  });

  it("merges stderr and reports the exit code", async () => {
    const { jobs } = manager();
    const outcome = await jobs.run({
      ownerId: "t1",
      command: "echo oops 1>&2; exit 3",
      cwd: "/tmp",
    });
    expect(outcome).toEqual({ kind: "done", exitCode: 3, output: "oops" });
  });

  // INF-247: a crewmate placed on a separate Mac that runs work starved
  // behind that Mac's other work at utility priority, so its commands run at
  // the run's own priority there; the home's, and another user's work on the
  // home's own Mac, stay below the UI (captain on INF-255).
  it.runIf(process.platform === "darwin")(
    "runs a command below the UI, or at the run's own priority where there is none",
    async () => {
      const PRIORITY = "ps -o pri= -p $$";
      const read = (file: string, args: readonly string[]) =>
        Number(execFileSync(file, args, { encoding: "utf8" }).trim());
      const clamped = atUtilityQos("/bin/sh", ["-c", PRIORITY]);
      const below = read(clamped.file, clamped.args);
      const own = read("/bin/sh", ["-c", PRIORITY]);
      const ran = async (belowUi?: boolean) => {
        const jobs = new JobManager({
          onExit: () => {},
          ...(belowUi === undefined ? {} : { belowUi }),
        });
        const outcome = await jobs.run({ ownerId: "t1", command: PRIORITY, cwd: "/tmp" });
        if (outcome.kind !== "done") throw new Error("expected a finished command");
        return Number(outcome.output.trim());
      };
      expect(await ran()).toBe(below);
      expect(await ran(false)).toBe(own);
    },
  );

  it("converts a slow command into a background job at the cap, then wakes on exit", async () => {
    const { jobs, exits, db } = manager();
    // The cap runs on a clock the test moves, and the command says when it
    // has printed and waits to be let go, so what the job carries at the cap
    // does not depend on how fast a loaded machine starts a shell.
    const dir = scratchDir("infinitary-job-cap-");
    const printed = join(dir, "printed");
    const release = join(dir, "release");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let converted = false;
    const running = jobs.run({
      ownerId: "t1",
      command: `echo started; touch '${printed}'; while [ ! -e '${release}' ]; do sleep 0.02; done; echo finished`,
      cwd: "/tmp",
      capMs: 100,
    });
    void running.then(() => (converted = true));
    while (!existsSync(printed)) await turn();
    // The line is in the pipe before the file exists; one more turn reads it.
    await turn();
    await vi.advanceTimersByTimeAsync(99);
    expect(converted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await running;
    vi.useRealTimers();
    writeFileSync(release, "");
    if (outcome.kind !== "job") throw new Error("expected a job");
    expect(outcome.tail).toContain("started");
    expect(jobs.hasRunningJobs("t1")).toBe(true);
    // The running job is durable state (a quit would report it).
    expect(db.prepare("SELECT COUNT(*) as n FROM jobs").get()).toEqual({ n: 1 });

    await expect.poll(() => exits.length, { timeout: 5_000 }).toBe(1);
    expect(exits[0]).toMatchObject({ ownerId: "t1", exitCode: 0 });
    expect(exits[0]?.tail).toContain("finished");
    expect(jobs.hasRunningJobs("t1")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) as n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("starts immediately as a job with the explicit background flag", async () => {
    const { jobs, exits } = manager();
    const outcome = await jobs.run({
      ownerId: "fm",
      command: "sleep 0.2; echo done",
      cwd: "/tmp",
      background: true,
    });
    expect(outcome.kind).toBe("job");
    // The exit is the wake: poll for it rather than guess how long a loaded
    // machine takes to spawn a shell and run it.
    await expect.poll(() => exits[0]?.tail, { timeout: 5_000 }).toBe("done");
  });

  it("kills an owner's jobs quietly - a cancelled task hears nothing", async () => {
    const { jobs, exits } = manager();
    await jobs.run({ ownerId: "t1", command: "sleep 5", cwd: "/tmp", background: true });
    jobs.killForOwner("t1");
    await wait(200);
    expect(exits).toEqual([]);
    expect(jobs.hasRunningJobs("t1")).toBe(false);
  });

  it("names an owner's longest-running job, the reading the idle ladder bounds", async () => {
    // Stamped on the host's one clock, the one the ladder's job bound reads.
    let clock = 1_000_000;
    const { jobs } = manager(() => clock);
    const startedAt = clock;
    const first = await jobs.run({
      ownerId: "t1",
      command: "sleep 5",
      cwd: "/tmp",
      background: true,
    });
    clock = startedAt + 60_000;
    await jobs.run({ ownerId: "t1", command: "sleep 6", cwd: "/tmp", background: true });
    await jobs.run({ ownerId: "t2", command: "sleep 7", cwd: "/tmp", background: true });
    expect(first.kind === "job" && jobs.oldestRunningJob("t1")).toEqual({
      jobId: first.kind === "job" ? first.jobId : "",
      command: "sleep 5",
      startedAt,
    });
    expect(jobs.oldestRunningJob("t2")?.command).toBe("sleep 7");
    expect(jobs.oldestRunningJob("nobody")).toBeUndefined();
    jobs.killForOwner("t1");
    jobs.killForOwner("t2");
    // Gone once each process has actually exited.
    await expect.poll(() => jobs.oldestRunningJob("t1"), { timeout: 5_000 }).toBeUndefined();
    await expect.poll(() => jobs.hasRunningJobs("t2"), { timeout: 5_000 }).toBe(false);
  });

  it("measures a job's duration on the host's clock", async () => {
    let clock = 1_000_000;
    const { jobs, exits } = manager(() => clock);
    const release = join(scratchDir("infinitary-job-clock-"), "release");
    const outcome = await jobs.run({
      ownerId: "t1",
      command: `while [ ! -e '${release}' ]; do sleep 0.02; done`,
      cwd: "/tmp",
      background: true,
    });
    expect(outcome.kind).toBe("job");
    expect(jobs.oldestRunningJob("t1")?.startedAt).toBe(1_000_000);
    clock += 90_000;
    writeFileSync(release, "");
    await expect.poll(() => exits.length, { timeout: 5_000 }).toBe(1);
    expect(exits[0]).toMatchObject({ ownerId: "t1", exitCode: 0, durationMs: 90_000 });
  });

  it("reports jobs a quit interrupted, once, from the durable rows", async () => {
    const { db } = manager();
    // A row left behind by a previous process.
    db.prepare("INSERT INTO jobs (id, owner_id, command, started_at) VALUES (?, ?, ?, ?)").run(
      "j1",
      "t9",
      "make build",
      Date.now(),
    );
    const fresh = new JobManager({ db, onExit: vi.fn() });
    expect(fresh.reportInterrupted()).toEqual([
      { ownerId: "t9", command: "make build", stoppedByQuit: false },
    ]);
    expect(fresh.reportInterrupted()).toEqual([]);
  });

  // INF-377 F1: a command that finishes within the cap never became a job,
  // so it never touches the rows - on a computer that runs work, each one
  // used to read its task's jobs file and delete or rewrite it.
  it("keeps a row only for a command that became a job", async () => {
    const calls: string[] = [];
    const jobs = new JobManager({
      rows: {
        add: (job) => calls.push(`add ${job.command}`),
        remove: (id) => calls.push(`remove ${id}`),
        markStoppedByQuit: (id) => calls.push(`mark ${id}`),
      },
      onExit: () => {},
    });
    expect(await jobs.run({ ownerId: "t1", command: "echo quick", cwd: "/tmp" })).toMatchObject({
      kind: "done",
      exitCode: 0,
    });
    expect(calls).toEqual([]);
    const outcome = await jobs.run({
      ownerId: "t1",
      command: "true",
      cwd: "/tmp",
      background: true,
    });
    if (outcome.kind !== "job") throw new Error("expected a job");
    await expect.poll(() => calls).toEqual(["add true", `remove ${outcome.jobId}`]);
  });

  it("caps captured output at the tail", async () => {
    const { jobs } = manager();
    const outcome = await jobs.run({
      ownerId: "t1",
      command: "for i in $(seq 1 5000); do echo line-$i-padding-padding-padding; done",
      cwd: "/tmp",
    });
    if (outcome.kind !== "done") throw new Error("expected done");
    expect(outcome.output.length).toBeLessThan(40_000);
    expect(outcome.output).toContain("[earlier output truncated; full output: ");
    expect(outcome.output).toContain("line-5000");
    // The evicted head is not gone - it spilled to the pointed-at file.
    const file = outcome.output.match(/full output: (.+)\]/)?.[1];
    expect(file).toBeTruthy();
    expect(readFileSync(file ?? "", "utf8")).toContain("line-1-padding-padding-padding");
  });
});

describe("a job's exit wake", () => {
  /** What its owner is served: the typed wake, through the inbox and back. */
  function served(exit: JobExit, to: "firstmate" | "crewmate"): string {
    const inbox = new InboxStore(openInMemoryDatabase());
    inbox.enqueue(FIRSTMATE_RECIPIENT, jobExitWake(exit, to), undefined, "agent");
    const [row] = inbox.allFor(FIRSTMATE_RECIPIENT);
    if (!row) throw new Error("the wake was not recorded");
    return renderWake(row);
  }

  it("phrases the wake in plain words with the bounded tail, for either owner", () => {
    const exit = {
      jobId: "j1",
      ownerId: "t1",
      command: "make build",
      exitCode: 0,
      durationMs: 252_000,
      tail: "ok",
    };
    expect(served(exit, "firstmate")).toBe(
      '[fm-op] background job j1 finished: "make build" exited 0 after 4m 12s. Output tail:\nok',
    );
    expect(served(exit, "crewmate")).toBe(
      '[job] background job j1 finished: "make build" exited 0 after 4m 12s. Output tail:\nok',
    );
  });

  it("cuts a long command, says a signal ended it and that it printed nothing", () => {
    expect(
      served(
        {
          jobId: "j2",
          ownerId: "t1",
          command: "x".repeat(90),
          exitCode: null,
          durationMs: 400,
          tail: "",
        },
        "crewmate",
      ),
    ).toBe(
      `[job] background job j2 finished: "${"x".repeat(80)}..." exited by signal after 1s with no output`,
    );
  });

  it("words a run of hours", () => {
    expect(
      served(
        {
          jobId: "j3",
          ownerId: "firstmate",
          command: "pnpm test",
          exitCode: 1,
          durationMs: 2 * 3_600_000 + 5 * 60_000 + 1_000,
          tail: "FAIL a\nFAIL b",
        },
        "firstmate",
      ),
    ).toBe(
      '[fm-op] background job j3 finished: "pnpm test" exited 1 after 2h 5m. Output tail:\nFAIL a\nFAIL b',
    );
  });

  // INF-367: a job its computer's restart cut off reaches its crewmate as the
  // end that will never come, so it does not wait for one.
  it("says a job its computer's stop killed did not finish, and that one a crash left may have run on", () => {
    const cutOff = {
      jobId: "45d291d9",
      ownerId: "t1",
      command: "pnpm test:ios",
      exitCode: null,
      durationMs: 12 * 60_000 + 3_000,
      tail: "",
    };
    expect(served({ ...cutOff, interrupted: "quit" }, "crewmate")).toBe(
      '[job] background job 45d291d9 did not finish: "pnpm test:ios" was stopped after 12m 3s, when Infinitary stopped on the computer running it. No exit will come; run it again if you still need its result.',
    );
    expect(served({ ...cutOff, durationMs: 0, interrupted: "crash" }, "crewmate")).toBe(
      '[job] background job 45d291d9 did not finish there: "pnpm test:ios" was still running when Infinitary ended unexpectedly on the computer running it, and it may have kept running, even to the end. No exit will come; check what it left before you run it again.',
    );
  });
});

describe("a crewmate's shell from a Dock launch (the person's search path)", () => {
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

  afterEach(() => {
    resetLoginPathForTests();
    process.env.PATH = saved.PATH;
    process.env.SHELL = saved.SHELL;
  });

  it("finds the node the person's shell puts on the path, though the app's own path is the system folders", async () => {
    const dir = scratchDir("infinitary-jobs-path-");
    const nvm = join(dir, "nvm", "bin");
    plantProgram(nvm, "node", "v99.0.0-planted");
    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = writeLoginShellStub(join(dir, "shell"), {
      interactive: `PATH='${nvm}':"$PATH"`,
    }).shell;
    resetLoginPathForTests();
    await captureLoginPath();

    const { jobs } = manager();
    const outcome = await jobs.run({ ownerId: "t1", command: "node --version", cwd: "/tmp" });
    expect(outcome).toEqual({ kind: "done", exitCode: 0, output: "v99.0.0-planted" });
  });
});
