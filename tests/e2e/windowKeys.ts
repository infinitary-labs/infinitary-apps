import {
  type ElectronApplication,
  type ElementHandle,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { withPreset } from "../../src/shared/keymap";
import { PRESET_LABELS, type PresetId } from "../../src/shared/keyPresets";
import { takeTurn } from "./inputQueue";
import { readInMain } from "./mainProcess";

/** A modifier Electron's `sendInputEvent` takes. */
export type WindowKeyModifier = "meta" | "control" | "alt" | "shift";

/**
 * What the window's keys do now, as the shell marks it on its document
 * (`data-window-keys`, src/renderer/src/app/windowKeysMark.ts): `commands`
 * once the shell follows the window's commands, `recording` while Keyboard
 * settings records a key, and nothing before the shell has drawn.
 */
function windowKeysMark(page: Page): Locator {
  return page.locator(":root");
}

/**
 * Returns once a window key runs its command: the shell follows the
 * window's commands and no recording holds the keys. `launchApp` waits for it
 * before it returns; a journey waits for it again after a reload, and after
 * Keyboard settings stops recording.
 */
export async function untilWindowCommands(page: Page, timeout?: number): Promise<void> {
  await expect(windowKeysMark(page)).toHaveAttribute(
    "data-window-keys",
    "commands",
    timeout === undefined ? {} : { timeout },
  );
}

/**
 * The modifiers as this computer's keyboard holds them: a journey names a
 * Mac's ⌘ as `meta`, and on a Ctrl system (Linux) Ctrl takes ⌘'s place in
 * every key the app gives (docs/keyboard.md, "Keys on each system"), so
 * there `meta` presses Ctrl.
 */
function systemModifiers(modifiers: readonly WindowKeyModifier[]): WindowKeyModifier[] {
  if (process.platform === "darwin") return [...modifiers];
  return [...new Set(modifiers.map((modifier) => (modifier === "meta" ? "control" : modifier)))];
}

/** The presses this worker has made, so each has its own number (`pressWindowKey`). */
let presses = 0;

/**
 * Presses a key in the app's window the way Electron delivers one: through
 * `before-input-event` in the main process, then the page. Playwright's own
 * keyboard reaches the page through the debugger and skips the main
 * process, so a window command (docs/keyboard.md) never hears it. `meta` is
 * the command key: ⌘ on a Mac, Ctrl on Linux (`systemModifiers`).
 */
export async function pressWindowKey(
  app: ElectronApplication,
  keyCode: string,
  modifiers: readonly WindowKeyModifier[] = [],
): Promise<void> {
  // A busy main process can lose an evaluation to a garbage collection
  // (`readInMain`). The press marks its number there as it sends the key, so
  // asking again sends nothing when the key went and sends it when it did
  // not: the key goes once either way.
  const press = { number: ++presses, keyCode, modifiers: systemModifiers(modifiers) };
  await readInMain(() =>
    app.evaluate(({ BrowserWindow }, key) => {
      const marks = globalThis as { windowKeysSent?: Set<number> };
      marks.windowKeysSent ??= new Set();
      const sent = marks.windowKeysSent;
      if (sent.has(key.number)) return;
      // The app's own window: a task's hidden browser pages are windows too.
      const windows = BrowserWindow.getAllWindows();
      const contents = (
        windows.find((win) => win.webContents.getURL().startsWith("file:")) ?? windows[0]
      )?.webContents;
      if (!contents) throw new Error("App window missing");
      sent.add(key.number);
      contents.sendInputEvent({ type: "keyDown", keyCode: key.keyCode, modifiers: key.modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: key.keyCode, modifiers: key.modifiers });
    }, press),
  );
}

/**
 * Brings the window forward as switching back to the app does, the window
 * still hidden: the main process focuses its page. Use it when a page the
 * stage prepared while the keyboard was in another page is waiting to hand
 * focus to the window's own page (docs/keyboard.md, "Cards and frames"):
 * it returns once the window's page has taken focus and given it back to
 * the page that held it.
 */
export async function windowComesForward(app: ElectronApplication, page: Page): Promise<void> {
  type Handoff = { handoff?: "taken" | "given back" };
  await page.evaluate(() => {
    const at = window as unknown as Handoff;
    delete at.handoff;
    window.addEventListener(
      "focus",
      () => {
        at.handoff = "taken";
        window.addEventListener("blur", () => (at.handoff = "given back"), { once: true });
      },
      { once: true },
    );
  });
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) throw new Error("App window missing");
    contents.focus();
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handoff).handoff ?? "none"))
    .toBe("given back");
}

