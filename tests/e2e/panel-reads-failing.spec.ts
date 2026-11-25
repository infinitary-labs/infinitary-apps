import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  PANEL_READS_ASKED_OPENING,
  PANEL_READS_FAILING_OPENING,
} from "../../src/core/orchestrator/noticeWakes";
import { appPathsFor } from "../../src/core/paths";
import {
  FAILING_ASK,
  FAILING_HEADING,
  FAILING_LOOKING,
} from "../../src/renderer/src/personal/panelBoundaryWords";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { openPanelStatus, panelStatusDetails, panelStatusMark } from "./panelStatus";
import { FAILING_READ_ANSWER, seedFailingReadPanel } from "./personalFixtures";
import { pressKey } from "./windowKeys";

/**
 * The captain's plan for the panel status mark, part 2: a background job of
 * their own panel that keeps failing gets a mark by the panel's name, the
 * first mate hears it once, Ask the first mate - pressed from the
 * keyboard - tells it once, and the first run that works clears the mark.
 *
 * - Promised result: after two failed runs that span the app's window, the
 *   mark appears with the failing line on rest, its details say the job
 *   fails with the newest answer and that the panel still shows what it last
 *   read, the first mate's request carries the failing wake, and Ask the
 *   first mate turns to Asked and tells the first mate; once the limit comes
 *   back, the next run clears the row and the mark.
 * - Data: `growth`, whose one job runs every minute and throws the
 *   connector's read limit each time until its `raise-limit` action.
 * - Completion signal: the snapshot's `failing` row, the mark's label, and
 *   the mock provider's request bodies.
 * - Platform prerequisites: none beyond the hermetic launcher; the short
 *   tick makes the window two minutes, so the second run, a minute after the
 *   first, turns the job failing.
 * - Shared resources: none beyond its own launch.
 */

/** The job's minute and a margin for the panel process to start. */
const TURNS_FAILING_MS = 150_000;
/** The job's next minute and a margin. */
const NEXT_RUN_MS = 90_000;

let launched: LaunchedApp | undefined;
test.afterAll(async () => {
  await launched?.close();
});

test("a background job that keeps failing gets a mark, and Ask the first mate tells the first mate once", async () => {
  test.setTimeout(TURNS_FAILING_MS + NEXT_RUN_MS + 90_000);
  const userDataDir = scratchDir("infinitary-e2e-panel-reads-failing-");
  const workspace = appPathsFor(userDataDir).personalWorkspaceDir;
  mkdirSync(workspace, { recursive: true });
  seedFailingReadPanel(workspace);
  launched = await launchApp({ userDataDir, withMockProvider: true, env: SHORT_TICK });
  const { page } = launched;
  const failingOf = () =>
    page.evaluate(() =>
      window.infinitary.plugins.personal
        .list()
        .then((s) => s.extensions.find((e) => e.id === "growth")?.failing ?? []),
    );
  const told = (opening: string) =>
    (launched?.mockProvider?.requestBodies() ?? []).filter(
      (body) => body.includes(opening) && body.includes("(id growth)"),
    ).length;

  await test.step("a single failed run draws nothing", async () => {
    await expect(panelBody(page, "growth").locator('[data-fixture="growth"]')).toBeVisible({
      timeout: 30_000,
    });
    expect(await failingOf()).toEqual([]);
    await expect(panelStatusMark(page, "growth")).toHaveCount(0);
  });

  await test.step("the second failed run turns it failing, and the first mate hears it", async () => {
    await expect.poll(failingOf, { timeout: TURNS_FAILING_MS }).toEqual([
      expect.objectContaining({
        read: { kind: "background", task: "refresh" },
        answer: FAILING_READ_ANSWER,
        asked: false,
      }),
    ]);
    const mark = panelStatusMark(page, "growth");
    await expect(mark).toHaveAttribute("aria-label", /Background reads failing since/);
    await expect
      .poll(() => told(PANEL_READS_FAILING_OPENING), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // The panel still draws what it last read.
    await expect(panelBody(page, "growth").locator('[data-fixture="growth"]')).toBeVisible();
  });

  await test.step("the details name the job and its answer, and Ask the first mate tells it once", async () => {
    const section = (await openPanelStatus(page, "growth")).locator(
      '[data-panel-status-section="failing"]',
    );
    await expect(section).toContainText(FAILING_HEADING);
    await expect(section).toContainText("refresh");
    await expect(section.locator("[data-panel-failing-answer]")).toHaveText(FAILING_READ_ANSWER);
    await pressKey(section.getByRole("button", { name: FAILING_ASK, exact: true }), "Enter");
    await expect(section.locator("[data-panel-failing-asked]")).toHaveText(FAILING_LOOKING);
    await expect.poll(failingOf).toEqual([expect.objectContaining({ asked: true })]);
    await expect
      .poll(() => told(PANEL_READS_ASKED_OPENING), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // A second ask while the first stands tells no one.
    expect(
      await page.evaluate(() => window.infinitary.plugins.personal.askFirstmate("growth")),
    ).toBe(false);
  });

  await test.step("the first run that works clears the row and the mark", async () => {
    expect(
      await page.evaluate(() => window.infinitary.plugins.invoke("growth", "raise-limit", null)),
    ).toEqual({ ok: true, result: true });
    await expect.poll(failingOf, { timeout: NEXT_RUN_MS }).toEqual([]);
    await expect(panelStatusMark(page, "growth")).toHaveCount(0);
    await expect(panelStatusDetails(page, "growth")).toHaveCount(0);
  });
});
