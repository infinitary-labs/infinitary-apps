import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { INBOX_WORDS, INTEGRATION_KIND_NAMES } from "@shared/integrations";
import { decode } from "@toon-format/toon";
import { INBOX_COMMAND, INBOX_EVENT, INBOX_FENCE } from "../../src/core/integrations";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { type AutomationEventsSeen, automationEvents } from "./scenarios/automationEvents";
import { settingsSection } from "./settings";
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

  // Turning the inbox on turned its rule on too (the captain's word on INF-1214), named in the box.
  await expect(door).toContainText(INBOX_WORDS.ruleLead(INBOX_WORDS.ruleName));
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
  expect(seen.turns[0]).toContain(
    `on 1 new event - ${INBOX_EVENT.label} in ${INTEGRATION_KIND_NAMES.inbox}`,
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

  // Turned off and on again, the one rule listens again rather than a second one.
  await focusOn(toggle);
  await pressKey(toggle, "Space");
  await expect(section).toHaveAttribute("data-inbox-section", "off");
  await pressKey(toggle, "Space");
  await expect(door).toBeVisible();
  await expect
    .poll(async () =>
      (await page.evaluate(async () => (await window.infinitary.automation.list()).rules)).map(
        (rule) => [rule.name, rule.state, rule.stopped ?? null],
      ),
    )
    .toEqual([[INBOX_WORDS.ruleName, "enabled", null]]);
  const again = await sh(line, process.env.PATH ?? "");
  expect(again.exitCode).toBe(0);
  await expect.poll(() => seen.turns.length, { timeout: 30_000 }).toBe(2);
});
