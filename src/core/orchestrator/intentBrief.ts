import { folderRefreshWords } from "@shared/folderRefresh";
import { type HoldOverride, reviewerOverrideWords } from "@shared/holds";
import type { LiveValidation } from "@shared/liveValidation";
import type { RepoDelivery } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import {
  type Deliverable,
  type InPlaceFacts,
  type InPlacePull,
  isAnswerKind,
  type WorkKind,
} from "@shared/routingPolicy";
import { CAREFUL_LIVE_VALIDATION } from "../prompts/liveValidation";
import { RESULT_WORDS, resultText } from "../tasks/taskResult";
import { type ReviewHistoryEntry, renderReviewHistory } from "./reviewHistory";

/**
 * spawn_crewmate v2's structured intent and its fixed rendering (contract
 * v1, spec sections 1.3 and 4.3): the orchestrator no longer authors the
 * crewmate's brief - it passes a goal, the user's words verbatim, typed
 * constraints, and an optional delivery note, and THE HOST renders them
 * into the crewmate's first message as this fixed template. No model writes
 * the template; the crewmate self-briefs from it on its first turn.
 */

/** The constraint kinds a spawn may name today. */
export type SpawnConstraintKind =
  | "read-only"
  | "operation"
  | "tests-required"
  | "no-new-deps"
  | "minimal-diff"
  | "free";

/**
 * A kind the vocabulary retired: never produced by `parseSpawnIntent`, but a
 * stored intent written before it retired still names it.
 */
export type RetiredConstraintKind = "plan-first";

export type SpawnConstraint = {
  kind: SpawnConstraintKind | RetiredConstraintKind;
  text?: string;
};

/**
 * What the ask is about beyond "project work": `personal-ui` (talk-to-
 * personalize Step 4) is an ask about the user's own panels on the rails.
 * The host binds it to the personal workspace, the one repository whose
 * kind is `personal`; the Firstmate names no repo for it.
 */
export type SpawnIntentKind = "personal-ui";

export type SpawnIntent = {
  goal: string;
  userWords: string;
  constraints?: SpawnConstraint[];
  deliveryNote?: string;
  kind?: SpawnIntentKind;
};

/**
 * Constraint kinds the vocabulary no longer offers, with the canonical
 * sentence they carried. `plan-first` retired at contract 4.6 into a plan
 * step of its own (docs/sequences.md); a recorded spawn or a stored intent
 * that names it still reads, as a free constraint saying the same thing.
 */
const RETIRED_CONSTRAINT_TEXT: Record<RetiredConstraintKind, string> = {
  "plan-first":
    "plan first: present your plan as a decision card with the option you would take as its default, and wait for the choice before changing anything",
};

/** The typed constraint vocabulary's canonical sentences (v1 seed list). */
const CONSTRAINT_TEXT: Record<Exclude<SpawnConstraintKind, "free">, string> = {
  "read-only":
    "read-only: find the answer without changing anything - commit nothing, push nothing, open no pull request",
  operation: "operation: make and verify the named effect; commit nothing and open no pull request",
  "tests-required": "tests required: the work must add or extend tests for its stated intent",
  "no-new-deps": "no new dependencies",
  "minimal-diff": "minimal diff: the smallest change that meets the goal",
};

/** Fail-loud validation at the tool boundary; returns the normalized intent. */
export function parseSpawnIntent(input: {
  goal: string;
  user_words: string;
  constraints?: { kind: string; text?: string }[];
  delivery_note?: string;
  kind?: string;
}): SpawnIntent {
  const goal = input.goal.trim();
  if (!goal) throw new Error("goal is required: one sentence saying what done looks like.");
  const userWords = input.user_words.trim();
  if (!userWords) throw new Error("user_words is required: the user's request verbatim.");
  const constraints = (input.constraints ?? []).map((constraint): SpawnConstraint => {
    const retired = Object.hasOwn(RETIRED_CONSTRAINT_TEXT, constraint.kind)
      ? RETIRED_CONSTRAINT_TEXT[constraint.kind as RetiredConstraintKind]
      : undefined;
    if (retired) {
      const qualifier = constraint.text?.trim();
      return { kind: "free", text: qualifier ? `${retired} (${qualifier})` : retired };
    }
    const kind = constraint.kind as SpawnConstraintKind;
    if (!(kind in CONSTRAINT_TEXT) && kind !== "free") {
      throw new Error(
        `Unknown constraint kind "${constraint.kind}". Use read-only, operation, tests-required, no-new-deps, minimal-diff, or free.`,
      );
    }
    const text = constraint.text?.trim();
    if (kind === "free" && !text) {
      throw new Error('A "free" constraint needs its text.');
    }
    return { kind, ...(text ? { text } : {}) };
  });
  assertDeliverableConstraints({ goal, userWords, constraints });
  const deliveryNote = input.delivery_note?.trim();
  if (input.kind !== undefined && input.kind !== "personal-ui") {
    throw new Error(`Unknown intent kind "${input.kind}". Use personal-ui, or omit it.`);
  }
  return {
    goal,
    userWords,
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(deliveryNote ? { deliveryNote } : {}),
    ...(input.kind === "personal-ui" ? { kind: "personal-ui" as const } : {}),
  };
}

const DELIVERY_TEXT: Record<RepoDelivery, string> = {
  "direct-pr":
    "direct-pr - finished work is pushed and opened as a pull request where the project lives (git push, then open_change). If the rest needs this merged first, file it as Continue: …, name it in your report, and finish with the completion decision",
  "local-only": "local-only - work merges on a local branch and never leaves the machine",
};

/**
 * The personal workspace's additions (talk-to-personalize Step 4, report
 * section 5.3 step 3): where the workspace is, which skills to start from, the
 * tools that check a panel, and the surfaces that already exist - so a change
 * resolves to the extension it is about. Every crewmate's session already
 * carries the workspace's AGENTS.md and lists the skills under
 * `.claude/skills/` (FI3-789, `src/core/session/projectResources.ts`), so
 * this names the two to start from rather than listing them again.
 */
export type PersonalBriefFacts = {
  ongoing?: boolean;
  workspaceDir: string;
  surfaces: { id: string; title: string; placement: { x: "left" | "right" } }[];
};

/**
 * The fixed template. Order and wording are host-owned: the user's words
 * marked verbatim-and-outranking, then the goal, then constraints, then the
 * delivery posture plus note, then - on the personal workspace - the
 * workspace facts. A task on the personal workspace has no delivery at all:
 * it builds in place, so `delivery` is undefined and the line is not
 * written.
 */
/** The project whose own folder declared folder work works in (INF-567). */
export type FolderBriefFacts = { project: string; folder: string };

const USER_WORDS_PRECEDENCE =
  "The user's words, verbatim - these outrank every elaboration below, including your own:";

/** Amend only a host-rendered goal, never matching a goal line inside verbatim words.
 * Keep goal-first stored briefs and follow-up provenance from before INF-1369 readable.
 */
export function amendBriefGoal(
  brief: string,
  previousGoal: string,
  nextGoal: string,
  userWords?: string,
): string {
  const openings = [
    ...(userWords === undefined ? [] : [`${USER_WORDS_PRECEDENCE}\n${userWords}\n\nGoal: `]),
    "Goal: ",
  ];
  for (const opening of openings) {
    const prefix = `${opening}${previousGoal}`;
    if (brief === prefix || brief.startsWith(`${prefix}\n`)) {
      return `${opening}${nextGoal}${brief.slice(prefix.length)}`;
    }
  }
  return brief;
}

