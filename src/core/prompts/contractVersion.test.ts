import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { FIRSTMATE_CONTRACT_VERSION } from "../pi/piResources";
import { contractRevisionFiles, contractRevisionsDir, contractVersionOf } from "./contractVersion";

function branchOfRevisions(...added: string[]): string {
  const dir = scratchDir("infinitary-contract-revisions-");
  cpSync(contractRevisionsDir(), dir, { recursive: true });
  for (const name of added) writeFileSync(join(dir, name), `# ${name}\n`);
  return dir;
}

describe("the contract version", () => {
  it("is 4.72 plus one for every revision file", () => {
    expect(contractVersionOf([])).toBe("4.72");
    expect(contractVersionOf(["pairing-actions.md"])).toBe("4.73");
    expect(contractVersionOf(["a.md", "b.md", "c.md"])).toBe("4.75");
  });

  it("counts neither the folder's README nor a file that is not Markdown", () => {
    const dir = branchOfRevisions("notes.txt");
    expect(contractRevisionFiles(dir)).not.toContain("README.md");
    expect(contractRevisionFiles(dir)).not.toContain("notes.txt");
    expect(contractVersionOf(contractRevisionFiles(dir))).toBe(FIRSTMATE_CONTRACT_VERSION);
  });

  it("serves the version its revision folder counts", () => {
    expect(FIRSTMATE_CONTRACT_VERSION).toBe(contractVersionOf(contractRevisionFiles()));
  });
});
