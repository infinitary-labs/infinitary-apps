/**
 * Where a start that began no crewmate leaves its task (`CrewStarts`;
 * docs/task-board.md, "A confirmed failure returns it to Backlog with
 * Could not start"). INF-3307's audit, row 4: a queued start whose working
 * copy failed went back to the queue still marked started, so its record
 * offered neither Start nor Drop and only the first mate could move it.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads the record, its moves, the cards
 * and the first mate's wakes.
 */
import { forgeSignInCardId } from "@shared/forges";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { TaskProtocol } from "../tasks/taskProtocol";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { startFailureReason } from "./starts";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

type Harness = ReturnType<typeof setup>;

/** The moves the task's record and board offer now, as `inf:task:run` reads them. */
function movesOf(ctx: Harness, taskId: string) {
  const protocol = new TaskProtocol({
    tasks: ctx.tasks,
    repos: ctx.repos,
    cards: {
      listOpen: () => ctx.cardStore.listOpen(),
      snapshot: () => ctx.supervisor.cards.snapshot(),
    },
    broadcastEvent: () => {},
    emit: () => {},
  });
  try {
    return protocol.detail(taskId).moves;
  } finally {
    protocol.dispose();
  }
}

const BRANCH_TAKEN = "a branch named 'fm/task-x' already exists";

