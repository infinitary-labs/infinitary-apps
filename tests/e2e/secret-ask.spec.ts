import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claimLink } from "@core/devices/dial";
import { expect, test } from "@playwright/test";
import { decode } from "@toon-format/toon";
import { hostEnv } from "../../src/core/hostEnv";
import { SECRET_ASK_WORDS } from "../../src/core/secrets/commandWords";
import { SECRETS_COMMAND } from "../../src/core/secrets/requests";
import { SECRET_ASK_CARD_WORDS, secretKeepFields } from "../../src/shared/secrets";
import { connectClient } from "../helpers/connectionClient";
import { cardBody } from "./frames";
import { heroShot, regionShot } from "./pictures";
import { savedText } from "./savedText";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { shownCard } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

const TASK = { id: "secret-ask-proof-task", title: "Wire up the checkout" };
const KEY = { name: "Stripe test key", place: "Test", value: "sk_test_invented_ask_4239_key" };
const HOOK = { name: "Webhook secret", value: "whsec_invented_ask_4239_hook" };
const REASON = "Charge the test card in the checkout tests";
const DASHBOARD = "https://dashboard.stripe.com/test/apikeys";
const HOW = `<ol><li>Open <a href="${DASHBOARD}">dashboard.stripe.com/test/apikeys</a>.</li><li>Reveal the <strong>Secret key</strong> and copy it.</li><li>Under <em>Webhooks</em>, copy the signing secret of <code>checkout-tests</code>.</li></ol>`;

// Intent: INF-4239, the captain's direction A and "all macs windows and phone
// app in one build piece", here on the first mate's computer: a crewmate asks
// by name, place and reason; Infinitary raises its own card with one masked
// field per secret; the captain reaches the fields with Tab and keeps both
// with Enter in the last; the values go straight into Secrets. INF-5516 with
// the captain's write-in: the asker's own "How to get it" layout is drawn,
// each link showing its address and the part saying who wrote it, and a
// how-to holding a script asks nothing.
// Data: invented keys and the real app, renderer, IPC, task command and sealed
// files, over the disposable custody and confirmation stand-ins of
// `launchSecrets`. Completion: the ask's card goes, Secrets lists both under
// the asked names and place, and a search of every saved file of the data
// folder finds neither value outside the sealed values.
// Prerequisites: Electron and the built renderer; no account, native store or
// network. Shared resources: none beyond its own scratch folders.
test("a crewmate's ask is kept from Infinitary's own card by keys alone", async () => {
  const launched = await launchSecrets();
  const { app, page, userDataDir } = launched;
  try {
    // Only the closed facade, as the local task channel grants it.
    const shell = await app.evaluate((_electron, task) => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
      services.tasks.create({ ...task, prompt: task.title, repoId: null });
      return services.taskCommands.grant("secret-ask-proof", {
        secrets: services.secrets.commandFor({ task: task.id }),
      });
    }, TASK);
    const [bin] = shell.path;
    if (!bin) throw new Error("The task channel supplied no command folder.");
    const secrets = JSON.stringify([{ name: KEY.name, place: KEY.place }, { name: HOOK.name }]);
    const ask = (how: string, id: string) =>
      promisify(execFile)(
        join(bin, SECRETS_COMMAND),
        ["ask", "--secrets", secrets, "--how", how, "--reason", REASON, "--id", id],
        {
          env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(":") },
          encoding: "utf8",
        },
      );
    // A how-to holding a script is refused before anything is asked.
    await expect(
      ask(`${HOW}<script>parent.postMessage("x", "*")</script>`, "refused"),
    ).rejects.toThrow();
    const asked = await ask(HOW, "checkout-keys");
    expect(decode(asked.stdout)).toEqual({
      ask: { ask: "checkout-keys", state: "waiting" },
      help: SECRET_ASK_WORDS.waiting,
    });

    const title = SECRET_ASK_CARD_WORDS.title([KEY.name, HOOK.name], false);
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    const body = cardBody(page, title).locator("body");
    await expect(body).toContainText(REASON);
    await expect(body).toContainText(SECRET_ASK_CARD_WORDS.asked(TASK.title));
    // The asker's layout, its link showing its own address, and who wrote it.
    await expect(
      body.getByRole("heading", { name: SECRET_ASK_CARD_WORDS.how(true) }),
    ).toBeVisible();
    await expect(body.locator("ol > li")).toHaveCount(3);
    await expect(body.locator(`a[href="${DASHBOARD}"]`)).toHaveText(
      DASHBOARD.replace("https://", ""),
    );
    await expect(body).toContainText(SECRET_ASK_CARD_WORDS.by(TASK.id));
    await expect(body.locator("script")).toHaveCount(0);
    // The place is said once, beside its field.
    await expect(card.getByText(SECRET_ASK_CARD_WORDS.place(KEY.place))).toHaveCount(1);
    // The card's own page holds no field, and its line for older windows is hidden here.
    await expect(cardBody(page, title).locator("input")).toHaveCount(0);
    await expect(cardBody(page, title).locator("[data-inf-secret-elsewhere]")).toBeHidden();
    const [keyField, hookField] = [
      card.locator('[data-secret-ask-field="s1"]'),
      card.locator('[data-secret-ask-field="s2"]'),
    ];
    await expect(keyField).toHaveAttribute("type", "password");
    await expect(hookField).toHaveAttribute("type", "password");
    await expect(card.getByLabel(new RegExp(`^${KEY.name}`))).toHaveCount(1);

    // Tab order: the fields sit between the body and the buttons, so Shift-Tab
    // from Don't save reaches the last field, then the first.
    const dontSave = card.getByRole("button", { name: SECRET_ASK_CARD_WORDS.dontSave });
    await focusOn(dontSave);
    await pressKey(dontSave, "Shift+Tab");
    await expect(hookField).toBeFocused();
    await pressKey(hookField, "Shift+Tab");
    await expect(keyField).toBeFocused();
    await typeInto(keyField, KEY.value);
    // Enter moves on to the next field rather than keeping half the ask.
    await pressKey(keyField, "Enter");
    await expect(hookField).toBeFocused();
    await typeInto(hookField, HOOK.value);
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence && test.info().repeatEachIndex === 0) {
      await regionShot(card, join(evidence, "secret-ask-card-typed.png"));
      await heroShot(app, page, { region: card, name: "secrets-ask-how" });
      await focusOn(hookField);
    }
    await pressKey(hookField, "Enter");
    await expect(card).toHaveCount(0);

    const kept = await app.evaluate(async () => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      return (await services.secrets.view()).entries.map((entry) => ({
        label: entry.label,
        environment: entry.environment ?? "",
        version: entry.version,
      }));
    });
    expect(kept).toEqual(
      expect.arrayContaining([
        { label: KEY.name, environment: KEY.place, version: 1 },
        { label: HOOK.name, environment: "", version: 1 },
      ]),
    );
    // Every saved file of the data folder: only the sealed values hold the keys, and sealed.
    const saved = savedText(userDataDir);
    expect(
      saved.filter(({ file }) => file.startsWith(join(userDataDir, "secrets", "values"))),
    ).toHaveLength(2);
    for (const { file, text } of saved)
      for (const value of [KEY.value, HOOK.value]) {
        expect(text, file).not.toContain(value);
        expect(text, file).not.toContain(Buffer.from(value).toString("base64"));
      }
  } finally {
    await launched.close();
  }
});

