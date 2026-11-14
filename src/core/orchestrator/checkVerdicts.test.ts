import { BATCH_CHECK } from "@shared/batches";
import { describe, expect, it } from "vitest";
import {
  CHECK_FAILS_ON_MAIN_WORDS,
  CHECK_VERDICT_MISSING,
  CHECK_VERDICT_WORDS,
  checkVerdicts,
  failsOnMainSentence,
} from "./checkVerdicts";

// INF-1915 fix 1: the host states its own fact under a failed check that the
// default branch's newest run fails too, in the open, from the recorded
// evidence alone; the crew's verdict stays the crew's.
describe("checkVerdicts", () => {
  /** A row's open line: the verdict first, then the check's name in mono. */
  const row = (verdict: string, check: string) =>
    `<span class="inf-check-v">${verdict}</span> <span class="inf-mono inf-check-name">${check}</span>`;
  const headSha = "a".repeat(40);
  const mainSha = "b".repeat(40);
  const now = 10 * 60_000;
  const failed = (names: string[]) => ({
    headSha,
    items: names.map((name) => ({ name, state: "failure" as const })),
    absenceDeclared: false,
  });
  const reading = (checks: string[], onMain: string[]) => ({
    ci: "red",
    headSha,
    ciRepair: { failures: [{ headSha, checks }], diagnoses: [], repairs: [] },
    checks: failed(checks),
    mainChecks: {
      head: headSha,
      sha: mainSha,
      at: now - 5 * 60_000,
      items: onMain.map((name) => ({ name, state: "failure" as const })),
    },
  });

  it("states that main fails an undiagnosed check too, naming main's version and when it was read", () => {
    const html = checkVerdicts(reading(["unit-tests", "probe-tests"], ["unit-tests"]), now);
    expect(html).toContain(row(CHECK_FAILS_ON_MAIN_WORDS, "unit-tests"));
    expect(html).toContain(
      `<p class="inf-check-outside" data-check-outside="unit-tests">${failsOnMainSentence({ sha: mainSha, at: now - 5 * 60_000 }, now)}</p>`,
    );
    expect(failsOnMainSentence({ sha: mainSha, at: now - 5 * 60_000 }, now)).toBe(
      "Main's newest run of this check failed too, at bbbbbbb, read 5m ago, so the failure is outside this change; the app watches main's run of it.",
    );
    // A check main passes keeps the missing-verdict words and no fact line.
    expect(html).toContain(row(CHECK_VERDICT_MISSING, "probe-tests"));
    expect(html).not.toContain('data-check-outside="probe-tests"');
    expect(html.match(/data-check-outside=/g)).toHaveLength(1);
  });

  it("keeps the crew's verdict as the summary and the host's fact under it", () => {
    const delivery = reading(["unit-tests"], ["unit-tests"]);
    delivery.ciRepair.diagnoses.push({
      headSha,
      check: "unit-tests",
      classification: "baseline-blocked",
      evidence: "Main's run fails the same assertion.",
      at: 1,
    } as (typeof delivery.ciRepair.diagnoses)[number]);
    const html = checkVerdicts(delivery, now);
    expect(html).toContain(
      `<summary>${row(CHECK_VERDICT_WORDS["baseline-blocked"], "unit-tests")}</summary>`,
    );
    expect(html).not.toContain(CHECK_FAILS_ON_MAIN_WORDS);
    expect(html).toContain('data-check-outside="unit-tests"');
    expect(html).toContain("outside this change");
  });

  it("states nothing from main's run of another version or of a check that passes there", () => {
    const stale = reading(["unit-tests"], ["unit-tests"]);
    stale.mainChecks.head = "c".repeat(40);
    expect(checkVerdicts(stale, now)).not.toContain("data-check-outside");
    expect(checkVerdicts(stale, now)).toContain(CHECK_VERDICT_MISSING);
    const passing = reading(["unit-tests"], []);
    passing.mainChecks.items = [{ name: "unit-tests", state: "success" as never }];
    expect(checkVerdicts(passing, now)).not.toContain("data-check-outside");
    const green = { ...reading(["unit-tests"], ["unit-tests"]), ci: "green" };
    expect(checkVerdicts(green, now)).toBe("");
  });

  // INF-3208: the crewmate's diagnosis words apply to the pull request's
  // own checks; the queue status says the queue's own words under the
  // strip's Batch check state instead.
  it("lists no row for the batch check, diagnosed or not, beside an own check's row", () => {
    const delivery = reading(["unit-tests", BATCH_CHECK], []);
    delivery.ciRepair.diagnoses.push({
      headSha,
      check: BATCH_CHECK,
      classification: "own-regression",
      evidence: "The batch failed on this change's test.",
      at: 1,
    } as (typeof delivery.ciRepair.diagnoses)[number]);
    const html = checkVerdicts(delivery, now);
    expect(html).toContain(row(CHECK_VERDICT_MISSING, "unit-tests"));
    expect(html).not.toContain(BATCH_CHECK);
    expect(html).not.toContain(CHECK_VERDICT_WORDS["own-regression"]);
    expect(checkVerdicts(reading([BATCH_CHECK], []), now)).toBe("");
  });

  // The captain's answer on INF-3709's plan, "earlier failures: hidden": a
  // check recorded failed at this version that the newest reading no longer
  // shows failing is left out of the merge card.
  describe("a failure the newest reading no longer shows", () => {
    const rerun = (states: Record<string, "success" | "failure" | "pending">) => {
      const delivery = reading(["unit-tests", "journeys"], []);
      delivery.checks.items = Object.entries(states).map(([name, state]) => ({
        name,
        state: state as "failure",
      }));
      return delivery;
    };

    it("leaves out a check that passed or runs again, and keeps the one still failing", () => {
      const html = checkVerdicts(rerun({ "unit-tests": "success", journeys: "failure" }), now);
      expect(html).toContain(row(CHECK_VERDICT_MISSING, "journeys"));
      expect(html).not.toContain("unit-tests");
      expect(
        checkVerdicts(rerun({ "unit-tests": "pending", journeys: "failure" }), now),
      ).not.toContain("unit-tests");
    });

    it("leaves out a requested run's job once the run's newest attempt stops listing it", () => {
      // The run's job is not one of the pull request's checks, so the reading
      // of them never names it: the run's own newest reading decides.
      const delivery = {
        ...rerun({ "unit-tests": "failure" }),
        ciRepair: {
          failures: [{ headSha, checks: ["unit-tests", "journeys"] }],
          runs: [{ runId: 7, headSha, attempt: 1, failed: ["journeys"] }],
          diagnoses: [],
          repairs: [],
        },
      };
      expect(checkVerdicts(delivery, now)).toContain(row(CHECK_VERDICT_MISSING, "journeys"));
      delivery.ciRepair.runs = [{ runId: 7, headSha, attempt: 2, failed: [] }];
      const html = checkVerdicts(delivery, now);
      expect(html).not.toContain("journeys");
      expect(html).toContain(row(CHECK_VERDICT_MISSING, "unit-tests"));
    });

    it("keeps a check a missing or incomplete reading cannot speak for", () => {
      const unread = { ...rerun({}), checks: undefined };
      expect(checkVerdicts(unread, now)).toContain(row(CHECK_VERDICT_MISSING, "unit-tests"));
      const incomplete = rerun({ journeys: "failure" });
      Object.assign(incomplete.checks, { complete: false });
      expect(checkVerdicts(incomplete, now)).toContain(row(CHECK_VERDICT_MISSING, "unit-tests"));
      // A whole reading that does not list the check says it no longer fails.
      expect(checkVerdicts(rerun({ journeys: "failure" }), now)).not.toContain("unit-tests");
    });
  });
});
