import { ElementType, parseDocument } from "htmlparser2";
import { escapeHtml } from "./cardBodyMarkup";
import { ELEMENT_TYPES, NON_COPY } from "./cardHeadings";
import { hasHook, hookValue } from "./codeNames";
import * as m from "./i18n/messages.generated.ts";

/**
 * The tradeoff chart (docs/card-authoring.md, "The tradeoff chart"; INF-5510's
 * plan, piece 2): a question's options weighed under a few headings, which the
 * author writes as a plain table marked `data-inf-tradeoff` and every reader -
 * the window, a view of another computer and the phone - draws when it builds
 * the body's markup (`withTradeoffCharts`, from `cardBodyMarkup`). Two
 * headings draw as one scatter; three or more draw a small radar on each
 * option. Up, right and outward are always more of a heading, so High is the
 * outer ring. Each option appears once on the chart, and a press on it picks
 * the question's own option, which stays the keyboard's way to pick. The
 * table the author wrote stays under the chart, folded.
 *
 * The author writes:
 *
 *   <table data-inf-tradeoff>
 *     <tr><th>Option</th><th>User experience</th><th>Ship fast</th></tr>
 *     <tr data-inf-option="keep"><th>Keep it</th>
 *       <td data-inf-level="high">one click</td><td data-inf-level="high">now</td></tr>
 *   </table>
 *
 * The first row names the headings; each later row names, by its value, the
 * option of the same question it stands for, then gives a level - high,
 * medium or low - in every heading's cell, with the author's few words. The
 * app draws each heading and option as written and reads no word of it.
 */

/** A cell's level, from least to most of what its heading names. */
export const TRADEOFF_LEVELS = ["low", "medium", "high"] as const;
export type TradeoffLevel = (typeof TRADEOFF_LEVELS)[number];

export type TradeoffRow = {
  /** The value of the question's option this row stands for. */
  option: string;
  words: string;
  levels: TradeoffLevel[];
  current: boolean;
  recommended: boolean;
  /**
   * Where the option's own label and control stand, and the label's words as
   * the author wrote them: the chart shows each option once, in those words,
   * and the label leaves view while its control stays the keyboard's way in.
   */
  placed?: { label: number; control: number; words: string };
};

export type TradeoffTable = {
  start: number;
  end: number;
  /**
   * Where the chart stands when it takes the options' place: before the first
   * option's own row in the element holding every option, so a row laid out
   * as a flex line, such as div.inf-row, never squeezes the chart beside it.
   */
  chartAt?: number;
  headings: string[];
  rows: TradeoffRow[];
};

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
  parent?: Node | null;
  startIndex?: number | null;
  endIndex?: number | null;
};

function isElement(node: Node): boolean {
  return ELEMENT_TYPES.has(node.type);
}

function tagOf(node: Node): string {
  return node.name?.toLowerCase() ?? "";
}

function words(node: Node): string {
  const collect = (each: Node): string => {
    if (each.type === ElementType.Text) return each.data ?? "";
    if (!isElement(each) || NON_COPY.has(tagOf(each))) return "";
    return (each.children ?? []).map(collect).join("");
  };
  return collect(node).replace(/\s+/g, " ").trim();
}

function descendants(node: Node, keep: (each: Node) => boolean, into: Node[] = []): Node[] {
  for (const child of node.children ?? []) {
    if (!isElement(child)) continue;
    if (keep(child)) into.push(child);
    descendants(child, keep, into);
  }
  return into;
}

/** A row's own cells, in order; a nested table's are not its own. */
function cellsOf(row: Node): Node[] {
  return (row.children ?? []).filter((child) => ["th", "td"].includes(tagOf(child)));
}

/** The rows of the table itself, through its thead, tbody and tfoot. */
function rowsOf(table: Node): Node[] {
  const rows: Node[] = [];
  for (const child of table.children ?? []) {
    const tag = tagOf(child);
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const row of child.children ?? []) if (tagOf(row) === "tr") rows.push(row);
    }
  }
  return rows;
}

/** The question a table weighs: its nearest fieldset, or the whole body. */
function questionOf(table: Node, root: Node): Node {
  for (let at = table.parent; at; at = at.parent) if (tagOf(at) === "fieldset") return at;
  return root;
}

function choicesIn(question: Node): Node[] {
  return descendants(question, (each) => {
    if (tagOf(each) !== "input") return false;
    const type = (each.attribs?.type ?? "").toLowerCase();
    return type === "radio" || type === "checkbox";
  });
}

type Read = { table?: TradeoffTable; problem?: string };

