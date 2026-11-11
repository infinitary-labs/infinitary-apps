import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { claimLink } from "@core/devices/dial";
import { expect, test } from "@playwright/test";
import { decode } from "@toon-format/toon";
import { hostEnv } from "../../src/core/hostEnv";
import { runWords } from "../../src/core/secrets/approvalCard";
import { approvalCode } from "../../src/core/secrets/approvals";
import { SECRETS_CHECK_WORDS } from "../../src/core/secrets/commandWords";
import { SECRETS_COMMAND, type UseCheck, type UseReceipt } from "../../src/core/secrets/requests";
import { newReference } from "../../src/core/secrets/settings";
import { secretName } from "../../src/shared/secretNames";
import {
  decisionWords,
  SAVED_DECISION_WORDS,
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_CHECKED_WORDS,
  SECRET_DEVICE_WORDS,
  SECRET_STATE_WORDS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  secretRefSchema,
  secretsListed,
  secretsNamed,
} from "../../src/shared/secrets";
import { connectClient } from "../helpers/connectionClient";
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
import { launchSecrets, type SecretsJourneyGlobal, secretsArea } from "./secretsHarness";
import { settingsSection } from "./settings";
import { shownCard } from "./stack";
import { setThemeViaSettings } from "./theme";
import { commandSearch, focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * A link for a Mac used from this Mac itself, as the stand-in phone pairs: it
 * joins as a view that only controls, and says it is a phone when it connects.
 */
const PAIRED_FROM_HERE = {
  kind: "mac",
  window: true,
  user: { name: userInfo().username, uid: process.getuid?.() ?? userInfo().uid },
} as const;
const LABEL = "Staging deployment";
const REFERENCE = "staging-deploy";
/** The reference the controller makes from LABEL when Settings adds it; the page asks for none. */
const ENTERED = newReference(LABEL, []);
const TOKEN = "invented-staging-proof-token";
const REASON = "Check the staging deployment";
/**
 * The approval card's title, from its owners: the requested secrets named among
 * every saved one as Settings names them, and the task that asked.
 */
const approvalTitle = (
  saved: readonly { ref: string; label: string; environment?: string }[],
  task: string | null = null,
) =>
  SECRET_APPROVAL_CARD_WORDS.title(
    secretsNamed(
      saved.map((one) =>
        secretName(
          saved.map((entry) => ({ ...entry, environment: entry.environment ?? "" })),
          one.ref,
        ),
      ),
    ),
    task,
  );

// Intent: INF-1109's Settings secure entry and trusted exact-use approval, and
// the captain's keyboard ruling. Real renderer, IPC, AXI, sealed files and
// recipient process; only platform custody and human confirmation stand in.
// Completion: the recipient runs once, its output never reaches AXI, and the
// saved card contains metadata rather than the value, and the secret's row names
// the task that used it (INF-1690 piece 1). The crew's check names a failed
// check before any card, and the card lists what was checked (piece 3).
// Prerequisites: Electron,
// the built renderer and /bin/sh. No shared account, native store or network.
const USING_TASK = { id: "secrets-ui-proof-task", title: "Check the staging deployment" };
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
    // The captain's simpler entry flow: name then value; saving makes the reference.
    const save = section.getByRole("button", { name: SECRETS_WORDS.save, exact: true });
    await pressKey(save, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    await expect(value).toHaveCount(0);
    await expect(add).toBeFocused();

    // Grant only the closed facade, just as the local task channel does.
    // A task name is not authority; listing names does not approve a use.
    const shell = await app.evaluate((_electron, task) => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
      services.tasks.create({ ...task, prompt: task.title, repoId: null });
      return services.taskCommands.grant("secrets-ui-proof", {
        secrets: services.secrets.commandFor({ task: task.id }),
      });
    }, USING_TASK);
    const [bin] = shell.path;
    if (!bin) throw new Error("The task channel supplied no command folder.");
    const axi = async (args: string[]) => {
      const result = await promisify(execFile)(join(bin, SECRETS_COMMAND), args, {
        cwd,
        env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(delimiter) },
        encoding: "utf8",
      });
      expect(result.stdout).not.toContain(TOKEN);
      expect(result.stderr).not.toContain(TOKEN);
      return decode(result.stdout) as { receipt: UseReceipt; check: UseCheck; help?: string };
    };
    const run = async (args: string[]) => (await axi(args)).receipt;
    // INF-1690's plan, piece 3: the crew checks the exact run before asking.
    // A run that fails a check is named, and asking for it raises no card.
    const mapping = JSON.stringify({ SERVICE_TOKEN: ENTERED });
    expect(await axi(["check", "--env", mapping, "--", "./missing.sh"])).toEqual({
      check: { problem: "program" },
      help: SECRETS_CHECK_WORDS.problem.program,
    });
    const refused = await axi([
      "inject",
      "--env",
      mapping,
      "--reason",
      REASON,
      "--id",
      "missing-proof",
      "--",
      "./missing.sh",
    ]);
    expect(refused).toMatchObject({
      receipt: { state: "unavailable" },
      help: SECRETS_CHECK_WORDS.refused,
    });
    // The check names the program by its real path: on Linux /bin/sh is a link to dash.
    const shPath = realpathSync("/bin/sh");
    expect(await axi(["check", "--env", mapping, "--", "/bin/sh", "check.sh"])).toEqual({
      check: { decision: "ask", program: shPath, files: [join(cwd, "check.sh")], folder: cwd },
      help: SECRETS_CHECK_WORDS.decision.ask,
    });
    const args = [
      "inject",
      "--env",
      JSON.stringify({ SERVICE_TOKEN: ENTERED }),
      "--reason",
      REASON,
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
    const title = approvalTitle([{ ref: ENTERED, label: LABEL }], USING_TASK.title);
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    const body = cardBody(page, title);
    await expect(body.locator("body")).toContainText(REASON);
    await expect(body.locator("body")).not.toContainText(TOKEN);
    // The card shows what was checked, in words, and asks the person to fill in nothing.
    const checked = body.locator("details");
    await expect(checked.locator("summary")).toHaveText(SECRET_APPROVAL_CARD_WORDS.checked);
    // A line is found by its exact name: the Not checked line mentions the program too.
    const line = (name: string) =>
      checked
        .locator("dl > div")
        .filter({ has: page.locator("dt").getByText(name, { exact: true }) });
    await expect(line(SECRET_CHECKED_WORDS.program)).toContainText(
      `${shPath} · ${SECRET_CHECKED_WORDS.inPlace}`,
    );
    await expect(line(SECRET_CHECKED_WORDS.file)).toContainText(
      `${join(cwd, "check.sh")} · ${SECRET_CHECKED_WORDS.input}`,
    );
    await expect(line(SECRET_CHECKED_WORDS.secrets)).toContainText(
      `SERVICE_TOKEN ${SECRET_CHECKED_WORDS.gets} ${LABEL}`,
    );
    await expect(body.locator("input, textarea, select")).toHaveCount(0);

    await app.evaluate(() => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = false;
    });
    await pressKey(card.getByRole("button", { name: SECRETS_WORDS.once, exact: true }), "Enter");
    await expect(cardBody(page, title).getByRole("status")).toBeVisible();
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
    // The row says which task used the secret, by the task's own title.
    await expect(
      section.getByRole("listitem").filter({ hasText: LABEL }).locator("summary"),
    ).toContainText(USING_TASK.title);
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
    const title = approvalTitle([
      { ref: "planning-calendar", label: "Planning calendar", environment: "Personal" },
    ]);
    const card = shownCard(page, title);
    // This is a lone card, not a stack with a warmed successor. Read its
    // drawn frame, then enter chrome through its own keyboard command.
    await expect(cardBody(page, title).locator("body")).toBeVisible();
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

