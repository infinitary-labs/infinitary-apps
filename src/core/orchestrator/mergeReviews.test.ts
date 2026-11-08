import { fixedHoldWords } from "@shared/holds";
import type { MergeReview } from "@shared/mergeReview";
import { describe, expect, it, vi } from "vitest";
import {
  FakeForge,
  insertDirectPrTask,
  insertTask,
  setup,
} from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  ForgeBaseMoved,
  type ForgeChange,
  ForgeError,
  type ForgePull,
  type ForgeQueueStart,
  type ForgeReadiness,
  type ForgeRuleset,
  type ForgeSkipMerge,
  QUEUE_STATUS,
} from "../forge";
import type { MergeGuard } from "./changeMerge";
import type { TypedWake, WakeFacts } from "./wakes";

/** Where a failed start of the queue's next batch is told, as the app wires it. */
type QueueWakes = {
  steer?: (taskId: string, wake: TypedWake) => void;
  tell?: (facts: Extract<WakeFacts, { kind: "queue-stalled" }>) => void;
};

// Integration cohort (docs/test-cohorts.md): a real `git init` per project at
// the run's own priority, the slowest test (the refusals by number) 0.6 s at
// its fastest of five Mac runs, so five times fits vitest's 5 s default and the file sets no budget.

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Guardrails for merge reviews (INF-2625's plan, prCi's row: "Merge, refusal
 * and review paths pinned by tests"): a review of a pull request named by its
 * number, a merge past the branch rules, and the captain's click on either.
 * Each refusal is pinned word for word, since the crewmate and the first mate
 * read these words, and each send-once outcome by what it stores and sends.
 */

/** A pull request as GitHub answers it by its number, on the task's own branch in x/y. */
const HEAD = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
const MERGED = "b2e6d0c94a8f7e6d5c4b3a2918f7e6d5c4b3a201";

function openPull(overrides: Partial<ForgePull> = {}): ForgePull {
  return {
    number: 23,
    state: "open",
    merged: false,
    headSha: HEAD,
    base: "main",
    branch: "fm/task-ab12cd34",
    headRepo: "x/y",
    title: "fix(crew): keep a renewed conversation's reason across a restart",
    readiness: "clean",
    ...overrides,
  };
}

/** The rule set GitHub reads for the default branch when the sign-in may skip it. */
const SKIPPABLE: ForgeRuleset = {
  id: 7,
  name: "main checks",
  bypass: "always",
  rules: ["required_status_checks"],
};

/**
 * A task on a GitHub project x/y whose pull request #23 the host reads by its
 * number, with its branch rules and the merge past them. The test moves
 * `host` between calls. A shape puts the project's delivery ask on the task.
 */
async function onGitHub(shape?: { delivery_ask: "queue-pr" }, wakes: QueueWakes = {}) {
  const forge = new FakeForge();
  const harness = setup({ forge, ...wakes });
  await insertDirectPrTask(harness.tasks, harness.repos, {
    ...(shape ? { shape: { kind: "fix", kind_source: "none", ...shape } } : {}),
  });
  const task = harness.tasks.get("ab12cd34");
  if (!task?.repoId) throw new Error("the task has no project");
  harness.repos.configure(task.repoId, { origin: "https://github.com/x/y.git" });
  forge.change = {
    number: 23,
    url: "https://github.com/x/y/pull/23",
    branch: task.branch ?? "",
    headSha: HEAD,
    title: openPull().title,
  };
  const host: {
    pull: ForgePull;
    readFails?: Error;
    rules: ForgeRuleset[];
    send: ForgeSkipMerge | Error;
    /** What the pull request reads as once the merge past the rules was sent. */
    afterSend?: ForgePull;
    /** Whether the review read as sent when the merge went out: it is marked before the send. */
    markedAtSend?: boolean;
  } = { pull: openPull(), rules: [SKIPPABLE], send: { status: "merged" } };
  let sent = false;
  const putInSkippingRules = vi.fn(
    async (_change: ForgeChange, _headSha: string): Promise<ForgeSkipMerge> => {
      sent = true;
      host.markedAtSend = (harness.tasks.get(task.id)?.delivery?.mergeReviews ?? []).some(
        (item) => item.skips && item.sent !== undefined,
      );
      if (host.send instanceof Error) throw host.send;
      return host.send;
    },
  );
  Object.assign(forge, {
    pull: async (number: number): Promise<ForgePull> => {
      if (host.readFails) throw host.readFails;
      if (sent && host.afterSend) return { ...host.afterSend, number };
      return { ...host.pull, number };
    },
    branchRules: async () => host.rules,
    putInSkippingRules,
  });
  const reviews = () => harness.tasks.get(task.id)?.delivery?.mergeReviews ?? [];
  const skipInput = (overrides: { headSha?: string; method?: "squash" } = {}) => ({
    pull: 23,
    skipRules: { headSha: HEAD, method: "squash" as const, ...overrides },
  });
  /** Prepares the merge past the rules at HEAD and answers its stored review. */
  const prepareSkip = async (): Promise<MergeReview> => {
    const answer = await harness.service.checkTool.checkForCrew(task.id, skipInput());
    expect(answer).toContain("skipping the branch rules");
    const review = reviews().find((item) => item.skips);
    if (!review) throw new Error(`no review stored: ${answer}`);
    return review;
  };
  /** Prepares an ordinary review of #23 and answers it. */
  const prepare = async (): Promise<MergeReview> => {
    const answer = await harness.service.checkTool.checkForCrew(task.id, { pull: 23 });
    expect(answer).toContain("Merge review mr");
    const review = reviews().find((item) => !item.skips);
    if (!review) throw new Error(`no review stored: ${answer}`);
    return review;
  };
  return {
    ...harness,
    forge,
    task,
    host,
    putInSkippingRules,
    reviews,
    skipInput,
    prepareSkip,
    prepare,
  };
}

describe("preparing a review of a pull request named by its number", () => {
  it("refuses, storing nothing, a number, project, host or pull request it cannot review", async () => {
    const { service, task, host, reviews, forge } = await onGitHub();
    const ask = (pull: number) => service.checkTool.checkForCrew(task.id, { pull });
    expect(await ask(0)).toBe("Merge review refused: pull must be the pull request's number.");
    expect(await ask(2.5)).toBe("Merge review refused: pull must be the pull request's number.");
    host.readFails = new ForgeError("refused", "GitHub answered 404 to GET /repos/x/y/pulls/23");
    expect(await ask(23)).toBe(
      "Merge review refused: could not read pull request 23. GitHub answered 404 to GET /repos/x/y/pulls/23",
    );
    host.readFails = new ForgeError("sign-in", "GitHub answered 401");
    expect(await ask(23)).toBe(
      "Not signed in to GitHub (github.com). Report this as a blocker: the captain signs in to GitHub in the app's Settings. Do not sign in yourself, and do not look for another way in.",
    );
    host.readFails = undefined;
    host.pull = openPull({ state: "closed" });
    expect(await ask(23)).toBe("Merge review refused: pull request 23 is not open.");
    host.pull = openPull({ merged: true, state: "closed" });
    expect(await ask(23)).toBe("Merge review refused: pull request 23 is not open.");
    host.pull = openPull({ branch: undefined });
    expect(await ask(23)).toBe(
      "Merge review refused: pull request 23 did not name its branch, version and destination.",
    );
    host.pull = openPull({ headRepo: "someone/y" });
    expect(await ask(23)).toBe(
      "Merge review refused: pull request 23 is not a branch in x/y. Forks are out of scope.",
    );
    host.pull = openPull({ headRepo: undefined });
    expect(await ask(23)).toBe(
      "Merge review refused: pull request 23 is not a branch in x/y. Forks are out of scope.",
    );
    host.pull = openPull();
    const absent = (overrides: Partial<{ headSha: string; evidence: string; localGate: string }>) =>
      service.checkTool.checkForCrew(task.id, {
        pull: 23,
        absentChecks: {
          headSha: HEAD,
          evidence: "The project has no workflows.",
          localGate: "pnpm check passed",
          ...overrides,
        },
      });
    const absenceRefusal =
      "Merge review refused: an absence declaration must name this pull request's current version, the workflow and changed-file evidence, and the local gate run at that version.";
    expect(await absent({ headSha: MERGED })).toBe(absenceRefusal);
    expect(await absent({ evidence: "  " })).toBe(absenceRefusal);
    expect(await absent({ localGate: "" })).toBe(absenceRefusal);
    expect(reviews()).toEqual([]);
    // A host with no pull requests to read, and a project with none where it lives.
    Object.assign(forge, { pull: undefined });
    expect(await ask(23)).toBe(
      "Merge review refused: where this project lives has no pull requests to read.",
    );
    const plain = setup();
    await insertDirectPrTask(plain.tasks, plain.repos);
    expect(await plain.service.checkTool.checkForCrew("ab12cd34", { pull: 23 })).toBe(
      "Merge review refused: this project has no pull requests where it lives.",
    );
    expect(reviews()).toEqual([]);
  });

  it("refuses skipRules without a pull request number, and a change id the task does not have", async () => {
    const { service, task } = await onGitHub();
    expect(
      await service.checkTool.checkForCrew(task.id, {
        skipRules: { headSha: HEAD, method: "squash" },
      }),
    ).toBe("Merge review refused: skipRules goes with pull, the pull request's number.");
    expect(await service.checkTool.checkForCrew(task.id, { change: "ch-unknown" })).toMatch(
      /^check_change refused: "ch-unknown" is not one of this task's changes; its changes are [0-9a-f]{8}\.$/,
    );
    const fresh = setup();
    insertTask(fresh.tasks);
    expect(await fresh.service.checkTool.checkForCrew("ab12cd34", { change: "ch-unknown" })).toBe(
      "check_change refused: this task has no change record yet; leave change out.",
    );
  });

  it("stores the review, names it and selects it, granting nothing", async () => {
    const { service, task, prepare, reviews } = await onGitHub();
    const review = await prepare();
    expect(review).toMatchObject({
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 23,
      headSha: HEAD,
      base: "main",
      branch: "fm/task-ab12cd34",
      method: "squash",
      title: "fix(crew): keep a renewed conversation's reason across a restart",
    });
    expect(review.id).toMatch(/^mr[0-9a-f]{12}$/);
    expect(reviews()).toHaveLength(1);
    expect(await service.reviews.reviewGate(task.id, review.id)).toBeUndefined();
  });
});

describe("check_change's own-pull absence declaration and its declarations (INF-1955, FI3-304)", () => {
  it("refuses an own-pull absence declaration it cannot read, or on a host with no checks", async () => {
    const { service, task, forge } = await onGitHub();
    const declare = () =>
      service.checkTool.checkForCrew(task.id, {
        absentChecks: {
          headSha: HEAD,
          evidence: "The project has no workflows.",
          localGate: "pnpm check passed",
        },
      });
    forge.failChangeForTimes = 1;
    forge.fail.changeFor = new ForgeError("transient", "could not reach GitHub: socket hang up");
    expect(await declare()).toBe(
      "Absence declaration refused: could not read this task's pull request. could not reach GitHub: socket hang up",
    );
    forge.failChangeForTimes = 1;
    forge.fail.changeFor = new ForgeError("sign-in", "GitHub answered 401");
    expect(await declare()).toBe(
      "Not signed in to GitHub (github.com). Report this as a blocker: the captain signs in to GitHub in the app's Settings. Do not sign in yourself, and do not look for another way in.",
    );
    const plain = new FakeForge({ kind: "git", place: "git.example.com" });
    const harness = setup({ forge: plain });
    await insertDirectPrTask(harness.tasks, harness.repos);
    expect(
      await harness.service.checkTool.checkForCrew("ab12cd34", {
        absentChecks: { headSha: HEAD, evidence: "none", localGate: "passed" },
      }),
    ).toBe(
      "Absence declaration refused: git.example.com runs no checks, so there is nothing to declare; the reading already says so.",
    );
  });

  it("refuses a conflict repair sent beside a diagnosis, repair or rerun, recording nothing", async () => {
    const { service, task, tasks } = await onGitHub();
    const before = tasks.get(task.id)?.delivery;
    expect(
      await service.checkTool.checkForCrew(task.id, {
        conflictRepair: {
          fromHead: HEAD,
          toHead: MERGED,
          newBase: "9d3c0f1e2b4a5968778695a4b3c2d1e0f9a8b7c6",
          impact: "none",
          changedPaths: [],
          evidence: "Brought up to date; only the conflicted file changed.",
          validation: "pnpm test passed",
        },
        rerun: { headSha: HEAD, check: "critical-path", evidence: "A runner lost its connection." },
      }),
    ).toBe(
      "Check declaration refused: send a conflictRepair on its own, not beside a diagnosis, repair or rerun.",
    );
    expect(tasks.get(task.id)?.delivery).toEqual(before);
  });
});

describe("preparing a merge past the branch rules (FI3-1571 piece 2)", () => {
  it("refuses, storing nothing, what it may not skip, word for word", async () => {
    const { service, task, host, reviews, skipInput, forge } = await onGitHub();
    const ask = (input = skipInput()) => service.checkTool.checkForCrew(task.id, input);
    host.pull = openPull({ readiness: "blocked" });
    expect(
      await service.checkTool.checkForCrew(task.id, { pull: 0, skipRules: skipInput().skipRules }),
    ).toBe("Merge review refused: pull must be the pull request's number.");
    expect(
      await ask({
        pull: 23,
        skipRules: { headSha: HEAD, method: "merge" as unknown as "squash" },
      }),
    ).toBe("Merge review refused: a merge that skips the branch rules uses squash only.");
    expect(await ask(skipInput({ headSha: MERGED }))).toBe(
      `Merge review refused: pull request 23 is at ${HEAD}, not the version you named (${MERGED}). Read it again and prepare the review at the version you mean.`,
    );
    host.pull = openPull({ readiness: "blocked", headRepo: "someone/y" });
    expect(await ask()).toBe(
      "Merge review refused: pull request 23 is not a branch in x/y. Forks are out of scope.",
    );
    host.pull = openPull({ readiness: "blocked", base: "release" });
    expect(await ask()).toBe(
      "Merge review refused: pull request 23 merges into release, not this project's default branch.",
    );
    for (const [readiness, plain] of [
      ["conflict", "it conflicts with newer work in the project"],
      ["draft", "its pull request is a draft"],
      ["computing", "GitHub has not worked out whether it can merge yet"],
    ] as const) {
      host.pull = openPull({ readiness });
      expect(await ask()).toBe(
        `Merge review refused: ${plain}. Skipping rules does not change that.`,
      );
    }
    host.pull = openPull({ readiness: "blocked" });
    for (const bypass of ["never", null] as const) {
      host.rules = [SKIPPABLE, { id: 8, name: "release gate", bypass, rules: ["pull_request"] }];
      expect(await ask()).toBe(
        "Merge review refused: GitHub says your sign-in may not skip the rule set release gate.",
      );
    }
    host.rules = [{ ...SKIPPABLE, rules: ["pull_request"], mergeMethods: ["merge", "rebase"] }];
    expect(await ask()).toBe(
      "Merge review refused: the rule set main checks allows no squash merge, the one method the app sends.",
    );
    for (const readiness of ["blocked", "behind"] as const) {
      host.rules = [];
      host.pull = openPull({ readiness });
      expect(await ask()).toBe(
        "Merge review refused: GitHub holds it by a rule outside its rule sets, such as classic branch protection, which the app cannot skip.",
      );
    }
    host.rules = [SKIPPABLE];
    host.pull = openPull({ readiness: "clean" });
    expect(await ask()).toBe(
      "Merge review refused: nothing holds pull request 23: GitHub reports no rule or terminal failure to skip. Prepare an ordinary review with pull alone.",
    );
    host.pull = openPull({ readiness: "blocked" });
    forge.fail.checks = new ForgeError("transient", "could not reach GitHub: socket hang up");
    expect(await ask()).toBe(
      "Merge review refused: the checks or the branch rules could not be read. could not reach GitHub: socket hang up",
    );
    forge.fail.checks = undefined;
    const read = forge.checks.bind(forge);
    forge.checks = async (change, movedPast) => ({
      ...(await read(change, movedPast)),
      problem: "GitHub answered 403 to GET /repos/x/y/commits/checks",
    });
    expect(await ask()).toBe(
      "Merge review refused: The checks cannot be read. GitHub answered 403 to GET /repos/x/y/commits/checks",
    );
    expect(reviews().some((review) => review.skips)).toBe(false);
  });

  it("refuses, storing nothing, a pull request it cannot read or that is not open", async () => {
    const { service, task, host, reviews, skipInput } = await onGitHub();
    const ask = () => service.checkTool.checkForCrew(task.id, skipInput());
    host.readFails = new ForgeError("refused", "GitHub answered 404 to GET /repos/x/y/pulls/23");
    expect(await ask()).toBe(
      "Merge review refused: could not read pull request 23. GitHub answered 404 to GET /repos/x/y/pulls/23",
    );
    host.readFails = new ForgeError("sign-in", "GitHub answered 401");
    expect(await ask()).toBe(
      "Not signed in to GitHub (github.com). Report this as a blocker: the captain signs in to GitHub in the app's Settings. Do not sign in yourself, and do not look for another way in.",
    );
    host.readFails = undefined;
    host.pull = openPull({ readiness: "blocked", state: "closed" });
    expect(await ask()).toBe("Merge review refused: pull request 23 is not open.");
    host.pull = openPull({ readiness: "blocked", base: "" });
    expect(await ask()).toBe(
      "Merge review refused: pull request 23 did not name its branch, version and destination.",
    );
    expect(reviews()).toEqual([]);
  });

  it("refuses on a host that cannot merge past its rules", async () => {
    const gitlab = new FakeForge({ kind: "gitlab", place: "git.example.com" });
    const harness = setup({ forge: gitlab });
    await insertDirectPrTask(harness.tasks, harness.repos);
    const repoId = harness.tasks.get("ab12cd34")?.repoId ?? "";
    harness.repos.configure(repoId, { origin: "https://git.example.com/x/y.git" });
    Object.assign(gitlab, { pull: async () => openPull({ readiness: "blocked" }) });
    expect(
      await harness.service.checkTool.checkForCrew("ab12cd34", {
        pull: 23,
        skipRules: { headSha: HEAD, method: "squash" },
      }),
    ).toBe(
      "Merge review refused: a merge that skips the branch rules is available on GitHub, including GitHub Enterprise, only.",
    );
  });

  it("names each rule it skips and each failed check, granting nothing", async () => {
    const { service, task, host, forge, skipInput } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    host.rules = [
      SKIPPABLE,
      { id: 9, name: "reviews", bypass: "pull_requests_only", rules: ["pull_request"] },
    ];
    forge.names = ["typecheck-lint-build", "critical-path"];
    forge.states = ["success", "failure"];
    const answer = await service.checkTool.checkForCrew(task.id, skipInput());
    const lines = answer.split("\n");
    expect(lines.find((line) => line.startsWith("Merge review mr"))).toMatch(
      new RegExp(
        `^Merge review mr[0-9a-f]{12} for #23 at ${HEAD} into main on GitHub, skipping the branch rules\\.$`,
      ),
    );
    expect(lines).toContain("Your merge card merges it, its review naming this review.");
    expect(lines).toContain(
      "It may skip these rules, each of which GitHub says your sign-in may skip: required checks (main checks); a review before merging (reviews).",
    );
    expect(lines).toContain("It merges with these checks failed: critical-path.");
  });
});

describe("the captain's click on a merge past the rules: sent once, never again", () => {
  it("merges once and keeps its receipt; a second click sends nothing", async () => {
    const { service, task, host, prepareSkip, putInSkippingRules, reviews } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    const review = await prepareSkip();
    host.send = { status: "merged", sha: MERGED };
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: true,
      text: "Merged #23 on GitHub, skipping the branch rules.",
      receipt: { head: HEAD, sha: MERGED },
    });
    expect(putInSkippingRules).toHaveBeenCalledTimes(1);
    expect(putInSkippingRules.mock.calls[0]?.[1]).toBe(HEAD);
    expect(host.markedAtSend).toBe(true);
    const stored = reviews().find((item) => item.id === review.id);
    expect(stored?.sent?.outcome).toBeUndefined();
    expect(stored?.receipt).toMatchObject({ head: HEAD, sha: MERGED });
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: true,
      text: `Pull request #23 was already merged at ${HEAD}.`,
      receipt: { head: HEAD, sha: MERGED, already: true },
    });
    expect(await service.reviews.reviewGate(task.id, review.id)).toBe(
      `Card refused: that merge was already sent once and is never sent again. Prepare a new review to ask again. ${fixedHoldWords("sent-once")}`,
    );
    expect(putInSkippingRules).toHaveBeenCalledTimes(1);
  });

  it("keeps a refusal GitHub gave as failed, and never sends it again", async () => {
    const { service, task, host, prepareSkip, putInSkippingRules, reviews } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    const review = await prepareSkip();
    host.send = { status: "failed", message: 'Required status check "critical-path" is failing' };
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: false,
      text: 'Cannot merge: GitHub did not merge #23: Required status check "critical-path" is failing. Nothing merged, and it is not sent again.',
      problem: 'Required status check "critical-path" is failing',
    });
    expect(reviews().find((item) => item.id === review.id)?.sent).toMatchObject({
      outcome: "failed",
      text: 'Required status check "critical-path" is failing',
    });
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: false,
      text: `Cannot merge: that merge was sent once and GitHub did not merge it (Required status check "critical-path" is failing). Nothing was sent again; prepare a new review to ask again. ${fixedHoldWords("sent-once")}`,
      stop: "outcome",
    });
    expect(putInSkippingRules).toHaveBeenCalledTimes(1);
  });

  it("keeps an answer it cannot read as unknown, read back first, and never sends it again", async () => {
    const { service, task, host, prepareSkip, putInSkippingRules, reviews } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    const review = await prepareSkip();
    host.send = { status: "unknown", message: "GitHub answered 502" };
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: false,
      text: "The merge of #23 was sent once, and its outcome is unknown: GitHub answered 502. It is not sent again; read pull request #23 to see whether it merged.",
      problem: "GitHub answered 502",
      stop: "outcome",
    });
    expect(reviews().find((item) => item.id === review.id)?.sent).toMatchObject({
      outcome: "unknown",
      text: "GitHub answered 502",
    });
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: false,
      text: `Cannot merge: that merge was already sent once and its outcome is unknown (GitHub answered 502). Nothing was sent again; read pull request #23 to see whether it merged. ${fixedHoldWords("sent-once")}`,
      stop: "outcome",
    });
    expect(putInSkippingRules).toHaveBeenCalledTimes(1);
  });

  it("reads a lost answer back: merged at the reviewed version is the merge", async () => {
    const { service, task, host, prepareSkip, putInSkippingRules, reviews } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    const review = await prepareSkip();
    host.send = new ForgeError("transient", "could not reach GitHub: socket hang up");
    host.afterSend = openPull({ state: "closed", merged: true, mergedSha: MERGED });
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: true,
      text: "Merged #23 on GitHub, skipping the branch rules.",
      receipt: { head: HEAD, sha: MERGED },
    });
    expect(reviews().find((item) => item.id === review.id)?.receipt?.head).toBe(HEAD);
    expect(putInSkippingRules).toHaveBeenCalledTimes(1);
  });

  it("keeps a transport failure unknown and a sign-in refusal failed, each sent once", async () => {
    const unknown = await onGitHub();
    unknown.host.pull = openPull({ readiness: "blocked" });
    const first = await unknown.prepareSkip();
    unknown.host.send = new ForgeError("transient", "could not reach GitHub: socket hang up");
    expect(await unknown.service.reviews.mergeReview(unknown.task.id, first.id)).toMatchObject({
      ok: false,
      stop: "outcome",
      problem: "could not reach GitHub: socket hang up",
    });
    expect(unknown.reviews()[0]?.sent?.outcome).toBe("unknown");

    const signIn = await onGitHub();
    signIn.host.pull = openPull({ readiness: "blocked" });
    const second = await signIn.prepareSkip();
    signIn.host.send = new ForgeError("sign-in", "GitHub answered 401");
    expect(await signIn.service.reviews.mergeReview(signIn.task.id, second.id)).toEqual({
      ok: false,
      text: "Cannot merge: GitHub answered 401. Nothing merged, and it is not sent again.",
      problem: "GitHub answered 401",
      stop: "sign-in",
    });
    expect(signIn.reviews()[0]?.sent?.outcome).toBe("failed");
    expect(signIn.putInSkippingRules).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the pull request changed after the review, and stores the merge made outside it", async () => {
    const { service, task, host, prepareSkip, putInSkippingRules, forge } = await onGitHub();
    host.pull = openPull({ readiness: "blocked" });
    const review = await prepareSkip();
    const click = () => service.reviews.mergeReview(task.id, review.id);
    host.pull = openPull({ readiness: "blocked", base: "release" });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the pull request is not the one that was reviewed.",
      stop: "identity",
    });
    host.pull = openPull({ readiness: "blocked", state: "closed" });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the pull request was closed without merging.",
      stop: "closed",
    });
    host.pull = openPull({ readiness: "blocked", headSha: MERGED });
    expect(await click()).toEqual({
      ok: false,
      text: `Cannot merge: the pull request is at ${MERGED}, and the review covers ${HEAD}. Nothing merged. A new version needs a new review and a new click.`,
      stop: "moved",
    });
    host.pull = openPull({ readiness: "blocked" });
    host.rules = [SKIPPABLE, { id: 9, name: "reviews", bypass: "always", rules: ["pull_request"] }];
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: it would now also skip a review before merging (reviews), which the review did not name. Nothing merged. Prepare a new review.",
      stop: "protected",
    });
    host.rules = [SKIPPABLE];
    forge.names = ["typecheck-lint-build"];
    forge.states = ["failure"];
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the check typecheck-lint-build failed after the review, which did not name it. Nothing merged. Prepare a new review.",
      stop: "checks",
    });
    expect(await service.reviews.reviewGate(task.id, review.id)).toBe(
      "Card refused: the check typecheck-lint-build failed after the review, which did not name it. Nothing merged. Prepare a new review.",
    );
    forge.states = ["success"];
    host.readFails = new ForgeError("transient", "could not reach GitHub: socket hang up");
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the pull request could not be read. could not reach GitHub: socket hang up",
      stop: "transient",
    });
    host.readFails = undefined;
    Object.assign(forge, { putInSkippingRules: undefined });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: this host cannot merge past its branch rules.",
    });
    Object.assign(forge, { putInSkippingRules });
    host.pull = openPull({ state: "closed", merged: true, mergedSha: MERGED });
    expect(await click()).toEqual({
      ok: true,
      text: "#23 is already merged on GitHub.",
      receipt: { head: HEAD, sha: MERGED, already: true },
    });
    expect(putInSkippingRules).not.toHaveBeenCalled();
  });
});

