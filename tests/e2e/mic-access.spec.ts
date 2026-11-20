import { expect, type Locator, type Page, test } from "@playwright/test";
import { STANDARD_PLACEHOLDER } from "@shared/firstRun";
import type { MicAccess } from "@shared/voice";
import { type LaunchedApp, launchApp } from "./launch";
import { probeMicrophone } from "./micPreflight";
import { MAC_ONLY_TAG } from "./tags";

/**
 * Microphone access is a line under the input, never a card
 * (docs/composer.md, "Voice"). INFINITARY_MIC_ACCESS stands in for macOS's
 * answer, and a getUserMedia held open stands in for its prompt.
 */

// Only macOS asks a person whether an app may use the microphone; on Linux
// the app reads no answer of its own (src/main/voice/micAccess.ts).
test.skip(process.platform !== "darwin", "the microphone permission is macOS's");

type MicWindow = {
  __answerMic?: (allow: boolean) => void;
  __micOpens?: number;
  __realGetUserMedia?: MediaDevices["getUserMedia"];
};

/** Counts microphone opens; with `ask`, the next one waits for `answerMac`. */
async function standInForMac(page: Page, ask: boolean): Promise<void> {
  await page.evaluate((ask) => {
    const w = window as unknown as MicWindow;
    const devices = navigator.mediaDevices;
    w.__realGetUserMedia ??= devices.getUserMedia.bind(devices);
    const real = w.__realGetUserMedia;
    w.__micOpens = 0;
    devices.getUserMedia = (constraints) => {
      w.__micOpens = (w.__micOpens ?? 0) + 1;
      if (!ask) return real(constraints);
      return new Promise((resolve, reject) => {
        w.__answerMic = (allow) =>
          allow
            ? resolve(real(constraints))
            : reject(new DOMException("Permission denied", "NotAllowedError"));
      });
    };
  }, ask);
}

function setMacAnswer(launched: LaunchedApp, access: MicAccess): Promise<void> {
  return launched.app.evaluate((_electron, value) => {
    process.env.INFINITARY_MIC_ACCESS = value;
  }, access);
}

async function answerMac(launched: LaunchedApp, allow: boolean): Promise<void> {
  await setMacAnswer(launched, allow ? "granted" : "denied");
  await launched.page.evaluate(
    (allow) => (window as unknown as MicWindow).__answerMic?.(allow),
    allow,
  );
}

const micOpens = (page: Page) =>
  page.evaluate(() => (window as unknown as MicWindow).__micOpens ?? 0);

/** Holds the talk key once the voice check has settled; the key stays down. */
async function holdToTalk(page: Page, took: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.keyboard.down("AltRight");
        const visible = await took.isVisible().catch(() => false);
        if (!visible) await page.keyboard.up("AltRight");
        return visible;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Tabs forward until `target` has the focus, as a person reaching it by keys. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await target.evaluate((element) => element === document.activeElement)) return true;
        await page.keyboard.press("Tab");
        return false;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test("while macOS asks, a line under the input explains, no card covers the Firstmate, and allowing takes it down", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const launched = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_MIC_ACCESS: "not-determined" },
  });
  try {
    const { page } = launched;
    await expect(page.getByPlaceholder(STANDARD_PLACEHOLDER)).toBeVisible();
    const cardsBefore = await page.evaluate(() => window.infinitary.cards.list());
    await standInForMac(page, true);
    const asking = page.locator('[data-voice-notice="mic-asking"]');

    await holdToTalk(page, page.getByRole("button", { name: "Abandon" }));
    await expect(asking).toBeVisible();
    await expect(page.locator("[data-screen-label]")).toHaveAttribute(
      "data-screen-label",
      "Listening",
    );
    expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual(cardsBefore);

    // Allow: the line goes by itself and listening goes on.
    await answerMac(launched, true);
    await expect(page.locator("[data-voice-notice]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.up("AltRight");
    await expect(page.getByRole("button", { name: "Abandon" })).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual(cardsBefore);
  } finally {
    await launched.close();
  }
});

test("Don't Allow leaves a line that leads to System Settings, and access turned on there takes it down", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const launched = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_MIC_ACCESS: "not-determined" },
  });
  try {
    const { page } = launched;
    await expect(page.getByPlaceholder(STANDARD_PLACEHOLDER)).toBeVisible();
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const off = page.locator('[data-voice-notice="mic-off"]');
    const openSettings = off.getByRole("button", { name: "Open System Settings" });
    const close = off.getByRole("button", { name: "Close" });

    // The first ask, answered Don't Allow after the key is already up.
    await standInForMac(page, true);
    await holdToTalk(page, page.getByRole("button", { name: "Abandon" }));
    await expect(page.locator('[data-voice-notice="mic-asking"]')).toBeVisible();
    await page.keyboard.up("AltRight");
    await answerMac(launched, false);
    await expect(off).toBeVisible();
    await expect(page.getByRole("button", { name: "Abandon" })).toHaveCount(0);

    // Its buttons are reached by keys; Open System Settings opens the microphone pane.
    await tabTo(page, openSettings);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened))
      .toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"]);
    await tabTo(page, close);
    await page.keyboard.press("Enter");
    await expect(off).toHaveCount(0);

    // A later hold while access is off: the line at once, and the microphone never opens.
    await standInForMac(page, false);
    await page.keyboard.down("AltRight");
    await expect(off).toBeVisible();
    await page.keyboard.up("AltRight");
    await expect(page.getByRole("button", { name: "Abandon" })).toHaveCount(0);
    expect(await micOpens(page)).toBe(0);

    // Access turned on in System Settings: back in the window, the line goes.
    await setMacAnswer(launched, "granted");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("[data-voice-notice]")).toHaveCount(0);
    await page.keyboard.down("AltRight");
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.up("AltRight");
    await expect(page.getByRole("button", { name: "Abandon" })).toHaveCount(0);
    expect(await micOpens(page)).toBe(1);
    await expect(page.locator("[data-voice-notice^='mic-']")).toHaveCount(0);

    // Access turned off again: the next hold says so.
    await setMacAnswer(launched, "denied");
    await page.keyboard.down("AltRight");
    await expect(off).toBeVisible();
    await page.keyboard.up("AltRight");

    // A Mac whose administrator decides: a line with Close alone.
    await setMacAnswer(launched, "restricted");
    await page.keyboard.down("AltRight");
    const managed = page.locator('[data-voice-notice="mic-managed"]');
    await expect(managed).toBeVisible();
    await page.keyboard.up("AltRight");
    await expect(managed.getByRole("button")).toHaveCount(1);
    await tabTo(page, managed.getByRole("button", { name: "Close" }));
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-voice-notice]")).toHaveCount(0);
    expect(await micOpens(page)).toBe(1);
  } finally {
    await launched.close();
  }
});

// INF-420: the run's own microphone check (tests/e2e/micPreflight.ts) asked
// for __dirname, which Playwright's loader does not define, and its probe's
// data: page had no navigator.mediaDevices, so in a virtual Mac every run
// failed before its first journey, granted or not. It runs here under the
// same loader as the global setup, on a Mac whose runner may open the
// microphone.
test("the run's microphone check opens the fake microphone", { tag: MAC_ONLY_TAG }, async () => {
  expect(await probeMicrophone()).toBe("opened");
});
