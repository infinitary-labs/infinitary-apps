import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { decode } from "@toon-format/toon";
import { hostEnv } from "../../src/core/hostEnv";
import { approvalCode } from "../../src/core/secrets/approvals";
import { SECRETS_COMMAND, type UseReceipt } from "../../src/core/secrets/requests";
import { newReference } from "../../src/core/secrets/settings";
import {
  SECRET_DEVICE_WORDS,
  SECRET_STATE_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  secretRefSchema,
} from "../../src/shared/secrets";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { overflows, resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { readSavedData } from "./savedData";
import { savedText } from "./savedText";
import {
  PROTECTED_USE_DONE,
  PROTECTED_USE_PROMPT,
  PROTECTED_USE_REPORT,
  PROTECTED_USE_TITLE,
  protectedSecretUse,
} from "./scenarios/protectedSecretUse";
import {
  launchSecrets,
  type SecretsJourneyGlobal,
  secretReference,
  secretsArea,
} from "./secretsHarness";
import { settingsSection } from "./settings";
import { shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";
import { commandSearch, focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

const LABEL = "Staging deployment";
const REFERENCE = "staging-deploy";
const TOKEN = "invented-staging-proof-token";

// Intent: INF-1109's Settings secure entry and trusted exact-use approval, and
// the captain's keyboard ruling. Real renderer, IPC, AXI, sealed files and
// recipient process; only platform custody and human confirmation stand in.
// Completion: the recipient runs once, its output never reaches AXI, and the
// saved card contains metadata rather than the value. Prerequisites: Electron,
// the built renderer and /bin/sh. No shared account, native store or network.
test("secure entry and an exact command meet at the app's trusted approval", async () => {
  const cwd = realpathSync(scratchDir("secrets-journey-recipient-"));
  const marker = join(cwd, "executions");
  writeFileSync(
    join(cwd, "check.sh"),
    '#!/bin/sh\nprintf "ran\\n" >> "$PWD/executions"\nprintf "%s" "$SERVICE_TOKEN"\n',
  );
  const launched = await launchSecrets();
  const { app, page, userDataDir } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await runFromSearch(app, page, "settings.secrets");
    const add = section.getByRole("button", { name: SECRETS_WORDS.add, exact: true });
    await focusOn(add);
    await pressKey(add, "Enter");
    const name = section.getByLabel(SECRETS_WORDS.name, { exact: true });
    await expect(name).toBeFocused();
    await name.fill(LABEL);
    await pressKey(name, "Tab");
    const value = section.getByLabel(SECRETS_WORDS.value, { exact: true });
    await expect(value).toBeFocused();
    await expect(value).toHaveAttribute("type", "password");
    await value.fill(TOKEN);
    // The captain's simpler entry flow: name then value; a custom reference is optional detail.
    const reference = await secretReference(page);
    // Saving now allocates a readable reference; an explicit override remains optional.
    await expect(reference).toHaveValue("");
    await reference.fill(REFERENCE);
    const save = section.getByRole("button", { name: SECRETS_WORDS.save, exact: true });
    await pressKey(save, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    await expect(value).toHaveCount(0);
    await expect(add).toBeFocused();

    // Grant only the closed facade, just as the local task channel does.
    // A task name is not authority; listing names does not approve a use.
    const shell = await app.evaluate(() => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
      return services.taskCommands.grant("secrets-ui-proof", {
        secrets: services.secrets.commandFor({ task: "" }),
      });
    });
    const [bin] = shell.path;
    if (!bin) throw new Error("The task channel supplied no command folder.");
    const run = async (args: string[]) => {
      const result = await promisify(execFile)(join(bin, SECRETS_COMMAND), args, {
        cwd,
        env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(delimiter) },
        encoding: "utf8",
      });
      expect(result.stdout).not.toContain(TOKEN);
      expect(result.stderr).not.toContain(TOKEN);
      return (decode(result.stdout) as { receipt: UseReceipt }).receipt;
    };
    const args = [
      "inject",
      "--env",
      JSON.stringify({ SERVICE_TOKEN: REFERENCE }),
      "--reason",
      "Check the staging deployment",
      "--id",
      "staging-proof",
      "--",
      "/bin/sh",
      "check.sh",
    ];
    const requested = await run(args);
    expect(requested.state).toBe("waiting");
    await pressKey(
      section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true }),
      "Enter",
    );
    const card = shownCard(page, SECRETS_WORDS.approvalTitle);
    await expect(card).toBeVisible();
    const body = cardBody(page, SECRETS_WORDS.approvalTitle);
    await expect(body.locator("body")).toContainText(LABEL);
    await expect(body.locator("body")).not.toContainText(TOKEN);

    await app.evaluate(() => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = false;
    });
    await pressKey(card.getByRole("button", { name: SECRETS_WORDS.once, exact: true }), "Enter");
    await expect(cardBody(page, SECRETS_WORDS.approvalTitle).getByRole("status")).toBeVisible();
    expect((await run(["status", requested.request])).state).toBe("waiting");
    await app.evaluate(() => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
    });
    await pressKey(card.getByRole("button", { name: SECRETS_WORDS.once, exact: true }), "Enter");
    await expect
      .poll(async () => (await run(["status", requested.request])).state)
      .toBe("completed");
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    expect((await run(args)).state).toBe("completed");
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(2);
    // INF-3042: the boundary is every saved file, not only the sealed values folder.
    const saved = savedText(userDataDir);
    expect(
      saved.filter(({ file }) => file.startsWith(join(userDataDir, "secrets", "values"))),
    ).toHaveLength(1);
    for (const { file, text } of saved) {
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(Buffer.from(TOKEN).toString("base64"));
    }
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "history");
    const history = section.getByRole("region", { name: SECRETS_WORDS.historyRegion });
    await expect(history).toContainText(SECRET_STATE_WORDS.completed);
    await expect(history).not.toContainText(TOKEN);
  } finally {
    await launched.close();
  }
});

