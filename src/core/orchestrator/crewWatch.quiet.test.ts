/**
 * The crew's watch as `CrewWatch` keeps it (docs/inbox.md,
 * docs/report-sort.md): a carried-on turn its session no longer runs, a
 * quiet crewmate's alert and wakes, the watchdog, fleet hygiene at boot and
 * on a cancel, and the served text of every remaining wake.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  reportTurn,
  SETTLE_DISCARD,
  settleWakes,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { pngImage } from "../../../tests/helpers/images";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { THREAD_STEER_PREAMBLE } from "./captainWakes";
import type { CrewmateSpec } from "./crewSession";
import { UNHEARD_END_NOTE } from "./crewTurns";
import { QUIET_CARD_MS } from "./crewWatch";
import { discardedText } from "./settleWords";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  // INF-2332, captain: "make sure we delete unnecessary state tracking to
  // honor the source of truth principle". A crewmate on this computer that
  // carried on by itself is checked against its own live session: one whose
  // session no longer works ends as interrupted after a quiet stretch or a
  // stop, and one whose session still works is left alone.
  it.each(["quiet", "stop"] as const)(
    "ends a carried-on turn its live session no longer runs, on a %s (INF-2332)",
    async (trigger) => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks } = setup(crewmate);
      const { taskId } = await supervisor.intake.commission({
        title: "Finish background checks",
        intent: intentOf("finish the background checks"),
      });
      await tick();
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      // The crewmate carries on, and its end is lost: the session stops
      // working without a continuation_ended.
      crewmate.emit({ type: "continuation_started" });
      expect(legacyStateOf(tasks.get(taskId))).toBe("running");
      expect(crewmate.isStreaming()).toBe(false);

      if (trigger === "quiet") supervisor.watch.checkQuietTasks(Date.now() + QUIET_CARD_MS);
      else await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
      await tick();

      expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
      const timeline = tasks.timeline(taskId);
      expect(timeline.some((event) => event.text === UNHEARD_END_NOTE)).toBe(true);
      expect(timeline.some((event) => event.kind === "failed")).toBe(false);
    },
  );

  it("leaves a carried-on turn its live session still runs (INF-2332)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Finish background checks",
      intent: intentOf("finish the background checks"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    crewmate.emit({ type: "continuation_started" });
    crewmate.isStreaming = () => true;

    supervisor.watch.checkQuietTasks(Date.now() + QUIET_CARD_MS);
    await tick();

    expect(legacyStateOf(tasks.get(taskId))).toBe("running");
    expect(tasks.timeline(taskId).some((event) => event.text === UNHEARD_END_NOTE)).toBe(false);
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(true);
  });

  // INF-2603, the captain's answers "Any open call, including the
  // crewmate's own, such as a test run open for 40 minutes" and "Wake the
  // first mate once, naming what the steer waits behind". A call the
  // crewmate started is never answered for it: it is named.
  it("names a crewmate's own open call and unread steer, and wakes once for a steer two checks find unread (INF-2603)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Run the phone tests",
      intent: intentOf("run the phone tests"),
    });
    await tick();
    const start = Date.now();
    crewmate.emit({ type: "tool_start", taskId, callId: "call-1", toolName: "bash" });
    await supervisor.steer.steerCrewmate(taskId, "Stop after the first failure.");

    supervisor.watch.checkQuietTasks(start + QUIET_CARD_MS + 60_000);
    await tick();

    const quiet = ops.find((line) => line.includes("may be stuck"));
    expect(quiet).toContain(
      `It is inside bash since ${new Date(start).toISOString().slice(0, 16)}`,
    );
    expect(quiet).toContain("1 steer handed over since");
    expect(
      tasks
        .timeline(taskId)
        .some(
          (event) =>
            event.text?.includes("may be stuck; inside bash for") &&
            event.text.includes("1 steer unread"),
        ),
    ).toBe(true);
    expect(supervisor.facts.crewStatus(taskId)[0]?.waiting).toMatch(
      /^inside bash .*; 1 steer unread /,
    );
    expect(ops.some((line) => line.includes("still unread"))).toBe(false);
    supervisor.watch.checkQuietTasks(start + 2 * QUIET_CARD_MS + 120_000);
    await tick();
    const unread = ops.filter((line) => line.includes("still unread after two quiet checks"));
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain("It waits behind bash since");
    supervisor.watch.checkQuietTasks(start + 3 * QUIET_CARD_MS + 180_000);
    await tick();
    expect(ops.filter((line) => line.includes("still unread after two quiet checks"))).toHaveLength(
      1,
    );
  });

  // INF-2603, the captain's answer "Keep it for the 20-minute alert; the
  // two-hour wake fires anyway, naming the job and any open call".
  it("keeps a running job's silence for the quiet alert, and wakes at two hours naming the job and the open call (INF-2603)", async () => {
    const crewmate = fakeCrewmate();
    const jobStart = Date.now();
    const { supervisor, ops } = setup(crewmate, {
      hasRunningJobs: () => true,
      oldestRunningJob: () => ({ jobId: "j1", command: "pnpm test:phone", startedAt: jobStart }),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Run the phone tests",
      intent: intentOf("run the phone tests"),
    });
    await tick();
    crewmate.emit({ type: "tool_start", taskId, callId: "call-1", toolName: "Agent" });

    supervisor.watch.checkQuietTasks(jobStart + QUIET_CARD_MS + 60_000);
    await tick();
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(false);

    supervisor.watch.checkQuietTasks(jobStart + 125 * 60_000);
    await tick();
    const long = ops.find((line) => line.includes("has been on one turn for"));
    expect(long).toContain(
      `Its background job runs since ${new Date(jobStart).toISOString()}: pnpm test:phone.`,
    );
    expect(long).toContain("It is inside Agent since");
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(false);
  });
});

describe("the quiet-crewmate watchdog (P4)", () => {
  const MIN = 60_000;

  it("escalates a quiet streaming turn: a record line at 10 minutes, one wake at 20, never a card", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, cards, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Slow build",
      intent: intentOf("build it"),
    });
    await tick();
    const start = Date.now();

    supervisor.watch.checkQuietTasks(start + 9 * MIN);
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(0);

    // Eleven: one line on the task's record, once - the next tick does not
    // repeat it - and nothing in the feed, which offers the captain nothing
    // to do yet (INF-3060 finding 6).
    supervisor.watch.checkQuietTasks(start + 11 * MIN);
    supervisor.watch.checkQuietTasks(start + 12 * MIN);
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(0);
    expect(
      tasks.timeline(taskId).filter((event) => event.text === "quiet for 11 minutes"),
    ).toHaveLength(1);

    // Twenty-one: one [fm-op] naming the tools, a timeline note, no card
    // (cards/tasks/agents P0, WI-3) - and the next tick does not repeat it.
    supervisor.watch.checkQuietTasks(start + 21 * MIN);
    supervisor.watch.checkQuietTasks(start + 22 * MIN);
    await tick();
    expect(cards()).toEqual([]);
    const stuck = ops.filter((line) => line.includes("may be stuck"));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toContain(`[fm-op] crewmate 1 on task ${taskId} "Slow build"`);
    expect(stuck[0]).toContain("You can steer or interrupt it.");
    expect(tasks.timeline(taskId).at(-1)?.text).toContain("may be stuck");
  });

  it("treats any session event as activity, so a fresh silence wakes again", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Chatty",
      intent: intentOf("work"),
    });
    await tick();
    const start = Date.now();
    supervisor.watch.checkQuietTasks(start + 21 * MIN);
    await tick();
    expect(ops.filter((line) => line.includes("may be stuck"))).toHaveLength(1);
    expect(cards()).toEqual([]);

    // Output arrives: the question answered itself; the clock restarts from
    // that event, so fifteen minutes later is a feed line at most, and a
    // fresh twenty quiet minutes is a fresh wake.
    crewmate.emit({ type: "assistant_delta", taskId, text: "still here" });
    await tick();
    supervisor.watch.checkQuietTasks(start + 15 * MIN);
    expect(ops.filter((line) => line.includes("may be stuck"))).toHaveLength(1);
    supervisor.watch.checkQuietTasks(start + 45 * MIN);
    expect(ops.filter((line) => line.includes("may be stuck"))).toHaveLength(2);
    expect(cards()).toEqual([]);
  });

  it("never escalates an idle task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, cards, ops } = setup(crewmate);
    await supervisor.intake.commission({ title: "Done", intent: intentOf("quick") });
    await tick();
    crewmate.finishPrompt();
    await tick();
    supervisor.watch.checkQuietTasks(Date.now() + 60 * MIN);
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(0);
    expect(cards()).toEqual([]);
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(false);
  });

  it("escalates the wall-clock bound once, as a wake, after the quiet wake", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Marathon",
      intent: intentOf("long work"),
    });
    await tick();
    const start = Date.now();
    supervisor.watch.checkQuietTasks(start + 21 * MIN);
    await tick();
    supervisor.watch.checkQuietTasks(start + 121 * MIN);
    supervisor.watch.checkQuietTasks(start + 122 * MIN);
    await tick();
    expect(cards()).toEqual([]);
    const hours = ops.filter((line) => line.includes("hours"));
    expect(hours).toHaveLength(1);
    expect(hours[0]).toContain(
      `[fm-op] crewmate 1 on task ${taskId} "Marathon" has been on one turn for`,
    );
  });
});

describe("fleet hygiene (interaction P0, WI-7)", () => {
  async function idleCommissioned(prepare?: (harness: ReturnType<typeof setup>) => void) {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    prepare?.(harness);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Tidy the meter test",
      intent: intentOf("go"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    return { ...harness, crewmate, taskId };
  }

  it("installs dependencies in the new worktree before the first turn, and records it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, paths } = setup(crewmate);
    const install = deferred<{ outcome: "offline"; ms: number }>();
    vi.mocked(workspace.installDependencies).mockReturnValue(install.promise);
    const { taskId } = await supervisor.intake.commission({
      title: "Build",
      intent: intentOf("go"),
    });
    await tick();

    expect(workspace.installDependencies).toHaveBeenCalledWith(join(paths.worktreesDir, taskId));
    expect(crewmate.promptCalls).toEqual([]);
    install.resolve({ outcome: "offline", ms: 2_300 });
    await tick();

    expect(crewmate.promptCalls).toHaveLength(1);
    expect(tasks.timeline(taskId).find((event) => event.kind === "note")).toMatchObject({
      text: "the project's dependencies are installed (2s)",
      data: { install: "offline", ms: 2_300 },
      feed: false,
    });
  });

  it("a failed install is a timeline fact and the crewmate still starts", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks } = setup(crewmate);
    vi.mocked(workspace.installDependencies).mockResolvedValue({
      outcome: "failed",
      ms: 900,
      error: "ERR_PNPM_FETCH_404 not found",
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Build",
      intent: intentOf("go"),
    });
    await tick();
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(tasks.timeline(taskId).map((event) => event.text)).toContain(
      "could not install the project's dependencies - ERR_PNPM_FETCH_404 not found; the crewmate can do it itself",
    );
  });

  it("a task cancelled while its install runs closes as dropped and never starts a turn", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks } = setup(crewmate);
    const install = deferred<{ outcome: "skipped" }>();
    vi.mocked(workspace.installDependencies).mockReturnValue(install.promise);
    const { taskId } = await supervisor.intake.commission({
      title: "Build",
      intent: intentOf("go"),
    });
    await tick();

    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    install.resolve({ outcome: "skipped" });
    await tick();

    expect(crewmate.promptCalls).toEqual([]);
    expect(tasks.get(taskId)).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      workspaceState: "removed",
    });
  });

  it("a task cancelled while idle closes as dropped with no worktree", async () => {
    const { supervisor, tasks, workspace, taskId, paths } = await idleCommissioned();
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();

    const record = tasks.get(taskId);
    expect(record).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      workspaceState: "removed",
    });
    expect(record?.closedAt).toBeGreaterThan(0);
    expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: join(paths.worktreesDir, taskId) }),
    );
  });

  it("a cancel removes a worktree holding unlanded work after saving it, quietly", async () => {
    const { supervisor, tasks, workspace, taskId } = await idleCommissioned(({ workspace }) => {
      vi.mocked(workspace.retireTaskWorktree).mockImplementation(async (ws) => {
        await workspace.removeTaskWorktree(ws);
        return {
          outcome: "removed",
          kept: {
            ref: `refs/infinitary/kept/${ws.taskId}`,
            sha: "abc",
            dirty: true,
            unlandedCommits: 2,
          },
        };
      });
    });
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();

    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", workspaceState: "removed" });
    expect(workspace.removeTaskWorktree).toHaveBeenCalledTimes(1);
    const saved = tasks.timeline(taskId).find((event) => event.data?.saved);
    // The line names no ref: the kept ref is never shown on a surface.
    expect(saved).toMatchObject({
      feed: false,
      text: "working copy removed - its 2 commits not in yet and uncommitted edits saved first",
      data: { saved: { ref: `refs/infinitary/kept/${taskId}` } },
    });
  });

  it("a cancel keeps a worktree whose work could not be saved, says so in the feed, and a confirmed discard clears it", async () => {
    const { supervisor, tasks, workspace, taskId } = await idleCommissioned(({ workspace }) => {
      vi.mocked(workspace.taskWorkStatus).mockResolvedValue({ dirty: false, unlandedCommits: 2 });
      vi.mocked(workspace.retireTaskWorktree).mockResolvedValue({
        outcome: "kept",
        reason: "fatal: unable to write new index file",
      });
    });
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();

    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", workspaceState: "present" });
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    expect(tasks.timeline(taskId).find((event) => event.data?.kept)).toMatchObject({
      feed: true,
      text: "working copy kept - its work could not be saved first; discard to remove it",
      data: { reason: "fatal: unable to write new index file" },
    });

    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toContain("2 commits");
    expect(await supervisor.settling.settle.settleTask(taskId, "discard", true)).toBe(
      discardedText(),
    );
    // The close stands as cancelled; only the worktree it kept is gone.
    expect(tasks.get(taskId)).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      workspaceState: "removed",
    });
  });

  it("an idle crewmate with unlanded work stays active and resumable until settled (WI-11)", async () => {
    const { supervisor, tasks, workspace, taskId } = await idleCommissioned(({ workspace }) => {
      vi.mocked(workspace.taskWorkStatus).mockResolvedValue({ dirty: false, unlandedCommits: 3 });
    });
    // There is no `finish`: a finished crewmate is not a close. The row stays
    // active and idle, its worktree intact, until the captain settles it.
    expect(tasks.get(taskId)).toMatchObject({ status: "active", activity: "idle" });
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
  });

  // INF-3060 finding 6: the same leftover branches were a feed line at every
  // start with nothing to click. The captain: "we should not bother users
  // with things that the crew can take care of and doesn't really need user
  // judgment" - boot retires them, each saved first, and names only one
  // that could not be deleted.
  it("boot reconciliation retires leftover task branches and names only one it could not delete", async () => {
    const { supervisor, tasks, workspace, events, paths } = setup(fakeCrewmate());
    mkdirSync(join(paths.defaultWorkspaceDir, ".git"), { recursive: true });
    seedTask(tasks, { id: "gone", title: "Gone", status: "cancelled" });
    seedTask(tasks, { id: "live", title: "Live", status: "idle", worktreeDir: "/work/live" });
    vi.mocked(workspace.listTaskBranches).mockResolvedValue([
      { branch: "fm/task-gone", taskId: "gone" },
      { branch: "fm/task-live", taskId: "live" },
      { branch: "fm/task-ghost", taskId: "ghost" },
    ]);

    await supervisor.watch.reconcileFleetHygiene();

    expect(vi.mocked(workspace.retireTaskBranch).mock.calls).toEqual([
      [paths.defaultWorkspaceDir, "fm/task-gone", "gone"],
      [paths.defaultWorkspaceDir, "fm/task-ghost", "ghost"],
    ]);
    expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
    expect(supervisor.cards.snapshot()).toEqual([]);

    vi.mocked(workspace.retireTaskBranch).mockImplementation(async (_repo, branch) =>
      branch === "fm/task-ghost"
        ? { outcome: "kept", reason: "branch is checked out" }
        : { outcome: "removed" },
    );
    await supervisor.watch.reconcileFleetHygiene();
    expect(events).toEqual([
      {
        type: "firstmate_note",
        text: "1 leftover task branch is kept because it could not be deleted: fm/task-ghost in default workspace (branch is checked out).",
      },
    ]);
  });

  it("boot reconciliation retires every closed row's worktree, keeping only one whose work could not be saved", async () => {
    const { supervisor, tasks, workspace, events } = setup(fakeCrewmate());
    seedTask(tasks, { id: "old", title: "Old", status: "cancelled", worktreeDir: "/work/old" });
    seedTask(tasks, {
      id: "unlanded",
      title: "Unlanded",
      status: "cancelled",
      worktreeDir: "/work/u",
    });
    seedTask(tasks, { id: "kept", title: "Kept", status: "cancelled", worktreeDir: "/work/kept" });
    vi.mocked(workspace.retireTaskWorktree).mockImplementation(async (ws) => {
      if (ws.taskId === "kept") return { outcome: "kept", reason: "fatal: bad object HEAD" };
      await workspace.removeTaskWorktree(ws);
      return { outcome: "removed", kept: null };
    });

    await supervisor.watch.reconcileFleetHygiene();

    expect(tasks.get("old")?.workspaceState).toBe("removed");
    expect(tasks.get("unlanded")?.workspaceState).toBe("removed");
    expect(tasks.get("kept")?.workspaceState).toBe("present");
    expect(workspace.removeTaskWorktree).toHaveBeenCalledTimes(2);
    // The boot line is the surfacing; no per-task feed line on top of it.
    expect(tasks.timeline("kept").some((event) => event.data?.kept)).toBe(false);
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: '1 closed task keeps its working copy because its work could not be saved first: "Kept".',
    });
  });

  it("boot reconciliation retires a worktree directory no record explains, and never one a live row owns", async () => {
    const { supervisor, tasks, workspace, events, paths } = setup(fakeCrewmate());
    seedTask(tasks, {
      id: "live",
      title: "Live",
      status: "idle",
      worktreeDir: join(paths.worktreesDir, "live"),
    });
    seedTask(tasks, { id: "queued", title: "Queued", status: "queued" });
    vi.mocked(workspace.listWorktreeDirs).mockReturnValue(["live", "queued", "ghost", "junk"]);
    vi.mocked(workspace.workspaceAt).mockImplementation(async (name) =>
      name === "ghost"
        ? {
            taskId: name,
            cwd: join(paths.worktreesDir, name),
            branch: `fm/task-${name}`,
            repoDir: paths.defaultWorkspaceDir,
          }
        : null,
    );

    await supervisor.watch.reconcileFleetHygiene();

    expect(workspace.workspaceAt).toHaveBeenCalledTimes(2);
    expect(workspace.retireTaskWorktree).toHaveBeenCalledTimes(1);
    expect(workspace.retireTaskWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "ghost" }),
    );
    // A non-empty directory that is not a checkout of its own cannot be
    // saved, so it stays - and says so.
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: "1 working copy with no task is kept because its work could not be saved first: junk.",
    });
  });
});

/**
 * The last wake families on the typed envelope (the primitives review's P3):
 * every wake the host composes carries typed facts, and `renderWake` words
 * it where it is served. Every literal below is the text the prose
 * templates served before the move, byte for byte, read back through the
 * inbox the way the Firstmate's drain and a crewmate's lane read it.
 */
