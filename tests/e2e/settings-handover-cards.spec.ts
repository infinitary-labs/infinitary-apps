import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claimLink } from "@core/devices/dial";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { readHomeNumber } from "../../src/core/devices/homeNumber";
import { openDatabase } from "../../src/core/storage/db";
import { KeptJobs } from "../../src/core/tasks/keptJobs";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { ACTIONS } from "../../src/shared/actions";
import { INBOX_WORDS } from "../../src/shared/integrations";
import { KEPT_ITEM_PREFIX } from "../../src/shared/keptJobs";
import { SECRETS_AREAS } from "../../src/shared/secrets";
import { connectClient } from "../helpers/connectionClient";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { handoverCard, leaveSettings, offeredCard } from "./handoverCards";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { seedPersonalWorkspace } from "./personalFixtures";
import { projectSettings } from "./projects";
import { feedLine, recordCard } from "./rails";
import {
  ASKED_WITHOUT_EVIDENCE_MARKER,
  askedWithoutEvidence,
} from "./scenarios/askedWithoutEvidence";
import { launchSecrets } from "./secretsHarness";
import { settingsSection } from "./settings";
import { expectNoCard } from "./stack";
import { pressKey, pressKeyTakingFrame } from "./windowKeys";

/**
 * INF-5326's approved plan, piece 2 (the captain: everything a person can do
 * in Settings, the first mate can do too, through one set of ways), with the
 * keyboard rule: for an act that stays the captain's click, the first mate's
 * card opens the exact place, and the first mate's show-settings and
 * show-task point the window at a place as a panel's point.openSettings and
 * point.openRecord do, through one check of what the window offers.
 * The data is the hermetic launcher's own: a disposable Secrets custody, a
 * phone that knows only the wire, a repository made in the launcher's home,
 * one seeded task, one kept job whose remove did not finish, and a panel of
 * the person's own (`tests/fixtures/panel-cards/settings-pointer`) that
 * calls point.openSettings from the captain's keys. Each step's completion
 * signal is the place opened, or for a refusal the window left as it was.
 * The computers' own cards are `device-sign-ins.spec.ts`'s, beside the
 * computer they need; the offers' refusals are
 * `src/shared/handoverActions.test.ts`'s.
 */

const POINTER = "settings-pointer";
const POINTER_FIXTURE = join(process.cwd(), "tests", "fixtures", "panel-cards", POINTER);
/** What the pointer panel says when its call to open Secrets opened nothing. */
const SECRETS_NOT_OPENED = "secrets not opened";

/**
 * Counts the links this first mate's computer makes from here on: each one is
 * the window's own request for it (`inf:devices:invite`), answered as before.
 */
async function countLinksMade(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ ipcMain }) => {
    const counted = globalThis as typeof globalThis & { linksMade?: number };
    const handlers = (
      ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
      }
    )._invokeHandlers;
    const original = handlers.get("inf:devices:invite");
    if (!original) throw new Error("Missing handler: inf:devices:invite");
    counted.linksMade = 0;
    ipcMain.removeHandler("inf:devices:invite");
    ipcMain.handle("inf:devices:invite", (event, ...args) => {
      counted.linksMade = (counted.linksMade ?? 0) + 1;
      return original(event, ...args);
    });
  });
  return () =>
    app.evaluate(() => (globalThis as typeof globalThis & { linksMade?: number }).linksMade ?? 0);
}

