import { HELD_WORK_WORDS } from "../../../src/core/orchestrator/reportWakes";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { calledTool, sinceLastUser, spawnedTaskOf } from "../providerRequest";

/**
 * A hold on a task's finding ends when that task reports it (INF-735, from
 * INF-720's Fix 2). Hermetic replay, not a claim that a live model obeys:
 * the captain's words have the first mate start a reader and a rerun held
 * on the reader's finding through a recorded wait, then ask the reader what
 * it found. The reader puts a decision card up before it reports, so its
 * report is the captain's turn and, before INF-735, woke no one. The
 * stand-in first mate follows the report wake's words: it passes the
 * finding on and ends the wait, and the rerun reports that it resumed.
 */
export const FINDING_RELAY_PROMPT = "exercise a finding relay";
export const READER_TITLE = "Read the iPad phone failure";
export const HELD_TITLE = "Rerun the iPad phone check";
export const READER_CARD_TITLE = "Hold the iPad rerun until the failure is read";
/** What the reader reports: INF-621's finding, the one PR #184 waited on. */
export const FINDING =
  "The verdict remains the captured native readiness race and a controlled rerun, not an Escape-code rewrite.";
/** How the rerun's report opens once it carries on with the finding. */
export const RESUMED = "Resumed with the finding:";
/** Each crewmate is told apart by its own goal, which only its brief carries. */
const READER_GOAL = "Read why the iPad phone check failed, for the finding relay journey.";
const HELD_GOAL =
  "Rerun the iPad phone check once its failure is read, for the finding relay journey.";
const ASK = "Report what you found in the iPad failure.";

const taskOf = (result: string | undefined) => spawnedTaskOf(result) ?? "missing";
const report = (text: string): ScenarioAnswer => ({ calls: [{ name: "report", args: { text } }] });

export const findingRelay: Scenario = () => {
  /** The rerun's task, from its spawn: the first mate steers it by id. */
  let held = "missing";
  return ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!wantsStream) return undefined;
    const { user, results } = sinceLastUser(body);
    if (isFirstmate) {
      if (user.includes("[user]") && user.includes(FINDING_RELAY_PROMPT)) {
        const reader = taskOf(results[0]);
        const spawn = (title: string, goal: string): ScenarioAnswer => ({
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title,
                goal,
                user_words: FINDING_RELAY_PROMPT,
                shape: { rigor_ask: "quick" },
              },
            },
          ],
        });
        if (results.length === 0) return spawn(READER_TITLE, READER_GOAL);
        if (results.length === 1) return spawn(HELD_TITLE, HELD_GOAL);
        held = taskOf(results[1]);
        // The practical wait the first mate's own instructions record.
        if (results.length === 2)
          return {
            calls: [{ name: "link_tasks", args: { from: reader, to: held, type: "blocks" } }],
          };
        if (results.length === 3)
          return { calls: [{ name: "steer_crewmate", args: { task_id: reader, message: ASK } }] };
        return { text: "Started the rerun behind the reading." };
      }
      // The report wake names the rerun held on the reader: pass the
      // finding on and end the wait, as its words say.
      if (!user.includes(HELD_WORK_WORDS) || !user.includes(FINDING)) return undefined;
      const reader = user.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
      if (results.length === 0)
        return {
          calls: [
            {
              name: "steer_crewmate",
              args: { task_id: held, message: `The reading is in: ${FINDING}` },
            },
          ],
        };
      if (results.length === 1)
        return {
          calls: [
            {
              name: "link_tasks",
              args: { from: reader, to: held, type: "blocks", remove: true },
            },
          ],
        };
      return { text: "Passed the finding on to the rerun." };
    }
    if (body.includes(HELD_GOAL)) {
      if (calledTool(latestUserTail, "report")) return { text: "Reported." };
      return latestUserTail.includes(FINDING)
        ? report(`${RESUMED} ${FINDING}`)
        : report("Holding until the iPad failure is read.");
    }
    if (!body.includes(READER_GOAL)) return undefined;
    if (!calledTool(body, "emit_card"))
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: READER_CARD_TITLE,
              body: "<p>I am reading the iPad failure before the rerun goes out.</p>",
              actions: [
                { id: "hold", label: "Keep it held", default: true },
                { id: "release", label: "Rerun now" },
              ],
            },
          },
        ],
      };
    if (calledTool(latestUserTail, "report")) return { text: "Reported." };
    return latestUserTail.includes(ASK)
      ? report(FINDING)
      : report("Reading the iPad failure log while my card asks about the rerun.");
  };
};
