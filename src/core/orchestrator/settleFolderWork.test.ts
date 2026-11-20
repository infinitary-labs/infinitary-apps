import type { Deliverable } from "@shared/routingPolicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { CardStore } from "../storage/cardStore";
import { InboxStore } from "../storage/inboxStore";
import { seedTask, type TaskSeed } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { askEndingOf } from "./askEnding";
import { CardService } from "./cardService";
import type { SettleServiceHost } from "./settleHost";
import { createSettleOwners } from "./settleOwners";

// INF-1279: a verified task in the project's folder finishes successfully,
// without treating the captain's folder as a disposable working copy.
const evidence =
  "Read the project files and verified that the existing draft and edits remain intact.";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(seed: Partial<TaskSeed> = {}) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const cards = new CardService({
    now: () => 1000,
    tasks,
    cardStore: new CardStore(db),
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  cleanups.push(() => {
    cards.dispose();
    db.close();
  });
  const task = seedTask(tasks, {
    id: "folder",
    title: "Check the project folder",
    status: "idle",
    outcome: evidence,
    repoDir: "/project",
    worktreeDir: "",
    branch: "",
    shape: {
      kind: "chore",
      kind_source: "test",
      deliverable: "change",
      in_place: { folder: true },
    },
    ...seed,
  });
  // Every workspace/forge entry point is forbidden for a successful folder close.
  const workspace = new Proxy(
    {},
    {
      get: (_target, name) => {
        throw new Error(`Workspace accessed: ${String(name)}`);
      },
    },
  );
  const host = {
    now: () => 1000,
    tasks,
    inbox,
    cards,
    askEnding: askEndingOf(tasks, cards),
    workspace,
    runtimeState: vi.fn((): "starting" | "streaming" | "idle" | undefined => undefined),
    stopRuntime: vi.fn((): Promise<void> | undefined => undefined),
    hasRunningJobs: vi.fn(() => false),
    killJobs: vi.fn(),
    endLiveTask: vi.fn(),
    isPersonalTask: vi.fn(() => false),
    deliverableOf: () => (task.shape?.deliverable ?? "change") as Deliverable,
    taskDelivery: () => undefined,
    taskAutonomy: () => false,
    resolveTaskRef: () => tasks.get(task.id)!,
    notifyOp: vi.fn(),
    pokeInbox: vi.fn(),
    sweepGates: vi.fn(async () => {}),
    broadcastCrewCounts: vi.fn(),
    broadcastEvent: vi.fn(),
    mergePullRequest: vi.fn(),
    closePullRequest: vi.fn(),
  } satisfies Omit<SettleServiceHost, "repos" | "workspace"> & { workspace: object };
  const owners = createSettleOwners(host as unknown as SettleServiceHost);
  return { task, tasks, cards, inbox, host, ...owners };
}

describe("verified folder-work completion", () => {
  it("records done/finished and evidence, keeps a note, and clears a dependent task through the owner", async () => {
    const h = setup();
    seedTask(h.tasks, { id: "next", title: "Use the checked folder", status: "queued" });
    h.tasks.graph.link(h.task.id, "next", "blocks", "firstmate");
    const note = h.cards.addFirstmateCard({
      taskId: h.task.id,
      title: "The folder was checked",
      body: "<p>The draft is intact.</p>",
      actions: [],
    });
    expect(
      (await h.done.close(h.task.id, { why: "finished", evidence: ` ${evidence} ` })).text,
    ).toContain("as finished");
    expect(h.tasks.get(h.task.id)).toMatchObject({
      status: "done",
      closedReason: "finished",
      worktreeDir: "",
      branch: "",
    });
    expect(
      h.tasks.timeline(h.task.id).find((event) => event.data?.completionEvidence !== undefined)
        ?.data,
    ).toMatchObject({ completionEvidence: evidence });
    expect(h.cards.get(note)).toBeDefined();
    expect(h.tasks.graph.flagsOf(h.tasks.get("next")!).blocked).toBe(false);
    expect(h.host.sweepGates).toHaveBeenCalled();
    expect(h.host.mergePullRequest).not.toHaveBeenCalled();
    expect(h.host.closePullRequest).not.toHaveBeenCalled();
    const events = h.tasks.timeline(h.task.id);
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    expect(h.tasks.timeline(h.task.id)).toEqual(events);
  });

  it("leaves a finished closing note rather than a discarded one", async () => {
    const h = setup();
    // The captain asked for the folder work, so its close answers them.
    h.tasks.capture.openAsk({ id: "ask-folder", text: "tidy the notes folder" });
    h.tasks.capture.attachAsk("ask-folder", h.task.id, "tool:create_task");
    h.tasks.capture.closeAsk("ask-folder", "closed");
    await h.closing.withClosingSentence(
      h.task.id,
      "The folder was checked and your edits remain intact.",
      () => h.done.close(h.task.id, { why: "finished", evidence }),
    );
    expect(h.cards.snapshot()).toMatchObject([
      { title: `${h.task.key} finished`, actions: [], answering: true },
    ]);
  });

  it.each([
    { status: "queued" },
    { status: "running" },
    { status: "interrupted" },
    { status: "cancelled" },
    { outcome: "" },
    {
      shape: {
        kind: "research",
        kind_source: "test",
        deliverable: "answer",
        in_place: { folder: true },
      },
    },
  ] satisfies Partial<TaskSeed>[])(
    "refuses unsupported or unfinished task facts %j",
    async (seed) => {
      const h = setup(seed);
      const before = h.tasks.get(h.task.id);
      expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
        "Cannot close",
      );
      expect(h.tasks.get(h.task.id)).toEqual(before);
      expect(h.host.stopRuntime).not.toHaveBeenCalled();
    },
  );

  it("requires evidence rather than inferring success from an idle report", async () => {
    const h = setup();
    expect((await h.done.close(h.task.id, { why: "finished", evidence: "  " })).text).toContain(
      "evidence",
    );
    expect(h.tasks.get(h.task.id)?.status).toBe("active");
  });

  it("keeps children and dependency holds intact", async () => {
    const h = setup();
    seedTask(h.tasks, {
      id: "child",
      title: "Unfinished check",
      status: "queued",
      parentId: h.task.id,
    });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).refusal?.refused).toBe(
      "children-open",
    );
    h.tasks.close("child", { status: "done", reason: "finished", actor: "host" });
    seedTask(h.tasks, { id: "blocker", title: "Required check", status: "idle" });
    h.tasks.graph.link("blocker", h.task.id, "blocks", "firstmate", true);
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).refusal).toBeDefined();
    expect(h.tasks.get(h.task.id)?.status).toBe("active");
  });

  it("never closes over a question, a captain wait, a job or queued guidance", async () => {
    const h = setup();
    const question = h.cards.addFirstmateCard({
      taskId: h.task.id,
      title: "Keep checking?",
      body: "<p>Continue?</p>",
      actions: [
        { id: "yes", label: "Continue", default: true },
        { id: "no", label: "Stop" },
      ],
    });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    h.cards.close(question, { kind: "firstmate" });
    seedDelivery(h.tasks, h.task.id, { captainWait: { reason: "Read the result", at: 1000 } });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    seedDelivery(h.tasks, h.task.id, { captainWait: undefined });
    h.host.hasRunningJobs.mockReturnValue(true);
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    h.host.hasRunningJobs.mockReturnValue(false);
    h.inbox.enqueue(h.task.id, "Please check another file");
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    expect(h.inbox.allFor(h.task.id)).toHaveLength(1);
    h.inbox.markDelivered(h.inbox.allFor(h.task.id).map((row) => row.id));
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    expect(h.inbox.inFlight(h.task.id)).toHaveLength(1);
    expect(h.host.stopRuntime).not.toHaveBeenCalled();
  });

  it("leaves a continuing turn, a check-back and a gate open", async () => {
    const h = setup();
    h.host.runtimeState.mockReturnValue("streaming");
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    h.host.runtimeState.mockReturnValue("idle");
    seedDelivery(h.tasks, h.task.id, {
      checkBack: { at: 1000, until: 2000, waitingFor: "The check to finish" },
    });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    seedDelivery(h.tasks, h.task.id, { checkBack: undefined });
    h.tasks.placement.setGate(h.task.id, { kind: "captain", reason: "A decision is pending" });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "Cannot close",
    );
    expect(h.host.stopRuntime).not.toHaveBeenCalled();
  });

  it("refuses its own pull request still open and another pending settle", async () => {
    const h = setup();
    seedDelivery(h.tasks, h.task.id, { prNumber: 7 });
    const pulls = {
      readPull: async () => ({ number: 7, state: "open", merged: false, headSha: "a" }),
    };
    Object.assign(h.host, pulls);
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "its own pull request #7 is still open",
    );
    seedDelivery(h.tasks, h.task.id, { prNumber: undefined });
    h.tasks.delivery.setPendingSettle(h.task.id, {
      mode: "land",
      actor: "captain",
      requestedAt: 1000,
      proceedWithOpen: false,
    });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain("settle");
    expect(h.host.stopRuntime).not.toHaveBeenCalled();
  });

  it("records closure before stopping can yield, and shares the existing settle exclusion", async () => {
    const h = setup();
    let stop!: () => void;
    h.host.stopRuntime.mockReturnValue(
      new Promise<void>((resolve) => {
        stop = resolve;
      }),
    );
    const closing = h.done.close(h.task.id, { why: "finished", evidence });
    await vi.waitFor(() => expect(h.tasks.get(h.task.id)?.status).toBe("done"));
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain("settle");
    stop();
    await closing;
    expect(h.host.stopRuntime).toHaveBeenCalledTimes(1);
  });
});

