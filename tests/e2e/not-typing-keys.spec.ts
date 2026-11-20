import { createServer } from "node:http";
import { expect, type Locator, test } from "@playwright/test";
import { bindingWarning } from "../../src/shared/keymap";
import { FRAME_BRIDGE_VERSION } from "../../src/shared/plugins/bridge";
import { TAKE_CONTROL_LABEL } from "../../src/shared/taskBrowser";
import { claimedPort } from "../helpers/claimedPort";
import { crewComposer, crewmateView } from "./crewmateTab";
import { keyWords } from "./desktop";
import { cardBody, cardBodyElement, frameGesturesDecided } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { dockFrameElement, expandDock, nowFrame, nowRow, pressRow } from "./rails";
import {
  NOT_TYPING_MARKER,
  NOT_TYPING_TITLES,
  notTypingKeys,
  RISKY_KEYS_MARKER,
  RISKY_KEYS_TITLES,
  riskyKeys,
} from "./scenarios/notTypingKeys";
import {
  cardReply,
  focusFrameAfterStage,
  minimizeForLegacyView,
  pager,
  showCard,
  shownCard,
  shownEntry,
  stagePrepared,
} from "./stack";
import { browserView, clickOnPage, closeSite, pageSays, stopTaskBrowsers } from "./taskBrowser";
import {
  chooseKeyPlace,
  endRecording,
  focusOn,
  frameHoldsWindowFocus,
  keyboardSettings,
  pressKey,
  pressKeyTakingFrame,
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
  // Settings takes the cards and the side panels away, so a key that opens it
  // comes up only once its frame is gone (`pressKeyTakingFrame`).
  const frameKey = async (target: Locator, key: string, frame: "stays" | "goes") => {
    await focusOn(target);
    await frameHoldsWindowFocus(target);
    await pressWindowKey(app, key);
    if (frame === "goes") await pressKeyTakingFrame(target, key);
    else await pressKey(target, key);
  };
  const keepsLetter = async (field: Locator) => {
    await field.fill("");
    await focusOn(field);
    await pressWindowKey(app, "s");
    await typeInto(field, "s");
    await expect(field).toHaveValue("s");
    await expect(settings()).toHaveCount(0);
  };
  // A busy page runs the work a key press deferred only after later presses
  // came in, as the Mac's hidden window once did in a merge batch's run of
  // this journey. Every timer the window page sets while it dispatches a key
  // waits for the returned release. The release then asks the window about
  // one more offer, which no press witnessed: the window answers offers in
  // turn, so its answer comes after it decided every offer the held work sent.
  const holdPressWork = async (): Promise<() => Promise<void>> => {
    await page.evaluate(() => {
      const { setTimeout: later, clearTimeout: forget } = window;
      const held = new Map<number, () => void>();
      let next = -1;
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
        if (window.event?.type !== "keydown" || typeof handler !== "function")
          return later(handler, timeout, ...rest);
        const id = next--;
        held.set(id, () => handler(...rest));
        return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((id?: number) => {
        if (id === undefined || !held.delete(id)) forget(id);
      }) as typeof window.clearTimeout;
      (window as unknown as { pressWorkHeld: () => void }).pressWorkHeld = () => {
        window.setTimeout = later;
        window.clearTimeout = forget;
        for (const run of held.values()) run();
        held.clear();
      };
    });
    return () =>
      page.evaluate(async () => {
        (window as unknown as { pressWorkHeld: () => void }).pressWorkHeld();
        await window.infinitary.keyboard.offer({
          key: "F24",
          code: "F24",
          meta: false,
          ctrl: false,
          alt: false,
          shift: false,
          composing: false,
          repeat: false,
        });
      });
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
        await frameKey(body.getByRole("region", { name: "Note text" }), "s", "goes");
        await expect(settings()).toBeVisible();
        await home();
        // Settings took the cards away, so going home makes every card's page again.
        await showCard(page, cardTitle);
        await focusFrameAfterStage(page, cardBodyElement(page, cardTitle));
        await frameKey(body.getByRole("radio", { name: "Ready for review" }), "s", "goes");
        await expect(settings()).toBeVisible();
        await home();
      }
      // Find a task opens the Tasks dock, and beside a wide note this window
      // folds the docks: the dock leaves the window once its slide ends, and
      // the shell hands the focus its search held to the main message (run
      // 43064436321). Tasks is searched as a person can here, with the notes
      // put aside, and they come back for the next step.
      const notes = Object.values(NOT_TYPING_TITLES);
      for (const cardTitle of notes) await minimizeForLegacyView(page, cardTitle);
      await expect(shownEntry(page)).toHaveCount(0);
      await runFromSearch(app, page, "panel:now/find");
      await keepsLetter(nowFrame(page).locator("[data-now-query]"));
      await home();
      await page.evaluate(async (titles: string[]) => {
        for (const card of await window.infinitary.cards.list())
          if (titles.includes(card.title)) await window.infinitary.cards.minimize(card.id, false);
      }, notes);
      await expect(pager(page, notes.length)).toBeVisible();
    });

    await test.step("a key pressed in a card's frame stays the frame's when the window page offers late", async () => {
      await showCard(page, NOT_TYPING_TITLES.served);
      await stagePrepared(page);
      const body = cardBody(page, NOT_TYPING_TITLES.served);
      // The window page hears the window key pressed in the frame's field,
      // then focus comes back to it and the reply's own key is witnessed
      // before that first key's offer runs.
      const release = await holdPressWork();
      await keepsLetter(body.getByRole("textbox", { name: "Note", exact: true }));
      await keepsLetter(cardReply(page).field);
      await release();
      await expect(settings()).toHaveCount(0);
      await pressWindowKey(app, "Escape");
      await expect(shownEntry(page)).toBeFocused();
    });

    await test.step("a card's used key stays local; unfocused and unwitnessed offers do nothing", async () => {
      await showCard(page, NOT_TYPING_TITLES.served);
      await stagePrepared(page);
      const body = cardBody(page, NOT_TYPING_TITLES.served);
      const local = body.getByRole("button", { name: "Keep reading", exact: true });
      await frameKey(local, "s", "stays");
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
      await frameKey(reader, "s", "goes");
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
      // The row brings the task's card forward, which takes the focus once it
      // appears; the keys below start after that, so it cannot move focus
      // out of Tasks between them (docs/e2e-contracts.md, `pressRow`).
      await expect(shownEntry(page)).toBeFocused();
      await focusFrameAfterStage(page, dockFrameElement(page, "now"));
      await frameKey(nowRow(page, task.key), "s", "goes");
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
    await focusFrameAfterStage(
      restarted.page,
      cardBodyElement(restarted.page, RISKY_KEYS_TITLES.question),
    );
    // The captain kept risky offers from card content: witness the native press, then offer it there.
    const note = cardBody(restarted.page, RISKY_KEYS_TITLES.question).getByRole("region", {
      name: "Project note",
      exact: true,
    });
    await focusOn(note);
    await frameHoldsWindowFocus(note);
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
