import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { DICTATION_KEY_PICKING } from "../../src/shared/dictation";
import {
  STANDARD_PLACEHOLDER_NO_VOICE,
  STANDARD_PLACEHOLDER_SHORT,
} from "../../src/shared/firstRun";
import { DICTATION_KEY, dictationCap, hintOnThisComputer } from "./dictation";
import { type LaunchedApp, launchApp } from "./launch";

/**
 * Phase 6 (docs/architecture.md §17): the first-use consent path (real
 * voice status, no model on disk) and download deferral. The D-13
 * invariant that no audio ever lands on disk is owned by
 * src/main/voice/voiceModelService.test.ts. Full transcription runs need
 * the 1.6GB model and a real microphone; they are covered by unit tests
 * over the pipeline pieces and a documented manual check.
 */

/** What the spec types and pastes before it drops a recording, and expects kept. */
const TYPED_DRAFT = "Keep my typed draft";
const PASTED_FILE = "Keep my pasted file";

/** The strip under the input that offers the one-time model download. */
const downloadOffer = (page: Page) => page.locator('[data-voice-notice="consent"]');

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, voiceModelReady: false });
});

test.afterAll(async () => {
  await launched.close();
});

test("first hold asks for download consent and declining leaves everything local and idle", async () => {
  const { page, userDataDir } = launched;
  // The WebGPU capability check is async at boot; retry the hold until the
  // shell is listening for it.
  await expect
    .poll(
      async () => {
        await page.keyboard.down(DICTATION_KEY);
        const visible = await downloadOffer(page)
          .isVisible()
          .catch(() => false);
        await page.keyboard.up(DICTATION_KEY);
        return visible;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  // No model on disk: the shell offers the one-time download rather than
  // silently fetching 1.6GB or pretending to listen.
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(downloadOffer(page)).toHaveCount(0);
  // Nothing downloaded.
  const modelsDir = join(userDataDir, "models");
  const modelFiles = (() => {
    try {
      return readdirSync(modelsDir, { recursive: true });
    } catch {
      return [];
    }
  })();
  expect(modelFiles).toHaveLength(0);
});

test("the one-row off switch releases the key and mic, and saves the chosen key across restart", async () => {
  let app = await launchApp({
    withMockProvider: true,
    voiceModelReady: false,
    useAppMediaPermissions: true,
  });
  const screenshot = async (name: string) => {
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR) {
      const row = app.page.locator('[data-setting="dictation"]');
      if (await row.isVisible())
        await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await app.page.screenshot({
        path: join(process.env.INFINITARY_TASK_EVIDENCE_DIR, name),
        animations: "disabled",
      });
    }
  };
  try {
    let page = app.page;
    await expect(
      page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER_SHORT)),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const row = page.locator('[data-setting="dictation"]');
    const sw = row.getByRole("switch", { name: "Dictation", exact: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await row.scrollIntoViewIfNeeded();
    await screenshot("dictation-on.png");
    await row.getByRole("button", { name: "Dictation key" }).click();
    await screenshot("dictation-picking.png");
    await page.keyboard.press("a");
    await expect(row.getByRole("button", { name: "Dictation key" })).toHaveText(
      DICTATION_KEY_PICKING,
    );
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button", { name: "Dictation key" })).toContainText(dictationCap());
    await row.getByRole("button", { name: "Dictation key" }).click();
    await page.keyboard.press("MetaRight");
    await expect(row.getByRole("button", { name: "Dictation key" })).toContainText(
      dictationCap("MetaRight"),
    );
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getDictation()))
      .toEqual({ enabled: true, key: "MetaRight" });
    await page.keyboard.press("Escape");
    await expect(
      page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER_SHORT, "MetaRight")),
    ).toBeVisible();
    await page.keyboard.press(DICTATION_KEY);
    await expect(downloadOffer(page)).toHaveCount(0);
    await page.keyboard.press("MetaRight");
    await expect(downloadOffer(page)).toBeVisible();
    await screenshot("dictation-new-key-offer.png");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(row.getByRole("button", { name: "Dictation key" })).toBeDisabled();
    await screenshot("dictation-off.png");
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder(STANDARD_PLACEHOLDER_NO_VOICE)).toBeVisible();
    const probe = await page.evaluate(async () => {
      const prevented = ["keydown", "keyup"].map((type) => {
        const event = new KeyboardEvent(type, {
          key: "Meta",
          code: "MetaRight",
          location: 2,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      let microphone = "opened";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => {
          track.stop();
        });
      } catch (error) {
        microphone = (error as DOMException).name;
      }
      return { prevented, microphone };
    });
    expect(probe.prevented).toEqual([false, false]);
    expect(probe.microphone).toBe("NotAllowedError");
    // Nothing under the input either: no download offer, no microphone line.
    await expect(page.locator("[data-voice-notice]")).toHaveCount(0);
    await screenshot("dictation-off-home.png");
    const { userDataDir } = app;
    await app.close();
    app = await launchApp({ userDataDir, withMockProvider: true, voiceModelReady: false });
    page = app.page;
    await expect(page.getByPlaceholder(STANDARD_PLACEHOLDER_NO_VOICE)).toBeVisible();
    expect(await page.evaluate(() => window.infinitary.settings.getDictation())).toEqual({
      enabled: false,
      key: "MetaRight",
    });
    await page.keyboard.press("MetaRight");
    await expect(downloadOffer(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Dictation", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(
      page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER_SHORT, "MetaRight")),
    ).toBeVisible();
    await page.keyboard.press("MetaRight");
    await expect(downloadOffer(page)).toBeVisible();
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "dictation-probe.json"),
        JSON.stringify(
          {
            ...probe,
            persisted: await page.evaluate(() => window.infinitary.settings.getDictation()),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await app.close();
  }
});

test("turning dictation off drops an active recording without losing typed text", async () => {
  const app = await launchApp({
    withMockProvider: true,
  });
  try {
    const { page } = app;
    const input = page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER_SHORT));
    await expect(input).toBeVisible();
    await input.fill(TYPED_DRAFT);
    await input.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, `${PASTED_FILE}\r\n`.repeat(21));
    const file = page.locator("[data-voice-input-paste]");
    await expect(file).toHaveCount(1);
    await expect(file).toContainText("file ·");
    // Keep the key down: a slow quick-press transport can otherwise become a hold release.
    await page.keyboard.down(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Dictation", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getDictation()))
      .toMatchObject({ enabled: false });
    await page.keyboard.up(DICTATION_KEY);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Abandon", exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder(STANDARD_PLACEHOLDER_NO_VOICE)).toHaveValue(TYPED_DRAFT);
    await expect(file).toHaveCount(1);
    await expect(file).toContainText(PASTED_FILE);
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR) {
      await page.screenshot({
        path: join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "dictation-dropped-recording.png"),
        animations: "disabled",
      });
    }
  } finally {
    await app.close();
  }
});
