import { describe, expect, it, vi } from "vitest";
import { figureLabelSpills } from "./cardFigureFit";
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

  it("reports the tighter edge of a centred label when both ends are within the margin", () => {
    // 25 letters "n" are 191.6 units wide. Centred at 98 in a box from 0 to 200,
    // the label runs 2.2 units from the left edge and 6.2 from the right.
    const body = `<svg viewBox="0 0 400 60"><rect x="0" y="0" width="200" height="60"/><text x="98" y="30" text-anchor="middle">${"n".repeat(25)}</text></svg>`;
    const [spill] = figureLabelSpills(body);
    expect(spill?.side).toBe("left");
    expect(spill?.room).toBeCloseTo(2.2, 0);
  });

  it("draws unsized text at the frame's 12.5 px, and sizes from the root, ems and a style", () => {
    // 18 letters "n" (0.613 em each, 11.03 em) from x=10 end at 147.9 drawn at 12.5 px
    // and at 142.4 at 12 px; the box edge at 154 leaves 6.1 units or 11.6.
    const text = "n".repeat(18);
    const at = (attrs: string, svgAttrs = ""): number | undefined =>
      figureLabelSpills(
        `<svg viewBox="0 0 750 60" ${svgAttrs}><rect x="0" y="0" width="154" height="60"/><text x="10" y="30" ${attrs}>${text}</text></svg>`,
      )[0]?.room;
    expect(at("")).toBeCloseTo(6.1, 0);
    expect(at('font-size="12"')).toBeUndefined();
    expect(at("", 'style="font-size: 16px"')).toBeLessThan(0);
    expect(at('style="font-size: 1.5em"')).toBeLessThan(0);
    expect(at('font-size="16"')).toBeLessThan(0);
  });

  it("splits a label at a tspan that names its own x, as the browser lays it out", () => {
    const body = `<svg viewBox="0 0 400 60"><rect x="0" y="0" width="200" height="60"/><text x="10" y="20" font-size="12.5">Short<tspan x="10" y="40">A second line that is far too long for this box</tspan></text></svg>`;
    expect(figureLabelSpills(body).map((spill) => spill.text)).toEqual([
      "A second line that is far too long for this box",
    ]);
  });

  it("trims a positioned tspan's indentation before measuring it", () => {
    // Ten letters "n" from x=100 end at 176.6 in a box to 200: 23.4 units of room. Counting
    // the five spaces of indentation (16 units) would leave 7.4, inside the margin.
    const body = `<svg viewBox="0 0 400 60"><rect x="0" y="0" width="200" height="60"/><text x="10" y="20">Fits<tspan x="100" dy="20">     ${"n".repeat(10)}</tspan></text></svg>`;
    expect(figureLabelSpills(body)).toEqual([]);
  });

  it("measures a first tspan that names its own row against the box in that row", () => {
    // The label (about 140 units wide) fits the wide box in the first row but not the 100-unit box below.
    const body = `<svg viewBox="0 0 400 130"><rect x="0" y="0" width="300" height="50"/><rect x="0" y="60" width="100" height="50"/><text x="10" y="30">\n      <tspan y="90">A label of moderate length</tspan>\n    </text></svg>`;
    expect(figureLabelSpills(body).map((spill) => [spill.text, spill.edgeRight])).toEqual([
      ["A label of moderate length", 100],
    ]);
    const moved = body.replace('y="90"', 'dy="60"');
    expect(figureLabelSpills(moved).map((spill) => spill.edgeRight)).toEqual([100]);
  });

  it("measures a tspan that names only a new row after words from where those words end", () => {
    // "Step one" fits the wide box above; the run below starts where it ends and passes the 100-unit box.
    const body = `<svg viewBox="0 0 400 130"><rect x="0" y="0" width="300" height="50"/><rect x="0" y="60" width="100" height="50"/><text x="10" y="30">Step one<tspan dy="60">A label of moderate length</tspan></text></svg>`;
    const spills = figureLabelSpills(body);
    expect(spills.map((spill) => [spill.text, spill.edgeRight])).toEqual([
      ["A label of moderate length", 100],
    ]);
    expect(
      figureLabelSpills(body.replace('dy="60"', 'y="90"')).map((spill) => spill.edgeRight),
    ).toEqual([100]);
  });

  it("takes the root's size from an inline style, not from a presentation attribute the frame overrides", () => {
    const at = (svgAttrs: string): number | undefined =>
      figureLabelSpills(
        `<svg viewBox="0 0 750 60" ${svgAttrs}><rect x="0" y="0" width="154" height="60"/><text x="10" y="30">${"n".repeat(18)}</text></svg>`,
      )[0]?.room;
    expect(at('font-size="32"')).toBeCloseTo(6.1, 0);
    expect(at('style="font-size: 32px"')).toBeLessThan(0);
  });

  it("keeps a root's text-anchor, which the frame does not override", () => {
    // 25 letters "n" (191.6 units) centred at 98 in a box from 0 to 200: 2.2 units from the left edge.
    const body = `<svg viewBox="0 0 400 60" text-anchor="middle"><rect x="0" y="0" width="200" height="60"/><text x="98" y="30">${"n".repeat(25)}</text></svg>`;
    expect(figureLabelSpills(body)[0]?.side).toBe("left");
  });
});

