/**
 * The settle owners over a real task record, inbox and card service, for
 * its guardrail tests (INF-2625's plan, the settle piece). One idle task,
 * "meter", delivers pull request #71 at `HEAD` in a GitHub project that asks
 * before merging. Every live fact the supervisor would supply is a field of
 * `live` a test changes, and every hook records what it heard.
 */
import type { ForgePull } from "../../src/core/forge";
import { askEndingOf } from "../../src/core/orchestrator/askEnding";
import type { CardService } from "../../src/core/orchestrator/cardService";
import type { MergeGuard, PrOutcome } from "../../src/core/orchestrator/changeMerge";
import type { SettleServiceHost } from "../../src/core/orchestrator/settleHost";
import { createSettleOwners, type SettleOwners } from "../../src/core/orchestrator/settleOwners";
import type { AppDatabase } from "../../src/core/storage/db";
import { InboxStore } from "../../src/core/storage/inboxStore";
import type { MergeAuthorization } from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import type { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { seedProject } from "../../src/core/workspace/seedProject";
import { setup as cardWorld } from "./cardServiceHarness";
import { freshDatabase } from "./database";
import { seedDelivery } from "./taskDelivery";

export const TASK = "meter";
export const HEAD = "a".repeat(40);
export const PR = 71;

/** The captain's standing approval of #71 at `HEAD`, as a click mints it. */
export function standingApproval(patch: Partial<MergeAuthorization> = {}): MergeAuthorization {
  return {
    version: 1,
    id: "approval-1",
    generation: 1,
    issuer: "captain",
    at: 1,
    card: { id: "card-done", offerId: "offer-1", actionId: "merge" },
    target: {
      repoId: "project",
      host: "github.com",
      owner: "o",
      name: "meter",
      prNumber: PR,
      branch: "fm/task-meter",
      delivery: "direct-pr",
      method: "squash",
    },
    approvedHead: HEAD,
    lineage: [],
    proceedWithOpen: false,
    status: "standing",
    ...patch,
  };
}

export type SettleWorld = SettleOwners & {
  db: AppDatabase;
  tasks: TaskService;
  inbox: InboxStore;
  repos: RepoRegistry;
  cards: CardService;
  /** The facts the supervisor reads live; a test changes them mid-settle. */
  live: {
    runtime: "starting" | "streaming" | "idle" | undefined;
    delivery: "direct-pr" | "local-only";
    autonomy: boolean;
    deliverable: "change" | "answer" | "operation";
    pull: ForgePull | undefined;
    work: { dirty: boolean; unlandedCommits: number } | null;
    /** Whether a commit the close names is on the main branch; null when it cannot be found. */
    onMain: boolean | null;
  };
  /** What the merge request answers; a test replaces it. */
  merge: (
    guard: Parameters<NonNullable<SettleServiceHost["mergePullRequest"]>>[1],
    boundary: Parameters<NonNullable<SettleServiceHost["mergePullRequest"]>>[2],
  ) => Promise<PrOutcome>;
  /** What reading the working copy does; a test replaces it. */
  readWork: () => Promise<{ dirty: boolean; unlandedCommits: number } | null>;
  /** Every hook call, in order, with what the record showed at that moment. */
  log: string[];
  wakes: unknown[];
};

/** `reviews`: the host can merge a stored review (a request_merge click). */
export function settleWorld(options: { reviews?: boolean } = {}): SettleWorld {
  const now = 1_000;
  const db = freshDatabase();
  seedProject(db, {
    id: "project",
    name: "Meter",
    path: "/not-mounted/project",
    origin: "https://github.com/o/meter.git",
    delivery: "direct-pr",
  });
  const repos = new RepoRegistry(db, "/not-mounted/fleet");
  // The task service reads each task's policies through the same projects
  // the settle does, as the app wires them: a project change is a policy change.
  const { tasks, make } = cardWorld(db, () => now, repos);
  const cards = make();
  const inbox = new InboxStore(db, { now: () => now });
  seedTask(tasks, {
    id: TASK,
    title: "Correct the meter",
    status: "idle",
    repoId: "project",
    repoDir: "/not-mounted/project",
    worktreeDir: "/not-mounted/worktree",
    branch: "fm/task-meter",
    outcome: "The meter reads on time.",
  });
  seedDelivery(tasks, TASK, { prNumber: PR, headSha: HEAD, ci: "green", ciAt: 0 });
  const log: string[] = [];
  const wakes: unknown[] = [];
  const state = (): string => {
    const record = tasks.get(TASK);
    return `${record?.status}/${record?.delivery?.mergeAuthorization?.status ?? "none"}`;
  };
  const world: Omit<SettleWorld, keyof SettleOwners> = {
    db,
    tasks,
    inbox,
    repos,
    cards,
    live: {
      runtime: "idle",
      delivery: "direct-pr",
      autonomy: false,
      deliverable: "change",
      pull: {
        number: PR,
        state: "open",
        merged: false,
        headSha: HEAD,
        branch: "fm/task-meter",
        base: "main",
        readiness: "clean",
      },
      work: { dirty: false, unlandedCommits: 0 },
      onMain: null,
    },
    merge: async () => ({ ok: true, text: `Merged #${PR} on GitHub.`, receipt: { head: HEAD } }),
    readWork: async () => world.live.work,
    log,
    wakes,
  };
  const workspace = {
    taskWorkStatus: async () => {
      const work = await world.readWork();
      if (!work) throw new Error("the working copy is gone");
      return work;
    },
    commitOnMain: async () => world.live.onMain,
    retireTaskWorktree: async () => {
      log.push(`retire worktree: ${state()}`);
      return { outcome: "removed" as const, kept: null };
    },
    removeTaskWorktree: async () => {
      log.push(`remove worktree: ${state()}`);
    },
  } as unknown as SettleServiceHost["workspace"];
  const owners = createSettleOwners({
    now: () => now,
    tasks,
    inbox,
    workspace,
    repos,
    cards,
    askEnding: askEndingOf(tasks, cards),
    runtimeState: () => world.live.runtime,
    // The stop settles on the next turn of the event loop's queue: what the
    // record shows then tells whether the close waited for it.
    stopRuntime: () => {
      log.push(`stop runtime: ${state()}`);
      return Promise.resolve().then(() => {
        log.push(`runtime stopped: ${state()}`);
      });
    },
    endLiveTask: () => {},
    mergePullRequest: (_taskId, guard, boundary) => {
      log.push(`merge: ${state()}`);
      return world.merge(guard, boundary);
    },
    ...(options.reviews
      ? {
          mergeReview: (_taskId: string, _reviewId: string, guard?: MergeGuard) => {
            log.push(`merge review: ${state()}`);
            return world.merge(guard, undefined);
          },
        }
      : {}),
    readPull: async (_taskId, number) =>
      world.live.pull?.number === number ? world.live.pull : undefined,
    closePullRequest: async () => {
      log.push(`close pull request: ${state()}`);
      return { ok: true, text: `Closed #${PR}.` };
    },
    isPersonalTask: () => false,
    deliverableOf: () => world.live.deliverable,
    taskDelivery: () => world.live.delivery,
    taskAutonomy: () => world.live.autonomy,
    resolveTaskRef: (ref) => {
      const record = tasks.resolve(ref);
      if (!record) throw new Error(`Unknown task "${ref}".`);
      return record;
    },
    notifyOp: (wake) => wakes.push(wake.facts),
    pokeInbox: () => {},
    sweepGates: async () => {},
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
  });
  return Object.assign(world, owners);
}
