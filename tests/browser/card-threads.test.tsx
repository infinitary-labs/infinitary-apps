import { TURN_IMAGE_MAX_BYTES, TURN_IMAGES_MAX } from "@shared/cards";
import { COMPOSER_NOTICE_WORDS, type ComposerNotice } from "@shared/composer";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { pastePictures, picturePng } from "./prompt";
import { inShown, SHOWN_ENTRY } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Cards as threads (captain-approved 2026-09-20; R4 of
 * `fm3000-card-close-decision-model-s1`): the captain answers a card in
 * the reply row under it, with the main message's own limits. A reply
 * refuses pictures past the shared count and size and says so with the
 * shared notice, and it takes a second line without hiding the first. One
 * window with the first mate's own card: the pictures first, then the lines.
 */

const TITLE = "Two ways to phrase the welcome";
const ACTIONS = [
  { id: "chips-first", label: "Lead with the chips" },
  { id: "caption-first", label: "Lead with the caption", default: true as const },
];

/** The shown card's reply field. */
const replyField = () => inShown("[data-card-reply] textarea") as HTMLTextAreaElement;

/** The pictures waiting in the shown card's reply row. */
const replyPictures = () =>
  document.querySelectorAll(`${SHOWN_ENTRY} [data-card-reply] [data-card-reply-picture]`);

/** The reply row's notice of `kind`, or null while it says nothing of it. */
const replyNotice = (kind: ComposerNotice) =>
  document.querySelector<HTMLElement>(
    `${SHOWN_ENTRY} [data-card-reply] [data-composer-notice="${kind}"]`,
  );

test("a card reply refuses pictures past the shared limits with the shared notice, and takes multiple lines", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ title: TITLE, actions: ACTIONS })));
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  const png = await picturePng();

  // Section: a card reply refuses pictures beyond the shared limit and shows the shared notice.
  pastePictures(
    replyField(),
    png,
    Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => ({ name: `reply-${i}.png` })),
  );
  await expect.poll(() => replyPictures().length).toBe(TURN_IMAGES_MAX);
  await expect
    .poll(() => replyNotice("pictures-max")?.textContent)
    .toContain(COMPOSER_NOTICE_WORDS["pictures-max"]);
  await expect.element(replyNotice("pictures-max") as HTMLElement).toBeVisible();
  // The row remains capped when another picture is pasted later, too.
  pastePictures(replyField(), png, [{ name: "extra.png" }]);
  await expect.poll(() => replyPictures().length).toBe(TURN_IMAGES_MAX);
  // A picture past the shared size limit also refuses visibly in this field.
  pastePictures(replyField(), png, [{ name: "oversized.png", bytes: TURN_IMAGE_MAX_BYTES + 1 }]);
  await expect
    .poll(() => replyNotice("picture-too-big")?.textContent)
    .toContain(COMPOSER_NOTICE_WORDS["picture-too-big"]);
  await expect.element(replyNotice("picture-too-big") as HTMLElement).toBeVisible();
  expect(replyPictures()).toHaveLength(TURN_IMAGES_MAX);

  // The next section starts from an empty reply row, as on a card just shown.
  await userEvent.click(replyNotice("picture-too-big")?.querySelector("button") as HTMLElement);
  await expect.poll(() => replyNotice("picture-too-big")).toBeNull();
  for (let i = 0; i < TURN_IMAGES_MAX; i++)
    await userEvent.click(page.getByRole("button", { name: `Remove reply-${i}.png`, exact: true }));
  await expect.poll(() => replyPictures().length).toBe(0);

  // Section: a card reply takes multiple lines without hiding their text.
  await userEvent.click(replyField());
  await userEvent.keyboard("a");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await userEvent.keyboard("b");
  await expect.poll(() => replyField().value).toBe("a\nb");
  await expect
    .poll(() => replyField().scrollHeight <= replyField().clientHeight, {
      message: "both lines show",
    })
    .toBe(true);
  expect(bridge.requests("inf:cards:reply")).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
