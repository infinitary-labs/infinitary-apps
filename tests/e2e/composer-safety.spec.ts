import { expect, type Page, test } from "@playwright/test";
import {
  CONVERSE_TEXT_MAX_CHARS,
  TURN_IMAGE_MAX_BYTES,
  TURN_IMAGES_MAX,
} from "../../src/shared/cards";
import { COMPOSER_NOTICE_WORDS } from "../../src/shared/composer";
import { parseServedInput } from "../../src/shared/servedFrame";
import { type LaunchedApp, launchApp } from "./launch";
import { PASTE_PICTURE_PNG_BASE64, pastePictures, promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";

/**
 * Nothing the captain typed or pasted disappears without being sent
 * (fm3000-multiline-input-s1, PR 1). Each test drives the real prompt and
 * reads what reached the provider: a draft the app refused is still in the
 * field, the quiet line under it says why, and the provider never saw it.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

/** Bodies that reached the provider carrying `marker`. */
function bodiesWith(marker: string): string[] {
  return (launched.mockProvider?.requestBodies() ?? []).filter((body) => body.includes(marker));
}

/**
 * How many of the captain's own messages in one request's conversation carry
 * `marker`, read from the served frame's typed origin. A wake that quotes the
 * captain (the answer-delivery retry) is not one of them.
 */
function captainMessagesWith(body: string, marker: string): number {
  return providerMessages(body)
    .filter((message) => message.role === "user")
    .flatMap((message) => parseServedInput(message.text) ?? [])
    .filter((segment) => segment.origin === "captain" && segment.body.includes(marker)).length;
}

/** Sends a short turn and waits until the provider has it, so everything before it has landed. */
async function sendAndAwait(page: Page, marker: string): Promise<void> {
  const input = promptInput(page);
  await input.fill(marker);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect.poll(() => bodiesWith(marker).length, { timeout: 30_000 }).toBeGreaterThan(0);
}

test("a draft over the limit stays in the field, says why, and never reaches the provider", async () => {
  const { page } = launched;
  const marker = "composer-safety over-limit draft";
  const draft = marker + " ".padEnd(CONVERSE_TEXT_MAX_CHARS + 1 - marker.length, "x");
  expect(draft.length).toBe(CONVERSE_TEXT_MAX_CHARS + 1);

  const input = promptInput(page);
  await input.fill(draft);
  await input.press("Enter");

  // Enter does nothing over the limit; the foot row says why, and the send
  // control is disabled (docs/composer.md, "Paste and limits").
  await expect(input).toHaveValue(draft);
  const hint = page.locator('[data-voice-input-hint="too-long"]');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(COMPOSER_NOTICE_WORDS["too-long"]);
  const send = page.locator("[data-voice-input-shell]").getByRole("button", { name: "Submit" });
  await expect(send).toBeDisabled();

  // A later turn reaches the provider; the long draft never did.
  await sendAndAwait(page, "composer-safety after the long draft");
  expect(bodiesWith(marker)).toEqual([]);
  await expect(page.locator("[data-composer-notice]")).toHaveCount(0);
});

test("a fifth pasted picture is refused while the other four stay and send", async () => {
  const { page } = launched;
  await pastePictures(
    promptInput(page),
    Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => ({ name: `shot-${i + 1}.png` })),
  );

  const chips = page.locator("[data-voice-input-attachment]");
  await expect(chips).toHaveCount(TURN_IMAGES_MAX);
  const notice = page.locator('[data-composer-notice="pictures-max"]');
  await expect(notice).toContainText(COMPOSER_NOTICE_WORDS["pictures-max"]);

  // One more paste on a full row is refused the same way.
  await pastePictures(promptInput(page), [{ name: "shot-6.png" }]);
  await expect(chips).toHaveCount(TURN_IMAGES_MAX);

  // The turn leaves with its words and all four pictures.
  const marker = "composer-safety four pictures";
  await sendAndAwait(page, marker);
  await expect(chips).toHaveCount(0);
  const [body = ""] = bodiesWith(marker);
  expect(body.split(PASTE_PICTURE_PNG_BASE64).length - 1).toBe(TURN_IMAGES_MAX);
});

test("a picture over the size cap is refused out loud, never dropped silently", async () => {
  const { page } = launched;
  await pastePictures(promptInput(page), [{ name: "huge.png", bytes: TURN_IMAGE_MAX_BYTES + 1 }]);

  const notice = page.locator('[data-composer-notice="picture-too-big"]');
  await expect(notice).toContainText(COMPOSER_NOTICE_WORDS["picture-too-big"]);
  await expect(page.locator("[data-voice-input-attachment]")).toHaveCount(0);
  await notice.getByRole("button").click();
  await expect(page.locator("[data-composer-notice]")).toHaveCount(0);
});

test("an Enter that confirms an input-method candidate never sends", async () => {
  const { page } = launched;
  const marker = "composer-safety composing";
  const input = promptInput(page);
  await input.fill(marker);

  // The candidate-confirming Enter (isComposing), and a keydown the input
  // method is still processing (keyCode 229).
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    await input.evaluate((field, init) => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
      );
    }, init);
    await expect(input).toHaveValue(marker);
  }

  // The captain's own Enter afterwards sends it, once.
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect.poll(() => bodiesWith(marker).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const counts = bodiesWith(marker).map((body) => captainMessagesWith(body, marker));
  expect(counts).toEqual(counts.map(() => 1));
});

test("whitespace alone shows no send control", async () => {
  const { page } = launched;
  const input = promptInput(page);
  // The send control, by its name: the shell's Add files button is always there.
  const send = page.locator("[data-voice-input-shell]").getByRole("button", { name: "Submit" });

  await input.fill("   ");
  await expect(send).toHaveCount(0);
  await input.fill("  a word  ");
  await expect(send).toHaveCount(1);
  await input.fill("");
  await expect(send).toHaveCount(0);
});
