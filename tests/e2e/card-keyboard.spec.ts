import { writeFile } from "node:fs/promises";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CARD_CHOICE_COMMANDS } from "@shared/keyboard";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { Card, CardObservation } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { INLINE_PNG } from "./crewCards";
import { hintOf } from "./desktop";
import { cardBody, cardBodySelector, frameGesturesDecided } from "./frames";
import { launchApp } from "./launch";
import { pressPointer, resizeWindow } from "./layout";
import { promptInput } from "./prompt";
import { keySummary, linkedTaskKeys, recordCard } from "./rails";
import { expectNoCard, SHOWN_ENTRY, showCard, shownCard, shownEntry } from "./stack";
import {
  commandSearch,
  focusedRegion,
  focusOn,
  pressKey,
  pressWindowKey,
  regionAfter,
  runFromSearch,
  typeInto,
} from "./windowKeys";

/**
 * A card from the keyboard alone (docs/keyboard.md, "Cards and frames";
 * FI3-800 piece 6): F6 lands on the card and the reading keys scroll its
 * body; Go to the card's body and Go to the card's buttons go to its own
 * places; a choice pressed with Enter goes through the click's own checks,
 * and a held Enter sends nothing more; focus that leaves a field or a
 * picture inside the card's frame for command search or the picture viewer
 * comes back to it, caret and all; a task key the keyboard rests on opens
 * its summary; Escape leaves the body for the card; and a card's script
 * cannot use any of it to open things or move focus.
 *
 * A key typed inside a card's frame goes through Playwright's keyboard: the
 * window's own input path (`pressWindowKey`) reaches the main process,
 * which hears the window's commands, but not a hidden window's frames.
 */

const TITLE = "Pick the launch window";
const HOSTILE = "A card that forges its own gestures";
const PICTURES = ["The launch board before", "The launch board after"];

/**
 * The viewer's count over the card's own pictures, "1 / 2": the format is typed
 * inline in `PictureViewer.tsx`, which exports nothing a spec can load, so the
 * places and the total come from `PICTURES`.
 */
function pictureCount(position: number): string {
  return `${position} / ${PICTURES.length}`;
}
const DRAFT = "ship the login fix today";
/** The caret after "ship". */
const CARET = 4;

function decisionCard(key: string): Card {
  return {
    id: "card-fm-launch",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: TITLE,
    body:
      `<p>The checklist in ${key} is ready. Pick when the launch goes out.</p>` +
      `<fieldset><legend>When should it launch?</legend>` +
      `<label><input type="radio" name="window" value="morning" required> Tomorrow morning</label>` +
      `<label><input type="radio" name="window" value="evening"> Tomorrow evening</label></fieldset>` +
      `<p><label>Note <textarea name="note"></textarea></label></p>` +
      `<figure class="inf-pictures">` +
      PICTURES.map((alt) => `<img src="${INLINE_PNG}" alt="${alt}" width="160" height="90">`).join(
        "",
      ) +
      `<figcaption>The launch board, before and after</figcaption></figure>` +
      "<p>The rest of the plan follows, one step a line.</p>".repeat(16),
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "hold", label: "Hold", variant: "secondary" },
      { id: "launch", label: "Launch it", variant: "primary", default: true },
    ],
  };
}

const PLAN = "Add a dark theme to the settings page";

/** A planner's card: two other choices, then its default at the right edge. */
function planCard(): Card {
  return {
    id: "card-fm-plan",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: PLAN,
    body: "<p>I would add a dark theme switch under Appearance, using the colors the app already has.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "abandon", label: "Abandon", variant: "secondary" },
      { id: "defer", label: "Save and defer", variant: "secondary" },
      { id: "build", label: "Approve and build", variant: "primary", default: true },
    ],
  };
}

/**
 * A body whose script, ten times over two seconds, makes the bridge send
 * every gesture that opens or moves something - a click on its picture and
 * on its task key, an Escape - and sends a picture of its own besides,
 * while it keeps every key the captain types inside it for itself.
 */
