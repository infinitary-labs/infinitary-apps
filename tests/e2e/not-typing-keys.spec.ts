import { createServer } from "node:http";
import { expect, type Locator, test } from "@playwright/test";
import { bindingWarning } from "../../src/shared/keymap";
import { FRAME_BRIDGE_VERSION } from "../../src/shared/plugins/bridge";
import { TAKE_CONTROL_LABEL } from "../../src/shared/taskBrowser";
import { claimedPort } from "../helpers/claimedPort";
import { crewComposer, crewmateView } from "./crewmateTab";
import { keyWords } from "./desktop";
import { cardBody, frameGesturesDecided } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, nowRow, pressRow } from "./rails";
import {
  NOT_TYPING_MARKER,
  NOT_TYPING_TITLES,
  notTypingKeys,
  RISKY_KEYS_MARKER,
  RISKY_KEYS_TITLES,
  riskyKeys,
} from "./scenarios/notTypingKeys";
import { cardReply, pager, showCard, shownCard, shownEntry, stagePrepared } from "./stack";
import { browserView, clickOnPage, closeSite, pageSays, stopTaskBrowsers } from "./taskBrowser";
import {
  chooseKeyPlace,
  endRecording,
  focusOn,
  keyboardSettings,
  pressKey,
  pressWindowKey,
  runFromSearch,
  startRecording,
  typeInto,
} from "./windowKeys";

/**
 * Accepted layers plan, piece 1: a recorded bare key acts outside typing,
 * never inside editing controls or the controlled task browser. Real app,
 * provider scenarios, card frames, task rows and a disposable loopback site;
 * completion is the resulting screen, focused control and retained draft.
 * No sign-in, personal data, native Mac prerequisite or shared resource.
 */
