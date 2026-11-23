import { appPartProblem } from "@shared/appParts";
import {
  bodyHeadings,
  COMPLETION_CARD_HEADINGS,
  type DomNode,
  ELEMENT_TYPES,
  HEADING_TAGS,
  NON_COPY,
  TIERED_STORY_HEADINGS,
  textOf,
} from "@shared/cardHeadings";
import { ANYTHING_ELSE_ANSWER, isPlayableBody, mergeEffectOf, settleEffectOf } from "@shared/cards";
import { hasHook } from "@shared/codeNames";
import type { Rigor } from "@shared/rigor";
import { tradeoffProblem } from "@shared/tradeoffChart";
import { ElementType, parseDocument } from "htmlparser2";
import { languageCompletionHeadings } from "../prompts/captainLanguage";
import type { EmittedCard } from "./cardTool";

/**
 * The emit_card boundary lint (contract v1.1; interaction P1 WI-11; one
 * card with effects, cards/tasks/agents P1; facts-and-fix refusals,
 * contract v2.0). Each rule turns a card rule into a host refusal whose
 * text names the real defect and the one fix. A refused card is never
 * shown; the thrown message reaches the model as a loud tool error and it
 * revises.
 *
 * A rule here refuses only what the host may hard-code (docs/principles.md,
 * "Build the agent's reach, never its verdicts"; INF-484 move 5): a typed
 * fact it holds, consent for an effect, a physical limit, or a product fact
 * the captain ruled. How a card is worded, how long it runs, how it opens,
 * where its evidence sits and what its buttons are called are the author's
 * verdicts: the contract states them as goals and nothing here refuses them.
 * Each rule, by its kind:
 *
 * - product fact (D-9): a card with actions (a decision) gives 2 or 3 of
 *   them and marks exactly one `default`, the step the emitter would take;
 * - product fact: figure text draws at 11 px or more in the usual card;
 * - typed fact: a body that arrived entity-escaped (`&lt;p&gt;` for `<p>`)
 *   is named as such, because it would render as literal tags - the Sep 15
 *   Claude crewmates that sent one were told they had "3 sentences" instead
 *   and rewrote correct content four times (contract v2.0);
 * - consent: an action never carries the host's own effect, and one that
 *   reads like a merge declares the settle it claims;
 * - consent: a decision that is not a preview asks a required radio,
 *   checkbox or select question unpicked, its recommendation only marked
 *   (contract 4.56), and ends each question with options with a Something
 *   else row unless it marks the options as the only answers (FI3-1002);
 * - the Firstmate's own rules and the crewmate's, each named by its kind
 *   where it is defined below.
 *
 * The lint asks for SHAPE, never for the absence of words: the v1 progress
 * ban list refused legitimate cards for containing "in progress" or "still
 * pending" (Sep 14), so it is gone, and nothing like it comes back - and
 * since P1 no rule reads an action id either, because an id is a name and
 * the host dispatches on the declared effect. The shape rules read the body
 * through htmlparser2 - the parser the host hashes a card's scripts with -
 * never through regex over markup. This is a SHAPE gate, never a safety one:
 * a body is rendered verbatim and the frame is what contains it, so nothing
 * here is load-bearing for security.
 *
 * What INF-484 move 5 retired as verdicts (E16, INF-365, counted the
 * refusals they cost): the title that must not lead with a SHA, the
 * decision's leading paragraph and the evidence after it, headings on a body
 * past 1,200 characters, the calm voice's ban on "!" and emoji, and a ready
 * plan's three button labels.
 *
 * What this lint no longer asks for, at contract v3.6 (captain lock 3 of
 * 2026-09-19 on the visual-density audit, 4.4b row 4): the five evidence
 * headings in a completion card's OPEN BODY. They were the third copy of a
 * record the crewmate's report and the PR body already carry, and requiring
 * them in the card is what made the app's most common card a text document.
 * They stay required where they belong - the report and the PR body - by the
 * crewmate prompt and `renderRigorSection`, and `scoreRigor` counts them
 * there (`reportEvidenceHeadings` in `@shared/rigor`).
 *
 * `lintCardShape` applies at BOTH boundaries (the crewmate's emit_card and
 * the Firstmate's). The settle-needs-a-task check, attach-first, and the
 * carded-task refusal (WI-12) are the Firstmate's alone:
 * `lintFirstmateCard`. The CI gate (G-1) and the PR-link rule went with the
 * Firstmate's merge-card branch (captain ruling D3): the crewmate's
 * completion card is the one merge decision, and the host renders the
 * PR link and CI state on it itself.
 */

/** An entity-escaped tag: `&lt;p&gt;`, `&lt;/ul&gt;`, `&lt;svg viewBox=...&gt;`. */
const ESCAPED_TAG = /&lt;\/?[a-z][a-z0-9-]*(?:\s[^&]*?)?\s*\/?&gt;/i;

/**
 * Consent: an action that CLAIMS a settle - a label or id reading like merge
 * or land - without declaring one. Not a word ban: a consistency check
 * between what a button says and what it does. Sep 4-5's thirty "Merge PR"
 * buttons that merged nothing were exactly this; with effects on the wire
 * the host runs a settle only where one is declared, so the claim must
 * carry it.
 */
const SETTLE_CLAIM_ID = /^(merge[-_ ]?pr|merge|land)([-_ ][a-z0-9]+|\d+)?$/i;
const SETTLE_CLAIM_LABEL = /^(merge|land)\b/i;

function fakeSettleRefusal(actions: EmittedCard["actions"]): string | undefined {
  const fake = actions.find(
    (action) =>
      !mergeEffectOf(action) &&
      !settleEffectOf(action) &&
      (SETTLE_CLAIM_ID.test(action.id) || SETTLE_CLAIM_LABEL.test(action.label)),
  );
  if (!fake) return undefined;
  return `action "${fake.id}" ("${fake.label}") reads like a merge but carries no merge effect, so the host would run nothing when it is clicked; declare effect { kind: "merge", after: "close" or "continue" } - the host merges the PR or merges locally by the task's posture - or name the action for what it does.`;
}

