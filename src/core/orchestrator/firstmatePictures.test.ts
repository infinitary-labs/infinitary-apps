import type { Slot } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeSession,
  fakeClockEachTest,
  fakeSession,
  setup,
  tick,
} from "../../../tests/helpers/firstmateHarness";
import { pngImage } from "../../../tests/helpers/images";
import type { SessionSpec } from "../session/session";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { FIRSTMATE_FAILURE_CARD_ID, FIRSTMATE_PICTURES_CARD_ID } from "./hostCards";
import { rowAttachments } from "./wakes";

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeClockEachTest();

const TEXT_ONLY = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };
const OTHER_TEXT_ONLY = { provider: "openrouter", id: "moonshotai/kimi-k3" };
const READER = { provider: "openrouter", id: "google/gemini-3.5-flash" };
const WORDS_ONLY = new Set([TEXT_ONLY.id, OTHER_TEXT_ONLY.id]);
const NAMES: Record<string, string> = {
  [TEXT_ONLY.id]: "DeepSeek V4 Pro",
  [OTHER_TEXT_ONLY.id]: "Kimi K3",
  [READER.id]: "Gemini 3.5 Flash",
};
const EVERY_SLOT: Slot[] = ["low", "medium", "high"];

/**
 * An OpenRouter-style install: a model that reads words only and one that
 * reads pictures, the seat opening a session on whichever model it binds.
 */
function install(
  options: {
    available?: { provider: string; id: string }[];
    slots?: Record<string, Slot[]>;
    firstmate?: { provider: string; id: string };
  } = {},
) {
  const sessions: FakeSession[] = [];
  const f = setup({
    availableModels: () => options.available ?? [TEXT_ONLY, READER],
    slotsOf: (ref) => options.slots?.[ref.id] ?? EVERY_SLOT,
    readsPictures: (ref) => !WORDS_ONLY.has(ref.id),
    modelName: (ref) => NAMES[ref.id] ?? ref.id,
    piSeat: async (spec: SessionSpec) => {
      const opened = fakeSession(spec.model);
      sessions.push(opened);
      return opened;
    },
  });
  if (options.firstmate) f.settings.setFirstmateModel(options.firstmate);
  const pending = () => new InboxStore(f.db).pending(FIRSTMATE_RECIPIENT, Date.now());
  const waitingWords = () =>
    pending().map((row) =>
      row.facts?.kind === "captain-turn" ? row.facts.words : row.facts?.kind,
    );
  const card = (id: string) => f.cards().find((entry) => entry.id === id);
  return { ...f, sessions, pending, waitingWords, card };
}

describe("the first mate's automatic pick", () => {
  it("takes the model that reads pictures among models of the same slot", async () => {
    const t = install();
    await t.agent.converse("hello");
    expect(t.settings.getFirstmateModel()).toEqual(READER);
    expect(t.sessions[0]?.modelRef()).toEqual(READER);
  });

  it("keeps the slot first: a words-only model at high beats a picture reader at medium", async () => {
    const t = install({ slots: { [TEXT_ONLY.id]: ["high"], [READER.id]: ["medium"] } });
    await t.agent.converse("hello");
    expect(t.settings.getFirstmateModel()).toEqual(TEXT_ONLY);
  });
});

