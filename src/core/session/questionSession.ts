import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "../orchestrator/seat";
import { LOCAL_MACHINE_ID, type SessionBinding, type SessionSpec } from "./session";

/**
 * The question role: one bounded question's session, as options on the one
 * session contract (`src/core/session/`), opened by the question walk
 * (`questionTurns.ts`) for the adapted decision model's one word, for a
 * question set it asks together (one line per question) and for a
 * program's JSON answer. One bounded question,
 * answered once, by a session that can reach nothing - no built-ins, no
 * tools, no record - on the question's own instruction, served byte for
 * byte, so a verdict recorded months ago still says which question was
 * asked. One model turn, one retry at most; the walk's wall clock stays
 * outside the session. Pi caps a single choice's output at a word's
 * allowance; a set asked together and a JSON answer are not capped.
 * Claude's output includes hidden thinking that cannot always be disabled,
 * so its client chooses the allowance, as it does for a JSON answer.
 */
export function questionSessionSpec(input: {
  /** A neutral cwd (the firstmate home); the session reads nothing. */
  homeDir: string;
  binding: SessionBinding;
  /** The shopped cheap model (LOW slot first, never premium). */
  model: { provider: string; id: string };
  instruction: string;
  /**
   * A JSON answer (a program's ask(), INF-799): its length is the answer's
   * own, so the model's own output ceiling bounds it, not a word's.
   */
  json?: boolean;
  /** A question set answered one line per question: its length is its own too. */
  set?: boolean;
}): SessionSpec {
  return {
    machine: LOCAL_MACHINE_ID,
    owner: FIRSTMATE_SESSION_ID,
    cwd: input.homeDir,
    binding: input.binding,
    model: input.model,
    // Fixed low effort: a decision is a cheap call by design.
    thinking: { level: "low" },
    instructions: { base: input.instruction },
    builtins: "none",
    tools: [],
    shape: { turns: "one" },
    bounds: {
      request: {
        // INF-1451: Sonnet can spend the entire word-only cap on hidden
        // thinking even when asked to disable it, leaving no answer text.
        ...(input.json || input.set || input.binding.backend === "claude"
          ? {}
          : { maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS }),
        maxModelTurns: 1,
        retries: 1,
      },
    },
  };
}
