import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangePresentation } from "@shared/changePresentation";
import type { MergeReview } from "@shared/mergeReview";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  AttachmentUploadError,
  type Forge,
  type ForgeChange,
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  type ForgeReadiness,
  ForgeWriteError,
  GITLAB_PRIVATE_MEDIA_REFUSAL,
  overallOfChecks,
  presentationCommitMessage,
  presentationContentHash,
  presentationMarkdown,
} from "../forge";
import { stageChangePresentation } from "../pi/changePresentation";
import type { MergeAuthorization } from "../storage/taskStore";
import { seedTask, type TaskSeed } from "../tasks/seedTask";
import { taskFeedLine } from "../tasks/taskFeed";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { readChangeReading } from "../workspace/workspaceService";
import { ChangePresentations } from "./changePresentations";
import { type MergeGuard, PrCiService } from "./prCi";
import { reviewCoversHead } from "./reviewCarry";

// Integration budget (docs/test-cohorts.md): real git plus the product's
// own put-in backoff, the slowest test 1.3 s at its fastest measured run.
vi.setConfig({ testTimeout: 10_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * check_pr_ci's host behavior (contract v1): the standing CI rule in code,
 * fail-soft text on every edge, and the timestamped record the host's
 * settle-facts strip renders (contract v2.0) - read through the forge seam
 * (git integration PR 1.1), so a fake forge stands where the project lives.
 * GitHub over its REST API is `githubForge.test.ts`; a plain
 * Git host against real repositories is `plainGit.test.ts`.
 */

/** A forge whose change, checks and failures the test moves between calls. */
class FakeForge implements Forge {
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
  /** Fail `changeFor` only this many more times. */
  failChangeForTimes = 0;
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
  async openChange(input: { branch: string; title: string; body: string }): Promise<ForgeChange> {
    this.calls.push(`openChange ${input.branch} ${input.title}`);
    if (this.fail.openChange) throw this.fail.openChange;
    this.change = { ...this.opened, branch: input.branch };
    return this.change;
  }
  /** GitHub's and GitLab's conditional write: refused unless the change is as just read. */
  async updateChangeBody(change: ForgeChange, body: string): Promise<void> {
    this.calls.push(`updateChangeBody ${this.label(change)}`);
    if (this.fail.updateChangeBody) throw this.fail.updateChangeBody;
    if (
      !this.change ||
      this.change.headSha !== change.headSha ||
      (this.change.body ?? "") !== (change.body ?? "")
    )
      throw new ForgeWriteError("failed", "refused", "The pull request changed after it was read.");
    this.change = { ...this.change, body: this.heldAfterWrite ?? body };
  }
  async changeFor(branch: string) {
    this.calls.push(`changeFor ${branch}`);
    if (this.failChangeForTimes > 0) {
      this.failChangeForTimes -= 1;
      throw this.fail.changeFor ?? new Error("changeFor failed");
    }
    return this.change ? { ...this.change, branch } : null;
  }
  async checks(change: ForgeChange) {
    this.calls.push(`checks ${change.headSha}`);
    if (this.fail.checks) throw this.fail.checks;
    const items = this.states.map((state, index) => ({
      name: this.names?.[index] ?? (index === 0 ? "linux-checks" : `check-${index}`),
      state,
    }));
    return { overall: overallOfChecks(items), items };
  }
  async putIn(change: ForgeChange, headSha: string) {
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

function setup(
  options: {
    forge?: FakeForge;
    now?: () => number;
    onCap?: (taskId: string, facts: { rounds: number; headSha: string }) => void;
    onNote?: (text: string) => void;
    /** Check commit names against real git rather than skipping the check. */
    realRange?: boolean;
    bringBranchHome?: (taskId: string) => Promise<string | undefined>;
  } = {},
) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const paths = scratchDir("infinitary-prci-");
  const repos = new RepoRegistry(db, join(paths, "fleet"));
  const forge = options.forge ?? new FakeForge();
  const readHead = vi.fn(async () => forge.change?.headSha ?? "");
  const presentations = new ChangePresentations({ tasks, mediaDir: () => paths, head: readHead });
  const service = new PrCiService({
    tasks,
    repos,
    forgeFor: () => forge,
    presentations,
    ...(options.bringBranchHome ? { bringBranchHome: options.bringBranchHome } : {}),
    ...(options.realRange ? {} : { validateRange: async () => {} }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onCap ? { onCap: options.onCap } : {}),
    ...(options.onNote ? { onNote: options.onNote } : {}),
  });
  return { db, tasks, repos, service, forge, paths, presentations, readHead };
}

function insertTask(tasks: TaskService, overrides: Partial<TaskSeed> = {}): void {
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

async function insertDirectPrTask(
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
function recordPr(tasks: TaskService, number: number, id = "ab12cd34"): void {
  tasks.recordDelivery(id, { prNumber: number, prUrl: `https://github.com/x/y/pull/${number}` });
}

describe("PrCiService", () => {
  it("holds a missing saved story at the merge boundary even when every check passes (INF-92)", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    recordPr(tasks, 23);
    tasks.updateChangePresentation("ab12cd34", () => ({ revisions: [], receipts: [] }));
    expect(await service.checkForCrew("ab12cd34")).toContain("overall: green");
    const result = await service.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("story has not been published");
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toEqual([]);
  });

  it("reads a change with no checks as green, says so, and lets the put-in through", async () => {
    // A repo whose check suite is deliberately absent (or skipped for the
    // branch) must still be landable: the recorded reading is green, the
    // text names the absence, and the put-in proceeds on that reading.
    const forge = new FakeForge();
    forge.states = [];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const result = await service.checkForCrew("ab12cd34");
    expect(result).toContain("overall: green");
    expect(result).toContain("- no checks reported on the head SHA");
    expect(service.reading("ab12cd34")?.overall).toBe("green");
    expect(tasks.get("ab12cd34")?.delivery?.ci).toBe("green");

    const merged = await service.merge("ab12cd34");
    expect(merged.ok).toBe(true);
    expect(forge.calls).toContain("putIn fm/task-ab12cd34 feedbeef");
  });

  it("reports every check on the change head and records the overall", async () => {
    const forge = new FakeForge();
    forge.change = { ...(forge.change as ForgeChange), headSha: "abc123def456" };
    forge.states = ["success", "pending"];
    forge.names = ["checks", "package-smoke"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const result = await service.checkForCrew("ab12cd34");
    expect(result).toContain("pull request #23 https://github.com/x/y/pull/23 head abc123def456");
    expect(result).toContain("overall: pending");
    expect(result).toContain("- checks: completed / success");
    expect(result).toContain("- package-smoke: in_progress / -");
    expect(forge.calls[0]).toBe("changeFor fm/task-ab12cd34");
    expect(service.reading("ab12cd34")?.overall).toBe("pending");
  });

  it("records the green reading with the time it was taken, and the change by the forge's label", async () => {
    const now = 1_000_000;
    const { tasks, repos, service } = setup({ now: () => now });
    await insertDirectPrTask(tasks, repos);
    await service.checkOverall("ab12cd34");
    // The settle-facts strip renders this reading and its age (contract
    // v2.0); nothing expires it, because a put-in click re-checks the head.
    expect(service.reading("ab12cd34")).toEqual({ overall: "green", at: now });
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      prUrl: "https://github.com/x/y/pull/23",
      prNumber: 23,
      changeLabel: "#23",
      ci: "green",
      ciAt: now,
    });
  });

  describe("checkOverall", () => {
    it("resolves the fresh verdict alone, for the crewmate completion-card CI gate", async () => {
      const { tasks, repos, service } = setup();
      await insertDirectPrTask(tasks, repos);
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("green");
      expect(tasks.get("ab12cd34")?.delivery?.ci).toBe("green");
    });

    it("resolves pending or red exactly as check would report them", async () => {
      const forge = new FakeForge();
      forge.states = ["failure"];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("red");
    });

    it("falls back to pending, never green, on a forge failure that never recorded a reading", async () => {
      const forge = new FakeForge();
      forge.failChangeForTimes = 1;
      forge.fail.changeFor = new ForgeError("refused", "the host said no");
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      expect(service.reading("ab12cd34")).toBeUndefined();
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("pending");
    });

    it("answers pending, never an earlier green, when this call could not read the checks", async () => {
      const forge = new FakeForge();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("green");

      forge.fail.checks = new ForgeError("refused", "spawn gh ENOENT");
      // The earlier green stays on the record with its time (it is what was
      // last read), but it says nothing about the head the card is about now.
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("pending");
      expect(service.reading("ab12cd34")?.overall).toBe("green");
    });

    it("answers pending on an early return too, whatever an earlier reading said", async () => {
      const forge = new FakeForge();
      forge.states = [];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos, {
        worktreeDir: join(tmpdir(), "infinitary-gone-worktree"),
      });
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("green");
      const repoDir = tasks.get("ab12cd34")?.repoDir as string;
      // The repository folder goes away: check returns before any reading.
      rmSync(repoDir, { recursive: true, force: true });
      await expect(service.checkOverall("ab12cd34")).resolves.toBe("pending");
    });
  });

  it("fails soft on every edge: unknown task, queued row, no change, forge failure", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    expect(await service.checkForCrew("nope")).toContain('Unknown task "nope"');
    insertTask(tasks, { id: "queued99", branch: "", status: "queued" });
    expect(await service.checkForCrew("queued99")).toContain("no branch yet");
    await insertDirectPrTask(tasks, repos);
    const noPr = await service.checkForCrew("ab12cd34");
    expect(noPr).toBe("overall: no-pr\nNo open PR found for branch fm/task-ab12cd34.");
    expect(service.reading("ab12cd34")?.overall).toBe("no-pr");

    const failing = setup();
    failing.forge.failChangeForTimes = 1;
    failing.forge.fail.changeFor = new Error("gh: command not found");
    await insertDirectPrTask(failing.tasks, failing.repos);
    expect(await failing.service.checkForCrew("ab12cd34")).toContain("Could not check CI");
  });

  it("rechecks all the checks and puts the change in at the checked head", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);

    await expect(service.merge("ab12cd34")).resolves.toEqual({
      ok: true,
      text: "Merged #23 on GitHub. https://github.com/x/y/pull/23",
    });
    expect(forge.calls).toEqual([
      "changeFor fm/task-ab12cd34",
      "checks feedbeef",
      "putIn fm/task-ab12cd34 feedbeef",
    ]);
  });

  it("blocks the put-in when any head check is not successful", async () => {
    const forge = new FakeForge();
    forge.states = ["success", "pending"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);

    const result = await service.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("the checks have not all passed");
    // The feed's reason is the app's own words; the check names stay in the text.
    expect(result.plain).toBe("the checks have not all passed yet");
    expect(result.problem).toBeUndefined();
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("refuses a merge on failed checks even when the recorded reading the Firstmate read says green", async () => {
    const forge = new FakeForge();
    forge.states = ["success"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    await service.checkOverall("ab12cd34");
    expect(service.reading("ab12cd34")?.overall).toBe("green");

    // The checks turn red on GitHub after the reading was recorded.
    forge.states = ["failure"];
    const result = await service.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.notGreen).toBe(true);
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("retries the put-in once after a transient host/network failure, then succeeds", async () => {
    const forge = new FakeForge();
    forge.failChangeForTimes = 1;
    forge.fail.changeFor = new ForgeError(
      "transient",
      "ETIMEDOUT: could not connect to api.github.com",
    );
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);

    const result = await service.merge("ab12cd34");
    expect(result).toEqual({
      ok: true,
      text: "Merged #23 on GitHub. https://github.com/x/y/pull/23",
    });
    expect(forge.calls.filter((call) => call.startsWith("changeFor"))).toHaveLength(2);
  });

  it("retries a put-in the host failed transiently, and never one it refused", async () => {
    const flaky = setup();
    flaky.forge.fail.putIn = new ForgeError("transient", "GitHub answered 502");
    await insertDirectPrTask(flaky.tasks, flaky.repos);
    const retried = await flaky.service.merge("ab12cd34");
    expect(retried).toMatchObject({ ok: false, problem: "GitHub answered 502" });
    expect(flaky.forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(3);

    const refused = setup();
    refused.forge.fail.putIn = new ForgeError("refused", "Head branch was modified");
    await insertDirectPrTask(refused.tasks, refused.repos);
    const once = await refused.service.merge("ab12cd34");
    expect(once).toMatchObject({
      ok: false,
      text: "Cannot merge: Head branch was modified",
      problem: "Head branch was modified",
    });
    expect(refused.forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
  });

  it("refuses a put-in whose re-check could not read the checks, carrying the raw failure", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    await service.checkOverall("ab12cd34");
    forge.fail.checks = new ForgeError("refused", "spawn gh ENOENT");

    const result = await service.merge("ab12cd34");
    expect(result).toMatchObject({ ok: false, problem: "spawn gh ENOENT" });
    expect(result.text).toContain("the checks could not be read");
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("refuses to pretend local-only work has CI", async () => {
    const { tasks, repos, service, forge } = setup();
    // init has no remote, so the defaulted posture is local-only.
    const { repo } = await repos.setup({ kind: "init", name: "local-notes" });
    insertTask(tasks, { repoId: repo.id, repoDir: repo.path });
    expect(await service.checkForCrew("ab12cd34")).toContain("local-only");
    expect(forge.calls).toEqual([]);
  });

  it("checks CI for a task whose ask is direct-pr even when the repo is local-only", async () => {
    const forge = new FakeForge();
    forge.states = [];
    const { tasks, repos, service } = setup({ forge });
    const { repo } = await repos.setup({ kind: "init", name: "local-notes" });
    insertTask(tasks, {
      repoId: repo.id,
      repoDir: repo.path,
      shape: { kind: "fix", kind_source: "none", delivery_ask: "direct-pr" },
    });
    const result = await service.checkForCrew("ab12cd34");
    expect(result).toContain("overall: green");
    expect(forge.calls).not.toEqual([]);
  });

  it("does not check CI when the task asked to stay local on a direct-pr repo", async () => {
    const { tasks, repos, service, forge } = setup();
    const { repo } = await repos.setup({ kind: "init", name: "notes" });
    repos.configure(repo.id, { delivery: "direct-pr" });
    insertTask(tasks, {
      repoId: repo.id,
      repoDir: repo.path,
      shape: { kind: "fix", kind_source: "none", delivery_ask: "local-only" },
    });
    const text = await service.checkForCrew("ab12cd34");
    expect(text).toContain("Task ab12cd34 ships local-only");
    expect(text).not.toContain("Repository");
    expect(forge.calls).toEqual([]);
  });

  describe("on a plain Git host, where the change is the working copy sent up", () => {
    function plainHost() {
      const forge = new FakeForge({ kind: "git", place: "git.example.com" });
      forge.change = { branch: "fm/task-ab12cd34", headSha: "5e0b", url: null };
      forge.states = [];
      return forge;
    }

    it("names the change by its branch, records it with no number or link, and says where it went in", async () => {
      const forge = plainHost();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const text = await service.checkForCrew("ab12cd34");
      expect(text).toContain("the pushed branch fm/task-ab12cd34 head 5e0b");
      expect(text).toContain("overall: green");
      const delivery = tasks.get("ab12cd34")?.delivery;
      expect(delivery).toMatchObject({ changeLabel: "fm/task-ab12cd34", ci: "green" });
      expect(delivery?.prNumber).toBeUndefined();
      expect(delivery?.prUrl).toBeUndefined();
      const opened = tasks.timeline("ab12cd34").find((event) => event.kind === "pr_opened");
      expect(opened?.text).toBe("Pushed the branch fm/task-ab12cd34 to git.example.com");

      await expect(service.merge("ab12cd34")).resolves.toEqual({
        ok: true,
        text: 'Merged "Ship it" on git.example.com.',
      });
    });

    it("says nothing was sent up yet, and takes the sent-up copy back on discard", async () => {
      const forge = plainHost();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const sent = forge.change;
      forge.change = null;
      expect(await service.checkForCrew("ab12cd34")).toBe(
        "overall: no-pr\nNothing pushed for branch fm/task-ab12cd34 on git.example.com yet.",
      );

      forge.change = sent;
      await service.checkOverall("ab12cd34");
      await expect(service.close("ab12cd34")).resolves.toEqual({
        ok: true,
        text: "Deleted the pushed branch on git.example.com.",
      });
      expect(forge.calls.at(-1)).toBe("close fm/task-ab12cd34");
    });
  });

  describe("close", () => {
    it("closes the task's open change without putting it in", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      recordPr(tasks, 23);

      await expect(service.close("ab12cd34")).resolves.toEqual({
        ok: true,
        text: "Closed PR #23 on GitHub. https://github.com/x/y/pull/23",
      });
      expect(forge.calls.at(-1)).toBe("close fm/task-ab12cd34");
      expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    });

    it("is a silent no-op when there is no open change, no branch, or the work is local-only", async () => {
      const forge = new FakeForge();
      forge.change = null;
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      recordPr(tasks, 4);
      await expect(service.close("ab12cd34")).resolves.toEqual({ ok: true, text: "" });
      const callsForOpenTask = forge.calls.length;

      insertTask(tasks, { id: "queued99", branch: "", status: "queued" });
      await expect(service.close("queued99")).resolves.toEqual({ ok: true, text: "" });
      // A branchless (still-queued) task never asks the host at all.
      expect(forge.calls.length).toBe(callsForOpenTask);

      const { repo } = await repos.setup({ kind: "init", name: "local-notes" });
      insertTask(tasks, { id: "local1", repoId: repo.id, repoDir: repo.path });
      await expect(service.close("local1")).resolves.toEqual({ ok: true, text: "" });
      expect(forge.calls.length).toBe(callsForOpenTask);
    });

    it("asks nothing for a task that never opened a change, even with a branch", async () => {
      const forge = new FakeForge();
      forge.fail.changeFor = new Error("spawn gh ENOENT");
      forge.failChangeForTimes = 99;
      const { tasks, repos, service } = setup({ forge });
      // A read-only task: it has a branch and a direct-pr repository, and
      // by its brief opened nothing.
      await insertDirectPrTask(tasks, repos, {
        shape: {
          kind: "research",
          kind_source: "classifier:test",
          deliverable: "answer",
        } as TaskSeed["shape"],
      });
      await expect(service.close("ab12cd34")).resolves.toEqual({ ok: true, text: "" });
      expect(forge.calls).toEqual([]);
    });

    it("reports a forge failure instead of throwing", async () => {
      const forge = new FakeForge();
      forge.fail.close = new ForgeError("permission", "gh: permission denied");
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      recordPr(tasks, 5);
      const result = await service.close("ab12cd34");
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Could not close PR");
      expect(result.text).toContain("permission denied");
      // The raw failure rides beside the text, for the feed to say plainly.
      expect(result.problem).toBe("gh: permission denied");
    });
  });
});

describe("the CI round counter (delivery rigor phase 3)", () => {
  /** A forge whose change head and check state the test moves between calls. */
  function movingForge() {
    const forge = new FakeForge();
    const state = {
      set head(sha: string) {
        forge.change = {
          number: 9,
          url: "https://github.com/o/r/pull/9",
          branch: "fm/task-ab12cd34",
          headSha: sha,
        };
      },
      set checks(value: ForgeCheckState) {
        forge.states = [value];
      },
    };
    state.head = "aaaaaaa";
    return { state, forge };
  }

  it("two evidenced baseline failures then a flake never spend repairs or wake the captain", async () => {
    const { state, forge } = movingForge();
    const onCap = vi.fn();
    const { db, tasks, repos, service } = setup({ forge, onCap });
    await insertDirectPrTask(tasks, repos);
    const owner = tasks.create({
      id: "baseline-owner",
      title: "Fix baseline",
      prompt: "Fix baseline",
      repoId: tasks.get("ab12cd34")?.repoId ?? null,
    });
    for (const head of ["baseline1", "baseline2"]) {
      state.head = head;
      state.checks = "failure";
      expect(await service.checkForCrew("ab12cd34")).toContain(
        "Read the failed step and logs first",
      );
      expect(
        await service.checkForCrew("ab12cd34", {
          diagnosis: {
            headSha: head,
            check: "linux-checks",
            classification: "baseline-blocked",
            evidence: "Owner reproduced the same failing assertion on untouched main; log attached",
            dependencyTask: owner.id,
          },
        }),
      ).toContain("Diagnosis recorded");
      // An unrelated wait and a fresh service over the durable record change no allowance.
      tasks.setGate("ab12cd34", { kind: "at-time", until: 9000 });
      await service.checkOverall("ab12cd34");
      expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBeUndefined();
    }
    state.head = "flake";
    await service.readWatched("ab12cd34");
    await service.checkForCrew("ab12cd34", {
      diagnosis: {
        headSha: "flake",
        check: "linux-checks",
        classification: "suspected-flake",
        evidence: "Same-head verify job passed the same tests; standalone job timeout logs differ",
      },
    });
    const reserve = {
      rerun: {
        headSha: "flake",
        check: "linux-checks",
        evidence: "Same-version successful verification and timeout log",
      },
    };
    expect(await service.checkForCrew("ab12cd34", reserve)).toContain("Rerun authorized once");
    const reboot = new PrCiService({
      tasks: new TaskService({ db, strict: true }),
      repos,
      forgeFor: () => forge,
    });
    expect(await reboot.checkForCrew("ab12cd34", reserve)).toContain("Rerun refused");
    state.checks = "success";
    expect(await reboot.checkOverall("ab12cd34")).toBe("green");
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      ciRepair: {
        failures: [{ headSha: "baseline1" }, { headSha: "baseline2" }, { headSha: "flake" }],
      },
    });
    expect(onCap).not.toHaveBeenCalled();
    expect(tasks.get("ab12cd34")?.delivery?.ciCapAt).toBeUndefined();
  });

  // FI3-671: the answer to a declared wait says where the named task stands,
  // so the crewmate moves the wait or escalates it instead of sitting on it.
  it.each([
    {
      state: "planned on request",
      seed: { status: "queued", startPolicy: "on-request" },
      says: "Nobody has started",
      next: "Lead your report with its key",
    },
    {
      state: "held behind a gate",
      seed: { status: "queued", gate: { kind: "captain" } },
      says: "Nobody has started",
      next: "wakes the first mate",
    },
    {
      state: "queued to start when ready",
      seed: { status: "queued" },
      says: "is queued and starts by itself",
      next: "report the wait once and end your turn",
    },
    {
      state: "underway",
      seed: { status: "running" },
      says: "is underway",
      next: "report the wait once and end your turn",
    },
    {
      state: "done",
      seed: { status: "idle" },
      done: true,
      says: "is already done",
      next: "bring your change up to date",
    },
  ] as const)("a baseline wait on work $state is answered with that state", async (entry) => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    forge.states = ["failure"];
    await service.checkForCrew("ab12cd34");
    const owner = seedTask(tasks, {
      id: "baseline-owner",
      title: "Fix baseline",
      repoId: tasks.get("ab12cd34")?.repoId ?? null,
      ...entry.seed,
    } as TaskSeed);
    if ("done" in entry) tasks.close(owner.id, { status: "done", reason: "merged", actor: "host" });
    const answer = await service.checkForCrew("ab12cd34", {
      diagnosis: {
        headSha: "feedbeef",
        check: "linux-checks",
        classification: "baseline-blocked",
        evidence: "The same assertion fails on untouched main; log attached",
        dependencyTask: owner.id,
      },
    });
    expect(answer).toContain("Diagnosis recorded: baseline-blocked");
    expect(answer).toContain(`${owner.key} "Fix baseline"`);
    expect(answer).toContain(entry.says);
    expect(answer).toContain(entry.next);
  });

  it("counts three unsuccessful own repairs once across foreground/watch reads and restarts", async () => {
    const { state, forge } = movingForge();
    const onCap = vi.fn();
    const { db, tasks, repos, service } = setup({ forge, onCap, now: () => 5000 });
    await insertDirectPrTask(tasks, repos);
    state.checks = "failure";
    await service.checkForCrew("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBeUndefined();
    let current = service;
    let sourceHead = "aaaaaaa";
    for (let i = 1; i <= 3; i++) {
      await current.checkForCrew("ab12cd34", {
        diagnosis: {
          headSha: sourceHead,
          check: "linux-checks",
          classification: "own-regression",
          evidence: "Failed assertion reproduced only with my diff",
        },
      });
      const headSha = `repair${i}`;
      state.head = headSha;
      state.checks = "pending";
      const input = {
        repair: {
          id: `attempt${i}`,
          sourceHead,
          headSha,
          check: "linux-checks",
          evidence: "Corrected the assertion's broken code path",
        },
      };
      await current.checkForCrew("ab12cd34", input);
      expect(tasks.get("ab12cd34")?.delivery?.ciRounds ?? 0).toBe(i - 1);
      current = new PrCiService({
        tasks: new TaskService({ db, strict: true }),
        repos,
        forgeFor: () => forge,
        onCap,
        now: () => 5000,
      });
      state.checks = "failure";
      const read = await current.readWatched("ab12cd34");
      if (i === 3) expect(read).toMatchObject({ cap: { rounds: 3 } });
      await current.checkForCrew("ab12cd34");
      await current.checkOverall("ab12cd34");
      expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBe(i);
      sourceHead = headSha;
    }
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith("ab12cd34", { rounds: 3, headSha: "repair3" });
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({ ciRounds: 3, ciCapAt: 5000 });
    const capped = tasks.timeline("ab12cd34").filter((e) => e.kind === "ci" && e.feed);
    expect(capped).toHaveLength(1);
    expect(
      capped[0] && tasks.get("ab12cd34")
        ? taskFeedLine(
            tasks.get("ab12cd34") as NonNullable<ReturnType<typeof tasks.get>>,
            capped[0],
          )?.text
        : undefined,
    ).toContain("3 repairs did not get the checks to pass");
    // A historical head revisit and a passing result cannot erase the captain hold.
    state.head = "aaaaaaa";
    await current.checkOverall("ab12cd34");
    state.checks = "success";
    await current.checkOverall("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciCapAt).toBe(5000);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "skipped"] as const)(
    "refuses unsupported exemptions and accepts a %s repaired target without spending an attempt",
    async (accepted) => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.states = ["failure"];
      await service.checkForCrew("ab12cd34");
      const diagnosis = {
        headSha: "feedbeef",
        check: "linux-checks",
        evidence: "Failed step log",
        classification: "baseline-blocked" as const,
      };
      expect(await service.checkForCrew("ab12cd34", { diagnosis })).toContain("Diagnosis refused");
      expect(
        await service.checkForCrew("ab12cd34", {
          diagnosis: { ...diagnosis, classification: "unknown" },
        }),
      ).toContain("Investigate once");
      expect(
        await service.checkForCrew("ab12cd34", {
          diagnosis: { ...diagnosis, classification: "unknown" },
        }),
      ).toContain("Stop rereading");
      expect(
        await service.checkForCrew("ab12cd34", {
          rerun: { headSha: "feedbeef", check: "linux-checks", evidence: "Maybe flaky" },
        }),
      ).toContain("Rerun refused");
      const repair = {
        id: "one",
        headSha: "new",
        sourceHead: "feedbeef",
        check: "linux-checks",
        evidence: "Fixed code",
      };
      expect(await service.checkForCrew("ab12cd34", { repair })).toContain("Repair refused");
      await service.checkForCrew("ab12cd34", {
        diagnosis: { ...diagnosis, classification: "own-regression" },
      });
      forge.change = { ...(forge.change as ForgeChange), headSha: "new" };
      forge.states = [accepted, "failure"];
      await service.checkForCrew("ab12cd34", { repair });
      // The repaired check passed even though another check failed: no unsuccessful own repair.
      expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBeUndefined();
      expect(await service.checkOverall("ab12cd34")).toBe("red");
      expect(
        await service.checkForCrew("ab12cd34", { repair: { ...repair, id: "different" } }),
      ).toContain("Repair refused");
    },
  );

  it("archives unqualified legacy failed versions without charging new own repairs", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    tasks.recordDelivery("ab12cd34", { ciRounds: 2, ciRedHead: "legacy-head" });
    forge.states = ["failure"];
    await service.checkForCrew("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      ciRepair: { legacyFailedVersions: 2 },
    });
    expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBeUndefined();
    await service.checkForCrew("ab12cd34", {
      diagnosis: {
        headSha: "feedbeef",
        check: "linux-checks",
        classification: "own-regression",
        evidence: "Only my diff fails this assertion",
      },
    });
    forge.change = { ...(forge.change as ForgeChange), headSha: "first-own-repair" };
    await service.checkForCrew("ab12cd34", {
      repair: {
        id: "one",
        sourceHead: "feedbeef",
        headSha: "first-own-repair",
        check: "linux-checks",
        evidence: "Fixed the failed path",
      },
    });
    expect(tasks.get("ab12cd34")?.delivery?.ciRounds).toBe(1);
    expect(tasks.get("ab12cd34")?.delivery?.ciCapAt).toBeUndefined();
  });

  it.each(["pending", "failure", "neutral"] as const)(
    "%s never permits putting a repair in",
    async (state) => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.states = ["failure"];
      await service.checkForCrew("ab12cd34");
      await service.checkForCrew("ab12cd34", {
        diagnosis: {
          headSha: "feedbeef",
          check: "linux-checks",
          classification: "own-regression",
          evidence: "Failed-step assertion only reproduces on this diff",
        },
      });
      forge.change = { ...(forge.change as ForgeChange), headSha: "repair-head" };
      forge.states = [state, "success"];
      await service.checkForCrew("ab12cd34", {
        repair: {
          id: "one",
          sourceHead: "feedbeef",
          headSha: "repair-head",
          check: "linux-checks",
          evidence: "Corrected the path",
        },
      });
      expect(tasks.get("ab12cd34")?.delivery?.ciRounds ?? 0).toBe(state === "pending" ? 0 : 1);
      expect((await service.merge("ab12cd34")).ok).toBe(false);
      expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    },
  );

  it("does not open the change again for a task whose number was recorded before the label", async () => {
    // A record written before the forge seam carries `prNumber` alone.
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    recordPr(tasks, 23);
    await service.checkOverall("ab12cd34");
    expect(tasks.timeline("ab12cd34").filter((event) => event.kind === "pr_opened")).toEqual([]);
  });
});

