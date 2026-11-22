import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { reviewerChoiceState } from "../../src/core/orchestrator/reviewerChoice";
import { reviewPickLine } from "../../src/core/orchestrator/reviewPick";
import type { RouteResult } from "../../src/core/routing/router";
import { openDatabase } from "../../src/core/storage/db";
import { KnowledgeStore } from "../../src/core/storage/knowledgeStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { DECISION_APPROVAL_VERSION } from "../../src/shared/decisionUses";
import type { TaskView } from "../../src/shared/tasks";
import { REVIEW_CAREFULLY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID, mockModelsJson } from "./mockModels";
import { REVIEW_CAREFULLY_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { startedLine } from "./rails";
import { MOCK_CAREFUL_CARD_TITLE, reviewCarefully } from "./scenarios/reviewCarefully";
import { MOCK_REVIEWED_CHANGE, REVIEW_BRIEF_MARKER, reviewedTier } from "./scenarios/reviewedTier";
import { shownCard } from "./stack";
import { starterFor } from "./starters";

/**
 * Which model reviews (INF-5021; docs/delivery-rigor.md, "Which model
 * reviews"): a standing direction names the model that reviews a project's
 * work, and a careful review the captain asks for from a Default merge card
 * runs on that model, not on the usual pick.
 *
 * Two models: the usual one placed at low, medium and high, which the
 * builder and an ordinary review get, and the reviewer the direction names,
 * placed at premium only, so the usual rules never give it a review. The
 * reviewer is a Grok model on a disposable Grok account, pointed at the
 * stand-in: routing passes over a model whose provider the app does not
 * offer, which the stand-in's own provider is not.
 *
 * Real: the repository, the direction as the app stores it, the reviewer
 * question and its facts as the app sends them, the pick's routing and its
 * record line. Stand-ins: the models (the mock provider), GitHub
 * (`./githubStub.ts`) and Jev, whose stand-in answers the reviewer question
 * with the model its options name for the directed key - a scripted model
 * proves the host's side only; the real Jev's reading is scored by
 * `pnpm score:reviewers`.
 */

const REPO_ID = "repo-meterlab";
const REPO_NAME = "meterlab";
const TITLE = `${REPO_NAME} ${REVIEW_CAREFULLY_MARKER}`;
const REVIEWER_PROVIDER = "xai";
const REVIEWER_ID = starterFor(REVIEWER_PROVIDER, "medium");
const REVIEWER_LABEL = "Mock reviewer";
const REVIEWER_KEY = `${REVIEWER_PROVIDER}/${REVIEWER_ID}`;
const REVIEWER_ACCOUNT = "acct_reviewer";
const DIRECTION = `Every review of ${REPO_NAME} runs on ${REVIEWER_LABEL}.`;
const STUB_KEY = "ts-live-e2e-0000000000";
/** The model the stand-in says answered; the app records it as `jev/<model>`. */
const STUB_MODEL = "jev-1.13.0";

/** The mock provider's models.json, with Grok pointed at the stand-in for the model the direction names. */
function twoModelsJson(port: number): string {
  const config = JSON.parse(mockModelsJson(port));
  config.providers[REVIEWER_PROVIDER] = {
    ...config.providers[MOCK_PROVIDER_ID],
    models: [{ id: REVIEWER_ID, name: REVIEWER_LABEL, input: ["text", "image"] }],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

type Question = { criteria: Record<string, string> };
type StubJev = {
  server: Server;
  url: string;
  /** The reviewer questions the app sent, with their facts. */
  reviewer: { state: Record<string, string>; question: Question }[];
};

/**
 * Jev's stand-in: the reviewer question is answered with the option whose
 * meaning names the directed key; every other question abstains (a
 * confidence of zero), so the app's own fallback decides it as it does
 * with no decision model.
 */
async function startStubJev(): Promise<StubJev> {
  const stub: StubJev = { server: createServer(), url: "", reviewer: [] };
  stub.server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        state: Record<string, string>;
        questions: Record<string, Question>;
      };
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const options = Object.keys(question.criteria);
          const named =
            id === "reviewer"
              ? options.find((option) => question.criteria[option]?.includes(`(${REVIEWER_KEY})`))
              : undefined;
          if (id === "reviewer") stub.reviewer.push({ state: body.state, question });
          const choice = named ?? options[0] ?? "";
          const confidence = named ? 0.95 : 0;
          return [
            id,
            { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
          ];
        }),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: STUB_MODEL,
          answers,
          usage: { input_tokens: 412, output_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/v1/systemone`;
  return stub;
}

let launched: LaunchedApp;
let github: GitHubStub;
let jev: StubJev;

test.beforeEach(async () => {
  const userDataDir = scratchDir("infinitary-review-model-");
  const repo = seedRepo(userDataDir);
  const repoDir = repo.repoDir;
  github = await startGitHubStub();
  github.servePull({ number: 57, ...MOCK_REVIEWED_CHANGE });
  github.headOf((branch) =>
    execFileSync("git", ["-C", repoDir, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim(),
  );
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: REPO_ID,
    path: repoDir,
    name: REPO_NAME,
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "standard",
  });
  seedHostedOrigins(db, userDataDir);
  // The usual model at every level a task or a review routes to; the
  // directed one at premium only.
  new SettingsStore(db).setModelSlots({
    version: 1,
    assignments: {
      [`${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`]: ["low", "medium", "high"],
      [REVIEWER_KEY]: ["premium"],
    },
    seen: [`${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`, REVIEWER_KEY],
  });
  db.close();
  seedAccountStore(userDataDir, REVIEWER_PROVIDER, REVIEWER_ACCOUNT, { recursive: true });
  seedAccountAuth(
    userDataDir,
    REVIEWER_PROVIDER,
    REVIEWER_ACCOUNT,
    { [REVIEWER_PROVIDER]: { type: "api_key", key: "disposable-key" } },
    {},
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: REVIEWER_ACCOUNT,
        providerId: REVIEWER_PROVIDER,
        kind: "api_key",
        label: "Reviewer test",
        enabled: true,
        createdAt: 1,
      },
    ],
    {},
    {},
  );
  const now = Date.now();
  const knowledge = KnowledgeStore.open(join(userDataDir, "knowledge"));
  knowledge.saveDirection(
    {
      id: "d:review-model",
      scope: REPO_ID,
      text: DIRECTION,
      origin: "captain-turn",
      revision: 1,
      retired: false,
      createdAt: now,
      updatedAt: now,
    },
    "publish",
    "The captain's words.",
  );
  knowledge.close();
  jev = await startStubJev();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [reviewCarefully, reviewedTier],
    userDataDir,
    modelsJson: twoModelsJson,
    env: { ...github.env, INFINITARY_JEV_URL: jev.url },
  });
  const { page } = launched;
  // Jev answers decisions, through the channels the Decisions form drives.
  await page.evaluate((key) => window.infinitary.models.setDecisionKey("jev", key), STUB_KEY);
  await page.evaluate(
    (version) =>
      window.infinitary.models.setDecisions({
        version: 1,
        answerer: { kind: "native", id: "jev" },
        egress: { jev: { enabled: true, consentedVersion: version } },
      }),
    DECISION_APPROVAL_VERSION,
  );
});

test.afterEach(async () => {
  await launched.close();
  await github.close();
  await new Promise<void>((resolve) => jev.server.close(() => resolve()));
});

async function taskRow(match: (task: TaskView) => boolean): Promise<TaskView> {
  const find = async () =>
    (await launched.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(match) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return (await find()) as TaskView;
}

test("a careful review asked for from the merge card runs on the model a standing direction names", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");
  const builder = await taskRow((task) => task.title === TITLE);
  await expect(startedLine(page, builder.key)).toBeVisible({ timeout: 30_000 });

  const card = shownCard(page, MOCK_CAREFUL_CARD_TITLE);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: REVIEW_CAREFULLY_WORDS, exact: true }).click();

  const review = await taskRow((task) => task.reviewOf === builder.id);
  await expect.poll(() => jev.reviewer.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const asked = jev.reviewer[0];
  // How the review started, in the words the app sends for a merge card's ask.
  const clicked = reviewerChoiceState({
    builder: { title: TITLE, goal: TITLE, delivers: "change", project: REPO_NAME },
    started: "click",
    usual: null,
    directions: [],
    models: [],
  }).facts.review_started;
  expect(asked?.state.standing_directions).toContain(DIRECTION);
  expect(asked?.state.review_started).toBe(clicked);
  // Both placed models are options. The stand-in provider has no allowance
  // reading, so the ladder names no usual pick here (the task runs on the
  // client's default); the usual pick's wording is the unit tests'.
  const options = Object.values(asked?.question.criteria ?? {}).join("\n");
  expect(options).toContain(`(${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID})`);
  expect(options).toContain(`(${REVIEWER_KEY})`);

  // The review runs on the directed model: its record says so, in the line
  // the app writes when the pick took the review (after the model's name,
  // which Settings gives it), and its brief reached the model the
  // direction names. The poll returns the notes, so a miss shows the line.
  const NAME = "\u0000";
  const [, took] = reviewPickLine(
    {
      mode: "prefer",
      key: REVIEWER_KEY,
      name: NAME,
      usual: null,
      source: `jev/${STUB_MODEL}`,
    },
    { choice: { provider: REVIEWER_PROVIDER, id: REVIEWER_ID } } as RouteResult,
    undefined,
  ).split(NAME);
  const notes = async () =>
    (await page.evaluate((id) => window.infinitary.tasks.detail(id), review.id)).events
      .filter((event) => event.kind === "note")
      .map((event) => event.text);
  await expect
    .poll(notes, { timeout: 30_000 })
    .toContainEqual(expect.stringContaining(took ?? NAME));
  const briefed = () =>
    (mockProvider?.requestBodies() ?? []).find(
      (body) => body.includes(REVIEW_BRIEF_MARKER) && body.includes(MOCK_CAREFUL_CARD_TITLE),
    );
  await expect.poll(() => briefed() ?? null, { timeout: 30_000 }).not.toBeNull();
  expect((JSON.parse(briefed() as string) as { model: string }).model).toBe(REVIEWER_ID);
});
