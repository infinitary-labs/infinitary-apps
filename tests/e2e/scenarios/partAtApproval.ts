import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type Scenario, type ScenarioAnswer, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { contextRepos, sinceLastUser } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";
import { mergeShellCall, mergeShellTurn } from "./mergeShell";

/**
 * Hermetic replay for a chain of plan parts that each start when the part
 * before it is approved to merge (INF-4517 piece 3, and INF-5269's plan,
 * part 2: every dependency on batched pull requests, with no mark), not a
 * claim that a live model obeys: one prompt has the first mate start the
 * first part, file the second as a when-ready part blocked by it, the
 * third blocked by both, and a release blocked by the first that needs it
 * merged. No dependency carries a start mark. Each part's crewmate commits
 * one file, prepares its story, confirms it with open_change, reads its
 * pushed branch's checks and puts up its merge card. A later part's shell
 * first requires every earlier part's file, so it builds only in a working
 * copy on the approved version under it, and gives that version as its
 * story's base. The release's crewmate is not scripted. Nothing here
 * merges: the journey presses each card, and the app combines the approved
 * changes.
 */
export const PART_AT_APPROVAL_MARKER = "exercise a part at approval";

export const PARTS = ["first", "second", "third"] as const;
export type Part = (typeof PARTS)[number];

/** The prompt that starts the first part and files the second behind it, in `project`. */
export const partAtApprovalPrompt = (project: string) =>
  `${SPAWN_PROMPT_MARKER} ${project} ${PART_AT_APPROVAL_MARKER}`;

/** A part's task title, as the first mate files it. */
export const partTask = (project: string, part: Part) =>
  `${project} ${PART_AT_APPROVAL_MARKER} ${part}`;

/** The release's task title: it needs the first part merged, not only its code. */
export const releaseTask = (project: string) => `${project} release the meter`;

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
  // A later part's brief names the part under it too: the latest part it names is its own.
  const part: Part =
    [...PARTS].reverse().find((name) => user.includes(`${PART_AT_APPROVAL_MARKER} ${name}`)) ??
    "first";
  const title = partTitle(part);
  // A later part needs every earlier part's file: without them the command fails and no story follows.
  const earlier = PARTS.slice(0, PARTS.indexOf(part));
  const command = [
    ...earlier.map((name) => `test -f ${name}.txt`),
    `printf '${part}\\n' > ${part}.txt && git add ${part}.txt && git commit -m "${title}"`,
    part === "first" ? "git rev-parse main HEAD" : "git rev-parse HEAD~1 HEAD",
  ].join(" && ");
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
  const first = /(?:Recorded|Queued) task (\S+);/.exec(results[0] ?? "")?.[1] ?? "missing";
  const second = /Planned (\S+) /.exec(results[1] ?? "")?.[1] ?? "missing";
  // No dependency carries a start mark: on batched pull requests each starts at the approval.
  const filings = [
    { ...intent("second"), blocked_by: [first] },
    { ...intent("third"), blocked_by: [first, second] },
    {
      title: releaseTask(project),
      goal: "Release the meter",
      user_words: "release the meter",
      repo_id: repoId,
      blocked_by: [first],
      needs_merge: [first],
    },
  ];
  const filing = filings[results.length - 1];
  if (filing)
    return { calls: [{ name: "create_task", args: { ...filing, start_policy: "when-ready" } }] };
  return { text: "Filed." };
}
