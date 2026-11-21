import { describe, expect, it } from "vitest";
import {
  type AutonomyInput,
  autonomyFor,
  autonomyForRecord,
  type DeliveryInput,
  deliveryChoices,
  deliveryFor,
  deliveryForRecord,
  opensPullRequest,
  projectDeliveryChoices,
  repoConfiguredEvent,
  repoDeliverySchema,
  repoKindSchema,
  repoPolicyPatchSchema,
  runsHereOnly,
  runsOnLine,
} from "./repos";

describe("deliveryFor: a task-level ask overrides the repo, otherwise the repo stands", () => {
  const table: Array<{ why: string; input: DeliveryInput; delivery: string; reason: string }> = [
    {
      why: "no ask inherits the repository",
      input: { repo: "direct-pr" },
      delivery: "direct-pr",
      reason: "the repository ships direct-pr",
    },
    {
      why: "no repo and no ask is local-only",
      input: {},
      delivery: "local-only",
      reason: "no repository: local-only",
    },
    {
      why: "the captain's ask beats a direct-pr repo: this task stays local",
      input: { repo: "direct-pr", ask: "local-only" },
      delivery: "local-only",
      reason: "the captain asked for local-only",
    },
    {
      why: "the captain's ask beats a local-only repo: this task opens a PR",
      input: { repo: "local-only", ask: "direct-pr" },
      delivery: "direct-pr",
      reason: "the captain asked for direct-pr",
    },
    {
      why: "the same posture as the repo is still the ask, so the reason names it",
      input: { repo: "direct-pr", ask: "direct-pr" },
      delivery: "direct-pr",
      reason: "the captain asked for direct-pr",
    },
  ];

  it.each(table)("$why", ({ input, delivery, reason }) => {
    const decision = deliveryFor(input);
    expect(decision.delivery).toBe(delivery);
    expect(decision.reason).toContain(reason);
  });
});

describe("deliveryForRecord", () => {
  it("reads the task ask ahead of the repo", () => {
    expect(deliveryForRecord({ shape: { delivery_ask: "local-only" } }, "direct-pr")).toBe(
      "local-only",
    );
    expect(deliveryForRecord({ shape: { delivery_ask: "direct-pr" } }, "local-only")).toBe(
      "direct-pr",
    );
    expect(deliveryForRecord({}, "direct-pr")).toBe("direct-pr");
    expect(deliveryForRecord({})).toBe("local-only");
  });
});

// INF-2430 piece 2: a project on GitHub may merge its pull requests through its own queue,
// INF-2952 piece 2 brings the queue to GitLab and INF-5186 piece 5 to Bitbucket; the plan's not-offered answer keeps it
// from a host whose CI cannot run it.
// The order is the one Settings shows, local merge first, from the lightest choice
// to the most involved (the captain's ask to move local merge to the very left).
describe("a project's delivery choices", () => {
  it("offers the queue only to a project on a host whose CI runs it", () => {
    for (const host of [
      { kind: "github", name: "github.com" },
      { kind: "gitlab", name: "gitlab.com" },
      { kind: "gitlab", name: "gitlab.example.com" },
      { kind: "bitbucket", name: "bitbucket.org" },
    ] as const)
      expect(deliveryChoices(host, true)).toEqual(["local-only", "direct-pr", "queue-pr"]);
    expect(deliveryChoices({ kind: "git", name: "git.example.com" }, true)).toEqual([
      "local-only",
      "direct-pr",
    ]);
    expect(deliveryChoices(undefined, true)).toEqual(["local-only"]);
  });

  // The captain's ask (INF-4754): batched pull requests are a choice only once
  // their runbook is on, and a project already on them keeps them listed.
  it("offers batches only while a runbook offers them, or to a project already batching", () => {
    const github = { kind: "github", name: "github.com" } as const;
    expect(deliveryChoices(github, false)).toEqual(["local-only", "direct-pr"]);
    expect(deliveryChoices(github, false, "queue-pr")).toEqual([
      "local-only",
      "direct-pr",
      "queue-pr",
    ]);
    // An older home sends no answer, so Settings offers by host alone.
    const project = {
      origin: "git@github.com:o/r.git",
      host: github,
      delivery: "direct-pr",
    } as const;
    expect(projectDeliveryChoices(project)).toEqual(["local-only", "direct-pr", "queue-pr"]);
    expect(projectDeliveryChoices({ ...project, batchesOffered: false })).toEqual([
      "local-only",
      "direct-pr",
    ]);
  });

  it("treats the queue as a pull request everywhere a pull request is asked", () => {
    expect(opensPullRequest("queue-pr")).toBe(true);
    expect(opensPullRequest("direct-pr")).toBe(true);
    expect(opensPullRequest("local-only")).toBe(false);
    expect(deliveryForRecord({ shape: { delivery_ask: "local-only" } }, "queue-pr")).toBe(
      "local-only",
    );
    expect(deliveryForRecord({}, "queue-pr")).toBe("queue-pr");
  });
});

