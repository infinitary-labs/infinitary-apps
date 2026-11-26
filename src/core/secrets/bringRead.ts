import { readJson } from "./bringJson";
import type { SourceOutput } from "./bringOutput";
import {
  type BringReads,
  type ReadValue,
  readEnv0,
  readLines,
  readValue,
  zeroFill,
} from "./bringReaders";
import { type BoundSource, readSource } from "./bringSource";

/** How a bring's output holds its secrets, and which of them to read. */
export type BringHow = {
  reads: BringReads;
  trim?: "newline";
  /**
   * The names the source gives the secrets to read, or null for every name
   * a `lines` or `env0` source holds. Any other value read is filled with
   * zeros at once.
   */
  names: readonly string[] | null;
};

/** What one run or read of a bring's source gave: the values by name, or why none. */
export type BringRead =
  | { values: Map<string, ReadValue> }
  | { failed: { exitCode?: number; signal?: string } }
  | { ended: "changed" | "too-large" | "invalid-json" };

/**
 * Runs or reads the bound source once (or uses output already captured)
 * and reads its output by the bring's shape, on whichever computer the
 * source is on: the home for a bring here, the computer that runs work for
 * a bring there (docs/secrets.md, "Bringing secrets from another tool").
 * The output buffer is filled with zeros before this returns.
 */
export async function readBrought(
  source: BoundSource,
  base: NodeJS.ProcessEnv,
  limitMs: number,
  how: BringHow,
  captured?: SourceOutput,
): Promise<BringRead> {
  const output =
    captured ?? (await readSource(source, base, limitMs).catch(() => ({ failed: {} }) as const));
  if (output === "changed" || output === "too-large") return { ended: output };
  if ("failed" in output) return { failed: output.failed };
  try {
    const names = how.names;
    if (how.reads === "json") {
      const values = readJson(output.output, names ?? []);
      return values ? { values } : { ended: "invalid-json" };
    }
    if (how.reads === "value") {
      const only = names?.[0];
      return {
        values:
          only === undefined ? new Map() : new Map([[only, readValue(output.output, how.trim)]]),
      };
    }
    const all = how.reads === "env0" ? readEnv0(output.output) : readLines(output.output);
    if (names === null) return { values: all };
    const wanted = new Set(names);
    for (const [name, value] of all) {
      if (wanted.has(name)) continue;
      zeroFill([value]);
      all.delete(name);
    }
    return { values: all };
  } finally {
    output.output.fill(0);
  }
}
