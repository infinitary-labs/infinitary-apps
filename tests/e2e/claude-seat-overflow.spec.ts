import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchClaudeSeat, say } from "./claudeSeat";
import { cardBody } from "./frames";
import type { LaunchedApp } from "./launch";
import { atRest } from "./layout";
import { claudeDefaultStore } from "./mockClaudeClient";
import {
  ANSWER_PROMPT_MARKER,
  CONTEXT_OVERFLOW_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  startMockProvider,
} from "./mockProvider";
import { windowShot } from "./pictures";
import { closeOpenCards, shownCard } from "./stack";

/** INF-447: hello must answer after a service length refusal, even with the person's compaction switches off.
 * Fixture: real boxed Claude client, dummy subscription, isolated HOME/userData and loopback provider.
 * Completion: an answer card arrives without Retry, then the next hello answers too.
 * Prerequisites: Electron and the SDK's client on macOS/Linux; no shared resources or real sign-in.
 */
test("Claude answers after a context refusal without asking the captain to Retry", async () => {
  const mockProvider = await startMockProvider();
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchClaudeSeat({
      mockProvider,
      env: {
        DISABLE_AUTO_COMPACT: "1",
        DISABLE_COMPACT: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      },
      prepareHome: (home) => {
        const config = claudeDefaultStore(home);
        mkdirSync(config, { recursive: true });
        writeFileSync(join(config, ".claude.json"), JSON.stringify({ autoCompactEnabled: false }));
      },
    });
    const { page } = launched;
    await say(page, `hello ${ANSWER_PROMPT_MARKER}`);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
    await closeOpenCards(page);
    await say(page, `hello ${CONTEXT_OVERFLOW_PROMPT_MARKER} ${ANSWER_PROMPT_MARKER}`);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 45_000 });
    await expect(cardBody(page, MOCK_ANSWER_TITLE).getByText(MOCK_ANSWER_TEXT)).toBeVisible();
    await atRest(shownCard(page, MOCK_ANSWER_TITLE));
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).every(
        (card) => card.author !== "host",
      ),
    ).toBe(true);
    if (process.env.INFINITARY_OVERFLOW_EVIDENCE_DIR) {
      await windowShot(
        page,
        join(process.env.INFINITARY_OVERFLOW_EVIDENCE_DIR, "claude-overflow-after.png"),
      );
    }
    await closeOpenCards(page);
    await say(page, `hello again ${ANSWER_PROMPT_MARKER}`);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});
