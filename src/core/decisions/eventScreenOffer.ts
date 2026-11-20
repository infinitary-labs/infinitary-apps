import type { AutomationSpec } from "@shared/automation";
import type { Card, CardAction } from "@shared/cards";
import { decisionUse } from "@shared/decisionUses";
import { cutText } from "@shared/textCut";
import { escapeCardText } from "../orchestrator/cardText";
import type { DecisionModels } from "./decisionModel";

/**
 * The offer of the event screen (docs/automation.md, "Offering the screen";
 * INF-4667 finding 1): a rule with an Only if condition that is saved or
 * turned on while Screen automation events is off raises one host card that
 * explains the screen, with its own disclosure, and offers Turn on beside
 * Not now. Every such save revises the one card in place, so it never stacks.
 */
export const EVENT_SCREEN_OFFER_CARD_ID = "event-screen-offer";

/** The offer card's title. */
export const EVENT_SCREEN_OFFER_TITLE = "Skip events your automation does not need?";

const NAME_CHARS = 80;
const CONDITION_CHARS = 240;

/** The rule as the offer reads it. */
export type OfferedRule = { name?: string; prompt: string; spec: AutomationSpec };

/** The card's words: the rule, what the screen does, what turning it on sends. */
export function eventScreenOfferCard(input: {
  rule: { label: string; waitsFor: string };
  /** The disclosure the card shows, by version: Turn on agrees to exactly this one. */
  disclosure: { version: number; text: readonly string[] };
  /** The answering decision model's approval predates the screen: Settings shows both. */
  needsApproval: boolean;
}): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const { rule, disclosure } = input;
  const turnOn: CardAction = input.needsApproval
    ? {
        id: "open-settings",
        label: "Open Settings",
        variant: "primary",
        default: true,
        effect: { kind: "open", target: "settings" },
      }
    : {
        id: "turn-on",
        label: "Turn on",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "turn-on-event-screen", arg: String(disclosure.version) },
      };
  return {
    id: EVENT_SCREEN_OFFER_CARD_ID,
    title: EVENT_SCREEN_OFFER_TITLE,
    meta: "Automation",
    body: [
      `<p>"${escapeCardText(rule.label)}" acts only on: ${escapeCardText(rule.waitsFor)}. Every other event still wakes your first mate, because Screen automation events is off.</p>`,
      // The first disclosure line is what turning it on sends; the rest fold.
      `<p>${escapeCardText(disclosure.text[0] ?? "")}</p>`,
      "<details><summary>More</summary>",
      ...disclosure.text.slice(1).map((line) => `<p>${escapeCardText(line)}</p>`),
      input.needsApproval
        ? "<p>The model answering decisions needs your approval first, so Turn on is in Settings → Intelligence → Decisions.</p>"
        : "<p>Change it later in Settings → Intelligence → Decisions.</p>",
      "</details>",
    ].join(""),
    actions: [turnOn, { id: "not-now", label: "Not now", variant: "secondary", declines: true }],
  };
}

export type EventScreenOfferOptions = {
  decisions: Pick<DecisionModels, "allowsUse" | "view" | "setUse">;
  cards: {
    raiseHostCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => unknown;
    withdrawHostCard: (id: string, reason: string) => void;
  };
  /** One feed line, for a Turn on the home refused. */
  note: (text: string) => void;
};

export class EventScreenOffer {
  constructor(private readonly options: EventScreenOfferOptions) {}

  /**
   * An enabled rule was saved or turned on: offer the screen when the rule
   * has an Only if condition and the screen cannot ask now.
   */
  offer(rule: OfferedRule): boolean {
    const { spec } = rule;
    const waitsFor = spec.kind === "event" ? spec.waitsFor?.trim() : undefined;
    if (!waitsFor) return false;
    const { decisions } = this.options;
    if (decisions.allowsUse("event-screen")) return false;
    const use = decisionUse("event-screen");
    if (!use?.disclosure) return false;
    const view = decisions.view().uses?.find((row) => row.id === "event-screen");
    this.options.cards.raiseHostCard(
      eventScreenOfferCard({
        rule: {
          label: rule.name?.trim() || cutText(rule.prompt, NAME_CHARS),
          waitsFor: cutText(waitsFor, CONDITION_CHARS),
        },
        disclosure: use.disclosure,
        needsApproval: view?.needsApproval === true,
      }),
    );
    return true;
  }

  /** The card's Turn on: agree to the disclosure version it showed, and switch the screen on. */
  turnOn(arg: string | undefined): void {
    const agreed = Number(arg);
    try {
      this.options.decisions.setUse({
        id: "event-screen",
        on: true,
        ...(Number.isInteger(agreed) ? { agreed } : {}),
      });
    } catch (error) {
      this.options.note(
        `Screen automation events did not turn on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The screen was turned on elsewhere, such as in Settings: the offer is answered. */
  turnedOn(): void {
    if (this.options.decisions.allowsUse("event-screen"))
      this.options.cards.withdrawHostCard(EVENT_SCREEN_OFFER_CARD_ID, "turned on");
  }
}
