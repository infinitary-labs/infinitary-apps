import { describe, expect, it } from "vitest";
import {
  carriesEvidenceHeadings,
  EVIDENCE_HEADINGS,
  findingsBlock,
  missingEvidenceHeading,
  REVIEW_VERDICT_OF_CODE,
  type RigorInput,
  renderFinding,
  reportEvidenceHeadings,
  reviewFindingSchema,
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

describe("the evidence contract", () => {
  it("holds the standard and reviewed tiers to the evidence contract, and quick to nothing", () => {
    expect(EVIDENCE_HEADINGS).toEqual(["Intent", "What changed", "Verified", "Risk", "Not done"]);
    expect(rigorRequiresEvidence("standard")).toBe(true);
    expect(rigorRequiresEvidence("reviewed")).toBe(true);
    expect(rigorRequiresEvidence("quick")).toBe(false);
    expect(rigorRequiresEvidence(undefined)).toBe(false);
  });
});

describe("the typed finding and the blocking rule (INF-1875)", () => {
  it("renders a finding as one line: id, severity, where, text and action", () => {
    expect(
      renderFinding({
        id: "F1",
        severity: "error",
        file: "src/x.ts",
        line: 12,
        text: "the retry loop never backs off",
        action: "auto-fix",
      }),
    ).toBe("F1 error src/x.ts:12 the retry loop never backs off - auto-fix");
    expect(
      renderFinding({
        id: "F2",
        severity: "info",
        file: "docs/z.md",
        text: "the doc still names the old flow",
        action: "no-op",
      }),
    ).toBe("F2 info docs/z.md the doc still names the old flow - no-op");
    expect(
      renderFinding({
        id: "F3",
        severity: "warning",
        text: "the copy says Later, which the captain retired",
        action: "ask-user",
      }),
    ).toBe("F3 warning the copy says Later, which the captain retired - ask-user");
  });

  it("blocks on error or warning severity and on any ask-user action; info never blocks", () => {
    expect(findingsBlock([{ severity: "error", action: "auto-fix" }])).toBe(true);
    expect(findingsBlock([{ severity: "warning", action: "no-op" }])).toBe(true);
    expect(findingsBlock([{ severity: "info", action: "ask-user" }])).toBe(true);
    // Info never blocks (the no-mistakes rule).
    expect(findingsBlock([{ severity: "info", action: "no-op" }])).toBe(false);
    expect(findingsBlock([])).toBe(false);
  });

  it("refuses a finding with no severity, no action or no place on a line: the record fails toward the human, never a parser", () => {
    const finding = {
      id: "F1",
      severity: "error",
      text: "the flush races the read",
      action: "auto-fix",
    };
    expect(reviewFindingSchema.safeParse(finding).success).toBe(true);
    expect(reviewFindingSchema.safeParse({ ...finding, severity: undefined }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, action: undefined }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, line: 0 }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, text: " " }).success).toBe(false);
  });

  it("maps the typed code judgment to the verdict, and parses nothing off the report's words", () => {
    expect(REVIEW_VERDICT_OF_CODE).toEqual({
      clear: "pass",
      findings: "findings",
      blocked: "blocked",
    });
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