export function renderIntentBrief(
  intent: SpawnIntent,
  delivery: RepoDelivery | undefined,
  personal?: PersonalBriefFacts,
  folder?: FolderBriefFacts,
): string {
  const lines: string[] = [USER_WORDS_PRECEDENCE, intent.userWords, "", `Goal: ${intent.goal}`, ""];
  if (intent.constraints && intent.constraints.length > 0) {
    lines.push("Constraints:");
    for (const constraint of intent.constraints) {
      if (constraint.kind === "free") {
        lines.push(`- ${constraint.text}`);
      } else {
        // A row stored before a kind retired still names it.
        const canonical =
          constraint.kind === "plan-first"
            ? RETIRED_CONSTRAINT_TEXT[constraint.kind]
            : CONSTRAINT_TEXT[constraint.kind];
        lines.push(`- ${canonical}${constraint.text ? ` (${constraint.text})` : ""}`);
      }
    }
    lines.push("");
  }
  if (delivery) {
    lines.push(`Delivery: ${DELIVERY_TEXT[delivery]}.`);
    if (intent.deliveryNote) {
      lines.push(`Delivery note: ${intent.deliveryNote}`);
    }
  }
  if (personal) {
    // One blank line between sections, whether or not a Delivery line was
    // written above (a personal task has none).
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...renderPersonalFacts(personal));
  }
  if (folder) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...renderFolderFacts(folder));
  }
  return lines.join("\n");
}

/**
 * What folder work is told (INF-567): the folder itself is its working
 * directory, on the computer that keeps it, and it ships nothing. The
 * captain's edits there are his, as in the folder repair's brief.
 */
function renderFolderFacts(folder: FolderBriefFacts): string[] {
  return [
    `${IN_PLACE_OPENING}: your working directory is the folder of ${folder.project} at ${folder.folder} itself, on the computer that keeps it, not a working copy of your own. This task has no branch, no pull request and no completion decision, and it ships nothing.`,
    "Uncommitted edits, unpushed commits and stashes in the folder are the captain's. Never discard or overwrite them, switch the folder's branch, push, or open a pull request without their word on a card; setting edits aside on a backup branch or a stash with a message naming this task is allowed.",
    "Your completion is a report of what you did, never a completion card.",
  ];
}

/** How a personal brief's own sentence opens; a scripted stand-in tells the build in place by it. */
export const BUILD_IN_PLACE_OPENING = "You build in place";

function renderPersonalFacts(personal: PersonalBriefFacts): string[] {
  const surfaces =
    personal.surfaces.length > 0
      ? personal.surfaces
          .map((surface) => `${surface.id} "${surface.title}" (${surface.placement.x} rail)`)
          .join("; ")
      : "none yet";
  return [
    `${BUILD_IN_PLACE_OPENING}: this task carries no delivery posture and no rigor tier, because nothing here ships through a gate. What that means concretely:`,
    `Workspace: ${personal.workspaceDir} - your working directory. There is no worktree, no branch, and no pull request: you edit these files in place. The app compiles what you save as you save it, apart from the captain's rails: they keep each panel as it was until place_panel puts your version there, and the host commits it with your report. Do not commit; the host commits at the end of each of your turns with your report as the message. Your completion is a factual note showing what you built, with no actions, then your report; there is nothing to merge, land, or discard.`,
    "Your session carries the workspace's AGENTS.md and lists its skills under .claude/skills/. Read the skill your brief names. Open personal-panel before you write or change a panel. Before reporting a panel change, lint_panel checks it, place_panel puts it on the captain's rail, and capture_panel photographs it there.",
    ...(personal.ongoing
      ? [
          "This task is ongoing: each turn is committed without closing the task or reporting routine progress to the first mate. Report needs_firstmate when coordination is needed, or finished true when the work ends.",
        ]
      : []),
    `Surfaces now: ${surfaces}. A change to one of these is an edit of that directory, not a new one.`,
  ];
}

/**
 * What the fresh crewmate is told about the attempt it replaces
 * (intelligence-bucket routing S4, report section 4 step 5). All of it is
 * host-established fact: the Firstmate names the rejected task and relays
 * the captain's words; it writes none of this section.
 */
export type EscalationBriefFacts = {
  /** 1-based position in the lineage; bounded by the policy's maxEscalations. */
  attempt: number;
  /** The rejected attempt's conversational handle. */
  previousKey: string;
  /** The tier this attempt runs at - one rung above the rejected one. */
  tier: string;
  /** The model the rejected attempt ran on, when the record has it. */
  previousModel?: string;
  /** Its last report, when it made one. */
  previousOutcome?: string;
  /** Its branch, kept because it held unlanded work (O1). */
  /** The hidden ref the rejected attempt's work was saved on when it closed. */
  previousWork?: string;
};

/**
 * The escalation brief: the ordinary intent template plus one section
 * saying what already failed. The captain's words on that result are the
 * intent's own `userWords`, already marked verbatim-and-outranking above,
 * so this section does not repeat them - it says which attempt they were
 * about. The kept branch is offered, never prescribed: a stronger model
 * starting clean is a legitimate reading of the same goal.
 */
export function renderEscalationBrief(
  intent: SpawnIntent,
  delivery: RepoDelivery | undefined,
  escalation: EscalationBriefFacts,
  personal?: PersonalBriefFacts,
  folder?: FolderBriefFacts,
): string {
  const base = renderIntentBrief(intent, delivery, personal, folder);
  const previous = escalation.previousModel
    ? `${escalation.previousKey}, on ${escalation.previousModel}`
    : escalation.previousKey;
  const lines: string[] = [
    "",
    `This is attempt ${escalation.attempt} at the ${escalation.tier} tier: an earlier attempt at this work was rejected by the captain, and the words above are what they said about it.`,
    escalation.previousOutcome
      ? `The previous attempt (${previous}) reported:\n${escalation.previousOutcome}`
      : `The previous attempt (${previous}) finished without a report.`,
  ];
  if (escalation.previousWork) {
    lines.push(
      `Its branch is gone, but its work is saved in the repository at ${escalation.previousWork} (\`git log ${escalation.previousWork}\`); read or start from it only if it helps, and do not assume it is right.`,
    );
  }
  lines.push(
    "Do not repeat its approach because it is there. Work the goal again from the user's words.",
  );
  return [base, ...lines].join("\n");
}

/** How a follow-up brief's provenance line opens. */
export const FOLLOWUP_PROVENANCE_OPENING = "Filed as a follow-up by";

/**
 * The brief a crewmate-filed follow-up runs from (task-system P2,
 * `file_followup`). There are no captain words to mark verbatim: the
 * provenance line says which crewmate found the work and why, so the
 * crewmate that later takes it knows the goal is inherited, not spoken.
 */
export function renderFollowupBrief(
  followup: {
    goal: string;
    why: string;
    filedBy: string;
    originTitle: string;
    originKey: string;
  },
  delivery: RepoDelivery | undefined,
  personal?: PersonalBriefFacts,
): string {
  return [
    `Goal: ${followup.goal}`,
    "",
    `${FOLLOWUP_PROVENANCE_OPENING} ${followup.filedBy} while working on "${followup.originTitle}" (${followup.originKey}). Why it is needed, in that crewmate's words:`,
    followup.why,
    originReadLine(followup.originKey),
    "",
    // The provenance block already ended with a blank line, so the facts
    // need their own separator only when a Delivery line sits between.
    ...(delivery ? [`Delivery: ${DELIVERY_TEXT[delivery]}.`] : []),
    ...(personal ? [...(delivery ? [""] : []), ...renderPersonalFacts(personal)] : []),
  ].join("\n");
}

/**
 * A filed follow-up's brief once the classifier has called it an answer
 * (FI3-598). `renderFollowupBrief` writes a posture at filing, before any
 * kind exists, and always as its last line; an answer ships nothing and
 * gets no delivery tools, so the host drops that line rather than tell the
 * crewmate to open a pull request it cannot open. Only the host's own
 * trailing line goes, whatever wording it was filed with; nothing above it
 * is read.
 */
export function withoutDeliveryLine(brief: string): string {
  const text = brief.trimEnd();
  const cut = text.lastIndexOf("\n");
  if (!text.slice(cut + 1).startsWith("Delivery: ")) return brief;
  return cut < 0 ? "" : text.slice(0, cut).trimEnd();
}

