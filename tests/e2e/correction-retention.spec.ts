import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CORRECTION_OFFER_WORDS } from "@shared/correctionWords";
import {
  DECISION_APPROVAL_VERSION,
  DECISION_FIRST_APPROVAL_VERSION,
  decisionUse,
} from "@shared/decisionUses";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { DECISION_USES_WORDS, MODELS_WORDS } from "../../src/renderer/src/settings/modelsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { openModelsBoard } from "./modelsBoard";
import { seedProject } from "./projectSeed";
import { readKnowledgeData } from "./savedData";
import {
  CORRECTION_CAPTION,
  CORRECTION_EXPLICIT,
  CORRECTION_PROJECT,
  CORRECTION_REVISED,
  CORRECTION_REWORD,
  CORRECTION_RULE,
  type CorrectionRetentionSeen,
  correctionRetention,
} from "./scenarios/correctionRetention";
import { cardReply, putAwayAndRestore, showCard, shownEntry } from "./stack";
import { pressKey } from "./windowKeys";

/** Intent: the accepted separate, project-only retention offer uses ordinary
 * keyboard/card behavior, exact saved data and restart recovery. The named
 * stand-in proves plumbing, never recognition or real model obedience. */
function seed(replyChecks: boolean): string {
  const dir = scratchDir("correction-retention-");
  const folder = join(dir, "harbor");
  mkdirSync(folder, { recursive: true });
  const db = openDatabase(dir);
  try {
    seedProject(db, { ...CORRECTION_PROJECT, path: folder, setupKind: "adopt", runsOn: null });
    // Reply checks start on; a person may have switched them off.
    if (!replyChecks) new SettingsStore(db).setDecisionUses({ "reply-checks": { on: false } });
  } finally {
    db.close();
  }
  return dir;
}
function directions(dir: string): { id: string; scope: string; text: string; revision: number }[] {
  return readKnowledgeData(dir, (db) =>
    db.prepare("SELECT id, scope, text, revision FROM directions").all(),
  ) as { id: string; scope: string; text: string; revision: number }[];
}
const seen = (): CorrectionRetentionSeen => ({ questions: [], saved: [] });
async function open(dir: string, readings: CorrectionRetentionSeen): Promise<LaunchedApp> {
  return launchApp({
    userDataDir: dir,
    withMockProvider: true,
    scenarios: [correctionRetention(readings)],
  });
}

test("a wording reply and restart keep one exact project direction through the keyboard", async () => {
  const dir = seed(true);
  const readings = seen();
  let running = await open(dir, readings);
  try {
    await askFirstmate(running.page, CORRECTION_CAPTION);
    await showCard(running.page, CORRECTION_OFFER_WORDS.title);
    await expect(
      cardBody(running.page, CORRECTION_OFFER_WORDS.title).getByText(CORRECTION_RULE, {
        exact: true,
      }),
    ).toBeVisible();
    expect(directions(dir)).toEqual([]);
    const original = await running.page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((card) => card.title === title)?.id,
      CORRECTION_OFFER_WORDS.title,
    );
    const reply = cardReply(running.page);
    await reply.field.fill(CORRECTION_REWORD);
    await pressKey(reply.send, "Enter");
    await expect(
      cardBody(running.page, CORRECTION_OFFER_WORDS.title).getByText(CORRECTION_REVISED, {
        exact: true,
      }),
    ).toBeVisible();
    expect(directions(dir)).toEqual([]);
    await running.close();
    running = await open(dir, readings);
    await showCard(running.page, CORRECTION_OFFER_WORDS.title);
    const restored = await running.page.evaluate(
      async (title) =>
        (await window.infinitary.cards.list()).find((card) => card.title === title)?.id,
      CORRECTION_OFFER_WORDS.title,
    );
    expect(restored).toBe(original);
    await pressKey(
      shownEntry(running.page).getByRole("button", {
        name: CORRECTION_OFFER_WORDS.keep,
        exact: true,
      }),
      "Enter",
    );
    await expect
      .poll(() => directions(dir).map(({ scope, text }) => ({ scope, text })))
      .toEqual([{ scope: CORRECTION_PROJECT.id, text: CORRECTION_REVISED }]);
    await expect.poll(() => readings.saved.length).toBeGreaterThan(0);
    const stored = directions(dir);
    await running.close();
    running = await open(dir, readings);
    expect(directions(dir)).toEqual(stored);
  } finally {
    await running.close();
  }
});

