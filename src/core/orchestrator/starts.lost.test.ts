/**
 * A start that loses its computer (INF-5142 part 4) and a task that branches
 * from work kept here starting on a computer that runs work (part 5). The
 * captain's words: "it shouldn't have required any user intervention". Each
 * case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) with one stand-in computer that runs work,
 * whose connection drops where a case says, and reads the record, its
 * timeline and the first mate's wakes.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AUTOMATIC_COMPUTER, placementSnapshotSchema } from "@shared/placement";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { DeviceOutOfReachError } from "../connection/connection";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { AutomaticPlacement } from "../placed/automaticPlacement";
import type { CrewMachines } from "../placed/crewMachines";
import { PreparationUnknown } from "../placed/placedCopies";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { checkedOutRefFor } from "../workspace/workspaceService";
import { lostStartLine, lostStepWords } from "./lostStarts";

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

const MACHINE = "875ece86-3e09-4c54-a108-15fafad9b31b";
const NAME = "the Mac mini";
// A second computer that runs work, where a source task's work lives.
const SOURCE_MACHINE = "2b0f6a1e-5c3d-4e7f-9a8b-1c2d3e4f5a6b";
const SOURCE_NAME = "the Windows PC";
// The words the connection raises when a computer goes mid-request.
const WENT = "The connection to that computer went mid-request.";

/** What `PlacedCopies.prepare` throws when the connection goes before the computer answers. */
const preparationLost = () =>
  new PreparationUnknown(`${NAME} could not confirm this task's working copy: ${WENT}`, {
    cause: new DeviceOutOfReachError(WENT),
  });

/**
 * A harness with computers that run work, and a task on one of them: set
 * to run there, placed there by Automatic (`automatic`), or run here and
 * replacing a task whose live work is on the second computer (`liveSource`).
 */
