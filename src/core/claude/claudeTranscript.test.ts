import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  ClaudeTranscriptLookup,
  encodeClaudeProjectDir,
  locateClaudeTranscript,
  locateClaudeTranscriptAsync,
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
