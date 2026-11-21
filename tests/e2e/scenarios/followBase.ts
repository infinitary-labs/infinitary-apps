import { GUIDANCE_MARK_WORDS } from "../../../src/core/orchestrator/wakes";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type Scenario, type ScenarioAnswer, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { contextRepos, providerMessages, sinceLastUser } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";
import { mergeShellCall, mergeShellTurn } from "./mergeShell";

/**
 * Hermetic replay for a chain of three parts that follow the part under
 * them (INF-5269's plan, part 3), not a claim that a live model obeys. One
 * prompt has the first mate start the first part and file the second and
 * third behind it on batched pull requests, so each starts at the approval
 * of the part under it. Each part's crewmate commits one file, prepares its
 * story, confirms it with open_change, reads its checks and puts up its
 * merge card; a later part's shell first requires every earlier part's
 * file.
 *
 * Then the moves this part of the plan is about, each on a steer:
 * - The first part, told by the journey that the default branch moved,
 *   brings its branch up to date and declares that repair with check_change
 *   conflictRepair, impact none, under the captain's kept approval; the
 *   journey's words are the captain's, so it also declares they leave the
 *   approved change as it was.
 * - A part told that the part under it is approved at a newer version
 *   (the `base-moved` steer) replays its own commits onto that version with
 *   the versions the steer names. Under a kept approval (the second part)
 *   it declares that repair onto the newer version; without one (the third
 *   part) it first offers its merge card at the old version, which the host
 *   refuses, then shows a new story and merge card at the replayed version.
 * Nothing here merges: the journey presses each card, and the app combines
 * the approved changes.
 */
export const FOLLOW_BASE_MARKER = "exercise following the part under it";

export const CHAIN = ["first", "second", "third"] as const;
export type ChainPart = (typeof CHAIN)[number];

/** The prompt that starts the first part and files the rest behind it, in `project`. */
export const followBasePrompt = (project: string) =>
  `${SPAWN_PROMPT_MARKER} ${project} ${FOLLOW_BASE_MARKER}`;

/** A part's task title, as the first mate files it. */
export const chainTask = (project: string, part: ChainPart) =>
  `${project} ${FOLLOW_BASE_MARKER} ${part}`;

/** A part's checked title: its merge card's title and its commit's subject. */
export const chainTitle = (part: ChainPart) => `feat(${part}): add the ${part} part`;

/** A part's merge card id, so a new version revises the card in place. */
export const chainCardId = (part: ChainPart) => `merge-${part}-part`;

/** The journey's words to the first part's crewmate: the default branch moved. */
export const BRING_FIRST_UP_TO_DATE = `${FOLLOW_BASE_MARKER}: the default branch moved, bring the first part up to date`;

export const followBase: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) =>
    wantsStream ? chainMove(body, isFirstmate) : undefined;

/** The part a crewmate builds: the last part its brief names, since a later part's brief names the one under it. */
function ownPart(body: string): ChainPart {
  const brief = providerMessages(body).find(
    (message) => message.role === "user" && message.text.includes(FOLLOW_BASE_MARKER),
  );
  return (
    [...CHAIN].reverse().find((name) => brief?.text.includes(`${FOLLOW_BASE_MARKER} ${name}`)) ??
    "first"
  );
}

function chainMove(body: string, firstmate: boolean): ScenarioAnswer | undefined {
  const { user, results, pending } = firstmate
    ? { ...sinceLastUser(body), pending: false }
    : mergeShellTurn(body, FOLLOW_BASE_MARKER);
  if (!user.includes(FOLLOW_BASE_MARKER)) return undefined;
  if (pending) return { text: "" };
  if (firstmate) return firstmateMove(body, user, results);
  const part = ownPart(body);
  // The base-moved steer names the newer version and the one the branch builds on.
  const moved = /approved to merge at ([0-9a-f]{40}), a newer version than ([0-9a-f]{40})/.exec(
    user,
  );
  const steps = moved
    ? followSteps(body, user, part, results, moved[1] as string, moved[2] as string)
    : user.includes(BRING_FIRST_UP_TO_DATE)
      ? upToDateSteps(body, user, results)
      : buildSteps(body, part, results);
  const next = steps[results.length];
  return next ? { calls: [next] } : { text: "Ready." };
}

/** The versions a shell's `git rev-parse` printed, in order. */
const versions = (reading: string | undefined) => reading?.match(/[0-9a-f]{40}/g) ?? [];

/** Prepare, publish and offer the part's change at its current version. */
function offerSteps(body: string, part: ChainPart, results: string[], reading: string | undefined) {
  const title = chainTitle(part);
  return [
    prepareMockStory(title, reading, {
      ...MOCK_GITHUB_STORY,
      why: [`The meter needs its ${part} part.`],
      whatChanged: [`The meter has its ${part} part.`],
      before: [`The meter had no ${part} part.`],
      after: [`The meter has its ${part} part.`],
    }),
    { name: "open_change", args: { title, presentation: preparedRevision(results.join("\n")) } },
    { name: "check_change", args: {} },
    mergeCard(part, preparedRevision(results.join("\n"))),
  ] satisfies ScriptedCall[];
}

