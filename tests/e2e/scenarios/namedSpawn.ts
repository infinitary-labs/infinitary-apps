import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  type Scenario,
  type ScriptedCall,
  sinceLastUser,
} from "../mockProvider";

/**
 * New work on a model the captain names (FI3-444): each ask is one
 * spawn_crewmate carrying override_model_id - one the app serves, and one it
 * does not - and the answer it reads back says which model took the task.
 */
export const NAMED_SPAWN_ASK = "spawn the dial repair on the mock model";
export const NAMED_SPAWN_TITLE = "Repair the dial";
export const NAMED_SPAWN_MISSING_ASK = "spawn the needle repair on a model that is not here";
export const NAMED_SPAWN_MISSING_TITLE = "Repair the needle";
/** A model id the hermetic app's models.json does not define. */
export const NAMED_SPAWN_MISSING_MODEL_ID = "mock-9";

function namedSpawnFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes("[user]")) return undefined;
  const ask = user.slice(user.lastIndexOf("[user]"));
  const spawn = (
    title: string,
    words: string,
    model: string,
  ): { calls: ScriptedCall[] } | { text: string } =>
    results.length > 0
      ? { text: "Started it." }
      : {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title,
                goal: `${title}.`,
                user_words: words,
                shape: { override_model_id: model, rigor_ask: "quick" },
              },
            },
          ],
        };
  if (ask.includes(NAMED_SPAWN_ASK)) {
    return spawn(NAMED_SPAWN_TITLE, NAMED_SPAWN_ASK, `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`);
  }
  if (ask.includes(NAMED_SPAWN_MISSING_ASK)) {
    return spawn(
      NAMED_SPAWN_MISSING_TITLE,
      NAMED_SPAWN_MISSING_ASK,
      `${MOCK_PROVIDER_ID}/${NAMED_SPAWN_MISSING_MODEL_ID}`,
    );
  }
  return undefined;
}

/** The first mate spawns each repair on the model the captain names. */
export const namedSpawn: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    isFirstmate && wantsStream ? namedSpawnFirstmateMove(body) : undefined;