describe("the commit-name check measures only the branch's own commits", () => {
  it("ignores merged commits a stale local main lacks, and merge commits that take in newer work", async () => {
    // FI3-755: the Mac's main sat behind the fetched origin/main, so commits
    // already merged where the project lives were judged as the branch's own.
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge, realRange: true });
    await insertDirectPrTask(tasks, repos);
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (file: string, subject: string) => {
      writeFileSync(join(dir, file), `${subject}\n`);
      run("add", file);
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    const stale = run("rev-parse", "main");
    commit("digest.ts", "ESP-5497: Migrate the Linear daily digest to Soapbox (#3097)");
    // A fetch moves origin/main; the local main stays where it was.
    run("update-ref", "refs/remotes/origin/main", "HEAD");
    run("reset", "--hard", stale);
    run("checkout", "-b", "fm/task-ab12cd34", "origin/main");
    commit("ask.ts", "feat: highlight and ask");

    expect(
      await service.open("ab12cd34", { title: "feat: highlight and ask", body: "b" }),
    ).toContain("Opened pull request #42");

    // Taking newer main in with a merge commit is not a commit to name.
    run("checkout", "--detach", "origin/main");
    run("update-ref", "refs/remotes/origin/main", commit("other.ts", "docs: newer main"));
    run("checkout", "fm/task-ab12cd34");
    run("merge", "--no-ff", "origin/main", "-m", "Merge branch 'main' into fm/task-ab12cd34");
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: run("rev-parse", "HEAD"),
    };
    await service.checkOverall("ab12cd34");
    const merged = await service.merge("ab12cd34");
    expect(merged).toMatchObject({ ok: true });

    // The branch's own badly named commit is still refused.
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: commit("wip.ts", "wip"),
    };
    await service.checkOverall("ab12cd34");
    const refused = await service.merge("ab12cd34");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('Received: "wip"');
  });
});