describe("a start that began no crewmate", () => {
  // INF-3307 row 4: the sweep's failed start left neither Start nor Drop.
  it("returns a queued start whose working copy failed with Could not start, which Start tries again and Drop task drops", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, sessions, workspace, ops } = ctx;
    const { taskId } = await supervisor.intake.commission({
      title: "Queued",
      intent: intentOf("do the thing"),
      startAfter: { at: Date.now() - 1 },
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(new Error(BRANCH_TAKEN));
    await supervisor.starts.dispatchQueuedTask(taskId);
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: null,
      startedAt: null,
      startPolicy: "on-request",
      startNotice: JSON.stringify({ reason: BRANCH_TAKEN }),
    });
    expect(movesOf(ctx, taskId)).toMatchObject({
      "start-task": { ok: true },
      "drop-task": { ok: true },
    });
    expect(ops).toContain(
      renderWake({
        facts: {
          kind: "queued-start-failed",
          task: { id: taskId, title: "Queued" },
          error: `Could not commission a crewmate: ${BRANCH_TAKEN}`,
        },
      }),
    );
    // The captain kept its one Activity line, with the reason (INF-3392's finding 3).
    expect(
      tasks.timeline(taskId).filter((event) => event.text.startsWith("could not start")),
    ).toMatchObject([{ text: `could not start - ${BRANCH_TAKEN}`, feed: true }]);
    expect(tasks.graph.listReady().map((ready) => ready.id)).not.toContain(taskId);
    await supervisor.starts.startQueuedNow(taskId);
    await tick();
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  // INF-3307 row 4: the same start held for a sign-in kept its start time too.
  it("holds a queued start refused for its sign-in behind that sign-in, and Drop task still drops it", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, workspace, cards } = ctx;
    const { taskId } = await supervisor.intake.commission({
      title: "Queued",
      intent: intentOf("update the project"),
      startAfter: { at: Date.now() - 1 },
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new ForgeAuthRequiredError("could not read Username for GitHub"),
    );
    await supervisor.starts.dispatchQueuedTask(taskId);
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      startedAt: null,
      gate: { kind: "captain", ref: "forge-sign-in:github.com" },
    });
    await vi.waitFor(() =>
      expect(cards().some((card) => card.id === forgeSignInCardId("github.com"))).toBe(true),
    );
    expect(movesOf(ctx, taskId)).toMatchObject({ "drop-task": { ok: true } });
    await supervisor.resumeForgeSignInTasks("github.com");
    await vi.waitFor(() => expect(tasks.get(taskId)?.status).toBe("active"));
  });

  // A review starts on a record born active (INF-3060); its sign-in refusal holds it the same way.
  it("holds a review refused for its sign-in behind that sign-in and answers that it is queued", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, workspace, cards } = ctx;
    tasks.create({
      id: "review",
      title: "Review",
      prompt: "read it",
      repoId: null,
      status: "active",
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new ForgeAuthRequiredError("could not read Username for GitHub"),
    );
    await expect(
      supervisor.starts.startTask({
        taskId: "review",
        title: "Review",
        brief: "read it",
        repoId: null,
        routed: undefined,
        fresh: true,
      }),
    ).resolves.toEqual({ taskId: "review", crewmate: "queued" });
    expect(tasks.get("review")).toMatchObject({
      status: "open",
      gate: { kind: "captain", ref: "forge-sign-in:github.com" },
    });
    await vi.waitFor(() =>
      expect(cards().some((card) => card.id === forgeSignInCardId("github.com"))).toBe(true),
    );
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 0 });
  });

  // A spawn nobody waits on leaves nothing behind when it fails (`cleanupFailedSpawn`).
  it("erases a review whose start failed when nobody asked for it", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, workspace } = ctx;
    tasks.create({
      id: "review",
      title: "Review",
      prompt: "read it",
      repoId: null,
      status: "active",
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(new Error(BRANCH_TAKEN));
    await expect(
      supervisor.starts.startTask({
        taskId: "review",
        title: "Review",
        brief: "read it",
        repoId: null,
        routed: undefined,
        fresh: true,
      }),
    ).rejects.toThrow(BRANCH_TAKEN);
    expect(tasks.get("review")).toBeUndefined();
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 0 });
  });

  // INF-3060: a start the first mate asked for that failed stays open for its go.
  it("keeps a start the first mate asked for open with Could not start when its project is gone", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, repos, ops } = ctx;
    const { repo } = await repos.setup({ kind: "init", name: "notes" });
    const task = supervisor.intake.plan({
      title: "Tidy",
      intent: intentOf("tidy the notes"),
      repoId: repo.id,
    });
    repos.unregister(repo.id);
    expect(await supervisor.starts.startQueuedNow(task.id)).toContain("is starting.");
    await vi.waitFor(() => expect(tasks.get(task.id)?.startNotice).toBeTruthy());
    expect(tasks.get(task.id)).toMatchObject({
      status: "open",
      startedAt: null,
      startPolicy: "on-request",
    });
    expect(movesOf(ctx, task.id)).toMatchObject({
      "start-task": { ok: true },
      "drop-task": { ok: true },
    });
    expect(ops.some((op) => op.includes("which you started, could not start"))).toBe(true);
    // The first mate hears it; Activity gets no second line (INF-3392's re-review).
    expect(
      tasks.timeline(task.id).filter((event) => event.text.startsWith("could not start")),
    ).toMatchObject([{ feed: false }]);
  });

  // docs/task-board.md: the captain's Start that fails returns the task to Backlog with Could not start.
  it("returns the captain's Start on a backlog task whose project is gone to Backlog with Could not start", async () => {
    const ctx = setup(fakeCrewmate());
    const { supervisor, tasks, repos } = ctx;
    const { repo } = await repos.setup({ kind: "init", name: "notes" });
    const task = supervisor.intake.plan({
      title: "Tidy",
      intent: intentOf("tidy the notes"),
      repoId: repo.id,
    });
    repos.unregister(repo.id);
    const said = await supervisor.starts.startQueuedNow(task.id, {
      audience: "captain",
      direct: true,
    });
    expect(said).toContain("could not start");
    // Its reply says so; Activity gets no second line (INF-3392's re-review).
    expect(
      tasks.timeline(task.id).filter((event) => event.text.startsWith("could not start")),
    ).toMatchObject([{ feed: false }]);
    expect(tasks.get(task.id)).toMatchObject({
      status: "open",
      startedAt: null,
      startPolicy: "on-request",
    });
    expect(tasks.get(task.id)?.startNotice).toBeTruthy();
    expect(movesOf(ctx, task.id)).toMatchObject({
      "start-task": { ok: true },
      "drop-task": { ok: true },
    });
  });

  // The captain chose "Show only the cause": git's raw failure filled the record's bar.
  it("says only the cause of a failed command in one line, with no command or folder paths", () => {
    // The message git gave a real start whose branch another working copy held.
    const failed = new Error(
      [
        "Command failed: /usr/sbin/taskpolicy -c utility /Users/someone/Library/Application Support/infinitary/vendor/git/bin/git -C /Users/someone/code/notes worktree add /Users/someone/Library/Application Support/infinitary/worktrees/lp-a fm/task-lp-a",
        "Preparing worktree (checking out 'fm/task-lp-a')",
        "fatal: 'fm/task-lp-a' is already used by worktree at '/Users/someone/Library/Application Support/infinitary/held-lp-a'",
        "",
      ].join("\n"),
    );
    expect(startFailureReason(failed)).toBe(
      "'fm/task-lp-a' is already used by worktree at 'held-lp-a'",
    );
    expect(startFailureReason(new Error(BRANCH_TAKEN))).toBe(BRANCH_TAKEN);
  });

  // INF-3398's proof read: a ref or an address is not a folder, and the command is never the cause.
  it("keeps git's refs and addresses whole, and says only that a silent command failed", () => {
    const command =
      "Command failed: /usr/sbin/taskpolicy -c utility /Users/someone/Library/Application Support/infinitary/vendor/git/bin/git -C /Users/someone/code/notes fetch origin";
    expect(
      startFailureReason(
        new Error(
          `${command}\nfatal: couldn't find remote ref refs/heads/fm/task-x from https://github.com/o/r.git/\n`,
        ),
      ),
    ).toBe("couldn't find remote ref refs/heads/fm/task-x from https://github.com/o/r.git/");
    expect(startFailureReason(new Error(`${command}\n`))).toBe("the command failed");
  });
});
