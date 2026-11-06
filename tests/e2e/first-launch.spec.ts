import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STANDARD_PLACEHOLDER } from "@shared/firstRun";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { WELCOME_STARTERS, WELCOME_TITLE, WELCOME_WORDS } from "@shared/welcome";
import { GATE_HOME_TITLE, gateIntro } from "../../src/renderer/src/app/firstRunGateWords";
import { scratchDir } from "../helpers/scratchDirs";
import { expectClaudeConnected } from "./claudeAccount";
import { claudeSeatRequests, NO_CLAUDE_LOGIN_USER, otherSeatRequests } from "./claudeSeat";
import { DICTATION_KEY, firstRunHintOnThisComputer, hintOnThisComputer } from "./dictation";
import { committedWelcome, observeWelcomeReadiness, reloadTypingEarly } from "./firstLaunch";
import { type LaunchedApp, launchApp } from "./launch";
import {
  atRest,
  expectClearOf,
  minimumWindowSize,
  overflows,
  resizeWindow,
  within,
} from "./layout";
import { signedInClaudeHome, writeMockClaudeClient } from "./mockClaudeClient";
import { MOCK_KEY_PROVIDER_ID, mockProviderOverrideModelsJson } from "./mockModels";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, startMockProvider } from "./mockProvider";
import { movePanelTo } from "./panelLayout";
import { promptInput } from "./prompt";
import { cardLeave, cardReply, cardScroller, showCard, shownCard, shownCardFrame } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * The first launch (captain decisions 2026-09-19; docs/first-launch.md).
 *
 * A fresh install has no model that can answer, so the stage carries the
 * gate - a caption under the character and the provider chip row, with the
 * input disabled and hold-to-talk ignored - and the Intelligence tab shows
 * nothing it has not measured. Connecting through the stage's own chip (a
 * key pasted into the provider's own prompt: the one sign-in that needs no
 * browser) closes the gate, the caption dissolves, the input reads the
 * first-run hint, and the host commits one approved Firstmate-owned note without inference. The captain's first turn returns the standard hint, and a
 * relaunch keeps all of it.
 *
 * The models.json here defines no custom provider: the base runtime serves
 * nothing, and the key-signed account's runtime - reading the same
 * app-scoped file - sends every turn to the mock server.
 */
let launched: LaunchedApp;
// Made per launch, never at module load: Playwright's runner loads this file
// too, and a directory made there outlives every worker's cleanup.
const clients = () => ({
  INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
});

/** Connects the mock provider through the gate's own chip, with a pasted key. */
async function connectThroughGate(page: Page): Promise<void> {
  const gate = page.locator("[data-first-run-gate]");
  await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
  await gate.locator(`[data-connect-provider="${MOCK_KEY_PROVIDER_ID}"]`).click();
  await gate.locator("[data-connect-method]").getByRole("button", { name: "API key" }).click();
  const aside = gate.locator("[data-connect-aside]");
  await aside.locator("input[type='password']").fill("sk-first-launch");
  await aside.getByRole("button", { name: "Submit" }).click();
}

/** The Tasks panel on its rail, collapsed: the header the welcome's words point at. */
const collapsedTasks = (page: Page) =>
  page.locator('[data-rail="right"] > [data-side-panel="now"][data-side-panel-collapsed]');

test.beforeEach(async () => {
  const provider = await startMockProvider();
  launched = await launchApp({
    reuseMockProvider: provider,
    modelsJson: mockProviderOverrideModelsJson,
    env: clients(),
  });
});

test.afterEach(async () => {
  if (launched) {
    await launched.close();
    await launched.mockProvider?.close();
  }
});