test("a bare key works outside typing and cannot borrow a field, another frame or an unseen press", async () => {
  test.setTimeout(180_000);
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Project note</title><label>Note <input id="note"></label>');
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => site.listen(port, "127.0.0.1", resolve));
  const launched = await launchApp({ withMockProvider: true, scenarios: [notTypingKeys] }).catch(
    async (error: unknown) => {
      await closeSite(site);
      throw error;
    },
  );
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const prompt = promptInput(page);
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const title = `${NOT_TYPING_MARKER}${url}`;
  const home = () => runFromSearch(app, page, "focus.main-message");
  const settings = () => page.getByRole("tab", { name: "General", exact: true });
  // Electron injects a window key into the shell, not an out-of-process frame.
  // Witness it through the native owner, then deliver it to the focused frame through its key driver.
  const frameKey = async (target: Locator, key: string) => {
    await focusOn(target);
    await pressWindowKey(app, key);
    await pressKey(target, key);
  };
  const keepsLetter = async (field: Locator) => {
    await field.fill("");
    await focusOn(field);
    await pressWindowKey(app, "s");
    await typeInto(field, "s");
    await expect(field).toHaveValue("s");
    await expect(settings()).toHaveCount(0);
  };
  try {
    await test.step("Legacy keeps Escape in the message", async () => {
      await focusOn(prompt);
      await pressWindowKey(app, "Escape");
      await expect(prompt).toBeFocused();
      await runFromSearch(app, page, "settings.keyboard");
    });

    await test.step("records a bare key; a modified key's place changes through its keyboard control", async () => {
      await startRecording(page, "settings.open");
      await pressWindowKey(app, "s");
      await expect(keyboard.verdict("settings.open")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      const place = keyboard.row("regions.next").getByRole("combobox");
      await chooseKeyPlace(place, "not-typing");
      await expect(place).toHaveValue("not-typing");
      await chooseKeyPlace(place, "anywhere");
      await expect(place).toHaveValue("anywhere");
      await home();
      await keepsLetter(prompt);
      await pressWindowKey(app, "Escape");
      await expect(prompt).not.toBeFocused();
      await pressWindowKey(app, "s");
      await expect(settings()).toBeVisible();
      await home();
      await expect(prompt).toHaveValue("s");
    });

    await test.step("the recorded key never steals search words or any card field", async () => {
      await prompt.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await pressKey(prompt, "Enter");
      await expect(pager(page, 2)).toBeVisible({ timeout: 60_000 });
      for (const cardTitle of Object.values(NOT_TYPING_TITLES)) {
        await showCard(page, cardTitle);
        await stagePrepared(page);
        const body = cardBody(page, cardTitle);
        await keepsLetter(body.getByRole("textbox", { name: "Note", exact: true }));
        await keepsLetter(body.getByRole("textbox", { name: "Find a word", exact: true }));
        const draft = body.getByRole("textbox", { name: "Draft", exact: true });
        await focusOn(draft);
        await pressWindowKey(app, "s");
        await typeInto(draft, "s");
        await expect(draft).toContainText("s");
        await expect(settings()).toHaveCount(0);
        await keepsLetter(cardReply(page).field);
        await pressWindowKey(app, "Escape");
        await expect(shownEntry(page)).toBeFocused();
        await frameKey(body.getByRole("region", { name: "Note text" }), "s");
        await expect(settings()).toBeVisible();
        await home();
        await showCard(page, cardTitle);
        await stagePrepared(page);
        await frameKey(body.getByRole("radio", { name: "Ready for review" }), "s");
        await expect(settings()).toBeVisible();
        await home();
      }
      await stagePrepared(page);
      await runFromSearch(app, page, "panel:now/find");
      await keepsLetter(nowFrame(page).locator("[data-now-query]"));
      await home();
    });

    await test.step("a card's used key stays local; unfocused and unwitnessed offers do nothing", async () => {
      await showCard(page, NOT_TYPING_TITLES.served);
      await stagePrepared(page);
      const body = cardBody(page, NOT_TYPING_TITLES.served);
      const local = body.getByRole("button", { name: "Keep reading", exact: true });
      await frameKey(local, "s");
      await expect(local).toHaveAttribute("data-used", "true");
      await expect(settings()).toHaveCount(0);
      await page.evaluate(() => {
        window.addEventListener("message", (event) => {
          if (event.data?.type === "key")
            (window as unknown as { keyDocument: string }).keyDocument = event.data.document;
        });
      });
      const reader = body.getByRole("region", { name: "Note text" });
      await pressKey(reader, "x");
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { keyDocument?: string }).keyDocument),
        )
        .toBeTruthy();
      const documentId = await page.evaluate(
        () => (window as unknown as { keyDocument: string }).keyDocument,
      );
      const forge = () =>
        reader.evaluate((_node, message) => parent.postMessage(message, "*"), {
          fm: FRAME_BRIDGE_VERSION,
          type: "key",
          document: documentId,
          press: {
            key: "s",
            code: "KeyS",
            meta: false,
            ctrl: false,
            alt: false,
            shift: false,
            composing: false,
            repeat: false,
          },
        });
      await focusOn(prompt);
      await pressWindowKey(app, "s");
      await forge();
      await frameGesturesDecided(page);
      await expect(settings()).toHaveCount(0);
      await focusOn(reader);
      await forge();
      await frameGesturesDecided(page);
      await expect(settings()).toHaveCount(0);
      await frameKey(reader, "s");
      await expect(settings()).toBeVisible();
      await home();
    });

    await test.step("the task list runs the key, while the Crewmate prompt and controlled browser keep it", async () => {
      const task = await page.evaluate(
        async (wanted) =>
          (await window.infinitary.tasks.board()).tasks.find((row) => row.title === wanted),
        title,
      );
      if (!task) throw new Error("The scenario's task is missing");
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await stagePrepared(page);
      await frameKey(nowRow(page, task.key), "s");
      await expect(settings()).toBeVisible();
      await home();
      await showCard(page, NOT_TYPING_TITLES.served);
      await runFromSearch(app, page, "cards.show-crewmate");
      await keepsLetter(crewComposer(crewmateView(page, task.id)));
      await runFromSearch(app, page, "cards.show-browser");
      const browser = browserView(page, task.id);
      await browser.getByRole("button", { name: TAKE_CONTROL_LABEL, exact: true }).click();
      await expect(browser).toHaveAttribute("data-browser-state", "captain");
      await clickOnPage(app, page, task.id, url, "note");
      await pressWindowKey(app, "s");
      await expect.poll(() => pageSays(app, url, "note", "value")).toBe("s");
      await expect(settings()).toHaveCount(0);
    });

    await test.step("Reset all keys restores Legacy reply isolation", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await keyboard.resetAll.click();
      await keyboard.resetAll.click();
      await home();
      await showCard(page, NOT_TYPING_TITLES.served);
      await focusOn(cardReply(page).field);
      await pressWindowKey(app, "Escape");
      await expect(cardReply(page).field).toBeFocused();
    });
  } finally {
    try {
      await stopTaskBrowsers(page);
    } finally {
      try {
        await launched.close();
      } finally {
        await closeSite(site);
      }
    }
  }
});

