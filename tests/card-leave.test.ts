import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { cornerProblems } from "../scripts/card-leave";

const docs = readFileSync("docs/card-authoring.md", "utf8");

// INF-1879: future card work must use the same corner owner and dispatcher, not only the same glyph.
it("accepts the current shared corner and rejects a caller-owned close button", () => {
  const owner = readFileSync("src/renderer/src/design/cards/CardSize.tsx", "utf8");
  expect(
    cornerProblems({
      "src/renderer/src/design/cards/CardSize.tsx": owner,
      "docs/card-authoring.md": docs,
    }),
  ).toEqual([]);
  const oldCorner =
    '<CardCorner><IconButton label="Close" onClick={onClose}>{closeIcon}</IconButton></CardCorner>';
  expect(
    cornerProblems({
      "src/renderer/src/cards/NewCard.tsx": oldCorner,
      "docs/card-authoring.md": docs,
    }),
  ).toEqual([
    expect.stringContaining("CardCorner owns its button"),
    expect.stringContaining("leaving button belongs in CardCorner"),
  ]);
});

it("rejects a second close caller and out-of-order documentation through the lint interface", () => {
  const store = readFileSync("src/renderer/src/app/store.ts", "utf8");
  expect(
    cornerProblems({
      "src/renderer/src/app/store.ts": store,
      "src/renderer/src/cards/NewCard.tsx": 'window.infinitary.cards.close("plan");',
      "docs/card-authoring.md": docs,
    }),
  ).toEqual([
    expect.stringContaining("shell's card-leave dispatcher"),
    expect.stringContaining("one card-close dispatcher"),
  ]);
  expect(
    cornerProblems({
      "docs/card-authoring.md": docs.replace("| `note` | Put aside | read |\n", ""),
    }),
  ).toEqual([expect.stringContaining("corner rows must match")]);
});
