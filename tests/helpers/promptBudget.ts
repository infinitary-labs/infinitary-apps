import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OLLAMA_MIN_CONTEXT } from "../../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE } from "../../src/core/pi/ollamaStream";

/**
 * The one measurement of the prompt budgets (docs/orchestrator-contract.md,
 * "The fixed-context budget"; docs/testing.md, "The prompt budget's two
 * lines"). Both fixed-context tests and `scripts/prompt-budget.ts` read it.
 *
 * Each budget is derived from the smallest local window; only the captain
 * raises one, when a trim finds that what every task needs no longer fits.
 * The captain raised the first mate's by half when the first trim under
 * "How a trim works" found its always-needed rules over the budget, and kept
 * a crewmate's.
 * INF-2930's plan, which the captain approved ("fail only if we exceed budget
 * by a lot (say 50%), and anything lower than that result in a follow up trim
 * task not blocking release"), gives it two lines: the tests fail past the
 * hard line, one and a half times a crewmate's budget and a quarter over the
 * first mate's raised one, and the prompt-budget check on main fails past the
 * budget itself, which files one trim task.
 */

/** The window left once the reserve for the answer is taken. */
const WINDOW_AFTER_RESERVE = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE;

/**
 * A crewmate's budget: the conversation is promised at least as much room as
 * the fixed part takes, so it is half of what the window leaves after the
 * reserve.
 */
export const CREWMATE_BUDGET = WINDOW_AFTER_RESERVE / 2;

/**
 * The first mate's budget before the raise: the window less ten status
 * blocks of the size FI3-539 recorded (2,938 tokens) and the 4,096 recent
 * tokens shortening always keeps, which is 19,772.
 */
const FIRSTMATE_DERIVED_BUDGET = WINDOW_AFTER_RESERVE - (10 * 2_938 + 4_096);

/** The captain's raise of the first mate's budget, by half. */
export const FIRSTMATE_BUDGET = Math.floor(FIRSTMATE_DERIVED_BUDGET * 1.5);

/** The conversation the smallest local window still promises the first mate. */
export const FIRSTMATE_PROMISED_CONVERSATION = WINDOW_AFTER_RESERVE - FIRSTMATE_BUDGET;

/** The captain's "exceed budget by a lot (say 50%)". */
const HARD_LINE_FACTOR = 1.5;

/**
 * A raised budget's hard line sits a quarter over it, as the approved plan's
 * raise said, so the smallest local window keeps room for a conversation.
 */
export const RAISED_HARD_LINE_FACTOR = 1.25;

/** A trim aims here (docs/orchestrator-contract.md, "How a trim works"). */
const TRIM_TARGET_FACTOR = 0.9;

export function trimTarget(budget: number): number {
  return Math.floor(budget * TRIM_TARGET_FACTOR);
}

export function hardLine(budget: number, factor = HARD_LINE_FACTOR): number {
  return Math.floor(budget * factor);
}

/** The conversation the smallest local window still holds when the fixed part reaches the hard line. */
export function roomAtHardLine(budget: number, factor = HARD_LINE_FACTOR): number {
  return WINDOW_AFTER_RESERVE - hardLine(budget, factor);
}

type Counted = { systemPrompt: string; tools: unknown };

/** Each fixed part counted since the last `overLine`, while `SERVED_TEXT_OUT` is set. */
const counted: Counted[] = [];

/** The app's own count of a fixed part (`localInputFits`): characters / 4. */
export function fixedTokens(context: Counted): number {
  if (process.env.SERVED_TEXT_OUT)
    counted.push({ systemPrompt: context.systemPrompt, tools: context.tools });
  return Math.ceil((context.systemPrompt.length + JSON.stringify(context.tools).length) / 4);
}

/**
 * Which line a run holds. The tests hold the hard line; the prompt-budget
 * check sets `PROMPT_BUDGET_LINE=budget` and holds the budget itself.
 */
export function failingLine(budget: number, factor = HARD_LINE_FACTOR): number {
  return process.env.PROMPT_BUDGET_LINE === "budget" ? budget : hardLine(budget, factor);
}

export type Reading = { label: string; tokens: number };

/**
 * With `SERVED_TEXT_OUT` set, writes the text behind each reading to that
 * folder as `<seat>.json` for `scripts/served-sentences.ts`. Each budget test
 * counts its readings, in order, just before it hands them here, so the last
 * `readings.length` counted parts are those readings. The pairing is by order
 * because tests written before this hook pass only labels and counts, and the
 * script reads older versions through them.
 */
function writeServed(seat: string, readings: Reading[]): void {
  const out = process.env.SERVED_TEXT_OUT;
  if (!out) return;
  const parts = counted.splice(0).slice(-readings.length);
  if (parts.length !== readings.length)
    throw new Error(`${seat}: ${readings.length} readings but ${parts.length} counted parts`);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${seat}.json`),
    JSON.stringify(readings.map((row, index) => ({ label: row.label, ...parts[index] }))),
  );
}

export function overLine(
  seat: string,
  budget: number,
  readings: Reading[],
  factor = HARD_LINE_FACTOR,
): string[] {
  writeServed(seat, readings);
  const line = failingLine(budget, factor);
  console.info(`${seat} fixed context`, {
    budget,
    trimTarget: trimTarget(budget),
    hardLine: hardLine(budget, factor),
    rows: readings.map((row) => ({ ...row, room: budget - row.tokens })),
  });
  return readings
    .filter((row) => row.tokens > line)
    .map(
      (row) =>
        `${seat} ${row.label} reads ${row.tokens} tokens: budget ${budget}, hard line ${hardLine(budget, factor)}`,
    );
}