test("aside leaves the independent offer pending and Just this time saves nothing", async () => {
  const dir = seed(true);
  const running = await open(dir, seen());
  try {
    await askFirstmate(running.page, CORRECTION_CAPTION);
    await showCard(running.page, CORRECTION_OFFER_WORDS.title);
    expect(directions(dir)).toEqual([]);
    await putAwayAndRestore(running.page, CORRECTION_OFFER_WORDS.title);
    expect(directions(dir)).toEqual([]);
    await pressKey(
      shownEntry(running.page).getByRole("button", {
        name: CORRECTION_OFFER_WORDS.decline,
        exact: true,
      }),
      "Enter",
    );
    expect(directions(dir)).toEqual([]);
    await expect
      .poll(() =>
        running.page.evaluate(
          async (title) =>
            (await window.infinitary.cards.list()).filter(
              (card) => card.title === title && !card.ended,
            ).length,
          CORRECTION_OFFER_WORDS.title,
        ),
      )
      .toBe(0);
  } finally {
    await running.close();
  }
});

test("an explicit keep request retains the existing writer while automatic reply checks are off", async () => {
  const dir = seed(false);
  const readings = seen();
  const running = await open(dir, readings);
  try {
    await askFirstmate(running.page, CORRECTION_EXPLICIT);
    await expect
      .poll(() => directions(dir).map(({ scope, text }) => ({ scope, text })))
      .toEqual([{ scope: CORRECTION_PROJECT.id, text: CORRECTION_RULE }]);
    expect(readings.questions).toEqual([]);
    expect(
      await running.page.evaluate(
        async (title) =>
          (await window.infinitary.cards.list()).some((card) => card.title === title),
        CORRECTION_OFFER_WORDS.title,
      ),
    ).toBe(false);
  } finally {
    await running.close();
  }
});

