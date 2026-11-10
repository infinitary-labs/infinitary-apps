import { DomUtils, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecretChoices } from "./SecretChoices";

// Intent: the captain's INF-1109 Secrets UX request requires unmistakable
// identities. A permission must never appear to select a different secret.
const entries = [
  { ref: "website-production", label: "Website deployment", environment: "Production" },
  { ref: "website-production-mirror", label: "Website deployment", environment: "Production" },
  { ref: "website-staging", label: "Website deployment", environment: "Staging" },
];
function options(selected: string) {
  const html = renderToStaticMarkup(
    <select value={selected} onChange={() => {}}>
      <SecretChoices entries={entries} selected={selected} />
    </select>,
  );
  return DomUtils.getElementsByTagName("option", parseDocument(html), true).map((node) => ({
    ref: node.attribs.value,
    text: DomUtils.textContent(node),
    selected: "selected" in node.attribs,
  }));
}

describe("the permission's secret chooser", () => {
  it("distinguishes duplicate names and environments without changing the selected identity", () => {
    const shown = options("website-production-mirror");
    expect(shown).toHaveLength(entries.length);
    for (const entry of entries) {
      const row = shown.find((option) => option.ref === entry.ref);
      expect(row?.text).toContain(entry.label);
      expect(row?.text).toContain(entry.environment);
      expect(row?.text).toContain(entry.ref);
    }
    expect(shown.filter((option) => option.selected).map((option) => option.ref)).toEqual([
      "website-production-mirror",
    ]);
  });
  it("keeps an unavailable saved reference instead of displaying the first remaining secret", () => {
    const removed = "retired-website-credential";
    expect(options(removed).filter((option) => option.selected)).toEqual([
      { ref: removed, text: `Secret unavailable · ${removed}`, selected: true },
    ]);
  });
});
