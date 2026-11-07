import { describe, expect, it } from "vitest";
import type { ForgeQueuePause, ForgeQueueStart } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { QUEUE_PAUSE_WORDS, QueuePauses } from "./queuePauses";
import type { WakeFacts } from "./wakes";

/**
 * The shipped queue's pause, as the captain chose it in the plan: claim-issue
 * ("the first mates of everyone whose change is paused are woken once; the
 * first to take the pause's issue starts one repair crewmate") and quiet ("no
 * card for pause; tasks say who repairs, Settings shows pause with Resume").
 *
 * A real registry on an in-memory database keeps the project; the one stand-in
 * is the host, answering the open pause issue as `GitHubForge.queuePause`
 * reads it and recording each start of the queue.
 */
function setup() {
  const db = openInMemoryDatabase();
  const repos = new RepoRegistry(db, "/fleet");
  seedProject(db, {
    id: "repo-meter",
    name: "meter",
    path: "/code/meter",
    origin: "https://github.com/o/meter.git",
    delivery: "queue-pr",
  });
  const host: {
    pause: ForgeQueuePause | null;
    issuesOff: boolean;
    reads: number;
    starts: ForgeQueueStart[];
  } = { pause: null, issuesOff: false, reads: 0, starts: [] };
  const told: Extract<WakeFacts, { kind: "queue-paused" }>[] = [];
  const notes: string[] = [];
  const taskNotes: { taskId: string; text: string }[] = [];
  const pauses = new QueuePauses({
    repos,
    forgeFor: () => ({
      queuePause: async () => {
        host.reads += 1;
        // GitHub's answer to an issue list on a project with Issues turned off.
        if (host.issuesOff)
          throw new Error("GitHub answered 410: Issues has been disabled in this repository.");
        return host.pause;
      },
      startQueue: async (start) => {
        if (start.action !== "form") host.starts.push(start);
      },
    }),
    tell: (facts) => told.push(facts),
    note: (text) => notes.push(text),
    taskNote: (taskId, text) => taskNotes.push({ taskId, text }),
    now: () => 5_000,
  });
  return { repos, host, told, notes, taskNotes, pauses };
}

