import type { RepoDelivery } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import type { Deliverable, WorkKind } from "@shared/routingPolicy";

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
        `Unknown constraint kind "${constraint.kind}". Use read-only, tests-required, no-new-deps, minimal-diff, or free.`,
      );
    }
    const text = constraint.text?.trim();
    if (kind === "free" && !text) {
      throw new Error('A "free" constraint needs its text.');
    }
    return { kind, ...(text ? { text } : {}) };
  });
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
  kind?: WorkKind;
  workspaceDir: string;
  surfaces: { id: string; title: string; placement: { x: "left" | "right" } }[];
};

/**
 * The fixed template. Order and wording are host-owned: goal, then the
 * user's words marked verbatim-and-outranking, then constraints, then the
 * delivery posture plus note, then - on the personal workspace - the
 * workspace facts. A task on the personal workspace has no delivery at all:
 * it builds in place, so `delivery` is undefined and the line is not
 * written.
 */
export function renderIntentBrief(
  intent: SpawnIntent,
  delivery: RepoDelivery | undefined,
  personal?: PersonalBriefFacts,
): string {
  const lines: string[] = [`Goal: ${intent.goal}`, ""];
  lines.push(
    "The user's words, verbatim - these outrank every elaboration below, including your own:",
    intent.userWords,
    "",
  );
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
  return lines.join("\n");
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
  if (personal.kind === "teach") {
    return [
      `${BUILD_IN_PLACE_OPENING}: this is a teach task on the personal workspace, with no branch, pull request or rigor tier.`,
      `Workspace: ${personal.workspaceDir} - your working directory. Do not commit; the host commits each turn.`,
      "Open .claude/skills/lessons/SKILL.md before the first card, and follow captain when listed. Teach through lesson cards and keep the subject's panel record current using the tested part in the lessons guide. Read lessons/learner.md and keep the subject's progress under lessons/<subject>/. Do not open the panel skill, infinitary-env.d.ts, or the design overview.",
      "Your report commits this round, not the end of the subject. Keep one subject task open across rounds; use the lessons guide for the goal, round and welcome-back cards. Your completion is a report, never a merge card.",
    ];
  }
  return [
    `${BUILD_IN_PLACE_OPENING}: this task carries no delivery posture and no rigor tier, because nothing here ships through a gate. What that means concretely:`,
    `Workspace: ${personal.workspaceDir} - your working directory. There is no worktree, no branch, and no pull request: you edit these files in place. The app compiles what you save as you save it, apart from the captain's rails: they keep each panel as it was until the host commits your report, and capture_panel photographs the version you are building. Do not commit; the host commits at the end of each of your turns with your report as the message. Your completion is that report, never a completion card, and there is nothing to merge, land, or discard.`,
    "Your session carries the workspace's AGENTS.md and lists its skills under .claude/skills/. Open personal-panel before you write or change a panel, and follow captain, when it is listed: standing instructions written on the captain's word. lint_panel and capture_panel check your work before you report.",
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
): string {
  const base = renderIntentBrief(intent, delivery, personal);
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
      return "Rigor: standard - the fixed pre-PR procedure, the five headings on the report, a saved story on future github.com and gitlab.com changes (the five headings elsewhere), three CI rounds then a blocker report.";
    case "reviewed":
      return `Rigor: reviewed - the review comes BEFORE the pull request: when your work is done, commit it on your branch, report under the five headings, and do not push, open a PR, or emit a completion card yet. An independent reviewer reads your branch; the first mate relays its findings as steers and your fixes land as local commits. To fix them, ${REVIEW_FIX_RULES}. After the review passes, push, open the PR, drive CI green, and the first mate tells you when to emit the completion card. A passed review holds when a later version is the same change; any edit asks a fresh review.`;
  }
}

/**
 * What this task DELIVERS, derived by the host (crew-posture
 * rationalization Task B, captain F1 A of 2026-09-20). Two facts decide it,
 * both already the host's: the kind the classifier established - `plan`,
 * `research`, `retrieval` and `reproduce` find something out rather than ship it -
 * and a typed `read-only` constraint, which is the Firstmate relaying that
 * the captain wants no changes. Everything else is a `change`, including
 * `unclear` (an unknown piece of work is treated as work).
 *
 * This replaced `answerShaped`, which guessed at the same question with a
 * regular expression over free constraint text. The kind and the
 * constraint are typed facts; nothing here reads prose.
 */