function hostileCard(key: string): Card {
  const forged = JSON.stringify({
    fm: 2,
    type: "image",
    index: 0,
    pictures: [{ src: INLINE_PNG, alt: "forged", width: 2, height: 2 }],
  });
  return {
    id: "card-fm-hostile",
    author: "firstmate",
    meta: "firstmate",
    priority: 30,
    title: HOSTILE,
    body:
      `<p>The report in ${key} is ready.</p>` +
      `<p><label>Scratch <input name="scratch"></label></p>` +
      `<img src="${INLINE_PNG}" alt="A picture the script clicks" width="80" height="40">` +
      `<p role="status">0</p>` +
      "<script>(function () {" +
      'document.addEventListener("keydown", function (event) {' +
      "  if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }" +
      "}, true);" +
      "var sent = 0;" +
      "var forge = setInterval(function () {" +
      '  var click = function (node) { if (node) node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };' +
      '  click(document.querySelector("img"));' +
      '  click(document.querySelector("a[data-inf-task]"));' +
      '  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));' +
      `  parent.postMessage(${forged}, "*");` +
      "  sent += 1;" +
      '  document.querySelector("[role=status]").textContent = String(sent);' +
      "  if (sent >= 10) clearInterval(forge);" +
      "}, 200);" +
      "})();</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

function seed(userDataDir: string, cards: (key: string) => Card[]): void {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "keyboard-launch",
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    });
    const store = new CardStore(db);
    for (const card of cards(task.key)) store.upsert(card);
  } finally {
    db.close();
  }
}

function observationsOf(userDataDir: string, cardId: string): CardObservation[] {
  const db = openDatabase(userDataDir);
  try {
    return new CardStore(db).observations(cardId);
  } finally {
    db.close();
  }
}

const body = (page: Page, title: string): FrameLocator => cardBody(page, title);

function focusedInFrame(frame: FrameLocator): Promise<{ tag: string; name: string } | null> {
  return frame
    .locator("body")
    .evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return {
        tag: active.tagName,
        name: active.getAttribute("alt") ?? active.getAttribute("name") ?? "",
      };
    })
    .catch(() => null);
}

/** How far the shown card's body, the one place it scrolls, is scrolled. */
const cardScroll = (page: Page) =>
  shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller) => scroller.scrollTop);

const cardOverflow = (page: Page) =>
  shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller) => scroller.scrollHeight - scroller.clientHeight);

const viewer = (page: Page) => page.getByRole("dialog", { name: /^Pictures from / });

async function typeDraft(page: Page): Promise<void> {
  const prompt = promptInput(page);
  await prompt.fill(DRAFT);
  await prompt.evaluate((field: HTMLTextAreaElement, at) => field.setSelectionRange(at, at), CARET);
  await expect(prompt).toBeFocused();
}

async function expectDraftKept(page: Page): Promise<void> {
  const prompt = promptInput(page);
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(DRAFT);
  expect(await prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(CARET);
}

test("a card is read, answered and chosen from the keyboard, through the click's own checks", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  let offerId = "";
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    await typeDraft(page);
    offerId = await page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((card) => card.title === title)?.offerId ?? "",
      TITLE,
    );
    expect(offerId).not.toBe("");

    await test.step("F6 lands on the card, and the reading keys scroll its body", async () => {
      await expect.poll(() => cardOverflow(page)).toBeGreaterThan(0);
      let at = await focusedRegion(page);
      while (at !== "card") at = await regionAfter(app, page, at, "F6");
      expect(await cardScroll(page)).toBe(0);
      await page.keyboard.press("PageDown");
      await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
      await page.keyboard.press("End");
      const end = await cardScroll(page);
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => cardScroll(page)).toBeLessThan(end);
      await page.keyboard.press("Home");
      await expect.poll(() => cardScroll(page)).toBe(0);
    });

    await test.step("Go to the card's body puts focus in the body, and Tab goes on to its first control", async () => {
      await runFromSearch(app, page, "focus.card-body");
      await expect(shownEntry(page).locator("[data-card-body]")).toBeFocused();
      await page.keyboard.press("PageDown");
      await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
      await page.keyboard.press("Home");
      await page.keyboard.press("Tab");
      await expect.poll(() => focusedInFrame(body(page, TITLE))).not.toBeNull();
    });

    const launch = shownEntry(page).getByRole("button", { name: "Launch it" });
    await test.step("Go to the card's buttons focuses its default, and Enter with a question unanswered goes to the question", async () => {
      await runFromSearch(app, page, "focus.card-actions");
      await expect(launch).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => focusedInFrame(body(page, TITLE)))
        .toEqual({ tag: "INPUT", name: "window" });
      await expect(shownEntry(page)).toBeVisible();
      expect(
        observationsOf(userDataDir, "card-fm-launch").filter((seen) => seen.kind === "action"),
      ).toEqual([]);
      // The arrows pick in a group of radios, as anywhere.
      await page.keyboard.press("ArrowDown");
      await expect(
        body(page, TITLE).getByRole("radio", { name: "Tomorrow evening" }),
      ).toBeChecked();
    });

    await test.step("Enter on the default sends the answer, and a held Enter sends no message after it", async () => {
      await runFromSearch(app, page, "focus.card-actions");
      await expect(launch).toBeFocused();
      // The press, and the key held down after the card leaves.
      await page.keyboard.down("Enter");
      await expectNoCard(page, TITLE);
      await expect(promptInput(page)).toBeFocused();
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      await expect(promptInput(page)).toHaveValue(DRAFT);
    });
  } finally {
    await launched.close();
  }

  const [chosen, ...others] = observationsOf(userDataDir, "card-fm-launch").filter(
    (seen) => seen.kind === "action",
  );
  expect(others).toHaveLength(0);
  if (chosen?.kind !== "action") throw new Error("the keyboard's choice left no evidence");
  expect(chosen.actor).toBe("captain");
  expect(chosen.source).toBe("chrome");
  expect(chosen.payload).toMatchObject({
    actionId: "launch",
    reading: "fresh",
    display: { fidelity: "matched", reportedOfferId: offerId },
  });
  expect(chosen.payload.answers).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "window", values: ["evening"] })]),
  );
});

