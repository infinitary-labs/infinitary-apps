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
    params: { emote: (typeof FIRSTMATE_EMOTES)[number] },
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
      await tool.execute(`call-${emote}`, { emote });
      expect(request).toHaveBeenLastCalledWith(emote);
      expect(fmEventSchema.safeParse({ type: "firstmate_emote", emote }).success, emote).toBe(true);
    }
    expect(fmEventSchema.safeParse({ type: "firstmate_emote", emote: "shake" }).success).toBe(
      false,
    );
  });

  it("takes no words: the emote is motion only", async () => {
    // INF-772's plan, the captain's "drop them": what happened is the
    // turn's closing sentence, never an emote's words.
    const request = vi.fn();
    const tool = piToolOf(createEmoteTool(request)) as unknown as AnyTool;
    expect(Object.keys(tool.parameters.properties)).toEqual(["emote"]);
    const result = await tool.execute("call-1", { emote: "salute" });
    expect(request).toHaveBeenCalledWith("salute");
    expect(result.content[0]?.text).toBe("Emote requested: salute");
  });

  it("holds the host's own emote words to the shared rule: clean within the limit, or none", () => {
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
