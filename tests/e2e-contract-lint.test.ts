import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintFrameActions } from "./lint/e2eFrameActions";

/**
 * The e2e assertion contract's lint (docs/testing.md, "The e2e assertion
 * contract"), driven through Biome itself: the plugins biome.json runs on
 * `pnpm check`, over a fixture spec. Each rule fires on the line that
 * breaks the contract, passes the line that keeps it, stays inside
 * tests/e2e, and reports an error: every rule's migration has landed.
 */

const RULES = {
  bareTag: "A bare-tag query",
  classSelector: "A class names a look",
  rect: "A box equal to a hard-coded rect",
  length: "A measured length or tolerance",
  gap: "A measured gap reconstructed",
  pixels: "A pixel toHaveCSS",
  layoutState: "A layout-state hook",
  modelId: "A model id typed into a spec",
  feedProse: "A feed line's composed words",
  // Not an assertion rule: where a spec keeps its evidence ("Per-run e2e evidence").
  evidencePath: "A fixed path in test-results/",
  typedKeys: "Keys typed before focus has landed",
  pose: "The first mate's pose reads idle",
  frameDoor: "A frame is read through the door",
  bareFocus: "A bare focus() returns before focus has landed",
  textLookup: "A page-wide lookup by typed words or a card's title",
  regionLookup: "A region found by its name across the page or the stage",
  msBudget: "A duration budget in an end-to-end spec",
} as const;
type Rule = keyof typeof RULES;

/**
 * One fixture line and the rule it should trip, or null when it keeps the
 * contract. The lines near each rule's edge hold INF-2138's faster rules to
 * what the rules caught before: a plain-text check runs ahead of each
 * pattern, so a line holding that text but not the pattern stays clean, and
 * a line the pattern takes is still refused.
 */
