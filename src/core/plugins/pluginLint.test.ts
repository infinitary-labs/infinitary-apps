import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { undeclaredIntegrationMessage } from "@shared/personal/manifest";
import { describe, expect, it } from "vitest";
import {
  formatPanelLint,
  lintPanelSources,
  type PanelSourceFile,
  panelLintRefused,
} from "./pluginLint";

/**
 * One fixture directory per rule (tests/fixtures/personal-lint/), each a
 * panel written the way an author actually gets that rule wrong. The lint
 * runs over the real files, so a rule that stops firing - or starts firing
 * on the clean panel - fails here.
 */

const FIXTURES = join(__dirname, "../../../tests/fixtures/personal-lint");

/** Every file of an extension, the manifest included: a title is copy too. */
function extension(name: string): PanelSourceFile[] {
  const dir = join(FIXTURES, name);
  return readdirSync(dir)
    .filter((file) => /\.(tsx?|json)$/.test(file))
    .map((file) => ({ path: file, text: readFileSync(join(dir, file), "utf8") }));
}

describe("refusals", () => {
  it("refuses an emoji in copy and in a panel title, and says what to do instead", () => {
    const findings = lintPanelSources(extension("emoji"));
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "manifest.json:3",
      "panel.tsx:6",
    ]);
    for (const finding of findings) {
      expect(finding.rule).toBe("emoji");
      expect(finding.severity).toBe("refuse");
      expect(finding.message).toContain("StatusDot");
    }
    expect(panelLintRefused(findings)).toBe(true);
  });

  it("refuses an external URL in the panel and allows the same fetch in server.ts", () => {
    const findings = lintPanelSources(extension("external-url"));
    const refusals = findings.filter((finding) => finding.rule === "external-url");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.file).toBe("panel.tsx");
    expect(refusals[0]?.message).toContain("server.ts");
    expect(findings.every((finding) => finding.file !== "server.ts")).toBe(true);
  });

  it("refuses a direct reach for the host bridge", () => {
    const findings = lintPanelSources(extension("host-bridge"));
    const bridge = findings.find((finding) => finding.rule === "host-bridge");
    expect(bridge?.severity).toBe("refuse");
    expect(bridge?.message).toContain("props");
  });

  // INF-2334 piece 1: a call the manifest does not name is refused in the
  // same words the integrations service answers at run time.
  it("refuses an integration call, event or connection the manifest does not name, in the service's words", () => {
    const findings = lintPanelSources(extension("undeclared-integration")).filter(
      (finding) => finding.rule === "undeclared-integration",
    );
    expect(
      findings.map((finding) => [finding.file, finding.line, finding.severity, finding.message]),
    ).toEqual([
      ["panel.tsx", 10, "refuse", undeclaredIntegrationMessage("github", { action: "write" })],
      [
        "panel.tsx",
        11,
        "refuse",
        undeclaredIntegrationMessage("github", { event: "workflow_run_finished" }),
      ],
      ["panel.tsx", 13, "refuse", undeclaredIntegrationMessage("calendar")],
    ]);
    // Without a manifest a panel names nothing, so its one call is refused too.
    const bare = extension("undeclared-integration").filter(
      (file) => file.path !== "manifest.json",
    );
    expect(
      lintPanelSources(bare).filter((finding) => finding.rule === "undeclared-integration"),
    ).toHaveLength(4);
  });

  it("refuses the host bridge under Infinitary's name for it as well", () => {
    const findings = lintPanelSources([
      {
        path: "panel.tsx",
        text: "export default function Panel() { return window.infinitary.version; }",
      },
    ]);
    expect(findings.find((finding) => finding.rule === "host-bridge")?.severity).toBe("refuse");
  });
});

describe("warnings name the nearest token", () => {
  it("leaves a short hex that is not a color alone", () => {
    // The clean fixture carries `#186` as a pull request number.
    expect(lintPanelSources(extension("clean"))).toEqual([]);
  });

  it("names the nearest color for a hex and for an rgba", () => {
    const findings = lintPanelSources(extension("raw-color")).filter(
      (finding) => finding.rule === "raw-color",
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.message).toContain("var(--accent)");
    expect(findings[1]?.message).toContain("var(--line-");
    expect(panelLintRefused(findings)).toBe(false);
  });

  it("names the nearest type step for a raw font size", () => {
    const finding = lintPanelSources(extension("raw-font-size")).find(
      (item) => item.rule === "raw-font-size",
    );
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("var(--text-sm)");
  });

  it("names the nearest radius and shadow for off-scale values", () => {
    expect(
      lintPanelSources(extension("off-scale-radius")).find(
        (finding) => finding.rule === "off-scale-radius",
      )?.message,
    ).toContain("var(--radius-m)");
    expect(
      lintPanelSources(extension("off-scale-shadow")).find(
        (finding) => finding.rule === "off-scale-shadow",
      )?.message,
    ).toContain("var(--shadow-2)");
  });

  it("warns once when a panel lights two accent families", () => {
    const findings = lintPanelSources(extension("two-accents")).filter(
      (finding) => finding.rule === "two-accents",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("var(--accent)");
    expect(findings[0]?.message).toContain("var(--hot)");
  });
});

describe("notes", () => {
  it("notes a list with no empty state", () => {
    const finding = lintPanelSources(extension("list-without-empty")).find(
      (item) => item.rule === "list-without-empty",
    );
    expect(finding?.severity).toBe("note");
    expect(finding?.message).toContain("Empty");
  });
});

describe("the findings a crewmate reads back", () => {
  it("leads with refusals and names file, line and rule", () => {
    const findings = lintPanelSources([
      ...extension("emoji").map((file) => ({ ...file, path: `emoji/${file.path}` })),
      ...extension("raw-color").map((file) => ({ ...file, path: `raw-color/${file.path}` })),
    ]);
    const text = formatPanelLint(findings);
    expect(text.split("\n")[0]).toMatch(/^refuse: emoji\/[a-z.]+:\d+ \[emoji\]/);
    expect(text).toContain("warn: raw-color/panel.tsx");
  });
});
