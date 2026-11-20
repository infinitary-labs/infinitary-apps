import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type Scenario, type ScenarioAnswer, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { contextRepos, sinceLastUser } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";
import { mergeShellCall, mergeShellTurn } from "./mergeShell";

/**
 * Hermetic replay for INF-4517 piece 3, a plan part that starts when the
 * part before it is approved to merge, not a claim that a live model
 * obeys: one prompt has the first mate start the first part and file the
 * second as a when-ready part blocked by it and marked to start at its
 * approval. Each crewmate commits one file, prepares its story, confirms it
 * with open_change, reads its pushed branch's checks and puts up its merge
 * card. The second part's shell first requires the first part's file, so it
 * builds only in a working copy on the first part's approved version, and
 * gives that version as its story's base. Nothing here merges: the journey
 * presses each card, and the app combines the approved changes.
 */
export const PART_AT_APPROVAL_MARKER = "exercise a part at approval";

export const PARTS = ["first", "second"] as const;
export type Part = (typeof PARTS)[number];

/** The prompt that starts the first part and files the second behind it, in `project`. */
export const partAtApprovalPrompt = (project: string) =>
  `${SPAWN_PROMPT_MARKER} ${project} ${PART_AT_APPROVAL_MARKER}`;

/** A part's task title, as the first mate files it. */
export const partTask = (project: string, part: Part) =>
  `${project} ${PART_AT_APPROVAL_MARKER} ${part}`;

/** A part's checked title: its merge card's title and its commit's subject. */
export const partTitle = (part: Part) => `feat(${part}): add the ${part} part`;

export const partAtApproval: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? partMove(body, isFirstmate) : undefined;

function partMove(body: string, firstmate: boolean): ScenarioAnswer | undefined {
  const { user, results, pending } = firstmate
    ? { ...sinceLastUser(body), pending: false }
    : mergeShellTurn(body, PART_AT_APPROVAL_MARKER);
  if (!user.includes(PART_AT_APPROVAL_MARKER)) return undefined;
  if (pending) return { text: "" };
  if (firstmate) return firstmateMove(body, user, results);
  const part: Part = user.includes(`${PART_AT_APPROVAL_MARKER} second`) ? "second" : "first";
  const title = partTitle(part);
  // The second part needs the first part's file: without it the command fails and no story follows.
  const command =
    part === "first"
      ? `printf 'first\\n' > first.txt && git add first.txt && git commit -m "${title}" && git rev-parse main HEAD`
      : `test -f first.txt && printf 'second\\n' > second.txt && git add second.txt && git commit -m "${title}" && git rev-parse HEAD~1 HEAD`;
  const steps: ScriptedCall[] = [
    mergeShellCall(body, command),
    prepareMockStory(title, results[0], {
      ...MOCK_GITHUB_STORY,
      why: [`The meter needs its ${part} part.`],
      whatChanged: [`The meter has its ${part} part.`],
      before: [`The meter had no ${part} part.`],
      after: [`The meter has its ${part} part.`],
    }),
    { name: "open_change", args: { title, presentation: preparedRevision(results.join("\n")) } },
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
        text: `${PART_AT_APPROVAL_MARKER} ${part}: the change is ready and its merge card is up.`,
      },
    },
  ];
  const next = steps[results.length];
  return next ? { calls: [next] } : { text: "Ready." };
}

function firstmateMove(body: string, user: string, results: string[]): ScenarioAnswer | undefined {
  if (!user.includes(SPAWN_PROMPT_MARKER)) return undefined;
  const asked = user.slice(user.indexOf(SPAWN_PROMPT_MARKER) + SPAWN_PROMPT_MARKER.length);
  const project = asked.trim().split(` ${PART_AT_APPROVAL_MARKER}`)[0] ?? "";
  const repoId = contextRepos(body).find(([name]) => name === project)?.[1];
  const intent = (part: Part) => ({
    title: partTask(project, part),
    goal: `Add the ${part} part`,
    user_words: `${PART_AT_APPROVAL_MARKER} ${part}`,
    repo_id: repoId,
  });
  if (results.length === 0)
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            ...intent("first"),
            shape: {
              rigor_ask: "quick",
              skipped_plan_because: "Part-at-approval reproduction; implementation fixture",
            },
          },
        },
      ],
    };
  if (results.length === 1) {
    const first = /(?:Recorded|Queued) task (\S+);/.exec(results[0] ?? "")?.[1] ?? "missing";
    return {
      calls: [
        {
          name: "create_task",
          args: {
            ...intent("second"),
            blocked_by: [first],
            start_policy: "when-ready",
            start_at_approval: first,
          },
        },
      ],
    };
  }
  return { text: "Filed." };
}