/**
 * A product fact (D-9): how many actions a decision gives (CARD_MECHANICS:
 * "A decision gives 2 or 3 actions"). One is no choice - the app's Decline
 * (`withAppDecline`) is a way to say no, not an alternative, and it is
 * added after this count - and four are a menu. FI3-409's live check showed one with a radio question and a lone
 * "Save this answer" going up because nothing counted. The lint reads the
 * card the captain gets: a crewmate's completion decision is counted after
 * the host writes its merge and discard pair.
 */
const DECISION_ACTIONS_MIN = 2;
const DECISION_ACTIONS_MAX = 3;

function decisionActionsRefusal(all: EmittedCard["actions"]): string | undefined {
  // The host's Review carefully rides beside its merge and discard
  // (INF-562): it is the app's offer, never a choice the author counts.
  const actions = all.filter((action) => !action.care);
  const count = actions.length;
  if (count >= DECISION_ACTIONS_MIN && count <= DECISION_ACTIONS_MAX) return undefined;
  const given = `a decision gives ${DECISION_ACTIONS_MIN} or ${DECISION_ACTIONS_MAX} actions, and this one gives ${count} (${actions
    .map((action) => action.id)
    .join(", ")})`;
  return count < DECISION_ACTIONS_MIN
    ? `${given}; add the other choice the captain could make beside your default, such as the alternative answer, or emit a note with no actions when nothing is asked.`
    : `${given}; keep the ${DECISION_ACTIONS_MIN} or ${DECISION_ACTIONS_MAX} choices that matter, and ask anything finer as a question in the body.`;
}

export type ShapedCard = Pick<EmittedCard, "title" | "body" | "actions">;

/**
 * A typed fact: the refusal for a body that arrived entity-escaped, whose
 * parsed body holds no element at all while its text spells tags out as
 * `&lt;p&gt;`. Only the whole-body case is refused - a body that shows one
 * literal tag inside a real paragraph is a code sample, and renders as one.
 */
export const ESCAPED_BODY_REFUSAL =
  "the body arrived HTML-escaped (&lt;p&gt; where <p> was meant), so it would render as literal tags instead of markup; send raw HTML tags.";

function escapedBodyRefusal(body: string): string | undefined {
  if (!ESCAPED_TAG.test(body)) return undefined;
  const hasElement = parseDocument(body, { decodeEntities: true }).children.some((node) =>
    ELEMENT_TYPES.has(node.type),
  );
  return hasElement ? undefined : ESCAPED_BODY_REFUSAL;
}

/**
 * Consent (docs/secrets.md, "Asking to keep a secret"; INF-4239): a
 * password field on an agent's own card would carry what the captain types
 * back as the card's answer, into the agent's wake, the card's thread and
 * the task record. Infinitary's own ask draws that field outside the card's
 * page instead, so an agent card that holds one is refused and pointed to
 * the ask. A markup field and a script that makes one are both read.
 */
export const PASSWORD_FIELD_REFUSAL =
  "the body holds a password field, whose answer would reach you and the card's record; never ask for a secret on a card: ask to keep it in Secrets instead (ask_secret for the first mate, infinitary-secrets-axi ask for a crewmate), and the app draws its own masked field.";

