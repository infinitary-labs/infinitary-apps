import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { InboxStore } from "../storage/inboxStore";
import type { MergeAuthorization } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { readChangeReading } from "../workspace/workspaceService";
import type { CardService } from "./cardService";
import type { MergeBoundary, MergeGuard } from "./prCi";
import { carryPassedReview } from "./reviewCarry";
import { SettleService, type SettleServiceHost } from "./settleService";

// Integration budget (docs/test-cohorts.md): real git for one pure update
// and one edited line, at the run's own priority.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * INF-148, the captain's words: a passed review should not start over only
 * because main moved. The kept merge's preflight is sync, so the carry is
 * recorded before it, and the merge click's boundary reads that fact.
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
    tasks.recordDelivery("review01", {
      prNumber: 23,
      reviewVerdict: "pass",
      reviewSha: reviewed,
      reviewChange: reading,
      mergeAuthorization: authorization(updated),
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

  it("does not wait on review when the update did not edit the change", async () => {
    const { tasks, host, updated, merged } = await reviewedUpdate();
    await host.runMergeAuthorization("review01");
    expect(tasks.get("review01")?.delivery?.reviewCarrySha).toBe(updated);
    expect(tasks.get("review01")?.delivery?.reviewSha).not.toBe(updated);
    expect(merged()).toBe(true);
    expect(tasks.get("review01")?.delivery?.mergeAuthorization?.waiting?.on).toBe("checks");
  });

  it("still waits on review when the update edited a line", async () => {
    const { tasks, host, run, dir, merged } = await reviewedUpdate();
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const editedBody = `${lines.join("\n")}\n`
      .replace("line 1\n", "line 1 main\n")
      .replace("line 20\n", "  line 20 changed\n");
    writeFileSync(join(dir, "a.txt"), editedBody);
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", "add", "a.txt"]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@l",
      "commit",
      "-m",
      "style: indent the changed line",
    ]);
    const edited = run("rev-parse", "HEAD");
    const current = tasks.get("review01")?.delivery?.mergeAuthorization;
    tasks.recordDelivery("review01", {
      mergeAuthorization: current ? { ...current, approvedHead: edited } : undefined,
    });
    await host.runMergeAuthorization("review01");
    expect(merged()).toBe(false);
    expect(tasks.get("review01")?.delivery?.reviewCarrySha).toBeUndefined();
    expect(tasks.get("review01")?.delivery?.mergeAuthorization?.waiting?.on).toBe("review");
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
    expect(tasks.get("oldpass")?.delivery?.reviewCarrySha).toBe(later);

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
