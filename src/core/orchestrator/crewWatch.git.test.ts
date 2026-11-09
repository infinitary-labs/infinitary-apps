/**
 * The crew's watch over real git (docs/forge.md, "The check watch"): a
 * GitHub read that never returns at the twenty-minute check, closed tasks'
 * working copies removed with their work saved first, and the host's check
 * watch from a pending reading to its one wake.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  SETTLE_MERGE,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Forge, ForgeChange, ForgeCheckState, ForgeError, ForgePull } from "../forge";
import type { TaskRecord } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { git } from "../workspace/git";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService as RealWorkspaceService } from "../workspace/workspaceService";
import { type ChangeDelivery, createChangeDelivery } from "./changeDelivery";
import { ciFactOf } from "./ciFact";
import { QUIET_CARD_MS } from "./crewWatch";
import { CHECK_OBSERVATIONS_LEAD } from "./deliveryWakes";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  // INF-2603, the captain's direction B: "Name the wait and settle the app's
  // own calls". INF-2550's turn sat 13 hours inside one github_read that
  // never answered, with two steers queued behind it. The twenty-minute
  // check answers the app's own read "ask again", so the turn goes on.
  it("answers a GitHub read that never returns at the twenty-minute check, so the turn goes on (INF-2603)", async () => {
    const crewmate = fakeCrewmate();
    const githubRead = vi.fn(() => new Promise<string>(() => {}));
    const { supervisor, tasks, repos, sessionSpecs, ops } = setup(crewmate, { githubRead });
    const { repo } = await repos.setup({ kind: "init", name: "shop" });
    repos.configure(repo.id, { delivery: "direct-pr" });
    const { taskId } = await supervisor.intake.commission({
      title: "Find the failed phone runs",
      intent: intentOf("find the failed phone runs"),
      repoId: repo.id,
    });
    await tick();
    const read = sessionSpecs[0]?.tools.find((tool) => tool.name === "github_read");
    if (!read) throw new Error("the crewmate holds no github_read");
    const start = Date.now();
    crewmate.emit({ type: "tool_start", taskId, callId: "call-1", toolName: "github_read" });
    const reading = read.run(
      { path: "/repos/acme/shop/actions/runs?per_page=100" },
      new AbortController().signal,
    );
    await supervisor.steer.steerCrewmate(taskId, "Also say which of them failed on the phone.");
    expect(crewmate.steer).toHaveBeenCalledTimes(1);

    supervisor.watch.checkQuietTasks(start + QUIET_CARD_MS + 60_000);

    await expect(reading).rejects.toThrow("Infinitary answered this github_read call for you");
    expect(
      tasks
        .timeline(taskId)
        .some((event) => event.text?.startsWith('answered github_read "ask again"')),
    ).toBe(true);
    // The answer moves the turn on, so nobody is woken for it.
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(false);
    expect(ops.some((line) => line.includes("still unread"))).toBe(false);
    // The turn goes on: the read ends and its session reads the steer.
    crewmate.emit({
      type: "tool_end",
      taskId,
      callId: "call-1",
      toolName: "github_read",
      isError: true,
    });
    const steered = crewmate.steer.mock.calls[0]?.[0] ?? "";
    crewmate.emit({
      type: "input_read",
      textSha256: createHash("sha256").update(steered).digest("hex"),
    });
    expect(supervisor.facts.crewStatus(taskId)[0]?.waiting).toBeUndefined();
  });
});

/**
 * Always clean (captain, 2026-09-22: "when a task closes, its worktree gets
 * cleaned up period. no exceptions"), end to end over REAL git: the real
 * supervisor's close and boot paths, the real workspace service, real
 * repositories. A closed task's worktree and branch always go; whatever
 * never merged is saved first as one commit on refs/infinitary/kept/<id>,
 * outside every branch listing. The MacBook evidence this reproduces: 27 of
 * 32 kept trees were squash-merged pull requests that git ancestry reads
 * as unlanded forever, and 5 held real uncommitted edits.
 */
