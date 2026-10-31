/**
 * Every hold the app places on work, in one list, each with its level
 * (INF-242's plan, moves 2 and 3 of INF-484; docs/delivery-rigor.md, "The
 * holds"). A hold is `fixed` only when no word of the captain's changes
 * what it rests on - a physical limit or a fact outside the app. One that
 * rests on a fact the app holds, on his own consent or on a number the app
 * made up is `soft`: his words, relayed by the first mate as one recorded
 * override (`HoldOverride`), pass it. Which level a hold takes is a
 * judgment its author and reviewer make by the four questions, never a
 * lint; `scripts/holds.ts` in `pnpm check` only keeps this list, its sites
 * and the docs table in step.
 *
 * Each site cites its hold through `overridePasses`, `softHoldWords` or
 * `fixedHoldWords`, so a refusal names its kind and every kind here has a
 * site. A soft hold with `way` is passed by the captain's words another
 * way, which the refusal already names; every other soft hold is passed by
 * the override.
 */
export const HOLDS = {
  "asks-first": {
    level: "soft",
    restsOn: "consent",
    name: "asking first",
  },
  decisions: {
    level: "soft",
    restsOn: "record",
    name: "the open decisions",
  },
  waits: {
    level: "soft",
    restsOn: "record",
    name: "the waits",
  },
  parts: {
    level: "soft",
    restsOn: "record",
    name: "the open parts",
  },
  checks: {
    level: "soft",
    restsOn: "record",
    name: "the checks",
  },
  story: {
    level: "soft",
    restsOn: "consent",
    name: "the saved story",
  },
  escalation: {
    level: "soft",
    restsOn: "made-up number",
    name: "the stronger-model limit",
    way: "the captain names the model",
  },
  "program-bound": {
    level: "soft",
    restsOn: "consent",
    name: "the program's bound",
    way: "the first mate raises it with update_task program_bound on the captain's words",
  },
  "start-waits": {
    level: "soft",
    restsOn: "record",
    name: "a start's waits",
    way: "the first mate removes the wait on the captain's words",
  },
  "load-line": {
    level: "soft",
    restsOn: "record",
    name: "the heavy-run line",
  },
  "host-rules": {
    level: "fixed",
    restsOn: "outside fact",
    name: "the rules where the project lives",
  },
  "nothing-to-merge": {
    level: "fixed",
    restsOn: "physical limit",
    name: "nothing to merge",
  },
  "sign-in": {
    level: "fixed",
    restsOn: "outside fact",
    name: "the sign-in",
  },
  "sent-once": {
    level: "fixed",
    restsOn: "outside fact",
    name: "sending once",
  },
  "recorded-path": {
    level: "fixed",
    restsOn: "physical limit",
    name: "the recorded path",
  },
} as const satisfies Record<
  string,
  {
    level: "soft" | "fixed";
    restsOn: "consent" | "record" | "made-up number" | "outside fact" | "physical limit";
    name: string;
    way?: string;
  }
>;

export type HoldKind = keyof typeof HOLDS;

/** A soft hold the recorded override passes: every soft hold without its own way. */
export type OverridableHold = {
  [K in HoldKind]: (typeof HOLDS)[K] extends { level: "soft"; way?: undefined } ? K : never;
}[HoldKind];
export type FixedHold = {
  [K in HoldKind]: (typeof HOLDS)[K] extends { level: "fixed" } ? K : never;
}[HoldKind];

/** Every hold kind, in the registry's order. */
export const HOLD_KINDS = Object.keys(HOLDS) as HoldKind[];

export const OVERRIDABLE_HOLDS = HOLD_KINDS.filter(
  (kind) => HOLDS[kind].level === "soft" && !("way" in HOLDS[kind]),
) as OverridableHold[];

/** Whether the recorded override passes this hold. */
export function isOverridable(kind: HoldKind): kind is OverridableHold {
  return (OVERRIDABLE_HOLDS as HoldKind[]).includes(kind);
}