test("first-launch cards stay reachable with collapsed, expanded or one-sided panels", async () => {
  const { app, page } = launched;
  const gate = page.locator("[data-first-run-gate]");
  await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
  // Captain, INF-417: the first screen's heading and the first mate's introduction.
  await expect(gate.locator("[data-gate-title]")).toHaveText(GATE_HOME_TITLE);
  await expect(gate.locator("[data-mac-choice]")).toHaveText(gateIntro());
  await connectThroughGate(page);
  await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
  const layer = page.locator("[data-card-layer]");
  const readings: unknown[] = [];
  const reachable = async (state: string) => {
    await atRest(layer);
    await expectClearOf(
      page,
      layer.locator("[data-card-presentation]"),
      page.locator("[data-prompt-dock]"),
    );
    readings.push(
      await layer.evaluate((element) => ({
        window: window.innerWidth,
        card: element.getBoundingClientRect().toJSON(),
      })),
    );
    await page.screenshot({ path: test.info().outputPath(`${state}.png`) });
  };
  // The actual fresh profile: Activity collapsed on the left, and Tasks
  // collapsed on the right from the welcome on.
  await expect(page.locator('[data-rail="left"] > [data-side-panel="activity"]')).toHaveAttribute(
    "data-side-panel-collapsed",
  );
  await expect(collapsedTasks(page)).toBeVisible();
  await reachable("fresh-collapsed-both");
  for (const size of [await minimumWindowSize(app), { width: 1280, height: 800 }]) {
    await resizeWindow(app, page, size);
    await reachable(`collapsed-${size.width}`);
  }
  await resizeWindow(app, page, { width: 1200, height: 800 });
  for (const x of ["left", "right"] as const) {
    await movePanelTo(
      page,
      "activity",
      { x, y: "bottom" },
      { collapsedPanels: { activity: false }, hiddenPanels: {} },
    );
    await expect(page.locator(`[data-rail="${x}"] > [data-side-panel="activity"]`)).toBeVisible();
    await reachable(`expanded-${x}`);
    // Collapsing must leave the card reachable too.
    await page.getByRole("button", { name: "Collapse Activity" }).click();
    await reachable(`collapsed-${x}`);
  }
  await page.evaluate(() =>
    window.infinitary.settings.setLayout({
      collapsedPanels: {},
      hiddenPanels: { activity: true },
      placements: {},
    }),
  );
  await reachable("tasks-only-right");
  await page.evaluate(() =>
    window.infinitary.settings.setLayout({
      collapsedPanels: {},
      hiddenPanels: { activity: true, now: true },
      placements: {},
    }),
  );
  await reachable("no-panels");
  // The same one-sided mistake existed in the card-and-thread container. The
  // welcome takes no reply, so the thread opens under an answer to a message
  // sent from the box.
  const welcomeId = (await page.evaluate(() => window.infinitary.app.firstRun())).welcomeCardId;
  await page.evaluate((id) => window.infinitary.cards.close(id ?? ""), welcomeId);
  await promptInput(page).fill(`Where should I begin? ${ANSWER_PROMPT_MARKER}`);
  await promptInput(page).press("Enter");
  await showCard(page, MOCK_ANSWER_TITLE);
  await cardReply(page).field.fill("Where should I begin?");
  await cardReply(page).field.press("Enter");
  await expect(layer.locator("[data-card-thread]")).toBeVisible({ timeout: 30_000 });
  for (const x of ["left", "right"] as const) {
    await movePanelTo(
      page,
      "activity",
      { x, y: "bottom" },
      { collapsedPanels: { activity: false }, hiddenPanels: {} },
    );
    for (const width of [1200, 1728]) {
      await resizeWindow(app, page, { width, height: width === 1728 ? 1000 : 800 });
      await reachable(`thread-${x}-${width}`);
    }
  }
  writeFileSync(
    test.info().outputPath("card-reachability.json"),
    JSON.stringify(readings, null, 2),
  );
});

