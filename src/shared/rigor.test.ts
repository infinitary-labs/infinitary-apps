import { describe, expect, it } from "vitest";
import {
  CI_ROUND_CAP,
  carriesEvidenceHeadings,
  ciCapReached,
  EVIDENCE_HEADINGS,
  findingsBlock,
  missingEvidenceHeading,
  parseReviewFindings,
  parseReviewReport,
  REVIEW_ROUND_CAP,
  type RigorInput,
  reportEvidenceHeadings,
  reviewCapReached,
  rigorFor,
  rigorRequiresEvidence,
  withoutIntentLead,
} from "./rigor";

describe("rigorFor: the derivation order", () => {
  // One row per rule of the captain's revised order (2026-09-19), each with
  // every LOWER rule's input set the other way, so the row proves which
  // rule won rather than that several agreed.
  const table: Array<{ why: string; input: RigorInput; rigor: string; reason: string }> = [
    {
      why: "the captain's ask beats the repository: a reviewed repo still ships quick when asked",
      input: { gated: true, delivery: "direct-pr", ask: "quick", repoRigor: "reviewed" },
      rigor: "quick",
      reason: "the captain asked for quick",
    },
    {
      why: "the captain's reviewed request overrides a quick project setting",
      input: { gated: true, delivery: "direct-pr", ask: "reviewed", repoRigor: "quick" },
      rigor: "reviewed",
      reason: "the captain asked for reviewed",
    },
    {
      why: "the repository's configured rigor beats the default",
      input: { gated: true, delivery: "direct-pr", repoRigor: "quick" },
      rigor: "quick",
      reason: "the repository ships quick",
    },
    {
      why: "a repository may configure reviewed",
      input: { gated: true, delivery: "direct-pr", repoRigor: "reviewed" },
      rigor: "reviewed",
      reason: "the repository ships reviewed",
    },
    {
      why: "every repository defaults to standard on direct-pr",
      input: { gated: true, delivery: "direct-pr" },
      rigor: "standard",
      reason: "every repository ships standard by default",
    },
    {
      why: "every repository defaults to standard on local-only too",
      input: { gated: true, delivery: "local-only" },
      rigor: "standard",
      reason: "every repository ships standard by default",
    },
  ];

  for (const row of table) {
    it(row.why, () => {
      const decision = rigorFor(row.input);
      expect(decision.rigor).toBe(row.rigor);
      expect(decision.reason).toContain(row.reason);
    });
  }

  it("answers no rigor at all when the work lands through no gate", () => {
    // Rigor exists only where a change leaves through a gate. A task on the
    // personal workspace builds in place and a review task reads a change
    // rather than shipping one: neither takes a tier, whatever anyone asked
    // for - a quick tier would still be a tier, and the brief would still
    // name one.
    for (const input of [
      { gated: false, delivery: "local-only", ask: "reviewed" },
      { gated: false, delivery: "direct-pr", repoRigor: "standard" },
      { gated: false, delivery: "local-only" },
    ] as const) {
      const decision = rigorFor(input);
      expect(decision.rigor).toBeUndefined();
      expect(decision.reason).toContain("no gate");
    }
  });

  it("bounds an asked-for reviewed to a posture that ships a pull request: local-only ships standard and says why", () => {
    // The reviewed sequence ends in a push, PR and CI after the pass; with
    // no remote delivery there is nothing to ship, so the answer is
    // standard - never a quiet quick, because the rule that fired asked
    // for more care.
    for (const input of [
      { gated: true, delivery: "local-only", ask: "reviewed" },
      { gated: true, delivery: "local-only", repoRigor: "reviewed" },
    ] as const) {
      const decision = rigorFor(input);
      expect(decision.rigor).toBe("standard");
      expect(decision.reason).toContain("reviewed ships a pull request");
      expect(decision.reason).toContain("local-only ships standard");
    }
    // The bound is on reviewed alone: an ask for quick on local-only is
    // honored as given.
    expect(rigorFor({ gated: true, delivery: "local-only", ask: "quick" }).rigor).toBe("quick");
  });
});