test("an older Jev approval asks once from the keyboard, beside the locked task classification", async () => {
  // Intent: the captain's plan - every decision model use has its own switch,
  // task classification's is locked on, reply checks turn off and on, and a
  // person who turned Jev on under the first approval screen is asked once,
  // in the consent dialog, before reply checks reach Jev.
  const dir = seed(true);
  const accountId = "reply-checks-fixture";
  seedAccountStore(dir, "openai-codex", accountId, { recursive: true, mode: 0o700 });
  seedAccountAuth(
    dir,
    "openai-codex",
    accountId,
    {
      "openai-codex": {
        type: "oauth",
        access: "stand-in-access",
        refresh: "stand-in-refresh",
        expires: Date.now() + 86_400_000,
      },
    },
    { mode: 0o600 },
  );
  seedAccountRegistry(
    dir,
    [
      {
        id: accountId,
        providerId: "openai-codex",
        label: "Standard",
        kind: "subscription_oauth",
        createdAt: Date.now(),
        enabled: true,
      },
    ],
    {},
    { mode: 0o600 },
  );
  const kind = decisionUse("kind");
  const replyChecks = decisionUse("reply-checks");
  if (!kind || !replyChecks) throw new Error("Both uses are listed");
  const readings = seen();
  const running = await open(dir, readings);
  const decisions = () => running.page.evaluate(() => window.infinitary.models.decisions());
  const switchOf = (view: Awaited<ReturnType<typeof decisions>>, id: string) =>
    view.uses?.find((use) => use.id === id)?.on;
  try {
    // Turned on the way the first approval screen did, from an older computer.
    await running.page.evaluate(async (approval) => {
      await window.infinitary.models.setDecisionKey("jev", "ts-stand-in-key-0000000000");
      await window.infinitary.models.setDecisions({
        version: 1,
        answerer: { kind: "native", id: "jev" },
        egress: { jev: { enabled: true, consentedVersion: approval } },
      });
    }, DECISION_FIRST_APPROVAL_VERSION);
    await pressKey(running.page.getByRole("button", { name: "Settings", exact: true }), "Enter");
    await pressKey(running.page.getByRole("tab", { name: "Intelligence", exact: true }), "Enter");
    const models = await openModelsBoard(running.page);
    const uses = models.getByRole("region", { name: DECISION_USES_WORDS.group, exact: true });
    const locked = uses.getByRole("switch", { name: kind.name, exact: true });
    const replies = uses.getByRole("switch", { name: replyChecks.name, exact: true });

    await pressKey(
      models.getByRole("button", { name: "Decision model actions", exact: true }),
      "Tab",
    );
    await expect(locked).toBeFocused();
    await expect(locked).toHaveAttribute("aria-checked", "true");
    await expect(locked).toHaveAttribute("aria-disabled", "true");
    await expect(locked).toHaveAccessibleDescription(DECISION_USES_WORDS.locked);
    await pressKey(locked, "Space");
    await expect(locked).toHaveAttribute("aria-checked", "true");
    expect(switchOf(await decisions(), kind.id)).toBe(true);

    await pressKey(locked, "Tab");
    await expect(replies).toBeFocused();
    await expect(replies).toHaveAttribute("aria-checked", "false");
    await expect(uses).toContainText(DECISION_USES_WORDS.needsApproval("Jev"));
    await pressKey(replies, "Space");
    const dialog = running.page.getByRole("dialog", {
      name: DECISION_USES_WORDS.allowTitle(replyChecks.name, "Jev"),
      exact: true,
    });
    await expect(dialog).toBeVisible();
    // Intent: the captain asked the screen to say what is shared, the choice and the cost.
    await expect(dialog.getByRole("term")).toHaveText([...MODELS_WORDS.decisionDisclosureLabels]);
    const notNow = dialog.getByRole("button", { name: "Not now", exact: true });
    await expect(notNow).toBeFocused();
    await running.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(replies).toBeFocused();
    expect((await decisions()).settings.egress.jev?.consentedVersion).toBe(
      DECISION_FIRST_APPROVAL_VERSION,
    );
    await expect(replies).toHaveAttribute("aria-checked", "false");

    await pressKey(replies, "Space");
    await expect(notNow).toBeFocused();
    await running.page.keyboard.press("Tab");
    const allow = dialog.getByRole("button", { name: DECISION_USES_WORDS.allow, exact: true });
    await expect(allow).toBeFocused();
    await running.page.keyboard.press("Tab");
    await expect(notNow).toBeFocused();
    await running.page.keyboard.press("Shift+Tab");
    await expect(allow).toBeFocused();
    await running.page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => (await decisions()).settings.egress.jev)
      .toEqual({ enabled: true, consentedVersion: DECISION_APPROVAL_VERSION });
    await expect(replies).toHaveAttribute("aria-checked", "true");
    await expect(uses).not.toContainText(DECISION_USES_WORDS.needsApproval("Jev"));

    // Off and on again, with no dialog: the approval now covers every use.
    await pressKey(replies, "Space");
    await expect.poll(async () => switchOf(await decisions(), replyChecks.id)).toBe(false);
    await expect(replies).toHaveAttribute("aria-checked", "false");
    await pressKey(replies, "Space");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => switchOf(await decisions(), replyChecks.id)).toBe(true);
    await expect(replies).toHaveAttribute("aria-checked", "true");
    expect(readings.questions).toEqual([]);
  } finally {
    await running.close();
  }
});