test("fresh key setup commits the welcome before ready without inference, restores it, and never reissues a dismissed note", async () => {
  const { page, mockProvider } = launched;
  if (!mockProvider) throw new Error("no mock provider");
  mockProvider.failFirstmate(true);
  const gate = page.locator("[data-first-run-gate]");
  // Gated: the input takes nothing, and hold-to-talk is ignored.
  await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
  await expect(promptInput(page)).toBeDisabled();
  await page.keyboard.down(DICTATION_KEY);
  await page.waitForTimeout(300);
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
  await page.keyboard.up(DICTATION_KEY);
  await observeWelcomeReadiness(page);
  await gate.locator(`[data-connect-provider="${MOCK_KEY_PROVIDER_ID}"]`).click();
  const choice = gate.locator("[data-connect-method]");
  await choice.getByRole("button", { name: "API key" }).click();
  const aside = gate.locator("[data-connect-aside]");
  await aside.locator("input[type='password']").fill("sk-first-launch");
  await page.screenshot({ path: test.info().outputPath("first-launch-api-key.png") });
  await aside.getByRole("button", { name: "Submit" }).click();
  await expect(promptInput(page)).toBeEnabled();
  await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
  await expect(page.getByPlaceholder(firstRunHintOnThisComputer())).toBeEnabled();
  const initial = await committedWelcome(page);
  expect(mockProvider.requestBodies()).toEqual([]);
  const events = await page.evaluate(() => window.welcomeReadiness);
  expect(events.find((event) => event.kind === "ready")).toMatchObject({
    ids: [initial.id],
    cardVisible: true,
  });
  expect(events.findIndex((event) => event.kind === "cards")).toBeLessThan(
    events.findIndex((event) => event.kind === "ready"),
  );
  writeFileSync(
    test.info().outputPath("welcome-key-evidence.json"),
    JSON.stringify(
      { events, initial, inferenceRequestsBeforeFirstInput: mockProvider.requests() },
      null,
      2,
    ),
  );

  const min = await minimumWindowSize(launched.app);
  await resizeWindow(launched.app, page, min);
  const frame = shownCardFrame(page);
  await expect(frame.locator("figure")).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((theme) => window.infinitary.settings.setAppearance({ theme }), theme);
    await expect(page.locator("[data-theme]").first()).toHaveAttribute("data-theme", theme);
    expect(await overflows(frame.locator("body"))).toBe(0);
    // Starting a task needs no introduction scroll, even at the minimum.
    expect(await cardScroller(page).evaluate((el) => el.scrollTop)).toBe(0);
    const input = await promptInput(page).boundingBox();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (!input || !viewport) throw new Error("missing input bounds");
    expect(within(input, { x: 0, y: 0, ...viewport })).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`welcome-ready-${theme}.png`) });
    // Reading the drawing is optional; it fits horizontally and leaves the input available.
    await frame.locator("figure").scrollIntoViewIfNeeded();
    await expect(promptInput(page)).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`welcome-drawing-${theme}.png`) });
    await cardScroller(page).evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  await promptInput(page).fill("a draft stays here");
  await page.evaluate(() => window.infinitary.app.firstRun());
  await expect(promptInput(page)).toHaveValue("a draft stays here");
  await expect(promptInput(page)).toBeFocused();

  const { userDataDir, homeDir } = launched;
  await launched.close();
  launched = await launchApp({
    userDataDir,
    homeDir,
    reuseMockProvider: mockProvider,
    modelsJson: mockProviderOverrideModelsJson,
    env: clients(),
  });
  await expect(shownCard(launched.page, WELCOME_TITLE)).toBeVisible();
  const restored = await committedWelcome(launched.page);
  expect(restored.record).toEqual(initial.record);
  expect(restored.id).toBe(initial.id);
  expect(mockProvider.requests()).toBe(0);

  // The welcome takes no reply: no reply row under it, and the core refuses one.
  await expect(cardReply(launched.page).row).toHaveCount(0);
  await expect(cardLeave(launched.page, shownCard(launched.page, WELCOME_TITLE))).toBeVisible();
  const refused = await launched.page.evaluate(async (id) => {
    try {
      await window.infinitary.cards.reply(id, "Where should I begin?");
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, initial.id);
  expect(refused).toMatch(/takes no reply/);
  expect(
    (await launched.page.evaluate((id) => window.infinitary.cards.thread(id), initial.id)).messages,
  ).toEqual([]);

  // A message sent from the box ends the introductory hint and is a normal
  // Firstmate turn, carrying this introduction in its context. No new
  // welcome is composed, and the welcome stays up.
  mockProvider.failFirstmate(false);
  await promptInput(launched.page).fill("Where should I begin?");
  await promptInput(launched.page).press("Enter");
  await expect(
    launched.page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER)),
  ).toBeVisible();
  await expect.poll(() => mockProvider.requestBodies().length).toBeGreaterThan(0);
  expect(mockProvider.requestBodies()[0]).toContain(initial.id);
  await expect(shownCard(launched.page, WELCOME_TITLE)).toBeVisible();
  await launched.page.evaluate((id) => window.infinitary.cards.close(id), initial.id);
  const afterReply = await launched.page.evaluate(() => window.infinitary.app.firstRun());
  expect(afterReply.firstTurnAt).not.toBeNull();
  await launched.close();
  launched = await launchApp({
    userDataDir,
    homeDir,
    reuseMockProvider: mockProvider,
    modelsJson: mockProviderOverrideModelsJson,
    env: clients(),
  });
  await expect(promptInput(launched.page)).toBeEnabled();
  expect(await launched.page.evaluate(() => window.infinitary.app.firstRun())).toEqual(afterReply);
  expect(
    (await launched.page.evaluate(() => window.infinitary.cards.list())).some(
      (card) => card.id === initial.id,
    ),
  ).toBe(false);
  writeFileSync(
    test.info().outputPath("welcome-key-final.json"),
    JSON.stringify(
      {
        initialId: initial.id,
        restoredId: restored.id,
        afterReply,
        requestCount: mockProvider.requests(),
        firstRequestIncludesIntroduction: mockProvider.requestBodies()[0]?.includes(initial.id),
        messages: (
          await launched.page.evaluate((id) => window.infinitary.cards.thread(id), initial.id)
        ).messages.map(({ who, text }) => ({ who, text })),
      },
      null,
      2,
    ),
  );
  // The fixture owns the reused server until afterEach, including restarts.
});

