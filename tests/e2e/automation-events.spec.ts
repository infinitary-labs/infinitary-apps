import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { eventsWords } from "@shared/automation";
import { automationEventWords } from "@shared/automationWords";
import { INTEGRATION_KIND_NAMES } from "@shared/integrations";
import { STAND_IN_EVENT } from "../../src/core/integrations";
import { NOTICE_WORDS } from "../../src/core/orchestrator/noticeWakes";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { readSavedData } from "./savedData";
import { type AutomationEventsSeen, automationEvents } from "./scenarios/automationEvents";
import { settingsSection } from "./settings";
import { focusOn, pressKey, runFromSearch, typeInto, untilFocused } from "./windowKeys";

/**
 * INF-775 piece 3: an Automation rule fires on an integration's event, and
 * the app looks on its one tick (the captain's q6).
 *
 * - Promised result: a rule saved and turned on from Settings → Automation
 *   by keys alone, listening for the stand-in's "An item arrives"; three
 *   items arriving at once reach the first mate as one turn naming all
 *   three, and the rule's saved history holds one run of those three.
 * - Data: the stand-in integration over a scratch folder's items file, the
 *   way a mail account's new messages would arrive; three items appended
 *   in one write after the rule found its place.
 * - Completion signal: the rule's saved cursor (its first look), then the
 *   first mate turn the stand-in model served, then the rule's saved runs.
 * - Platform prerequisites: none beyond the hermetic launcher, its stand-in
 *   model and the shortened tick.
 * - Shared resources: none; its own userData, HOME and items folder.
 */

const ITEMS = [
  { id: "m1", summary: "From Ada Park: Lunch on Friday?" },
  { id: "m2", summary: "From Build Bot: The nightly build failed" },
  { id: "m3", summary: "From Cy Moreno: Contract signed" },
];

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("a rule saved by keys fires once for three items that arrive together", async () => {
  const userDataDir = scratchDir("infinitary-automation-events-");
  const standIn = scratchDir("infinitary-stand-in-integration-");
  const items = join(standIn, "items.jsonl");
  writeFileSync(items, "");
  const seen: AutomationEventsSeen = { turns: [] };
  launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [automationEvents(seen)],
    env: { ...SHORT_TICK, INFINITARY_STAND_IN_INTEGRATION: standIn },
  });
  const { app, page } = launched;

  // Open Automation puts the keyboard on New automation.
  await runFromSearch(app, page, "settings.automation");
  const tab = settingsSection(page, "automation");
  const create = tab.locator("[data-automation-new]");
  await untilFocused(create);
  await pressKey(create, "Enter");
  const sheet = tab.locator('[data-automation-sheet="new"]');
  const name = sheet.locator("#automation-name");
  await focusOn(name);
  await typeInto(name, "Triage new items");
  // A letter picks "When something happens", which starts at the first event listed.
  const when = sheet.locator("#automation-when");
  await pressKey(when, "w");
  await expect(when).toHaveValue("event");
  const what = sheet.locator("[data-automation-event]");
  await expect(what).toHaveValue(`stand-in/${STAND_IN_EVENT.name}`);
  const prompt = sheet.locator("#automation-prompt");
  await focusOn(prompt);
  await typeInto(prompt, "Sort these by urgency: {{events}}");
  await pressKey(sheet.locator("[data-automation-enable]"), "Enter");
  const turnOn = sheet.locator("[data-automation-turn-on]");
  await untilFocused(turnOn);
  const listening = automationEventWords(STAND_IN_EVENT.label, INTEGRATION_KIND_NAMES["stand-in"]);
  await expect(sheet.locator("[data-automation-review]")).toContainText(listening);
  await pressKey(turnOn, "Enter");

  const rules = () => page.evaluate(async () => (await window.infinitary.automation.list()).rules);
  await expect
    .poll(async () => (await rules()).map((rule) => [rule.state, rule.when]))
    .toEqual([["enabled", listening]]);
  const [rule] = await rules();
  if (!rule) throw new Error("the rule was not saved");

  // Its first look finds its place, so only what arrives after it fires.
  await expect
    .poll(
      () =>
        readSavedData(
          userDataDir,
          (db) =>
            (
              db.prepare("SELECT event_cursor FROM schedules WHERE id = ?").get(rule.id) as
                | { event_cursor: string | null }
                | undefined
            )?.event_cursor ?? null,
        ),
      { timeout: 30_000 },
    )
    .not.toBeNull();

  appendFileSync(items, ITEMS.map((item) => `${JSON.stringify(item)}\n`).join(""));
  await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(1);
  const asked = `Sort these by urgency: ${eventsWords(ITEMS)}`;
  expect(seen.turns[0]).toContain(asked);
  const wake = NOTICE_WORDS.scheduled(
    {
      kind: "scheduled",
      prompt: asked,
      catchUp: false,
      captainRequested: rule.captainRequested,
      events: {
        integration: INTEGRATION_KIND_NAMES["stand-in"],
        label: STAND_IN_EVENT.label,
        count: ITEMS.length,
      },
      rule: { id: rule.id, ...(rule.name ? { name: rule.name } : {}) },
    },
    { ways: [], text: "" },
  );
  expect(seen.turns[0]).toContain(wake);

  // One run, carrying the three by their ids.
  const runs = () =>
    readSavedData(userDataDir, (db) =>
      (
        db.prepare("SELECT events FROM schedule_runs WHERE schedule_id = ?").all(rule.id) as {
          events: string;
        }[]
      ).map((run) => (JSON.parse(run.events) as { id: string }[]).map((item) => item.id)),
    );
  await expect.poll(runs).toEqual([ITEMS.map((item) => item.id)]);
  // Nothing more arrived, so no other turn came.
  expect(seen.turns).toHaveLength(1);
});