// INF-1109's bounded reads and End access, through the real Settings controls.
// Fixture: an invented calendar credential and a broker whose transport records
// delivery instead of reaching Google. Native custody and confirmation stand in.
// Completion: the keyboard-approved permission serves the next exact read, then
// End access makes another read wait without sending. Electron only; no account,
// native store, signing resource or external network is used.
test("ending bounded access makes the next exact read ask again", async () => {
  const testInfo = test.info();
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await app.evaluate(async () => {
      const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
      const token = "ya29.invented-calendar-read-proof";
      fixture.readProbe = { deliveries: 0, credentialMatched: true };
      fixture.core.services.secrets.registerBroker(
        fixture.httpBroker({
          id: "calendar-read-proof",
          label: "Planning calendar",
          resolve: () => ({
            url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            method: "GET",
            credentials: {
              access: {
                ref: "planning-calendar",
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
              new Headers(options?.headers).get("authorization") === `Bearer ${token}`;
            return new Response(
              JSON.stringify({ items: [{ id: "planning", summary: "Planning meeting" }] }),
            );
          },
        }),
      );
      await fixture.core.services.secrets.put({
        ref: "planning-calendar",
        label: "Planning calendar",
        value: token,
        expectedVersion: 0,
        expectedRevision: null,
        environment: "Personal",
      });
    });
    const request = (id: string) =>
      app.evaluate(
        async (_electron, id) =>
          (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.broker(
            {
              id,
              reason: "Read the next planning meeting",
              broker: "calendar-read-proof",
              input: { calendar: "primary" },
            },
            "",
          ),
        id,
      );
    const completed = (request: string) =>
      expect
        .poll(() =>
          app.evaluate(async (_electron, request) => {
            const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
            const view = await fixture.core.services.secrets.view();
            return {
              state: view.uses.find((use) => use.request === request)?.state,
              confirmations: fixture.confirmations,
              message: view.message,
            };
          }, request),
        )
        .toMatchObject({ state: "completed" });
    const first = await request("first-calendar-read");
    expect(first.state).toBe("waiting");
    await runFromSearch(app, page, "settings.secrets");
    await pressKey(
      section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true }),
      "Enter",
    );
    const card = shownCard(page, SECRETS_WORDS.approvalTitle);
    // This is a lone card, not a stack with a warmed successor. Read its
    // drawn frame, then enter chrome through its own keyboard command.
    await expect(cardBody(page, SECRETS_WORDS.approvalTitle).locator("body")).toBeVisible();
    await runFromSearch(app, page, "focus.card-actions");
    await pressKey(card.getByRole("button", { name: SECRETS_WORDS.short, exact: true }), "Enter");
    await completed(first.request);
    await completed((await request("second-calendar-read")).request);
    await runFromSearch(app, page, "settings.secrets");
    const end = section.getByRole("button", { name: SECRETS_WORDS.end, exact: true });
    await expect(end).toBeVisible();
    await regionShot(section, testInfo.outputPath("bounded-read-active.png"));
    await pressKey(end, "Enter");
    await expect(end).toHaveCount(0);
    await regionShot(section, testInfo.outputPath("bounded-read-ended.png"));
    expect((await request("after-ending-access")).state).toBe("waiting");
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.readProbe),
    ).toEqual({ deliveries: 2, credentialMatched: true });
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(1);
  } finally {
    await launched.close();
  }
});