async function placedTask(
  options: {
    backlog?: boolean;
    branchFrom?: boolean;
    automatic?: boolean;
    liveSource?: boolean;
    // Another branch the live source's crewmate committed on there.
    checkedOutThere?: string;
    // The captain asked for the strongest model, and only a lower one is served now.
    premiumAsk?: boolean;
  } = {},
) {
  const crew = fakeCrewmate();
  const work = scratchDir("inf5142-worker-");
  const away = new Set<string>();
  const prepare = vi.fn(async (_machine: string, id: string) => ({
    cwd: work,
    branch: `fm/task-${id}`,
  }));
  const sourceRef = vi.fn(
    async (_machine: string, task: string, _repo: string | null, source: string) =>
      `refs/infinitary/sources/${task}-${source}`,
  );
  const bringBranchHome = vi.fn(async (): Promise<string | undefined> => undefined);
  const machines = {
    computers: () => [MACHINE, SOURCE_MACHINE],
    nameOf: (id: string) => (id === SOURCE_MACHINE ? SOURCE_NAME : NAME),
    placeOf: (id: string) => {
      const who = id === SOURCE_MACHINE ? SOURCE_NAME : NAME;
      return { who, where: `on ${who}` };
    },
    ready: (id: string) => !away.has(id),
    signInsOf: async () => null,
    served: async () => undefined,
    signInWait: () => undefined,
    accountOf: () => undefined,
    cutOffOf: () => undefined,
    servingAccount: () => undefined,
    takesCheckDeclarations: () => true,
    folders: () => ({
      work,
      sessions: join(work, "sessions"),
      evidence: join(work, "evidence"),
      temp: join(work, "temp"),
    }),
    prepare,
    bringBranchHome,
    // Without a branch named, it names no checkout, as a computer older than that answer does.
    checkedOut: async () =>
      options.checkedOutThere
        ? { branch: options.checkedOutThere, head: "4f80358a3c1e9d2b7f6a5e4d3c2b1a0f9e8d7c6b" }
        : null,
    factories: () => ({
      pi: { backend: "pi", controlProfile: PI_CONTROL_PROFILE, open: async () => crew },
    }),
    sourceFile: async (_m: string, _id: string, name: string) => join(work, name),
    sourceRef,
    install: async () => ({ outcome: "skipped" }),
  } as unknown as CrewMachines;
  let order = 0;
  const automatic = {
    // As Automatic does: commit the choice once, and keep it while it is not ended.
    choose: async (record: TaskRecord) => {
      h.tasks.placement.commitPlacement(record.id, () =>
        placementSnapshotSchema.parse({
          version: 1,
          at: Date.parse("2026-11-19T20:40:00Z"),
          computerId: MACHINE,
          computerName: NAME,
          physicalComputerId: "b".repeat(64),
          orderId: `order-${++order}`,
          demand: { cpu: 0.5, memoryBytes: 2 * 1024 ** 3 },
          model: { provider: "fm-mock", id: "mock-1" },
          acceptedFallback: false,
          requirements: { tools: [] },
          candidateCount: 1,
          candidates: [],
        }),
      );
      return {
        computerId: MACHINE,
        routed: { choice: { provider: "fm-mock", id: "mock-1" }, bucket: "high", rule: "R8" },
      };
    },
  } as unknown as Pick<AutomaticPlacement, "choose">;
  const h = setup(crew, {
    machines,
    ...(options.automatic ? { automatic } : {}),
    ...(options.premiumAsk
      ? {
          routeResult: {
            choice: { provider: "fm-mock", id: "mock-1" },
            bucket: "premium" as const,
            servedBucket: "high" as const,
            rule: "R0" as const,
          },
        }
      : {}),
  });
  const path = scratchDir("inf5142-repo-");
  execFileSync("git", ["-C", path, "init", "--initial-branch=main"], { stdio: "ignore" });
  // An origin makes the scratch project one a computer that runs work can take; no network call follows.
  execFileSync(
    "git",
    ["-C", path, "remote", "add", "origin", "https://github.com/infinitary-labs/example.git"],
    { stdio: "ignore" },
  );
  const repo = (await h.repos.setup({ kind: "adopt", path, name: "example" })).repo;
  if (options.automatic) h.repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
  // Work kept on this Mac: a working copy here with its branch.
  const source = options.branchFrom
    ? seedTask(h.tasks, {
        id: "5142bbbb",
        title: "Source work",
        repoId: repo.id,
        prompt: "p",
        status: "completed",
        worktreeDir: "/kept/here",
        branch: "fm/task-source",
      })
    : undefined;
  const task = seedTask(h.tasks, {
    id: "5142aaaa",
    title: "Placed work",
    repoId: repo.id,
    prompt: "do the placed work",
    status: "queued",
    startPolicy: options.backlog ? "on-request" : "when-ready",
    shape: {
      kind: "chore",
      deliverable: "change",
      ...(source ? { branch_from: source.key } : {}),
      ...(options.premiumAsk ? { premium_ask: true } : {}),
    },
  });
  // Live work on the second computer that this task, run here, replaces.
  if (options.liveSource) {
    const live = seedTask(h.tasks, {
      id: "5142dddd",
      title: "Live work",
      repoId: repo.id,
      prompt: "p",
      status: "completed",
      deviceId: SOURCE_MACHINE,
      worktreeDir: "/live/there",
      branch: "fm/task-live",
      shape: { kind: "chore", deliverable: "change" },
    });
    h.tasks.close(live.id, { status: "dropped", reason: "cancelled", actor: "host" });
    h.tasks.graph.link(live.id, task.id, "replaced-by", "firstmate");
  } else if (!options.automatic)
    h.tasks.updateFields(task.id, { runsOn: { ask: MACHINE, words: NAME } }, "firstmate");
  return { ...h, crew, prepare, sourceRef, bringBranchHome, away, repo, source, taskId: task.id };
}

const failedWakes = (ops: string[]) => ops.filter((op) => op.includes("could not start"));
const heardOf = (ops: string[], taskId: string) => ops.filter((op) => op.includes(taskId));

