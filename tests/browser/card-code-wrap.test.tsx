import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MAXIMIZE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody } from "./stack";
import { openWindow } from "./window";

const TITLE = "Commands to update a server to stable 0.8.10";

// A note an agent wrote: two commands longer than the card is wide, in a fold.
const BODY = `<p>Run these on the server.</p>
<details open><summary>Commands</summary>
<p>1. Download the package:</p>
<pre><code>curl -fLO https://github.com/infinitary-labs/infinitary-apps/releases/download/v0.8.10/infinitary-0.8.10-linux-amd64.deb</code></pre>
<p>2. Check it against the published SHA-256. Continue only if it says OK:</p>
<pre><code>printf '%s  %s\\n' 'c1391421ba483430d449252bdfcf01340c8793388a8566893af03b4aa6bc1f6e' 'infinitary-0.8.10-linux-amd64.deb' | sha256sum -c -</code></pre>
</details>`;

type Read = {
  frameWidth: number;
  pageOverflow: number;
  blocks: { line: string; whiteSpace: string; hidden: number }[];
};

/** What each pre block of the open card shows: its wrapping and how far its text runs past the frame's right edge. */
function readBlocks(): Read {
  const root = document.documentElement;
  const blocks = [...document.querySelectorAll("pre")].map((pre) => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const right = Math.max(...[...range.getClientRects()].map((rect) => rect.right));
    return {
      line: (pre.textContent ?? "").slice(0, 20),
      whiteSpace: getComputedStyle(pre).whiteSpace,
      hidden: Math.max(0, Math.round(right - root.clientWidth)),
    };
  });
  return {
    frameWidth: root.clientWidth,
    pageOverflow: root.scrollWidth - root.clientWidth,
    blocks,
  };
}

// The card frame does not scroll sideways, so a command wider than the frame
// is cut off with no way to read its end. Every command wraps instead.
function expectWrapped(read: Read): void {
  expect(read.blocks).toHaveLength(2);
  expect(read.pageOverflow).toBe(0);
  for (const block of read.blocks) {
    expect(block.whiteSpace, block.line).toBe("pre-wrap");
    expect(block.hidden, block.line).toBe(0);
  }
}

test("a long command wraps inside the card at its usual and maximized size", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, body: BODY }));
  // 1566 x 1032 points at 140 percent zoom: the window the bug was reported in.
  await page.viewport(1118, 737);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  await bodyDrawn(TITLE);

  expectWrapped(await inCardBody(TITLE, readBlocks));

  const button = page
    .getByRole("button", { name: MAXIMIZE_LABEL, exact: true })
    .query() as HTMLElement;
  button.focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => document.querySelector("[data-card-layer][data-card-maximized]") !== null)
    .toBe(true);
  expectWrapped(await inCardBody(TITLE, readBlocks));
});
