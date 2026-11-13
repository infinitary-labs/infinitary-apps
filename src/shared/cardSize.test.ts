import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cardBodyMarkup } from "./cardBodyMarkup";
import { cardNavigationParts } from "./cardParts";
import { cardSizeParts, cardSizeRefusal, cardWindowLength } from "./cardSize";
import { servedNumber } from "./i18n/format";
import { cardFrameMountRequestSchema, FRAME_TEMPLATE_MAX_BYTES } from "./plugins/frameDocument";

/**
 * INF-3887 (captain: "prevent cards from being too large in the first
 * place"): the size check refuses exactly the cards the window would refuse,
 * so no card reaches the captain that cannot open, and none is refused that
 * would. The window is the card frame's mount schema; the body is real prose,
 * this project's card-authoring guide, under a scripted figure that sends the
 * card down the mounted path.
 */
const GUIDE = readFileSync(resolve("docs/card-authoring.md"), "utf8")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => `<p>${line.replace(/[<>&]/g, "")}</p>`);

const FIGURE = `<figure aria-label="A count"><svg viewBox="0 0 750 40"><text x="0" y="20">0</text></svg><script>document.querySelector("text").textContent = "1";</script></figure>`;

/**
 * A card of whole guide paragraphs under its figure and two headings, `length`
 * characters as the window receives it. A batch of paragraphs that would pass
 * the length is set aside for a smaller one, so any edit to the guide still
 * fills it; letters in the last paragraph pad it to the exact length.
 */
function cardOf(length: number): string {
  let body = `<h3>Why</h3>${FIGURE}<h3>After</h3>`;
  let n = 0;
  // Leave room for the padding paragraph's own markup.
  const room = () => length - cardWindowLength(`${body}<p></p>`);
  for (let target = room() / 2; room() > 600 && target >= 1; ) {
    let batch = "";
    let next = n;
    while (batch.length < target) batch += GUIDE[next++ % GUIDE.length];
    if (cardWindowLength(`${body}${batch}<p></p>`) > length) {
      target /= 2;
      continue;
    }
    body += batch;
    n = next;
    target = room() / 2;
  }
  return `${body}<p>${"a".repeat(room())}</p>`;
}

const windowOpens = (body: string) =>
  cardFrameMountRequestSchema.safeParse({
    kind: "card",
    title: "A card",
    theme: "dark",
    style: "",
    template: {
      html: cardBodyMarkup(
        body,
        cardNavigationParts(body).map((part) => part.start),
      ).html,
    },
  }).success;

describe("the card size check (INF-3887)", () => {
  it("opens a card at the window's limit and refuses one character more, as the window does", () => {
    const atLimit = cardOf(FRAME_TEMPLATE_MAX_BYTES);
    expect(cardWindowLength(atLimit)).toBe(FRAME_TEMPLATE_MAX_BYTES);
    expect(windowOpens(atLimit)).toBe(true);
    expect(cardSizeRefusal(atLimit)).toBeUndefined();

    const over = cardOf(FRAME_TEMPLATE_MAX_BYTES + 1);
    expect(windowOpens(over)).toBe(false);
    expect(cardSizeRefusal(over)).toBeDefined();
  });

  it("names the largest parts first and counts the rest together", () => {
    const over = cardOf(FRAME_TEMPLATE_MAX_BYTES + 1);
    const parts = cardSizeParts(over);
    expect(parts.map((part) => part.length)).toEqual(
      [...parts.map((part) => part.length)].sort((a, b) => b - a),
    );
    const refusal = cardSizeRefusal(over, "Shorten it.") ?? "";
    // Six parts by name, largest first, then one count for every other part.
    let at = refusal.indexOf("in characters: ");
    for (const part of parts.slice(0, 6)) {
      const next = refusal.indexOf(part.label, at + 1);
      expect(next, part.label).toBeGreaterThan(at);
      at = next;
    }
    const rest = parts.slice(6).reduce((sum, part) => sum + part.length, 0);
    expect(refusal).toMatch(
      new RegExp(`; ${parts.length - 6} smaller parts: ${servedNumber(rest)}\\. Shorten it\\.$`),
    );
  });
});
