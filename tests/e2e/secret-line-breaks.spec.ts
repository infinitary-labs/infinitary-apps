import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { expect, type Locator, test } from "@playwright/test";
import { decode } from "@toon-format/toon";
import { hostEnv } from "../../src/core/hostEnv";
import { SECRETS_COMMAND, type UseReceipt } from "../../src/core/secrets/requests";
import { secretName } from "../../src/shared/secretNames";
import {
  SECRET_APPROVAL_CARD_WORDS,
  SECRET_ASK_CARD_WORDS,
  SECRETS_WORDS,
  secretsNamed,
} from "../../src/shared/secrets";
import { scratchDir } from "../helpers/scratchDirs";
import { regionShot } from "./pictures";
import { savedText } from "./savedText";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingsSection } from "./settings";
import { shownCard } from "./stack";
import { focusOn, pressKey, runFromSearch, typeInto } from "./windowKeys";

type Launched = Awaited<ReturnType<typeof launchSecrets>>;

/**
 * A secret whose line breaks matter: a private key in PEM form, made fresh for
 * each test, so the value is invented yet shaped as the real thing, ending in
 * its own final line break.
 */
const privateKey = () =>
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/**
 * Gives `task` the task channel, runs a recipient that writes the variable it
 * gets to a file, approves the run once on Infinitary's own card and answers
 * the bytes the recipient received. `reveal` brings the card forward where
 * another view covers it.
 */
async function delivered(
  { app, page }: Launched,
  task: { id: string; title: string },
  label: string,
  reveal?: () => Promise<void>,
): Promise<{ received: string; outputs: string[] }> {
  const cwd = realpathSync(scratchDir("secret-line-breaks-recipient-"));
  writeFileSync(join(cwd, "write.sh"), '#!/bin/sh\nprintf "%s" "$SERVICE_KEY" > "$PWD/received"\n');
  const { shell, entries } = await app.evaluate(async (_electron, task) => {
    const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
    if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
    if (!services.tasks.get(task.id))
      services.tasks.create({ ...task, prompt: task.title, repoId: null });
    return {
      shell: services.taskCommands.grant(`${task.id}-use`, {
        secrets: services.secrets.commandFor({ task: task.id }),
      }),
      entries: (await services.secrets.view()).entries.map((entry) => ({
        ref: entry.ref,
        label: entry.label,
        environment: entry.environment ?? "",
      })),
    };
  }, task);
  const saved = entries.find((entry) => entry.label === label);
  if (!saved) throw new Error(`Secrets holds no ${label}.`);
  const [bin] = shell.path;
  if (!bin) throw new Error("The task channel supplied no command folder.");
  const outputs: string[] = [];
  const run = async (args: string[]) => {
    const result = await promisify(execFile)(join(bin, SECRETS_COMMAND), args, {
      cwd,
      env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(delimiter) },
      encoding: "utf8",
    });
    outputs.push(result.stdout, result.stderr);
    return (decode(result.stdout) as { receipt: UseReceipt }).receipt;
  };
  const args = [
    "inject",
    "--env",
    JSON.stringify({ SERVICE_KEY: saved.ref }),
    "--reason",
    "Sign the release with the deploy key",
    "--id",
    `${task.id}-write`,
    "--",
    "/bin/sh",
    "write.sh",
  ];
  const requested = await run(args);
  expect(requested.state).toBe("waiting");
  await reveal?.();
  const title = SECRET_APPROVAL_CARD_WORDS.title(
    secretsNamed([secretName(entries, saved.ref)]),
    task.title,
  );
  const card = shownCard(page, title);
  await expect(card).toBeVisible();
  await pressKey(card.getByRole("button", { name: SECRETS_WORDS.once, exact: true }), "Enter");
  await expect.poll(async () => (await run(["status", requested.request])).state).toBe("completed");
  return { received: readFileSync(join(cwd, "received"), "utf8"), outputs };
}

/** No saved file of the data folder holds the value, plain or encoded, outside the sealed values. */
function sealedOnly({ userDataDir }: Launched, value: string) {
  const lines = value.split("\n").filter((line) => line.length > 8);
  for (const { file, text } of savedText(userDataDir)) {
    for (const line of lines) expect(text, file).not.toContain(line);
    expect(text, file).not.toContain(Buffer.from(value).toString("base64"));
  }
}

/**
 * Pastes `text` into the focused field as a paste does: the paste event first,
 * carrying the text on its own clipboard data, then, unless the page took the
 * paste, the browser's own insertion of that text. The test never reads or
 * replaces the computer's clipboard.
 */
async function pasteInto(field: Locator, text: string) {
  await focusOn(field);
  await field.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    if (element.dispatchEvent(paste)) document.execCommand("insertText", false, text);
  }, text);
}

async function masked(field: Locator, value: string) {
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveJSProperty("value.length", value.length);
}

