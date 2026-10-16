import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { personalManifestSchema } from "@shared/personal/manifest";
import { describe, expect, it } from "vitest";
import { lintPanelSources, type PanelSourceFile } from "./pluginLint";

/**
 * The fixture extensions (tests/fixtures/personal-skills/), one per data skill,
 * run through the real lint. They are what a skill's reader would write, so a
 * skill that teaches something the lint refuses fails here - the two must
 * never disagree.
 */

const FIXTURES = join(__dirname, "../../../tests/fixtures/personal-skills");

function extensions(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every file of the extension, the manifest included: a title is copy too. */
function filesOf(id: string): PanelSourceFile[] {
  const dir = join(FIXTURES, id);
  return readdirSync(dir)
    .filter((file) => /\.(tsx?|json)$/.test(file))
    .map((file) => ({ path: file, text: readFileSync(join(dir, file), "utf8") }));
}

describe("the fixture extensions the skills teach", () => {
  it("parses every manifest", () => {
    for (const id of extensions()) {
      const manifest = personalManifestSchema.parse(
        JSON.parse(readFileSync(join(FIXTURES, id, "manifest.json"), "utf8")),
      );
      // A title is host chrome: sentence case, no emoji, and never the id.
      expect(manifest.title, id).toBeDefined();
      expect(manifest.title?.[0], id).toBe(manifest.title?.[0]?.toUpperCase());
    }
  });

  it("passes the lint with no findings at all", () => {
    for (const id of extensions()) {
      expect(lintPanelSources(filesOf(id)), id).toEqual([]);
    }
  });
});
