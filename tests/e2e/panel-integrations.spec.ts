import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { STAND_IN_COUNT, standInIntegration } from "../../src/core/integrations/providers/standIn";
import {
  INTEGRATION_ASK_AGAIN,
  integrationAskLine,
} from "../../src/renderer/src/personal/panelBoundaryWords";
import {
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalTitle,
} from "../../src/shared/integrations";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { seedPersonalWorkspace } from "./personalFixtures";
import { heroShot, regionShot } from "./pictures";
import { showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-2334 piece 1, the captain's "Approve and build" (consent A, one rule
 * for every caller; the principle "Integrations reach every surface the
 * same way"): a panel reaches an integration through `props.integrations`,
 * under the same action rule and approval card as the agents, and the
 * captain allows its ask by keys alone.
 *
 * - Promised result: the panel's first call is kept and raises the app's
 *   approval card, naming the panel and its manifest's why; while it is up
 *   the panel's next call raises no other, and the window draws the host's
 *   line above the panel; Not now leaves the line turned down, and its Ask
 *   again raises the card anew; Always allow takes the line away and the
 *   panel's next call answers what the integration holds.
 * - Data: a panel whose manifest names the stand-in integration's
 *   `count_items`, and a stand-in items file with two items.
 * - Completion signal: the card on the stack, the line's `data-state`, and
 *   the stand-in's own answer drawn in the panel.
 * - Platform prerequisites: none beyond the hermetic launcher.
 * - Shared resources: none; the stand-in reads a scratch folder named by
 *   `INFINITARY_STAND_IN_INTEGRATION`.
 */

const PANEL = "stand-in-count";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "personal-integrations", PANEL);
/** The why the fixture's manifest gives, which the approval card shows as the panel's. */
const WHY =
  (
    JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")) as {
      integrations: { why: string }[];
    }
  ).integrations[0]?.why ?? "";

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("a panel's integration call asks the captain once, and Always allow by keys lets it run", async () => {
  const userDataDir = scratchDir("infinitary-panel-integrations-");
  seedPersonalWorkspace(userDataDir, FIXTURE, PANEL);
  const standIn = scratchDir("infinitary-panel-stand-in-");
  writeFileSync(
    join(standIn, "items.jsonl"),
    `${JSON.stringify({ id: "a", summary: "First" })}\n${JSON.stringify({ id: "b", summary: "Second" })}\n`,
  );
  launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { INFINITARY_STAND_IN_INTEGRATION: standIn },
  });
  const { app, page } = launched;
  const evidenceDir = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidenceDir) await resizeWindow(app, page, { width: 1280, height: 800 });

  const place = await page.evaluate(
    async () =>
      (await window.infinitary.integrations.list()).integrations.find(
        (entry) => entry.id === "stand-in",
      )?.name ?? "",
  );
  expect(place).not.toBe("");
  const title = integrationApprovalTitle(STAND_IN_COUNT.label, place);
  const approvals = () =>
    page.evaluate(
      async (wanted) =>
        (await window.infinitary.cards.list()).filter((card) => card.title === wanted).length,
      title,
    );

  const panel = page.locator(`[data-side-panel="${PANEL}"]`);
  const drawn = panelBody(page, PANEL);
  const count = drawn.getByRole("button", { name: "Count items", exact: true });
  const answer = drawn.locator("[data-fixture-answer]");
  const line = panel.locator(`[data-panel-integration-ask="stand-in/${STAND_IN_COUNT.name}"]`);

  await test.step("the first call is kept and raises one approval card naming the panel", async () => {
    await pressKey(count, "Enter");
    await expect(answer).toHaveAttribute("data-fixture-answer", "refused", { timeout: 30_000 });
    await expect(line).toHaveAttribute("data-state", "asking");
    await expect(line).toContainText(integrationAskLine(STAND_IN_COUNT.label, place, "asking"));
    await expect.poll(approvals, { timeout: 30_000 }).toBe(1);
    await showCard(page, title);
    await expect(cardBody(page, title).locator("body")).toContainText(WHY);
    if (evidenceDir) {
      await regionShot(panel, join(evidenceDir, "panel-line-asking-after.png"));
      await regionShot(shownCard(page, title), join(evidenceDir, "panel-approval-after.png"));
      await heroShot(app, page, { region: panel, name: "panels-reach-integrations" });
    }
    // Its next call waits on the same card and raises no other.
    await pressKey(count, "Enter");
    await expect(answer).toContainText(INTEGRATION_APPROVAL_WORDS.always);
    expect(await approvals()).toBe(1);
  });

  await test.step("Not now leaves the line turned down, and Ask again raises the card anew", async () => {
    await pressKey(
      shownCard(page, title).getByRole("button", {
        name: INTEGRATION_APPROVAL_WORDS.deny,
        exact: true,
      }),
      "Enter",
    );
    await expect(line).toHaveAttribute("data-state", "declined");
    await expect(line).toContainText(integrationAskLine(STAND_IN_COUNT.label, place, "declined"));
    await expect.poll(approvals).toBe(0);
    await pressKey(count, "Enter");
    await expect(answer).toContainText(INTEGRATION_APPROVAL_WORDS.deny);
    expect(await approvals()).toBe(0);
    if (evidenceDir) await regionShot(panel, join(evidenceDir, "panel-line-declined-after.png"));

    await pressKey(line.getByRole("button", { name: INTEGRATION_ASK_AGAIN, exact: true }), "Enter");
    await expect(line).toHaveAttribute("data-state", "asking");
    await expect.poll(approvals).toBe(1);
  });

  await test.step("Always allow takes the line away and the panel's next call runs", async () => {
    await showCard(page, title);
    await pressKey(
      shownCard(page, title).getByRole("button", {
        name: INTEGRATION_APPROVAL_WORDS.always,
        exact: true,
      }),
      "Enter",
    );
    await expect(line).toHaveCount(0);
    await pressKey(count, "Enter");
    await expect(answer).toHaveAttribute("data-fixture-answer", "ran");
    // The words are the stand-in's own answer for the same folder.
    const holds = await standInIntegration({ dir: standIn }).call(
      "stand-in",
      STAND_IN_COUNT.name,
      {},
      {
        kind: "firstmate",
      },
    );
    await expect(answer).toHaveText(holds.text);
  });
});
