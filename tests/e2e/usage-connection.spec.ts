import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CustodySlot } from "../../src/core/secrets/custody";
import { USAGE_CONNECTION_FILE } from "../../src/core/usageReport/usageConnection";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeSeat, say } from "./claudeSeat";
import { waitForFirstmateIdle } from "./crew";
import { leaveSettings } from "./handoverCards";
import type { LaunchedApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  MOCK_COMPLETION_TEXT,
  mockSpawnGoal,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, taskKey } from "./rails";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow, settingsSection } from "./settings";
import { shownCard } from "./stack";
import { usageTab } from "./usage";
import { focusOn, pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

type Arrived = { path: string; headers: IncomingHttpHeaders; body: any };

const TOKEN = "glc_invented-grafana-cloud-token";
const TURN_WORDS = "tally the idle meter";

/**
 * INF-6587's approved plan, piece 3 (docs/usage-report.md, "The person's
 * reporting connection"): the person adds a reporting connection in
 * Settings → Intelligence by keys, with an Authorization header kept in
 * Secrets, and no file holds the header's value. Settings → Usage names the
 * host. The connection sends every ten minutes and once more at quit, so
 * quitting delivers the crew's turn to the person's collector, a local HTTP
 * server this test owns, in the standard format with the header, and with
 * prompts and replies off, as the form starts, none of the turn's words. After a
 * relaunch Secrets names the header as the reporting connection's, and
 * Remove forgets the connection and its header.
 * The app, its Secrets controller and its sending are real; custody is the
 * Secrets harness's disposable stand-in, kept across the relaunch as a
 * computer's would be, and the model is the mock provider.
 */
/** The person's collector: a local HTTP server keeping each batch it is sent. */
async function startCollector() {
  const arrived: Arrived[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      arrived.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(text) });
      response.end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    arrived,
    url,
    host: new URL(url).host,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test("the person adds a reporting connection by keys and the crew's usage reaches it", async () => {
  test.setTimeout(4 * 60_000);
  const collector = await startCollector();
  const { arrived, url, host } = collector;
  let custody: Map<CustodySlot, Buffer> = new Map();
  const userDataDir = scratchDir("infinitary-usage-connection-");
  let launched: Awaited<ReturnType<typeof launchSecrets>> | undefined = await launchSecrets({
    userDataDir,
  });
  try {
    const { app, page } = launched;
    const row = settingRow(page, "usage-connection");

    await test.step("Add connection, filled and saved by keys", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const intelligence = page.locator('[role="tab"][id$="-tab-subscriptions"]');
      await focusOn(intelligence);
      await pressKey(intelligence, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionNone());
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionAdd() }), "Enter");
      const form = row.locator("[data-usage-connection-form]");
      const address = form.getByLabel(m.settingsUsageConnectionAddress());
      await expect(address).toBeFocused();
      await typeInto(address, url);
      await expect(form.getByLabel(m.settingsUsageConnectionReads())).toHaveValue("standard");
      await expect(
        form.getByRole("switch", { name: m.settingsUsageConnectionWords() }),
      ).toHaveAttribute("aria-checked", "false");
      await pressKey(
        form.getByRole("button", { name: m.settingsUsageConnectionAddHeader() }),
        "Enter",
      );
      const name = form.getByLabel(m.settingsUsageConnectionHeaderName());
      await expect(name).toBeFocused();
      await typeInto(name, "Authorization");
      await pressKey(name, "Tab");
      const value = form.getByLabel(m.settingsUsageConnectionHeaderValue());
      await expect(value).toBeFocused();
      await typeInto(value, `Bearer ${TOKEN}`);
      await pressKey(value, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionStandard({ host }));
      await expect(form).toHaveCount(0);
      await expect(
        row.getByRole("button", { name: m.settingsUsageConnectionEdit() }),
      ).toBeFocused();
      const saved = readFileSync(join(userDataDir, USAGE_CONNECTION_FILE), "utf8");
      expect(saved).toContain(url);
      expect(saved).not.toContain(TOKEN);
    });

    await test.step("the crew takes a turn", async () => {
      await leaveSettings(page);
      const input = promptInput(page);
      await expect(input).toBeEnabled();
      await input.fill(`please ${ANSWER_PROMPT_MARKER}: ${TURN_WORDS}`);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).some(
              (card) => card.title === MOCK_ANSWER_TITLE,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await waitForFirstmateIdle(page);
    });

    await test.step("Settings → Usage names where it goes", async () => {
      await runFromSearch(app, page, "settings.usage");
      await expect(usageTab(page).section.locator("[data-usage-reporting-connection]")).toHaveText(
        m.settingsUsageReportsConnectionTo({ host }),
      );
    });

    await test.step("quitting sends what waits, with the kept header", async () => {
      expect(arrived).toEqual([]);
      // The computer's custody outlives the app, so the relaunch opens the same Secrets.
      const slots = await app.evaluate(() =>
        [...(globalThis as SecretsJourneyGlobal).secretsJourney.custody.slots].map(
          ([slot, bytes]) => [slot, bytes.toString("base64")] as const,
        ),
      );
      custody = new Map(slots.map(([slot, bytes]) => [slot, Buffer.from(bytes, "base64")]));
      await launched?.close();
      launched = undefined;
      expect(arrived.some((entry) => entry.path === "/v1/metrics")).toBe(true);
      for (const entry of arrived) expect(entry.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const names = arrived
        .filter((entry) => entry.path === "/v1/metrics")
        .flatMap((entry) => entry.body.resourceMetrics)
        .flatMap((resource: any) => resource.scopeMetrics)
        .flatMap((scope: any) => scope.metrics.map((metric: any) => metric.name));
      expect(names).toContain("gen_ai.client.token.usage");
      // With prompts and replies off, no words of the turn leave.
      const sent = JSON.stringify(arrived.map((entry) => entry.body));
      expect(sent).not.toContain(TURN_WORDS);
      expect(sent).not.toContain(MOCK_ANSWER_TITLE);
      expect(sent).not.toContain("gen_ai.input.messages");
    });

    launched = await launchSecrets({ userDataDir, leftCustody: custody });
    const relaunched = launched;
    const page2 = relaunched.page;
    const row2 = settingRow(page2, "usage-connection");

    await test.step("Secrets names the header as the reporting connection's", async () => {
      await runFromSearch(relaunched.app, page2, "settings.secrets");
      const secret = settingsSection(page2, "secrets").locator("li[data-secret-row]", {
        hasText: m.settingsUsageConnectionSecretLabel({ name: "Authorization" }),
      });
      const summary = secret.locator(":scope > details > summary");
      await focusOn(summary);
      await pressKey(summary, "Enter");
      await expect(secret.locator('[data-secrets-kept="usage-report"]')).toContainText(
        m.settingsSecretsKeptUsageReport(),
      );
      await pressKey(
        secret.getByRole("button", { name: m.settingsSecretsManageInIntelligence() }),
        "Enter",
      );
      await expect(
        row2.getByRole("button", { name: m.settingsUsageConnectionEdit() }),
      ).toBeFocused();
    });

    await test.step("Remove, by keys, forgets the connection and its header", async () => {
      const row = row2;
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionRemove() }), "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionRemoveWarning());
      const confirm = row.getByRole("button", { name: m.settingsUsageConnectionRemoveConfirm() });
      await expect(confirm).toBeFocused();
      await pressKey(confirm, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionNone());
      expect(existsSync(join(userDataDir, USAGE_CONNECTION_FILE))).toBe(false);
      await runFromSearch(relaunched.app, page2, "settings.secrets");
      await expect(
        settingsSection(page2, "secrets").locator("li[data-secret-row]", {
          hasText: m.settingsUsageConnectionSecretLabel({ name: "Authorization" }),
        }),
      ).toHaveCount(0);
    });
  } finally {
    await launched?.close();
    await collector.close();
  }
});

