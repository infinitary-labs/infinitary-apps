import { writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { HERE } from "../../src/shared/deviceNames";
import {
  DIAGNOSTIC_EVENT_NAMES,
  DIAGNOSTIC_INSTALL_ID_PATTERN,
  diagnosticDataViolation,
} from "../../src/shared/diagnostics";
import {
  DIAGNOSTICS_NOTHING_WAITING,
  DIAGNOSTICS_NOTICE_TEXT,
  DIAGNOSTICS_SUMMARY,
} from "../../src/shared/sharing";
import { WELCOME_TITLE } from "../../src/shared/welcome";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { firstRunHintOnThisComputer } from "./dictation";
import { committedWelcome } from "./firstLaunch";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import { minimumWindowSize, resizeWindow, within } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { MOCK_KEY_PROVIDER_ID, mockProviderOverrideModelsJson } from "./mockModels";
import {
  ANSWER_PROMPT_MARKER,
  FAIL_PROVIDER_PROMPT_MARKER,
  FINISH_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { assertReadableSettingsFeedback, REFUSAL, refuseNext, releaseSave } from "./settings";
import { shownCard } from "./stack";

/**
 * Diagnostics, on by default (docs/sharing.md): the allowlisted events of
 * src/shared/diagnostics.ts - the app launching, Firstmate turns ending or
 * failing, and the first-run funnel - each with its enum fields, the app
 * version and an anonymous random install ID, disclosed on the first
 * launch, with an opt-out that drops the ID.
 *
 * This runs the app's REAL wire client against a local stub of the
 * endpoint - the same runtime override a release build reads for its ids -
 * and watches the stub. The first install starts with no model that can
 * answer, so it walks the first-run funnel through the real window: the
 * gate, a key sign-in, the welcome note, the first turn and a failed
 * turn. A second install walks the crew half: a crewmate that starts,
 * reports and is closed. Every body that reaches the stub is
 * checked key by key against the allowlist, and none carries a word the
 * person typed.
 */

type Received = { body: Record<string, unknown>; headers: IncomingHttpHeaders };
type StubEndpoint = { server: Server; url: string; received: Received[] };
type Payload = {
  website: string;
  hostname: string;
  title: string;
  url: string;
  name: string;
  data: Record<string, unknown>;
  timestamp: number;
  id: string;
};

async function startStubEndpoint(): Promise<StubEndpoint> {
  const stub: StubEndpoint = { server: createServer(), url: "", received: [] };
  stub.server.on("request", (request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/send") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        stub.received.push({ body, headers: request.headers });
      }
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}`;
  return stub;
}

function closeStub(stub: StubEndpoint): Promise<void> {
  return new Promise((resolve) => stub.server.close(() => resolve()));
}

// Made per launch, never at module load: Playwright's runner loads this file
// too, and a directory made there outlives every worker's cleanup.
const clients = () => ({
  INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
});

function launchWithStub(stub: StubEndpoint, options: LaunchOptions = {}): Promise<LaunchedApp> {
  return launchApp({
    withMockProvider: true,
    ...options,
    env: {
      ...clients(),
      INFINITARY_UMAMI_HOST: stub.url,
      INFINITARY_UMAMI_WEBSITE_ID: "e2e-site",
      ...options.env,
    },
  });
}

/** A fresh install with no model that can answer: the first-run gate is up. */
function launchGated(stub: StubEndpoint, options: LaunchOptions = {}): Promise<LaunchedApp> {
  return launchWithStub(stub, { modelsJson: mockProviderOverrideModelsJson, ...options });
}

function payloads(stub: StubEndpoint, from = 0): Payload[] {
  return stub.received.slice(from).map((received) => received.body.payload as Payload);
}

function names(stub: StubEndpoint, from = 0): string[] {
  return payloads(stub, from).map((payload) => payload.name);
}

/**
 * The policy, on the wire: exactly the fixed keys, a declared event with
 * only its allowlisted enum/boolean/number fields and the app version, and
 * the anonymous install ID - nothing more on any body the stub received.
 */
function expectEveryBodyAllowlisted(stub: StubEndpoint, appVersion: string): void {
  for (const { body, headers } of stub.received) {
    expect(Object.keys(body).sort()).toEqual(["payload", "type"]);
    expect(body.type).toBe("event");
    const payload = body.payload as Payload;
    expect(Object.keys(payload).sort()).toEqual([
      "data",
      "hostname",
      "id",
      "name",
      "timestamp",
      "title",
      "url",
      "website",
    ]);
    expect(DIAGNOSTIC_EVENT_NAMES).toContain(payload.name);
    expect(diagnosticDataViolation(payload.name, payload.data)).toBeNull();
    expect(payload.data.version).toBe(appVersion);
    expect(payload).toMatchObject({
      website: "e2e-site",
      hostname: "app",
      title: "Firstmate 3000",
      url: `app://firstmate-3000/${payload.name}`,
    });
    expect(payload.id).toMatch(DIAGNOSTIC_INSTALL_ID_PATTERN);
    expect(Number.isInteger(payload.timestamp)).toBe(true);
    // The request carries no cookie and names only the build.
    expect(headers.cookie).toBeUndefined();
    expect(headers["user-agent"]).toBe(`firstmate-3000/${appVersion} telemetry`);
  }
}

