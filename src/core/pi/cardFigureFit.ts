// i18n-exempt: served to the agent that wrote the card, stays English
import { LABEL_FIT_DELIMITER, LABEL_FIT_END } from "@shared/labelFit";
import { ElementType, parseDocument } from "htmlparser2";
import { GLYPH_ADVANCES } from "./cardGlyphWidths.generated";
import { declaredSize } from "./cardLint";

/**
 * Send-time label fit (docs/card-authoring.md, "Type"): SVG text never wraps,
 * so a label longer than the box it starts in is drawn past that box's edge.
 * This measures each SVG text with the card font's own advances and names the
 * labels that cross, or come near, their box. It reads typed geometry only -
 * a rect's edges, a text's anchor, size and words - and never what a label
 * means. Its words are facts for the emit_card answer; no card is refused.
 */

/** Units of room a label keeps to its box's edge. A label this close spills at
 * some card widths and fits at others: Chromium sets small type a little
 * differently from one width to the next, by up to about 11 units. */
export const LABEL_EDGE_ROOM = 8;
/** Advance of a character outside U+0020..U+007E, in ems; those are rare in a figure. */
const OTHER_ADVANCE = 0.6;
/** The frame's `--text-sm`, the size SVG text draws at when nothing declares one. */
const FRAME_SVG_SIZE = 12.5;

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

type Box = { left: number; right: number; top: number; bottom: number };
type Style = { size: number; weight: number; anchor: "start" | "middle" | "end" };
type Run = { text: string; size: number; weight: number };
type Label = { text: string; x: number; y: number; width: number; anchor: Style["anchor"] };
type Spill = {
  text: string;
  room: number;
  edgeLeft: number;
  edgeRight: number;
  side: "left" | "right";
};

function number(value: string | undefined, fallback = 0): number {
  const first = value?.trim().split(/[\s,]+/)[0];
  const parsed = first === undefined || first === "" ? Number.NaN : Number(first);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function declared(node: Node, name: string): string | undefined {
  const attrs = node.attribs ?? {};
  const style = attrs.style?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1];
  return (style ?? attrs[name])?.trim();
}

function styleOf(node: Node, inherited: Style): Style {
  const size = declaredSize(node, inherited.size);
  const weight = declared(node, "font-weight");
  const anchor = declared(node, "text-anchor");
  return {
    size: Number.isFinite(size) ? size : inherited.size,
    weight:
      weight === "bold" ? 700 : weight && /^\d+$/.test(weight) ? Number(weight) : inherited.weight,
    anchor:
      anchor === "middle" || anchor === "end" || anchor === "start" ? anchor : inherited.anchor,
  };
}

type Glyph = { char: string; size: number; weight: number };

function glyphWidth({ char, size, weight }: Glyph): number {
  const table = GLYPH_ADVANCES[weight >= 600 ? 600 : 400] ?? [];
  const at = char.codePointAt(0) ?? 0;
  return (at >= 32 && at <= 126 ? (table[at - 32] ?? OTHER_ADVANCE) : OTHER_ADVANCE) * size;
}

/** The frame lays out SVG text with collapsed white space, trimmed at both ends. */
function collapsed(glyphs: Glyph[]): Glyph[] {
  const out: Glyph[] = [];
  for (const glyph of glyphs) {
    if (/\s/.test(glyph.char)) {
      if (out.length === 0 || /\s/.test(out.at(-1)?.char ?? "")) continue;
      out.push({ ...glyph, char: " " });
    } else out.push(glyph);
  }
  if (/\s/.test(out.at(-1)?.char ?? "")) out.pop();
  return out;
}

/**
 * A text's lines. A `tspan` that names its own x starts a line there, one
 * that names y or dy moves the line's baseline, and each line keeps the
 * anchor of the element that started it, as the browser lays it out.
 */