test("the welcome shows one part per press by keys in both themes at the minimum window, and a starter starts the message", async () => {
  const { app, page, mockProvider } = launched;
  if (!mockProvider) throw new Error("no mock provider");
  mockProvider.failFirstmate(true);
  await connectThroughGate(page);
  await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
  await committedWelcome(page);
  await expect(collapsedTasks(page)).toBeVisible();
  await expect(cardReply(page).row).toHaveCount(0);
  await resizeWindow(app, page, await minimumWindowSize(app));
  const frame = shownCardFrame(page);
  const figure = frame.locator("figure[data-chapter]");
  const next = frame.getByRole("button", { name: "Next" });
  const back = frame.getByRole("button", { name: "Back" });
  /** What the picture draws now: its chapter, its count, its parts and the words by the box. */
  const reading = () =>
    figure.evaluate((shown) => ({
      chapter: Number(shown.getAttribute("data-chapter")),
      count: shown.querySelector("[data-count]")?.textContent,
      parts: [...shown.querySelectorAll("[data-part]:not([data-part='words'])")]
        .filter((part) => getComputedStyle(part).visibility === "visible")
        .map((part) => part.getAttribute("data-part")),
      words: shown.querySelector("[data-part='words']")?.textContent,
      lit: [...shown.querySelectorAll<SVGElement>("[data-look]")]
        .filter((part) => /var\(--accent\)/.test(part.style.stroke + part.style.fill))
        .map((part) => part.getAttribute("data-look")),
    }));
  /** Each pass of motion the picture started since the last read, by its length. */
  const passes = () =>
    frame
      .locator("body")
      .evaluate(() => (window as unknown as { passes: number[] }).passes.splice(0));
  await frame.locator("body").evaluate(() => {
    const kept = window as unknown as { passes: number[] };
    kept.passes = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      kept.passes.push(typeof options === "number" ? options : Number(options?.duration ?? 0));
      return animate.call(this, keyframes, options);
    };
  });
  const press = async (button: typeof next, key: "Enter" | " " = "Enter") => {
    await pressKey(button, key);
  };
  const atRest = {
    chapter: 1,
    count: "1 / 5",
    parts: ["firstmate", "box"],
    words: WELCOME_WORDS.box,
    lit: ["box"],
  };

  for (const theme of ["dark", "light"] as const) {
    await test.step(`${theme}: Next reveals one part per press with one pass, and Back returns as a cut`, async () => {
      await page.evaluate(
        (next) => window.infinitary.settings.setAppearance({ theme: next }),
        theme,
      );
      await expect(page.locator("[data-theme]").first()).toHaveAttribute("data-theme", theme);
      await expect.poll(reading).toEqual(atRest);
      await page.screenshot({ path: test.info().outputPath(`welcome-${theme}-1.png`) });
      // The card rises over the Firstmate as it fades behind it, in one pass each.
      await press(next);
      await expect.poll(reading).toEqual({
        chapter: 2,
        count: "2 / 5",
        parts: ["box", "card"],
        words: WELCOME_WORDS.box,
        lit: ["card"],
      });
      const rise = await passes();
      expect(rise).toHaveLength(2);
      for (const pass of rise) expect(pass).toBeGreaterThan(0);
      await press(next, " ");
      await expect.poll(reading).toMatchObject({
        chapter: 3,
        parts: ["box", "card", "activity"],
        lit: ["crew"],
      });
      expect(await passes()).toHaveLength(1);
      await press(next);
      await expect.poll(reading).toMatchObject({
        chapter: 4,
        parts: ["box", "card", "activity", "tasks"],
        lit: ["task"],
      });
      expect(await passes()).toHaveLength(1);
      await press(next);
      await expect.poll(reading).toEqual({
        chapter: 5,
        count: "5 / 5",
        parts: ["box", "card", "activity", "tasks"],
        words: WELCOME_WORDS.end,
        lit: ["box"],
      });
      expect(await passes()).toHaveLength(1);
      await page.screenshot({ path: test.info().outputPath(`welcome-${theme}-5.png`) });
      // Next at the end and Back at the start do nothing.
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await press(next);
      await press(back);
      await expect.poll(reading).toMatchObject({ chapter: 4, words: WELCOME_WORDS.box });
      for (const chapter of [3, 2, 1]) {
        await press(back);
        await expect.poll(reading).toMatchObject({ chapter });
      }
      expect(await reading()).toEqual(atRest);
      await expect(back).toHaveAttribute("aria-disabled", "true");
      expect(await passes()).toEqual([]);
    });
  }

  await test.step("under reduced motion every move is a cut", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await expect
        .poll(() =>
          frame
            .locator("body")
            .evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--dur-med").trim(),
            ),
        )
        .toBe("0ms");
      await press(next);
      await expect.poll(reading).toMatchObject({ chapter: 2, parts: ["box", "card"] });
      expect(await passes()).toEqual([]);
      await press(back);
      await expect.poll(reading).toEqual(atRest);
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  });

  const requests = mockProvider.requests();
  const prompt = promptInput(page);
  await test.step("a starter puts its words in the message box by keys, caret after them, sending nothing", async () => {
    const [clone, fresh] = WELCOME_STARTERS;
    await press(frame.getByRole("button", { name: clone.label }));
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(clone.words);
    expect(await prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(
      clone.words.length,
    );
    // Another starter's words take the place of the first's.
    await press(frame.getByRole("button", { name: fresh.label }), " ");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(fresh.words);
    await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
    expect(mockProvider.requests()).toBe(requests);
    expect((await page.evaluate(() => window.infinitary.app.firstRun())).firstTurnAt).toBeNull();
    await page.screenshot({ path: test.info().outputPath("welcome-starter.png") });
  });

  await test.step("a starter its own page presses while focus is in the box moves nothing", async () => {
    await prompt.fill("my own words");
    await expect(prompt).toBeFocused();
    await frame.locator("body").evaluate(async () => {
      const starter = document.querySelector<HTMLElement>("[data-inf-draft]");
      for (let round = 0; round < 10; round++) {
        starter?.click();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }
    });
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("my own words");
  });
});

