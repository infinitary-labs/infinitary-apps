import { z } from "zod";
import type { RepoDelivery } from "./repos";

/**
 * Delivery rigor: how carefully a crewmate ships (captain-approved tiers,
 * 2026-09-19; `docs/delivery-rigor.md` is the one home). Three tiers,
 * derived by the HOST at dispatch - never judged by the Firstmate, the same
 * way the intelligence tier is computed from the work's shape and never
 * judged (routing S2). This module is the shared vocabulary and the pure
 * derivation; the supervisor stamps the answer on the work's shape
 * (`WorkShape.rigor`) and names it in the brief.
 */

export const rigorSchema = z.enum(["quick", "standard", "reviewed"]);
export type Rigor = z.infer<typeof rigorSchema>;

/**
 * Everything the derivation is made from. Each field is a fact the host
 * holds at dispatch: the repository's posture, the captain's own words on
 * care (`rigor_ask`), and a rigor the repository itself declares
 * (`repos.rigor`, migration 36 - set by talking through `app_change project-settings`;
 * null = derive). Nothing else moves the rigor (captain ruling,
 * 2026-09-19): not the intelligence tier, not the kind, and not an
 * escalation - rejecting a result routes a stronger model, never more
 * ceremony.
 */
export type RigorInput = {
  /**
   * Whether this work lands through a gate at all. Rigor exists only where
   * a CHANGE leaves through one: a task whose deliverable is an answer
   * ships nothing at all (Task B), a task on the personal workspace builds
   * in place (there is no branch to review and no pull request to hold),
   * and a review task reads a change rather than shipping one. None of
   * those is gated and none takes a tier.
   */
  gated: boolean;
  delivery: RepoDelivery;
  /** The captain said in words how careful to be. */
  ask?: Rigor | undefined;
  /** The repository's own standing rigor, when it declares one. */
  repoRigor?: Rigor | undefined;
};

export type RigorDecision = {
  /** Absent when the work is ungated: it ships nothing through a gate. */
  rigor?: Rigor;
  /** One line for the brief's audit and the record. */
  reason: string;
};

/**
 * The derivation, in the captain's order (revised ruling, 2026-09-19): the
 * first rule that applies wins.
 *
 *   1. nothing at all when the work is not gated;
 *   2. the captain's ask, in words;
 *   3. the repository's own standing rigor, set by talking
 *      (`app_change project-settings rigor`);
 *   4. standard - every repository's default, whatever its posture.
 *
 * One bound sits under the order, mechanical rather than judged: `reviewed`
 * ships a pull request after its review passes - the reviewer reads the
 * builder's branch and the pass is what releases the push - so a reviewed
 * answer someone ASKED for on a local-only posture ships standard instead,
 * the most care that posture can take, and the reason says why.
 */
export function rigorFor(input: RigorInput): RigorDecision {
  if (!input.gated) {
    return { reason: "the work lands through no gate: no rigor" };
  }
  const bound = (rigor: Rigor, reason: string): RigorDecision => {
    if (rigor === "reviewed" && input.delivery !== "direct-pr") {
      return {
        rigor: "standard",
        reason: `${reason}; reviewed ships a pull request, so ${input.delivery} ships standard`,
      };
    }
    return { rigor, reason };
  };
  if (input.ask) {
    return bound(input.ask, `the captain asked for ${input.ask}`);
  }
  if (input.repoRigor) {
    return bound(input.repoRigor, `the repository ships ${input.repoRigor}`);
  }
  return { rigor: "standard", reason: "every repository ships standard by default" };
}

/**
 * The evidence contract's five headings, in the order a standard or reviewed
 * change carries them in its REPORT and its PR body (the crewmate prompt and
 * `renderRigorSection` ask for exactly this). Phase 3 also asked for them in
 * the completion card's open body; captain lock 3 of 2026-09-19 took that
 * back, so no lint reads them any more and `scoreRigor` counts them on the
 * report.
 */
export const EVIDENCE_HEADINGS = [
  "Intent",
  "What changed",
  "Verified",
  "Risk",
  "Not done",
] as const;
export type EvidenceHeading = (typeof EVIDENCE_HEADINGS)[number];

/** Whether a tier holds its report and PR body to the evidence contract. */
export function rigorRequiresEvidence(rigor: Rigor | undefined): boolean {
  return rigor === "standard" || rigor === "reviewed";
}

/**
 * The evidence contract read off a list of headings, in ONE place (phase 4):
 * each of the five appears, after the one before it. Other headings may sit
 * between or after them. Returns the first heading that breaks the rule -
 * `before` names the heading it wrongly precedes when it is merely out of
 * place, and is absent when it is missing outright - or undefined when the
 * list carries the contract. The rigor numbers count how often it is
 * undefined, over the headings `reportEvidenceHeadings` reads off a report.
 */
export function missingEvidenceHeading(
  headings: string[],
): { heading: EvidenceHeading; before?: EvidenceHeading } | undefined {
  const lower = headings.map((heading) => heading.toLowerCase());
  let cursor = 0;
  for (const [index, name] of EVIDENCE_HEADINGS.entries()) {
    const at = lower.indexOf(name.toLowerCase(), cursor);
    if (at === -1) {
      const before = EVIDENCE_HEADINGS[index - 1];
      return lower.includes(name.toLowerCase()) && before
        ? { heading: name, before }
        : { heading: name };
    }
    cursor = at + 1;
  }
  return undefined;
}

/** Whether a set of headings carries the evidence contract in order. */
export function carriesEvidenceHeadings(headings: string[]): boolean {
  return missingEvidenceHeading(headings) === undefined;
}