function labelsOf(node: Node, style: Style, at: { dx: number; dy: number }): Label[] {
  type Line = { x: number; y: number; anchor: Style["anchor"]; glyphs: Glyph[] };
  const attrs = node.attribs ?? {};
  const lines: Line[] = [
    {
      x: number(attrs.x) + number(attrs.dx) + at.dx,
      y: number(attrs.y) + number(attrs.dy) + at.dy,
      anchor: style.anchor,
      glyphs: [],
    },
  ];
  const add = (child: Node, inherited: Style): void => {
    if (child.type === ElementType.Text) {
      for (const char of child.data ?? "")
        lines.at(-1)?.glyphs.push({ char, size: inherited.size, weight: inherited.weight });
      return;
    }
    if (child.type !== ElementType.Tag || child.name?.toLowerCase() !== "tspan") return;
    const own = styleOf(child, inherited);
    const last = lines.at(-1);
    const rows = child.attribs?.y !== undefined || child.attribs?.dy !== undefined;
    if (
      child.attribs?.x === undefined &&
      rows &&
      last &&
      last.glyphs.every((glyph) => /\s/.test(glyph.char))
    ) {
      // The first run names its own row and keeps the text's x: no earlier
      // words sit in the old row, so the line itself moves.
      last.y =
        (child.attribs?.y !== undefined ? number(child.attribs.y) + at.dy : last.y) +
        number(child.attribs?.dy);
      last.anchor = own.anchor;
    }
    if (child.attribs?.x !== undefined) {
      const y = child.attribs.y !== undefined ? number(child.attribs.y) + at.dy : (last?.y ?? 0);
      lines.push({
        x: number(child.attribs.x) + number(child.attribs.dx) + at.dx,
        y: y + number(child.attribs.dy),
        anchor: own.anchor,
        glyphs: [],
      });
    }
    for (const grandchild of child.children ?? []) add(grandchild, own);
  };
  for (const child of node.children ?? []) add(child, style);
  return lines.flatMap(({ x, y, anchor, glyphs }) => {
    const kept = collapsed(glyphs);
    if (kept.length === 0) return [];
    return [
      {
        text: kept.map((glyph) => glyph.char).join(""),
        x,
        y,
        width: kept.reduce((sum, glyph) => sum + glyphWidth(glyph), 0),
        anchor,
      },
    ];
  });
}

/** A translate-only transform moves what it holds; any other is not measured. */
function moved(node: Node, at: { dx: number; dy: number }): { dx: number; dy: number } | undefined {
  const transform = node.attribs?.transform?.trim();
  if (!transform) return at;
  const match = /^translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)$/.exec(transform);
  if (!match) return undefined;
  return { dx: at.dx + Number(match[1]), dy: at.dy + Number(match[2] ?? 0) };
}

