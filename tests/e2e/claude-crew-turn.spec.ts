import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { launchClaudeCrew } from "./claudeCrew";
import { claudeQueued } from "./claudeSeat";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  MOCK_CLAUDE_CARD_TEXT,
  MOCK_CLAUDE_CARD_TITLE,
  MOCK_CLAUDE_STEERED_REPORT,
} from "./crewScripts";
import { cardBody, observeBody } from "./frames";
import type { LaunchedApp } from "./launch";
import {
  claudeDefaultStore,
  MOCK_CLAUDE_API_KEY,
  mockClaudeKeychainLookups,
} from "./mockClaudeClient";
import { SPAWN_PROMPT_MARKER, STEER_PROMPT_MARKER } from "./mockProvider";
import { reportLine, taskKey } from "./rails";
import { shownCard } from "./stack";
import { claudeStarter } from "./starters";
import { MAC_ONLY_TAG } from "./tags";

/**
 * A Claude crewmate runs a real turn (W1 S5; the owner's "tests for the
 * Claude seat, first-class"). The mock client hands the session to the
 * SDK's own co-released client (tests/e2e/mockClaudeClient.ts, turn mode),
 * so the turn crosses the real stream-json protocol and the real in-process
 * tool server: the model's `mcp__infinitary__emit_card` call becomes a card
 * on the record - on the stage once the crewmate reports - and a steer from
 * the captain rides into the running turn at its next step (the way the
 * seat's does, tests/e2e/claude-seat.spec.ts).
 *
 * Hermetic, and proved here rather than assumed: the client reached only
 * the mock provider, with only the dummy key, and every Keychain lookup it
 * made named a suffixed service - never the bare `Claude Code-credentials`
 * item that holds the machine's own login.
 *
 * The crewmate's record is the app's own (the session contract's step 6):
 * its transcript is copied into its task's folder, and Observe reads the
 * copy after the client's own file is gone.
 */

const TITLE = `count the rivets ${CLAUDE_CREW_PROMPT_MARKER}`;
const CLAUDE_MODEL_LABEL = claudeStarter("low").name;