/**
 * A filed follow-up's brief as it starts (FI3-733): the posture its filing
 * wrote last is the one of that moment, but the follow-up merges under its
 * own record's posture when it starts - the project's may have changed
 * while it waited, or the Firstmate may have set one for it. The host swaps
 * its own trailing line for that posture, or drops it for an answer
 * (`withoutDeliveryLine`), so the brief matches the merge it gets.
 */
export function withDeliveryLine(brief: string, delivery: RepoDelivery | undefined): string {
  const rest = withoutDeliveryLine(brief);
  return delivery ? `${rest.trimEnd()}\n\nDelivery: ${DELIVERY_TEXT[delivery]}.` : rest;
}

/** The line a follow-up's brief is filed with, telling it to read its origin itself. */
function originReadLine(originKey: string): string {
  return `Read the origin's report and card with the tasks query (${originKey}) before continuing.`;
}

/**
 * A follow-up's brief once the mint hands it its origin's recorded
 * findings as a section of their own: the line its filing wrote, telling
 * it to go and read them, goes, so the origin reaches it once. An answer
 * gets no section and keeps the line. Only the host's own line goes - the
 * last one, after the crewmate's words - and nothing else is read.
 */
export function withoutOriginReadLine(brief: string, originKey: string): string {
  const line = `${originReadLine(originKey)}\n`;
  const at = brief.lastIndexOf(line);
  return at < 0 ? brief : brief.slice(0, at) + brief.slice(at + line.length);
}

/**
 * How a builder fixes a reviewer's findings (the ported no-mistakes fixer
 * preamble, contract v3.5). The reviewed brief carries it, so the
 * Firstmate relays findings verbatim without restating it; a findings wake
 * on a builder whose brief predates its reviewed care still names it for
 * the steer (`wakes.ts`).
 */
export const REVIEW_FIX_RULES =
  "double-check each finding is legitimate before changing code, identify all sibling sites of the broken invariant, repair the whole defect class with one small correction rather than new machinery, retrace normal callers, never resolve a finding by reverting the author's intentional change, never implement a finding the captain declined or undo a fix the captain chose merely to satisfy an earlier goal, and verify each is resolved";

/**
 * The one line the brief carries about how carefully the work ships
 * (delivery rigor phase 2, `docs/delivery-rigor.md`). The host derives the
 * tier (`src/shared/rigor.ts`) and appends this at the single brief mint,
 * after the classifier has run - the kind is never sorted on it. The
 * crewmate prompt states what each tier asks; this names which one applies.
 * On the reviewed tier it also says what changes at the end: no completion
 * card until the Firstmate says so, because an independent reviewer reads
 * the branch first and the merge is held until it passes - and how to fix
 * the findings the Firstmate relays.
 */
export function renderRigorSection(rigor: Rigor): string {
  switch (rigor) {
    case "quick":
      return "Rigor: quick - the repository's own gate and green CI; the five headings are welcome, nothing more is required.";
    case "standard":
      return "Rigor: standard - the fixed pre-PR procedure, the five headings on the report, three CI rounds then a blocker report.";
    case "reviewed":
      return `Rigor: reviewed - the review comes BEFORE the pull request: when your work is done, commit it on your branch, report under the five headings, and do not push, open a PR, or emit a completion card yet. An independent reviewer reads your branch; the first mate relays its findings as steers and your fixes land as local commits. To fix them, ${REVIEW_FIX_RULES}. After the review passes, push, open the PR, drive CI green, and the first mate tells you when to emit the completion card. A passed review holds when a later version is the same change; any edit asks a fresh review. ${CAREFUL_LIVE_VALIDATION.replaceAll("\n", " ")}`;
  }
}

/**
 * What this task DELIVERS, derived by the host (crew-posture
 * rationalization Task B, captain F1 A of 2026-09-20). For work the
 * Firstmate commissioned, its typed `operation` or `read-only` constraint
 * declares an effect or an answer. Without either the task is a `change`, and the classifier's kind only routes (INF-990
 * friction 7: a build whose goal asked for a preview first was classified a
 * plan, so its brief said answer only and the preview's click closed it).
 * A crewmate's follow-up has no intent and so no declaration: its kind
 * decides, the answer branch of `KINDS_BY_DELIVERABLE` being answers.
 */
export function deliverableFor(
  intent: SpawnIntent | undefined,
  kind: WorkKind | undefined,
): Deliverable {
  assertDeliverableConstraints(intent);
  if (intent?.constraints?.some((constraint) => constraint.kind === "operation"))
    return "operation";
  if (!intent) {
    return isAnswerKind(kind) ? "answer" : "change";
  }
  return (intent.constraints ?? []).some((constraint) => constraint.kind === "read-only")
    ? "answer"
    : "change";
}

/** Contradictory typed declarations are refused before any task starts (INF-1430). */
export function assertDeliverableConstraints(
  intent: SpawnIntent | undefined,
  folder = false,
): void {
  const constraints = intent?.constraints ?? [];
  if (
    constraints.some((c) => c.kind === "read-only") &&
    (folder || constraints.some((c) => c.kind === "operation"))
  )
    throw new Error(
      "An operation makes an effect and cannot be read-only. Omit read-only, or use an answer task without operation or in_folder.",
    );
}

/** The effect, not a source change or an answer card, is the approved deliverable. */
export function renderOperationShapeSection(): string {
  return [
    "Operation shape: the effect is the deliverable. Make the effect named in the goal and check that it took. Commit nothing, push nothing, open no pull request, and stop and report if code must change.",
    "The captain's words authorize only the effects the goal names. Keychain and signing access, writes outside this task's own project, payments and browser handoffs still ask under their existing consent rules; anything beyond the named effects asks too.",
    "Your own project's writes go at once. You have no pull request tools and no completion decision. Show what took effect on a factual note with no settle action, then report the result and its evidence; the first mate closes it done and finished from that evidence. A note stays until the captain closes it, but its dismissal is not proof of success.",
    "Rigor: none - this task delivers an effect, not code through a gate.",
  ].join("\n");
}

/**
 * The captain's pictures a brief carries (`docs/task-capture.md`, "Pictures
 * stay with the task"): those that ride the first turn beside it, those that
 * did not fit in one turn, and how many copies were gone. `path` is the app's
 * own copy, named only where the crewmate runs on this Mac.
 */
export type BriefPictures = {
  riding: { name: string; path?: string }[];
  more: { name: string; path?: string }[];
  missing: number;
};

function pictureWords(count: number): string {
  return count === 1 ? "1 picture" : `${count} pictures`;
}

/** The brief's pictures section; empty when the task came with none. */
export function renderPicturesSection(pictures: BriefPictures): string {
  const listed = [...pictures.riding, ...pictures.more];
  const total = listed.length + pictures.missing;
  if (total === 0) return "";
  const lines = [
    `Pictures: the captain attached ${pictureWords(total)} to the messages this task came from.`,
  ];
  const riding = pictures.riding.length;
  if (riding > 0 && pictures.more.length > 0) {
    lines.push(
      `The first ${pictureWords(riding)} ride with this brief; ${pictures.more.length} more did not fit in one turn.`,
    );
  } else if (riding > 0 && riding === total) {
    lines.push(riding === 1 ? "It rides with this brief." : "They ride with this brief.");
  } else if (riding > 0) {
    lines.push(`${pictureWords(riding)} ${riding === 1 ? "rides" : "ride"} with this brief.`);
  }
  if (pictures.missing > 0) {
    lines.push(`${pictureWords(pictures.missing)} could not be found among the app's copies.`);
  }
  const paths = listed.every((picture) => picture.path);
  if (listed.length > 0 && paths) {
    lines.push("The app keeps its own copy of each, which you can open by its path:");
  }
  for (const picture of listed) {
    lines.push(paths ? `- ${picture.name}: ${picture.path}` : `- ${picture.name}`);
  }
  return lines.join("\n");
}