function spillsOf(svg: Node): Spill[] {
  const viewBox = (svg.attribs?.viewBox ?? svg.attribs?.viewbox)
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite) || (viewBox[2] ?? 0) <= 0) return [];
  const drawing: Box = {
    left: viewBox[0] ?? 0,
    right: (viewBox[0] ?? 0) + (viewBox[2] ?? 0),
    top: viewBox[1] ?? 0,
    bottom: (viewBox[1] ?? 0) + (viewBox[3] ?? 0),
  };
  const boxes: Box[] = [];
  const labels: Label[] = [];
  const walk = (node: Node, style: Style, at: { dx: number; dy: number }): void => {
    if (node.type !== ElementType.Tag) return;
    const name = node.name?.toLowerCase() ?? "";
    if (
      ["script", "style", "foreignobject", "svg", "defs", "symbol", "clippath", "mask"].includes(
        name,
      )
    )
      return;
    const place = moved(node, at);
    if (!place) return;
    const own = styleOf(node, style);
    if (name === "rect") {
      const width = number(node.attribs?.width);
      const height = number(node.attribs?.height);
      if (width > 0 && height > 0) {
        const left = number(node.attribs?.x) + place.dx;
        const top = number(node.attribs?.y) + place.dy;
        boxes.push({ left, right: left + width, top, bottom: top + height });
      }
      return;
    }
    if (name === "text") {
      labels.push(...labelsOf(node, own, place));
      return;
    }
    for (const child of node.children ?? []) walk(child, own, place);
  };
  // The frame's own SVG type size (docs/card-authoring.md, "Type"), unless the root says otherwise.
  // The frame's `svg` rule outranks a font-size attribute on the root, so only its inline style moves the
  // size; the root's other presentation attributes, an anchor or a weight, still reach its text.
  const { "font-size": _overridden, ...rootAttribs } = svg.attribs ?? {};
  const root = styleOf(
    { type: ElementType.Tag, attribs: rootAttribs },
    { size: FRAME_SVG_SIZE, weight: 400, anchor: "start" },
  );
  for (const child of svg.children ?? []) walk(child, root, { dx: 0, dy: 0 });

  const spills: Spill[] = [];
  for (const label of labels) {
    const holding = boxes
      .filter(
        (box) =>
          box.left <= label.x &&
          label.x <= box.right &&
          box.top <= label.y &&
          label.y <= box.bottom,
      )
      .sort(
        (a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top),
      );
    const edge = holding[0] ?? drawing;
    const left =
      label.anchor === "start"
        ? label.x
        : label.anchor === "middle"
          ? label.x - label.width / 2
          : label.x - label.width;
    const right = left + label.width;
    // A start-anchored label begins at its anchor, so only its end can cross.
    const rightRoom = edge.right - right;
    const leftRoom = label.anchor === "start" ? Number.POSITIVE_INFINITY : left - edge.left;
    if (Math.min(rightRoom, leftRoom) < LABEL_EDGE_ROOM) {
      const side = rightRoom <= leftRoom ? "right" : "left";
      spills.push({
        text: label.text,
        room: Math.min(rightRoom, leftRoom),
        edgeLeft: edge.left,
        edgeRight: edge.right,
        side,
      });
    }
  }
  return spills;
}

/** Every figure label whose measured words reach, or come within `LABEL_EDGE_ROOM` units of, its box's edge. */
export function figureLabelSpills(body: string): Spill[] {
  const found: Spill[] = [];
  const walk = (node: Node): void => {
    if (node.type !== ElementType.Tag) return;
    if (node.name?.toLowerCase() === "svg") {
      found.push(...spillsOf(node));
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of parseDocument(body).children as Node[]) walk(node);
  return found;
}

function spillWords(spill: Spill): string {
  const units = Math.abs(Math.round(spill.room));
  const right = spill.side === "right";
  const edge = Math.round(right ? spill.edgeRight : spill.edgeLeft);
  const quoted = spill.text.length > 48 ? `${spill.text.slice(0, 47)}...` : spill.text;
  const from = right ? "ends" : "starts";
  // i18n-exempt: served to the agent, stays English
  const where = `its box's ${right ? "right" : "left"} edge (${edge})`;
  // i18n-exempt: served to the agent, stays English
  return spill.room < 0
    ? `"${quoted}" ${from} ${units} units past ${where}`
    : `"${quoted}" ${from} ${units} units inside ${where}`;
}

/**
 * What the emit_card answer adds when a card's figure labels do not fit, or
 * nothing. A fact, never a refusal.
 */
export function figureLabelFacts(body: string): string {
  const spills = figureLabelSpills(body);
  if (spills.length === 0) return "";
  const listed = spills.map(spillWords).join("; ");
  const past = spills.filter((spill) => spill.room < 0).length;
  // i18n-exempt: served to the agent, stays English
  return `${LABEL_FIT_DELIMITER} SVG text does not wrap. Measured in the card font, ${past} of ${spills.length} flagged label${spills.length === 1 ? "" : "s"} ${past === 1 ? "runs" : "run"} past its box; the rest sit within ${LABEL_EDGE_ROOM} units of an edge, where the width of the card can tip them over: ${listed}. Shorten the label, widen the box, or draw the box as HTML, whose words wrap and whose height grows, ${LABEL_FIT_END}`;
}
