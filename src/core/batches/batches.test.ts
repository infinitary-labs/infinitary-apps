import { createHash } from "node:crypto";
import {
  type BatchChange,
  type BatchMember,
  type MergeWay,
  type MergeWays,
  SQUASH_ONLY_WORDS,
} from "@shared/batches";
import type { NamingRule } from "@shared/runbooks";
import { describe, expect, it } from "vitest";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import type { Forge, ForgeChange, ForgeCheck, ForgePull, ForgeReadiness } from "../forge";
import { ForgeError, ForgeWriteError } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { BATCH_WORDS, Batches, type BatchHeld } from "./batches";
import { type Combined, type CombineInput, LEFT_OUT_WORDS } from "./combine";

// Intent: the captain's approved plan for batches of their own, piece 1. Its done-when list
// asks for the formation rule, a change left out, the merge-way choice from host facts,
// two changes sent back, a fix ending a hold, an approval withdrawn, restart reconcile and
// receipts; its rules say a batch of one reads and merges as that change's pull request
// does, a failed batch holds while later approvals wait, and the host's own reading
// decides what happens next.
//
// A real project registry on an in-memory database keeps the record, so every step goes
// through its one writer and its saved form. The stand-in is the host: a project whose
// pull requests, branches, checks and allowed merges answer as GitHub's do, with the
// combine and the push writing to it in place of git (`combine.test.ts` owns git).

const REPO = "repo-meter";
const MAIN_AT_START = "9d1c7e2a4b6f8091a3c5e7d9f1b3a5c7e9d1f3b5";
/** The merges a GitHub project allows by default, as its settings read answers them. */
const EVERY_WAY: MergeWays = { squash: true, rebase: true, merge: true };

const PARSER: BatchChange = {
  taskId: "t-parser",
  branch: "fm/task-parser",
  head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.",
  at: 1_000,
};
const EXPORT: BatchChange = {
  taskId: "t-export",
  branch: "fm/task-export",
  head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  title: "feat(export): add a CSV export",
  body: "- A report exports as CSV.",
  at: 2_000,
};
const LEGEND: BatchChange = {
  taskId: "t-legend",
  branch: "fm/task-legend",
  head: "0f9e8d7c6b5a49382716f5e4d3c2b1a009182736",
  title: "fix(chart): keep the legend inside the chart",
  body: "- The legend no longer overlaps the bars.",
  at: 3_000,
};
const AXIS: BatchChange = {
  taskId: "t-axis",
  branch: "fm/task-axis",
  head: "7e6d5c4b3a2918070f6e5d4c3b2a190817263544",
  title: "fix(chart): label the time axis in local time",
  body: "- The time axis reads in the viewer's own time.",
  at: 4_000,
};

const id = (words: string) => createHash("sha1").update(words).digest("hex");
const passed = (name: string): ForgeCheck => ({ name, state: "success" });
const failed = (name: string): ForgeCheck => ({ name, state: "failure" });
const running = (name: string): ForgeCheck => ({ name, state: "pending" });

type StandInPull = {
  number: number;
  branch: string;
  head: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedSha?: string;
  readiness: ForgeReadiness;
};
type Commit = { sha: string; title: string };

