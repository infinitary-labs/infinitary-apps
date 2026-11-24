import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { THREAD_APP_CARD_PREAMBLE } from "../../src/core/orchestrator/captainWakes";
import { CARRIED_OUT_ASKER_WORDS } from "../../src/core/prompts/choiceCarried";
import { SECRETS_COMMAND } from "../../src/core/secrets/requests";
import { SECRET_ASK_CARD_WORDS } from "../../src/shared/secrets";
import type { IntegrationAsk } from "../../src/shared/writeAsk";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { cardMeta, cardReply, cardThread, shownCard, shownEntry } from "./stack";
import { focusOn, pressKey, pressWindowKey, typeInto } from "./windowKeys";

const TASK = { id: "asker-replies-task", title: "Wire up the checkout" };
const KEY = { name: "Stripe test key", place: "Test" };
const REASON = "Charge the test card in the checkout tests";
const QUESTION = "Which Stripe account should this key come from?";
const LEFT_WORDS = "Use the shared test account's key instead; I will add it myself.";
const DRAFT = "Open it as a draft, please.";
const ANSWER = "The shared test account; its key is the one named Test.";
const SIZE = { width: 1280, height: 860 };

/** What the app told the asking crewmate, each steer whole, as its task's record keeps it. */
async function steersHeard(page: Page): Promise<string[]> {
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), TASK.id);
  return detail.events.filter((event) => event.kind === "steered").map((event) => event.text);
}

/** An open card's id or title, as the core lists it. */
async function listedCard(page: Page, match: { id?: string; title?: string }) {
  const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (one) => one.id === match.id || one.title === match.title,
  );
  if (!card) throw new Error("No such open card.");
  return card;
}

/** A picture for the change's evidence folder, on the first of repeated runs only. */
async function picture(region: Locator, name: string) {
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence && test.info().repeatEachIndex === 0)
    await regionShot(region, join(evidence, `${name}.png`));
}

/** The asking crewmate's task, and its ask through the real task command. */
async function askForASecret(app: Awaited<ReturnType<typeof launchSecrets>>["app"]) {
  const shell = await app.evaluate((_electron, task) => {
    const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
    if (!services.taskCommands) throw new Error("No task channel in the isolated app.");
    services.tasks.create({ ...task, prompt: task.title, repoId: null });
    return services.taskCommands.grant("asker-replies", {
      secrets: services.secrets.commandFor({ task: task.id }),
    });
  }, TASK);
  const [bin] = shell.path;
  if (!bin) throw new Error("The task channel supplied no command folder.");
  await promisify(execFile)(
    join(bin, SECRETS_COMMAND),
    ["ask", "--secrets", JSON.stringify([KEY]), "--reason", REASON, "--id", "checkout-key"],
    {
      env: { ...hostEnv(), ...shell.env, PATH: [...shell.path, hostEnv().PATH].join(":") },
      encoding: "utf8",
    },
  );
}

// Intent: INF-6265 piece 1, the approved plan: the app's own card for a
// crewmate's ask takes a reply that reaches the crewmate that asked, its header
// names that crewmate's task, and on a card with a masked field Chat opens the
// thread beside the card (the captain's choice: chat-opens-thread), so a reply
// is never typed beside a secret's field. Words left in the field at Don't
// save ride the outcome to the asker.
// Data: an invented ask through the real task command, app, renderer, IPC and
// task record, over the disposable custody and mock model of `launchSecrets`.
// Completion: the reply and the Don't save words each reach the asking
// crewmate as a steer with the app card's own words, the crewmate's line
// naming the captain's message answers it in the thread, and the card's own
// face holds no reply field.
// Prerequisites: Electron and the built renderer; no account, native store or
// network. Shared resources: none beyond its own scratch folders.
test("the asker hears a reply on its secret card, and Chat opens the thread there", async () => {
  const launched = await launchSecrets();
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, SIZE);
    await askForASecret(app);

    const title = SECRET_ASK_CARD_WORDS.title([KEY.name], false);
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    await expect(cardMeta(page, title)).toHaveText(TASK.title);
    // The masked field stands alone on the card's face: no reply field beside it.
    const reply = cardReply(page);
    await expect(reply.row).toHaveCount(0);
    const chat = card.locator("[data-card-chat-opens]");
    await expect(chat).toBeVisible();
    await picture(card, "secret-card-after");

    // Chat opens the thread beside the card and puts the caret in its field.
    await focusOn(chat);
    await pressKey(chat, "Enter");
    const thread = cardThread(page, (await listedCard(page, { title })).id);
    await expect(reply.field).toBeFocused();
    await expect(thread).toBeVisible();
    await typeInto(reply.field, QUESTION);
    await pressKey(reply.field, "Enter");
    await expect(thread).toContainText(QUESTION);
    await expect
      .poll(async () => (await steersHeard(page)).find((text) => text.includes(QUESTION)))
      .toContain(THREAD_APP_CARD_PREAMBLE);

    // The asking crewmate answers through its reply tool's handler, naming the
    // captain's message, and the line answers it in the card's thread.
    const cardId = (await listedCard(page, { title })).id;
    const answered = await app.evaluate(
      (_electron, { taskId, cardId, answer }) => {
        const cards = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.supervisor
          .cards;
        const question = cards.messages(cardId).findLast((line) => line.who === "captain");
        if (!question) throw new Error("The captain's message is not in the thread.");
        const said = cards.replyFromCrewmate(taskId, {
          cardId,
          text: answer,
          answersMessage: question.id,
        });
        return { said, owed: cards.answerOwed(cardId) };
      },
      { taskId: TASK.id, cardId, answer: ANSWER },
    );
    expect(answered.said).toContain("Replied in the thread");
    expect(answered.owed).toBe(false);
    await expect(thread).toContainText(ANSWER);

    const pair = shownEntry(page);
    await picture(pair, "secret-card-thread-after");
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR && test.info().repeatEachIndex === 0)
      await heroShot(app, page, { region: pair, name: "app-card-asker-replies" });

    // Words left in the thread's field at Don't save ride the outcome to the asker.
    await focusOn(reply.field);
    await typeInto(reply.field, LEFT_WORDS);
    // With the thread open its buttons stay under the masked field.
    const dontSave = card.getByRole("button", {
      name: SECRET_ASK_CARD_WORDS.dontSave,
    });
    await focusOn(dontSave);
    await pressKey(dontSave, "Enter");
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => (await steersHeard(page)).find((text) => text.includes(LEFT_WORDS)))
      .toContain(CARRIED_OUT_ASKER_WORDS);
  } finally {
    await launched.close();
  }
});