function mergeCard(part: ChainPart, presentation: number): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      id: chainCardId(part),
      title: chainTitle(part),
      presentation,
      actions: [
        { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
      ],
    },
  };
}

function report(text: string): ScriptedCall {
  return { name: "report", args: { text: `${FOLLOW_BASE_MARKER}: ${text}` } };
}

/** The part's first build: one file of its own on the approved version under it. */
function buildSteps(body: string, part: ChainPart, results: string[]): ScriptedCall[] {
  const earlier = CHAIN.slice(0, CHAIN.indexOf(part));
  const command = [
    ...earlier.map((name) => `test -f ${name}.txt`),
    `printf '${part}\\n' > ${part}.txt && git add ${part}.txt && git commit -m "${chainTitle(part)}"`,
    part === "first" ? "git rev-parse main HEAD" : "git rev-parse HEAD~1 HEAD",
  ].join(" && ");
  return [
    mergeShellCall(body, command),
    ...offerSteps(body, part, results, results[0]),
    report(`the ${part} part is ready and its merge card is up.`),
  ];
}

/** A kept approval's repair onto the newer default branch, declared with impact none. */
function upToDateSteps(body: string, user: string, results: string[]): ScriptedCall[] {
  const [from, to, base] = versions(results[0]);
  const mark = Number(
    user
      .split(GUIDANCE_MARK_WORDS)
      .at(-1)
      ?.match(/^ (\d+)/)?.[1] ?? 0,
  );
  return [
    mergeShellCall(body, "git rebase main && git rev-parse ORIG_HEAD HEAD main"),
    {
      name: "check_change",
      args: {
        conflictRepair: {
          fromHead: from ?? "",
          toHead: to ?? "",
          newBase: base ?? "",
          impact: "none",
          changedPaths: [],
          evidence: "Brought the first part up to date with the default branch; no conflicts.",
          validation: "Read the first file at the new version.",
        },
      },
    },
    {
      name: "check_change",
      args: {
        captainGuidance: {
          mark,
          impact: "none",
          evidence: "The captain asked for the update itself; the approved change stays as it was.",
        },
      },
    },
    report("the first part is up to date under the kept approval."),
  ];
}

/** Replay only the part's own commits onto the newer version the steer names. */
function followSteps(
  body: string,
  user: string,
  part: ChainPart,
  results: string[],
  to: string,
  from: string,
): ScriptedCall[] {
  // The replay the steer itself names, so the part follows the host's own words.
  const replay = /, then (git rebase [^)]+)\)/.exec(user)?.[1] ?? "false";
  if (part === "second") {
    // Under the captain's kept approval: declare the replay as a repair onto that version.
    const [old, replayed] = versions(results[0]);
    return [
      mergeShellCall(body, `${replay} && git rev-parse ORIG_HEAD HEAD`),
      {
        name: "check_change",
        args: {
          conflictRepair: {
            fromHead: old ?? "",
            toHead: replayed ?? "",
            newBase: to,
            impact: "none",
            changedPaths: [],
            evidence:
              "Replayed only the second part's own commit onto the first part's newer version.",
            validation: "Read the second file at the new version.",
          },
        },
      },
      report("the second part follows the first part's newer version."),
    ];
  }
  // No approval yet: the card at the old version first, then the replayed version's.
  return [
    mergeCard(part, preparedRevision(body)),
    mergeShellCall(body, `${replay} && git rev-parse HEAD`),
    // The story keeps its first base, the version the part started on.
    ...offerSteps(body, part, results, `${from} ${versions(results[1]).at(-1) ?? ""}`),
    report(`the ${part} part follows the part under it and its merge card is up.`),
  ];
}

function firstmateMove(body: string, user: string, results: string[]): ScenarioAnswer | undefined {
  if (!user.includes(SPAWN_PROMPT_MARKER)) return undefined;
  const asked = user.slice(user.indexOf(SPAWN_PROMPT_MARKER) + SPAWN_PROMPT_MARKER.length);
  const project = asked.trim().split(` ${FOLLOW_BASE_MARKER}`)[0] ?? "";
  const repoId = contextRepos(body).find(([name]) => name === project)?.[1];
  const intent = (part: ChainPart) => ({
    title: chainTask(project, part),
    goal: `Add the ${part} part`,
    user_words: `${FOLLOW_BASE_MARKER} ${part}`,
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
              skipped_plan_because: "Follow-base reproduction; implementation fixture",
            },
          },
        },
      ],
    };
  const first = /(?:Recorded|Queued) task (\S+);/.exec(results[0] ?? "")?.[1] ?? "missing";
  const second = /Planned (\S+) /.exec(results[1] ?? "")?.[1] ?? "missing";
  const filings = [
    { ...intent("second"), blocked_by: [first] },
    { ...intent("third"), blocked_by: [first, second] },
  ];
  const filing = filings[results.length - 1];
  if (filing)
    return { calls: [{ name: "create_task", args: { ...filing, start_policy: "when-ready" } }] };
  return { text: "Filed." };
}
