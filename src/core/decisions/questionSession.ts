import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "../orchestrator/seat";
import { LOCAL_MACHINE_ID, type SessionBinding, type SessionSpec } from "../session/session";

/**
 * The question role: the adapted decision model's session, as options on
 * the one session contract (`src/core/session/`). One bounded question,
 * answered once, by a session that can reach nothing - no built-ins, no
 * tools, no record - on the question's own instruction, served byte for
 * byte, so a verdict recorded months ago still says which question was
 * asked. Its bounds are the same whichever backend answers: a word of
 * output (or a JSON answer's own length), one model turn, one retry at most. The adapter's wall clock stays
 * outside the session, with the adapter.
 */
export function questionSessionSpec(input: {
  /** A neutral cwd (the firstmate home); the session reads nothing. */
  homeDir: string;
  binding: SessionBinding;
  /** The shopped cheap model (LOW slot first, never premium). */
  model: { provider: string; id: string };
  /** The question's own system instruction. */
  instruction: string;
  /**
   * A JSON answer (a program's ask(), INF-799): its length is the answer's
   * own, so the model's own output ceiling bounds it, not a word's.
   */
  json?: boolean;
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
        ...(input.json ? {} : { maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS }),
        maxModelTurns: 1,
        retries: 1,
      },
    },
  };
}
