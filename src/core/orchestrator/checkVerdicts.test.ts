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
    expect(html).toContain(`unit-tests</span> <span>· ${CHECK_FAILS_ON_MAIN_WORDS}</span>`);
    expect(html).toContain(
      `<p class="inf-check-outside" data-check-outside="unit-tests">${failsOnMainSentence({ sha: mainSha, at: now - 5 * 60_000 }, now)}</p>`,
    );
    expect(failsOnMainSentence({ sha: mainSha, at: now - 5 * 60_000 }, now)).toBe(
      "Main's newest run of this check failed too, at bbbbbbb, read 5m ago, so the failure is outside this change; the app watches main's run of it.",
    );
    // A check main passes keeps the missing-verdict words and no fact line.
    expect(html).toContain(`probe-tests</span> <span>· ${CHECK_VERDICT_MISSING}</span>`);
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
    expect(html).toContain(`· ${CHECK_VERDICT_WORDS["baseline-blocked"]}</span></summary>`);
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
});
