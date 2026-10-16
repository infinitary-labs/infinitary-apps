import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { buildCrewmateSystemPrompt, crewmateProcedureFor } from "../../src/core/pi/piResources";
import { openDatabase } from "../../src/core/storage/db";
import { COMPLETION_CARD_HEADINGS } from "../../src/shared/cardHeadings";
import { reportSummary } from "../../src/shared/feed";
import {
  CARE_WORDS,
  CHECK_WORDS,
  DEFAULT_WORKSPACE_WORD,
  MERGE_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import {
  FM_SYSTEM_MARKER,
  MOCK_STANDARD_AFTER,
  MOCK_STANDARD_CARD_BODY,
  MOCK_STANDARD_CARD_TITLE,
  MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE,
  MOCK_STANDARD_INVENTED_LABEL,
  MOCK_STANDARD_REPORT,
  SPAWN_PROMPT_MARKER,
  STANDARD_TIER_HOST_BUTTONS_MARKER,
  STANDARD_TIER_MISSING_HEADING_MARKER,
  STANDARD_TIER_PROMPT_MARKER,
} from "./mockProvider";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { reportLine, startedLine, taskKey } from "./rails";
import { authoredFirst, factsStrip, shownCard } from "./stack";

/**
 * The report keeps its five evidence headings; the completion card uses the
 * loose four-heading outline. The real emit -> lint -> checks -> frame path
 * accepts it, rejects a missing heading and publishes the correction. The
 * scripted model proves boundary behavior and rendering, not model obedience.
 * Host buttons and facts remain unchanged, for local and direct-pr work.
 */

const REPO_NAME = "meterlab";

let launched: LaunchedApp;
let github: GitHubStub;

test.beforeEach(async () => {
  const userDataDir = scratchDir("infinitary-rigor-standard-");
  const repo = seedRepo(userDataDir);
  github = await startGitHubStub();
  // The crewmate's change, read at its task branch's own commit.
  github.servePull({ number: 56, title: "fix: the meter reads on the first paint" });
  github.headOf((branch) =>
    execFileSync("git", ["-C", repo.repoDir, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim(),
  );
  seedGitHubSignIn(userDataDir);
  // The repository's standing rigor (phase 3, migration 36): standard, so
  // the unclassified spawn's high tier does not make the task reviewed and
  // the completion card is the lint's to refuse, not the review hold's.
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'standard')",
  ).run("repo-meterlab", repo.repoDir, REPO_NAME, Date.now(), "https://github.com/o/meterlab.git");
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: github.env,
  });
});

test.afterEach(async () => {
  await launched.close();
  await github.close();
});