test("a fresh profile takes no words before it has read the gate, and still gets its welcome", async () => {
  const { page, mockProvider } = launched;
  if (!mockProvider) throw new Error("no mock provider");
  mockProvider.failFirstmate(true);
  const gate = page.locator("[data-first-run-gate]");
  await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
  // The window starts again on this fresh profile, with someone typing and
  // sending at the first moment the input would take it.
  await reloadTypingEarly(page);
  await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
  const early = await page.evaluate(() => window.earlyInput);
  expect(early.seen).toBeGreaterThan(0);
  expect(early.took).toEqual([]);
  // Nothing reached Firstmate, so the welcome is still owed.
  expect(await page.evaluate(() => window.infinitary.app.firstRun())).toMatchObject({
    gateOpen: true,
    welcomeState: "pending",
    firstTurnAt: null,
  });
  await expect(promptInput(page)).toHaveValue("");
  await page.screenshot({ path: test.info().outputPath("early-typing-gate.png") });

  await connectThroughGate(page);
  await expect(page.getByPlaceholder(firstRunHintOnThisComputer())).toBeEnabled();
  await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
  await committedWelcome(page);
  expect(mockProvider.requestBodies()).toEqual([]);
  await expect(shownCardFrame(page).locator("figure")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("early-typing-welcome.png") });
});