describe("a start that loses its computer", () => {
  it("goes back in line without a word to the first mate, and starts by itself on the next sweep", async () => {
    const h = await placedTask();
    h.prepare.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.tasks.get(h.taskId)).toMatchObject({
      status: "open",
      gate: null,
      startPolicy: "when-ready",
      deviceId: MACHINE,
    });
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      lostStartLine(NAME, "working-copy"),
    );
    expect(failedWakes(h.ops)).toEqual([]);
    // Ready for the sweep a returning computer runs.
    expect(h.tasks.graph.listReady().map((ready) => ready.id)).toContain(h.taskId);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.crew.promptCalls).toHaveLength(1);
    expect(heardOf(h.ops, h.taskId)).toEqual([]);
  });

  it("tells the first mate once, naming the step, when it is lost twice at the same step", async () => {
    const h = await placedTask();
    h.prepare.mockRejectedValue(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId).catch(() => {});
    const record = h.tasks.get(h.taskId);
    expect(record).toMatchObject({ status: "open", startedAt: null });
    expect(record?.startNotice).toContain(
      `went out of reach twice ${lostStepWords("working-copy")}`,
    );
    const wakes = failedWakes(h.ops);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(lostStepWords("working-copy"));
  });

  it("goes back in line again when the second loss is at a later step", async () => {
    const h = await placedTask({ branchFrom: true });
    h.prepare.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    // The loss arrives as the cause of the step's own error.
    h.sourceRef.mockRejectedValueOnce(
      new Error("Could not carry the work", { cause: new DeviceOutOfReachError(WENT) }),
    );
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.tasks.get(h.taskId)?.status).toBe("open");
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      lostStartLine(NAME, "brief"),
    );
    expect(failedWakes(h.ops)).toEqual([]);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
  });

  it("keeps the go of a start from the backlog", async () => {
    const h = await placedTask({ backlog: true });
    h.prepare.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.startQueuedNow(h.taskId, {
      audience: "captain",
      from: "task-card",
      direct: true,
    });
    await tick();
    await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.status).toBe("open"));
    expect(h.tasks.get(h.taskId)?.startPolicy).toBe("when-ready");
    expect(h.tasks.graph.listReady().map((ready) => ready.id)).toContain(h.taskId);
    expect(failedWakes(h.ops)).toEqual([]);
  });

  it("keeps a Start past the reasoning wait past it when it starts again", async () => {
    // Run here, so this Mac's routing reads the captain's ask; its brief reads the other computer.
    const h = await placedTask({ premiumAsk: true, backlog: true, liveSource: true });
    h.bringBranchHome.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    // The captain's Start on a lower model than asked, through the first mate's start_now.
    await h.supervisor.starts.startBehind(h.taskId, {
      ignoreAsk: true,
      requested: { by: "captain", from: "task-card" },
    });
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "open", gate: null });
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.bringBranchHome).toHaveBeenCalledTimes(2);
  });

  it("waits no more for a computer it no longer runs on", async () => {
    const h = await placedTask();
    h.prepare.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    h.away.add(MACHINE);
    h.tasks.updateFields(
      h.taskId,
      { runsOn: { ask: SOURCE_MACHINE, words: SOURCE_NAME } },
      "firstmate",
    );
    h.supervisor.placement.runsOnChanged(h.taskId);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.prepare).toHaveBeenLastCalledWith(
      SOURCE_MACHINE,
      h.taskId,
      h.repo.id,
      undefined,
      expect.any(String),
    );
  });

  it("is not a loss when the computer answered with a refusal", async () => {
    const h = await placedTask();
    h.prepare.mockRejectedValueOnce(new Error("a branch named 'fm/task-x' already exists"));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId).catch(() => {});
    expect(h.tasks.get(h.taskId)?.startPolicy).toBe("on-request");
    expect(failedWakes(h.ops)).toHaveLength(1);
  });
});

describe("a task that branches from work kept here", () => {
  it("starts on a computer that runs work with that work carried across", async () => {
    const h = await placedTask({ branchFrom: true });
    const source = h.source;
    if (!source) throw new Error("the case seeds a source");
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.sourceRef).toHaveBeenCalledWith(
      MACHINE,
      h.taskId,
      h.repo.id,
      source.id,
      "fm/task-source",
    );
    const carried = `refs/infinitary/sources/${h.taskId}-${source.id}`;
    expect(h.crew.promptCalls[0]).toContain(`git reset --hard ${carried}`);
  });

  it("is told nothing of that work when it starts on an approved version instead", async () => {
    const h = await placedTask({ branchFrom: true });
    const source = h.source;
    if (!source) throw new Error("the case seeds a source");
    // Its branch_from work is no longer here to carry; the approved version wins all the same.
    h.tasks.placement.setDevice(source.id, SOURCE_MACHINE);
    // An earlier part's approved version, whose working copy is on the computer this task runs on.
    vi.spyOn(h.tasks.graph, "approvedBase").mockImplementation((record) =>
      record.id === h.taskId
        ? {
            task: { ...source, deviceId: MACHINE },
            branch: "fm/task-approved",
            head: "a".repeat(40),
            carried: new Set<string>(),
          }
        : undefined,
    );
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.sourceRef).not.toHaveBeenCalled();
    expect(h.crew.promptCalls[0]).not.toContain("git reset --hard");
  });

  it("goes back in line when the computer goes while the work is carried", async () => {
    const h = await placedTask({ branchFrom: true });
    h.sourceRef.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "open", startPolicy: "when-ready" });
    expect(failedWakes(h.ops)).toEqual([]);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    // The working copy there is reused, not made again.
    expect(h.sourceRef).toHaveBeenCalledTimes(2);
  });
});

