import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CUSTOM_TOKEN_FAILURE } from "@shared/customApi";
import { scratchDir } from "../helpers/scratchDirs";
import { customApiBlock, customApiForm, fillCustomApi, saveCustomApi } from "./customApi";
import { startCustomApiFixture } from "./customApiFixture";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
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
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { savedText } from "./savedText";
import { showCard } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

// Intent: the accepted enterprise access plan's Custom connection piece.
// Disposable gateway and real shell helper; keyboard setup, checked Save,
// one 401 renewal, first mate and crew replies, then safe command failure.
// Portable: no native credential store, subscription or external service.
test("a shell token command checks, serves both roles after refusal, and reports renewal failure without revealing a token", async () => {
  const dir = scratchDir("token-command-journey-");
  const calls = join(dir, "calls");
  const script = join(dir, "company-token.cjs");
  const fail = join(dir, "expired-sign-in");
  writeFileSync(
    script,
    `const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
let n=0; try{n=Number(fs.readFileSync(${JSON.stringify(calls)},'utf8'));}catch{}
fs.writeFileSync(${JSON.stringify(calls)},String(++n)); process.stdout.write('journey-private-token-'+n);`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)} | cat`;
  // pipefail is intentionally not assumed: the real command must report its own failure.
  const failingCommand = `${quote(process.execPath)} ${quote(script)}`;
  const model = await startMockProvider();
  const fixture = await startCustomApiFixture(model.port, undefined, {
    data: [{ id: "operator-model", context_length: 200000, max_output_tokens: 4096 }],
  });
  let refuseNext = false;
  let refusals = 0;
  const server = createServer(async (req, res) => {
    if (refuseNext) {
      refuseNext = false;
      refusals++;
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(`${fixture.baseUrl}${req.url?.slice(3) ?? ""}`, {
      method: req.method,
      ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      headers: { "Content-Type": "application/json" },
    });
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway port");
  const base = `http://127.0.0.1:${address.port}/v1`;
  const run = await launchApp({
    reuseMockProvider: model,
    modelsJson: () => JSON.stringify({ providers: {} }),
  });
  try {
    const page = run.page;
    await page.locator("[data-first-run-gate] [data-connect-custom-api]").click();
    await fillCustomApi(page, {
      name: "Company gateway",
      address: base,
      network: "local",
      models: [{ id: "operator-model" }],
    });
    const f = customApiForm(page);
    // Native type-ahead works without opening the macOS picker in the hidden test window.
    await pressKey(f.authentication, "t");
    await pressKey(f.authentication, "Tab");
    await expect(f.tokenCommand).toBeVisible();
    await focusOn(f.tokenCommand);
    await typeInto(f.tokenCommand, command, { insert: true });
    await pressKey(f.tokenCommand, "Tab");
    await expect(f.refreshSeconds).toBeFocused();
    await expect(f.commandApproval).toHaveText(command);
    expect(await saveCustomApi(page)).toBe("saved");
    await f.choose.getByRole("button", { name: "Use operator-model", exact: true }).click();
    const account = (await page.evaluate(() => window.infinitary.accounts.custom.list()))[0];
    if (!account?.accountId) throw new Error("Missing saved connection");
    expect(account.tokenCommand?.command).toBe(command);
    expect(JSON.stringify(account)).not.toContain("journey-private-token");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const models = await openModelsBoard(page);
    const panel = await openModelPanel(page, levelLane(models, "off"), "operator-model");
    await setLevelInPanel(panel, "operator-model", "medium", true);
    await closeModelPanel(models);
    await pressKey(page.getByRole("tab", { name: "Intelligence" }), "Escape");
    refuseNext = true;
    const input = promptInput(page);
    await input.fill(`${ANSWER_PROMPT_MARKER}: answer through the gateway`);
    await pressKey(input, "Enter");
    await showCard(page, MOCK_ANSWER_TITLE);
    await expect(
      cardBody(page, MOCK_ANSWER_TITLE).getByText(MOCK_ANSWER_TEXT, { exact: true }),
    ).toBeVisible();
    expect(refusals).toBe(1);
    expect(Number(readFileSync(calls, "utf8"))).toBeGreaterThan(1);
    await input.fill(`${SPAWN_PROMPT_MARKER} token command crew proof`);
    await pressKey(input, "Enter");
    await expect
      .poll(async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        const task = board.tasks.find((row) => row.title === "token command crew proof");
        return task
          ? (await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).outcome
          : null;
      })
      .toBe(MOCK_COMPLETION_TEXT);
    writeFileSync(fail, "expired");
    refuseNext = true;
    await input.fill(`${ANSWER_PROMPT_MARKER}: answer after the company sign-in expires`);
    await pressKey(input, "Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.accounts.custom.list()))[0]
            ?.tokenCommandFailed,
      )
      .toBe(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const block = customApiBlock(page, account.accountId);
    await expect(block.block.getByRole("alert")).toContainText(CUSTOM_TOKEN_FAILURE.row);
    await regionShot(
      block.block.getByRole("alert"),
      test.info().outputPath("token-command-row-failure.png"),
    );
    await block.edit.click();
    const edit = customApiForm(page);
    await expect(edit.tokenCommand).toHaveValue(command);
    await edit.tokenCommand.fill(failingCommand);
    writeFileSync(fail, "expired");
    expect(await saveCustomApi(page)).toBe("failed");
    await expect(edit.error("key")).toContainText(CUSTOM_TOKEN_FAILURE.message);
    await regionShot(edit.error("key"), test.info().outputPath("token-command-save-failure.png"));
    await expect(edit.form).not.toContainText("journey-private-token");
    const kept = [...savedText(run.userDataDir), ...savedText(run.diagnosticsDir)];
    for (const file of kept) expect(file.text, file.file).not.toContain("journey-private-token");
    writeFileSync(
      test.info().outputPath("token-command-proof.json"),
      JSON.stringify(
        {
          savedWithCommand: true,
          firstmateAnswered: true,
          crewReported: true,
          refusals,
          helperRuns: Number(readFileSync(calls, "utf8")),
          settingsReportedFailure: true,
          savedAndDiagnosticFilesChecked: kept.length,
          tokensInSavedFiles: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await run.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    await model.close();
  }
});