// INF-1109 recovery and the keyboard ruling: one disposable saved entry and a
// pending real command become a private backup, then a new protected home.
// Completion: keys activate both controls, refused confirmation keeps the home,
// accepted restore changes it, and imported history is labeled, never replayed.
// Prerequisites: built Electron renderer and /bin/sh. Native custody, file choices
// and confirmation stand in; no personal files, accounts, native store or network.
test("recovery controls keep files private and restore without replaying history", async () => {
  const cwd = realpathSync(scratchDir("secrets-recovery-journey-"));
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await runFromSearch(app, page, "settings.secrets");
    await pressKey(section.getByRole("button", { name: SECRETS_WORDS.add, exact: true }), "Enter");
    await section.getByLabel(SECRETS_WORDS.name, { exact: true }).fill(LABEL);
    await (await secretReference(page)).fill(REFERENCE);
    await section.getByLabel(SECRETS_WORDS.value, { exact: true }).fill(TOKEN);
    await pressKey(section.getByRole("button", { name: SECRETS_WORDS.save, exact: true }), "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    const original = await app.evaluate(
      async (_electron, { cwd, ref }) => {
        const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
        const settings = fixture.core.services.secrets;
        const receipt = await settings.commandFor({ task: "" }).inject({
          id: "pending-before-recovery",
          reason: "Check the staging deployment",
          argv: ["/bin/sh", "-c", "exit 0"],
          cwd,
          env: { SERVICE_TOKEN: ref },
        });
        return { home: (await settings.view()).home, request: receipt.request };
      },
      { cwd, ref: REFERENCE },
    );
    const area = await secretsArea(page, "recovery");
    const recovery = section.getByRole("region", {
      name: SECRETS_RECOVERY_WORDS.region,
      exact: true,
    });
    const backup = recovery.getByRole("button", {
      name: SECRETS_RECOVERY_WORDS.saveButton,
      exact: true,
    });
    const restore = recovery.getByRole("button", {
      name: SECRETS_RECOVERY_WORDS.restoreButton,
      exact: true,
    });
    await pressKey(area, "Tab");
    await expect(backup).toBeFocused();
    await pressKey(backup, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_RECOVERY_WORDS.save.saved);
    await pressKey(backup, "Tab");
    await expect(restore).toBeFocused();
    await app.evaluate(() => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = false;
    });
    await pressKey(restore, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_RECOVERY_WORDS.restore.refused);
    expect(
      await app.evaluate(async () =>
        (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
          .view()
          .then((view) => view.home),
      ),
    ).toBe(original.home);
    await app.evaluate(() => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
    });
    await pressKey(restore, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_RECOVERY_WORDS.restore.restored);
    const current = await app.evaluate(async () =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.view(),
    );
    expect(current.home).not.toBe(original.home);
    expect(current.rules).toEqual([]);
    expect(current.uses.find((use) => use.request === original.request)?.state).toBe("invalidated");
    expect(JSON.stringify(current)).not.toContain(TOKEN);
    await secretsArea(page, "history");
    await expect(section.getByRole("region", { name: SECRETS_WORDS.historyRegion })).toContainText(
      SECRETS_RECOVERY_WORDS.recoveredHistory,
    );
  } finally {
    await launched.close();
  }
});