// INF-1430 piece 2 composes the same close owner for an operational effect.
describe("verified operation completion", () => {
  it("closes an operation done/finished from reported evidence without a merge", async () => {
    const h = setup({ shape: { kind: "unclear", deliverable: "operation" } });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "as finished",
    );
    expect(h.tasks.get(h.task.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.host.mergePullRequest).not.toHaveBeenCalled();
  });
  it("refuses merging and landing an operation before touching workspace or forge", async () => {
    const h = setup({ shape: { kind: "unclear", deliverable: "operation" } });
    for (const mode of ["merge-pr", "land"] as const) {
      expect(
        (await h.settle.settleTaskDetailed(h.task.id, mode, false, false, "captain")).text,
      ).toContain("operation");
    }
    expect(h.tasks.get(h.task.id)?.status).toBe("active");
  });
  it("requires both a report and an explicit verification statement", async () => {
    const h = setup({ outcome: "", shape: { kind: "unclear", deliverable: "operation" } });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "has not reported",
    );
    const reported = setup({ shape: { kind: "unclear", deliverable: "operation" } });
    expect(
      (await reported.done.close(reported.task.id, { why: "finished", evidence: "" })).text,
    ).toContain("evidence");
  });
});

// INF-1430: ordinary operations retain an isolated copy until their verified close.
it("retires an operation’s scratch working copy without merging it", async () => {
  const h = setup({
    worktreeDir: "/scratch-operation",
    branch: "fm/task-operation",
    shape: { kind: "unclear", deliverable: "operation" },
  });
  const retire = vi.fn(async () => ({ outcome: "removed", kept: null }));
  h.host.workspace = { retireTaskWorktree: retire };
  expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
    "as finished",
  );
  expect(retire).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/scratch-operation" }), {});
  expect(h.tasks.get(h.task.id)).toMatchObject({
    status: "done",
    closedReason: "finished",
    workspaceState: "removed",
  });
  expect(h.host.mergePullRequest).not.toHaveBeenCalled();
});

