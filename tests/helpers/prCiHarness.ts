/**
 * The shared stand-in for where a project lives in the change delivery tests
 * (INF-2625's plan): one fake forge whose change, checks and failures a test
 * moves between calls, and the service wired as the app wires it over a
 * fresh database and a scratch project folder.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, vi } from "vitest";
import type { Batches } from "../../src/core/batches/batches";
import {
  type Forge,
  type ForgeChange,
  type ForgeCheckState,
  type ForgeError,
  ForgeWriteError,
  type MergeAnswer,
} from "../../src/core/forge";
import {
  type ChangeDelivery,
  createChangeDelivery,
} from "../../src/core/orchestrator/changeDelivery";
import { ChangePresentations } from "../../src/core/orchestrator/changePresentations";
import type { TypedWake } from "../../src/core/orchestrator/wakes";
import type { AppDatabase } from "../../src/core/storage/db";
import { seedTask, type TaskSeed } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import type { MergeWay } from "../../src/shared/batches";
import type { KnownForgeHost } from "../../src/shared/forge";
import type { NamingRule } from "../../src/shared/runbooks";
import { freshDatabase } from "./database";
import { BUNDLED_NAMING } from "./namingRunbook";
import { scratchDir } from "./scratchDirs";
import { seedDelivery } from "./taskDelivery";

/** A forge whose change, checks and failures the test moves between calls. */
export class FakeForge implements Forge {
  readonly kind;
  readonly host;
  readonly place;
  readonly hasChecks;
  change: ForgeChange | null = {
    number: 23,
    url: "https://github.com/x/y/pull/23",
    branch: "fm/task-ab12cd34",
    headSha: "feedbeef",
    title: "fix: ship it",
  };
  states: ForgeCheckState[] = ["success"];
  names?: string[];
  /** Each check's start and finish as the host gives them, by position. */
  times?: { startedAt?: number; finishedAt?: number }[];
  fail: Partial<
    Record<
      "changeFor" | "checks" | "putIn" | "close" | "openChange" | "updateChangeBody",
      ForgeError | Error
    >
  > = {};
  /** The description the host holds after a replacement: a person's edit that raced it. */
  heldAfterWrite?: string;
  /** What `openChange` offers the branch as. */
  opened: Omit<ForgeChange, "branch"> = {
    number: 42,
    url: "https://github.com/x/y/pull/42",
    headSha: "cafe0042",
    title: "fix: ship it",
  };
  failChangeForTimes = 0;
  /** The checks GitHub holds at named versions, or its refusal there; other versions read `states`. */
  atHead: Record<
    string,
    { name: string; state: ForgeCheckState; statusId?: number; detail?: string }[] | Error
  > = {};
  readonly calls: string[] = [];

  constructor(where: { kind?: Forge["kind"]; place?: string | null } = {}) {
    this.kind = where.kind ?? "github";
    this.host = this.kind === "github" ? "github.com" : "git.example.com";
    this.place = where.place === undefined ? "GitHub" : where.place;
    this.hasChecks = this.kind === "github";
  }

  async listProjects() {
    return [];
  }
  async defaultBranch() {
    return "main";
  }
  drafts: boolean[] = [];
  /** The base each opening asked for; undefined is the default branch. */
  bases: (string | undefined)[] = [];
  async openChange(input: {
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
    base?: string;
  }): Promise<ForgeChange> {
    this.drafts.push(input.draft === true);
    this.bases.push(input.base);
    this.calls.push(`openChange ${input.branch} ${input.title}`);
    if (this.fail.openChange) throw this.fail.openChange;
    this.change = {
      ...this.opened,
      branch: input.branch,
      ...(input.base ? { base: input.base } : {}),
    };
    return this.change;
  }
  /** GitHub's and GitLab's conditional write: refused unless the change is as just read. */
  async updateChangeBody(change: ForgeChange, body: string, title?: string): Promise<void> {
    this.calls.push(`updateChangeBody ${this.label(change)}`);
    if (this.fail.updateChangeBody) throw this.fail.updateChangeBody;
    if (
      !this.change ||
      this.change.headSha !== change.headSha ||
      (this.change.body ?? "") !== (change.body ?? "") ||
      (title !== undefined && this.change.title !== change.title)
    )
      throw new ForgeWriteError("failed", "refused", "The pull request changed after it was read.");
    this.change = {
      ...this.change,
      body: this.heldAfterWrite ?? body,
      ...(title === undefined ? {} : { title }),
    };
  }
  async changeFor(branch: string) {
    this.calls.push(`changeFor ${branch}`);
    if (this.failChangeForTimes > 0) {
      this.failChangeForTimes -= 1;
      throw this.fail.changeFor ?? new Error("changeFor failed");
    }
    return this.change ? { ...this.change, branch } : null;
  }
  failReady: Error | undefined;
  async markReady(change: ForgeChange, beforeSend: () => void) {
    beforeSend();
    this.calls.push(`markReady ${change.headSha}`);
    if (this.failReady) throw this.failReady;
    this.change = { ...change, draft: false, title: change.title?.replace(/^Draft: /, "") };
    return this.change;
  }
  branchesAt?: Forge["branchesAt"];
  /** The default branch's own checks, where a test gives the host them. */
  branchChecks?: Forge["branchChecks"];
  async checks(change: ForgeChange, movedPast?: string) {
    const headSha = movedPast ?? change.headSha;
    this.calls.push(`checks ${headSha}`);
    if (this.fail.checks) throw this.fail.checks;
    const held = this.atHead[headSha];
    if (held instanceof Error) throw held;
    const items =
      held ??
      this.states.map((state, index) => ({
        name: this.names?.[index] ?? (index === 0 ? "linux-checks" : `check-${index}`),
        state,
        ...this.times?.[index],
      }));
    return { items };
  }
  async putIn(
    change: ForgeChange,
    headSha: string,
    _way?: MergeWay,
  ): Promise<MergeAnswer | undefined> {
    this.calls.push(`putIn ${change.branch} ${headSha}`);
    if (this.fail.putIn) throw this.fail.putIn;
    return undefined;
  }
  async close(change: ForgeChange) {
    this.calls.push(`close ${change.branch}`);
    if (this.fail.close) throw this.fail.close;
  }
  label(change: ForgeChange) {
    return change.number !== undefined ? `#${change.number}` : change.branch;
  }
  url(change: ForgeChange) {
    return change.url;
  }
}

