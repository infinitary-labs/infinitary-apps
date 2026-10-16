import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { encodeClaudeProjectDir, locateClaudeTranscript } from "./claudeTranscript";

describe("locateClaudeTranscript", () => {
  it("encodes the cwd the way the client names its project dir", () => {
    // Measured against the vendored client (2026-09-05).
    expect(encodeClaudeProjectDir("/private/tmp/claude-501/x.y/work")).toBe(
      "-private-tmp-claude-501-x-y-work",
    );
  });

  it("finds the transcript under the encoded cwd in one stat", () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    const cwd = "/w/fleet/demo/.worktrees/ab12";
    const dir = join(configDir, "projects", encodeClaudeProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess-1.jsonl");
    writeFileSync(file, "");
    expect(locateClaudeTranscript({ configDir, cwd, sessionId: "sess-1" })).toBe(file);
  });

  it("falls back to scanning the project dirs when the encoding differs", () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    const dir = join(configDir, "projects", "some-future-encoding");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sess-2.jsonl");
    writeFileSync(file, "");
    expect(locateClaudeTranscript({ configDir, cwd: "/w/other", sessionId: "sess-2" })).toBe(file);
  });

  it("returns null before the client has written anything", () => {
    const configDir = scratchDir("infinitary-claude-cfg-");
    expect(locateClaudeTranscript({ configDir, cwd: "/w", sessionId: "sess-3" })).toBeNull();
    mkdirSync(join(configDir, "projects", "-w"), { recursive: true });
    expect(locateClaudeTranscript({ configDir, cwd: "/w", sessionId: "sess-3" })).toBeNull();
  });
});
