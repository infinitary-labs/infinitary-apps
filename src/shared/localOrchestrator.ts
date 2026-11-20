import { z } from "zod";

/**
 * The dev-only local-model orchestrator seat (roadmap 1.7; captain
 * decisions 2026-09-21; `docs/local-orchestrator.md` is the one home): the
 * Settings-side shape of the same choice the environment variables make.
 * The core resolves the seat and refuses every write on a packaged build,
 * so `available` is what the window renders the section on - false, and
 * there is no control at all. Nothing here reaches a shipped build's
 * surface; the words are the dev checkout's.
 */

export const localOrchestratorSettingSchema = z.strictObject({
  /** On: the Firstmate seat moves to the endpoint below; crewmates route as usual. */
  enabled: z.boolean(),
  /** An OpenAI-compatible base URL, e.g. Ollama's `http://localhost:11434/v1`. */
  baseUrl: z.string(),
  /** The model id the endpoint serves, e.g. `qwen3:8b`. */
  model: z.string(),
});
export type LocalOrchestratorSetting = z.infer<typeof localOrchestratorSettingSchema>;

export const DEFAULT_LOCAL_ORCHESTRATOR_SETTING: LocalOrchestratorSetting = {
  enabled: false,
  baseUrl: "http://localhost:11434/v1",
  model: "",
};

/** Who asked for the seat: the Settings row, or the environment (a headless run). */
export const localOrchestratorSourceSchema = z.enum(["setting", "environment"]);
export type LocalOrchestratorSource = z.infer<typeof localOrchestratorSourceSchema>;

export const localOrchestratorViewSchema = z.strictObject({
  /** False on a packaged build: the section does not render and a write is refused. */
  available: z.boolean(),
  setting: localOrchestratorSettingSchema,
  /** The seat the core resolved and built, or null when the Firstmate is on its usual model. */
  active: z
    .strictObject({
      model: z.string(),
      host: z.string(),
      source: localOrchestratorSourceSchema,
    })
    .nullable(),
  /** Why an enabled setting seats nothing (a bad URL, a blank model); null otherwise. */
  problem: z.string().nullable(),
});
export type LocalOrchestratorView = z.infer<typeof localOrchestratorViewSchema>;

/** The section's one line: why the row seats nothing, where the seat is, or what the switch does. */
export function localSeatDescription(view: LocalOrchestratorView): string {
  if (view.problem) return view.problem;
  const active = view.active;
  if (active?.source === "setting") {
    return `Your first mate runs on ${active.model} at ${active.host}; crewmates route as usual. A change binds at the next idle moment.`;
  }
  if (active?.source === "environment") {
    return `Set by the environment for this run: ${active.model} at ${active.host}. Turn this on to use the fields below instead.`;
  }
  return "Only this dev checkout: the first mate's seat alone moves to the endpoint below; crewmates route as usual. A packaged build has no such control.";
}