/**
 * Which of an answer task's cards closes it (INF-1226): INF-1220's consent
 * card closed its task answered before it signed anything. The crewmate
 * declares the card it goes on from; the host reads only that declaration.
 */
const ANSWER_CONTINUES_CARD =
  "A card whose choice you go on from rather than your answer, such as a consent before you use something sensitive, declares continues on each revision: that choice comes back to you, and the captain's choice on any other card of yours closes this task as answered.";

/**
 * The one section the brief carries about what an answer task's answer
 * looks like, appended where `renderRigorSection` sits for a change
 * (captain lock 2 of 2026-09-19, visual-density audit section 6.1: the
 * brief was the one channel every model family obeyed, so what a task's
 * answer should look like is the HOST's to say). Since Task B it also
 * states the two facts a crewmate cannot see from inside its worktree: the
 * task ships nothing, and the worktree is scratch. A plan is its own step
 * since contract 4.6 (docs/sequences.md): an answer task like any other.
 * Both shapes say which of its cards closes it (INF-1226): the captain's
 * choice on a card its crewmate declared `continues` comes back to the
 * crewmate, and a choice on any other closes the task answered
 * (`SettleService.closeAnsweredTask`).
 */
export function renderAnswerShapeSection(internalStep = false, kind?: WorkKind): string {
  const shape = answerShape(internalStep);
  // An internal step's answer goes to the next step, not to a card.
  return kind === "retrieval" && !internalStep ? `${shape} ${RETRIEVAL_BOUNDARY_WORDS}` : shape;
}

/**
 * A retrieval answer's boundary (INF-1430 piece 1): it was routed low to
 * read what this app can already read, so it stops where that ends rather than
 * reaching past it, and the captain's Look deeper is the way on - the
 * first mate starts a research step built on this answer. A crewmate never
 * climbs on its own: a stronger model stays the captain's move.
 */
export const LOOK_DEEPER_LABEL = "Look deeper";
export const RETRIEVAL_BOUNDARY_WORDS = [
  "Retrieval: this answer reads only what this app can already read - the code and its history, the task record, the docs, and the current state of the computers, checks and GitHub runs it connects to.",
  "Stop at that boundary rather than reaching past it: when the whole answer needs a cause traced across past runs, a reproduction, a measurement, a computer the app does not reach or the web, the card says what is established and what is not, names the source still needed, and makes " +
    `${LOOK_DEEPER_LABEL} its default action, which the first mate answers with a research step built on this answer.`,
].join(" ");

function answerShape(internalStep: boolean): string {
  if (internalStep) {
    // A step the Firstmate declared its own (docs/sequences.md): its answer
    // goes to the next step, not to the captain, so the report carries it
    // and a card is only for a decision he must make first.
    return [
      "Answer shape: this task's deliverable is an answer, not a change - a step whose answer the next step builds on.",
      "Your report is that answer and is handed to the next step verbatim, so put all of it there: what you found and the evidence, including paths, commands and a reproduction.",
      "Show a card, as any crewmate does, when the captain must decide or see something before the next step can start; it then opens with the answer in a sentence and draws it, with a figure for each part of the explanation, and their replies come to you there, not through the first mate.",
      ANSWER_CONTINUES_CARD,
      "When the captain's replies change the answer, report it again in full - the final agreed version, with their tweaks and anything decided on the card - before they choose.",
      "Rigor: none - this task ships nothing.",
      "Your worktree is a laboratory: install, run, and edit there freely to find the answer, but commit nothing, push nothing, and open no pull request. Nothing in it ships; it is discarded when this task closes, and anything worth keeping goes in your report.",
      "Your report is what survives this task; the first mate closes it once the next step has started, unless a card of yours is waiting on the captain.",
    ].join(" ");
  }
  const shape = [
    "Answer shape: this task's deliverable is an answer, not a change, and it lands as one card.",
    "The card opens with the answer in a sentence and then draws it - how the thing works, how the options differ, what the state or the layout is - with a figure for each part of the explanation.",
    "Names, numbers, quotes and caveats are prose beside the figure they qualify; the evidence a reader who digs would want, including paths and commands, goes in <details>.",
    "When your findings warrant a concrete next move, identify it and put it in the card's actions with one recommended default; do not invent an action when the answer is a pure fact, which stays a note.",
    ANSWER_CONTINUES_CARD,
    "Your report stays the short factual account; the card is where the answer is shown.",
    "Your report is also the answer this task keeps, and work built on it starts from it: when the captain's replies change the answer, report it again in full - the final agreed version, with their tweaks and anything decided on the card - before they choose.",
    "Rigor: none - this task ships nothing; the card is the deliverable.",
    "Your worktree is a laboratory: install, run, and edit there freely to find the answer, but commit nothing, push nothing, and open no pull request. Nothing in it ships; it is discarded when this task closes, and anything worth keeping - paths, commands, a reproduction, a sketch of a fix - goes in the card.",
    "The card and your report are the only things that survive this task.",
  ];
  return shape.join(" ");
}

/**
 * The brief's line for a change the first mate marked its own
 * (`shape.internal_step`, INF-1467, the captain's direction A with their
 * answer "Also a note when it finds something you should see"): the
 * captain did not ask for it, so its crewmate puts up only what the
 * captain must give or should see, and a drop or finish goes quiet.
 */
export const FLEET_STARTED_CHANGE_WORDS =
  "Your first mate started this work itself; the captain did not ask for it. Show the captain a card only for what only they can give - a merge click, a consent, a sign-in - or a note for something you found that they should see. Your report goes to the first mate, and if this task closes without a merge or release, no note reaches the captain.";

/**
 * The result shape a task declared (INF-799 piece 1), printed where the
 * brief says what the task's answer looks like: the JSON Schema the host
 * checks the report's `result` against, and the one sentence that says so.
 */