function expectNothingTyped(stub: StubEndpoint, app: LaunchedApp): void {
  const wire = JSON.stringify(stub.received.map((received) => received.body));
  for (const typed of TYPED) expect(wire).not.toContain(typed);
  expect(wire).not.toContain(app.userDataDir);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Settings",
  );
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
    "data-screen-label",
    "Settings",
  );
}

async function homeShown(page: Page): Promise<void> {
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
}

function diagnosticsSwitch(page: Page) {
  return page.locator('[data-setting="diagnostics"] [role="switch"]');
}

function notice(page: Page) {
  return page.locator("[data-diagnostics-notice]");
}

async function sharingView(page: Page) {
  return page.evaluate(() => window.infinitary.settings.getSharing());
}

/** The version this install reports: every body it sends carries it. */
async function appVersionOf(page: Page): Promise<string> {
  return (await page.evaluate(() => window.infinitary.app.healthcheck())).version;
}

async function send(page: Page, text: string): Promise<void> {
  await page.evaluate((turn) => window.infinitary.conversation.send(turn), text);
}

/**
 * What the core holds of the events this run recorded: the ones still waiting
 * to go, then the ones the endpoint accepted (`sharingPreviewSchema`). An event
 * is in one of the two from the moment it is recorded until the run ends, so a
 * read here comes after every event the app recorded before it.
 */
async function sharingPreview(page: Page) {
  return page.evaluate(() => window.infinitary.settings.sharingPreview());
}
const TURN_MS = 45_000;

/** The first install's first turn: a greeting the stand-in answers with a card. */
const FIRST_TURN = `hello firstmate, ${ANSWER_PROMPT_MARKER}`;
/** What the person typed in this run: none of it may reach the endpoint. */
const TYPED = [
  "hello firstmate",
  ANSWER_PROMPT_MARKER,
  "write a short status note",
  "sk-first-launch",
];

