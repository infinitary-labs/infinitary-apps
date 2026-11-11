import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  corpusFingerprint,
  privatePath,
  projectContext,
  readCorrectionCases,
  readCorrectionLabels,
  readCorrectionQuestion,
} from "../scripts/evaluate-corrections.ts";
import { REPO_ROOT } from "../scripts/moduleRunner.ts";
import { excerptCorrectionCard } from "../src/core/decisions/correctionContext";
import {
  CORRECTION_QUESTION,
  type CorrectionContext,
  correctionState,
} from "../src/core/decisions/correctionQuestion";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * Intent: the accepted correction detector must use bounded surrounding
 * context and never leak real evaluation sources, outcomes or strata.
 * These are synthetic counterparts of the handed-over shapes, not session
 * excerpts. This file owns evaluator input/privacy/budget behavior; actual
 * classification quality belongs to frozen-label live evaluations.
 */
function sample(): { id: string; context: CorrectionContext } {
  return {
    id: createHash("sha256").update("synthetic correction sample").digest("hex"),
    context: {
      latestReply: "For later work in this project, show the proposed wording before keeping it.",
      precedingSource: "same-thread",
      preceding: [
        { who: "captain", text: "Can this apply to future work?" },
        { who: "author", text: "I can propose a project direction." },
      ],
      addressedCard: {
        title: "Keep the project instruction?",
        text: "The proposed wording applies to this project only.",
      },
      project: { id: "sample-project", name: "Sample" },
      task: { title: "Plan instruction retention" },
      unavailableContext: false,
    },
  };
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("private correction evaluation input", () => {
  it("allows prompt tuning without changing the accepted closed judgment contract", () => {
    expect(readCorrectionQuestion(JSON.stringify(CORRECTION_QUESTION))).toEqual(
      CORRECTION_QUESTION,
    );
    for (const invalid of [
      { ...CORRECTION_QUESTION, type: "boolean" },
      { ...CORRECTION_QUESTION, abstain: "ordinary" },
      {
        ...CORRECTION_QUESTION,
        criteria: { ...CORRECTION_QUESTION.criteria, keep: "Keep directly" },
      },
      { ...CORRECTION_QUESTION, expected: "review" },
    ])
      expect(() => readCorrectionQuestion(JSON.stringify(invalid))).toThrow();
  });

  it("serves the allowlisted facts, never nested outcomes or sampling aids", () => {
    const row = sample();
    const loaded = readCorrectionCases(
      jsonl({
        ...row,
        recorded_after_the_fact: { result: "saved" },
        primary_stratum: "explicit",
        context: {
          ...row.context,
          recorded_after_the_fact: { result: "review" },
          attachments: [{ text: "Private attachment contents" }],
          project: { ...row.context.project, status: "removed after the reply" },
          addressedCard: { ...row.context.addressedCard, status_at_extraction: "closed" },
        },
      }),
    );
    expect(loaded).toEqual([row]);
    const context = loaded[0]?.context;
    if (!context) throw new Error("Missing loaded context");
    const state = correctionState(context, 10_000);
    expect(state?.facts).toEqual({
      latest_captain_reply: row.context.latestReply,
      preceding_exchange: JSON.stringify(row.context.preceding),
      preceding_relationship: row.context.precedingSource,
      addressed_card: JSON.stringify(row.context.addressedCard),
      project: JSON.stringify(row.context.project),
      task: JSON.stringify(row.context.task),
      context_missing_or_omitted: false,
    });
  });

  it("splits JSONL only on newlines, preserving Unicode separators inside replies", () => {
    const row = sample();
    row.context.latestReply = "Apply this\u2028only in this project\u2029not elsewhere.";
    expect(readCorrectionCases(jsonl(row))).toEqual([row]);
  });

  it("refuses duplicate identities and unknown label values before any model call", () => {
    const row = sample();
    expect(() => readCorrectionCases(jsonl(row) + jsonl(row))).toThrow("Duplicate case");
    expect(() => readCorrectionLabels(jsonl({ id: row.id, expected: "saved" }))).toThrow();
    expect(() => readCorrectionLabels(jsonl({ id: row.id, expected: "review" }).repeat(2))).toThrow(
      "Duplicate label",
    );
  });

  it("binds the frozen judgment and input content in the corpus fingerprint", () => {
    const row = sample();
    const labels = readCorrectionLabels(jsonl({ id: row.id, expected: "review" }));
    const original = corpusFingerprint([row], labels);
    expect(corpusFingerprint([row], labels)).toBe(original);
    expect(
      corpusFingerprint(
        [{ ...row, context: { ...row.context, latestReply: "Only this time." } }],
        labels,
      ),
    ).not.toBe(original);
    expect(
      corpusFingerprint([row], readCorrectionLabels(jsonl({ id: row.id, expected: "ordinary" }))),
    ).not.toBe(original);
  });

  it("keeps ablations explicit instead of presenting omitted context as complete", () => {
    const { context } = sample();
    expect(projectContext(context, "card")).toEqual(context);
    expect(projectContext(context, "card-only")).toEqual({
      ...context,
      preceding: [],
      unavailableContext: true,
    });
    expect(projectContext(context, "nearby")).toEqual({
      latestReply: context.latestReply,
      preceding: context.preceding,
      precedingSource: context.precedingSource,
      project: context.project,
      task: context.task,
      unavailableContext: true,
    });
    expect(projectContext(context, "reply")).toEqual({
      latestReply: context.latestReply,
      preceding: [],
      precedingSource: context.precedingSource,
      project: context.project,
      task: context.task,
      unavailableContext: true,
    });
  });

  it("rejects project-local private files and output aliases through symlinks", () => {
    const dir = scratchDir("correction-evaluation-paths-");
    const input = join(dir, "cases.jsonl");
    writeFileSync(input, jsonl(sample()));
    expect(privatePath(input)).toBe(realpathSync(input));
    expect(() => privatePath(join(REPO_ROOT, "package.json"))).toThrow("outside the project");
    const alias = join(dir, "project");
    symlinkSync(REPO_ROOT, alias);
    expect(() => privatePath(join(alias, "private-output.jsonl"), true)).toThrow(
      "outside the project",
    );
    const outside = join(dir, "reports");
    mkdirSync(outside);
    expect(privatePath(join(outside, "result.jsonl"), true)).toBe(
      join(realpathSync(outside), "result.jsonl"),
    );
  });
});

describe("bounded correction context", () => {
  it("keeps source relationship factual instead of treating recent conversation as the same thread", () => {
    const { context } = sample();
    const recent = { ...context, precedingSource: "recent-conversation" as const };
    expect(correctionState(recent, 10_000)?.facts.preceding_relationship).toBe(
      recent.precedingSource,
    );
    expect(correctionState(context, 10_000)?.facts.preceding_relationship).toBe(
      context.precedingSource,
    );
  });

  it("keeps both ends of a long card within its byte allowance without splitting Unicode or shortening the reply", () => {
    const { context } = sample();
    const opening = "Opening conditions: αβγ.\n";
    const closing = "\nClosing choice: keep this project only.";
    const original = opening + "Evidence paragraph.\n".repeat(100) + closing;
    const card = { title: "A long proposal", text: original };
    const budget = Math.floor(Buffer.byteLength(original) / 2);
    const bounded = excerptCorrectionCard({ ...context, addressedCard: card }, budget);
    const text = bounded.addressedCard?.text ?? "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
    expect(text.startsWith(opening)).toBe(true);
    expect(text.endsWith(closing)).toBe(true);
    expect(text.includes("\uFFFD")).toBe(false);
    expect(bounded.latestReply).toBe(context.latestReply);
    expect(bounded.unavailableContext).toBe(true);
    expect(card.text).toBe(original);
    expect(excerptCorrectionCard(context, 10_000)).toBe(context);
  });

  it("declares an unavailable card when the byte allowance cannot even carry the omission marker", () => {
    const { context } = sample();
    const bounded = excerptCorrectionCard(context, 1);
    expect(bounded.addressedCard).toBeUndefined();
    expect(bounded.unavailableContext).toBe(true);
    expect(bounded.latestReply).toBe(context.latestReply);
    expect(() => excerptCorrectionCard(context, 0)).toThrow("Invalid card");
  });
  it("omits the oldest exchange first and marks missing context without mutating its source", () => {
    const { context } = sample();
    const full = correctionState(context, 10_000);
    const bytes = Buffer.byteLength(JSON.stringify(full));
    const bounded = correctionState(context, bytes - 1);
    expect(bounded?.facts.preceding_exchange).toBe(JSON.stringify(context.preceding.slice(1)));
    expect(bounded?.facts.context_missing_or_omitted).toBe(true);
    expect(context.preceding).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(bytes);
  });

  it("omits an oversized card whole, preserving the captain's exact conditions and project", () => {
    const { context } = sample();
    const withoutCard = {
      ...context,
      preceding: [],
      addressedCard: undefined,
      unavailableContext: true,
    };
    const budget = Buffer.byteLength(JSON.stringify(correctionState(withoutCard, 10_000)));
    const state = correctionState({ ...context, preceding: [] }, budget);
    expect(state?.facts.addressed_card).toBeNull();
    expect(state?.facts.latest_captain_reply).toBe(context.latestReply);
    expect(state?.facts.project).toBe(JSON.stringify(context.project));
    expect(state?.facts.context_missing_or_omitted).toBe(true);
  });

  it("sends nothing rather than clipping a reply to fit an impossible byte budget", () => {
    const { context } = sample();
    expect(correctionState(context, Buffer.byteLength(context.latestReply) - 1)).toBeUndefined();
    expect(() => correctionState(context, 0)).toThrow("Invalid context");
  });
});
