import { cpSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import type { FreshAuthentication } from "../../src/core/secrets/approvals";
import { STANDBY_COPY, STANDBY_DIR } from "../../src/core/standby/keeper";
import { readSealedSecrets } from "../../src/core/standby/sealedSecrets";
import { STANDBY_WORDS } from "../../src/core/standby/words";
import * as m from "../../src/shared/i18n/messages.generated";
import { secretName } from "../../src/shared/secretNames";
import { SECRET_APPROVAL_CARD_WORDS, SECRETS_WORDS, secretsNamed } from "../../src/shared/secrets";
import { claimedPort } from "../helpers/claimedPort";
import { type DisposableCustody, disposableCustody } from "../helpers/disposableCustody";
import { scratchDir } from "../helpers/scratchDirs";
import { BUILDER, openDevices, rowAction, selectDevice } from "./deviceFixtures";
import { cardBody } from "./frames";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import type { LaunchedApp } from "./launch";
import { heroShot, regionShot } from "./pictures";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingsSection } from "./settings";
import { shownCard } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * The first mate's Secrets kept with a copy on another computer (INF-4207
 * piece 10, decisions 10 and 11; docs/devices.md, "Secrets on a computer that
 * keeps a copy"). The home is the built app on a scratch data folder with
 * stand-in Secrets custody and confirmation; Mac mini and Mac Studio are two
 * work modes in this process, each joined as another Mac, each with a
 * stand-in lock custody and its own stand-in confirmation. The captain keeps a
 * copy on both and keeps Secrets on Mac mini alone, confirming there once.
 * A changed secret reaches Mac mini's copy. Then a first mate starts from Mac
 * mini's copy, as a takeover starts one, with Mac mini's lock, and runs an
 * approved use with the changed value and no restore by hand.
 *
 * Promised result: Mac mini's Ready list reads its Secrets kept after one
 * confirmation there; Mac Studio was never asked and holds no lock; Mac
 * mini's copy carries the changed value sealed; the first mate started from
 * that copy sends the changed value on the captain's Allow once, with no
 * saved decision carried over.
 * Data: an invented calendar credential, changed once; a broker whose
 * transport records what it would send instead of reaching the network.
 * Completion signal: the Ready list's secrets line, the copy's sealed file,
 * and the use's completed state on the new home.
 * Platform prerequisites: none; it runs on Linux and the Mac.
 * Shared resources: none beyond the loopback connection each work mode opens.
 */

const MACBOOK = { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };
const TOKEN = "ya29.invented-standby-calendar";
const CHANGED = "ya29.invented-standby-calendar-changed";
const SECRET = { ref: "planning-calendar", label: "Planning calendar", environment: "Personal" };

const apps: LaunchedApp[] = [];
const runs: HelperRun[] = [];
test.afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop();
  for (const app of apps.splice(0).reverse()) await app.close().catch(() => {});
});

type Computer = {
  name: string;
  dataDir: string;
  deviceId: string;
  lock: DisposableCustody;
  confirmations: () => number;
};

/** A computer that runs work for the home, with a stand-in lock and confirmation of its own. */
async function computer(home: LaunchedApp, name: string): Promise<Computer> {
  const dataDir = join(scratchDir("infinitary-standby-secrets-computer-"), "work");
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const lock = disposableCustody();
  let confirmations = 0;
  const authentication: FreshAuthentication = {
    available: async () => true,
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  };
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    standbyLock: { custody: lock, authentication },
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  return {
    name,
    dataDir,
    deviceId: joined.grant.deviceId,
    lock,
    confirmations: () => confirmations,
  };
}

const copyOf = (there: Computer) => join(there.dataDir, STANDBY_DIR, STANDBY_COPY);

/** The home's own Settings keeps the secret, as the captain enters it. */
async function keepSecret(home: LaunchedApp, value: string): Promise<void> {
  await home.app.evaluate(
    async (_electron, { secret, value }) => {
      const settings = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets;
      const current = (await settings.view()).entries.find((entry) => entry.ref === secret.ref);
      await settings.put({
        ...secret,
        value,
        expectedVersion: current?.version ?? 0,
        expectedRevision: current?.revision ?? null,
      });
    },
    { secret: SECRET, value },
  );
}