const SCRIPTED_PASSWORD =
  /\btype\s*=\s*["'`]password["'`]|["'`]type["'`]\s*,\s*["'`]password["'`]/i;

function passwordFieldRefusal(body: string): string | undefined {
  if (!/password/i.test(body)) return undefined;
  const walk = (nodes: DomNode[]): boolean =>
    nodes.some((node) => {
      if (!ELEMENT_TYPES.has(node.type)) return false;
      // A script that makes the field is read as its script text alone; words
      // quoting the markup, as in <code> or <pre>, make no field.
      if (node.name?.toLowerCase() === "script")
        return (node.children ?? []).some((child) => SCRIPTED_PASSWORD.test(child.data ?? ""));
      const attrs = (node as FigureNode).attribs ?? {};
      if (node.name?.toLowerCase() === "input" && attrs.type?.trim().toLowerCase() === "password")
        return true;
      return walk(node.children ?? []);
    });
  return walk(parseDocument(body).children as DomNode[]) ? PASSWORD_FIELD_REFUSAL : undefined;
}

/** A product fact: the usual card's figure column, a 560 px card less its
 * 1 px border, 20 px body padding each side and 4 px frame padding each side. Draw-at-true-size
 * measures the 11 px floor here, not at the 350 px column a card gets with a
 * thread beside it. A narrower card shrinks labels with the drawing, and that
 * shrink is accepted: the emitter cannot know the captain's window. */
const USUAL_FIGURE_WIDTH = 750;
const MIN_RENDERED_TYPE = 11;

type FigureNode = DomNode & { attribs?: Record<string, string> };

function declaredSize(node: FigureNode, inherited: number): number {
  const attrs = node.attribs ?? {};
  const style = attrs.style?.match(/(?:^|;)\s*font-size\s*:\s*([^;]+)/i)?.[1]?.trim();
  const value = style ?? attrs["font-size"];
  if (!value) return inherited;
  const px = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(value);
  if (px) return Number(px[1]);
  const em = /^(\d+(?:\.\d+)?)\s*em$/i.exec(value);
  return em ? inherited * Number(em[1]) : Number.NaN;
}

/** Read actual SVG text nodes rather than guessing from shape geometry or label length.
 * An SVG with no viewBox, or one whose dimensions use non-pixel CSS, cannot be
 * measured honestly from markup and is left to the author's guidance. */
function figureTypeRefusal(body: string): string | undefined {
  const document = parseDocument(body);
  const walk = (
    node: FigureNode,
    svgScale: number | undefined,
    size: number,
    flowing = false,
  ): string | undefined => {
    if (!ELEMENT_TYPES.has(node.type)) return undefined;
    const name = node.name?.toLowerCase() ?? "";
    if (name === "script" || name === "style") return undefined;
    let scale = svgScale;
    if (name === "svg") {
      const viewBox = node.attribs?.viewBox ?? node.attribs?.viewbox;
      const units = viewBox
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      const width = units?.length === 4 ? units[2] : undefined;
      const declaredWidth = node.attribs?.width;
      const fixed = declaredWidth && /^(\d+(?:\.\d+)?)\s*(?:px)?$/.exec(declaredWidth);
      const percent = declaredWidth && /^(\d+(?:\.\d+)?)\s*%$/.exec(declaredWidth);
      const available = percent
        ? (USUAL_FIGURE_WIDTH * Number(percent[1])) / 100
        : fixed
          ? Number(fixed[1])
          : USUAL_FIGURE_WIDTH;
      scale = width && width > 0 ? Math.min(USUAL_FIGURE_WIDTH, available) / width : undefined;
    }
    const fontSize = declaredSize(node, size);
    // Check only a text element or a flowing element's own text, not the
    // entire subtree: descendants may override the inherited size.
    const hasOwnText = node.children?.some(
      (child) => child.type === ElementType.Text && child.data?.trim(),
    );
    if (
      scale !== undefined &&
      hasOwnText &&
      (name === "text" || name === "tspan" || name === "textpath" || flowing) &&
      fontSize * scale < MIN_RENDERED_TYPE - 0.001
    ) {
      return `figure text would draw at ${(fontSize * scale).toFixed(1)} px in the usual card (declared ${fontSize} px), under 11 px; use a full-width drawing of at most 750 units, or larger type. A smaller drawing takes its pixel width, not 100 percent, so the card only shrinks it.`;
    }
    for (const child of node.children ?? []) {
      const refusal = walk(
        child as FigureNode,
        scale,
        fontSize,
        flowing || name === "foreignobject",
      );
      if (refusal) return refusal;
    }
    return undefined;
  };
  for (const node of document.children) {
    const refusal = walk(node as FigureNode, undefined, 12);
    if (refusal) return refusal;
  }
  return undefined;
}

type ControlNode = DomNode & {
  attribs?: Record<string, string>;
  startIndex?: number | null;
  endIndex?: number | null;
  parent?: ControlNode | null;
};

/** An option's value as the frame reads it: its value attribute, else its own words. */
function optionValue(option: ControlNode): string {
  return option.attribs?.value ?? textOf(option).replace(/\s+/g, " ").trim();
}

function selectOptions(select: ControlNode): { option: ControlNode; disabled: boolean }[] {
  const all: { option: ControlNode; disabled: boolean }[] = [];
  const collect = (nodes: DomNode[], groupDisabled: boolean): void => {
    for (const node of nodes as ControlNode[]) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase();
      const disabled = groupDisabled || node.attribs?.disabled !== undefined;
      if (name === "option") all.push({ option: node, disabled });
      else if (name === "optgroup") collect(node.children ?? [], disabled);
    }
  };
  collect(select.children ?? [], false);
  return all;
}

/** What a select opens on: the marked options, else the first enabled option
 * a single-row dropdown picks by itself; and whether it can open empty. */
function openingOptions(select: ControlNode): {
  options: ControlNode[];
  written: boolean;
  needsChoose: boolean;
} {
  const all = selectOptions(select);
  const attrs = select.attribs ?? {};
  const single = attrs.multiple === undefined && Number(attrs.size ?? 1) <= 1;
  const first = all[0];
  const needsChoose = single && !(first && !first.disabled && optionValue(first.option) === "");
  const marked = all.filter(({ option }) => option.attribs?.selected !== undefined);
  if (marked.length > 0) {
    return { options: marked.map(({ option }) => option), written: true, needsChoose };
  }
  const enabled = all.find(({ disabled }) => !disabled);
  return { options: single && enabled ? [enabled.option] : [], written: false, needsChoose };
}

/**
 * Consent: a required choice question that arrives answered (contract 4.56;
 * FI3-517 direction A), and where its answer is written: a radio or checkbox
 * written `checked`, or a select whose opening option has a value.
 */
export type PreansweredQuestion = {
  name: string;
  /** What answers it, in words: `"project" is checked`. */
  answered: string;
  /** Each answering start tag's offset in the body: an input written
   * `checked`, or the option a select opens on (`written` false when the
   * dropdown picks it by itself). */
  picks: { at: number; attribute: "checked" | "selected"; written: boolean }[];
  /** The offsets of its single-row selects that have no empty option to open on. */
  chooseAt: number[];
};

/**
 * Every required choice question in a body that arrives answered. The
 * captain could send one with the default before reading its options, so
 * the author leaves it unpicked and marks its recommendation instead.
 * Grouping and `required` read the way the frame bridge reads them: by
 * name, a disabled control is no question, and one required control makes
 * its whole question required. Text fields keep their prefilled text.
 */
