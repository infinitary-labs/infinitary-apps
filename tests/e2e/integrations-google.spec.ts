import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { eventsWords } from "@shared/automation";
import { automationEventWords } from "@shared/automationWords";
import {
  GOOGLE_CLIENT_SETUP_PAGE,
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
} from "../../src/core/integrations";
import { NOTICE_WORDS } from "../../src/core/orchestrator/noticeWakes";
import type { CustodySlot } from "../../src/core/secrets/custody";
import * as m from "../../src/shared/i18n/messages.generated";
import { SECRETS_WORDS } from "../../src/shared/secrets";
import { SHOOT_EVENT, STUDIO_CALENDAR } from "../helpers/calendarStandIn";
import {
  type GoogleStandIn,
  OWN_CLIENT_ID,
  OWN_CLIENT_SECRET,
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
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
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

/** The file Google Cloud gives for a Desktop app client, as it downloads it. */
const OWN_CLIENT_FILE = JSON.stringify({
  installed: {
    client_id: OWN_CLIENT_ID,
    project_id: "ada-mail-assistant",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: OWN_CLIENT_SECRET,
    redirect_uris: ["http://localhost"],
  },
});

/** Puts a client file in the setup's masked field by keys and keeps it with Enter. */
async function keepClientFile(setup: Locator, file: string): Promise<void> {
  const field = setup.getByLabel(m.integrationsGoogleSetupField(), { exact: true });
  await focusOn(field);
  await typeInto(field, file, { insert: true });
  await pressKey(field, "Enter");
}

/**
 * INF-5549's plan, piece 3: "the Google row offers Set up: it opens the
 * Personal mode link, then asks Secrets to keep the client file through a
 * drop target", Google's notice and consent page then run for that client,
 * and "new sign-ins use only an own client"; INF-887's development and
 * released builds both take that path, and a released build still ignores
 * development overrides.
 * Data: fresh isolated homes, no account; the own client's file as Google
 * Cloud gives it, with the stand-in's own-client id.
 * Completion: development and packaged Settings offer Set up Google; keys
 * open the setup, whose Cancel opens nothing, then its first step opens
 * Google's Personal mode page, the file pasted by keys is kept, Google's
 * notice comes next, and its accept opens Google's real consent page for the
 * person's own client, cancelled without saving a connection; the chip then
 * signs in with the kept client. No external browser is opened.
 * Prerequisites: hermetic launcher with disposable Secrets, including its
 * inert packaged bootstrap.
 * Shared resources: none beyond the desktop lane's packaged connection port.
 */
test("development and released builds set up the person's own Google client by keys", async () => {
  for (const packaged of [false, true]) {
    await test.step(
      packaged
        ? "released Google ignores development overrides"
        : "development needs the person's own client",
      async () => {
        launched = packaged
          ? await launchApp({
              packaged,
              withMockProvider: true,
              env: {
                INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
                INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
                INFINITARY_GOOGLE_URL: "http://127.0.0.1:1",
              },
            })
          : await launchSecrets({ withMockProvider: true });
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
          await expect(chip).toHaveText(m.integrationsGoogleSetUpChip());
          const opening = () =>
            app.evaluate(() => (globalThis as { googleOpened?: string[] }).googleOpened ?? []);
          await pressKey(chip, "Enter");
          const setup = tab.locator('[data-integration-setup="google"]');
          await expect(setup).toBeFocused();
          await pressKey(
            setup.getByRole("button", { name: m.integrationsSignInCancel(), exact: true }),
            "Enter",
          );
          await expect(setup).toHaveCount(0);
          await expect(chip).toBeFocused();
          expect(await opening()).toEqual([]);

          await pressKey(chip, "Enter");
          await pressKey(
            setup.getByRole("button", { name: m.integrationsGoogleSetupOpenPage(), exact: true }),
            "Enter",
          );
          await expect.poll(opening).toEqual([GOOGLE_CLIENT_SETUP_PAGE]);
          if (packaged) {
            // The packaged launcher has no disposable Secrets, so keeping the file stays with the development step.
            await expect(setup).toBeVisible();
            return;
          }
          await keepClientFile(setup, OWN_CLIENT_FILE);
          await expect(setup).toHaveCount(0);
          await expect(tab.locator('[data-integration-notice="google"]')).toBeFocused();
          await acceptGoogleNotice(tab);
          const waiting = tab.locator('[data-integration-signing-in="google"]');
          await expect(waiting).toContainText(m.integrationsGoogleSignInHint());
          await expect.poll(async () => (await opening()).length).toBe(2);
          const consent = new URL((await opening())[1] ?? "");
          expect(consent.origin).toBe("https://accounts.google.com");
          // Google's page names the person's own client.
          expect(consent.searchParams.get("client_id") === OWN_CLIENT_ID).toBe(true);
          await pressKey(
            waiting.getByRole("button", {
              name: INTEGRATIONS_BROWSER_SIGN_IN_WORDS.cancel,
              exact: true,
            }),
            "Enter",
          );
          await expect(waiting).toHaveCount(0);
          await expect(chip).toHaveText(INTEGRATION_KIND_NAMES.google);
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

/**
 * INF-5549's plan, piece 3: the Google row's states and the switch-over. "A
 * sign-in made with Infinitary's client keeps renewing until piece 5 and
 * shows Set up your own Google connection"; "while Google's page is open, the
 * row reminds the person to sign in with the account that made the client";
 * "if the token answer carries a lifetime, the row says the client is not in
 * Personal mode and how to set it up again"; a client Google refused reads as
 * stopped, with Set up again.
 * Data: the stand-in Google (`tests/helpers/googleStandIn.ts`) as the run's
 * Google, first as a development run's own client for the earlier sign-in,
 * then with no run client, as a released build; the own client's file as
 * Google Cloud gives it, and a Web application client's file it refuses.
 * Completion: the row's state words, detail line and one next step at each
 * state, the consent page's client, and the setup's focus.
 * Prerequisites: the hermetic launcher with disposable Secrets, relaunched on
 * the same data folder.
 * Shared resources: none; its own userData, HOME and stand-in Google.
 */
test("the Google row moves a sign-in to the person's own client by keys", async () => {
  const userDataDir = scratchDir("infinitary-google-own-");
  google = await startGoogleStandIn();
  const stand = google;
  const recordOpened = (app: LaunchedApp["app"]) =>
    app.evaluate(({ shell }) => {
      (globalThis as { googleOpened?: string[] }).googleOpened = [];
      shell.openExternal = async (url) => {
        (globalThis as { googleOpened?: string[] }).googleOpened?.push(url);
      };
    });
  const opening = (app: LaunchedApp["app"]) =>
    app.evaluate(() => (globalThis as { googleOpened?: string[] }).googleOpened ?? []);
  let custody: Map<CustodySlot, Buffer> = new Map();

  await test.step("an earlier sign-in made with Infinitary's client", async () => {
    stand.knobs.lasts = undefined;
    launched = await launchSecrets({
      userDataDir,
      withMockProvider: true,
      env: {
        ...SHORT_TICK,
        INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
        INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
        INFINITARY_GOOGLE_URL: stand.base,
      },
    });
    const { app, page } = launched;
    await recordOpened(app);
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await pressKey(tab.locator('[data-integration-add="google"] button'), "Enter");
    await acceptGoogleNotice(tab);
    await expect.poll(async () => (await opening(app)).length).toBe(1);
    await fetch((await opening(app))[0] ?? "");
    await expect(tab.locator('[data-integration-row="google"]')).toContainText(STAND_IN_ACCOUNT);
    // The computer's custody outlives the app, so the relaunch opens the same Secrets.
    const slots = await app.evaluate(() =>
      [...(globalThis as SecretsJourneyGlobal).secretsJourney.custody.slots].map(
        ([slot, bytes]) => [slot, bytes.toString("base64")] as const,
      ),
    );
    custody = new Map(slots.map(([slot, bytes]) => [slot, Buffer.from(bytes, "base64")]));
    await launched.close();
    launched = undefined;
  });

  launched = await launchSecrets({
    userDataDir,
    withMockProvider: true,
    leftCustody: custody,
    env: { ...SHORT_TICK, INFINITARY_GOOGLE_URL: stand.base },
  });
  const { app, page } = launched;
  await recordOpened(app);
  await runFromSearch(app, page, "settings.integrations");
  const tab = settingsSection(page, "integrations");
  const row = tab.locator('[data-integration-row="google"]');
  const state = row.locator("[data-integration-client]");
  const next = (words: string) => row.getByRole("button", { name: words, exact: true });
  const detail = tab.locator('[data-integration-client-detail="google"]');
  const setup = tab.locator('[data-integration-setup="google"]');

  await test.step("the sign-in on Infinitary's client says to set up an own one", async () => {
    await expect(state).toHaveText(m.integrationsGoogleRetiring());
    await expect(detail).toHaveText(m.integrationsGoogleRetiringDetail());
    await expect(next(m.integrationsGoogleSetUp())).toBeVisible();
    await expect(row).toHaveAttribute("data-integration-state", "ok");
  });

  await test.step("a Web application client's file is refused and nothing is kept", async () => {
    await pressKey(next(m.integrationsGoogleSetUp()), "Enter");
    await expect(setup).toBeFocused();
    await keepClientFile(
      setup,
      JSON.stringify({ web: { client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET } }),
    );
    await expect(setup.locator("[data-integration-setup-problem]")).toHaveText(
      m.integrationsGoogleClientFileWeb(),
    );
    await expect(state).toHaveText(m.integrationsGoogleRetiring());
  });

  await test.step("the own client's file is kept and Google's page names that client", async () => {
    stand.knobs.lasts = 604_799;
    await keepClientFile(setup, OWN_CLIENT_FILE);
    await expect(setup).toHaveCount(0);
    await expect(tab.locator('[data-integration-notice="google"]')).toBeFocused();
    await acceptGoogleNotice(tab);
    await expect(tab.locator('[data-integration-signing-in="google"]')).toContainText(
      m.integrationsGoogleSignInHint(),
    );
    await expect.poll(async () => (await opening(app)).length).toBe(1);
    const consent = (await opening(app))[0] ?? "";
    expect(new URL(consent).searchParams.get("client_id") === OWN_CLIENT_ID).toBe(true);
    await fetch(consent);
    await expect(tab.locator('[data-integration-signing-in="google"]')).toHaveCount(0);
  });

  await test.step("a client Google ends after seven days says so", async () => {
    // The stand-in names the lasting key's lifetime, as Google does for a client in Testing;
    // the date is the computer's own form, so the words around it are what the row is held to.
    const [before = "", after = ""] = m.integrationsGoogleStops({ date: "\u0000" }).split("\u0000");
    const shown = async () => (await state.textContent()) ?? "";
    await expect
      .poll(async () => {
        const words = await shown();
        return (
          words.length > before.length + after.length &&
          words.startsWith(before) &&
          words.endsWith(after)
        );
      })
      .toBe(true);
    const date = (await shown()).slice(before.length, (await shown()).length - after.length);
    await expect(detail).toHaveText(m.integrationsGoogleStopsDetail({ date }));
    await expect(next(m.integrationsGoogleSetUpAgain())).toBeVisible();
  });

  await test.step("a client Google refused reads as stopped and sets up again by keys", async () => {
    stand.knobs.deleted.add(OWN_CLIENT_ID);
    stand.lapse();
    await page.evaluate(() => window.infinitary.integrations.check("google"));
    await expect(state).toHaveText(m.integrationsGoogleStopped());
    await expect(detail).toHaveText(m.integrationsGoogleStoppedDetail());
    await pressKey(next(m.integrationsGoogleSetUpAgain()), "Enter");
    await expect(setup).toBeFocused();
    await expect(setup.locator("[data-integration-setup-refused]")).toHaveText(
      m.integrationsGoogleStoppedDetail(),
    );
  });
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

  // INF-4096: signing in was the consent, so Secrets lists the sign-in as kept for its
  // service, with no Replace, Forget or saved decision, and opens Integrations by keys.
  await test.step("Secrets lists the sign-in as kept, asked nothing, and opens Integrations by keys", async () => {
    await runFromSearch(app, page, "settings.secrets");
    const section = settingsSection(page, "secrets");
    await expect(section.locator("[data-secret-waiting]")).toHaveCount(0);
    const row = section.getByRole("listitem").filter({ hasText: "Google sign-in" });
    const summary = row.locator("summary");
    await pressKey(summary, "Enter");
    await expect(row.locator("[data-secrets-kept]")).toContainText(m.settingsSecretsKeptSignIn());
    await expect(row.getByRole("button", { name: SECRETS_WORDS.replace, exact: true })).toHaveCount(
      0,
    );
    await expect(row.getByRole("button", { name: SECRETS_WORDS.forget, exact: true })).toHaveCount(
      0,
    );
    await expect(row.getByRole("button", { name: SECRETS_WORDS.remove, exact: true })).toHaveCount(
      0,
    );
    const manage = row.getByRole("button", {
      name: m.settingsSecretsManageInIntegrations(),
      exact: true,
    });
    await pressKey(summary, "Tab");
    await expect(manage).toBeFocused();
    await pressKey(manage, "Enter");
    await expect(settingsSection(page, "integrations")).toBeVisible();
    await expect(
      settingsSection(page, "integrations").locator('[data-integration-row="google"]'),
    ).toContainText(`as ${STAND_IN_ACCOUNT}`);
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