describe("the captain's click on an ordinary review", () => {
  it("refuses a review, or a merge, that is not on the task", async () => {
    const { service, task } = await onGitHub();
    expect(await service.reviews.reviewGate(task.id, "mrmissing0000")).toBe(
      "Card refused: merge review mrmissing0000 is not on this task.",
    );
    expect(await service.reviews.mergeReview(task.id, "mrmissing0000")).toEqual({
      ok: false,
      text: "Cannot merge: merge review mrmissing0000 is not on this task.",
    });
  });

  it("refuses at the gate and at the click what changed since the review, sending nothing", async () => {
    const { service, task, host, prepare, forge, repos } = await onGitHub();
    const review = await prepare();
    const click = () => service.reviews.mergeReview(task.id, review.id);
    host.pull = openPull({ state: "closed", merged: true, mergedSha: MERGED });
    expect(await service.reviews.reviewGate(task.id, review.id)).toBe(
      "Card refused: that pull request is already merged.",
    );
    host.pull = openPull({ branch: "fm/task-other" });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the pull request is not the one that was reviewed.",
      stop: "identity",
    });
    host.pull = openPull({ state: "closed" });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the pull request was closed without merging.",
      stop: "closed",
    });
    host.pull = openPull();
    forge.fail.checks = new ForgeError("refused", "GitHub answered 404 to GET checks");
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the checks could not be read. GitHub answered 404 to GET checks",
      stop: "checks",
      notGreen: true,
    });
    forge.fail.checks = undefined;
    forge.states = ["failure"];
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: the checks failed",
      stop: "checks",
      notGreen: true,
    });
    forge.states = [];
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: No checks have registered and no positive absence declaration covers this version.",
      stop: "checks",
      notGreen: true,
    });
    forge.states = ["success"];
    repos.configure(task.repoId ?? "", { origin: "https://github.com/x/moved.git" });
    expect(await click()).toEqual({
      ok: false,
      text: "Cannot merge: where the reviewed pull request lives changed.",
      stop: "identity",
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("stores the merge made outside it at the reviewed version, and refuses a host it cannot read", async () => {
    const { service, task, host, prepare, forge, reviews } = await onGitHub();
    const review = await prepare();
    host.readFails = new ForgeError("sign-in", "GitHub answered 401");
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: false,
      text: "Cannot merge: the pull request could not be read. GitHub answered 401",
      stop: "sign-in",
    });
    host.readFails = undefined;
    host.pull = openPull({ state: "closed", merged: true, mergedSha: MERGED });
    expect(await service.reviews.mergeReview(task.id, review.id)).toEqual({
      ok: true,
      text: "#23 is already merged on GitHub.",
      receipt: { head: HEAD, sha: MERGED, already: true },
    });
    expect(reviews()[0]?.receipt).toMatchObject({ head: HEAD, sha: MERGED });
    const second = await onGitHub();
    const other = await second.prepare();
    Object.assign(second.forge, { pull: undefined });
    expect(await second.service.reviews.mergeReview(second.task.id, other.id)).toEqual({
      ok: false,
      text: "Cannot merge: this host cannot read a pull request by its number.",
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    expect(second.forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("keeps a merge GitHub made though its answer was lost, and reads a 409 as moved", async () => {
    const lost = await onGitHub();
    const review = await lost.prepare();
    lost.forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    // GitHub merged it; only its answer was lost on the way back.
    const putIn = lost.forge.putIn.bind(lost.forge);
    lost.forge.putIn = async (change, head) => {
      try {
        return await putIn(change, head);
      } finally {
        lost.host.pull = openPull({ state: "closed", merged: true, mergedSha: MERGED });
      }
    };
    expect(await lost.service.reviews.mergeReview(lost.task.id, review.id)).toEqual({
      ok: true,
      text: "Merged #23 on GitHub.",
      receipt: { head: HEAD, sha: MERGED },
    });
    expect(lost.reviews()[0]?.receipt).toMatchObject({ head: HEAD, sha: MERGED });
    expect(lost.forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);

    const moved = await onGitHub();
    const second = await moved.prepare();
    moved.forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 409 to PUT /repos/x/y/pulls/23/merge: Head branch was modified. Review and try the merge again.",
    );
    expect(await moved.service.reviews.mergeReview(moved.task.id, second.id)).toEqual({
      ok: false,
      text: "Cannot merge: GitHub answered 409 to PUT /repos/x/y/pulls/23/merge: Head branch was modified. Review and try the merge again.",
      problem:
        "GitHub answered 409 to PUT /repos/x/y/pulls/23/merge: Head branch was modified. Review and try the merge again.",
      stop: "moved",
    });
  });

  it("holds a kept approval's click on the captain's newer words and on an approval that ended", async () => {
    const { service, task, prepare, forge } = await onGitHub();
    const review = await prepare();
    const guard = (overrides: Partial<MergeGuard> = {}): MergeGuard => ({
      head: HEAD,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
      ...overrides,
    });
    expect(
      await service.reviews.mergeReview(
        task.id,
        review.id,
        guard({ held: () => "the captain's newer words wait for the crewmate's declaration" }),
      ),
    ).toEqual({
      ok: false,
      stop: "guidance",
      text: "the captain's newer words wait for the crewmate's declaration",
    });
    expect(
      await service.reviews.mergeReview(
        task.id,
        review.id,
        guard({ beforeDispatch: () => "the captain's merge approval ended" }),
      ),
    ).toEqual({ ok: false, stop: "withdrawn", text: "the captain's merge approval ended" });
    expect(await service.reviews.mergeReview(task.id, review.id, guard({ head: MERGED }))).toEqual({
      ok: false,
      text: "Cannot merge: the pull request moved past the approved version. Declare its repair with check_change conflictRepair; the captain's approval is kept.",
      stop: "moved",
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("answers a review already merged from its receipt, asking the host nothing", async () => {
    const harness = setup();
    insertTask(harness.tasks);
    const review: MergeReview = {
      id: "mrreceipt0001",
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 23,
      headSha: HEAD,
      base: "main",
      branch: "fm/task-ab12cd34",
      method: "squash",
      title: openPull().title ?? "",
      at: 1,
      receipt: { head: HEAD, sha: MERGED, at: 2 },
    };
    seedDelivery(harness.tasks, "ab12cd34", { mergeReviews: [review] });
    expect(await harness.service.reviews.mergeReview("ab12cd34", review.id)).toEqual({
      ok: true,
      text: `Pull request #23 was already merged at ${HEAD}.`,
      receipt: { head: HEAD, sha: MERGED, already: true },
    });
    expect(harness.forge.calls).toEqual([]);
  });
});

describe("the captain's click on a pull request the task did not open, while GitHub works it out (INF-457)", () => {
  // PR #94 as GitHub served it on 2026-10-18 (INF-456): it answered
  // mergeable null, which reads computing, to both of the captain's clicks
  // just after main moved, and clean to reads seconds later.
  const PR94 = {
    number: 94,
    headSha: "44b8b3aaf25091de13081dc62eae268df3d9a148",
    branch: "fm/task-3a9271dd",
    title: "fix(crew): keep a renewed conversation's reason across a restart",
  };

  /** The fake forge answering each read of PR #94 by its number in turn; the last answer repeats. */
  class UndecidedForge extends FakeForge {
    answers: { readiness: ForgeReadiness; headSha?: string }[] = [{ readiness: "computing" }];
    reads = 0;
    async pull(number: number): Promise<ForgePull> {
      const answer = this.answers[Math.min(this.reads, this.answers.length - 1)];
      this.reads += 1;
      return {
        number,
        state: "open",
        merged: false,
        headSha: answer?.headSha ?? PR94.headSha,
        base: "main",
        branch: PR94.branch,
        title: PR94.title,
        headRepo: "infinitary-labs/infinitary",
        readiness: answer?.readiness ?? "computing",
      };
    }
  }

  async function adopted(answers: UndecidedForge["answers"]) {
    const forge = new UndecidedForge();
    forge.answers = answers;
    const harness = setup({ forge });
    await insertDirectPrTask(harness.tasks, harness.repos);
    harness.repos.configure(harness.tasks.get("ab12cd34")!.repoId!, {
      origin: "https://github.com/infinitary-labs/infinitary.git",
    });
    const review: MergeReview = {
      id: "mrpr94clicked",
      kind: "github",
      host: "github.com",
      owner: "infinitary-labs",
      name: "infinitary",
      number: PR94.number,
      headSha: PR94.headSha,
      base: "main",
      branch: PR94.branch,
      method: "squash",
      title: PR94.title,
      at: Date.now(),
    };
    seedDelivery(harness.tasks, "ab12cd34", { mergeReviews: [review] });
    // The click, or the host's merge under a kept approval (`guard`), with
    // the gaps between GitHub's reads on a fake clock: it settles only if the
    // wait ends.
    const click = async (guard?: MergeGuard) => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const outcome = harness.service.reviews.mergeReview("ab12cd34", review.id, guard);
        await vi.runAllTimersAsync();
        return await outcome;
      } finally {
        vi.useRealTimers();
      }
    };
    return { ...harness, forge, click };
  }

  it("refuses, sending nothing, when GitHub is still undecided after the wait", async () => {
    const { forge, click } = await adopted([{ readiness: "computing" }]);
    const outcome = await click();
    expect(outcome).toMatchObject({ ok: false, stop: "computing" });
    expect(outcome.text).toContain("Nothing merged");
    expect(forge.reads).toBeGreaterThan(1);
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("sends nothing when the pull request moves to a new version while GitHub works it out", async () => {
    const { forge, click } = await adopted([
      { readiness: "computing" },
      { readiness: "clean", headSha: "9d3c0f1e2b4a5968778695a4b3c2d1e0f9a8b7c6" },
    ]);
    const outcome = await click();
    expect(outcome).toMatchObject({ ok: false, stop: "moved" });
    expect(forge.reads).toBe(2);
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  // The captain's ask: retry on its own right away when GitHub says main
  // moved, with no crewmate step. GitHub's refusal as it gave it to a batch's
  // merges, then the pull request read as computing until GitHub decides.
  it("sends the host's merge GitHub refused because main moved again, once GitHub reads it clean", async () => {
    const { forge, click } = await adopted([
      { readiness: "clean" }, // the read before the request
      { readiness: "computing" }, // read back after the refusal
      { readiness: "computing" }, // the refusal's cause
      { readiness: "computing" }, // the next try's first read
      { readiness: "clean" },
    ]);
    const putIn = forge.putIn.bind(forge);
    let refused = false;
    forge.putIn = async (change, head) => {
      if (refused) return putIn(change, head);
      refused = true;
      forge.calls.push(`putIn ${change.branch} ${head}`);
      throw new ForgeBaseMoved(
        "GitHub answered 405 to PUT /repos/infinitary-labs/infinitary/pulls/94/merge: Base branch was modified. Review and try the merge again.",
      );
    };
    const outcome = await click({
      head: PR94.headSha,
      prNumber: PR94.number,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(outcome).toMatchObject({ ok: true, receipt: { head: PR94.headSha } });
    expect(outcome).not.toHaveProperty("baseMoved");
    expect(forge.reads).toBe(5);
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toEqual([
      `putIn ${PR94.branch} ${PR94.headSha}`,
      `putIn ${PR94.branch} ${PR94.headSha}`,
    ]);
  });
});

describe("a review's click on a queue-pr project (docs/forge.md, \"A project's queue\")", () => {
  async function queuedReview(wakes: QueueWakes = {}) {
    const harness = await onGitHub({ delivery_ask: "queue-pr" }, wakes);
    const review: MergeReview = {
      id: "mrqueued00001",
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 23,
      headSha: HEAD,
      base: "main",
      branch: "fm/task-ab12cd34",
      method: "squash",
      title: openPull().title ?? "",
      at: 1,
    };
    seedDelivery(harness.tasks, "ab12cd34", { mergeReviews: [review] });
    const putIns = () => harness.forge.calls.filter((call) => call.startsWith("putIn"));
    return { ...harness, review, putIns };
  }

  it("stops on the checks when the queue's batch failed at the version, marking nothing", async () => {
    const { service, forge, review, putIns } = await queuedReview();
    const marked: string[] = [];
    forge.markQueued = async (sha) => {
      marked.push(sha);
      return {};
    };
    forge.atHead[HEAD] = [
      { name: "linux-checks", state: "success" },
      { name: QUEUE_STATUS, state: "failure" },
    ];
    expect(await service.reviews.mergeReview("ab12cd34", review.id)).toEqual({
      ok: false,
      text: `Cannot merge yet - the project's queue did not pass ${HEAD} (${QUEUE_STATUS} is failure).`,
      plain: "the batch check failed",
      notGreen: true,
      stop: "checks",
    });
    expect(marked).toEqual([]);
    expect(putIns()).toEqual([]);
  });

  // The re-review's finding (next-batch-rarer-merge-routes): every route a
  // review merges by starts the next batch, since a merge's own push starts
  // no workflow on GitHub (docs/forge.md, "The shipped queue").
  it("starts the shipped queue's next batch after the merge, and after a merge GitHub made though its answer was lost", async () => {
    const { service, forge, repos, tasks, host, task, review } = await queuedReview();
    if (!task.repoId) throw new Error("the task has no project");
    repos.recordQueue(task.repoId, {
      workflows: [{ path: ".github/workflows/infinitary-queue.yml", active: true, shipped: 1 }],
    });
    const starts: string[] = [];
    Object.assign(forge, {
      startQueue: async (start: ForgeQueueStart) => {
        starts.push(start.action);
      },
    });
    forge.markQueued = async () => ({});
    forge.atHead[HEAD] = [
      { name: "linux-checks", state: "success" },
      { name: QUEUE_STATUS, state: "success" },
    ];
    expect(await service.reviews.mergeReview("ab12cd34", review.id)).toMatchObject({ ok: true });
    expect(starts).toEqual(["form"]);

    // A second batched review whose merge GitHub made though its answer was lost.
    const lost = { ...review, id: "mrqueued00002" };
    seedDelivery(tasks, "ab12cd34", { mergeReviews: [lost] });
    forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    host.pull = openPull();
    const putIn = forge.putIn.bind(forge);
    forge.putIn = async (change, head) => {
      try {
        return await putIn(change, head);
      } finally {
        host.pull = openPull({ state: "closed", merged: true, mergedSha: MERGED });
      }
    };
    expect(await service.reviews.mergeReview("ab12cd34", lost.id)).toMatchObject({
      ok: true,
      receipt: { head: HEAD, sha: MERGED },
    });
    expect(starts).toEqual(["form", "form"]);
  });

  // The review's finding (lost-start-stalls) and the captain's choice on it:
  // "retry the start after a mark, and wake the task's crewmate if it still
  // fails. Never swallow the failure."
  it("starts the next batch once more when a start fails, and when that fails too notes it and wakes a crewmate waiting in the queue, or the first mate", async () => {
    const steers: { taskId: string; wake: TypedWake }[] = [];
    const told: Extract<WakeFacts, { kind: "queue-stalled" }>[] = [];
    const { service, forge, repos, tasks, task, review } = await queuedReview({
      steer: (taskId, wake) => steers.push({ taskId, wake }),
      tell: (facts) => told.push(facts),
    });
    if (!task.repoId) throw new Error("the task has no project");
    const repo = repos.recordQueue(task.repoId, {
      workflows: [{ path: ".github/workflows/infinitary-queue.yml", active: true, shipped: 1 }],
    });
    const answers: (Error | undefined)[] = [
      new ForgeError("transient", "could not reach GitHub: socket hang up"),
      undefined,
    ];
    const starts: string[] = [];
    Object.assign(forge, {
      startQueue: async (start: ForgeQueueStart) => {
        starts.push(start.action);
        const answer = answers.shift();
        if (answer) throw answer;
      },
    });
    forge.markQueued = async () => ({});
    forge.atHead[HEAD] = [
      { name: "linux-checks", state: "success" },
      { name: QUEUE_STATUS, state: "success" },
    ];
    expect(await service.reviews.mergeReview("ab12cd34", review.id)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(starts).toEqual(["form", "form"]));
    expect(steers).toEqual([]);
    expect(told).toEqual([]);

    // After a mark, both starts fail: this task's crewmate hears it.
    const refused = "GitHub answered 403: Resource not accessible by integration";
    const fail = () =>
      answers.push(new ForgeError("permission", refused), new ForgeError("permission", refused));
    seedDelivery(tasks, "ab12cd34", { queueMark: { head: HEAD, at: 1 } });
    fail();
    service.merges.startNextBatch("ab12cd34", "mark");
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    expect(starts).toEqual(["form", "form", "form", "form"]);
    expect(steers[0]).toEqual({
      taskId: "ab12cd34",
      wake: { facts: { kind: "queue-start-failed", why: refused } },
    });
    expect(
      tasks
        .timeline("ab12cd34")
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain(`The project's queue did not start: ${refused}`);

    // After a merge the merged task closes with its wakes (the re-review's
    // after-merge-wake-lost): with no other task waiting in the queue, the
    // first mate hears it.
    fail();
    service.merges.startNextBatch("ab12cd34", "merge");
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toEqual({
      kind: "queue-stalled",
      project: { id: task.repoId, name: repo?.name },
      why: refused,
    });
    expect(steers).toHaveLength(1);

    // A task still waiting in that queue hears it instead.
    insertTask(tasks, { id: "cd56ef78", repoId: task.repoId, branch: "fm/task-cd56ef78" });
    seedDelivery(tasks, "cd56ef78", { queueMark: { head: "9".repeat(40), at: 2 } });
    fail();
    service.merges.startNextBatch("ab12cd34", "merge");
    await vi.waitFor(() => expect(steers).toHaveLength(2));
    expect(steers[1]).toEqual({
      taskId: "cd56ef78",
      wake: { facts: { kind: "queue-start-failed", why: refused } },
    });
    expect(told).toHaveLength(1);
  });

  // The re-review's finding (approval-never-restarts): a change the queue
  // held, such as one waiting for a Maintainer's approval on GitLab, joins
  // only when a start reads it again, so a click on a waiting version starts
  // the queue on a host whose mark starts nothing, and marks nothing twice.
  it("starts the queue again on a click on a waiting version where a mark starts nothing", async () => {
    const { service, forge, repos, task, review } = await queuedReview();
    if (!task.repoId) throw new Error("the task has no project");
    repos.recordQueue(task.repoId, {
      workflows: [{ path: ".gitlab/infinitary-queue.yml", active: true, shipped: 1 }],
    });
    const starts: string[] = [];
    const marked: string[] = [];
    Object.assign(forge, {
      markStartsQueue: false,
      startQueue: async (start: ForgeQueueStart) => {
        starts.push(start.action);
      },
    });
    forge.markQueued = async (sha) => {
      marked.push(sha);
      return {};
    };
    forge.atHead[HEAD] = [
      { name: "linux-checks", state: "success" },
      { name: QUEUE_STATUS, state: "pending" },
    ];
    expect(await service.reviews.mergeReview("ab12cd34", review.id)).toMatchObject({
      ok: false,
      stop: "queue",
    });
    expect(starts).toEqual(["form"]);
    expect(marked).toEqual([]);
    // A kept approval's unattended retry of the same review starts nothing
    // (the review's restart-on-unattended-reruns).
    const kept: MergeGuard = {
      head: HEAD,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    };
    expect(await service.reviews.mergeReview("ab12cd34", review.id, kept)).toMatchObject({
      ok: false,
      stop: "queue",
    });
    expect(starts).toEqual(["form"]);
  });

  it("refuses in words when the host cannot mark a version for the queue", async () => {
    const { service, review, putIns } = await queuedReview();
    expect(await service.reviews.mergeReview("ab12cd34", review.id)).toEqual({
      ok: false,
      text: "Cannot merge: This project's host cannot mark a version for its queue.",
      problem: "This project's host cannot mark a version for its queue.",
    });
    expect(putIns()).toEqual([]);
  });
});