// Intent: INF-4239 piece 3, the captain's "all macs windows and phone app in
// one build piece": the first mate's ask is answered at another Mac's window.
// A view that lists the change reads the card's Keep and sends the typed value
// over the connection with its pass; a view that does not list it gets the card
// without Keep. Data: an invented key; the real app, connection, pairing and
// controller over the disposable custody of `launchSecrets`; the other Mac is
// this Mac paired as a window, the stand-in `secrets.spec.ts` uses for a phone.
// Completion: the view's Keep answers kept, the card goes on this window, and
// Secrets lists the key under the asked name and place.
// Prerequisites: Electron and the built renderer. Shared resources: none.
test("another Mac's window keeps the first mate's ask over the connection", async () => {
  const launched = await launchSecrets();
  const { app, page, userDataDir } = launched;
  const views: Awaited<ReturnType<typeof connectClient>>[] = [];
  try {
    const answer = await app.evaluate(async (_electron, key) => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      return services.secrets.askToKeep(null, {
        id: "deploy-key",
        reason: "Deploy the site to staging",
        secrets: [{ name: key.name, place: key.place }],
      });
    }, KEY);
    expect(answer).toEqual({ ask: "deploy-key", state: "waiting" });
    const title = SECRET_ASK_CARD_WORDS.title([KEY.name], false);
    await expect(shownCard(page, title)).toBeVisible();

    const pair = async (changes: string[]) => {
      const { link } = await page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
      const grant = await claimLink(link, {
        kind: "mac",
        window: true,
        user: { name: userInfo().username, uid: process.getuid?.() ?? userInfo().uid },
        name: `Studio Mac ${views.length + 1}`,
      });
      const view = await connectClient(grant, { changes });
      views.push(view);
      return view;
    };
    type Listed = {
      id: string;
      title: string;
      author: string;
      actions: { id: string; effect?: unknown }[];
    };
    const cardOn = async (view: Awaited<ReturnType<typeof connectClient>>) =>
      ((await view.invoke("inf:cards:list", [])) as Listed[]).find((one) => one.title === title);

    // An older window gets the card without Keep in Secrets, so it never sends a value it cannot.
    const older = await cardOn(await pair([]));
    expect(older && secretKeepFields(older)).toBeUndefined();
    expect(older?.actions).toHaveLength(1);

    const view = await pair(["secrets-ask"]);
    const shown = await cardOn(view);
    const keep = shown && secretKeepFields(shown);
    if (!keep) throw new Error("The other Mac's window reads no Keep on the ask's card.");
    expect(keep.fields.map((field) => [field.name, field.place])).toEqual([[KEY.name, KEY.place]]);
    expect(
      await view.invoke("inf:secrets:keep", [
        { pass: keep.pass, values: [{ field: keep.fields[0]?.id, value: KEY.value }] },
      ]),
    ).toEqual({ kept: true });
    await expect(shownCard(page, title)).toHaveCount(0);
    // A spent pass sent again keeps nothing.
    expect(
      await view.invoke("inf:secrets:keep", [
        { pass: keep.pass, values: [{ field: keep.fields[0]?.id, value: KEY.value }] },
      ]),
    ).toEqual({ kept: false, words: SECRET_ASK_CARD_WORDS.gone });

    const kept = await app.evaluate(async () => {
      const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
      return (await services.secrets.view()).entries.map((entry) => [
        entry.label,
        entry.environment ?? "",
        entry.version,
      ]);
    });
    expect(kept).toEqual([[KEY.name, KEY.place, 1]]);
    for (const { file, text } of savedText(userDataDir))
      expect(text, file).not.toContain(KEY.value);
  } finally {
    for (const view of views) await view.close();
    await launched.close();
  }
});
