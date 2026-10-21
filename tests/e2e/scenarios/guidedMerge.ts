import { GUIDANCE_MARK_WORDS } from "../../../src/core/orchestrator/wakes";
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
import { KEPT_MERGE_ON_CLAUDE } from "./keptMerge";

/**
 * Hermetic replay for FI3-662, not a claim that a live model obeys: the
 * captain's guidance holds his kept merge until the crewmate declares its
 * impact. After the click is kept on a conflict, the captain asks through
 * the Firstmate, whose steer in his turn is his guidance; the crewmate
 * brings the change up to date, declares the repair and asks him back on a
 * card without declaring the guidance, so the merge waits. His reply under
 * that card is guidance too: the crewmate declares the newest mark it read
 * as none, and the host merges. Words carrying KEPT_MERGE_ON_CLAUDE pin the
 * spawn to CLAUDE_CREW_MODEL.
 */
export const GUIDED_MERGE_MARKER = "hold a kept merge for guidance";
export const GUIDED_MERGE_TITLE = "feat: hold the merge for guidance";
export const GUIDED_MERGE_CARD = GUIDED_MERGE_TITLE;
export const GUIDED_MERGE_QUESTION = "Rename the guided file?";
/** The captain's ask in the main input: the Firstmate steers it to the crewmate in his turn. */
export const GUIDED_MERGE_ASK = `${GUIDED_MERGE_MARKER}: ask whether to rename the file`;
/** The captain's reply under the crewmate's question card. */
export const GUIDED_MERGE_ANSWER = `${GUIDED_MERGE_MARKER}: keep its name`;
// e2e-typed-words: the mock Firstmate's own steer, relaying the captain's ask
const GUIDED_MERGE_STEER = `${GUIDED_MERGE_MARKER} - the captain asks whether the file should be renamed`;

export const guidedMerge: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? guidedMergeMove(body, isFirstmate) : undefined;

function guidedMergeMove(body: string, firstmate: boolean): ScenarioAnswer | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes(GUIDED_MERGE_MARKER)) return undefined;
  const onClaude = user.includes(`${GUIDED_MERGE_MARKER} ${KEPT_MERGE_ON_CLAUDE}`);
  const title = `meterlab ${GUIDED_MERGE_MARKER}${onClaude ? ` ${KEPT_MERGE_ON_CLAUDE}` : ""}`;
  const taskId =
    indexTaskId(body, title) ??
    indexTaskId(body, `meterlab ${GUIDED_MERGE_MARKER} ${KEPT_MERGE_ON_CLAUDE}`) ??
    findCrewTaskId(body, GUIDED_MERGE_MARKER) ??
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
                  title,
                  goal: "Hold a kept merge for the captain's guidance",
                  user_words: GUIDED_MERGE_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "quick",
                    skipped_plan_because: "Guided kept-merge reproduction; implementation fixture",
                    ...(onClaude ? { override_model_id: CLAUDE_CREW_MODEL } : {}),
                  },
                },
              },
            ],
          };
    // The captain's own words: relayed to the crewmate in his turn.
    if (user.includes(GUIDED_MERGE_ASK))
      return results.length
        ? { text: "Asked the crewmate." }
        : {
            calls: [
              { name: "steer_crewmate", args: { task_id: taskId, message: GUIDED_MERGE_STEER } },
            ],
          };
    // The kept click's settle wake and the crewmate's reports: nothing to steer.
    return { text: "Noted; nothing for the captain." };
  }
  if (user.includes(GUIDED_MERGE_ANSWER)) {
    // The newest mark the steer named, read after the words the app wrote it with.
    const mark = Number(
      user
        .split(GUIDANCE_MARK_WORDS)
        .at(-1)
        ?.match(/^ (\d+)/)?.[1] ?? 0,
    );
    if (!results.length)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              captainGuidance: {
                mark,
                impact: "none",
                evidence:
                  "The captain kept the file's name, so the change stays as he approved it.",
              },
            },
          },
        ],
      };
    if (results.length === 1)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `${GUIDED_MERGE_MARKER}: the captain kept the name; declared that his guidance leaves the approved change as it was.`,
            },
          },
        ],
      };
    return { text: "Declared." };
  }
  if (user.includes(GUIDED_MERGE_STEER)) {
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
                impact: "conflict-only",
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
    // It asks the captain back rather than deciding: his question stays open.
    if (results.length === 2)
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: GUIDED_MERGE_QUESTION,
              body: "<p>Should the guided file get a new name?</p><p>I brought the change up to date and kept the name you approved.</p>",
              asking: true,
              actions: [
                { id: "keep", label: "Keep the name", default: true },
                { id: "rename", label: "Rename it" },
              ],
            },
          },
        ],
      };
    if (results.length === 3)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `${GUIDED_MERGE_MARKER}: brought up to date; the captain decides whether the file gets a new name.`,
              waiting_on_captain: { reason: "Whether the guided file gets a new name" },
            },
          },
        ],
      };
    return { text: "Asked." };
  }
  const steps: ScriptedCall[] = [
    {
      name: "bash",
      args: {
        command: `printf 'guided\\n' > guided.txt && git add guided.txt && git commit -m "${GUIDED_MERGE_TITLE}" && git rev-parse main HEAD`,
      },
    },
    prepareMockStory(GUIDED_MERGE_CARD, results[0], {
      ...MOCK_GITHUB_STORY,
      why: ["A kept merge should wait for the captain's newest words."],
      whatChanged: ["Added the guided file."],
      before: ["A reply did not hold the merge."],
    }),
    {
      name: "open_change",
      args: { title: GUIDED_MERGE_TITLE, presentation: preparedRevision(results.join("\n")) },
    },
    { name: "check_change", args: {} },
    {
      name: "emit_card",
      args: {
        title: GUIDED_MERGE_CARD,
        presentation: preparedRevision(results.join("\n")),
        actions: [
          { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
        ],
      },
    },
    {
      name: "report",
      args: { text: `${GUIDED_MERGE_MARKER}: the change is ready and its completion card is up.` },
    },
  ];
  const next = steps[results.length];
  return next ? { calls: [next] } : { text: "Ready." };
}
