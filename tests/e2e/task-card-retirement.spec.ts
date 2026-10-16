import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeCrew } from "./claudeCrew";
import { type LaunchedApp, launchApp } from "./launch";
import { sdkBundledClaudeClient } from "./mockClaudeClient";
import {
  CANCEL_PROMPT_MARKER,
  CLAUDE_CARD_RETIRE_MARKER,
  CLAUDE_CREW_PROMPT_MARKER,
  MOCK_CLAUDE_CARD_TITLE,
  SPAWN_PROMPT_MARKER,
  THREAD_CARD_TITLE,
  THREAD_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, taskLine } from "./rails";
import { shownCard } from "./stack";

/** A private wrapper records only its own client's pid, so the test can end that session outright. */
function recordedClient(dir: string): { client: string; pidFile: string } {
  const client = join(dir, "client.mjs");
  const pidFile = join(dir, "client.pid");
  writeFileSync(
    client,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(${JSON.stringify(sdkBundledClaudeClient())}, process.argv.slice(2), {
  stdio: "inherit", env: process.env,
});
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
`,
    { mode: 0o755 },
  );
  return { client, pidFile };
}

async function send(app: LaunchedApp, text: string): Promise<void> {
  const input = promptInput(app.page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  await input.press("Enter");
}

async function closedWithoutChoices(
  app: LaunchedApp,
  taskId: string,
  reason: string,
): Promise<void> {
  const { page } = app;
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId), {
      timeout: 30_000,
    })
    .toMatchObject({
      status: "dropped",
      closedReason: reason,
      waitingCardId: null,
      flags: { needsYou: false },
    });
  await expect.poll(() => page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
  writeFileSync(
    test.info().outputPath(`${reason}-state.json`),
    JSON.stringify(
      { detail, cards: await page.evaluate(() => window.infinitary.cards.list()) },
      null,
      2,
    ),
  );
  await expandDock(page, "activity");
  await expect(taskLine(page, detail.key, reason === "failed" ? "failed" : "status")).toBeVisible();
}

for (const reason of ["cancelled", "failed"] as const) {
  test(`a ${reason} running crewmate retires its shown decision and keeps it retired after restart`, async () => {
    const wrapper = recordedClient(scratchDir("infinitary-ended-client-"));
    let app = await launchClaudeCrew({ claudeTurns: { client: wrapper.client } });
    const title = `inspect hatches ${CLAUDE_CREW_PROMPT_MARKER} ${CLAUDE_CARD_RETIRE_MARKER}`;
    try {
      await send(app, `${SPAWN_PROMPT_MARKER} ${title}`);
      await expect(shownCard(app.page, MOCK_CLAUDE_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => app.mockProvider?.heldRequests()).toBe(1);
      const [card] = await app.page.evaluate(() => window.infinitary.cards.list());
      const taskId = card?.taskId as string;
      expect(card?.actions).toHaveLength(2);
      expect(card?.awaiting).toBeUndefined();
      await expect
        .poll(() => app.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
        .toMatchObject({ status: "active", activity: "running", waitingCardId: card?.id });
      await app.page.screenshot({ path: test.info().outputPath(`${reason}-before.png`) });
      if (reason === "cancelled") {
        await send(app, `${CANCEL_PROMPT_MARKER}${title}`);
      } else {
        // The actual client exits while a request is held. This is not a
        // recoverable provider-failed turn or a host-requested interruption.
        expect(existsSync(wrapper.pidFile)).toBe(true);
        const pid = Number(readFileSync(wrapper.pidFile, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        process.kill(pid, "SIGKILL");
      }
      await closedWithoutChoices(app, taskId, reason);
      await app.page.screenshot({ path: test.info().outputPath(`${reason}-after.png`) });
      const { userDataDir, homeDir } = app;
      await app.close();
      app = await launchClaudeCrew({ userDataDir, homeDir });
      await closedWithoutChoices(app, taskId, reason);
      await app.page.screenshot({ path: test.info().outputPath(`${reason}-restart.png`) });
    } finally {
      await app.close();
    }
  });
}

test("cancelling a saved idle task retires its restored decision without reopening its crewmate", async () => {
  let app = await launchApp({ withMockProvider: true });
  try {
    await send(app, `${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
    await expect(shownCard(app.page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const [card] = await app.page.evaluate(() => window.infinitary.cards.list());
    const taskId = card?.taskId as string;
    await expect
      .poll(() => app.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "active", activity: "idle", waitingCardId: card?.id });
    const { userDataDir, homeDir } = app;
    await app.close();
    app = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    await expect(shownCard(app.page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await send(app, `${CANCEL_PROMPT_MARKER}${THREAD_PROMPT_MARKER}`);
    await closedWithoutChoices(app, taskId, "cancelled");
    await app.page.screenshot({ path: test.info().outputPath("saved-idle-cancelled.png") });
    expect(await app.page.evaluate(() => window.infinitary.crew.counts())).toEqual({
      working: 0,
      idle: 0,
      queued: 0,
    });
  } finally {
    await app.close();
  }
});
