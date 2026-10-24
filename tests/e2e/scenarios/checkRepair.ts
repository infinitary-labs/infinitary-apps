import { completionCardBody } from "../../helpers/completionCard";
import {
  contextRepos,
  findCrewTaskId,
  indexTaskId,
  type Scenario,
  type ScriptedCall,
  SPAWN_PROMPT_MARKER,
  sinceLastUser,
} from "../mockProvider";

/** Hermetic instruction/host replay for FI3-237, not a claim that a live model obeys. */
export const CI_REPAIR_MARKER = "exercise diagnosed check failures";
export const CI_REPAIR_OWNER = "ci-baseline-owner";
export const CI_REPAIR_CARD = "The diagnosed change is ready";
export const CI_REPAIR_HEADS = ["baseline-one", "baseline-two", "flake-head"] as const;

function checkRepairMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes(CI_REPAIR_MARKER)) return undefined;
  const taskId =
    indexTaskId(body, `meterlab ${CI_REPAIR_MARKER}`) ??
    findCrewTaskId(body, CI_REPAIR_MARKER) ??
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
                  title: `meterlab ${CI_REPAIR_MARKER}`,
                  goal: "Exercise diagnosed failures",
                  user_words: CI_REPAIR_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "standard",
                    skipped_plan_because:
                      "Existing check-repair reproduction; implementation fixture",
                  },
                },
              },
            ],
          };
    if (user.includes("needs diagnosis")) {
      if (results.length === 0)
        return { calls: [{ name: "crew_status", args: { task_id: taskId } }] };
      if (results.length === 1)
        return {
          calls: [
            {
              name: "steer_crewmate",
              args: { task_id: taskId, message: `${CI_REPAIR_MARKER} diagnose ${results[0]}` },
            },
          ],
        };
      return { text: "Diagnosis requested without a captain card." };
    }
    if (
      user.includes("[user]") &&
      (user.includes(`${CI_REPAIR_MARKER} read`) || user.includes(`${CI_REPAIR_MARKER} finish`))
    ) {
      return results.length
        ? { text: "Continued." }
        : {
            calls: [
              {
                name: "steer_crewmate",
                args: {
                  task_id: taskId,
                  message: `${CI_REPAIR_MARKER} ${user.includes(`${CI_REPAIR_MARKER} finish`) ? "finish" : "read"}`,
                },
              },
            ],
          };
    }
    if (user.includes("reported on task")) {
      // FI3-671: a wait on work nobody has started is started that turn.
      const unstarted = user.match(/It waits on ([\w-]+) "[^"]*" \(not started\)/)?.[1];
      if (unstarted && results.length === 0)
        return { calls: [{ name: "update_task", args: { task: unstarted, start_now: true } }] };
      // Routine waits are not decisions.
      return { text: "The separate owner and wait remain recorded; no captain decision needed." };
    }
    return undefined;
  }
  const card: ScriptedCall = {
    name: "emit_card",
    args: {
      title: CI_REPAIR_CARD,
      body: completionCardBody(
        "<p>A failed check needs a diagnosis before another repair.</p>",
        "<p>Repaired the diagnosed regression.</p>",
        "<p>The checks failed on the previous version.</p>",
        '<p>The diagnosed change is ready without an extra failure decision.</p><figure aria-label="Checks pass"><svg viewBox="0 0 510 50" width="100%"><rect x="5" y="5" width="500" height="40" rx="8" fill="var(--ok-dim)"/><text x="20" y="30" fill="var(--fg-1)">Every current check passed</text></svg></figure>',
      ),
      // The merge alone, unlabeled, as the crewmate is told: the host
      // attaches the completion buttons and their words (FI3-249).
      actions: [{ id: "put-in", default: true, effect: { kind: "settle", mode: "merge" } }],
    },
  };
  if (user.includes(`${CI_REPAIR_MARKER} finish`)) {
    if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
    if (results.length === 1) return { calls: [card] };
    return results.length === 2
      ? {
          calls: [
            {
              name: "report",
              args: {
                text: "The diagnosed change passed every current check and its completion decision is ready.",
              },
            },
          ],
        }
      : { text: "Completion recorded." };
  }
  if (user.includes(`${CI_REPAIR_MARKER} diagnose`)) {
    const headSha = CI_REPAIR_HEADS.find((head) => user.includes(head)) ?? "missing";
    const flake = headSha === CI_REPAIR_HEADS[2];
    if (!results.length)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              diagnosis: {
                headSha,
                check: "linux-checks",
                classification: flake ? "suspected-flake" : "baseline-blocked",
                evidence: flake
                  ? "Failed standalone timeout log differs from the same-head successful verification"
                  : "Separate owner reproduced the same failed assertion on untouched main, with log evidence",
                ...(flake ? { changedTest: false } : { dependencyTask: CI_REPAIR_OWNER }),
              },
            },
          },
        ],
      };
    if (flake && results.length === 1)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              rerun: {
                headSha,
                check: "linux-checks",
                evidence: "Successful same-head verification and failed-job timeout log",
              },
            },
          },
        ],
      };
    // Try premature completion to exercise the actual card gate on failed checks.
    if (flake && results.length === 2) return { calls: [card] };
    if (results.length === (flake ? 3 : 1))
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `${CI_REPAIR_MARKER} ${flake ? "rerun reserved; completion correctly refused until all checks pass" : "waiting for the evidenced separate baseline owner"}`,
            },
          },
        ],
      };
    return { text: "Waiting." };
  }
  if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
  if (results.length === 1) {
    // It names the version it read, as a crewmate does: two failures at
    // two versions are two reports, never one repeated wake.
    const head = CI_REPAIR_HEADS.find((h) => results[0]?.includes(h)) ?? "the current version";
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${CI_REPAIR_MARKER} needs diagnosis at ${head}; failed step and logs recorded for the next move`,
          },
        },
      ],
    };
  }
  return { text: "Reported." };
}

/** The diagnosed check failures, for the first mate and for its crewmate. */
export const checkRepair: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? checkRepairMove(body, isFirstmate) : undefined;
