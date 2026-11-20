import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath, resetLoginPathForTests } from "../hostEnv";
import { plantProgram, writeLoginShellStub } from "../loginShellStub";
import { renderWake } from "../orchestrator/wakes";
import { initOverflowDir } from "../overflow";
import { windowsBash } from "../pi/windowsBash";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { type JobExit, JobManager, jobExitWake, NO_GIT_BASH } from "./jobManager";

// A command JobManager runs below the UI carries the real utility clamp and
// says so in its own environment, so the clamp test below can tell it apart
// even where the run itself is held at utility and no priority shows it.
const CLAMPED_ENV = vi.hoisted(() => "INFINITARY_TEST_CLAMPED");
vi.mock("../utilityQos", async (importOriginal) => {
  const real = await importOriginal<typeof import("../utilityQos")>();
  return {
    ...real,
    atUtilityQos: (file: string, args: readonly string[]) => {
      const clamped = real.atUtilityQos(file, args);
      return {
        file: "/usr/bin/env",
        args: [`${CLAMPED_ENV}=utility`, clamped.file, ...clamped.args],
      };
    },
  };
});

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

  it("on Windows with no Git Bash, answers that Git for Windows is needed and never runs the Linux subsystem's bash", async () => {
    // INF-1238 (D6): Pi's lookup falls back to the first bash.exe on the
    // search path, which at shell-pc is WSL's; these are its two answers there
    // with Git for Windows absent.
    const wsl = () => ({
      shell: "C:\\WINDOWS\\system32\\bash.exe",
      args: ["-s"],
      commandTransport: "stdin" as const,
    });
    const none = () => {
      throw new Error("No bash shell found.");
    };
    const cwd = scratchDir("infinitary-job-windows-");
    for (const find of [wsl, none]) {
      const jobs = new JobManager({
        onExit: () => {},
        platform: "win32",
        windowsBash: () => windowsBash(find),
      });
      const outcome = await jobs.run({ ownerId: "t1", command: "touch ran", cwd });
      expect(outcome).toEqual({ kind: "done", exitCode: 127, output: NO_GIT_BASH });
      expect(existsSync(join(cwd, "ran"))).toBe(false);
      expect(jobs.hasRunningJobs("t1")).toBe(false);
    }
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

  // INF-689: `git commit && git push && git config --get remote.origin.url`
  // came back with the address ahead of the lines push printed first: the
  // app was busy while the command ran, then read stdout before stderr.
  it("keeps the order the command wrote stdout and stderr in, however late the app reads them", async () => {
    const { jobs, exits } = manager();
    const written = join(scratchDir("infinitary-job-order-"), "written");
    const outcome = jobs.run({
      ownerId: "t1",
      command: `echo "[main 1a2b3c4] fix: the meter"; echo "To /srv/notes.git" >&2; echo " * [new branch] HEAD -> main" >&2; echo "https://gitlab.com/group/notes.git"; touch '${written}'`,
      cwd: "/tmp",
      background: true,
    });
    // The app busy until the command has written all of it: nothing is read
    // until both pipes hold their lines.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let tries = 0; !existsSync(written) && tries < 1000; tries += 1) {
      Atomics.wait(pause, 0, 0, 10);
    }
    expect(existsSync(written)).toBe(true);
    expect((await outcome).kind).toBe("job");
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(exits[0]?.tail).toBe(
      [
        "[main 1a2b3c4] fix: the meter",
        "To /srv/notes.git",
        " * [new branch] HEAD -> main",
        "https://gitlab.com/group/notes.git",
      ].join("\n"),
    );
  });

  // INF-247: a crewmate placed on a separate Mac that runs work starved
  // behind that Mac's other work at utility priority, so its commands run at
  // the run's own priority there; the home's, and another user's work on the
  // home's own Mac, stay below the UI (captain on INF-255).
  // INF-723: `ps` reads the scheduler's current priority, which sinks below
  // its base under load, so two readings taken apart need not match. The
  // clamp is read as the ceiling it is instead: a shell that asks for an
  // app's priority (`taskpolicy -a`) stays at utility's or under it below
  // the clamp, and rises past it wherever the run itself can. `ps` reads
  // that shell while it waits, having spent next to no CPU to sink by. A
  // run launchd starts with no ProcessType, as the virtual Mac's guest agent
  // did, is itself held at utility, so nothing it starts rises and only the
  // clamp's mark (above) tells the two apart there.
  it.runIf(process.platform === "darwin")(
    "runs a command below the UI, or at the run's own priority where there is none",
    async () => {
      // macOS's base priority for utility QoS (xnu's BASEPRI_UTILITY).
      const UTILITY = 20;
      const RISE = "/usr/sbin/taskpolicy -a /bin/sh -c 'ps -o pri= -p $$; :'";
      const runRisesTo = Number(execFileSync("/bin/sh", ["-c", RISE], { encoding: "utf8" }));
      const ran = async (belowUi?: boolean) => {
        // In the background, so a loaded Mac's slow start never meets the
        // command's cap; the exit carries what it printed.
        const exit = await new Promise<JobExit>((resolve, reject) => {
          const jobs = new JobManager({
            onExit: resolve,
            ...(belowUi === undefined ? {} : { belowUi }),
          });
          jobs
            .run({
              ownerId: "t1",
              command: `printf "%s|" "$${CLAMPED_ENV}"; ${RISE}`,
              cwd: "/tmp",
              background: true,
            })
            .catch(reject);
        });
        expect(exit.exitCode, exit.tail).toBe(0);
        const [clamp, priority] = exit.tail.split("|");
        return { clamp, risesTo: Number(priority) };
      };
      const below = await ran();
      expect(below.clamp).toBe("utility");
      expect(below.risesTo).toBeLessThanOrEqual(UTILITY);
      const own = await ran(false);
      expect(own.clamp).toBe("");
      expect(own.risesTo > UTILITY, `the run itself rises to ${runRisesTo}`).toBe(
        runRisesTo > UTILITY,
      );
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

  // INF-531: on a loaded Mac a task command's answer came back after Pi's
  // limit and its look became a job. The channel tells the shell the command
  // reached the app; the shell waits for the answer, at most one cap more.
  it("waits past the cap for a shell whose task command reached the app, at most one cap more", async () => {
    const { jobs, exits } = manager();
    const dir = scratchDir("infinitary-job-answering-");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Each shell writes the id it was told and waits to be let go, so what
    // the cap sees does not depend on how fast a loaded machine starts it.
    const shell = async (name: string) => {
      const told = join(dir, `${name}.id`);
      const release = join(dir, `${name}.release`);
      let settled = false;
      const running = jobs.run({
        ownerId: "t1",
        command: `printf %s "$INFINITARY_SHELL_ID" > '${told}.part' && mv '${told}.part' '${told}'; while [ ! -e '${release}' ]; do sleep 0.02; done; echo answered`,
        cwd: "/tmp",
        capMs: 100,
      });
      void running.then(() => (settled = true));
      while (!existsSync(told)) await turn();
      return {
        id: readFileSync(told, "utf8"),
        running,
        settled: () => settled,
        release: () => writeFileSync(release, ""),
      };
    };

    // Its answer comes back after the cap: the shell returns it.
    const answered = await shell("answered");
    expect(answered.id).toMatch(/^[0-9a-f-]{36}$/);
    jobs.answering(answered.id);
    await vi.advanceTimersByTimeAsync(199);
    expect(answered.settled()).toBe(false);
    answered.release();
    expect(await answered.running).toEqual({ kind: "done", exitCode: 0, output: "answered" });

    // A shell that goes on after its command still becomes a job, one cap later.
    const longer = await shell("longer");
    jobs.answering(longer.id);
    await vi.advanceTimersByTimeAsync(199);
    expect(longer.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await longer.running).kind).toBe("job");
    vi.useRealTimers();
    longer.release();
    await expect.poll(() => exits.length, { timeout: 5_000 }).toBe(1);
    expect(exits[0]?.tail).toBe("answered");
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

  // INF-405: a Claude client's background task ends with its client, so its
  // crewmate hears that no end will come and does not wait for one.
  it("says a Claude client's background task did not finish when the client it ran in ended", () => {
    expect(
      served(
        {
          jobId: "bybac1mss",
          ownerId: "t1",
          command: "Run the long suite",
          exitCode: null,
          durationMs: 4 * 60_000 + 30_000,
          tail: "",
          interrupted: "client",
        },
        "crewmate",
      ),
    ).toBe(
      '[job] background job bybac1mss did not finish: "Run the long suite" was stopped after 4m 30s, when the Claude Code process it ran in ended. No exit will come; run it again if you still need its result.',
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
