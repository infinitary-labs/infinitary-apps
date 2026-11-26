import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WELCOME_TITLE } from "@shared/welcome";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import {
  CUSTOM_EXCEPTION_WORDS,
  placeCustomApiFailure,
} from "../../src/renderer/src/accounts/customApiFailures";
import * as m from "../../src/shared/i18n/messages.generated";
import { customApiCaFixture } from "../helpers/customApiCaFixture";
import { customChatCall, customChatText, sendCustomStream } from "../helpers/customApiDialect";
import { scratchDir } from "../helpers/scratchDirs";
import {
  customApiBlock,
  customApiEditDialog,
  customApiFile,
  customApiForm,
  fillCustomApi,
  saveCustomApi,
} from "./customApi";
import { startCustomApiFixture } from "./customApiFixture";
import { chooseWhereFirstMateLives, committedWelcome } from "./firstLaunch";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  MOCK_COMPLETION_TEXT,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "./mockProvider";
import {
  closeModelPanel,
  levelLane,
  openModelPanel,
  openModelsBoard,
  setLevelInPanel,
} from "./modelsBoard";
import { PASTE_PICTURE_PNG_BASE64, pastePictures, promptInput } from "./prompt";
import { pressRow, recordFrame, showRecordTab } from "./rails";
import { showCard } from "./stack";
import { pressKey, typeInto } from "./windowKeys";

/** Places a custom model at one crew level on the Models board, the one place crew use is set. */
async function placeOnBoard(page: Page, model: string, level: "medium") {
  const models = await openModelsBoard(page);
  const panel = await openModelPanel(page, levelLane(models, "off"), model);
  await setLevelInPanel(panel, model, level, true);
  await closeModelPanel(models);
  await expect(
    levelLane(models, level).getByRole("button", { name: model, exact: true }),
  ).toBeVisible();
}

let launched: LaunchedApp | undefined;
let api: Awaited<ReturnType<typeof startCustomApiFixture>> | undefined;
let model: Awaited<ReturnType<typeof startMockProvider>> | undefined;
test.afterEach(async () => {
  if (api)
    writeFileSync(
      test.info().outputPath("diagnostic-wire.json"),
      JSON.stringify(api.requests, null, 2),
    );
  if (launched)
    writeFileSync(
      test.info().outputPath("diagnostic-state.json"),
      JSON.stringify(
        await launched.page.evaluate(async () => ({
          board: await window.infinitary.tasks.board(),
          slots: await window.infinitary.models.slots(),
          accounts: await window.infinitary.accounts.list(),
          custom: await window.infinitary.accounts.custom.list(),
          events: await window.infinitary.feed.recent(),
        })),
        null,
        2,
      ),
    );
  await launched?.close();
  await api?.close();
  await model?.close();
  launched = undefined;
  api = undefined;
  model = undefined;
});