test("a Mac with only Claude: connecting it on the stage closes the gate, and the Firstmate answers on Claude", async () => {
  // A person who already uses Claude Code on this Mac, and nothing else.
  // The Firstmate runs on the machine's login (W1 S12), through the SDK's
  // own client against the mock provider; the app runs as a user the
  // Keychain holds no Claude login for, so the sign-in never reaches the
  // person's own (tests/e2e/claudeSeat.ts).
  const mockProvider = await startMockProvider();
  mockProvider.failFirstmate(true);
  const quotaDir = scratchDir("infinitary-quota-fixture-");
  writeFileSync(
    join(quotaDir, "snapshot.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), fetchedAt: Date.now(), providers: [] }),
  );
  const app = await launchApp({
    reuseMockProvider: mockProvider,
    modelsJson: mockProviderOverrideModelsJson,
    claudeTurns: { credential: "subscription", maxRetries: 0 },
    prepareHome: signedInClaudeHome,
    env: { USER: NO_CLAUDE_LOGIN_USER, INFINITARY_QUOTA_FIXTURE_DIR: quotaDir },
  });
  try {
    const { page } = app;
    const gate = page.locator("[data-first-run-gate]");
    await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath("first-launch-claude-caption.png") });
    await observeWelcomeReadiness(page);

    // Claude signs in one way: the chip goes straight to the Mac's login.
    await gate.locator(`[data-connect-provider="${CLAUDE_PROVIDER_ID}"]`).click();
    // An immediately arriving card can replace the null-state layer before
    // a test samples the caption's transient fade; assert the ready outcome.
    await expect(gate).toHaveCount(0, { timeout: 30_000 });
    const connected = await page.evaluate(async () =>
      (await window.infinitary.accounts.list()).find(
        (account) => account.providerId === "anthropic-claude",
      ),
    );
    if (!connected) throw new Error("The stage did not register the machine's Claude login");
    await expectClaudeConnected(page, connected.id);
    const input = page.getByPlaceholder(firstRunHintOnThisComputer());
    await expect(input).toBeEnabled({ timeout: 10_000 });

    // Approved Firstmate-owned copy, already committed without Claude inference.
    await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
    const welcome = await committedWelcome(page);
    expect(mockProvider.requestBodies()).toEqual([]);
    const events = await page.evaluate(() => window.welcomeReadiness);
    expect(events.find((event) => event.kind === "ready")).toMatchObject({
      ids: [welcome.id],
      cardVisible: true,
    });
    writeFileSync(
      test.info().outputPath("welcome-claude-evidence.json"),
      JSON.stringify({ events, welcome, inferenceRequestsBeforeFirstInput: 0 }, null, 2),
    );
    await page.screenshot({ path: test.info().outputPath("welcome-claude-ready.png") });
    mockProvider.failFirstmate(false);
    expect(otherSeatRequests(mockProvider)).toEqual([]);
    const model = await page.evaluate(() => window.infinitary.settings.getFirstmateModel());
    expect(model?.provider).toBe(CLAUDE_PROVIDER_ID);

    // The captain's first turn is answered on Claude too.
    await input.click();
    await input.fill(`what can you do? ${ANSWER_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect
      .poll(
        () =>
          claudeSeatRequests(mockProvider).filter((body) => body.includes(ANSWER_PROMPT_MARKER))
            .length,
        { timeout: 45_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER))).toBeVisible({
      timeout: 10_000,
    });
    // Request delivery and an idle input can precede the card broadcast.
    // Wait for the persisted answer itself, not an intermediate turn signal.
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.title)),
      )
      .toContain(MOCK_ANSWER_TITLE);
  } finally {
    await app.close();
    await mockProvider.close();
  }
});
