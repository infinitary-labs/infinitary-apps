import { type MergeWays, SQUASH_ONLY_WORDS } from "@shared/batches";
import type { Card } from "@shared/cards";
import type { QueueWorkflow, RepoPolicyPatch } from "@shared/repos";
import { describe, expect, it } from "vitest";
import type { CoreDispatch } from "../dispatcher";
import { GITHUB_QUEUE_PART } from "../queue/shipped";
import { openInMemoryDatabase } from "../storage/db";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { QUEUE_SETUP_WORDS, QueueChoice, queueSetupCardId } from "./queueChoice";
import type { WakeFacts } from "./wakes";

const QUEUE_VERSION = GITHUB_QUEUE_PART.version;

/**
 * INF-2885, the captain's direction B: "Wake at the choice; switch on only
 * once the queue merges", with their words "we should show a card that tells
 * user their repo is not set up to use that option yet, and give them the
 * option to ask first mate to plan it".
 *
 * A real registry on an in-memory database holds the project; GitHub's
 * workflow read is the one stand-in, answering what a project's default
 * branch holds as `GitHubForge.queueWorkflows` reads it and writing it
 * through the registry as `ProjectQueue.readWorkflows` does.
 *
 * INF-3759 piece 1 narrows it: a project with no file of a team queue gets
 * batches of the captain's own at once, so the wait and its card are left
 * to a project whose queue files are all turned off, and "the app stops
 * offering to set the team queue up".
 */
const BATCH: QueueWorkflow = { path: ".github/workflows/batch.yml", active: true };
const TURNED_OFF: QueueWorkflow = { ...BATCH, active: false };
/** The merges a GitHub project allows by default, as its settings read answers them. */
const EVERY_WAY: MergeWays = { squash: true, rebase: true, merge: true };

function setup(
  onBranch: QueueWorkflow[] | "unreadable" = [],
  version?: number,
  ways: MergeWays = EVERY_WAY,
) {
  const db = openInMemoryDatabase();
  const repos = new RepoRegistry(db, "/fleet");
  seedProject(db, {
    id: "repo-meter",
    name: "meter",
    path: "/code/meter",
    origin: "https://github.com/o/meter.git",
    delivery: "direct-pr",
  });
  const github = { workflows: onBranch, reads: 0 };
  const allowed = { ways };
  const cards = new Map<string, Omit<Card, "author" | "priority" | "status" | "createdAt">>();
  const withdrawn: string[] = [];
  const told: Extract<WakeFacts, { kind: "queue-plan-asked" | "queue-offered" }>[] = [];
  const notes: string[] = [];
  let clock = 1_000;
  const choice = new QueueChoice({
    repos,
    queue: {
      readWorkflows: async (repoId) => {
        github.reads += 1;
        if (github.workflows === "unreadable") return repos.get(repoId);
        return repos.recordQueue(repoId, { workflows: github.workflows });
      },
    },
    raiseCard: (card) => cards.set(card.id, card),
    withdrawCard: (id) => {
      if (cards.delete(id)) withdrawn.push(id);
    },
    tell: (facts) => told.push(facts),
    note: (text) => notes.push(text),
    ways: async () => allowed.ways,
    offers: {
      offered: (repoId) => repos.queueOffered(repoId),
      record: (repoId, offered) => repos.recordQueueOffered(repoId, offered),
    },
    ...(version !== undefined ? { version } : {}),
    now: () => (clock += 1),
  });
  const configure = (changes: RepoPolicyPatch) =>
    choice.configure("repo-meter", changes, (patch) => repos.configure("repo-meter", patch));
  choice.bindDispatch((async (channel: string, args: [string, RepoPolicyPatch]) => {
    if (channel !== "inf:repos:configure") throw new Error(`No ${channel} here.`);
    return choice.configure(args[0], args[1], (patch) => repos.configure(args[0], patch));
  }) as CoreDispatch);
  return { repos, github, allowed, cards, withdrawn, told, notes, choice, configure };
}

function hostArg(card: Omit<Card, "author" | "priority" | "status" | "createdAt"> | undefined) {
  return card?.actions.map((action) => ({
    label: action.label,
    default: action.default === true,
    effect: action.effect,
  }));
}

