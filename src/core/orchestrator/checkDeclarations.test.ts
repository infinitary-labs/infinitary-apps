import {
  type HoldOverride,
  overridePasses,
  standingOverride,
  standingOverrideWords,
} from "@shared/holds";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { standingBaselineChecks, standingDependencyWaits } from "../tasks/dependencyWaits";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { declareCheckAction, observeCheckRepair } from "./checkRepair";

// Accepted INF-1177 piece 0: the crew owns readiness and repair settlement.
// Exercise the actual declaration and persisted delivery interface, not source text.
describe("evidence-backed check declarations", () => {
  function fixture() {
    const tasks = new TaskService({ db: freshDatabase() });
    seedTask(tasks, { id: "checks", title: "Fix the checks", status: "idle" });
    return tasks;
  }
  const headSha = "93355db9d04e964513879db74d068a7789cb4c16";
  const evidence = "The phone run's log and the checks reading identify this exact version.";

  it("keeps the captain's words when only retired count holds were named", () => {
    const override = JSON.parse(
      '{"words":"Keep fixing it and use the agreed test resources.","holds":["repairs"],"until":"task","at":100}',
    ) as HoldOverride;
    const standing = standingOverride({ override }, headSha);
    expect(standing?.words).toBe(override.words);
    expect(overridePasses({ override }, "checks", headSha)).toBe(false);
    expect(standingOverrideWords(standing!)).toContain(override.words);
    expect(standingOverrideWords(standing!)).toContain("count holds are retired");
  });

  // Captain INF-1555 F12: an offer expresses readiness; old inputs cannot record a second verdict.
  it("rejects old ready/red requests while preserving their existing history and consent boundary", () => {
    const tasks = fixture();
    const history = [{ headSha, verdict: "ready" as const, evidence, at: 1 }];
    seedDelivery(tasks, "checks", {
      ciRepair: { failures: [], diagnoses: [], repairs: [], declarations: history },
    });
    for (const verdict of ["ready", "red"] as const) {
      const oldRequest = JSON.parse(
        JSON.stringify({ declaration: { headSha, verdict, evidence } }),
      );
      const result = declareCheckAction(tasks, "checks", oldRequest, 10);
      expect(result.read).toBe(false);
      expect(result.text).toContain("merge offer");
    }
    const delivery = tasks.get("checks")?.delivery;
    expect(delivery?.ciRepair?.declarations).toEqual(history);
    expect(delivery).not.toHaveProperty("crewVerdict");
    expect(delivery?.mergeAuthorization).toBeUndefined();
    expect(delivery?.ciCapAt).toBeUndefined();
  });

  it("requires evidence, and never settles or counts an observed repair", () => {
    const tasks = fixture();
    expect(
      declareCheckAction(
        tasks,
        "checks",
        { declaration: { headSha, verdict: "flake", evidence: " " } },
        10,
      ).read,
    ).toBe(false);
    const repair = { id: "phone-fix", sourceHead: "c7f9d964", headSha, check: "phone", evidence };
    expect(declareCheckAction(tasks, "checks", { repair }, 10).read).toBe(true);
    const observed = observeCheckRepair(
      tasks.get("checks")?.delivery,
      headSha,
      [{ name: "phone", state: "failure" }],
      11,
    );
    seedDelivery(tasks, "checks", observed);
    expect(tasks.get("checks")?.delivery?.ciRepair?.repairs).toEqual([repair]);
    expect(observed.ciRounds).toBeUndefined();
    expect(observed.ciCapAt).toBeUndefined();
    expect(
      declareCheckAction(
        tasks,
        "checks",
        {
          declaration: {
            headSha,
            verdict: "settled",
            repairId: repair.id,
            outcome: "superseded",
            evidence,
          },
        },
        12,
      ).read,
    ).toBe(true);
    expect(tasks.get("checks")?.delivery?.ciRepair?.repairs[0]?.outcome).toBe("superseded");
    expect(tasks.get("checks")?.delivery?.ciRepair?.declarations?.at(-1)).toMatchObject({
      verdict: "settled",
      evidence,
    });
  });

  it("projects the latest diagnosis without losing the declaration history", () => {
    const tasks = fixture();
    seedTask(tasks, { id: "baseline-owner", title: "Fix the baseline failure", status: "running" });
    seedDelivery(tasks, "checks", { headSha, ci: "red" });
    declareCheckAction(
      tasks,
      "checks",
      {
        diagnosis: {
          headSha,
          check: "phone",
          classification: "baseline-blocked",
          dependencyTask: "baseline-owner",
          evidence,
        },
      },
      10,
    );
    const before = standingBaselineChecks(tasks.get("checks")?.delivery);
    expect(before).toEqual(["phone"]);
    declareCheckAction(
      tasks,
      "checks",
      {
        diagnosis: {
          headSha,
          check: "phone",
          classification: "own-regression",
          evidence: "The comparison run identifies the change's own failing assertion.",
        },
      },
      11,
    );
    const delivery = tasks.get("checks")?.delivery;
    expect(standingBaselineChecks(delivery)).toEqual([]);
    expect(standingDependencyWaits(tasks, delivery)).toEqual([]);
    expect(delivery?.ciRepair?.declarations).toHaveLength(2);
    expect(delivery?.ciRepair?.diagnoses.map((d) => d.classification)).toEqual([
      "baseline-blocked",
      "own-regression",
    ]);
    declareCheckAction(
      tasks,
      "checks",
      {
        diagnosis: {
          headSha,
          check: "phone",
          classification: "baseline-blocked",
          dependencyTask: "baseline-owner",
          evidence,
        },
      },
      12,
    );
    const reopened = tasks.get("checks")?.delivery;
    expect(standingDependencyWaits(tasks, reopened)[0]?.since).toBe(
      reopened?.ciRepair?.diagnoses.at(-1)?.at,
    );
    expect(reopened?.ciRepair?.declarations).toHaveLength(3);
    console.log(
      "Crew diagnosis projection",
      JSON.stringify({
        before,
        after: standingBaselineChecks(delivery),
        history: delivery?.ciRepair?.declarations,
      }),
    );
  });

  // FI3-671 still applies: retiring count policy must not remove dependency-state feedback.
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
    {
      state: "dropped",
      seed: { status: "idle" },
      dropped: true,
      says: "was dropped",
      next: "name the current owner",
    },
  ] as const)("answers a baseline wait on work $state with that state", (entry) => {
    const tasks = fixture();
    const owner = seedTask(tasks, { id: "baseline-owner", title: "Fix baseline", ...entry.seed });
    if ("done" in entry) tasks.close(owner.id, { status: "done", reason: "merged", actor: "host" });
    if ("dropped" in entry)
      tasks.close(owner.id, {
        status: "dropped",
        reason: "discarded",
        actor: "host",
        text: "The previous owner was dropped.",
      });
    const answer = declareCheckAction(
      tasks,
      "checks",
      {
        diagnosis: {
          headSha,
          check: "phone",
          classification: "baseline-blocked",
          evidence,
          dependencyTask: owner.id,
        },
      },
      10,
    ).text;
    expect(answer).toContain(`${owner.key || owner.id} "Fix baseline"`);
    expect(answer).toContain(entry.says);
    expect(answer).toContain(entry.next);
  });

  it("records another evidenced flake or rerun decision without a host allowance", () => {
    const tasks = fixture();
    for (const at of [10, 11, 12, 13]) {
      expect(
        declareCheckAction(
          tasks,
          "checks",
          { declaration: { headSha, verdict: "flake", check: "phone", evidence } },
          at,
        ).read,
      ).toBe(true);
      expect(
        declareCheckAction(tasks, "checks", { rerun: { headSha, check: "phone", evidence } }, at)
          .read,
      ).toBe(true);
    }
    expect(tasks.get("checks")?.delivery?.ciRepair?.declarations).toHaveLength(8);
  });
});