async function ask(page: Page, action: keyof typeof ACTIONS, value: unknown): Promise<void> {
  await askFirstmate(page, APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
}

/**
 * The panel's call to point.openSettings, from the captain's keys in its frame;
 * Settings takes the window, and the frame with it, unless the call opens nothing.
 */
async function pointAt(page: Page, section: string, item: string, opens = true): Promise<Locator> {
  const body = panelBody(page, POINTER);
  await body.locator("[data-pointer-item]").fill(item);
  const button = body.locator(`[data-pointer-open="${section}"]`);
  await (opens ? pressKeyTakingFrame(button, "Enter") : pressKey(button, "Enter"));
  return body.locator("[data-pointer-said]");
}

test("the Inbox and Secrets cards and a panel's call open their own place in Settings, by keys", async () => {
  const userDataDir = scratchDir("handover-secrets-");
  seedPersonalWorkspace(userDataDir, POINTER_FIXTURE, POINTER);
  const launched = await launchSecrets({ userDataDir });
  try {
    const { page } = launched;

    await test.step("INF-5348: the Inbox card focuses the Infinitary command's switch, with no key form or sign-in", async () => {
      await ask(page, "integration-add", { kind: "inbox" });
      const offer = offeredCard(
        "integration-add",
        { kind: "inbox" },
        { integrations: [], addable: [] },
      );
      const card = await handoverCard(page, offer);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      const integrations = settingsSection(page, "integrations");
      const toggle = integrations
        .locator("[data-inbox-section]")
        .getByRole("switch", { name: INBOX_WORDS.toggle });
      await expect(toggle).toBeFocused();
      // Turning it on stays the captain's own switch.
      await expect(toggle).not.toBeChecked();
      await expect(
        page.locator("[data-forge-key-form], [data-forge-flow], [data-device-sign-in-provider]"),
      ).toHaveCount(0);
      await leaveSettings(page);
    });

    const pageName = SECRETS_AREAS[2].value;
    const onlyOpen = async (open: string) => {
      const secrets = settingsSection(page, "secrets");
      await expect(secrets.locator(`details[data-secrets-area="${open}"]`)).toHaveAttribute(
        "open",
        "",
      );
      for (const other of SECRETS_AREAS.filter((area) => area.value !== open))
        await expect(
          secrets.locator(`details[data-secrets-area="${other.value}"]`),
        ).not.toHaveAttribute("open", "");
    };

    await test.step("a Secrets page card opens Manage on that page", async () => {
      await ask(page, "secrets-page", { page: pageName });
      const offer = offeredCard("secrets-page", { page: pageName }, null);
      const card = await handoverCard(page, offer);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      await onlyOpen(pageName);
      await leaveSettings(page);
    });

    await test.step("a panel's point.openSettings opens another Secrets page by name", async () => {
      const other = SECRETS_AREAS[0].value;
      // Settings takes the window and the panel draws afresh after it, so the place is the signal.
      await pointAt(page, "secrets", other);
      await onlyOpen(other);
      await leaveSettings(page);
    });
  } finally {
    await launched.close();
  }
});

test("the phone and kept-job cards, a panel's calls and the asked lines point at their place, and refusals open nothing", async () => {
  const userDataDir = scratchDir("handover-cards-");
  const db = openDatabase(userDataDir);
  const task = (() => {
    try {
      return seedTask(new TaskService({ db, strict: true }), {
        id: "handover-record",
        title: "Write the harbour charts guide",
        status: "queued",
        startPolicy: "on-request",
      });
    } finally {
      db.close();
    }
  })();
  // A job kept running past its task's close whose remove did not finish.
  const folder = join(userDataDir, "kept", "task-9-s1");
  mkdirSync(folder, { recursive: true });
  const jobs = new KeptJobs(join(userDataDir, "kept", "jobs.json"));
  jobs.record(
    [
      {
        id: "s1",
        label: "Weekly photo sync",
        check: "true",
        remove: "exit 3",
        folder,
        account: "captain",
      },
    ],
    { computer: null, task: "task-9", key: "INF-9" },
  );
  jobs.note(null, folder, { removeFailed: { at: 1, outcome: "failed", exitCode: 3 } });
  seedPersonalWorkspace(userDataDir, POINTER_FIXTURE, POINTER);
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [askedWithoutEvidence],
  });
  try {
    const { page } = launched;
    const settings = page.locator("[data-settings-column]");
    const linksMade = await countLinksMade(launched.app);

    const phone =
      await test.step("the phone card makes no link before its click or after Not now, and Make a link shows the code", async () => {
        const offer = offeredCard("device-invite", { how: "phone" }, []);
        await ask(page, "device-invite", { how: "phone" });
        let card = await handoverCard(page, offer);
        expect(await linksMade()).toBe(0);
        await pressKey(card.getByRole("button", { name: offer.decline, exact: true }), "Enter");
        await expectNoCard(page, offer.title);
        await expect(settings).toHaveCount(0);
        expect(await linksMade()).toBe(0);

        await ask(page, "device-invite", { how: "phone" });
        card = await handoverCard(page, offer);
        await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
        const panel = page.locator('[data-panel-state="open"]');
        await expect(panel.locator("[data-phone-code]")).toBeVisible();
        // The one link the first mate's own computer made is the captain's click's.
        expect(await linksMade()).toBe(1);
        const link = await panel.locator("[data-device-link]").innerText();
        const joined = await claimLink(link, { kind: "mac", name: "Test iPhone", system: "ios" });
        await expect(page.locator('[data-panel-state="joined"]')).toContainText("Test iPhone");
        await leaveSettings(page);
        return joined;
      });

    await test.step("the kept-job card opens Automation at its row, where only Forget takes it off", async () => {
      const id = "task-9-s1";
      const current = await page.evaluate(() => window.infinitary.automation.kept());
      const offer = offeredCard("kept-job-forget", { id }, current);
      await ask(page, "kept-job-forget", { id });
      const card = await handoverCard(page, offer);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      const row = settingsSection(page, "automation").locator(`[data-kept-job="${id}"]`);
      // It arrives on the row's Check, the first of its own buttons, with Forget beside it.
      await expect(row.locator("[data-kept-check]")).toBeFocused();
      await expect(row.locator("[data-kept-forget]")).toBeVisible();
      // Still kept: the card only opened the row.
      expect(jobs.list().map((job) => job.label)).toEqual(["Weekly photo sync"]);
      expect(offer.arrival).toEqual({ section: "automation", item: `${KEPT_ITEM_PREFIX}${id}` });
      await leaveSettings(page);
    });

    const { repo } = await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "harbour", key: "HAR" }),
    );

    await test.step("a panel's point.openSettings opens a project by key, a computer by id, and a section with an unknown item as it is", async () => {
      // Settings takes the window and the panel draws afresh after it, so the place is the signal.
      await pointAt(page, "projects", "HAR");
      await expect(projectSettings(page, repo.id)).toBeVisible();
      await leaveSettings(page);

      await pointAt(page, "devices", phone.deviceId);
      await expect(page.locator(`[data-device-row="${phone.deviceId}"]`)).toBeVisible();
      await leaveSettings(page);

      await pointAt(page, "projects", "NO-SUCH-PROJECT");
      await expect(settingsSection(page, "projects")).toBeVisible();
      await expect(projectSettings(page, repo.id)).toHaveCount(0);
      await leaveSettings(page);
    });

    await test.step("a section this window does not offer opens nothing, from a panel or the first mate", async () => {
      // Without protected storage this launch offers no Secrets.
      await expect(await pointAt(page, "secrets", "history", false)).toHaveText(SECRETS_NOT_OPENED);
      await expect(settings).toHaveCount(0);
      await ask(page, "show-settings", { section: "secrets", item: "history" });
      await expect(
        feedLine(page, ACTIONS["show-settings"].done({ section: "secrets" })),
      ).toBeVisible();
      await expect(settings).toHaveCount(0);
    });

    await test.step("show-settings chooses a computer's row in Devices and opens a project by key", async () => {
      await ask(page, "show-settings", { section: "devices", item: phone.deviceId });
      await expect(page.locator(`[data-device-row="${phone.deviceId}"]`)).toBeVisible();
      await leaveSettings(page);
      await ask(page, "show-settings", { section: "projects", item: "HAR" });
      await expect(projectSettings(page, repo.id)).toBeVisible();
      await leaveSettings(page);
    });

    await test.step("an asked line with none of the captain's words as its evidence opens nothing and says nothing", async () => {
      for (const [action, value, line] of [
        [
          "show-task",
          { task: task.key },
          ACTIONS["show-task"].done({ key: task.key, title: task.title }),
        ],
        [
          "show-settings",
          { section: "projects", item: "HAR" },
          ACTIONS["show-settings"].done({ section: "projects" }),
        ],
      ] as const) {
        // The earlier steps' own asks wrote these lines already; a refused ask adds none.
        const before = await feedLine(page, line).count();
        await askFirstmate(page, ASKED_WITHOUT_EVIDENCE_MARKER + JSON.stringify({ action, value }));
        await expect(recordCard(page)).toHaveCount(0);
        await expect(settings).toHaveCount(0);
        await expect(feedLine(page, line)).toHaveCount(before);
      }
    });

    await test.step("show-task opens the task's record by its key with one feed line, and an unknown key opens nothing", async () => {
      await ask(page, "show-task", { task: "HAR-404" });
      await expect(recordCard(page)).toHaveCount(0);
      await expect(feedLine(page, ACTIONS["show-task"].done({ key: "HAR-404" }))).toHaveCount(0);
      await ask(page, "show-task", { task: task.key });
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expect(
        feedLine(page, ACTIONS["show-task"].done({ key: task.key, title: task.title })),
      ).toBeVisible();
    });

    await test.step("once a window tells it of a second first mate with its number, the keep-one card opens Devices at that question", async () => {
      // The phone that joined hears another home answer with this one's number after another
      // takeover, and tells this one, as a window does (docs/devices.md, "Two homes with one number").
      const client = await connectClient(phone, { as: "view" });
      try {
        const told = await client.invoke("inf:standby:other-home", [
          {
            name: "Mac Studio",
            homeNumber: readHomeNumber(join(userDataDir, "devices")),
            takeOver: randomUUID(),
            addresses: ["127.0.0.1:9"],
          },
        ]);
        expect(told).toEqual({ ok: true });
      } finally {
        await client.close();
      }
      const current = await page.evaluate(() => window.infinitary.devices.standby.list());
      const offer = offeredCard("keep-home", {}, current);
      await ask(page, "keep-home", {});
      const card = await handoverCard(page, offer);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      const question = settingsSection(page, "devices").locator("[data-keep-home]");
      await expect(question).toBeVisible();
      // Keeping one stays the captain's own button: both still answer.
      expect(
        (await page.evaluate(() => window.infinitary.devices.standby.list())).twoHomes,
      ).toEqual(current.twoHomes);
      await leaveSettings(page);
    });
  } finally {
    await launched.close();
  }
});