describe("choosing batched pull requests for a project that carries no team queue file", () => {
  it("applies at once, with no wait, card or word to the first mate: the changes combine in batches of the captain's own", async () => {
    const { repos, cards, told, configure } = setup([]);
    const repo = await configure({ delivery: "queue-pr", rigor: "quick" });
    expect(repo).toMatchObject({ delivery: "queue-pr", rigor: "quick", queueWorkflows: [] });
    expect(repo.queuePendingAt).toBeUndefined();
    expect(repos.get("repo-meter")?.delivery).toBe("queue-pr");
    expect(cards.size).toBe(0);
    expect(told).toEqual([]);
  });

  it("refuses a project that allows only squash merges, with the reason Settings shows, and keeps where its changes go", async () => {
    const { repos, cards, configure } = setup([], undefined, {
      squash: true,
      rebase: false,
      merge: false,
    });
    await expect(configure({ delivery: "queue-pr" })).rejects.toThrow(SQUASH_ONLY_WORDS);
    expect(repos.get("repo-meter")).toMatchObject({ delivery: "direct-pr" });
    expect(repos.get("repo-meter")?.queuePendingAt).toBeUndefined();
    expect(cards.size).toBe(0);
  });

  it("applies by itself a choice that waited for a queue the project never got", async () => {
    const { repos, github, cards, withdrawn, notes, choice, configure } = setup([TURNED_OFF]);
    await configure({ delivery: "queue-pr" });
    expect(repos.get("repo-meter")?.queuePendingAt).toEqual(expect.any(Number));
    // The turned-off file leaves the default branch.
    github.workflows = [];
    await choice.recheck("repo-meter");
    expect(repos.get("repo-meter")).toMatchObject({ delivery: "queue-pr", queueWorkflows: [] });
    expect(repos.get("repo-meter")?.queuePendingAt).toBeUndefined();
    expect(cards.size).toBe(0);
    expect(withdrawn).toEqual([queueSetupCardId("repo-meter")]);
    expect(notes).toEqual([QUEUE_SETUP_WORDS.own("meter")]);
  });

  it("ends such a wait with the reason when the project allows only squash merges", async () => {
    const { repos, github, allowed, cards, notes, choice, configure } = setup([TURNED_OFF]);
    await configure({ delivery: "queue-pr" });
    github.workflows = [];
    allowed.ways = { squash: true, rebase: false, merge: false };
    await choice.recheck("repo-meter");
    expect(repos.get("repo-meter")).toMatchObject({ delivery: "direct-pr" });
    expect(repos.get("repo-meter")?.queuePendingAt).toBeUndefined();
    expect(cards.size).toBe(0);
    expect(notes).toEqual([QUEUE_SETUP_WORDS.squashOnly("meter")]);
  });
});

describe("choosing batched pull requests while the project's queue workflow is turned off", () => {
  it("keeps where changes go, waits, and asks on a card whether the first mate should plan the workflow", async () => {
    const { repos, cards, configure } = setup([TURNED_OFF]);
    const repo = await configure({ delivery: "queue-pr", rigor: "quick" });
    expect(repo).toMatchObject({
      delivery: "direct-pr",
      rigor: "quick",
      queueWorkflows: [TURNED_OFF],
    });
    expect(repo.queuePendingAt).toEqual(expect.any(Number));
    expect(repos.get("repo-meter")).toMatchObject({
      delivery: "direct-pr",
      queuePendingAt: repo.queuePendingAt,
    });
    const card = cards.get(queueSetupCardId("repo-meter"));
    expect(card?.title).toBe(QUEUE_SETUP_WORDS.title("meter"));
    expect(card?.body).toContain(QUEUE_SETUP_WORDS.turnedOff("meter"));
    expect(card?.body).toContain("still go as pull requests");
    expect(hostArg(card)).toEqual([
      {
        label: QUEUE_SETUP_WORDS.plan,
        default: true,
        effect: { kind: "host", op: "plan-queue", arg: "repo-meter" },
      },
      {
        label: QUEUE_SETUP_WORDS.notNow,
        default: false,
        effect: { kind: "host", op: "keep-delivery", arg: "repo-meter" },
      },
    ]);
  });

  it("applies at once when a workflow that is on mentions the status, or the read cannot say", async () => {
    for (const onBranch of [[BATCH], "unreadable"] as const) {
      const { cards, configure } = setup(onBranch === "unreadable" ? onBranch : [...onBranch]);
      const repo = await configure({ delivery: "queue-pr" });
      expect(repo.delivery).toBe("queue-pr");
      expect(repo.queuePendingAt).toBeUndefined();
      expect(cards.size).toBe(0);
    }
  });

  it("applies at once on a project whose queue answered before", async () => {
    const { repos, cards, configure } = setup([]);
    repos.recordQueue("repo-meter", { answeredAt: 500 });
    expect(await configure({ delivery: "queue-pr" })).toMatchObject({ delivery: "queue-pr" });
    expect(cards.size).toBe(0);
  });

  it("tells the first mate once per press, with what the read found, while the choice waits", async () => {
    const { told, choice, configure } = setup([TURNED_OFF]);
    choice.plan("repo-meter");
    expect(told).toEqual([]);
    await configure({ delivery: "queue-pr" });
    choice.plan("repo-meter");
    expect(told).toEqual([
      {
        kind: "queue-plan-asked",
        project: { id: "repo-meter", name: "meter" },
        delivery: "direct-pr",
        workflows: [TURNED_OFF],
      },
    ]);
  });

  it("ends the wait on Not now, or on any later choice of where changes go", async () => {
    const { repos, cards, withdrawn, choice, configure } = setup([TURNED_OFF]);
    await configure({ delivery: "queue-pr" });
    choice.keep("repo-meter");
    expect(repos.get("repo-meter")?.queuePendingAt).toBeUndefined();
    expect(repos.get("repo-meter")?.delivery).toBe("direct-pr");

    await configure({ delivery: "queue-pr" });
    expect(cards.has(queueSetupCardId("repo-meter"))).toBe(true);
    expect(await configure({ delivery: "local-only" })).toMatchObject({ delivery: "local-only" });
    expect(repos.get("repo-meter")?.queuePendingAt).toBeUndefined();
    expect(withdrawn).toEqual([queueSetupCardId("repo-meter")]);
  });

  it("switches on by itself once a merge finds a workflow that is on, and not before", async () => {
    const { repos, github, cards, notes, choice, configure } = setup([TURNED_OFF]);
    const { queuePendingAt } = await configure({ delivery: "queue-pr" });
    await choice.recheck("repo-meter");
    expect(repos.get("repo-meter")).toMatchObject({ delivery: "direct-pr", queuePendingAt });
    expect(notes).toEqual([]);

    // The workflow was turned on.
    github.workflows = [BATCH];
    await choice.recheck("repo-meter");
    const repo = repos.get("repo-meter");
    expect(repo).toMatchObject({ delivery: "queue-pr", queueWorkflows: [BATCH] });
    expect(repo?.queuePendingAt).toBeUndefined();
    expect(cards.size).toBe(0);
    expect(notes).toEqual([QUEUE_SETUP_WORDS.switched("meter")]);

    // Nothing waits now: a later merge reads nothing.
    const reads = github.reads;
    await choice.recheck("repo-meter");
    expect(github.reads).toBe(reads);
  });
});