test("first setup reads a named loopback site's models, takes its /v1 address in one press and saves it paused when its check fails", async () => {
  const hostname = "claude.local.dev.bla.net";
  const wire: string[] = [];
  const server = createServer((req, res) => {
    wire.push(`${req.method} ${req.url} Host: ${req.headers.host}`);
    const correctSite = req.headers.host === `${hostname}:${port}` && req.url === "/v1/models";
    res.writeHead(correctSite ? 200 : 404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "local-model", context_length: 32000, max_output_tokens: 2048 }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const port = address.port;
  try {
    launched = await launchApp({ modelsJson: () => JSON.stringify({ providers: {} }) });
    // Only the unavailable reporter's DNS answer is stood in. Real policy,
    // checked-IP lookup, socket and Host-based server routing remain intact.
    await launched.app.evaluate(async ({ app }, name) => {
      const { createRequire, syncBuiltinESMExports } = process.getBuiltinModule("node:module");
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const dns = require("node:dns/promises") as typeof import("node:dns/promises");
      const original = dns.lookup;
      dns.lookup = ((host: string, options: import("node:dns").LookupAllOptions) =>
        host === name
          ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
          : original(host, options)) as typeof dns.lookup;
      syncBuiltinESMExports();
    }, hostname);
    const page = launched.page;
    await chooseWhereFirstMateLives(page, "here");
    await page.locator("[data-first-run-gate] [data-connect-custom-api]").click();
    const f = customApiForm(page);
    // No network question: the name's answer is read as this Mac.
    await fillCustomApi(page, {
      name: "Local Claude proxy",
      address: `http://${hostname}:${port}`,
      network: "local",
    });
    await f.fetch.click();
    await expect(f.error("address")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("local-name-path.png") });
    // The one-press /v1 keeps the HTTP approval: it is the same server.
    await f.fix.click();
    await expect(f.address).toHaveValue(`http://${hostname}:${port}/v1`);
    await expect(f.http).toBeChecked();
    await f.fetch.click();
    await f.listed("local-model").click();
    await expect(f.row("local-model").getByLabel(/^Context tokens/)).toHaveValue("32000");
    await page.screenshot({ path: test.info().outputPath("local-name-models.png") });
    // This server answers no generation, so Save's check fails on the model's row.
    expect(await saveCustomApi(page)).toBe("failed");
    await expect(f.rowError("local-model")).toBeVisible();
    await f.savePaused.click();
    await expect(f.form).toHaveCount(0);
    expect(wire.map((line) => line.split(" Host: ")[1])).toEqual(
      wire.map(() => `${hostname}:${port}`),
    );
    expect(wire.map((line) => line.split(" Host: ")[0])).toEqual([
      "GET /models",
      "GET /v1/models",
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
    const connections = await page.evaluate(() => window.infinitary.accounts.custom.list());
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      baseUrl: `http://${hostname}:${port}/v1`,
      mode: "local",
      enabled: false,
    });
  } finally {
    writeFileSync(test.info().outputPath("local-name-wire.json"), JSON.stringify(wire, null, 2));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// A provider that refuses one model's check with HTTP 400 and its own reason,
// as a provider asking for an account setting does (INF-6842's reproduction).
test("a provider's 400 refusal of a model's check is told beside Save with its reason, and the summary marks no field", async () => {
  const passes = "model-passes";
  const refused = "model-needs-global";
  const reason = `Model ${refused} is hosted outside Europe and the United States. Turn on the Global region setting in your console to use it.`;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [passes, refused].map((id) => ({
              id,
              context_length: 200000,
              max_completion_tokens: 32768,
            })),
          }),
        );
        return;
      }
      const body = JSON.parse(raw) as { model?: string };
      if (body.model === refused) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: reason },
          }),
        );
        return;
      }
      if (raw.includes("data:image/png;base64,")) sendCustomStream(res, customChatText("unknown"));
      else if (raw.includes('"role":"tool"'))
        sendCustomStream(res, customChatText("FIRSTMATE_CUSTOM_API_OK"));
      else
        sendCustomStream(
          res,
          customChatCall("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}'),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    launched = await launchApp({ modelsJson: () => JSON.stringify({ providers: {} }) });
    const page = launched.page;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    await page.locator('[data-connect-chips="foot"] [data-connect-custom-api]').click();
    const f = customApiForm(page);
    await fillCustomApi(page, {
      name: "Refusing provider",
      address: `http://127.0.0.1:${address.port}/v1`,
      network: "local",
      key: "sk-synthetic-refusal-key-0000000000",
      protocol: "openai-completions",
      pick: [passes, refused],
    });
    expect(await saveCustomApi(page)).toBe("failed");
    await expect(f.error("save")).toContainText(reason);
    await expect(f.error("save")).not.toContainText(m.accountsCustomApiServer());
    await expect(f.form.locator("[data-custom-error]")).toHaveCount(1);
    await expect(f.summary).not.toContainText(m.accountsCustomApiNotSavedField());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const protocol of ["openai-completions", "openai-responses"] as const) {
  test(`${protocol}: paused first setup, restart, checked explicit roles, Firstmate card and crew reach only the chosen connection`, async () => {
    model = await startMockProvider();
    api = await startCustomApiFixture(model.port, undefined, undefined, undefined, true);
    launched = await launchApp({
      reuseMockProvider: model,
      modelsJson: () => JSON.stringify({ providers: {} }),
    });
    let page = launched.page;
    const label = `Synthetic ${protocol}`;
    await expect(promptInput(page)).toBeDisabled();
    await chooseWhereFirstMateLives(page, "here");
    await page.locator("[data-first-run-gate] [data-connect-custom-api]").click();
    let f = customApiForm(page);
    await fillCustomApi(page, {
      name: label,
      address: api.baseUrl,
      network: "local",
      protocol,
      models: [{ id: "operator-model" }],
    });
    await page.screenshot({ path: test.info().outputPath(`custom-${protocol}-setup.png`) });
    // No sizes: Save asks the server's list, which has none, and sends no test.
    expect(await saveCustomApi(page)).toBe("failed");
    await expect(f.rowError("operator-model")).toBeVisible();
    expect(api.requests.map(({ path }) => path)).toEqual([
      `${new URL(api.baseUrl).pathname}/models`,
    ]);
    await f.savePaused.click();
    await expect(f.form).toHaveCount(0);
    const accountsBefore = await page.evaluate(() => window.infinitary.accounts.list());
    expect(accountsBefore).toHaveLength(1);
    const account = accountsBefore[0];
    if (!account) throw new Error("Missing paused account");
    expect(account.enabled).toBe(false);
    await expect(promptInput(page)).toBeDisabled();
    const sentBeforeRestart = api.requests.length;
    const { userDataDir, homeDir } = launched;
    await launched.close();
    launched = await launchApp({
      reuseMockProvider: model,
      modelsJson: () => JSON.stringify({ providers: {} }),
      userDataDir,
      homeDir,
    });
    page = launched.page;
    await expect(promptInput(page)).toBeDisabled();
    expect(api.requests).toHaveLength(sentBeforeRestart);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    await expect(
      page.locator('[data-connect-chips="foot"] [data-connect-custom-api]'),
    ).toBeVisible();
    const block = customApiBlock(page, account.id);
    // Edit opens the same dialog as Add, filled in; the sizes are typed on the model's line.
    await block.edit.click();
    await expect(customApiEditDialog(page, label)).toBeVisible();
    f = customApiForm(page);
    await f
      .row("operator-model")
      .getByLabel(/^Context tokens/)
      .fill("200000");
    await f
      .row("operator-model")
      .getByLabel(/^Output tokens/)
      .fill("4096");
    expect(await saveCustomApi(page)).toBe("saved");
    // A checked replacement keeps the connection paused until Resume.
    await block.resume.click();
    await expect(block.firstmate("operator-model")).toBeEnabled();
    await placeOnBoard(page, "operator-model", "medium");
    // INF-6581's plan, piece 1: a name and price edit saves without checking the model again.
    const sentBeforePrice = api.requests.length;
    await block.edit.click();
    f = customApiForm(page);
    const price = f.price("operator-model");
    await price.open.click();
    await price.name.fill("Operator");
    await price.free.check();
    expect(await saveCustomApi(page)).toBe("saved");
    // Save reads the model list again, and sends no check.
    expect(api.requests.slice(sentBeforePrice).map(({ path }) => path)).toEqual([
      `${new URL(api.baseUrl).pathname}/models`,
    ]);
    expect(
      (await page.evaluate(() => window.infinitary.accounts.custom.list()))[0]?.models[0],
    ).toMatchObject({
      checked: true,
      name: "Operator",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect((await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen).toBe(true);
    expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toBeNull();
    await block.firstmate("operator-model").check();
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen)
      .toBe(false);
    await expect(page.locator('[data-setting="firstmate-model"] select')).toHaveValue(
      `${account.providerId}/operator-model`,
    );
    await page.screenshot({ path: test.info().outputPath(`custom-${protocol}-selected.png`) });
    await page.keyboard.press("Escape");
    const input = promptInput(page);
    await expect(input).toBeEnabled();
    // A profile set up here is still new: its once-only welcome is on the
    // stage once the Firstmate can answer (docs/first-launch.md).
    await showCard(page, WELCOME_TITLE);
    await committedWelcome(page);
    await page.screenshot({
      path: test.info().outputPath(`custom-${protocol}-welcome.png`),
      animations: "disabled",
    });
    await pastePictures(input, [{ name: "capture.png" }]);
    await input.fill(`please ${ANSWER_PROMPT_MARKER}: show a synthetic custom API card`);
    await input.press("Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.cards.list())).some(
            (card) => card.title === MOCK_ANSWER_TITLE,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    expect(
      (await page.evaluate(() => window.infinitary.accounts.custom.list()))[0]?.models[0]
        ?.readsPictures,
    ).toBe(true);
    expect(
      api.requests.some(({ body }) => JSON.stringify(body).includes(PASTE_PICTURE_PNG_BASE64)),
    ).toBe(true);
    await showCard(page, MOCK_ANSWER_TITLE);
    await expect(
      cardBody(page, MOCK_ANSWER_TITLE).getByText(MOCK_ANSWER_TEXT, { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`custom-${protocol}-firstmate.png`),
      animations: "disabled",
    });
    await input.fill(`${SPAWN_PROMPT_MARKER} custom API evidence task`);
    await input.press("Enter");
    await expect
      .poll(
        async () => {
          const board = await page.evaluate(() => window.infinitary.tasks.board());
          const task = board.tasks.find((entry) => entry.title === "custom API evidence task");
          if (!task) return null;
          return (await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).outcome;
        },
        { timeout: 30000 },
      )
      .toBe(MOCK_COMPLETION_TEXT);
    // The Firstmate must finish its own spawn tool-result loop too, not just
    // create a successful crew task and then fail replaying reused fixture IDs.
    await expect
      .poll(() =>
        api?.requests.some(({ body }) => {
          const messages = (body.input ?? body.messages ?? []) as Record<string, unknown>[];
          const id =
            protocol === "openai-responses"
              ? messages.find(
                  (item) => item.type === "function_call" && item.name === "spawn_crewmate",
                )?.call_id
              : messages
                  .flatMap(
                    (item) =>
                      (item.tool_calls ?? []) as { id: string; function: { name: string } }[],
                  )
                  .find((call) => call.function.name === "spawn_crewmate")?.id;
          return Boolean(
            id &&
              messages.some(
                (item) =>
                  (item.call_id === id && item.type === "function_call_output") ||
                  (item.tool_call_id === id && item.role === "tool"),
              ),
          );
        }),
      )
      .toBe(true);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((entry) => entry.title === "custom API evidence task");
    expect(task?.model).toBe(`${account.providerId}/operator-model`);
    if (!task) throw new Error("The custom crew task is missing");
    await pressRow(page, task.key);
    await showRecordTab(page, "activity");
    await recordFrame(page)
      .locator('[data-record-event="report"] > summary')
      .evaluate((summary) => (summary as HTMLElement).click());
    await expect(recordFrame(page).getByText(MOCK_COMPLETION_TEXT, { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`custom-${protocol}-crew.png`),
      animations: "disabled",
    });
    const work = api.requests.filter(
      (request) =>
        !JSON.stringify(request.body).includes("synthetic API connection check") &&
        request.body.stream,
    );
    expect(work.some((request) => JSON.stringify(request.body).includes(FIRSTMATE_PERSONA))).toBe(
      true,
    );
    expect(
      work.some((request) => JSON.stringify(request.body).includes("You are a crewmate")),
    ).toBe(true);
    expect(
      work.some(
        (request) =>
          JSON.stringify(request.body).includes('"role":"tool"') ||
          JSON.stringify(request.body).includes('"type":"function_call_output"'),
      ),
    ).toBe(true);
    for (const request of api.requests) {
      expect(request.authorization).toBe(false);
      if (!request.body.stream) continue;
      expect(request.path).toBe(
        `${new URL(api.baseUrl).pathname}/${protocol === "openai-responses" ? "responses" : "chat/completions"}`,
      );
      expect(request.body.model).toBe("operator-model");
      for (const field of [
        "previous_response_id",
        "conversation",
        "prompt_cache_key",
        "prompt_cache_retention",
        "reasoning",
        "temperature",
        "service_tier",
        "session_id",
      ])
        expect(request.body).not.toHaveProperty(field);
      if (protocol === "openai-responses") expect(request.body.store).toBe(false);
    }
    const saved = await page.evaluate(() => window.infinitary.accounts.custom.list());
    writeFileSync(
      test.info().outputPath(`${protocol}-wire.json`),
      JSON.stringify(api.requests, null, 2),
    );
    writeFileSync(
      test.info().outputPath(`${protocol}-state.json`),
      JSON.stringify(
        {
          accounts: await page.evaluate(() => window.infinitary.accounts.list()),
          custom: saved,
          task,
          firstRun: await page.evaluate(() => window.infinitary.app.firstRun()),
        },
        null,
        2,
      ),
    );
    expect(readdirSync(join(userDataDir, "accounts", account.providerId, account.id))).toEqual([
      "custom-auth.json",
    ]);
    expect(readFileSync(join(userDataDir, "auth", "models.json"), "utf8")).toBe(
      JSON.stringify({ providers: {} }),
    );
  });
}

test("the server's model list supplies model names and limits nobody typed", async () => {
  model = await startMockProvider();
  api = await startCustomApiFixture(model.port, undefined, {
    object: "list",
    data: [
      { id: "operator-model", context_length: 200000, max_completion_tokens: 4096 },
      { id: "typed-model", context_window: 131072, max_output_tokens: 8192 },
      { id: "unlisted-limits", owned_by: "operator" },
    ],
  });
  launched = await launchApp({
    reuseMockProvider: model,
    modelsJson: () => JSON.stringify({ providers: {} }),
  });
  const page = launched.page;
  await chooseWhereFirstMateLives(page, "here");
  await page.locator("[data-first-run-gate] [data-connect-custom-api]").click();
  const f = customApiForm(page);
  await fillCustomApi(page, { name: "Synthetic listing", address: api.baseUrl, network: "local" });
  expect(api.requests).toHaveLength(0);
  await f.fetch.click();
  for (const id of ["operator-model", "typed-model", "unlisted-limits"])
    await expect(f.listed(id)).toBeVisible();
  expect(api.requests.map(({ path }) => path)).toEqual([`${new URL(api.baseUrl).pathname}/models`]);
  await page.screenshot({ path: test.info().outputPath("custom-listed-models.png") });
  await f.listed("operator-model").click();
  await expect(f.listed("operator-model")).toBeDisabled();
  await expect(f.row("operator-model").getByLabel(/^Context tokens/)).toHaveValue("200000");
  await expect(f.row("operator-model").getByLabel(/^Output tokens/)).toHaveValue("4096");
  // A model added by keys, its sizes left for the server's list to fill on Save.
  await pressKey(f.addByHand, "Enter");
  const typed = f.form.locator("[data-custom-model-row]").last().getByLabel("Model ID");
  await typeInto(typed, "typed-model");
  await expect(f.row("typed-model").getByLabel(/^Context tokens/)).toHaveValue("");
  expect(await saveCustomApi(page)).toBe("saved");
  await page.screenshot({ path: test.info().outputPath("custom-listed-checked.png") });
  // First setup then asks which model Firstmate answers with.
  await expect(f.choose).toBeVisible();
  await f.choose.getByRole("button", { name: "Choose later" }).click();
  await expect(f.form).toHaveCount(0);
  const saved = await page.evaluate(() => window.infinitary.accounts.custom.list());
  expect(saved.map((view) => view.models)).toEqual([
    [
      expect.objectContaining({ id: "operator-model", context: 200000, output: 4096 }),
      expect.objectContaining({ id: "typed-model", context: 131072, output: 8192 }),
    ],
  ]);
  writeFileSync(
    test.info().outputPath("listed-models.json"),
    JSON.stringify({ wire: api.requests, custom: saved }, null, 2),
  );
});

// A connection file in Pi's models.json format: the app reads it and never
// writes it, each computer approves a connection with its own key, a name
// from the file applies at once, and a new address pauses it until approved.
test("a connection from the connection file is approved with this computer's own key and follows the file", async () => {
  model = await startMockProvider();
  api = await startCustomApiFixture(model.port);
  const path = join(scratchDir("custom-connection-file-"), "models.json");
  const provider = (name: string, baseUrl: string) => ({
    providers: {
      "team-gateway": {
        name,
        baseUrl,
        api: "openai-completions",
        apiKey: "$TEAM_GATEWAY_KEY",
        headers: { "X-Org-Id": "synthetic-org" },
        models: [
          {
            id: "operator-model",
            name: "Operator",
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 3, output: 15 },
          },
        ],
      },
    },
  });
  const written = JSON.stringify(provider("Team gateway", api.baseUrl), null, 2);
  writeFileSync(path, written);
  launched = await launchApp({
    reuseMockProvider: model,
    modelsJson: () => JSON.stringify({ providers: {} }),
  });
  const page = launched.page;
  // The picker is the system's own sheet, answered in the main process.
  await launched.app.evaluate(({ dialog }, answer) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [answer],
    })) as unknown as typeof dialog.showOpenDialog;
  }, path);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const file = customApiFile(page);
  await file.choose.click();
  await expect(file.path).toHaveText(path);
  await expect(file.status).toHaveText(m.accountsCustomApiFileRead({ count: 1 }));
  const pending = file.pending("team-gateway");
  await expect(pending.block).toContainText(m.accountsCustomApiFileNew());
  // The file's key reference is never used: each computer types its own.
  await expect(pending.warnings).toContainText(m.accountsCustomApiFileKey());
  await page.screenshot({ path: test.info().outputPath("custom-file-pending.png") });
  expect(api.requests).toHaveLength(0);

  await pending.approve.click();
  const f = customApiForm(page);
  await expect(page.getByRole("dialog", { name: "Approve Team gateway" })).toBeVisible();
  await expect(f.name).toHaveValue("Team gateway");
  await expect(f.name).toHaveAttribute("readonly", "");
  await expect(f.address).toHaveValue(api.baseUrl);
  await expect(f.address).toHaveAttribute("readonly", "");
  await expect(f.protocol).toBeDisabled();
  await expect(f.row("operator-model").getByLabel(/^Context tokens/)).toHaveValue("200000");
  await f.http.check();
  await f.key.fill("synthetic-file-key");
  await page.screenshot({ path: test.info().outputPath("custom-file-approve.png") });
  expect(await saveCustomApi(page)).toBe("saved");
  // Checked with this computer's key and the file's visible header.
  expect(api.requests.length).toBeGreaterThan(0);
  expect(api.requests.every((request) => request.scheme === "Bearer")).toBe(true);
  expect(api.requests.every((request) => request.org === "synthetic-org")).toBe(true);
  const [saved] = await page.evaluate(() => window.infinitary.accounts.custom.list());
  expect(saved).toMatchObject({
    label: "Team gateway",
    file: { name: "team-gateway", state: "current" },
    models: [
      { id: "operator-model", name: "Operator", cost: { input: 3, output: 15 }, checked: true },
    ],
  });
  const block = customApiBlock(page, saved?.accountId ?? "");
  await expect(block.block).toContainText(m.accountsCustomApiFileTag());
  await expect(block.block).toContainText("Ready");
  await expect(file.pending("team-gateway").block).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("custom-file-approved.png") });

  // A new name in the file applies at once, with no request to the server.
  const checks = api.requests.length;
  writeFileSync(path, JSON.stringify(provider("Renamed gateway", api.baseUrl), null, 2));
  await expect(block.block.locator("h3")).toHaveText("Renamed gateway");
  expect(api.requests).toHaveLength(checks);

  // A new address pauses it until this computer approves it again.
  writeFileSync(
    path,
    JSON.stringify(provider("Renamed gateway", "http://127.0.0.1:9/v1"), null, 2),
  );
  await expect(block.block.locator("[data-custom-file-held]")).toContainText(
    m.accountsCustomApiFileChanged(),
  );
  await expect(block.block.getByRole("button", { name: "Approve again" })).toBeVisible();
  await expect(block.firstmate("operator-model")).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: test.info().outputPath("custom-file-held.png") });
  expect(api.requests).toHaveLength(checks);
  // The app read the file and never wrote it.
  expect(readFileSync(path, "utf8")).toBe(
    JSON.stringify(provider("Renamed gateway", "http://127.0.0.1:9/v1"), null, 2),
  );
});