describe("a message with pictures for a first mate whose model reads words only", () => {
  it("waits with its words and pictures, and one card offers the move to a model that reads them", async () => {
    const t = install({ firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await tick();

    const seat = t.sessions[0] as FakeSession;
    expect(seat.modelRef()).toEqual(TEXT_ONLY);
    expect(seat.prompts).toEqual([]);
    expect(t.waitingWords()).toEqual(["what does this dialog say?"]);
    expect(rowAttachments(t.pending())).toHaveLength(1);

    expect(t.card(FIRSTMATE_FAILURE_CARD_ID)).toBeUndefined();
    const card = t.card(FIRSTMATE_PICTURES_CARD_ID);
    expect(card?.title).toBe("Your first mate's model cannot read pictures");
    expect(card?.body).toContain(
      "your first mate answers on DeepSeek V4 Pro, which reads words only",
    );
    expect(card?.body).toContain("Move to Gemini 3.5 Flash puts your first mate on a model");
    expect(card?.actions.map((action) => [action.label, action.default, action.effect])).toEqual([
      [
        "Move to Gemini 3.5 Flash",
        true,
        { kind: "host", op: "move-flagship", arg: "openrouter/google/gemini-3.5-flash" },
      ],
      ["Open settings", undefined, { kind: "open", target: "settings" }],
    ]);
    expect(t.settings.getFirstmateModel()).toEqual(TEXT_ONLY);
  });

  it("is answered with its pictures once the captain moves to the model on the card", async () => {
    const t = install({ firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await tick();

    t.supervisor.cardActions.act(FIRSTMATE_PICTURES_CARD_ID, "move-flagship");
    await tick();

    expect(t.settings.getFirstmateModel()).toEqual(READER);
    const reader = t.sessions.at(-1) as FakeSession;
    expect(reader.modelRef()).toEqual(READER);
    expect(reader.prompts).toHaveLength(1);
    expect(reader.prompts[0]).toContain("what does this dialog say?");
    expect(reader.promptImages[0]).toEqual([pngImage]);
    expect(t.sessions[0]?.promptImages).toEqual([]);
    expect(t.card(FIRSTMATE_PICTURES_CARD_ID)).toBeUndefined();
  });

  it("leaves messages without pictures answered on the same model while it waits", async () => {
    const t = install({ firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await t.agent.converse("what is the crew doing?");
    await tick();

    const seat = t.sessions[0] as FakeSession;
    expect(seat.prompts).toHaveLength(1);
    expect(seat.prompts[0]).toContain("what is the crew doing?");
    expect(seat.prompts[0]).not.toContain("what does this dialog say?");
    expect(seat.promptImages[0]).toBeUndefined();
    seat.emitTurnEnd("The crew is idle.");
    seat.resolveNextPrompt();
    await tick();

    expect(seat.prompts).toHaveLength(1);
    expect(t.waitingWords()).toEqual(["what does this dialog say?"]);
    expect(t.card(FIRSTMATE_PICTURES_CARD_ID)).toBeDefined();
    expect(t.card(FIRSTMATE_FAILURE_CARD_ID)).toBeUndefined();
  });

  it("waits rather than riding a running turn as a steer", async () => {
    const t = install({ firstmate: TEXT_ONLY });
    await t.agent.converse("what is the crew doing?");
    const seat = t.sessions[0] as FakeSession;
    expect(seat.isStreaming()).toBe(true);

    await t.agent.converse({ text: "and this dialog?", images: [pngImage] });
    await tick();
    expect(seat.steers).toEqual([]);
    expect(t.card(FIRSTMATE_PICTURES_CARD_ID)).toBeDefined();

    seat.emitTurnEnd("The crew is idle.");
    seat.resolveNextPrompt();
    await tick();
    expect(seat.prompts).toHaveLength(1);
    expect(seat.promptImages).toEqual([undefined]);
    expect(t.waitingWords()).toEqual(["and this dialog?"]);
  });

  it("names the new model when the captain picks another that reads words only in Settings", async () => {
    const t = install({ available: [TEXT_ONLY, OTHER_TEXT_ONLY, READER], firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await tick();

    await t.agent.applyModelSetting(OTHER_TEXT_ONLY);
    await tick();

    expect(t.sessions.at(-1)?.modelRef()).toEqual(OTHER_TEXT_ONLY);
    expect(t.sessions.at(-1)?.prompts).toEqual([]);
    expect(t.waitingWords()).toEqual(["what does this dialog say?"]);
    const card = t.card(FIRSTMATE_PICTURES_CARD_ID);
    expect(card?.body).toContain("your first mate answers on Kimi K3, which reads words only");
    expect(card?.actions[0]?.label).toBe("Move to Gemini 3.5 Flash");
  });

  it("is answered with its pictures once the captain picks a model that reads them in Settings", async () => {
    const t = install({ firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await tick();

    await t.agent.applyModelSetting(READER);
    await tick();

    const reader = t.sessions.at(-1) as FakeSession;
    expect(reader.modelRef()).toEqual(READER);
    expect(reader.promptImages[0]).toEqual([pngImage]);
    expect(t.pending()).toEqual([]);
    expect(t.card(FIRSTMATE_PICTURES_CARD_ID)).toBeUndefined();
  });

  it("points to Settings when no model that can answer the first mate reads pictures", async () => {
    const t = install({ available: [TEXT_ONLY], firstmate: TEXT_ONLY });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });
    await tick();

    const card = t.card(FIRSTMATE_PICTURES_CARD_ID);
    expect(card?.body).toContain(
      "None of your models that can answer your first mate reads pictures.",
    );
    expect(card?.actions.map((action) => [action.label, action.default, action.effect])).toEqual([
      ["Open settings", true, { kind: "open", target: "settings" }],
    ]);
    expect(t.sessions[0]?.prompts).toEqual([]);
    expect(t.pending()).toHaveLength(1);
  });

  it("is served at once when the model reads pictures", async () => {
    const t = install({ firstmate: READER });
    await t.agent.converse({ text: "what does this dialog say?", images: [pngImage] });

    const seat = t.sessions[0] as FakeSession;
    expect(seat.promptImages[0]).toEqual([pngImage]);
    expect(t.card(FIRSTMATE_PICTURES_CARD_ID)).toBeUndefined();
  });
});
