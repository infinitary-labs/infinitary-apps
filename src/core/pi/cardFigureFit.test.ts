import { describe, expect, it, vi } from "vitest";
import { figureLabelFacts, figureLabelSpills } from "./cardFigureFit";
import { createEmitCardTool } from "./cardTool";
import { piToolOf } from "./toolSpec";

// The captain's report (a card whose step labels ran past their boxes) is
// rebuilt with made-up houseplant steps in the same geometry: 160-unit boxes
// in a 750-unit drawing, labels 12 units in, 13 and 12.5 unit type. Each
// expected end below was read from Chromium drawing that card in the app's
// own frame at 750 px (the browser-layer reproduction): units past the edge
// of the box the label starts in.
const STEPS: [string, string[]][] = [
  ["1  Water the plant", ["The day before you start"]],
  ["2  Loosen the roots (if root-bound)", ["Tease them apart by hand"]],
  ["3  Choose the new pot", ["Two to five cm wider"]],
  ["4  Add fresh soil", ["Peat-free mix (any brand)"]],
  ["5  Check the depth", []],
  ["6  Trim old roots (optional)", ["Cut only dead roots", "Healthy roots stay"]],
  ["7  Settle the plant", ["Press the soil down", "Water until it drains"]],
  ["8  Watch for a week", ["Keep out of direct sun", "Then feed monthly"]],
];

function stepsBody(steps = STEPS): string {
  const parts = steps
    .map(([head, lines], i) => {
      const x = 10 + (i % 4) * 190;
      const y = i < 4 ? 10 : 120;
      const h = i < 4 ? 70 : 90;
      const tx = x + 12;
      const rect = `<rect x="${x}" y="${y}" width="160" height="${h}" rx="8" fill="none"/>`;
      const title = `<text x="${tx}" y="${y + 26}" font-size="13">${head}</text>`;
      const rest = lines
        .map((line, n) => `<text x="${tx}" y="${y + 48 + n * 20}" font-size="12.5">${line}</text>`)
        .join("");
      return rect + title + rest;
    })
    .join("\n");
  return `<p>Repot the plant in eight steps.</p><figure aria-label="Eight steps"><svg viewBox="0 0 750 230" width="100%">${parts}</svg></figure>`;
}

describe("figureLabelSpills", () => {
  it("names the labels the browser drew past their boxes, with how far", () => {
    const spills = figureLabelSpills(stepsBody());
    expect(spills.map((spill) => spill.text)).toEqual([
      "The day before you start",
      "2 Loosen the roots (if root-bound)",
      "Tease them apart by hand",
      "Peat-free mix (any brand)",
      "6 Trim old roots (optional)",
    ]);
    // Chromium: +7, +69, +13, +11, +15 units past the edge at 750 px; the
    // width table agrees within 3 units.
    const past = spills.map((spill) => Math.round(-spill.room));
    [7, 69, 13, 11, 15].forEach((units, at) => {
      expect(Math.abs((past[at] ?? 0) - units)).toBeLessThanOrEqual(3);
    });
  });

  it("names nothing when every label sits well inside its box", () => {
    const short = STEPS.map(([, lines]): [string, string[]] => [
      "1  Water",
      lines.map((line) => line.slice(0, 12)),
    ]);
    expect(figureLabelSpills(stepsBody(short))).toEqual([]);
  });

  it("measures a label against the drawing's edge when no box holds it, and a centred one on both sides", () => {
    const body = `<svg viewBox="0 0 400 60"><text x="390" y="20">Past the drawing edge</text><text x="30" y="50" text-anchor="middle">A centred label that runs off the left</text></svg>`;
    expect(figureLabelSpills(body).map((spill) => [spill.text, spill.side])).toEqual([
      ["Past the drawing edge", "right"],
      ["A centred label that runs off the left", "left"],
    ]);
  });

  it("splits a label at a tspan that names its own x, as the browser lays it out", () => {
    const body = `<svg viewBox="0 0 400 60"><rect x="0" y="0" width="200" height="60"/><text x="10" y="20" font-size="12.5">Short<tspan x="10" y="40">A second line that is far too long for this box</tspan></text></svg>`;
    expect(figureLabelSpills(body).map((spill) => spill.text)).toEqual([
      "A second line that is far too long for this box",
    ]);
  });
});

describe("emit_card answer", () => {
  it("adds the label facts and the repairs after the card is shown", async () => {
    const onCard = vi.fn(() => "card-fm-1-abc");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>;
    };
    const result = await tool.execute("t1", { title: "Repotting steps", body: stepsBody() });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Card shown: Repotting steps (card-fm-1-abc) Label fit:");
    expect(text).toContain('"2 Loosen the roots (if root-bound)" ends 70 units past');
    expect(text).toContain("Shorten the label, widen the box");
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  it("adds nothing for a card with no figure", async () => {
    expect(figureLabelFacts("<p>No drawing here.</p>")).toBe("");
  });
});
