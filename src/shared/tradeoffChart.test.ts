import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { cardBodyMarkup } from "./cardBodyMarkup";
import { tradeoffProblem, tradeoffTables, withTradeoffCharts } from "./tradeoffChart";

// INF-5510's approved plan, piece 2: the app draws a review question's
// tradeoff table as a chart - a scatter for two headings, a small radar on
// each option for three or more (the captain's chart_layout radar-each) - and
// the card check refuses a chart missing the row of the option a question
// marks as built (INF-6293: a question need not offer one). The question below is
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

  it("draws a question that offers nothing as built, as a plan question does", () => {
    // INF-6293's approved plan: any card's question may carry the table, and
    // most plan questions offer no option for what the project does now. The
    // question and options are a real plan card's of November 2026 (what a
    // reset does with the old folder); the table is written under the shared
    // card rules.
    const body = `<fieldset><legend>What happens to the old folder after a reset?</legend>
<label><input type="radio" name="old_folder" value="delete" data-inf-recommended> Delete it right away</label>
<label><input type="radio" name="old_folder" value="keep-7-days"> Keep it hidden for 7 days, with Undo reset</label>
<label><input type="radio" name="old_folder" value="something-else" data-inf-write-in> Something else</label>
<table data-inf-tradeoff>
<tr><td></td><td>Security</td><td>User experience</td></tr>
<tr data-inf-option="delete"><td>Delete right away</td><td data-inf-level="high">nothing stays on disk</td><td data-inf-level="low">a mistaken reset is final</td></tr>
<tr data-inf-option="keep-7-days"><td>Keep 7 days</td><td data-inf-level="medium">sign-ins stay a week</td><td data-inf-level="high">Undo reset for a week</td></tr>
</table>
<p>I recommend deleting right away. It gives up undoing a mistaken reset.</p>
</fieldset>`;
    expect(tradeoffProblem(body)).toBeUndefined();
    expect(marks(withTradeoffCharts(body))).toEqual([
      { pick: "delete", current: false, recommended: true, x: "1", y: "3" },
      { pick: "keep-7-days", current: false, recommended: false, x: "3", y: "2" },
    ]);
  });

  it("marks each option of a checkbox question with a box, and of a radio question with a round ring", () => {
    // INF-6766's approved plan: the captain read a question that let them pick
    // several fixes as a single pick, because the chart drew its options with
    // the radio's round ring. The question is the real one from the velocity
    // review card of November 25, 2026, its labels cut to their bold lead.
    const body = `<fieldset>
<legend>Which fixes should the fleet build? They are ranked by the merge time they would have saved today. (required)</legend>
<label><input type="checkbox" name="fixes" value="run-reached-journeys" required data-inf-recommended> <strong>1. Have a crewmate run the journeys its change plainly reaches, once on GitHub&rsquo;s Linux machines, before its last push.</strong></label>
<label><input type="checkbox" name="fixes" value="window-methods-on-branch" data-inf-recommended> <strong>2. Run the journey that checks the exact list of the app window&rsquo;s methods in every branch&rsquo;s checks.</strong></label>
<label><input type="checkbox" name="fixes" value="fewer-linux-jobs"> <strong>3. Join the batch&rsquo;s short Linux jobs into fewer, longer ones, so a round wants about 21 GitHub machines instead of 28.</strong></label>
<label><input type="checkbox" name="fixes" value="start-inf-6744"> <strong>4. Start INF-6744 now, the task that keeps Mac journey checks running when GitHub lacks a Mac.</strong></label>
<label><input type="checkbox" name="fixes" value="other" data-inf-write-in> Something else</label>
<table data-inf-tradeoff>
<tr><td></td><th>Merge speed</th><th>Save crew time</th><th>Save cost</th></tr>
<tr data-inf-option="run-reached-journeys"><th>1. Run reached journeys</th><td data-inf-level="high">2 or 3 of 3 today</td><td data-inf-level="medium">a search and a request</td><td data-inf-level="medium">8 min of a machine each</td></tr>
<tr data-inf-option="window-methods-on-branch"><th>2. Window methods on every branch</th><td data-inf-level="medium">1 of 3 today</td><td data-inf-level="high">no repair crewmate</td><td data-inf-level="high">15 seconds a check</td></tr>
<tr data-inf-option="fewer-linux-jobs"><th>3. Fewer Linux jobs</th><td data-inf-level="low">no merge held</td><td data-inf-level="high">shorter waits</td><td data-inf-level="high">no new cost</td></tr>
<tr data-inf-option="start-inf-6744"><th>4. Start INF-6744 now</th><td data-inf-level="high">about 90 min on Nov 24</td><td data-inf-level="high">no runs again by hand</td><td data-inf-level="medium">not planned yet</td></tr>
</table>
<p>My pick is fixes 1 and 2: they cut batch holds, and give up about 8 minutes of a GitHub machine per reached change.</p>
</fieldset>`;
    const rings = (html: string) =>
      [...html.matchAll(/<i (data-inf-tradeoff-ring[^>]*)>/g)].map((m) => m[1]);
    expect(rings(withTradeoffCharts(body))).toEqual(Array(4).fill('data-inf-tradeoff-ring="box"'));
    expect(rings(withTradeoffCharts(question(THREE)))).toEqual(
      Array(3).fill("data-inf-tradeoff-ring"),
    );
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