// The captain's choice on the review of this file's approval: a size the file
// leaves out, with no server list to fill it, is typed on this computer.
test("a size the connection file leaves out is typed on this computer when it approves", async () => {
  model = await startMockProvider();
  api = await startCustomApiFixture(model.port);
  const path = join(scratchDir("custom-connection-file-"), "models.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "local-server": {
          baseUrl: api.baseUrl,
          api: "openai-completions",
          models: [{ id: "operator-model", maxTokens: 4096 }],
        },
        // Refused as a built-in provider's name: listed, but not counted as read.
        openai: { baseUrl: api.baseUrl, api: "openai-completions" },
      },
    }),
  );
  launched = await launchApp({
    reuseMockProvider: model,
    modelsJson: () => JSON.stringify({ providers: {} }),
  });
  const page = launched.page;
  await launched.app.evaluate(({ dialog }, answer) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [answer],
    })) as unknown as typeof dialog.showOpenDialog;
  }, path);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  const file = customApiFile(page);
  await file.choose.click();
  await expect(file.status).toHaveText(m.accountsCustomApiFileRead({ count: 1 }));
  await expect(file.pending("openai").block).toContainText(
    m.accountsCustomApiFileBuiltIn({ name: "openai" }),
  );
  await file.pending("local-server").approve.click();
  const f = customApiForm(page);
  const row = f.row("operator-model");
  const context = row.getByLabel(m.accountsCustomApiContextFor({ name: "operator-model" }));
  const output = row.getByLabel(m.accountsCustomApiOutputFor({ name: "operator-model" }));
  await expect(row.getByLabel(m.accountsCustomApiModelId())).toBeDisabled();
  await expect(output).toBeDisabled();
  await expect(output).toHaveValue("4096");
  await expect(context).toBeEnabled();
  await expect(context).toHaveValue("");
  await context.fill("65536");
  await f.http.check();
  await f.key.fill("synthetic-file-key");
  await page.screenshot({ path: test.info().outputPath("custom-file-typed-size.png") });
  expect(await saveCustomApi(page)).toBe("saved");
  const [saved] = await page.evaluate(() => window.infinitary.accounts.custom.list());
  expect(saved).toMatchObject({
    file: { name: "local-server", state: "current" },
    models: [{ id: "operator-model", context: 65536, output: 4096, checked: true }],
  });
});

