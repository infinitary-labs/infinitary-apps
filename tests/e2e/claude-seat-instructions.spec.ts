import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveClaudeExecutable } from "../../src/core/claude/claudeCli";
import { seatMovedLine } from "../../src/core/orchestrator/seat";
import { SEQUENCES_SKILL_RELATIVE_PATH } from "../../src/core/personal/sequencesSkill";
import { catalogEntry } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { CLAUDE_SEAT_MODEL, claudeSeatRequests, launchClaudeSeat, say } from "./claudeSeat";
import { waitForFirstmateIdle } from "./crew";
import type { LaunchedApp } from "./launch";
import { sdkBundledClaudeClient } from "./mockClaudeClient";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { feedLine } from "./rails";
import { shownCard } from "./stack";

/**
 * The captain rewrites how the Firstmate approaches work while it answers on
 * Claude (docs/claude-client.md). A resumed Claude client serves the system
 * prompt it recorded when its session started, so the seat does not resume:
 * its next turn runs in a new conversation serving the new words, told what
 * the host saw of the turns before, and the feed says so. The seat runs the
 * client the product would run: the installed one, else the SDK's own copy.
 */

const NEW_RULE = "Always name the rivet count first.";

let launched: LaunchedApp;
let mockProvider: MockProviderServer;

test.beforeAll(async () => {
  mockProvider = await startMockProvider();
  launched = await launchClaudeSeat({
    mockProvider,
    homeDir: scratchDir("infinitary-home-"),
    client: resolveClaudeExecutable() ?? sdkBundledClaudeClient(),
  });
});

test.afterAll(async () => {
  await launched?.close();
  await mockProvider?.close();
});

test("changed instructions start a new conversation on Claude that serves them", async () => {
  const { page, userDataDir } = launched;
  await say(page, `remember the word cobalt, ${ANSWER_PROMPT_MARKER}`);
  await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({
    timeout: 45_000,
  });
  // A card can arrive before its session finishes. The old conversation must
  // be committed before changing instructions, or there is nothing to renew.
  await waitForFirstmateIdle(page, 45_000);
  expect(claudeSeatRequests(mockProvider).some((body) => body.includes(NEW_RULE))).toBe(false);

  // The captain's own words on how to approach work, in the personal workspace.
  const path = join(userDataDir, "fleet", "personal", SEQUENCES_SKILL_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: sequences\n---\n# Sequences\n\n${NEW_RULE}\n`);

  await say(page, `which word was it? ${ANSWER_PROMPT_MARKER}`);
  await expect(
    feedLine(
      page,
      seatMovedLine(
        {
          provider: catalogEntry(CLAUDE_SEAT_MODEL.provider)?.name ?? CLAUDE_SEAT_MODEL.provider,
          model: CLAUDE_SEAT_MODEL.id,
        },
        "instructions",
      ),
    ),
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(
      () => claudeSeatRequests(mockProvider).find((body) => body.includes("which word was it?")),
      { timeout: 45_000 },
    )
    .toBeTruthy();
  const turn = claudeSeatRequests(mockProvider).find((body) =>
    body.includes("which word was it?"),
  ) as string;
  // The new words reach the request, and the turn is told what came before.
  expect(turn).toContain(NEW_RULE);
  expect(turn).toContain('the captain said \\"remember the word cobalt');
  await page.screenshot({ path: test.info().outputPath("claude-seat-instructions.png") });
});
