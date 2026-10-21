import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { InboxStore } from "../storage/inboxStore";
import type { MergeAuthorization } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { readChangeReading } from "../workspace/workspaceService";
import type { CardService } from "./cardService";
import { declareMergeRepair } from "./mergeAuthorization";
import type { MergeBoundary, MergeGuard } from "./prCi";
import { carryPassedReview, reviewCoversHead } from "./reviewCarry";
import { SettleService, type SettleServiceHost } from "./settleService";

// Integration budget (docs/test-cohorts.md): real git for one pure update
// and one edited line, at the run's own priority.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * INF-148, the captain's words: a passed review should not start over only
 * because main moved. INF-416 G: the reading is stored with the version, so
 * the kept merge compares that fact and does not read the branch.
 */
describe("a kept merge carries a passed review across a pure update", () => {
  async function reviewedUpdate() {
    const db = freshDatabase();
    const tasks = new TaskService({ db, strict: true });
    const repos = new RepoRegistry(db, join(scratchDir("infinitary-settle-review-"), "fleet"));
    const { repo } = await repos.setup({ kind: "init", name: "reviewed-update" });
    repos.configure(repo.id, {
      origin: "https://github.com/x/y.git",
      delivery: "direct-pr",
      rigor: "reviewed",
    });
    const dir = repo.path;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const commit = (body: string, subject: string) => {
      writeFileSync(join(dir, "a.txt"), body);
      run("add", "a.txt");
      run("commit", "-m", subject);
      return run("rev-parse", "HEAD");
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const base = `${lines.join("\n")}\n`;
    commit(base, "chore: base lines");
    run("checkout", "-b", "fm/task-review01");
    const reviewed = commit(
      `${lines.map((line) => (line === "line 20" ? "line 20 changed" : line)).join("\n")}\n`,
      "feat: change line 20",
    );
    run("checkout", "main");
    commit(base.replace("line 1\n", "line 1 main\n"), "chore: main edits a nearby line");
    run("checkout", "fm/task-review01");
    run("rebase", "main");
    const updated = run("rev-parse", "HEAD");
    seedTask(tasks, {
      id: "review01",
      title: "Ship the change",
      prompt: "work",
      repoId: repo.id,
      repoDir: dir,
      worktreeDir: dir,
      branch: "fm/task-review01",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: 1,
    });
    const authorization = (head: string): MergeAuthorization => ({
      version: 1,
      id: "auth-1",
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "card-1", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: repo.id,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-review01",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: head,
      lineage: [],
      proceedWithOpen: false,
      status: "standing",
    });
    const reading = await readChangeReading(dir, reviewed);
    if (!reading) throw new Error("the reviewed commit has no change reading");
    const updatedReading = await readChangeReading(dir, updated);
    if (updatedReading !== reading) throw new Error("the pure update changed the reading");
    tasks.recordDelivery("review01", {
      prNumber: 23,
      reviewVerdict: "pass",
      reviewSha: reviewed,
      reviewChange: reading,
      versionReadings: { [reviewed]: reading, [updated]: reading },
      mergeAuthorization: {
        ...authorization(reviewed),
        changeReading: reading,
        lineage: [
          {
            fromHead: reviewed,
            toHead: updated,
            newBase: "main",
            impact: "conflict-only",
            changedPaths: [],
            evidence: "the stored readings match",
            validation: "the pure update kept the change",
            generation: 1,
            at: 1,
            changeReading: reading,
          },
        ],
      },
    });
    let merged = false;
    const host = {
      now: () => 1_000,
      tasks,
      inbox: {} as InboxStore,
      repos,
      cards: { openMergeAction: () => undefined } as unknown as CardService,
      runtimeState: () => undefined,
      stopRuntime: () => undefined,
      endLiveTask: () => undefined,
      isPersonalTask: () => false,
      deliverableOf: () => "change" as const,
      taskDelivery: () => "direct-pr" as const,
      taskAutonomy: () => false,
      resolveTaskRef: () => tasks.get("review01"),
      notifyOp: () => undefined,
      pokeInbox: () => undefined,
      sweepGates: async () => undefined,
      broadcastCrewCounts: () => undefined,
      broadcastEvent: () => undefined,
      workspace: { branchHead: async () => updated },
      mergePullRequest: async (_taskId: string, guard?: MergeGuard, boundary?: MergeBoundary) => {
        merged = true;
        const refusal = guard?.beforeDispatch(updated) ?? boundary?.beforeDispatch(updated);
        if (refusal)
          return { ok: false, text: `Cannot merge: ${refusal}.`, stop: "withdrawn" as const };
        return {
          ok: false,
          text: "the checks have not all passed",
          stop: "checks" as const,
          notGreen: true,
        };
      },
    } as unknown as SettleServiceHost;
    return { tasks, host: new SettleService(host), updated, run, dir, merged: () => merged };
  }

  it("does not read the branch when the stored readings match", async () => {
    // INF-416 G: a kept merge brought up to date compares the reading stored
    // with the repair. A branch read would fail once the checkout is gone.
    const { tasks, host, updated, dir, merged } = await reviewedUpdate();
    execFileSync("rm", ["-rf", join(dir, ".git")]);
    // INF-125: unchanged code clearance alone is not current proof. This
    // non-running a.txt change still needs an explicit no-surface judgment.
    await host.runMergeAuthorization("review01");
    expect(merged()).toBe(false);
    expect(tasks.get("review01")?.delivery?.mergeAuthorization?.waiting?.on).toBe("review");
    tasks.recordDelivery("review01", {
      liveValidation: noSurfaceProof(
        updated,
        "fixture-reviewer",
        "This lifecycle fixture changes only a.txt; it has no running product.",
      ),
    });
    await host.runMergeAuthorization("review01");
    const delivery = tasks.get("review01")?.delivery;
    expect(delivery?.reviewCarrySha).toBeUndefined();
    expect(delivery?.reviewSha).not.toBe(updated);
    expect(reviewCoversHead(delivery, updated)).toBe(true);
    expect(merged()).toBe(true);
    expect(delivery?.mergeAuthorization?.waiting?.on).toBe("checks");
  });

  it("still waits on review when the stored reading does not match", async () => {
    const { tasks, host, dir, merged } = await reviewedUpdate();
    execFileSync("rm", ["-rf", join(dir, ".git")]);
    const current = tasks.get("review01")?.delivery;
    const step = current?.mergeAuthorization?.lineage[0];
    if (!step || !current?.mergeAuthorization) throw new Error("the repair was not stored");
    tasks.recordDelivery("review01", {
      versionReadings: { ...current.versionReadings, [step.toHead]: "edited-line" },
      mergeAuthorization: {
        ...current.mergeAuthorization,
        lineage: [{ ...step, changeReading: "edited-line" }],
      },
    });
    await host.runMergeAuthorization("review01");
    expect(merged()).toBe(false);
    expect(tasks.get("review01")?.delivery?.reviewCarrySha).toBeUndefined();
    expect(tasks.get("review01")?.delivery?.mergeAuthorization?.waiting?.on).toBe("review");
  });

  it("stores the repaired head's reading when the repair is accepted", () => {
    // INF-416 G: the reading is stored where the repair is recorded, so the
    // kept merge can compare it without reading the branch.
    const db = freshDatabase();
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: "repair01",
      title: "Repair",
      prompt: "work",
      repoId: null,
      repoDir: "/tmp/repair",
      worktreeDir: "/tmp/repair",
      branch: "fm/task-repair01",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: 1,
    });
    const approved = "a".repeat(40);
    const repaired = "b".repeat(40);
    tasks.recordDelivery("repair01", {
      reviewVerdict: "pass",
      reviewSha: approved,
      reviewChange: "same-change",
      mergeAuthorization: {
        version: 1,
        id: "auth-1",
        generation: 1,
        issuer: "captain",
        at: 1,
        card: { id: "card-1", offerId: "offer-1", actionId: "merge" },
        target: {
          repoId: "repo",
          host: "github.com",
          owner: "x",
          name: "y",
          prNumber: 1,
          branch: "fm/task-repair01",
          delivery: "direct-pr",
          method: "squash",
        },
        approvedHead: approved,
        lineage: [],
        proceedWithOpen: false,
        status: "standing",
      },
    });
    const declared = declareMergeRepair(
      tasks,
      "repair01",
      {
        fromHead: approved,
        toHead: repaired,
        newBase: "c".repeat(40),
        impact: "conflict-only",
        changedPaths: [],
        evidence: "range-diff shows the same change",
        validation: "the reading matched",
      },
      {
        known: true,
        toHeadHere: true,
        baseInTo: true,
        baseInFrom: false,
        approvedPaths: ["a.txt"],
        repairedPaths: ["a.txt"],
        approvedReading: "same-change",
        repairedReading: "same-change",
      },
      2,
    );
    expect(declared.read).toBe(true);
    const delivery = tasks.get("repair01")?.delivery;
    expect(delivery?.mergeAuthorization?.lineage[0]?.changeReading).toBe("same-change");
    expect(delivery?.mergeAuthorization?.changeReading).toBe("same-change");
    expect(delivery?.versionReadings?.[repaired]).toBe("same-change");
    expect(delivery?.reviewCarrySha).toBeUndefined();
    expect(reviewCoversHead(delivery, repaired)).toBe(true);
  });

  it("carries a pass from before the reading was stored when the commit is still here", async () => {
    // INF-148 assumption 4: a pass recorded before this ships carries by
    // reading the reviewed commit, unless the task runs on another computer.
    const db = freshDatabase();
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: "oldpass",
      title: "Old pass",
      prompt: "work",
      repoId: null,
      repoDir: "/tmp/old",
      worktreeDir: "/tmp/old",
      branch: "fm/task-oldpass",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: 1,
    });
    const reviewed = "a".repeat(40);
    const later = "b".repeat(40);
    tasks.recordDelivery("oldpass", { reviewVerdict: "pass", reviewSha: reviewed });
    const read = vi.fn(async (_dir: string, sha: string) =>
      sha === reviewed || sha === later ? "same-change" : "other",
    );
    const record = tasks.get("oldpass");
    expect(record).toBeTruthy();
    expect(
      await carryPassedReview({
        tasks,
        taskId: "oldpass",
        record: record as NonNullable<typeof record>,
        repoDir: "/tmp/old",
        head: later,
        read,
      }),
    ).toBe(true);
    const carried = tasks.get("oldpass")?.delivery;
    expect(carried?.reviewCarrySha).toBeUndefined();
    expect(carried?.reviewChange).toBe("same-change");
    expect(carried?.versionReadings?.[later]).toBe("same-change");
    expect(reviewCoversHead(carried, later)).toBe(true);

    tasks.setDevice("oldpass", "other-mac");
    tasks.recordDelivery("oldpass", { reviewCarrySha: undefined, reviewChange: undefined });
    const placed = tasks.get("oldpass");
    expect(
      await carryPassedReview({
        tasks,
        taskId: "oldpass",
        record: placed as NonNullable<typeof placed>,
        repoDir: "/tmp/old",
        head: later,
        read,
      }),
    ).toBe(false);
  });
});
