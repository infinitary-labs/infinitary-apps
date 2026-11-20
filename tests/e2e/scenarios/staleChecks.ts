import { CHECK_OBSERVATIONS_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type Scenario, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { contextRepos, findCrewTaskId, indexTaskId, sinceLastUser } from "../providerRequest";

/** A completion card whose checks change on GitHub after it went up. */
export const STALE_CHECKS_MARKER = "exercise stale check strip";
export const STALE_CHECKS_CARD = "The stale strip change is ready";
export const STALE_CHECKS_REFUSAL = "Resource not accessible by integration";

function staleChecksMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (
    !firstmate &&
    (user.includes(CHECK_OBSERVATIONS_LEAD) || user.includes(STALE_CHECKS_REFUSAL)) &&
    body.includes(STALE_CHECKS_MARKER)
  ) {
    if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
    if (results.length === 1)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: "The current check facts were refreshed; the merge offer remains on its card.",
              waiting_on_captain: {
                reason: "The existing merge choice is still on its card.",
              },
            },
          },
        ],
      };
    return { text: "The changed check facts are recorded." };
  }
  if (!user.includes(STALE_CHECKS_MARKER)) return undefined;
  const taskId =
    indexTaskId(body, `meterlab ${STALE_CHECKS_MARKER}`) ??
    findCrewTaskId(body, STALE_CHECKS_MARKER) ??
    "missing";
  if (firstmate) {
    if (user.includes(SPAWN_PROMPT_MARKER))
      return results.length
        ? { text: "Opened." }
        : {
            calls: [
              {
                name: "spawn_crewmate",
                args: {
                  title: `meterlab ${STALE_CHECKS_MARKER}`,
                  goal: "Ship a change whose checks later fail",
                  user_words: STALE_CHECKS_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "standard",
                    skipped_plan_because: "Bounded check-refresh fixture",
                  },
                },
              },
            ],
          };
    if (user.includes(`${STALE_CHECKS_MARKER} read`))
      return results.length
        ? { text: "Read the checks." }
        : { calls: [{ name: "crew_status", args: { task_id: taskId } }] };
    return { text: "Noted." };
  }
  if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
  if (results.length === 1)
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: STALE_CHECKS_CARD,
            body: completionCardBody(
              "<p>The captain asked for this change.</p>",
              "<p>Changed the meter.</p>",
              "<p>The meter was wrong.</p>",
              '<p>The meter is right now.</p><figure aria-label="Checks pass"><svg viewBox="0 0 510 50" width="100%"><rect x="5" y="5" width="500" height="40" rx="8" fill="var(--ok-dim)"/><text x="20" y="30" fill="var(--fg-1)">Every current check passed</text></svg></figure>',
            ),
            actions: [
              {
                id: "merge-it",
                label: "Merge it",
                default: true,
                effect: { kind: "merge", after: "close" },
              },
            ],
          },
        },
      ],
    };
  if (results.length === 2)
    return {
      calls: [
        {
          name: "report",
          args: {
            text: "The change passed its checks; the completion decision is up.",
            waiting_on_captain: { reason: "the completion decision is up" },
          },
        },
      ],
    };
  return { text: "Waiting on the captain." };
}

/** The stale check strip, for the first mate and for its crewmate. */
export const staleChecks: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? staleChecksMove(body, isFirstmate) : undefined;