export function preansweredQuestions(body: string): PreansweredQuestion[] {
  const document = parseDocument(body, { decodeEntities: true, withStartIndices: true });
  const questions = new Map<string, PreansweredQuestion & { required: boolean }>();
  const question = (name: string) => {
    const known = questions.get(name);
    if (known) return known;
    const fresh = { name, answered: "", picks: [], chooseAt: [], required: false };
    questions.set(name, fresh);
    return fresh;
  };
  const walk = (nodes: DomNode[]): void => {
    for (const node of nodes as ControlNode[]) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const tag = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(tag)) continue;
      const attrs = node.attribs ?? {};
      const name = attrs.name;
      const at = node.startIndex ?? -1;
      if (tag === "input" && name && attrs.disabled === undefined) {
        const type = (attrs.type ?? "text").toLowerCase();
        if (type !== "radio" && type !== "checkbox") continue;
        const entry = question(name);
        if (attrs.required !== undefined) entry.required = true;
        const value = attrs.value ?? "on";
        if (attrs.checked === undefined || value === "") continue;
        entry.answered ||= `"${value}" is checked`;
        entry.picks.push({ at, attribute: "checked", written: true });
        continue;
      }
      if (tag === "select" && name && attrs.disabled === undefined) {
        const entry = question(name);
        if (attrs.required !== undefined) entry.required = true;
        const opening = openingOptions(node);
        const valued = opening.options.filter((option) => optionValue(option) !== "");
        if (valued.length === 0) continue;
        entry.answered ||= `"${optionValue(valued[0] as ControlNode)}" is selected`;
        for (const option of valued) {
          entry.picks.push({
            at: option.startIndex ?? -1,
            attribute: "selected",
            written: opening.written,
          });
        }
        if (opening.needsChoose) entry.chooseAt.push(at);
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(document.children as unknown as DomNode[]);
  return [...questions.values()]
    .filter((entry) => entry.required && entry.answered)
    .map(({ required: _required, ...entry }) => entry);
}

/** A refusal's words for a pre-answered question; a scripted stand-in recognizes them. */
export const PREANSWERED_WORDS = "arrives already answered";

function preansweredRefusal(body: string): string | undefined {
  const first = preansweredQuestions(body)[0];
  if (!first) return undefined;
  return `the required question "${first.name}" ${PREANSWERED_WORDS} (${first.answered}), so the captain could send it before reading the options; leave radio, checkbox and select questions unpicked - a select opens on an empty <option value="">Choose</option> - and put data-inf-recommended on the input or option you recommend.`;
}

/**
 * Every radio or select question in a body that the captain may skip and
 * that marks no option (INF-4425): not required, arriving unanswered, with
 * no `data-inf-recommended` on any of its options. A skip sends the marked
 * option, so a question with none would send nothing the author can act on.
 * Grouping and `required` read the way the frame bridge reads them: by
 * name, a disabled control is no question, and one required control makes
 * its whole question required. A question that arrives answered sends its
 * answer, so it needs no mark; checkboxes and text fields need none. `at`
 * is the offset of the question's first control's start tag in the body.
 */
export type UnmarkedSkippable = { name: string; at: number };

export function unmarkedSkippableQuestions(body: string): UnmarkedSkippable[] {
  const document = parseDocument(body, { decodeEntities: true, withStartIndices: true });
  type Entry = {
    at: number;
    offered: boolean;
    required: boolean;
    marked: boolean;
    answered: boolean;
  };
  const questions = new Map<string, Entry>();
  const question = (name: string, at: number): Entry => {
    const known = questions.get(name);
    if (known) return known;
    const fresh = { at, offered: false, required: false, marked: false, answered: false };
    questions.set(name, fresh);
    return fresh;
  };
  const walk = (nodes: DomNode[]): void => {
    for (const node of nodes as ControlNode[]) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const tag = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(tag)) continue;
      const attrs = node.attribs ?? {};
      const name = attrs.name;
      if (tag === "input" && name && attrs.disabled === undefined) {
        const type = (attrs.type ?? "text").toLowerCase();
        if (type !== "radio" && type !== "checkbox") continue;
        const entry = question(name, node.startIndex ?? -1);
        if (attrs.required !== undefined) entry.required = true;
        if (hasHook(attrs, "recommended")) entry.marked = true;
        if (type === "checkbox") entry.answered = true;
        else if (!hasHook(attrs, "write-in") && (attrs.value ?? "on") !== "") entry.offered = true;
        if (attrs.checked !== undefined) entry.answered = true;
        continue;
      }
      if (tag === "select" && name && attrs.disabled === undefined) {
        const entry = question(name, node.startIndex ?? -1);
        if (attrs.required !== undefined) entry.required = true;
        for (const { option } of selectOptions(node)) {
          if (hasHook(option.attribs, "recommended")) entry.marked = true;
          if (!hasHook(option.attribs, "write-in") && optionValue(option) !== "")
            entry.offered = true;
        }
        if (openingOptions(node).options.some((option) => optionValue(option) !== "")) {
          entry.answered = true;
        }
        continue;
      }
      if (tag === "fieldset" && attrs.disabled !== undefined) continue;
      walk(node.children ?? []);
    }
  };
  walk(document.children as unknown as DomNode[]);
  return [...questions.entries()]
    .filter(([, entry]) => entry.offered && !entry.required && !entry.marked && !entry.answered)
    .map(([name, entry]) => ({ name, at: entry.at }));
}

/** A refusal's words for a skippable question with no marked option; a scripted stand-in recognizes them. */
export const UNMARKED_SKIP_WORDS = "may be skipped but marks no option";

function unmarkedSkipRefusal(body: string): string | undefined {
  const first = unmarkedSkippableQuestions(body)[0];
  if (!first) return undefined;
  return `the question "${first.name}" ${UNMARKED_SKIP_WORDS}, so a skip would send nothing; put data-inf-recommended on the option you would act on if the captain skips it - the app shows it as Default and a skip sends it - or, when you need the captain's own answer, add required to the question.`;
}

/**
 * Consent: the mark on a question's Something else row (FI3-1002), as a
 * refusal names it. Every hook is read in either spelling (`hasHook`), so a
 * card a crewmate on the other side of the Infinitary rename writes passes
 * too.
 */
const WRITE_IN_MARK = "data-inf-write-in";
/** The mark on a question's fieldset or select whose options are the only answers. */
const OPTIONS_ONLY_MARK = "data-inf-options-only";

/**
 * A choice question that gives the captain no way to write an answer that
 * is none of its options (FI3-1002, the captain's way B): no Something else
 * row, and no mark saying its options are the only answers. `at` is the
 * body offset just past its last row - the label around its last radio or
 * checkbox, or its select's last option - where a row would go; -1 when the
 * markup gives none.
 */
export type WriteInGap = { name: string; control: "radio" | "checkbox" | "select"; at: number };

