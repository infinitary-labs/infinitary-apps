import { EMOTE_WORDS_MAX, emoteWords } from "@shared/emotes";
import { fmEventSchema } from "@shared/events";
import { describe, expect, it, vi } from "vitest";
import { createEmoteTool, FIRSTMATE_EMOTES } from "./emoteTool";
import { piToolOf } from "./toolSpec";

type AnyTool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, { description?: string }>; required?: string[] };
  execute: (
    id: string,
    params: { emote: (typeof FIRSTMATE_EMOTES)[number]; text?: string },
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
};

describe("emote tool", () => {
  it("offers every reply emote the captain shipped, and each one crosses to the renderer", async () => {
    // Captain's board verdict (2026-09-22): the host fires nod, tuck and tick
    // itself, and all five stay the Firstmate's to call.
    expect(FIRSTMATE_EMOTES).toEqual(
      expect.arrayContaining(["nod", "salute", "tick", "tuck", "aww"]),
    );
    expect(FIRSTMATE_EMOTES).not.toContain("shake");
    const request = vi.fn();
    const tool = piToolOf(createEmoteTool(request)) as unknown as AnyTool;
    for (const emote of FIRSTMATE_EMOTES) {
      await tool.execute(`call-${emote}`, { emote, text: "All set" });
      expect(request).toHaveBeenLastCalledWith(emote, "All set");
      // The event the agent broadcasts is one the wire schema accepts.
      expect(
        fmEventSchema.safeParse({ type: "firstmate_emote", emote, text: "All set" }).success,
        emote,
      ).toBe(true);
    }
    expect(fmEventSchema.safeParse({ type: "firstmate_emote", emote: "shake" }).success).toBe(
      false,
    );
  });

  it("refuses an emote with no words, requesting nothing", async () => {
    // FI3-798, the captain: "let's make the words required".
    const request = vi.fn();
    const tool = piToolOf(createEmoteTool(request)) as unknown as AnyTool;
    for (const text of [undefined, "", "   ", "\n\t", "\u0007"]) {
      const result = await tool.execute("call-1", { emote: "salute", text });
      expect(result.content[0]?.text, JSON.stringify(text)).toBe(
        `Refused: an emote needs words that say what the captain should know about what happened, at most ${EMOTE_WORDS_MAX} characters. Nothing was shown.`,
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("requires the words as a top-level parameter that says what they tell and their limit", () => {
    const tool = piToolOf(createEmoteTool(vi.fn())) as unknown as AnyTool;
    expect(tool.parameters.required).toEqual(expect.arrayContaining(["emote", "text"]));
    // Top level, so a Claude seat is served it too (docs/claude-client.md).
    const said = tool.parameters.properties.text?.description;
    expect(said).toContain("what the captain should know about what happened");
    expect(said).toContain(`${EMOTE_WORDS_MAX} characters`);
    expect(said).toContain("never an answer");
  });

  it("passes the words through cleaned: one space for every run, line breaks included", async () => {
    const request = vi.fn();
    const tool = piToolOf(createEmoteTool(request)) as unknown as AnyTool;
    const result = await tool.execute("call-1", {
      emote: "ponder",
      text: "  Let me\n\n look\u0007 \t again ",
    });
    expect(request).toHaveBeenCalledWith("ponder", "Let me look again");
    expect(result.content[0]?.text).toBe(
      'Emote requested: ponder, with the words "Let me look again"',
    );
  });

  it("accepts words of exactly the limit and refuses one character more, requesting nothing", async () => {
    const request = vi.fn();
    const tool = piToolOf(createEmoteTool(request)) as unknown as AnyTool;
    // Counted in characters, not code units: an emoji is one.
    const atLimit = `${"a".repeat(EMOTE_WORDS_MAX - 1)}👋`;
    await tool.execute("call-1", { emote: "aww", text: atLimit });
    expect(request).toHaveBeenLastCalledWith("aww", atLimit);

    request.mockClear();
    const over = await tool.execute("call-2", { emote: "aww", text: `${atLimit}!` });
    expect(request).not.toHaveBeenCalled();
    expect(over.content[0]?.text).toBe(
      `Refused: the words are ${EMOTE_WORDS_MAX + 1} characters; keep them to ${EMOTE_WORDS_MAX} or fewer. Nothing was shown.`,
    );
  });

  it("holds the event to the same rule: clean words within the limit, or none", () => {
    const parses = (text: string) =>
      fmEventSchema.safeParse({ type: "firstmate_emote", emote: "salute", text }).success;
    expect(parses("On it")).toBe(true);
    expect(parses("x".repeat(EMOTE_WORDS_MAX))).toBe(true);
    expect(parses("x".repeat(EMOTE_WORDS_MAX + 1))).toBe(false);
    // Words the tool would have cleaned never cross as they are.
    for (const raw of ["", " On it", "On\nit", "On  it", "On\u0000it"]) {
      expect(parses(raw), JSON.stringify(raw)).toBe(false);
      const words = emoteWords(raw);
      if (words.kind === "words") expect(parses(words.text)).toBe(true);
    }
  });
});
