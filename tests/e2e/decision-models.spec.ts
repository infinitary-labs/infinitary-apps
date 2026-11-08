import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "../../src/core/orchestrator/seat";
import { KIND_CLASSIFIER_OPENING } from "../../src/core/pi/piResources";
import { USE_OPENROUTER_DECISION_MODEL } from "../../src/renderer/src/settings/modelsWords";
import {
  DECISION_MODEL_CATALOG,
  decisionConsent,
  decisionKeyRejectedNote,
  decisionModelRow,
  type OpenRouterDecisionOffering,
  openRouterDecisionConsent,
  openRouterDecisionLine,
} from "../../src/shared/decisions";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { CLAUDE_SEAT_ACCOUNT, launchClaudeSeat, say } from "./claudeSeat";
import { type LaunchedApp, launchApp } from "./launch";
import { mockModelsJson } from "./mockModels";
import {
  CLASSIFY_CHORE_MARKER,
  type MockProviderServer,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "./mockProvider";
import { modelsSection } from "./modelsBoard";
import { promptInput } from "./prompt";
import { seedQuotaFixture } from "./quotaFixtures";
import { feedLine, startedLine, taskKey } from "./rails";

/**
 * Decision models (S7b, captain-approved design
 * `fm3000-decision-models-s7-design-s1/report.md`). The three things this
 * spec is here to hold:
 *
 * - **Off by default means zero requests.** A fresh install spawns a
 *   crewmate - which classifies - and the stub endpoint never hears from
 *   it. That is the whole of "the user acts twice or nothing leaves".
 * - **On means ONE bounded request per spawn**, and the answer reaches the
 *   record as `classifier:jev/<model>`.
 * - **A vendor 401 is honest**: one feed line, the row says `key rejected`,
 *   and one of the user's own subscription models answers in its place with
 *   the reason on the routing decision - never a stall and never a card.
 *
 * - **A machine with only Claude signed in classifies on Claude**: the
 *   question goes to the machine's own client once, with room for hidden
 *   thinking before its one word (INF-1451), and the kind it answers
 *   reaches the record under Claude's model.
 *
 * The consent reaches the form from its shared owner; the focused consent
 * test owns the wording, while this journey holds the opt-in boundary.
 *
 * Like the live quota sensor's spec, only the endpoint's address is
 * redirected (a dev/e2e-gated override a packaged build refuses to read).
 * No real key exists anywhere in this file.
 *
 * Two apps, because the halves want opposite worlds: the Models board only
 * renders once an account's models are in the pool, and an account with a
 * fake credential cannot serve a crewmate turn. So the surface runs against
 * a seeded account the way the other Settings specs do, and the calls run
 * against the mock provider, driving the same four channels the buttons
 * drive.
 */

const STUB_KEY = "ts-live-e2e-0000000000";

type StubJev = {
  server: Server;
  url: string;
  /** Every request the app made, in order: what it sent and with which bearer. */
  seen: { bearer: string; contentType: string; body: unknown }[];
  /** 200 answers with a choice; set to 401 to play the vendor rejecting the key. */
  status: number;
  choice: string;
  confidence: number;
  /** The model the reply names as having answered. */
  served: string;
  /** The cost the reply states for the call, when it states one. */
  cost?: number;
};

async function startStubJev(): Promise<StubJev> {
  const stub: StubJev = {
    server: createServer(),
    url: "",
    seen: [],
    status: 200,
    choice: "chore",
    confidence: 0.93,
    served: "jev-1.13.0",
  };
  stub.server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      stub.seen.push({
        bearer: (request.headers.authorization ?? "").replace(/^Bearer /, ""),
        contentType: request.headers["content-type"] ?? "",
        body,
      });
      if (stub.status !== 200) {
        response.writeHead(stub.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: stub.served,
          answers: {
            kind: {
              type: "choice",
              choice: stub.choice,
              confidence: stub.confidence,
              probabilities: { [stub.choice]: stub.confidence },
            },
          },
          usage: {
            input_tokens: 412,
            output_tokens: 0,
            ...(stub.cost === undefined ? {} : { cost: stub.cost }),
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/v1/systemone`;
  return stub;
}

type TaskRow = { id: string; key: string; title: string; shape_json: string | null };

function withDb<T>(userDataDir: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(userDataDir, "firstmate.db"), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function readTasks(userDataDir: string): TaskRow[] {
  return withDb(
    userDataDir,
    (db) =>
      db
        .prepare("SELECT id, key, title, shape_json FROM task_records ORDER BY created_at, seq")
        .all() as TaskRow[],
  );
}

function readReasons(userDataDir: string, taskId: string): string[] {
  return withDb(userDataDir, (db) =>
    (
      db
        .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ? ORDER BY id")
        .all(taskId) as { reasons_json: string }[]
    ).flatMap((row) => JSON.parse(row.reasons_json) as string[]),
  );
}

function readUsage(userDataDir: string): { provider: string | null; model: string | null }[] {
  return withDb(
    userDataDir,
    (db) =>
      db.prepare("SELECT provider, model FROM usage_events ORDER BY id").all() as {
        provider: string | null;
        model: string | null;
      }[],
  );
}

function shapeOf(task: TaskRow): Record<string, unknown> {
  return JSON.parse(task.shape_json ?? "{}") as Record<string, unknown>;
}

let stub: StubJev;

test.beforeAll(async () => {
  stub = await startStubJev();
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

test.describe("the surface", () => {
  let launched: LaunchedApp;

  /** One signed-in account, so the Models board has models to show. */
  function seedCodexAccount(userDataDir: string): void {
    seedAccountStore(userDataDir, "openai-codex", "acct_codex_decisions", {
      recursive: true,
      mode: 0o700,
    });
    seedAccountAuth(
      userDataDir,
      "openai-codex",
      "acct_codex_decisions",
      {
        "openai-codex": {
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        },
      },
      { mode: 0o600 },
    );
    seedAccountRegistry(
      userDataDir,
      [
        {
          id: "acct_codex_decisions",
          providerId: "openai-codex",
          label: "Personal",
          kind: "subscription_oauth",
          createdAt: Date.now(),
          enabled: true,
        },
      ],
      {},
      { mode: 0o600 },
    );
  }

  /** Idempotent: a test that left Settings open finds it open. */
  async function openDecisions(page: Page) {
    const settings = page.getByRole("button", { name: "Settings" });
    if (await settings.isVisible().catch(() => false)) await settings.click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const models = modelsSection(page);
    await expect(models).toBeVisible({ timeout: 20_000 });
    const head = models.getByRole("button", { name: /^Models/ });
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    return page.locator('[data-slot-group="decisions"]');
  }

  async function closeSettings(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
      "data-screen-label",
      "Settings",
    );
  }

  test.beforeAll(async () => {
    const fixtureDir = seedQuotaFixture(
      scratchDir("infinitary-decisions-quota-"),
      {
        generatedAt: new Date().toISOString(),
        fetchedAt: Date.now(),
        providers: [
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct_codex_decisions",
            accountLabel: "Personal",
            status: "ok",
            stale: false,
            windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
          },
        ],
      },
      {
        generatedAt: new Date().toISOString(),
        models: [{ provider: "codex", id: "gpt-5.5", label: "gpt-5.5" }],
      },
    );
    const userDataDir = scratchDir("infinitary-e2e-decisions-ui-");
    seedCodexAccount(userDataDir);
    launched = await launchApp({
      userDataDir,
      env: { INFINITARY_JEV_URL: stub.url, INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir },
    });
  });

  test.afterAll(async () => {
    await launched.close();
  });

  test("turning it on takes the consent and the key, and stores neither in the row; removing it takes them back", async () => {
    const { page, userDataDir } = launched;
    await test.step("turning it on takes the consent and the key, and stores neither in the row", async () => {
      const group = await openDecisions(page);

      await group.getByRole("button", { name: "Decision model actions" }).click();
      await page.getByRole("menuitem", { name: "Use Jev (TypeSafe)" }).click();

      // The one form: what leaves the machine, then the key, then one button.
      const form = page.getByRole("form", { name: "Turn on Jev" });
      const native = DECISION_MODEL_CATALOG.find((model) => model.id === "jev");
      if (!native) throw new Error("Jev is missing from the decision catalog");
      for (const paragraph of decisionConsent(native)) await expect(form).toContainText(paragraph);
      const field = form.getByLabel("Jev key");
      // Write-only: a password field, empty, and nothing can read a stored key
      // back into it.
      await expect(field).toHaveAttribute("type", "password");
      await expect(field).toHaveValue("");
      await field.fill(STUB_KEY);
      await form.getByRole("button", { name: "Turn on" }).click();

      await expect
        .poll(() => page.evaluate(() => window.infinitary.models.decisions()))
        .toMatchObject({ settings: { answerer: { kind: "native", id: "jev" } } });

      // The key is its own 0600 file in its own 0700 directory - never the
      // settings row, which is read, exported and pushed.
      const keyFile = join(userDataDir, "decisions", "jev", "key");
      await expect.poll(() => existsSync(keyFile), { timeout: 10_000 }).toBe(true);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(userDataDir, "decisions", "jev")).mode & 0o777).toBe(0o700);
      const row = withDb(
        userDataDir,
        (db) =>
          db.prepare("SELECT value FROM settings WHERE key = 'decisions'").get() as
            | { value: string }
            | undefined,
      );
      expect(row?.value ?? "").not.toContain(STUB_KEY);
      expect(row?.value ?? "").toContain('"enabled":true');
    });

    await test.step("removing it takes the key, the switch and the pick with it", async () => {
      const group = await openDecisions(page);
      await group.getByRole("button", { name: "Decision model actions" }).click();
      await page.getByRole("menuitem", { name: "Remove Jev" }).click();
      await expect
        .poll(() => page.evaluate(() => window.infinitary.models.decisions()))
        .toMatchObject({ settings: { answerer: { kind: "adapted", offering: "auto" } } });
      await closeSettings(page);

      await expect
        .poll(() => existsSync(join(userDataDir, "decisions", "jev")), { timeout: 10_000 })
        .toBe(false);
    });
  });
});

test.describe("the calls", () => {
  let launched: LaunchedApp;

  /** Spawns one crewmate and waits for the classify-then-dispatch to land. */
  async function spawn(title: string): Promise<TaskRow> {
    const { page, userDataDir } = launched;
    const before = readTasks(userDataDir).length;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    await expect(startedLine(page, await taskKey(page, title))).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readTasks(userDataDir).length, { timeout: 20_000 }).toBe(before + 1);
    const tasks = readTasks(userDataDir);
    return tasks[tasks.length - 1] as TaskRow;
  }

  /**
   * Turns Jev on through the channels the form's button drives; the surface
   * half above proves the button drives them.
   */
  async function turnOnJev(): Promise<void> {
    const { page } = launched;
    const view = await page.evaluate(
      (key) => window.infinitary.models.setDecisionKey("jev", key),
      STUB_KEY,
    );
    expect(view.natives[0]).toMatchObject({ keyStored: true, consented: true });
    await page.evaluate(() =>
      window.infinitary.models.setDecisions({
        version: 1,
        answerer: { kind: "native", id: "jev" },
        egress: { jev: { enabled: true, consentedVersion: 1 } },
      }),
    );
  }

  test.beforeAll(async () => {
    launched = await launchApp({
      withMockProvider: true,
      env: { INFINITARY_JEV_URL: stub.url },
    });
  });

  test.afterAll(async () => {
    await launched.close();
  });

  test("off by default: a fresh install classifies a spawn without touching the endpoint", async () => {
    const { userDataDir } = launched;
    const task = await spawn("Meter fix");

    // The classification happened - on one of the captain's own subscription
    // models, through the adapter, exactly as it did before S7.
    expect(String(shapeOf(task).kind_source ?? "")).toMatch(/^classifier/);
    expect(String(shapeOf(task).kind_source ?? "")).not.toContain("jev");
    expect(shapeOf(task).kind_detail).toBeUndefined();

    // And nothing left the machine for the new endpoint. Not "we did not
    // show it" - the endpoint was never called.
    expect(stub.seen).toEqual([]);
    // No key store exists either: the directory is made by a write, and
    // there has been no write.
    expect(existsSync(join(userDataDir, "decisions"))).toBe(false);
  });

  test("turned on, it answers one bounded request per spawn", async () => {
    const { userDataDir } = launched;
    stub.status = 200;
    await turnOnJev();

    const before = stub.seen.length;
    const task = await spawn("Wire the meter");

    // ONE request per spawn, with the captain's own key as a bearer and
    // nothing claiming to be a browser.
    const calls = stub.seen.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bearer).toBe(STUB_KEY);
    expect(calls[0]?.contentType).toBe("application/json");
    const sent = calls[0]?.body as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    expect(sent.model).toBe("jev-latest");
    // Only the bounded fact set the consent copy enumerates.
    for (const name of Object.keys(sent.state)) {
      expect(["title", "goal", "user_words", "how_to_work", "repository", "basis"]).toContain(name);
    }
    // The abstention is withheld from the model, so its own distribution is
    // over the real options.
    expect(Object.keys(sent.questions.kind?.criteria ?? {})).not.toContain("unclear");

    // The answer reaches the record as the native model, and its certainty
    // is prose on the routing decision rather than a typed field.
    expect(shapeOf(task).kind).toBe("chore");
    expect(shapeOf(task).kind_source).toBe("classifier:jev/jev-1.13.0");
    expect(shapeOf(task)).not.toHaveProperty("kind_confidence");
    expect(shapeOf(task).kind_detail).toBe("p=0.93");
    expect(readReasons(userDataDir, task.id).join("\n")).toContain(
      "shape kind=chore (classifier:jev/jev-1.13.0)",
    );
    // And it is billed where the work is.
    expect(readUsage(userDataDir)).toContainEqual({ provider: "typesafe", model: "jev-1.13.0" });
  });

  test("a rejected key is one feed line, a row that says so, and the captain's own model answering", async () => {
    const { page, userDataDir } = launched;
    await turnOnJev();
    stub.status = 401;
    const before = stub.seen.length;
    const task = await spawn("Read the trailer");

    // It tried once, was refused, and one of the captain's own subscription
    // models answered in its place - never a stall, never a card.
    expect(stub.seen.slice(before)).toHaveLength(1);
    expect(String(shapeOf(task).kind_source ?? "")).toMatch(/^classifier/);
    expect(String(shapeOf(task).kind_source ?? "")).not.toContain("jev");
    expect(String(shapeOf(task).kind_detail ?? "")).toContain(
      "decision model jev failed: key-rejected",
    );
    expect(readReasons(userDataDir, task.id).join("\n")).toContain("decision model jev failed");

    await expect(feedLine(page, decisionKeyRejectedNote(decisionModelRow("jev").name))).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    const view = await page.evaluate(() => window.infinitary.models.decisions());
    expect(view.natives[0]?.state).toBe("key-rejected");
  });

  test("removing it stops the requests where they stand", async () => {
    const { page, userDataDir } = launched;
    await turnOnJev();
    await page.evaluate(() => window.infinitary.models.removeDecisionKey("jev"));
    await expect
      .poll(() => existsSync(join(userDataDir, "decisions", "jev")), { timeout: 10_000 })
      .toBe(false);

    stub.status = 200;
    const before = stub.seen.length;
    const task = await spawn("Back to our own");
    expect(stub.seen.slice(before)).toEqual([]);
    expect(String(shapeOf(task).kind_source ?? "")).not.toContain("jev");
  });
});

/**
 * Claude's allowance from a fixture and, when asked, its model catalog: the
 * catalog ranks the slotted models for the walk. Without one - before the
 * first reading, or when it fails - the slots alone must still put the
 * cheapest first.
 */
function claudeQuotaFixture(withCatalog: boolean): string {
  const now = Date.now();
  return seedQuotaFixture(
    scratchDir("infinitary-decisions-claude-quota-"),
    {
      generatedAt: new Date(now).toISOString(),
      fetchedAt: now,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: CLAUDE_SEAT_ACCOUNT,
          accountLabel: "kun@example.com",
          status: "ok",
          stale: false,
          windows: [{ id: "five_hour", label: "session", percentRemaining: 80 }],
        },
      ],
    },
    withCatalog
      ? {
          generatedAt: new Date(now).toISOString(),
          models: ["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-5-5"].map((id) => ({
            provider: "claude",
            id,
            label: id,
          })),
        }
      : undefined,
  );
}

for (const world of [
  { name: "a Claude-only machine", withCatalog: true },
  { name: "a Claude-only machine with no model catalog", withCatalog: false },
]) {
  test.describe(world.name, () => {
    let mockProvider: MockProviderServer;
    let launched: LaunchedApp;

    test.beforeAll(async () => {
      mockProvider = await startMockProvider();
      launched = await launchClaudeSeat({
        mockProvider,
        env: { INFINITARY_QUOTA_FIXTURE_DIR: claudeQuotaFixture(world.withCatalog) },
      });
    });

    test.afterAll(async () => {
      await launched.close();
      await mockProvider.close();
    });

    test("classifies a spawn's kind on the machine's own Claude client", async () => {
      const { page, userDataDir } = launched;
      const title = `Please ${CLASSIFY_CHORE_MARKER}`;
      await say(page, `${SPAWN_PROMPT_MARKER} ${title}`);
      await expect(startedLine(page, await taskKey(page, title))).toBeVisible({
        timeout: 30_000,
      });
      const task = readTasks(userDataDir).find((row) => row.title === title);
      expect(task).toBeDefined();

      // The kind came from Claude's cheapest slotted model, answering the one
      // question through the adapter - not an abstention, not a failure.
      expect(shapeOf(task as TaskRow).kind).toBe("chore");
      expect(shapeOf(task as TaskRow).kind_source).toBe(
        "classifier:anthropic-claude/claude-haiku-5-5",
      );

      // The machine's own client asked it, once. Claude counts hidden thinking
      // as output, so the app sends no word-sized cap that thinking could use
      // up before the answer (INF-1451); the allowance is the client's own.
      const headers = mockProvider.requestHeaders();
      const asked = mockProvider
        .requestBodies()
        .filter(
          (body, index) =>
            body.includes(KIND_CLASSIFIER_OPENING) &&
            body.includes(CLASSIFY_CHORE_MARKER) &&
            headers[index]?.["user-agent"]?.startsWith("claude-cli/") === true,
        )
        .map(
          (body) => JSON.parse(body) as { model?: string; max_tokens?: number; thinking?: unknown },
        );
      expect(asked).toEqual([expect.objectContaining({ model: "claude-haiku-5-5" })]);
      expect(asked[0]?.max_tokens).toBeGreaterThan(CLASSIFIER_MAX_OUTPUT_TOKENS);

      // And its burn is billed where the work is, on Claude.
      expect(readUsage(userDataDir)).toContainEqual({
        provider: "anthropic-claude",
        model: "claude-haiku-5-5",
      });
    });
  });
}

test("a chosen model answers decisions in use or not, and a chosen model that is gone is never named", async () => {
  const mockProvider = await startMockProvider();
  const launched = await launchClaudeSeat({
    mockProvider,
    env: { INFINITARY_QUOTA_FIXTURE_DIR: claudeQuotaFixture(true) },
  });
  const { page, userDataDir } = launched;
  const askedModels = () =>
    mockProvider
      .requestBodies()
      .filter((body) => body.includes(KIND_CLASSIFIER_OPENING))
      .map((body) => (JSON.parse(body) as { model?: string }).model);
  const spawn = async (title: string) => {
    await say(page, `${SPAWN_PROMPT_MARKER} ${title}`);
    await expect(startedLine(page, await taskKey(page, title))).toBeVisible({ timeout: 30_000 });
    const task = readTasks(userDataDir).find((row) => row.title === title);
    if (!task) throw new Error(`no task titled ${title}`);
    return shapeOf(task);
  };
  const openDecisions = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const head = modelsSection(page).getByRole("button", { name: /^Models/ });
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    return page.locator('[data-slot-group="decisions"]');
  };
  try {
    // A chosen model that is not in use answers.
    const chosen = "claude-sonnet-5-5";
    const before = await page.evaluate(() => window.infinitary.models.slots());
    const row = before.models.find(
      (model) => model.provider === "anthropic-claude" && model.id === chosen,
    );
    if (!row) throw new Error(`${chosen} is not listed`);
    for (const slot of row.slots) {
      await page.evaluate(
        ([key, level]) =>
          window.infinitary.models.setSlotMembership(key as string, level as "medium", false),
        [`anthropic-claude/${chosen}`, slot],
      );
    }
    const group = await openDecisions();
    await group.getByRole("button", { name: "Decision model actions" }).click();
    await page.getByRole("menuitem", { name: "Use a specific model", exact: true }).click();
    await group
      .getByRole("button", { name: `Answer decisions with ${row.label}`, exact: true })
      .click();
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.models.decisions())).pinned)
      .toBe("ready");
    await expect(group).toContainText(row.label);
    await page.keyboard.press("Escape");
    const asked = askedModels().length;
    const picked = await spawn(`Please ${CLASSIFY_CHORE_MARKER} on the chosen model`);
    expect(picked.kind_source).toBe(`classifier:anthropic-claude/${chosen}`);
    expect(askedModels().slice(asked)).toEqual([chosen]);

    // A chosen model no account serves any more is never named; the walk answers.
    const gone = "claude-sonnet-4-5";
    await page.evaluate(
      (offering) =>
        window.infinitary.models.setDecisions({
          version: 1,
          answerer: { kind: "adapted", offering },
          egress: {},
        }),
      `anthropic-claude/${gone}`,
    );
    expect((await page.evaluate(() => window.infinitary.models.decisions())).pinned).toBe(
      "fallback",
    );
    const reopened = await openDecisions();
    await expect(reopened.locator('[data-decision-row="answerer"]')).toBeVisible();
    await expect(reopened).not.toContainText(gone);
    await expect(modelsSection(page)).not.toContainText(gone);
    await page.keyboard.press("Escape");
    const walked = await spawn(`Please ${CLASSIFY_CHORE_MARKER} with the chosen model gone`);
    expect(walked.kind_source).toBe("classifier:anthropic-claude/claude-haiku-5-5");
  } finally {
    await launched.close();
    await mockProvider.close();
  }
});

test("OpenRouter selection uses its account, records what served it, remembers consent and falls back on no credit", async () => {
  const local = await startStubJev();
  // OpenRouter's reply names the dated model that answered and the cost of
  // the call, which is not Pi's catalog price for the same tokens.
  local.served = "typesafe/jev-1.13-20260917";
  local.cost = 0.0000317;
  const userDataDir = scratchDir("infinitary-e2e-openrouter-decisions-");
  const accountId = "acct_openrouter_decisions";

  seedAccountStore(userDataDir, "openrouter", accountId, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    userDataDir,
    "openrouter",
    accountId,
    { openrouter: { type: "api_key", key: "fake-openrouter-decisions" } },
    { mode: 0o600 },
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: accountId,
        providerId: "openrouter",
        label: "Personal",
        kind: "api_key",
        createdAt: Date.now(),
        enabled: true,
      },
    ],
    { openrouter: accountId },
    { mode: 0o600 },
  );
  const fixtureDir = seedQuotaFixture(
    scratchDir("infinitary-openrouter-decisions-quota-"),
    {
      generatedAt: new Date().toISOString(),
      fetchedAt: Date.now(),
      providers: [
        {
          provider: "openrouter",
          label: "OpenRouter",
          accountId,
          accountLabel: "Personal",
          status: "ok",
          stale: false,
          windows: [],
        },
      ],
    },
    {
      generatedAt: new Date().toISOString(),
      models: [{ provider: "openrouter", id: "openai/gpt-4o-mini", label: "GPT-4o mini" }],
    },
  );
  const env = {
    INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
    INFINITARY_OPENROUTER_DECISIONS_BASE_URL: local.url.replace(/\/systemone$/, ""),
  };
  const modelsJson = (port: number) => {
    const config = JSON.parse(mockModelsJson(port));
    config.providers.openrouter = { baseUrl: `http://127.0.0.1:${port}/v1` };
    return JSON.stringify(config);
  };
  let launched = await launchApp({ userDataDir, withMockProvider: true, modelsJson, env });
  await launched.page.evaluate(() =>
    window.infinitary.settings.setFirstmateModel({ provider: "fm-mock", id: "mock-1" }),
  );
  const open = async () => {
    const page = launched.page;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const head = modelsSection(page).getByRole("button", { name: /^Models/ });
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    return page.locator('[data-slot-group="decisions"]');
  };
  const spawn = async (title: string) => {
    await say(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
    await expect(startedLine(launched.page, await taskKey(launched.page, title))).toBeVisible({
      timeout: 30_000,
    });
    return readTasks(userDataDir).find((row) => row.title === title) as TaskRow;
  };
  try {
    let group = await open();
    const offered = (await launched.page.evaluate(() => window.infinitary.models.decisions()))
      .openrouter?.models;
    expect(offered).toBeDefined();
    expect(offered?.length).toBeGreaterThan(0);
    const offering = (id: string): OpenRouterDecisionOffering => {
      const model = offered?.find((entry) => entry.id === id);
      if (!model) throw new Error(`OpenRouter offers no ${id}`);
      return model;
    };
    const jev = offering("typesafe/jev-1.13");
    const kev = offering("jaredpalmer/kev-4b");
    expect(local.seen).toHaveLength(0);
    await group.getByRole("button", { name: "Decision model actions" }).click();
    await launched.page.getByRole("menuitem", { name: USE_OPENROUTER_DECISION_MODEL }).click();
    const picker = group.getByRole("group", { name: "OpenRouter decision models" });
    await expect(picker.getByRole("button")).toHaveCount(offered?.length ?? 0);
    await expect(picker).not.toContainText("Span-01");
    await picker.getByRole("button", { name: /^Jev 1.13/ }).click();
    const form = group.getByRole("form", { name: "Turn on Jev 1.13 through OpenRouter" });
    for (const sentence of openRouterDecisionConsent(jev))
      await expect(form).toContainText(sentence);
    await expect(form.locator("input")).toHaveCount(0);
    await group.screenshot({ path: test.info().outputPath("openrouter-consent.png") });
    await form.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(group).toContainText(openRouterDecisionLine(jev));
    await group.screenshot({ path: test.info().outputPath("openrouter-on.png") });
    await launched.page.keyboard.press("Escape");
    const task = await spawn("OpenRouter decision work");
    expect(local.seen).toHaveLength(1);
    expect(local.seen[0]?.bearer).toBe("fake-openrouter-decisions");
    expect(shapeOf(task)).toMatchObject({
      kind: "chore",
      kind_source: "classifier:openrouter/typesafe/jev-1.13-20260917",
      kind_detail: "p=0.93",
    });
    expect(readUsage(userDataDir)).toContainEqual({
      provider: "openrouter",
      model: "typesafe/jev-1.13-20260917",
    });
    const billed = withDb(userDataDir, (db) =>
      db
        .prepare(
          "SELECT task_id, account_id, model, model_source, input, cost, cost_source FROM usage_events WHERE provider = 'openrouter'",
        )
        .all(),
    );
    expect(billed).toContainEqual({
      task_id: task.id,
      account_id: accountId,
      model: "typesafe/jev-1.13-20260917",
      model_source: "served",
      input: 412,
      cost: 0.0000317,
      cost_source: "reported",
    });
    // The row's last answer belongs to the pick, whichever model served it.
    expect(
      (await launched.page.evaluate(() => window.infinitary.models.decisions())).openrouter?.last,
    ).toMatchObject({ value: "chore", tokens: 412 });
    await launched.close();
    launched = await launchApp({ userDataDir, withMockProvider: true, modelsJson, env });
    await launched.page.evaluate(() =>
      window.infinitary.settings.setFirstmateModel({ provider: "fm-mock", id: "mock-1" }),
    );
    group = await open();
    await expect(group).toContainText(openRouterDecisionLine(jev));
    await group.getByRole("button", { name: "Decision model actions" }).click();
    await launched.page.getByRole("menuitem", { name: USE_OPENROUTER_DECISION_MODEL }).click();
    await group.getByRole("button", { name: /^Kev 4B/ }).click();
    await expect(group).toContainText(openRouterDecisionLine(kev));
    await expect(group.getByRole("form")).toHaveCount(0);
    await launched.page.keyboard.press("Escape");
    local.status = 402;
    const fallback = await spawn(`Please ${CLASSIFY_CHORE_MARKER}`);
    expect(shapeOf(fallback).kind_detail).toContain("decision model openrouter failed: no-credit");
    expect(shapeOf(fallback).kind).toBe("chore");
    expect(String(shapeOf(fallback).kind_source)).toMatch(/^classifier:openrouter\//);
    expect(shapeOf(fallback).kind_detail).toContain("answered by adapted:openrouter/");
    const journey = test.info().outputPath("openrouter-journey.json");
    writeFileSync(
      journey,
      JSON.stringify(
        { sent: local.seen, shape: shapeOf(task), billed, fallback: shapeOf(fallback) },
        null,
        2,
      ),
    );
    await test
      .info()
      .attach("OpenRouter decision journey", { path: journey, contentType: "application/json" });
    // Signing out removes the choice without removing the stored pick.
    await launched.page.evaluate((id) => window.infinitary.accounts.remove(id), accountId);
    const signedOut = await launched.page.evaluate(() => window.infinitary.models.decisions());
    expect(signedOut.openrouter?.models).toEqual([]);
    expect(signedOut.settings.answerer).toEqual({
      kind: "openrouter",
      model: "jaredpalmer/kev-4b",
    });
    await launched.page.getByRole("button", { name: "Settings", exact: true }).click();
    await launched.page.getByRole("tab", { name: "Intelligence" }).click();
    await expect(
      launched.page.getByRole("menuitem", { name: USE_OPENROUTER_DECISION_MODEL, exact: true }),
    ).toHaveCount(0);
  } finally {
    await launched.close();
    local.server.closeAllConnections();
    await new Promise<void>((resolve) => local.server.close(() => resolve()));
  }
});