function labelOf(choice: Node, root: Node): Node | undefined {
  for (let at = choice.parent; at; at = at.parent) if (tagOf(at) === "label") return at;
  const id = choice.attribs?.id;
  if (!id) return undefined;
  return descendants(root, (each) => tagOf(each) === "label" && each.attribs?.for === id)[0];
}

/** A label's own markup, its control left out: the option's words as written. */
function labelWords(label: Node, html: string): string {
  return (label.children ?? [])
    .filter((child) => tagOf(child) !== "input")
    .map((child) => html.slice(child.startIndex ?? 0, (child.endIndex ?? -1) + 1))
    .join("")
    .trim();
}

function readTable(table: Node, root: Node, html: string): Read {
  const [header, ...body] = rowsOf(table);
  const headings = header ? cellsOf(header).slice(1).map(words) : [];
  if (headings.length < 2) {
    return {
      // i18n-exempt: a card check refusal served to the author model, never shown
      problem: `a <table data-inf-tradeoff> names ${headings.length} heading${headings.length === 1 ? "" : "s"} in its first row; it draws two or more: an empty first cell, then one cell per heading where the options differ.`,
    };
  }
  const question = questionOf(table, root);
  const choices = choicesIn(question);
  const rows: TradeoffRow[] = [];
  const labels: Node[] = [];
  for (const row of body) {
    const cells = cellsOf(row);
    const option = hookValue(row.attribs, "option");
    const shown = words(cells[0] ?? row);
    // i18n-exempt: names a row in a card check refusal served to the author model, never shown
    const name = shown || "a row";
    if (option === undefined) {
      return {
        // i18n-exempt: a card check refusal served to the author model, never shown
        problem: `the tradeoff row "${name}" names no option: put data-inf-option="<value>" on its <tr>, the value of the question's option it stands for.`,
      };
    }
    const choice = choices.find((each) => (each.attribs?.value ?? "on") === option);
    if (!choice) {
      return {
        // i18n-exempt: a card check refusal served to the author model, never shown
        problem: `the tradeoff row "${name}" names the option "${option}", which its question does not offer; data-inf-option holds the value of one of the question's own radios or checkboxes.`,
      };
    }
    const levelCells = cells.slice(1);
    if (levelCells.length !== headings.length) {
      return {
        // i18n-exempt: a card check refusal served to the author model, never shown
        problem: `the tradeoff row "${name}" has ${levelCells.length} level cell${levelCells.length === 1 ? "" : "s"} for ${headings.length} headings; give it one cell per heading after the option's words.`,
      };
    }
    const levels: TradeoffLevel[] = [];
    for (const cell of levelCells) {
      const level = hookValue(cell.attribs, "level")?.toLowerCase();
      if (!TRADEOFF_LEVELS.includes(level as TradeoffLevel)) {
        return {
          // i18n-exempt: a card check refusal served to the author model, never shown
          problem: `the tradeoff row "${name}" has a cell with no level; put data-inf-level="high", "medium" or "low" on every cell, high always the most of what its heading names.`,
        };
      }
      levels.push(level as TradeoffLevel);
    }
    const label = labelOf(choice, root);
    const written = label ? labelWords(label, html) : "";
    if (label && written) labels.push(label);
    rows.push({
      option,
      words: shown,
      levels,
      current: hasHook(choice.attribs, "current"),
      recommended: hasHook(choice.attribs, "recommended"),
      ...(label && written
        ? {
            placed: {
              label: label.startIndex ?? 0,
              control: choice.startIndex ?? 0,
              words: written,
            },
          }
        : {}),
    });
  }
  // A question need not offer what the project does now; one that does, by
  // marking an option's own input, gives that option its row.
  if (choices.some((choice) => hasHook(choice.attribs, "current"))) {
    if (!rows.some((row) => row.current)) {
      return {
        // i18n-exempt: a card check refusal served to the author model, never shown
        problem:
          "a <table data-inf-tradeoff> has no row for what the code does now: give the question's option marked data-inf-current its own row, so the captain sees what each way gains or gives up against it.",
      };
    }
  } else if (descendants(question, (each) => hasHook(each.attribs, "current")).length > 0) {
    return {
      // i18n-exempt: a card check refusal served to the author model, never shown
      problem:
        "a <table data-inf-tradeoff> sits in a question with no option marked data-inf-current: put data-inf-current on the <input> of what the code does now, never on its label, and give that option its own row.",
    };
  }
  return {
    table: {
      start: table.startIndex ?? 0,
      end: (table.endIndex ?? 0) + 1,
      headings,
      rows,
      ...(labels.length > 0 ? { chartAt: optionsStart(labels) } : {}),
    },
  };
}

