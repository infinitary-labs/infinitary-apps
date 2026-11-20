import { z } from "zod";
// Types only: decisions.ts reads this module's values for its view.
import type { DecisionConsentText, DecisionsSettings } from "./decisions";

/**
 * The approval screen a Jev or OpenRouter approval saw, kept as its
 * `consentedVersion`. The first screen described task classification's
 * facts alone, and an older view or home still writes it; this build's
 * screen covers every listed use.
 */
export const DECISION_FIRST_APPROVAL_VERSION = 1;
export const DECISION_APPROVAL_VERSION = 2;

/**
 * Every way Infinitary asks a decision model a question, one entry per use
 * (docs/decision-models.md, "The uses"). Settings → Intelligence draws its
 * Uses list from this list alone, and the decision service checks a use's
 * switch here before any model or key is read. Adding a use is adding an
 * entry: its kind says how it is switched, and `approval` says which
 * approval screen a Jev or OpenRouter approval must have seen before this
 * use reaches that model.
 *
 * A program's ask() is not a use: it asks for JSON in a shape it chooses,
 * which a decision model cannot be relied on to give, so it is answered by
 * the person's own models apart from this list (docs/programs.md).
 */

/**
 * How a use is switched:
 * - `always-on`: Infinitary needs it to work; its switch shows on and
 *   locked, and the home refuses to turn it off.
 * - `default-on`: on until the person turns it off.
 * - `needs-ok`: off until the person agrees to its own disclosure in the
 *   consent dialog, once.
 */
export const decisionUseKindSchema = z.enum(["always-on", "default-on", "needs-ok"]);
export type DecisionUseKind = z.infer<typeof decisionUseKindSchema>;

export const DECISION_USE_IDS = [
  "kind",
  "reply-checks",
  "computer",
  "reviewer",
  "event-screen",
  "card-reader",
] as const;
export type DecisionUseId = (typeof DECISION_USE_IDS)[number];

export type DecisionUse = {
  id: DecisionUseId;
  /** The row's name in Settings. */
  name: string;
  /** Under the name in Settings: how the use helps the person, and what it sends a decision model. */
  reads: string;
  kind: DecisionUseKind;
  /** The approval screen (`consentedVersion`) a Jev or OpenRouter approval needs for this use. */
  approval: number;
  /** A `needs-ok` use's own disclosure, agreed once at its version. */
  disclosure?: { version: number; text: DecisionConsentText };
};

export const DECISION_USES: readonly DecisionUse[] = [
  {
    id: "kind",
    name: "Task classification",
    reads:
      "Each new task runs on a model that fits the work, so easy tasks spend less of your plan's allowance. It reads the task's title, goal and your words, its project and related work.",
    kind: "always-on",
    // The first approval screen described exactly these facts.
    approval: DECISION_FIRST_APPROVAL_VERSION,
  },
  {
    id: "reply-checks",
    // The id stays `reply-checks`, as saved switches hold it.
    name: "Propose standing direction",
    reads:
      "When you tell your first mate how you like things done, it offers to keep that as a standing direction for the project, so you don't have to say it again. It reads your new replies, the conversation around them and the card you answered.",
    kind: "default-on",
    approval: DECISION_APPROVAL_VERSION,
  },
  {
    id: "computer",
    name: "Choose a computer for new work",
    reads:
      "When more than one computer can run a new task, it starts where your standing directions point. It reads the task's title and goal, your standing directions and each computer's room and models.",
    // On like reply checks: it reaches only the person's own models, or a
    // decision model whose approval covers every listed use (INF-1729).
    kind: "default-on",
    approval: DECISION_APPROVAL_VERSION,
  },
  {
    id: "reviewer",
    name: "Choose a model for reviews",
    reads:
      "When an independent review starts, it runs on the model your standing directions call for, or on the usual pick. It reads the task's title and goal, your standing directions and the models you placed.",
    // On like the computer use: the same kinds of facts, and the v2
    // approval screen covers every listed use (INF-5021).
    kind: "default-on",
    approval: DECISION_APPROVAL_VERSION,
  },
  {
    id: "event-screen",
    name: "Screen automation events",
    reads:
      "When an automation sets an Only if condition, events that plainly do not meet it skip your first mate and are listed in the automation's history. It reads each new event's summary, such as an email's sender and subject, and the automation's condition.",
    // Each event's summary is words from outside, written by anyone who can
    // email or invite the person: the first use that waits for their OK.
    kind: "needs-ok",
    approval: DECISION_APPROVAL_VERSION,
    disclosure: {
      version: 1,
      text: [
        "Each new event's summary, such as an email's sender and subject, and the automation's Only if condition go to the model answering decisions.",
        "Only an automation with an Only if condition is screened. Turn this off at any time and every event reaches your first mate again.",
        "One short question per event. When the answer is unclear, or no answer comes, the event reaches your first mate as before.",
      ],
    },
  },
  {
    id: "card-reader",
    name: "Reader check on cards",
    reads:
      "When a crewmate shows you a card, it learns whether the card reads plainly, so it can rewrite one before you have to ask. It reads the card's title and open text.",
    // Four questions on every card a crewmate sends: on the person's own
    // models that is a few seconds and a little allowance a card, so it
    // waits for their OK (INF-4000).
    kind: "needs-ok",
    approval: DECISION_APPROVAL_VERSION,
    disclosure: {
      version: 1,
      text: [
        "The title and open text of each card a crewmate shows you go to the model answering decisions.",
        "The crewmate sees which readings did not pass and decides whether to rewrite the card; a card is never held back. Turn this off at any time.",
        "Four short questions per card. With your own models answering, that takes a few seconds and a little of your plan's allowance each time.",
      ],
    },
  },
];