/** A project where it lives: what GitHub holds and answers for one repository. */
function standInHost(ways: MergeWays) {
  const host = {
    ways,
    branches: new Map<string, string>([["main", MAIN_AT_START]]),
    /** What each pushed version carries above the default branch: its commits, in order. */
    carried: new Map<string, Commit[]>(),
    /** The default branch's commits as merges wrote or kept them. */
    main: [] as Commit[],
    pulls: new Map<number, StandInPull>(),
    checks: new Map<string, ForgeCheck[]>(),
    merges: [] as { number: number; head: string; way?: MergeWay; title?: string; body?: string }[],
    notes: [] as { number: number; note: string }[],
    /** The host's own words for refusing the next merges. */
    refusal: undefined as string | undefined,
    /** The default branch has GitHub's merge queue: a merge request is taken into it, never merged at once. */
    mergeQueue: false,
    /** The pull requests that queue holds now. */
    queued: new Set<number>(),
    /** How many times that queue was read. */
    queueReads: 0,
    /** The connection drops as the next pull request opens: its answer is lost, and so is every read after. */
    loseNextOpen: false,
    offline: false,
    /** The host does not answer for the merges the project allows. */
    waysUnreadable: false,
    /** Something that happens between a pass's first look and its merge. */
    beforeChecks: undefined as (() => void) | undefined,
    /** The pull request has yet to follow its pushed branch, as a host's can for a moment. */
    trails: false,
    /** Every rewrite of a pull request's title and description the host took. */
    rewrites: [] as { number: number; title?: string }[],
    /** Someone edits the pull request between the app's read and its next rewrite. */
    editBeforeRewrite: undefined as string | undefined,
    /** Merge a pull request as the host does it: by the app's request or by hand on its page. */
    land(number: number, way: MergeWay, words?: { title?: string }): string {
      const pull = host.pulls.get(number) as StandInPull;
      const commits = host.carried.get(pull.head) ?? [];
      let mergedSha: string;
      if (way === "squash") {
        mergedSha = id(`squash of #${number}`);
        host.main.push({ sha: mergedSha, title: words?.title ?? pull.title });
      } else if (way === "rebase") {
        // A rebase merge writes each commit again, so none keeps the id the batch gave it.
        for (const commit of commits)
          host.main.push({ sha: id(`rebased ${commit.sha}`), title: commit.title });
        mergedSha = (host.main.at(-1) as Commit).sha;
      } else {
        host.main.push(...commits);
        mergedSha = id(`merge of #${number}`);
      }
      host.branches.set("main", mergedSha);
      Object.assign(pull, { state: "closed", merged: true, mergedSha });
      return mergedSha;
    },
    /** The checks the host reports on the open batch's version. */
    report(checks: ForgeCheck[]): void {
      host.checks.set(host.batchHead(), checks);
    },
    batchHead(): string {
      const open = [...host.pulls.values()].find((pull) => pull.state === "open");
      return (open && host.branches.get(open.branch)) ?? "";
    },
    ready(readiness: ForgeReadiness): void {
      for (const pull of host.pulls.values()) if (pull.state === "open") pull.readiness = readiness;
    },
  };
  /** The pull request's version: its branch's, unless it has yet to follow a push. */
  const synced = (pull: StandInPull): StandInPull => {
    if (!host.trails) pull.head = host.branches.get(pull.branch) ?? pull.head;
    return pull;
  };
  const asChange = (pull: StandInPull): ForgeChange => ({
    number: pull.number,
    url: `https://github.com/acme/meter/pull/${pull.number}`,
    branch: pull.branch,
    headSha: synced(pull).head,
    title: pull.title,
    body: pull.body,
  });
  const close = (number: number | undefined) => {
    const pull = number === undefined ? undefined : host.pulls.get(number);
    if (pull) pull.state = "closed";
  };
  const forge = {
    kind: "github",
    host: "github.com",
    place: "GitHub",
    hasChecks: true,
    defaultBranch: async () => "main",
    changeFor: async (branch: string) => {
      if (host.offline) throw new ForgeError("transient", "GitHub could not be reached.");
      const pull = [...host.pulls.values()].find(
        (entry) => entry.branch === branch && entry.state === "open",
      );
      return pull ? asChange(pull) : null;
    },
    openChange: async (input: { branch: string; title: string; body: string }) => {
      const pull: StandInPull = {
        number: 31 + host.pulls.size,
        branch: input.branch,
        head: host.branches.get(input.branch) as string,
        title: input.title,
        body: input.body,
        state: "open",
        merged: false,
        readiness: "blocked",
      };
      host.pulls.set(pull.number, pull);
      if (host.loseNextOpen) {
        host.loseNextOpen = false;
        host.offline = true;
        throw new ForgeError("transient", "GitHub did not answer in time.");
      }
      return asChange(pull);
    },
    branchHead: async (branch: string) => {
      const head = host.branches.get(branch);
      if (!head) throw new ForgeError("refused", `GitHub has no branch ${branch}.`);
      return head;
    },
    updateChangeBody: async (change: ForgeChange, body: string, title?: string) => {
      const pull = synced(host.pulls.get(change.number as number) as StandInPull);
      if (host.editBeforeRewrite !== undefined) {
        pull.body = host.editBeforeRewrite;
        host.editBeforeRewrite = undefined;
      }
      // The host replaces a description only at the version, words and title just read.
      if (
        pull.state !== "open" ||
        pull.head !== change.headSha ||
        pull.body !== (change.body ?? "") ||
        (title !== undefined && pull.title !== change.title)
      )
        throw new ForgeWriteError(
          "failed",
          "refused",
          "The pull request changed after it was read, so its description was not replaced. Read it again before updating.",
        );
      Object.assign(pull, { body, ...(title ? { title } : {}) });
      host.rewrites.push({ number: pull.number, ...(title ? { title } : {}) });
    },
    pull: async (number: number): Promise<ForgePull> => {
      const pull = synced(host.pulls.get(number) as StandInPull);
      return {
        number,
        state: pull.state,
        merged: pull.merged,
        ...(pull.mergedSha ? { mergedSha: pull.mergedSha } : {}),
        headSha: pull.head,
        base: "main",
        branch: pull.branch,
        title: pull.title,
        readiness: pull.readiness,
      };
    },
    checks: async (change: ForgeChange) => {
      host.beforeChecks?.();
      return { complete: true, items: host.checks.get(change.headSha) ?? [] };
    },
    putIn: async (change: ForgeChange, headSha: string, way?: MergeWay) => {
      const number = change.number as number;
      host.merges.push({
        number,
        head: headSha,
        ...(way ? { way } : {}),
        ...(change.title ? { title: change.title } : {}),
        ...(change.squashMessage ? { body: change.squashMessage } : {}),
      });
      if (host.refusal) throw new ForgeError("refused", host.refusal);
      if (host.mergeQueue) {
        host.queued.add(number);
        return { queued: true as const };
      }
      return { sha: host.land(number, way ?? "squash", { title: change.title }) };
    },
    inHostQueue: async (number: number) => {
      host.queueReads += 1;
      return host.queued.has(number);
    },
    mergeWays: async () => {
      if (host.waysUnreadable) throw new ForgeError("transient", "GitHub could not be reached.");
      return host.ways;
    },
    deleteBranch: async (branch: string) => {
      host.branches.delete(branch);
    },
    closeWithNote: async (change: ForgeChange, note: string) => {
      host.notes.push({ number: change.number as number, note });
      close(change.number);
    },
    close: async (change: ForgeChange) => close(change.number),
    label: (change: ForgeChange) => `#${change.number}`,
    url: (change: ForgeChange) => `https://github.com/acme/meter/pull/${change.number}`,
  };
  return { host, forge: forge as unknown as Forge };
}