test("a standard-tier crewmate's completion card renders the completion outline in order and its report is one feed line", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${STANDARD_TIER_PROMPT_MARKER}`);
  await input.press("Enter");

  // The completion card, up through the real crewmate tool and lint. It is
  // the only card, so the stack shows it with no pager to page through.
  await expect(shownCard(page, MOCK_STANDARD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

  // The completion outline opens the body: no answer line ahead of Why.
  const frame = cardBody(page, MOCK_STANDARD_CARD_TITLE);
  await expect(frame.locator("h3")).toHaveText([...COMPLETION_CARD_HEADINGS]);
  await expect(authoredFirst(frame)).toHaveText(COMPLETION_CARD_HEADINGS[0]);
  for (const heading of COMPLETION_CARD_HEADINGS) {
    await expect(
      frame
        .getByRole("heading", { name: heading, exact: true })
        .locator("xpath=following-sibling::p[1]"),
    ).not.toBeEmpty();
  }
  await expect(
    frame
      .getByRole("heading", { name: COMPLETION_CARD_HEADINGS[3], exact: true })
      .locator("xpath=following-sibling::p[1]"),
  ).toContainText(MOCK_STANDARD_AFTER);
  // The host's facts strip stands beside the buttons (ruling D4, the fact
  // strip at v2.7): the body never repeats the project's care.
  const facts = factsStrip(frame);
  await expect(facts.project).toHaveText(DEFAULT_WORKSPACE_WORD);
  await expect(facts.care).toHaveText(CARE_WORDS.standard);
  // The completion decision: the merge action, default, and the discard.
  await expect(page.getByRole("button", { name: MERGE_WORDS.land })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();

  // The report is one feed line carrying its summary, never a card of its
  // own. The words are `reportSummary`'s (the unit tests own them); here
  // the line is found by its event and task key.
  const report = reportLine(page, await taskKey(page, STANDARD_TIER_PROMPT_MARKER));
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(reportSummary(MOCK_STANDARD_REPORT));
  await page.screenshot({ path: test.info().outputPath("rigor-standard-activity.png") });
  await waitForFirstmateIdle(page);
  // Still one card: the report did not become a second one.
  await expect(page.locator("[data-card-pager]")).toHaveCount(0);

  // The crewmate was served the prompt that names its tier: the request
  // the real Pi session sent carries the standard-tier paragraph, and the
  // Firstmate's does not. The prompt is the one for the task's own
  // delivery and care, read from its record: this local task's omits the
  // pull-request passages its standard tier does not need.
  const policies = await page.evaluate(async (title) => {
    const row = (await window.infinitary.tasks.board()).tasks.find((task) => task.title === title);
    if (!row) throw new Error(`No task "${title}"`);
    return (await window.infinitary.tasks.detail(row.id)).policies ?? null;
  }, STANDARD_TIER_PROMPT_MARKER);
  const prompt = buildCrewmateSystemPrompt(
    "pi",
    undefined,
    undefined,
    undefined,
    undefined,
    crewmateProcedureFor(policies),
  );
  const bodies = mockProvider?.requestBodies() ?? [];
  const crewmate = bodies.filter(
    (body) => !body.includes(FM_SYSTEM_MARKER) && body.includes("You are a crewmate"),
  );
  expect(crewmate.length).toBeGreaterThan(0);
  for (const body of crewmate) {
    // The focused prompt test owns the wording; this journey proves the
    // task's guidance reaches the provider whole, not that a model follows it.
    const request = JSON.parse(body) as { messages: { content: unknown }[] };
    const served = request.messages.find(
      (message) =>
        typeof message.content === "string" && message.content.includes("You are a crewmate"),
    )?.content;
    expect(served).toContain(prompt);
    await test.info().attach("served-crewmate-prompt", {
      body: String(served),
      contentType: "text/plain",
    });
  }
});

test("the host attaches completion buttons and facts after the outline", async () => {
  const { page, mockProvider } = launched;
  const title = `${REPO_NAME} ${STANDARD_TIER_HOST_BUTTONS_MARKER}`;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  await expect(startedLine(page, await taskKey(page, title))).toBeVisible({ timeout: 30_000 });
  // The repository's standing rigor drove the derivation: standard, on a
  // spawn whose own tier would have read reviewed.
  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        const row = board.tasks.find((task) => task.title === title);
        return row ? page.evaluate((id) => window.infinitary.tasks.detail(id), row.id) : null;
      },
      { timeout: 30_000 },
    )
    .toMatchObject({ rigor: "standard" });

  // The card publishes with its own outline, not the report's five headings.
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.title)),
      { timeout: 30_000 },
    )
    .toEqual([MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE]);
  await expect(shownCard(page, MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE)).toBeVisible();
  const frame = cardBody(page, MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE);
  await expect(frame.locator("h3")).toHaveText([...COMPLETION_CARD_HEADINGS]);
  await expect(authoredFirst(frame)).toHaveText(COMPLETION_CARD_HEADINGS[0]);
  await expect(frame.locator("figure svg")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("completion-outline-after.png") });

  // The buttons are the HOST's, from the task's posture: the direct-pr
  // repository makes the merge "Merge the pull request", the discard sits beside it, and
  // the label the crewmate invented for its one declared action is gone.
  await expect(page.getByRole("button", { name: MERGE_WORDS["merge-pr"] })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(page.getByRole("button", { name: MOCK_STANDARD_INVENTED_LABEL })).toHaveCount(0);

  // The host still writes its own facts after the body.
  const facts = factsStrip(frame);
  await expect(facts.project).toHaveText(REPO_NAME);
  await expect(facts.care).toHaveText(CARE_WORDS.standard);
  await expect(facts.checks).toHaveText(CHECK_WORDS.green);
  await facts.strip.screenshot({ path: test.info().outputPath("completion-outline-facts.png") });

  // Nothing was refused on the way: the crewmate never saw a lint error.
  expect((mockProvider?.requestBodies() ?? []).some((body) => body.includes("Card refused"))).toBe(
    false,
  );
  const report = reportLine(page, await taskKey(page, title));
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(reportSummary(MOCK_STANDARD_REPORT));
});

test("a missing completion heading is refused and the corrected outline publishes", async () => {
  const { page, mockProvider } = launched;
  const title = `${SPAWN_PROMPT_MARKER} ${STANDARD_TIER_MISSING_HEADING_MARKER}`;
  const input = promptInput(page);
  await input.fill(title);
  await input.press("Enter");
  await expect(shownCard(page, MOCK_STANDARD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const frame = cardBody(page, MOCK_STANDARD_CARD_TITLE);
  await expect(frame.locator("h3")).toHaveText([...COMPLETION_CARD_HEADINGS]);
  await expect(authoredFirst(frame)).toHaveText(COMPLETION_CARD_HEADINGS[0]);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards).toHaveLength(1);
  expect(cards[0]?.body).toContain(MOCK_STANDARD_CARD_BODY);
  const refused = (mockProvider?.requestBodies() ?? []).filter((body) =>
    body.includes("Card refused"),
  );
  expect(refused.length).toBeGreaterThan(0);
  const request = JSON.parse(refused[0] ?? "{}");
  const refusal = request.messages
    .flatMap((message: { content: unknown }) =>
      typeof message.content === "string" ? [message.content] : [],
    )
    .find((text: string) => text.includes("Card refused"));
  expect(refusal).toBeTruthy();
  writeFileSync(
    test.info().outputPath("completion-outline-boundary.json"),
    JSON.stringify(
      {
        refusal,
        published: { title: cards[0]?.title, body: cards[0]?.body },
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: test.info().outputPath("completion-outline-corrected.png") });
});