// The captain's words: "the default should always be cmd+1, and the number
// should grow from the right to the left", so ⌘1 always takes the recommended step.
test("⌘1 presses the recommended choice, and the other keys count leftward from it", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, () => [planCard()]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, PLAN);
    await typeDraft(page);

    await test.step("the default shows ⌘1, and the keys grow from the right edge leftward", async () => {
      // Drawn left to right: the app's Decline (INF-3108), Abandon, Save and
      // defer, Approve and build.
      await expect(
        shownEntry(page).locator("[data-card-actions] [data-card-choice] [data-button-key]"),
      ).toHaveText([
        hintOf(CARD_CHOICE_COMMANDS[3]),
        hintOf(CARD_CHOICE_COMMANDS[2]),
        hintOf(CARD_CHOICE_COMMANDS[1]),
        hintOf(CARD_CHOICE_COMMANDS[0]),
      ]);
    });

    await test.step("⌘1 presses the default, and the draft waits in the main message", async () => {
      await pressWindowKey(app, "1", ["meta"]);
      await expectNoCard(page, PLAN);
      await expectDraftKept(page);
    });
  } finally {
    await launched.close();
  }

  const chosen = observationsOf(userDataDir, "card-fm-plan").filter(
    (seen) => seen.kind === "action",
  );
  expect(chosen).toHaveLength(1);
  if (chosen[0]?.kind !== "action") throw new Error("⌘1 left no choice behind");
  expect(chosen[0].actor).toBe("captain");
  expect(chosen[0].payload).toMatchObject({ actionId: "build" });
});

test("focus that leaves a card's field or picture comes back to it, caret and all", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    const frame = body(page, TITLE);
    const note = frame.getByRole("textbox", { name: "Note" });

    await test.step("command search closes back into the note, its caret where it was", async () => {
      await note.fill("launch after standup");
      await note.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(7, 7));
      await pressWindowKey(app, "k", ["meta"]);
      await expect(commandSearch(page).dialog).toBeVisible();
      await pressWindowKey(app, "Escape");
      await expect(commandSearch(page).dialog).toHaveCount(0);
      await expect(note).toBeFocused();
      await typeInto(note, "right ");
      await expect(note).toHaveValue("launch right after standup");
    });

    await test.step("Tab reaches a picture, Enter opens it, and closing the viewer comes back to it", async () => {
      await pressKey(note, "Tab");
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[0] });
      await page.keyboard.press("Enter");
      await expect(viewer(page)).toBeVisible();
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText(pictureCount(1));
      await page.keyboard.press("ArrowRight");
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText(pictureCount(2));
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toHaveCount(0);
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[0] });
      await page.keyboard.press("Tab");
      await page.keyboard.press(" ");
      await expect(viewer(page).locator("[data-picture-count]")).toHaveText(pictureCount(2));
      await page.keyboard.press("Escape");
      await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "IMG", name: PICTURES[1] });
    });

    await test.step("a task key the keyboard rests on opens its summary, and Escape lets it go", async () => {
      // Back up the body: the first picture, the note, the question, the key.
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Tab");
      await expect(linkedTaskKeys(frame).first()).toBeFocused();
      await expect(keySummary(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(keySummary(page)).toBeHidden();
      // That Escape let the summary go, and nothing more.
      await expect(linkedTaskKeys(frame).first()).toBeFocused();
    });

    await test.step("Escape in the body leaves it for the card, and Tab goes back in", async () => {
      await pressKey(note, "Escape");
      await expect(page.locator(`${SHOWN_ENTRY}[data-window-region="card"]`)).toBeFocused();
      await expect(note).toHaveValue("launch right after standup");
    });

    await test.step("Enter on the card's edge gives it back the width the host chose", async () => {
      const edge = page.locator('[data-card-layer] [data-card-edge="right"]');
      const chosen = Number(await edge.getAttribute("aria-valuenow"));
      await pressKey(edge, "ArrowLeft");
      await expect(edge).toHaveAttribute("aria-valuenow", String(chosen - 32));
      await page.keyboard.press("Enter");
      await expect(edge).toHaveAttribute("aria-valuenow", String(chosen));
    });
  } finally {
    await launched.close();
  }
});