describe("closed task worktrees always go, work saved first (real git)", {
  timeout: 60_000,
}, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  // Real git under a loaded machine (the whole suite runs in parallel):
  // generous bounds, polled, so a slow host never reads as a failure.
  const REAL_GIT_WAIT = { timeout: 20_000, interval: 25 };

  const kept = (taskId: string) => `refs/infinitary/kept/${taskId}`;

  async function refExists(repoDir: string, ref: string): Promise<boolean> {
    try {
      await git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** A commissioned crewmate, idle, on a real worktree of the default repo. */
  async function commissionReal(extras: Pick<SetupExtras, "readPull"> = {}) {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate, { realWorkspace: true, ...extras });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Tidy the meter test",
      intent: intentOf("go"),
    });
    const record = await vi.waitFor(() => {
      const current = harness.tasks.get(taskId);
      if (!current?.worktreeDir || !existsSync(current.worktreeDir)) throw new Error("not yet");
      return current;
    }, REAL_GIT_WAIT);
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(harness.tasks.get(taskId)?.activity).toBe("idle"), REAL_GIT_WAIT);
    return {
      ...harness,
      crewmate,
      taskId,
      cwd: record.worktreeDir,
      branch: record.branch,
      repoDir: record.repoDir,
    };
  }

  async function cancelAndSettle(harness: Awaited<ReturnType<typeof commissionReal>>) {
    await harness.supervisor.sessions.interruptCrewmate(harness.taskId, "cancel");
    await vi.waitFor(
      () => expect(harness.tasks.get(harness.taskId)?.workspaceState).not.toBe("present"),
      REAL_GIT_WAIT,
    );
    await harness.realWorkspace?.deletionsSettled();
  }

  it("a squash-merged task: tree and branch gone, its content recoverable from the kept ref", async () => {
    const harness = await commissionReal();
    const { cwd, branch, repoDir, taskId, tasks } = harness;
    writeFileSync(join(cwd, "meter.txt"), "fixed meter\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "fix the meter"]);
    // The pull request merged by squash: main carries the content, but not
    // the branch's commit - ancestry calls it unlanded forever.
    await git(repoDir, ["merge", "--squash", branch]);
    await git(repoDir, ["commit", "-m", "fix the meter (#8)"]);

    await cancelAndSettle(harness);

    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", workspaceState: "removed" });
    expect(existsSync(cwd)).toBe(false);
    expect(await git(repoDir, ["branch", "--list", branch])).toBe("");
    // Ancestry cannot see a squash merge, so a save IS made - harmless,
    // since the content is also on main.
    expect(await git(repoDir, ["show", `${kept(taskId)}:meter.txt`])).toBe("fixed meter");
  });

  // INF-2628, the captain's "Release close accepts closed pull requests and
  // squash merges": LOOK-134's own pull request closed without merging and
  // another task's squash-merged pull request delivered its work. The first
  // mate closes it as released on that verified delivery; the task's own
  // commits, unmerged to history, are kept rather than refused.
  it("a released close of a task whose own pull request closed unmerged: closes, its squashed commits recoverable from the kept ref", async () => {
    let ownPull: ForgePull = {
      number: 66,
      state: "open",
      merged: false,
      headSha: "",
      base: "main",
      readiness: "clean",
    };
    const harness = await commissionReal({
      readPull: async (_id, number) => (number === ownPull.number ? ownPull : undefined),
    });
    const { cwd, branch, repoDir, taskId, tasks, supervisor } = harness;
    writeFileSync(join(cwd, "meter.txt"), "fixed meter\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "fix the meter"]);
    const original = await git(cwd, ["rev-parse", "HEAD"]);
    ownPull = { ...ownPull, headSha: original };
    tasks.turns.recordReport(taskId, { text: "Fixed the meter on PR #66" });
    seedDelivery(tasks, taskId, { prUrl: "https://github.com/o/r/pull/66", prNumber: 66 });
    // Another task's pull request merged the same work by squash: main has
    // the content, but not this branch's commit.
    await git(repoDir, ["merge", "--squash", branch]);
    await git(repoDir, ["commit", "-m", "fix the meter (#65)"]);

    // While its own pull request is open, the close refuses and keeps everything.
    const held = await supervisor.settling.done.close(taskId, {
      why: "released",
      evidence: "PR #65 merged with this work",
    });
    expect(held.text).toContain("#66 is still open");
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(existsSync(cwd)).toBe(true);

    ownPull = { ...ownPull, state: "closed" };
    const closed = await supervisor.settling.done.close(taskId, {
      why: "released",
      evidence: "PR #65 merged with this work",
    });
    expect(closed.text).toContain("Closed");
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "released" });
    expect(tasks.timeline(taskId).find((entry) => entry.data?.releaseEvidence)?.data).toMatchObject(
      { releaseEvidence: "PR #65 merged with this work" },
    );
    await vi.waitFor(() => expect(existsSync(cwd)).toBe(false), REAL_GIT_WAIT);
    await harness.realWorkspace?.deletionsSettled();
    expect(await git(repoDir, ["branch", "--list", branch])).toBe("");
    // The history rides along: the kept commit holds the original commit and its file.
    expect(await git(repoDir, ["merge-base", "--is-ancestor", original, kept(taskId)])).toBe("");
    expect(await git(repoDir, ["show", `${kept(taskId)}:meter.txt`])).toBe("fixed meter");
  });

  // INF-2626, fix 1 (the captain's "File the checked fixes"): a first mate held
  // squash-merged tasks open because their commits sit outside the merged
  // history. settle_task's description now says every close keeps them; this
  // is the merge close doing so for a pull request already merged by squash.
  it("the first mate's merge close of a squash-merged task closes it as merged and keeps its own commit (INF-2626)", async () => {
    const harness = await commissionReal({
      readPull: async (_id, number) => ({
        number,
        state: "closed",
        merged: true,
        mergedSha: "squash40",
        headSha: "head40",
        base: "main",
        readiness: "clean",
      }),
    });
    const { cwd, branch, repoDir, taskId, tasks, supervisor } = harness;
    writeFileSync(join(cwd, "meter.txt"), "fixed meter\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "fix the meter"]);
    await git(repoDir, ["merge", "--squash", branch]);
    await git(repoDir, ["commit", "-m", "fix the meter (#40)"]);
    seedDelivery(tasks, taskId, { prNumber: 40 });

    await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
    await vi.waitFor(
      () => expect(tasks.get(taskId)?.workspaceState).toBe("removed"),
      REAL_GIT_WAIT,
    );

    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(existsSync(cwd)).toBe(false);
    expect(await git(repoDir, ["log", "--format=%s", kept(taskId)])).toContain("fix the meter");
    expect(await git(repoDir, ["show", `${kept(taskId)}:meter.txt`])).toBe("fixed meter");
  });

  it("a dirty dropped task: tracked and untracked edits recoverable from the kept ref, ignored files not", async () => {
    const harness = await commissionReal();
    const { cwd, branch, repoDir, taskId, tasks, events } = harness;
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "ignore deps"]);
    writeFileSync(join(cwd, "README.md"), "edited, never committed\n");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "new.ts"), "export const brandNew = true;\n");
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "node_modules", "huge.js"), "dependency\n");
    // The crewmate's own index is left as it was: staged here, unstaged there.
    await git(cwd, ["add", "README.md"]);

    await cancelAndSettle(harness);

    expect(tasks.get(taskId)?.workspaceState).toBe("removed");
    expect(existsSync(cwd)).toBe(false);
    expect(await git(repoDir, ["branch", "--list", branch])).toBe("");
    const ref = kept(taskId);
    expect(await git(repoDir, ["show", `${ref}:README.md`])).toBe("edited, never committed");
    expect(await git(repoDir, ["show", `${ref}:src/new.ts`])).toBe("export const brandNew = true;");
    expect(await git(repoDir, ["show", `${ref}:.gitignore`])).toBe("node_modules/");
    expect(await git(repoDir, ["ls-tree", "-r", "--name-only", ref])).not.toContain("node_modules");
    // ONE commit whose parent is the branch's own head: the history rides along.
    expect(await git(repoDir, ["log", "--format=%s", ref])).toContain("ignore deps");
    // Quiet: a timeline line naming no ref, and no feed line about it.
    const saved = tasks.timeline(taskId).find((event) => event.data?.saved);
    expect(saved).toMatchObject({ feed: false });
    expect(saved?.text).not.toContain("refs/");
    expect(JSON.stringify(events)).not.toContain("refs/infinitary");
  });

  it("Start again recovers never-reported saved edits in a fresh working copy, not preloaded", async () => {
    const harness = await commissionReal();
    const { supervisor, tasks, crewmate, cwd, repoDir, taskId } = harness;
    writeFileSync(join(cwd, "draft.txt"), "The harbour chart is half drawn.\n");
    expect(tasks.get(taskId)?.outcome).toBeNull();
    // Click immediately after cancellation: restart must join retirement,
    // not race its save and deliver a branch that is about to disappear.
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    const result = supervisor.starts.startAgain(taskId, "captain");
    if (!result.ok) throw new Error(result.text);
    await result.started;
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
    const fresh = tasks.get(result.task.id);
    if (!fresh) throw new Error("replacement missing");
    expect(fresh.worktreeDir).not.toBe(cwd);
    expect(existsSync(join(fresh.worktreeDir, "draft.txt"))).toBe(false);
    const brief = crewmate.promptCalls[1] ?? "";
    expect(brief).toContain(kept(taskId));
    expect(brief).toContain("start from it");
    const saved = await git(repoDir, ["show", `${kept(taskId)}:draft.txt`]);
    expect(saved).toBe("The harbour chart is half drawn.");
    // The crewmate applies the named work itself, through git in its copy.
    await git(fresh.worktreeDir, ["restore", `--source=${kept(taskId)}`, "--", "draft.txt"]);
    expect(readFileSync(join(fresh.worktreeDir, "draft.txt"), "utf8")).toBe(`${saved}\n`);
    console.info(
      "Start again recovery",
      JSON.stringify({
        old: {
          key: tasks.get(taskId)?.key,
          status: tasks.get(taskId)?.status,
          outcome: tasks.get(taskId)?.outcome,
        },
        replacement: { key: fresh.key, status: fresh.status },
        savedRef: kept(taskId),
        saved,
        preloaded: false,
        applied: readFileSync(join(fresh.worktreeDir, "draft.txt"), "utf8"),
        brief,
      }),
    );
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(tasks.get(fresh.id)?.activity).toBe("idle"), REAL_GIT_WAIT);
    await supervisor.sessions.interruptCrewmate(fresh.id, "cancel");
    await vi.waitFor(
      () => expect(tasks.get(fresh.id)?.workspaceState).toBe("removed"),
      REAL_GIT_WAIT,
    );
    await harness.realWorkspace?.deletionsSettled();
  });

  it("the kept ref never shows as a branch, a task branch, or a leftover", async () => {
    const harness = await commissionReal();
    const { cwd, repoDir, taskId, events, supervisor, realWorkspace } = harness;
    writeFileSync(join(cwd, "draft.txt"), "draft\n");
    await cancelAndSettle(harness);

    expect(await refExists(repoDir, kept(taskId))).toBe(true);
    expect(await git(repoDir, ["branch", "--all", "--format=%(refname)"])).not.toContain(
      "refs/infinitary",
    );
    expect(await git(repoDir, ["tag", "--list"])).toBe("");
    expect(await realWorkspace?.listTaskBranches(repoDir)).toEqual([]);
    await supervisor.watch.reconcileFleetHygiene();
    expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
  });

  it("boot: a closed task with its tree present and a tree with no record are both saved and removed", async () => {
    const { supervisor, tasks, realWorkspace, paths, events } = setup(fakeCrewmate(), {
      realWorkspace: true,
    });
    const workspace = realWorkspace as RealWorkspaceService;
    // A task closed before this rule existed, its tree left behind dirty.
    const closed = await workspace.createTaskWorktree("closed1");
    writeFileSync(join(closed.cwd, "README.md"), "left dirty\n");
    seedTask(tasks, {
      id: "closed1",
      title: "Closed long ago",
      status: "cancelled",
      worktreeDir: closed.cwd,
      branch: closed.branch,
      repoDir: closed.repoDir,
    });
    // A tree whose record is gone, with a commit that never merged.
    const orphan = await workspace.createTaskWorktree("ghost1");
    writeFileSync(join(orphan.cwd, "ghost.txt"), "orphaned work\n");
    await git(orphan.cwd, ["add", "-A"]);
    await git(orphan.cwd, ["commit", "-m", "orphaned work"]);
    // A live task's tree is never touched.
    const live = await workspace.createTaskWorktree("live1");
    seedTask(tasks, {
      id: "live1",
      title: "Live",
      status: "idle",
      worktreeDir: live.cwd,
      branch: live.branch,
      repoDir: live.repoDir,
    });

    await supervisor.watch.reconcileFleetHygiene();
    await workspace.deletionsSettled();

    const repoDir = paths.defaultWorkspaceDir;
    expect(existsSync(closed.cwd)).toBe(false);
    expect(tasks.get("closed1")?.workspaceState).toBe("removed");
    expect(await git(repoDir, ["show", `${kept("closed1")}:README.md`])).toBe("left dirty");
    expect(existsSync(orphan.cwd)).toBe(false);
    expect(await git(repoDir, ["show", `${kept("ghost1")}:ghost.txt`])).toBe("orphaned work");
    expect(await git(repoDir, ["branch", "--list", "fm/task-closed1", "fm/task-ghost1"])).toBe("");
    expect(existsSync(live.cwd)).toBe(true);
    expect(await git(repoDir, ["branch", "--list", "--format=%(refname:short)"])).toContain(
      "fm/task-live1",
    );
    expect(await workspace.listWorktreeDirs()).toEqual(["live1"]);
    expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
  });

  it("a save that fails keeps the tree and branch, and says so in the feed", async () => {
    const harness = await commissionReal();
    const { cwd, branch, repoDir, taskId, tasks } = harness;
    writeFileSync(join(cwd, "precious.txt"), "unsaved work\n");
    // Git can no longer write objects: the save cannot happen.
    const objects = join(repoDir, ".git", "objects");
    execFileSync("chmod", ["-R", "a-w", objects]);
    try {
      await harness.supervisor.sessions.interruptCrewmate(taskId, "cancel");
      await vi.waitFor(
        () => expect(tasks.timeline(taskId).find((event) => event.data?.kept)).toBeTruthy(),
        REAL_GIT_WAIT,
      );
    } finally {
      execFileSync("chmod", ["-R", "u+w", objects]);
    }
    expect(tasks.get(taskId)?.workspaceState).toBe("present");
    expect(readFileSync(join(cwd, "precious.txt"), "utf8")).toBe("unsaved work\n");
    expect(await git(repoDir, ["branch", "--list", "--format=%(refname:short)", branch])).toBe(
      branch,
    );
    expect(tasks.timeline(taskId).find((event) => event.data?.kept)).toMatchObject({
      feed: true,
      text: "working copy kept - its work could not be saved first; discard to remove it",
    });
  });
});