// Intent: INF-1109's device enrollment, built by INF-1202. A phone's offered
// approval key reaches this computer as a card whose code the captain compares,
// only that card's confirmation here enrolls it, and Settings lists it with Stop
// approvals, which asks once more. The phone's own offer comes through the
// controller's enrollment hook with a real P-256 key, as `inf:secrets:enroll`
// delivers it; the phone's screens are the phone check's (PhoneJourney's
// testSecretsApprovals). Completion: the device list empties. Prerequisites:
// Electron and the built renderer. No phone, native store or network.
test("a phone's approval key is enrolled and stopped only on this computer", async () => {
  const PHONE = { device: "8F3C2A1E-5B7D-4C9A-9E21-0D4B6F8A7C35", label: "Kun’s iPhone" };
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await app.evaluate(
      async (_electron, offer) => {
        const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
        await services.secrets.put({
          ref: "calendar",
          label: "Planning calendar",
          value: "invented-planning-calendar-token",
          expectedVersion: 0,
          expectedRevision: null,
          environment: "Personal",
        });
        await services.secrets.enroll(offer);
      },
      { ...PHONE, key },
    );
    const enrollment = shownCard(page, SECRET_DEVICE_WORDS.enrollTitle(PHONE.label));
    await expect(enrollment).toBeVisible();
    await expect(
      cardBody(page, SECRET_DEVICE_WORDS.enrollTitle(PHONE.label)).locator("code"),
    ).toHaveText(approvalCode(key));
    await pressKey(
      enrollment.getByRole("button", { name: SECRET_DEVICE_WORDS.confirm, exact: true }),
      "Enter",
    );
    await expect(enrollment).toHaveCount(0);

    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "rules");
    const devices = section.getByRole("region", { name: SECRETS_WORDS.devicesRegion });
    await expect(devices.getByText(PHONE.label, { exact: true })).toBeVisible();
    await expect(devices.getByText(`Code ${approvalCode(key)}`, { exact: true })).toBeVisible();
    const stop = devices.getByRole("button", { name: SECRETS_WORDS.stopApprovals, exact: true });
    await focusOn(stop);
    await pressKey(stop, "Enter");
    const stopping = shownCard(page, SECRET_DEVICE_WORDS.stopTitle(PHONE.label));
    await expect(stopping).toBeVisible();
    await pressKey(
      stopping.getByRole("button", { name: SECRETS_WORDS.stopApprovals, exact: true }),
      "Enter",
    );
    await expect(stopping).toHaveCount(0);
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "rules");
    await expect(section.getByRole("region", { name: SECRETS_WORDS.devicesRegion })).toContainText(
      SECRETS_WORDS.noDevices,
    );
    // The enrollment and the stop each asked for this computer's own confirmation once.
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(2);
  } finally {
    await launched.close();
  }
});

