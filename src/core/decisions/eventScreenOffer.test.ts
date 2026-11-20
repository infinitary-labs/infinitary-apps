import type { Card } from "@shared/cards";
import { DEFAULT_DECISIONS, type DecisionsSettings } from "@shared/decisions";
import { type DecisionUseSwitches, decisionUse } from "@shared/decisionUses";
import { describe, expect, it } from "vitest";
import { Scheduler } from "../orchestrator/scheduler";
import { openInMemoryDatabase } from "../storage/db";
import { ScheduleStore } from "../storage/scheduleStore";
import { DecisionModels } from "./decisionModel";
import {
  EVENT_SCREEN_OFFER_CARD_ID,
  EVENT_SCREEN_OFFER_TITLE,
  EventScreenOffer,
} from "./eventScreenOffer";

/**
 * INF-4667 finding 1, which the captain chose to build ("Start a task now to
 * build it"): a watch with an Only if condition woke the first mate for every
 * email because Screen automation events was off and nothing offered it. A
 * rule with an Only if condition that is saved or turned on while the screen
 * is off now raises one card that explains it, with Turn on beside Not now.
 * These drive the real Scheduler, decision service and offer together.
 */

type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;

function setup(uses: DecisionUseSwitches = {}) {
  let decisions: DecisionsSettings = DEFAULT_DECISIONS;
  let switches = uses;
  const service = new DecisionModels({
    settings: {
      getDecisions: () => decisions,
      setDecisions: (next) => {
        decisions = next;
      },
      getDecisionUses: () => switches,
      setDecisionUses: (next) => {
        switches = next;
      },
    },
    adapted: { id: "adapted", native: false, decide: async () => ({ answers: {}, usage: [] }) },
  });
  const cards = new Map<string, Raised>();
  const raised: Raised[] = [];
  const withdrawn: string[] = [];
  const feed: string[] = [];
  const offer = new EventScreenOffer({
    decisions: service,
    cards: {
      raiseHostCard: (card) => {
        raised.push(card);
        cards.set(card.id, card);
      },
      withdrawHostCard: (id) => {
        if (cards.delete(id)) withdrawn.push(id);
      },
    },
    note: (text) => feed.push(text),
  });
  const scheduler = new Scheduler({
    store: new ScheduleStore(openInMemoryDatabase()),
    notify: () => null,
    broadcastEvent: () => {},
    now: () => Date.UTC(2026, 10, 17, 16, 0),
    events: {
      find: (integration, event) =>
        integration === "google" && event === "message_received"
          ? {
              integration: "google",
              connection: "google-1",
              name: "Google",
              event,
              label: "A message arrives",
              every: 1,
            }
          : undefined,
      look: async () => ({ cursor: "c", items: [] }),
    },
    enabled: (record) => void offer.offer(record),
  });
  const watch = (waitsFor?: string, draft = false) =>
    scheduler.create(
      {
        kind: "event",
        integration: "google",
        event: "message_received",
        ...(waitsFor ? { waitsFor } : {}),
      },
      "Tell me when it arrives: {{events}}",
      !draft,
      "Microsoft email",
    );
  return { service, scheduler, offer, cards, raised, withdrawn, feed, watch };
}

describe("Offering the event screen", () => {
  it("offers the screen once for a watch with an Only if, and its Turn on switches the screen on", () => {
    const { service, offer, cards, raised, feed, watch } = setup();
    // A watch with no Only if has nothing to screen.
    watch();
    expect(raised).toEqual([]);

    watch("An email from Microsoft about the account");
    const card = cards.get(EVENT_SCREEN_OFFER_CARD_ID);
    expect(card?.title).toBe(EVENT_SCREEN_OFFER_TITLE);
    expect(card?.body).toContain("An email from Microsoft about the account");
    for (const line of decisionUse("event-screen")?.disclosure?.text ?? [])
      expect(card?.body).toContain(line);
    expect(card?.actions.map((action) => action.label)).toEqual(["Turn on", "Not now"]);
    expect(card?.actions[1]?.declines).toBe(true);

    // A second such watch revises the one card rather than stacking another.
    watch("A calendar invite from my manager");
    expect(cards.size).toBe(1);
    expect(cards.get(EVENT_SCREEN_OFFER_CARD_ID)?.body).toContain("my manager");

    const turnOn = cards.get(EVENT_SCREEN_OFFER_CARD_ID)?.actions[0]?.effect;
    expect(turnOn).toEqual({ kind: "host", op: "turn-on-event-screen", arg: "1" });
    expect(service.allowsUse("event-screen")).toBe(false);
    // The card's own button, as the host op hands its argument over.
    if (turnOn?.kind === "host") offer.turnOn(turnOn.arg);
    expect(service.allowsUse("event-screen")).toBe(true);
    expect(feed).toEqual([]);

    // With the screen on, a later watch asks nothing.
    const before = raised.length;
    watch("Another email from Microsoft");
    expect(raised.length).toBe(before);
  });

  it("offers it when a draft or paused watch is turned on, never for a draft saved alone", () => {
    const { scheduler, raised, watch } = setup();
    const draft = watch("An email from Microsoft", true);
    expect(draft.state).toBe("draft");
    expect(raised).toEqual([]);

    scheduler.update(draft.id, {}, { enable: true });
    expect(raised.length).toBe(1);

    scheduler.pause(draft.id);
    scheduler.resume(draft.id);
    expect(raised.length).toBe(2);
  });

  it("takes the card down once Settings turns the screen on", () => {
    const { service, offer, cards, withdrawn, watch } = setup();
    watch("An email from Microsoft");
    expect(cards.has(EVENT_SCREEN_OFFER_CARD_ID)).toBe(true);

    offer.turnedOn();
    expect(withdrawn).toEqual([]);

    service.setUse({ id: "event-screen", on: true, agreed: 1 });
    offer.turnedOn();
    expect(withdrawn).toEqual([EVENT_SCREEN_OFFER_CARD_ID]);
  });

  it("refuses a Turn on from a card showing an older disclosure, and says so", () => {
    const { service, offer, feed } = setup();
    offer.turnOn("0");
    expect(service.allowsUse("event-screen")).toBe(false);
    expect(feed).toEqual([
      "Screen automation events did not turn on: Screen automation events turns on only once its disclosure is agreed.",
    ]);
  });

  it("does not offer a screen already on", () => {
    const { raised, watch } = setup({ "event-screen": { on: true, agreed: 1 } });
    watch("An email from Microsoft");
    expect(raised).toEqual([]);
  });
});
