import { CONVERSE_TEXT_MAX_CHARS, TURN_IMAGE_MAX_BYTES, TURN_IMAGES_MAX } from "@shared/cards";
import { COMPOSER_NOTICE_WORDS } from "@shared/composer";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { base64, messageBox, pastePictures, picturePng } from "./prompt";
import { openWindow } from "./window";

/**
 * Nothing the captain typed or pasted disappears without being sent
 * (fm3000-multiline-input-s1, PR 1). The test drives the real message box
 * and reads what the window sent the core: a draft the app refused is still
 * in the field, the quiet line under it says why, and no turn carried it.
 * One window, as the captain keeps one: each part leaves the box empty.
 */

/** The turns the window sent whose words carry `marker`. */
function turnsWith(bridge: FakeBridge, marker: string) {
  return bridge
    .requests("inf:converse")
    .map(([turn]) => turn)
    .filter((turn) => (typeof turn === "string" ? turn : (turn.text ?? "")).includes(marker));
}

function field(): HTMLTextAreaElement {
  const box = messageBox();
  if (!box) throw new Error("The window drew no message box");
  return box;
}

/** The send control, by its name: the shell's Add files button is always there. */
const send = () =>
  page
    .elementLocator(document.querySelector("[data-voice-input-shell]") as HTMLElement)
    .getByRole("button", { name: "Submit" });

/** Sends a short turn and waits until the window has sent it. */
async function sendAndAwait(bridge: FakeBridge, marker: string): Promise<void> {
  await userEvent.fill(field(), marker);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => field().value).toBe("");
  await expect.poll(() => turnsWith(bridge, marker).length).toBe(1);
}

/** Two frames and a task later: what a key or paste started has drawn and sent. */
const settled = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))),
  );

const notices = () => document.querySelectorAll("[data-composer-notice]");
const chips = () => document.querySelectorAll("[data-voice-input-attachment]");

test("nothing typed or pasted in the message box disappears without being sent", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  bridge.answer("inf:converse", { ok: true });
  await openWindow(bridge);
  await expect.poll(() => messageBox()?.disabled).toBe(false);
  const png = await picturePng();

  // A draft over the limit stays in the field, says why, and is never sent.
  {
    const marker = "composer-safety over-limit draft";
    const draft = marker + " ".padEnd(CONVERSE_TEXT_MAX_CHARS + 1 - marker.length, "x");
    expect(draft.length).toBe(CONVERSE_TEXT_MAX_CHARS + 1);
    await userEvent.fill(field(), draft);
    await userEvent.keyboard("{Enter}");
    await settled();
    // Enter does nothing over the limit; the foot row says why, and the send
    // control is disabled (docs/composer.md, "Paste and limits").
    expect(field().value).toBe(draft);
    const hint = () => document.querySelector<HTMLElement>('[data-voice-input-hint="too-long"]');
    await expect.poll(() => hint()?.textContent).toContain(COMPOSER_NOTICE_WORDS["too-long"]);
    await expect.element(hint() as HTMLElement).toBeVisible();
    await expect.element(send()).toBeDisabled();
    // A later turn is sent; the long draft never was.
    await sendAndAwait(bridge, "composer-safety after the long draft");
    expect(turnsWith(bridge, marker)).toEqual([]);
    expect(notices()).toHaveLength(0);
  }

  // A fifth pasted picture is refused while the other four stay and send.
  {
    pastePictures(
      field(),
      png,
      Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => ({ name: `shot-${i + 1}.png` })),
    );
    await expect.poll(() => chips().length).toBe(TURN_IMAGES_MAX);
    const notice = () => document.querySelector('[data-composer-notice="pictures-max"]');
    await expect.poll(() => notice()?.textContent).toContain(COMPOSER_NOTICE_WORDS["pictures-max"]);
    // One more paste on a full row is refused the same way.
    pastePictures(field(), png, [{ name: "shot-6.png" }]);
    await expect.poll(() => chips().length).toBe(TURN_IMAGES_MAX);
    // The turn leaves with its words and all four pictures.
    const marker = "composer-safety four pictures";
    await sendAndAwait(bridge, marker);
    expect(chips()).toHaveLength(0);
    const [turn] = turnsWith(bridge, marker);
    const images = typeof turn === "object" ? (turn.images ?? []) : [];
    expect(images.map((image) => image.data)).toEqual(
      Array.from({ length: TURN_IMAGES_MAX }, () => base64(png)),
    );
  }

  // A picture over the size cap is refused out loud, never dropped silently.
  {
    pastePictures(field(), png, [{ name: "huge.png", bytes: TURN_IMAGE_MAX_BYTES + 1 }]);
    const notice = () =>
      document.querySelector<HTMLElement>('[data-composer-notice="picture-too-big"]');
    await expect
      .poll(() => notice()?.textContent)
      .toContain(COMPOSER_NOTICE_WORDS["picture-too-big"]);
    expect(chips()).toHaveLength(0);
    await userEvent.click(page.elementLocator(notice() as HTMLElement).getByRole("button"));
    await expect.poll(() => notices().length).toBe(0);
  }

  // An Enter that confirms an input-method candidate never sends.
  {
    const marker = "composer-safety composing";
    await userEvent.fill(field(), marker);
    // The candidate-confirming Enter (isComposing), and a keydown the input
    // method is still processing (keyCode 229).
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
      );
      // Read once the window has done what the key starts, a send included.
      await settled();
      expect(field().value).toBe(marker);
      expect(turnsWith(bridge, marker)).toEqual([]);
    }
    // The captain's own Enter afterwards sends it, once.
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => field().value).toBe("");
    await expect.poll(() => turnsWith(bridge, marker).length).toBe(1);
  }

  // Whitespace alone shows no send control.
  {
    const sendCount = () => send().elements().length;
    await userEvent.fill(field(), "   ");
    await expect.poll(sendCount).toBe(0);
    await userEvent.fill(field(), "  a word  ");
    await expect.poll(sendCount).toBe(1);
    await userEvent.fill(field(), "");
    await expect.poll(sendCount).toBe(0);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