// INF-1109's actual task path: the first mate starts the crewmate, its supervisor
// grants the command, and a terminal use resumes that same task through the inbox.
// Completion: one checked recipient run and a saved report, with no value in the
// model traffic. Data: a disposable credential and shell recipient. Prerequisites:
// built Electron and /bin/sh; model, native custody and confirmation stand in.
// No shared credentials, accounts, native stores or external requests are used.
test("a dispatched crewmate requests once and resumes after the protected use", async () => {
  const cwd = realpathSync(scratchDir("secrets-dispatched-recipient-"));
  const marker = join(cwd, "executions");
  writeFileSync(
    join(cwd, "check.sh"),
    `#!/bin/sh
[ "$SERVICE_TOKEN" = '${TOKEN}' ] || exit 1
printf 'ran\n' >> "$PWD/executions"
printf '%s' "$SERVICE_TOKEN"
`,
  );
  const launched = await launchSecrets({ scenarios: [protectedSecretUse(cwd, REFERENCE)] });
  const { app, page, userDataDir } = launched;
  try {
    // Trusted fixture entry only; the supervisor, task shell, approval and wake stay real.
    await app.evaluate(
      async (_electron, input) => {
        await (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.put(input);
      },
      {
        ref: REFERENCE,
        label: LABEL,
        value: TOKEN,
        expectedVersion: 0,
        expectedRevision: null,
        environment: "Disposable",
      },
    );
    await askFirstmate(page, PROTECTED_USE_PROMPT);
    const approval = shownCard(page, SECRETS_WORDS.approvalTitle);
    await expect(approval).toBeVisible();
    await expect(cardBody(page, SECRETS_WORDS.approvalTitle).locator("body")).toContainText(LABEL);
    await pressKey(
      approval.getByRole("button", { name: SECRETS_WORDS.once, exact: true }),
      "Enter",
    );
    await expect(shownCard(page, PROTECTED_USE_DONE)).toBeVisible();
    await expect
      .poll(() =>
        readSavedData(
          userDataDir,
          (db) =>
            (
              db.prepare("SELECT outcome FROM tasks WHERE title = ?").get(PROTECTED_USE_TITLE) as
                | { outcome: string | null }
                | undefined
            )?.outcome,
        ),
      )
      .toBe(PROTECTED_USE_REPORT);
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    const traffic = (launched.mockProvider?.requestBodies() ?? []).join("\n");
    expect(traffic).not.toContain(TOKEN);
    expect(traffic).not.toContain(Buffer.from(TOKEN).toString("base64"));
    for (const { file, text } of savedText(userDataDir)) {
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(Buffer.from(TOKEN).toString("base64"));
    }
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(1);
  } finally {
    await launched.close();
  }
});

// Captain's INF-1109 UX request: everyday entry needs only a name and value;
// references remain stable through replacement, and Cancel never saves a value.
// The actual renderer, IPC and sealed owner run in launchSecrets' disposable
// home; custody/confirmation stand in. No native store, account or network.
test("simple entry generates a stable reference and returns keyboard focus", async () => {
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await runFromSearch(app, page, "settings.secrets");
    const add = section.getByRole("button", { name: SECRETS_WORDS.add, exact: true });
    await pressKey(add, "Enter");
    const name = section.getByLabel(SECRETS_WORDS.name, { exact: true });
    const value = section.getByLabel(SECRETS_WORDS.value, { exact: true });
    const reference = section.getByLabel(SECRETS_WORDS.reference, { exact: true });
    await expect(name).toBeFocused();
    await expect(reference).not.toBeVisible();
    await name.fill("   ");
    await pressKey(name, "Tab");
    await expect(value).toBeFocused();
    await value.fill(TOKEN);
    const save = section.getByRole("button", { name: SECRETS_WORDS.save, exact: true });
    await pressKey(save, "Enter");
    await expect(section.getByText(SECRETS_WORDS.nameRequired, { exact: true })).toBeVisible();
    await expect(name).toBeFocused();
    await expect(reference).not.toBeVisible();
    await name.fill(LABEL);
    await pressKey(save, "Enter");
    await expect(add).toBeFocused();
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    const saved = await app.evaluate(async () =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
        .view()
        .then((view) => view.entries),
    );
    expect(saved).toHaveLength(1);
    const entry = saved[0];
    if (!entry) throw new Error("The saved secret is missing.");
    expect(secretRefSchema.safeParse(entry.ref).success).toBe(true);
    // The controller owns readable reference allocation; the form must not send a random one.
    expect(entry.ref).toBe(newReference(LABEL, []));
    expect(entry.label).toBe(LABEL);

    // Editing a row hidden by the search after saving still returns focus to Add.
    const search = section.getByLabel(SECRETS_WORDS.search, { exact: true });
    await search.fill(LABEL);
    const row = section.getByRole("group").filter({ hasText: LABEL });
    await pressKey(row.locator("summary"), "Enter");
    await pressKey(row.getByRole("button", { name: SECRETS_WORDS.replace, exact: true }), "Enter");
    const renamed = "Website preview deployment";
    await name.fill(renamed);
    await value.fill("invented-replacement-proof-token");
    await pressKey(save, "Enter");
    await expect(add).toBeFocused();
    const replaced = await app.evaluate(async () =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
        .view()
        .then((view) => view.entries),
    );
    expect(replaced).toMatchObject([
      { ref: entry.ref, label: renamed, version: entry.version + 1 },
    ]);
    await search.fill("");
    await pressKey(add, "Enter");
    await name.fill("Discarded credential");
    await value.fill("invented-cancelled-proof-token");
    // e2e-typed-words: Cancel is the native entry form's cancellation control.
    await pressKey(section.getByRole("button", { name: "Cancel", exact: true }), "Enter");
    await expect(add).toBeFocused();
    const afterCancel = await app.evaluate(async () =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
        .view()
        .then((view) => view.entries),
    );
    expect(afterCancel).toEqual(replaced);
  } finally {
    await launched.close();
  }
});