/**
 * Every choice question in a body that offers options with no Something
 * else row (`data-inf-write-in`) and no `data-inf-options-only` on its
 * fieldset or select. A radio group and a dropdown with an option need one,
 * and so does a group of two or more checkboxes; a lone checkbox is a
 * switch, and text fields need none. Grouping reads the way the frame
 * bridge reads it: by name, and a disabled control is no question.
 */
export function writeInGaps(body: string): WriteInGap[] {
  const document = parseDocument(body, {
    decodeEntities: true,
    withStartIndices: true,
    withEndIndices: true,
  });
  type Entry = WriteInGap & { offered: number; writeIn: boolean; optionsOnly: boolean };
  const questions = new Map<string, Entry>();
  const question = (name: string, control: WriteInGap["control"]): Entry => {
    const known = questions.get(name);
    if (known) return known;
    const fresh = { name, control, at: -1, offered: 0, writeIn: false, optionsOnly: false };
    questions.set(name, fresh);
    return fresh;
  };
  const past = (node: ControlNode | null | undefined): number =>
    typeof node?.endIndex === "number" ? node.endIndex + 1 : -1;
  const walk = (nodes: DomNode[], optionsOnly: boolean): void => {
    for (const node of nodes as ControlNode[]) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const tag = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(tag)) continue;
      const attrs = node.attribs ?? {};
      const name = attrs.name;
      if (tag === "input" && name && attrs.disabled === undefined) {
        const type = (attrs.type ?? "text").toLowerCase();
        if (type !== "radio" && type !== "checkbox") continue;
        const entry = question(name, type);
        if (hasHook(attrs, "write-in")) entry.writeIn = true;
        else if ((attrs.value ?? "on") !== "") entry.offered += 1;
        if (optionsOnly) entry.optionsOnly = true;
        entry.at = past(node.parent?.name?.toLowerCase() === "label" ? node.parent : node);
        continue;
      }
      if (tag === "select" && name && attrs.disabled === undefined) {
        const entry = question(name, "select");
        for (const { option } of selectOptions(node)) {
          if (hasHook(option.attribs, "write-in")) entry.writeIn = true;
          else if (optionValue(option) !== "") entry.offered += 1;
          entry.at = past(option);
        }
        if (optionsOnly || hasHook(attrs, "options-only")) entry.optionsOnly = true;
        continue;
      }
      if (tag === "fieldset" && attrs.disabled !== undefined) continue;
      walk(
        node.children ?? [],
        optionsOnly || (tag === "fieldset" && hasHook(attrs, "options-only")),
      );
    }
  };
  walk(document.children as unknown as DomNode[], false);
  return [...questions.values()]
    .filter((entry) => !entry.writeIn && !entry.optionsOnly)
    .filter((entry) => entry.offered >= (entry.control === "checkbox" ? 2 : 1))
    .map(({ name, control, at }) => ({ name, control, at }));
}

/** A refusal's words for a question with no way out; a scripted stand-in recognizes them. */
export const WRITE_IN_GAP_WORDS = "offers options with no Something else row";

function writeInRefusal(body: string): string | undefined {
  const first = writeInGaps(body)[0];
  if (!first) return undefined;
  const row =
    first.control === "select"
      ? `<option value="other" ${WRITE_IN_MARK}>Something else</option> as its last option`
      : `<label><input type="${first.control}" name="${first.name}" value="other" ${WRITE_IN_MARK}> Something else</label> as its last row`;
  return `the question "${first.name}" ${WRITE_IN_GAP_WORDS}, so the captain has no way to write an answer that is none of them; give it ${row} - the app opens a text field under it once picked - or, when its options are the only possible answers, put ${OPTIONS_ONLY_MARK} on its <fieldset> or <select>.`;
}

/** A refusal's words for an author's control under the name of the app's own field's answer. */
export const ANYTHING_ELSE_TAKEN_WORDS = "is the answer of the app's own field";

/**
 * Whether a body names a control, or stages a setting, `anything_else`: the
 * answer the app's own field rides the footer click as (INF-680, INF-924),
 * so an author's own would collide with it.
 */
function anythingElseRefusal(body: string): string | undefined {
  const document = parseDocument(body, { decodeEntities: true });
  let named = false;
  const walk = (nodes: DomNode[]): void => {
    for (const node of nodes as ControlNode[]) {
      if (named || !ELEMENT_TYPES.has(node.type)) continue;
      const tag = node.name?.toLowerCase() ?? "";
      if (
        (tag === "input" || tag === "select" || tag === "textarea") &&
        node.attribs?.name === ANYTHING_ELSE_ANSWER
      ) {
        named = true;
        return;
      }
      walk(node.children ?? []);
    }
  };
  walk(document.children as unknown as DomNode[]);
  const staged = new RegExp(`inf\\.stage\\(\\s*["'\`]${ANYTHING_ELSE_ANSWER}["'\`]`).test(body);
  if (!named && !staged) return undefined;
  return `the name "${ANYTHING_ELSE_ANSWER}" ${ANYTHING_ELSE_TAKEN_WORDS}, which the app draws above the buttons and sends with the button the captain clicks; rename your control or setting, or drop it if it only asked for further comments.`;
}

/**
 * The shape rules both boundaries share (WI-11). Returns the corrective
 * refusal, or undefined when the card passes.
 */