describe("the round caps (phase 3)", () => {
  it("holds CI at the third unsuccessful own repair, and a review one past its two re-reviews", () => {
    // The crewmate prompt's own bound is three rounds; the host's record
    // reaches the cap after the third unsuccessful declared own repair.
    expect(CI_ROUND_CAP).toBe(3);
    expect(ciCapReached(undefined)).toBe(false);
    expect(ciCapReached(2)).toBe(false);
    expect(ciCapReached(3)).toBe(true);
    expect(ciCapReached(4)).toBe(true);
    // The first findings verdict is the review itself; the cap bounds the
    // re-reviews after it, so the third findings is one past the cap.
    expect(REVIEW_ROUND_CAP).toBe(2);
    expect(reviewCapReached(undefined)).toBe(false);
    expect(reviewCapReached(1)).toBe(false);
    expect(reviewCapReached(2)).toBe(false);
    expect(reviewCapReached(3)).toBe(true);
  });

  it("holds the standard and reviewed tiers to the evidence contract, and quick to nothing", () => {
    expect(EVIDENCE_HEADINGS).toEqual(["Intent", "What changed", "Verified", "Risk", "Not done"]);
    expect(rigorRequiresEvidence("standard")).toBe(true);
    expect(rigorRequiresEvidence("reviewed")).toBe(true);
    expect(rigorRequiresEvidence("quick")).toBe(false);
    expect(rigorRequiresEvidence(undefined)).toBe(false);
  });
});

describe("parseReviewFindings and the blocking rule", () => {
  it("reads one finding per line with its severity and action, skipping the verdict and risk lines", () => {
    const findings = parseReviewFindings(
      [
        "verdict: findings",
        "F1 error src/x.ts:12 the retry loop never backs off - auto-fix",
        "F2 warning src/y.ts:40 the copy says 'Later' which the captain retired - ask-user",
        "F3 info docs/z.md:3 the doc still names the old flow - no-op",
        "Some prose between findings carries neither token.",
        "risk: medium - two call sites change behaviour under load.",
      ].join("\n"),
    );
    expect(findings).toEqual([
      { severity: "error", action: "auto-fix", line: expect.stringContaining("F1") },
      { severity: "warning", action: "ask-user", line: expect.stringContaining("F2") },
      { severity: "info", action: "no-op", line: expect.stringContaining("F3") },
    ]);
  });

  it("blocks on error or warning severity, on any ask-user action, and on an unreadable severity", () => {
    expect(findingsBlock([{ severity: "error", action: "auto-fix", line: "x" }])).toBe(true);
    expect(findingsBlock([{ severity: "warning", action: "no-op", line: "x" }])).toBe(true);
    expect(findingsBlock([{ severity: "info", action: "ask-user", line: "x" }])).toBe(true);
    // Failing toward the human: a line naming an action but no severity.
    expect(findingsBlock([{ action: "auto-fix", line: "x" }])).toBe(true);
    // Info never blocks (the no-mistakes rule).
    expect(findingsBlock([{ severity: "info", action: "no-op", line: "x" }])).toBe(false);
    expect(findingsBlock([{ severity: "info", line: "x" }])).toBe(false);
    expect(findingsBlock([])).toBe(false);
  });
});

