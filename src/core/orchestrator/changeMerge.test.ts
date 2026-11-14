import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedHoldWords } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import {
  FakeForge,
  insertDirectPrTask,
  insertTask,
  recordPr,
  setup,
} from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  ForgeBaseMoved,
  type ForgeChange,
  ForgeError,
  type ForgePull,
  type ForgeReadiness,
} from "../forge";
import type { MergeAuthorization } from "../storage/taskRecords";
import type { TaskSeed } from "../tasks/seedTask";
import type { MergeGuard } from "./changeMerge";
import { MERGE_CHECKS_HOLD_REASON } from "./mergeAuthorization";

// Integration budget (docs/test-cohorts.md): real git plus the put-in's own
// 300 + 900 ms retry backoff, the slowest test (a merge sent again after
// GitHub said the main branch moved, with one second's re-read) 1.4 s at its
// fastest of five Mac runs; five times is 7 s.
vi.setConfig({ testTimeout: 10_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Guardrails for merging the task's change (INF-2625's plan, prCi's row:
 * "Merge, refusal and review paths pinned by tests"): what a merge under the
 * captain's kept approval stops on, how a request whose answer never came is
 * read back before anything is sent again. Each outcome is pinned by its words, its typed stop and
 * what was sent.
 */

/** The task's pull request #23, read by its number at the forge's current change. */
class NumberedForge extends FakeForge {
  readiness: ForgeReadiness = "clean";
  /** What the pull request reads as after a merge request went out. */
  afterPutIn?: Partial<ForgePull>;
  pullFails?: Error;
  sent = false;
  async pull(number: number): Promise<ForgePull> {
    if (this.pullFails && this.sent) throw this.pullFails;
    return {
      number,
      state: "open",
      merged: false,
      headSha: this.change?.headSha ?? "gone",
      base: "main",
      branch: "fm/task-ab12cd34",
      headRepo: "x/y",
      title: this.change?.title,
      readiness: this.readiness,
      ...(this.sent ? this.afterPutIn : {}),
    };
  }
  override async putIn(change: Parameters<FakeForge["putIn"]>[0], headSha: string) {
    try {
      return await super.putIn(change, headSha);
    } finally {
      this.sent = true;
    }
  }
}

async function approved() {
  const forge = new NumberedForge();
  const harness = setup({ forge });
  await insertDirectPrTask(harness.tasks, harness.repos);
  const guard = (overrides: Partial<MergeGuard> = {}): MergeGuard => ({
    head: "feedbeef",
    prNumber: 23,
    unattended: true,
    beforeDispatch: () => undefined,
    ...overrides,
  });
  const putIns = () => forge.calls.filter((call) => call.startsWith("putIn"));
  return { ...harness, forge, guard, putIns };
}

describe("a merge under the captain's kept approval stops, sending nothing", () => {
  it("on the captain's newer words, read after the review carries", async () => {
    const { service, guard, putIns } = await approved();
    expect(
      await service.merges.merge(
        "ab12cd34",
        guard({ held: () => "the captain's newer words wait for the crewmate's declaration" }),
      ),
    ).toEqual({
      ok: false,
      text: "Cannot merge yet: the captain's newer words wait for the crewmate's declaration.",
      stop: "guidance",
    });
    expect(putIns()).toEqual([]);
  });

  it("on checks it could not read after every retry, as a hiccup before anything was sent", async () => {
    const { service, forge, guard, putIns } = await approved();
    forge.fail.checks = new ForgeError("transient", "could not reach GitHub: socket hang up");
    const outcome = await service.merges.merge("ab12cd34", guard());
    expect(outcome).toMatchObject({
      ok: false,
      problem: "could not reach GitHub: socket hang up",
      stop: "transient",
    });
    expect(outcome.text).toBe(
      "Cannot merge yet - the checks could not be read. Could not check CI for task ab12cd34: could not reach GitHub: socket hang up",
    );
    expect(forge.calls.filter((call) => call.startsWith("checks"))).toHaveLength(3);
    expect(putIns()).toEqual([]);
  });

  it("on a sign-in the host refused at the request, carrying the sign-in fact", async () => {
    const { service, forge, guard, tasks } = await approved();
    forge.fail.putIn = new ForgeError(
      "sign-in",
      "GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
    );
    expect(await service.merges.merge("ab12cd34", guard())).toEqual({
      ok: false,
      text: "Cannot merge: GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
      problem: "GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
      stop: "sign-in",
      signIn: { host: "github.com", name: "GitHub", repoId: tasks.get("ab12cd34")?.repoId },
    });
  });

  it("with no open pull request and no approval, saying so in the reason", async () => {
    const { service, forge } = await approved();
    forge.change = null;
    const outcome = await service.merges.merge("ab12cd34");
    expect(outcome).toMatchObject({
      ok: false,
      notGreen: true,
      plain: "no open pull request was found for it",
    });
    expect(outcome.text).toBe(
      "Cannot merge yet - no open pull request was found for it. overall: no-pr\nNo open PR found for branch fm/task-ab12cd34.",
    );
  });
});

describe("a merge request whose answer never came is read back before anything is sent again (FI3-304)", () => {
  it("ends on a pull request closed without merging", async () => {
    const { service, forge, guard, putIns } = await approved();
    forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    forge.afterPutIn = { state: "closed" };
    expect(await service.merges.merge("ab12cd34", guard())).toEqual({
      ok: false,
      text: "Cannot merge: #23 was closed without merging.",
      plain: "its pull request was closed without merging",
      stop: "closed",
    });
    expect(putIns()).toHaveLength(1);
  });

  it("stops as moved on a pull request now at another version", async () => {
    const { service, forge, guard, putIns } = await approved();
    forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    forge.afterPutIn = { headSha: "c0ffee99" };
    expect(await service.merges.merge("ab12cd34", guard())).toEqual({
      ok: false,
      text: "Cannot merge: could not reach GitHub: socket hang up",
      problem: "could not reach GitHub: socket hang up",
      stop: "moved",
    });
    expect(putIns()).toHaveLength(1);
  });

  it("keeps the outcome unknown when the pull request cannot be read back", async () => {
    const { service, forge, guard, putIns } = await approved();
    forge.fail.putIn = new ForgeError("transient", "could not reach GitHub: socket hang up");
    forge.pullFails = new ForgeError("transient", "could not reach GitHub: connection reset");
    expect(await service.merges.merge("ab12cd34", guard())).toEqual({
      ok: false,
      text: "Cannot merge: could not reach GitHub: socket hang up",
      problem: "could not reach GitHub: socket hang up",
      stop: "outcome",
    });
    expect(putIns()).toHaveLength(1);
  });
});

describe("ChangeMerge", () => {
  it("carries the sign-in fact on a refused put-in, for the settle's refusal", async () => {
    const forge = new FakeForge();
    forge.fail.putIn = new ForgeError(
      "sign-in",
      "GitHub answered 401 to PUT /repos/x/y/pulls/23/merge",
    );
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    const outcome = await service.merges.merge("ab12cd34");
    expect(outcome.ok).toBe(false);
    expect(outcome.signIn).toEqual({
      host: "github.com",
      name: "GitHub",
      repoId: tasks.get("ab12cd34")?.repoId,
    });
  });

  it("holds a missing saved story at the merge boundary even when every check passes (INF-92)", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);
    recordPr(tasks, 23);
    tasks.delivery.updateChangePresentation("ab12cd34", () => ({ revisions: [], receipts: [] }));
    await service.checkTool.checkForCrew("ab12cd34");
    expect(service.checks.reading("ab12cd34")?.overall).toBe("green");
    const result = await service.merges.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("story has not been published");
    expect(forge.calls.filter((call) => call.startsWith("putIn"))).toEqual([]);
  });

  it("rechecks all the checks and puts the change in at the checked head", async () => {
    const { tasks, repos, service, forge } = setup();
    await insertDirectPrTask(tasks, repos);

    await expect(service.merges.merge("ab12cd34")).resolves.toEqual({
      ok: true,
      text: "Merged #23 on GitHub. https://github.com/x/y/pull/23",
      line: "Merged #23 on GitHub",
      // The line as a fact, worded where it is shown (INF-3674, piece 3).
      lineSaid: { m: "mergedChangeOn", a: { change: "#23", place: "GitHub" } },
    });
    expect(forge.calls).toEqual([
      "changeFor fm/task-ab12cd34",
      "checks feedbeef",
      "putIn fm/task-ab12cd34 feedbeef",
    ]);
  });

  // Captain INF-1555 F12: the offer carries readiness; legacy verdicts add no check hold.
  it.each(["red", "missing"] as const)(
    "does not add a separate %s readiness hold over passing checks",
    async (verdict) => {
      const forge = new FakeForge();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      if (verdict === "red")
        seedDelivery(tasks, "ab12cd34", {
          ciRepair: {
            failures: [],
            diagnoses: [],
            repairs: [],
            declarations: [
              { headSha: "feedbeef", verdict, evidence: "Saved earlier separate verdict.", at: 1 },
            ],
          },
        });
      await service.checkTool.checkForCrew("ab12cd34");
      const result = await service.merges.merge("ab12cd34");
      expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
        ci: "green",
        checks: { items: [{ name: "linux-checks", state: "success" }] },
      });
      expect(tasks.get("ab12cd34")?.delivery).not.toHaveProperty("crewVerdict");
      expect(result.ok).toBe(true);
      expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
    },
  );

  it("blocks the put-in when any head check is not successful", async () => {
    const forge = new FakeForge();
    forge.states = ["success", "pending"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);

    const result = await service.merges.merge("ab12cd34");
    expect(result.ok).toBe(false);
    expect(result.text).toContain(MERGE_CHECKS_HOLD_REASON);
    // The feed's reason is the app's own words; the check names stay in the text.
    expect(result.plain).toBe(MERGE_CHECKS_HOLD_REASON);
    expect(result.problem).toBeUndefined();
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });

  it("refuses a merge on failed checks even when the recorded reading the Firstmate read says green", async () => {
    const forge = new FakeForge();
    forge.states = ["success"];
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    await service.checks.checkOverall("ab12cd34");
    expect(service.checks.reading("ab12cd34")?.overall).toBe("green");

    // The checks turn red on GitHub after the reading was recorded.
    forge.states = ["failure"];
    const result = await service.merges.merge("ab12cd34");
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

    const result = await service.merges.merge("ab12cd34");
    expect(result).toEqual({
      ok: true,
      text: "Merged #23 on GitHub. https://github.com/x/y/pull/23",
      line: "Merged #23 on GitHub",
      // The line as a fact, worded where it is shown (INF-3674, piece 3).
      lineSaid: { m: "mergedChangeOn", a: { change: "#23", place: "GitHub" } },
    });
    expect(forge.calls.filter((call) => call.startsWith("changeFor"))).toHaveLength(2);
  });

  it("retries a put-in the host failed transiently, and never one it refused", async () => {
    const flaky = setup();
    flaky.forge.fail.putIn = new ForgeError("transient", "GitHub answered 502");
    await insertDirectPrTask(flaky.tasks, flaky.repos);
    const retried = await flaky.service.merges.merge("ab12cd34");
    expect(retried).toMatchObject({ ok: false, problem: "GitHub answered 502" });
    expect(flaky.forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(3);

    const refused = setup();
    refused.forge.fail.putIn = new ForgeError("refused", "Head branch was modified");
    await insertDirectPrTask(refused.tasks, refused.repos);
    const once = await refused.service.merges.merge("ab12cd34");
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
    await service.checks.checkOverall("ab12cd34");
    forge.fail.checks = new ForgeError("refused", "spawn gh ENOENT");

    const result = await service.merges.merge("ab12cd34");
    expect(result).toMatchObject({ ok: false, problem: "spawn gh ENOENT" });
    expect(result.text).toContain("the checks could not be read");
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
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
      const text = await service.checkTool.checkForCrew("ab12cd34");
      expect(text).toContain("the pushed branch fm/task-ab12cd34 head 5e0b");
      expect(text).toContain("facts: ");
      expect(service.checks.reading("ab12cd34")?.overall).toBe("green");
      const delivery = tasks.get("ab12cd34")?.delivery;
      expect(delivery).toMatchObject({
        changeLabel: "fm/task-ab12cd34",
        checks: { items: [], absenceDeclared: true },
      });
      expect(service.checks.reading("ab12cd34")?.overall).toBe("green");
      expect(delivery?.prNumber).toBeUndefined();
      expect(delivery?.prUrl).toBeUndefined();
      const opened = tasks.timeline("ab12cd34").find((event) => event.kind === "pr_opened");
      expect(opened?.text).toBe("Pushed the branch fm/task-ab12cd34 to git.example.com");

      await expect(service.merges.merge("ab12cd34")).resolves.toEqual({
        ok: true,
        text: 'Merged "Ship it" on git.example.com.',
        line: "Merged on git.example.com",
        lineSaid: { m: "mergedOn", a: { place: "git.example.com" } },
      });
    });

    it("says nothing was sent up yet, and takes the sent-up copy back on discard", async () => {
      const forge = plainHost();
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      const sent = forge.change;
      forge.change = null;
      expect(await service.checkTool.checkForCrew("ab12cd34")).toBe(
        "overall: no-pr\nNothing pushed for branch fm/task-ab12cd34 on git.example.com yet.",
      );

      forge.change = sent;
      await service.checks.checkOverall("ab12cd34");
      await expect(service.merges.close("ab12cd34")).resolves.toEqual({
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

      await expect(service.merges.close("ab12cd34")).resolves.toEqual({
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
      await expect(service.merges.close("ab12cd34")).resolves.toEqual({ ok: true, text: "" });
      const callsForOpenTask = forge.calls.length;

      insertTask(tasks, { id: "queued99", branch: "", status: "queued" });
      await expect(service.merges.close("queued99")).resolves.toEqual({ ok: true, text: "" });
      // A branchless (still-queued) task never asks the host at all.
      expect(forge.calls.length).toBe(callsForOpenTask);

      const { repo } = await repos.setup({ kind: "init", name: "local-notes" });
      insertTask(tasks, { id: "local1", repoId: repo.id, repoDir: repo.path });
      await expect(service.merges.close("local1")).resolves.toEqual({ ok: true, text: "" });
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
      await expect(service.merges.close("ab12cd34")).resolves.toEqual({ ok: true, text: "" });
      expect(forge.calls).toEqual([]);
    });

    it("reports a forge failure instead of throwing", async () => {
      const forge = new FakeForge();
      forge.fail.close = new ForgeError("permission", "gh: permission denied");
      const { tasks, repos, service } = setup({ forge });
      await insertDirectPrTask(tasks, repos);
      recordPr(tasks, 5);
      const result = await service.merges.close("ab12cd34");
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Could not close PR");
      expect(result.text).toContain("permission denied");
      // The raw failure rides beside the text, for the feed to say plainly.
      expect(result.problem).toBe("gh: permission denied");
    });
  });
});

describe("a merge under the captain's kept approval (FI3-304)", () => {
  /** The fake forge with the pinned pull request read by its number. */
  class PinnedForge extends FakeForge {
    readiness: ForgeReadiness = "clean";
    merged = false;
    reads = 0;
    /** Refusals the next merge requests meet, one each, before a request goes through. */
    refusals: Error[] = [];
    /** What the pull request reads as for this many reads after a refusal, before `readiness` again. */
    afterRefusal?: { readiness: ForgeReadiness; reads: number };
    private settling = 0;
    async pull(number: number): Promise<ForgePull> {
      this.reads += 1;
      const readiness =
        this.settling > 0 && this.afterRefusal ? this.afterRefusal.readiness : this.readiness;
      if (this.settling > 0) this.settling -= 1;
      this.calls.push(`pull ${readiness}`);
      return {
        number,
        state: this.merged ? "closed" : "open",
        merged: this.merged,
        ...(this.merged ? { mergedSha: "squash01" } : {}),
        headSha: this.change?.headSha ?? "gone",
        base: "main",
        readiness,
      };
    }
    override async putIn(change: Parameters<FakeForge["putIn"]>[0], headSha: string) {
      const refusal = this.refusals.shift();
      if (!refusal) return super.putIn(change, headSha);
      this.calls.push(`putIn ${change.branch} ${headSha}`);
      this.settling = this.afterRefusal?.reads ?? 0;
      throw refusal;
    }
  }

  /** A branch with a merge queue of GitHub's own: a merge request is taken into it, never merged at once. */
  class QueueBranchForge extends PinnedForge {
    queued = false;
    override async putIn(change: Parameters<FakeForge["putIn"]>[0], headSha: string) {
      this.calls.push(`putIn ${change.branch} ${headSha}`);
      this.queued = true;
      return { queued: true as const };
    }
    async inHostQueue(): Promise<boolean> {
      this.calls.push("inHostQueue");
      return this.queued;
    }
  }

  async function pinned<F extends PinnedForge = PinnedForge>(made?: F) {
    const forge = (made ?? new PinnedForge()) as F;
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
    const moved = await service.merges.merge("ab12cd34", guard({ head: "olderhead" }));
    expect(moved).toMatchObject({ ok: false, stop: "moved" });
    const swapped = await service.merges.merge("ab12cd34", guard({ prNumber: 99 }));
    expect(swapped).toMatchObject({ ok: false, stop: "identity" });
    for (const [readiness, stop] of [
      ["blocked", "protected"],
      ["computing", "computing"],
      ["conflict", "conflict"],
      ["behind", "behind"],
      ["draft", "draft"],
    ] as const) {
      forge.readiness = readiness;
      expect(await service.merges.merge("ab12cd34", guard())).toMatchObject({ ok: false, stop });
    }
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    forge.readiness = "clean";
    const merged = await service.merges.merge("ab12cd34", guard());
    expect(merged).toMatchObject({ ok: true, receipt: { head: "feedbeef" } });
    // The last look runs right before the request, never earlier.
    expect(forge.calls.slice(-2)).toEqual([
      "beforeDispatch feedbeef",
      "putIn fm/task-ab12cd34 feedbeef",
    ]);
  });

  // Intent: the approved plan's piece 5: a merge click on a branch with a
  // merge queue hands the pull request to that queue, and "an enqueued answer
  // makes the task wait until the host merges or removes it".
  it("waits on a version the branch's merge queue took, reads the queue instead of sending again, and sends one GitHub removed only on an answer or the captain's click", async () => {
    const { service, forge, guard } = await pinned(new QueueBranchForge());
    const sends = () => forge.calls.filter((call) => call.startsWith("putIn")).length;
    const taken = await service.merges.merge("ab12cd34", guard());
    expect(taken).toMatchObject({ ok: false, stop: "host-queue" });
    expect(taken.receipt).toBeUndefined();
    expect(taken.text).toContain("It is queued, not merged");
    expect(sends()).toBe(1);
    // The approval now stands on that wait: a later run reads the queue and sends nothing.
    const handed = { handed: () => ({ answered: false }) };
    expect(await service.merges.merge("ab12cd34", guard(handed))).toMatchObject({
      ok: false,
      stop: "host-queue",
    });
    expect(forge.calls.at(-1)).toBe("inHostQueue");
    expect(sends()).toBe(1);
    // GitHub removed it without merging: a run nobody asked for sends nothing.
    forge.queued = false;
    const removed = await service.merges.merge("ab12cd34", guard(handed));
    expect(removed).toMatchObject({ ok: false, stop: "host-removed" });
    expect(sends()).toBe(1);
    // Its crewmate answered the removal: that version goes to the queue once more.
    expect(
      await service.merges.merge("ab12cd34", guard({ handed: () => ({ answered: true }) })),
    ).toMatchObject({ ok: false, stop: "host-queue" });
    expect(sends()).toBe(2);
    // Removed again, the captain's own click sends it too.
    forge.queued = false;
    expect(
      await service.merges.merge("ab12cd34", guard({ ...handed, unattended: false })),
    ).toMatchObject({ ok: false, stop: "host-queue" });
    expect(sends()).toBe(3);
    // GitHub merged it between the read of its checks and the read of its queue.
    forge.queued = false;
    forge.merged = true;
    expect(await service.merges.merge("ab12cd34", guard(handed))).toMatchObject({
      ok: true,
      receipt: { head: "feedbeef", sha: "squash01", already: true },
    });
    expect(sends()).toBe(3);
  });

  it("sends nothing when the approval ended before the request, and stops on a pending check", async () => {
    const { service, forge, guard, refuseDispatch } = await pinned();
    refuseDispatch("the captain's merge approval ended");
    expect(await service.merges.merge("ab12cd34", guard())).toMatchObject({
      ok: false,
      stop: "withdrawn",
    });
    refuseDispatch(undefined);
    forge.states = ["success", "pending"];
    expect(await service.merges.merge("ab12cd34", guard())).toMatchObject({
      ok: false,
      stop: "checks",
    });
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
    expect(await service.merges.merge("ab12cd34", attended)).toMatchObject({ stop: "protected" });
    // GitHub's readiness can lag the refusal: the conflict refusal still speaks.
    forge.readiness = "clean";
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 405 to PUT /repos/x/y/pulls/23/merge: Pull Request has merge conflicts",
    );
    expect(await service.merges.merge("ab12cd34", attended)).toMatchObject({ stop: "conflict" });
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitHub answered 409 to PUT /repos/x/y/pulls/23/merge: Head branch was modified. Review and try the merge again.",
    );
    expect(await service.merges.merge("ab12cd34", attended)).toMatchObject({ stop: "moved" });
    forge.fail.putIn = new ForgeError("refused", "GitHub answered 422 to PUT: something else");
    const other = await service.merges.merge("ab12cd34", attended);
    expect(other.ok).toBe(false);
    expect(other.stop).toBeUndefined();
  });

  // The captain's ask: retry on its own right away when GitHub says main
  // moved, with no crewmate step, and need a crewmate only for a conflict or
  // what cannot be resolved on its own. GitHub's answers as it gave them to a
  // batch's merges: the refusal, then the pull request read as computing
  // while GitHub works the new main in, then clean.
  describe("a merge GitHub refused because the main branch moved", () => {
    const baseMoved = () =>
      new ForgeBaseMoved(
        "GitHub answered 405 to PUT /repos/x/y/pulls/23/merge: Base branch was modified. Review and try the merge again.",
      );

    it("is sent again on its own at the approved version, once GitHub reads it clean", async () => {
      const { service, forge, guard, dispatched } = await pinned();
      forge.refusals = [baseMoved()];
      // GitHub reads computing to the refusal's own read, the next try's
      // check read and its first readiness read.
      forge.afterRefusal = { readiness: "computing", reads: 3 };
      const outcome = await service.merges.merge("ab12cd34", guard());
      expect(outcome).toMatchObject({ ok: true, receipt: { head: "feedbeef" } });
      expect(outcome.stop).toBeUndefined();
      expect(forge.calls.filter((call) => call.startsWith("putIn"))).toEqual([
        "putIn fm/task-ab12cd34 feedbeef",
        "putIn fm/task-ab12cd34 feedbeef",
      ]);
      expect(dispatched).toEqual(["feedbeef", "feedbeef"]);
      // GitHub was read again until it decided, and only then was the merge sent.
      const after = forge.calls.slice(forge.calls.indexOf("putIn fm/task-ab12cd34 feedbeef") + 1);
      expect(after).toContain("pull computing");
      expect(after.slice(-3)).toEqual([
        "pull clean",
        "beforeDispatch feedbeef",
        "putIn fm/task-ab12cd34 feedbeef",
      ]);
    });

    it("stops on a conflict GitHub reads after it, for the crewmate, sending nothing more", async () => {
      const { service, forge, guard } = await pinned();
      forge.refusals = [baseMoved()];
      forge.afterRefusal = { readiness: "computing", reads: 1 };
      forge.readiness = "conflict";
      // The captain's own click reads GitHub before sending again, as the host's merge does.
      const outcome = await service.merges.merge("ab12cd34", guard({ unattended: false }));
      expect(outcome).toMatchObject({ ok: false, stop: "conflict" });
      expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(1);
    });

    it("waits on GitHub, not the crewmate, when every request meets the same refusal", async () => {
      const { service, forge, guard } = await pinned();
      forge.refusals = [baseMoved(), baseMoved(), baseMoved()];
      const outcome = await service.merges.merge("ab12cd34", guard());
      expect(outcome).toMatchObject({ ok: false, stop: "computing" });
      expect(outcome.problem).toContain("Base branch was modified");
      expect(forge.calls.filter((call) => call.startsWith("putIn"))).toHaveLength(3);
    });
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
    const merged = await service.merges.merge("ab12cd34", guard());
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
    expect(await service.merges.merge("ab12cd34", guard())).toMatchObject({
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
    expect(await other.service.merges.merge("ab12cd34", guard())).toMatchObject({
      ok: false,
      stop: "closed",
    });
  });

  it("checks a declared repair against real git: lineage, the base it sits on, and every path accounted for", async () => {
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
    seedDelivery(tasks, "ab12cd34", { mergeAuthorization: authorization });
    const declare = (toHead: string, changedPaths: string[] = []) =>
      service.checkTool.checkForCrew("ab12cd34", {
        conflictRepair: {
          fromHead: approved,
          toHead,
          newBase,
          impact: "none",
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
    // A base older than the one the repair sits on: the newer work's own
    // file then differs from the approved change, and nothing names it.
    const stale = await service.checkTool.checkForCrew("ab12cd34", {
      conflictRepair: {
        fromHead: approved,
        toHead: repaired,
        newBase: run("rev-parse", "main~1"),
        impact: "none",
        changedPaths: [],
        evidence: "e",
        validation: "v",
      },
    });
    expect(stale).toContain("the declaration does not name them: other.ts");
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

  // INF-484's E6 (INF-493): on 2026-10-11 a crewmate reworded a commit title
  // its merge was refused for, the tree unchanged and no newer work taken
  // in, and the host refused its repair twice because it was not "bringing
  // it up to date". The impact on the approved work is the crewmate's to
  // declare; the host checks the facts and records it.
  it("keeps the approval for a repair that only rewords a commit title, declared with no impact on the approved work", async () => {
    const { tasks, repos, service } = setup();
    await insertDirectPrTask(tasks, repos);
    const dir = tasks.get("ab12cd34")?.repoDir as string;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@l", ...args])
        .toString()
        .trim();
    const base = run("rev-parse", "main");
    run("checkout", "-b", "fm/task-ab12cd34");
    writeFileSync(join(dir, "pi-settings.json"), '{ "lastChangelogVersion": "1.0.0" }\n');
    run("add", "pi-settings.json");
    run("commit", "-m", "pi config");
    const approved = run("rev-parse", "HEAD");
    run("commit", "--amend", "-m", "chore(pi): record Pi changelog version 1.0.0");
    const reworded = run("rev-parse", "HEAD");
    seedDelivery(tasks, "ab12cd34", {
      mergeAuthorization: {
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
      },
    });
    const said = await service.checkTool.checkForCrew("ab12cd34", {
      conflictRepair: {
        fromHead: approved,
        toHead: reworded,
        newBase: base,
        impact: "none",
        changedPaths: [],
        evidence:
          "git diff of the approved commit and the new head is empty; only the commit's subject changed",
        validation: "the tree matches the approved commit",
      },
    });
    expect(said).toContain(
      `Repair accepted: the captain's kept merge approval now covers ${reworded}`,
    );
    const kept = tasks.get("ab12cd34")?.delivery?.mergeAuthorization;
    expect(kept?.status).toBe("standing");
    expect(kept?.lineage).toMatchObject([
      { fromHead: approved, toHead: reworded, newBase: base, impact: "none", generation: 1 },
    ]);
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

  // INF-2744: the answer points at the merge card's after close, never a report field.
  it("reads the task's own pull request by its number and records it merged", async () => {
    const { tasks, service, forge } = await mergedOutside();
    const text = await service.checkTool.checkForCrew("ab12cd34");
    expect(text).toBe(
      "overall: merged\n#23 was merged on GitHub outside the app as squash01.\nhead: feedbeef\nNothing is left to merge. Continue any remaining work; when this merge finished all of it, put up your merge card for this pull request with after close, and the app closes the task as merged without merging again.",
    );
    expect(forge.calls).toEqual(["changeFor fm/task-ab12cd34", "pull 23"]);
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      ci: "merged",
      prNumber: 23,
      headSha: "feedbeef",
    });
    expect(
      tasks
        .timeline("ab12cd34")
        .filter((event) => event.kind === "ci")
        .at(-1)?.data,
    ).toMatchObject({ ci: "merged" });
    const crew = await service.checkTool.checkForCrew("ab12cd34");
    expect(crew).toContain("overall: merged");
    // INF-2744: the merge card's after close is the one declaration that this merge finished the task.
    expect(crew).toContain("put up your merge card for this pull request with after close");
  });

  it("answers a put-in with the merge already made and sends nothing", async () => {
    const { service, forge } = await mergedOutside();
    const outcome = await service.merges.merge("ab12cd34");
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
    expect(await service.checkTool.checkForCrew("ab12cd34")).toBe(
      "overall: no-pr\nNo open PR found for branch fm/task-ab12cd34. #23 was closed without merging.",
    );
    expect(await service.merges.merge("ab12cd34")).toMatchObject({
      ok: false,
      plain: "no open pull request was found for it",
    });
    forge.pullState = "unreadable";
    expect(await service.checkTool.checkForCrew("ab12cd34")).toBe(
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
    expect(await service.checkTool.checkForCrew("ab12cd34")).toBe(
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
    const reading = await service.checkTool.checkForCrew("ab12cd34");
    expect(reading).toContain(
      "pull request !23 https://gitlab.com/group/sub/y/-/merge_requests/23 head feedbeef",
    );
    expect(reading).toContain("facts: ");
    expect(reading).not.toContain("crew verdict:");
    expect(tasks.get("ab12cd34")?.delivery).toMatchObject({
      changeLabel: "!23",
      prNumber: 23,
      prUrl: "https://gitlab.com/group/sub/y/-/merge_requests/23",
    });
    expect(await service.merges.merge("ab12cd34")).toMatchObject({
      ok: true,
      text: "Merged !23 on GitLab. https://gitlab.com/group/sub/y/-/merge_requests/23",
      line: "Merged !23 on GitLab",
    });
  });

  it("names a merge request merged or closed outside the app in GitLab's words", async () => {
    const forge = new GitLabFake();
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    recordPr(tasks, 23);
    forge.change = null;
    forge.pullState = "merged";
    expect(await service.checkTool.checkForCrew("ab12cd34")).toContain(
      "!23 was merged on GitLab outside the app as squash01.",
    );
    expect(await service.merges.merge("ab12cd34")).toMatchObject({
      ok: true,
      text: "!23 is already merged on GitLab.",
    });
    forge.pullState = "closed";
    expect(await service.checkTool.checkForCrew("ab12cd34")).toBe(
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
    expect(await service.merges.merge("ab12cd34", guard)).toMatchObject({
      ok: false,
      stop: "protected",
      text: `Cannot merge yet: GitLab reads !23 as blocked. ${fixedHoldWords("host-rules")}`,
      plain: "GitLab holds it for a required review or another rule on the main branch",
    });
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
    // A refusal after the request reads its cause off the merge request.
    forge.readiness = "conflict";
    forge.fail.putIn = new ForgeError(
      "refused",
      "GitLab answered 422 to PUT /projects/g%2Fy/merge_requests/23/merge: Branch cannot be merged",
    );
    expect(await service.merges.merge("ab12cd34", { ...guard, unattended: false })).toMatchObject({
      ok: false,
      stop: "conflict",
    });
    forge.fail.putIn = undefined;
    forge.readiness = "clean";
    expect(await service.merges.merge("ab12cd34", guard)).toMatchObject({
      ok: true,
      receipt: { head: "feedbeef" },
    });
  });

  it("refuses to merge or answer an open merge request whose title is not conventional", async () => {
    const forge = new GitLabFake();
    forge.change = { ...(forge.change as ForgeChange), title: "Ship it" };
    const { tasks, repos, service } = setup({ forge });
    await insertDirectPrTask(tasks, repos);
    expect(
      await service.publication.open("ab12cd34", { title: "fix: ship it", body: "Why" }),
    ).toContain('"Ship it"');
    const merged = await service.merges.merge("ab12cd34");
    expect(merged.ok).toBe(false);
    expect(merged.text).toContain('"Ship it"');
    expect(forge.calls.some((call) => call.startsWith("putIn"))).toBe(false);
  });
});