export function renderResultShapeSection(schema: Record<string, unknown>): string {
  return [
    "Result shape: your report carries a typed result, the result field of the report tool, and it must fit this JSON Schema; the host refuses a report whose result is missing or does not fit, naming the first failing field, unless that report declares waiting_on_captain or needs_firstmate.",
    "The next task reads the result as data, so it holds the answer itself; the report's text stays the plain account.",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * A part of a program (INF-799 piece 2, docs/programs.md): the host's
 * runner filed it from one task() call of a script, and reads its report's
 * result as that call's answer. It delivers its branch and its result,
 * never a pull request: the program's own report names the branch a
 * change ships from.
 */
export function renderProgramPartSection(program: { key: string; title: string }): string {
  return [
    `Program part: this task is one part of the program ${program.key} "${program.title}", which the host runs; your report's result is what the program reads next, and nobody else is woken by it.`,
    "Commit what you change on your branch - a later part may start from your last commit - but push nothing, open no pull request and show no completion card: this part delivers its branch and its result, and the program closes it once it has read your report, keeping your work.",
    "Run the checks that prove your part works. Show a card only when the captain must decide something before you can go on, and then report with waiting_on_captain.",
  ].join(" ");
}

/**
 * Where a task's working copy began when it branches from another task
 * (INF-799 piece 1): that task's last commit, so its work is already on
 * this task's branch.
 */
export function renderBranchFromLine(source: { key: string; title: string; ref: string }): string {
  return `Your working copy starts at ${source.key} "${source.title}"'s last commit (${source.ref}), not at the default branch: its commits are already on your branch, so continue from them.`;
}

/**
 * What the host knows about the answer a change is built on (Task B, F3 A
 * and the captain's note on context): when `spawn_crewmate` named a basis
 * and the host verified it, the builder is handed that task's answer rather
 * than being told to go and find it. Byte-stable like the escalation brief -
 * the Firstmate names the basis and writes none of this - and read back at
 * any time through the `tasks` query by key, which carries the same report
 * and every choice the captain made on its cards.
 */
export type BasisBriefFacts = {
  /** The basis task's conversational handle. */
  key: string;
  /**
   * Its id, which marks each report the section copies as that task's
   * event, so the receipt can keep it by reference; without one the
   * reports are plain text.
   */
  taskId?: string;
  title: string;
  /** The captain's own words on that task, when the record kept them. */
  userWords?: string;
  /** Its report, verbatim. */
  outcome?: string;
  /** Its latest typed result, as the host checked it (INF-799 piece 1). */
  result?: Record<string, unknown>;
  /** Full reports in timeline order, including superseded reports, not inferred approvals. */
  reports?: { event_id: number; text: string }[];
  /**
   * The body of the card it answered with - its crewmate's card the captain
   * chose on, never a merge decision or a Firstmate or host card filed under
   * it (`CardStore.newestAnswerForTask`) - HTML as offered (the host renders
   * bodies verbatim). Quoted in the section only when `cardFile` is absent.
   */
  card?: string;
  /**
   * The file the host saved that body to, whole - script and style included
   * - for the builder to open (FI3-700). When present the section names it
   * instead of pasting the HTML; the choice, answers and thread stay words.
   */
  cardFile?: string;
  /**
   * Files of the pictures its card shows, as the host keeps them: the
   * builder can open these where it cannot open the card's links.
   */
  pictures?: string[];
  /** Files of the demo recordings its card plays, as the host keeps them. */
  recordings?: string[];
  /** Starting work imported and acknowledged in the destination repository. */
  startingRef?: string;
  /** Its live branch, while its working copy is present (worktrees share refs). */
  branch?: string;
  /** The hidden ref its unlanded work was saved on when its working copy went. */
  keptRef?: string;
  /** The complete messages under its card, oldest first. */
  thread?: { who: string; text: string }[];
  /** The action the captain chose on its card when it closed, when it closed on one. */
  choice?: string;
  /**
   * The captain's answers to the questions its card's body asked, one line
   * each, as `cardAnswerLines` words them (contract 4.22).
   */
  answers?: string[];
};

/**
 * A report event's text, copied into a brief verbatim. The crewmate is
 * served it whole; the receipt that pins the brief keeps it by reference
 * to the event where that is smaller (`TaskService.recordBrief`).
 */
export type ServedReport = { taskId: string; eventId: number; text: string };

/** A brief in pieces: host text, or a report's text off the record. */
export type BriefPart = string | ServedReport;

/** The text a brief's pieces serve. */
export function briefText(parts: readonly BriefPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.text)).join("");
}

/** Groups of pieces with `separator` between them, as `join` joins strings. */
export function joinParts(
  groups: readonly (readonly BriefPart[])[],
  separator: string,
): BriefPart[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [separator, ...group]));
}

export function renderBasisSection(
  facts: BasisBriefFacts,
  source: "basis" | "origin" | "replacement" = "basis",
): string {
  return briefText(basisSectionParts(facts, source));
}

/** The basis section in pieces, each report it copies marked as its event. */
export function basisSectionParts(
  facts: BasisBriefFacts,
  source: "basis" | "origin" | "replacement" = "basis",
): BriefPart[] {
  const { taskId } = facts;
  const report = (eventId: number, text: string): BriefPart =>
    taskId ? { taskId, eventId, text } : text;
  const lines: BriefPart[] = [
    source === "basis"
      ? `This work is grounded in ${facts.key} "${facts.title}", whose answer is the spec for it. What that task established:`
      : source === "replacement"
        ? `This task starts dropped work ${facts.key} "${facts.title}" again as its replacement, not a stronger-model retry. Recover its saved work yourself; the new working copy is not preloaded. What that task recorded:`
        : `Recorded origin ${facts.key} "${facts.title}" (discovered-from provenance, not inferred approval). What that task recorded:`,
  ];
  if (facts.userWords) {
    lines.push("", `What the captain asked of it, verbatim:`, facts.userWords);
  }
  // The latest report is the outcome; the ones before it are history.
  const latest = facts.reports?.at(-1);
  if (facts.outcome) {
    lines.push(
      "",
      "Its report - the final answer it recorded:",
      latest?.text === facts.outcome ? report(latest.event_id, latest.text) : facts.outcome,
    );
  }
  if (facts.result) lines.push("", RESULT_WORDS, resultText(facts.result));
  const earlier = latest?.text === facts.outcome ? facts.reports?.slice(0, -1) : facts.reports;
  if (earlier?.length) {
    lines.push(
      "",
      "Its earlier reports in chronological order (history, not additional approval):",
      ...earlier.flatMap((entry) => [
        `Report event ${entry.event_id}:`,
        report(entry.event_id, entry.text),
      ]),
    );
  }
  if (facts.cardFile) {
    lines.push(
      "",
      "Its card, as the captain read it, is saved whole - any script and style included - in this file on this machine; open it to read the card:",
      `- ${facts.cardFile}`,
    );
  } else if (facts.card) {
    lines.push("", "Its card, as the captain read it:", facts.card);
  }
  if (facts.cardFile || facts.card) {
    if (facts.pictures?.length) {
      lines.push(
        "",
        "The pictures in that card are files on this machine; open them to see the design the captain saw:",
        ...facts.pictures.map((file) => `- ${file}`),
      );
    }
    if (facts.recordings?.length) {
      lines.push(
        "",
        "The demo recordings in that card are files on this machine; play them to see what the captain saw:",
        ...facts.recordings.map((file) => `- ${file}`),
      );
    }
  }
  if (facts.startingRef) {
    lines.push(
      "",
      `Its starting work has been copied into this repository at ${facts.startingRef} (git log ${facts.startingRef}); start from it when the task builds on it.`,
    );
  } else if (facts.branch) {
    lines.push(
      "",
      `Its work is on branch ${facts.branch} in this repository (worktrees share refs: git log ${facts.branch}); start from it when the task builds on it.`,
    );
  } else if (facts.keptRef) {
    lines.push(
      "",
      `Its working copy is gone, but its work is saved in the repository at ${facts.keptRef} (git log ${facts.keptRef}); start from it when the task builds on it.`,
    );
  }
  if (facts.thread && facts.thread.length > 0) {
    lines.push(
      "",
      "What was said under its card, newest last:",
      ...facts.thread.map((message) => `- ${message.who}: ${message.text}`),
    );
  }
  if (facts.choice) {
    lines.push("", `The captain closed it by choosing "${facts.choice}".`);
  }
  if (facts.answers && facts.answers.length > 0) {
    lines.push(
      "",
      "The captain's latest submitted settings/answers (supersede earlier values):",
      ...facts.answers,
    );
  }
  if (!facts.userWords && !facts.outcome && !facts.card && !facts.cardFile) {
    lines.push("", `Read it with the tasks query, key ${facts.key}.`);
  }
  lines.push(
    "",
    "Build on it rather than re-deriving it, and say in your report where it turned out to be wrong.",
  );
  return joinParts(
    lines.map((line) => [line]),
    "\n",
  );
}

/**
 * What the host knows about the change a reviewer reads (delivery rigor
 * phase 2; review-before-PR since the captain's 2026-09-19 ruling). All of
 * it is host-established: the builder's title and last report off the
 * record, the branch and its committed head off the repository itself.
 * An already-open pull request does not replace that head. The Firstmate
 * names the task and relays the captain's words; it writes none of this.
 */