describe("the delivery enum says only where a change lands", () => {
  it("has no personal posture: the workspace kind carries that", () => {
    expect(repoDeliverySchema.options).toEqual(["direct-pr", "queue-pr", "local-only"]);
    expect(repoDeliverySchema.safeParse("live").success).toBe(false);
    expect(repoKindSchema.options).toEqual(["project", "personal"]);
  });

  it("refuses a policy patch that names a posture the enum no longer has", () => {
    expect(repoPolicyPatchSchema.safeParse({ delivery: "live" }).success).toBe(false);
    expect(repoPolicyPatchSchema.safeParse({ delivery: "local-only" }).success).toBe(true);
  });
});

describe("repoConfiguredEvent / repoPolicyOutcome", () => {
  const repo = {
    id: "r1",
    name: "nimbus",
    path: "/fleet/nimbus",
    setupKind: "clone" as const,
    kind: "project" as const,
    origin: null,
    host: null,
    delivery: "direct-pr" as const,
    autonomy: true,
    rigor: "standard" as const,
    runsOn: null,
  };

  it("is the one payload both writers broadcast", () => {
    expect(repoConfiguredEvent(repo)).toEqual({
      type: "repo_configured",
      repoId: "r1",
      name: "nimbus",
      delivery: "direct-pr",
      autonomy: true,
      rigor: "standard",
    });
  });
});

describe("autonomyFor: the ask, then the repository (contract v3.9)", () => {
  const table: Array<{ why: string; input: AutonomyInput; autonomy: boolean; reason: string }> = [
    {
      why: "no ask inherits an autonomous repository",
      input: { repo: true },
      autonomy: true,
      reason: "the repository merges green work itself",
    },
    {
      why: "no ask inherits an ask-first repository",
      input: { repo: false },
      autonomy: false,
      reason: "the repository asks before merging",
    },
    {
      why: "no repository is not held: there is no standing answer to enforce",
      input: {},
      autonomy: true,
      reason: "no repository: nothing to hold",
    },
    {
      why: "the captain's ask beats an ask-first repository: this task merges itself",
      input: { repo: false, ask: true },
      autonomy: true,
      reason: "the captain asked for this task to merge itself",
    },
    {
      why: "the captain's ask beats an autonomous repository: this one comes back to him",
      input: { repo: true, ask: false },
      autonomy: false,
      reason: "the captain asked to be asked before this task merges",
    },
    {
      why: "an ask with no repository stands on its own",
      input: { ask: true },
      autonomy: true,
      reason: "the captain asked for this task to merge itself",
    },
  ];

  it.each(table)("$why", ({ input, autonomy, reason }) => {
    const decision = autonomyFor(input);
    expect(decision.autonomy).toBe(autonomy);
    expect(decision.reason).toContain(reason);
  });
});

describe("autonomyForRecord", () => {
  it("reads the task ask ahead of the repo, and reads `false` as an ask", () => {
    expect(autonomyForRecord({ shape: { autonomy_ask: true } }, false)).toBe(true);
    // The trap this field exists for: `false` is the captain asking to be
    // asked, so it must not be read as "nothing was said".
    expect(autonomyForRecord({ shape: { autonomy_ask: false } }, true)).toBe(false);
    expect(autonomyForRecord({}, true)).toBe(true);
    expect(autonomyForRecord({})).toBe(true);
  });
});

describe("Runs on (docs/helper.md)", () => {
  it("keeps the personal workspace and a project with no origin on this Mac", () => {
    expect(runsHereOnly({ kind: "personal", origin: null })).toBe(
      "The personal workspace stays on this computer.",
    );
    expect(runsHereOnly({ kind: "project", origin: null })).toBe(
      "Kept on this computer only, so its tasks run there.",
    );
    expect(runsHereOnly({ kind: "project", origin: "https://github.com/o/website.git" })).toBe(
      null,
    );
  });

  it("says where the next task starts and where a running one finishes", () => {
    expect(runsOnLine("website", "on Mac mini", true)).toBe(
      "website runs on Mac mini now. Its next task starts there; the one running here finishes here.",
    );
    expect(runsOnLine("api", "as Builder", false)).toBe(
      "api runs as Builder now. Its next task starts there; one already running finishes where it started.",
    );
    expect(runsOnLine("website", null, false)).toBe(
      "website runs on this computer now. Its next task starts here.",
    );
  });
});
