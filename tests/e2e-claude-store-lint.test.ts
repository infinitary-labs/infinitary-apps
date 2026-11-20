import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintClaudeStore } from "./lint/e2eClaudeStore";

/** INF-2394 measure 1: refuse the hand-composed seeds that made Claude journeys stale. */
function lint(source: string) {
  const dir = join(scratchDir("infinitary-claude-store-lint-"), "tests/e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "journey.spec.ts");
  writeFileSync(file, source);
  return lintClaudeStore([file]);
}

describe("the Claude store's fixture owner", () => {
  it("refuses both component seeds, including import aliases and namespace calls", () => {
    const findings = lint(`
import { seedClaudeCredentialFile as credentials } from "./mockClaudeClient";
seedSignedInClaudeStore(store);
credentials(store);
client.seedClaudeCredentialFile(store);
`);
    expect(findings.map(({ line }) => line)).toEqual([3, 4, 5]);
    expect(findings[0]?.message).toContain("launchSignedInClaude");
  });

  it("refuses direct paths, store aliases and asynchronous filesystem writes", () => {
    expect(
      lint(`
import { writeFileSync as write } from "node:fs";
const store = claudeDefaultStore(home);
const credential = join(store, ".credentials.json");
write(credential, payload);
fs.promises.writeFile(join(home, ".claude", "stub-credential"), "stub");
writeFileSync(\`\${home}/.claude/.credentials.json\`, payload);
`).map(({ line }) => line),
    ).toEqual([5, 6, 7]);
  });

  it("allows the owner, store reads and writes outside the Claude store", () => {
    expect(
      lint(`
prepareHome: signedInClaudeHome;
launchSignedInClaude(account, { userDataDir });
readFileSync(join(claudeDefaultStore(home), ".credentials.json"));
writeFileSync(join(userDataDir, "registry.json"), accounts);
writeFileSync(script, 'readFileSync(join(dir, ".credentials.json"))');
`),
    ).toEqual([]);
  });

  it("allows only adjacent, reasoned mutation exceptions, never an empty or file-wide waiver", () => {
    expect(
      lint(`
// e2e-claude-store: mutation -- reproduce an incomplete credential rewrite
writeFileSync(join(claudeDefaultStore(home), ".credentials.json"), "{incomplete");
writeFileSync(join(claudeDefaultStore(home), ".credentials.json"), "stub");
// e2e-claude-store: mutation --
seedClaudeCredentialFile(store);
`).map(({ line }) => line),
    ).toEqual([4, 6]);
  });
});