/** A key of a shape Infinitary recognizes, made up for the run. */
const KEY = "sk-ant-api03-invented-example-key";
/** The task the first mate commissions, whose crewmate takes its own turn. */
const CREW_TITLE = "Count the idle meter's minutes";

/** Each span of one name the collector got, with its attributes by key. */
function spansNamed(arrived: Arrived[], name: string): Record<string, string>[] {
  return arrived
    .filter((entry) => entry.path === "/v1/traces")
    .flatMap((entry) => entry.body.resourceSpans)
    .flatMap((resource: any) => resource.scopeSpans)
    .flatMap((scope: any) => scope.spans)
    .filter((span: any) => span.name === name)
    .map((span: any) =>
      Object.fromEntries(
        span.attributes.map(({ key, value }: any) => [key, Object.values(value)[0]]),
      ),
    );
}

/** Every text and tool call in a span's messages attribute. */
function partsOf(messages: string | undefined): any[] {
  return (JSON.parse(messages ?? "[]") as any[]).flatMap((message) => message.parts);
}

/** Each log event of one name the collector got, with its attributes by key. */
function eventsNamed(arrived: Arrived[], name: string): Record<string, string>[] {
  return arrived
    .filter((entry) => entry.path === "/v1/logs")
    .flatMap((entry) => entry.body.resourceLogs)
    .flatMap((resource: any) => resource.scopeLogs)
    .flatMap((scope: any) => scope.logRecords)
    .filter((record: any) => record.body.stringValue === name)
    .map((record: any) =>
      Object.fromEntries(
        record.attributes.map(({ key, value }: any) => [key, Object.values(value)[0]]),
      ),
    );
}