test("a card's script cannot use its frame to open things or move focus", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [hostileCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, HOSTILE);
    const frame = body(page, HOSTILE);
    await expect(linkedTaskKeys(frame)).toHaveCount(1);
    await typeDraft(page);

    await test.step("a picture, a task and an Escape the script sends while focus is elsewhere open nothing", async () => {
      await expect(frame.getByRole("status")).toHaveText("10", { timeout: 10_000 });
      await frameGesturesDecided(page);
      await expect(viewer(page)).toHaveCount(0);
      await expect(recordCard(page)).toHaveCount(0);
      await expect(shownCard(page, HOSTILE)).toBeVisible();
      await expectDraftKept(page);
    });

    await test.step("the captain's own press on the same picture opens it", async () => {
      await pressPointer(page, frame.getByRole("img", { name: "A picture the script clicks" }));
      await expect(viewer(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toHaveCount(0);
    });

    await test.step("a script that keeps every key cannot keep the window's: F6 and Cmd+L leave it", async () => {
      const scratch = frame.getByRole("textbox", { name: "Scratch" });
      await focusOn(scratch);
      await typeInto(scratch, "kept");
      await expect(scratch).toHaveValue("");
      expect(await focusedRegion(page)).toBe("card");
      expect(await regionAfter(app, page, "card", "F6")).not.toBe("card");
      await focusOn(scratch);
      await pressWindowKey(app, "l", ["meta"]);
      await expectDraftKept(page);
    });
  } finally {
    await launched.close();
  }
});

// INF-391: on a slow virtual Mac the card's height check ran between a
// PageDown and the first scroll frame, wrote the body's scrollTop back as 0
// and lost the smooth scroll (card-keyboard.spec.ts failed at the PageDown
// step in 9 of 205 runs there, 0 of 90 on a fast Mac). The check is forced
// here by a change inside the card, the moment a smooth scroll starts.
test("a smooth scroll of a card's body survives the card's height check", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-scroll-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    await expect.poll(() => cardOverflow(page)).toBeGreaterThan(0);
    await shownEntry(page)
      .locator("[data-card-body]")
      .evaluate((scroller) => {
        scroller.scrollTo({ top: 200, behavior: "smooth" });
        // A change inside the shell queues the height check as a microtask,
        // before the scroll's first frame.
        const shell = scroller.closest("[data-card-presentation]");
        shell?.append(document.createElement("span"));
      });
    await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
  } finally {
    await launched.close();
  }
});

/**
 * INF-1154 (card-keyboard.spec.ts:354 in run 40106791569: the key's summary
 * never appeared): Shift+Tab onto a task key scrolls the card's body to
 * bring the key into view, and the frame reports the key two frames later.
 * The window hears that scroll at its own next frame, which under load comes
 * after it has read the report. The window here holds the scrolls it hears,
 * before the report or after it, and lets them go in a task after the one
 * that read the report, so the order the failing run met by chance is the
 * order of every run. A hold that caught only the scrolls heard before the
 * report held none in the runs whose window heard the scroll after it on its
 * own (INF-1507: 2 of 20 local runs on main). The data: the card
 * the journey above reads, scrolled to its end. The completion signal: the
 * frame has reported the key and the held scrolls have reached the window.
 * Platform and shared resources: none beyond the hermetic launch.
 */
