import type { MergeReview } from "@shared/mergeReview";
import { describe, expect, it, vi } from "vitest";
import { FakeForge, insertDirectPrTask, setup } from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeError, type ForgePull, type ForgeReadiness, QUEUE_STATUS } from "../forge";
import type { MergeGuard } from "./prCi";

// Each project is a real `git init` (docs/test-cohorts.md), run at this
// run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Guardrails for merging the task's change (INF-2625's plan, prCi's row:
 * "Merge, refusal and review paths pinned by tests"): what a merge under the
 * captain's kept approval stops on, how a request whose answer never came is
 * read back before anything is sent again, and how a project's queue answers
 * a review's click. Each outcome is pinned by its words, its typed stop and
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

async function approved(shape?: { delivery_ask: "queue-pr" }) {
  const forge = new NumberedForge();
  const harness = setup({ forge });
  await insertDirectPrTask(harness.tasks, harness.repos, {
    ...(shape ? { shape: { kind: "fix", kind_source: "none", ...shape } } : {}),
  });
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
      await service.merge(
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
    const outcome = await service.merge("ab12cd34", guard());
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
    expect(await service.merge("ab12cd34", guard())).toEqual({
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
    const outcome = await service.merge("ab12cd34");
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
    expect(await service.merge("ab12cd34", guard())).toEqual({
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
    expect(await service.merge("ab12cd34", guard())).toEqual({
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
    expect(await service.merge("ab12cd34", guard())).toEqual({
      ok: false,
      text: "Cannot merge: could not reach GitHub: socket hang up",
      problem: "could not reach GitHub: socket hang up",
      stop: "outcome",
    });
    expect(putIns()).toHaveLength(1);
  });
});

describe("a review's click on a queue-pr project (docs/forge.md, \"A project's queue\")", () => {
  async function queuedReview() {
    const harness = await approved({ delivery_ask: "queue-pr" });
    const repoId = harness.tasks.get("ab12cd34")?.repoId ?? "";
    harness.repos.configure(repoId, { origin: "https://github.com/x/y.git" });
    const review: MergeReview = {
      id: "mrqueued00001",
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 23,
      headSha: "feedbeef",
      base: "main",
      branch: "fm/task-ab12cd34",
      method: "squash",
      title: "fix: ship it",
      at: 1,
    };
    seedDelivery(harness.tasks, "ab12cd34", { mergeReviews: [review] });
    return { ...harness, review };
  }

  it("stops on the checks when the queue's batch failed at the version, marking nothing", async () => {
    const { service, forge, review, putIns } = await queuedReview();
    const marked: string[] = [];
    forge.markQueued = async (sha) => {
      marked.push(sha);
    };
    forge.atHead.feedbeef = [
      { name: "linux-checks", state: "success" },
      { name: QUEUE_STATUS, state: "failure" },
    ];
    expect(await service.mergeReview("ab12cd34", review.id)).toEqual({
      ok: false,
      text: `Cannot merge yet - the project's queue did not pass feedbeef (${QUEUE_STATUS} is failure).`,
      plain: "the batch check failed",
      notGreen: true,
      stop: "checks",
    });
    expect(marked).toEqual([]);
    expect(putIns()).toEqual([]);
  });

  it("refuses in words when the host cannot mark a version for the queue", async () => {
    const { service, review, putIns } = await queuedReview();
    expect(await service.mergeReview("ab12cd34", review.id)).toEqual({
      ok: false,
      text: "Cannot merge: This project's host cannot mark a version for its queue.",
      problem: "This project's host cannot mark a version for its queue.",
    });
    expect(putIns()).toEqual([]);
  });
});