type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

async function sendThroughTool(
  body: string,
  onCard: () => string | { shown: string; line: string; bodyShown: boolean },
): Promise<string> {
  const tool = piToolOf(createEmitCardTool(onCard)) as unknown as Tool;
  const result = await tool.execute("t1", { title: "Repotting steps", body });
  return result.content[0]?.text ?? "";
}

describe("emit_card answer", () => {
  it("names every spilling label and every repair after the card is shown", async () => {
    const onCard = vi.fn(() => "card-fm-1-abc");
    const text = await sendThroughTool(stepsBody(), onCard);
    expect(text.startsWith("Card shown: Repotting steps (card-fm-1-abc)\n\nLabel fit:")).toBe(true);
    for (const label of [
      "The day before you start",
      "2 Loosen the roots (if root-bound)",
      "Tease them apart by hand",
      "Peat-free mix (any brand)",
      "6 Trim old roots (optional)",
    ])
      expect(text).toContain(`"${label}"`);
    // Chromium drew the long title 69 units past its box.
    const long = /"2 Loosen the roots \(if root-bound\)" ends (\d+) units past/.exec(text);
    expect(Math.abs(Number(long?.[1]) - 69)).toBeLessThanOrEqual(3);
    for (const repair of ["Shorten the label", "widen the box", "draw the box as HTML"])
      expect(text).toContain(repair);
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  it("names all seven spilling labels, with none dropped, after a blank line", async () => {
    const labels = Array.from(
      { length: 7 },
      (_, i) =>
        `<text x="${10 + i * 4}" y="${20 + i * 20}">A label far too long for its small box ${i}</text>`,
    ).join("");
    const body = `<svg viewBox="0 0 400 200"><rect x="0" y="0" width="100" height="200"/>${labels}</svg>`;
    const text = await sendThroughTool(body, () => "card-fm-1-abc");
    expect(text.split("\n\nLabel fit:")[0]).toBe("Card shown: Repotting steps (card-fm-1-abc)");
    for (let i = 0; i < 7; i++)
      expect(text).toContain(`"A label far too long for its small box ${i}"`);
    expect(text).toContain("7 of 7 flagged labels run past its box");
  });

  it("adds nothing for a card whose labels fit, or that has no figure", async () => {
    const short = STEPS.map(([, lines]): [string, string[]] => [
      "1  Water",
      lines.map((line) => line.slice(0, 12)),
    ]);
    expect(await sendThroughTool(stepsBody(short), () => "card-fm-1-abc")).toBe(
      "Card shown: Repotting steps (card-fm-1-abc)",
    );
    expect(await sendThroughTool("<p>No drawing here.</p>", () => "card-fm-1-abc")).toBe(
      "Card shown: Repotting steps (card-fm-1-abc)",
    );
  });

  it("adds the facts when a first mate's revision with a line did show the body", async () => {
    const text = await sendThroughTool(stepsBody(), () => ({
      shown: "card-fm-1-abc",
      line: "Your line is message 4.",
      bodyShown: true,
    }));
    expect(text).toContain("(card-fm-1-abc). Your line is message 4.\n\nLabel fit:");
  });

  it("adds nothing when the host answers with a thread line, which is not this body shown", async () => {
    const text = await sendThroughTool(stepsBody(), () => ({
      shown: "card-fm-1-abc",
      line: "Your reply was written on the card.",
      bodyShown: false,
    }));
    expect(text).toBe(
      "Card shown: Repotting steps (card-fm-1-abc). Your reply was written on the card.",
    );
  });
});
