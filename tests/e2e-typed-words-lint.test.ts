import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintTypedWords, productWords } from "./lint/e2eTypedWords";

/**
 * Words come from their owner (docs/e2e-contracts.md): a spec reads the words
 * it expects from the module that owns them, and a fixture never re-types a
 * sentence or a contract version the product owns.
 */

/** The product's typed words, as `productWords` reads them from a scratch src/. */
function product(): string[] {
  const src = join(scratchDir("infinitary-e2e-typed-words-src-"), "src");
  mkdirSync(join(src, "renderer"), { recursive: true });
  writeFileSync(
    join(src, "devices.ts"),
    [
      "export const NO_WORK = 'It takes no new work until it is updated.';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "export const runningAs = (name: string) => `Running as ${name} on this Mac`;",
      "const seen = 'seen just now';",
    ].join("\n"),
  );
  writeFileSync(
    join(src, "renderer/Seat.tsx"),
    "export const Seat = () => <p>Firstmate has used up its allowance</p>;",
  );
  writeFileSync(join(src, "devices.test.ts"), "const pinned = 'Only a test types these words';");
  return productWords(src);
}

/** The lines the rule reports in `source`, as a spec under tests/e2e. */
function lint(
  source: string,
  words: readonly string[] = product(),
  name = "journey.spec.ts",
): number[] {
  const dir = join(scratchDir("infinitary-e2e-typed-words-"), "tests/e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, source);
  return lintTypedWords([file], words).map((diagnostic) => diagnostic.line);
}

describe("the e2e typed-words lint", () => {
  it("reads the product's strings, template parts and JSX text, not its tests", () => {
    expect(product().toSorted()).toEqual([
      "Firstmate has used up its allowance",
      "It takes no new work until it is updated",
      "on this Mac",
      "seen just now",
    ]);
  });

  it("refuses a text assertion that types three words or more, in every literal form", () => {
    const typed = [
      'await expect(row).toContainText("It takes no new work");',
      'await expect(row).not.toHaveText("seen just now");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "await expect(row).toContainText(`Remove ${name}? Its folder stays`);",
      "await expect(row).toHaveText(/^Revised .* · 2 parts new$/);",
      'await expect(rows).toHaveText(["Pick", "Pick the launch window"]);',
      'await expect(row).toContainText(("Keep my pasted file"));',
      "await expect(level).not.toHaveText(/premium|not in use|low/);",
    ];
    expect(lint(typed.join("\n"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps words read from their owner, and short words a spec types", () => {
    const owned = [
      "await expect(row).toContainText(NO_WORK);",
      'await expect(row).toContainText(runningAs("Builder"));',
      "await expect(card).toHaveText(TITLE);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "await expect(line).toHaveText(`${site} · ${DRIVER_WORDS.waiting}`);",
      'await expect(pill).toHaveText("FM3K-1 queued");',
      'await expect(row).toHaveAttribute("title", "Kept on this Mac for you");',
      'expect(prompt).toContain("Started git in this folder");',
      "await expect(row).not.toContainText(/GitHub|sign in/i);",
      "await expect(row).toHaveText(/^(?:\\d+) left$/);",
    ];
    expect(lint(owned.join("\n"))).toEqual([]);
  });

  it("refuses a fixture constant whose words the product types, and keeps the spec's own", () => {
    const fixtures = [
      'const NO_READER = "It takes no new work until it is updated.";',
      'const title = "Firstmate has used up its allowance";',
      'const NOTICE = "Work reads: It takes no new work until it is updated, for now";',
      "const BUILDER = /seen just now/;",
      'const TITLE = "Reconcile the walrus ledger";',
      'const SHORT = "Running as";',
      'const OWN = "Seen on this Mac today";',
    ];
    expect(lint(fixtures.join("\n"))).toEqual([1, 2, 3, 4]);
  });

  it("refuses a contract version typed as a number, and keeps a derived one and app versions", () => {
    const versions = [
      'run({ appVersion: "0.0.1", protocolVersion: "1.40.0" });',
      'const env = { INFINITARY_CONTRACT_VERSION: "3.0.0" };',
      'const CONTRACT_VERSION = "2.3.0";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "const env2 = { INFINITARY_CONTRACT_VERSION: `${newerMajor}.0.0` };",
      'const STABLE = "0.1.30";',
      'run({ appVersion: "0.0.1" });',
    ];
    expect(lint(versions.join("\n"))).toEqual([1, 2, 3]);
  });

  it("lets words that are not a copy say why, in their statement or on the line above it", () => {
    const waived = [
      "// e2e-typed-words: the frame's policy is stated independently of the code that sets it",
      'const POLICY = "It takes no new work until it is updated.";',
      'await expect(row).toHaveText("seen just now"); // e2e-typed-words: the subject is this build',
      "// e2e-typed-words:",
      'await expect(row).toHaveText("seen just now");',
      "// e2e-typed-words: the mock's own note, which only shares a phrase with the product's",
      "const NOTE =",
      '  "It takes no new work until it is updated.";',
      'const AFTER = "It takes no new work until it is updated.";',
    ];
    expect(lint(waived.join("\n"))).toEqual([5, 9]);
  });

  it("leaves a frame program's focused spec its program's words, and nothing else", () => {
    const source = [
      'await expect(scroll(page)).toContainText("No turns recorded yet");',
      'const title = "Firstmate has used up its allowance";',
    ].join("\n");
    expect(lint(source, product(), "observe-frame.spec.ts")).toEqual([2]);
    expect(lint(source, product(), "dev-observe.spec.ts")).toEqual([1, 2]);
  });

  it("sees no product words where there is no src/", () => {
    expect(productWords(join(scratchDir("infinitary-e2e-typed-words-none-"), "src"))).toEqual([]);
    expect(lint('const title = "Firstmate has used up its allowance";', [])).toEqual([]);
  });
});