function setup(ways: MergeWays = EVERY_WAY) {
  const db = openInMemoryDatabase();
  const repos = new RepoRegistry(db, "/fleet");
  seedProject(db, {
    id: REPO,
    name: "meter",
    path: "/code/meter",
    origin: "https://github.com/acme/meter.git",
    delivery: "queue-pr",
  });
  const { host, forge } = standInHost(ways);
  /** Each task's standing merge approval: the version the captain approved. */
  const approvals = new Map<string, string>();
  const closedTasks = new Set<string>();
  const declaredNoChecks = new Set<string>();
  /** Changes whose branch no longer combines with what is ahead of it. */
  const conflicting = new Set<string>();
  /** Changes whose story cannot be written into a description now, as a picture edited since it was looked at. */
  const unwritable = new Set<string>();
  /** A change's story as its crewmate revised it: what its Why says now. */
  const retold = new Map<string, string>();
  const heard = {
    settled: [] as string[][],
    sentBack: [] as { taskId: string; reason: string }[],
    held: [] as BatchHeld[],
    notes: [] as string[],
    taskNotes: [] as { taskId: string; text: string }[],
    pushes: [] as { branch: string; head: string; expected: string | null }[],
    landedReads: 0,
  };
  const names = ["infinitary-batch/3fa9c1d2", "infinitary-batch/8be04a67"];
  let clock = 10_000;
  /** Something that happens while the app combines a batch at home. */
  let duringCombine: (() => void) | undefined;
  /** The active naming runbook's rule: the built-in one, unless a test names another or none. */
  let naming: NamingRule | null = BUNDLED_NAMING;
  /** The app as it starts: a new owner over the same saved record and the same host. */
  const start = () =>
    new Batches({
      repos,
      forgeFor: () => forge,
      now: () => (clock += 1),
      naming: () => naming,
      approved: (taskId, head) => approvals.get(taskId) === head,
      runsNoChecks: (taskId) => declaredNoChecks.has(taskId),
      live: (taskId) => !closedTasks.has(taskId),
      story: async (member) => {
        if (unwritable.has(member.taskId))
          throw new Error("The retained media changed after inspection.");
        return {
          region: `<!-- story of ${member.taskId} -->\n## Why\n${retold.get(member.taskId) ?? member.title}`,
          projectText: `Part of the ${member.taskId} work.`,
        };
      },
      settle: (taskIds) => heard.settled.push(taskIds),
      sentBack: (change, reason) => {
        // As the app does it: a change sent back is no longer approved.
        approvals.delete(change.taskId);
        heard.sentBack.push({ taskId: change.taskId, reason });
      },
      held: (held) => heard.held.push(held),
      note: (text) => heard.notes.push(text),
      taskNote: (taskId, text) => heard.taskNotes.push({ taskId, text }),
      combine: async (input: CombineInput): Promise<Combined> => {
        duringCombine?.();
        duringCombine = undefined;
        const base = host.branches.get(input.defaultBranch) as string;
        let head = base;
        const members: BatchMember[] = [];
        const commits: Commit[] = [];
        const leftOut: Combined["leftOut"] = [];
        for (const change of input.changes) {
          if (conflicting.has(change.taskId)) {
            leftOut.push({ change, reason: LEFT_OUT_WORDS.conflict });
            continue;
          }
          // The commit's date is the combine's, so each combine writes new commits.
          head = id(`${head} ${change.head} ${input.at}`);
          commits.push({ sha: head, title: change.title });
          members.push({ ...change, commit: head });
        }
        host.carried.set(head, commits);
        return { base, head, members, leftOut };
      },
      push: async (input) => {
        // The lease: a branch that is not where the app last pushed it is refused.
        if ((host.branches.get(input.branch) ?? null) !== input.expected)
          throw new Error(`stale info: ${input.branch} is not at ${input.expected}`);
        host.branches.set(input.branch, input.head);
        heard.pushes.push({ branch: input.branch, head: input.head, expected: input.expected });
      },
      landed: async (input) => {
        heard.landedReads += 1;
        return new Map(
          input.members.map((member) => [
            member.taskId,
            [...host.main].reverse().find((commit) => commit.title === member.title)?.sha,
          ]),
        );
      },
      branchName: () => names.shift() as string,
    });
  let batches = start();
  return {
    host,
    repos,
    heard,
    approvals,
    closedTasks,
    declaredNoChecks,
    conflicting,
    unwritable,
    retold,
    get batches() {
      return batches;
    },
    /** The captain approves a change at its version: it goes in line, in turn with any pass at work. */
    approve(change: BatchChange): Promise<void> {
      approvals.set(change.taskId, change.head);
      return batches.enqueue(REPO, change);
    },
    /** The captain turns on a naming runbook of their own, or turns naming off. */
    nameBy(rule: NamingRule | null) {
      naming = rule;
    },
    /** What the captain does while the next batch is being combined. */
    whileCombining(run: () => void) {
      duringCombine = run;
    },
    /** One more pass, after every pass already asked for. */
    pass: () => batches.pass(REPO),
    /** The app closes and opens again: nothing but the saved record and the host carries over. */
    async restart() {
      batches = start();
      await batches.sweep();
    },
    record: () => batches.record(REPO),
    open: () => {
      const open = batches.record(REPO).open;
      if (!open) throw new Error("no batch is open");
      return open;
    },
    members: () => (batches.record(REPO).open?.members ?? []).map((member) => member.taskId),
    place: (change: BatchChange) => batches.standing(REPO, change.taskId, change.head),
  };
}

/** Two approved changes combined and opened as pull request #31. */
async function batchOfTwo(ways: MergeWays = EVERY_WAY) {
  const home = setup(ways);
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  return home;
}

// Intent: the captain's answer in the approved plan (`squash_only`): batched pull requests
// are not offered to a project that allows only squash merges, since a batch keeps one commit
// for each change. The choice in Settings and the first mate's project settings both pass here.
describe("choosing batched pull requests", () => {
  it("is refused with its reason for a project that allows only squash merges", async () => {
    const home = setup({ squash: true, rebase: false, merge: false });
    await expect(home.batches.refuseSquashOnly(REPO)).rejects.toThrow(SQUASH_ONLY_WORDS);
  });

  it("is taken for a project that can keep each change's commit, by a rebase merge or a merge commit", async () => {
    for (const ways of [
      { squash: true, rebase: true, merge: false },
      { squash: false, rebase: false, merge: true },
    ])
      await expect(setup(ways).batches.refuseSquashOnly(REPO)).resolves.toBeUndefined();
  });

  it("is not refused while the host cannot say which merges the project allows", async () => {
    const home = setup({ squash: true, rebase: false, merge: false });
    home.host.waysUnreadable = true;
    await expect(home.batches.refuseSquashOnly(REPO)).resolves.toBeUndefined();
  });
});