/** The app's copies of every crewmate's Claude transcript, beside their served sidecars. */
function crewCopies(userDataDir: string): string[] {
  const crewmates = join(userDataDir, "crewmates");
  if (!existsSync(crewmates)) return [];
  return readdirSync(crewmates).flatMap((task) => {
    const dir = join(crewmates, task, "sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".served.jsonl"))
      .map((name) => join(dir, name));
  });
}

let launched: LaunchedApp;

// Keep app startup and shutdown in their own hook budgets; the single
// journey below owns every turn and transcript that its sections inspect.
test.beforeAll(async () => {
  launched = await launchClaudeCrew();
});

test.afterAll(async () => {
  await launched.close();
});

// These checks inspect the same turn, so they are ordered sections of one
// self-contained journey, not named tests consuming a predecessor's state.
test("a Claude crew turn shows its card, takes a mid-turn steer, and remains readable from the app's transcript copy", {
  tag: MAC_ONLY_TAG,
}, async () => {
  await test.step("a Claude crewmate's tool call becomes a card, and a steer lands mid-turn", async () => {
    const { page, mockProvider, homeDir } = launched;
    const input = page.getByRole("textbox", { name: "Task prompt" });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
    await input.press("Enter");

    // The card came through the real client's in-process tool protocol. It
    // is on the record, and off the stage until the crewmate closes out -
    // its report, or its idle (docs/card-threads.md "When a card reaches the
    // stage").
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.cards.list()))
            .filter((card) => card.title === MOCK_CLAUDE_CARD_TITLE)
            .map((card) => card.awaiting),
        { timeout: 30_000 },
      )
      .toEqual(["close-out"]);

    // The turn is still running: its next step waits on the model.
    await expect.poll(() => mockProvider?.heldRequests()).toBe(1);
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);

    await input.click();
    await input.fill(`${STEER_PROMPT_MARKER}${TITLE}: ${CLAUDE_STEER_MARKER}`);
    await input.press("Enter");

    // The client queued the steer into the running session - an order, never
    // a clock - and only then does the model's step come back.
    await expect
      .poll(() => claudeQueued(homeDir, CLAUDE_STEER_MARKER), { timeout: 30_000 })
      .toBe(true);
    expect(mockProvider?.heldRequests()).toBe(1);
    mockProvider?.releaseHeldCrew();

    await expect(
      reportLine(page, await taskKey(page, TITLE)).filter({
        hasText: reportSummary(MOCK_CLAUDE_STEERED_REPORT),
      }),
    ).toBeVisible({ timeout: 30_000 });
    expect(mockProvider?.heldRequests()).toBe(0);
    // The report was the close-out: the card is on the stage, and its model
    // chip names the Claude model the captain's words pinned.
    const card = shownCard(page, MOCK_CLAUDE_CARD_TITLE);
    await expect(card).toBeVisible();
    await expect(
      cardBody(page, MOCK_CLAUDE_CARD_TITLE).getByText(MOCK_CLAUDE_CARD_TEXT),
    ).toBeVisible();
    const head = card.locator("[data-card-head]");
    await expect(head.locator("[data-card-meta]")).toHaveText(TITLE);
    await expect(head.locator("[data-model-chip]")).toHaveText(CLAUDE_MODEL_LABEL);
    // It rode the running turn: the request that carried it also carried the
    // held step's tool result, and it was never sent again as a turn of its own.
    const headers = mockProvider?.requestHeaders() ?? [];
    const carrying = (mockProvider?.requestBodies() ?? []).filter(
      (body, index) =>
        headers[index]?.["user-agent"]?.startsWith("claude-cli/") === true &&
        body.includes(CLAUDE_STEER_MARKER),
    );
    expect(carrying[0]).toContain('"tool_use_id"');
    expect(carrying[0]).toContain("_held");
    expect(carrying.every((body) => body.includes("_held"))).toBe(true);
    await page.screenshot({ path: test.info().outputPath("steered-crew-card.png") });
    await test.info().attach("steered-crew-state", {
      body: JSON.stringify(
        {
          cards: await page.evaluate(() => window.infinitary.cards.list()),
          board: await page.evaluate(() => window.infinitary.tasks.board()),
          heldRequests: mockProvider?.heldRequests(),
          carryingRequests: carrying.length,
          steerSharesHeldToolResult: carrying.every((body) => body.includes("_held")),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  await test.step("the Claude client ran hermetically, never near the machine's login", async () => {
    const { mockProvider, homeDir } = launched;
    const claudeRequests = (mockProvider?.requestHeaders() ?? []).filter((headers) =>
      headers["user-agent"]?.startsWith("claude-cli/"),
    );
    // The steered turn above is at least three: card, the held step, the steer.
    expect(claudeRequests.length).toBeGreaterThanOrEqual(3);
    for (const headers of claudeRequests) {
      expect(headers["x-api-key"]).toBe(MOCK_CLAUDE_API_KEY);
      expect(headers.authorization).toBeUndefined();
    }

    // Its transcript is in the throwaway HOME's config dir, where the stub
    // pointed it.
    expect(existsSync(join(claudeDefaultStore(homeDir), "projects"))).toBe(true);
    expect(readdirSync(join(claudeDefaultStore(homeDir), "projects")).length).toBeGreaterThan(0);

    // Every Keychain lookup went through the shim, and every one named the
    // service a set CLAUDE_CONFIG_DIR suffixes - never the bare item that
    // holds the machine's login.
    const services = mockClaudeKeychainLookups(homeDir).map((line) => line.match(/ -s (.+)$/)?.[1]);
    if (process.platform === "darwin") expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(service).toMatch(/^Claude Code(-credentials)?-[0-9a-f]{8}$/);
    }
    await test.info().attach("hermetic-client-state", {
      body: JSON.stringify(
        {
          claudeRequests: claudeRequests.length,
          onlyDummyKeys: claudeRequests.every(
            (headers) => headers["x-api-key"] === MOCK_CLAUDE_API_KEY,
          ),
          noAuthorizationHeaders: claudeRequests.every(
            (headers) => headers.authorization === undefined,
          ),
          keychainServices: services,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  await test.step("the crewmate's transcript reads in Observe from the app's copy once the client's own is gone", async () => {
    const { page, homeDir, userDataDir } = launched;
    // The session copied the client's transcript into its task's folder at
    // the turn's idle boundary: the card's tool call is in it.
    await expect
      .poll(
        () => {
          const [copy] = crewCopies(userDataDir);
          return copy ? readFileSync(copy, "utf8").includes(MOCK_CLAUDE_CARD_TITLE) : false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const copies = crewCopies(userDataDir);
    expect(copies).toHaveLength(1);
    const sessionId = basename(copies[0] ?? "", ".jsonl");

    // The client's own file goes, as its 30-day sweep would take it.
    const projects = join(claudeDefaultStore(homeDir), "projects");
    const clientFiles = readdirSync(projects)
      .map((dir) => join(projects, dir, `${sessionId}.jsonl`))
      .filter((file) => existsSync(file));
    expect(clientFiles).toHaveLength(1);
    // e2e-claude-store: mutation -- reproduce the client removing its transcript during its 30-day sweep
    rmSync(clientFiles[0] ?? "");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Observe" }).click();
    const frame = observeBody(page);
    const crew = frame.locator('[data-observe-group="crewmate"]');
    await expect(crew).toContainText(TITLE);
    // Chromium drops native clicks into a sandboxed out-of-process frame
    // while the window is hidden, so the click is dispatched in-frame.
    await crew.locator("[data-observe-session]").first().dispatchEvent("click");
    const detail = frame.locator("[data-observe-detail]");
    await expect(detail.locator("[data-observe-detail-header]")).toContainText("claude");
    await expect(
      detail.locator('[data-observe-turn="tool"]').filter({ hasText: "emit_card" }).first(),
    ).toBeVisible();
    await expect(detail.locator("[data-observe-transcript-note]")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("observe-app-copy.png") });
    await test.info().attach("transcript-copy-state", {
      body: JSON.stringify(
        {
          appCopyExists: existsSync(copies[0] ?? ""),
          clientOriginalExists: existsSync(clientFiles[0] ?? ""),
          observeToolCalls: await detail.locator('[data-observe-turn="tool"]').allTextContents(),
          unavailableNotes: await detail.locator("[data-observe-transcript-note]").count(),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
  });
  await test.step("failure diagnostics retain the crew transcript and ordered provider requests before scratch cleanup", async () => {
    const copies = crewCopies(launched.userDataDir);
    await launched.close();
    const kept = crewCopies(launched.diagnosticsDir);
    expect(kept.map((file) => readFileSync(file, "utf8"))).toEqual(
      copies.map((file) => readFileSync(file, "utf8")),
    );
    const requests = readFileSync(join(launched.diagnosticsDir, "provider.requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((row) => JSON.stringify(row.body))).toEqual(
      launched.mockProvider?.requestBodies().map((body) => JSON.stringify(JSON.parse(body))),
    );
    expect(requests.some((row) => JSON.stringify(row.body).includes(MOCK_CLAUDE_CARD_TITLE))).toBe(
      true,
    );
  });
});
