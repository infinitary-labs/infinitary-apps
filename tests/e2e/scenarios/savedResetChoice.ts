import { SAVED_RESET_QUESTION } from "../../../src/core/codex/autoSavedResets";
import type { Scenario } from "../mockProvider";

/**
 * The saved-reset question (INF-5478's plan, piece 2; docs/quota.md "Saved
 * resets on their own"), answered `use` by the person's own model as a real
 * one would for a session allowance that refills hours from now. Its opening
 * line is read from its owner, so the stand-in knows the question by it.
 */
const OPENING = SAVED_RESET_QUESTION.instructions.split("\n")[0] ?? "";

export const savedResetChoice: Scenario =
  () =>
  ({ body }) =>
    OPENING !== "" && body.includes(OPENING) ? { text: "use" } : undefined;