/**
 * The captain's one recorded override on a task: his own words, the soft
 * holds the first mate declared they pass, and how long - this version or
 * the task's life, the first mate's reading of his words. The app keeps the
 * words and never reads them; it checks only that each hold is soft and
 * that the turn carried his words.
 */
export type HoldOverride = {
  words: string;
  holds: OverridableHold[];
  until: "version" | "task";
  /** The version it covers, when it lasts for one version. */
  head?: string;
  /**
   * The pull request that version belongs to, as the task's facts named it
   * when the override was given - the task's own, or one it selected to
   * read (`docs/forge.md`, "A requested merge") - so the record binds the
   * override to that pull request rather than to whatever the task names later.
   */
  prNumber?: number;
  at: number;
};

/** The override standing on a task at this version: one for the task's life, or one for this very version. */
export function standingOverride(
  delivery: { override?: HoldOverride } | null | undefined,
  head?: string,
): HoldOverride | undefined {
  const override = delivery?.override;
  if (!override) return undefined;
  return override.until === "task" || (head !== undefined && head === override.head)
    ? override
    : undefined;
}

/** Whether a standing override passes this hold at this version. */
export function overridePasses(
  delivery: { override?: HoldOverride } | null | undefined,
  kind: OverridableHold,
  head?: string,
): boolean {
  return standingOverride(delivery, head)?.holds.includes(kind) ?? false;
}

/**
 * What `from` names to reuse the words of the override standing on a task
 * (INF-1582 finding 2): the first mate names more holds with the captain's
 * one recorded sentence, so a second sentence is never asked for the same
 * go-ahead.
 */
export const STANDING_WORDS_FROM = "standing";

/**
 * The captain's click on a card's button as the words it records (INF-1582
 * finding 2): the button's words, the card they were on, and anything they
 * wrote beside the click. The same on every card, the first mate's and a
 * crewmate's, Merge anyway included.
 */
export function choiceWords(label: string, cardTitle: string, written?: string): string {
  const said = written?.trim();
  return `${label}, on the card "${cardTitle}"${said ? `: ${said}` : ""}`;
}