export function lintCardShape(card: ShapedCard): string | undefined {
  // Consent: the host's own effect is the agent-down cards' and no agent's:
  // an agent that wants the captain in Settings declares open.
  const hostEffect = card.actions.find((action) => action.effect?.kind === "host");
  if (hostEffect) {
    return `action "${hostEffect.id}" carries a host effect, which only the app's own cards may; declare settle or open, or no effect for a choice that returns to you.`;
  }
  const fake = fakeSettleRefusal(card.actions);
  if (fake) return fake;
  // Consent, in a preview too: a secret is never typed into an agent's card.
  const password = passwordFieldRefusal(card.body);
  if (password) return password;

  // A product fact (D-9): a card with actions is a decision (one card
  // shape, ruling D1 a), with 2 or 3 actions and one default.
  const decision = card.actions.length > 0;
  if (decision) {
    const count = decisionActionsRefusal(card.actions);
    if (count) return count;
    const defaults = card.actions.filter((action) => action.default);
    if (defaults.length === 0) {
      return "a decision marks the step you would take: set default true on exactly one action (it becomes the primary button).";
    }
    if (defaults.length > 1) {
      return `a decision has exactly one default, and this one marks ${defaults.length} (${defaults
        .map((action) => action.id)
        .join(", ")}); keep default only on the step you would take.`;
    }
  }

  // A product fact: the app's own box owns its answer's name, in a preview too.
  if (decision) {
    const taken = anythingElseRefusal(card.body);
    if (taken) return taken;
  }

  // A product fact: a body names only a part the app ships, in the one form
  // every reader fills (docs/card-authoring.md, "Parts by reference").
  const partRefusal = appPartProblem(card.body);
  if (partRefusal) return partRefusal;

  // A product fact: the app draws a tradeoff table only from its structure -
  // two headings or more, a row per option naming it, a level in every cell
  // and a row for the option marked as what the code does now, when one is
  // (docs/card-authoring.md, "The tradeoff chart"); no heading's or option's
  // words and no card kind are read.
  const tradeoffRefusal = tradeoffProblem(card.body);
  if (tradeoffRefusal) return tradeoffRefusal;

  // A product fact: no figure text under 11 px, in a preview too.
  const figureRefusal = figureTypeRefusal(card.body);
  if (figureRefusal) return figureRefusal;
  // A playable preview is the mock of a thing, whose controls carry its
  // settings: the question rules below read a body as a question, so a
  // playable preview returns before them. Shape, not kind, decides
  // (isPlayableBody); a body that only brings a style sheet still asks
  // questions (INF-5452). The action rules above still apply: a preview that
  // offers a choice is still a decision.
  if (isPlayableBody(card.body)) return undefined;

  const escaped = escapedBodyRefusal(card.body);
  if (escaped) return escaped;

  if (decision) {
    const preanswered = preansweredRefusal(card.body);
    if (preanswered) return preanswered;
    const writeIn = writeInRefusal(card.body);
    if (writeIn) return writeIn;
    const unmarked = unmarkedSkipRefusal(card.body);
    if (unmarked) return unmarked;
  }
  return undefined;
}

export type CardLintContext = {
  /** Resolve a model-passed stable id to the routable card id. */
  resolveCardId: (stableId: string) => string;
  /**
   * Whether a task id names a record (task-system P1, attach first). Absent
   * = the boundary has no task record to check against.
   */
  taskExists?: (taskId: string) => boolean;
  /** Whether a task id or key names a record, for `related`. Absent = unchecked. */
  taskResolves?: (ref: string) => boolean;
  /**
   * Whether a task id names a closed record (done or dropped). A choice on
   * a closed task's card is refused on the click, so the emit refuses it
   * first. Absent = the boundary cannot see task status.
   */
  taskClosed?: (taskId: string) => boolean;
  /**
   * The task's newest open card its crewmate emitted (WI-12). Absent = the
   * boundary cannot see the stack.
   */
  openCrewmateCard?: (taskId: string) => { id: string; title: string } | undefined;
  /** Whether a resolved card id is an open Firstmate card on the task (a revision). */
  isOpenFirstmateCard?: (cardId: string, taskId: string) => boolean;
  /**
   * Whether a resolved card id is an open card already on the task, such as
   * the app's required-action card: revising it keeps its task (INF-2714).
   */
  openCardOnTask?: (cardId: string, taskId: string) => boolean;
  /**
   * Whether the task's own crewmate is still the one that emits its
   * completion card (contract v3.6, captain lock 3; audit 4.4b row 9).
   * Absent = the boundary cannot see the crew, so the rule does not apply.
   */
  crewmateOwesCompletion?: (taskId: string) => boolean;
};

/**
 * A typed fact: a note of the first mate's is its own card (INF-2714, the
 * captain's direction A): it names the tasks it is about in its words and
 * `related`, never as its task, so its head, its asked line and the
 * question's life stay the first mate's. A review relay keeps its task.
 */
export const NOTE_NAMES_TASK_REFUSAL =
  "a note is your own card: drop task_id, name the tasks it is about in its words and pass their ids or keys in related. task_id is for a decision whose buttons act on that task, or with review_task_id when relaying a review's findings.";

/** A typed fact: a related task must name a record. */
export function unknownRelatedRefusal(ref: string): string {
  return `unknown related task "${ref}"; use a task id or key from the about line, the context's crew or open cards, crew_status, or the tasks tool.`;
}

/**
 * A typed fact: the closed-task choice refusal - the click refuses every
 * choice on a card whose task is closed (`CardActions.act`), so the emit
 * names the ways out instead of putting up buttons that cannot work.
 */
export function closedTaskChoiceRefusal(taskId: string): string {
  return `task ${taskId} is closed, so a choice on a card about it cannot be taken. Either file the follow-up with create_task, with basis ${taskId} so its report and answers carry over, and pass the new task_id; or emit this decision without task_id (it becomes its own decision task and the choice comes back to you), then name basis ${taskId} on the work the choice starts. A note with no actions may still carry the closed task's id.`;
}

/** A typed fact: the one structural settle check - a settle effect must know its task. */
export function settleNeedsTaskRefusal(
  card: Pick<EmittedCard, "actions" | "taskId">,
): string | undefined {
  const settle = card.actions.find((action) => settleEffectOf(action) || mergeEffectOf(action));
  if (settle && !card.taskId) {
    return `action "${settle.id}" carries a merge or discard effect, so the card must pass task_id; without it the host cannot tell which task to merge or discard and the button does nothing.`;
  }
  return undefined;
}

