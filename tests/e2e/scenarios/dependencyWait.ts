import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * FI3-250's hermetic replay, not a claim that a live model obeys: the
 * captain's words (`DEPENDENCY_WAIT_PROMPT`, then the key of the work to
 * wait on) have the Firstmate start a crewmate and link that work as its
 * blocker; the crewmate reports the wait. The work it waits on carries
 * `DEPENDENCY_WAIT_MARKER` in its title, so the host's steer when that work
 * closes names it, and the resumed crewmate reports what the steer said.
 */
export const DEPENDENCY_WAIT_PROMPT = "exercise a dependency wait";
export const DEPENDENCY_WAIT_MARKER = "shared fixture fix";
export const DEPENDENCY_WAIT_TITLE = "Ship the gauge";
/** The waiting crewmate's report while it waits, and the start of its report once the wait ends. */
export const DEPENDENCY_WAIT_REPORT = "Waiting for the fixture fix to merge first.";
export const DEPENDENCY_RESUMED_REPORT = "Resumed after the wait ended:";

function dependencyWaitMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (firstmate) {
    if (!user.includes("[user]") || !user.includes(DEPENDENCY_WAIT_PROMPT)) return undefined;
    const owner = user.split(DEPENDENCY_WAIT_PROMPT)[1]?.match(/[A-Z0-9]+-\d+/)?.[0] ?? "missing";
    if (results.length === 0)
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: DEPENDENCY_WAIT_TITLE,
              goal: `Ship the gauge once ${owner} lands.`,
              user_words: `${DEPENDENCY_WAIT_PROMPT} on ${owner}`,
              shape: { rigor_ask: "quick" },
            },
          },
        ],
      };
    const spawned = results[0]?.match(/on task ([\w-]+)/)?.[1] ?? "missing";
    if (results.length === 1)
      return {
        calls: [{ name: "link_tasks", args: { from: owner, to: spawned, type: "blocks" } }],
      };
    return { text: "Started it behind the fixture fix." };
  }
  if (user.includes(DEPENDENCY_WAIT_MARKER)) {
    return results.length
      ? { text: "Reported." }
      : {
          calls: [
            {
              name: "report",
              args: { text: `${DEPENDENCY_RESUMED_REPORT} ${user.trim().split("\n").at(-1)}` },
            },
          ],
        };
  }
  if (!user.includes(DEPENDENCY_WAIT_PROMPT)) return undefined;
  return results.length
    ? { text: "Reported." }
    : {
        calls: [{ name: "report", args: { text: DEPENDENCY_WAIT_REPORT } }],
      };
}

/** The dependency wait, for the first mate and for the crewmate that waits. */
export const dependencyWait: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? dependencyWaitMove(body, isFirstmate) : undefined;