/**
 * Where the first option's row starts inside the element holding every
 * option's label: the label itself when the labels sit side by side, or the
 * row around it, such as a div.inf-row holding its control and label.
 */
function optionsStart(labels: Node[]): number {
  const first = labels.reduce((a, b) => ((b.startIndex ?? 0) < (a.startIndex ?? 0) ? b : a));
  const holds = (at: Node, each: Node): boolean => {
    for (let up: Node | null | undefined = each; up; up = up.parent) if (up === at) return true;
    return false;
  };
  let row = first;
  while (row.parent && !labels.every((each) => holds(row.parent as Node, each))) row = row.parent;
  return row.startIndex ?? 0;
}

function readAll(html: string): Read[] {
  if (!html.includes("data-inf-tradeoff")) return [];
  const root = parseDocument(html, {
    decodeEntities: true,
    withStartIndices: true,
    withEndIndices: true,
  }) as unknown as Node;
  const tables = descendants(
    root,
    (each) => tagOf(each) === "table" && hasHook(each.attribs, "tradeoff"),
  );
  return tables.map((table) => readTable(table, root, html));
}

/** Every tradeoff table in a body that the app can draw, in order. */
export function tradeoffTables(html: string): TradeoffTable[] {
  return readAll(html).flatMap((read) => (read.table ? [read.table] : []));
}

/**
 * What is wrong with a body's tradeoff tables, for the card checks to refuse
 * (a product fact: the app draws only what it can place). It reads structure
 * alone - two headings or more, a row per option naming it, a level in every
 * cell, and a row for the option marked as what the code does now when the
 * question marks one - and never a heading's or option's words, nor which
 * kind of card holds it. Undefined when every table is sound.
 */
export function tradeoffProblem(body: string): string | undefined {
  return readAll(body).find((read) => read.problem)?.problem;
}

function rank(level: TradeoffLevel): number {
  return TRADEOFF_LEVELS.indexOf(level) + 1;
}

/** The marks the frame stylesheet and the form's own script read on an option's place on the chart. */
function pickAttributes(row: TradeoffRow): string {
  return ` data-inf-tradeoff-pick="${escapeHtml(row.option)}"${row.current ? " data-inf-tradeoff-current" : ""}${row.recommended ? " data-inf-tradeoff-recommended" : ""}`;
}

function optionWords(row: TradeoffRow, own: boolean): string {
  const shown = own && row.placed ? row.placed.words : escapeHtml(row.words);
  return `<i data-inf-tradeoff-ring></i><span data-inf-tradeoff-words>${shown}</span>`;
}

/** The radar's outer ring, in drawing units. */
const RADAR_RADIUS = 46;
/** How far a heading's name sits outside the outer ring. */
const LABEL_GAP = 8;
/** The width of one letter of an 11 px mono capital, rounded up. */
const LETTER_WIDTH = 6.8;

function round(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function radarSvg(headings: string[], levels: TradeoffLevel[]): string {
  const count = headings.length;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / count;
  const point = (i: number, r: number) => [Math.cos(angle(i)) * r, Math.sin(angle(i)) * r] as const;
  const polygon = (r: (i: number) => number) =>
    headings.map((_, i) => point(i, r(i)).map(round).join(",")).join(" ");
  let minX = -RADAR_RADIUS;
  let maxX = RADAR_RADIUS;
  let minY = -RADAR_RADIUS;
  let maxY = RADAR_RADIUS;
  const labels = headings.map((heading, i) => {
    const [x, y] = point(i, RADAR_RADIUS + LABEL_GAP);
    const cos = Math.cos(angle(i));
    const sin = Math.sin(angle(i));
    const anchor = Math.abs(cos) < 0.3 ? "middle" : cos > 0 ? "start" : "end";
    const baseline = sin < -0.3 ? y - 2 : sin > 0.3 ? y + 10 : y + 4;
    const width = heading.length * LETTER_WIDTH;
    const left = anchor === "middle" ? x - width / 2 : anchor === "start" ? x : x - width;
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, left + width);
    minY = Math.min(minY, baseline - 10);
    maxY = Math.max(maxY, baseline + 3);
    return `<text x="${round(x)}" y="${round(baseline)}" text-anchor="${anchor}">${escapeHtml(heading)}</text>`;
  });
  const rings = [1, 2, 3]
    .map(
      (k) => `<polygon data-inf-tradeoff-grid points="${polygon(() => (RADAR_RADIUS * k) / 3)}"/>`,
    )
    .join("");
  const spokes = headings
    .map((_, i) => {
      const [x, y] = point(i, RADAR_RADIUS);
      return `<line data-inf-tradeoff-grid x1="0" y1="0" x2="${round(x)}" y2="${round(y)}"/>`;
    })
    .join("");
  const reach = (i: number) => (RADAR_RADIUS * rank(levels[i] ?? "low")) / 3;
  const dots = headings
    .map((_, i) => {
      const [x, y] = point(i, reach(i));
      return `<circle data-inf-tradeoff-dot cx="${round(x)}" cy="${round(y)}" r="3"/>`;
    })
    .join("");
  const width = maxX - minX + 4;
  const height = maxY - minY + 4;
  return `<svg viewBox="${round(minX - 2)} ${round(minY - 2)} ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}" aria-hidden="true">${rings}${spokes}<polygon data-inf-tradeoff-shape points="${polygon(reach)}"/>${dots}${labels.join("")}</svg>`;
}

