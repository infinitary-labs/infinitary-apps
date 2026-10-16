import { describe, expect, it } from "vitest";
import { knowledgeEnabled } from "./availability";

/**
 * Knowledge is enabled in every build, regardless of the reported version.
 */
describe("knowledgeEnabled", () => {
  it("turns knowledge on for development runs and for packaged alpha versions", () => {
    expect(knowledgeEnabled({ packaged: false, version: "0.1.30" })).toBe(true);
    expect(knowledgeEnabled({ packaged: false, version: "not a version" })).toBe(true);
    expect(knowledgeEnabled({ packaged: true, version: "0.1.30-alpha.3" })).toBe(true);
    expect(knowledgeEnabled({ packaged: true, version: "1.2.0-alpha.12" })).toBe(true);
  });

  it("includes stable regardless of the version spelling", () => {
    for (const version of [
      "0.1.30",
      "0.1.30-beta.1",
      "0.1.30-alpha",
      "0.1.30-alpha.x",
      "0.1.30-alpha.3+build.7",
      "0.1.30-alpha.3.1",
      "v0.1.30-alpha.3",
      "",
    ]) {
      expect(knowledgeEnabled({ packaged: true, version }), version).toBe(true);
    }
  });
});