// Captain's INF-1109 UX request: every actual requested identity is readable,
// including duplicate and long names at the desktop's minimum width. The
// genuine sealed owner prepares a real executable; Deny must send no values.
// Custody/confirmation stand in; there is no account, network or native store.
for (const theme of ["dark", "light"] as const) {
  test(`named secret requests fit the narrow approval in ${theme}`, async () => {
    const launched = await launchSecrets();
    const { app, page } = launched;
    const entries = [
      { ref: "website-production", label: "Website deployment", environment: "Production" },
      { ref: "website-production-mirror", label: "Website deployment", environment: "Production" },
      { ref: "website-staging", label: "Website deployment", environment: "Staging" },
      {
        ref: "billing-read",
        label:
          "Customer billing and subscription reporting access for the production support and financial reconciliation dashboards",
        environment: "Production",
      },
    ];
    try {
      await resizeWindow(app, page, { width: 960, height: 900 });
      await setThemeViaSettings(page, theme);
      const receipt = await app.evaluate(async (_electron, entries) => {
        const s = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets;
        for (const entry of entries)
          await s.put({
            ...entry,
            value: "invented-layout-proof-token",
            expectedVersion: 0,
            expectedRevision: null,
          });
        return s.commandFor({ task: "" }).inject({
          id: "named-layout-proof",
          reason: "Compare the website deployment credentials and billing access",
          env: {
            PRODUCTION_TOKEN: "website-production",
            MIRROR_TOKEN: "website-production-mirror",
            STAGING_TOKEN: "website-staging",
            BILLING_TOKEN: "billing-read",
          },
          argv: ["/usr/bin/true"],
          cwd: "/",
        });
      }, entries);
      expect(receipt.state).toBe("waiting");
      await runFromSearch(app, page, "settings.secrets");
      const section = settingsSection(page, "secrets");
      // Equal names and environments also show their stable reference in the catalog.
      for (const ref of ["website-production", "website-production-mirror"])
        await expect(section.locator("summary").getByText(ref, { exact: true })).toBeVisible();
      await pressKey(
        section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true }),
        "Enter",
      );
      const body = cardBody(page, SECRETS_WORDS.approvalTitle);
      // e2e-typed-words: this region names the exact identities the captain is approving.
      const requested = body.getByRole("region", { name: "Secrets requested", exact: true });
      await expect(requested).toBeVisible();
      for (const entry of entries) {
        const row = requested.locator(`[data-secret-ref=${JSON.stringify(entry.ref)}]`);
        await expect(row.getByText(entry.label, { exact: true })).toBeInViewport();
        await expect(row.getByText(entry.ref, { exact: true })).toBeInViewport();
        await expect(row.getByText(entry.environment, { exact: true })).toBeInViewport();
      }
      expect(await overflows(requested)).toBe(0);
      expect(await overflows(body.locator("body"))).toBe(0);
      const card = shownCard(page, SECRETS_WORDS.approvalTitle);
      await regionShot(card, test.info().outputPath(`named-approval-${theme}.png`));
      await runFromSearch(app, page, "focus.card-actions");
      await pressKey(card.getByRole("button", { name: SECRETS_WORDS.deny, exact: true }), "Enter");
      await expect
        .poll(() =>
          app.evaluate(async (_electron, request) => {
            const f = (globalThis as SecretsJourneyGlobal).secretsJourney;
            return {
              receipt: await f.core.services.secrets.commandFor({ task: "" }).status(request),
              confirmations: f.confirmations,
            };
          }, receipt.request),
        )
        .toMatchObject({ receipt: { state: "denied" }, confirmations: 0 });
      await runFromSearch(app, page, "settings.secrets");
      await secretsArea(page, "rules");
      await pressKey(
        section.getByRole("button", { name: SECRETS_WORDS.addRule, exact: true }),
        "Enter",
      );
      const secretChoice = section.getByRole("combobox", {
        name: SECRETS_WORDS.ruleSecret,
        exact: true,
      });
      await expect(secretChoice).toBeVisible();
      const options = await secretChoice
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ ref: node.getAttribute("value"), label: node.textContent })),
        );
      for (const entry of entries) {
        const label = options.find((option) => option.ref === entry.ref)?.label;
        expect(label).toContain(entry.label);
        expect(label).toContain(entry.ref);
        expect(label).toContain(entry.environment);
      }
      await secretChoice.selectOption("website-production-mirror");
      await expect(secretChoice).toHaveValue("website-production-mirror");
    } finally {
      await launched.close();
    }
  });
}

