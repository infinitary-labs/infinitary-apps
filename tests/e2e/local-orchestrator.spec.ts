import { expect, test } from "@playwright/test";
import { GATED_PLACEHOLDER, STANDARD_PLACEHOLDER } from "@shared/firstRun";
import { localSeatDescription } from "@shared/localOrchestrator";
import {
  LOCAL_ORCHESTRATOR_OFF_LINE,
  localOrchestratorLine,
} from "../../src/core/orchestrator/localOrchestrator";
import { firstRunHintOnThisComputer, hintOnThisComputer } from "./dictation";
import { type LaunchedApp, launchApp } from "./launch";
import {
  FM_SYSTEM_MARKER,
  MOCK_MODEL_ID,
  type MockProviderServer,
  mockProviderOverrideModelsJson,
  startMockProvider,
} from "./mockProvider";
import { feedLine } from "./rails";

/** The line the seat writes once it runs on the mock's model at `url`, the endpoint the spec gave. */
function seatLine(url: string): string {
  return localOrchestratorLine({ model: { id: MOCK_MODEL_ID }, host: new URL(url).host });
}

/**
 * Roadmap 1.7, the dev-only local-model orchestrator: an unpackaged
 * checkout that names an OpenAI-compatible endpoint and a model in its
 * environment runs the Firstmate - only the Firstmate - on it. The mock
 * provider stands in for Ollama here: the app's own models.json defines NO
 * custom provider and no account is signed in, so without the seat the
 * first-run gate would be up and nothing could answer. With it, the gate
 * never opens, the feed says where the seat is, and a captain turn reaches
 * the endpoint as a real Firstmate request for the named model.
 *
 * The Settings control (captain decision 2026-09-21: the dogfood also gets
 * a Settings option) makes the same choice from General -> "Local model
 * (dev checkout)": the second launch below starts with nothing asking for
 * a seat, so the first-run gate is up, and the switch alone closes it,
 * moves a captain turn onto the endpoint, and opens it again when turned
 * off. A packaged build refuses both the environment and the control; that
 * half is the core boot's contract test (core.test.ts), since e2e runs
 * unpackaged.
 */

let mock: MockProviderServer;
let launched: LaunchedApp;
let seatUrl: string;

test.beforeAll(async () => {
  mock = await startMockProvider();
  seatUrl = `http://127.0.0.1:${mock.port}/v1`;
  launched = await launchApp({
    reuseMockProvider: mock,
    modelsJson: mockProviderOverrideModelsJson,
    env: {
      INFINITARY_LOCAL_ORCHESTRATOR_URL: seatUrl,
      INFINITARY_LOCAL_ORCHESTRATOR_MODEL: MOCK_MODEL_ID,
    },
  });
});

test.afterAll(async () => {
  await launched.close();
  await mock.close();
});

test("the seat closes the gate and the feed says where it is", async () => {
  const { page } = launched;
  await expect(page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER))).toBeEnabled({
    timeout: 20_000,
  });
  await expect(page.locator("[data-first-run-gate]")).toHaveCount(0);
  await expect(feedLine(page, seatLine(seatUrl))).toBeVisible({ timeout: 20_000 });
});

test("a captain turn is served by the local endpoint as the named model", async () => {
  const { page } = launched;
  const input = page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER));
  await input.fill("hello from the local seat");
  await input.press("Enter");
  await expect
    .poll(
      () =>
        mock
          .requestBodies()
          .some(
            (body) =>
              body.includes(FM_SYSTEM_MARKER) &&
              body.includes("hello from the local seat") &&
              /"model":\s*"mock-1"/.test(body),
          ),
      { timeout: 30_000 },
    )
    .toBe(true);
  // The seat is the Firstmate's model, and the pin the person may have set
  // is left alone: nothing about the seat is persisted.
  expect(await page.evaluate(() => window.infinitary.settings.getFirstmateModel())).toBeNull();
});

test.describe
  .serial("the Settings control", () => {
    let control: MockProviderServer;
    let app: LaunchedApp;

    test.beforeAll(async () => {
      control = await startMockProvider();
      app = await launchApp({
        reuseMockProvider: control,
        modelsJson: mockProviderOverrideModelsJson,
      });
    });

    test.afterAll(async () => {
      await app.close();
      await control.close();
    });

    test("turning the seat on in Settings moves the captain's turn onto the endpoint, and turning it off puts the gate back", async () => {
      const { page } = app;
      await test.step("turning the seat on in Settings closes the gate and moves the captain's turn onto the endpoint", async () => {
        const gate = page.locator("[data-first-run-gate]");
        await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("tab", { name: "General", exact: true }).click();
        const section = page.locator("[data-local-seat]");
        await expect(section).toBeVisible();
        const controlUrl = `http://127.0.0.1:${control.port}/v1`;
        const url = page.locator('[data-setting="local-seat-url"] input');
        await url.fill(controlUrl);
        await url.press("Enter");
        const model = page.locator('[data-setting="local-seat-model"] input');
        await model.fill(MOCK_MODEL_ID);
        await model.press("Enter");
        await page.locator('[data-setting="local-seat"] [role="switch"]').click();
        await expect(page.locator('[data-setting="local-seat"] [role="switch"]')).toHaveAttribute(
          "aria-checked",
          "true",
        );
        const seated = localSeatDescription({
          available: true,
          setting: { enabled: true, baseUrl: controlUrl, model: MOCK_MODEL_ID },
          active: { model: MOCK_MODEL_ID, host: new URL(controlUrl).host, source: "setting" },
          problem: null,
        });
        await expect(section.getByText(seated)).toBeVisible();
        await page.getByRole("button", { name: "Back" }).click();
        await expect(gate).toHaveCount(0);
        await expect(feedLine(page, seatLine(controlUrl))).toBeVisible({ timeout: 20_000 });
        // The gate went open -> closed for the first time, so this is the
        // app's first launch as far as the input knows: the first-run hint,
        // not the standard one, until the captain's first turn.
        const input = page.getByPlaceholder(firstRunHintOnThisComputer());
        await expect(input).toBeEnabled({ timeout: 20_000 });
        await input.fill("hello from the settings seat");
        await input.press("Enter");
        await expect
          .poll(
            () =>
              control
                .requestBodies()
                .some(
                  (body) =>
                    body.includes(FM_SYSTEM_MARKER) &&
                    body.includes("hello from the settings seat") &&
                    /"model":\s*"mock-1"/.test(body),
                ),
            { timeout: 30_000 },
          )
          .toBe(true);
        expect(
          await page.evaluate(() => window.infinitary.settings.getFirstmateModel()),
        ).toBeNull();
      });

      await test.step("turning it off puts the gate back, since nothing else can answer", async () => {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("tab", { name: "General", exact: true }).click();
        await page.locator('[data-setting="local-seat"] [role="switch"]').click();
        await expect(page.locator('[data-setting="local-seat"] [role="switch"]')).toHaveAttribute(
          "aria-checked",
          "false",
        );
        await page.getByRole("button", { name: "Back" }).click();
        // The stage is showing the cards the seat's turns produced, so the
        // gate's caption stays under them; the input is where the gate is
        // felt: disabled, with the gated line.
        await expect(page.getByPlaceholder(GATED_PLACEHOLDER)).toBeDisabled({ timeout: 20_000 });
        await expect(feedLine(page, LOCAL_ORCHESTRATOR_OFF_LINE)).toBeVisible({ timeout: 20_000 });
      });
    });
  });
