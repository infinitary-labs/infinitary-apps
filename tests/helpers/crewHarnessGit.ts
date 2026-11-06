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
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  type ForgeReadiness,
} from "@core/forge";
import { type ChangeDelivery, createChangeDelivery } from "@core/orchestrator/changeDelivery";
import type { LineageFacts } from "@core/orchestrator/mergeAuthorization";
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
  sends = 0;
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
    const items = this.states.map((state) => ({ name: "linux-checks", state }));
    return { items };
  }
  async putIn(_change: ForgeChange, headSha: string) {
    this.sends += 1;
    if (this.refuse) throw this.refuse;
    this.merges.push(headSha);
    this.merged = true;
    return { sha: `squash-${headSha}` };
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
      body: "",
    };
  }
}
/**
 * A direct-pr task on a project that lives on GitHub whose crewmate put
 * its completion card up through the real checks gate and went idle:
 * the real check service, the real click, a GitHub stand-in.
 */
export async function approved(
  where: {
    kind?: "github" | "gitlab";
    referenced?: boolean;
    internalStep?: boolean;
    /** Serve the bundled runbooks, so a care edit's notice carries the guidance it selects. */
    guidance?: boolean;
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
  const harness = setup(crewmate, {
    crewmates: [reviewer],
    checkCi: (id) => service().checks.readForOffer(id),
    mergePullRequest: (id, guard, beforeDispatch) =>
      service().merges.merge(id, guard, beforeDispatch),
    mergeReview: (id, reviewId, guard) => service().reviews.mergeReview(id, reviewId, guard),
    reviewGate: (id, reviewId) => service().reviews.reviewGate(id, reviewId),
    readPull: (id, prNumber) => service().merges.pullState(id, prNumber),
    openChange: (id, input) => service().publication.open(id, input),
    checkChange: (id, input) => service().checkTool.checkForCrew(id, input),
    ...(where.guidance ? { runbooks: bundledRunbooks() } : {}),
  });
  delivery = createChangeDelivery({
    tasks: harness.tasks,
    repos: harness.repos,
    forgeFor: () => forge,
    validateRange: async () => {},
    lineageFacts: async () => facts,
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
  harness.repos.configure(repo.id, { delivery: "direct-pr", rigor: "quick" });
  const { taskId } = await harness.supervisor.intake.commission({
    title: "Ship the meter",
    intent: intentOf("Ship the meter fix"),
    repoId: repo.id,
    ...(where.internalStep ? { shape: { internal_step: true } } : {}),
  });
  await tick();
  if (where.referenced) await service().checkTool.checkForCrew(taskId, { pull: 7 });
  const review = harness.tasks.get(taskId)?.delivery?.mergeReviews?.[0];
  const emit = (title: string) =>
    harness.specs[0]?.onCard?.({
      requiredActions: [],
      title,
      body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
      actions: review
        ? [
            { id: "merge", default: true, effect: { kind: "request_merge", review: review.id } },
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
export async function kept(where: { kind?: "github" | "gitlab" } = {}) {
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