// Intent: INF-1690's accepted plan, the captain's answer: saved decisions are
// made "Only from the approval card: Always allow this run, or Don't allow and
// stop asking for this key. The page lists saved decisions with Remove and has
// no editor." Data: a disposable credential and a real shell recipient in a
// scratch folder. Completion: Always allow this runs the shown use and the same
// run then needs no card, while different arguments ask again; a failed
// confirmation on Always allow runs and saves nothing; Keep asking saves nothing;
// the window cannot add a decision; Keep it leaves a decision and Remove makes the
// run ask again; Don't allow then Stop asking refuses the next run without a card.
// Every card is answered by keys. Native custody and confirmation stand in; no
// account, native store or network.
test("saved decisions are made on the approval card and removed from Settings", async () => {
  const cwd = realpathSync(scratchDir("secrets-decisions-recipient-"));
  const marker = join(cwd, "executions");
  const script = join(cwd, "deploy.sh");
  writeFileSync(script, '#!/bin/sh\nprintf "ran\\n" >> "$PWD/executions"\n');
  const entry = { ref: "website-staging", label: "Website deployment", environment: "Staging" };
  /** The held run below loops until this file exists; the finally writes it on any failure. */
  const release = join(cwd, "release");
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  const argv = ["/bin/sh", script, "--staging"];
  const run = (id: string, args: readonly string[] = argv) =>
    app.evaluate(
      async (_electron, use) =>
        (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
          .commandFor({ task: "" })
          .inject(use),
      {
        id,
        reason: "Deploy the website to staging and check it",
        env: { DEPLOY_TOKEN: entry.ref },
        argv: [...args],
        cwd,
      },
    );
  const confirming = (ok: boolean) =>
    app.evaluate((_electron, ok) => {
      (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = ok;
    }, ok);
  const state = (request: string) =>
    app.evaluate(async (_electron, request) => {
      const f = (globalThis as SecretsJourneyGlobal).secretsJourney;
      const view = await f.core.services.secrets.view();
      return {
        state: view.uses.find((use) => use.request === request)?.state,
        confirmations: f.confirmations,
      };
    }, request);
  const saved = () =>
    app.evaluate(
      async () =>
        (await (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.view())
          .rules.length,
    );
  const title = approvalTitle([entry]);
  const answer = async (card: string, label: string) => {
    await expect(cardBody(page, card).locator("body")).toBeVisible();
    await runFromSearch(app, page, "focus.card-actions");
    await pressKey(
      shownCard(page, card).getByRole("button", { name: label, exact: true }),
      "Enter",
    );
  };
  const decisions = () =>
    section.getByRole("region", { name: SECRETS_WORDS.decisionsRegion, exact: true });
  try {
    await app.evaluate(async (_electron, entry) => {
      await (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.put({
        ...entry,
        value: "invented-deploy-proof-token",
        expectedVersion: 0,
        expectedRevision: null,
      });
    }, entry);

    // Always allow this: the shown run goes now, under one confirmation, and is saved.
    const first = await run("deploy-1");
    expect(first.state).toBe("waiting");
    await expect(shownCard(page, title)).toBeVisible();
    await answer(title, SECRETS_WORDS.always);
    await expect.poll(() => state(first.request)).toEqual({ state: "completed", confirmations: 1 });
    // The use runs before its decision is saved; the next run waits for the save.
    await expect.poll(saved).toBe(1);
    const again = await run("deploy-2");
    await expect.poll(() => state(again.request)).toEqual({ state: "completed", confirmations: 1 });
    expect(readFileSync(marker, "utf8")).toBe("ran\nran\n");

    // Different arguments are a different run: it asks again.
    const other = await run("deploy-other", ["/bin/sh", script, "--production"]);
    expect(other.state).toBe("waiting");
    await expect(shownCard(page, title)).toBeVisible();
    // Always allow this with a failed confirmation runs nothing and saves nothing;
    // the same card comes back.
    await confirming(false);
    await answer(title, SECRETS_WORDS.always);
    await expect.poll(() => state(other.request)).toEqual({ state: "waiting", confirmations: 2 });
    // The card comes back drawn anew with its notice; answer it only once that
    // card is the one shown, or the keys reach the card being replaced.
    await expect(cardBody(page, title).getByRole("status")).toBeVisible();
    await confirming(true);
    expect(await saved()).toBe(1);
    // Don't allow, then Keep asking: nothing is saved, so the next such run asks.
    await answer(title, SECRETS_WORDS.deny);
    const stopTitle = SECRET_APPROVAL_CARD_WORDS.stopTitle(
      secretsListed([secretName([entry], entry.ref)]),
    );
    await expect.poll(() => state(other.request)).toEqual({ state: "denied", confirmations: 2 });
    await answer(stopTitle, SECRET_APPROVAL_CARD_WORDS.keepAsking);
    await expect(shownCard(page, stopTitle)).toHaveCount(0);
    expect(await saved()).toBe(1);
    const otherAgain = await run("deploy-other-2", ["/bin/sh", script, "--production"]);
    expect(otherAgain.state).toBe("waiting");
    await answer(title, SECRETS_WORDS.deny);
    await answer(stopTitle, SECRET_APPROVAL_CARD_WORDS.keepAsking);
    await expect(shownCard(page, stopTitle)).toHaveCount(0);
    expect(readFileSync(marker, "utf8")).toBe("ran\nran\n");

    // The window cannot add a decision: a save that adds one changes nothing.
    const added = await page.evaluate(async () => {
      const view = await window.infinitary.secrets.view();
      return window.infinitary.secrets.action({
        kind: "save-rules",
        rules: [...view.rules, { id: "added", effect: "never", secret: "website-staging" }],
      });
    });
    expect(added.message).toBe(SAVED_DECISION_WORDS.onlyRemove);
    expect(added.rules).toHaveLength(1);
    expect(await saved()).toBe(1);

    // The page lists it as one sentence; Remove asks on a card, and the run asks again.
    const sentence = decisionWords(
      {
        id: "shown",
        effect: "allow",
        secret: entry.ref,
        note: runWords({ kind: "program", program: realpathSync("/bin/sh"), argv, cwd }),
      },
      secretName([entry], entry.ref),
    );
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "decisions");
    await expect(decisions()).toContainText(sentence);
    await regionShot(decisions(), test.info().outputPath("saved-decision-allow.png"));
    const remove = decisions().getByRole("button", {
      name: SECRETS_WORDS.remove,
      exact: true,
    });
    // Keep it leaves the decision saved, and the same run still needs no card.
    await focusOn(remove);
    await pressKey(remove, "Enter");
    await answer(SAVED_DECISION_WORDS.removeTitle, SAVED_DECISION_WORDS.keep);
    await expect(shownCard(page, SAVED_DECISION_WORDS.removeTitle)).toHaveCount(0);
    expect(await saved()).toBe(1);
    const kept = await run("deploy-kept");
    await expect.poll(() => state(kept.request)).toEqual({ state: "completed", confirmations: 2 });
    expect(readFileSync(marker, "utf8")).toBe("ran\nran\nran\n");
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "decisions");
    await focusOn(remove);
    await pressKey(remove, "Enter");
    await expect(cardBody(page, SAVED_DECISION_WORDS.removeTitle).locator("body")).toContainText(
      sentence,
    );
    await answer(SAVED_DECISION_WORDS.removeTitle, SAVED_DECISION_WORDS.removeConfirm);
    await expect.poll(() => state(again.request)).toMatchObject({ confirmations: 3 });
    // The confirmation comes before the save, so wait for the decision itself to go.
    await expect.poll(saved).toBe(0);
    const asks = await run("deploy-3");
    expect(asks.state).toBe("waiting");

    // Don't allow sends nothing, then offers to stop asking; Stop asking saves Never.
    await answer(title, SECRETS_WORDS.deny);
    await expect(shownCard(page, stopTitle)).toBeVisible();
    await expect.poll(() => state(asks.request)).toEqual({ state: "denied", confirmations: 3 });
    await answer(stopTitle, SECRET_APPROVAL_CARD_WORDS.stop);
    await expect.poll(() => state(asks.request)).toMatchObject({ confirmations: 4 });
    await expect.poll(saved).toBe(1);
    expect((await run("deploy-4")).state).toBe("denied");
    expect(readFileSync(marker, "utf8")).toBe("ran\nran\nran\n");
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "decisions");
    await expect(decisions()).toContainText(
      decisionWords(
        { id: "shown", effect: "never", secret: entry.ref },
        secretName([entry], entry.ref),
      ),
    );
    // There is no editor: the only control a saved decision has is Remove.
    await expect(decisions().getByRole("combobox")).toHaveCount(0);
    await expect(decisions().getByRole("textbox")).toHaveCount(0);

    // A request's card shows beside the first mate, not over Settings, so go back.
    const back = page.getByRole("button", { name: "Back", exact: true });
    await focusOn(back);
    await pressKey(back, "Enter");
    await expect(section).toBeHidden();

    // Always allow this saves the decision once the run starts, while it still runs.
    const preview = { ref: "website-preview", label: "Website preview", environment: "Preview" };
    const previewRevision = await app.evaluate(async (_electron, preview) => {
      const view = await (
        globalThis as SecretsJourneyGlobal
      ).secretsJourney.core.services.secrets.put({
        ...preview,
        value: "invented-preview-proof-token",
        expectedVersion: 0,
        expectedRevision: null,
      });
      return view.entries.find((one) => one.ref === preview.ref)?.revision ?? null;
    }, preview);
    const held = join(cwd, "held.sh");
    writeFileSync(held, '#!/bin/sh\nwhile [ ! -e "$PWD/release" ]; do sleep 0.05; done\n');
    const previewRun = (id: string, args: readonly string[]) =>
      app.evaluate(
        async (_electron, use) =>
          (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
            .commandFor({ task: "" })
            .inject(use),
        {
          id,
          reason: "Publish the website preview",
          env: { PREVIEW_TOKEN: preview.ref },
          argv: [...args],
          cwd,
        },
      );
    const previewTitle = SECRET_APPROVAL_CARD_WORDS.title(
      secretsNamed([secretName([entry, preview], preview.ref)]),
      null,
    );
    const long = await previewRun("preview-held", ["/bin/sh", held]);
    expect(long.state).toBe("waiting");
    await answer(previewTitle, SECRETS_WORDS.always);
    await expect.poll(saved).toBe(2);
    expect(await state(long.request)).toEqual({ state: "executing", confirmations: 5 });
    writeFileSync(release, "");
    await expect.poll(() => state(long.request)).toEqual({ state: "completed", confirmations: 5 });
    expect(await saved()).toBe(2);

    // A replacement saved while a use waits does not rename it: the card offered
    // again from Settings still names the secret the use prepared.
    const renamed = await previewRun("preview-renamed", ["/bin/sh", held, "--again"]);
    expect(renamed.state).toBe("waiting");
    await expect(shownCard(page, previewTitle)).toBeVisible();
    await app.evaluate(
      async (_electron, { preview, revision }) => {
        await (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.put({
          ...preview,
          label: "Old website preview",
          value: "invented-preview-proof-token-2",
          expectedVersion: 1,
          expectedRevision: revision,
        });
      },
      { preview, revision: previewRevision },
    );
    await runFromSearch(app, page, "settings.secrets");
    const review = section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true });
    await focusOn(review);
    await pressKey(review, "Enter");
    await expect(cardBody(page, previewTitle).locator("body")).toBeVisible();
    await expect(
      shownCard(
        page,
        SECRET_APPROVAL_CARD_WORDS.title(secretsNamed(["Old website preview"]), null),
      ),
    ).toHaveCount(0);
    await answer(previewTitle, SECRETS_WORDS.deny);
    const previewStop = SECRET_APPROVAL_CARD_WORDS.stopTitle(
      secretsListed([secretName([entry, preview], preview.ref)]),
    );
    await answer(previewStop, SECRET_APPROVAL_CARD_WORDS.keepAsking);
    await expect.poll(() => state(renamed.request)).toEqual({ state: "denied", confirmations: 5 });
  } finally {
    // The held script loops until this file exists, so write it whatever happened.
    writeFileSync(release, "");
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
      { cwd, ref: ENTERED },
    );
    const area = await secretsArea(page, "copy");
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

// Intent: INF-1109's device enrollment, built by INF-1202, set up where INF-1690
// piece 4 put it, the captain's pick: "In Devices, as a switch on the paired
// iPhone: Approves key uses. The code comparison stays as the one confirmation,
// with the same key underneath." A paired phone's row in Settings -> Devices
// carries the switch; turning it on asks that phone for its key, whose card the
// captain compares and confirms here, and turning it off asks once more on the
// card that stops it. The phone is a stand-in on the real connection, asking
// `inf:secrets:approvals` and `inf:secrets:enroll` with a real P-256 key as the
// phone does; the phone's screens are the phone check's (PhoneJourney's
// testSecretsApprovals). Completion: the switch reads off again and the Secrets
// list empties. Prerequisites: Electron and the built renderer. No phone, native
// store or network.
test("a paired phone's switch in Devices enrolls its key only through the code card on this computer", async () => {
  const PHONE = { device: "8F3C2A1E-5B7D-4C9A-9E21-0D4B6F8A7C35", label: "Kun’s iPhone" };
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  let phone: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    await app.evaluate(async () => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      await services.secrets.put({
        ref: "calendar",
        label: "Planning calendar",
        value: "invented-planning-calendar-token",
        expectedVersion: 0,
        expectedRevision: null,
        environment: "Personal",
      });
    });
    const { link } = await page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    const grant = await claimLink(link, { ...PAIRED_FROM_HERE, name: PHONE.label });
    phone = await connectClient(grant, { system: { system: "ios", chip: "arm64" } });
    const asked = async () =>
      (await phone?.invoke("inf:secrets:approvals", [{ device: PHONE.device }]))?.asked;
    // Settings opens from command search; Devices is its tab.
    const toDevices = async () => {
      await runFromSearch(app, page, "settings.secrets");
      await page.getByRole("tab", { name: "Devices", exact: true }).click();
      await expect(page.locator("[data-devices]")).toBeVisible();
    };
    expect(await asked()).toBe(false);

    await toDevices();
    const row = page.locator(`[data-device-row="${grant.deviceId}"]`);
    const approves = row.getByRole("switch", {
      name: `${PHONE.label} ${SECRET_DEVICE_WORDS.approves.toLowerCase()}`,
      exact: true,
    });
    await expect(approves).toHaveAttribute("aria-checked", "false");
    await focusOn(approves);
    await pressKey(approves, "Space");
    await expect(approves).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText(SECRET_DEVICE_WORDS.waiting(PHONE.label));
    await expect.poll(asked).toBe(true);

    // The phone offers its key, as it does once it reads that it was asked.
    await phone.invoke("inf:secrets:enroll", [{ ...PHONE, key }]);
    await expect(row).toContainText(SECRET_DEVICE_WORDS.comparing(PHONE.label));
    const compare = row.getByRole("button", { name: SECRET_DEVICE_WORDS.compare, exact: true });
    await focusOn(compare);
    await pressKey(compare, "Enter");
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
    // Confirmed, the home asks the phone no more.
    await expect.poll(asked).toBe(false);

    await toDevices();
    await expect(approves).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText(SECRET_DEVICE_WORDS.on(approvalCode(key)));
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "phone");
    const devices = section.getByRole("region", { name: SECRETS_WORDS.devicesRegion });
    await expect(devices.getByText(PHONE.label, { exact: true })).toBeVisible();
    await expect(devices.getByText(`Code ${approvalCode(key)}`, { exact: true })).toBeVisible();

    // Turning the switch off asks on the Stop approvals card; Keep approvals leaves the phone approving.
    await toDevices();
    await focusOn(approves);
    await pressKey(approves, "Space");
    const stopping = shownCard(page, SECRET_DEVICE_WORDS.stopTitle(PHONE.label));
    await expect(stopping).toBeVisible();
    await pressKey(
      stopping.getByRole("button", { name: SECRET_DEVICE_WORDS.keep, exact: true }),
      "Enter",
    );
    await expect(stopping).toHaveCount(0);
    await toDevices();
    await expect(approves).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText(SECRET_DEVICE_WORDS.on(approvalCode(key)));

    // Settings -> Secrets' own Stop approvals raises the same card, and confirming it turns the switch off.
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "phone");
    const stop = devices.getByRole("button", { name: SECRETS_WORDS.stopApprovals, exact: true });
    await focusOn(stop);
    await pressKey(stop, "Enter");
    await expect(stopping).toBeVisible();
    await pressKey(
      stopping.getByRole("button", { name: SECRETS_WORDS.stopApprovals, exact: true }),
      "Enter",
    );
    await expect(stopping).toHaveCount(0);
    await runFromSearch(app, page, "settings.secrets");
    await secretsArea(page, "phone");
    await expect(section.getByRole("region", { name: SECRETS_WORDS.devicesRegion })).toContainText(
      SECRETS_WORDS.noDevices,
    );
    await toDevices();
    await expect(approves).toHaveAttribute("aria-checked", "false");
    // The enrollment and the stop each asked for this computer's own confirmation once.
    expect(
      await app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations),
    ).toBe(2);
  } finally {
    await phone?.close();
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
    // INF-1690's card names the secret and the task that asked, and says who asks.
    const title = approvalTitle(
      [{ ref: REFERENCE, label: LABEL, environment: "Disposable" }],
      PROTECTED_USE_TITLE,
    );
    const approval = shownCard(page, title);
    await expect(approval).toBeVisible();
    await expect(cardBody(page, title).locator("body")).toContainText(
      SECRET_APPROVAL_CARD_WORDS.asked(PROTECTED_USE_TITLE),
    );
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
// INF-1690 piece 1: the form asks for a name, the masked value and an optional
// place, and never for a reference.
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
    const place = section.getByLabel(SECRETS_WORDS.place, { exact: true });
    const form = section.getByRole("form", { name: SECRETS_WORDS.add, exact: true });
    await expect(name).toBeFocused();
    await expect(place).toBeVisible();
    // Name, value and place are the whole form: there is no reference to invent.
    await expect(form.locator("input")).toHaveCount(3);
    await name.fill("   ");
    await pressKey(name, "Tab");
    await expect(value).toBeFocused();
    await value.fill(TOKEN);
    const save = section.getByRole("button", { name: SECRETS_WORDS.save, exact: true });
    await pressKey(save, "Enter");
    await expect(section.getByText(SECRETS_WORDS.nameRequired, { exact: true })).toBeVisible();
    await expect(name).toBeFocused();
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
    const row = section.getByRole("listitem").filter({ hasText: LABEL });
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
// including duplicate and long names at the desktop's minimum width; INF-1690's
// plan names each by name and place, and by reference only where two read alike.
// The genuine sealed owner prepares a real executable; Don't allow sends no values.
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
      const title = approvalTitle(entries);
      const body = cardBody(page, title);
      // e2e-typed-words: this list names the exact identities the captain is approving.
      const requested = body.getByRole("list", { name: "Secrets requested", exact: true });
      await expect(requested).toBeVisible();
      for (const entry of entries) {
        const row = requested.locator(`[data-secret-ref=${JSON.stringify(entry.ref)}]`);
        // Named as Settings names it: place when a name repeats, reference only when both do.
        await expect(row).toHaveText(secretName(entries, entry.ref));
        await expect(row).toBeInViewport();
      }
      expect(await overflows(requested)).toBe(0);
      expect(await overflows(body.locator("body"))).toBe(0);
      const card = shownCard(page, title);
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
      // Don't allow offers to stop asking; Stop asking saves Never for each secret,
      // after the computer's confirmation. A decision is made only on a card.
      // The stop card lists every secret by name, in the order the use holds them.
      const stopTitle = SECRET_APPROVAL_CARD_WORDS.stopTitle(
        secretsListed(
          entries
            .map((entry) => entry.ref)
            .sort()
            .map((ref) => secretName(entries, ref)),
        ),
      );
      const stop = shownCard(page, stopTitle);
      await expect(stop).toBeVisible();
      await runFromSearch(app, page, "focus.card-actions");
      await pressKey(
        stop.getByRole("button", { name: SECRET_APPROVAL_CARD_WORDS.stop, exact: true }),
        "Enter",
      );
      await expect(stop).toHaveCount(0);
      const savedRules = () =>
        app.evaluate(async () =>
          (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
            .view()
            .then((view) => view.rules),
        );
      await expect.poll(async () => (await savedRules()).length).toBe(entries.length);
      const rules = await savedRules();
      expect(rules.every((rule) => rule.effect === "never")).toBe(true);
      // INF-1690 piece 1: saved decisions are plain sentences on the page, each
      // naming exactly its secret, and Remove asks on the host's card.
      const confirmRules = async (rulesTitle: string, confirm: string) => {
        const rulesCard = shownCard(page, rulesTitle);
        await expect(cardBody(page, rulesTitle).locator("body")).toBeVisible();
        await runFromSearch(app, page, "focus.card-actions");
        await pressKey(rulesCard.getByRole("button", { name: confirm, exact: true }), "Enter");
        await expect(rulesCard).toHaveCount(0);
      };
      await runFromSearch(app, page, "settings.secrets");
      await secretsArea(page, "decisions");
      const decisions = section.getByRole("region", {
        name: SECRETS_WORDS.decisionsRegion,
        exact: true,
      });
      const sentences = rules.map((rule) => decisionWords(rule, secretName(entries, rule.secret)));
      expect(new Set(sentences).size).toBe(entries.length);
      for (const sentence of sentences)
        await expect(decisions.getByText(sentence, { exact: true })).toBeVisible();
      for (const ref of ["website-production", "website-production-mirror"])
        expect(sentences.filter((sentence) => sentence.includes(`${ref})`))).toHaveLength(1);
      expect(await overflows(decisions)).toBe(0);
      await regionShot(decisions, test.info().outputPath(`saved-decisions-${theme}.png`));
      const mirrored = rules.findIndex((rule) => rule.secret === "website-production-mirror");
      const mirror = decisions
        .getByRole("listitem")
        .filter({ hasText: sentences[mirrored] as string });
      await focusOn(mirror.getByRole("button", { name: SECRETS_WORDS.remove, exact: true }));
      await pressKey(
        mirror.getByRole("button", { name: SECRETS_WORDS.remove, exact: true }),
        "Enter",
      );
      await confirmRules(SAVED_DECISION_WORDS.removeTitle, SAVED_DECISION_WORDS.removeConfirm);
      // The card closes before the confirmed save is written, so read until it lands.
      await expect
        .poll(() =>
          app.evaluate(async () =>
            (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets
              .view()
              .then((view) => view.rules.map((rule) => rule.secret).sort()),
          ),
        )
        .toEqual(
          rules
            .map((rule) => rule.secret)
            .filter((ref) => ref !== "website-production-mirror")
            .sort(),
        );
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
    const add = section.getByRole("button", { name: SECRETS_WORDS.add, exact: true });
    await pressKey(add, "Enter");
    await ready(section.getByRole("button", { name: "Cancel", exact: true }));
    // While the form is open, Add is refused and says why.
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toHaveAttribute("aria-description", /.+/);
    await section.getByLabel(SECRETS_WORDS.name, { exact: true }).fill(LABEL);
    await section.getByLabel(SECRETS_WORDS.value, { exact: true }).fill(TOKEN);
    await pressKey(section.getByRole("button", { name: SECRETS_WORDS.save, exact: true }), "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);
    await runFromSearch(app, page, "settings.secrets");
    await expect(
      section.getByRole("heading", { name: SECRETS_WORDS.title, exact: true }),
    ).toBeFocused();
    await ready(add);
    await pressKey(section.locator("summary").filter({ hasText: LABEL }), "Enter");
    await ready(section.getByRole("button", { name: SECRETS_WORDS.replace, exact: true }));
    await ready(section.getByRole("button", { name: SECRETS_WORDS.forget, exact: true }));
    await secretsArea(page, "copy");
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