/** What a placed task's computer says its working copy has checked out (`ChangeDeliveryOptions`' `checkedOut`). */
export type CheckedOut = (
  taskId: string,
) => Promise<{ branch: string | null; head: string; dirty?: boolean } | null>;

export type PrCiHarness = {
  db: AppDatabase;
  tasks: TaskService;
  repos: RepoRegistry;
  service: ChangeDelivery;
  forge: FakeForge;
  paths: string;
  presentations: ChangePresentations;
  readHead: Mock<() => Promise<string>>;
};

export function setup(
  options: {
    forge?: FakeForge;
    now?: () => number;
    onNote?: (text: string) => void;
    /** The steer to a task's crewmate, as the app wires it to the inbox. */
    steer?: (taskId: string, wake: TypedWake) => void;
    /** Check commit names against real git rather than skipping the check. */
    realRange?: boolean;
    prepareContribution?: (taskId: string) => Promise<string | undefined>;
    bringBranchHome?: (taskId: string) => Promise<string | undefined>;
    /** The branch a placed task's working copy has checked out there, wired as the app wires it. */
    checkedOut?: CheckedOut;
    /** Enterprise forge hosts registered with the app. */
    knownHosts?: () => readonly KnownForgeHost[];
    /** One forge per project, by its origin, where a test names more than one project. */
    forgeFor?: (repo: { origin?: string | null } | undefined) => FakeForge;
    /** The active naming runbook's rule, as the app reads it; the bundled one, on by default, unless a test names another. */
    namingRule?: () => NamingRule | null;
    /** The line and open batch of projects that get batches of the person's own, read late as the app wires it. */
    batches?: () => Batches | undefined;
  } = {},
): PrCiHarness {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const paths = scratchDir("infinitary-prci-");
  const repos = new RepoRegistry(db, join(paths, "fleet"), {
    knownHosts: options.knownHosts,
  });
  const forge = options.forge ?? new FakeForge();
  const readHead = vi.fn(async () => forge.change?.headSha ?? "");
  const namingRule = options.namingRule ?? (() => BUNDLED_NAMING);
  const presentations: ChangePresentations = new ChangePresentations({
    namingRule,
    tasks,
    mediaDir: () => paths,
    head: readHead,
    ...(options.checkedOut
      ? { branch: (taskId) => service.publication.presentationBranch(taskId) }
      : {}),
  });
  const service: ChangeDelivery = createChangeDelivery({
    namingRule,
    tasks,
    repos,
    forgeFor: options.forgeFor ?? (() => forge),
    presentations,
    ...(options.prepareContribution ? { prepareContribution: options.prepareContribution } : {}),
    ...(options.checkedOut ? { checkedOut: options.checkedOut } : {}),
    ...(options.bringBranchHome ? { bringBranchHome: options.bringBranchHome } : {}),
    ...(options.realRange ? {} : { validateRange: async () => {} }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onNote ? { onNote: options.onNote } : {}),
    ...(options.steer ? { steer: options.steer } : {}),
    ...(options.batches ? { batches: options.batches } : {}),
  });
  return { db, tasks, repos, service, forge, paths, presentations, readHead };
}

export function insertTask(tasks: TaskService, overrides: Partial<TaskSeed> = {}): void {
  seedTask(tasks, {
    id: "ab12cd34",
    title: "Ship it",
    prompt: "work",
    repoId: null,
    repoDir: tmpdir(),
    worktreeDir: tmpdir(),
    branch: "fm/task-ab12cd34",
    sessionFile: null,
    accountId: null,
    status: "idle",
    createdAt: Date.now(),
    ...overrides,
  });
}

export async function insertDirectPrTask(
  tasks: TaskService,
  repos: RepoRegistry,
  overrides: Partial<TaskSeed> = {},
): Promise<void> {
  const { repo } = await repos.setup({
    kind: "init",
    name: `pr-${overrides.id ?? "ab12cd34"}`,
  });
  repos.configure(repo.id, { delivery: "direct-pr" });
  insertTask(tasks, { repoId: repo.id, repoDir: repo.path, ...overrides });
}

/** The host learned of the task's PR: what `pr_opened` records. */
export function recordPr(tasks: TaskService, number: number, id = "ab12cd34"): void {
  seedDelivery(tasks, id, { prNumber: number, prUrl: `https://github.com/x/y/pull/${number}` });
}