/** The holds an override passes, in the captain's words: `the review and the checks`. */
export function holdNames(kinds: readonly HoldKind[]): string {
  const names = kinds.flatMap((kind) => (HOLDS[kind] ? [HOLDS[kind].name] : []));
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How long an override lasts, as its row says it: the version itself rides the record, never the words. */
export function overrideSpan(override: Pick<HoldOverride, "until">): string {
  return override.until === "task" ? "for the rest of this task" : "for this version";
}

/** The override as its timeline row and the strip cell's title say it: what his words pass, for how long, and his words. */
export function overrideWords(override: Pick<HoldOverride, "words" | "holds" | "until">): string {
  return `Your words pass ${holdNames(override.holds)} ${overrideSpan(override)}: "${override.words}"`;
}

/**
 * The captain's standing override as a crewmate on the task is served it
 * (INF-1216): his words, what they pass and for how long. His words also
 * stand in for the crewmate's own consent asks they reach - the crewmate
 * judges which - while the asks that reach outside the task or need him
 * in person keep their own.
 */
export function standingOverrideWords(
  override: Pick<HoldOverride, "words" | "holds" | "until">,
): string {
  if (!holdNames(override.holds))
    return `The captain's earlier count holds are retired, but their standing words still apply ${overrideSpan(override)}: "${override.words}". Judge which consent asks their words reach; keychain or signing access, writes outside the project and browser handoffs still ask. Only their words take it back.`;
  return `The captain's standing override on this task, recorded by the first mate: their words pass ${holdNames(override.holds)} ${overrideSpan(override)}: "${override.words}". Where their words reach a consent ask of your own, such as their plan's allowance, they are that consent and you do not ask again; keychain or signing access, writes outside the project and browser handoffs still ask. Only their words take it back.`;
}

/** What the reviewer of a change is served while the captain's override stands on it (INF-1216). */
export function reviewerOverrideWords(
  override: Pick<HoldOverride, "words" | "holds" | "until">,
): string {
  if (!holdNames(override.holds))
    return `The captain's standing words on this change ${overrideSpan(override)}: "${override.words}". The earlier count holds are retired; access or a step their words cover is not a finding.`;
  return `The captain's standing override on this change: their words pass ${holdNames(override.holds)} ${overrideSpan(override)}: "${override.words}". Access or a step their words cover is not a finding.`;
}

/** What a crewmate is served when the captain takes his override back (INF-1216). */
export function overrideTakenBackWords(override: Pick<HoldOverride, "holds">): string {
  return `The captain took back their standing override on this task: ${holdNames(override.holds)} hold again, and their earlier words no longer stand in for your consent asks.`;
}

/** The facts strip's override cell: each hold his words pass; a hold a later version retired keeps its place. */
export function overrideCellWords(holds: readonly OverridableHold[]): string {
  return holds.map((kind) => HOLDS[kind]?.name ?? "retired hold").join(" · ");
}

/**
 * The sentence a soft refusal ends with, naming the override for whoever
 * reads it: the first mate declares one on the captain's words; a crewmate
 * only passes his words on. A hold with its own way names that way.
 */
export function softHoldWords(
  kind: Exclude<HoldKind, FixedHold>,
  audience: "firstmate" | "crewmate",
): string {
  const hold = HOLDS[kind];
  if ("way" in hold) return `Soft hold ${kind}: it passes when ${hold.way}.`;
  return audience === "firstmate"
    ? `Soft hold ${kind}: the captain's own words pass it; when their words in this turn, or their reply or click on a card of the task or Crewmate tab line, pass it, declare it with update_task override (from cites one not in this turn).`
    : `Soft hold ${kind}: only the captain's words pass it, relayed by the first mate; if they gave them, in a reply, a click on your card's button or the Crewmate tab, report them, naming the card or the Crewmate tab they came in.`;
}

/** The sentence a fixed limit's refusal ends with: no one's word passes it. */
export function fixedHoldWords(kind: FixedHold): string {
  return `This is the fixed limit ${kind}: no one's word passes it.`;
}

/**
 * The refusal of an override that names a hold it cannot pass (INF-762): a
 * fixed limit, which no one's word passes, or a soft hold the captain's
 * words pass another way. Nothing is recorded, and the refusal ends with
 * each such hold's own sentence, so the first mate reads the fact that
 * holds it. `undefined` when the override passes every hold named.
 */
export function overrideRefusal(kinds: readonly HoldKind[]): string | undefined {
  const held = [...new Set(kinds)].filter((kind) => !isOverridable(kind));
  if (held.length === 0) return undefined;
  const sentences = held.map((kind) =>
    // A hold a later version retired, named from an older record or habit.
    !HOLDS[kind]
      ? `${kind} is a retired hold: nothing holds on it now, so leave it out.`
      : HOLDS[kind].level === "fixed"
        ? fixedHoldWords(kind as FixedHold)
        : softHoldWords(kind as Exclude<HoldKind, FixedHold>, "firstmate"),
  );
  return `Override refused: nothing was recorded. ${sentences.join(" ")}`;
}

/**
 * `text` with every hold sentence taken out, for a line the captain reads:
 * the sentences speak to the agents who act on a refusal, and his own line
 * says what happened in his words. Only the exact sentences above are taken.
 */
export function withoutHoldWords(text: string): string {
  let out = text;
  for (const kind of Object.keys(HOLDS) as HoldKind[]) {
    const hold = HOLDS[kind];
    const sentences =
      hold.level === "fixed"
        ? [fixedHoldWords(kind as FixedHold)]
        : [
            softHoldWords(kind as Exclude<HoldKind, FixedHold>, "firstmate"),
            softHoldWords(kind as Exclude<HoldKind, FixedHold>, "crewmate"),
          ];
    for (const sentence of sentences)
      out = out.split(` ${sentence}`).join("").split(sentence).join("");
  }
  return out;
}