export type ReviewBriefFacts = {
  validation?: LiveValidation;
  proofFiles?: { id: string; file: string; poster?: string }[];
  builderTitle: string;
  /** The builder's branch; the review reads it before any PR exists. */
  branch: string;
  headSha: string;
  /** Present when a pull request is already open. It is not the review target. */
  prUrl?: string;
  /** The builder's last report, verbatim. */
  builderReport: string;
  /** The builder's evidence folder on this machine; evidence is never committed. */
  evidenceDir?: string;
  /** Committed paths at the assigned head, or null when that commit is not local. */
  changedFiles: string[] | null;
  /** The change reading at the assigned commit, when it could be read. */
  changeReading?: string;
  /**
   * The version an earlier review of this change passed, when the
   * assigned commit is another one (INF-401). The review then reads only
   * what changed since that pass.
   */
  passedHead?: string;
  /**
   * The merge card the captain was reading when he pressed Review carefully
   * (INF-562): its title, the file it is saved whole in (or its body, when
   * no file could be written there), the pictures in it and its risk chart.
   */
  captainCard?: CaptainCardFacts;
  /**
   * What was decided so far on this change, oldest first (INF-993): the
   * review rounds, the captain's answers and each validation answer, written
   * by the host from the record on every turn.
   */
  history?: ReviewHistoryEntry[];
  /** The captain's override standing on the builder at this version (INF-1216). */
  override?: Pick<HoldOverride, "words" | "holds" | "until">;
};

/** The merge card behind a careful review, as the captain read it (INF-562). */
export type CaptainCardFacts = {
  title: string;
  file?: string;
  body?: string;
  pictures?: string[];
  /** Each risk dimension as one line: its name, level and the builder's why. */
  risk?: string[];
};

/** The reviewer's section on the merge card the captain read (INF-562). */
function captainCardLines(card: CaptainCardFacts): string[] {
  return [
    `The captain asked for this review from the merge card they were reading, "${card.title}": they pressed Review carefully because the work looked risky to them. Read that card - its story and its risk chart - and weigh what it says against the diff; it is the builder's account of the change, not proof of it.`,
    ...(card.file
      ? [
          "It is saved whole - any script and style included - in this file on this machine; open it to read the card:",
          `- ${card.file}`,
        ]
      : card.body
        ? ["The card, as the captain read it:", card.body]
        : []),
    ...(card.pictures?.length
      ? [
          "The pictures in that card are files on this machine:",
          ...card.pictures.map((file) => `- ${file}`),
        ]
      : []),
    ...(card.risk?.length ? ["Its risk chart, as the builder declared it:", ...card.risk] : []),
    "",
  ];
}

/** How the review instruction opens; a scripted stand-in recognizes the reviewer by it. */
export const REVIEW_BRIEF_OPENING = "You are reviewing, not building";

/**
 * What the host knows about a repair its crewmate could not judge (FI3-663),
 * all off the record: the approval's heads, the repair's transition, the
 * paths each change touches, and the crewmate's account.
 */
export type RepairAssessmentFacts = {
  builderTitle: string;
  /** How the change is named where the project lives: "PR #23 <link>". */
  change: string;
  /** The captain's words the change was built for, when the record has them. */
  userWords?: string;
  approvedHead: string;
  fromHead: string;
  toHead: string;
  newBase: string;
  /** Paths the approved change touches against its own base, and the repaired one against the base it sits on. */
  paths: { approved: string[]; repaired: string[] };
  evidence: string;
  validation: string;
};

/** How the repair assessment's instruction opens. */
export const REPAIR_ASSESSMENT_BRIEF_OPENING = "You are assessing a repair, not building";

/** The assessment's checklist: every path either change touches, marked where only one does. */
function checklist(paths: RepairAssessmentFacts["paths"]): string[] {
  const approved = new Set(paths.approved);
  const repaired = new Set(paths.repaired);
  return [...new Set([...paths.approved, ...paths.repaired])].sort().map((path) => {
    const only = !repaired.has(path)
      ? " (only in the approved change)"
      : !approved.has(path)
        ? " (only in the repaired change)"
        : "";
    return `- ${JSON.stringify(path)}${only}`;
  });
}

/**
 * The brief of an independent repair assessment (FI3-663; FI3-304 section
 * 3's scope boundary, the captain's guard = builder): one bounded, read-only
 * look at whether a repair of an approved change kept it the change the
 * captain approved, answered with the one line the host reads.
 */
export function renderRepairAssessmentBrief(facts: RepairAssessmentFacts): string {
  const approvedBase = `$(git merge-base ${facts.approvedHead} ${facts.newBase})`;
  const words = facts.userWords?.trim();
  return [
    `Goal: assess whether a repair of "${facts.builderTitle}" kept the change the captain approved, and report one impact line.`,
    "The impact report is the whole deliverable of this internal assessment; emit no card.",
    ...(words ? ["", "The captain's words the change was built for, verbatim:", words] : []),
    "",
    `${REPAIR_ASSESSMENT_BRIEF_OPENING}: change nothing, commit nothing, push nothing, run no tests. The captain approved merging ${facts.change} at ${facts.approvedHead}. Its crewmate then repaired it, from ${facts.fromHead} to ${facts.toHead}, on the default branch at ${facts.newBase}. The crewmate could not tell whether that kept the approved work as it was, so you decide, independently of it. This repository's working copies share commits: the approved change is git diff ${approvedBase} ${facts.approvedHead}, the repaired one is git diff ${facts.newBase} ${facts.toHead}, and git range-diff ${approvedBase}..${facts.approvedHead} ${facts.newBase}..${facts.toHead} lines them up commit by commit.`,
    "",
    "none: the repaired change does what the approved one did, whatever the repair was - such as resolved conflicts, an interface newer work renamed adapted without changing behavior, or a reworded commit message - with the tests and documents it directly needs. changed-work: anything else - new or removed behavior, unrelated fixes, weakened tests or protections, or edits the repair did not need. Who wrote a commit, how few lines changed, or edits only in conflicted files prove nothing. If you cannot settle it within this one look, answer unknown: unknown never merges.",
    "",
    "Every path either change touches - judge each one; a path only one of them touches is the first place to look:",
    ...checklist(facts.paths),
    "",
    "Open your report with exactly one line, impact: none|changed-work|unknown, then say in a few lines what you compared and why it decides. Your first report is your verdict: the host reads that line and closes this task.",
    "",
    "The crewmate's account of the repair:",
    `Evidence: ${facts.evidence}`,
    `Validation at ${facts.toHead}: ${facts.validation}`,
  ].join("\n");
}

/** The title of the task the host files for a folder a merge left behind (INF-549). */
export const FOLDER_REPAIR_TITLE = "Bring the folder up to date";

/** How the in-place brief's own sentence opens; a scripted stand-in tells it by this. */
export const IN_PLACE_OPENING = "You work in place";

/**
 * The brief of the task the host files when it could not bring a project's
 * folder up to date after a merge (INF-549, approved by the captain), or
 * when other work found the folder missing or behind (INF-572): every line
 * is filled from the facts on the record, modelled on INB-9's hand-written
 * brief without its delivery line. It names no delivery, no pull request and
 * no completion decision, because the task ships nothing. A missing folder's
 * brief has the crewmate find out why, from the folder above it, and clone
 * it again only when it was deleted.
 */
