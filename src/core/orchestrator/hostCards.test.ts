import type { Card } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";

describe("CardService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the same short-note rule to host cards and their revisions", () => {
    const { make } = setup();
    const cards = make();
    const hostCard: Card = {
      id: "card-host-width",
      author: "host",
      priority: 0,
      title: "A short notice",
      meta: "",
      body: "<p>All set.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
    };
    cards.put(hostCard);
    expect(cards.get(hostCard.id)?.width).toBe("regular");
    cards.put({ ...hostCard, body: `<p>${"x".repeat(600)}</p>` });
    expect(cards.get(hostCard.id)?.width).toBeUndefined();
    cards.put({ ...hostCard, body: '<svg viewBox="0 0 750 40"></svg>' });
    expect(cards.get(hostCard.id)?.width).toBeUndefined();
    cards.put(hostCard);
    expect(cards.get(hostCard.id)?.width).toBe("regular");
    expect(make().stored(hostCard.id)?.width).toBe("regular");
  });

  it("files an operation row for a host decision with no task, and drops it when the card goes", () => {
    const { tasks, make } = setup();
    const cards = make();
    cards.hostCards.raiseHostCard({
      id: "card-consent",
      title: "Add the plugin?",
      meta: "firstmate",
      body: "<p>It asks to read your tasks.</p>",
      actions: [{ id: "add", label: "Add it", variant: "primary" }],
    });
    expect(tasks.capture.openCardTaskFor("card-consent")?.kind).toBe("operation");

    cards.hostCards.withdrawHostCard("card-consent", "gone");
    expect(cards.has("card-consent")).toBe(false);
    expect(tasks.capture.openCardTaskFor("card-consent")).toBeUndefined();
  });

  it("files each paused-seat card's operation row, gated on the card, and drops it when the card leaves (W1 S9)", () => {
    const { tasks, make } = setup();
    const cards = make();
    const gatedOn = (id: string) => {
      const row = tasks.capture.openCardTaskFor(id);
      expect(row?.kind).toBe("operation");
      expect(row?.gate).toEqual({ kind: "captain", ref: id });
    };
    cards.hostCards.addFirstmatePauseCard({
      pause: "refused",
      body: "Claude is not answering your first mate right now.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.hostCards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Claude needs you to sign in again.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "Move?",
      providerName: "Claude",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    cards.hostCards.addFirstmateMoveBackCard({
      providerId: "anthropic-claude",
      providerName: "Claude",
      body: "Claude can serve your first mate again.",
    });
    const ids = [
      "card-fm-refused",
      "card-fm-no-headroom",
      "card-fm-flagship-move",
      "card-fm-move-back",
    ];
    for (const id of ids) gatedOn(id);
    expect(cards.get("card-fm-no-headroom")?.title).toBe(
      "Your first mate needs you to sign in again",
    );

    // The pause is over: its three cards and their rows go; the way back's card stays.
    cards.hostCards.withdrawFirstmatePauseCards("serves again");
    for (const id of ids.slice(0, 3)) {
      expect(cards.has(id)).toBe(false);
      expect(tasks.capture.openCardTaskFor(id)).toBeUndefined();
    }
    gatedOn("card-fm-move-back");
    cards.hostCards.withdrawHostCard("card-fm-move-back", "moved");
    expect(tasks.capture.openCardTaskFor("card-fm-move-back")).toBeUndefined();
  });

  // The design skill's footer rule: the card's one primary is its default,
  // drawn at the right edge, so ⌘1 finds it (INF-404).
  it("marks each paused-seat card's one primary as its default", () => {
    const { make } = setup();
    const cards = make();
    cards.hostCards.addFirstmatePauseCard({
      pause: "refused",
      body: "Claude is not answering your first mate right now.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.hostCards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Move?",
      accountId: "acct_claude",
      providerName: "Claude",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "Out.",
      providerName: "Codex",
    });
    const defaults = (id: string) =>
      cards
        .get(id)
        ?.actions.filter((action) => action.default)
        .map((action) => [action.id, action.variant]);
    expect(defaults("card-fm-refused")).toEqual([["try-again", "primary"]]);
    expect(defaults("card-fm-flagship-move")).toEqual([["move-flagship", "primary"]]);
    expect(defaults("card-fm-no-headroom")).toEqual([["open-settings", "primary"]]);
  });

  it("revises a paused-seat card in place when its words change, and never re-raises a dismissed one on revise (review S3)", () => {
    const { tasks, make } = setup();
    const cards = make();
    cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "Out.",
      providerName: "Codex",
    });
    const row = tasks.capture.openCardTaskFor("card-fm-no-headroom");
    cards.hostCards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Personal needs you to sign in again.",
      accountId: "acct",
      providerName: "Codex",
    });
    const revised = cards.get("card-fm-no-headroom");
    expect(revised?.title).toBe("Your first mate needs you to sign in again");
    expect(revised?.actions.map((action) => action.id)).toEqual(["sign-in"]);
    // One question, revised: its row is the same row.
    expect(tasks.capture.openCardTaskFor("card-fm-no-headroom")?.id).toBe(row?.id);

    cards.hostCards.withdrawFirstmatePauseCards("dismissed");
    cards.hostCards.addFirstmatePauseCard(
      { pause: "no_headroom", body: "Out.", providerName: "Codex" },
      { reviseOnly: true },
    );
    expect(cards.has("card-fm-no-headroom")).toBe(false);
  });
});
