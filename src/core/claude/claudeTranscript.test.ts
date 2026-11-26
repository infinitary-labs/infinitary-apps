import { mkdirSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  ClaudeTranscriptLookup,
  clientTranscriptAt,
  encodeClaudeProjectDir,
  locateClaudeTranscript,
  locateClaudeTranscriptAsync,
  seatSessionFiles,
} from "./claudeTranscript";

describe.each([locateClaudeTranscript, locateClaudeTranscriptAsync])("%s", (locate) => {
  it("encodes the cwd the way the client names its project dir", () => {
    // Measured against the vendored client (2026-09-05).
    expect(encodeClaudeProjectDir("/private/tmp/claude-501/x.y/work")).toBe(
      "-private-tmp-claude-501-x-y-work",
    );
  });

  it("finds the transcript under the encoded cwd", async () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    const cwd = "/w/fleet/demo/.worktrees/ab12";
    const dir = join(configDir, "projects", encodeClaudeProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess-1.jsonl");
    writeFileSync(file, "");
    expect(await locate({ configDir, cwd, sessionId: "sess-1" })).toBe(file);
  });

  it("falls back to scanning the project dirs when the encoding differs", async () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    const dir = join(configDir, "projects", "some-future-encoding");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess-2.jsonl");
    writeFileSync(file, "");
    expect(await locate({ configDir, cwd: "/w/other", sessionId: "sess-2" })).toBe(file);
  });

  it("returns null before the client has written anything", async () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    expect(await locate({ configDir, cwd: "/w", sessionId: "sess-3" })).toBeNull();
    mkdirSync(join(configDir, "projects", "-w"), { recursive: true });
    expect(await locate({ configDir, cwd: "/w", sessionId: "sess-3" })).toBeNull();
  });
});

// INF-2248: rolling sessions must discover missing/renamed paths without a synchronous project walk.
it("shares asynchronous discovery, keeps found paths and retries a missing or removed file", async () => {
  const configDir = scratchDir("infinitary-claude-lookup-");
  const cwd = "/work/crew";
  const lookup = new ClaudeTranscriptLookup(configDir, cwd);
  expect(await lookup.find("session")).toBeNull();
  const dir = join(configDir, "projects", "different-encoding");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "");
  let responsive = false;
  const heartbeat = new Promise<void>((resolve) =>
    setImmediate(() => {
      responsive = true;
      resolve();
    }),
  );
  expect(lookup.read("session")).toBeNull();
  const found = lookup.find("session");
  expect(lookup.find("session")).toBe(found);
  expect(await found).toBe(file);
  expect(responsive).toBe(true);
  await heartbeat;
  expect(lookup.read("session")).toBe(file);
  unlinkSync(file);
  expect(lookup.read("session")).toBeNull();
  expect(await lookup.find("session")).toBeNull();
  writeFileSync(file, "");
  expect(await lookup.find("session")).toBe(file);
});

// INF-6587's approved plan: the person's connection carries the first mate's turns on Claude's own
// client too, which the client finishes writing after the app's copy was made.
it("reads the first mate seat's session from the client's own transcript while it holds more than the app's copy", () => {
  const recordDir = scratchDir("infinitary-seat-records-");
  const configDir = scratchDir("infinitary-claude-cfg-");
  // The seat's home as the app names it; the client names its folder after the resolved one.
  const home = scratchDir("infinitary-seat-home-");
  const session = "5f0c2a4e-1111-4222-8333-944455556666";
  const prompt = {
    type: "user",
    sessionId: session,
    uuid: "u1",
    timestamp: "2026-11-25T20:32:23.404Z",
    message: { role: "user", content: "why does the meter idle? answer with a card" },
  };
  const reply = {
    type: "assistant",
    sessionId: session,
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-11-25T20:32:25.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "The crew has it under way." }] },
  };
  const served = join(recordDir, `${session}.served.jsonl`);
  writeFileSync(
    served,
    `${JSON.stringify({ kind: "contract", at: 1_000, version: "firstmate" })}\n`,
  );
  const clientDir = join(configDir, "projects", encodeClaudeProjectDir(realpathSync(home)));
  mkdirSync(clientDir, { recursive: true });
  const client = join(clientDir, `${session}.jsonl`);
  writeFileSync(client, `${JSON.stringify(prompt)}\n`);
  const clientFile = (id: string) => clientTranscriptAt(configDir, home, id);
  const servedAt = Date.parse(prompt.timestamp);
  utimesSync(served, servedAt / 1000, servedAt / 1000);

  // A first turn can end before the app copies anything.
  expect(seatSessionFiles(recordDir, servedAt, clientFile)).toEqual([client]);

  const copy = join(recordDir, `${session}.jsonl`);
  writeFileSync(copy, `${JSON.stringify(prompt)}\n`);
  expect(seatSessionFiles(recordDir, servedAt, clientFile)).toEqual([copy]);

  writeFileSync(client, `${JSON.stringify(prompt)}\n${JSON.stringify(reply)}\n`);
  expect(seatSessionFiles(recordDir, servedAt, clientFile)).toEqual([client]);

  // A session served before the turn began is not looked up.
  expect(seatSessionFiles(recordDir, servedAt + 60_000, clientFile)).toEqual([copy]);
});