/**
 * The shipped queue, every teammate's view (the captain's plan answers
 * shipped-queue and keep-and-offer: "make the fix forward behavior the
 * default for everyone using this mode"). The stand-in answers what
 * `GitHubForge.queueWorkflows` reads from a stamped file on the default branch.
 */
/** The seeded project as the registry holds it now. */
function project(repos: RepoRegistry) {
  const repo = repos.get("repo-meter");
  if (!repo) throw new Error("The seeded project is missing.");
  return repo;
}

describe("a project that runs Infinitary's shipped queue", () => {
  const shipped = (version: number): QueueWorkflow => ({
    path: GITHUB_QUEUE_PART.queueFile,
    active: true,
    shipped: version,
  });

  it("goes as batched pull requests for a teammate who never chose it, and refuses another way", async () => {
    const { repos, github, notes, choice, configure } = setup([]);
    github.workflows = [shipped(QUEUE_VERSION)];
    await choice.recheckAll();
    expect(repos.get("repo-meter")?.delivery).toBe("queue-pr");
    expect(notes).toEqual([QUEUE_SETUP_WORDS.adopted("meter")]);
    await expect(configure({ delivery: "direct-pr" })).rejects.toThrow(
      QUEUE_SETUP_WORDS.shippedRefusal("meter"),
    );
    expect(repos.get("repo-meter")?.delivery).toBe("queue-pr");
  });

  it("offers an older stamp's update to the first mate once, and nothing at the current stamp", async () => {
    const later = QUEUE_VERSION + 1;
    const { repos, told, choice } = setup([], later);
    repos.configure("repo-meter", { delivery: "queue-pr" });
    repos.recordQueue("repo-meter", { workflows: [shipped(later)] });
    await choice.follow(project(repos));
    expect(told).toEqual([]);
    repos.recordQueue("repo-meter", { workflows: [shipped(QUEUE_VERSION)] });
    await choice.follow(project(repos));
    await choice.follow(project(repos));
    expect(told).toEqual([
      {
        kind: "queue-offered",
        project: { id: "repo-meter", name: "meter" },
        offer: "update",
        from: QUEUE_VERSION,
        to: later,
      },
    ]);
  });

  // INF-3759 piece 1: "the app stops offering to set the team queue up".
  it("keeps a project's own answering queue and no longer offers the shipped queue in its place", async () => {
    const { repos, told, choice } = setup([]);
    repos.configure("repo-meter", { delivery: "queue-pr" });
    repos.recordQueue("repo-meter", { workflows: [BATCH], answeredAt: 500 });
    await choice.follow(project(repos));
    await choice.follow(project(repos));
    expect(repos.get("repo-meter")?.delivery).toBe("queue-pr");
    expect(told).toEqual([]);
  });
});