describe("forming a batch", () => {
  it("combines the whole line into one pull request, one commit for each change, in approval order", async () => {
    const home = await batchOfTwo();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.branch).toBe("infinitary-batch/3fa9c1d2");
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(home.host.carried.get(pull.head)?.map((commit) => commit.title)).toEqual([
      PARSER.title,
      EXPORT.title,
    ]);
    // The description lists the changes, then carries each one's story.
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).toContain("<!-- story of t-parser -->");
    expect(pull.body).toContain("<!-- story of t-export -->");
    expect(home.open()).toMatchObject({
      number: 31,
      url: "https://github.com/acme/meter/pull/31",
      base: MAIN_AT_START,
      head: pull.head,
    });
    expect(home.record().line).toEqual([]);
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({
      kind: "in-batch",
      link: "https://github.com/acme/meter/pull/31",
    });
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 2)]);
  });

  // The plan's "A batch of several is titled in the app's words in the naming form", under
  // the captain's ruling that no naming form lives in the app: the active runbook gives it.
  it("titles a batch of several in the form the active naming runbook gives a name the app writes, and plainly with none on", async () => {
    const team = setup();
    // A team that names work by its area in capitals and brackets.
    team.nameBy({
      pattern: "^\\[[A-Z][A-Z0-9-]*\\] \\S.+$",
      message: 'Start with the area in capitals and brackets, such as "[DOCS] Explain the export".',
      compose: "[APP] {summary}",
    });
    team.approve(PARSER);
    team.approve(EXPORT);
    await team.pass();
    expect((team.host.pulls.get(31) as StandInPull).title).toBe("[APP] merge 2 approved changes");

    const unnamed = setup();
    unnamed.nameBy(null);
    unnamed.approve(PARSER);
    unnamed.approve(EXPORT);
    await unnamed.pass();
    expect((unnamed.host.pulls.get(31) as StandInPull).title).toBe("merge 2 approved changes");
  });

  it("starts as soon as one change is in line, and keeps one open batch: a later approval waits", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    home.approve(EXPORT);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.place(EXPORT)).toEqual({ state: "waiting", place: "line" });
  });

  // Found by rehearsing this piece's live proof: four changes were approved within half a
  // second, and the pass combining the first one saved the record it had read at its start,
  // so two approvals written beside it left the line until their own merges ran again.
  it("keeps the changes approved while the batch ahead of them is being combined: they wait in line and go up together next", async () => {
    const home = setup();
    home.whileCombining(() => {
      void home.approve(EXPORT);
      void home.approve(LEGEND);
    });
    void home.approve(PARSER);
    await home.pass();
    // One more pass, behind the two approvals that waited their turn.
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-export", "t-legend"]);
    expect(home.place(EXPORT)).toEqual({ state: "waiting", place: "line" });
    expect(home.place(LEGEND)).toEqual({ state: "waiting", place: "line" });

    // The batch ahead merges, and the two that waited go up as one pull request.
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.number)).toEqual([31]);
    expect([...home.host.pulls.keys()]).toEqual([31, 32]);
    expect(home.members()).toEqual(["t-export", "t-legend"]);
    expect(home.record().line).toEqual([]);
  });

  it("leaves out a change that no longer combines, tells its task why, and goes on with the rest", async () => {
    const home = setup();
    home.conflicting.add("t-export");
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-legend"]);
    expect(home.place(EXPORT)).toEqual({ state: "left-out", reason: LEFT_OUT_WORDS.conflict });
    expect(home.heard.taskNotes).toEqual([
      { taskId: "t-export", text: BATCH_WORDS.leftOut(LEFT_OUT_WORDS.conflict) },
    ]);
    expect(home.heard.settled).toEqual([["t-export"]]);

    // Its crewmate brings the branch up to date; the new version, once approved, waits in line.
    home.conflicting.delete("t-export");
    const repaired = { ...EXPORT, head: "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7", at: 6_000 };
    home.approve(repaired);
    await home.pass();
    expect(home.place(repaired)).toEqual({ state: "waiting", place: "line" });
    expect(home.record().leftOut).toEqual([]);
  });

  it("opens no pull request when nothing in line combines", async () => {
    const home = setup();
    home.conflicting.add("t-parser");
    home.approve(PARSER);
    await home.pass();
    expect(home.host.pulls.size).toBe(0);
    expect(home.heard.pushes).toEqual([]);
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({ state: "left-out" });
  });
});

// The independent review's finding on this change, a bug being fixed, with the captain's
// answer to it: a batch opens even when a change's story could not be written, Activity
// names the missing story once, and the description is written again until it is there.
describe("a story that could not be added", () => {
  it("opens the batch anyway, names the missing story once, and adds it as soon as it can be", async () => {
    const home = setup();
    home.unwritable.add(EXPORT.taskId);
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).toContain("<!-- story of t-parser -->");
    expect(pull.body).not.toContain("<!-- story of t-export -->");
    expect(home.heard.notes).toEqual([
      BATCH_WORDS.formed("meter", "#31", 2),
      BATCH_WORDS.noStory("meter", "#31", [EXPORT.title]),
    ]);

    // Still missing on the passes after: nothing is rewritten, and it is not said again.
    await home.pass();
    await home.pass();
    expect(home.host.rewrites).toEqual([]);
    expect(home.heard.notes).toHaveLength(2);

    // The story can be written: the next pass adds it, and the passes after write nothing.
    home.unwritable.clear();
    await home.pass();
    expect(pull.body).toContain("<!-- story of t-export -->");
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);
    expect(home.heard.notes).toHaveLength(2);
  });

  it("does the same for a batch of one, whose description is its change's own story", async () => {
    const home = setup();
    home.unwritable.add(PARSER.taskId);
    home.approve(PARSER);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe(PARSER.title);
    expect(pull.body).toBe("");
    expect(home.heard.notes).toEqual([
      BATCH_WORDS.formed("meter", "#31", 1),
      BATCH_WORDS.noStory("meter", "#31", [PARSER.title]),
    ]);

    home.unwritable.clear();
    await home.pass();
    expect(pull.body).toBe(
      `Part of the t-parser work.\n\n<!-- story of t-parser -->\n## Why\n${PARSER.title}`,
    );
    expect(home.heard.notes).toHaveLength(2);
  });

  it("says nothing again for a story still missing after the batch's members changed", async () => {
    const home = setup();
    home.unwritable.add(EXPORT.taskId);
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const said = home.heard.notes.filter((note) => note.includes("without the story"));
    expect(said).toEqual([BATCH_WORDS.noStory("meter", "#31", [EXPORT.title])]);

    // A change is sent back: the batch is at a new version, and the same story is still missing.
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-legend", reason: "its legend test fails on the batch's version" }],
    });
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(pull.body).not.toContain("<!-- story of t-export -->");
    expect(home.heard.notes.filter((note) => note.includes("without the story"))).toEqual(said);
  });
});

describe("a batch of one", () => {
  it("reads as that change's own pull request: its title, the words around its story, then the story", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe(PARSER.title);
    expect(pull.body).toBe(
      `Part of the t-parser work.\n\n<!-- story of t-parser -->\n## Why\n${PARSER.title}`,
    );
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 1)]);
  });

  it("merges as that pull request does: one squash commit with the change's title and words", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([
      {
        number: 31,
        head: home.heard.pushes[0]?.head,
        way: "squash",
        title: PARSER.title,
        body: PARSER.body,
      },
    ]);
    // The squash commit the host answered is the change's own commit on the default branch.
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.heard.landedReads).toBe(0);
    expect(home.heard.settled).toEqual([["t-parser"]]);
    expect(home.heard.notes.at(-1)).toBe(BATCH_WORDS.merged("meter", "#31", 1));
  });

  it("wakes its own change when its checks fail, and never the first mate", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();
    expect(home.place(PARSER)).toEqual({
      state: "failed",
      checks: ["unit-tests"],
      number: 31,
      url: "https://github.com/acme/meter/pull/31",
    });
    expect(home.heard.settled).toEqual([["t-parser"]]);
    expect(home.heard.held).toEqual([]);
  });
});

