import { describe, expect, it } from "vitest";
import { ASK_INSTRUCTION, askJson, parseAnswer } from "./programAsk";

// INF-799 piece 2: a program's ask(prompt, schema) answers with JSON the
// host checks against the schema (the captain's "the host checks"), asked
// once more with why when it does not fit, then null.

const VERDICT = {
  type: "object",
  required: ["ship"],
  properties: { ship: { type: "boolean" } },
};

describe("a program's ask()", () => {
  it("parses a JSON answer, a fenced one included, and checks it against the schema", () => {
    expect(parseAnswer('{"ship": true}', VERDICT)).toEqual({ value: { ship: true } });
    expect(parseAnswer('```json\n{"ship": false}\n```', VERDICT)).toEqual({
      value: { ship: false },
    });
    expect(parseAnswer("Yes, ship it.", VERDICT)).toEqual({ refused: "it is not JSON." });
    expect(parseAnswer('{"ship": "yes"}', VERDICT)).toMatchObject({
      refused: expect.stringContaining("ship"),
    });
    // With no schema any JSON is the answer.
    expect(parseAnswer("[1, 2]", null)).toEqual({ value: [1, 2] });
  });

  it("asks once more with why the answer was refused, then answers null", async () => {
    const asked: string[] = [];
    const answers = ["Ship it.", '{"ship": true}'];
    const value = await askJson(
      async (instruction, text) => {
        expect(instruction).toBe(ASK_INSTRUCTION);
        asked.push(text);
        return { text: answers.shift() ?? "" };
      },
      "Is the meter refactor ready to ship?",
      VERDICT,
    );
    expect(value).toEqual({ ship: true });
    expect(asked[0]).toContain(
      `Answer with JSON that fits this JSON Schema: ${JSON.stringify(VERDICT)}`,
    );
    expect(asked[1]).toContain("Your last answer was refused: it is not JSON.");

    let turns = 0;
    const never = await askJson(
      async () => {
        turns += 1;
        return { text: "no" };
      },
      "Is it ready?",
      VERDICT,
    );
    expect([never, turns]).toEqual([null, 2]);
  });

  it("answers null at once when the model fails", async () => {
    let turns = 0;
    const value = await askJson(
      async () => {
        turns += 1;
        return { failed: "no-model" };
      },
      "Is it ready?",
      VERDICT,
    );
    expect([value, turns]).toEqual([null, 1]);
  });
});
