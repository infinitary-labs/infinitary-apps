import { RISK_DIMENSIONS, RISK_WORDS, type RiskAssessment } from "@shared/risk";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RiskChart } from "./RiskChart";

type Node = {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

function all(node: Node, attribute: string, found: Node[] = []): Node[] {
  if (node.type === ElementType.Tag && node.attribs && attribute in node.attribs) found.push(node);
  for (const child of node.children ?? []) all(child, attribute, found);
  return found;
}

const RISK: RiskAssessment = {
  declared: {
    blast: { level: "high", why: "The stage, the store and every test that reads widths" },
    behavior: { level: "high", why: "Every card opens wider than before" },
    undo: { level: "medium", why: "Saved widths are rewritten by a migration" },
    evidence: { level: "medium", why: "Tests pass; the narrow window was not photographed" },
    sensitivity: { level: "medium", why: "Rewrites saved card widths" },
    novelty: { level: "medium", why: "A new width rule beside the old" },
    deps: { level: "low", why: "Nothing added" },
  },
};

describe("the risk chart", () => {
  const root = parseDocument(renderToStaticMarkup(<RiskChart risk={RISK} />)) as unknown as Node;

  it("draws one dot per dimension in the radar's order, each named by its level in words", () => {
    const dots = all(root, "data-risk-dot");
    expect(dots.map((dot) => dot.attribs?.["data-risk-dot"])).toEqual([...RISK_DIMENSIONS]);
    expect(dots.map((dot) => dot.attribs?.["data-risk-level"])).toEqual(
      RISK_DIMENSIONS.map((dimension) => RISK.declared[dimension].level),
    );
    // Each is a stop the keyboard reaches, with its words for a screen reader.
    expect(dots.every((dot) => dot.name === "button")).toBe(true);
    expect(dots[0]?.attribs?.["aria-label"]).toBe(
      `${RISK_WORDS.blast.label}: ${RISK_WORDS.blast.levels.high}`,
    );
  });

  it("shows no note and no label at rest, and no word sums it up", () => {
    expect(all(root, "data-risk-note")).toEqual([]);
    const labels = all(root, "data-risk-axis");
    expect(labels).toHaveLength(RISK_DIMENSIONS.length);
    expect(labels.every((label) => /opacity:\s*0/.test(label.attribs?.style ?? ""))).toBe(true);
    expect(all(root, "data-lit")).toEqual([]);
  });
});
