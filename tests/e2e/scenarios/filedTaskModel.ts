import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "../mockModels";
import type { Scenario } from "../mockProvider";
import { lookUpTask, sinceLastUser } from "../providerRequest";

/**
 * A task filed earlier starts on the model the captain names (FI3-436): the
 * file ask records a parent and its on-request child with create_task; the
 * start ask names the model on that same row with update_task
 * override_model_id and starts it in the same call - never a replacement.
 */
export const FILED_MODEL_FILE_ASK = "file the gauge calibration for later";
export const FILED_MODEL_START_ASK = "start the gauge calibration on the mock model";
export const FILED_MODEL_PARENT = "Gauge work";
export const FILED_MODEL_TITLE = "Calibrate the gauge";

function filedModelFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes("[user]")) return undefined;
  const ask = user.slice(user.lastIndexOf("[user]"));
  if (ask.includes(FILED_MODEL_FILE_ASK)) {
    const parentKey = results[0]?.match(/Planned ([A-Z0-9]+-\d+)/)?.[1];
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: FILED_MODEL_PARENT,
              goal: `${FILED_MODEL_PARENT}.`,
              user_words: FILED_MODEL_FILE_ASK,
            },
          },
        ],
      };
    }
    if (results.length === 1 && parentKey) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: FILED_MODEL_TITLE,
              goal: "The gauge reads true.",
              user_words: FILED_MODEL_FILE_ASK,
              parent: parentKey,
            },
          },
        ],
      };
    }
    return { text: "Filed." };
  }
  if (ask.includes(FILED_MODEL_START_ASK)) {
    return (
      lookUpTask(FILED_MODEL_TITLE, results, (task) => [
        {
          name: "update_task",
          args: {
            task,
            override_model_id: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
            start_now: true,
          },
        },
      ]) ?? { text: "Started it on the model you named." }
    );
  }
  return undefined;
}

/** The first mate files the calibration, then starts it on the named model. */
export const filedTaskModel: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    isFirstmate && wantsStream ? filedModelFirstmateMove(body) : undefined;