// Intent: INF-6265 piece 1 and "every feature works from the keyboard": on a
// card whose own field is masked, the Reply key does what Chat does.
// Data, prerequisites and shared resources: as the journey above.
// Completion: the thread is open beside the card with the caret in its field.
test("the Reply key opens the thread on a secret card, from its masked field", async () => {
  const launched = await launchSecrets();
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, SIZE);
    await askForASecret(app);
    const title = SECRET_ASK_CARD_WORDS.title([KEY.name], false);
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    await focusOn(card.locator('[data-secret-ask-field="s1"]'));
    await pressWindowKey(app, "l", ["meta", "shift"]);
    await expect(cardReply(page).field).toBeFocused();
    await expect(cardThread(page, (await listedCard(page, { title })).id)).toBeVisible();
  } finally {
    await launched.close();
  }
});

// Intent: INF-6265 piece 1: the integration approval card for a crewmate's
// call names that crewmate's task and takes a reply in its own field, which
// reaches the crewmate that asked.
// Data: an invented GitHub call kept for an invented task through the real
// supervisor, app, renderer, IPC and task record; nothing runs the call.
// Completion: the reply reaches the asking crewmate as a steer with the app
// card's own lead.
// Prerequisites: Electron and the built renderer; no account or network.
// Shared resources: none beyond its own scratch folders.
test("the asker hears a reply on its integration approval card", async () => {
  const launched = await launchSecrets();
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, SIZE);
    const ask: IntegrationAsk = {
      id: "proof-pr",
      kind: "integration",
      integration: "github",
      connection: "c-github",
      place: "GitHub",
      action: "write",
      label: "Change something on GitHub",
      description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
      effect: "changes",
      reason: "Open the proof pull request the task asks for.",
      signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
      input: JSON.stringify({ method: "POST", path: "/repos/octo/checkout/pulls", body: "{}" }),
      at: Date.now(),
    };
    await app.evaluate(
      (_electron, { task, ask }) => {
        const services = (globalThis as SecretsJourneyGlobal).secretsJourney.core.services;
        services.tasks.create({ ...task, prompt: task.title, repoId: null });
        services.tasks.delivery.keepWriteAsk(task.id, ask);
        services.supervisor.integrationAsks.askIntegration(task.id, ask);
      },
      { task: TASK, ask },
    );
    await expect.poll(() => listedCard(page, { id: "integration-ask-proof-pr" })).toBeTruthy();
    const { title } = await listedCard(page, { id: "integration-ask-proof-pr" });
    const card = shownCard(page, title);
    await expect(card).toBeVisible();
    await expect(cardMeta(page, title)).toHaveText(TASK.title);
    const reply = cardReply(page);
    await expect(reply.field).toBeVisible();
    await picture(card, "integration-card-after");
    await focusOn(reply.field);
    await typeInto(reply.field, DRAFT);
    await pressKey(reply.field, "Enter");
    await expect
      .poll(async () => (await steersHeard(page)).find((text) => text.includes(DRAFT)))
      .toContain(THREAD_APP_CARD_PREAMBLE);
  } finally {
    await launched.close();
  }
});
