import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type Scenario, type ScenarioAnswer, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { contextRepos, sinceLastUser } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";
import { mergeShellCall, mergeShellTurn } from "./mergeShell";

/**
 * Hermetic replay for INF-3759 piece 1, batches of the captain's own, not a
 * claim that a live model obeys: one prompt has the first mate start a
 * crewmate for each named change of a project. Each crewmate commits one
 * file, prepares its story, confirms it with open_change (which opens no
 * pull request where the project gets batches of its own), reads its
 * pushed branch's checks and puts up its merge card. Nothing here merges:
 * the journey presses each card, and the app combines the approved changes.
 */
export const OWN_BATCH_MARKER = "exercise a batch of my own";

/** The prompt that starts one crewmate per named change in `project`. */
export const ownBatchPrompt = (project: string, changes: readonly string[]) =>
  `${SPAWN_PROMPT_MARKER} ${project} ${OWN_BATCH_MARKER} ${changes.join(" ")}`;

/** A change's task title, as the first mate starts it. */
export const ownBatchTask = (project: string, change: string) =>
  `${project} ${OWN_BATCH_MARKER} ${change}`;

/** A change's checked title: its merge card's title and its commit's subject in a batch. */
export const ownBatchTitle = (change: string) => `fix(${change}): keep the ${change} file`;

/**
 * The words each change's story says under What changed, before their full
 * stop: a host's description writes punctuation in its own escaped form.
 */
export const ownBatchChanged = (change: string) => `The ${change} file is kept with the meter`;

export const ownBatch: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? ownBatchMove(body, isFirstmate) : undefined;

function ownBatchMove(body: string, firstmate: boolean): ScenarioAnswer | undefined {
  const { user, results, pending } = firstmate
    ? { ...sinceLastUser(body), pending: false }
    : mergeShellTurn(body, OWN_BATCH_MARKER);
  if (!user.includes(OWN_BATCH_MARKER)) return undefined;
  if (pending) return { text: "" };
  if (firstmate) {
    if (!user.includes(SPAWN_PROMPT_MARKER)) return undefined;
    if (results.length) return { text: "Opened." };
    const asked = user.slice(user.indexOf(SPAWN_PROMPT_MARKER) + SPAWN_PROMPT_MARKER.length);
    const [project = "", rest = ""] = asked.trim().split(` ${OWN_BATCH_MARKER} `);
    const repoId = contextRepos(body).find(([name]) => name === project)?.[1];
    return {
      calls: rest
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((change) => ({
          name: "spawn_crewmate",
          args: {
            title: ownBatchTask(project, change),
            goal: `Keep the ${change} file`,
            user_words: `${OWN_BATCH_MARKER} ${change}`,
            repo_id: repoId,
            shape: {
              rigor_ask: "quick",
              skipped_plan_because: "Own-batch reproduction; implementation fixture",
            },
          },
        })),
    };
  }
  const change = new RegExp(`${OWN_BATCH_MARKER} ([a-z]+)`).exec(user)?.[1] ?? "change";
  const title = ownBatchTitle(change);
  const steps: ScriptedCall[] = [
    mergeShellCall(
      body,
      `printf '${change}\\n' > ${change}.txt && git add ${change}.txt && git commit -m "${title}" && git rev-parse main HEAD`,
    ),
    prepareMockStory(title, results[0], {
      ...MOCK_GITHUB_STORY,
      why: [`The ${change} file should travel with the meter.`],
      whatChanged: [`${ownBatchChanged(change)}.`],
      before: [`The meter had no ${change} file.`],
      after: [`The meter keeps its ${change} file.`],
    }),
    {
      name: "open_change",
      args: { title, presentation: preparedRevision(results.join("\n")) },
    },
    { name: "check_change", args: {} },
    {
      name: "emit_card",
      args: {
        title,
        presentation: preparedRevision(results.join("\n")),
        actions: [
          { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
        ],
      },
    },
    {
      name: "report",
      args: {
        text: `${OWN_BATCH_MARKER} ${change}: the change is ready and its merge card is up.`,
      },
    },
  ];
  const next = steps[results.length];
  return next ? { calls: [next] } : { text: "Ready." };
}