/** How many answer cards the first mate has shown. */
async function answers(page: LaunchedApp["page"]): Promise<number> {
  return (await page.evaluate(() => window.infinitary.cards.list())).filter(
    (card) => card.title === MOCK_ANSWER_TITLE,
  ).length;
}

/**
 * INF-6587's approved plan, piece 3 (docs/usage-report.md, "Prompts and
 * replies"): the person turns on Send prompts and replies too by keys, and
 * the first mate's turn reaches their collector with its prompt, its reply
 * and the card call's arguments on the turn's span, a key typed into the
 * prompt hidden first. A crewmate's turn arrives on its own span with its
 * brief and its report, read from the crewmate's session. After a relaunch the form still shows the switch on,
 * and in Claude Code's format the next turn arrives as Claude Code's own
 * prompt and tool events, without repeating the first.
 * The app, its session records and its sending are real; the model is the
 * mock provider and the collector a local HTTP server this test owns.
 */
test("prompts and replies reach the person's tool once they turn them on, in either format", async () => {
  test.setTimeout(5 * 60_000);
  const collector = await startCollector();
  const { arrived, url, host } = collector;
  const userDataDir = scratchDir("infinitary-usage-words-");
  let launched: Awaited<ReturnType<typeof launchSecrets>> | undefined = await launchSecrets({
    userDataDir,
  });
  const openRow = async (opened: NonNullable<typeof launched>) => {
    await pressWindowKey(opened.app, ",", ["meta"]);
    const intelligence = opened.page.locator('[role="tab"][id$="-tab-subscriptions"]');
    await focusOn(intelligence);
    await pressKey(intelligence, "Enter");
    return settingRow(opened.page, "usage-connection");
  };
  const turn = async (opened: NonNullable<typeof launched>, words: string) => {
    await leaveSettings(opened.page);
    const shown = await answers(opened.page);
    const input = promptInput(opened.page);
    await expect(input).toBeEnabled();
    await input.fill(`please ${ANSWER_PROMPT_MARKER}: ${words}`);
    await input.press("Enter");
    await expect.poll(() => answers(opened.page), { timeout: 30_000 }).toBeGreaterThan(shown);
    await waitForFirstmateIdle(opened.page);
  };
  try {
    await test.step("Send prompts and replies too, turned on and saved by keys", async () => {
      const row = await openRow(launched as NonNullable<typeof launched>);
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionAdd() }), "Enter");
      const form = row.locator("[data-usage-connection-form]");
      const address = form.getByLabel(m.settingsUsageConnectionAddress());
      await expect(address).toBeFocused();
      await typeInto(address, url);
      await pressKey(address, "Tab");
      const reads = form.getByLabel(m.settingsUsageConnectionReads());
      await expect(reads).toBeFocused();
      await pressKey(reads, "Tab");
      const words = form.getByRole("switch", { name: m.settingsUsageConnectionWords() });
      await expect(words).toBeFocused();
      await pressKey(words, " ");
      await expect(words).toHaveAttribute("aria-checked", "true");
      await pressKey(address, "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionStandardWords({ host }));
      await expect(form).toHaveCount(0);
      await expect(
        row.getByRole("button", { name: m.settingsUsageConnectionEdit() }),
      ).toBeFocused();
    });

    await test.step("the first mate takes a turn whose prompt holds a key", async () => {
      await turn(launched as NonNullable<typeof launched>, `check the staging key ${KEY}`);
    });

    await test.step("a crewmate takes its own turn and reports", async () => {
      const { page } = launched as NonNullable<typeof launched>;
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} ${CREW_TITLE}`);
      await input.press("Enter");
      const key = await taskKey(page, CREW_TITLE);
      await expect(reportLine(page, key).last()).toBeVisible({ timeout: 30_000 });
      await waitForFirstmateIdle(page);
    });

    await test.step("quitting sends each turn's words on its span, the key hidden", async () => {
      await launched?.close();
      launched = undefined;
      const spoken = spansNamed(arrived, "invoke_agent firstmate").find((span) =>
        span["gen_ai.input.messages"]?.includes("check the staging key"),
      );
      expect(
        partsOf(spoken?.["gen_ai.input.messages"]).some(
          (part) =>
            part.type === "text" &&
            part.content.includes("check the staging key [redacted api key]"),
        ),
      ).toBe(true);
      const call = partsOf(spoken?.["gen_ai.output.messages"]).find(
        (part) => part.type === "tool_call" && part.name === "emit_card",
      );
      expect(call?.arguments).toMatchObject({ title: MOCK_ANSWER_TITLE });
      expect(JSON.stringify(arrived)).not.toContain(KEY);
      const crewed = spansNamed(arrived, "invoke_agent crewmate").find(
        (span) => span["gen_ai.input.messages"],
      );
      expect(
        partsOf(crewed?.["gen_ai.input.messages"]).some(
          (part) => part.type === "text" && part.content.includes(mockSpawnGoal(CREW_TITLE)),
        ),
      ).toBe(true);
      expect(partsOf(crewed?.["gen_ai.output.messages"])).toContainEqual({
        type: "text",
        content: MOCK_COMPLETION_TEXT,
      });
    });

    const before = arrived.length;
    launched = await launchSecrets({ userDataDir });
    const relaunched = launched;

    await test.step("Edit shows the switch still on; Claude Code's format saved", async () => {
      const row = await openRow(relaunched);
      await pressKey(row.getByRole("button", { name: m.settingsUsageConnectionEdit() }), "Enter");
      const form = row.locator("[data-usage-connection-form]");
      await expect(
        form.getByRole("switch", { name: m.settingsUsageConnectionWords() }),
      ).toHaveAttribute("aria-checked", "true");
      await form.getByLabel(m.settingsUsageConnectionReads()).selectOption("claude-code");
      await pressKey(form.getByLabel(m.settingsUsageConnectionAddress()), "Enter");
      await expect(row).toContainText(m.settingsUsageConnectionClaudeCodeWords({ host }));
    });

    await test.step("the next turn arrives as Claude Code's prompt and tool events", async () => {
      await turn(relaunched, "summarize the release");
      await relaunched.close();
      launched = undefined;
      const later = arrived.slice(before);
      expect(
        eventsNamed(later, "claude_code.user_prompt").some((event) =>
          event.prompt?.includes("summarize the release"),
        ),
      ).toBe(true);
      const tool = eventsNamed(later, "claude_code.tool_result").find(
        (event) => event.tool_name === "emit_card",
      );
      expect(JSON.parse(tool?.tool_input ?? "{}")).toMatchObject({ title: MOCK_ANSWER_TITLE });
      expect(JSON.stringify(later)).not.toContain("check the staging key");
    });
  } finally {
    await launched?.close();
    await collector.close();
  }
});

/**
 * INF-6587's approved plan, piece 3: the words come "for every provider
 * alike". With the first mate on Claude's own client (tests/e2e/claudeSeat.ts:
 * the SDK's co-released client against the mock provider), the turn's words
 * are read from the app's copy of Claude's transcript and reach the
 * person's collector in the same shape as a Pi turn's.
 */
test("a turn on Claude's own client carries its prompts and replies too", async () => {
  test.setTimeout(4 * 60_000);
  const mockProvider = await startMockProvider();
  const collector = await startCollector();
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchClaudeSeat({ mockProvider });
    const { page } = launched;
    await expect
      .poll(
        () =>
          page.evaluate(
            (endpoint) =>
              window.infinitary.settings
                .saveUsageConnection({ endpoint, format: "standard", headers: [], words: true })
                .then((answer) => answer.saved)
                .catch(() => false),
            collector.url,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await say(page, `why does the meter idle? ${ANSWER_PROMPT_MARKER}`);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 45_000 });
    await waitForFirstmateIdle(page);
    await launched.close();
    launched = undefined;

    const [spoken] = spansNamed(collector.arrived, "invoke_agent firstmate").filter(
      (span) => span["gen_ai.input.messages"],
    );
    expect(
      partsOf(spoken?.["gen_ai.input.messages"]).some(
        (part) => part.type === "text" && part.content.includes("why does the meter idle?"),
      ),
    ).toBe(true);
    const call = partsOf(spoken?.["gen_ai.output.messages"]).find(
      (part) => part.type === "tool_call" && part.name === "emit_card",
    );
    expect(call?.arguments).toMatchObject({ title: MOCK_ANSWER_TITLE });
  } finally {
    try {
      await launched?.close();
    } finally {
      await mockProvider.close();
      await collector.close();
    }
  }
});