/** Let the read a reading started finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const PAUSE: ForgeQueuePause = {
  run: 4410,
  url: "https://github.com/o/meter/issues/88",
  changes: [12, 14],
};

describe("a paused batch of the shipped queue", () => {
  it("keeps the pause, tells the first mate and Activity once, and notes the paused task", async () => {
    const { repos, host, told, notes, taskNotes, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter", "task-a");
    await pauses.refresh("repo-meter", "task-b");
    expect(repos.get("repo-meter")?.queuePause).toEqual({ ...PAUSE, since: 5_000 });
    expect(told).toEqual([
      {
        kind: "queue-paused",
        project: { id: "repo-meter", name: "meter" },
        run: 4410,
        url: PAUSE.url,
        changes: [12, 14],
      },
    ]);
    expect(notes).toEqual([QUEUE_PAUSE_WORDS.paused("meter", 4410)]);
    expect(taskNotes).toEqual([
      { taskId: "task-a", text: QUEUE_PAUSE_WORDS.task(4410, undefined) },
      { taskId: "task-b", text: QUEUE_PAUSE_WORDS.task(4410, undefined) },
    ]);
  });

  it("says who took the repair, and a paused reading of the kept run reads nothing more", async () => {
    const { repos, host, told, taskNotes, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter", "task-a");
    host.pause = { ...PAUSE, claimedBy: "rosa" };
    await pauses.sweep();
    expect(repos.get("repo-meter")?.queuePause?.claimedBy).toBe("rosa");
    expect(told).toHaveLength(1);

    const reads = host.reads;
    pauses.observed({
      repoId: "repo-meter",
      taskId: "task-a",
      state: { kind: "paused", run: 4410 },
    });
    expect(host.reads).toBe(reads);
    expect(taskNotes.at(-1)).toEqual({
      taskId: "task-a",
      text: QUEUE_PAUSE_WORDS.task(4410, "rosa"),
    });
  });

  it("clears an ended pause on the next pass, whatever the tasks' readings say", async () => {
    const { repos, host, notes, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter");
    // The pause ends where the project lives while no task reads it as
    // paused: the last paused change was sent back, or the check watch ended.
    host.pause = null;
    pauses.observed({ repoId: "repo-meter", taskId: "task-a", state: { kind: "failed" } });
    expect(repos.get("repo-meter")?.queuePause).toBeDefined();
    await pauses.sweep();
    expect(repos.get("repo-meter")?.queuePause).toBeUndefined();
    const reads = host.reads;
    await pauses.sweep();
    expect(host.reads).toBe(reads);
    expect(notes).toEqual([
      QUEUE_PAUSE_WORDS.paused("meter", 4410),
      QUEUE_PAUSE_WORDS.resumed("meter"),
    ]);
  });

  it("tells the first mate again for a new paused run", async () => {
    const { host, told, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter");
    host.pause = { ...PAUSE, run: 4420, changes: [16] };
    await pauses.refresh("repo-meter");
    expect(told.map((facts) => facts.run)).toEqual([4410, 4420]);
  });

  it("starts the queue where the project lives with a by-hand answer to the run that holds the pause", async () => {
    const { host, notes, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter");
    const answer = {
      action: "send-back",
      run: 4410,
      number: 14,
      reason: "It breaks the build alone",
    } as const;
    await pauses.answer("repo-meter", answer);
    expect(host.starts).toEqual([answer]);
    expect(notes.at(-1)).toBe(QUEUE_PAUSE_WORDS.answered("meter", answer));
  });

  it("refuses an answer to a pause that ended or moved to a newer run, and a project it does not know", async () => {
    const { repos, host, pauses } = setup();
    host.pause = PAUSE;
    await pauses.refresh("repo-meter");
    // A teammate resumed while this Settings still showed the pause.
    host.pause = null;
    await expect(
      pauses.answer("repo-meter", { action: "resume", run: 4410, reason: "flaky" }),
    ).rejects.toThrow(QUEUE_PAUSE_WORDS.ended(4410));
    expect(repos.get("repo-meter")?.queuePause).toBeUndefined();
    // A newer batch paused since: the old run's answer does not reach it.
    host.pause = { ...PAUSE, run: 4420, changes: [16] };
    await expect(
      pauses.answer("repo-meter", { action: "resume", run: 4410, reason: "flaky" }),
    ).rejects.toThrow(QUEUE_PAUSE_WORDS.ended(4410));
    expect(host.starts).toEqual([]);
    await expect(
      pauses.answer("missing", { action: "resume", run: 4410, reason: "flaky" }),
    ).rejects.toThrow();
  });

  // The reviewer's finding (INF-2965 re-review): with Issues off the app kept
  // nothing, so Settings showed no pause; the pause is kept from the statuses.
  it("keeps a pause whose issue cannot be read from the paused statuses, until one of them moves on", async () => {
    const { repos, host, told, notes, taskNotes, pauses } = setup();
    host.issuesOff = true;
    const runLink = "https://github.com/o/meter/actions/runs/4410";
    const paused = { kind: "paused" as const, run: 4410 };
    pauses.observed({
      repoId: "repo-meter",
      taskId: "task-a",
      state: paused,
      link: runLink,
      number: 12,
    });
    await settled();
    pauses.observed({
      repoId: "repo-meter",
      taskId: "task-b",
      state: paused,
      link: runLink,
      number: 14,
    });
    await settled();
    await pauses.sweep();
    expect(repos.get("repo-meter")?.queuePause).toEqual({
      run: 4410,
      url: runLink,
      since: 5_000,
      changes: [12, 14],
      unread: true,
    });
    expect(told).toEqual([]);
    expect(notes).toEqual([QUEUE_PAUSE_WORDS.paused("meter", 4410)]);
    expect(taskNotes.map((line) => line.taskId)).toEqual(["task-a", "task-b"]);
    await pauses.answer("repo-meter", { action: "resume", run: 4410, reason: "flake" });
    expect(host.starts).toEqual([{ action: "resume", run: 4410, reason: "flake" }]);
    pauses.observed({
      repoId: "repo-meter",
      taskId: "task-a",
      state: { kind: "waiting" },
      number: 12,
    });
    expect(repos.get("repo-meter")?.queuePause).toBeUndefined();
    expect(notes.at(-1)).toBe(QUEUE_PAUSE_WORDS.resumed("meter"));
  });

  it("tells the first mate once the issue of a pause kept from its statuses reads", async () => {
    const { repos, host, told, notes, pauses } = setup();
    host.issuesOff = true;
    pauses.observed({
      repoId: "repo-meter",
      taskId: "task-a",
      state: { kind: "paused", run: 4410 },
      link: "https://github.com/o/meter/actions/runs/4410",
      number: 12,
    });
    await settled();
    host.issuesOff = false;
    host.pause = PAUSE;
    await pauses.sweep();
    expect(repos.get("repo-meter")?.queuePause).toEqual({ ...PAUSE, since: 5_000 });
    expect(told.map((facts) => facts.url)).toEqual([PAUSE.url]);
    expect(notes).toEqual([QUEUE_PAUSE_WORDS.paused("meter", 4410)]);
  });
});
