import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BoundProgram, ProgramStarted } from "./programBroker";
import { programSecretBroker } from "./programBroker";

// Intent: INF-3984 (Secrets hands a key to a program that keeps running, such
// as an MCP server over its pipes): the program the person allowed is the one
// that starts with the key, checked again right before it starts, and a start
// that fails never carries the key back in its words.
const KEY = "nk_live_4Fq9sT2vXw8LmC3pRb7Y";
const HIDDEN = "[a kept key]";

/** A notes server's script and its data file in a fresh folder, as a person adds one. */
async function notesServer(): Promise<{ folder: string; script: string; data: string }> {
  const folder = scratchDir("program-broker-");
  const script = join(folder, "notes-server");
  const data = join(folder, "notes.json");
  await writeFile(script, "#!/bin/sh\nexec cat\n");
  await chmod(script, 0o755);
  await writeFile(data, JSON.stringify({ notes: ["Plan the week"] }));
  return { folder, script, data };
}

function brokerFor(
  program: BoundProgram,
  start: (given: { env: Record<string, string> }) => Promise<string>,
) {
  return programSecretBroker<string>({
    id: "notes-server",
    resolve: () => program,
    start,
    hidden: HIDDEN,
  });
}

function bound(folder: string, script: string, data: string): BoundProgram {
  return {
    label: "Notes",
    program: script,
    args: [data],
    cwd: folder,
    env: { PATH: "/usr/bin:/bin" },
    keys: { NOTES_KEY: "notes-key" },
    operation: "Start Notes, an MCP server, and keep talking to it",
    result: "Its connection",
  };
}

describe("a program that keeps running", () => {
  it("starts with its key while it is the program that was allowed, and not once it changed", async () => {
    const { folder, script, data } = await notesServer();
    const starts: Record<string, string>[] = [];
    const broker = brokerFor(bound(folder, script, data), async ({ env }) => {
      starts.push({ ...env });
      return "connection";
    });

    const prepared = await broker.prepare({});
    expect(prepared?.facts.program?.executable.path).toBe(await realpath(script));
    expect(prepared?.facts.secrets).toEqual({ NOTES_KEY: "notes-key" });
    // The server's own data changes as it runs; that is not a different program.
    await writeFile(data, JSON.stringify({ notes: ["Plan the week", "Call the plumber"] }));
    const started = (await prepared?.run({
      NOTES_KEY: Buffer.from(KEY),
    })) as ProgramStarted<string>;
    expect(started).toEqual({ started: "connection" });
    expect(starts).toEqual([{ PATH: "/usr/bin:/bin", NOTES_KEY: KEY }]);

    const again = await broker.prepare({});
    await writeFile(script, "#!/bin/sh\nexec env\n");
    expect(await again?.run({ NOTES_KEY: Buffer.from(KEY) })).toEqual({ changed: true });
    expect(starts).toHaveLength(1);
  });

  it("answers a failed start's words with the key hidden", async () => {
    const { folder, script, data } = await notesServer();
    const broker = brokerFor(bound(folder, script, data), async ({ env }) => {
      throw new Error(`Notes refused the key ${env.NOTES_KEY} and exited.`);
    });
    const prepared = await broker.prepare({});
    expect(await prepared?.run({ NOTES_KEY: Buffer.from(KEY) })).toEqual({
      failed: `Notes refused the key ${HIDDEN} and exited.`,
    });
  });
});
