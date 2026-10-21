import {
  CLAUDE_CREW_MODEL,
  contextRepos,
  findCrewTaskId,
  indexTaskId,
  type Scenario,
  type ScenarioAnswer,
  type ScriptedCall,
  SPAWN_PROMPT_MARKER,
  sinceLastUser,
} from "../mockProvider";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * Hermetic replay for FI3-304, not a claim that a live model obeys: one
 * captain click survives GitHub's conflict refusal. The crewmate commits,
 * opens its pull request, reads its checks and puts up its completion
 * card; after the refusal the Firstmate steers it to bring the branch up
 * to date, and it rebases, declares the repair with check_change
 * conflictRepair from the heads git printed, and reports - the host merges.
 * The same script drives a Pi crewmate and a Claude one: words carrying
 * KEPT_MERGE_ON_CLAUDE pin the spawn to CLAUDE_CREW_MODEL (FI3-664).
 */
export const KEPT_MERGE_MARKER = "exercise a kept merge";
export const KEPT_MERGE_ON_CLAUDE = "on Claude";
export const KEPT_MERGE_TITLE = "feat: keep the merge click";
export const KEPT_MERGE_CARD = KEPT_MERGE_TITLE;
// e2e-typed-words: the mock's own steer to the kept-merge crewmate; it only shares a phrase with the product's
const KEPT_MERGE_REPAIR = `${KEPT_MERGE_MARKER} bring it up to date`;

export const keptMerge: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? keptMergeMove(body, isFirstmate) : undefined;

function keptMergeMove(body: string, firstmate: boolean): ScenarioAnswer | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes(KEPT_MERGE_MARKER)) return undefined;
  const onClaude = user.includes(`${KEPT_MERGE_MARKER} ${KEPT_MERGE_ON_CLAUDE}`);
  const title = `meterlab ${KEPT_MERGE_MARKER}${onClaude ? ` ${KEPT_MERGE_ON_CLAUDE}` : ""}`;
  const taskId = indexTaskId(body, title) ?? findCrewTaskId(body, KEPT_MERGE_MARKER) ?? "missing";
  if (firstmate) {
    if (user.includes(SPAWN_PROMPT_MARKER))
      return results.length
        ? { text: "Opened." }
        : {
            calls: [
              {
                name: "spawn_crewmate",
                args: {
                  title,
                  goal: "Exercise a kept merge",
                  user_words: KEPT_MERGE_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "quick",
                    skipped_plan_because: "Kept-merge reproduction; implementation fixture",
                    ...(onClaude ? { override_model_id: CLAUDE_CREW_MODEL } : {}),
                  },
                },
              },
            ],
          };
    // The settle wake says the click is kept: steer the repair, ask nothing.
    if (user.includes("do not ask the captain to merge again")) {
      return results.length
        ? { text: "The repair is steered; the captain's click stands." }
        : {
            calls: [
              { name: "steer_crewmate", args: { task_id: taskId, message: KEPT_MERGE_REPAIR } },
            ],
          };
    }
    return { text: "Noted; nothing for the captain." };
  }
  if (user.includes(KEPT_MERGE_REPAIR)) {
    if (!results.length)
      return {
        calls: [
          {
            name: "bash",
            args: {
              command:
                "git rev-parse HEAD && git rebase main >/dev/null 2>&1 && git rev-parse main HEAD",
            },
          },
        ],
      };
    if (results.length === 1) {
      const [fromHead, newBase, toHead] = (results[0]?.match(/\b[0-9a-f]{40}\b/g) ?? []) as (
        | string
        | undefined
      )[];
      return {
        calls: [
          {
            name: "check_change",
            args: {
              conflictRepair: {
                fromHead: fromHead ?? "missing",
                toHead: toHead ?? "missing",
                newBase: newBase ?? "missing",
                impact: "none",
                changedPaths: [],
                evidence:
                  "git range-diff shows the one approved commit unchanged on the newer main",
                validation: "the change's own check at the rebased head",
              },
            },
          },
        ],
      };
    }
    if (results.length === 2)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `${KEPT_MERGE_MARKER}: brought up to date with main and declared impact none; the host merges on the captain's kept click.`,
            },
          },
        ],
      };
    return { text: "Brought up to date." };
  }
  const steps: ScriptedCall[] = [
    {
      name: "bash",
      args: {
        command: `printf 'kept\\n' > kept.txt && git add kept.txt && git commit -m "${KEPT_MERGE_TITLE}" && git rev-parse main HEAD`,
      },
    },
    prepareMockStory(KEPT_MERGE_CARD, results[0], {
      ...MOCK_GITHUB_STORY,
      why: ["A merge click should survive a conflict refusal."],
      whatChanged: ["Added the kept file."],
      before: ["The click bought one attempt."],
    }),
    {
      name: "open_change",
      args: { title: KEPT_MERGE_TITLE, presentation: preparedRevision(results.join("\n")) },
    },
    { name: "check_change", args: {} },
    {
      name: "emit_card",
      args: {
        title: KEPT_MERGE_CARD,
        presentation: preparedRevision(results.join("\n")),
        actions: [
          { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
        ],
      },
    },
    {
      name: "report",
      args: { text: `${KEPT_MERGE_MARKER}: the change is ready and its completion card is up.` },
    },
  ];
  const next = steps[results.length];
  return next ? { calls: [next] } : { text: "Ready." };
}
