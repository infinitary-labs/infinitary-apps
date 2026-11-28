// i18n-exempt: served to the agent that wrote the card, stays English
import { ElementType, parseDocument } from "htmlparser2";
import { GLYPH_ADVANCES } from "./cardGlyphWidths.generated";

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
const MOST_LISTED = 5;

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
  const size = declared(node, "font-size");
  const px = size ? /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(size) : null;
  const weight = declared(node, "font-weight");
  const anchor = declared(node, "text-anchor");
  return {
    size: px ? Number(px[1]) : inherited.size,
    weight:
      weight === "bold" ? 700 : weight && /^\d+$/.test(weight) ? Number(weight) : inherited.weight,
    anchor:
      anchor === "middle" || anchor === "end" || anchor === "start" ? anchor : inherited.anchor,
  };
}

function runWidth(run: Run): number {
  const table = GLYPH_ADVANCES[run.weight >= 600 ? 600 : 400] ?? [];
  let ems = 0;
  for (const char of run.text) {
    const at = char.codePointAt(0) ?? 0;
    ems += at >= 32 && at <= 126 ? (table[at - 32] ?? OTHER_ADVANCE) : OTHER_ADVANCE;
  }
  return ems * run.size;
}

/** A text's lines: a `tspan` that names its own x starts a new line there. */
function labelsOf(node: Node, style: Style, at: { dx: number; dy: number }): Label[] {
  const attrs = node.attribs ?? {};
  const lines: { x: number; y: number; runs: Run[] }[] = [
    { x: number(attrs.x) + at.dx, y: number(attrs.y) + at.dy, runs: [] },
  ];
  const add = (child: Node, inherited: Style): void => {
    if (child.type === ElementType.Text) {
      lines
        .at(-1)
        ?.runs.push({ text: child.data ?? "", size: inherited.size, weight: inherited.weight });
      return;
    }
    if (child.type !== ElementType.Tag || child.name?.toLowerCase() !== "tspan") return;
    const own = styleOf(child, inherited);
    if (child.attribs?.x !== undefined) {
      const last = lines.at(-1);
      lines.push({
        x: number(child.attribs.x) + at.dx,
        y: child.attribs.y !== undefined ? number(child.attribs.y) + at.dy : (last?.y ?? 0),
        runs: [],
      });
    }
    for (const grandchild of child.children ?? []) add(grandchild, own);
  };
  for (const child of node.children ?? []) add(child, style);
  return lines.flatMap(({ x, y, runs }) => {
    const text = runs
      .map((run) => run.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return [];
    const spaced = runs.map((run) => ({ ...run, text: run.text.replace(/\s+/g, " ") }));
    const width = spaced.reduce((sum, run) => sum + runWidth(run), 0);
    return [{ text, x, y, width, anchor: style.anchor }];
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
  for (const child of svg.children ?? [])
    walk(child, { size: 12, weight: 400, anchor: "start" }, { dx: 0, dy: 0 });

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
    const base = { text: label.text, edgeLeft: edge.left, edgeRight: edge.right };
    if (edge.right - right < LABEL_EDGE_ROOM)
      spills.push({ ...base, room: edge.right - right, side: "right" });
    else if (label.anchor !== "start" && left - edge.left < LABEL_EDGE_ROOM)
      spills.push({ ...base, room: left - edge.left, side: "left" });
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
  const edge = spill.side === "right" ? spill.edgeRight : spill.edgeLeft;
  const where = spill.side === "right" ? "right" : "left";
  const quoted = spill.text.length > 48 ? `${spill.text.slice(0, 47)}...` : spill.text;
  // i18n-exempt: served to the agent, stays English
  return spill.room < 0
    ? `"${quoted}" ends ${units} units past its box's ${where} edge (${Math.round(edge)})`
    : `"${quoted}" ends ${units} units from its box's ${where} edge (${Math.round(edge)}), which spills at some card widths`;
}

/**
 * What the emit_card answer adds when a card's figure labels do not fit, or
 * nothing. A fact, never a refusal: the card is shown as written.
 */
export function figureLabelFacts(body: string): string {
  const spills = figureLabelSpills(body);
  if (spills.length === 0) return "";
  const listed = spills.slice(0, MOST_LISTED).map(spillWords).join("; ");
  // i18n-exempt: served to the agent, stays English
  const more = spills.length > MOST_LISTED ? `; and ${spills.length - MOST_LISTED} more` : "";
  // i18n-exempt: served to the agent, stays English
  return ` Label fit: SVG text does not wrap, and measured in the card font ${spills.length === 1 ? "this label does" : `${spills.length} labels do`} not fit its box with ${LABEL_EDGE_ROOM} units to spare: ${listed}${more}. Shorten the label, widen the box, or draw the box as HTML, whose words wrap and whose height grows, then revise the card; it was shown as written.`;
}