describe("merging a batch of several", () => {
  it("merges by rebase where the project allows it: a receipt for each change, the branch deleted, the tasks settled, the next batch formed", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();

    expect(home.host.merges).toEqual([
      {
        number: 31,
        head: home.heard.pushes[0]?.head,
        way: "rebase",
        title: "chore: merge 2 approved changes",
        body: `- ${PARSER.title}\n- ${EXPORT.title}`,
      },
    ]);
    // Each change is its own commit on the default branch, and its receipt names that commit.
    expect(home.host.main.map((commit) => commit.title)).toEqual([PARSER.title, EXPORT.title]);
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: {
        sha: home.host.main[0]?.sha,
        number: 31,
        url: "https://github.com/acme/meter/pull/31",
      },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha, number: 31 },
    });
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    expect(home.heard.notes).toContain(BATCH_WORDS.merged("meter", "#31", 2));

    // The change approved meanwhile is the next batch, on a branch of its own.
    expect(home.open()).toMatchObject({ number: 32, branch: "infinitary-batch/8be04a67" });
    expect(home.members()).toEqual(["t-legend"]);
    expect(home.open().base).toBe(home.host.branches.get("main"));
  });

  it("keeps the batch's own commits with a merge commit where the project allows no rebase merge", async () => {
    const home = await batchOfTwo({ squash: true, rebase: false, merge: true });
    const written = home.open().members.map((member) => member.commit);
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.way)).toEqual(["merge"]);
    expect(home.place(PARSER)).toMatchObject({ state: "merged", receipt: { sha: written[0] } });
    expect(home.place(EXPORT)).toMatchObject({ state: "merged", receipt: { sha: written[1] } });
  });

  it("holds where the project allows only squash merges, says so once, and merges once it allows another", async () => {
    const home = await batchOfTwo({ squash: true, rebase: false, merge: false });
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toMatchObject({ reason: "merge-way", checks: [] });
    expect(
      home.heard.notes.filter((note) => note === BATCH_WORDS.noWay("meter", "#31")),
    ).toHaveLength(1);
    // The allowed merges are kept as read, for the reason Settings shows.
    expect(home.record().ways).toEqual({ squash: true, rebase: false, merge: false });

    home.host.ways = { squash: true, rebase: true, merge: false };
    await home.pass();
    expect(home.host.merges.map((merge) => merge.way)).toEqual(["rebase"]);
    expect(home.record().ways).toEqual({ squash: true, rebase: true, merge: false });
  });

  it("waits while the batch's checks run or the host has not said it may merge", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build"), running("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    home.host.report([passed("build"), passed("unit-tests")]);
    home.host.ready("computing");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().hold).toBeUndefined();
  });

  it("holds a batch the host reads as blocked by a rule, says so once and sends no merge, then merges by itself once the host lets it through", async () => {
    // The plan: the app "follows the host's reading and adds no rule". The live
    // proof on GitHub under a signed-commits rule: the batch's check passed, the
    // host read its pull request as blocked, and the batch waited without a word.
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("blocked");
    await home.pass();
    await home.pass();
    expect(home.host.merges).toEqual([]);
    const held = home.open();
    expect(held.hold).toMatchObject({ reason: "rules", head: held.head, checks: [] });
    const said = BATCH_WORDS.blocked("meter", "#31", "GitHub");
    expect(home.heard.notes.filter((note) => note === said)).toHaveLength(1);
    expect(home.place(PARSER)).toMatchObject({ state: "waiting", place: "held", hold: "rules" });
    // A rule is no failed check: no repair is started for it.
    expect(home.heard.held).toEqual([]);

    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
  });

  it("treats a version with no checks as pending until every change in it was declared to run none", async () => {
    const home = await batchOfTwo();
    home.host.ready("clean");
    await home.pass();
    home.declaredNoChecks.add("t-parser");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    home.declaredNoChecks.add("t-export");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
  });

  it("waits for a pull request that has yet to follow its pushed branch, and combines again only for a branch that itself moved", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const held = home.open();
    const pushes = home.heard.pushes.length;

    // Try again pushes a new version; the host's pull request still shows the one before.
    home.host.trails = true;
    await home.batches.answer(REPO, { action: "try-again", head: held.head });
    const pushed = home.open().head;
    expect(pushed).not.toBe(held.head);
    await home.pass();
    await home.pass();
    expect(home.heard.pushes).toHaveLength(pushes + 1);
    expect(home.open().head).toBe(pushed);
    expect(home.host.merges).toEqual([]);

    // The pull request catches up: its checks are read at the pushed version and it merges.
    home.host.trails = false;
    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([expect.objectContaining({ number: 31, head: pushed })]);

    // A branch someone else moved is not the batch the app combined: it is combined again.
    const moved = setup();
    moved.approve(PARSER);
    await moved.pass();
    const before = moved.open().head;
    moved.host.branches.set(
      "infinitary-batch/3fa9c1d2",
      "c0ffee0123456789abcdef0123456789abcdef01",
    );
    moved.host.carried.set("c0ffee0123456789abcdef0123456789abcdef01", []);
    await moved.pass();
    expect(moved.open().head).not.toBe(before);
    expect(moved.heard.pushes.at(-1)).toMatchObject({
      branch: "infinitary-batch/3fa9c1d2",
      head: moved.open().head,
    });
  });

  it("combines again onto the moved default branch when the host reads the batch behind", async () => {
    const home = await batchOfTwo();
    const first = home.open().head;
    home.host.report([passed("build")]);
    home.host.branches.set("main", "2b4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c");
    home.host.ready("behind");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.open().base).toBe("2b4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c");
    expect(home.open().head).not.toBe(first);
    // The batch branch the app owns moves from the version it last pushed, to the same pull request.
    expect(home.heard.pushes.at(-1)).toEqual({
      branch: "infinitary-batch/3fa9c1d2",
      head: home.open().head,
      expected: first,
    });
    expect([...home.host.pulls.keys()]).toEqual([31]);
  });

  it("closes a change's own pull request with a link once its batch merged", async () => {
    const home = setup();
    home.approve({ ...PARSER, number: 27 });
    home.approve(EXPORT);
    await home.pass();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.notes).toEqual([
      {
        number: 27,
        note: BATCH_WORDS.superseded("#31", "https://github.com/acme/meter/pull/31"),
      },
    ]);
  });

  it("holds a merge the host refused with the host's own words, and never sends it again at that version", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    home.host.refusal = "Commits must have verified signatures.";
    await home.pass();
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    const held = home.open();
    expect(held.hold).toMatchObject({
      reason: "merge-way",
      head: held.head,
      detail: "Commits must have verified signatures.",
    });
    expect(home.heard.notes.at(-1)).toBe(
      BATCH_WORDS.refused("meter", "#31", "Commits must have verified signatures."),
    );

    // The host reading it as blocked and then as mergeable again leaves the refusal standing.
    home.host.ready("blocked");
    await home.pass();
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.open().hold).toMatchObject({ reason: "merge-way", head: held.head });

    // Try again makes a new version; the rule was lifted meanwhile, so that one merges.
    home.host.refusal = undefined;
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    home.host.report([passed("build")]);
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([
      held.head,
      home.heard.pushes.at(-1)?.head,
    ]);
    expect(home.place(PARSER)).toMatchObject({ state: "merged" });
  });
});