/**
 * Consent, held as a ceiling: the merge-card refusal (contract v3.6, captain
 * lock 3 on the visual-density audit, 4.4b row 9). "Never author a merge
 * card for a crewmate's task" has been a captain ruling since v2.0 and prose
 * did not hold it: on 2026-09-19, after each of four reviews passed, the
 * Firstmate steered the crewmate to emit its completion card AND emitted its
 * own merge card in the same turn, so the captain got two merge cards per
 * task and the Firstmate closed three of its own as duplicates. WI-12 only caught the case where the crewmate's
 * card was already on screen; here the Firstmate got there first, which is
 * why this reads the crew rather than the stack. A task whose crewmate has
 * already emitted its completion card is not covered: a settle refusal's ways
 * out are a legitimate Firstmate card, and by then the completion card exists.
 */
export function crewmateOwesCompletionRefusal(taskId: string): string {
  return `task ${taskId} still has its own crewmate, and a crewmate's merge card is the one merge decision for each of its pull requests: steer it with steer_crewmate to emit that card (or revise it), instead of carrying a merge effect yourself.`;
}

/**
 * A ceiling: the WI-12 steer-not-answer refusal - the crewmate's card is
 * revised, not re-answered. It compensates for a first mate that answered a
 * crewmate's card beside it, and is marked as one so a later audit can ask
 * whether the instruction now holds without it.
 */
export function steerNotAnswerRefusal(taskId: string, card: { id: string; title: string }): string {
  return `task ${taskId} already has its crewmate's card "${card.title}" (${card.id}) on screen: write on that card instead of a second one beside it. Read it with tasks card, then emit_card with id ${card.id}: with its expected_revision to revise it, or with reply alone to answer in its thread. Steer the crewmate with steer_crewmate when the work is its to do.`;
}

/**
 * Lint one Firstmate card. Returns the corrective refusal text, or
 * undefined when the card passes. Order: attach-first (with the
 * closed-task choice refusal), the carded-task refusal, and the
 * settle-needs-a-task check (the decision-integrity rules), then the shared
 * shape rules.
 */
export function lintFirstmateCard(card: EmittedCard, context: CardLintContext): string | undefined {
  // Attach first (task-system P1): a task_id must name a record. A note is
  // the first mate's own card and names no task, apart from a review relay
  // (INF-2714); its tasks ride `related`, each of which must name a record.
  if (card.taskId && context.taskExists && !context.taskExists(card.taskId)) {
    return `unknown task_id "${card.taskId}"; use a task id from the about line, the context's crew or open cards, crew_status, or the tasks tool.`;
  }
  if (
    card.actions.length === 0 &&
    card.taskId &&
    !card.reviewTaskId &&
    !(card.id && context.openCardOnTask?.(context.resolveCardId(card.id), card.taskId))
  ) {
    return NOTE_NAMES_TASK_REFUSAL;
  }
  const unknownRelated = context.taskResolves
    ? card.relatedTaskIds?.find((ref) => !context.taskResolves?.(ref))
    : undefined;
  if (unknownRelated) return unknownRelatedRefusal(unknownRelated);
  if (card.taskId && card.actions.length > 0 && context.taskClosed?.(card.taskId)) {
    return closedTaskChoiceRefusal(card.taskId);
  }
  // Consent: opening a task's browser with the captain in control is its
  // crewmate's request alone (docs/task-browser.md, "Asking for help").
  const browserOpen = card.actions.find(
    (action) => action.effect?.kind === "open" && action.effect.target === "browser",
  );
  if (browserOpen) {
    return `action "${browserOpen.id}" opens a task's browser, which only that task's crewmate may ask the captain to take over; declare open on settings, subscriptions or projects, or no effect.`;
  }

  // WI-12 steer-not-answer: a task whose crewmate already carded it gets
  // that card written on, not a second answer beside it. A revision of the
  // Firstmate's own open card on the task is not an answer, and a write on
  // the crewmate's own card never reaches this lint (docs/card-threads.md,
  // "Shared cards").
  // A card names its tasks in `related` too (INF-2714), so each of those is
  // read the same way as its own task.
  const spokenOf = [...new Set([card.taskId, ...(card.relatedTaskIds ?? [])])].filter(
    (taskId): taskId is string => Boolean(taskId),
  );
  for (const taskId of context.openCrewmateCard ? spokenOf : []) {
    const crewCard = context.openCrewmateCard?.(taskId);
    // A revision is read against the card's own task when it has one, so a
    // card on A that names B stays revisable once B's crewmate carded it.
    const revising =
      card.id !== undefined &&
      context.isOpenFirstmateCard?.(context.resolveCardId(card.id), card.taskId ?? taskId) === true;
    if (crewCard && !revising) return steerNotAnswerRefusal(taskId, crewCard);
  }

  // A settle effect is dispatched by the host against the card's task_id:
  // a card that omits it would render a button that cannot settle anything.
  const settleRefusal = settleNeedsTaskRefusal(card);
  if (settleRefusal) return settleRefusal;

  // The merge decision belongs to the crewmate that did the work (v3.6).
  if (
    card.taskId &&
    card.actions.some((action) => mergeEffectOf(action) !== undefined) &&
    context.crewmateOwesCompletion?.(card.taskId) === true
  ) {
    return crewmateOwesCompletionRefusal(card.taskId);
  }

  return lintCardShape(card);
}

type PictureDeclaration = {
  /** Pictures under each completion heading (lowercase) and how many are tagged new. */
  sections: Map<string, { pictures: number; fresh: number }>;
  /** A no-picture sentence with words in it. */
  noPictureSentence: boolean;
};

