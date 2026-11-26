import { describe, expect, it } from "vitest";
import { WORDS_TEXT_MAX, type WordsMessage } from "./sessionWords";
import { WORDS_ATTRIBUTE_MAX, wordsAttributes } from "./usageReportFormats";

/**
 * INF-6587's approved plan, piece 3 (docs/usage-report.md, "Prompts and
 * replies"): a turn's words ride its span within what a collector takes,
 * the prompts keeping their first messages and the replies their last.
 */

const START = Date.parse("2026-11-25T18:00:00Z");

/** A prompt as the session reader hands it on, already cut to its own bound. */
function prompt(label: string, at: number): WordsMessage {
  const text = `${label}: ${"Keep the meter's idle minutes out of the monthly bill. ".repeat(200)}`;
  return {
    role: "user",
    at,
    parts: [{ type: "text", content: text.slice(0, WORDS_TEXT_MAX) }],
  };
}

/** One of a crewmate's replies: a line and the command it runs next. */
function reply(step: number): WordsMessage {
  return {
    role: "assistant",
    at: START + step * 1_000,
    finishReason: "tool_call",
    parts: [
      { type: "text", content: `Running the meter tests again, step ${step}.` },
      {
        type: "tool_call",
        id: `call_${step}`,
        name: "bash",
        arguments: { command: "pnpm vitest run src/meter --reporter=dot" },
      },
    ],
  };
}

type SentMessage = { role: string; parts: any[]; finish_reason?: string };

describe("a turn's words on its span", () => {
  it("keeps a long turn's first prompts and last replies within the bound", () => {
    // A crewmate's turn runs from its brief to idle: the brief, four steers, 400 replies.
    const prompts = ["Brief", "Steer 1", "Steer 2", "Steer 3", "Steer 4"].map((label, index) =>
      prompt(label, START + index * 100_000),
    );
    const replies = Array.from({ length: 400 }, (_, index) => reply(index + 1));
    const sent = wordsAttributes({ claude: false, messages: [...prompts, ...replies] });

    const input = sent["gen_ai.input.messages"] ?? "";
    const output = sent["gen_ai.output.messages"] ?? "";
    expect(input.length).toBeLessThanOrEqual(WORDS_ATTRIBUTE_MAX);
    expect(output.length).toBeLessThanOrEqual(WORDS_ATTRIBUTE_MAX);

    // Each prompt is about 8,050 characters as JSON: three fit within 32,000, four do not.
    const keptPrompts = (JSON.parse(input) as SentMessage[]).map(
      (message) => (message.parts[0].content as string).split(":")[0],
    );
    expect(keptPrompts).toEqual(["Brief", "Steer 1", "Steer 2"]);

    const keptReplies = JSON.parse(output) as SentMessage[];
    const steps = keptReplies.map((message) => Number(message.parts[1].id.slice("call_".length)));
    const first = steps[0] ?? 0;
    expect(steps.at(-1)).toBe(400);
    expect(steps).toEqual(Array.from({ length: 401 - first }, (_, index) => first + index));
    expect(first).toBeGreaterThan(1);
    // As many as fit: the reply before the first one kept would pass the bound.
    const earlier = {
      role: "assistant",
      parts: reply(first - 1).parts,
      finish_reason: "tool_call",
    };
    expect(JSON.stringify([earlier, ...keptReplies]).length).toBeGreaterThan(WORDS_ATTRIBUTE_MAX);
  });

  it("keeps the first parts of a last reply too long alone", () => {
    // A reply that writes forty files at once, each call's arguments near their own bound.
    const files = Array.from({ length: 40 }, (_, index) => ({
      type: "tool_call" as const,
      id: `call_write_${index + 1}`,
      name: "write",
      arguments: {
        path: `src/meter/idle${index + 1}.ts`,
        content: "export const IDLE_GRACE_MINUTES = 5;\n".repeat(48),
      },
    }));
    const last: WordsMessage = {
      role: "assistant",
      at: START + 2_000,
      finishReason: "tool_call",
      parts: [{ type: "text", content: "Writing the idle meter's files." }, ...files],
    };
    const sent = wordsAttributes({ claude: false, messages: [reply(1), last] });

    const output = sent["gen_ai.output.messages"] ?? "";
    expect(output.length).toBeLessThanOrEqual(WORDS_ATTRIBUTE_MAX);
    const [kept, ...more] = JSON.parse(output) as SentMessage[];
    expect(more).toEqual([]);
    expect(kept?.finish_reason).toBe("tool_call");
    const keptParts = kept?.parts ?? [];
    expect(keptParts[0]).toEqual({ type: "text", content: "Writing the idle meter's files." });
    expect(keptParts.length).toBeGreaterThan(1);
    expect(keptParts.length).toBeLessThan(last.parts.length);
    expect(keptParts).toEqual(last.parts.slice(0, keptParts.length));
    // As many as fit: the next part would pass the bound.
    const withNext = { ...kept, parts: last.parts.slice(0, keptParts.length + 1) };
    expect(JSON.stringify([withNext]).length).toBeGreaterThan(WORDS_ATTRIBUTE_MAX);
  });
});
