import { execFile } from "node:child_process";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { decode } from "@toon-format/toon";
import { hostEnv } from "../../src/core/hostEnv";
import { SECRET_BRING_WORDS } from "../../src/core/secrets/commandWords";
import { SECRETS_COMMAND } from "../../src/core/secrets/requests";
import { SECRET_BRING_CARD_WORDS } from "../../src/shared/secretBring";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { savedText } from "./savedText";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

const TASK = { id: "secret-bring-proof-task", title: "Move the staging keys" };
const TOKEN = { name: "STAGING_TOKEN", as: "Staging token", value: "av_invented_bring_4718_token" };
const DB = { name: "DB_PASSWORD", value: "av_invented_bring_4718_database" };
/** The value Secrets already keeps under the second name, before the bring. */
const KEPT_BEFORE = "av_invented_bring_4718_kept_before";
const REASON = "Move the staging keys out of Automic Vault";

// Intent: INF-4718's plan, piece 1, approved by the captain: "a way for users
// who have secrets stored in automic vault to easily migrate secrets into
// infinitary... we need to handle secrets safely not leaking it in plain text
// into unintended places". A crewmate asks to bring two secrets from a tool's
// command; Infinitary's own card shows the exact command and one tick box
// each, a name Secrets already keeps arriving unticked; the captain brings
// the other by keys alone.
// Data: a stand-in tool that prints invented values as `/usr/bin/env -0`
// does, and the real app, renderer, IPC, task command, inbox, journal and
// sealed files over the disposable custody of `launchSecrets`. Completion:
// the card goes, Secrets lists only the ticked one, and a search of every
// saved file of the data folder finds neither value outside the one sealed
// value. Prerequisites: Electron and the built renderer; no account, native
// store or network. Shared resources: none beyond its own scratch folders.
test("a bring from another tool keeps only the ticked secret, by keys alone", async () => {
  const launched = await launchSecrets();
  const { app, page, userDataDir } = launched;
  try {
    const project = realpathSync(scratchDir("secret-bring-tool-"));
    const tool = join(project, "av");
    writeFileSync(
      tool,
      `#!/bin/sh\nprintf 'PATH=/usr/bin\\0${TOKEN.name}=${TOKEN.value}\\0${DB.name}=${DB.value}\\0'\necho '${DB.value}' >&2\n`,
    );
    chmodSync(tool, 0o755);
    const shell = await app.evaluate(
      async (_electron, { task, kept }) => {
        const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
        if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
        // As the captain kept it in Settings → Secrets earlier.
        await services.secrets.put({
          label: kept.label,
          environment: "",
          value: kept.value,
          expectedVersion: 0,
          expectedRevision: null,
        });
        services.tasks.create({ ...task, prompt: task.title, repoId: null });
        return services.taskCommands.grant("secret-bring-proof", {
          secrets: {
            ...services.secrets.commandFor({ task: task.id }),
            ...services.secretBrings.commandFor(task.id),
          },
        });
      },
      { task: TASK, kept: { label: DB.name, value: KEPT_BEFORE } },
    );
    const [bin] = shell.path;
    if (!bin) throw new Error("The task channel supplied no command folder.");
    const from = {
      tool: "Automic Vault",
      source: { run: [tool, "inject", "staging"], folder: project },
      reads: "env0",
      secrets: [{ name: TOKEN.name, as: TOKEN.as, place: "Staging" }, { name: DB.name }],
    };
    const asked = await promisify(execFile)(
      join(bin, SECRETS_COMMAND),
      ["bring", "--from", JSON.stringify(from), "--reason", REASON, "--id", "staging-keys"],
      {
        env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(":") },
        encoding: "utf8",
      },
    );
    expect(decode(asked.stdout)).toEqual({
      bring: { bring: "staging-keys", state: "waiting" },
      help: SECRET_BRING_WORDS.waiting,
    });

    const title = SECRET_BRING_CARD_WORDS.title(2, "Automic Vault");
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    const body = cardBody(page, title).locator("body");
    await expect(body).toContainText(REASON);
    await expect(body.locator("[data-secret-bring-runs]")).toHaveText(`${tool} inject staging`);
    // The rows are the window's, outside the card's own page.
    await expect(cardBody(page, title).locator("input")).toHaveCount(0);
    const [first, second] = [
      card.locator('[data-secret-bring-row="s1"]'),
      card.locator('[data-secret-bring-row="s2"]'),
    ];
    await expect(first).toBeChecked();
    // Secrets already keeps that name: replacing it waits for a tick.
    await expect(second).not.toBeChecked();
    await expect(card.getByLabel(new RegExp(`^${TOKEN.as}`))).toHaveCount(1);

    // Tab order: the rows sit between the body and the buttons.
    const dontBring = card.getByRole("button", { name: SECRET_BRING_CARD_WORDS.dontBring });
    await focusOn(dontBring);
    await pressKey(dontBring, "Shift+Tab");
    await expect(second).toBeFocused();
    await pressKey(second, "Space");
    await expect(second).toBeChecked();
    await pressKey(second, "Space");
    await expect(second).not.toBeChecked();
    await pressKey(second, "ArrowUp");
    await expect(first).toBeFocused();
    await pressKey(first, "Enter");
    await expect(card).toHaveCount(0);

    const kept = await app.evaluate(async () => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      const view = await services.secrets.view();
      return {
        entries: view.entries
          .map((entry) => ({
            label: entry.label,
            environment: entry.environment ?? "",
            version: entry.version,
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        brought: view.history.filter((item) => item.brought).map((item) => item.brought),
      };
    });
    expect(kept).toEqual({
      entries: [
        { label: DB.name, environment: "", version: 1 },
        { label: TOKEN.as, environment: "Staging", version: 1 },
      ],
      brought: ["Automic Vault"],
    });
    // Every saved file of the data folder, the task record, inbox and journal
    // among them: only the two sealed values hold a value, and sealed.
    const saved = savedText(userDataDir);
    expect(
      saved.filter(({ file }) => file.startsWith(join(userDataDir, "secrets", "values"))),
    ).toHaveLength(2);
    for (const { file, text } of saved)
      for (const value of [TOKEN.value, DB.value, KEPT_BEFORE]) {
        expect(text, file).not.toContain(value);
        expect(text, file).not.toContain(Buffer.from(value).toString("base64"));
      }
  } finally {
    await launched.close();
  }
});

// INF-4718 piece 3: named JSON and a kept key, through the real task command,
// the keyboard approval and sealed store. Disposable custody and system
// confirmation stand in for the native store, with no account or network.
test("brings named JSON fields with one confirmed unlock key", async () => {
  const launched = await launchSecrets();
  const { app, page, userDataDir } = launched;
  const secret = { name: "session-key", value: "invented_bring_unlock_session" };
  const imported = "invented_imported_login_value";
  const toolName = "Demo vault";
  const title = SECRET_BRING_CARD_WORDS.title(1, toolName);
  try {
    const project = realpathSync(scratchDir("secret-bring-json-"));
    const tool = join(project, "read-json");
    const source = join(project, "vault-data");
    writeFileSync(source, imported, { mode: 0o600 });
    writeFileSync(
      tool,
      `#!/bin/sh
[ -n "$VAULT_SESSION" ] || exit 3
printf '{"login":"%s","ignored":"%s"}' "$(cat vault-data)" "$VAULT_SESSION"
printf '%s' "$VAULT_SESSION" >&2
`,
      { mode: 0o755 },
    );
    const shell = await app.evaluate(
      async (_electron, { secret, task }) => {
        const { core } = (globalThis as SecretsJourneyGlobal).secretsJourney;
        const { services } = core;
        if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
        await services.secrets.put({
          label: secret.name,
          environment: "",
          value: secret.value,
          expectedVersion: 0,
          expectedRevision: null,
        });
        services.tasks.create({ ...task, prompt: task.title, repoId: null });
        return services.taskCommands.grant("secret-bring-json-proof", {
          secrets: {
            ...services.secrets.commandFor({ task: task.id }),
            ...services.secretBrings.commandFor(task.id),
          },
        });
      },
      { secret, task: TASK },
    );
    const bin = shell.path[0];
    if (!bin) throw new Error("The task channel supplied no command folder.");
    const from = {
      tool: toolName,
      source: { run: [tool], folder: project },
      reads: "json",
      secrets: [{ name: "login" }],
      uses: { VAULT_SESSION: secret.name },
    };
    const command = (...args: string[]) =>
      promisify(execFile)(join(bin, SECRETS_COMMAND), args, {
        env: { ...hostEnv(), ...shell.env },
        encoding: "utf8",
      });
    const asked = await command(
      "bring",
      "--from",
      JSON.stringify(from),
      "--reason",
      "Move my login",
      "--id",
      "login",
    );
    expect(decode(asked.stdout)).toMatchObject({ bring: { bring: "login", state: "waiting" } });
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    const body = cardBody(page, title).locator("body");
    await expect(body).toContainText(SECRET_BRING_CARD_WORDS.unlocks);
    await expect(body).toContainText("VAULT_SESSION");
    await expect(body).toContainText(secret.name);
    const pick = card.locator('[data-secret-bring-row="s1"]');
    await focusOn(pick);
    await pressKey(pick, "Enter");
    await expect(card).toHaveCount(0);
    const status = await command("status", "login");
    expect(decode(status.stdout)).toMatchObject({
      bring: { state: "kept", secrets: [{ name: "login", outcome: "kept", ref: "login" }] },
    });
    const { confirmations, labels } = await app.evaluate(async () => {
      const fixture = (globalThis as SecretsJourneyGlobal).secretsJourney;
      const view = await fixture.core.services.secrets.view();
      return {
        confirmations: fixture.confirmations,
        labels: view.entries.map((one) => one.label).sort(),
      };
    });
    expect(confirmations).toBe(1);
    expect(labels).toEqual(["login", secret.name]);
    const saved = savedText(userDataDir);
    expect(
      saved.filter(({ file }) => file.startsWith(join(userDataDir, "secrets", "values"))),
    ).toHaveLength(2);
    for (const { file, text } of [
      ...saved,
      { file: "task command output", text: asked.stdout + status.stdout },
    ]) {
      for (const value of [secret.value, imported]) {
        expect(text, file).not.toContain(value);
        expect(text, file).not.toContain(Buffer.from(value).toString("base64"));
      }
    }
  } finally {
    await launched.close();
  }
});
