import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CROWDED_PLANES } from "../../src/renderer/src/character/crew/orbitalPlanes";
import { modelDisplayName } from "../../src/shared/modelDisplayName";
import {
  crewModelName,
  crewModelNameLayout,
  crewModelNames,
  crewPlaneCounts,
  crewSummary,
} from "./crew";
import { crewRoster } from "./crewRoster";
import { type LaunchedApp, launchApp } from "./launch";
import { CANCEL_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, hideRecord, pressRow, recordCard, taskFact } from "./rails";
import { setThemeViaSettings } from "./theme";
import { focusOn } from "./windowKeys";

const roster = (count: number) => crewRoster(count);

test("crew model names default on, toggle immediately and survive restart independently of window storage", async () => {
  const fixture = await roster(6);
  let app: LaunchedApp = await launchApp({ ...fixture, withMockProvider: true });
  const expected: [string, string] = [
    modelDisplayName(fixture.models[0]),
    modelDisplayName(fixture.models[1]),
  ];
  try {
    const { page } = app;
    await expect(crewModelNames(page)).toHaveCount(6);
    await expect(crewModelName(page, "label-crew-0")).toHaveText(expected[0]);
    await expect(crewModelName(page, "label-crew-1")).toHaveText(expected[1]);
    const view = await page.evaluate(() => window.infinitary.models.slots());
    const rows = [...view.models, ...view.byName];
    for (const model of fixture.models)
      expect(
        rows.find((row) => row.provider === model.provider && row.id === model.id)?.label,
      ).toBe(model.label);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    expect(board.tasks.find((task) => task.id === "label-crew-0")?.model).toBe(
      `${fixture.models[0].provider}/${fixture.models[0].id}`,
    );
    const evidence = {
      catalog: fixture.models.map((model) =>
        rows.find((row) => row.provider === model.provider && row.id === model.id),
      ),
      assignments: board.tasks.map(({ id, model }) => ({ id, model })),
      visible: await crewModelNames(page).allTextContents(),
      hiddenAfterRestart: false,
      shownAgain: false,
      hiddenBehindRecordAndRestored: false,
    };
    await page.emulateMedia({ reducedMotion: "reduce" });
    mkdirSync(test.info().outputPath("crew-model-labels"), { recursive: true });
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("crew-model-labels/default-dark.png"),
    });
    // Pointing at a name is pointing at its crewmate: its summary carries
    // the complete model name, and leaving it or Esc closes it.
    await crewModelName(page, "label-crew-1").hover();
    await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", "label-crew-1");
    await expect(taskFact(crewSummary(page), "model")).toHaveText(expected[1]);
    await page.mouse.move(12, 12);
    await expect(crewSummary(page)).toHaveCount(0);
    await crewModelName(page, "label-crew-1").hover();
    await expect(crewSummary(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(crewSummary(page)).toHaveCount(0);
    // Current main uses records in the card stack: their hidden/inert frame
    // must also hide names and inspection, then restore the single orbit.
    const task = board.tasks.find((task) => task.id === "label-crew-0");
    if (!task) throw new Error("The seeded task record is missing");
    await focusOn(crewModelName(page, "label-crew-1"));
    await expect(crewSummary(page)).toBeVisible();
    await expandDock(page, "now");
    await pressRow(page, task.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await expectRecordBody(page);
    await expect(crewModelNames(page)).toHaveCount(0);
    await expect(crewSummary(page)).toHaveCount(0);
    await hideRecord(page).click();
    await expect(crewModelNames(page)).toHaveCount(6);
    evidence.hiddenBehindRecordAndRestored = true;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const toggle = page.locator('[data-setting="crew-model-names"]').getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
            .showCrewModelNames,
      )
      .toBe(false);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("crew-model-labels/setting-off.png"),
    });
    await page.keyboard.press("Escape");
    await expect(crewModelNames(page)).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("crew-model-labels/hidden.png"),
    });
    await setThemeViaSettings(page, "light");
    expect(
      (await page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
        .showCrewModelNames,
    ).toBe(false);
    await app.close();
    for (const name of ["Local Storage", "Session Storage", "IndexedDB", "databases", "WebStorage"])
      rmSync(join(fixture.userDataDir, name), { recursive: true, force: true });
    app = await launchApp({ ...fixture, withMockProvider: true });
    // Hidden names must not remove the seeded crew. Formation tuning is owned
    // by the orbit tests, not by this restart/persistence journey.
    await expect
      .poll(async () => (await crewPlaneCounts(app.page)).reduce((sum, count) => sum + count, 0))
      .toBe(6);
    await expect(crewModelNames(app.page)).toHaveCount(0);
    expect(
      (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
        .showCrewModelNames,
    ).toBe(false);
    evidence.hiddenAfterRestart =
      (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
        .showCrewModelNames === false;
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const restored = app.page.locator('[data-setting="crew-model-names"]').getByRole("switch");
    await expect(restored).toHaveAttribute("aria-checked", "false");
    await restored.click();
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
            .showCrewModelNames,
      )
      .toBe(true);
    await app.page.keyboard.press("Escape");
    await expect(crewModelNames(app.page)).toHaveCount(6);
    evidence.shownAgain =
      (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
        .showCrewModelNames === true;
    writeFileSync(
      test.info().outputPath("crew-model-labels/behavior.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await app.page.emulateMedia({ reducedMotion: "reduce" });
    await crewModelNameLayout(app.page);
    await app.page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("crew-model-labels/restored-light.png"),
    });
  } finally {
    await app.close();
  }
});

test("names switched off stay off while the crew grows to a second orbit and back to one", async () => {
  const count = CROWDED_PLANES[0].capacity;
  const fixture = await roster(count);
  // Only the local mock may serve new turns. The existing isolated idle tasks
  // keep their assigned identities even when their catalog is unavailable.
  rmSync(join(fixture.userDataDir, "accounts"), { recursive: true, force: true });
  const app = await launchApp({ ...fixture, withMockProvider: true });
  const title = "Second orbit example";
  const send = async (text: string) => {
    const input = promptInput(app.page);
    await input.fill(text);
    await input.press("Enter");
  };
  const onStage = async () =>
    (await crewPlaneCounts(app.page)).reduce((sum, value) => sum + value, 0);
  const switchNames = async () => {
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await app.page.locator('[data-setting="crew-model-names"]').getByRole("switch").click();
    await app.page.keyboard.press("Escape");
  };
  const showNames = async () =>
    (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
      .showCrewModelNames;
  try {
    const { page } = app;
    await expect(crewModelNames(page)).toHaveCount(count);
    await switchNames();
    await expect.poll(showNames).toBe(false);
    await expect(crewModelNames(page)).toHaveCount(0);
    // One more crewmate than the first orbit holds, then back.
    await send(`${SPAWN_PROMPT_MARKER} ${title}`);
    await expect.poll(onStage, { timeout: 30_000 }).toBe(count + 1);
    await send(`${CANCEL_PROMPT_MARKER}${title}`);
    await expect.poll(onStage, { timeout: 30_000 }).toBe(count);
    // The captain's off survived both changes.
    await expect(crewModelNames(page)).toHaveCount(0);
    expect(await showNames()).toBe(false);
    await switchNames();
    await expect(crewModelNames(page)).toHaveCount(count);
  } finally {
    await app.close();
  }
});
