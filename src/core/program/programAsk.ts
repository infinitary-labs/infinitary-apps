import { resultRefusal } from "../tasks/taskResult";

/**
 * A program's ask(prompt, schema) (INF-799 piece 2, docs/programs.md):
 * one tool-less typed read through the decision models' one-question
 * session. The answer is JSON the host checks against the schema; one that
 * does not parse or fit is asked once more with why, then the call answers
 * null. A typed fact is the host's to hold: the answer's text is parsed as
 * JSON and nothing else - a fenced block is the one wrapping taken off.
 */

/** The question session's system instruction for a JSON answer. */
export const ASK_INSTRUCTION = [
  "You answer one question from a program with one JSON value and nothing else: no prose, no explanation.",
  "When a JSON Schema is given, your answer must fit it.",
].join(" ");

export type JsonAnswerer = (
  instruction: string,
  text: string,
) => Promise<{ text: string } | { failed: string }>;

/** The question as the session's one message: the prompt, then the schema it must fit. */
function question(prompt: string, schema: Record<string, unknown> | null, why?: string): string {
  return [
    prompt,
    ...(schema
      ? ["", `Answer with JSON that fits this JSON Schema: ${JSON.stringify(schema)}`]
      : []),
    ...(why ? ["", `Your last answer was refused: ${why} Answer again with JSON only.`] : []),
  ].join("\n");
}

/** The answer's JSON, or why it is not an answer. */
export function parseAnswer(
  text: string,
  schema: Record<string, unknown> | null,
): { value: unknown } | { refused: string } {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim());
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? text.trim());
  } catch {
    return { refused: "it is not JSON." };
  }
  if (!schema) return { value };
  const refused = resultRefusal(schema, value);
  return refused ? { refused } : { value };
}

/** The checked answer, or null when two tries gave none. */
export async function askJson(
  answer: JsonAnswerer,
  prompt: string,
  schema: Record<string, unknown> | null,
): Promise<unknown> {
  let why: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const turn = await answer(ASK_INSTRUCTION, question(prompt, schema, why));
    if ("failed" in turn) return null;
    const parsed = parseAnswer(turn.text, schema);
    if ("value" in parsed) return parsed.value;
    why = parsed.refused;
  }
  return null;
}
