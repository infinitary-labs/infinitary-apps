import { describe, expect, it } from "vitest";
import { chooseGeminiModel, openingThinking, thinkingChoiceOf, toolNameOf } from "./acpReading";

/**
 * Intent: INF-3776's approved plan - an Antigravity crewmate's Activity
 * names the app's own tools as the app names them, however the program
 * prefixes an MCP tool, and the crewmate runs on Gemini models only at the
 * thinking level its care asks for.
 */

const OWN = new Set(["report", "emit_card", "card", "note_progress"]);

describe("the tool a call names", () => {
  it("reads the app's tool through each prefix the program may give it, longest name first", () => {
    expect(toolNameOf({ title: "infinitary/report" }, OWN)).toBe("report");
    expect(toolNameOf({ title: "mcp_infinitary_emit_card" }, OWN)).toBe("emit_card");
    expect(toolNameOf({ title: "infinitary.note_progress" }, OWN)).toBe("note_progress");
    expect(toolNameOf({ title: "x", rawInput: { name: "infinitary:card" } }, OWN)).toBe("card");
    // A name that only ends in an app tool's name, with no server before it, is not one.
    expect(toolNameOf({ title: "postcard", kind: "other" }, OWN)).toBe("postcard");
  });

  it("names the program's own tools by their kind, in the Pi dialect's words", () => {
    expect(toolNameOf({ title: "Run pnpm test", kind: "execute" }, OWN)).toBe("bash");
    expect(toolNameOf({ title: "Read a.ts", kind: "read" }, OWN)).toBe("read");
    expect(toolNameOf({ title: "Edit a.ts", kind: "edit" }, OWN)).toBe("edit");
    expect(toolNameOf({ title: "Search", kind: "search" }, OWN)).toBe("search");
  });
});

describe("the model a session runs on", () => {
  const gemini = { id: "gemini-3-pro", name: "Gemini 3 Pro" };
  const flash = { id: "gemini-3-flash", name: "Gemini 3 Flash" };
  const other = { id: "gpt-oss-120b", name: "GPT-OSS 120B" };

  it("keeps the program's current model when it is Gemini, else takes the first Gemini one", () => {
    expect(
      chooseGeminiModel({ current: flash.id, offered: [other, gemini, flash] }, undefined),
    ).toBe(flash);
    expect(
      chooseGeminiModel({ current: other.id, offered: [other, gemini, flash] }, undefined),
    ).toBe(gemini);
  });

  it("keeps the program's own model when it lists none, only when that one is Gemini", () => {
    expect(chooseGeminiModel({ current: gemini.id, offered: [] }, undefined)).toEqual({
      id: gemini.id,
      name: gemini.id,
    });
    // A reattach asks for the model it ran on, the program's own here.
    expect(chooseGeminiModel({ current: gemini.id, offered: [] }, gemini.id)).toEqual({
      id: gemini.id,
      name: gemini.id,
    });
    expect(chooseGeminiModel({ current: other.id, offered: [] }, undefined)).toBe(
      `Infinitary runs Antigravity on Gemini models only, and ${other.id} is not one.`,
    );
  });

  it("refuses a model the sign-in does not offer", () => {
    expect(chooseGeminiModel({ current: gemini.id, offered: [gemini] }, "gemini-9")).toBe(
      "Antigravity does not offer the model gemini-9 on this sign-in.",
    );
  });
});

describe("the thinking level a session opens at", () => {
  const offered = {
    configOptions: [
      {
        id: "thinking",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ],
  };

  it("takes the asked level or the nearest below it, one lower for Quick care", () => {
    const choice = thinkingChoiceOf(offered);
    expect(openingThinking(choice, "high", false)).toEqual({
      reasoning: { level: "high" },
      value: "high",
    });
    expect(openingThinking(choice, "medium", false).value).toBe("low");
    expect(openingThinking(choice, "high", true).value).toBe("low");
  });

  it("leaves the model's own level when the session offers none", () => {
    expect(openingThinking(thinkingChoiceOf({}), "high", false)).toEqual({
      reasoning: { level: "default" },
    });
  });
});