describe("a start Automatic placed that loses its computer", () => {
  it("keeps its order through two losses at the same step, tells the first mate once, and Start reconciles that order", async () => {
    const h = await placedTask({ automatic: true });
    h.prepare.mockRejectedValueOnce(preparationLost());
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    // The first loss: back in line, checking what that computer made.
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "open", deviceId: MACHINE });
    expect(h.tasks.starts.startAttemptOf(h.taskId)?.phase).toBe("checking");
    const placement = h.tasks.get(h.taskId)?.placement;
    expect(placement?.snapshot.orderId).toBe("order-1");
    expect(placement?.reservation).not.toBe("ended");
    expect(heardOf(h.ops, h.taskId)).toEqual([]);

    h.prepare.mockRejectedValueOnce(preparationLost());
    await h.supervisor.starts.dispatchQueuedTask(h.taskId).catch(() => {});
    const wakes = failedWakes(h.ops);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`went out of reach twice ${lostStepWords("working-copy")}`);
    expect(h.tasks.get(h.taskId)?.placement).toMatchObject({
      snapshot: { orderId: "order-1" },
    });
    expect(h.tasks.get(h.taskId)?.placement?.reservation).not.toBe("ended");

    await h.supervisor.starts.startQueuedNow(h.taskId, {
      audience: "captain",
      from: "task-card",
      direct: true,
    });
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.tasks.get(h.taskId)?.placement?.snapshot.orderId).toBe("order-1");
    expect(h.prepare).toHaveBeenCalledTimes(3);
    expect(failedWakes(h.ops)).toHaveLength(1);
  });

  it("keeps its first loss through an unconfirmed reply, so the second loss is still told once", async () => {
    const h = await placedTask({ automatic: true });
    h.prepare.mockRejectedValueOnce(preparationLost());
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    // The computer answered, but nothing confirmed the working copy.
    h.prepare.mockRejectedValueOnce(
      new PreparationUnknown(`${NAME} could not confirm this task's working copy.`),
    );
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.tasks.get(h.taskId)?.status).toBe("open");
    expect(failedWakes(h.ops)).toEqual([]);
    h.prepare.mockRejectedValueOnce(preparationLost());
    await h.supervisor.starts.dispatchQueuedTask(h.taskId).catch(() => {});
    const wakes = failedWakes(h.ops);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`went out of reach twice ${lostStepWords("working-copy")}`);
  });

  it("keeps a delegated backlog Start's go when its computer is back before the start settles", async () => {
    const h = await placedTask({ automatic: true, backlog: true });
    h.prepare.mockRejectedValueOnce(preparationLost());
    // The first mate's start_now on the captain's Start, run behind its answer;
    // the computer is back in reach by the time it settles.
    await h.supervisor.starts.startBehind(h.taskId, {
      ignoreAsk: true,
      requested: { by: "captain", from: "task-card" },
    });
    expect(h.tasks.get(h.taskId)).toMatchObject({
      status: "open",
      startPolicy: "when-ready",
      startNotice: null,
    });
    expect(heardOf(h.ops, h.taskId)).toEqual([]);
    // The next sweep starts it, and it is a started backlog task again.
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", startPolicy: "on-request" });
    expect(heardOf(h.ops, h.taskId)).toEqual([]);
  });
});

describe("a start whose brief reads from another computer", () => {
  it("hands on the other branch the source's crewmate committed on there, brought home to the source's own ref for it (INF-6378)", async () => {
    const h = await placedTask({ liveSource: true, checkedOutThere: "fm/task-live-dev" });
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.bringBranchHome).toHaveBeenCalledWith("5142dddd", true, "fm/task-live-dev");
    const brief = h.crew.promptCalls[0] ?? "";
    expect(brief).toContain(
      `Its starting work has been copied into this repository at ${checkedOutRefFor("5142dddd")}`,
    );
    expect(brief).not.toContain("Its work is on branch fm/task-live");
  });

  it("waits for that computer across sweeps and starts by itself once it is back", async () => {
    const h = await placedTask({ liveSource: true });
    // The source computer goes while its work is read, as a connection does.
    h.bringBranchHome.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "open", startPolicy: "when-ready" });
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      lostStartLine(SOURCE_NAME, "brief"),
    );
    // Away across a sweep: nothing tries the start, so nothing spends its second loss.
    h.away.add(SOURCE_MACHINE);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    expect(h.bringBranchHome).toHaveBeenCalledTimes(1);
    expect(h.tasks.get(h.taskId)?.status).toBe("open");
    h.away.delete(SOURCE_MACHINE);
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.bringBranchHome).toHaveBeenCalledTimes(2);
    expect(heardOf(h.ops, h.taskId)).toEqual([]);
  });

  it("waits no more once its brief no longer reads that source", async () => {
    const h = await placedTask({ liveSource: true });
    h.bringBranchHome.mockRejectedValueOnce(new DeviceOutOfReachError(WENT));
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    h.away.add(SOURCE_MACHINE);
    // It no longer replaces that task, so its brief reads nothing there.
    h.tasks.graph.unlink("5142dddd", h.taskId, "replaced-by", "firstmate");
    await h.supervisor.starts.dispatchQueuedTask(h.taskId);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.bringBranchHome).toHaveBeenCalledTimes(1);
    expect(heardOf(h.ops, h.taskId)).toEqual([]);
  });
});
