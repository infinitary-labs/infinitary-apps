import { expect, type Page, test } from "@playwright/test";
import { seedMockModelCatalog } from "./accountFixtures";
import { endCommands, run, runEnv } from "./commandRun";
import { keyWords } from "./desktop";
import { type LaunchedApp, launchApp } from "./launch";
import { mockModelsJson } from "./mockModels";
import { startMockProvider } from "./mockProvider";
import { windowShot } from "./pictures";
import { promptInput } from "./prompt";
import { KEYBOARD_KEYS_ASK, keyboardKeysRead } from "./scenarios/keyboardKeysRead";
import {
  commandSearch,
  endRecording,
  keyboardSettings,
  pressKey,
  pressWindowKey,
  startRecording,
  typeInto,
} from "./windowKeys";

/**
 * The first mate reads the keys Keyboard settings shows (INF-5326's plan,
 * piece 3, and the captain's choice on its review: "Match Keyboard Settings
 * when available; label saved keys otherwise"; docs/keyboard.md, "The
 * installed map").
 *
 * Promised result: a person moves command search's key to the Tasks
 * panel's Find in Keyboard settings; the first mate's `keyboard.keys` read
 * then gives both commands the keys their rows show, as installed. Started
 * as a run over the same data folder, with no main window of its own, the
 * first mate reads what was saved instead and says so: no panel's command,
 * and command search changed, without the key that moved.
 * Data: a throwaway data folder and home, and the mock provider, whose
 * scripted first mate calls the read and hands the test its answer.
 * Completion: each read's answer, compared with the rows Keyboard settings
 * draws. Platform: any desktop; the run draws on its own screen on Linux.
 * Shared resources: none; the run and the window are launches of the built
 * app in the throwaway folder.
 */

test.afterEach(endCommands);

const FIND = "panel:now/board-find";
const SEARCH = "commands.search";

type Command = { id: string; keys: string[]; changed: boolean };
type KeysAnswer = { source: string; commands: Command[] };

const byId = (answer: KeysAnswer, id: string) =>
  answer.commands.find((command) => command.id === id);

/** Opens Keyboard settings the keyboard's way: command search, then its row. */
async function openKeyboardSettings(app: LaunchedApp["app"], page: Page): Promise<void> {
  await pressWindowKey(app, "k", ["meta"]);
  const search = commandSearch(page);
  await search.field.fill("keyboard");
  await expect(search.row("settings.keyboard")).toBeVisible();
  await pressWindowKey(app, "Enter");
  await expect(search.dialog).toBeHidden();
  await expect(keyboardSettings(page).search).toBeFocused();
}

/** Asks the first mate in `page`'s main message, and returns the read's answer once it came. */
async function askForKeys(page: Page, answers: string[]): Promise<KeysAnswer> {
  const before = answers.length;
  const input = promptInput(page);
  await typeInto(input, KEYBOARD_KEYS_ASK);
  await pressKey(input, "Enter");
  await expect.poll(() => answers.length, { timeout: 60_000 }).toBeGreaterThan(before);
  const answer = JSON.parse(answers[before] ?? "{}");
  expect(answer.read).toBe("keyboard.keys");
  return answer.value as KeysAnswer;
}

test("the first mate reads the keys Keyboard settings shows, and the saved keys with no main window", async () => {
  test.setTimeout(240_000);
  const moved = keyWords({ key: "k", meta: true });
  const answers: string[] = [];
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [keyboardKeysRead((result) => answers.push(result))],
  });
  const { userDataDir } = launched;
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);
    const shown = async (id: string) => keyboard.keys(id).locator("kbd").allTextContents();

    await test.step("moves command search's key to the Tasks panel's Find", async () => {
      await openKeyboardSettings(app, page);
      await startRecording(page, FIND);
      await pressWindowKey(app, "k", ["meta"]);
      await expect(keyboard.verdict(FIND)).toHaveAttribute("data-keyboard-verdict", "moves");
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys(FIND).locator("kbd")).toHaveText([moved]);
      expect(await shown(SEARCH)).not.toContain(moved);
      await windowShot(page, test.info().outputPath("evidence", "keyboard-settings.png"));
    });

    await test.step("the first mate reads the keys the rows show, as installed", async () => {
      const rows = { find: await shown(FIND), search: await shown(SEARCH) };
      await pressWindowKey(app, "Escape");
      await expect(keyboard.section).toBeHidden();
      const answer = await askForKeys(page, answers);
      await test.info().attach("installed-keys.json", {
        body: JSON.stringify({ rows, answer }, null, 2),
        contentType: "application/json",
      });
      expect(answer.source).toBe("installed");
      expect(byId(answer, FIND)).toMatchObject({ keys: rows.find, changed: true });
      expect(byId(answer, SEARCH)).toMatchObject({ keys: rows.search, changed: true });
    });
  } finally {
    await launched.close();
  }

  await test.step("a run with no main window reads the saved keys, and says so", async () => {
    const provider = await startMockProvider({
      scenarios: [keyboardKeysRead((result) => answers.push(result))],
    });
    try {
      seedMockModelCatalog(userDataDir, mockModelsJson(provider.port));
      const ran = run(await runEnv(userDataDir));
      try {
        await ran.started();
        // A window opened beside the run is the run's view: the first mate,
        // and its keys read, are the run's, which has no main window.
        const beside = await launchApp({ userDataDir });
        try {
          const answer = await askForKeys(beside.page, answers);
          await test.info().attach("saved-keys.json", {
            body: JSON.stringify(answer, null, 2),
            contentType: "application/json",
          });
          expect(answer.source).toBe("saved");
          expect(byId(answer, FIND)).toBeUndefined();
          expect(byId(answer, SEARCH)?.changed).toBe(true);
          expect(byId(answer, SEARCH)?.keys).not.toContain(moved);
        } finally {
          await beside.close();
        }
      } finally {
        // The run stops as its starter stops it, and ends before the provider closes.
        ran.child.kill("SIGTERM");
        await ran.exited;
      }
    } finally {
      await provider.close();
    }
  });
});
