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

/** One finding line as the host reads it: the line is the unit. */
export type ReviewFinding = {
  severity?: FindingSeverity;
  action?: FindingAction;
  line: string;
};

const SEVERITY_PATTERN = /\b(error|warning|info)\b/i;
const ACTION_PATTERNS: readonly (readonly [FindingAction, RegExp])[] = [
  ["auto-fix", /\bauto[\s._-]?fix\b/i],
  ["ask-user", /\bask[\s._-]?user\b/i],
  ["no-op", /\bno[\s._-]?op\b/i],
];

/**
 * The findings in a reviewer's report, one per line - the brief asks for
 * id, severity, file and line, one sentence, and an action on each line,
 * so a line naming both a severity and an action is a finding, the first
 * token of each kind is its own, and the verdict and risk lines the host
 * already reads are never findings. This is the ONE reading (the metric in
 * `scripts/interaction-metrics.ts` counts actions by the same line rule):
 * what blocks, what auto-fixes and what merely informs all come off it.
 */
export function parseReviewFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^verdict:/i.test(line) || /^risk:/i.test(line)) continue;
    const severity = SEVERITY_PATTERN.exec(line)?.[1]?.toLowerCase() as FindingSeverity | undefined;
    const action = ACTION_PATTERNS.find(([, pattern]) => pattern.test(line))?.[0];
    if (severity === undefined && action === undefined) continue;
    findings.push({
      ...(severity !== undefined ? { severity } : {}),
      ...(action !== undefined ? { action } : {}),
      line,
    });
  }
  return findings;
}

/** INF-166 direction A: only the reviewer's typed facts route the cap.
 * Unknown severity/action (or no readable findings) fails toward the captain.
 * The captain chose this on every qualifying cap, not only the first.
 */
export function reviewCapOwner(findings: ReviewFinding[]): "firstmate" | "captain" {
  return findings.length > 0 &&
    findings.every(
      ({ severity, action }) =>
        (severity === "info" || severity === "warning") &&
        (action === "auto-fix" ||
          action === "no-op" ||
          (severity === "info" && action === "ask-user")),
    )
    ? "firstmate"
    : "captain";
}

/**
 * Whether a set of findings holds the merge (the no-mistakes blocking
 * rule, captain-approved 2026-09-19): an error or warning severity blocks,
 * and so does an ask-user action at any severity - the captain has a
 * question to answer. Info findings with no ask never block; a finding
 * whose severity could not be read blocks, failing toward the human.
 */
export function findingsBlock(findings: ReviewFinding[]): boolean {
  return findings.some(
    (finding) =>
      finding.severity === "error" ||
      finding.severity === "warning" ||
      finding.severity === undefined ||
      finding.action === "ask-user",
  );
}

/**
 * What the host reads off a reviewer's report: the verdict on its FIRST
 * line, the risk on its last `risk:` line, and the finding lines between.
 * A report with no verdict line states nothing - the host records no
 * verdict and spends no round on it (a reviewer's acknowledgment is not a
 * review; the merge stays held either way, so it still fails toward the
 * human). A stated `findings` whose findings are all info/no-op derives
 * `pass`: info never blocks (the no-mistakes rule). The risk is recorded
 * beside CI and never holds (Q4).
 */
export function parseReviewReport(text: string): {
  verdict: ReviewVerdict;
  /** True when the first line really carried a verdict. */
  stated: boolean;
  /** True when a stated findings verdict carried only non-blocking findings. */
  derivedPass: boolean;
  findings: ReviewFinding[];
  risk?: ReviewRisk;
  riskNote?: string;
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0] ?? "";
  const verdictMatch = /^verdict:\s*(pass|findings|blocked)\b/i.exec(first);
  let verdict = verdictMatch
    ? (verdictMatch[1]?.toLowerCase() as ReviewVerdict)
    : ("findings" as const);
  let risk: ReviewRisk | undefined;
  let riskNote: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const riskMatch = /^risk:\s*(low|medium|high)\b[\s,.:;-]*(.*)$/i.exec(lines[index] ?? "");
    if (riskMatch) {
      risk = riskMatch[1]?.toLowerCase() as ReviewRisk;
      const note = riskMatch[2]?.trim();
      if (note) riskNote = note;
      break;
    }
  }
  const findings = parseReviewFindings(text);
  // Info-only findings derive a pass, but only from a STATED findings
  // verdict with at least one readable finding: an empty or unreadable
  // list proves nothing and stays findings.
  const derivedPass =
    verdictMatch !== null &&
    verdict === "findings" &&
    findings.length > 0 &&
    !findingsBlock(findings);
  if (derivedPass) verdict = "pass";
  return {
    verdict,
    stated: verdictMatch !== null,
    derivedPass,
    findings,
    ...(risk ? { risk } : {}),
    ...(riskNote ? { riskNote } : {}),
  };
}
