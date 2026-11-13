import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { eventsWords } from "@shared/automation";
import { automationEventWords } from "@shared/automationWords";
import {
  GOOGLE_DATA_KEPT,
  INTEGRATION_KIND_NAMES,
  INTEGRATION_NOTICES,
  INTEGRATION_RULE_WORDS,
  INTEGRATIONS_BROWSER_SIGN_IN_WORDS,
  INTEGRATIONS_WORDS,
} from "@shared/integrations";
import { fenced, fencedSpans } from "@shared/outsideData";
import { outsideDataDeletedNote, SAVED_OUTSIDE_DATA_WORDS } from "@shared/savedOutsideData";
import {
  CALENDAR_ACTIONS,
  CALENDAR_CHANGED_EVENT,
  GMAIL_MESSAGE_EVENT,
  GOOGLE_DATA_FENCE,
  GOOGLE_OAUTH_CLIENT,
} from "../../src/core/integrations";
import { NOTICE_WORDS } from "../../src/core/orchestrator/noticeWakes";
import { SHOOT_EVENT, STUDIO_CALENDAR } from "../helpers/calendarStandIn";
import {
  type GoogleStandIn,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../helpers/googleStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { readSavedData } from "./savedData";
import {
  AUTOMATION_EVENTS_ANSWER,
  type AutomationEventsSeen,
  automationEvents,
} from "./scenarios/automationEvents";
import { launchSecrets } from "./secretsHarness";
import { settingRow, settingsSection } from "./settings";
import { focusOn, pressKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * INF-784, piece 5 of the accepted integrations plan: "a journey on
 * recorded answers where an arriving message fires a rule", after one
 * Google sign-in from Settings (the captain's q8: "one Google row that
 * signs in once for both, asking every permission up front").
 *
 * - Promised result: the Google chip, pressed by keys, shows Google's
 *   notice (INF-949) and opens nothing until its accept; the accept, by keys,
 *   opens Google's consent page in the browser and says to finish there; once the browser
 *   comes back the Google row shows who it is signed in as, with its Gmail
 *   all actions asking; a rule listening for "A message
 *   arrives" then reaches the first mate with the message that arrived;
 *   the delete in Settings → Integrations' Data section, by keys (the
 *   captain: "maybe all data deletion stuff gets put into another "Data"
 *   section at the bottom of the integrations tab"), then puts a note where
 *   its sender and subject were in the first mate's saved conversation and
 *   the rule's run, and the conversation stays (INF-952: "A person can
 *   delete the Gmail and Calendar content Infinitary saved without purging
 *   every task").
 * - Data: the stand-in Google (`tests/helpers/googleStandIn.ts`), answering
 *   in Google's documented shapes, as the run's Google and its client; one
 *   message delivered to its inbox after the rule found its place.
 * - Completion signal: the recorded consent page address, then the row's
 *   account, then the rule's saved cursor, then the first mate turn the
 *   stand-in model served, then the first mate at rest, then the delete's
 *   answer and the saved files and run.
 * - Platform prerequisites: the hermetic launcher with disposable Secrets
 *   (`tests/e2e/secretsHarness.ts`), where the sign-in keeps its key; its stand-in
 *   model and the shortened tick; the system browser is a recorder, and the
 *   test follows the consent page itself the way a browser does.
 * - Shared resources: none; its own userData, HOME and stand-in Google.
 */

/** Google's notice, words from their owner (INF-949). */
const NOTICE = (() => {
  const notice = INTEGRATION_NOTICES.google;
  if (!notice) throw new Error("Google shows a notice before its sign-in");
  return notice;
})();

/** Accept Google's notice by keys; it closes, and the sign-in starts. */
async function acceptGoogleNotice(tab: Locator): Promise<void> {
  const notice = tab.locator('[data-integration-notice="google"]');
  await pressKey(notice.getByRole("button", { name: NOTICE.accept, exact: true }), "Enter");
  await expect(notice).toHaveCount(0);
}

let launched: LaunchedApp | undefined;
let google: GoogleStandIn | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await google?.close();
  google = undefined;
});

/**
 * INF-887: the captain asks this PR to match an unverified production audience
 * for private testing, using stable for testers and alpha for personal development.
 * Data: fresh isolated homes with the real registered public client, no account.
 * Completion: development and packaged Settings offer one Google chip; keys open
 * Google's notice, whose Cancel opens nothing (INF-949), then its accept opens
 * registered-client consent, cancelled without saving a connection. Packaged
 * setup also ignores development overrides. No external browser is opened.
 * Prerequisites: hermetic launcher, including its inert packaged bootstrap.
 * Shared resources: none beyond the desktop lane's packaged connection port.
 */
test("development and released builds offer the registered Google client by keys", async () => {
  for (const packaged of [false, true]) {
    await test.step(
      packaged
        ? "released Google ignores development overrides"
        : "development uses the registered client",
      async () => {
        launched = await launchApp({
          packaged,
          withMockProvider: true,
          ...(packaged
            ? {
                env: {
                  INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
                  INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
                  INFINITARY_GOOGLE_URL: "http://127.0.0.1:1",
                },
              }
            : {}),
        });
        const { app, page } = launched;
        try {
          await app.evaluate(({ shell }) => {
            (globalThis as { googleOpened?: string[] }).googleOpened = [];
            shell.openExternal = async (url) => {
              (globalThis as { googleOpened?: string[] }).googleOpened?.push(url);
            };
          });
          await runFromSearch(app, page, "settings.integrations");
          const tab = settingsSection(page, "integrations");
          const chip = tab.locator('[data-integration-add="google"] button');
          await expect(chip).toHaveCount(1);
          const opening = () =>
            app.evaluate(() => (globalThis as { googleOpened?: string[] }).googleOpened ?? []);
          // INF-949: the notice comes first, and its Cancel asks Google nothing.
          await pressKey(chip, "Enter");
          const notice = tab.locator('[data-integration-notice="google"]');
          await expect(notice).toBeFocused();
          await pressKey(notice.getByRole("button", { name: NOTICE.cancel, exact: true }), "Enter");
          await expect(notice).toHaveCount(0);
          await expect(chip).toBeFocused();
          expect(await opening()).toEqual([]);
          await pressKey(chip, "Enter");
          await acceptGoogleNotice(tab);
          await expect(tab.locator('[data-integration-signing-in="google"]')).toBeVisible();
          const opened = await opening();
          // A boolean failure cannot print the registered client configuration.
          expect(
            opened.length === 1 &&
              new URL(opened[0] ?? "").origin === "https://accounts.google.com" &&
              new URL(opened[0] ?? "").searchParams.get("client_id") === GOOGLE_OAUTH_CLIENT.id,
          ).toBe(true);
          await pressKey(
            tab.locator('[data-integration-signing-in="google"]').getByRole("button", {
              name: INTEGRATIONS_BROWSER_SIGN_IN_WORDS.cancel,
              exact: true,
            }),
            "Enter",
          );
          await expect(tab.locator('[data-integration-signing-in="google"]')).toHaveCount(0);
          await expect(chip).toHaveCount(1);
          expect(
            await page.evaluate(
              async () => (await window.infinitary.integrations.list()).integrations.length,
            ),
          ).toBe(0);
        } finally {
          await launched.close();
          launched = undefined;
        }
      },
    );
  }
});

test("one Google sign-in from Settings by keys, and a message arriving fires a rule", async () => {
  const userDataDir = scratchDir("infinitary-google-");
  google = await startGoogleStandIn();
  const seen: AutomationEventsSeen = { turns: [] };
  // The sign-in's lasting key is kept in Secrets (INF-785), here on disposable custody.
  launched = await launchSecrets({
    userDataDir,
    withMockProvider: true,
    scenarios: [automationEvents(seen)],
    env: {
      ...SHORT_TICK,
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  const { app, page } = launched;
  const stand = google;
  // The system browser, replaced by a recorder: the test follows the page itself.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const opened = () =>
    app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

  await test.step("the chip shows Google's notice, and nothing opens until it is accepted", async () => {
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await pressKey(tab.locator('[data-integration-add="google"] button'), "Enter");
    const notice = tab.locator('[data-integration-notice="google"]');
    await expect(notice).toBeFocused();
    await expect(notice).toHaveAccessibleName(NOTICE.title);
    // The line that says to sign in on the first mate's computer is a view's alone.
    await expect(notice.locator("[data-integration-notice-there]")).toHaveCount(0);
    // What it uses and where it goes: the AI provider, other computers, saved task records.
    for (const item of NOTICE.groups.flatMap((group) => group.items))
      await expect(notice).toContainText(item.text);
    expect(await opened()).toEqual([]);
    expect(stand.tokens).toEqual([]);
  });

  await test.step("the accept opens Google's page, and the row comes back signed in", async () => {
    const tab = settingsSection(page, "integrations");
    await acceptGoogleNotice(tab);
    await expect(tab.locator('[data-integration-signing-in="google"]')).toContainText(
      INTEGRATIONS_BROWSER_SIGN_IN_WORDS.waiting(INTEGRATION_KIND_NAMES.google),
    );
    await expect.poll(async () => (await opened()).length).toBe(1);
    const [consent = ""] = await opened();
    expect(consent.startsWith(`${stand.base}/o/oauth2/v2/auth?`)).toBe(true);

    // The person's browser: Google's page sends it back to the app on this computer.
    const back = await fetch(consent);
    expect(await back.text()).toContain("Signed in to Google");

    const row = tab.locator('[data-integration-row="google"]');
    await expect(row).toContainText(`as ${STAND_IN_ACCOUNT}`);
    await expect(tab.locator('[data-integration-signing-in="google"]')).toHaveCount(0);
    const actions = tab.locator('[data-integration-actions="google"]');
    await expect(
      actions.locator('[data-integration-action="search_mail"] [data-integration-rule]'),
    ).toHaveText(INTEGRATION_RULE_WORDS.ask);
    await expect(
      actions.locator('[data-integration-action="send_message"] [data-integration-rule]'),
    ).toHaveText(INTEGRATION_RULE_WORDS.ask);
    await expect(
      actions.locator(`[data-integration-event="${GMAIL_MESSAGE_EVENT.name}"]`),
    ).toContainText(GMAIL_MESSAGE_EVENT.label);
  });

  await test.step("a message that arrives reaches the first mate through a rule", async () => {
    const rule = await page.evaluate(
      (event) =>
        window.infinitary.automation.save({
          name: "Triage new mail",
          spec: { kind: "event", integration: "google", event },
          prompt: "Sort these by urgency: {{events}}",
          enable: true,
        }),
      GMAIL_MESSAGE_EVENT.name,
    );
    expect(rule.when).toBe(
      automationEventWords(GMAIL_MESSAGE_EVENT.label, INTEGRATION_KIND_NAMES.google),
    );
    // Its first look finds its place in the mailbox, so only what arrives after it fires.
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

    const from = "Lena Ortiz <lena@ortiz-studio.com>";
    const subject = "Invoice 2214 for the October shoot";
    const id = stand.deliver({
      from,
      subject,
      text: "Hi Ada, the invoice for the October shoot is attached.",
    });
    await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(1);
    // INF-951: the sender and subject anyone can write arrive fenced as data from outside.
    const [span] = fencedSpans(seen.turns[0] ?? "");
    expect(span).toMatchObject({ label: GOOGLE_DATA_FENCE, closed: true });
    const summary = fenced(`From ${from}: ${subject}`, {
      label: GOOGLE_DATA_FENCE,
      value: span?.value ?? "",
      at: span?.at ?? 0,
    });
    expect(seen.turns[0]).toContain(`Sort these by urgency: ${eventsWords([{ id, summary }])}`);
    const wake = NOTICE_WORDS.scheduled(
      {
        kind: "scheduled",
        prompt: `Sort these by urgency: ${eventsWords([{ id, summary }])}`,
        catchUp: false,
        captainRequested: rule.captainRequested,
        events: {
          integration: INTEGRATION_KIND_NAMES.google,
          label: GMAIL_MESSAGE_EVENT.label,
          count: 1,
        },
        rule: { id: rule.id, ...(rule.name ? { name: rule.name } : {}) },
      },
      { ways: [], text: "" },
    );
    expect(seen.turns[0]).toContain(wake);
  });

  await test.step("Integrations' Data section deletes what the first mate read, by keys, and keeps its conversation", async () => {
    const subject = "Invoice 2214 for the October shoot";
    const sessions = join(userDataDir, "firstmate", "sessions");
    const saved = () =>
      readdirSync(sessions, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFileSync(join(sessions, name), "utf8"))
        .join("\n");
    const runs = () =>
      readSavedData(userDataDir, (db) =>
        (db.prepare("SELECT prompt FROM schedule_runs").all() as { prompt: string }[]).map(
          (run) => run.prompt,
        ),
      );
    // The turn that read the subject has ended: its conversation is saved, and free to rewrite.
    // The first mate is drawn outside Settings.
    await pressKey(page.getByRole("tab", { selected: true }), "Escape");
    await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
      "data-screen-label",
      "Settings",
    );
    await waitForFirstmateIdle(page);
    expect(saved()).toContain(subject);
    expect((await runs()).join("\n")).toContain(subject);

    // The delete is the Integrations tab's Data section, under its own label.
    await runFromSearch(app, page, "settings.integrations");
    const data = settingsSection(page, "integrations").locator("[data-integrations-data]");
    await expect(data).toContainText(INTEGRATIONS_WORDS.data);
    const row = settingRow(page, "delete-outside-data");
    await expect(data.locator(row)).toHaveCount(1);
    await expect(row).toContainText(SAVED_OUTSIDE_DATA_WORDS.title([GOOGLE_DATA_KEPT]));
    await expect(row).toContainText(SAVED_OUTSIDE_DATA_WORDS.description([GOOGLE_DATA_KEPT]));
    // Armed on the first press, as Purge is; the second deletes.
    await pressKey(
      row.getByRole("button", { name: SAVED_OUTSIDE_DATA_WORDS.delete, exact: true }),
      "Enter",
    );
    await pressKey(
      row.getByRole("button", { name: SAVED_OUTSIDE_DATA_WORDS.confirm, exact: true }),
      "Enter",
    );
    await expect(row).toContainText(
      SAVED_OUTSIDE_DATA_WORDS.done({ conversations: 1, waiting: 0 }),
    );

    const note = outsideDataDeletedNote(GOOGLE_DATA_KEPT.what);
    const after = saved();
    expect(after).not.toContain(subject);
    expect(after).toContain(note);
    // The rest of the conversation stays: the rule's own words and the first mate's answer.
    expect(after).toContain("Sort these by urgency:");
    expect(after).toContain(AUTOMATION_EVENTS_ANSWER);
    const [prompt = ""] = await runs();
    expect(prompt).not.toContain(subject);
    expect(prompt).toContain(note);
  });
});

/**
 * INF-786 / accepted INF-775 piece 6: one Google row, Calendar actions and
 * selected-calendar changes fire Automation. The data is Calendar v3-shaped
 * stand-in responses, with one event present before listening and a later
 * revision of it. The completion signal is the persisted filter and cursor,
 * then the first mate's turn containing that revision, not a private event
 * in another calendar. No platform prerequisite or shared resource beyond
 * the hermetic launcher with disposable Secrets: isolated HOME, data, key
 * custody and Google, no real sign-in.
 */
test("Calendar shares the Google row and a calendar selected by keys fires Automation", async () => {
  const userDataDir = scratchDir("infinitary-calendar-");
  google = await startGoogleStandIn();
  const stand = google;
  const existing = stand.calendar.change(STUDIO_CALENDAR, SHOOT_EVENT);
  const seen: AutomationEventsSeen = { turns: [] };
  // The sign-in's lasting key is kept in Secrets (INF-785), here on disposable custody.
  launched = await launchSecrets({
    userDataDir,
    withMockProvider: true,
    scenarios: [automationEvents(seen)],
    env: {
      ...SHORT_TICK,
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: stand.base,
    },
  });
  const { app, page } = launched;
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  await runFromSearch(app, page, "settings.integrations");
  const connections = settingsSection(page, "integrations");
  await pressKey(connections.locator('[data-integration-add="google"] button'), "Enter");
  await acceptGoogleNotice(connections);
  await expect(connections.locator('[data-integration-row="google"]')).toHaveCount(1);
  const actions = connections.locator('[data-integration-actions="google"]');
  for (const action of CALENDAR_ACTIONS) {
    await expect(
      actions.locator(`[data-integration-action="${action.name}"] [data-integration-rule]`),
    ).toHaveText(INTEGRATION_RULE_WORDS.ask);
  }
  await expect(
    actions.locator(`[data-integration-event="${CALENDAR_CHANGED_EVENT.name}"]`),
  ).toContainText(CALENDAR_CHANGED_EVENT.label);
  expect(stand.tokens.filter((t) => t.grant_type === "authorization_code")).toHaveLength(1);

  await runFromSearch(app, page, "settings.automation");
  const tab = settingsSection(page, "automation");
  await pressKey(tab.locator("[data-automation-new]"), "Enter");
  const sheet = tab.locator('[data-automation-sheet="new"]');
  await focusOn(sheet.locator("#automation-name"));
  await typeInto(sheet.locator("#automation-name"), "Studio calendar changes");
  await pressKey(sheet.locator("#automation-when"), "w");
  const what = sheet.locator("[data-automation-event]");
  await pressKey(what, "a");
  await expect(what).toHaveValue(`google/${CALENDAR_CHANGED_EVENT.name}`);
  const calendar = sheet.getByRole("textbox", { name: "Calendar", exact: true });
  await focusOn(calendar);
  await typeInto(calendar, STUDIO_CALENDAR);
  await focusOn(sheet.locator("#automation-prompt"));
  await typeInto(sheet.locator("#automation-prompt"), "Tell me what changed: {{events}}");
  await pressKey(sheet.locator("[data-automation-enable]"), "Enter");
  await expect(sheet.locator("[data-automation-review]")).toContainText(STUDIO_CALENDAR);
  await pressKey(sheet.locator("[data-automation-turn-on]"), "Enter");
  const rules = await page.evaluate(() => window.infinitary.automation.list());
  const rule = rules.rules.find((one) => one.name === "Studio calendar changes");
  expect(rule?.spec).toEqual({
    kind: "event",
    integration: "google",
    event: CALENDAR_CHANGED_EVENT.name,
    filter: { calendar: STUDIO_CALENDAR },
  });
  if (!rule) throw new Error("The calendar rule was not saved");
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
  expect(seen.turns).toEqual([]);
  stand.calendar.change("primary", { ...SHOOT_EVENT, summary: "Private appointment" });
  stand.calendar.change(STUDIO_CALENDAR, { id: existing.id, summary: "Shot list confirmed" });
  await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(1);
  expect(seen.turns[0]).toContain("Shot list confirmed");
  expect(seen.turns[0]).toContain(SHOOT_EVENT.start.dateTime);
  expect(seen.turns[0]).not.toContain("Private appointment");
  expect(seen.turns[0]).not.toContain(SHOOT_EVENT.description);
  expect(seen.turns[0]).toContain(CALENDAR_CHANGED_EVENT.label);
});