/**
 * The crewmate's pair where the project lives and the app's own sign-in
 * (git integration PR 1.2): open_change offers the branch as a proposed
 * change and records it; check_change reads the same checks check_pr_ci
 * does, in the crewmate's words; a missing sign-in is a typed fact every
 * caller turns into its own words, never a raw 401.
 */
describe("PrCiService and the sign-in where the project lives", () => {
  const notSignedIn = () => new ForgeError("sign-in", "Not signed in to GitHub (github.com)");

  it("refuses a renamed plain GitHub title at put-in after successful checks", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    forge.change = { ...(forge.change as ForgeChange), title: "Plain renamed title" };
    const result = await service.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("conventional name");
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("refuses a plain proposed title before opening it", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    expect(await service.open("ab12cd34", { title: "Fix it", body: "## Intent" })).toContain(
      "conventional name",
    );
    expect(forge.calls).not.toContain("openChange fm/task-ab12cd34 Fix it");
  });

  // INF-290 F4: an evidence upload refusal is answered in its own words; the branch is pushed.
  it.each([
    new AttachmentUploadError("failed", "refused", GITLAB_PRIVATE_MEDIA_REFUSAL),
    new AttachmentUploadError(
      "uncertain",
      "refused",
      "GitLab may have kept the attachment, but no confirmed receipt returned.",
    ),
  ])("answers an evidence upload that stopped with its own words: $outcome", async (error) => {
    const forge = new FakeForge({ kind: "gitlab", place: "GitLab" });
    forge.change = null;
    Object.assign(forge, {
      attachments: {
        destination: async () => {
          throw new Error("No destination read expected");
        },
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
    });
    const { tasks, repos, service, presentations } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    vi.spyOn(presentations, "publish").mockRejectedValue(error);
    const text = await service.open("ab12cd34", {
      title: "fix: carry the evidence",
      presentation: 1,
    });
    expect(text).toBe(error.message);
  });

  // INF-290 G1: an upload the host refused for permission still asks for write access as a blocker.
  it("keeps the write-access note and blocker words for an evidence upload refused for permission", async () => {
    const forge = new FakeForge({ kind: "gitlab", place: "GitLab" });
    forge.change = null;
    Object.assign(forge, {
      attachments: {
        destination: async () => {
          throw new Error("No destination read expected");
        },
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
    });
    const onNote = vi.fn();
    const { tasks, repos, service, presentations } = setup({ forge, onNote });
    await insertDirectPrTask(tasks, repos);
    const refused = new AttachmentUploadError(
      "failed",
      "permission",
      "GitLab refused the evidence upload (403). No merge request was opened; there is no fallback.",
    );
    vi.spyOn(presentations, "publish").mockRejectedValue(refused);
    const text = await service.open("ab12cd34", {
      title: "fix: carry the evidence",
      presentation: 1,
    });
    expect(text).toBe(
      `GitLab did not allow opening the change: ${refused.message}. Report this as a blocker: the captain needs write access to the project there.`,
    );
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(String(onNote.mock.calls[0]?.[0])).toContain("ask its owner for write access");
  });

  it("opens the branch as a proposed change and records it once", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const text = await service.open("ab12cd34", { title: "fix: correct it", body: "## Intent" });
    expect(text).toBe(
      "Opened pull request #42 https://github.com/x/y/pull/42 for fm/task-ab12cd34. Read its checks with check_change. If the rest of your work needs this merged first, file it as Continue: … and end this task with the completion decision after the checks pass.",
    );
    expect(forge.calls).toEqual([
      "changeFor fm/task-ab12cd34",
      "openChange fm/task-ab12cd34 fix: correct it",
    ]);
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      changeLabel: "#42",
      prNumber: 42,
      prUrl: "https://github.com/x/y/pull/42",
    });
    const events = tasks.timeline("ab12cd34").filter((event) => event.kind === "pr_opened");
    expect(events).toHaveLength(1);
  });

  it("answers a change already open for the branch rather than opening a second", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    const text = await service.open("ab12cd34", { title: "fix: correct it", body: "b" });
    expect(text).toContain("A pull request for fm/task-ab12cd34 is already open: pull request #23");
    expect(text).toContain("file it as Continue: …");
    expect(forge.calls).not.toContain("openChange fm/task-ab12cd34 fix: correct it");
  });

  /**
   * INF-291, from INF-87's PR #39: a corrected body passed to open_change on a
   * pull request opened before saved stories was answered "already open"
   * while GitHub kept the stale description. A body now replaces such a
   * description, and the answer says what the host shows when read back.
   */
  describe("a body on a pull request that is open without a saved story (INF-291)", () => {
    const STALE = "## Verified\nCurrent head: `46e20da`.";
    const CORRECTED = "## Verified\nCurrent head: `4c771ba`; approved pieces start Queued.";

    it("replaces the description, reads it back, and answers what GitHub shows", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const replaced = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(replaced).toContain(
        `Replaced its description: GitHub now shows the ${CORRECTED.length}-character body you passed, at version feedbee.`,
      );
      expect(replaced).toContain("Read its checks with check_change.");
      expect(forge.change?.body).toBe(CORRECTED);
      // One write, made only after reading the change, and read back before answering.
      expect(forge.calls).toEqual([
        "changeFor fm/task-ab12cd34",
        "updateChangeBody #23",
        "changeFor fm/task-ab12cd34",
      ]);

      // Asking again with the same words sends nothing more.
      const again = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(again).toContain("GitHub already shows this description; nothing was sent.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toHaveLength(1);
    });

    it("refuses to keep a story that is not there when around is passed (INF-497)", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const text = await service.open("ab12cd34", {
        title: "fix: ship it",
        around: { from: STALE, to: CORRECTED },
      });
      expect(text).toContain("does not carry a saved story");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
      expect(forge.change?.body).toBe(STALE);
    });

    it("leaves the description unchanged without a body, and says so", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      const text = await service.open("ab12cd34", { title: "fix: ship it" });
      expect(text).toContain("Its description is unchanged; pass body to replace it.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
      expect(forge.change?.body).toBe(STALE);
    });

    it("says the title stays, since open_change never renames one", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      const text = await service.open("ab12cd34", { title: "fix: a new name", body: CORRECTED });
      expect(text).toContain('Its title stays "fix: ship it".');
      expect(forge.change?.title).toBe("fix: ship it");
    });

    it("never claims words the host does not show after the write", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.change = { ...(forge.change as ForgeChange), body: STALE };
      forge.heldAfterWrite = `${CORRECTED}\n\nA person's words.`;
      const text = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(text).toContain("Sent the new description, but GitHub shows different words");
      expect(text).toContain("Read it with github_read before calling open_change again.");
      expect(text).not.toContain("Replaced its description");
    });

    it("says a refused replacement was not made, without sending the crewmate to push", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.fail.updateChangeBody = new ForgeWriteError(
        "failed",
        "refused",
        "The pull request changed after it was read, so its description was not replaced. Read it again before updating.",
      );
      const text = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(text).toContain(
        "Its description was not replaced: The pull request changed after it was read",
      );
      expect(text).not.toContain("Push your branch first");
    });

    it("says an uncertain write may or may not have replaced it, and is not resent", async () => {
      const { tasks, repos, service, forge } = setup();
      await insertDirectPrTask(tasks, repos);
      forge.fail.updateChangeBody = new ForgeWriteError(
        "uncertain",
        "transient",
        "GitHub answered 502 when replacing the description; read it back before any retry.",
      );
      const text = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(text).toContain(
        "Its description may or may not have been replaced: GitHub answered 502",
      );
      expect(text).toContain("Read it with github_read before calling open_change again.");
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toHaveLength(1);
    });

    it("says a plain Git host keeps no description for the pushed branch", async () => {
      const forge = new FakeForge({ kind: "git", place: "git.example.com" });
      forge.change = { url: null, branch: "fm/task-ab12cd34", headSha: "feedbeef" };
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const text = await service.open("ab12cd34", { title: "fix: ship it", body: CORRECTED });
      expect(text).toContain(
        "git.example.com keeps no description for a pushed branch, so body was not published.",
      );
      expect(forge.calls.filter((call) => call.startsWith("updateChangeBody"))).toEqual([]);
    });
  });

  it("tells the crewmate a missing sign-in is the captain's blocker, never its own", async () => {
    const forge = new FakeForge();
    forge.fail.changeFor = notSignedIn();
    forge.failChangeForTimes = 2;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    for (const text of [
      await service.open("ab12cd34", { title: "fix: correct title", body: "b" }),
      await service.checkForCrew("ab12cd34"),
    ]) {
      expect(text).toBe(
        "Not signed in to GitHub (github.com). Report this as a blocker: the captain signs in to GitHub in the app's Settings. Do not sign in yourself, and do not look for another way in.",
      );
    }
  });

  it("carries the sign-in fact on a refused put-in, for the settle's refusal", async () => {
    const forge = new FakeForge();
    forge.fail.putIn = new ForgeError(
      "sign-in",
      "GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
    );
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const outcome = await service.merge("ab12cd34");
    expect(outcome.ok).toBe(false);
    expect(outcome.signIn).toEqual({
      host: "github.com",
      name: "GitHub",
      repoId: tasks.get("ab12cd34")?.repoId,
    });
  });

  it("says in the feed that the host refused the change, and asks for write access", async () => {
    const forge = new FakeForge();
    forge.change = null;
    forge.fail.openChange = new ForgeError(
      "permission",
      "GitHub answered 403 to POST /repos/x/y/pulls",
    );
    const notes: string[] = [];
    const { tasks, repos, service } = setup({ forge, onNote: (text) => notes.push(text) });
    await insertDirectPrTask(tasks, repos);
    const text = await service.open("ab12cd34", { title: "fix: correct title", body: "b" });
    expect(text).toContain("Report this as a blocker");
    expect(notes).toEqual([
      "GitHub did not allow the change on pr-ab12cd34 - ask its owner for write access.",
    ]);
  });

  it("opens nothing for a task whose work goes straight into the project", async () => {
    const { tasks, repos, service, forge } = setup();
    const { repo } = await repos.setup({ kind: "init", name: "kept-here" });
    insertTask(tasks, { repoId: repo.id, repoDir: repo.path });
    const text = await service.open("ab12cd34", { title: "fix: correct title", body: "b" });
    expect(text).toContain("its work merges locally");
    expect(forge.calls).toEqual([]);
  });

  it("gives the crewmate the cap in its own words", async () => {
    const forge = new FakeForge();
    forge.states = ["failure"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    tasks.recordDelivery("ab12cd34", { ciRounds: 3, ciCapAt: 5000 });
    const text = await service.checkForCrew("ab12cd34");
    expect(text).toContain(
      "Three unsuccessful own repairs exhausted the allowance (3/3): stop and report the failing check and attempts.",
    );
    expect(text).not.toContain("your decision card");
  });
});