// Intent: the approved plan's piece 5, for batches: a branch with a merge
// queue of GitHub's own takes the batch's pull request, and the batch waits
// "until the host merges or removes it".
describe("a batch on a branch with GitHub's merge queue", () => {
  async function queuedBatch() {
    const home = await batchOfTwo();
    home.host.mergeQueue = true;
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    return home;
  }

  it("hands the batch to the queue, waits there without sending again, and settles its tasks once GitHub merges it", async () => {
    const home = await queuedBatch();
    const head = home.open().head;
    expect(home.host.merges).toEqual([expect.objectContaining({ number: 31, head })]);
    expect(home.open()).toMatchObject({ queued: head });
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.notes.at(-1)).toBe(BATCH_WORDS.queued("meter", "#31", "GitHub"));
    // Queued is not merged: no receipt, no task settled.
    expect(home.place(PARSER)).not.toMatchObject({ state: "merged" });
    expect(home.heard.settled).toEqual([]);

    // Later passes, and the app starting again, read the queue and send nothing.
    const reads = home.host.queueReads;
    await home.pass();
    await home.restart();
    expect(home.host.queueReads).toBe(reads + 2);
    expect(home.host.merges).toHaveLength(1);
    expect(home.open()).toMatchObject({ queued: head });

    // GitHub's queue merges it, each change its own commit.
    home.host.queued.delete(31);
    home.host.land(31, "rebase");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha, number: 31 },
    });
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    expect(home.host.merges).toHaveLength(1);
  });

  it("holds a batch GitHub removed from its queue, never sends that version again, and sends the new version Try again makes", async () => {
    const home = await queuedBatch();
    const head = home.open().head;
    // GitHub removes it: the pull request is open and out of the queue.
    home.host.queued.delete(31);
    await home.pass();
    expect(home.open().queued).toBeUndefined();
    expect(home.open().hold).toMatchObject({
      reason: "merge-way",
      head,
      detail: BATCH_WORDS.removed("GitHub"),
    });
    expect(home.heard.notes.at(-1)).toBe(
      BATCH_WORDS.refused("meter", "#31", BATCH_WORDS.removed("GitHub")),
    );
    const told = home.heard.notes.length;
    await home.pass();
    await home.pass();
    expect(home.host.merges).toHaveLength(1);
    expect(home.heard.notes).toHaveLength(told);

    // Try again makes a new version, which goes to the queue once its checks pass.
    expect(await home.batches.answer(REPO, { action: "try-again", head })).toBeUndefined();
    home.host.report([passed("build")]);
    await home.pass();
    const again = home.heard.pushes.at(-1)?.head;
    expect(again).not.toBe(head);
    expect(home.host.merges.map((merge) => merge.head)).toEqual([head, again]);
    expect(home.open()).toMatchObject({ queued: again });
  });
});

