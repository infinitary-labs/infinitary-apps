import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { CLAUDE_CHIP_INSTALL_NOTE, CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import type { InvokeResponse } from "@shared/ipc";
import { afterEach, expect, test, vi } from "vitest";
import { resolveClaudeExecutable } from "../src/core/claude/claudeCli";
import { defaultClaudeConfigDir } from "../src/core/claude/claudeQuota";
import { readHome } from "./helpers/browserFreshHome";
import type { FreshHomeAnswers } from "./helpers/browserProvided";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The browser layer's homes (docs/testing.md, "The browser layer") read the
 * same on a computer with Claude Code as on one without: each boot finds no
 * Claude Code and no Claude login of the computer it runs on, so the Claude
 * chip says to install Claude Code on a developer's Mac as in CI, and no boot
 * runs the computer's own Claude Code. The computer's Claude Code here is a
 * stand-in on the search path that leaves a mark when anything runs it.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A Claude Code on this computer's search path; `ran` exists once anything has run it. */
function installedClaudeCode(): { ran: string } {
  const bin = scratchDir("infinitary-installed-claude-");
  const ran = join(bin, "ran");
  const client = join(bin, "claude");
  writeFileSync(client, `#!/bin/sh\n: > "${ran}"\necho "2.1.999 (Claude Code)"\n`);
  chmodSync(client, 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("INFINITARY_CLAUDE_CLI", undefined);
  vi.stubEnv("FM3000_CLAUDE_CLI", undefined);
  return { ran };
}

function claudeRow(answers: FreshHomeAnswers) {
  const providers = answers.plain["inf:auth:providers"] as InvokeResponse<"inf:auth:providers">;
  return providers.find((provider) => provider.id === "anthropic-claude");
}

test("the fresh home on a computer with Claude Code reads as one without, and never runs it", async () => {
  const { ran } = installedClaudeCode();
  // Without the home's own Claude Code location, the core finds this one.
  expect(resolveClaudeExecutable()).toBeDefined();

  const answers = await readHome();

  expect(claudeRow(answers)).toMatchObject({
    authTypes: [],
    unavailable: { note: CLAUDE_CHIP_INSTALL_NOTE, detail: CLAUDE_CLIENT_MISSING_TEXT },
    connected: false,
  });
  expect(existsSync(ran)).toBe(false);
});

test("a seeded home's core finds no Claude Code or Claude login of this computer's, and the test's come back after", async () => {
  const { ran } = installedClaudeCode();
  const testHome = process.env.HOME;
  const testClaudeDir = defaultClaudeConfigDir();
  const testClient = process.env.INFINITARY_CLAUDE_CLI;
  const seen: { client?: string; claudeDir?: string; homeExisted?: boolean } = {};

  const answers = await readHome(() => {
    seen.client = resolveClaudeExecutable();
    seen.claudeDir = defaultClaudeConfigDir();
    seen.homeExisted = existsSync(dirname(seen.claudeDir));
  });

  expect(claudeRow(answers)).toMatchObject({ authTypes: [], connected: false });
  expect(seen.client).toBeUndefined();
  expect(seen.claudeDir).not.toBe(testClaudeDir);
  expect(seen.homeExisted).toBe(true);
  expect(existsSync(dirname(seen.claudeDir ?? ""))).toBe(false);
  expect(existsSync(ran)).toBe(false);
  expect(process.env.HOME).toBe(testHome);
  expect(process.env.INFINITARY_CLAUDE_CLI).toBe(testClient);
  expect(defaultClaudeConfigDir()).toBe(testClaudeDir);
});