describe('the check watch\'s side of a reading (docs/forge.md, "The check watch")', () => {
  it("arms on checks still running, keeps its start on the same head, and restarts on a new one", async () => {
    let now = 1_000_000;
    const forge = new FakeForge();
    forge.states = ["success", "pending"];
    const { tasks, repos, service } = setup({ forge, now: () => now });
    await insertDirectPrTask(tasks, repos);
    const said = await service.checkForCrew("ab12cd34");
    expect(said).toContain(
      "The app is watching these checks and will wake you once when the first check fails, and once when they finish. End your turn now and wait for that message; do not call check_change again until it comes.",
    );
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch).toEqual({
      head: "feedbeef",
      since: 1_000_000,
      nextAt: 1_060_000,
      tries: 0,
    });
    // The host's own reading of the same head keeps the watch.
    now += 30_000;
    await service.checkOverall("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch?.since).toBe(1_000_000);
    forge.change = { ...(forge.change as ForgeChange), headSha: "feed0002" };
    await service.checkForCrew("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch).toMatchObject({
      head: "feed0002",
      since: 1_030_000,
    });
  });

  it("ends on the crewmate's own finished reading, and stands through the host's own", async () => {
    const forge = new FakeForge();
    forge.states = ["pending"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    await service.checkForCrew("ab12cd34");
    forge.states = ["success"];
    // The crewmate has not seen this one: it is still woken.
    await service.checkOverall("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch).toBeDefined();
    // The crewmate read it itself: nothing is left to tell it.
    await service.checkForCrew("ab12cd34");
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch).toBeUndefined();
  });

  it.each([{ states: ["success", "skipped"] }, { states: ["skipped"] }] as const)(
    "accepts finished skipped checks %j without watching or repair diagnosis",
    async ({ states }) => {
      const forge = new FakeForge();
      forge.states = [...states];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const said = await service.checkForCrew("ab12cd34");
      console.log(`[skipped checks] check_change:
${said}`);
      expect(said).toContain("overall: green");
      expect(said).not.toContain("Read the failed step");
      expect(said).not.toContain("watching");
      const delivery = tasks.get("ab12cd34")?.delivery;
      console.log(`[skipped checks] persisted delivery: ${JSON.stringify(delivery)}`);
      expect(delivery?.ci).toBe("green");
      expect(delivery?.ciRepair?.failures).toEqual([]);
      expect(delivery?.ciWatch).toBeUndefined();
      expect(await service.readWatched("ab12cd34")).toMatchObject({
        kind: "settled",
        overall: "green",
      });
      const merged = await service.merge("ab12cd34");
      console.log(`[skipped checks] merge: ${JSON.stringify(merged)}`);
      expect(merged.ok).toBe(true);
      expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(true);
    },
  );

  it("watches nothing on a host with no checks, and tells the crewmate so", async () => {
    const forge = new FakeForge({ kind: "git", place: "git.example.com" });
    forge.states = [];
    forge.change = { url: null, branch: "fm/task-ab12cd34", headSha: "feedbeef" };
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const said = await service.checkForCrew("ab12cd34");
    expect(said).toContain(
      "git.example.com runs no checks the app can watch, so no wake will come: the local gate you ran is the evidence.",
    );
    expect(tasks.get("ab12cd34")?.delivery?.ciWatch).toBeUndefined();
  });

  describe("readWatched", () => {
    it("records running checks once per status or head change", async () => {
      const forge = new FakeForge();
      forge.states = ["success", "pending"];
      forge.names = ["checks", "package-smoke"];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const events = tasks.timeline("ab12cd34").length;
      await expect(service.readWatched("ab12cd34")).resolves.toEqual({
        kind: "pending",
        head: "feedbeef",
        change: "pull request #23 https://github.com/x/y/pull/23",
        pending: [{ name: "package-smoke", state: "pending" }],
      });
      expect(tasks.get("ab12cd34")?.delivery).toMatchObject({ ci: "pending", headSha: "feedbeef" });
      const recordedEvents = tasks.timeline("ab12cd34").length;
      expect(recordedEvents).toBeGreaterThan(events);
      await service.readWatched("ab12cd34");
      expect(tasks.timeline("ab12cd34")).toHaveLength(recordedEvents);
    });

    it("records a finished reading for diagnosis without spending a repair and names the red checks", async () => {
      const forge = new FakeForge();
      forge.states = ["success", "failure", "skipped"];
      forge.names = ["checks", "lint", "docs"];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      await expect(service.readWatched("ab12cd34")).resolves.toEqual({
        kind: "settled",
        overall: "red",
        head: "feedbeef",
        change: "pull request #23 https://github.com/x/y/pull/23",
        count: 3,
        failing: [{ name: "lint", state: "failure" }],
      });
      expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
        ci: "red",
        ciRepair: { failures: [{ headSha: "feedbeef", checks: ["lint"] }] },
      });
    });

    it("names the cap when the red it read reached it", async () => {
      const forge = new FakeForge();
      forge.states = ["failure"];
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      tasks.recordDelivery("ab12cd34", { ciRounds: 3, ciCapAt: 5000 });
      const read = await service.readWatched("ab12cd34");
      expect(read).toMatchObject({ kind: "settled", overall: "red", cap: { rounds: 3, cap: 3 } });
    });

    it("answers a change that is gone, a host hiccup, and a missing sign-in as typed facts", async () => {
      const forge = new FakeForge();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      forge.change = null;
      await expect(service.readWatched("ab12cd34")).resolves.toEqual({ kind: "gone" });
      forge.change = {
        number: 23,
        url: "https://github.com/x/y/pull/23",
        branch: "fm/task-ab12cd34",
        headSha: "feedbeef",
      };
      forge.fail.checks = new ForgeError("transient", "could not reach GitHub: ECONNRESET");
      await expect(service.readWatched("ab12cd34")).resolves.toEqual({
        kind: "failed",
        transient: true,
        problem: "could not reach GitHub: ECONNRESET",
      });
      forge.fail.checks = new ForgeError("sign-in", "Not signed in to GitHub (github.com)");
      const refused = await service.readWatched("ab12cd34");
      expect(refused).toMatchObject({ kind: "failed", transient: false, signIn: true });
      expect(refused.kind === "failed" && refused.problem).toContain(
        "Report this as a blocker: the captain signs in to GitHub in the app's Settings.",
      );
    });
  });
});

