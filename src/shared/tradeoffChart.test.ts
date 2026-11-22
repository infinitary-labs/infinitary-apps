import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { cardBodyMarkup } from "./cardBodyMarkup";
import { tradeoffProblem, tradeoffTables, withTradeoffCharts } from "./tradeoffChart";

// INF-5510's approved plan, piece 2: the app draws a review question's
// tradeoff table as a chart - a scatter for two headings, a small radar on
// each option for three or more (the captain's chart_layout radar-each) - and
// the card check refuses a chart with no as-built row. The question below is
// a real one the captain answered on November 20 (which pages a kept browser
// sign-in keeps), as a reviewer wrote it under the marked-table rules.

const OPTIONS = `<label><input type="radio" name="via" value="as-built" required data-inf-current> Keep every page you open while you hold control <span class="inf-muted">no further change</span></label>
<label><input type="radio" name="via" value="redirects-only" required data-inf-recommended> Keep only pages the site sent you through, not ones you opened <span class="inf-muted">medium</span></label>
<label><input type="radio" name="via" value="site-only" required> Keep no extra pages, only the site itself <span class="inf-muted">small</span></label>
<label><input type="radio" name="via" value="something-else" data-inf-write-in> Something else</label>`;

const THREE = `<table data-inf-tradeoff>
<tr><th></th><th>Security</th><th>Reliability</th><th>Ship fast</th></tr>
<tr data-inf-option="as-built"><th>Keep every page</th><td data-inf-level="low">later tasks open your mail</td><td data-inf-level="high">every sign-in still works</td><td data-inf-level="high">ready now</td></tr>
<tr data-inf-option="redirects-only"><th>Only pages the site sent you through</th><td data-inf-level="high">pages you opened stay yours</td><td data-inf-level="high">every sign-in still works</td><td data-inf-level="medium">a medium change</td></tr>
<tr data-inf-option="site-only"><th>The site only</th><td data-inf-level="high">nothing extra is kept</td><td data-inf-level="low">sign-in through another service breaks</td><td data-inf-level="high">a small change</td></tr>
</table>`;

const question = (table: string) =>
  `<fieldset><legend>Which pages should stay signed in for later tasks along with the site?</legend>${OPTIONS}${table}<p>My pick: only pages the site sent you through.</p></fieldset>`;

/** The same question weighed under two headings: Security and Ship fast. */
const TWO = THREE.replace(/<th>Reliability<\/th>/, "").replace(
  /<td data-inf-level="(?:low|high)">(?:every sign-in still works|sign-in through another service breaks)<\/td>/g,
  "",
);

function parse(html: string) {
  return parseDocument(html) as unknown as { children: unknown[] };
}

function marks(
  html: string,
): { pick: string; current: boolean; recommended: boolean; x?: string; y?: string }[] {
  const found: { pick: string; current: boolean; recommended: boolean; x?: string; y?: string }[] =
    [];
  const walk = (
    node: { attribs?: Record<string, string>; children?: unknown[] },
    cell?: Record<string, string>,
  ) => {
    const attribs = node.attribs ?? {};
    const here = "data-inf-tradeoff-cell" in attribs ? attribs : cell;
    if ("data-inf-tradeoff-pick" in attribs) {
      found.push({
        pick: attribs["data-inf-tradeoff-pick"] ?? "",
        current: "data-inf-tradeoff-current" in attribs,
        recommended: "data-inf-tradeoff-recommended" in attribs,
        x: here?.["data-inf-tradeoff-x"],
        y: here?.["data-inf-tradeoff-y"],
      });
    }
    for (const child of node.children ?? []) walk(child as typeof node, here);
  };
  walk(parse(html));
  return found;
}

