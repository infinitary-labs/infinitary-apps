import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { INBOX_WORDS, INTEGRATION_KIND_NAMES } from "@shared/integrations";
import { decode } from "@toon-format/toon";
import { INBOX_COMMAND, INBOX_EVENT, INBOX_FENCE } from "../../src/core/integrations";
import { NOTICE_WORDS } from "../../src/core/orchestrator/noticeWakes";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { type AutomationEventsSeen, automationEvents } from "./scenarios/automationEvents";
import { settingRow, settingsSection } from "./settings";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

/**
 * INF-1214, direction A (the captain's "Approve and build" with all seven
 * recommended answers): a program on this computer drops a freeform event
 * into the inbox and the first mate wakes on it as evidence from outside.
 *
 * - Promised result: the inbox's own section, off at first, says what it
 *   is (the captain's reply: "it should be its own section, and default
 *   it's off"); turned on and linked from Settings by keys alone, its rule turned on with it (the captain's reply: "once the user
 *   adds this integration, it should automatically turn on the automation
 *   rule"); the line Settings shows, run by
 *   `sh` as a script would, answers a receipt at once; the first mate's
 *   turn carries the event fenced; the receipts then read it handled.
 *   INF-1567, the captain's direction C ("the switch is the pause, and
 *   Delete moves to Data"): off, scripts get an error and the key and
 *   notes stay; the box says when the rule is paused or gone in
 *   Automation, never "told at once" when it is false (their q4); Delete
 *   in the Data section removes the notes and the key.
 * - Data: one deploy notice with a request id and a source, the way a CI
 *   script would send it.
 * - Completion signal: the link on disk, the rule's saved state, the first
 *   mate turn the stand-in model served, then the receipts' handled line.
 * - Platform prerequisites: `/bin/sh` and the system's curl, which the
 *   launcher uses; nothing else beyond the hermetic launcher.
 * - Shared resources: none; the link goes into a scratch folder through
 *   `INFINITARY_INBOX_LINK_DIR`, never the real `/usr/local/bin`.
 */

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** A line run by `sh` as a person's own script runs it. */
function sh(line: string, path: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((done) => {
    execFile(
      "/bin/sh",
      ["-c", line],
      { env: { PATH: path, HOME: process.env.HOME } },
      (error, stdout) =>
        done({ stdout, exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

test("a program's drop wakes the first mate through the inbox turned on by keys", async () => {
  const linkDir = scratchDir("infinitary-inbox-link-");
  const seen: AutomationEventsSeen = { turns: [] };
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [automationEvents(seen)],
    env: { INFINITARY_INBOX_LINK_DIR: linkDir },
  });
  const { app, page } = launched;

  await runFromSearch(app, page, "settings.integrations");
  const tab = settingsSection(page, "integrations");
  // Its own section, off until the person turns it on, says what it is.
  const section = tab.locator("[data-inbox-section]");
  await expect(section).toHaveAttribute("data-inbox-section", "off");
  await expect(section).toContainText(INBOX_WORDS.intro);
  await expect(section).toContainText(INBOX_WORDS.off);
  await expect(tab.locator('[data-integration-add="inbox"]')).toHaveCount(0);
  const toggle = section.getByRole("switch", { name: INBOX_WORDS.toggle });
  await focusOn(toggle);
  await pressKey(toggle, "Space");
  await expect(section).toHaveAttribute("data-inbox-section", "on");
  const door = tab.locator("[data-inbox-door]");
  await expect(door).toBeVisible();
  await expect(door).toContainText(INBOX_WORDS.exampleNote);

  // The short name's link, by one press, into the folder this run names.
  const link = door.getByRole("button", { name: INBOX_WORDS.link });
  await focusOn(link);
  await pressKey(link, "Enter");
  const linked = join(linkDir, INBOX_COMMAND);
  await expect(door.locator('[data-inbox-link="linked"]')).toContainText(
    INBOX_WORDS.linked(linked),
  );
  const line = (await door.locator("[data-inbox-line]").textContent()) ?? "";
  const command = readlinkSync(linked);
  expect(line).toContain(command);

  // Turning the inbox on turned its rule on too (the captain's word on INF-1214), so the box says it tells.
  const ruleLine = door.locator("[data-inbox-rule]");
  await expect(ruleLine).toHaveAttribute("data-inbox-rule", "told");
  await expect(ruleLine).toContainText(`${INBOX_WORDS.told} ${INBOX_WORDS.offKeeps}`);
  await expect
    .poll(async () =>
      (await page.evaluate(async () => (await window.infinitary.automation.list()).rules)).map(
        (rule) => [rule.name, rule.state],
      ),
    )
    .toEqual([[INBOX_WORDS.ruleName, "enabled"]]);

  // The line as Settings shows it, with a request id and a source, answers at once.
  const words = "Deploy of the website finished";
  const dropLine = line.replace(
    /note "[^"]*"$/,
    `note --request-id deploy-7 --source ci "${words}"`,
  );
  const dropped = await sh(dropLine, process.env.PATH ?? "");
  expect(dropped.exitCode).toBe(0);
  const receipt = decode(dropped.stdout.split("\nhelp")[0] ?? "") as {
    event: string;
    recorded: boolean;
    listening: number;
  };
  expect(receipt).toMatchObject({ recorded: true, listening: 1 });

  await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(1);
  expect(seen.turns[0]).toContain(`from ci: ${words}`);
  expect(seen.turns[0]).toContain(INBOX_FENCE);
  // The wake the first mate's notices word for the inbox rule's one event,
  // up to the rule's prompt, which carries the event fenced (above).
  const [told] = await page.evaluate(async () => (await window.infinitary.automation.list()).rules);
  if (!told) throw new Error("turning the inbox on added no rule");
  expect(seen.turns[0]).toContain(
    NOTICE_WORDS.scheduled(
      {
        kind: "scheduled",
        prompt: "",
        catchUp: false,
        captainRequested: told.captainRequested,
        events: {
          integration: INTEGRATION_KIND_NAMES.inbox,
          label: INBOX_EVENT.label,
          count: 1,
        },
        rule: { id: told.id, ...(told.name ? { name: told.name } : {}) },
      },
      { ways: [], text: "" },
    ),
  );

  // Once the turn handled it, the receipts read it handled, by the short name.
  const receiptsLine = line.replace(
    /'[^']*infinitary-inbox-axi' note "[^"]*"$/,
    `${INBOX_COMMAND} receipts`,
  );
  await expect
    .poll(
      async () => {
        const read = await sh(receiptsLine, `${linkDir}:${process.env.PATH ?? ""}`);
        const answer = decode(read.stdout.split("\nhelp")[0] ?? "") as {
          receipts?: { event: string; state: string }[];
        };
        return (answer.receipts ?? []).map((row) => [row.event, row.state]);
      },
      { timeout: 30_000 },
    )
    .toEqual([
      [receipt.event, "recorded"],
      [receipt.event, "handled"],
    ]);
  expect(seen.turns).toHaveLength(1);

  const rules = () => page.evaluate(async () => (await window.infinitary.automation.list()).rules);

  // The rule paused in Automation: the box says the first mate is not told.
  const [rule] = await rules();
  if (!rule) throw new Error("turning the inbox on added no rule");
  await page.evaluate((id) => window.infinitary.automation.setState(id, "pause"), rule.id);
  await expect(ruleLine).toHaveAttribute("data-inbox-rule", "paused");
  await expect(ruleLine).toContainText(INBOX_WORDS.rulePaused(INBOX_WORDS.ruleName));
  await expect(ruleLine).not.toContainText(INBOX_WORDS.told);
  await page.evaluate((id) => window.infinitary.automation.setState(id, "resume"), rule.id);
  await expect(ruleLine).toHaveAttribute("data-inbox-rule", "told");

  // Switched off, scripts get an error, and the key and the notes stay.
  await focusOn(toggle);
  await pressKey(toggle, "Space");
  await expect(section).toHaveAttribute("data-inbox-section", "off");
  await expect(section.locator('[data-inbox-off="kept"]')).toContainText(INBOX_WORDS.offKept);
  const refused = await sh(line, process.env.PATH ?? "");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stdout).toContain("The inbox is off");

  // On again, the same line works, the one rule listens, and the first note is still there.
  await pressKey(toggle, "Space");
  await expect(door).toBeVisible();
  expect(await door.locator("[data-inbox-line]").textContent()).toBe(line);
  expect((await rules()).map((entry) => [entry.name, entry.state, entry.stopped ?? null])).toEqual([
    [INBOX_WORDS.ruleName, "enabled", null],
  ]);
  const again = await sh(line, process.env.PATH ?? "");
  expect(again.exitCode).toBe(0);
  await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(2);
  const kept = await sh(receiptsLine, `${linkDir}:${process.env.PATH ?? ""}`);
  expect(kept.stdout).toContain(receipt.event);

  // The rule deleted in Automation: the box says no rule listens.
  await page.evaluate((id) => window.infinitary.automation.delete(id), rule.id);
  await expect(ruleLine).toHaveAttribute("data-inbox-rule", "none");
  await expect(ruleLine).toContainText(INBOX_WORDS.noRule);

  // Delete in the Data section, confirmed by keys: the notes and the key go, and the inbox is off.
  const remove = settingRow(page, "delete-inbox-notes");
  await expect(remove).toContainText(INBOX_WORDS.deleteTitle);
  const deleteButton = remove.getByRole("button", { name: INBOX_WORDS.delete });
  await focusOn(deleteButton);
  await pressKey(deleteButton, "Enter");
  const confirm = remove.getByRole("button", { name: INBOX_WORDS.confirm });
  await focusOn(confirm);
  await pressKey(confirm, "Enter");
  await expect(section.locator('[data-inbox-off="new"]')).toContainText(INBOX_WORDS.off);
  await expect(remove).toHaveCount(0);
  const gone = await sh(line, process.env.PATH ?? "");
  expect(gone.exitCode).not.toBe(0);
});