/**
 * Captain's revised safety rule: warn, save and run risky keys, including earlier saved function keys.
 * Real recorder and version-1 saved bindings, a fresh restart, and disposable question/note cards;
 * completion is the retained key caps, successful unrelated save and actual card actions.
 * Portable Electron journey; isolated app data and model scenario, with no sign-in or shared resource.
 */
test("warned answer keys survive a restart, allow other saves and run their card actions", async () => {
  test.setTimeout(120_000);
  const functionKey = "F13";
  let launched = await launchApp({ withMockProvider: true, scenarios: [riskyKeys] });
  const { userDataDir, homeDir } = launched;
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);
    await runFromSearch(app, page, "settings.keyboard");
    for (const [id, key] of [
      ["cards.choice-1", "a"],
      ["cards.done", functionKey],
    ] as const) {
      await startRecording(page, id);
      await pressWindowKey(app, key);
      const binding = key === functionKey ? { key } : { key, when: "not-typing" as const };
      const row = keyboard.row(id);
      await expect(row.locator("[data-keyboard-warning]")).toHaveText(
        bindingWarning(binding, id) ?? "",
      );
      await expect(row.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await expect(
        row.getByRole("button", { name: "Add beside the others", exact: true }),
      ).toBeEnabled();
      await endRecording(app, page, "Enter");
      await expect(row).toHaveAttribute("data-keyboard-changed", "true");
    }
    await launched.close();
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [riskyKeys],
      userDataDir,
      homeDir,
    });
    const restarted = launched;
    await runFromSearch(restarted.app, restarted.page, "settings.keyboard");
    const installed = keyboardSettings(restarted.page);
    // This function key has exactly the version-1 shape older builds saved: no `when` field.
    await expect(installed.keys("cards.done").locator("kbd")).toHaveText([
      keyWords({ key: functionKey }),
    ]);
    await startRecording(restarted.page, "settings.open");
    await pressWindowKey(restarted.app, "s");
    await expect(installed.row("settings.open").locator("[data-keyboard-warning]")).toHaveCount(0);
    await endRecording(restarted.app, restarted.page, "Enter");
    await expect(installed.row("settings.open")).toHaveAttribute("data-keyboard-changed", "true");
    await runFromSearch(restarted.app, restarted.page, "focus.main-message");
    await promptInput(restarted.page).fill(`${SPAWN_PROMPT_MARKER} ${RISKY_KEYS_MARKER}`);
    await pressKey(promptInput(restarted.page), "Enter");
    await expect(pager(restarted.page, 2)).toBeVisible({ timeout: 60_000 });
    await showCard(restarted.page, RISKY_KEYS_TITLES.question);
    await stagePrepared(restarted.page);
    // The captain kept risky offers from card content: witness the native press, then offer it there.
    const note = cardBody(restarted.page, RISKY_KEYS_TITLES.question).getByRole("region", {
      name: "Project note",
      exact: true,
    });
    await focusOn(note);
    await pressWindowKey(restarted.app, "a");
    await pressKey(note, "a");
    await expect(shownCard(restarted.page, RISKY_KEYS_TITLES.question)).toHaveCount(0);
    await showCard(restarted.page, RISKY_KEYS_TITLES.note);
    await focusOn(shownEntry(restarted.page));
    await pressWindowKey(restarted.app, functionKey);
    await expect(shownCard(restarted.page, RISKY_KEYS_TITLES.note)).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