const FIXTURE: readonly (readonly [string, Rule | null])[] = [
  ['document.querySelector("input");', "bareTag"],
  ['document.querySelectorAll("svg circle");', "bareTag"],
  ["document.querySelector('[name=\"task-prompt\"]');", null],
  ['page.locator(".inf-fact");', "classSelector"],
  ["page.locator('.inf-fact[title=\"goes in on git.example.test\"]');", "classSelector"],
  ['frame.locator("[data-card] .fm-body", { hasText: "x" });', "classSelector"],
  ["page.locator('[title=\"goes in on git.example.test\"]');", null],
  ["page.locator('[data-fact=\"care\"]');", null],
  ["page.locator('[data-path=\"a.b\"]');", null],
  ["expect(fit.stage).toEqual({ x: 300, right: 660, width: 360 });", "rect"],
  ["expect(g.stage).toEqual({ x: railWidth, width: g.innerWidth - railWidth });", null],
  ['expect(g.rails[1]).toMatchObject({ side: "right", width: 0 });', null],
  ["expect(fit.rails).toEqual([300, 300]);", "length"],
  ["expect(frame?.height).toBe(320);", "length"],
  ["expect(wide.figure).toBeCloseTo(510, 0);", "length"],
  ["await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960);", "length"],
  ["expect(live.status).toBe(200);", null],
  ["expect(box.width).toBeGreaterThan(railWidth);", null],
  ["expect(box.width).toBeCloseTo(64, 0);", "length"],
  ["expect(box.height).toBeLessThan(32);", "length"],
  ["expect(frame.width).toBeLessThanOrEqual(measured + 20);", "length"],
  ["expect(box.width).toBeCloseTo(CARD_SIZES.regular, 0);", "length"],
  ["expect(box.height).toBe(MIN_HEIGHT);", "length"],
  ["expect(Math.abs(box.x - other.x)).toBeLessThan(1);", "gap"],
  ["const gap = Math.abs(after.offset - before.offset);", "gap"],
  ['await expect(rail).toHaveCSS("width", "0px");', "pixels"],
  ['await expect(rail).not.toHaveCSS("height", "32px");', "pixels"],
  ['await expect(rail).toHaveCSS("opacity", "1");', null],
  ['page.locator("html[data-rails-folded]");', "layoutState"],
  ['await expect(layer).toHaveAttribute("data-card-width", "wide");', "layoutState"],
  ['node.getAttribute("data-stage-rate");', "layoutState"],
  ['node.getAttribute("data-side-panel-size");', "layoutState"],
  ['page.locator("[data-side-panel=now]");', null],
  ["expect(elapsed).toBeLessThan(SETTLE_MS);", "msBudget"],
  ["expect(rows).toBeLessThan(MAX_ROWS);", null],
  ["await expectClearOf(page, summary, tile);", null],
  ["expect(within(box, container)).toEqual([]);", null],
  ["expect(new Set(seen).size).toBe(BACKLOG);", null],
  ["expect(new Set(seen).size).toBe(40);", null],
  ["expect(image.naturalWidth).toBe(48);", null],
  ["expect(count).toBe(20);", null],
  ["expect(status).toBe(200);", null],
  ["const delta = Math.abs(red - blue);", null],
  ["expect(box.width).toBe(1_000);", "length"],
  ["expect(toolbar.left).toBe(-24);", "length"],
  ['await expect(rail).toHaveCSS("width", "auto");', null],

  ['export const SEAT = { provider: "anthropic-claude", id: "claude-sonnet-5-5" };', "modelId"],
  ['await expect(page.getByRole("button", { name: /gpt-5\\.5/ })).toBeVisible();', "modelId"],
  ["const row = `openai-codex/gpt-6-sol`;", "modelId"],
  ['const stubs = ["claude-stub", "grok-live-token", "mock-1"];', null],
  ['const id = "Claude-Opus-5-5";', "modelId"],
  ['const hint = "gpt-five";', null],
  ['await expect(feedLine(page, "meterlab ship · reported: done")).toBeVisible();', "feedProse"],
  ["await expect(feedLine(page, /meterlab ship · reported: Intent:/)).toBeVisible();", "feedProse"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ["await expect(feedLine(page, `${TITLE} · started`)).toBeVisible();", "feedProse"],
  ['await expect(feedLine(page, "Captain: hello there")).toBeVisible();', "feedProse"],
  ["await expect(feedLine(page, /^Firstmate moved to Codex/)).toBeVisible();", "feedProse"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ["await expect(feedLine(page, `${MOCK_PANEL_TITLE} removed`)).toBeVisible();", "feedProse"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ['await expect(feedLine(page, new RegExp(`chose "${LABEL}"`))).toBeVisible();', "feedProse"],
  ["await expect(feedLine(page, TITLE)).toBeVisible();", null],
  ["await expect(feedLine(page, new RegExp(MOCK_FOLLOWUP_TITLE))).toBeVisible();", null],
  ['await expect(feedLine(page, ACTIONS.theme.done({ theme: "light" }))).toBeVisible();', null],
  [
    'await expect(feedLineOf(page, { type: "user_turn", text: "hello there" })).toBeVisible();',
    null,
  ],
  ["await expect(reportLine(page, key)).toHaveCount(1);", null],
  ['await page.screenshot({ path: "test-results/screens/autonomy-on-card.png" });', "evidencePath"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ['writeFileSync(`test-results/custom-api/${protocol}-wire.json`, "{}");', "evidencePath"],
  ['mkdirSync(join("test-results", "screens"), { recursive: true });', "evidencePath"],
  ['await page.screenshot({ path: test.info().outputPath("autonomy-on-card.png") });', null],
  ['await page.screenshot({ path: "./test-results/card.png" });', "evidencePath"],
  ['const kept = "artifacts/test-results/card.png";', null],
  ['await page.keyboard.type("history");', "typedKeys"],
  ['await app.page.keyboard.insertText("look:\\n```ts");', "typedKeys"],
  ['await keyboard.type("sam@example.com");', "typedKeys"],
  ['await typeInto(find, "history");', null],
  ['await typeInto(input, "look:", { insert: true });', null],
  ['await page.keyboard.press("Enter");', null],
  ['await field.pressSequentially("history");', null],
  ['await keyboardSettings(page).search.type("keyboard");', null],
  ['await expect(page.getByRole("img", { name: "First mate - idle" })).toBeVisible();', "pose"],
  ['await expect(character).toHaveAttribute("aria-label", /First mate - working/);', "pose"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ["const pose = `First mate - ${state}`;", "pose"],
  ["await waitForFirstmateIdle(page);", null],
  ['await askFirstmate(page, "hello there");', null],
  ['const character = page.getByRole("img", { name: /^First mate - / });', null],
  ['const label = "Firstmate - working";', "pose"],
  ['const heading = "First mate - Idle";', null],
  ["const frame = page.frameLocator(selector);", "frameDoor"],
  ["const body = scope.contentFrame();", "frameDoor"],
  ["const element = page.locator('iframe[title=\"Observe\"]');", "frameDoor"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ["const panel = page.locator(`${PANEL} iframe`);", "frameDoor"],
  ['const body = cardBody(page, "Observe");', null],
  ['const hooks = page.locator("[data-iframes]");', null],
  ["const element = frameIn(panel);", null],
  ["await target.focus();", "bareFocus"],
  ["await page.getByRole('button').focus();", "bareFocus"],
  ["await focusOn(target);", null],
  ['await pressKey(target, "Enter");', null],
  ["await page.evaluate(() => field.focus());", null],
  ['await expect(page.getByText("Quay surveyed", { exact: true })).toBeVisible();', "textLookup"],
  ["await expect(app.page.getByText(/^\\d \\/ 4$/)).toBeVisible();", "textLookup"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal, as source text.
  ["await expect(page.getByText(`Add the ${title} panel?`)).toBeVisible();", "textLookup"],
  ["await expect(page.getByText(MOCK_ANSWER_CARD_TITLE)).toHaveCount(0);", "textLookup"],
  [
    "await expect(launched.page.getByText(card.title, { exact: true })).toBeVisible();",
    "textLookup",
  ],
  ["await expect(page.getByText(MOCK_FM_CHAT_TEXT)).toHaveCount(0);", null],
  ['await expect(row.getByText("Checked", { exact: true })).toBeVisible();', null],
  ["await expect(shownCard(page, MOCK_ANSWER_CARD_TITLE)).toBeVisible();", null],
  ["await expect(pager(page, 4)).toBeVisible();", null],
  [
    'await expect(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();',
    "regionLookup",
  ],
  ['shownEntry(page).getByRole("region", { name: "The chosen plan" });', "regionLookup"],
  ['page.locator(SHOWN_ENTRY).getByRole("region", { name, exact: true });', "regionLookup"],
  ['const highlights = body.getByRole("region", { name: "Highlights" });', null],
  ['await expect(page.getByRole("button", { name: "Close" })).toBeVisible();', null],
];

type Diagnostic = {
  severity: string;
  message: string;
  location: { path: string; start: { line: number } };
};

/**
 * Biome over `files`, with exactly the e2e plugins the repository's
 * biome.json runs, on the files its override gives them.
 */
function lint(root: string, files: string[]): Diagnostic[] {
  const config = JSON.parse(readFileSync("biome.json", "utf8")) as {
    overrides: { includes: string[]; plugins?: string[] }[];
  };
  const e2e = config.overrides.filter((override) =>
    override.plugins?.some((plugin) => plugin.startsWith("./tests/lint/e2e-")),
  );
  writeFileSync(
    join(root, "biome.json"),
    JSON.stringify({
      root: true,
      overrides: e2e.map((override) => ({
        includes: override.includes,
        plugins: override.plugins?.map((plugin) => resolve(plugin)),
      })),
      formatter: { enabled: false },
      linter: { enabled: true, rules: { recommended: false } },
    }),
  );
  // Biome exits non-zero once a rule reports an error; the report is on
  // stdout either way.
  const { stdout: out } = spawnSync(
    resolve("node_modules/.bin/biome"),
    ["lint", "--reporter=json", "--max-diagnostics=none", ...files],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return (JSON.parse(out) as { diagnostics: Diagnostic[] }).diagnostics;
}

function ruleOf(diagnostic: Diagnostic): Rule | undefined {
  return (Object.keys(RULES) as Rule[]).find((rule) => diagnostic.message.startsWith(RULES[rule]));
}

// It spawns Biome (about 0.1 s), so it runs in the integration cohort at the 5 s default.
describe("the e2e assertion contract's lint", () => {
  it("flags each line that breaks the contract, and only those, as an error", () => {
    const root = scratchDir("infinitary-e2e-contract-lint-");
    mkdirSync(join(root, "tests/e2e"), { recursive: true });
    writeFileSync(
      join(root, "tests/e2e/contract.spec.ts"),
      FIXTURE.map(([line]) => line).join("\n"),
    );

    const diagnostics = lint(root, ["tests/e2e/contract.spec.ts"]);

    // In line order: Biome groups its report by severity, not by line.
    const found = diagnostics
      .map((d) => [d.location.start.line, ruleOf(d) ?? d.message] as const)
      .toSorted(([a], [b]) => a - b);
    const expected = FIXTURE.flatMap(([, rule], index) => (rule ? [[index + 1, rule]] : []));
    expect(found).toEqual(expected);
    expect(diagnostics.map((d) => d.severity)).toEqual(diagnostics.map(() => "error"));
    expect(new Set(expected.map(([, rule]) => rule))).toEqual(new Set(Object.keys(RULES)));
  });

  it("stays inside tests/e2e and leaves the catalog specs their model ids, the run layout its paths, the typing helper its keys, the pose's own specs its names and the helper files their frames, focus and regions", () => {
    const root = scratchDir("infinitary-e2e-contract-lint-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests/e2e"), { recursive: true });
    const source = FIXTURE.map(([line]) => line).join("\n");
    writeFileSync(join(root, "src/fixture.ts"), source);
    writeFileSync(join(root, "tests/e2e/model-lists.spec.ts"), source);
    writeFileSync(join(root, "tests/e2e/runEvidence.ts"), source);
    writeFileSync(join(root, "tests/e2e/frames.ts"), source);
    for (const file of ["windowKeys.ts", "crew.ts", "phase1-shell.spec.ts"])
      writeFileSync(join(root, "tests/e2e", file), source);

    const diagnostics = lint(root, [
      "src/fixture.ts",
      "tests/e2e/model-lists.spec.ts",
      "tests/e2e/runEvidence.ts",
      "tests/e2e/windowKeys.ts",
      "tests/e2e/frames.ts",
      "tests/e2e/crew.ts",
      "tests/e2e/phase1-shell.spec.ts",
    ]);

    expect(diagnostics.filter((d) => d.location.path.startsWith("src/"))).toEqual([]);
    const rulesIn = (path: string) =>
      diagnostics.filter((d) => d.location.path === path).map(ruleOf);
    expect(rulesIn("tests/e2e/model-lists.spec.ts")).not.toContain("modelId");
    expect(rulesIn("tests/e2e/model-lists.spec.ts")).toContain("feedProse");
    // A page-wide lookup by words is refused everywhere in tests/e2e; a
    // region by its name only in a spec, since the helpers name the places.
    expect(rulesIn("tests/e2e/frames.ts")).toContain("textLookup");
    expect(rulesIn("tests/e2e/frames.ts")).not.toContain("regionLookup");
    expect(rulesIn("tests/e2e/model-lists.spec.ts")).toContain("regionLookup");
    expect(rulesIn("tests/e2e/runEvidence.ts")).not.toContain("evidencePath");
    expect(rulesIn("tests/e2e/runEvidence.ts")).toContain("modelId");
    expect(rulesIn("tests/e2e/windowKeys.ts")).not.toContain("typedKeys");
    expect(rulesIn("tests/e2e/windowKeys.ts")).toContain("pose");
    // The door's and the helpers' own files hold the raw frame and focus calls.
    for (const rule of ["frameDoor", "bareFocus"] as const) {
      expect(rulesIn("tests/e2e/frames.ts")).not.toContain(rule);
      expect(rulesIn("tests/e2e/windowKeys.ts")).not.toContain(rule);
      expect(rulesIn("tests/e2e/model-lists.spec.ts")).toContain(rule);
    }
    for (const file of ["crew.ts", "phase1-shell.spec.ts"]) {
      expect(rulesIn(`tests/e2e/${file}`)).not.toContain("pose");
      expect(rulesIn(`tests/e2e/${file}`)).toContain("typedKeys");
    }
  });

  // INF-518: an edit to a scenario picks only the journeys that import it,
  // which holds only while the shared stand-in and the other shared helpers
  // import none (docs/testing.md, "A journey's own scenarios").
  it("refuses a scenario import in the shared stand-in and every shared helper, and keeps it in journeys and scenarios", () => {
    const root = scratchDir("infinitary-e2e-scenario-lint-");
    mkdirSync(join(root, "tests/e2e/scenarios"), { recursive: true });
    mkdirSync(join(root, "tests/e2e/phone"), { recursive: true });
    const imports = [
      'import { contextOverflow } from "./scenarios/contextOverflow";',
      'import type { Scenario } from "./scenarios/reviewedTier";',
      'export { keptMerge } from "./scenarios/keptMerge";',
      'const { guidedMerge } = await import("./scenarios/guidedMerge");',
      'import { launchApp } from "./launch";',
    ].join("\n");
    writeFileSync(join(root, "tests/e2e/mockProvider.ts"), imports);
    writeFileSync(join(root, "tests/e2e/launch.ts"), imports);
    writeFileSync(
      join(root, "tests/e2e/phone/pairing.ts"),
      'import { githubChange } from "../scenarios/githubChange";',
    );
    writeFileSync(join(root, "tests/e2e/settle-effects.spec.ts"), imports);
    writeFileSync(
      join(root, "tests/e2e/scenarios/githubChange.ts"),
      [
        'import { calledTool } from "../mockProvider";',
        'import { prepareMockStory } from "./changeStory";',
      ].join("\n"),
    );

    const diagnostics = lint(root, [
      "tests/e2e/mockProvider.ts",
      "tests/e2e/launch.ts",
      "tests/e2e/phone/pairing.ts",
      "tests/e2e/settle-effects.spec.ts",
      "tests/e2e/scenarios/githubChange.ts",
    ]);

    const refused = diagnostics
      .filter((d) => d.message.startsWith("A scenario file is imported only by"))
      .map((d) => `${d.location.path}:${d.location.start.line}:${d.severity}`)
      .toSorted();
    expect(refused).toEqual([
      "tests/e2e/launch.ts:1:error",
      "tests/e2e/launch.ts:2:error",
      "tests/e2e/launch.ts:3:error",
      "tests/e2e/launch.ts:4:error",
      "tests/e2e/mockProvider.ts:1:error",
      "tests/e2e/mockProvider.ts:2:error",
      "tests/e2e/mockProvider.ts:3:error",
      "tests/e2e/mockProvider.ts:4:error",
      "tests/e2e/phone/pairing.ts:1:error",
    ]);
  });
});

// Frame provenance crosses aliases and helper calls, so this rule uses
// TypeScript's scoped symbols rather than matching the spelling of a chain.
describe("native pointer actions in e2e frames", () => {
  it("follows frame chains, scoped aliases and helper returns, without confusing shell elements for frame contents", () => {
    const root = scratchDir("infinitary-e2e-frame-lint-");
    const dir = join(root, "tests/e2e");
    mkdirSync(dir, { recursive: true });
    const helpers = join(dir, "helpers.ts");
    writeFileSync(
      helpers,
      `
      export const board = (page) => page.frameLocator("iframe").locator("[data-board]");
      export const link = (scope) => scope.getByRole("link");
      export function shell(page) { return page.getByRole("button"); }
    `,
    );
    const cases: [string, boolean][] = [
      ...["click", "dblclick", "check", "uncheck", "setChecked", "tap", "hover", "dragTo"].map(
        (method): [string, boolean] => [
          `page.frameLocator("iframe").getByRole("button").${method}();`,
          true,
        ],
      ),
      ['page.locator("iframe").contentFrame().getByRole("button")["click"]();', true],
      [
        'const body = page.frameLocator("iframe"); const alias = body; alias.getByRole("button").click();',
        true,
      ],
      ['const find = renamedBoard(page).locator("[data-find]"); find.click();', true],
      [
        'const body = page.frameLocator("iframe"); const keyLink = () => link(body).first(); keyLink().click();',
        true,
      ],
      ['link(page.frameLocator("iframe")).click();', true],
      ["const item = (true ? renamedBoard(page) : shell(page)); item.click();", true],
      ["(renamedBoard(page) as Locator)!.click();", true],
      ['function read(frame: FrameLocator) { frame.getByRole("button").hover(); }', true],
      ['function read(frame: Frame) { frame.getByRole("button").click(); }', true],
      [
        'async function read() { return page.locator("iframe").contentFrame(); } (await read()).locator("x").click();',
        true,
      ],
      ["const shellButton = shell(page); shellButton.or(renamedBoard(page)).click();", true],
      ['page.getByRole("button").click();', false],
      ['const frame = page.locator("iframe"); frame.click();', false],
      ['page.frameLocator("iframe").owner().click();', false],
      ["link(page).click();", false],
      ["shell(page).click();", false],
      ['page.locator("[data-shell]").filter({ has: renamedBoard(page) }).click();', false],
      [
        'const body = page.frameLocator("iframe"); function inner() { const body = page; body.getByRole("button").click(); }',
        false,
      ],
      [
        'const body = page.frameLocator("iframe"); function inner(body) { body.getByRole("button").click(); }',
        false,
      ],
      [
        "const shellOnly = () => { const nested = () => renamedBoard(page); return shell(page); }; shellOnly().click();",
        false,
      ],
      ["const loop = () => loop(); loop().click();", false],
      ["await clickInBody(renamedBoard(page));", false],
      ['await renamedBoard(page).dispatchEvent("click");', false],
      [
        "// e2e-frame-actions: native -- This journey proves real pointer activation.\nrenamedBoard(page).click();",
        false,
      ],
      ["// e2e-frame-actions: native --\nrenamedBoard(page).click();", true],
      [
        "// e2e-frame-actions: native -- This reason is not adjacent.\n\nrenamedBoard(page).click();",
        true,
      ],
    ];
    const files = cases.map(([body], index) => {
      const file = join(dir, `case-${index}.spec.ts`);
      writeFileSync(
        file,
        `import { board as renamedBoard, link, shell } from "./helpers";\nasync function journey(page) {\n${body}\n}`,
      );
      return file;
    });
    const findings = lintFrameActions([helpers, ...files]);
    expect(findings.map((finding) => finding.file)).toEqual(
      files.filter((_, index) => cases[index]?.[1]),
    );
    expect(
      findings.every((finding) => finding.line >= 3 && finding.message.startsWith("Native ")),
    ).toBe(true);
    const outside = join(root, "outside.ts");
    writeFileSync(outside, 'page.frameLocator("iframe").getByRole("button").click();');
    expect(lintFrameActions([outside])).toEqual([]);
  });

  it("the command fails on a native frame action and passes an in-frame action", () => {
    const root = scratchDir("infinitary-e2e-frame-command-");
    const dir = join(root, "tests/e2e");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "journey.spec.ts");
    const run = () =>
      spawnSync(process.execPath, [resolve("scripts/lint-e2e-frames.ts"), root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    writeFileSync(file, 'page.frameLocator("iframe").getByRole("button").click();');
    const refused = run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("journey.spec.ts:1:1 e2e-frame-actions: Native click");
    writeFileSync(file, 'clickInBody(page.frameLocator("iframe").getByRole("button"));');
    const kept = run();
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain("e2e-frame-actions: 0 error(s), 1 files checked");
  });

  it("the command fails on words a spec types where it asserts, or copies from the product", () => {
    const root = scratchDir("infinitary-e2e-typed-words-command-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests/e2e"), { recursive: true });
    writeFileSync(
      join(root, "src/devices.ts"),
      'export const NO_WORK = "It takes no new work until it is updated.";',
    );
    const file = join(root, "tests/e2e/journey.spec.ts");
    const run = () =>
      spawnSync(process.execPath, [resolve("scripts/lint-e2e-frames.ts"), root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    writeFileSync(
      file,
      [
        'await expect(row).toContainText("Runs no project yet");',
        'const NO_WORK = "It takes no new work until it is updated.";',
      ].join("\n"),
    );
    const refused = run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("journey.spec.ts:1:33 e2e-typed-words: A text assertion");
    expect(refused.stderr).toContain("journey.spec.ts:2:17 e2e-typed-words: A fixture constant");
    writeFileSync(
      file,
      [
        'import { NO_WORK } from "../../src/devices";',
        "await expect(row).toContainText(NO_WORK);",
      ].join("\n"),
    );
    const kept = run();
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain("e2e-typed-words: 0 error(s), 1 files checked");
  });
});