describe("a merge under the captain's kept approval (FI3-304)", () => {
  /** The fake forge with the pinned pull request read by its number. */
  class PinnedForge extends FakeForge {
    readiness: ForgeReadiness = "clean";
    merged = false;
    reads = 0;
    async pull(number: number): Promise<ForgePull> {
      this.reads += 1;
      return {
        number,
        state: this.merged ? "closed" : "open",
        merged: this.merged,
        ...(this.merged ? { mergedSha: "squash01" } : {}),
        headSha: this.change?.headSha ?? "gone",
        base: "main",
        readiness: this.readiness,
      };
    }
  }

  async function pinned() {
    const forge = new PinnedForge();
    const harness = setup({ forge });
    await insertDirectPrTask(harness.tasks, harness.repos);
    const dispatched: string[] = [];
    let refuse: string | undefined;
    const guard = (overrides: Partial<MergeGuard> = {}): MergeGuard => ({
      head: "feedbeef",
      prNumber: 23,
      unattended: true,
      beforeDispatch: (head) => {
        forge.calls.push(`beforeDispatch ${head}`);
        dispatched.push(head);
        return refuse;
      },
      ...overrides,
    });
    return {
      ...harness,
      forge,
      guard,
      dispatched,
      refuseDispatch: (why: string | undefined) => {
        refuse = why;
      },
    };
  }

  it("merges only the head the approval covers, the pull request it pinned, after GitHub says it may", async () => {
    const { service, forge, guard } = await pinned();
    const moved = await service.merge("ab12cd34", guard({ head: "olderhead" }));
    expect(moved).toMatchObject({ ok: false, stop: "moved" });
    const swapped = await service.merge("ab12cd34", guard({ prNumber: 99 }));
    expect(swapped).toMatchObject({ ok: false, stop: "identity" });
    for (const [readiness, stop] of [
      ["blocked", "protected"],
      ["computing", "computing"],
      ["conflict", "conflict"],
      ["behind", "behind"],
      ["draft", "draft"],
    ] as const) {
      forge.readiness = readiness;
      expect(await service.merge("ab12cd34", guard())).toMatchObject({ ok: false, stop });
    }
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    forge.readiness = "clean";
    const merged = await service.merge("ab12cd34", guard());
    expect(merged).toMatchObject({ ok: true, receipt: { head: "feedbeef" } });
    // The last look runs right before the request, never earlier.
    expect(forge.calls.slice(-2)).toEqual([
      "beforeDispatch feedbeef",
      "putIn fm/task-ab12cd34 feedbeef",
    ]);
  });

  it("sends nothing when the approval ended before the request, and stops on a pending check", async () => {
    const { service, forge, guard, refuseDispatch } = await pinned();
    refuseDispatch("the captain's merge approval ended");
    expect(await service.merge("ab12cd34", guard())).toMatchObject({
      ok: false,
      stop: "withdrawn",
    });
    refuseDispatch(undefined);
    forge.states = ["success", "pending"];
    expect(await service.merge("ab12cd34", guard())).toMatchObject({ ok: false, stop: "checks" });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("reads a refused merge request's cause off the pull request, not its words", async () => {
    const { service, forge, guard } = await pinned();
    const attended = guard({ unattended: false });
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 405 to PUT /repos/x/y/pulls/23/merge: Pull Request is not mergeable",
    );
    forge.readiness = "blocked";
    expect(await service.merge("ab12cd34", attended)).toMatchObject({ stop: "protected" });
    // GitHub's readiness can lag the refusal: the conflict refusal still speaks.
    forge.readiness = "clean";
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 405 to PUT /repos/x/y/pulls/23/merge: Pull Request has merge conflicts",
    );
    expect(await service.merge("ab12cd34", attended)).toMatchObject({ stop: "conflict" });
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 409 to PUT /repos/x/y/pulls/23/merge: Head branch was modified. Review and try the merge again.",
    );
    expect(await service.merge("ab12cd34", attended)).toMatchObject({ stop: "moved" });
    forge.fail.putIn = new ForgeError("refused", "GitHub answered 422 to PUT: something else");
    const other = await service.merge("ab12cd34", attended);
    expect(other.ok).toBe(false);
    expect(other.stop).toBeUndefined();
  });

  it("never sends a merge twice: an answer that never came is read back first", async () => {
    const { service, forge, guard } = await pinned();
    forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    // GitHub merged it; only its answer was lost on the way back.
    const putIn = forge.putIn.bind(forge);
    forge.putIn = async (change, head) => {
      try {
        return await putIn(change, head);
      } finally {
        forge.merged = true;
      }
    };
    const merged = await service.merge("ab12cd34", guard());
    expect(merged).toMatchObject({
      ok: true,
      receipt: { head: "feedbeef", sha: "squash01", already: true },
    });
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
  });

  it("reads a pull request no longer open by its number: merged spends, closed ends", async () => {
    const { service, forge, guard } = await pinned();
    forge.change = null;
    forge.merged = true;
    expect(await service.merge("ab12cd34", guard())).toMatchObject({
      ok: true,
      receipt: { already: true },
    });
    forge.merged = false;
    forge.readiness = "clean";
    const closed = new PinnedForge();
    closed.change = null;
    closed.pull = async (number) => ({
      number,
      state: "closed",
      merged: false,
      headSha: "feedbeef",
      base: "main",
      readiness: "computing",
    });
    const other = setup({ forge: closed });
    await insertDirectPrTask(other.tasks, other.repos);
    expect(await other.service.merge("ab12cd34", guard())).toMatchObject({
      ok: false,
      stop: "closed",
    });
  });

  it("checks a declared repair against real git: lineage, newer work taken in, and every path accounted for", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (file: string, subject: string) => {
      writeFileSync(join(dir, file), `${subject}\n`);
      run("add", file);
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    run("checkout", "-b", "fm/task-ab12cd34");
    const approved = commit("meter.ts", "fix: the meter");
    run("checkout", "main");
    const newBase = commit("other.ts", "feat: newer work on main");
    run("checkout", "fm/task-ab12cd34");
    run("rebase", "main");
    const repaired = run("rev-parse", "HEAD");
    const authorization: MergeAuthorization = {
      version: 1,
      id: "auth-1",
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "card-ab12cd34-1", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: approved,
      lineage: [],
      proceedWithOpen: false,
      status: "standing",
    };
    tasks.recordDelivery("ab12cd34", { mergeAuthorization: authorization });
    const declare = (toHead: string, changedPaths: string[] = []) =>
      service.checkForCrew("ab12cd34", {
        conflictRepair: {
          fromHead: approved,
          toHead,
          newBase,
          impact: "conflict-only",
          changedPaths,
          evidence: "git range-diff: the approved commit is unchanged",
          validation: "the unit tests at the repaired head",
        },
      });
    // A repair that pulled in a file the approved change never touched.
    const drifted = commit("billing.ts", "fix: the meter's billing too");
    expect(await declare(drifted)).toContain(
      "these paths differ from the approved change and the declaration does not name them: billing.ts",
    );
    run("reset", "--hard", repaired);
    // No newer work: declaring the approved head's own base is refused.
    const stale = await service.checkForCrew("ab12cd34", {
      conflictRepair: {
        fromHead: approved,
        toHead: repaired,
        newBase: run("rev-parse", "main~1"),
        impact: "conflict-only",
        changedPaths: [],
        evidence: "e",
        validation: "v",
      },
    });
    expect(stale).toContain("took in no newer work");
    const accepted = await declare(repaired);
    expect(accepted).toContain(
      `Repair accepted: the captain's kept merge approval now covers ${repaired}`,
    );
    // The reading that follows names the head a next repair starts from.
    expect(accepted).toContain(`The captain's merge approval is kept and covers ${repaired}`);
    expect(tasks.get("ab12cd34")?.delivery?.mergeAuthorization?.lineage).toMatchObject([
      { fromHead: approved, toHead: repaired, newBase, generation: 1 },
    ]);
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
    const review: MergeReview = {
      id: "mrpr94clicked",
      relationship: "referenced",
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
    harness.tasks.recordDelivery("ab12cd34", { mergeReviews: [review] });
    // The click, with the gaps between GitHub's reads on a fake clock: it
    // settles only if the wait ends.
    const click = async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const outcome = harness.service.mergeReview("ab12cd34", review.id);
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
    expect(outcome).toMatchObject({ ok: false, relationship: "referenced", stop: "computing" });
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
});

describe("a pull request merged outside the app (FI3-213)", () => {
  /** The fake forge whose pull request, read by its number, the test settles. */
  class OutsideForge extends FakeForge {
    pullState: "merged" | "closed" | "open" | "unreadable" = "merged";
    async pull(number: number): Promise<ForgePull> {
      this.calls.push(`pull ${number}`);
      if (this.pullState === "unreadable") throw new ForgeError("transient", "GitHub answered 502");
      return {
        number,
        state: this.pullState === "open" ? "open" : "closed",
        merged: this.pullState === "merged",
        ...(this.pullState === "merged" ? { mergedSha: "squash01" } : {}),
        headSha: "feedbeef",
        base: "main",
        readiness: "clean",
      };
    }
  }

  /** A task whose #23 GitHub no longer lists among the open pull requests. */
  async function mergedOutside() {
    const forge = new OutsideForge();
    const harness = setup({ forge });
    await insertDirectPrTask(harness.tasks, harness.repos);
    recordPr(harness.tasks, 23);
    forge.change = null;
    return { ...harness, forge };
  }

  it("reads the task's own pull request by its number and records it merged", async () => {
    const { tasks, service, forge } = await mergedOutside();
    const text = await service.checkForCrew("ab12cd34");
    expect(text).toBe(
      "overall: merged\n#23 was merged on GitHub outside the app as squash01.\nNothing is left to merge: emit the completion decision, and the captain's click closes this task as merged.",
    );
    expect(forge.calls).toEqual(["changeFor fm/task-ab12cd34", "pull 23"]);
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({ ci: "merged", prNumber: 23 });
    expect(
      tasks
        .timeline("ab12cd34")
        .filter((event) => event.kind === "ci")
        .at(-1)?.data,
    ).toMatchObject({ ci: "merged" });
    const crew = await service.checkForCrew("ab12cd34");
    expect(crew).toContain("overall: merged");
    expect(crew).toContain("emit the completion decision, and the captain's click closes");
  });

  it("answers a put-in with the merge already made and sends nothing", async () => {
    const { service, forge } = await mergedOutside();
    const outcome = await service.merge("ab12cd34");
    expect(outcome).toEqual({
      ok: true,
      text: "#23 is already merged on GitHub.",
      receipt: { head: "feedbeef", sha: "squash01", already: true },
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("keeps a closed, unmerged or unreadable pull request a missing change", async () => {
    const { tasks, service, forge } = await mergedOutside();
    forge.pullState = "closed";
    expect(await service.checkForCrew("ab12cd34")).toBe(
      "overall: no-pr\nNo open PR found for branch fm/task-ab12cd34. #23 was closed without merging.",
    );
    expect(await service.merge("ab12cd34")).toMatchObject({
      ok: false,
      plain: "no open pull request was found for it",
    });
    forge.pullState = "unreadable";
    expect(await service.checkForCrew("ab12cd34")).toBe(
      "overall: no-pr\nNo open PR found for branch fm/task-ab12cd34.",
    );
    expect(tasks.get("ab12cd34")?.delivery?.ci).toBe("no-pr");
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("asks nothing by number for a task that never named a pull request", async () => {
    const forge = new OutsideForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    expect(await service.checkForCrew("ab12cd34")).toBe(
      "overall: no-pr\nNo open PR found for branch fm/task-ab12cd34.",
    );
    expect(forge.calls).toEqual(["changeFor fm/task-ab12cd34"]);
  });
});

describe("a merge request on GitLab", () => {
  /**
   * GitLab where the project lives: merge requests named `!N`, pipelines
   * the host watches, and the merge request read by its number.
   */
  class GitLabFake extends FakeForge {
    override readonly hasChecks = true;
    readiness: ForgeReadiness = "clean";
    pullState: "open" | "merged" | "closed" = "open";
    constructor() {
      super({ kind: "gitlab", place: "GitLab" });
      this.change = {
        number: 23,
        url: "https://gitlab.com/group/sub/y/-/merge_requests/23",
        branch: "fm/task-ab12cd34",
        headSha: "feedbeef",
        title: "fix: ship it",
      };
    }
    override label(change: ForgeChange) {
      return change.number !== undefined ? `!${change.number}` : change.branch;
    }
    async pull(number: number): Promise<ForgePull> {
      this.calls.push(`pull ${number}`);
      return {
        number,
        state: this.pullState === "open" ? "open" : "closed",
        merged: this.pullState === "merged",
        ...(this.pullState === "merged" ? { mergedSha: "squash01" } : {}),
        headSha: "feedbeef",
        base: "main",
        readiness: this.readiness,
      };
    }
  }

  it("records the merge request by GitLab's label and says where it went in", async () => {
    const forge = new GitLabFake();
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const reading = await service.checkForCrew("ab12cd34");
    expect(reading).toContain(
      "pull request !23 https://gitlab.com/group/sub/y/-/merge_requests/23 head feedbeef",
    );
    expect(reading).toContain("overall: green");
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      changeLabel: "!23",
      prNumber: 23,
      prUrl: "https://gitlab.com/group/sub/y/-/merge_requests/23",
    });
    expect(await service.merge("ab12cd34")).toMatchObject({
      ok: true,
      text: "Merged !23 on GitLab. https://gitlab.com/group/sub/y/-/merge_requests/23",
    });
  });

  it("names a merge request merged or closed outside the app in GitLab's words", async () => {
    const forge = new GitLabFake();
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    recordPr(tasks, 23);
    forge.change = null;
    forge.pullState = "merged";
    expect(await service.checkForCrew("ab12cd34")).toContain(
      "!23 was merged on GitLab outside the app as squash01.",
    );
    expect(await service.merge("ab12cd34")).toMatchObject({
      ok: true,
      text: "!23 is already merged on GitLab.",
    });
    forge.pullState = "closed";
    expect(await service.checkForCrew("ab12cd34")).toBe(
      "overall: no-pr\nNo open PR found for branch fm/task-ab12cd34. !23 was closed without merging.",
    );
  });

  it("merges a kept approval only once GitLab says the merge request may merge", async () => {
    const forge = new GitLabFake();
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const guard: MergeGuard = {
      head: "feedbeef",
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    };
    forge.readiness = "blocked";
    expect(await service.merge("ab12cd34", guard)).toMatchObject({
      ok: false,
      stop: "protected",
      text: "Cannot merge yet: GitLab reads !23 as blocked.",
      plain: "GitLab holds it for a required review or another rule on the main branch",
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    // A refusal after the request reads its cause off the merge request.
    forge.readiness = "conflict";
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitLab answered 422 to PUT /projects/g%2Fy/merge_requests/23/merge: Branch cannot be merged",
    );
    expect(await service.merge("ab12cd34", { ...guard, unattended: false })).toMatchObject({
      ok: false,
      stop: "conflict",
    });
    forge.fail.putIn = undefined;
    forge.readiness = "clean";
    expect(await service.merge("ab12cd34", guard)).toMatchObject({
      ok: true,
      receipt: { head: "feedbeef" },
    });
  });

  it("refuses to merge or answer an open merge request whose title is not conventional", async () => {
    const forge = new GitLabFake();
    forge.change = { ...(forge.change as ForgeChange), title: "Ship it" };
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    expect(await service.open("ab12cd34", { title: "fix: ship it", body: "Why" })).toContain(
      '"Ship it"',
    );
    const merged = await service.merge("ab12cd34");
    expect(merged.ok).toBe(false);
    expect(merged.text).toContain('"Ship it"');
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });
});

/**
 * INF-148, the captain's words: a passed review should not start over only
 * because main moved. The three gates read a typed carry; these cover
 * open_change and the merge that runs before its boundary.
 */
describe("a passed review covers the same change", () => {
  it("opens at the exact reviewed head without reading git", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    repos.configure(tasks.get("ab12cd34")?.repoId as string, { rigor: "reviewed" });
    tasks.recordDelivery("ab12cd34", { reviewVerdict: "pass", reviewSha: "feedbeef" });
    const opened = await service.open("ab12cd34", { title: "fix: ship it", body: "Why" });
    expect(opened).toContain("already open");
    expect(opened).not.toContain("needs an independent review");
  });

  it("refuses a different head the app cannot read", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    repos.configure(tasks.get("ab12cd34")?.repoId as string, { rigor: "reviewed" });
    tasks.recordDelivery("ab12cd34", { reviewVerdict: "pass", reviewSha: "older" });
    expect(await service.open("ab12cd34", { title: "fix: ship it", body: "Why" })).toContain(
      "the current version needs an independent review",
    );
  });

  it("opens and merges a pure update, and refuses an edited line", async () => {
    const forge = new FakeForge();
    forge.change = null;
    const { tasks, repos, service } = setup({ forge, realRange: true });
    await insertDirectPrTask(tasks, repos);
    const repoId = tasks.get("ab12cd34")?.repoId as string;
    repos.configure(repoId, { rigor: "reviewed" });
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (file: string, body: string, subject: string) => {
      writeFileSync(join(dir, file), body);
      run("add", file);
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const base = `${lines.join("\n")}\n`;
    commit("a.txt", base, "chore: base lines");
    run("checkout", "-b", "fm/task-ab12cd34");
    const reviewed = commit(
      "a.txt",
      `${lines.map((line) => (line === "line 20" ? "line 20 changed" : line)).join("\n")}\n`,
      "feat: change line 20",
    );
    const reading = await readChangeReading(dir, reviewed);
    if (!reading) throw new Error("the reviewed commit has no change reading");
    tasks.recordDelivery("ab12cd34", {
      reviewVerdict: "pass",
      reviewSha: reviewed,
      reviewChange: reading,
    });
    run("checkout", "main");
    commit("a.txt", base.replace("line 1\n", "line 1 main\n"), "chore: main edits a nearby line");
    run("checkout", "fm/task-ab12cd34");
    run("rebase", "main");
    const updated = run("rev-parse", "HEAD");
    expect(
      await service.open("ab12cd34", { title: "feat: change line 20", body: "Why" }),
    ).toContain("Opened pull request #42");
    const openedDelivery = tasks.get("ab12cd34")?.delivery;
    expect(openedDelivery?.reviewSha).toBe(reviewed);
    expect(openedDelivery?.reviewCarrySha).toBeUndefined();
    expect(openedDelivery?.versionReadings?.[updated]).toBe(reading);
    expect(reviewCoversHead(openedDelivery, updated)).toBe(true);
    expect(tasks.timeline("ab12cd34").some((event) => event.text.includes("the same change"))).toBe(
      true,
    );

    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: updated,
      title: "feat: change line 20",
    };
    const merged = await service.merge("ab12cd34", undefined, {
      unattended: false,
      beforeDispatch: (head) => {
        expect(reviewCoversHead(tasks.get("ab12cd34")?.delivery, head)).toBe(true);
        expect(tasks.get("ab12cd34")?.delivery?.reviewCarrySha).toBeUndefined();
        return undefined;
      },
    });
    expect(merged.ok).toBe(true);

    const edited = commit(
      "a.txt",
      base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "  line 20 changed\n"),
      "fix: indent the changed line",
    );
    forge.change = {
      ...forge.opened,
      branch: "fm/task-ab12cd34",
      headSha: edited,
      title: "feat: change line 20",
    };
    const refused = await service.merge("ab12cd34", undefined, {
      unattended: false,
      beforeDispatch: () => {
        expect(reviewCoversHead(tasks.get("ab12cd34")?.delivery, edited)).toBe(false);
        expect(tasks.get("ab12cd34")?.delivery?.reviewCarrySha).toBeUndefined();
        return "the current version needs an independent review";
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("needs an independent review");
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
  });

  it("asks for an update only when the kept merge waits on a conflict or a moved version", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    const authorization: MergeAuthorization = {
      version: 1,
      id: "auth-1",
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "card-1", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: "feedbeef",
      lineage: [],
      proceedWithOpen: false,
      status: "standing",
    };
    const reading = async (on?: "checks" | "conflict" | "repair") => {
      tasks.recordDelivery("ab12cd34", {
        mergeAuthorization: {
          ...authorization,
          ...(on ? { waiting: { on, head: "feedbeef", at: 1 } } : { waiting: undefined }),
        },
      });
      return service.checkForCrew("ab12cd34");
    };
    expect(await reading("checks")).not.toContain("Declare a repair");
    expect(await reading()).not.toContain("Declare a repair");
    expect(await reading("conflict")).toContain(
      "Declare a repair that brings the change up to date with conflictRepair from that head.",
    );
    expect(await reading("repair")).toContain(
      "Declare a repair that brings the change up to date with conflictRepair from that head.",
    );
  });
});

// INF-169 F4/F5/F6/F12: exercise the public service, not a source-text pin.
describe("shared story delivery boundaries", () => {
  const original = "5ca2d466ee21f9733827383f23df81f3874e0d10";
  const repaired = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
  async function saved() {
    const bringBranchHome = vi.fn(async (): Promise<string> => {
      throw new Error("Work computer is asleep");
    });
    const at = setup({ bringBranchHome });
    await insertDirectPrTask(at.tasks, at.repos, { deviceId: "sleeping-work-computer" });
    const story: ChangePresentation = {
      version: 1,
      taskId: "ab12cd34",
      revision: 1,
      title: "One saved story",
      base: original,
      head: original,
      destination: {
        host: "github.com",
        projectId: 1422452335,
        fullName: "kunchenguid/infinitary-evidence-test-public",
        visibility: "public",
      },
      why: ["Keep the approved explanation."],
      whatChanged: ["The publication recovers."],
      before: ["Recovery could wait forever."],
      after: ["Recovery is deliberate."],
      noPicture: "This fixture changes publication recovery, not a screen.",
      views: [],
      assets: [],
      pictures: [],
      verification: ["Read the saved publication."],
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [
          dimension,
          { level: "low", why: "A harmless delivery fixture." },
        ]),
      ) as RiskDeclaration,
      requiredActions: [],
      unfinished: [],
      projectText: "",
    };
    const region = presentationMarkdown(story, new Map(), "passed");
    const published = {
      revision: 1,
      head: original,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      contentHash: presentationContentHash(story),
      number: 23,
    };
    at.tasks.updateChangePresentation("ab12cd34", () => ({
      revisions: [story],
      receipts: [],
      publication: published,
      published,
    }));
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: original, body: region };
    const update = vi.fn(async (_change: ForgeChange, body: string) => {
      at.forge.change = { ...(at.forge.change as ForgeChange), body };
    });
    Object.assign(at.forge, {
      attachments: {
        destination: async () => story.destination,
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
      branchHead: async () => at.forge.change?.headSha ?? "",
      updateChangeBody: update,
      pull: async () => ({
        number: 23,
        state: "open",
        merged: false,
        headSha: at.forge.change?.headSha,
        base: "main",
        readiness: "clean",
      }),
    });
    recordPr(at.tasks, 23);
    return { ...at, bringBranchHome, update, story };
  }

  // INF-497 (the captain on INF-100's PR #138): correct only the words around the story.
  it("corrects only the words around the published story through open_change (INF-497)", async () => {
    const at = await saved();
    const obsolete = "This first publication advances the published protocol to 9.0.0.";
    const corrected =
      "The published protocol advances to 10.0.0; every check on this version passed.";
    const footer = "BREAKING CHANGE: The published protocol advances to 10.0.0.";
    const region = at.forge.change?.body ?? "";
    at.forge.change = {
      ...(at.forge.change as ForgeChange),
      body: `${obsolete}\n\n${footer}\n\n${region}`,
    };
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(original);
    const same = await at.service.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: obsolete },
    });
    expect(same).toContain("Nothing was sent");
    expect(at.update).not.toHaveBeenCalled();
    const said = await at.service.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: corrected },
    });
    expect(said).toContain(
      "Changed the words around the story: GitHub shows them, and the story is as published.",
    );
    expect(at.forge.change?.body).toBe(`${corrected}\n\n${footer}\n\n${region}`);
    expect(at.update).toHaveBeenCalledTimes(1);
    // The same passage again is no longer there: nothing is sent, and the answer quotes the words.
    const stale = await at.service.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: corrected },
    });
    expect(stale).toContain(`no longer hold around.from exactly`);
    expect(stale).toContain(corrected);
    expect(at.update).toHaveBeenCalledTimes(1);
  });

  it("merges the published PR while its work computer is asleep and reads completion only once", async () => {
    const at = await saved();
    const completion = vi.spyOn(at.presentations, "completion");
    expect((await at.service.completionPresentation("ab12cd34", 1)).title).toBe("One saved story");
    expect(completion).toHaveBeenCalledTimes(1);
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    at.readHead.mockClear();
    expect((await at.service.merge("ab12cd34")).ok).toBe(true);
    expect(at.bringBranchHome).not.toHaveBeenCalled();
    expect(at.readHead).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("automatically republishes the unchanged story before a kept conflict-only merge", async () => {
    const at = await saved();
    const putIn = vi.spyOn(at.forge, "putIn");
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: repaired };
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    const authorization: MergeAuthorization = {
      version: 1,
      id: "approved-story",
      generation: 2,
      issuer: "captain",
      at: 1,
      card: { id: "approved-card", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: at.tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: original,
      proceedWithOpen: false,
      status: "standing",
      lineage: [
        {
          fromHead: original,
          toHead: repaired,
          newBase: original,
          impact: "conflict-only",
          changedPaths: [],
          evidence: "The accepted repair preserves behavior.",
          validation: "The affected checks passed.",
          generation: 2,
          at: 2,
        },
      ],
    };
    at.tasks.recordDelivery("ab12cd34", {
      mergeAuthorization: authorization,
      completionOffers: [
        {
          cardId: "approved-card",
          offerId: "offer-1",
          headSha: original,
          prNumber: 23,
          at: 1,
          presentationRevision: 1,
          presentationContentHash: at.tasks.changePresentation("ab12cd34")?.published?.contentHash,
        },
      ],
    });
    const outcome = await at.service.merge("ab12cd34", {
      head: repaired,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(outcome.ok).toBe(true);
    expect(at.update).toHaveBeenCalledTimes(1);
    // INF-169 R2 / INF-228 F2: the current description and its plain squash summary travel together.
    expect(putIn).toHaveBeenCalledWith(
      { ...at.forge.change, squashMessage: presentationCommitMessage(at.story) },
      repaired,
    );
    expect(putIn.mock.calls[0]?.[0].body).toContain(`demonstrated version ${repaired}`);
    expect(putIn.mock.calls[0]?.[0].body).not.toContain(`demonstrated version ${original}`);
    expect(at.tasks.changePresentation("ab12cd34")?.published).toMatchObject({
      revision: 2,
      head: repaired,
    });
    expect(at.bringBranchHome).not.toHaveBeenCalled();
    expect(at.readHead).not.toHaveBeenCalled();
    // A human-directed replacement is not the same-content exception.
    const current = at.tasks.changePresentation("ab12cd34")?.revisions.at(-1) as ChangePresentation;
    at.readHead.mockResolvedValue(repaired);
    const revision = await at.presentations.prepare(
      "ab12cd34",
      { ...current, after: ["A different account of the work."] },
      at.forge,
    );
    await at.presentations.publish(
      "ab12cd34",
      revision,
      at.forge,
      "fm/task-ab12cd34",
      "fix: ship it",
    );
    const refused = await at.service.merge("ab12cd34", {
      head: repaired,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("differs from the approved story");
    expect(at.forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
  });

  it("does not attach a saved-story hold to an existing unrecorded legacy PR", async () => {
    const at = await saved();
    const story = at.tasks.changePresentation("ab12cd34")?.revisions[0] as ChangePresentation;
    at.tasks.recordDelivery("ab12cd34", { presentation: undefined, prNumber: undefined });
    expect(await at.service.preparePresentation("ab12cd34", story)).toContain(
      "predates saved stories",
    );
    expect(at.tasks.changePresentation("ab12cd34")).toBeUndefined();
  });

  it("starts a saved story when the recorded pre-story PR has closed (INF-92 F1, captain's choice)", async () => {
    const at = await saved();
    const story = at.tasks.changePresentation("ab12cd34")?.revisions[0] as ChangePresentation;
    at.tasks.recordDelivery("ab12cd34", { presentation: undefined, prNumber: 23 });
    const open = at.forge.change;
    let body = "";
    at.forge.change = null;
    Object.assign(at.forge, {
      branchHead: async () => story.head,
      openChange: async (input: { branch: string; title: string; body: string }) => {
        at.forge.calls.push(`openChange ${input.branch} ${input.title}`);
        body = input.body;
        at.forge.change = {
          ...at.forge.opened,
          branch: input.branch,
          body: input.body,
          headSha: story.head,
        };
        return at.forge.change;
      },
      pull: async () => ({ number: 23, state: "closed", merged: false, base: "main" }),
    });
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    const said = await at.service.preparePresentation("ab12cd34", story);
    expect(said).toContain("Prepared presentation");
    expect(said).not.toContain("predates");
    const revision = Number(/Prepared presentation (\d+)/.exec(said)?.[1]);
    const opened = await at.service.open("ab12cd34", {
      title: "feat: share the story",
      presentation: revision,
    });
    expect(opened).toContain("Opened");
    expect(at.forge.calls).toContain("openChange fm/task-ab12cd34 feat: share the story");
    const delivery = at.tasks.get("ab12cd34")?.delivery;
    expect(body).toContain("infinitary-story:ab12cd34:start");
    expect(delivery?.prNumber).toBe(at.forge.opened.number);
    expect(delivery?.prNumber).not.toBe(23);
    expect(delivery?.changeLabel).not.toContain("23");
    // An open pull request for the branch is still a legacy one.
    at.tasks.recordDelivery("ab12cd34", { presentation: undefined });
    at.forge.change = open;
    expect(await at.service.preparePresentation("ab12cd34", story)).toContain(
      "predates saved stories",
    );
  });

  it("stops, opening nothing, when the recorded pre-story PR merged outside the app (INF-92 F3)", async () => {
    const at = await saved();
    const story = at.tasks.changePresentation("ab12cd34")?.revisions[0] as ChangePresentation;
    at.tasks.recordDelivery("ab12cd34", { presentation: undefined, prNumber: 23 });
    at.forge.change = null;
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: true, base: "main" }),
    });
    expect(await at.service.preparePresentation("ab12cd34", story)).toContain("merged outside");
    const opened = await at.service.open("ab12cd34", {
      title: "feat: share the story",
      presentation: 1,
    });
    expect(opened).toContain("merged outside");
    expect(at.forge.calls.some((call) => call.startsWith("openChange"))).toBe(false);
  });

  it("fails closed when the recorded pre-story PR cannot be read, and when it merges between prepare and open (INF-292 F5, F6)", async () => {
    const at = await saved();
    const story = at.tasks.changePresentation("ab12cd34")?.revisions[0] as ChangePresentation;
    at.tasks.recordDelivery("ab12cd34", { presentation: undefined, prNumber: 23 });
    at.forge.change = null;
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    Object.assign(at.forge, { branchHead: async () => story.head });
    Object.assign(at.forge, {
      pull: async () => {
        throw new Error("GitHub is unreachable");
      },
    });
    const refused = await at.service.preparePresentation("ab12cd34", story);
    expect(refused).toContain("Could not prepare the change story");
    expect(at.tasks.get("ab12cd34")?.delivery?.presentation).toBeUndefined();
    // Read fine at prepare, merged before open: the unpublished story opens nothing.
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: false, base: "main" }),
    });
    const said = await at.service.preparePresentation("ab12cd34", story);
    const revision = Number(/Prepared presentation (\d+)/.exec(said)?.[1]);
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: true, base: "main" }),
    });
    const opened = await at.service.open("ab12cd34", {
      title: "feat: share the story",
      presentation: revision,
    });
    expect(opened).toContain("merged outside");
    expect(at.forge.calls.some((call) => call.startsWith("openChange"))).toBe(false);
  });

  it.each(["missing task", "unsupported host", "recorded legacy", "unrecorded legacy"])(
    "cleans staged copies when preparation refuses %s (INF-169 R4)",
    async (reason) => {
      const at = await saved();
      const story = at.tasks.changePresentation("ab12cd34")?.revisions[0] as ChangePresentation;
      at.tasks.recordDelivery("ab12cd34", {
        presentation: undefined,
        prNumber: reason === "unrecorded legacy" ? undefined : 23,
      });
      const taskId = reason === "missing task" ? "missing-task" : "ab12cd34";
      const path = "release-notes/pictures/action-reply-line-dark.webp";
      const staged = await stageChangePresentation(
        {
          title: story.title,
          base: story.base,
          head: story.head,
          publishable: true,
          why: story.why,
          whatChanged: story.whatChanged,
          before: story.before,
          after: story.after,
          checked: [{ check: "Retained evidence", result: "The reply picture is selected." }],
          verification: story.verification,
          risk: story.risk,
          requiredActions: [],
          unfinished: [],
          views: [
            {
              id: "picture",
              kind: "new",
              caption: "The reply view",
              before: [],
              after: [
                { path, alt: "The dark reply view", inspected: true, captureHead: story.head },
              ],
            },
          ],
        },
        { taskId, worktree: process.cwd(), dir: at.paths },
      );
      if (reason === "unsupported host") Object.assign(at.forge, { attachments: undefined });
      expect(await at.service.preparePresentation(taskId, staged)).not.toContain(
        "Prepared presentation",
      );
      expect(staged.assets.every((asset) => !existsSync(join(at.paths, asset.file)))).toBe(true);
      expect(existsSync(path)).toBe(true);
    },
  );

  it("ignores downloaded untracked evidence but still refuses tracked edits before preparation", async () => {
    const at = setup();
    const { repo } = await at.repos.setup({ kind: "init", name: "head-check" });
    insertTask(at.tasks, { repoId: repo.id, repoDir: repo.path, worktreeDir: repo.path });
    const dir = repo.path;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args])
        .toString()
        .trim();
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("checkout", "-b", "fm/task-ab12cd34");
    writeFileSync(join(dir, "tracked.txt"), "Recorded fixture\n");
    run("add", "tracked.txt");
    run("commit", "-m", "test: record a fixture");
    mkdirSync(join(dir, ".infinitary-artifacts"));
    writeFileSync(
      join(dir, ".infinitary-artifacts", "empty.zip"),
      Buffer.from("504b05060000000000000000000000000000000000000000", "hex"),
    );
    expect(await at.service.presentationHead("ab12cd34")).toBe(run("rev-parse", "HEAD"));
    writeFileSync(join(dir, "tracked.txt"), "An uncommitted change\n");
    await expect(at.service.presentationHead("ab12cd34")).rejects.toThrow(
      "Commit the task's changes",
    );
  });
});