/**
 * Command search (docs/keyboard.md): the dialog, its field, and a command's
 * row by its id (`data-command`), never by its words.
 */
export function commandSearch(page: Page): {
  dialog: Locator;
  field: Locator;
  row: (command: string) => Locator;
  rows: Locator;
} {
  const dialog = page.getByRole("dialog", { name: "Search commands" });
  return {
    dialog,
    field: dialog.getByRole("combobox"),
    row: (command) => dialog.locator(`[role="option"][data-command="${command}"]`),
    rows: dialog.getByRole("option"),
  };
}

/**
 * Runs a window command by name, as a person does in command search: opens
 * it with ⌘K, moves the choice down to the command's row by its id, and
 * presses Enter, which closes search and runs it. Search draws its rows
 * before its field takes focus, and until it does the arrows still go where
 * focus was, a card's or a panel's frame among them, so they wait for the
 * field. The window's own document is asked where its focus is, as a
 * hidden window's frame answers Playwright's own check by how the last
 * input reached it.
 */
export async function runFromSearch(
  app: ElectronApplication,
  page: Page,
  command: string,
): Promise<void> {
  const search = commandSearch(page);
  await pressWindowKey(app, "k", ["meta"]);
  await expect(search.row(command)).toBeVisible();
  await expect
    .poll(() => search.field.evaluate((field) => field.ownerDocument.activeElement === field))
    .toBe(true);
  const rows = await search.rows.count();
  for (
    let i = 0;
    i < rows && (await search.row(command).getAttribute("aria-selected")) !== "true";
    i++
  )
    await page.keyboard.press("ArrowDown");
  await expect(search.row(command)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(search.dialog).toHaveCount(0);
}

/**
 * Puts the window's keys on a preset the way the Preset row does
 * (docs/keyboard.md, "Presets"), keeping each preset's changes, and returns
 * once the window installed it; a window already on it is left alone.
 */
export async function pickKeyPreset(page: Page, preset: PresetId): Promise<void> {
  const { saved } = await page.evaluate(() => window.infinitary.keyboard.keymap());
  if (saved.preset === preset) return;
  await page.evaluate((next) => window.infinitary.keyboard.save(next), withPreset(saved, preset));
}

/**
 * Settings → Keyboard (docs/keyboard.md): a command's row by its
 * id (`data-keyboard-command`), its keys, and its recorder's verdict, never
 * by their words; the Preset row's pills by the preset's name, as the row
 * names it (`PRESET_LABELS`).
 */
export function keyboardSettings(page: Page): {
  section: Locator;
  search: Locator;
  row: (command: string) => Locator;
  keys: (command: string) => Locator;
  record: (command: string) => Locator;
  verdict: (command: string) => Locator;
  resetAll: Locator;
  presets: Locator;
  preset: (preset: PresetId) => Locator;
} {
  const section = page.locator("[data-keyboard-settings]");
  const row = (command: string) => section.locator(`[data-keyboard-command="${command}"]`);
  return {
    section,
    search: section.locator("[data-keyboard-search] input"),
    row,
    keys: (command) => row(command).locator("[data-keyboard-keys]").first(),
    record: (command) => row(command).getByRole("button", { name: /^Record a key for / }),
    verdict: (command) => row(command).locator("[data-keyboard-verdict]"),
    resetAll: section.locator("[data-keyboard-reset-all]"),
    presets: section.locator('[data-setting="keyboard-preset"]').getByRole("radio"),
    preset: (preset) =>
      section
        .locator('[data-setting="keyboard-preset"]')
        .getByRole("radio", { name: PRESET_LABELS[preset], exact: true }),
  };
}

/**
 * Chooses a key's place through its native select, using real keys on each system.
 * Mac's popup lives outside Chromium's key driver; its closed-select typeahead
 * navigates by the option's actual label. Tab first clears the previous search.
 * Other systems retain the selector's arrow navigation. The journey owns the value assertion.
 */
export async function chooseKeyPlace(
  place: Locator,
  value: "not-typing" | "anywhere",
): Promise<void> {
  // A map push can change the value before its save reply reenables this control.
  await expect(place).toBeEnabled();
  if (process.platform === "darwin") {
    await pressKey(place, "Tab");
    const initial = await place.evaluate((node, wanted) => {
      const option = [...(node as HTMLSelectElement).options].find((item) => item.value === wanted);
      if (!option) throw new Error(`Missing place option: ${wanted}`);
      return option.label.trim().charAt(0).toLowerCase();
    }, value);
    await pressKey(place, initial);
  } else {
    await pressKey(place, value === "not-typing" ? "ArrowDown" : "ArrowUp");
  }
}

/**
 * Starts recording a key for `command` in Keyboard settings, as a person does
 * with its row's Record, and returns once the main process records: every
 * window key pressed after it is the recorder's alone. It starts from a
 * window whose keys run commands, so the end of an earlier recording is
 * never taken for the start of this one.
 */
export async function startRecording(page: Page, command: string): Promise<void> {
  await untilWindowCommands(page);
  await keyboardSettings(page).record(command).click();
  await expect(windowKeysMark(page)).toHaveAttribute("data-window-keys", "recording");
}

/**
 * Ends a recording by its key - Enter saves, ⇧Enter adds, Escape cancels -
 * and returns once the window's keys run commands again.
 */
export async function endRecording(
  app: ElectronApplication,
  page: Page,
  keyCode: "Enter" | "Escape",
  modifiers: readonly WindowKeyModifier[] = [],
): Promise<void> {
  await pressWindowKey(app, keyCode, modifiers);
  await untilWindowCommands(page);
}

/**
 * Whether `target` holds the window's focus: its own document focuses it,
 * and each frame it sits in is focused in the document around it, up to the
 * window's own. Each document is asked itself, as a hidden window's frame
 * answers Playwright's own focus check by how the last input reached it.
 */
async function holdsFocus(target: Locator, acrossFrames = false): Promise<boolean> {
  const handles: ElementHandle<Node>[] = [];
  try {
    let element: ElementHandle<Node> | null = await target.elementHandle({ timeout: 1_000 });
    let own = true;
    while (element) {
      handles.push(element);
      // Across sibling frames, which frame the window's focus rests on is
      // settled by the key's own window focus (`acrossFrames`): the frame
      // around the target keeps its sibling as the document's active
      // element until then, so a level resting on another frame counts.
      const held = await element.evaluate((node, tolerant) => {
        const active = node.ownerDocument?.activeElement;
        return active === node || (tolerant && active?.tagName === "IFRAME");
      }, acrossFrames && !own);
      if (!held) return false;
      own = false;
      const frame = await element.ownerFrame();
      element = frame?.parentFrame() ? await frame.frameElement() : null;
    }
    return true;
  } catch {
    // Not drawn yet, or drawn again since: ask again.
    return false;
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
  }
}

/**
 * Whether `target` can take focus: neither it nor any frame it sits in is
 * inside an inert part of its document. `focus()` on an inert element does
 * nothing, and the stage keeps a card inert until it appears: a task record
 * waits for its body to draw (INF-510).
 */
async function canTakeFocus(target: Locator): Promise<boolean> {
  const handles: ElementHandle<Node>[] = [];
  try {
    let element: ElementHandle<Node> | null = await target.elementHandle({ timeout: 1_000 });
    while (element) {
      handles.push(element);
      const inert = await element.evaluate(
        (node) => (node as Element).closest?.("[inert]") != null,
      );
      if (inert) return false;
      const frame = await element.ownerFrame();
      element = frame?.parentFrame() ? await frame.frameElement() : null;
    }
    return true;
  } catch {
    // Not drawn yet, or drawn again since: ask again.
    return false;
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
  }
}

/** Returns once `target` can take focus (`canTakeFocus`), so a `focus()` call is not spent on it. */
async function untilFocusable(target: Locator): Promise<void> {
  await expect
    .poll(() => canTakeFocus(target), {
      message: "the target can take focus: nothing inert holds it",
    })
    .toBe(true);
}

/**
 * Returns once `target` holds the window's focus, so the key a journey
 * presses next reaches it: focus moves into a frame of its own a moment
 * after `focus()` returns.
 */
export async function untilFocused(target: Locator): Promise<void> {
  await expect
    .poll(() => holdsFocus(target), { message: "the target holds focus before the keys" })
    .toBe(true);
}

/**
 * Puts the window's focus on `target` and returns once it holds it. A
 * `focus()` call returns before focus has moved: into a frame of its own it
 * lands a moment later, and a key pressed in between goes wherever focus
 * still was. A journey that focuses an element goes through here, or
 * presses a key on it through `pressKey`. A target that cannot take focus
 * yet, such as a card the stage has not shown, is focused once it can. The
 * press takes its turn behind any other input to the page (`takeTurn`,
 * tests/e2e/inputQueue.ts).
 */
export async function focusOn(
  target: Locator,
  options?: FocusOptions & { focusVisible?: boolean },
): Promise<void> {
  await takeTurn(target.page(), async () => {
    await untilFocusable(target);
    // Pointer activation in a hidden frame must not inherit keyboard
    // modality from scripted focus (INF-1951's sequential Start journey).
    if (options) {
      await target.evaluate((node, focus) => (node as HTMLElement).focus(focus), options);
    } else {
      await target.focus();
    }
    await focusLanded(target);
  });
}

/**
 * `untilFocused` for a target that may sit in a frame next to the one the
 * window's focus rests on: the target's own document must focus it and no
 * element of the document around it may hold focus in its place, while a
 * sibling frame holding it is the key's own window focus to resolve.
 */
async function focusLanded(target: Locator): Promise<void> {
  await expect
    .poll(() => holdsFocus(target, true), { message: "the target holds focus before the keys" })
    .toBe(true);
}

/** Presses `key` on `target` once it holds the window's focus, as `focusOn` does, and one press at a time per page. */
export async function pressKey(target: Locator, key: string): Promise<void> {
  await takeTurn(target.page(), async () => {
    await untilFocusable(target);
    await target.focus();
    await focusLanded(target);
    await target.page().keyboard.press(key);
  });
}

/**
 * Types `text` with Playwright's keyboard once `field` holds the window's
 * focus. The keyboard types wherever focus is, so a journey that types
 * where a step of its own put focus checks first that it landed there; one
 * that only needs words in a field uses `fill` or `pressSequentially`, which
 * focus it themselves. `insert` sends the words with no key, as a paste or an
 * input method's commit does.
 */
export async function typeInto(
  field: Locator,
  text: string,
  options: { delay?: number; insert?: boolean } = {},
): Promise<void> {
  await untilFocused(field);
  const { keyboard } = field.page();
  if (options.insert) await keyboard.insertText(text);
  else await keyboard.type(text, options.delay === undefined ? {} : { delay: options.delay });
}

/**
 * The part of the window that holds focus (docs/keyboard.md, "Parts of the
 * window"), as the code that draws each part names it on its root
 * (`data-window-region`): `main-message`, `card`, `settings-tabs`,
 * `settings-section`, or `panel:<id>` for a side panel; null outside every
 * part. Focus inside a card's or a panel's frame is its iframe's here.
 */
export function focusedRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const region = document.activeElement?.closest("[data-window-region]");
    if (!region) return null;
    const kind = region.getAttribute("data-window-region");
    const panel = region.getAttribute("data-side-panel");
    return panel === null ? kind : `${kind}:${panel}`;
  });
}

