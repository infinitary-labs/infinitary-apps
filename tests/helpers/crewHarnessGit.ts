/**
 * Real git for the crew supervisor's tests: a project folder with one
 * empty commit on main, and the captain's kept merge approval (FI3-304) as
 * its tests meet it - a direct-pr task on a real project folder whose
 * crewmate put its completion card up through the real checks gate, a
 * GitHub or GitLab stand-in, and that card clicked once. It is apart from
 * crewHarness.ts so a test file that spawns git says so in its own imports.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  type ForgeReadiness,
  type MergeAnswer,
} from "@core/forge";
import { type ChangeDelivery, createChangeDelivery } from "@core/orchestrator/changeDelivery";
import { ChangePresentations } from "@core/orchestrator/changePresentations";
import type { LineageFacts } from "@core/orchestrator/mergeAuthorization";
import { seedTask } from "@core/tasks/seedTask";
import type { Card } from "@shared/cards";
import type { CheckChangeInput } from "@shared/checkRepair";
import { expect, vi } from "vitest";
import {
  bundledRunbooks,
  completionBody,
  fakeCrewmate,
  intentOf,
  SETTLE_MERGE,
  setup,
  tick,
} from "./crewHarness";
import { scratchDir } from "./scratchDirs";

/** A project folder on main with one empty commit, named as the task's project. */
export function gitRepo(name = "meterlab") {
  const dir = scratchDir("infinitary-crew-git-");
  execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return { dir, name, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The host's refusal of the kept merge for a conflict, as GitHub words it. */
export const conflict =
  "GitHub answered 405 to PUT /repos/o/r/pulls/7/merge: Pull Request has merge conflicts";
/** The head the captain approved, the head a repair pushes, and the newer base it sits on. */
export const APPROVED = "approved0001";
export const REPAIRED = "repaired0002";
export const NEW_BASE = "mainmoved003";
/** What git reads of a repair that kept the approved work on the newer base. */
export const cleanFacts: Extract<LineageFacts, { known: true }> = {
  known: true,
  toHeadHere: true,
  baseInTo: true,
  approvedPaths: ["src/meter.ts"],
  repairedPaths: ["src/meter.ts"],
};
/** The crewmate's declaration of what a repair it pushed did to the approved work. */
export const repair = (
  impact: "none" | "changed-work" | "unknown",
  fromHead = APPROVED,
  changedPaths: string[] = [],
): CheckChangeInput => ({
  conflictRepair: {
    fromHead,
    toHead: REPAIRED,
    newBase: NEW_BASE,
    impact,
    changedPaths,
    evidence: "git range-diff shows the approved commit unchanged on the newer base",
    validation: "pnpm test src/meter.test.ts at the repaired head",
  },
});
/**
 * GitHub - or GitLab, with its merge request - as the approval meets it:
 * one pull request, its checks and readiness, and each merge it accepted.
 */
export class KeptForge implements Forge {
  readonly host: string;
  readonly place: string;
  readonly hasChecks = true;
  constructor(readonly kind: "github" | "gitlab" = "github") {
    this.host = kind === "github" ? "github.com" : "gitlab.com";
    this.place = kind === "github" ? "GitHub" : "GitLab";
  }
  headSha = APPROVED;
  states: ForgeCheckState[] = ["success"];
  /** Main's newest run of the checks, once a test gives one (INF-1915 fix 1). */
  branchChecks?: Forge["branchChecks"];
  mainRuns(states: ForgeCheckState[], sha = "ma1n0000feed") {
    this.branchChecks = async () => ({
      sha,
      checks: { items: states.map((state) => ({ name: "linux-checks", state })) },
    });
  }
  readiness: ForgeReadiness = "clean";
  /** The merge request's answer when it refuses; undefined merges. */
  refuse: ForgeError | undefined;
  merged = false;
  referencedBranch?: string;
  /** The heads GitHub merged, in order. */
  merges: string[] = [];
  /** The squash summary each merge request carried, in order. */
  squashes: (string | undefined)[] = [];
  /** The pull request's description, as GitHub shows it. */
  body = "";
  sends = 0;
  /** The host's merge names no version, as Bitbucket's does (`Forge.mergeNamesNoVersion`). */
  mergeNamesNoVersion?: true;
  /** The merges the host took and then said failed, by its own reference to each. */
  failedTasks = new Set<string>();
  async mergeTaskFailed(_number: number, task: string) {
    return this.failedTasks.has(task);
  }
  async listProjects() {
    return [];
  }
  async defaultBranch() {
    return "main";
  }
  async openChange(input: { branch: string }): Promise<ForgeChange> {
    return this.change(input.branch);
  }
  async changeFor(branch: string) {
    return this.merged || (this.referencedBranch && branch !== this.referencedBranch)
      ? null
      : this.change(branch);
  }
  /** Runs inside each checks read: what else happens while the gates are read. */
  duringChecks: () => void = () => {};
  async checks() {
    this.duringChecks();
    const items: ForgeCheck[] = this.states.map((state) => ({ name: "linux-checks", state }));
    return { items };
  }
  /** The branch has a merge queue of GitHub's own: a merge request is taken into it, never merged at once. */
  hostQueue = false;
  /** Whether that queue holds the pull request now. */
  inQueue = false;
  /** How many times that queue was read. */
  queueReads = 0;
  async putIn(_change: ForgeChange, headSha: string): Promise<MergeAnswer> {
    this.sends += 1;
    if (this.refuse) throw this.refuse;
    if (this.hostQueue) {
      this.inQueue = true;
      return { queued: true };
    }
    this.merges.push(headSha);
    this.squashes.push(_change.squashMessage);
    this.merged = true;
    return { sha: `squash-${headSha}` };
  }
  async inHostQueue() {
    this.queueReads += 1;
    return this.inQueue;
  }
  /** GitHub's queue merges the pull request it holds. */
  queueMerges() {
    this.inQueue = false;
    this.merged = true;
  }
  /** Pull requests that read open whatever the task's own reads (INF-2490). */
  openNumbers = new Set<number>();
  /** Pull requests the host cannot read (INF-2546). */
  unreadable = new Set<number>();
  async pull(number: number): Promise<ForgePull> {
    if (this.unreadable.has(number))
      throw new ForgeError("transient", `GitHub answered 502 to GET /repos/o/r/pulls/${number}`);
    if (this.openNumbers.has(number))
      return {
        number,
        state: "open",
        merged: false,
        headSha: this.headSha,
        base: "main",
        readiness: "clean",
      };
    return {
      number,
      state: this.merged ? "closed" : "open",
      merged: this.merged,
      ...(this.merged ? { mergedSha: `squash-${this.headSha}` } : {}),
      headSha: this.headSha,
      base: "main",
      readiness: this.readiness,
      ...(this.mergeNamesNoVersion ? { mergeNamesNoVersion: true as const } : {}),
      ...(this.referencedBranch
        ? { branch: this.referencedBranch, headRepo: "o/r", title: "fix: ship the meter" }
        : {}),
    };
  }
  async close() {}
  label(change: ForgeChange) {
    return this.kind === "gitlab" ? `!${change.number}` : `#${change.number}`;
  }
  url(change: ForgeChange) {
    return change.url;
  }
  private change(branch: string): ForgeChange {
    return {
      number: 7,
      url:
        this.kind === "gitlab"
          ? "https://gitlab.com/group/sub/r/-/merge_requests/7"
          : "https://github.com/o/r/pull/7",
      branch,
      headSha: this.headSha,
      title: "fix: ship the meter",
      body: this.body,
    };
  }
}
/**
 * A direct-pr task on a project that lives on GitHub whose crewmate put
 * its completion card up through the real checks gate and went idle:
 * the real check service, the real click, a GitHub stand-in.
 */
/** The goal a filed task records in place of the captain's words. */
export const FILED_GOAL = "The meter reads the same value after a restart.";

/** A follow-up filed with a goal and no intent, then started now. */
async function startFiled(harness: ReturnType<typeof setup>, repoId: string): Promise<string> {
  seedTask(harness.tasks, {
    id: "filed-meter",
    title: "Ship the meter",
    prompt: `Goal: ${FILED_GOAL}`,
    goal: FILED_GOAL,
    repoId,
    status: "queued",
    startPolicy: "on-request",
  });
  await harness.supervisor.starts.startQueuedNow("filed-meter");
  return "filed-meter";
}

export async function approved(
  where: {
    forgeFor?: (repo: import("@core/forge").ForgeRepo | undefined, own: KeptForge) => Forge;
    kind?: "github" | "gitlab";
    referenced?: boolean;
    internalStep?: boolean;
    /** Serve the bundled runbooks, so a care edit's notice carries the guidance it selects. */
    guidance?: boolean;
    /** Run the app's own check watch, so the shared tick reads the pull request as the app does. */
    checkWatch?: boolean;
    /**
     * The task was filed, as a follow-up is, with a goal and no recorded
     * words of the captain's, then started (INF-4072 finding 1).
     */
    filed?: boolean;
    realRouter?: import("./crewHarness").SetupExtras["realRouter"];
    /** A stand-in router's model, and the reviewer question's chooser and models (INF-5021). */
    routedModel?: import("./crewHarness").SetupExtras["routedModel"];
    reviewerChooser?: import("./crewHarness").SetupExtras["reviewerChooser"];
    reviewerModels?: import("./crewHarness").SetupExtras["reviewerModels"];
    /**
     * Save the task's change story before its card goes up, through the
     * app's own story service: the hook seeds it and answers the revision
     * the merge card shows (INF-3623).
     */
    story?: (at: {
      tasks: import("@core/tasks/taskService").TaskService;
      taskId: string;
      branch: string;
      forge: KeptForge;
    }) => number;
  } = {},
) {
  const forge = new KeptForge(where.kind);
  if (where.referenced) forge.referencedBranch = "fm/task-earlier";
  let facts: LineageFacts = cleanFacts;
  const crewmate = fakeCrewmate();
  // The reviewer the app starts from Review carefully (INF-1875).
  const reviewer = fakeCrewmate();
  let delivery: ChangeDelivery | undefined;
  const service = () => {
    if (!delivery) throw new Error("check service not ready");
    return delivery;
  };
  const presentations = where.story
    ? (tasks: import("@core/tasks/taskService").TaskService) =>
        new ChangePresentations({
          tasks,
          mediaDir: () => scratchDir("infinitary-kept-story-"),
          head: async () => forge.headSha,
        })
    : undefined;
  const harness = setup(crewmate, {
    crewmates: [reviewer],
    ...(where.story
      ? {
          completionPresentation: (id: string, revision: number) =>
            service().publication.completionPresentation(id, revision),
        }
      : {}),
    ...(where.realRouter ? { realRouter: where.realRouter } : {}),
    ...(where.routedModel ? { routedModel: where.routedModel } : {}),
    ...(where.reviewerChooser ? { reviewerChooser: where.reviewerChooser } : {}),
    ...(where.reviewerModels ? { reviewerModels: where.reviewerModels } : {}),
    checkCi: (id) => service().checks.readForOffer(id),
    mergePullRequest: (id, guard, beforeDispatch) =>
      service().merges.merge(id, guard, beforeDispatch),
    mergeReview: (id, reviewId, guard) => service().reviews.mergeReview(id, reviewId, guard),
    reviewGate: (id, reviewId) => service().reviews.reviewGate(id, reviewId),
    readPull: (id, prNumber, mergeTask) => service().merges.pullState(id, prNumber, mergeTask),
    mergedStory: (id, pull) => service().merges.mergedStory(id, pull),
    openChange: (id, input) => service().publication.open(id, input),
    checkChange: (id, input) => service().checkTool.checkForCrew(id, input),
    ...(where.checkWatch ? { readCheckWatch: (id) => service().checks.readWatched(id) } : {}),
    ...(where.guidance ? { runbooks: bundledRunbooks() } : {}),
  });
  delivery = createChangeDelivery({
    tasks: harness.tasks,
    repos: harness.repos,
    forgeFor: (repo) => where.forgeFor?.(repo, forge) ?? forge,
    validateRange: async () => {},
    lineageFacts: async () => facts,
    ...(presentations ? { presentations: presentations(harness.tasks) } : {}),
  });
  const { dir } = gitRepo("meter");
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "add",
    "origin",
    forge.kind === "gitlab" ? "https://gitlab.com/group/sub/r.git" : "https://github.com/o/r.git",
  ]);
  const { repo } = await harness.repos.setup({ kind: "adopt", path: dir, name: "meter" });
  harness.repos.configure(repo.id, {
    delivery: "direct-pr",
    rigor: "quick",
  });
  const taskId = where.filed
    ? await startFiled(harness, repo.id)
    : (
        await harness.supervisor.intake.commission({
          title: "Ship the meter",
          intent: intentOf("Ship the meter fix"),
          repoId: repo.id,
          ...(where.internalStep ? { shape: { internal_step: true } } : {}),
        })
      ).taskId;
  await tick();
  if (where.referenced) await service().checkTool.checkForCrew(taskId, { pull: 7 });
  const review = harness.tasks.get(taskId)?.delivery?.mergeReviews?.[0];
  const presentationRevision = where.story?.({
    tasks: harness.tasks,
    taskId,
    branch: harness.tasks.get(taskId)?.branch ?? "",
    forge,
  });
  const emit = (title: string) =>
    harness.specs[0]?.onCard?.({
      ...(presentationRevision === undefined ? {} : { presentationRevision }),
      requiredActions: [],
      title,
      body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
      actions: review
        ? [
            {
              id: "merge",
              default: true,
              effect: { kind: "merge", review: review.id, after: "continue" },
            },
            { id: "not-now", label: "Not now" },
          ]
        : [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
  await emit("Ready to merge");
  crewmate.finishPrompt();
  await tick();
  const card = harness.cards().find((entry) => entry.title === "Ready to merge") as Card;
  const authorization = () => harness.tasks.get(taskId)?.delivery?.mergeAuthorization;
  const declare = (input: CheckChangeInput) => harness.specs[0]?.onCheckChange?.(input);
  return {
    ...harness,
    crewmate,
    reviewer,
    forge,
    taskId,
    card,
    emit,
    declare,
    authorization,
    checkService: service(),
    setFacts: (next: LineageFacts) => {
      facts = next;
    },
  };
}
/** That card clicked once, and the host refusing the merge for a conflict. */
export async function kept(where: Parameters<typeof approved>[0] = {}) {
  const harness = await approved(where);
  harness.forge.refuse = new ForgeError(
    "refused",
    where.kind === "gitlab"
      ? "GitLab answered 422 to PUT /projects/group%2Fsub%2Fr/merge_requests/7/merge: Branch cannot be merged"
      : conflict,
  );
  harness.supervisor.cardActions.act(harness.card.id, "merge");
  await vi.waitFor(() =>
    expect(harness.authorization()?.waiting).toMatchObject({ on: "conflict" }),
  );
  harness.forge.refuse = undefined;
  return harness;
}
/** The crewmate's repair turn: it is steered, plays its moves, and ends. */
export async function repairTurn(
  harness: Awaited<ReturnType<typeof approved>>,
  moves: () => Promise<void>,
) {
  await harness.supervisor.steer.steerCrewmate(harness.taskId, "bring it up to date");
  await moves();
  harness.crewmate.finishPrompt();
  await tick();
}
export const editPolicies = (
  h: Awaited<ReturnType<typeof approved>>,
  policies: import("@shared/taskPolicies").TaskPolicyEdits,
) => {
  h.tasks.updateFields(h.taskId, { policies }, "firstmate");
  return h.supervisor.policiesChanged(h.taskId, policies);
};
