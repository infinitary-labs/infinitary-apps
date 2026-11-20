import { OLLAMA_MIN_CONTEXT } from "../../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE } from "../../src/core/pi/ollamaStream";

/**
 * The one measurement of the prompt budgets (docs/orchestrator-contract.md,
 * "The fixed-context budget"; docs/testing.md, "The prompt budget's two
 * lines"). Both fixed-context tests and `scripts/prompt-budget.ts` read it.
 *
 * Each budget is derived from the smallest local window and never raised.
 * INF-2930's plan, which the captain approved ("fail only if we exceed budget
 * by a lot (say 50%), and anything lower than that result in a follow up trim
 * task not blocking release"), gives it two lines: the tests fail past the
 * hard line, one and a half times the budget, and the prompt-budget check on
 * main fails past the budget itself, which files one trim task.
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
 * The conversation the window promises the first mate: ten status blocks of
 * the size FI3-539 recorded (2,938 tokens), plus the 4,096 recent tokens
 * shortening always keeps.
 */
export const FIRSTMATE_PROMISED_CONVERSATION = 10 * 2_938 + 4_096;

/** The first mate's budget: what the window leaves after the reserve and that conversation. */
export const FIRSTMATE_BUDGET = WINDOW_AFTER_RESERVE - FIRSTMATE_PROMISED_CONVERSATION;

/** The captain's "exceed budget by a lot (say 50%)". */
const HARD_LINE_FACTOR = 1.5;

/** Where a budget test fails: one and a half times the budget. */
export function hardLine(budget: number): number {
  return Math.floor(budget * HARD_LINE_FACTOR);
}

/** The conversation the smallest local window still holds when the fixed part reaches the hard line. */
export function roomAtHardLine(budget: number): number {
  return WINDOW_AFTER_RESERVE - hardLine(budget);
}

/** The app's own count of a fixed part (`localInputFits`): characters / 4. */
export function fixedTokens(context: { systemPrompt: string; tools: unknown }): number {
  return Math.ceil((context.systemPrompt.length + JSON.stringify(context.tools).length) / 4);
}

/**
 * Which line a run holds. The tests hold the hard line; the prompt-budget
 * check sets `PROMPT_BUDGET_LINE=budget` and holds the budget itself.
 */
export function failingLine(budget: number): number {
  return process.env.PROMPT_BUDGET_LINE === "budget" ? budget : hardLine(budget);
}

export type Reading = { label: string; tokens: number };

/** Prints every reading, and names each one past the line this run holds. */
export function overLine(seat: string, budget: number, readings: Reading[]): string[] {
  const line = failingLine(budget);
  console.info(`${seat} fixed context`, {
    budget,
    hardLine: hardLine(budget),
    rows: readings.map((row) => ({ ...row, room: budget - row.tokens })),
  });
  return readings
    .filter((row) => row.tokens > line)
    .map(
      (row) =>
        `${seat} ${row.label} reads ${row.tokens} tokens: budget ${budget}, hard line ${hardLine(budget)}`,
    );
}