// INF-1690's accepted answer: "No tab at all until storage is enabled; nothing a
// person can open and not use." The shipped composition, with no protected
// storage, through the real Settings tabs and command search. Completion: the
// gated Devices tab shows, and Open Integrations is listed where Open Secrets
// would be. Prerequisites: Electron and the built renderer.
test("a build without protected storage offers no Secrets tab or command", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  try {
    expect(await page.evaluate(() => window.infinitary.secrets.shown())).toEqual({ shown: false });
    await runFromSearch(app, page, "settings.open");
    const tabs = page.getByRole("tablist", { name: "Settings sections" });
    // Devices is gated by an answer from the core too; once it shows, Secrets' has come back.
    await expect(tabs.getByRole("tab", { name: "Devices", exact: true })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: SECRETS_WORDS.title, exact: true })).toHaveCount(0);
    await expect(settingsSection(page, "secrets")).toHaveCount(0);
    const search = commandSearch(page);
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("open");
    await expect(search.row("settings.integrations")).toBeVisible();
    await expect(search.row("settings.secrets")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

// INF-3042: enabled actions carry no disabled reason; actual refused actions
// retain their explanation. Disposable custody; no confirmation or recipient action.
test("Secrets controls explain only their current refusal", async () => {
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  const ready = async (button: import("@playwright/test").Locator) => {
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await expect(button).not.toHaveAttribute("aria-description", /.+/);
  };
  try {
    // Hold an actual home answer so command focus is checked while the view
    // is loading, then release the same answer into the empty section.
    await app.evaluate(() => {
      const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
      const settings = fixture.core.services.secrets;
      const read = settings.view.bind(settings);
      const pending = new Promise<void>((resolve) => {
        fixture.finishViewRead = () => {
          settings.view = read;
          resolve();
        };
      });
      settings.view = async () => {
        await pending;
        return read();
      };
    });
    await runFromSearch(app, page, "settings.secrets");
    await expect(
      section.getByRole("heading", { name: SECRETS_WORDS.title, exact: true }),
    ).toBeFocused();
    // e2e-typed-words: this is the pending-view copy rendered by SecretsTab.
    await expect(section.getByRole("status")).toHaveText("Reading Secrets…");
    await app.evaluate(() =>
      (globalThis as SecretsJourneyGlobal).secretsJourney.finishViewRead?.(),
    );
    await expect(
      section.getByRole("button", { name: SECRETS_WORDS.add, exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("heading", { name: SECRETS_WORDS.title, exact: true }),
    ).toBeFocused();
    await secretsArea(page, "rules");
    const addRule = section.getByRole("button", { name: SECRETS_WORDS.addRule, exact: true });
    await expect(addRule).toHaveAttribute("aria-disabled", "true");
    await expect(addRule).toHaveAttribute("aria-description", /.+/);
    await pressKey(section.getByRole("button", { name: SECRETS_WORDS.add, exact: true }), "Enter");
    await ready(section.getByRole("button", { name: "Cancel", exact: true }));
    await section.getByLabel(SECRETS_WORDS.name, { exact: true }).fill(LABEL);
    await section.getByLabel(SECRETS_WORDS.value, { exact: true }).fill(TOKEN);
    await pressKey(section.getByRole("button", { name: SECRETS_WORDS.save, exact: true }), "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    await runFromSearch(app, page, "settings.secrets");
    await expect(
      section.getByRole("heading", { name: SECRETS_WORDS.title, exact: true }),
    ).toBeFocused();
    await ready(addRule);
    // e2e-typed-words: the button's current explanation is the regression boundary.
    await ready(section.getByRole("button", { name: "Review rule changes", exact: true }));
    await pressKey(section.locator("summary").filter({ hasText: LABEL }), "Enter");
    // e2e-typed-words: the button's current explanation is the regression boundary.
    await ready(section.getByRole("button", { name: "Forget locally", exact: true }));
    await secretsArea(page, "recovery");
    await ready(
      section.getByRole("button", { name: SECRETS_RECOVERY_WORDS.saveButton, exact: true }),
    );
    await ready(
      section.getByRole("button", { name: SECRETS_RECOVERY_WORDS.restoreButton, exact: true }),
    );
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(0);
  } finally {
    try {
      await app.evaluate(() =>
        (globalThis as SecretsJourneyGlobal).secretsJourney.finishViewRead?.(),
      );
    } finally {
      await launched.close();
    }
  }
});