function readPictureDeclaration(body: string): PictureDeclaration {
  const document = parseDocument(body, { decodeEntities: true });
  const sections = new Map<string, { pictures: number; fresh: number }>();
  let noPictureSentence = false;
  let current: { pictures: number; fresh: number } | undefined;
  const walk = (nodes: DomNode[], fresh: boolean): void => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const element = node as DomNode & { attribs?: Record<string, string> };
      const name = element.name?.toLowerCase() ?? "";
      if (NON_COPY.has(name)) continue;
      const attribs = element.attribs ?? {};
      if (HEADING_TAGS.has(name)) {
        const heading = textOf(node).replace(/\s+/g, " ").trim().toLowerCase();
        current = sections.get(heading) ?? { pictures: 0, fresh: 0 };
        sections.set(heading, current);
      }
      if (hasHook(attribs, "no-picture") && textOf(node).trim()) {
        noPictureSentence = true;
      }
      const marked = fresh || hasHook(attribs, "new");
      if (name === "img" && current) {
        current.pictures += 1;
        if (marked) current.fresh += 1;
      }
      walk(node.children ?? [], marked);
    }
  };
  walk(document.children as unknown as DomNode[], false);
  return { sections, noPictureSentence };
}

/** Consent: the one refusal for a merge card that shows no picture and states no reason. */
export const COMPLETION_PICTURES_REFUSAL =
  "the merge card shows no pictures: put at least one result picture under After and, for each existing view it changed, its picture under Before; mark a figure data-inf-new when the view is new, so it needs no Before picture; or, when a person sees nothing different, state why in one sentence in an element marked data-inf-no-picture.";

/**
 * A physical limit: the elements the New tag cannot be drawn on - the card
 * stylesheet draws it as `[data-inf-new]::before`, and these generate no
 * `::before` box in the app's Chromium (measured in the card frame, FI3-770).
 */
const NO_NEW_TAG = new Set(["img", "svg", "video", "canvas", "iframe", "object", "embed", "input"]);

function untaggedNewMark(body: string): string | undefined {
  const find = (nodes: DomNode[]): string | undefined => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const element = node as DomNode & { attribs?: Record<string, string> };
      const name = element.name?.toLowerCase() ?? "";
      if (NON_COPY.has(name)) continue;
      if (NO_NEW_TAG.has(name) && hasHook(element.attribs, "new")) return name;
      const inner = find(node.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  return find(parseDocument(body, { decodeEntities: true }).children as unknown as DomNode[]);
}

export function untaggedNewMarkRefusal(element: string): string {
  return `data-inf-new is on the <${element}> itself, which cannot draw the New tag, so the new view would read as missing its Before picture; put data-inf-new on the <figure> that holds the <${element}> instead.`;
}

/**
 * Lint one crewmate card (WI-11): the shared shape rules. A crewmate's card
 * is about its own task by construction, so the settle check needs no task
 * here; a crewmate babysits its own CI before it offers a merge, and the
 * host writes the CI state and its own holds on the card. The evidence
 * contract left this boundary at v3.6 (captain lock 3): the five headings
 * are the report's and the PR body's, not the card's; v4.37 adds only the
 * completion card's own four-heading outline, and v4.69 asks its After
 * section for a picture (or a stated reason) and its Before for the pictures
 * of the views that already existed - consent, since the captain's merge
 * click rests on them. The picture check reads only what the body declares,
 * never the change, never which view a picture shows, and never how many
 * there are above one; a Quick-care task is exempt. On every crewmate card,
 * at every care level, a data-inf-new mark sits only where the New tag can
 * be drawn: a picture marked itself would show no tag.
 */
export function lintCrewmateCard(
  card: ShapedCard,
  options: { rigor?: Rigor; tieredStory?: boolean } = {},
): string | undefined {
  const shapeRefusal = lintCardShape(card);
  if (shapeRefusal) return shapeRefusal;
  const untagged = untaggedNewMark(card.body);
  if (untagged) return untaggedNewMarkRefusal(untagged);
  // The declared effect identifies the merge card of the task's own change,
  // never its words or id. Notes cannot be distinguished from other notes
  // at this boundary.
  if (
    !card.actions.some((action) => {
      const merge = mergeEffectOf(action);
      return merge !== undefined && !merge.review;
    })
  ) {
    return undefined;
  }
  const headings = bodyHeadings(card.body).map((heading) => heading.toLowerCase());
  let cursor = 0;
  const outline = options.tieredStory ? TIERED_STORY_HEADINGS : COMPLETION_CARD_HEADINGS;
  // The host writes a saved story's outline itself, in English; a free-form
  // merge card may head its sections in the captain's language instead
  // (INF-3674), as the catalog words them for the language the app speaks.
  const inLanguage = options.tieredStory ? undefined : languageCompletionHeadings();
  for (const [index, heading] of outline.entries()) {
    const translated = inLanguage?.[index];
    const at = Math.min(
      ...[heading, translated]
        .filter((name): name is string => name !== undefined)
        .map((name) => headings.indexOf(name.toLowerCase(), cursor))
        .map((found) => (found === -1 ? Number.POSITIVE_INFINITY : found)),
    );
    if (at === Number.POSITIVE_INFINITY) {
      const named =
        inLanguage && inLanguage.join() !== outline.join()
          ? `${outline.join(", ")}, or in the captain's language ${inLanguage.join(", ")},`
          : outline.join(", ");
      return `the merge card is missing the "${heading}" heading in order; give the body headed sections ${named} in that order, with the answer in the title alone.`;
    }
    cursor = at + 1;
  }
  // The saved story's schema and retained-media reader have already checked each
  // view's evidence relationships; free-form HTML still declares them below.
  if (options.tieredStory || options.rigor === "quick") return undefined;
  const { sections, noPictureSentence } = readPictureDeclaration(card.body);
  if (noPictureSentence) return undefined;
  const section = (english: string, translated: string | undefined) =>
    sections.get(english.toLowerCase()) ??
    (translated === undefined ? undefined : sections.get(translated.toLowerCase()));
  const before = section(COMPLETION_CARD_HEADINGS[2], inLanguage?.[2]);
  const after = section(COMPLETION_CARD_HEADINGS[3], inLanguage?.[3]);
  if (!after || after.pictures === 0) return COMPLETION_PICTURES_REFUSAL;
  if (after.fresh < after.pictures && (before?.pictures ?? 0) === 0) {
    return COMPLETION_PICTURES_REFUSAL;
  }
  return undefined;
}
