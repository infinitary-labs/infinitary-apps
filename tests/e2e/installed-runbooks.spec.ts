import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  runbookAddedLine,
  runbookConsentTitle,
  runbookRemovedLine,
} from "../../src/core/runbooks/words";
import { ACTIONS } from "../../src/shared/actions";
import * as m from "../../src/shared/i18n/messages.generated";
import { runbookManifestSchema } from "../../src/shared/runbooks";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody, panelBody } from "./frames";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { servedInstructions } from "./providerRequest";
import { feedLine } from "./rails";
import {
  ADD_RUNBOOK_PROMPT_MARKER,
  installRunbook,
  REMOVE_RUNBOOK_PROMPT_MARKER,
} from "./scenarios/installRunbook";
import { settingRow } from "./settings";
import { expectNoCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

// Intent: INF-1177 piece 3's accepted install-and-share journey. Real bundle guidance,
// isolated HOME/userData, scripted first mate, persisted switches and served prompt.
// Completion: only the captain's keyboard consent installs; one line names the replacement;
// the runbook survives restart and removal withdraws its guidance. No external account.
// The runbook also lists a panel (the real panel-cards fixture): its add card names it, and the
// same click shows it on the rail under the replaced built-in's id until removal takes it away
// (the captain's choice that an added runbook's panels are agreed on its own add card).
test("add a runbook only on consent, keep its replacement and remove it by talking", async () => {
  const source = join(scratchDir("inf-runbook-source-"), "studio-workflows");
  mkdirSync(source, { recursive: true });
  const base = join(process.cwd(), "resources/runbooks");
  const workflows = runbookManifestSchema.parse(
    JSON.parse(readFileSync(join(base, "sequences/runbook.json"), "utf8")),
  );
  const manifest = runbookManifestSchema.parse({
    ...workflows,
    id: "studio-workflows",
    name: "Studio workflows",
    author: "Studio",
    version: "1.0.0",
    replaces: workflows.id,
    skills: "skills",
    panels: ["reading"],
  });
  const panelId = `${workflows.id}-reading`;
  cpSync(join(process.cwd(), "tests/fixtures/panel-cards/reading-list"), join(source, "reading"), {
    recursive: true,
  });
  writeFileSync(join(source, "runbook.json"), JSON.stringify(manifest));
  const guide = readFileSync(join(base, "sequences", workflows.firstmate ?? ""), "utf8").replace(
    "# Common workflows",
    "# Studio workflows",
  );
  writeFileSync(join(source, manifest.firstmate ?? ""), guide);
  mkdirSync(join(source, "skills/lessons"), { recursive: true });
  for (const file of ["SKILL.md", "parts"])
    cpSync(join(base, "lessons/skills/lessons", file), join(source, "skills/lessons", file), {
      recursive: true,
    });
  let at = await launchApp({ withMockProvider: true, scenarios: [installRunbook] });
  const { userDataDir, homeDir } = at;
  const title = runbookConsentTitle(manifest.name);
  try {
    await promptInput(at.page).fill(ADD_RUNBOOK_PROMPT_MARKER + source);
    await promptInput(at.page).press("Enter");
    await expect(shownCard(at.page, title)).toBeVisible();
    const rows = cardBody(at.page, title).locator("dl").first();
    await expect(rows.locator("dt", { hasText: m.cardConsentTurnsOff() })).toBeVisible();
    await expect(rows.locator("dd b").nth(1)).toHaveText(workflows.name);
    await expect(cardBody(at.page, title).locator("body")).toContainText(
      m.cardConsentRunbookPanels({ count: 1, here: m.placeThisComputer() }),
    );
    await expect(
      rows.locator("dt", { hasText: m.cardConsentShowsPanels({ count: 1 }) }),
    ).toBeVisible();
    await expect(rows.locator("dd b").nth(2)).toHaveText("Reading list");
    expect(
      (await at.page.evaluate(() => window.infinitary.settings.getRunbooks())).some(
        (book) => book.id === manifest.id,
      ),
    ).toBe(false);
    expect(existsSync(join(userDataDir, "plugins", manifest.id))).toBe(false);
    // Declining by keyboard leaves the built-in untouched.
    await pressKey(at.page.getByRole("button", { name: "Don't add", exact: true }), "Enter");
    await expectNoCard(at.page, title);
    await waitForFirstmateIdle(at.page);
    await promptInput(at.page).fill(ADD_RUNBOOK_PROMPT_MARKER + source);
    await promptInput(at.page).press("Enter");
    await expect(shownCard(at.page, title)).toBeVisible();
    await pressKey(at.page.getByRole("button", { name: "Add it", exact: true }), "Enter");
    const line = runbookAddedLine(manifest.name, manifest.author ?? "", workflows.name);
    await expect(feedLine(at.page, line)).toBeVisible();
    await expectNoCard(at.page, title);
    expect(existsSync(join(userDataDir, "plugins", manifest.id, manifest.firstmate ?? ""))).toBe(
      true,
    );
    // The click that added the runbook agreed to its panel, which shows under the runbook's name.
    await expect(panelBody(at.page, panelId).locator("[data-fixture]")).toBeVisible();
    expect(
      (await at.page.evaluate(() => window.infinitary.plugins.personal.list())).extensions.map(
        (extension) => [extension.id, extension.runbook, extension.error],
      ),
    ).toEqual([[panelId, manifest.id, null]]);
    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Runbooks", exact: true }).click();
    await expect(settingRow(at.page, `runbook-${manifest.id}`).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "false");
    // The built-in remains available, and re-enabling its replacement switches it off in one named line.
    await pressKey(settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"), "Space");
    await expect(
      settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
    const added = settingRow(at.page, `runbook-${manifest.id}`).getByRole("switch");
    await pressKey(added, "Space");
    await expect(added).toHaveAttribute("aria-checked", "false");
    await pressKey(added, "Space");
    await expect(added).toHaveAttribute("aria-checked", "true");
    await expect(
      settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "false");
    await at.page.keyboard.press("Escape");
    await expect(
      feedLine(
        at.page,
        ACTIONS.runbook.done({ name: manifest.name, enabled: true, replacement: workflows.name }),
      ),
    ).toBeVisible();
    await at.close();
    at = await launchApp({
      withMockProvider: true,
      scenarios: [installRunbook],
      userDataDir,
      homeDir,
    });
    const persisted = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(persisted.find((book) => book.id === manifest.id)?.enabled).toBe(true);
    expect(persisted.find((book) => book.id === workflows.id)?.enabled).toBe(false);
    await promptInput(at.page).fill(REMOVE_RUNBOOK_PROMPT_MARKER + manifest.id);
    await promptInput(at.page).press("Enter");
    await expect(
      feedLine(at.page, runbookRemovedLine(manifest.name, manifest.author ?? "")),
    ).toBeVisible();
    await waitForFirstmateIdle(at.page);
    const served = (at.mockProvider?.requestBodies() ?? []).map(servedInstructions);
    expect(served.some((text) => text.includes(guide.trim()))).toBe(true);
    expect(served.some((text) => text.includes("# Common workflows"))).toBe(false);
    expect(
      (await at.page.evaluate(() => window.infinitary.settings.getRunbooks())).some(
        (book) => book.id === manifest.id,
      ),
    ).toBe(false);
    expect(existsSync(join(userDataDir, "plugins", manifest.id))).toBe(false);
    await expect(at.page.locator(`[data-side-panel="${panelId}"]`)).toHaveCount(0);
  } finally {
    await at.close();
  }
});
