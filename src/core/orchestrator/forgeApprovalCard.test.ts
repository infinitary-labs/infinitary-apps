import { type BuildRowAsk, buildRowChoiceOf, type ForgeWriteAsk } from "@shared/writeAsk";
import { ElementType, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { forgeApprovalCard } from "./forgeApprovalCard";

// Intent: INF-6426's approved plan, piece A. A Build row on the reader's
// approval card shows its title, the issue as a link, Reproduce first or Plan
// first, and its goal and why whole, with one choice whose default is Keep for
// later; the click reads that choice, and a row it carries no reading of keeps
// Keep for later.

const BUILD: BuildRowAsk = {
  id: "wa0123456789ab",
  kind: "build",
  place: "GitHub",
  issue: 7,
  issueUrl: "https://github.com/octo/meter/issues/7",
  start: "reproduce",
  title: "Meter shows a negative reading after midnight",
  goal: "The meter's daily reading never goes below zero when the day rolls over.",
  why: "The reporter sees -3 kWh on the first reading after midnight & the graph dips.",
  at: 1000,
};
const WRITE: ForgeWriteAsk = {
  id: "wa9999999999ab",
  kind: "github",
  host: "github.com",
  via: "project",
  place: "GitHub",
  method: "POST",
  path: "/repos/octo/meter/issues/7/comments",
  body: '{"body":"Thanks, we can reproduce this."}',
  at: 900,
};

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

function all(root: Node | undefined, test: (node: Node) => boolean): Node[] {
  const found: Node[] = [];
  const walk = (node: Node) => {
    if (node.type === ElementType.Tag && test(node)) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  if (root) walk(root);
  return found;
}
const parse = (html: string) => parseDocument(html) as unknown as Node;
const hasClass = (name: string) => (node: Node) =>
  (node.attribs?.class ?? "").split(" ").includes(name);
function textOf(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === ElementType.Text) return node.data ?? "";
  return (node.children ?? []).map(textOf).join("");
}

describe("the reader's approval card with a Build row", () => {
  it("draws the row whole with its choice set to Keep for later, outside the ticked writes", () => {
    const card = forgeApprovalCard([WRITE, BUILD], { id: "reader", title: "Triage the issues" });
    const doc = parse(card.body ?? "");
    const [row] = all(doc, (node) => node.attribs?.["data-inf-build-row"] === BUILD.id);
    expect(textOf(all(row, hasClass("inf-ask-name"))[0])).toBe(BUILD.title);
    const [link] = all(row, (node) => node.name === "a");
    expect(link?.attribs?.href).toBe(BUILD.issueUrl);
    expect(textOf(link)).toBe("Issue #7");
    expect(textOf(all(row, hasClass("inf-build-facts"))[0])).toBe("Issue #7 · Reproduce first");
    expect(all(row, (node) => node.name === "dd").map(textOf)).toEqual([BUILD.goal, BUILD.why]);
    const radios = all(row, (node) => node.attribs?.type === "radio");
    expect(
      radios.map((radio) => [
        radio.attribs?.name,
        radio.attribs?.value,
        "checked" in (radio.attribs ?? {}),
      ]),
    ).toEqual([
      [`inf-build-${BUILD.id}`, "start", false],
      [`inf-build-${BUILD.id}`, "later", true],
      [`inf-build-${BUILD.id}`, "skip", false],
    ]);
    expect(all(row, (node) => node.name === "label").map((label) => textOf(label).trim())).toEqual([
      "Start now",
      "Keep for later",
      "Don't file",
    ]);
    // The write keeps its tick and the tally counts it alone.
    expect(all(doc, hasClass("inf-ask"))).toHaveLength(1);
    expect(card.title).toBe("Allow writes on GitHub?");
    expect(
      all(all(doc, hasClass("inf-asks-buttons"))[0], (node) => node.name === "dt").map(textOf),
    ).toEqual(["Only this time", "Not now"]);
  });

  it("names the card for Build rows when it holds no write", () => {
    const card = forgeApprovalCard([BUILD], { id: "reader", title: "Triage the issues" });
    expect(card.title).toBe("File tasks from GitHub issues?");
    const doc = parse(card.body ?? "");
    expect(all(doc, hasClass("inf-asks-tally"))).toEqual([]);
    // No row has a tick, so the legend keeps only Not now's line.
    expect(
      all(all(doc, hasClass("inf-asks-buttons"))[0], (node) => node.name === "dt").map(textOf),
    ).toEqual(["Not now"]);
  });

  it("reads each row's pick from the click, and Keep for later where it carries none", () => {
    const field = `inf-build-${BUILD.id}`;
    expect(buildRowChoiceOf([{ name: field, values: ["start"] }], BUILD.id)).toBe("start");
    expect(buildRowChoiceOf([{ name: field, values: ["skip"] }], BUILD.id)).toBe("skip");
    expect(buildRowChoiceOf([{ name: field, values: ["merge"] }], BUILD.id)).toBe("later");
    expect(buildRowChoiceOf(undefined, BUILD.id)).toBe("later");
  });
});