describe("a review question's tradeoff table", () => {
  it("draws a small radar on each option for three headings, each option once, with the table folded under it", () => {
    const body = question(THREE);
    const html = withTradeoffCharts(body);
    expect(html).toContain('<div data-inf-tradeoff-chart="radar" aria-hidden="true">');
    expect(marks(html)).toEqual([
      { pick: "as-built", current: true, recommended: false, x: undefined, y: undefined },
      { pick: "redirects-only", current: false, recommended: true, x: undefined, y: undefined },
      { pick: "site-only", current: false, recommended: false, x: undefined, y: undefined },
    ]);
    // One radar per option, each naming the three headings as written.
    expect(html.match(/<svg /g)).toHaveLength(3);
    expect(html.match(/>Reliability<\/text>/g)).toHaveLength(3);
    expect(html).toContain(
      `<details data-inf-tradeoff-table><summary>The tradeoff as a table</summary>${THREE}</details>`,
    );
    expect(html.indexOf("data-inf-tradeoff-chart")).toBeLessThan(
      html.indexOf("<details data-inf-tradeoff-table>"),
    );
  });

  it("shows each option once: the chart stands in the options' place in their own words, their rows out of view but still in the form", () => {
    // The captain, on the first take: "rendering the text version of the
    // selection and then radar version of the same choices feel odd?"
    const html = withTradeoffCharts(question(THREE));
    const charted = [
      ...html.matchAll(
        /<label data-inf-tradeoff-charted><input data-inf-tradeoff-charted type="radio" name="via" value="([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(charted).toEqual(["as-built", "redirects-only", "site-only"]);
    // The write-in is not on the chart and keeps its row, after the chart.
    expect(html).toContain(
      '<label><input type="radio" name="via" value="something-else" data-inf-write-in> Something else</label>',
    );
    expect(html.indexOf("data-inf-tradeoff-chart")).toBeLessThan(
      html.indexOf("<label data-inf-tradeoff-charted>"),
    );
    expect(html.indexOf('value="something-else"')).toBeLessThan(
      html.indexOf("<details data-inf-tradeoff-table>"),
    );
    // Each mark carries its label's words as written, the rough size included.
    expect(html).toContain(
      '<span data-inf-tradeoff-words>Keep only pages the site sent you through, not ones you opened <span class="inf-muted">medium</span></span>',
    );
  });

  it("stands outside an option's flex row, so the chart keeps the question's width", () => {
    // INF-6099's review card wrote each option as a control and a label
    // naming it in a div.inf-row; the chart drawn inside the first row was
    // squeezed beside it to about 115 px, its words broken a letter or two a line.
    const rows = `<div class="inf-row"><input type="radio" id="via-as-built" name="via" value="as-built" required data-inf-current><label for="via-as-built">Keep every page you open while you hold control <span class="inf-muted">no further change</span></label></div>
<div class="inf-row"><input type="radio" id="via-redirects" name="via" value="redirects-only" required data-inf-recommended><label for="via-redirects">Keep only pages the site sent you through, not ones you opened <span class="inf-muted">medium</span></label></div>
<div class="inf-row"><input type="radio" id="via-site" name="via" value="site-only" required><label for="via-site">Keep no extra pages, only the site itself <span class="inf-muted">small</span></label></div>
<div class="inf-row"><label><input type="radio" name="via" value="something-else" data-inf-write-in> Something else</label></div>`;
    for (const table of [TWO, THREE]) {
      const html = withTradeoffCharts(question(table).replace(OPTIONS, rows));
      const [chart] = DomUtils.findAll(
        (each) => "data-inf-tradeoff-chart" in each.attribs,
        parseDocument(html).children,
      );
      expect(chart?.parent && "name" in chart.parent ? chart.parent.name : undefined).toBe(
        "fieldset",
      );
      expect(html.indexOf("data-inf-tradeoff-chart")).toBeLessThan(html.indexOf('class="inf-row"'));
    }
  });

  it("reaches High at the outer ring, so a shape grows outward with more of a heading", () => {
    const html = withTradeoffCharts(question(THREE));
    const shapes = [...html.matchAll(/data-inf-tradeoff-shape points="([^"]+)"/g)].map((match) =>
      (match[1] ?? "").split(" ").map((pair) => Math.hypot(...pair.split(",").map(Number))),
    );
    const outer = Math.max(...shapes.flat());
    // As built: low security, high reliability, high ship fast.
    expect(shapes[0]?.map((r) => Math.round((3 * r) / outer))).toEqual([1, 3, 3]);
    // The recommended way: high, high, medium.
    expect(shapes[1]?.map((r) => Math.round((3 * r) / outer))).toEqual([3, 3, 2]);
  });

  it("draws one plane for two headings, the first up and the second across, each option in the cell its levels name", () => {
    const html = withTradeoffCharts(question(TWO));
    expect(html).toContain('<div data-inf-tradeoff-chart="scatter" aria-hidden="true">');
    expect(html).toContain('<div data-inf-tradeoff-axis="up">Security</div>');
    expect(html).toContain('<div data-inf-tradeoff-axis="across">Ship fast</div>');
    // y 3 is high security and x 3 high ship fast; cells read top row first.
    expect(marks(html)).toEqual([
      { pick: "redirects-only", current: false, recommended: true, x: "2", y: "3" },
      { pick: "site-only", current: false, recommended: false, x: "3", y: "3" },
      { pick: "as-built", current: true, recommended: false, x: "3", y: "1" },
    ]);
  });

  it("reaches every reader through the card's markup, as the window and the phone build it", () => {
    // The reader marks the question and each row as a part to jump to; the
    // chart is drawn over those marks all the same.
    const html = cardBodyMarkup(question(THREE)).html;
    expect(html).toContain('<fieldset data-inf-target="0">');
    expect(marks(html).map((mark) => mark.pick)).toEqual([
      "as-built",
      "redirects-only",
      "site-only",
    ]);
    expect(html).toContain(
      "<details data-inf-tradeoff-table><summary>The tradeoff as a table</summary><table data-inf-tradeoff",
    );
  });

  it("is sound for the card check when every row names its option and every cell its level", () => {
    expect(tradeoffProblem(question(THREE))).toBeUndefined();
    expect(tradeoffProblem(question(TWO))).toBeUndefined();
    expect(tradeoffTables(question(THREE))[0]?.headings).toEqual([
      "Security",
      "Reliability",
      "Ship fast",
    ]);
  });

  it("is refused with no row for what the code does now, and left undrawn", () => {
    const body = question(THREE.replace(/<tr data-inf-option="as-built">.*?<\/tr>\n/s, ""));
    expect(tradeoffProblem(body)).toContain("has no row for what the code does now");
    expect(withTradeoffCharts(body)).toBe(body);
  });

  it("names the misplaced mark when the as-built way is marked on its label, as a real reviewer wrote it", () => {
    const body = question(THREE).replace(
      '<label><input type="radio" name="via" value="as-built" required data-inf-current>',
      '<label data-inf-current><input type="radio" name="via" value="as-built" required>',
    );
    expect(tradeoffProblem(body)).toContain(
      "put data-inf-current on the <input> of what the code does now, never on its label",
    );
  });

  it.each([
    [
      "a cell with no level",
      THREE.replace('<td data-inf-level="medium">', "<td>"),
      "has a cell with no level",
    ],
    [
      "a row naming no option",
      THREE.replace(' data-inf-option="site-only"', ""),
      'the tradeoff row "The site only" names no option',
    ],
    [
      "a row naming an option the question does not offer",
      THREE.replace('data-inf-option="site-only"', 'data-inf-option="other"'),
      'names the option "other", which its question does not offer',
    ],
    [
      "one heading",
      THREE.replace(/<th>Reliability<\/th><th>Ship fast<\/th>/, ""),
      "names 1 heading in its first row",
    ],
  ])("is refused with %s", (_, table, words) => {
    expect(tradeoffProblem(question(table))).toContain(words);
  });
});
