import type { Scenario } from "../mockProvider";

/**
 * A crewmate still working when the person updates a copy run from source
 * (source-update.spec.ts): its turn is held open, the model still working,
 * so the update has running work to save before it asks the starter.
 */
export const SOURCE_UPDATE_WORK_MARKER = "keep working while this copy updates from main";

export const sourceUpdateWork: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    !isFirstmate && wantsStream && body.includes(SOURCE_UPDATE_WORK_MARKER)
      ? { held: true }
      : undefined;