/**
 * Starts recording each frame the window's own page puts focus on, the
 * shell's move or the captain's, and returns a read of their titles in
 * order since then. One watch per page.
 */
export async function watchFramesFocused(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as { framesFocused?: string[] }).framesFocused = seen;
    document.addEventListener(
      "focusin",
      (event) => {
        if (event.target instanceof HTMLIFrameElement) seen.push(event.target.title);
      },
      true,
    );
  });
  return () => page.evaluate(() => (window as { framesFocused?: string[] }).framesFocused ?? []);
}

/**
 * Presses a window key and returns the part focus moved to, once it has
 * left `from`: each press of F6 or ⇧F6 lands in another part.
 */
export async function regionAfter(
  app: ElectronApplication,
  page: Page,
  from: string | null,
  keyCode: string,
  modifiers: readonly WindowKeyModifier[] = [],
): Promise<string | null> {
  await pressWindowKey(app, keyCode, modifiers);
  let now: string | null = from;
  await expect
    .poll(async () => {
      now = await focusedRegion(page);
      return now;
    })
    .not.toBe(from);
  return now;
}

/** The accelerator the app menu shows on an item, by the item's id. */
export function menuItemAccelerator(app: ElectronApplication, id: string): Promise<string | null> {
  return app.evaluate(
    ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.accelerator ?? null,
    id,
  );
}