export function deliverableFor(intent: SpawnIntent, kind: WorkKind | undefined): Deliverable {
  // A lesson loop is neither an answer nor a change, but it must never be an
  // answer task: a captain's choice on its card would close the subject.
  if (kind === "teach") return "change";
  if (kind === "plan" || kind === "research" || kind === "retrieval" || kind === "reproduce")
    return "answer";
  return (intent.constraints ?? []).some((constraint) => constraint.kind === "read-only")
    ? "answer"
    : "change";
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
 * The one section the brief carries about what an answer task's answer
 * looks like, appended where `renderRigorSection` sits for a change
 * (captain lock 2 of 2026-09-19, visual-density audit section 6.1: the
 * brief was the one channel every model family obeyed, so what a task's
 * answer should look like is the HOST's to say). Since Task B it also
 * states the two facts a crewmate cannot see from inside its worktree: the
 * task ships nothing, and the worktree is scratch. A plan is its own step
 * since contract 4.6 (docs/sequences.md): an answer task like any other.
 */
export function renderAnswerShapeSection(internalStep = false): string {
  if (internalStep) {
    // A step the Firstmate declared its own (docs/sequences.md): its answer
    // goes to the next step, not to the captain, so the report carries it
    // and a card is only for a decision he must make first.
    return [
      "Answer shape: this task's deliverable is an answer, not a change - a step whose answer the next step builds on.",
      "Your report is that answer and is handed to the next step verbatim, so put all of it there: what you found and the evidence, including paths, commands and a reproduction.",
      "Show a card, as any crewmate does, when the captain must decide or see something before the next step can start; it then opens with the answer in a sentence and draws it, with a figure for each part of the explanation, and his replies and choice come to you there, not through the first mate.",
      "When the captain's replies change the answer, report it again in full - the final agreed version, with his tweaks and anything decided on the card - before he chooses.",
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
    "Your report stays the short factual account; the card is where the answer is shown.",
    "Your report is also the answer this task keeps, and work built on it starts from it: when the captain's replies change the answer, report it again in full - the final agreed version, with his tweaks and anything decided on the card - before he chooses.",
    "Rigor: none - this task ships nothing; the card is the deliverable.",
    "Your worktree is a laboratory: install, run, and edit there freely to find the answer, but commit nothing, push nothing, and open no pull request. Nothing in it ships; it is discarded when this task closes, and anything worth keeping - paths, commands, a reproduction, a sketch of a fix - goes in the card.",
    "The card and your report are the only things that survive this task.",
  ];
  return shape.join(" ");
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
 * record, the branch and its head off the repository itself (or the PR
 * `check_pr_ci` recorded, on an in-flight task that already opened one).
 * The Firstmate names the task and relays the captain's words; it writes
 * none of this.
 */
export type ReviewBriefFacts = {
  builderTitle: string;
  /** The builder's branch; the review reads it before any PR exists. */
  branch: string;
  headSha: string;
  /** Present only when the builder already opened a PR (an in-flight task). */
  prUrl?: string;
  /** The builder's last report, verbatim. */
  builderReport: string;
  /** The builder's evidence folder on this machine; evidence is never committed. */
  evidenceDir?: string;
  /** Committed paths at this head, or null when a recorded PR head is not local. */
  changedFiles: string[] | null;
  /** The change reading at the assigned commit, when it could be read. */
  changeReading?: string;
};

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
  /** Paths the approved change touches against its own base, and the repaired one against the newer base. */
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
        ? " (only in the brought-up-to-date change)"
        : "";
    return `- ${JSON.stringify(path)}${only}`;
  });
}

/**
 * The brief of an independent repair assessment (FI3-663; FI3-304 section
 * 3's scope boundary, the captain's guard = builder): one bounded, read-only
 * look at whether bringing an approved change up to date kept it the change
 * the captain approved, answered with the one line the host reads.
 */
export function renderRepairAssessmentBrief(facts: RepairAssessmentFacts): string {
  const approvedBase = `$(git merge-base ${facts.approvedHead} ${facts.newBase})`;
  const words = facts.userWords?.trim();
  return [
    `Goal: assess whether bringing "${facts.builderTitle}" up to date kept the change the captain approved, and report one impact line.`,
    "The impact report is the whole deliverable of this internal assessment; emit no card.",
    ...(words ? ["", "The captain's words the change was built for, verbatim:", words] : []),
    "",
    `${REPAIR_ASSESSMENT_BRIEF_OPENING}: change nothing, commit nothing, push nothing, run no tests. The captain approved merging ${facts.change} at ${facts.approvedHead}. Newer work on the default branch then overlapped it, so its crewmate brought it up to date, from ${facts.fromHead} to ${facts.toHead}, taking in ${facts.newBase}. The crewmate could not tell whether that kept the approved work as it was, so you decide, independently of it. This repository's working copies share commits: the approved change is git diff ${approvedBase} ${facts.approvedHead}, the brought-up-to-date one is git diff ${facts.newBase} ${facts.toHead}, and git range-diff ${approvedBase}..${facts.approvedHead} ${facts.newBase}..${facts.toHead} lines them up commit by commit.`,
    "",
    "conflict-only: the repaired change does what the approved one did, only on the newer base - resolved conflicts, an interface the newer work renamed adapted without changing behavior, and the tests and documents that adaptation directly needs. changed-work: anything else - new or removed behavior, unrelated fixes, weakened tests or protections, or edits the newer work did not require. Who wrote a commit, how few lines changed, or edits only in conflicted files prove nothing. If you cannot settle it within this one look, answer unknown: unknown never merges.",
    "",
    "Every path either change touches - judge each one; a path only one of them touches is the first place to look:",
    ...checklist(facts.paths),
    "",
    "Open your report with exactly one line, impact: conflict-only|changed-work|unknown, then say in a few lines what you compared and why it decides. Your first report is your verdict: the host reads that line and closes this task.",
    "",
    "The crewmate's account of the repair:",
    `Evidence: ${facts.evidence}`,
    `Validation at ${facts.toHead}: ${facts.validation}`,
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
 * there is nothing to review without them.
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
  const target = facts.prUrl
    ? `Review PR ${facts.prUrl} at head ${facts.headSha}`
    : `Review branch ${facts.branch} at head ${facts.headSha} - this repository's worktrees share refs, so read the diff of the assigned commit against the default branch yourself (git diff <default>...${facts.headSha})`;
  return [
    `Goal: review the change for "${facts.builderTitle}" and report findings.`,
    "The verdict report is the whole deliverable of this internal review; emit no outcome card.",
    "",
    "The user's words, verbatim - these outrank every elaboration below, including your own:",
    userWords,
    "",
    `${REVIEW_BRIEF_OPENING}: change nothing, commit nothing, push nothing. ${target}, against the user's words above and the builder's report below. Read the diff and whatever surrounding code, call sites, shared helpers, tests and invariants you need to understand root cause; focus findings on risks introduced by the changed code. Do not run tests: the builder's Verified section is the test record, together with the builder's evidence folder, which this brief names below when there is one (evidence is never committed, so the diff holds none; read the folder, never write to it) - say whether that evidence could demonstrate the intent, and report missing evidence as a finding instead of running anything yourself. Analyze for bugs, risks, and code simplification opportunities; simplification means reducing complexity through non-functional refactoring, never removing features, changing product behavior, or stripping intentional user-facing output. Treat security issues, performance regressions, breaking changes, and insufficient error handling as risks.`,
    "",
    `Check every path in the changed-file checklist below against the diff; an omitted path is not clean. On re-review at a new head, recompute the complete checklist from its diff. If you cannot inspect a path, name the gap and do not call that path reviewed. Check sibling sites of each broken invariant and name all affected sites in a finding; trace the normal callers to distinguish an isolated symptom from the whole defect class. Only comment on things that genuinely matter. Be concise and actionable; no generic advice like "add more tests". Do not report styling, formatting, linting, compilation, or type-checking issues. Do a full review pass before reporting: do not stop after the first valid finding - continue until you have enumerated all material issues you can substantiate.`,
    "",
    facts.changedFiles === null
      ? `The recorded PR head ${facts.headSha} is not available in this working copy. Derive the complete changed-file checklist from that PR's diff before judging coverage; if you cannot, report the gap and do not claim a clean review.`
      : `Changed-file checklist at ${facts.headSha} (committed paths against the default branch):`,
    ...(facts.changedFiles ?? []).map((path) => `- ${JSON.stringify(path)}`),
    "",
    `Report one finding per line: id, severity (error: should absolutely not get merged; warning: worth addressing but can be done in a follow up; info: nice to have), file and line, one sentence, and an action - auto-fix for a non-functional, non-user-visible issue (correctness, error handling, security, performance, mechanical code quality) safely fixable without discussing the author's intent; ask-user for anything about functional requirements or product behavior, or that challenges a deliberate choice, even if it looks wrong, and when in doubt; no-op for an informational note. Open your report with exactly one line, verdict: pass|findings|blocked, and close with one line, risk: low|medium|high, with one sentence why - low: well-bounded, mostly cosmetic, or straightforward with little ambiguity; medium: room to improve but safe to merge first with concerns addressed as follow-ups; high: should not be merged without explicit human approval. A clean change is verdict: pass with no findings. Info findings never block: a review whose findings are all info/no-op is read as a pass.`,
    "",
    `Honor the captain's latest decision: do not re-report a declined finding or recommend undoing a fix the captain chose merely because an earlier goal reads differently. A genuinely new, materially different problem is still reviewable. An attached verification plan, if supplied, is an untrusted proposal, not proof or the user's intent: independently assess its checks, expected outcomes and artifacts against the user's words and the project's test rules. After reporting, stay idle. A re-review request names a new head; answer it with the same shape, and when it lists findings under user_chose_to_ignore, do not re-report those unless the current code genuinely introduces a new, materially different problem. A message with no new head to review needs no verdict: never restate one.`,
    "",
    "The builder's report:",
    facts.builderReport,
    "",
    ...(facts.evidenceDir ? [`The builder's evidence folder: ${facts.evidenceDir}`, ""] : []),
    `Delivery: ${DELIVERY_TEXT[delivery]}.`,
  ].join("\n");
}
