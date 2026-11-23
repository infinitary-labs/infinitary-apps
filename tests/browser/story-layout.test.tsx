import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, showCard, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * INF-467 direction B, and INF-706's approved table (the captain: "a table
 * format may work better, and before/after would be in the table header"):
 * real release-note pictures, two per state, stay whole; each view's caption
 * sits above its table, Before and After head their own columns, matching
 * pictures share a row, and a new view's table is headed New. A story saved
 * before the table keeps its old drawing. Publication itself is owned by
 * forge-signin.spec.ts; this owns the layout.
 */

const TABLE = "fix(cards): compare each view in one place";
const LEGACY = "fix(cards): compare each view in one place, as saved before the table";
const CAPTION = "The reply view in two themes";
const NEW_CAPTION = "The choice keys in two themes";
const VIEWS = [
  {
    caption: CAPTION,
    before: ["action-reply-line-dark", "action-reply-line-light"],
    after: ["anything-else-box-dark", "anything-else-box-light"],
  },
  {
    caption: NEW_CAPTION,
    before: [],
    after: ["card-choice-keys-dark", "card-choice-keys-light"],
    fresh: true,
  },
];

async function showDrawnCard(title: string): Promise<void> {
  await showCard(title);
  await bodyDrawn(title);
  await stageAtRest();
}

/** Returns once every picture in the card's body has decoded, so each holds its whole size. */
async function picturesDecoded(title: string): Promise<number> {
  return inCardBody(title, async () => {
    const images = [...document.images];
    await Promise.all(images.map((image) => image.decode()));
    if (!images.every((image) => image.naturalWidth > 0)) throw new Error("A picture is empty");
    return images.length;
  });
}

test("a saved story pairs the states of each view and preserves the old drawing", async () => {
  const bridge = fakeBridge(await seededHome({ legacy: LEGACY, table: TABLE, views: VIEWS }));
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(1280, 1800);
  await openWindow(bridge);

  // Section: the story saved before the table keeps its drawing, each
  // view's states one above the other.
  await showDrawnCard(LEGACY);
  expect(await picturesDecoded(LEGACY)).toBe(6);
  const [before, after] = await inCardBody(LEGACY, () =>
    [...document.images].map((image) => {
      const box = image.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  if (!before || !after) throw new Error("Missing comparison pictures");
  expect(before.bottom).toBeLessThanOrEqual(after.top);

  // Section: the table. Each view: its caption, then a table whose header
  // cells sit over their own pictures.
  await showDrawnCard(TABLE);
  expect(await picturesDecoded(TABLE)).toBe(6);
  const views = await inCardBody(
    TABLE,
    (captions) => {
      const placed = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const tables = [...document.querySelectorAll("table")];
      return {
        tables: tables.length,
        views: captions.map((text, index) => {
          const table = tables[index];
          if (!table) throw new Error(`No table for ${text}`);
          // The caption: the innermost element whose words are exactly the caption.
          const caption = [...document.querySelectorAll("body *")]
            .filter((element) => element.textContent?.trim() === text)
            .at(-1);
          return {
            caption: caption ? { text, box: placed(caption) } : null,
            headers: [...table.querySelectorAll("th")].map((header) => ({
              text: header.textContent,
              box: placed(header),
            })),
            rows: [...table.querySelectorAll("tr")]
              .filter((row) => row.querySelector("td"))
              .map((row) => [...row.querySelectorAll("img")].map(placed)),
            labels: table.querySelectorAll("figcaption").length,
          };
        }),
      };
    },
    [CAPTION, NEW_CAPTION],
  );
  expect(views.tables).toBe(2);
  expect(views.views.map((view) => view.caption?.text)).toEqual([CAPTION, NEW_CAPTION]);
  expect(views.views.map((view) => view.headers.map((header) => header.text))).toEqual([
    ["Before", "After"],
    ["New"],
  ]);
  expect(views.views.map((view) => view.labels)).toEqual([0, 0]);
  const [changed, fresh] = views.views;
  if (!changed || !fresh) throw new Error("Missing a view");
  expect(changed.rows).toHaveLength(2);
  for (const view of views.views) {
    const headerBottom = Math.max(...view.headers.map((header) => header.box.bottom));
    const captionBottom = view.caption?.box.bottom ?? Number.POSITIVE_INFINITY;
    // The caption ends before the header starts, so no header or tag covers it.
    for (const header of view.headers) expect(captionBottom).toBeLessThanOrEqual(header.box.top);
    for (const row of view.rows) {
      const [left, right] = row;
      if (!left || !right) throw new Error("A row is missing a picture");
      expect(left.top).toBe(right.top);
      expect(left.right).toBeLessThanOrEqual(right.left);
      expect(headerBottom).toBeLessThanOrEqual(left.top);
    }
  }
  const [beforeHeader, afterHeader] = changed.headers;
  if (!beforeHeader || !afterHeader) throw new Error("Missing a header");
  for (const [left, right] of changed.rows) {
    if (!left || !right) throw new Error("A row is missing a picture");
    for (const [picture, header] of [
      [left, beforeHeader],
      [right, afterHeader],
    ] as const) {
      expect(picture.left).toBeGreaterThanOrEqual(header.box.left);
      expect(picture.right).toBeLessThanOrEqual(header.box.right);
    }
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
