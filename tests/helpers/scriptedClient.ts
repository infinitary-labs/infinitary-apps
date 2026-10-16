import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DeviceGrant } from "@shared/devices";
import { scratchDir } from "./scratchDirs";

/**
 * Drives `scripts/contract-client.ts`, the client that knows the home only
 * through the published contract (docs/contract.md), as its own process
 * under plain Node: the test writes it requests and reads back the lines it
 * prints. The client parses everything against docs/contract.json; this
 * helper only matches lines.
 */

const SCRIPT = join(__dirname, "..", "..", "scripts", "contract-client.ts");

export type ClientLine = { t: string; [field: string]: unknown };

export type ScriptedClient = {
  /** Every line it printed so far, in order. */
  lines: ClientLine[];
  /** Resolves with the first line, printed or still to come, that matches. */
  line: (match: (line: ClientLine) => boolean) => Promise<ClientLine>;
  /** Asks one request and resolves with its `result` or `refused` line. */
  ask: (channel: string, args: unknown[]) => Promise<ClientLine>;
  /** Ends its input; resolves with its exit code once it has closed. */
  close: () => Promise<number | null>;
};

export async function startScriptedClient(
  grant: DeviceGrant,
  options: { speak?: string } = {},
): Promise<ScriptedClient & { welcome: ClientLine }> {
  const grantFile = join(scratchDir("infinitary-scripted-client-"), "grant.json");
  writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [SCRIPT, "--grant", grantFile, ...(options.speak ? ["--speak", options.speak] : [])],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines: ClientLine[] = [];
  const watchers = new Set<() => void>();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (text) => {
    lines.push(JSON.parse(text) as ClientLine);
    for (const watcher of watchers) watcher();
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const line = (match: (line: ClientLine) => boolean) =>
    new Promise<ClientLine>((resolve, reject) => {
      const look = () => {
        const found = lines.find(match);
        if (!found) return;
        watchers.delete(look);
        resolve(found);
      };
      watchers.add(look);
      look();
      void exited.then(() => {
        if (!watchers.has(look)) return;
        watchers.delete(look);
        reject(new Error(`The client exited first: ${stderr || JSON.stringify(lines.at(-1))}`));
      });
    });
  let nextId = 0;
  const client: ScriptedClient = {
    lines,
    line,
    ask: (channel, args) => {
      const id = `ask-${++nextId}`;
      child.stdin.write(`${JSON.stringify({ id, channel, args })}\n`);
      return line((printed) => printed.id === id);
    },
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
  const welcome = await line((printed) => printed.t === "welcome");
  return { ...client, welcome };
}