export function decisionUse(id: string): DecisionUse | undefined {
  return DECISION_USES.find((use) => use.id === id);
}

/**
 * The person's own switches, by use id: only the uses they switched, so a
 * use they never touched keeps its kind's default. A `needs-ok` use also
 * keeps the disclosure version they agreed to.
 */
export const decisionUseSwitchesSchema = z.record(
  z.string().min(1),
  z.strictObject({ on: z.boolean(), agreed: z.number().int().optional() }),
);
export type DecisionUseSwitches = z.infer<typeof decisionUseSwitchesSchema>;

/** Whether the use's switch is on: its saved switch, or its kind's default. */
export function decisionUseSwitchedOn(use: DecisionUse, switches: DecisionUseSwitches): boolean {
  if (use.kind === "always-on") return true;
  const saved = switches[use.id];
  if (use.kind === "needs-ok")
    return saved?.on === true && (saved.agreed ?? -1) >= (use.disclosure?.version ?? 0);
  return saved?.on ?? true;
}

/**
 * The approval screen the picked Jev or OpenRouter model's approval saw,
 * or null while the person's own models answer: a pick that is not turned
 * on is not the model answering, and the person's own models need no
 * approval of their own.
 */
export function decisionApproval(settings: DecisionsSettings): number | null {
  const { answerer } = settings;
  if (answerer.kind === "adapted") return null;
  const egress = settings.egress[answerer.kind === "native" ? answerer.id : "openrouter"];
  const seen = egress?.consentedVersion ?? -1;
  return egress?.enabled && seen >= DECISION_FIRST_APPROVAL_VERSION ? seen : null;
}

/**
 * Whether a use may ask now: always for an always-on use; otherwise its
 * switch is on and the answering model's approval covers it. An older
 * approval stops the use outright rather than sending its question to the
 * person's own models in that model's place.
 */
export function decisionUseAllowed(
  settings: DecisionsSettings,
  switches: DecisionUseSwitches,
  use: DecisionUse,
): boolean {
  if (use.kind === "always-on") return true;
  if (!decisionUseSwitchedOn(use, switches)) return false;
  return !decisionUseNeedsApproval(settings, use);
}

/** Whether the answering model's approval predates this use, so turning it on shows the approval again. */
export function decisionUseNeedsApproval(settings: DecisionsSettings, use: DecisionUse): boolean {
  const approval = decisionApproval(settings);
  return approval !== null && approval < use.approval;
}

/** One use as the Decisions group draws it; ids stay strings so a newer home may list more. */
export const decisionUseViewSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  reads: z.string(),
  kind: decisionUseKindSchema,
  /** Whether the use asks now: its switch and the answering model's approval. */
  on: z.boolean(),
  /** Turning it on first shows the answering model's approval again: its approval predates this use. */
  needsApproval: z.boolean(),
  /** A `needs-ok` use's disclosure, for the consent dialog; absent once agreed at its version. */
  disclosure: z.strictObject({ version: z.number().int(), text: z.array(z.string()) }).optional(),
});
export type DecisionUseView = z.infer<typeof decisionUseViewSchema>;

export function decisionUsesView(
  settings: DecisionsSettings,
  switches: DecisionUseSwitches,
): DecisionUseView[] {
  return DECISION_USES.map((use) => ({
    id: use.id,
    name: use.name,
    reads: use.reads,
    kind: use.kind,
    on: decisionUseAllowed(settings, switches, use),
    needsApproval: use.kind !== "always-on" && decisionUseNeedsApproval(settings, use),
    ...(use.disclosure && (switches[use.id]?.agreed ?? -1) < use.disclosure.version
      ? { disclosure: { version: use.disclosure.version, text: [...use.disclosure.text] } }
      : {}),
  }));
}

/**
 * One switch, as Settings sends it. `approve` is the approval screen the
 * person just agreed to in the consent dialog, raising the answering
 * model's approval; `agreed` is a `needs-ok` use's disclosure version.
 */
export const decisionUseRequestSchema = z.strictObject({
  id: z.string().min(1),
  on: z.boolean(),
  approve: z.number().int().optional(),
  agreed: z.number().int().optional(),
});
export type DecisionUseRequest = z.infer<typeof decisionUseRequestSchema>;
