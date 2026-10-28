import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveClaudeExecutable } from "../../src/core/claude/claudeCli";
import { seatMovedLine } from "../../src/core/orchestrator/seat";
import { catalogEntry } from "../../src/shared/providers";
import { runbookManifestSchema } from "../../src/shared/runbooks";
import { scratchDir } from "../helpers/scratchDirs";
import { CLAUDE_SEAT_MODEL, claudeSeatRequests, launchClaudeSeat, say } from "./claudeSeat";
import { waitForFirstmateIdle } from "./crew";
import type { LaunchedApp } from "./launch";
import { sdkBundledClaudeClient } from "./mockClaudeClient";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  type MockProviderServer,
  servedInstructions,
  startMockProvider,
} from "./mockProvider";
import { feedLine } from "./rails";
import { settingRow } from "./settings";
import { shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * The captain switches the guidance the Firstmate uses while it answers on
 * Claude (docs/claude-client.md). A resumed Claude client serves the system
 * prompt it recorded when its session started, so the seat does not resume:
 * its next turn runs in a new conversation serving the new words, told what
 * the host saw of the turns before, and the feed says so. The seat runs the
 * client the product would run: the installed one, else the SDK's own copy.
 */

// INF-1177 moves app-managed guidance out of the duplicate workspace skill.
// Read the actual runbook owner and change its supported switch, preserving
// the instruction-renewal and conversation-continuity promises on Claude.
const workflowRoot = join(process.cwd(), "resources/runbooks/sequences");
const workflows = runbookManifestSchema.parse(
  JSON.parse(readFileSync(join(workflowRoot, "runbook.json"), "utf8")),
);
if (!workflows.firstmate) throw new Error("Common workflows has no first-mate section.");
const workflowGuide = readFileSync(join(workflowRoot, workflows.firstmate), "utf8").trim();

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
  const { page } = launched;
  await say(page, `remember the word cobalt, ${ANSWER_PROMPT_MARKER}`);
  await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({
    timeout: 45_000,
  });
  // A card can arrive before its session finishes. The old conversation must
  // be committed before changing instructions, or there is nothing to renew.
  await waitForFirstmateIdle(page, 45_000);
  expect(
    claudeSeatRequests(mockProvider).some((body) =>
      servedInstructions(body).includes(workflowGuide),
    ),
  ).toBe(true);

  await pressKey(page.getByRole("button", { name: "Settings", exact: true }), "Enter");
  await pressKey(page.getByRole("tab", { name: "Intelligence", exact: true }), "Enter");
  const control = settingRow(page, `runbook-${workflows.id}`).getByRole("switch", {
    name: workflows.name,
    exact: true,
  });
  await expect(control).toHaveAttribute("aria-checked", "true");
  await pressKey(control, "Space");
  await expect(control).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

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
  // The new selection reaches the request, and the turn is told what came before.
  expect(servedInstructions(turn)).not.toContain(workflowGuide);
  expect(turn).toContain('the captain said \\"remember the word cobalt');
  await page.screenshot({ path: test.info().outputPath("claude-seat-instructions.png") });
});
