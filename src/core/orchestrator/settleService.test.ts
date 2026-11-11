import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { InboxStore } from "../storage/inboxStore";
import type { MergeAuthorization } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { readChangeReading } from "../workspace/workspaceService";
import type { CardService } from "./cardService";
import type { MergeBoundary, MergeGuard } from "./changeMerge";
import { declareMergeRepair } from "./mergeAuthorization";
import { carryPassedReview, reviewCoversHead } from "./reviewCarry";
import type { SettleServiceHost } from "./settleHost";
import { createSettleOwners } from "./settleOwners";

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
    seedDelivery(tasks, "review01", {
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
            impact: "none",
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
      cards: {
        openMergeAction: () => undefined,
        get: () => undefined,
        hostCards: { raiseHostCard: () => undefined, withdrawHostCard: () => undefined },
        releaseMerged: () => undefined,
        drawsMergedLine: () => false,
      } as unknown as CardService,
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
    return { tasks, host: createSettleOwners(host).kept, updated, run, dir, merged: () => merged };
  }

  it("does not read the branch when the stored readings match", async () => {
    // INF-416 G: a kept merge brought up to date compares the reading stored
    // with the repair. A branch read would fail once the checkout is gone.
    // The host holds nothing on the review's verdict (INF-1876): the kept
    // merge goes on to its checks, and the pass carries by the stored fact.
    const { tasks, host, updated, dir, merged } = await reviewedUpdate();
    execFileSync("rm", ["-rf", join(dir, ".git")]);
    await host.runMergeAuthorization("review01");
    const delivery = tasks.get("review01")?.delivery;
    expect(delivery?.reviewCarrySha).toBeUndefined();
    expect(delivery?.reviewSha).not.toBe(updated);
    expect(reviewCoversHead(delivery, updated)).toBe(true);
    expect(merged()).toBe(true);
    expect(delivery?.mergeAuthorization?.waiting?.on).toBe("checks");
  });

  it("records that the pass does not cover the head when the stored reading does not match, and holds nothing on it", async () => {
    // Whether a merge waits for the review's verdict is the care runbook's
    // guidance to the crew (INF-1876); the host keeps the typed fact only.
    const { tasks, host, updated, dir, merged } = await reviewedUpdate();
    execFileSync("rm", ["-rf", join(dir, ".git")]);
    const current = tasks.get("review01")?.delivery;
    const step = current?.mergeAuthorization?.lineage[0];
    if (!step || !current?.mergeAuthorization) throw new Error("the repair was not stored");
    seedDelivery(tasks, "review01", {
      versionReadings: { ...current.versionReadings, [step.toHead]: "edited-line" },
      mergeAuthorization: {
        ...current.mergeAuthorization,
        lineage: [{ ...step, changeReading: "edited-line" }],
      },
    });
    await host.runMergeAuthorization("review01");
    const delivery = tasks.get("review01")?.delivery;
    expect(delivery?.reviewCarrySha).toBeUndefined();
    expect(reviewCoversHead(delivery, updated)).toBe(false);
    expect(merged()).toBe(true);
    expect(delivery?.mergeAuthorization?.waiting?.on).toBe("checks");
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
    seedDelivery(tasks, "repair01", {
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
        impact: "none",
        changedPaths: [],
        evidence: "range-diff shows the same change",
        validation: "the reading matched",
      },
      {
        known: true,
        toHeadHere: true,
        baseInTo: true,
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
    seedDelivery(tasks, "oldpass", { reviewVerdict: "pass", reviewSha: reviewed });
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

    tasks.placement.setDevice("oldpass", "other-mac");
    seedDelivery(tasks, "oldpass", { reviewCarrySha: undefined, reviewChange: undefined });
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

// INF-1965: a plain/local story binds one attempt, including one waiting across restart.
// INF-3623 (captain: "all non-code changes to the PR should keep my approval"): only
// another commit stops the click; a story revised at the clicked version lands.
// The positive land is owned by story-destinations.spec.ts; this layer owns the final refusal.
describe("a local story at the final dispatch boundary", () => {
  it.each([
    ["during-validation", "words"],
    ["restored-wait", "words"],
    ["during-validation", "commit"],
    ["restored-wait", "commit"],
  ] as const)("a replacement prepared %s that changes the %s", async (when, change) => {
    const db = freshDatabase();
    const tasks = new TaskService({ db, strict: true });
    const repos = new RepoRegistry(db, join(scratchDir("infinitary-story-boundary-"), "fleet"));
    const { repo } = await repos.setup({ kind: "init", name: "meter" });
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo.path, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    writeFileSync(join(repo.path, "meter.txt"), "reads on time\n");
    run("add", "meter.txt");
    run("commit", "-m", "fix: the meter reads on time");
    const head = run("rev-parse", "HEAD");
    const { changePresentationSchema } = await import("@shared/changePresentation");
    const { RISK_DIMENSIONS } = await import("@shared/cards");
    const { presentationContentHash } = await import("../forge/presentation");
    const story = changePresentationSchema.parse({
      version: 1,
      taskId: "story-boundary",
      revision: 1,
      title: "fix: the meter reads on time",
      destination: { kind: "local", project: repo.id },
      base: head,
      head,
      why: ["The meter should read on time."],
      whatChanged: ["The meter reads on time."],
      before: ["The meter reading lagged."],
      after: ["The meter reads on time."],
      views: [],
      noPicture: "This fixture changes a text file, not a screen.",
      verification: ["Read the committed meter file."],
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [
          dimension,
          { level: "low", why: "One disposable text file." },
        ]),
      ),
      requiredActions: [],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    });
    seedTask(tasks, {
      id: story.taskId,
      title: story.title,
      status: "idle",
      repoId: repo.id,
      repoDir: repo.path,
      worktreeDir: repo.path,
      branch: "main",
      shape: { kind: "fix", rigor_ask: "quick", delivery_ask: "local-only" },
    });
    const statusBefore = tasks.get(story.taskId)?.status;
    const binding = {
      revision: story.revision,
      head,
      contentHash: presentationContentHash(story),
    };
    tasks.delivery.updateChangePresentation(story.taskId, () => ({
      revisions: [story],
      receipts: [],
      completion: binding,
    }));
    const replace = () => {
      let at = head;
      if (change === "commit") {
        writeFileSync(join(repo.path, "meter.txt"), "reads on time, every time\n");
        run("commit", "-am", "fix: the meter reads every time");
        at = run("rev-parse", "HEAD");
      }
      const newer = {
        ...story,
        revision: 2,
        head: at,
        whatChanged: ["The meter change has a newly reviewed explanation."],
      };
      tasks.delivery.updateChangePresentation(story.taskId, () => ({
        revisions: [newer],
        receipts: [],
        completion: { revision: 2, head: at, contentHash: presentationContentHash(newer) },
      }));
    };
    if (when === "restored-wait") {
      tasks.delivery.setPendingSettle(story.taskId, {
        mode: "land",
        actor: "captain",
        requestedAt: 1,
        proceedWithOpen: false,
        story: binding,
      });
      replace();
    }
    const validateLocalStory = vi.fn(async () => {
      if (when === "during-validation") replace();
      return head;
    });
    let dispatchRefusal: string | undefined;
    const landTaskWork = vi.fn(
      async (_task: unknown, beforeDispatch: (head: string) => string | undefined) => {
        dispatchRefusal = beforeDispatch(run("rev-parse", "HEAD"));
        // The fixture stops at dispatch either way; the refusal is what this layer owns.
        throw new Error(dispatchRefusal ?? "The fixture stops at dispatch");
      },
    );
    // A fresh owner reads the durable pending intent, not an earlier in-memory closure.
    const service = createSettleOwners({
      now: () => 10,
      tasks,
      repos,
      runtimeState: () => undefined,
      isPersonalTask: () => false,
      deliverableOf: () => "change",
      taskDelivery: () => "local-only",
      taskAutonomy: () => false,
      validateLocalStory,
      workspace: { landTaskWork },
      cards: { releaseMerged: () => undefined },
    } as unknown as SettleServiceHost).settle;
    const outcome = await service.settleTask(story.taskId, "land", undefined, "captain");
    expect(validateLocalStory).toHaveBeenCalledOnce();
    expect(landTaskWork).toHaveBeenCalledOnce();
    if (change === "words") {
      expect(dispatchRefusal).toBeUndefined();
      return;
    }
    expect(dispatchRefusal).toContain("another commit came after the merge card");
    expect(outcome).toContain(dispatchRefusal);
    expect(tasks.get(story.taskId)?.status).toBe(statusBefore);
  });
});