test("a task key the keyboard brings into view opens its summary when the window hears the scroll late", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-card-keyboard-");
  seed(userDataDir, (key) => [decisionCard(key)]);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, TITLE);
    const frame = body(page, TITLE);
    await expect.poll(() => cardOverflow(page)).toBeGreaterThan(0);
    // The question, just below the key; the key is then carried out of view.
    await pressKey(frame.getByRole("textbox", { name: "Note" }), "Shift+Tab");
    await expect.poll(() => focusedInFrame(frame)).toEqual({ tag: "INPUT", name: "window" });
    await shownEntry(page)
      .locator("[data-card-body]")
      .evaluate((scroller) => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
    // That scroll reaches the window before the hold begins.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    type Held = { held: number; rested: boolean; released: boolean; events: unknown[] };
    await page.evaluate((selector) => {
      const targets: EventTarget[] = [];
      const state: Held = { held: 0, rested: false, released: false, events: [] };
      Object.assign(window, { heldScrolls: state });
      const holder = document.querySelector<HTMLIFrameElement>(selector);
      const body = holder?.closest("[data-card-body]");
      const targetName = (target: EventTarget | null) =>
        target === document
          ? "document"
          : target === window
            ? "window"
            : target === body
              ? "card body"
              : target === holder
                ? "card frame"
                : target instanceof Element
                  ? target.localName
                  : null;
      const record = (kind: string, detail?: unknown) => {
        if (state.events.length === 64) state.events.shift();
        state.events.push({ at: performance.timeOrigin + performance.now(), kind, detail });
      };
      const bounds = () => holder?.getBoundingClientRect().toJSON();
      const scroll = (kind: string, target: EventTarget | null) =>
        record(kind, { target: targetName(target), scrollTop: body?.scrollTop, holder: bounds() });
      document.addEventListener(
        "scroll",
        (event) =>
          scroll(
            event.isTrusted ? "native scroll reached document" : "scroll replay reached document",
            event.target,
          ),
        true,
      );
      for (const kind of [
        "blur",
        "resize",
        "keydown",
        "pointermove",
        "pointerleave",
        "visibilitychange",
      ]) {
        const target = kind === "blur" || kind === "resize" ? window : document;
        target.addEventListener(
          kind,
          (event) => {
            if (kind === "pointermove" && !state.rested) return;
            record(kind, { target: targetName(event.target), hidden: document.hidden });
          },
          true,
        );
      }
      // Once the report has been read and a scroll held, whichever came
      // first, the held scrolls go in a later task than either.
      let letting = false;
      const release = () => {
        if (letting || !state.rested || state.held === 0) return;
        letting = true;
        setTimeout(() => {
          window.removeEventListener("scroll", hold, { capture: true });
          for (const target of targets) {
            scroll("replaying held scroll", target);
            target.dispatchEvent(new Event("scroll"));
          }
          state.released = true;
        });
      };
      const hold = (event: Event) => {
        if (!event.isTrusted) return;
        event.stopImmediatePropagation();
        scroll("held native scroll", event.target);
        if (event.target) targets.push(event.target);
        state.held += 1;
        release();
      };
      window.addEventListener("scroll", hold, { capture: true });
      // Heard once the window's own code has read the report, in the same
      // task; the held scrolls come in a later one.
      window.addEventListener("message", (event) => {
        const data = event.data as { type?: string; gesture?: string; box?: unknown } | null;
        if (data?.type !== "task") return;
        record(`frame ${data.gesture}`, {
          source: event.source === holder?.contentWindow ? "card frame" : "other",
          key: data.box,
          holder: bounds(),
        });
        if (data.gesture !== "rest" || state.rested) return;
        state.rested = true;
        release();
      });
    }, cardBodySelector(TITLE));
    const held = () =>
      page.evaluate(() => (window as unknown as { heldScrolls: Held }).heldScrolls);

    // The window sends its lit key back to the body on acceptance or release.
    // Observe that acknowledgment separately from the untrusted frame report.
    const key = linkedTaskKeys(frame).first();
    await key.evaluate((link) => {
      const events: { at: number; kind: string }[] = [];
      Object.assign(link, { restEvents: events });
      new MutationObserver((records) => {
        for (const { oldValue } of records) {
          if (events.length === 16) events.shift();
          events.push({
            at: performance.timeOrigin + performance.now(),
            kind: oldValue === null ? "key lit by host" : "key released by host",
          });
        }
      }).observe(link, { attributeFilter: ["data-inf-lit"], attributeOldValue: true });
    });

    try {
      await page.keyboard.press("Shift+Tab");
      await expect(key).toBeFocused();
      await expect.poll(async () => (await held()).released).toBe(true);
      expect((await held()).held).toBeGreaterThan(0);
      await expect(keySummary(page)).toBeVisible();
    } catch (error) {
      const [host, frame] = await Promise.allSettled([
        held(),
        key.evaluate(
          (link) => (link as unknown as { restEvents: unknown[] }).restEvents,
          undefined,
          {
            timeout: 500,
          },
        ),
      ]);
      const info = test.info();
      const path = info.outputPath("late-scroll-events.json");
      await writeFile(path, JSON.stringify({ host, frame }, null, 2))
        .then(() => info.attach("late-scroll-events", { path, contentType: "application/json" }))
        .catch(() => {}); // Keep the original assertion failure if the window or runner went away.
      throw error;
    }
  } finally {
    await launched.close();
  }
});
