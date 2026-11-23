import type { Card } from "@shared/cards";
import type { ThisMac } from "@shared/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesOffWords } from "../devices/viewWords";
import { useShellStore } from "./store";
import { card, DECIDE, resetShell, settle } from "./storeTestKit";

/**
 * Putting a card away and bringing it back (docs/composer.md and the design
 * skill's ResponseCard, "Minimize"), and a reply typed while changes to the
 * other computer are off (docs/view.md). Guardrails for INF-2625's renderer
 * piece, which moves this code out of store.ts: they hold what a person sees
 * before and after the move.
 */

const state = () => useShellStore.getState();

/** A window controlling the computer named Studio, out of reach. */
const AWAY: ThisMac = {
  role: "view",
  name: "Studio",
  address: "studio.local",
  joinedAt: 1_000,
  contact: "lost",
  readOnly: null,
  heardAt: 1_500,
  caughtUp: 0,
};

const WELCOME = card({ id: "card-a", title: "Pick a welcome", status: "ready", actions: DECIDE });
const FIX = card({ id: "card-b", title: "Merge the fix", status: "ready", actions: DECIDE });

let minimize: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let reply: ReturnType<typeof vi.fn>;
let stackThere: Card[];

beforeEach(() => {
  stackThere = [];
  minimize = vi.fn(async () => ({ ok: true }));
  list = vi.fn(async () => stackThere);
  reply = vi.fn(async (cardId: string) => ({ cardId, messages: [] }));
  vi.stubGlobal("window", { infinitary: { cards: { minimize, list, reply } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetShell();
});

describe("putting a card away", () => {
  it("asks the card's owner to put it away", async () => {
    useShellStore.setState({ cards: [WELCOME] });
    await state().minimizeCard("card-a");
    expect(minimize).toHaveBeenCalledWith("card-a", true);
    expect(state().cardActionErrors).toEqual({});
  });

  it("says why on the card when its owner refuses", async () => {
    minimize.mockRejectedValue(new Error("The card is already closed."));
    useShellStore.setState({ cards: [WELCOME] });
    await state().minimizeCard("card-a");
    expect(state().cardActionErrors).toEqual({ "card-a": "The card is already closed." });
  });

  it("refuses at once while changes to the other computer are off", async () => {
    useShellStore.setState({ thisMac: AWAY, cards: [WELCOME] });
    await state().minimizeCard("card-a");
    expect(minimize).not.toHaveBeenCalled();
    expect(state().cardActionErrors).toEqual({ "card-a": changesOffWords(AWAY) });
  });
});

describe("bringing back a card that was put away", () => {
  beforeEach(() => {
    useShellStore.setState({
      cards: [WELCOME, { ...FIX, minimized: true }],
      cardIndex: 0,
    });
  });

  it("restores it with its owner, reads the stack again and shows it", async () => {
    stackThere = [WELCOME, FIX];

    expect(state().focusCard("card-b")).toBe(true);
    expect(minimize).toHaveBeenCalledWith("card-b", false);
    await settle();

    expect(list).toHaveBeenCalledTimes(1);
    expect(state().cards.find((c) => c.id === "card-b")?.minimized).toBeUndefined();
    expect(state()).toMatchObject({ cardIndex: 1, cardFocusTarget: "card-b" });
  });

  it("says why on the card when its owner refuses to restore it", async () => {
    minimize.mockRejectedValue(new Error("the card is gone"));

    state().focusCard("card-b");
    await settle();

    expect(list).not.toHaveBeenCalled();
    expect(state().cardActionErrors["card-b"]).toContain("the card is gone");
    expect(state().cardIndex).toBe(0);
  });

  it("leaves it put away while changes to the other computer are off", () => {
    useShellStore.setState({ thisMac: AWAY });
    expect(state().focusCard("card-b")).toBe(false);
    expect(minimize).not.toHaveBeenCalled();
  });
});

describe("a reply while changes to the other computer are off (docs/view.md)", () => {
  it("keeps the reply, says so under the field, and sends nothing then or later", async () => {
    useShellStore.setState({
      thisMac: AWAY,
      cards: [WELCOME],
      replyDrafts: { "card-a": "Lead with the caption" },
    });

    await state().sendReply("card-a");

    expect(reply).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      replyDrafts: { "card-a": "Lead with the caption" },
      replyNotices: { "card-a": "away" },
      sendingReplies: {},
    });
  });
});
