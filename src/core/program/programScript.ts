import { createHash } from "node:crypto";
import { Script } from "node:vm";

/**
 * What the host checks of a program before it files one (INF-799 piece 2,
 * docs/programs.md "Filing a program"), and the digest that keys a call in
 * the journal. Nothing here reads what a script means: that it compiles
 * as the body of an async function, that it imports nothing, and that its
 * bound is a positive whole number.
 */

export type ProgramAsk = { script?: unknown; args?: unknown; bound?: unknown };

/** Why a declared program cannot be filed, in words, or undefined when it can. */
export function programRefusal(program: ProgramAsk): string | undefined {
  const { script, bound } = program;
  if (typeof script !== "string" || !script.trim())
    return "program.script must be the script's JavaScript as a string.";
  if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1)
    return "program.bound must be your proposed upper bound on the script's task() calls, a whole number of at least 1.";
  // A static import does not compile in a function body; a dynamic one would at runtime.
  if (/\bimport\s*\(/.test(script))
    return "program.script imports code; a program has only task(), ask(), log(), phase() and args.";
  try {
    // Compiled, never run: a syntax error is refused before anything is filed.
    new Script(`(async () => {\n${script}\n})()`, { filename: "program.js" });
  } catch (caught) {
    return `program.script does not compile: ${caught instanceof Error ? caught.message : String(caught)}.`;
  }
  try {
    JSON.stringify(program.args ?? null);
  } catch {
    return "program.args must be JSON.";
  }
  return undefined;
}

/** JSON with every object's keys in order, so equal calls digest equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The digest that keys one call in the journal: its host function and
 * every argument it was made with. A replayed call equal to a recorded one
 * digests the same and takes that call's answer (Claude's own resume rule).
 */
export function callDigest(op: string, input: readonly unknown[]): string {
  return createHash("sha256")
    .update(canonical([op, ...input]))
    .digest("hex")
    .slice(0, 32);
}