describe("a held batch", () => {
  async function heldBatch() {
    const home = await batchOfTwo();
    home.host.report([passed("build"), failed("unit-tests"), failed("lint")]);
    await home.pass();
    return home;
  }

  it("holds on failed checks, tells the first mate once, and keeps later approvals waiting in line", async () => {
    const home = await heldBatch();
    await home.pass();
    const held = home.open();
    expect(held.hold).toMatchObject({
      reason: "checks",
      head: held.head,
      checks: ["unit-tests", "lint"],
    });
    expect(home.heard.held).toHaveLength(1);
    expect(home.heard.held[0]).toMatchObject({
      repo: { id: REPO },
      batch: { number: 31, members: [{ taskId: "t-parser" }, { taskId: "t-export" }] },
    });
    expect(home.heard.notes.at(-1)).toBe(BATCH_WORDS.held("meter", "#31", ["unit-tests", "lint"]));
    // A member of a held batch of several is paused, and its own crewmate is not woken.
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({ kind: "paused" });
    expect(home.heard.settled).toEqual([]);

    home.approve(LEGEND);
    await home.pass();
    expect(home.place(LEGEND)).toEqual({ state: "waiting", place: "line" });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.open().head).toBe(held.head);
    expect(home.host.merges).toEqual([]);
    expect(home.heard.held).toHaveLength(1);
  });

  it("sends two changes back, each with its reason, and combines the rest again with the line", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    home.approve(AXIS);
    await home.pass();
    const held = home.open();

    const refused = await home.batches.answer(REPO, {
      action: "send-back",
      head: held.head,
      changes: [
        { taskId: "t-parser", reason: "its date test fails on the batch's version" },
        { taskId: "t-export", reason: "its export reads the dates the parser change moved" },
      ],
    });

    expect(refused).toBeUndefined();
    expect(home.heard.sentBack).toEqual([
      { taskId: "t-parser", reason: "its date test fails on the batch's version" },
      { taskId: "t-export", reason: "its export reads the dates the parser change moved" },
    ]);
    expect(home.heard.taskNotes).toEqual([
      {
        taskId: "t-parser",
        text: BATCH_WORDS.sentBackTask("its date test fails on the batch's version"),
      },
      {
        taskId: "t-export",
        text: BATCH_WORDS.sentBackTask("its export reads the dates the parser change moved"),
      },
    ]);
    expect(home.heard.notes).toContain(
      BATCH_WORDS.sentBack("meter", PARSER.title, "its date test fails on the batch's version"),
    );
    // The rest of the batch and the change that waited go on as one batch, on the same pull request.
    expect(home.members()).toEqual(["t-legend", "t-axis"]);
    expect(home.record().line).toEqual([]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.place(PARSER)).toBeUndefined();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 2 approved changes");
    expect(pull.body).toContain(`- ${LEGEND.title}\n- ${AXIS.title}`);
    expect(pull.body).not.toContain(PARSER.title);

    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.main.map((commit) => commit.title)).toEqual([LEGEND.title, AXIS.title]);
  });

  it("gives the pull request the batch's own words at what it just read, and sends a rewrite the host refused again", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    home.approve(LEGEND);
    await home.pass();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull.title).toBe("chore: merge 3 approved changes");
    // Opened with its words, the pull request needed no rewrite.
    expect(home.host.rewrites).toEqual([]);

    // Someone edits the description as the batch changes: the host refuses the stale rewrite.
    home.host.editBeforeRewrite = "Edited on the pull request's page.";
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-legend", reason: "its legend test fails on the batch's version" }],
    });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.host.rewrites).toEqual([]);
    expect(pull.title).toBe("chore: merge 3 approved changes");

    // The next pass reads the pull request again and rewrites it once.
    await home.pass();
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    expect(pull.body).toContain(`- ${PARSER.title}\n- ${EXPORT.title}`);
    expect(pull.body).not.toContain(LEGEND.title);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);

    // One change left: the pull request reads as that change's own.
    home.host.report([failed("unit-tests")]);
    await home.pass();
    await home.batches.answer(REPO, {
      action: "send-back",
      head: home.open().head,
      changes: [{ taskId: "t-export", reason: "its export test fails too" }],
    });
    expect(home.members()).toEqual(["t-parser"]);
    expect(pull.title).toBe(PARSER.title);
  });

  it("refuses to send back a change the batch does not carry, and an answer to a hold that ended", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(
      await home.batches.answer(REPO, {
        action: "send-back",
        head: held.head,
        changes: [{ taskId: "t-legend", reason: "its legend test fails" }],
      }),
    ).toBe(BATCH_WORDS.notMember("t-legend"));
    expect(
      await home.batches.answer(REPO, {
        action: "try-again",
        head: "0000000000000000000000000000000000000000",
      }),
    ).toBe(BATCH_WORDS.ended);
    // Settings asks the same answer, and a refusal fails its request with the same words.
    await expect(
      home.batches.answerOrThrow(REPO, {
        action: "try-again",
        head: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(BATCH_WORDS.ended);
    expect(home.heard.sentBack).toEqual([]);
    expect(home.open()).toEqual(held);
  });

  it("lets a change declared the batch's fix join it once approved and end the hold, while the line waits", async () => {
    const home = await heldBatch();
    home.approve(LEGEND);
    await home.pass();
    const held = home.open();
    const fix: BatchChange = {
      taskId: "t-fix",
      branch: "fm/task-fix",
      head: "3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2a1",
      title: "fix(export): read dates through the parser's new form",
      body: "- The export reads dates as the parser now writes them.",
      at: 7_000,
    };

    expect(await home.batches.declareFix(REPO, "t-fix")).toBeUndefined();
    // Declared, not yet approved: the batch stays held as it was.
    await home.pass();
    expect(home.open()).toEqual(held);

    home.approve(fix);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export", "t-fix"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.record().line.map((change) => change.taskId)).toEqual(["t-legend"]);
    expect(home.record().fixes).toBeUndefined();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect((home.host.pulls.get(31) as StandInPull).title).toBe("chore: merge 3 approved changes");
  });

  it("refuses a fix declaration when no batch of the project is held", async () => {
    const home = await batchOfTwo();
    expect(await home.batches.declareFix(REPO, "t-fix")).toBe(
      "No batch of this project is held, so there is nothing to fix.",
    );
    expect(home.record().fixes).toBeUndefined();
  });

  it("ends the hold when the failed checks run again, merges when they pass, and holds anew when they fail again", async () => {
    const home = await heldBatch();
    const held = home.open();
    // The repair judged a flake and ran the failed checks again where the project lives.
    home.host.report([passed("build"), running("unit-tests"), running("lint")]);
    await home.pass();
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).toBe(held.head);
    expect(home.batches.status(REPO, PARSER.taskId, PARSER.head)).toMatchObject({
      kind: "in-batch",
    });

    home.host.report([passed("build"), failed("unit-tests"), passed("lint")]);
    await home.pass();
    expect(home.open().hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
    expect(home.heard.held).toHaveLength(2);

    home.host.report([passed("build"), passed("unit-tests"), passed("lint")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges.map((merge) => merge.head)).toEqual([held.head]);
    expect(home.heard.pushes).toHaveLength(1);
  });

  it("tries again by combining the batch at a new version, so its checks run again", async () => {
    const home = await heldBatch();
    const held = home.open();
    expect(
      await home.batches.answer(REPO, { action: "try-again", head: held.head }),
    ).toBeUndefined();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.open().hold).toBeUndefined();
    expect(home.open().head).not.toBe(held.head);
    expect(home.heard.pushes.at(-1)).toMatchObject({ expected: held.head });
    expect(home.heard.notes.at(-1)).toBe(BATCH_WORDS.retried("meter", "#31"));
  });
});

describe("an approval withdrawn", () => {
  it("takes the change out of the open batch, which combines again without it", async () => {
    const home = await batchOfTwo();
    const first = home.open().head;
    await home.batches.withdraw(REPO, "t-export");
    await home.pass();
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.open().head).not.toBe(first);
    expect(home.open().stale).toBeUndefined();
    // The pull request now carries one change, so it reads as that change's own.
    expect((home.host.pulls.get(31) as StandInPull).title).toBe(PARSER.title);
    expect(home.place(EXPORT)).toBeUndefined();
  });

  it("carries no further a change whose approval ended since it joined", async () => {
    const home = await batchOfTwo();
    home.approvals.delete("t-parser");
    await home.pass();
    expect(home.members()).toEqual(["t-export"]);
  });

  it("closes the pull request and drops the branch once every change was withdrawn", async () => {
    const home = await batchOfTwo();
    await home.batches.withdraw(REPO, "t-parser");
    await home.batches.withdraw(REPO, "t-export");
    await home.pass();
    expect(home.record().open).toBeUndefined();
    expect((home.host.pulls.get(31) as StandInPull).state).toBe("closed");
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.host.merges).toEqual([]);
  });

  it("takes a waiting change out of the line", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.batches.withdraw(REPO, "t-legend");
    await home.pass();
    expect(home.record().line).toEqual([]);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
  });

  it("merges only approved work: an approval that ends as the batch turns green leaves before the merge", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    // The captain's reply ends the approval after this pass's first look.
    home.host.beforeChecks = () => {
      home.approvals.delete("t-export");
      home.host.beforeChecks = undefined;
    };
    await home.pass();
    expect(home.host.merges).toEqual([]);
    expect(home.members()).toEqual(["t-parser"]);
    expect(home.host.main).toEqual([]);
  });
});