// Intent: the captain's ask (INF-4830): "when i set a secret value, can i paste
// a multi-line text string into it? does line breaks work in the secret value?
// [...] need a fix, right?" A multi-line value pasted into Settings is saved and
// reaches an approved command with every line break, and stays masked.
// Data: a freshly made, invented PEM private key; the real app, renderer, IPC,
// task command, sealed files and a /bin/sh recipient, over launchSecrets'
// disposable custody and confirmation. The paste carries its text on its own
// clipboard data, so the test never touches the computer's clipboard. Completion: the bytes the recipient wrote equal the
// pasted value, and no saved file holds it. Prerequisites: Electron, the built
// renderer and /bin/sh; no account, native store or network. Shared resources:
// none beyond its own scratch folders.
test("a multi-line value pasted in Settings reaches the command with its line breaks", async () => {
  const value = privateKey();
  const label = "Release signing key";
  const launched = await launchSecrets();
  const { app, page } = launched;
  const section = settingsSection(page, "secrets");
  try {
    await runFromSearch(app, page, "settings.secrets");
    const add = section.getByRole("button", { name: SECRETS_WORDS.add, exact: true });
    await focusOn(add);
    await pressKey(add, "Enter");
    const name = section.getByLabel(SECRETS_WORDS.name, { exact: true });
    await expect(name).toBeFocused();
    await name.fill(label);
    await pressKey(name, "Tab");
    const field = section.getByLabel(SECRETS_WORDS.value, { exact: true });
    await expect(field).toBeFocused();
    await pasteInto(field, value);
    await masked(field, value);
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence && test.info().repeatEachIndex === 0)
      await regionShot(
        section.getByRole("form", { name: SECRETS_WORDS.add }),
        join(evidence, "settings-multiline-pasted.png"),
      );
    const save = section.getByRole("button", { name: SECRETS_WORDS.save, exact: true });
    await pressKey(save, "Enter");
    await expect(section.getByRole("status")).toHaveText(SECRETS_WORDS.saved);

    const { received, outputs } = await delivered(
      launched,
      { id: "line-breaks-settings-task", title: "Sign the release" },
      label,
      () =>
        pressKey(
          section.getByRole("button", { name: SECRETS_WORDS.waiting, exact: true }),
          "Enter",
        ),
    );
    expect(received).toBe(value);
    for (const output of outputs) expect(output).not.toContain(value.split("\n")[1]);
    sealedOnly(launched, value);
  } finally {
    await launched.close();
  }
});

// Intent: the captain's ask (INF-4830), on the other surface where a value is
// entered: a crewmate's ask to keep a secret, answered in the masked field
// Infinitary draws on its own card. The pasted value keeps every line break on
// its way to an approved command.
// Data: a freshly made, invented PEM private key and an invented token; the
// real app, renderer, IPC, task command, sealed files and a /bin/sh recipient
// over launchSecrets' disposable custody. Completion: the ask's card goes, and
// the bytes the recipient wrote equal the pasted key. Prerequisites: Electron,
// the built renderer and /bin/sh; no account, native store or network. Shared
// resources: none beyond its own scratch folders.
test("a multi-line value pasted in an ask's field reaches the command with its line breaks", async () => {
  const value = privateKey();
  const task = { id: "line-breaks-ask-task", title: "Ship the signed build" };
  const asked = { key: "Deploy key", token: "Registry token" };
  const launched = await launchSecrets();
  const { app, page } = launched;
  try {
    await app.evaluate(
      async (_electron, { task, asked }) => {
        const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
        services.tasks.create({ ...task, prompt: task.title, repoId: null });
        await services.secrets.askToKeep(task.id, {
          id: "signing-keys",
          reason: "Sign the build before it ships",
          secrets: [{ name: asked.key }, { name: asked.token }],
        });
      },
      { task, asked },
    );
    const title = SECRET_ASK_CARD_WORDS.title([asked.key, asked.token], false);
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    const [keyField, tokenField] = [
      card.locator('[data-secret-ask-field="s1"]'),
      card.locator('[data-secret-ask-field="s2"]'),
    ];
    // A value typed first is replaced whole by the paste over it, and a key
    // typed after the paste lands where the caret is.
    await focusOn(keyField);
    await typeInto(keyField, "a wrong value");
    await pressKey(keyField, "ControlOrMeta+A");
    await pasteInto(keyField, value);
    await typeInto(keyField, "x");
    await pressKey(keyField, "Backspace");
    await masked(keyField, value);
    await pressKey(keyField, "Enter");
    await expect(tokenField).toBeFocused();
    await typeInto(tokenField, "invented-registry-token-4830");
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence && test.info().repeatEachIndex === 0) {
      await regionShot(card, join(evidence, "ask-multiline-pasted.png"));
      await focusOn(tokenField);
    }
    await pressKey(tokenField, "Enter");
    await expect(card).toHaveCount(0);

    const { received } = await delivered(launched, task, asked.key);
    expect(received).toBe(value);
    sealedOnly(launched, value);
  } finally {
    await launched.close();
  }
});
