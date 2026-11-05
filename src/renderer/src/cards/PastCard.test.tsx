import type { PastCard } from "@shared/cards";
import { FRAME_ALLOW, FRAME_SANDBOX } from "@shared/plugins/containment";
import { HIDE_RECORD_LABEL } from "@shared/recordDrop";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PastCardColumn, PastThreadColumn, pastTime } from "./PastCard";

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node: Node): string {
  let text = "";
  walk(node, (n) => {
    if (n.type === ElementType.Text) text += n.data ?? "";
  });
  return text;
}

function find(root: Node, match: (node: Node) => boolean): Node[] {
  const found: Node[] = [];
  walk(root, (node) => {
    if (match(node)) found.push(node);
  });
  return found;
}

const past: PastCard = {
  id: "plan-1",
  taskId: "t1",
  author: "crewmate",
  title: "How to bring cards back",
  meta: "crewmate 18",
  body: "<p>The plan.</p>",
  actions: [
    { id: "not-now", label: "Not now" },
    { id: "keep", label: "Keep planning", variant: "ghost" },
    { id: "build", label: "Approve and build", default: true },
  ],
  ending: {
    how: "chose",
    at: Date.UTC(2026, 9, 2, 18, 14),
    actionId: "build",
    label: "Approve and build",
    by: "captain",
  },
  answers: [{ name: "q1", values: ["a"], changed: true }],
  messages: [{ id: 1, cardId: "plan-1", who: "captain", text: "for 5, yes", at: 1 }],
};

function column(card: PastCard): Node {
  return parseDocument(
    renderToStaticMarkup(<PastCardColumn past={card} theme="dark" width="100%" size="regular" />),
  ) as unknown as Node;
}

describe("a past card on the stage", () => {
  it("keeps the risk chart the merge card showed, at its title's top right (FI3-1128)", () => {
    const rating = { level: "medium", why: "One file" } as const;
    const risk = {
      declared: {
        blast: rating,
        behavior: rating,
        undo: rating,
        evidence: rating,
        sensitivity: rating,
        novelty: rating,
        deps: { level: "high", why: "Adds a parser" },
      },
    } as const;
    const root = column({ ...past, risk });
    const title = find(root, (n) => n.attribs?.["data-past-title"] !== undefined)[0] as Node;
    const chart = find(title, (n) => n.attribs?.["data-risk-chart"] !== undefined);
    expect(chart).toHaveLength(1);
    const dots = find(title, (n) => n.attribs?.["data-risk-dot"] !== undefined);
    expect(dots.map((dot) => dot.attribs?.["data-risk-level"])).toEqual([
      "medium",
      "medium",
      "medium",
      "medium",
      "medium",
      "medium",
      "high",
    ]);
    // A past card that showed none draws none.
    expect(find(column(past), (n) => n.attribs?.["data-risk-chart"] !== undefined)).toEqual([]);
  });

  it("draws the PAST strip with how it ended and a Hide that is its only control besides the footer", () => {
    const root = column(past);
    const strip = find(root, (n) => n.attribs?.["data-past-strip"] !== undefined)[0] as Node;
    expect(textOf(strip)).toContain("Past");
    expect(textOf(strip)).toContain("You chose Approve and build");
    expect(textOf(strip)).toContain(pastTime(past.ending.at));
    const hide = find(
      root,
      (n) => n.name === "button" && n.attribs?.["aria-label"] === HIDE_RECORD_LABEL,
    );
    expect(hide).toHaveLength(1);
  });

  it("shows every offered action disabled, with only the chosen one marked", () => {
    const root = column(past);
    const buttons = find(root, (n) => n.attribs?.["data-past-action"] !== undefined);
    expect(buttons.map((b) => b.attribs?.["data-past-action"])).toEqual([
      "keep",
      "not-now",
      "build",
    ]);
    for (const button of buttons) expect(button.attribs).toHaveProperty("disabled");
    const chosen = buttons.filter((b) => b.attribs?.["data-past-chosen"] !== undefined);
    expect(chosen.map((b) => textOf(b))).toEqual(["✓ Approve and build"]);
  });

  it("marks nothing when the card ended without a choice", () => {
    const root = column({ ...past, ending: { how: "dismissed", at: 1 } });
    expect(find(root, (n) => n.attribs?.["data-past-chosen"] !== undefined)).toEqual([]);
    expect(
      textOf(find(root, (n) => n.attribs?.["data-past-strip"] !== undefined)[0] as Node),
    ).toContain("Closed without choosing");
    for (const button of find(root, (n) => n.attribs?.["data-past-action"] !== undefined)) {
      expect(button.attribs).toHaveProperty("disabled");
    }
  });

  it("draws the body in a sandboxed frame and no reply row", () => {
    const html = renderToStaticMarkup(
      <PastCardColumn past={past} theme="dark" width="100%" size="regular" />,
    );
    const root = parseDocument(html) as unknown as Node;
    const frames = find(root, (n) => n.name === "iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.attribs?.sandbox).toBe(FRAME_SANDBOX);
    expect(frames[0]?.attribs?.allow).toBe(FRAME_ALLOW);
    expect(frames[0]?.attribs?.srcdoc ?? frames[0]?.attribs?.srcDoc).toContain("The plan.");
    expect(find(root, (n) => n.name === "textarea")).toEqual([]);
    expect(html).not.toContain("data-card-reply");
  });

  it("draws the thread read-only: its messages and no reply row or close", () => {
    const html = renderToStaticMarkup(<PastThreadColumn past={past} width={300} />);
    const root = parseDocument(html) as unknown as Node;
    expect(textOf(root)).toContain("for 5, yes");
    expect(
      find(root, (n) => n.name === "textarea" || n.name === "input" || n.name === "button"),
    ).toEqual([]);
  });
});
