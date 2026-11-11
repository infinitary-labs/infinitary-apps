import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { runbookManifestSchema } from "../../src/shared/runbooks";
import { RUNBOOK_VIEW_NOTE } from "../../src/shared/runbookWords";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { servedInstructions } from "./providerRequest";
import { feedLine } from "./rails";
import { settingRow } from "./settings";
import { pressKey, runFromSearch } from "./windowKeys";

// Intent: INF-1177's accepted six runbooks, individually switchable through Settings or the first mate.
// A runbook that ships as an experiment starts off until its switch turns it on (the approved Advanced
// architecture plan).
// Real bundle manifests, isolated HOME/userData, local scripted model, persisted IPC values and attributed feed lines.
const root = join(process.cwd(), "resources/runbooks");
const books = readdirSync(root).map((id) =>
  runbookManifestSchema.parse(JSON.parse(readFileSync(join(root, id, "runbook.json"), "utf8"))),
);
const workflows = books.find((book) => book.id === "sequences");
if (!workflows) throw new Error("The built-in workflows runbook is missing.");
const programs = books.find((book) => book.id === "programs");
if (!programs) throw new Error("The built-in programs runbook is missing.");

/** The heading a runbook's first mate guide opens with, as the bundle serves it. */
function guideHeading(book: (typeof books)[number]): string {
  if (!book.firstmate) throw new Error(`The ${book.id} runbook has no first mate guide.`);
  const [heading] = readFileSync(join(root, book.id, book.firstmate), "utf8").split("\n", 1);
  if (!heading) throw new Error(`The ${book.id} runbook's first mate guide is empty.`);
  return heading;
}

test("runbook switches persist and the first mate uses the same named switch", async () => {
  let at = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = at;
  try {
    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Runbooks", exact: true }).click();
    for (const book of books)
      await expect(
        settingRow(at.page, `runbook-${book.id}`).getByRole("switch", {
          name: book.name,
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", book.startsOff ? "false" : "true");
    const control = settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch");
    await pressKey(control, "Space");
    await expect(control).toHaveAttribute("aria-checked", "false");
    await at.page.keyboard.press("Escape");
    await expect(
      feedLine(at.page, ACTIONS.runbook.done({ name: workflows.name, enabled: false })),
    ).toBeVisible();
    const off = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    const startsOff = books.filter((book) => book.startsOff).map((book) => book.id);
    expect(startsOff).toEqual(["architecture"]);
    expect(
      off
        .filter((book) => !book.enabled)
        .map((book) => book.id)
        .sort(),
    ).toEqual([workflows.id, ...startsOff].sort());
    await at.close();
    at = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    const persisted = await at.page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(persisted.find((book) => book.id === workflows.id)?.enabled).toBe(false);
    // Each ask ends on the first mate's answer, never on the character looking idle:
    // after a relaunch the character settles back to idle while the turn still waits
    // for its session, before any served request this spec reads exists.
    const ask = () =>
      askFirstmate(
        at.page,
        APP_CATALOG_PROMPT_MARKER +
          JSON.stringify({ action: "runbook", value: { id: workflows.id, enabled: true } }),
      );
    await ask();
    await expect(
      feedLine(at.page, ACTIONS.runbook.done({ name: workflows.name, enabled: true })),
    ).toBeVisible();
    const offPrompt = (at.mockProvider?.requestBodies() ?? [])
      .map(servedInstructions)
      .find((text) => text.includes(guideHeading(programs)));
    expect(offPrompt).toBeDefined();
    expect(offPrompt).not.toContain(guideHeading(workflows));
    await ask();
    expect(
      (at.mockProvider?.requestBodies() ?? []).some((body) =>
        servedInstructions(body).includes(guideHeading(workflows)),
      ),
    ).toBe(true);

    await at.page.getByRole("button", { name: "Settings", exact: true }).click();
    await at.page.getByRole("tab", { name: "Runbooks", exact: true }).click();
    await expect(
      settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    await at.close();
  }
});

// Intent: INF-1981/INF-1988. The captain's keyboard opens personal folders and a read-only
// temporary built-in, never the signed bundle. Real bundle and host IPC; system opening is
// recorded instead of opening Finder. No accounts or shared files are used.
test("open Runbooks and its folders by keyboard without exposing built-ins for editing", async () => {
  const temp = scratchDir("inf-runbook-view-journey-");
  const at = await launchApp({ withMockProvider: true });
  const opened: string[] = [];
  try {
    await at.app.evaluate(({ app, shell }, temp) => {
      app.setPath("temp", temp);
      const paths: string[] = [];
      (globalThis as { __runbookPaths?: string[] }).__runbookPaths = paths;
      shell.openPath = async (path: string) => {
        paths.push(path);
        return "";
      };
    }, temp);
    const paths = () =>
      at.app.evaluate(() => (globalThis as { __runbookPaths?: string[] }).__runbookPaths ?? []);
    const unfinished = join(at.userDataDir, "fleet/personal/runbooks/unfinished");
    mkdirSync(unfinished, { recursive: true });
    await runFromSearch(at.app, at.page, "settings.runbooks");
    await expect(at.page.getByRole("tab", { name: "Runbooks", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const unreadable = (
      await at.page.evaluate(() => window.infinitary.settings.getRunbooks())
    ).find((book) => book.path === unfinished);
    if (!unreadable?.error)
      throw new Error("The unfinished runbook must explain what needs repair.");
    const broken = settingRow(at.page, `runbook-${unreadable.id}`);
    await expect(broken.getByRole("switch")).toHaveCount(0);
    await expect(broken.getByRole("alert")).toHaveText(unreadable.error);
    const button = settingRow(at.page, `runbook-${workflows.id}`).getByRole("button");
    await expect(button).toHaveAccessibleDescription(RUNBOOK_VIEW_NOTE);
    await pressKey(settingRow(at.page, `runbook-${workflows.id}`).getByRole("switch"), "Shift+Tab");
    await expect(at.page.locator("[data-icon-label]")).toBeVisible();
    await expect(at.page.locator("[data-icon-label]")).toHaveText(RUNBOOK_VIEW_NOTE);
    await pressKey(button, "Enter");
    await expect.poll(paths).toHaveLength(1);
    opened.push(...(await paths()));
    const view = opened[0];
    if (!view) throw new Error("View must open a temporary folder.");
    expect(view.startsWith(temp)).toBe(true);
    expect(lstatSync(view).mode & 0o222).toBe(0);
    expect(readFileSync(join(view, workflows.firstmate ?? ""), "utf8")).toBe(
      readFileSync(join(root, workflows.id, workflows.firstmate ?? ""), "utf8"),
    );
    // The main-process recorder sees the request before React clears the pending state.
    // Wait for the operation's control, not just request arrival, before moving focus.
    await expect(button).toBeEnabled();
    const folder = settingRow(at.page, "runbooks-folder").getByRole("button");
    await pressKey(folder, "Enter");
    await expect.poll(paths).toHaveLength(2);
    expect((await paths())[1]).toBe(join(at.userDataDir, "fleet/personal/runbooks"));
    expect(existsSync(join(at.userDataDir, "fleet/personal/runbooks"))).toBe(true);
    await expect(folder).toBeEnabled();
    await runFromSearch(at.app, at.page, "runbooks.open-folder");
    await expect.poll(paths).toHaveLength(3);
    expect((await paths())[2]).toBe(join(at.userDataDir, "fleet/personal/runbooks"));
  } finally {
    // The files remain read-only for the whole journey; restore only to dispose the fixture.
    const writable = (path: string) => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(temp);
    await at.close();
  }
});