// INF-3100's report: a proxy app answering a public API's name with a reserved
// stand-in address (198.18.0.0/15) left the form refusing with no reason. The
// captain asked that the form say what DNS answered and let the person make
// an exception for that one address, shown on the connection afterwards.
test("a name DNS answers with a reserved address is refused naming the answers, and saved with the person's exception for it", async () => {
  model = await startMockProvider();
  api = await startCustomApiFixture(model.port);
  launched = await launchApp({
    reuseMockProvider: model,
    modelsJson: () => JSON.stringify({ providers: {} }),
  });
  const target = "fakeip.example.test";
  const stand = "198.18.0.42";
  const answers = [
    { address: stand, kind: "reserved" as const },
    { address: "2606:4700:10::6814:2011", kind: "public" as const },
  ];
  // DNS answers as a fake-IP proxy would. The real policy checks every answer;
  // the connector, once handed the checked stand-in, reaches the fixture.
  await launched.app.evaluate(
    async ({ app }, { target, answers, port }) => {
      const { createRequire, syncBuiltinESMExports } = process.getBuiltinModule("node:module");
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const dns = require("node:dns/promises") as typeof import("node:dns/promises");
      const https = require("node:https") as typeof import("node:https");
      const http = require("node:http") as typeof import("node:http");
      const nativeLookup = dns.lookup;
      const nativeRequest = https.request;
      dns.lookup = ((hostname: string, options: import("node:dns").LookupAllOptions) =>
        hostname === target
          ? Promise.resolve(
              answers.map(({ address }) => ({ address, family: address.includes(":") ? 6 : 4 })),
            )
          : nativeLookup(hostname, options)) as unknown as typeof dns.lookup;
      https.request = ((
        url: URL,
        options: import("node:https").RequestOptions,
        callback: (res: import("node:http").IncomingMessage) => void,
      ) => {
        if (url.hostname !== target) return nativeRequest(url, options, callback);
        if (!options.lookup || options.rejectUnauthorized !== true || options.agent !== false)
          throw new Error("Unsafe HTTPS options");
        options.lookup(target, { all: true }, (_error, addresses) => {
          const checked = (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map(
            (entry) => entry.address,
          );
          if (checked[0] !== answers[0]?.address) throw new Error("Unchecked answer");
        });
        return http.request(
          new URL(`http://127.0.0.1:${port}${url.pathname}`),
          {
            ...options,
            // Both answers were checked, so Node's multi-address connect asks for all.
            lookup: ((_host, opts, done) =>
              opts.all
                ? done(null, [{ address: "127.0.0.1", family: 4 }])
                : done(null, "127.0.0.1", 4)) as import("node:net").LookupFunction,
          },
          callback,
        );
      }) as typeof https.request;
      syncBuiltinESMExports();
    },
    { target, answers, port: Number(new URL(api.baseUrl).port) },
  );
  const page = launched.page;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence" }).click();
  await page.locator('[data-connect-chips="foot"] [data-connect-custom-api]').click();
  const f = customApiForm(page);
  const address = `https://${target}${new URL(api.baseUrl).pathname}`;
  await fillCustomApi(page, {
    name: "Behind a proxy app",
    address,
    key: "synthetic-desktop-literal-key",
    models: [{ id: "operator-model", context: 200000, output: 4096 }],
  });
  const refused = placeCustomApiFailure("destination", {
    address,
    stage: "address",
    answers,
    exceptionOffered: true,
  }).text;
  await expect(f.answers).toHaveText(refused);
  await expect(f.exception).not.toBeChecked();
  expect(await saveCustomApi(page)).toBe("failed");
  await expect(f.error("address")).toHaveText(refused);
  expect(api.requests).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("custom-reserved-refused.png") });
  await pressKey(f.exception, "Space");
  await expect(f.exception).toBeChecked();
  await expect(f.sendsTo).toContainText(CUSTOM_EXCEPTION_WORDS.line);
  expect(await saveCustomApi(page)).toBe("saved");
  expect(api.requests[0]?.path).toBe(`${new URL(api.baseUrl).pathname}/models`);
  const saved = await page.evaluate(() => window.infinitary.accounts.custom.list());
  expect(saved).toMatchObject([{ baseUrl: address, mode: "public", addressException: true }]);
  const accounts = await page.evaluate(() => window.infinitary.accounts.list());
  const account = accounts[0];
  if (!account) throw new Error("Missing account");
  const block = customApiBlock(page, account.id);
  await expect(block.exception).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("custom-reserved-excepted.png") });
  await block.edit.click();
  const edit = customApiEditDialog(page, "Behind a proxy app");
  await expect(edit.getByLabel(/^Make an exception for /)).toBeChecked();
});