// Each test has an endpoint of its own, so the stub holds only what that
// test's installs sent, and each reads the app version from its own install.
test.describe("diagnostics: allowlisted events with an anonymous install ID, on by default", () => {
  let stub: StubEndpoint;

  test.beforeEach(async () => {
    stub = await startStubEndpoint();
  });

  test.afterEach(async () => {
    await closeStub(stub);
  });

  for (const action of ["Turn off", "OK"] as const) {
    test(`${action} refusal keeps the notice, saved state and a keyboard retry across relaunch`, async () => {
      let launched = await launchGated(stub);
      const unhandled: string[] = [];
      try {
        const { app, page } = launched;
        page.on("pageerror", (error) => unhandled.push(error.message));
        const strip = notice(page);
        const choice = strip.getByRole("button", { name: action, exact: true });
        const other = strip.getByRole("button", {
          name: action === "OK" ? "Turn off" : "OK",
          exact: true,
        });
        await expect(strip).toBeVisible();
        const before = (await sharingView(page)).diagnostics;
        const channel =
          action === "OK" ? "inf:settings:sharing:viewed" : "inf:settings:sharing:set";
        await refuseNext(app, channel, false, REFUSAL, true);
        for (
          let i = 0;
          i < 30 && !(await choice.evaluate((el) => el === document.activeElement));
          i++
        ) {
          await page.keyboard.press("Tab");
        }
        await expect(choice).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(
          strip.getByRole("button").and(strip.locator('[aria-busy="true"]')),
        ).toBeDisabled();
        await expect(other).toBeDisabled();
        await expect(strip).toBeVisible();
        await releaseSave(app);
        await assertReadableSettingsFeedback(strip.getByRole("alert"), REFUSAL);
        await expect(strip).toHaveAttribute("data-diagnostics-enabled", "true");
        await expect(choice).toBeEnabled();
        expect((await sharingView(page)).diagnostics).toMatchObject({
          enabled: true,
          viewedAt: null,
          installId: before.installId,
        });
        expect(stub.received).toEqual([]);
        const refusal = await strip.getByRole("alert").innerText();

        // An unavailable recovery read must not erase the last confirmed state
        // or the refusal, and a later write still works without leaving home.
        await refuseNext(app, channel);
        await refuseNext(app, "inf:settings:sharing:get");
        await choice.press("Enter");
        await assertReadableSettingsFeedback(strip.getByRole("alert"), REFUSAL);
        await expect(strip.getByRole("alert")).not.toHaveText(refusal);
        await expect(strip).toHaveAttribute("data-diagnostics-enabled", "true");
        await expect(choice).toBeEnabled();
        const recovery = await strip.getByRole("alert").innerText();
        await resizeWindow(app, page, await minimumWindowSize(app));
        // Even the longer refusal stays wholly readable, with setup still
        // reachable above it rather than hidden behind the disabled input.
        await expect
          .poll(async () => {
            const box = await strip.getByRole("alert").boundingBox();
            const viewport = await page.evaluate(() => ({
              x: 0,
              y: 0,
              width: innerWidth,
              height: innerHeight,
            }));
            return box ? within(box, viewport) : ["missing"];
          })
          .toEqual([]);
        const gate = page.locator("[data-first-run-gate]");
        await gate.locator(`[data-connect-provider="${MOCK_KEY_PROVIDER_ID}"]`).click();
        const methods = gate.locator("[data-connect-method]");
        await expect(methods).toBeVisible();
        await methods.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(methods).toHaveCount(0);
        await choice.press("Enter");
        await expect(strip).toHaveCount(0);
        const saved = (await sharingView(page)).diagnostics;
        if (action === "Turn off") {
          expect(saved).toMatchObject({
            enabled: false,
            viewedAt: null,
            installId: null,
            pending: [],
          });
          expect(stub.received).toEqual([]);
        } else {
          expect(saved.enabled).toBe(true);
          expect(saved.viewedAt).not.toBeNull();
          await expect.poll(() => stub.received.length).toBeGreaterThan(0);
        }
        const { userDataDir } = launched;
        await launched.close();
        launched = await launchGated(stub, { userDataDir });
        await expect(notice(launched.page)).toHaveCount(0);
        expect((await sharingView(launched.page)).diagnostics).toMatchObject({
          enabled: saved.enabled,
          viewedAt: saved.viewedAt,
          installId: saved.installId,
        });
        expect(unhandled).toEqual([]);
        writeFileSync(
          test.info().outputPath(`notice-${action === "OK" ? "ok" : "off"}.json`),
          JSON.stringify(
            {
              before,
              refusal,
              recovery,
              saved,
              unhandled,
            },
            null,
            2,
          ),
        );
      } finally {
        await launched.close();
      }
    });

    test(`${action} partial save keeps the refusal beside the actual saved state`, async () => {
      const launched = await launchGated(stub);
      try {
        const { app, page } = launched;
        const unhandled: string[] = [];
        page.on("pageerror", (error) => unhandled.push(error.message));
        await resizeWindow(app, page, await minimumWindowSize(app));
        const strip = notice(page);
        await expect(strip).toBeVisible();
        await refuseNext(
          app,
          action === "OK" ? "inf:settings:sharing:viewed" : "inf:settings:sharing:set",
          true,
        );
        await strip.getByRole("button", { name: action, exact: true }).click();
        await assertReadableSettingsFeedback(strip.getByRole("alert"), REFUSAL);
        const saved = (await sharingView(page)).diagnostics;
        expect(saved.enabled).toBe(action === "OK");
        if (action === "OK") expect(saved.viewedAt).not.toBeNull();
        await expect(strip).toHaveAttribute("data-diagnostics-enabled", String(saved.enabled));
        const refusal = await strip.getByRole("alert").innerText();
        await strip.getByRole("button", { name: action, exact: true }).click();
        await expect(strip).toHaveCount(0);
        expect(unhandled).toEqual([]);
        writeFileSync(
          test.info().outputPath(`notice-partial-${action === "OK" ? "ok" : "off"}.json`),
          JSON.stringify(
            {
              saved,
              refusal,
              unhandled,
            },
            null,
            2,
          ),
        );
      } finally {
        await launched.close();
      }
    });
  }

  // Each section reads what the one before left: the answered notice, the
  // funnel's events on the wire, the first install's ID. A second install's
  // ID is "its own" only beside the first's. So the first-run walk is one
  // test with named sections (docs/testing.md, "Each test owns its
  // prerequisites").
  test("the first-run walk across two installs: told first, the gate half, the viewer, a relaunch, and the crew half", async () => {
    let first = await launchGated(stub);
    let appVersion: string;
    let installId: string;
    try {
      await test.step("the first launch says so under the input, and nothing leaves until it is answered", async () => {
        const { page } = first;
        await homeShown(page);
        appVersion = await appVersionOf(page);
        await expect(notice(page)).toBeVisible();
        await expect(notice(page)).toContainText(DIAGNOSTICS_NOTICE_TEXT);
        await expect(notice(page).getByRole("button", { name: "Turn off" })).toBeVisible();
        const view = await sharingView(page);
        expect(view.diagnostics).toMatchObject({ enabled: true, viewedAt: null, sentAt: null });
        expect(view.diagnostics.installId).toMatch(DIAGNOSTIC_INSTALL_ID_PATTERN);
        installId = view.diagnostics.installId as string;
        await expect
          .poll(async () => (await sharingPreview(page)).diagnostics.pending.map((e) => e.name))
          .toEqual(["ftue_first_launch", "app_launch", "ftue_gate_shown"]);
        expect((await sharingPreview(page)).diagnostics.sent).toEqual([]);
        expect(stub.received).toEqual([]);
      });

      await test.step("answered, what waited goes in order: the first launch, the launch and the gate", async () => {
        const { page } = first;
        await notice(page).getByRole("button", { name: "OK" }).click();
        await expect(notice(page)).toHaveCount(0);
        await expect
          .poll(() => names(stub), { timeout: 15_000 })
          .toEqual(["ftue_first_launch", "app_launch", "ftue_gate_shown"]);
        expectEveryBodyAllowlisted(stub, appVersion);
        expect(new Set(payloads(stub).map((payload) => payload.id))).toEqual(new Set([installId]));
        for (const payload of payloads(stub)) expect(payload.data).toEqual({ version: appVersion });
        const view = await sharingView(page);
        expect(view.diagnostics.viewedAt).not.toBeNull();
        expect(view.diagnostics.sentAt).not.toBeNull();
        expect(view.diagnostics.pending).toEqual([]);
      });

      await test.step("the first-run funnel through the gate: sign-in, the welcome, the first turn, and a failed turn", async () => {
        const { page } = first;
        // Connect through the gate with a key: the one sign-in with no browser.
        const gate = page.locator("[data-first-run-gate]");
        await gate.locator(`[data-connect-provider="${MOCK_KEY_PROVIDER_ID}"]`).click();
        await page
          .locator("[data-connect-method]")
          .getByRole("button", { name: "API key" })
          .click();
        const aside = gate.locator("[data-connect-aside]");
        await expect(aside.getByText(/API key/i)).toBeVisible({ timeout: 20_000 });
        await aside.locator("input[type='password']").fill("sk-first-launch");
        await aside.getByRole("button", { name: "Submit" }).click();
        await expect(gate).toHaveCount(0, { timeout: 30_000 });
        // The welcome is a note the app commits itself, with no model turn
        // (docs/first-launch.md); the sign-in that let it through is a step.
        await expect(shownCard(page, WELCOME_TITLE)).toBeVisible();
        await committedWelcome(page);
        await expect.poll(() => names(stub), { timeout: 15_000 }).toContain("ftue_signed_in");

        // The first turn, typed, and answered with a card. Left unanswered it
        // would earn the answer-missing retry (docs/task-capture.md); that
        // clean turn, landing after the failed turn below, ends the lane's
        // outage and runs the failed words again at once (docs/inbox.md, "The
        // honest retry") - a turn event the viewer's quiet interval then sees.
        const input = page.getByPlaceholder(firstRunHintOnThisComputer());
        await expect(input).toBeEnabled({ timeout: 10_000 });
        await input.click();
        await input.fill(FIRST_TURN);
        await input.press("Enter");
        await expect.poll(() => names(stub), { timeout: TURN_MS }).toContain("ftue_first_turn");
        await expect
          .poll(() => payloads(stub).filter((payload) => payload.name === "main_agent_turn_end"), {
            timeout: TURN_MS,
          })
          .toContainEqual(
            expect.objectContaining({ data: { trigger: "captain", version: appVersion } }),
          );

        // A turn the provider fails: only its kind leaves, never its message.
        await send(page, FAIL_PROVIDER_PROMPT_MARKER);
        await expect
          .poll(
            () => payloads(stub).filter((payload) => payload.name === "main_agent_turn_failed"),
            { timeout: TURN_MS },
          )
          .toContainEqual(
            expect.objectContaining({
              data: { trigger: "captain", reason: "provider", version: appVersion },
            }),
          );

        expect(names(stub).filter((name) => name.startsWith("ftue_"))).toEqual([
          "ftue_first_launch",
          "ftue_gate_shown",
          "ftue_signed_in",
          "ftue_first_turn",
        ]);
        expectEveryBodyAllowlisted(stub, appVersion);
        expect(new Set(payloads(stub).map((payload) => payload.id))).toEqual(new Set([installId]));
        expectNothingTyped(stub, first);
      });

      await test.step("the viewer shows the install ID, what went, and every event and field that can leave", async () => {
        const { page } = first;
        const settledHeard = stub.received.length;
        await openSettings(page);
        await expect(diagnosticsSwitch(page)).toHaveAttribute("aria-checked", "true");
        const row = page.locator('[data-setting="diagnostics"]');
        await expect(row).toContainText(DIAGNOSTICS_SUMMARY);
        await expect(row).toContainText("Sent to 127.0.0.1");
        await expect(page.locator('[data-setting="contribution"]')).toHaveCount(0);
        await page
          .getByRole("button", { name: new RegExp(`What would leave ${HERE.this}`) })
          .click();
        const viewer = page.locator("[data-sharing-viewer]");
        await expect(viewer.locator("[data-sharing-install-id]")).toContainText(installId);
        await expect(viewer).toContainText(DIAGNOSTICS_NOTHING_WAITING.on);
        const sent = viewer.locator('[data-sharing-records="diagnostics-sent"]');
        const failed = sent.locator('[data-sharing-record="main_agent_turn_failed"]').first();
        await expect(failed).toBeVisible();
        await failed.locator("summary").click();
        await expect(failed).toContainText(`"id": "${installId}"`);
        await expect(failed).toContainText('"reason": "provider"');
        for (const name of DIAGNOSTIC_EVENT_NAMES) {
          await expect(viewer.locator(`[data-sharing-catalog-event="${name}"]`)).toHaveCount(1);
        }
        const text = (
          await page.locator("[data-screen-label='Settings']").innerText()
        ).toLowerCase();
        for (const word of ["telemetry", "analytics", "umami"]) {
          expect(text).not.toContain(word);
        }
        // Unpublished terms are not shown: the draft says nothing is sent, and
        // beside Diagnostics on it would contradict the row above it.
        await expect(page.getByRole("button", { name: /The terms/ })).toHaveCount(0);
        await expect(page.locator("[data-sharing-terms]")).toHaveCount(0);
        expect(text).not.toContain("sends us nothing");
        expect(text).not.toContain("no diagnostic leaves");
        // Opening Settings is not an event. The core holds nothing waiting,
        // what it sent is exactly what the endpoint heard, and since Settings
        // opened only a turn (the failed turn's retry may still run) went.
        const held = await sharingPreview(page);
        expect(held.diagnostics.pending).toEqual([]);
        expect(held.diagnostics.sent.map((record) => record.name)).toEqual(names(stub));
        expect(
          names(stub, settledHeard).filter((name) => !name.startsWith("main_agent_turn_")),
        ).toEqual([]);
        await closeSettings(page);
      });

      await test.step("a relaunch sends the launch under the same install ID, and no first-run step again", async () => {
        const { userDataDir } = first;
        await first.close();
        const before = stub.received.length;
        first = await launchGated(stub, { userDataDir });
        await expect(first.page.locator("[data-screen-label]")).toBeVisible();
        await expect(notice(first.page)).toHaveCount(0);
        // The relaunch may pick up a turn where the last run left it; only the
        // launch and the first-run steps are this section's claim.
        const launchNames = () =>
          names(stub, before).filter((name) => !name.startsWith("main_agent_turn_"));
        await expect.poll(launchNames, { timeout: 15_000 }).toEqual(["app_launch"]);
        // Every event this run recorded has gone, so the endpoint has heard
        // each one: still only the launch.
        await expect
          .poll(async () => (await sharingPreview(first.page)).diagnostics.pending)
          .toEqual([]);
        expect(launchNames()).toEqual(["app_launch"]);
        expect(new Set(payloads(stub, before).map((payload) => payload.id))).toEqual(
          new Set([installId]),
        );
      });
    } finally {
      await first.close();
    }

    await test.step("a second fresh install has an install ID of its own, and walks the crew half: a crewmate started, reported and closed", async () => {
      const before = stub.received.length;
      const second = await launchWithStub(stub);
      try {
        const { page } = second;
        await homeShown(page);
        await notice(page).getByRole("button", { name: "OK" }).click();
        await expect
          .poll(() => names(stub, before), { timeout: 15_000 })
          .toEqual(["ftue_first_launch", "app_launch"]);

        await send(page, `${SPAWN_PROMPT_MARKER} write a short status note`);
        await expect
          .poll(() => names(stub, before), { timeout: TURN_MS })
          .toEqual(
            expect.arrayContaining(["ftue_first_spawn_started", "ftue_first_spawn_succeeded"]),
          );
        await send(page, `${FINISH_PROMPT_MARKER}write a short status note`);
        await expect
          .poll(
            () => payloads(stub, before).find((payload) => payload.name === "ftue_first_disposal"),
            { timeout: TURN_MS },
          )
          .toMatchObject({ data: { outcome: "landed", version: appVersion } });
        expect(names(stub, before).filter((name) => name.startsWith("ftue_"))).toEqual([
          "ftue_first_launch",
          "ftue_first_turn",
          "ftue_first_spawn_started",
          "ftue_first_spawn_succeeded",
          "ftue_first_disposal",
        ]);
        expectNothingTyped(stub, second);
      } finally {
        await second.close();
      }
      const ids = new Set(payloads(stub, before).map((payload) => payload.id));
      expect(ids.size).toBe(1);
      expect(ids.has(installId)).toBe(false);
      expectEveryBodyAllowlisted(stub, appVersion);
    });
  });

  test("the opt-out: turned off on the notice, nothing leaves across a relaunch, and back on is a new install ID", async () => {
    let third = await launchWithStub(stub);
    try {
      await homeShown(third.page);
      const appVersion = await appVersionOf(third.page);
      const minted = (await sharingView(third.page)).diagnostics.installId;
      expect(minted).toMatch(DIAGNOSTIC_INSTALL_ID_PATTERN);
      await notice(third.page).getByRole("button", { name: "Turn off" }).click();
      await expect(notice(third.page)).toHaveCount(0);
      await send(third.page, "hello firstmate");
      await openSettings(third.page);
      await expect(diagnosticsSwitch(third.page)).toHaveAttribute("aria-checked", "false");
      await closeSettings(third.page);
      // Off, the core records nothing: once the turn that message started has
      // ended, no event waits and none went.
      await waitForFirstmateIdle(third.page);
      expect((await sharingPreview(third.page)).diagnostics).toEqual({ pending: [], sent: [] });
      expect(stub.received).toEqual([]);
      const off = await sharingView(third.page);
      expect(off.diagnostics).toMatchObject({ enabled: false, installId: null, pending: [] });

      const { userDataDir } = third;
      await third.close();
      third = await launchWithStub(stub, { userDataDir });
      await homeShown(third.page);
      await expect(notice(third.page)).toHaveCount(0);
      expect((await sharingPreview(third.page)).diagnostics).toEqual({ pending: [], sent: [] });
      expect(stub.received).toEqual([]);
      expect((await sharingView(third.page)).diagnostics.installId).toBeNull();

      // Turned back on in Settings: what it sends is shown first, under a new ID.
      await openSettings(third.page);
      await diagnosticsSwitch(third.page).click();
      await expect(diagnosticsSwitch(third.page)).toHaveAttribute("aria-checked", "true");
      const viewer = third.page.locator("[data-sharing-viewer]");
      await expect(viewer).toBeVisible();
      const renewed = (await sharingView(third.page)).diagnostics.installId as string;
      expect(renewed).toMatch(DIAGNOSTIC_INSTALL_ID_PATTERN);
      expect(renewed).not.toBe(minted);
      await expect(viewer.locator("[data-sharing-install-id]")).toContainText(renewed);
      await closeSettings(third.page);
      await send(third.page, "hello firstmate");
      await expect
        .poll(() => payloads(stub).map((payload) => [payload.name, payload.id]), {
          timeout: TURN_MS,
        })
        .toContainEqual(["main_agent_turn_end", renewed]);
      expect(payloads(stub).every((payload) => payload.id === renewed)).toBe(true);
      expectEveryBodyAllowlisted(stub, appVersion);
    } finally {
      await third.close();
    }
  });
});