function radarChart(table: TradeoffTable, own: boolean): string {
  const tiles = table.rows
    .map(
      (row) =>
        `<div${pickAttributes(row)}>${radarSvg(table.headings, row.levels)}<p>${optionWords(row, own)}</p></div>`,
    )
    .join("");
  return `<div data-inf-tradeoff-chart="radar" aria-hidden="true">${tiles}</div>`;
}

/**
 * Two headings: one plane, the first heading up and the second across, each
 * option a mark in the cell its two levels name - a scatter on the three
 * levels the author gives. Cells are HTML so an option's words wrap.
 */
function scatterChart(table: TradeoffTable, own: boolean): string {
  const [up = "", across = ""] = table.headings;
  const cells: string[] = [];
  for (const y of [3, 2, 1]) {
    for (const x of [1, 2, 3]) {
      const here = table.rows.filter(
        (row) => rank(row.levels[0] ?? "low") === y && rank(row.levels[1] ?? "low") === x,
      );
      const marks = here
        .map((row) => `<div${pickAttributes(row)}>${optionWords(row, own)}</div>`)
        .join("");
      cells.push(
        `<div data-inf-tradeoff-cell data-inf-tradeoff-x="${x}" data-inf-tradeoff-y="${y}">${marks}</div>`,
      );
    }
  }
  return `<div data-inf-tradeoff-chart="scatter" aria-hidden="true"><div data-inf-tradeoff-axis="up">${escapeHtml(up)}</div><div data-inf-tradeoff-plane>${cells.join("")}</div><div data-inf-tradeoff-axis="across">${escapeHtml(across)}</div></div>`;
}

/** The mark that takes a charted option's label and control out of view. */
const CHARTED = " data-inf-tradeoff-charted";

/**
 * The markup with each sound tradeoff table drawn. When every option has a
 * label, each shows once: the chart stands where the first charted option's
 * label stood, in the labels' own words, and the labels and controls leave
 * view but stay in the form, the keyboard's way to each option. The table as
 * written stays in its place, in a fold. A table the card checks would refuse stays as
 * written, so an older card still reads.
 */
export function withTradeoffCharts(html: string): string {
  const tables = tradeoffTables(html);
  if (tables.length === 0) return html;
  const edits: { at: number; end: number; put: string }[] = [];
  for (const table of tables) {
    const own = table.rows.every((row) => row.placed);
    const chart = table.headings.length === 2 ? scatterChart(table, own) : radarChart(table, own);
    const written = html.slice(table.start, table.end);
    // i18n-exempt: markup around the catalog's words, not shown as typed
    const fold = `<details data-inf-tradeoff-table><summary>${escapeHtml(m.cardTradeoffTable())}</summary>${written}</details>`;
    if (!own) {
      edits.push({ at: table.start, end: table.end, put: `${chart}${fold}` });
      continue;
    }
    edits.push({ at: table.start, end: table.end, put: fold });
    const first = table.chartAt ?? Math.min(...table.rows.map((row) => row.placed?.label ?? 0));
    edits.push({ at: first, end: first, put: chart });
    for (const row of table.rows) {
      const marks = row.placed;
      if (!marks) continue;
      edits.push({
        at: marks.label + "<label".length,
        end: marks.label + "<label".length,
        put: CHARTED,
      });
      edits.push({
        at: marks.control + "<input".length,
        end: marks.control + "<input".length,
        put: CHARTED,
      });
    }
  }
  // From the end, so each edit's place still holds; a removal starting at a
  // place is made before an insertion there, which then stays.
  edits.sort((a, b) => b.at - a.at || b.end - b.at - (a.end - a.at));
  let out = html;
  for (const edit of edits) out = `${out.slice(0, edit.at)}${edit.put}${out.slice(edit.end)}`;
  return out;
}