for (const mode of [
  "public",
  "public-headers",
  "private",
  "local-https",
  "public-http",
  "private-http",
  "private-http-no-key",
] as const) {
  const plainHttp = mode.includes("http") && mode !== "local-https";
  const networkMode = mode.startsWith("private")
    ? "private"
    : mode.startsWith("public")
      ? "public"
      : "local";
  const keyless = mode === "local-https" || mode === "private-http-no-key";
  // An organization gateway that takes its own headers instead of a key.
  const headerCredential = "Basic synthetic-gateway-credential";
  const headers = mode === "public-headers";
  test(`${mode}: Intelligence creation and explicit Firstmate/crew use under the guarded transport`, async () => {
    model = await startMockProvider();
    const ca =
      mode === "private" ? customApiCaFixture(scratchDir("custom-desktop-ca-")) : undefined;
    api = await startCustomApiFixture(
      model.port,
      ca ? { key: ca.leafKey, cert: ca.leaf } : undefined,
      plainHttp
        ? { data: [{ id: "operator-model", context_length: 200000, max_completion_tokens: 4096 }] }
        : undefined,
    );
    const baseUrl =
      mode === "private"
        ? api.baseUrl
        : api.baseUrl.replace(
            "http://127.0.0.1",
            networkMode === "local"
              ? "https://localhost"
              : `${plainHttp ? "http" : "https"}://gateway.example.test`,
          );
    launched = await launchApp({
      reuseMockProvider: model,
      modelsJson: () => JSON.stringify({ providers: {} }),
    });
    // The actual policy still validates/pins its class. Private mode retains
    // real packaged-Node TLS; public/loopback HTTPS emulate a normally trusted
    // peer at the connector only, asserting all original TLS safety options.
    await launched.app.evaluate(
      async ({ app }, { mode, port, plainHttp, networkMode }) => {
        const { createRequire, syncBuiltinESMExports } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const dns = require("node:dns/promises") as typeof import("node:dns/promises");
        const https = require("node:https") as typeof import("node:https");
        const http = require("node:http") as typeof import("node:http");
        const tls = require("node:tls") as typeof import("node:tls");
        const nativeLookup = dns.lookup;
        const nativeRequest = https.request;
        const nativeHttpRequest = http.request;
        const target = networkMode === "local" ? "localhost" : "gateway.example.test";
        const pin =
          networkMode === "public"
            ? "93.184.216.34"
            : networkMode === "private"
              ? "10.23.4.5"
              : "127.0.0.1";
        dns.lookup = ((hostname: string, options: import("node:dns").LookupAllOptions) =>
          hostname === target
            ? Promise.resolve([{ address: pin, family: 4 }])
            : nativeLookup(hostname, options)) as unknown as typeof dns.lookup;
        https.request = ((
          url: URL,
          options: import("node:https").RequestOptions,
          callback: (res: import("node:http").IncomingMessage) => void,
        ) => {
          if (url.hostname !== target) return nativeRequest(url, options, callback);
          if (
            !options.lookup ||
            options.rejectUnauthorized !== true ||
            options.agent !== false ||
            !Array.isArray(options.ca)
          )
            throw new Error("Unsafe HTTPS options");
          options.lookup(target, {}, (_error, address) => {
            if (address !== pin) throw new Error("Unvalidated pin");
          });
          const lookup: import("node:net").LookupFunction = (_host, _opts, done) =>
            done(null, "127.0.0.1", 4);
          if (mode === "private") return nativeRequest(url, { ...options, lookup }, callback);
          if (options.ca.length !== tls.rootCertificates.length)
            throw new Error("Unexpected connection trust");
          return http.request(
            new URL(`http://127.0.0.1:${port}${url.pathname}`),
            { ...options, lookup },
            callback,
          );
        }) as typeof https.request;
        if (plainHttp) {
          http.request = ((
            url: URL,
            options: import("node:http").RequestOptions,
            callback: (res: import("node:http").IncomingMessage) => void,
          ) => {
            if (url.hostname !== target) return nativeHttpRequest(url, options, callback);
            if (!options.lookup || options.agent !== false) throw new Error("Unsafe HTTP options");
            options.lookup(target, {}, (_error, address) => {
              if (address !== pin) throw new Error("Unvalidated HTTP pin");
            });
            return nativeHttpRequest(
              new URL(`http://127.0.0.1:${port}${url.pathname}`),
              { ...options, lookup: (_host, _opts, done) => done(null, "127.0.0.1", 4) },
              callback,
            );
          }) as typeof http.request;
        }
        syncBuiltinESMExports();
      },
      { mode, port: Number(new URL(api.baseUrl).port), plainHttp, networkMode },
    );
    const page = launched.page;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    await page.locator('[data-connect-chips="foot"] [data-connect-custom-api]').click();
    const f = customApiForm(page);
    const protocol = networkMode === "public" ? "openai-completions" : "openai-responses";
    const name = `Synthetic ${mode}`;
    const models = [{ id: "operator-model", context: 200000, output: 4096 }];
    if (plainHttp) {
      // A metadata address is refused at the address, before anything is sent.
      const metadataAddress = "http://169.254.169.254/v1";
      await fillCustomApi(page, { name, address: metadataAddress, models });
      expect(await saveCustomApi(page)).toBe("failed");
      // Its words are the refused destination's, whole: nothing of the
      // request that carried the refusal reads through.
      await expect(f.error("address")).toHaveText(
        placeCustomApiFailure("destination", { address: metadataAddress, stage: "address" }).text,
      );
      expect(api.requests).toHaveLength(0);
      await f.row("operator-model").getByRole("button", { name: "Remove operator-model" }).click();
    }
    // No network question: the line under the address reads it from the name's answer.
    await fillCustomApi(page, {
      name,
      address: baseUrl,
      network: networkMode,
      protocol,
      ...(keyless || headers ? {} : { key: "synthetic-desktop-literal-key" }),
      models,
    });
    if (plainHttp && networkMode === "public")
      await expect(f.http).toHaveAccessibleName(/public internet/);
    if (headers) {
      // Entered by keys: Enter opens the section and adds a row, which lands on
      // its name, and Tab goes on to its value. The button and the switch are
      // focused directly, because whether Tab reaches them follows the Mac's
      // own keyboard navigation setting.
      await pressKey(f.form.getByText("Extra request headers", { exact: true }), "Enter");
      const add = f.form.getByRole("button", { name: "Add header" });
      await pressKey(add, "Enter");
      const org = f.form.locator('[data-custom-header="0"]');
      await typeInto(org.getByLabel("Header name"), "X-Org-Id");
      await page.keyboard.press("Tab");
      await typeInto(org.getByLabel("Header value"), "synthetic-org");
      await pressKey(org.getByLabel("Secret"), "Space");
      await expect(org.getByLabel("Secret")).not.toBeChecked();
      await pressKey(add, "Enter");
      const credential = f.form.locator('[data-custom-header="1"]');
      await typeInto(credential.getByLabel("Header name"), "Authorization");
      await page.keyboard.press("Tab");
      await typeInto(credential.getByLabel("Header value"), headerCredential);
      await expect(credential.getByLabel("Secret")).toBeChecked();
      await expect(org.getByLabel("Header value")).toHaveValue("synthetic-org");
      await expect(f.form).toContainText("X-Org-Id, Authorization");
    }
    await page.screenshot({ path: test.info().outputPath(`custom-${mode}-form.png`) });
    expect(api.requests).toHaveLength(0);
    if (ca) {
      // The organization's own certificate is asked for once Save finds the server untrusted.
      expect(await saveCustomApi(page)).toBe("failed");
      await expect(f.error("address")).toBeVisible();
      await f.form.getByLabel("Choose a local PEM CA file").setInputFiles({
        name: "synthetic-ca.pem",
        mimeType: "application/x-pem-file",
        buffer: Buffer.from(ca.ca),
      });
      await f.form.getByLabel(/I approve these certificates/).check();
    }
    expect(await saveCustomApi(page)).toBe("saved");
    const accounts = await page.evaluate(() => window.infinitary.accounts.list());
    const account = accounts[0];
    if (!account) throw new Error("Missing account");
    const block = customApiBlock(page, account.id);
    if (plainHttp) await expect(block.unencrypted).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`custom-${mode}-selected.png`) });
    await placeOnBoard(page, "operator-model", "medium");
    expect((await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen).toBe(true);
    await block.firstmate("operator-model").check();
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen)
      .toBe(false);
    await page.keyboard.press("Escape");
    const prompt = promptInput(page);
    // A profile set up here is still new: its once-only welcome is on the
    // stage once the Firstmate can answer (docs/first-launch.md).
    await showCard(page, WELCOME_TITLE);
    await committedWelcome(page);
    await page.screenshot({
      path: test.info().outputPath(`custom-${mode}-welcome.png`),
      animations: "disabled",
    });
    await prompt.fill(`please ${ANSWER_PROMPT_MARKER}: show a synthetic HTTPS card`);
    await prompt.press("Enter");
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (card) => card.title === MOCK_ANSWER_TITLE,
        ),
      )
      .toBe(true);
    await showCard(page, MOCK_ANSWER_TITLE);
    await prompt.fill(`${SPAWN_PROMPT_MARKER} HTTPS evidence task`);
    await prompt.press("Enter");
    await expect
      .poll(
        async () => {
          const board = await page.evaluate(() => window.infinitary.tasks.board());
          const task = board.tasks.find((entry) => entry.title === "HTTPS evidence task");
          return task
            ? (await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).outcome
            : null;
        },
        { timeout: 30000 },
      )
      .toBe(MOCK_COMPLETION_TEXT);
    await page.screenshot({ path: test.info().outputPath(`custom-${mode}-work.png`) });
    if (headers) {
      expect(api.requests.length).toBeGreaterThan(0);
      // The secret header never comes back to the window.
      expect(
        JSON.stringify(await page.evaluate(() => window.infinitary.accounts.custom.list())),
      ).not.toContain(headerCredential);
    }
    for (const request of api.requests) {
      expect(request.authorization).toBe(!keyless);
      expect(request.scheme).toBe(keyless ? undefined : headers ? "Basic" : "Bearer");
      expect(request.org).toBe(headers ? "synthetic-org" : undefined);
      if (request.path.endsWith("/models")) continue;
      expect(request.body.model).toBe("operator-model");
      expect(request.path).toBe(
        `${new URL(baseUrl).pathname}/${protocol === "openai-responses" ? "responses" : "chat/completions"}`,
      );
      if (protocol === "openai-responses") expect(request.body.store).toBe(false);
    }
    writeFileSync(
      test.info().outputPath(`${mode}-https.json`),
      JSON.stringify(
        {
          mode,
          tls: plainHttp
            ? "HTTP with validated class and pin; socket connector fixture"
            : mode === "private"
              ? "actual Node verification; socket connector fixture"
              : "normally trusted HTTPS peer connector fixture; original TLS options asserted",
          baseUrl,
          wire: api.requests,
          state: await page.evaluate(() => window.infinitary.accounts.custom.list()),
        },
        null,
        2,
      ),
    );
  });
}