/**
 * The evidence headings in a crewmate's REPORT (contract v3.6, captain lock
 * 3 of 2026-09-19). The five headings left the completion card's open body -
 * the card was the third copy of a record the report and the PR body already
 * carried, and the lint asking for it is what made the app's most common
 * card a document - and stayed required where they always mattered. So the
 * rigor numbers read them here: a report is plain text, so a heading is a
 * LINE that is the heading and nothing else, however the crewmate marked it
 * up (`## Verified`, `**Verified**`, `Verified:`, or the bare word). A
 * sentence that merely mentions one is not a heading, which is the whole
 * reason this is a line rule rather than a search.
 */
export function reportEvidenceHeadings(report: string | null | undefined): string[] {
  if (!report) return [];
  const wanted = new Set<string>(EVIDENCE_HEADINGS.map((heading) => heading.toLowerCase()));
  const headings: string[] = [];
  for (const raw of report.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[#>\-*\s]+/, "")
      .replace(/[*_`:.\s]+$/, "")
      .trim();
    if (line && wanted.has(line.toLowerCase())) headings.push(line);
  }
  return headings;
}

/**
 * The evidence heading a report line OPENS with, however it is marked up,
 * and the words after it on the same line: `## What changed`, `**Intent:**
 * Fix the pane.` and `Verified: ran the spec.` all read as headings. A line
 * that merely mentions one mid-sentence does not.
 */
function evidenceHeadingOf(line: string): { heading: EvidenceHeading; rest: string } | undefined {
  const bare = line.trim().replace(/^[#>\-*_\s]+/, "");
  for (const heading of EVIDENCE_HEADINGS) {
    if (bare.slice(0, heading.length).toLowerCase() !== heading.toLowerCase()) continue;
    const after = bare.slice(heading.length).replace(/^[*_`]+/, "");
    if (after.trim() === "" || after.trimStart().startsWith(":")) {
      return {
        heading,
        rest: after
          .trimStart()
          .replace(/^:[*_`]*/, "")
          .trim(),
      };
    }
  }
  return undefined;
}

/**
 * A report with its leading Intent section set aside (the task popup audit,
 * A2). A five-heading report restates the goal first, so its first sentence
 * says what was asked, not what happened; its headline starts at the next
 * heading's words (What changed) instead. A report that does not open with
 * Intent comes back as it was.
 */
export function withoutIntentLead(report: string): string {
  const lines = report.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  const lead = first === -1 ? undefined : evidenceHeadingOf(lines[first] ?? "");
  if (lead?.heading !== "Intent") return report;
  const next = lines.findIndex((line, index) => index > first && evidenceHeadingOf(line));
  if (next === -1) return [lead.rest, ...lines.slice(first + 1)].join("\n");
  const section = evidenceHeadingOf(lines[next] ?? "");
  return [section?.rest ?? "", ...lines.slice(next + 1)].join("\n");
}

export const reviewVerdictSchema = z.enum(["pass", "findings", "blocked"]);
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const reviewRiskSchema = z.enum(["low", "medium", "high"]);
export type ReviewRisk = z.infer<typeof reviewRiskSchema>;

export const findingSeveritySchema = z.enum(["error", "warning", "info"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingActionSchema = z.enum(["auto-fix", "ask-user", "no-op"]);
export type FindingAction = z.infer<typeof findingActionSchema>;

/**
 * One finding a reviewer substantiated, as the typed review record carries
 * it (INF-1875): what it is, how much it matters, where it sits and what
 * should be done about it. The record is the verdict; the host never reads
 * a finding off a line of the report.
 */
/**
 * One typed finding (INF-1875). The brief says what each severity and action
 * means; a nested description never reaches a Claude crewmate and would
 * only spend the crewmate's fixed context.
 */
export const reviewFindingSchema = z.object({
  id: z.string().trim().min(1).max(64),
  severity: findingSeveritySchema,
  file: z.string().trim().min(1).optional(),
  line: z.number().int().min(1).optional(),
  text: z.string().trim().min(1).max(4000),
  action: findingActionSchema,
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** A finding as one line, for a wake, a brief's history or a feed line. */
export function renderFinding(finding: ReviewFinding): string {
  const where = finding.file
    ? finding.line === undefined
      ? finding.file
      : `${finding.file}:${finding.line}`
    : undefined;
  return `${[finding.id, finding.severity, where, finding.text].filter(Boolean).join(" ")} - ${finding.action}`;
}

/**
 * Whether a set of findings holds the merge (the no-mistakes blocking
 * rule, captain-approved 2026-09-19): an error or warning severity blocks,
 * and so does an ask-user action at any severity - the captain has a
 * question to answer. Info findings with no ask never block.
 */
export function findingsBlock(
  findings: readonly Pick<ReviewFinding, "severity" | "action">[],
): boolean {
  return findings.some(
    (finding) =>
      finding.severity === "error" ||
      finding.severity === "warning" ||
      finding.action === "ask-user",
  );
}

/**
 * The review verdict a typed review record declares (INF-1875): the code
 * judgment is the verdict - clear is a pass - and nothing is parsed off the
 * report's words. The record cannot contradict itself: the writer refuses
 * clear code beside a finding that blocks, and code findings none of
 * which block (`recordValidation`), so info findings ride a clear review
 * and never block (the no-mistakes rule).
 */
export const REVIEW_VERDICT_OF_CODE = {
  clear: "pass",
  findings: "findings",
  blocked: "blocked",
} as const satisfies Record<"clear" | "findings" | "blocked", ReviewVerdict>;