describe('the host\'s check watch (docs/forge.md, "The check watch")', () => {
  // The host's one clock (P5): the case moves `hostNow`; nothing fakes a timer.
  let hostNow = 0;
  const hostClock = () => hostNow;
  beforeEach(() => {
    vi.useRealTimers();
    hostNow = Date.now();
  });
  /** One turn of the event loop: the supervisor's promise chains settle; no clock moves. */
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const minutes = (n: number) => n * 60_000;

  /** A change where the project lives whose checks the case moves between reads. */
  class ChecksForge implements Forge {
    readonly kind;
    readonly host;
    readonly place;
    readonly hasChecks;
    headSha = "cafe0001feedbeef";
    states: ForgeCheckState[] = ["pending", "pending"];
    /** Every read of the checks, by anyone: the crewmate's, the watch's. */
    checkReads = 0;
    failNext: ForgeError | undefined;

    constructor(kind: "github" | "git" = "github") {
      this.kind = kind;
      this.host = kind === "github" ? "github.com" : "git.example.com";
      this.place = kind === "github" ? "GitHub" : "git.example.com";
      this.hasChecks = kind === "github";
    }
    async listProjects() {
      return [];
    }
    async defaultBranch() {
      return "main";
    }
    async openChange(input: { branch: string }): Promise<ForgeChange> {
      return this.changeOf(input.branch);
    }
    async changeFor(branch: string) {
      return this.changeOf(branch);
    }
    async checks() {
      this.checkReads += 1;
      const fail = this.failNext;
      this.failNext = undefined;
      if (fail) throw fail;
      if (!this.hasChecks) return { overall: "green" as const, items: [] };
      const items = this.states.map((state, index) => ({
        name: ["linux-checks", "lint"][index] ?? `check-${index}`,
        state,
      }));
      return { items };
    }
    async putIn() {
      return undefined;
    }
    async close() {}
    label(change: ForgeChange) {
      return change.number !== undefined ? `#${change.number}` : change.branch;
    }
    url(change: ForgeChange) {
      return change.url;
    }
    private changeOf(branch: string): ForgeChange {
      return this.kind === "github"
        ? { number: 7, url: "https://github.com/o/r/pull/7", branch, headSha: this.headSha }
        : { url: null, branch, headSha: this.headSha };
    }
  }

  /**
   * A direct-pr task on a real repository whose crewmate read its checks
   * with check_change and ended its turn to wait, as the tool tells it to:
   * the real check_change and the real watch, over the case's forge.
   */
  async function waiting(forge = new ChecksForge()) {
    const crewmate = fakeCrewmate();
    let delivery: ChangeDelivery | undefined;
    const service = () => {
      if (!delivery) throw new Error("check service not ready");
      return delivery;
    };
    const harness = setup(crewmate, {
      now: hostClock,
      openChange: (taskId, input) => service().publication.open(taskId, input),
      checkChange: (taskId, input) => service().checkTool.checkForCrew(taskId, input),
      readCheckWatch: (taskId) => service().checks.readWatched(taskId),
    });
    delivery = createChangeDelivery({
      tasks: harness.tasks,
      repos: harness.repos,
      forgeFor: () => forge,
      now: hostClock,
    });
    const { repo } = await harness.repos.setup({ kind: "init", name: "watched" });
    harness.repos.configure(repo.id, { delivery: "direct-pr" });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("Ship the fix"),
      repoId: repo.id,
    });
    await tick();
    const said = (await harness.specs[0]?.onCheckChange?.()) ?? "";
    crewmate.emit({
      type: "assistant_delta",
      taskId,
      text: "PR #7 is open; waiting on its checks.",
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const start = hostNow;
    /** The shared tick at `ms` past the wait's start: the ladder, the sweeps, the watch. */
    const at = async (ms: number) => {
      hostNow = start + ms;
      harness.supervisor.watch.reconcileIdle(hostNow);
      await harness.supervisor.watch.sweepGates(hostNow);
      await harness.supervisor.watch.pollCheckWatches(hostNow);
      await tick();
    };
    return { ...harness, crewmate, forge, delivery, taskId, said, start, at };
  }

  const watchWakes = (prompts: string[]) =>
    prompts.filter((text) => text.startsWith("The checks on pull request"));

  it("pending then green: exactly one wake, and no model turn while the checks run", async () => {
    const { crewmate, forge, taskId, tasks, said, sorts, ops, at } = await waiting();
    // The reading tells the crewmate to wait for the wake, and the watch stands.
    expect(said).toContain("facts: ");
    expect(said).not.toContain("crew verdict:");
    expect(said).toContain("The app is watching these checks and will wake you once");
    expect(tasks.get(taskId)?.delivery?.ciWatch).toMatchObject({ head: forge.headSha, tries: 0 });
    // Its report waits on the watch: nobody's turn to act, so it wakes nobody.
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
    const prompts = crewmate.promptCalls.length;

    // Forty minutes of running checks: the host reads them, the crewmate
    // takes no turn - no nudge, no steer, no stall wake.
    for (let minute = 1; minute <= 40; minute++) await at(minutes(minute));
    expect(crewmate.promptCalls).toHaveLength(prompts);
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(forge.checkReads).toBeGreaterThan(2);
    expect(ops).toEqual([]);
    expect(tasks.timeline(taskId).filter((event) => event.kind === "steered")).toEqual([]);

    forge.states = ["success", "success"];
    await at(minutes(45));
    const wokenAt = hostNow;
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "checks-settled",
          outcome: "finished",
          change: "pull request #7 https://github.com/o/r/pull/7",
          head: forge.headSha,
          checks: [
            { name: "linux-checks", state: "success" },
            { name: "lint", state: "success" },
          ],
        },
      }),
    );
    expect(tasks.get(taskId)?.delivery).toMatchObject({ ci: "green", headSha: forge.headSha });
    expect(tasks.get(taskId)?.delivery?.ciWatch).toBeUndefined();
    expect(
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "steered")
        .map((event) => event.actor),
    ).toEqual(["supervisor"]);

    // Its turn ends - the task's own, a fresh idle episode - and the watch
    // is over. Quiet refresh continues, but never sends another wake.
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(tasks.get(taskId)?.idleSince).toBeGreaterThanOrEqual(wokenAt);
    const reads = forge.checkReads;
    for (let minute = 46; minute <= 55; minute++) await at(minutes(minute));
    expect(forge.checkReads).toBe(reads + 2);
    expect(watchWakes(crewmate.promptCalls)).toHaveLength(1);
  });

  it("saves every running check reading's time even when its result and head are unchanged", async () => {
    // PR #1229's shape: three checks on one head, all running at check_change.
    const forge = new ChecksForge();
    forge.states = ["pending", "pending", "pending"];
    const { crewmate, taskId, tasks, supervisor, at, start } = await waiting(forge);
    const prompts = crewmate.promptCalls.length;
    const log: string[] = [];
    const readingTimes: { saved: number | undefined; read: number }[] = [];
    let previousReads = forge.checkReads;
    const rel = (ms: number | undefined) =>
      ms === undefined ? "-" : `t+${Math.round((ms - start) / 60_000)}m`;
    const snap = (minute: number) => {
      const record = tasks.get(taskId) as TaskRecord;
      const d = record.delivery;
      const fact = ciFactOf(d, hostNow);
      if (forge.checkReads > previousReads) {
        readingTimes.push({ saved: d?.ciAt, read: hostNow });
        previousReads = forge.checkReads;
      }
      log.push(
        `t+${minute}m reads=${forge.checkReads} github=[${forge.states.join(",")}] ci=${d?.ci} ciAt=${rel(d?.ciAt)} age=${fact?.ageMinutes}m watch=${d?.ciWatch ? `since ${rel(d.ciWatch.since)} next ${rel(d.ciWatch.nextAt)}` : "none"} posture=${supervisor.postures.workPosture(record).reason} wakes=${crewmate.promptCalls.length - prompts}`,
      );
    };
    for (let minute = 1; minute <= 10; minute++) {
      await at(minutes(minute));
      snap(minute);
    }
    // Two Linux journey jobs fail; the full Mac lane keeps running.
    forge.states = ["failure", "failure", "pending"];
    for (let minute = 11; minute <= 56; minute++) {
      await at(minutes(minute));
      snap(minute);
    }
    const readsAtRed = Number(/reads=(\d+)/.exec(log[10] ?? "")?.[1]);
    console.log(log.join("\n"));
    console.log(
      "ci events:",
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "ci")
        .map((event) => `${rel(event.at)} ${event.text}`),
    );
    const record = tasks.get(taskId) as TaskRecord;
    console.log("crew_status ci fact:", ciFactOf(record.delivery, hostNow));
    // The first failed check woke the crewmate once while one check still runs.
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toContain("linux-checks (failure)");
    expect(crewmate.promptCalls.at(-1)).toContain("lint (failure)");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    // Established: the host kept reading GitHub after the red...
    expect(forge.checkReads).toBeGreaterThan(readsAtRed + 5);
    // ...the watch still stands, so the tile says "Waiting for checks".
    expect(supervisor.postures.workPosture(record).reason).toBe("checks");
    // The failing check: the recorded reading time should follow the last read.
    expect(ciFactOf(record.delivery, hostNow)?.ageMinutes).toBeLessThanOrEqual(5);
    // Both unchanged pending and unchanged red reads use the host's reading clock.
    expect(readingTimes.length).toBeGreaterThan(10);
    for (const { saved, read } of readingTimes) expect(saved).toBe(read);
    expect(ciFactOf(record.delivery, hostNow)?.readAt).toBe(
      new Date(record.delivery?.ciAt as number).toISOString(),
    );
    expect(record.delivery?.ciRounds ?? 0).toBe(0);
  });

  it("forwards changed check facts and refreshes the card strip independently of the crew judgment (captain F1)", async () => {
    const { crewmate, forge, taskId, tasks, specs, at, supervisor } = await waiting();
    forge.states = ["success", "success"];
    await at(minutes(5));
    await specs[0]?.onCheckChange?.();
    await specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ship it is ready",
      body: completionBody("<p>The checks passed.</p>"),
      actions: [{ id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE }],
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const checks = () =>
      supervisor.cards
        .snapshot()
        .find((c) => c.title === "Ship it is ready")
        ?.body.match(/data-fact="checks"[\s\S]*?<\/span><\/span>/)?.[0];
    expect(checks()).toContain("passed");
    const prompts = crewmate.promptCalls.length;
    forge.states = ["success", "failure"];
    await at(minutes(10));
    expect(tasks.get(taskId)?.delivery).toMatchObject({ ci: "red" });
    expect(checks()).toContain("failed");
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toContain(CHECK_OBSERVATIONS_LEAD);
    await specs[0]?.onCheckChange?.();
    expect(tasks.get(taskId)?.delivery?.ci).toBe("red");
    expect(checks()).toContain("failed");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    forge.headSha = "beef0002cafef00d";
    forge.states = ["pending", "pending"];
    await at(minutes(15));
    expect(tasks.get(taskId)?.delivery?.ci).toBe("pending");
    expect(checks()).toContain("running");
    await specs[0]?.onCheckChange?.({});
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    forge.states = ["success", "success"];
    await at(minutes(16));
    expect(tasks.get(taskId)?.delivery).toMatchObject({ ci: "green" });
    expect(checks()).toContain("passed");
    await specs[0]?.onCheckChange?.();
    expect(tasks.get(taskId)?.delivery?.ci).toBe("green");
    expect(checks()).toContain("passed");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
  });

  it("neither reads nor records the checks of a task idle behind another task until that work closes (INF-721 friction 6)", async () => {
    // The captain's words: "Record a check poll only when its state
    // changes, and not for an idle task". INF-595's shape: its pull
    // request's checks failed, and it waited all day behind INF-621.
    const { crewmate, forge, taskId, tasks, supervisor, at } = await waiting();
    forge.states = ["success", "failure"];
    await at(minutes(1));
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const owner = seedTask(tasks, {
      id: "vm-proof",
      title: "Prove every project's Mac jobs in a virtual Mac",
      status: "running",
    });
    tasks.graph.link(owner.id, taskId, "blocks", "firstmate");
    const record = () => tasks.get(taskId) as TaskRecord;
    expect(supervisor.postures.workPosture(record())).toEqual({
      state: "idle",
      reason: "dependency",
    });
    const ciRows = () => tasks.timeline(taskId).filter((event) => event.kind === "ci").length;
    const reads = forge.checkReads;
    const rows = ciRows();
    // A day on the shared tick, every five minutes.
    for (let minute = 5; minute <= 24 * 60; minute += 5) await at(minutes(minute));
    expect(forge.checkReads).toBe(reads);
    expect(ciRows()).toBe(rows);
    // That work closes: the ready sweep resumes the crewmate, and the
    // refresh reads its checks again on the next tick.
    tasks.close(owner.id, { status: "done", reason: "merged", actor: "captain" });
    await at(minutes(24 * 60 + 1));
    await at(minutes(24 * 60 + 2));
    expect(supervisor.postures.workPosture(record()).reason).not.toBe("dependency");
    expect(forge.checkReads).toBeGreaterThan(reads);
  });

  it("pending then red: one diagnosis wake naming the failing check, no repair spent", async () => {
    const { crewmate, forge, taskId, tasks, at } = await waiting();
    const prompts = crewmate.promptCalls.length;
    for (let minute = 1; minute <= 5; minute++) await at(minutes(minute));
    expect(crewmate.promptCalls).toHaveLength(prompts);

    forge.states = ["success", "failure"];
    for (let minute = 6; minute <= 20; minute++) await at(minutes(minute));
    expect(watchWakes(crewmate.promptCalls)).toEqual([
      renderWake({
        facts: {
          kind: "checks-settled",
          outcome: "finished",
          change: "pull request #7 https://github.com/o/r/pull/7",
          head: forge.headSha,
          checks: [
            { name: "linux-checks", state: "success" },
            { name: "lint", state: "failure" },
          ],
        },
      }),
    ]);
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(tasks.get(taskId)?.delivery).toMatchObject({
      ci: "red",
      ciRepair: { failures: [{ headSha: forge.headSha, checks: ["lint"] }] },
    });
    expect(tasks.get(taskId)?.delivery?.ciWatch).toBeUndefined();
  });

  it("a new push re-arms the watch for the new head, and only the new head is woken about", async () => {
    const { crewmate, forge, taskId, tasks, at } = await waiting();
    await at(minutes(1));
    forge.headSha = "beadbeef00000002";
    await at(minutes(3));
    expect(tasks.get(taskId)?.delivery?.ciWatch).toMatchObject({ head: "beadbeef00000002" });
    forge.states = ["success", "success"];
    for (let minute = 4; minute <= 10; minute++) await at(minutes(minute));
    expect(watchWakes(crewmate.promptCalls)).toEqual([
      expect.stringContaining("finished at beadbee"),
    ]);
  });

  it("a host without checks is never watched, and the crewmate is told no wake will come", async () => {
    const forge = new ChecksForge("git");
    const { crewmate, taskId, tasks, said, sorts, at } = await waiting(forge);
    expect(said).toContain("facts: ");
    expect(said).not.toContain("crew verdict:");
    expect(said).toContain(
      "git.example.com runs no checks the app can watch, so no wake will come: the local gate you ran is the evidence.",
    );
    expect(tasks.get(taskId)?.delivery?.ciWatch).toBeUndefined();
    // Nothing waits on the host: the report is nobody's turn, as it always was.
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "stopped" });
    for (let minute = 1; minute <= 9; minute++) await at(minutes(minute));
    expect(forge.checkReads).toBe(1);
    expect(watchWakes(crewmate.promptCalls)).toEqual([]);
  });

  it("a restart mid-watch still wakes once, and a wake already sent is never sent again", async () => {
    const first = await waiting();
    const { forge, taskId, db, paths, workspace, start } = first;
    await first.at(minutes(1));
    await first.at(minutes(2));
    const watch = first.tasks.get(taskId)?.delivery?.ciWatch;
    expect(watch).toMatchObject({ head: forge.headSha, since: start });
    first.supervisor.disposeAll();

    /** The app starting again over the same record: a new supervisor, a new crewmate session. */
    const boot = () => {
      const crewmate = fakeCrewmate();
      const tasks = new TaskService({ db, strict: true, now: hostClock });
      const repos = new RepoRegistry(db, paths.fleetDir);
      const delivery = createChangeDelivery({
        tasks,
        repos,
        forgeFor: () => forge,
        now: hostClock,
      });
      const supervisor = reboot({ paths, db, workspace }, async () => crewmate, {
        now: hostClock,
        repos,
        tasks,
        openChange: (id, input) => delivery.publication.open(id, input),
        checkChange: (id) => delivery.checkTool.checkForCrew(id),
        readCheckWatch: (id) => delivery.checks.readWatched(id),
      });
      supervisor.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
      return { crewmate, tasks, supervisor };
    };
    const second = boot();
    expect(second.tasks.get(taskId)?.delivery?.ciWatch).toEqual(watch);

    forge.states = ["success", "success"];
    for (let minute = 3; minute <= 12; minute++) {
      hostNow = start + minutes(minute);
      await second.supervisor.watch.pollCheckWatches(hostNow);
      await tick();
    }
    // The resumed crewmate hears it once.
    expect(watchWakes(second.crewmate.promptCalls)).toEqual([
      expect.stringContaining("finished at cafe000"),
    ]);
    expect(second.tasks.get(taskId)?.delivery?.ciWatch).toBeUndefined();
    second.supervisor.disposeAll();

    // The app stopped after the wake but before the watch cleared: the
    // record still holds the watch. Its wake is not sent again.
    seedDelivery(second.tasks, taskId, { ciWatch: watch });
    const third = boot();
    for (let minute = 13; minute <= 20; minute++) {
      hostNow = start + minutes(minute);
      await third.supervisor.watch.pollCheckWatches(hostNow);
      await tick();
    }
    expect(third.crewmate.promptCalls).toEqual([]);
    expect(third.tasks.get(taskId)?.delivery?.ciWatch).toBeUndefined();
    third.supervisor.disposeAll();
  });
});