// The independent review's finding on this change, a bug being fixed, with the captain's
// answer to it: a change whose story is revised at its approved version stays in its batch,
// which only takes the story's title and words.
describe("a story revised at the approved version", () => {
  const RETITLED = {
    taskId: PARSER.taskId,
    head: PARSER.head,
    title: "fix(parser): read a date's time zone as written",
    body: "- A date keeps the time zone it was written with.",
  };
  const asItWas = (change: BatchChange) => ({
    taskId: change.taskId,
    head: change.head,
    title: change.title,
    body: change.body,
  });

  it("rewrites only the description when the commit words read as they did: no new version, no checks run again", async () => {
    const home = await batchOfTwo();
    const pull = home.host.pulls.get(31) as StandInPull;
    const version = pull.head;
    home.retold.set(EXPORT.taskId, "A report could not leave the app.");
    await home.batches.revise(REPO, asItWas(EXPORT));
    await home.pass();
    expect(pull.body).toContain("A report could not leave the app.");
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
    expect(pull.head).toBe(version);
    expect(home.heard.pushes).toHaveLength(1);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    await home.pass();
    expect(home.host.rewrites).toHaveLength(1);
  });

  it("combines the batch again in place when the commit words changed: the same pull request, the same order, the commit under its new title", async () => {
    const home = await batchOfTwo();
    const pull = home.host.pulls.get(31) as StandInPull;
    const version = pull.head;
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(pull.state).toBe("open");
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.host.carried.get(pull.head)?.map((commit) => commit.title)).toEqual([
      RETITLED.title,
      EXPORT.title,
    ]);
    // The new version went over the one the app pushed, to the same branch.
    expect(home.heard.pushes.at(-1)).toMatchObject({
      branch: "infinitary-batch/3fa9c1d2",
      expected: version,
    });
    expect(pull.body).toContain(`- ${RETITLED.title}\n- ${EXPORT.title}`);
    expect(home.place(PARSER)).toMatchObject({ state: "waiting", place: "batch", number: 31 });
  });

  it("keeps a batch of one's pull request open under the story's new title, never closing and opening another", async () => {
    const home = setup();
    home.approve(PARSER);
    await home.pass();
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    const pull = home.host.pulls.get(31) as StandInPull;
    expect(pull).toMatchObject({ state: "open", title: RETITLED.title });
    expect(home.host.branches.get("infinitary-batch/3fa9c1d2")).toBe(pull.head);
    // It merges as that change's own pull request would, under the revised words.
    home.host.report([passed("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toMatchObject([
      { number: 31, way: "squash", title: RETITLED.title, body: RETITLED.body },
    ]);
  });

  it("sends no change back from a held batch: the hold stays for a story whose commit words read as they did", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    const held = home.open().hold;
    expect(held).toMatchObject({ reason: "checks" });
    home.retold.set(EXPORT.taskId, "A report could not leave the app.");
    await home.batches.revise(REPO, asItWas(EXPORT));
    await home.pass();
    expect(home.open().hold).toEqual(held);
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.sentBack).toEqual([]);
    expect((home.host.pulls.get(31) as StandInPull).body).toContain(
      "A report could not leave the app.",
    );

    // New commit words make a new version of the same changes, whose checks run again.
    await home.batches.revise(REPO, RETITLED);
    await home.pass();
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.sentBack).toEqual([]);
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.pushes).toHaveLength(2);
  });

  it("keeps a waiting change's place in line under the story's new words", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.approve(AXIS);
    await home.batches.revise(REPO, {
      ...asItWas(LEGEND),
      title: "fix(chart): keep the legend clear of the bars",
    });
    await home.pass();
    expect(home.record().line.map((change) => change.title)).toEqual([
      "fix(chart): keep the legend clear of the bars",
      AXIS.title,
    ]);
    expect(home.heard.pushes).toHaveLength(1);
  });

  it("takes the batch's version of a change out when its story is confirmed at another version", async () => {
    const home = await batchOfTwo();
    await home.batches.revise(REPO, { ...RETITLED, head: LEGEND.head });
    await home.pass();
    expect(home.members()).toEqual(["t-export"]);
    expect(home.place(PARSER)).toBeUndefined();
  });
});

describe("after a restart", () => {
  it("adopts the pull request the host already holds when its confirmation was lost, and opens no second one", async () => {
    const home = setup();
    home.host.loseNextOpen = true;
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    expect(home.open().number).toBeUndefined();
    expect(home.host.pulls.size).toBe(1);
    home.host.offline = false;

    await home.restart();
    expect([...home.host.pulls.keys()]).toEqual([31]);
    expect(home.open()).toMatchObject({ number: 31, url: "https://github.com/acme/meter/pull/31" });
    expect(home.heard.notes).toEqual([BATCH_WORDS.formed("meter", "#31", 2)]);
  });

  it("reads the open pull request once and rewrites nothing that already carries the batch's words", async () => {
    const home = await batchOfTwo();
    await home.restart();
    await home.pass();
    expect(home.host.rewrites).toEqual([]);

    // A rewrite that never reached the host before the app closed is sent after it opens again.
    const pull = home.host.pulls.get(31) as StandInPull;
    pull.title = "chore: merge 3 approved changes";
    await home.restart();
    expect(home.host.rewrites).toEqual([{ number: 31, title: "chore: merge 2 approved changes" }]);
  });

  it("reads a batch that merged while the app was closed: receipts, the branch dropped, the tasks settled", async () => {
    const home = await batchOfTwo();
    home.host.land(31, "rebase");
    await home.restart();
    expect(home.record().open).toBeUndefined();
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha, number: 31 },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha },
    });
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.heard.settled).toEqual([["t-parser", "t-export"]]);
    // The app sent no merge of its own.
    expect(home.host.merges).toEqual([]);
  });

  it("puts the changes back at the front of the line when the pull request was closed unmerged, and forms the next batch", async () => {
    const home = await batchOfTwo();
    home.approve(LEGEND);
    await home.pass();
    (home.host.pulls.get(31) as StandInPull).state = "closed";
    await home.restart();
    expect(home.host.branches.has("infinitary-batch/3fa9c1d2")).toBe(false);
    expect(home.open()).toMatchObject({ number: 32, branch: "infinitary-batch/8be04a67" });
    expect(home.members()).toEqual(["t-parser", "t-export", "t-legend"]);
  });

  it("keeps a held batch held without telling the first mate again", async () => {
    const home = await batchOfTwo();
    home.host.report([failed("unit-tests")]);
    await home.pass();
    await home.restart();
    expect(home.open().hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
    expect(home.heard.held).toHaveLength(1);
  });

  it("drops a merged change's receipt once its task closed", async () => {
    const home = await batchOfTwo();
    home.host.report([passed("build")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.record().receipts.map((receipt) => receipt.taskId)).toEqual([
      "t-parser",
      "t-export",
    ]);
    home.closedTasks.add("t-parser");
    home.closedTasks.add("t-export");
    await home.restart();
    expect(home.repos.get(REPO)?.batch?.receipts ?? []).toEqual([]);
  });
});
