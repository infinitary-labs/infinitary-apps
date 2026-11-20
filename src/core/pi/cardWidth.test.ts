import type { CardPicture } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { contentCardWidth, decidedCardWidth } from "./cardWidth";

/**
 * The width a card's body asks for (the captain's Q5 A of 2026-09-28): closed
 * facts the host reads off the markup and the verified pictures, then the
 * author's hint, which only widens.
 */

const ANSWER = "<p>The five-column table is the answer.</p>";

function table(columns: number, { header = false } = {}): string {
  const cell = header ? "th" : "td";
  const row = Array.from({ length: columns }, (_, i) => `<${cell}>c${i}</${cell}>`).join("");
  return `<table><tr>${row}</tr></table>`;
}

function picture(width: number, group = 0): CardPicture {
  return { id: `p${width}-${group}`, alt: "the meter row", width, height: 400, group };
}

describe("the width a card's body asks for", () => {
  it("keeps prose, small tables and short code regular, however long", () => {
    const essay = `${ANSWER}${"<p>A sentence of real prose that runs on.</p>".repeat(200)}`;
    expect(contentCardWidth(essay)).toBe("regular");
    expect(contentCardWidth(`${ANSWER}${table(3)}`)).toBe("regular");
    expect(contentCardWidth(`${ANSWER}<pre>${"x".repeat(60)}\nshort</pre>`)).toBe("regular");
    expect(decidedCardWidth({ body: essay })).toBeUndefined();
    expect(decidedCardWidth({ body: ANSWER })).toBe("regular");
  });

  it("stores narrow only for short plain visible copy, on every revision", () => {
    for (const body of [
      "<p>All set.</p>",
      "<h3>Done</h3><ul><li>A &amp; B</li></ul>",
      `<details><summary>Evidence</summary><p>${"x".repeat(1000)}</p></details>`,
    ]) {
      expect(decidedCardWidth({ body })).toBe("regular");
    }
    expect(decidedCardWidth({ body: `<p>${"x".repeat(599)}</p>` })).toBe("regular");
    expect(decidedCardWidth({ body: `<p>${"x".repeat(600)}</p>` })).toBeUndefined();
    expect(decidedCardWidth({ body: `<p>${"x".repeat(598)}<strong>x</strong></p>` })).toBe(
      "regular",
    );
    expect(decidedCardWidth({ body: `<p>${"&amp;".repeat(599)}</p>` })).toBe("regular");
    for (const extra of [
      '<svg viewBox="0 0 750 40"></svg>',
      '<img src="a">',
      table(2),
      "<pre>short code</pre>",
      '<fieldset><input name="answer"></fieldset>',
      "<details><summary>Evidence</summary><svg></svg></details>",
    ]) {
      expect(decidedCardWidth({ body: ANSWER + extra })).toBeUndefined();
    }
    expect(decidedCardWidth({ body: ANSWER, pictures: [picture(100)] })).toBeUndefined();
    expect(
      decidedCardWidth({
        body: `<details open><summary>Evidence</summary>${"x".repeat(600)}</details>`,
      }),
    ).toBeUndefined();
  });

  it("is wide for a table of four or five columns, full at six", () => {
    expect(contentCardWidth(`${ANSWER}${table(4)}`)).toBe("wide");
    expect(contentCardWidth(`${ANSWER}${table(5, { header: true })}`)).toBe("wide");
    expect(contentCardWidth(`${ANSWER}${table(6)}`)).toBe("full");
    // A spanning cell counts every column it spans.
    const spanned = '<table><tr><td colspan="3">a</td><td>b</td></tr></table>';
    expect(contentCardWidth(`${ANSWER}${spanned}`)).toBe("wide");
  });

  it("is wide for a code block whose longest line is over 60 characters", () => {
    const code = `<pre><code>short\n${"a".repeat(61)}\nshort</code></pre>`;
    expect(contentCardWidth(`${ANSWER}${code}`)).toBe("wide");
  });

  it("reads verified pictures by the size the host measured", () => {
    expect(contentCardWidth(ANSWER, [picture(899)])).toBe("regular");
    expect(contentCardWidth(ANSWER, [picture(900)])).toBe("wide");
    expect(contentCardWidth(ANSWER, [picture(640), picture(1600, 1)])).toBe("full");
  });

  it("is wide for a picture group of two or more, never for a lone picture's figure", () => {
    const group =
      '<figure class="inf-pictures"><img src="a.png" alt="a"><img src="b.png" alt="b"></figure>';
    expect(contentCardWidth(`${ANSWER}${group}`)).toBe("wide");
    const lone = '<figure class="inf-pictures"><img src="a.png" alt="a"></figure>';
    expect(contentCardWidth(`${ANSWER}${lone}`)).toBe("regular");
  });

  it("is wide for a preview body", () => {
    expect(contentCardWidth(`${ANSWER}<canvas width="120" height="40"></canvas>`)).toBe("wide");
    expect(contentCardWidth(`${ANSWER}<style>.x { color: red; }</style>`)).toBe("wide");
  });

  it("never reads a table or code inside a script or style as the body's", () => {
    const hidden = `<script>const t = "${table(8).replaceAll('"', "'")}";</script>`;
    // The script alone makes it a preview (wide), but not full.
    expect(contentCardWidth(`${ANSWER}${hidden}`)).toBe("wide");
  });

  it("lets the author's hint widen and never narrow", () => {
    expect(decidedCardWidth({ body: ANSWER, width: "wide" })).toBe("wide");
    expect(decidedCardWidth({ body: ANSWER, width: "full" })).toBe("full");
    expect(decidedCardWidth({ body: `${ANSWER}${table(6)}`, width: "wide" })).toBe("full");
    expect(decidedCardWidth({ body: `${ANSWER}${table(4)}` })).toBe("wide");
  });
});
