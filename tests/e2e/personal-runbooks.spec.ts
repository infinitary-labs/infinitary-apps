import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { runbookManifestSchema } from "../../src/shared/runbooks";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { APP_CATALOG_PROMPT_MARKER, servedInstructions } from "./mockProvider";
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { activityFrame, dockRegion, feedLine } from "./rails";
import { settingRow } from "./settings";
import { pressKey } from "./windowKeys";

// Intent: INF-1177 piece 4. Real bundled guidance, the asked catalog action, isolated
// personal files, keyboard switches and saved state. No accounts or shared resources.
// Completion: editing the copy reaches the prompt, enabling leaves one replacement line,
// restart preserves it, and the captain can restore the untouched built-in.
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument before testInfo.
test("copy a built-in, edit it in place, replace it and restore it", async ({}, testInfo) => {
  const builtin = runbookManifestSchema.parse(
    JSON.parse(
      readFileSync(join(process.cwd(), "resources/runbooks/sequences/runbook.json"), "utf8"),
    ),
  );
  const copy = { id: "my-workflows", name: "My workflows" };
  let at = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = at;
  const ask = async (action: string, value: Record<string, unknown>) => {
    await promptInput(at.page).fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
    await promptInput(at.page).press("Enter");
    await waitForFirstmateIdle(at.page);
  };
  try {
    await ask("runbook-copy", { id: builtin.id, copyId: copy.id, name: copy.name });
    await expect(
      feedLine(at.page, ACTIONS["runbook-copy"].done({ source: builtin.name, name: copy.name })),
    ).toBeVisible();
    const entries = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    const personal = entries.find((book) => book.id === copy.id);
    expect(personal?.enabled).toBe(false);
    expect(personal?.path).toBe(join(userDataDir, "fleet/personal/runbooks", copy.id));
    if (!personal?.path) throw new Error("The copy must return its editable folder.");
    const manifest = runbookManifestSchema.parse(
      JSON.parse(readFileSync(join(personal.path, "runbook.json"), "utf8")),
    );
    expect(manifest.replaces).toBe(builtin.id);
    const guidePath = join(personal.path, manifest.firstmate ?? "");
    const original = readFileSync(guidePath, "utf8");
    writeFileSync(guidePath, original.replace("# Common workflows", "# My workflows"));
    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    const control = settingRow(at.page, `runbook-${copy.id}`).getByRole("switch");
    await expect(control).toHaveAttribute("aria-checked", "false");
    await pressKey(control, "Space");
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(settingRow(at.page, `runbook-${builtin.id}`).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await resizeWindow(at.app, at.page, { width: 1280, height: 900 });
    await regionShot(at.page.locator("[data-runbooks]"), testInfo.outputPath("runbooks-after.png"));
    await at.page.keyboard.press("Escape");
    const line = ACTIONS.runbook.done({
      name: copy.name,
      enabled: true,
      replacement: builtin.name,
    });
    await expect(feedLine(at.page, line)).toHaveCount(1);
    await pressKey(activityFrame(at.page).getByRole("region", { name: "Activity lines" }), "End");
    await regionShot(dockRegion(at.page, "activity"), testInfo.outputPath("replacement-line.png"));
    await at.close();
    at = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    const saved = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(saved.find((book) => book.id === copy.id)?.enabled).toBe(true);
    expect(saved.find((book) => book.id === builtin.id)?.enabled).toBe(false);
    // A harmless no-op switch ask records the actual replacement prompt at an idle boundary.
    await ask("runbook", { id: copy.id, enabled: true });
    const served = (at.mockProvider?.requestBodies() ?? []).map(servedInstructions);
    expect(served.some((text) => text.includes("# My workflows"))).toBe(true);
    expect(served.some((text) => text.includes("# Common workflows"))).toBe(false);
    await ask("runbook", { id: copy.id, enabled: false });
    await ask("runbook", { id: builtin.id, enabled: true });
    await ask("runbook", { id: builtin.id, enabled: true });
    expect(
      (at.mockProvider?.requestBodies() ?? []).some((body) =>
        servedInstructions(body).includes("# Common workflows"),
      ),
    ).toBe(true);
    expect(readFileSync(guidePath, "utf8")).toContain("# My workflows");
    const final = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(final.find((book) => book.id === copy.id)?.enabled).toBe(false);
    expect(final.find((book) => book.id === builtin.id)?.enabled).toBe(true);
  } finally {
    await at.close();
  }
});
