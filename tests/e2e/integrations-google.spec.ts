import { expect, test } from "@playwright/test";
import { eventsWords } from "@shared/automation";
import { automationEventWords } from "@shared/automationWords";
import {
  INTEGRATION_KIND_NAMES,
  INTEGRATION_RULE_WORDS,
  INTEGRATIONS_BROWSER_SIGN_IN_WORDS,
} from "@shared/integrations";
import { GMAIL_MESSAGE_EVENT } from "../../src/core/integrations";
import {
  type GoogleStandIn,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../helpers/googleStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { readSavedData } from "./savedData";
import { type AutomationEventsSeen, automationEvents } from "./scenarios/automationEvents";
import { settingsSection } from "./settings";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * INF-784, piece 5 of the accepted integrations plan: "a journey on
 * recorded answers where an arriving message fires a rule", after one
 * Google sign-in from Settings (the captain's q8: "one Google row that
 * signs in once for both, asking every permission up front").
 *
 * - Promised result: the Google chip, pressed by keys, opens Google's
 *   consent page in the browser and says to finish there; once the browser
 *   comes back the Google row shows who it is signed in as, with its Gmail
 *   reads allowed and its changes asking; a rule listening for "A message
 *   arrives" then reaches the first mate with the message that arrived.
 * - Data: the stand-in Google (`tests/helpers/googleStandIn.ts`), answering
 *   in Google's documented shapes, as the run's Google and its client; one
 *   message delivered to its inbox after the rule found its place.
 * - Completion signal: the recorded consent page address, then the row's
 *   account, then the rule's saved cursor, then the first mate turn the
 *   stand-in model served.
 * - Platform prerequisites: none beyond the hermetic launcher, its stand-in
 *   model and the shortened tick; the system browser is a recorder, and the
 *   test follows the consent page itself the way a browser does.
 * - Shared resources: none; its own userData, HOME and stand-in Google.
 */

let launched: LaunchedApp | undefined;
let google: GoogleStandIn | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await google?.close();
  google = undefined;
});

test("one Google sign-in from Settings by keys, and a message arriving fires a rule", async () => {
  const userDataDir = scratchDir("infinitary-google-");
  google = await startGoogleStandIn();
  const seen: AutomationEventsSeen = { turns: [] };
  launched = await launchApp({
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

  await test.step("the chip opens Google's page, and the row comes back signed in", async () => {
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await pressKey(tab.locator('[data-integration-add="google"] button'), "Enter");
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
    ).toHaveText(INTEGRATION_RULE_WORDS.allow);
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
    expect(seen.turns[0]).toContain(
      `Sort these by urgency: ${eventsWords([{ id, summary: `From ${from}: ${subject}` }])}`,
    );
    expect(seen.turns[0]).toContain(`on 1 new event - ${GMAIL_MESSAGE_EVENT.label} in Google`);
  });
});
