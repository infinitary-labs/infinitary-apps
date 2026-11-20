import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintTypedWords, productWords, standInWords } from "./lint/e2eTypedWords";

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

  // INF-2417's ledger class "stand-in words typed": a journey typed the words its mock or
  // scenario authors (the spawn marker, a scenario's card title), so a rewording in the
  // stand-in left the journey asserting or sending the old words.
  it("refuses a spec's literal that copies a stand-in's exported words, wherever it stands", () => {
    const dir = join(scratchDir("infinitary-e2e-stand-in-words-"), "tests/e2e");
    mkdirSync(join(dir, "scenarios"), { recursive: true });
    const mock = join(dir, "mockProvider.ts");
    const scenario = join(dir, "scenarios/releaseCard.ts");
    const scenarioTest = join(dir, "scenarios/releaseCard.test.ts");
    writeFileSync(
      mock,
      [
        'export const SPAWN_PROMPT_MARKER = "commission a crewmate:";',
        'export const SHORT_MARKER = "Leave waiting";',
        'const UNEXPORTED = "Await the job queue";',
      ].join("\n"),
    );
    writeFileSync(scenario, "export const RELEASE_CARD_TITLE = `Merge the release pull request`;");
    writeFileSync(scenarioTest, 'export const OWN = "a unit test owns nothing here";');
    const standIns = standInWords([mock, scenario, scenarioTest]);
    expect([...standIns]).toEqual([
      ["commission a crewmate:", { name: "SPAWN_PROMPT_MARKER", file: mock }],
      ["Merge the release pull request", { name: "RELEASE_CARD_TITLE", file: scenario }],
    ]);
    const spec = join(dir, "journey.spec.ts");
    const helper = join(dir, "journeyHelper.ts");
    const body = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "await input.fill(`commission a crewmate: ${TITLE}`);",
      'const card = shownCard(page, "Merge the release pull request");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);",
      'await card.getByRole("button", { name: "Leave waiting" }).click();',
      'await card.getByRole("button", { name: "Await the job queue" }).click();',
      'test("commission a crewmate: and Merge the release pull request", async () => {});',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
      "await test.step(`commission a crewmate: ${TITLE}`, async () => {});",
      "// e2e-typed-words: the captain's own words, which only share the stand-in's",
      'await say(page, "please commission a crewmate: now");',
    ];
    const lines = (file: string, imports: string[]) => {
      writeFileSync(file, [...imports, ...body].join("\n"));
      return lintTypedWords([file], [], standIns).map((diagnostic) => diagnostic.line);
    };
    const marker = 'import { SPAWN_PROMPT_MARKER } from "./mockProvider";';
    const running = [marker, 'const { releaseCard } = await import("./scenarios/releaseCard");'];
    expect(lines(spec, running)).toEqual([3, 4]);
    // A spec that runs no such scenario typed its own words, which only share the scenario's.
    expect(lines(spec, [marker, ""])).toEqual([3]);
    expect(lines(helper, running)).toEqual([]);
  });

  it("sees no product words where there is no src/", () => {
    expect(productWords(join(scratchDir("infinitary-e2e-typed-words-none-"), "src"))).toEqual([]);
    expect(lint('const title = "Firstmate has used up its allowance";', [])).toEqual([]);
  });
});