test("Secrets kept with a copy: confirmed once there, sealed with each change, and an approved use runs on a first mate started from that copy", async () => {
  test.setTimeout(300_000);
  const env = { ...MACBOOK, INFINITARY_CONNECTION_LOOPBACK_PORT: String(await claimedPort()) };
  const home = await launchSecrets({ env });
  apps.push(home);
  await keepSecret(home, TOKEN);
  const mini = await computer(home, "Mac mini");
  const studio = await computer(home, "Mac Studio");
  const rowOf = (there: Computer) => selectDevice(home.page, there.deviceId);
  const lineOf = async (there: Computer) => (await rowOf(there)).locator("[data-standby]");

  await test.step("Keep a copy here on each row, by keys: both read in sync", async () => {
    await openDevices(home.page);
    for (const there of [mini, studio]) {
      await rowOf(there);
      await pressKey(await rowAction(home.page, there.deviceId, "standby-keep"), "Enter");
    }
    for (const there of [mini, studio])
      await expect(await lineOf(there)).toHaveAttribute("data-standby", "in-sync", {
        timeout: 60_000,
      });
  });

  const ready = home.page.locator(`[data-standby-ready="${mini.deviceId}"]`);
  const secretsLine = ready.locator('[data-gap="secrets"]');
  await test.step("Mac mini's Ready list asks to keep the Secrets there; one confirmation there keeps them", async () => {
    await rowOf(mini);
    await pressKey(await rowAction(home.page, mini.deviceId, "standby-ready"), "Enter");
    await expect(secretsLine).toHaveAttribute("data-level", "blocks");
    await expect(secretsLine).toContainText(STANDBY_WORDS.secretsNone(mini.name));
    await regionShot(ready, test.info().outputPath("standby-secrets-before-keep.png"));
    await pressKey(
      secretsLine.getByRole("button", { name: m.settingsDevicesStandbyKeepSecrets() }),
      "Enter",
    );
    await expect(secretsLine).toHaveAttribute("data-level", "notes", { timeout: 30_000 });
    await expect(secretsLine).toHaveText(STANDBY_WORDS.secretsKept(mini.name));
    expect(mini.confirmations()).toBe(1);
    // Keeping them is a change the copy then takes, after which the list reads it in sync.
    await expect(ready.locator('[data-gap="copy"]')).toHaveText(STANDBY_WORDS.inSync(mini.name), {
      timeout: 30_000,
    });
    await home.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await regionShot(ready, test.info().outputPath("standby-secrets-kept.png"));
    if (test.info().repeatEachIndex === 0 && process.env.INFINITARY_TASK_EVIDENCE_DIR)
      await heroShot(home.app, home.page, {
        region: ready,
        anchors: [await rowOf(mini)],
        name: "standby-secrets",
      });
  });

  await test.step("only Mac mini's copy can open the Secrets; Mac Studio was never asked and holds no lock", async () => {
    await expect
      .poll(() => readSealedSecrets(copyOf(mini))?.keys.map((each) => each.device), {
        timeout: 30_000,
      })
      .toEqual([mini.deviceId]);
    expect(studio.confirmations()).toBe(0);
    expect(studio.lock.slots.size).toBe(0);
    expect(mini.lock.slots.has("root")).toBe(true);
  });

  await test.step("a changed secret reaches Mac mini's copy like any other change", async () => {
    const before = readSealedSecrets(copyOf(mini))?.made;
    await keepSecret(home, CHANGED);
    await expect
      .poll(() => readSealedSecrets(copyOf(mini))?.made, { timeout: 30_000 })
      .not.toBe(before);
  });

  // The takeover itself: the home stops, and a first mate starts on Mac mini
  // from its copy, with Mac mini's own lock and a Secrets custody of its own.
  for (const run of runs.splice(0)) await run.stop();
  await home.close();
  apps.splice(apps.indexOf(home), 1);
  const takenOver = scratchDir("infinitary-standby-secrets-new-home-");
  cpSync(copyOf(mini), takenOver, { recursive: true });
  const miniLock = mini.lock.slots.get("root");
  if (!miniLock) throw new Error("Mac mini kept no lock.");
  const newHome = await launchSecrets({ userDataDir: takenOver, standbyLock: miniLock, env });
  apps.push(newHome);

  await test.step("the first mate started from the copy runs an approved use with the changed value", async () => {
    const { app, page } = newHome;
    await app.evaluate(async (_electron, ref) => {
      const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
      fixture.readProbe = { deliveries: 0, credentialMatched: true };
      fixture.core.services.secrets.registerBroker(
        fixture.httpBroker({
          id: "calendar-after-takeover",
          label: "Planning calendar",
          resolve: () => ({
            url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            method: "GET",
            credentials: {
              access: {
                ref,
                delivery: { kind: "header", name: "authorization", prefix: "Bearer " },
              },
            },
            operation: "Read planning meetings",
            read: true,
            result: "Calendar response to the trusted owner only",
          }),
          send: async (_url, options) => {
            const probe = fixture.readProbe;
            if (!probe) throw new Error("No calendar proof was prepared.");
            probe.deliveries += 1;
            probe.credentialMatched &&=
              new Headers(options?.headers).get("authorization") ===
              "Bearer ya29.invented-standby-calendar-changed";
            return new Response(JSON.stringify({ items: [] }));
          },
        }),
      );
    }, SECRET.ref);
    // The values came over, and no saved decision with them.
    await expect
      .poll(() =>
        app.evaluate(async () => {
          const view = await (
            globalThis as SecretsJourneyGlobal
          ).secretsJourney.core.services.secrets.view();
          return { refs: view.entries.map((entry) => entry.ref), rules: view.rules.length };
        }),
      )
      .toEqual({ refs: [SECRET.ref], rules: 0 });
    const receipt = await app.evaluate(async () =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.broker(
        {
          id: "after-takeover",
          reason: "Read the next planning meeting",
          broker: "calendar-after-takeover",
          input: { calendar: "primary" },
        },
        "",
      ),
    );
    expect(receipt.state).toBe("waiting");
    const section = settingsSection(page, "secrets");
    await runFromSearch(app, page, "settings.secrets");
    await pressKey(
      section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true }),
      "Enter",
    );
    const title = SECRET_APPROVAL_CARD_WORDS.title(
      secretsNamed([secretName([SECRET], SECRET.ref)]),
      null,
    );
    const card = shownCard(page, title);
    await expect(cardBody(page, title).locator("body")).toBeVisible();
    await runFromSearch(app, page, "focus.card-actions");
    await pressKey(card.getByRole("button", { name: SECRETS_WORDS.once, exact: true }), "Enter");
    await expect
      .poll(() =>
        app.evaluate(async (_electron, request) => {
          const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
          const view = await fixture.core.services.secrets.view();
          return view.uses.find((use) => use.request === request)?.state;
        }, receipt.request),
      )
      .toBe("completed");
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.readProbe),
    ).toEqual({ deliveries: 1, credentialMatched: true });
  });
});