describe("the served text of every remaining wake (the typed envelope, P3)", () => {
  const MIN = 60_000;

  /** Age every lane row past the retry grace, as if two minutes had passed. */
  function ageRows(db: import("../storage/db").AppDatabase): void {
    db.prepare(
      "UPDATE inbox SET last_attempt_at = last_attempt_at - 120000, next_attempt_at = next_attempt_at - 120000 WHERE last_attempt_at IS NOT NULL",
    ).run();
  }

  it("a failed turn with nothing to retry, and a sign-in failure", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Checks",
      intent: intentOf("go"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const before = ops.length;
    crewmate.emit({ type: "continuation_started" });
    crewmate.emit({ type: "turn_failed", taskId, error: "Background command failed." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "continuation_ended", error: "Background command failed." });
    await tick();
    expect(ops.slice(before)).toEqual([
      `[fm-op] crewmate 1's turn on task ${taskId} "Checks" failed: Background command failed.. The crewmate is still steerable; you can retry, steer, or interrupt it.`,
    ]);

    const auth = fakeCrewmate();
    const signIn = setup(auth);
    const failed = await signIn.supervisor.intake.commission({
      title: "t",
      intent: intentOf("work"),
    });
    await tick();
    auth.emit({
      type: "turn_failed",
      taskId: failed.taskId,
      error: "401: Incorrect API key provided",
    });
    auth.emit({ type: "turn_end", taskId: failed.taskId });
    auth.finishPrompt();
    await tick();
    expect(signIn.ops).toEqual([
      `[fm-op] crewmate 1's turn on task ${failed.taskId} "t" failed: 401: Incorrect API key provided. The crewmate is still steerable; you can retry, steer, or interrupt it.`,
    ]);
  });

  it("a report, with what it filed and its cards on screen, and without", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix it"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    spec.onFollowup?.({ title: "Flaky meter test", goal: "g", why: "w" });
    spec.onFollowup?.({ title: "Unblock", goal: "g", why: "w", blocksMe: true });
    spec.onCard?.({ title: "PR 58 is merged", body: "<p>merged</p>", actions: [] });
    spec.onCard?.({ title: "Also merged", body: "<p>merged too</p>", actions: [] });
    await tick();
    await reportTurn(crewmate, taskId, "Meter fixed; two follow-ups filed.");
    expect(ops).toEqual([
      `[fm-op] crewmate 1 reported on task ${taskId} "Fix the meter": Meter fixed; two follow-ups filed. Filed this turn: SCR-2 "Flaky meter test" (not blocking), SCR-3 "Unblock" (blocks this task). Each waits on request, discovered from this task. It waits on SCR-3 "Unblock" (not started); nothing starts that work by itself. Its cards on the captain's screen: card-${taskId}-1 (note) "PR 58 is merged", card-${taskId}-2 (note) "Also merged".`,
    ]);

    const plain = fakeCrewmate();
    const bare = setup(plain);
    const job = await bare.supervisor.intake.commission({ title: "Job", intent: intentOf("go") });
    await tick();
    await reportTurn(plain, job.taskId, "All of it is done now.");
    expect(bare.ops).toEqual([
      `[fm-op] crewmate 1 reported on task ${job.taskId} "Job": All of it is done now.`,
    ]);
  });

  it("a task that failed, and the queued task whose wait it ended", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, tasks } = setup(crewmate);
    const first = await supervisor.intake.commission({
      title: "Doomed",
      intent: intentOf("will fail"),
    });
    await tick();
    const second = await supervisor.intake.commission({
      title: "Dependent",
      intent: intentOf("needs"),
      startAfter: { afterTask: first.taskId },
    });
    crewmate.failPrompt("crashed hard");
    await tick();
    const firstKey = tasks.get(first.taskId)?.key;
    const secondKey = tasks.get(second.taskId)?.key;
    expect(ops).toEqual([
      `[fm-op] task ${first.taskId} "Doomed" failed: crashed hard`,
      `[fm-op] queued task ${second.taskId} ${secondKey} "Dependent" waits on ${firstKey} "Doomed", which was failed, so its wait can never end; the dead edge is blocks ${firstKey} -> ${secondKey}.`,
    ]);
  });

  // INF-3169's piece 4, the captain's pick "Also fold the three into one
  // drop": the captain's own Discard click passes the work holds, so unmerged work
  // drops with its work saved, as a clean task does.
  it("a settle the captain chose: a discard of unmerged work and of a clean task, each an outcome", async () => {
    const { supervisor, tasks, workspace, ops } = setup(fakeCrewmate());
    seedTask(tasks, { id: "dirty", title: "Unlanded", status: "idle", worktreeDir: "/work" });
    seedTask(tasks, { id: "clean", title: "Clean", status: "idle", worktreeDir: "/clean" });
    vi.mocked(workspace.taskWorkStatus).mockResolvedValueOnce({ dirty: true, unlandedCommits: 2 });
    for (const taskId of ["dirty", "clean"]) {
      const id = supervisor.addFirstmateCard({
        taskId,
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [{ id: "discard", label: "Discard", default: true, effect: SETTLE_DISCARD }],
      });
      supervisor.cardActions.act(id, "discard");
      await vi.waitFor(() =>
        expect(settleWakes(ops).some((line) => line.includes(`task ${taskId} `))).toBe(true),
      );
    }
    expect(settleWakes(ops)).toEqual([
      `[fm-op] the captain chose discard for task dirty "Unlanded"; the host settled it and the outcome was: ${discardedText()}`,
      `[fm-op] the captain chose discard for task clean "Clean"; the host settled it and the outcome was: ${discardedText()}`,
    ]);
  });

  it("guidance set aside after its attempts", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, db, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    vi.mocked(crewmate.steer).mockRejectedValue(new Error("always busy"));
    await supervisor.steer.steerCrewmate(taskId, "urgent fix");
    for (let round = 0; round < 3; round += 1) {
      ageRows(db);
      await supervisor.watch.sweepInbox(Date.now());
    }
    expect(ops).toEqual([
      `[fm-op] guidance for task ${taskId} "Job" could not be delivered after 3 attempts and was set aside: urgent fix. You can interrupt the task or spawn a follow-up.`,
    ]);
  });

  it("the quiet watchdog and the wall-clock bound", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Marathon",
      intent: intentOf("long"),
    });
    await tick();
    const start = Date.now();
    supervisor.watch.checkQuietTasks(start + 21 * MIN);
    supervisor.watch.checkQuietTasks(start + 125 * MIN);
    await tick();
    expect(ops).toEqual([
      `[fm-op] crewmate 1 on task ${taskId} "Marathon" has produced no events for 21 minutes; it may be stuck. You can steer or interrupt it.`,
      `[fm-op] crewmate 1 on task ${taskId} "Marathon" has been on one turn for 2.1 hours.`,
    ]);
  });

  it("a queued start that failed wakes the first mate, and the one that started does not (INF-6536)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Queued",
      intent: intentOf("do"),
      startAfter: { at: Date.now() - 1 },
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new Error("a branch named 'fm/task-x' already exists"),
    );
    await supervisor.starts.dispatchQueuedTask(taskId);
    await supervisor.starts.dispatchQueuedTask(taskId);
    await tick();
    expect(ops).toEqual([
      `[fm-op] queued task ${taskId} "Queued" could not start: Could not commission a crewmate: a branch named 'fm/task-x' already exists`,
    ]);
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  it("a queued start of work the captain named a model for says which model took it (FI3-444)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops } = setup(crewmate);
    const { taskId, crewmate: handle } = await supervisor.intake.commission({
      title: "Queued on Fable",
      intent: intentOf("after the audit, on fable"),
      shape: { override_model_id: "claude-fable-5-1" },
      startAfter: { at: Date.now() - 1 },
    });
    expect(handle).toBe("queued");
    await supervisor.starts.dispatchQueuedTask(taskId);
    await tick();
    expect(ops).toEqual([
      `[fm-op] queued task ${taskId} "Queued on Fable" started - its wait ended. A crewmate is working on it now, on fm-mock/mock-1: claude-fable-5-1 was not available.`,
    ]);
  });

  it("a start someone asked for raises no started wake, and the captain's failed Start says he asked (FI3-695)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, ops, tasks } = setup(crewmate);
    // The Firstmate's own start_now: the tool's answer is its receipt, and
    // the start runs behind it (INF-3060) with no started wake.
    const own = supervisor.intake.plan({ title: "Own", intent: intentOf("do") });
    expect(await supervisor.starts.startQueuedNow(own.key)).toBe(
      `${own.key} "Own" is starting. Its tile shows any wait, such as for room on its computer; you hear an [fm-op] if it cannot start or waits for something its tile does not name.`,
    );
    await vi.waitFor(() => expect(tasks.get(own.id)?.status).toBe("active"));
    await vi.waitFor(() => expect(tasks.starts.startAttemptOf(own.id)).toBeUndefined());

    const planned = supervisor.intake.plan({ title: "Planned", intent: intentOf("do") });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new Error("a branch named 'fm/task-x' already exists"),
    );
    supervisor.hostOps.runTaskOp(planned.id, "start-task");
    await tick();
    expect(tasks.get(planned.id)?.status).toBe("open");
    // His Start that took raises nothing: his next context block lists it.
    supervisor.hostOps.runTaskOp(planned.id, "start-task");
    await tick();
    expect(tasks.get(planned.id)?.status).toBe("active");
    expect(ops).toEqual([
      `[fm-op] the captain pressed Start on task ${planned.id} "Planned", and it could not start: Could not commission a crewmate: a branch named 'fm/task-x' already exists`,
    ]);
  });

  it("the ask-first wait on a reasoning class", async () => {
    const { supervisor, ops } = setup(fakeCrewmate(), {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "premium",
        servedBucket: "high",
        rule: "R1a",
      },
      quotaGateCleared: () => true,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Later big one",
      intent: intentOf("big"),
      shape: { premium_ask: true },
      startAfter: { at: Date.now() - 1000 },
    });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(ops).toEqual([
      `[fm-op] task ${taskId} "Later big one" needs a premium model and none has quota right now; it waits on the premium quota reset unless you say otherwise, and a high model could serve it now.`,
    ]);
  });

  it("choices on the Firstmate's cards", async () => {
    const { supervisor, ops } = setup(fakeCrewmate());
    const one = supervisor.addFirstmateCard({
      title: "Which one?",
      body: "Two match.",
      actions: [{ id: "one", label: "One" }],
    });
    supervisor.cardActions.act(one, "one", "frame", { pick: 1 });
    const again = supervisor.addFirstmateCard({
      title: "Which again?",
      body: "Two match.",
      actions: [{ id: "two", label: "Two" }],
    });
    supervisor.cardActions.act(again, "two");
    await tick();
    expect(ops).toEqual([
      `[fm-op] a script chose "One" (one) on card "Which one?" (${one}).\nCard action value (JSON): {"pick":1}`,
      `[user]\nTwo\nChoice on card "Which again?" (${again}).`,
    ]);
  });

  it("choices on a crewmate's cards, as its steers", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs } = setup(crewmate);
    await supervisor.intake.commission({
      title: "Fix the flaky test",
      intent: intentOf("fix"),
    });
    await tick();
    const ways = syncCardId(
      specs[0]?.onCard?.({
        title: "Two ways",
        body: "<p>Awaiting the queue.</p><ul><li>Mocking.</li></ul>",
        actions: [
          { id: "await-queue", label: "Await the queue", default: true },
          { id: "mock-clock", label: "Mock the clock" },
        ],
      }),
    );
    crewmate.finishPrompt();
    await tick();
    const before = crewmate.promptCalls.length;
    supervisor.cardActions.act(ways ?? "", "await-queue");
    await tick();
    const pick = syncCardId(
      specs[0]?.onCard?.({
        title: "Pick",
        body: "<p>Pick.</p><p>Both.</p>",
        actions: [
          { id: "x", label: "X", default: true },
          { id: "y", label: "Y" },
        ],
      }),
    );
    crewmate.finishPrompt();
    await tick();
    supervisor.cardActions.act(pick ?? "", "x", "frame", [1]);
    await tick();
    expect(crewmate.promptCalls.slice(before)).toEqual([
      `Card "Two ways": the user chose "Await the queue" (await-queue).`,
      `Card "Pick": a script chose "X" (x).\nCard action value (JSON): [1]`,
    ]);
  });

  // Each reply names the captain message it is and the card's lifecycle, so
  // the crewmate's line answers exactly that question (INF-2225's approved
  // "named answers end only their question"; docs/card-threads.md "Shared cards").
  it("the captain's thread replies, with and without pictures", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Owner",
      intent: intentOf("emit"),
    });
    await tick();
    const card = syncCardId(
      specs[0]?.onCard?.({ title: "Owner note", body: "<p>The body.</p>", actions: [] }),
    );
    crewmate.finishPrompt();
    await tick();
    const lifecycle = cards().find((shown) => shown.id === card)?.lifecycleId;
    expect(lifecycle).toBeTruthy();
    const before = crewmate.promptCalls.length;
    const first = supervisor.cardActions.replyToCard(
      card ?? "",
      "  the checks failed on windows  ",
    );
    await tick();
    crewmate.finishPrompt();
    await tick();
    const second = supervisor.cardActions.replyToCard(card ?? "", "see this", [pngImage]);
    await tick();
    const asked = (thread: { messages: { id: number }[] }) =>
      ` This is the captain's message ${thread.messages.at(-1)?.id} in lifecycle ${lifecycle}; a line on this card answers it only when it names it in answers_message.`;
    expect(crewmate.promptCalls.slice(before)).toEqual([
      `${THREAD_STEER_PREAMBLE}\nCard "Owner note" (card-${taskId}-1).${asked(first)}\nThe captain's words, verbatim:\nthe checks failed on windows`,
      `${THREAD_STEER_PREAMBLE}\nCard "Owner note" (card-${taskId}-1).${asked(second)}\nThe captain's words, verbatim:\nsee this\n\n[attached: 1 picture: png]`,
    ]);
    expect(crewmate.promptImageCalls.at(-1)).toEqual([pngImage]);
  });

  it("the end of a timed wait, with and without its reason", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({ title: "Job", intent: intentOf("go") });
    await tick();
    crewmate.finishPrompt();
    await tick();
    const before = crewmate.promptCalls.length;
    tasks.placement.setGate(taskId, {
      kind: "at-time",
      until: Date.now() - 1,
      reason: "checks settle",
    });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    crewmate.finishPrompt();
    await tick();
    tasks.placement.setGate(taskId, { kind: "at-time", until: Date.now() - 1 });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    // The wake's whole words are the crewmate words table's; this case owns its reason riding along.
    const ended = crewmate.promptCalls.slice(before);
    expect(ended).toHaveLength(2);
    expect(ended[0]).toContain("was waiting for has come (checks settle).");
    expect(ended[1]).toContain("was waiting for has come. Carry on");
  });

  it("the Firstmate's lane holds these wakes as typed facts, never their wording", async () => {
    const crewmate = fakeCrewmate();
    const marathon = fakeCrewmate();
    const { supervisor, inbox, db } = setup(crewmate, { crewmates: [marathon] });
    // The real agent's notifyOp: the inbox's wake path.
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => {
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    const first = await supervisor.intake.commission({
      title: "Doomed",
      intent: intentOf("will fail"),
    });
    await tick();
    await supervisor.intake.commission({
      title: "Dependent",
      intent: intentOf("needs"),
      startAfter: { afterTask: first.taskId },
    });
    crewmate.failPrompt("crashed hard");
    await tick();
    await supervisor.intake.commission({ title: "Marathon", intent: intentOf("long") });
    await tick();
    const start = Date.now();
    supervisor.watch.checkQuietTasks(start + 21 * MIN);
    supervisor.watch.checkQuietTasks(start + 125 * MIN);
    const payloads = (
      db
        .prepare("SELECT payload FROM inbox WHERE recipient = ? ORDER BY id")
        .all(FIRSTMATE_RECIPIENT) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as { v: number; facts?: { kind: string } });
    expect(payloads.map((payload) => payload.facts?.kind)).toEqual([
      "task-failed",
      "dead-gate",
      "quiet",
      "long-turn",
    ]);
    expect(payloads.every((payload) => !("text" in payload))).toBe(true);
    // The dead wait built again, as the tick builds it, is not new information.
    await supervisor.watch.sweepGates(Date.now());
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(4);
  });

  it("a crewmate's lane holds the host's steers as typed facts until its turn ends", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const waiting = fakeQueuedSteerCrewmate();
    const { supervisor, specs, inbox, tasks } = setup(crewmate, { crewmates: [waiting] });
    const { taskId } = await supervisor.intake.commission({
      title: "Owner",
      intent: intentOf("emit"),
    });
    const timed = await supervisor.intake.commission({ title: "Waits", intent: intentOf("wait") });
    await tick();
    const card = syncCardId(
      specs[0]?.onCard?.({
        title: "Owner note",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [
          { id: "a", label: "A", default: true },
          { id: "b", label: "B" },
        ],
      }),
    );
    await tick();
    // Streaming on a backend that cannot take a steer mid-turn: the rows wait.
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.replyToCard(card ?? "", "see this", [pngImage]);
    tasks.placement.setGate(timed.taskId, { kind: "at-time", until: Date.now() - 1 });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(inbox.allFor(taskId).map((row) => [row.facts?.kind, row.text])).toEqual([
      ["attachments-kept", undefined],
    ]);
    expect(inbox.allFor(timed.taskId).map((row) => [row.facts?.kind, row.text])).toEqual([
      ["timed-wait-over", undefined],
    ]);
    expect(inbox.allFor(taskId)[0]?.facts).toMatchObject({
      guidance: { kind: "thread-reply", words: "see this" },
    });
  });
});