// INF-2971's finding 4: a work task whose own working copy delivered no
// change - a triage whose fix went to another task's branch - closes as
// finished, not discarded, and a copy holding work names the mode that would.
describe("a change task that delivered no change", () => {
  const ownCopy = {
    worktreeDir: "/task-copy",
    branch: "fm/task-triage",
    shape: { kind: "chore", kind_source: "test", deliverable: "change" },
  } satisfies Partial<TaskSeed>;

  function withCopy(work: { dirty: boolean; unlandedCommits: number } | Error) {
    const h = setup(ownCopy);
    const retire = vi.fn(async () => ({ outcome: "removed", kept: null }));
    const read = vi.fn(async () => {
      if (work instanceof Error) throw work;
      return work;
    });
    h.host.workspace = { taskWorkStatus: read, retireTaskWorktree: retire };
    return { ...h, retire, read };
  }

  it("closes done/finished after reading a clean copy, retiring it unmerged", async () => {
    const h = withCopy({ dirty: false, unlandedCommits: 0 });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "as finished",
    );
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/task-copy" }), {
      strict: true,
    });
    expect(h.tasks.get(h.task.id)).toMatchObject({
      status: "done",
      closedReason: "finished",
      workspaceState: "removed",
    });
    expect(
      h.tasks.timeline(h.task.id).find((event) => event.data?.completionEvidence !== undefined)
        ?.data,
    ).toMatchObject({ completionEvidence: evidence, noChange: true });
    expect(h.host.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    { dirty: true, unlandedCommits: 0 },
    { dirty: false, unlandedCommits: 2 },
  ])("holds a copy holding work %j for its delivery proof", async (work) => {
    const h = withCopy(work);
    const before = h.tasks.get(h.task.id);
    const { text } = await h.done.close(h.task.id, { why: "finished", evidence });
    expect(text).toContain("holds work that is not merged");
    expect(text).toContain("Soft hold proof");
    expect(h.tasks.get(h.task.id)).toEqual(before);
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("refuses when its crewmate starts a turn during the read", async () => {
    const h = withCopy({ dirty: false, unlandedCommits: 0 });
    h.read.mockImplementation(async () => {
      h.host.runtimeState.mockReturnValue("streaming");
      return { dirty: false, unlandedCommits: 0 };
    });
    expect((await h.done.close(h.task.id, { why: "finished", evidence })).text).toContain(
      "state changed",
    );
    expect(h.tasks.get(h.task.id)?.status).toBe("active");
  });
});