describe("parseReviewReport: the verdict line, the findings, and the risk line", () => {
  it("reads the verdict off the first line and the risk with its note off the last risk line", () => {
    const parsed = parseReviewReport(
      [
        "verdict: findings",
        "F1 error src/x.ts:12 the retry loop never backs off - auto-fix",
        "F2 warning src/y.ts:40 the copy says 'Later' which the captain retired - ask-user",
        "risk: medium - two call sites change behaviour under load.",
      ].join("\n"),
    );
    expect(parsed.verdict).toBe("findings");
    expect(parsed.stated).toBe(true);
    expect(parsed.derivedPass).toBe(false);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.risk).toBe("medium");
    expect(parsed.riskNote).toBe("two call sites change behaviour under load.");
  });

  it("reads a clean pass, case-insensitively, with a bare risk", () => {
    const parsed = parseReviewReport("Verdict: PASS\nNo findings.\nRisk: low");
    expect(parsed.verdict).toBe("pass");
    expect(parsed.stated).toBe(true);
    expect(parsed.derivedPass).toBe(false);
    expect(parsed.risk).toBe("low");
  });

  it("derives a pass from a stated findings verdict whose findings are all info/no-op: info never blocks", () => {
    const parsed = parseReviewReport(
      [
        "verdict: findings",
        "F1 info docs/z.md:3 the doc still names the old flow - no-op",
        "F2 info src/y.ts:9 a tradeoff worth noting - no-op",
        "risk: low - cosmetic notes only.",
      ].join("\n"),
    );
    expect(parsed.verdict).toBe("pass");
    expect(parsed.derivedPass).toBe(true);
    expect(parsed.findings).toHaveLength(2);
  });

  it("never derives a pass when a finding blocks, when none parsed, or when the verdict was not stated", () => {
    // An ask-user info finding still goes to the captain.
    expect(
      parseReviewReport("verdict: findings\nF1 info src/x.ts:1 odd choice - ask-user\nrisk: low")
        .verdict,
    ).toBe("findings");
    // A findings verdict with no readable finding lines proves nothing.
    expect(parseReviewReport("verdict: findings\nrisk: low").verdict).toBe("findings");
    // An unstated report is never upgraded, whatever its lines say.
    expect(parseReviewReport("F1 info docs/z.md:3 stale doc - no-op\nrisk: low").derivedPass).toBe(
      false,
    );
  });

  it("states nothing without a verdict line: the caller records no verdict and spends no round", () => {
    // A reviewer that forgot the shape must never read as a pass; since
    // the captain's 2026-09-19 ruling the caller also spends no round on
    // it - `stated` is the seam.
    const parsed = parseReviewReport("Looks good to me, ship it.\nrisk: low");
    expect(parsed.verdict).toBe("findings");
    expect(parsed.stated).toBe(false);
    // The verdict must OPEN the report, not appear somewhere in it.
    expect(parseReviewReport("Summary first.\nverdict: pass\nrisk: low").stated).toBe(false);
    expect(parseReviewReport("").stated).toBe(false);
  });

  it("reads blocked as blocked, with no risk when none was named", () => {
    const parsed = parseReviewReport("verdict: blocked\nThe PR head no longer exists.");
    expect(parsed.verdict).toBe("blocked");
    expect(parsed.stated).toBe(true);
    expect(parsed.risk).toBeUndefined();
  });
});

describe("reportEvidenceHeadings: the contract where it is required (contract v3.6)", () => {
  it("reads a heading however the crewmate marked it up, and only on a line of its own", () => {
    const report = [
      "## Intent",
      "Make the meter test steady.",
      "",
      "**What changed**",
      "The test awaits the flush.",
      "",
      "Verified:",
      "pnpm test, ten runs green.",
      "",
      "- Risk",
      "low, one test file.",
      "",
      "Not done",
      "nothing.",
    ].join("\n");
    expect(reportEvidenceHeadings(report)).toEqual([
      "Intent",
      "What changed",
      "Verified",
      "Risk",
      "Not done",
    ]);
    expect(carriesEvidenceHeadings(reportEvidenceHeadings(report))).toBe(true);
  });

  it("is not fooled by prose that merely names the headings", () => {
    // The whole reason this is a line rule: a report that talks ABOUT its
    // intent and what it verified has not written the contract's sections,
    // and crediting it would report compliance nobody asked for.
    const prose =
      "The intent was clear and I verified it end to end. Risk is low and nothing is not done.";
    expect(reportEvidenceHeadings(prose)).toEqual([]);
    expect(carriesEvidenceHeadings(reportEvidenceHeadings(prose))).toBe(false);
  });

  it("reports the first heading out of order, and an absent report as missing the first", () => {
    const outOfOrder = ["Intent", "What changed", "Risk", "Verified", "Not done"].join("\n");
    expect(missingEvidenceHeading(reportEvidenceHeadings(outOfOrder))).toEqual({
      heading: "Risk",
      before: "Verified",
    });
    expect(reportEvidenceHeadings(null)).toEqual([]);
    expect(missingEvidenceHeading(reportEvidenceHeadings(undefined))).toEqual({
      heading: "Intent",
    });
  });
});

describe("withoutIntentLead: a report's headline starts past its Intent section", () => {
  it("skips the Intent section however it is marked up, and leaves other reports alone", () => {
    expect(withoutIntentLead("Intent: fix it.\nWhat changed: fixed it.\nVerified: ran it.")).toBe(
      "fixed it.\nVerified: ran it.",
    );
    expect(withoutIntentLead("## Intent\nFix it.\n\n## What changed\nFixed it.")).toBe(
      "\nFixed it.",
    );
    expect(withoutIntentLead("**Intent:** fix it.")).toBe("fix it.");
    expect(withoutIntentLead("Fixed it. The intent was clear.")).toBe(
      "Fixed it. The intent was clear.",
    );
    expect(withoutIntentLead("Intentionally left the flag off.")).toBe(
      "Intentionally left the flag off.",
    );
  });
});