export function renderFolderRepairBrief(
  facts: InPlaceFacts & {
    project: string;
    folder: string;
    /** Where the project lives, when it has an address. */
    origin?: string | null;
    /** The crewmate's working directory, when it is not the folder itself. */
    workdir?: string;
  },
): string {
  const branch = facts.branch ?? "the default branch";
  const reach = facts.reach ?? `origin's ${branch} as you fetch it`;
  const found = folderFoundBy(facts);
  const factLines = [
    "Facts:",
    `- Project: ${facts.project}`,
    `- Folder: ${facts.folder}`,
    `- Where the project lives: ${facts.origin || "nowhere; it is kept only on this computer"}`,
    `- Default branch: ${facts.branch ?? "not named by where the project lives"}`,
    `- Merged version: ${facts.reach ?? "not known"}`,
    `- ${branch} where the project lives, as last read: ${facts.remote ?? "not read"}`,
    `- Why it was not brought up to date: ${folderRefreshWords(facts.cause)}`,
  ];
  if (facts.cause === "missing") {
    const workdir = facts.workdir
      ? `${facts.workdir}, the nearest folder above the missing one that exists`
      : `${facts.folder}, the project's folder itself, which is there now`;
    return [
      `Goal: bring back the folder of ${facts.project} at ${facts.folder}: there again, checked out on its default branch, with no uncommitted edits, and level with where the project lives.`,
      "",
      `Infinitary filed this task itself. ${found}, the project's folder was not there: ${folderRefreshWords(facts.cause)}. Work that needs the folder cannot run until it is back.`,
      "",
      ...factLines,
      "",
      `${IN_PLACE_OPENING}: your working directory is ${workdir}, not a working copy of your own. This task has no branch, no pull request and no completion decision, and it ships nothing.`,
      "Find out why the folder is missing first: whether it was deleted, moved or renamed elsewhere, sits on a drive that is not connected, or was kept only on this computer.",
      `Only if it was deleted, and the project has an address where it lives, clone it again from there into exactly ${facts.folder}. A fresh clone cannot bring back branches or edits that were only in the deleted folder: say so in your report.`,
      "In every other case change nothing and ask the captain on a card what to do. Never move, rename or delete another folder, and never clone into any other path.",
      `Once the folder is back, clean, on its default branch and level with where the project lives, report what you did and why it was missing in a few sentences. Infinitary sees the folder back and closes this task itself; show a card only when you must ask the captain.`,
    ].join("\n");
  }
  // With no default branch read, the folder is up to date only once origin's
  // HEAD names one: the host reads it there to close this task, and the next
  // merge's update reads it there too (INF-583).
  const unnamed = facts.branch
    ? []
    : [
        ...(facts.cause !== "no-origin"
          ? []
          : facts.origin
            ? [
                `The folder has no remote called origin: add it at ${facts.origin}, where the project lives. Rename or remove no other remote without the captain's word on a card.`,
              ]
            : [
                "The folder has no remote called origin, and Infinitary has no address where the project lives: ask the captain on a card where it lives before you add one.",
              ]),
        "Infinitary reads the folder's default branch from origin's HEAD (refs/remotes/origin/HEAD), after every merge and to see that this task is done, and it read none this time. Make sure origin's HEAD names the default branch: `git remote set-head origin --auto` sets it from where the project lives, while a pull or fetch of one branch leaves it unset.",
      ];
  return [
    `Goal: bring the folder of ${facts.project} at ${facts.folder} up to date: checked out on its default branch${facts.branch ? ` ${facts.branch}` : ""}, with no uncommitted edits, ${facts.branch ? "and " : ""}at or past ${reach}${facts.branch ? "" : ", and with origin's HEAD naming that branch"}.`,
    "",
    `Infinitary filed this task itself. ${found}, it could not bring the project's folder up to date: ${folderRefreshWords(facts.cause)}. It only ever fast-forwards a clean folder on its default branch, so the rest is yours to judge.`,
    "",
    ...factLines,
    "",
    `${IN_PLACE_OPENING}: your working directory is this folder itself, not a working copy of your own. This task has no branch, no pull request and no completion decision, and it ships nothing.`,
    `Read the folder first: its status, the branch it is on, its stashes, and how ${facts.branch ? `its ${facts.branch}` : "its default branch"} compares with origin's.`,
    ...unnamed,
    `Judge whether it is safe to bring up to date. A clean folder on ${branch} only needs a fetch and a fast-forward.`,
    `Uncommitted edits or unpushed commits are the captain's: set them aside safely, on a backup branch or a stash with a message naming this task, then bring ${branch} up to date, and report exactly what you set aside and where.`,
    "Never do any of these without the captain's word on a card: discard or overwrite uncommitted edits or unpushed commits, switch the folder off its default branch, push, or open a pull request. Setting edits aside on a backup branch or a stash is allowed.",
    "When something of the captain's would have to go, or you cannot tell whether it is safe, ask them on a card before you change anything.",
    "If you can tell, say what put the folder in that state.",
    `Once ${facts.branch ? `the folder is clean, on ${branch}` : "origin's HEAD names the default branch and the folder is clean, on that branch"} and at or past the merged version, report what you did in a few sentences. Infinitary sees the folder up to date and closes this task itself; show a card only when you must ask the captain.`,
  ].join("\n");
}

/** What found the folder, opening the repair brief's account (INF-572). */
function folderFoundBy(facts: InPlaceFacts): string {
  const who = facts.after ?? "a task";
  switch (facts.noticed) {
    case "start":
      return `When ${who} was starting on this computer`;
    case "branch-home":
      return `When ${who}'s branch was coming here from the computer it runs on`;
    case "land":
      return `When it was merging ${who} into the folder`;
    case "app-start":
      return "When the app started and read where the project lives";
    default:
      return facts.after ? `After it merged ${facts.after}` : "After a merge";
  }
}

/** The title of the task the host files for a pull request an abandoned task left open (INF-549). */
export const PULL_REPAIR_TITLE = "Close the pull request";

/**
 * The brief of the task the host files when a discarded, cancelled, failed
 * or superseded task's pull request could not be closed (INF-549's sibling,
 * approved by the captain: "a brief that says close the pull request or
 * report why not"). Filled from the facts on the record like the folder's,
 * and like it the task ships nothing: no delivery line, no pull request of
 * its own and no completion decision.
 */
export function renderPullRepairBrief(
  facts: InPlacePull & { project: string; folder: string },
): string {
  const { pull } = facts;
  const which = `${pull.label}${pull.url ? ` (${pull.url})` : ""}`;
  return [
    `Goal: close the pull request ${which} of ${facts.project} where the project lives, or report why it cannot be closed.`,
    "",
    `Infinitary filed this task itself. ${facts.after ? `It closed ${facts.after}` : "It closed a task"} without merging its work, and tried to close that task's pull request, but it could not, so the pull request is still open with nobody working on it.`,
    "",
    "Facts:",
    `- Project: ${facts.project}`,
    `- Pull request: ${pull.label}`,
    `- Link: ${pull.url ?? "not known"}`,
    `- Its branch where the project lives: ${pull.branch ?? "not known"}`,
    `- The task that opened it: ${facts.after ?? "not known"}`,
    `- What the project's host answered: ${pull.problem ?? "nothing"}`,
    "",
    `${IN_PLACE_OPENING}: your working directory is the project's folder, ${facts.folder}, not a working copy of your own. Leave the folder exactly as it is; this task needs nothing from it. This task has no branch, no pull request of its own and no completion decision, and it ships nothing.`,
    `Read the pull request with github_read first. If it is already closed or merged, there is nothing to do.`,
    `If it is open, close it with github_write: on GitHub PATCH /repos/{owner}/{repo}/pulls/${pull.number} with {"state":"closed"}, on GitLab PUT /projects/{url-encoded path}/merge_requests/${pull.number} with {"state_event":"close"}. Then read it again to see it closed.`,
    "Never merge it, push, delete a branch, or open a pull request. Leave its branch where the project lives as it is.",
    "If you cannot close it, report why not in a few sentences: what the host answered, and what would let it close, such as a sign-in only the captain can give. Do not try another way in.",
    "Once it is closed, report what you did in a few sentences. Infinitary reads it closed and closes this task itself; show a card only when you must ask the captain.",
  ].join("\n");
}

/**
 * The reviewer's brief, byte-stable like the escalation brief. The captain's
 * words stay the verbatim, outranking section; the review instruction is
 * the fixed text, aligned to the no-mistakes review prompt the captain has
 * battle-tested (2026-09-19): what to read, what not to run, the severity
 * and action vocabulary, the full-pass and genuinely-matters rules, the
 * risk ladder, the ignore-list convergence rule, and the two lines the
 * host parses (`verdict:` first, `risk:` last). A brief with no captain
 * words is a loud failure: the reviewer judges the change against them, so
 * there is nothing to review without them. A review after an earlier pass
 * names that passed version and reads only the difference since it.
 */
