import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MAXIMIZE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody } from "./stack";
import { openWindow } from "./window";

const TITLE = "Commands to update a server to stable 0.8.10";

// The last argument is one unbroken token wider than the card at both sizes, so only
// breaking inside a word can keep it whole.
const TOKEN = "a1b2c3d4e5f60718".repeat(14);
const BODY = `<p>Run this on the server.</p>
<details open><summary>Command</summary>
<pre><code>cd /tmp
  curl -fLO https://example.com/download/${TOKEN}</code></pre>
</details>`;

type Read = {
  frameWidth: number;
  pageOverflow: number;
  rows: number;
  hidden: number;
  ownRow: boolean;
  indented: boolean;
};

function readBlock(): Read {
  const root = document.documentElement;
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("pre") as HTMLElement);
  const rects = [...range.getClientRects()];
  const text = (document.querySelector("pre code") as HTMLElement).firstChild as Text;
  const first = document.createRange();
  first.setStart(text, text.data.indexOf("cd"));
  first.setEnd(text, text.data.indexOf("cd") + 2);
  const second = document.createRange();
  second.setStart(text, text.data.indexOf("curl"));
  second.setEnd(text, text.data.indexOf("curl") + 4);
  const [a, b] = [first.getBoundingClientRect(), second.getBoundingClientRect()];
  return {
    ownRow: b.top >= a.bottom - 1,
    indented: b.left > a.left + 5,
    frameWidth: root.clientWidth,
    pageOverflow: root.scrollWidth - root.clientWidth,
    rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
    hidden: Math.max(
      0,
      Math.round(Math.max(...rects.map((rect) => rect.right)) - root.clientWidth),
    ),
  };
}

// The card frame does not scroll sideways, so a command wider than the frame
// is cut off with no way to read its end. It wraps onto more rows instead,
// and the authored line break and indent stay.
function expectWhole(read: Read): void {
  expect(read.rows).toBeGreaterThan(2);
  expect(read.ownRow).toBe(true);
  expect(read.indented).toBe(true);
  expect(read.hidden).toBe(0);
  expect(read.pageOverflow).toBe(0);
}

test("a long command wraps inside the card at its usual and maximized size", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, body: BODY }));
  // 1566 x 1032 points at 140 percent zoom: the window the bug was reported in.
  await page.viewport(1118, 737);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  await bodyDrawn(TITLE);

  const usual = await inCardBody(TITLE, readBlock);
  expectWhole(usual);

  const button = page
    .getByRole("button", { name: MAXIMIZE_LABEL, exact: true })
    .query() as HTMLElement;
  button.focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => document.querySelector("[data-card-layer][data-card-maximized]") !== null)
    .toBe(true);
  const maximized = await inCardBody(TITLE, readBlock);
  expect(maximized.frameWidth).toBeGreaterThan(usual.frameWidth);
  expectWhole(maximized);
});
