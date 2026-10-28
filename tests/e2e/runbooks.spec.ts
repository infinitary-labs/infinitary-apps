import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { runbookManifestSchema } from "../../src/shared/runbooks";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER, servedInstructions } from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine } from "./rails";
import { settingRow } from "./settings";
import { pressKey } from "./windowKeys";

// Intent: INF-1177's accepted six runbooks, individually switchable through Settings or the first mate.
// Real bundle manifests, isolated HOME/userData, local scripted model, persisted IPC values and attributed feed lines.
const root = join(process.cwd(), "resources/runbooks");
const books = readdirSync(root).map((id) =>
  runbookManifestSchema.parse(JSON.parse(readFileSync(join(root, id, "runbook.json"), "utf8"))),
);
const workflows = books.find((book) => book.id === "sequences");
if (!workflows) throw new Error("The built-in workflows runbook is missing.");

test("runbook switches persist and the first mate uses the same named switch", async () => {
  let at = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = at;
  try {
    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    for (const book of books)
      await expect(
        settingRow(at.page, `runbook-${book.id}`).getByRole("switch", {
          name: book.name,
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", "true");
    const control = settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch");
    await pressKey(control, "Space");
    await expect(control).toHaveAttribute("aria-checked", "false");
    await at.page.keyboard.press("Escape");
    await expect(
      feedLine(at.page, ACTIONS.runbook.done({ name: workflows.name, enabled: false })),
    ).toBeVisible();
    const off = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(off.filter((book) => !book.enabled).map((book) => book.id)).toEqual([workflows.id]);
    await at.close();
    at = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    const persisted = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(persisted.find((book) => book.id === workflows.id)?.enabled).toBe(false);
    const input = promptInput(at.page);
    await input.fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "runbook", value: { id: workflows.id, enabled: true } }),
    );
    await input.press("Enter");
    await expect(
      feedLine(at.page, ACTIONS.runbook.done({ name: workflows.name, enabled: true })),
    ).toBeVisible();
    await waitForFirstmateIdle(at.page);
    const offPrompt = (at.mockProvider?.requestBodies() ?? [])
      .map(servedInstructions)
      .find((text) => text.includes("# Programs"));
    expect(offPrompt).toBeDefined();
    expect(offPrompt).not.toContain("# Common workflows");
    await input.fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "runbook", value: { id: workflows.id, enabled: true } }),
    );
    await input.press("Enter");
    await waitForFirstmateIdle(at.page);
    expect(
      (at.mockProvider?.requestBodies() ?? []).some((body) =>
        servedInstructions(body).includes("# Common workflows"),
      ),
    ).toBe(true);

    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    await expect(
      settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    await at.close();
  }
});