export function renderReviewBrief(
  intent: SpawnIntent,
  delivery: RepoDelivery,
  facts: ReviewBriefFacts,
): string {
  const userWords = intent.userWords.trim();
  if (!userWords) {
    throw new Error(
      "A review brief needs the user's words: the reviewer reads the change against them, so pass them as user_words.",
    );
  }
  const assigned = `Review branch ${facts.branch} at head ${facts.headSha} - this repository's worktrees share refs, so read the diff of the assigned commit against the default branch yourself (git diff <default>...${facts.headSha})`;
  const target = facts.prUrl
    ? `${assigned}. A pull request is already open at ${facts.prUrl}; review the assigned commit, not that pull request's recorded head.`
    : assigned;
  // After an earlier pass, only what changed since it is reviewed (INF-401;
  // the captain's direction: after an unavoidable update, the re-review
  // checks only the update's difference, not the whole change again).
  const passed = facts.passedHead && facts.passedHead !== facts.headSha ? facts.passedHead : null;
  const scope = passed
    ? [
        "",
        `An earlier review already passed this change at ${passed}, and the branch has moved since. Review only the difference between that passed version and the assigned commit - what bringing it up to date, or later work, changed - not the whole change again: after an unavoidable update, the re-review checks only the update's difference (the captain's rule). git range-diff <default>..${passed} <default>..${facts.headSha} lines the two versions up commit by commit; for one path, compare git diff <default>...${passed} -- <path> with git diff <default>...${facts.headSha} -- <path>. Read the rest of the change only where you need it to judge the difference. If ${passed} is not in this working copy, say so and review the whole change instead.`,
      ]
    : [];
  const coverage = passed
    ? `List which paths in the changed-file checklist below changed since ${passed}, and check each of them, and each path the passed version touched that this one no longer does, against the diff; an omitted path is not clean, while a path whose change reads the same as at ${passed} was reviewed there and needs no second look. On re-review at a new head, recompute the checklist from its diff and compare it with ${passed} again.`
    : "Check every path in the changed-file checklist below against the diff; an omitted path is not clean. On re-review at a new head, recompute the complete checklist from its diff.";
  const fullPass = passed
    ? "Do a full pass over the difference before reporting"
    : "Do a full review pass before reporting";
  return [
    USER_WORDS_PRECEDENCE,
    userWords,
    "",
    `Goal: review the change for "${facts.builderTitle}" and report findings.`,
    "The verdict report is the whole deliverable of this internal review; emit no outcome card.",
    "",
    `${REVIEW_BRIEF_OPENING}: change nothing, commit nothing, push nothing. ${target}, against the user's words above and the builder's report below. Read the diff and whatever surrounding code, call sites, shared helpers, tests and invariants you need to understand root cause; focus findings on risks introduced by the changed code. Do not run tests: the builder's Verified section is the test record, together with the builder's evidence folder, which this brief names below when there is one (evidence is never committed, so the diff holds none; read the folder, never write to it) - say whether that evidence could demonstrate the intent, and report missing evidence as a finding instead of running anything yourself. Analyze for bugs, risks, and code simplification opportunities; simplification means reducing complexity through non-functional refactoring, never removing features, changing product behavior, or stripping intentional user-facing output. Treat security issues, performance regressions, breaking changes, and insufficient error handling as risks. Also judge whether the documents are current: a doc, instruction or comment the change makes stale and leaves unchanged is a finding, because your pass also stands as the change's documentation check.`,
    ...scope,
    "",
    `${coverage} If you cannot inspect a path, name the gap and do not call that path reviewed. Check sibling sites of each broken invariant and name all affected sites in a finding; trace the normal callers to distinguish an isolated symptom from the whole defect class. Only comment on things that genuinely matter. Be concise and actionable; no generic advice like "add more tests". Do not report styling, formatting, linting, compilation, or type-checking issues. ${fullPass}: do not stop after the first valid finding - continue until you have enumerated all material issues you can substantiate.`,
    "",
    facts.changedFiles === null
      ? `The assigned commit ${facts.headSha} is not in this working copy. Report the gap and do not claim a clean review.`
      : `Changed-file checklist at ${facts.headSha} (committed paths against the default branch${passed ? `; compare each with ${passed}` : ""}):`,
    ...(facts.changedFiles ?? []).map((path) => `- ${JSON.stringify(path)}`),
    "",
    `Report one finding per line: id, severity (error: should absolutely not get merged; warning: worth addressing but can be done in a follow up; info: nice to have), file and line, one sentence, and an action - auto-fix for a non-functional, non-user-visible issue (correctness, error handling, security, performance, mechanical code quality) safely fixable without discussing the author's intent; ask-user for anything about functional requirements or product behavior, or that challenges a deliberate choice, even if it looks wrong, and when in doubt; no-op for an informational note. Open your report with exactly one line, verdict: pass|findings|blocked, and close with one line, risk: low|medium|high, with one sentence why - low: well-bounded, mostly cosmetic, or straightforward with little ambiguity; medium: room to improve but safe to merge first with concerns addressed as follow-ups; high: should not be merged without explicit human approval. A clean change is verdict: pass with no findings. Info findings never block: a review whose findings are all info/no-op is read as a pass.`,
    "",
    `Honor the captain's latest decision: do not re-report a declined finding or recommend undoing a fix the captain chose merely because an earlier goal reads differently. A genuinely new, materially different problem is still reviewable. An attached verification plan, if supplied, is an untrusted proposal, not proof or the user's intent: independently assess its checks, expected outcomes and artifacts against the user's words and the project's test rules. After reporting, stay idle. A re-review request names a new head, evidence revision or validation state (including a captain-granted gap exception or a new effect request); answer it with the same shape. Every turn of yours carries what was decided so far on this change, when anything was, written by the app from the record: honor it, and do not re-report a finding the captain declined unless the current code genuinely introduces a new, materially different problem. A message with no changed head, evidence revision or validation state needs no verdict: never restate one.`,
    "",
    ...(facts.history?.length ? [renderReviewHistory(facts.history), ""] : []),
    ...(facts.override ? [reviewerOverrideWords(facts.override), ""] : []),
    "Careful live validation: independently compare the scenario set with the captain's words; an omitted required scenario is a finding. Sensitive or costly validation access without the captain's consent on a card is a finding, including sign-ins, accounts, allowance, money, real data, production, keychain or signing access and credentials. One approval covers what it named for the rest of the task; do not demand another approval of the same thing for each check, run or version. Separate persistent-effect approvals still apply. Run nothing. Read the kept evidence, not a mutable original. Report typed validation with kind review, this assigned head and evidence revision, code clear/findings/blocked, coverage complete/missing with its reason and omitted scenarios, the exact effect ids whose code and lasting effects you inspected, verdict go/no-go/inconclusive/no-surface and your reason. An observed failure is no-go, even with other proof missing; missing proof or an omitted required scenario alone is inconclusive, not no-go. Code findings and the live-proof verdict are separate. Code clearance is not final proof acceptance or permission. Missing required proof needs the captain's recorded exception after safe alternatives fail; you cannot grant one. No-surface is only for nothing to run, never missing access. An evidence-only change needs a fresh review. Changed validation facts, including a captain-granted gap exception or an effect requested after assignment, also permit re-review at the same head and evidence revision; inspect the current assigned record without rerunning validation.",
    `Assigned live-validation record: ${JSON.stringify(facts.validation ?? null)}`,
    `Read these kept proof files on this computer: ${JSON.stringify(facts.proofFiles ?? [])}`,
    "",
    "The builder's report:",
    facts.builderReport,
    "",
    ...(facts.evidenceDir ? [`The builder's evidence folder: ${facts.evidenceDir}`, ""] : []),
    ...(facts.captainCard ? captainCardLines(facts.captainCard) : []),
    `Delivery: ${DELIVERY_TEXT[delivery]}.`,
  ].join("\n");
}
