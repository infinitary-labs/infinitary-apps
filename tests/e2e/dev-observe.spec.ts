import { expect, test } from "@playwright/test";
import { NO_SESSION_YET } from "../../src/shared/observe";
import { observeBody, observeElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { FINISH_PROMPT_MARKER, MOCK_COMPLETION_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { putInLine, reportLine, taskKey } from "./rails";

/**
 * Dev Observe (docs/dev-observe.md): unpackaged e2e always has the gate on.
 * Installed alpha and stable builds are `observe-gate.spec.ts`.
 *
 * Observe is the first Tier-2 contribution (docs/ui-plugins.md, phase 1):
 * the pane is a template in a sandboxed frame the host serves, fed by the
 * read catalog, so every locator below lives inside `iframe[title="Observe"]`.
 *
 * The second test drives a real fleet moment on the mock provider - a
 * commission and the crewmate's report - so both session kinds hold real transcripts, then
 * checks the pane tells them apart and never renders an empty pane, and
 * that the crewmate's session stays readable once its task is settled.
 */

/** The task the captain commissions. */
const TITLE = "write a short status note";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

const observeFrame = () => observeBody(launched.page);

test("exposes the Observe tab in unpackaged settings with the Firstmate row", async () => {
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(() => window.infinitary.observe.enabled()))
    .toEqual({ enabled: true });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Observe" }).click();
  const iframe = observeElement(page);
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", /^app-frame:\/\/mount\/[0-9a-f-]+$/);
  const frame = observeFrame();
  await expect(frame.locator("[data-observe-root]")).toBeVisible();
  await expect(frame.locator("[data-observe-banner]")).toBeVisible();
  await expect(frame.locator('[data-observe-session="firstmate"]')).toBeVisible();
  await expect(frame.locator("[data-observe-detail]")).toContainText("First mate");
  // Nothing has happened yet: the pane says so instead of showing nothing.
  await expect(frame.locator("[data-observe-transcript-note]")).toContainText(NO_SESSION_YET);
  await page.keyboard.press("Escape");
});

test("tells the main session and every crewmate apart, then opens the settled task's kept session", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await test.step("tells the main session and every crewmate apart, and shows each one's content", async () => {
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
    await input.press("Enter");
    await expect(reportLine(page, await taskKey(page, TITLE))).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Observe" }).click();
    const frame = observeFrame();
    const list = frame.locator("[data-observe-session-list]");
    const main = list.locator('[data-observe-group="orchestrator"]');
    const supervision = list.locator('[data-observe-group="supervision"]');
    const crew = list.locator('[data-observe-group="crewmate"]');

    // Two groups, each saying in words what it is - never two look-alike
    // rows. S7c retired the supervision session, so this install writes no
    // such transcript and the group does not appear.
    await expect(main).toContainText("Main");
    await expect(main).toContainText("First mate");
    // e2e-typed-words: the role line is typed in observe.frame.js, a frame script served as text that exports nothing to import
    await expect(main).toContainText("The session you talk to");
    await expect(supervision).toHaveCount(0);
    await expect(crew).toContainText("Crew");
    await expect(crew).toContainText(TITLE);

    // Main is selected by default: the header names the kind, the transcript
    // holds the captain's own turn and the spawn.
    const detail = frame.locator("[data-observe-detail]");
    // e2e-typed-words: the role line is typed in observe.frame.js, a frame script served as text that exports nothing to import
    await expect(detail.locator("[data-observe-role]")).toContainText("The first mate you talk to");
    await expect(detail.locator('[data-observe-turn="user"]').first()).toContainText(
      SPAWN_PROMPT_MARKER,
    );
    await expect(
      detail.locator('[data-observe-turn="tool"]').filter({ hasText: "spawn_crewmate" }).first(),
    ).toBeVisible();

    // The crewmate: brief, report, and a backend badge - never a blank pane.
    // Chromium drops native clicks into a sandboxed out-of-process frame
    // while the window is hidden, so the click is dispatched in-frame.
    await crew.locator("[data-observe-session]").first().dispatchEvent("click");
    await expect(detail.locator("[data-observe-detail-header]")).toContainText("crewmate");
    await expect(detail.locator("[data-observe-detail-header]")).toContainText("pi");
    await expect(detail.locator("[data-observe-turn]").first()).toBeVisible();
    await expect(detail.locator('[data-observe-turn="assistant"]').first()).toContainText(
      MOCK_COMPLETION_TEXT,
    );
    await expect(detail.locator("[data-observe-transcript-note]")).toHaveCount(0);
    await expect(detail.locator("[data-observe-empty]")).toHaveCount(0);
  });

  await test.step("opens a settled task's kept session: the record closes, the transcript stays readable (D2, P5)", async () => {
    await page.keyboard.press("Escape");
    await input.click();
    await input.fill(`${FINISH_PROMPT_MARKER}${TITLE}`);
    await input.press("Enter");
    const key = await taskKey(page, TITLE);
    await expect(putInLine(page, key)).toBeVisible({ timeout: 30_000 });
    // WI-11 retired `delivered`/`finish`: an idle crewmate is settled by
    // landing it. Its clean branch fast-forwards, the record closes done, its
    // worktree goes, and its session file stays in place.
    const record = await page.evaluate(async (key) => {
      const board = await window.infinitary.tasks.board();
      return board.tasks.find((task) => task.key === key) ?? null;
    }, key);
    expect(record).toMatchObject({ status: "done", closedReason: "landed" });

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Observe" }).click();
    const frame = observeFrame();
    const crew = frame
      .locator("[data-observe-session-list]")
      .locator('[data-observe-group="crewmate"]');
    const row = crew.locator("[data-observe-session]").first();
    await expect(row).toContainText(TITLE);
    await expect(row).toContainText("done");
    await row.dispatchEvent("click");
    const detail = frame.locator("[data-observe-detail]");
    await expect(detail.locator("[data-observe-detail-header]")).toContainText("done");
    await expect(detail.locator('[data-observe-turn="assistant"]').first()).toContainText(
      MOCK_COMPLETION_TEXT,
    );
    await expect(detail.locator("[data-observe-transcript-note]")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
