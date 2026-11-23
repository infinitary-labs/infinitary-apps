import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WebSignIns } from "../../src/core/browser/webSignIns";
import {
  ASK_EACH_TIME_LABEL,
  KEPT_PARTITION,
  SIGN_IN_RULE_LABEL,
  USE_WITHOUT_ASKING_LABEL,
} from "../../src/shared/taskBrowser";
import { scratchDir } from "../helpers/scratchDirs";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import { SAVED_SITE_VISIT, savedSiteTitle, savedSiteVisit } from "./scenarios/savedSiteVisit";
import { launchSecrets } from "./secretsHarness";
import { settingsSection } from "./settings";
import { browserView, closeSite, pageCookieNames } from "./taskBrowser";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

// Approved INF-920 direction C, with INF-4585's kept profile. Fixture: a
// disposable club whose cookie is its session, signed in once in this
// computer's kept profile. Signal: the real Electron page and the crewmate's
// actual reading. Desktop prerequisites only; its server, task homes and
// kept profile are private. INF-1493's approved direction A: with protected
// storage on (disposable custody), the sign-ins sit last in Settings →
// Secrets, and Manage opens them there.
test("a site's rule survives restart, signs future tasks in by itself, and Ask me each time leaves an open browser signed in until Remove", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const member = /(?:^|;\s*)member=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    response.end(
      `<h1>Club</h1><p id="state">${member ? `Signed in as ${member}` : "Not signed in"}</p>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const site = new URL(url).host;
  const userDataDir = scratchDir("infinitary-trusted-site-");
  // The captain signed in to the club in the kept profile once, under Ask me each time.
  new WebSignIns(join(userDataDir, "web-sign-ins")).record(site, { automatic: false });
  let launched = await launchSecrets({ userDataDir, scenarios: [savedSiteVisit] });
  try {
    await launched.app.evaluate(
      async ({ session }, { partition, address }) => {
        const kept = session.fromPartition(partition);
        await kept.cookies.set({
          url: address,
          name: "member",
          value: "Sam",
          expirationDate: Math.floor(Date.now() / 1000) + 86_400,
        });
        await kept.cookies.flushStore();
      },
      { partition: KEPT_PARTITION, address: url },
    );
    await runFromSearch(launched.app, launched.page, "settings.secrets");
    const row = () =>
      settingsSection(launched.page, "secrets").locator(`[data-website-sign-in="${site}"]`);
    const rule = () => row().getByRole("combobox", { name: SIGN_IN_RULE_LABEL });
    // INF-4867: the site shows its saved rule before opening the editor.
    const openSiteRule = async (label: string) => {
      const disclosure = row().locator("details");
      const summary = disclosure.locator(":scope > summary");
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(label);
      if ((await disclosure.getAttribute("open")) === null) await pressKey(summary, "Enter");
      await expect(rule()).toBeVisible();
    };
    await openSiteRule(ASK_EACH_TIME_LABEL);
    await expect(rule()).toHaveValue("ask");
    await focusOn(rule());
    await rule().selectOption("automatic");
    await expect(rule()).toHaveValue("automatic");
    await launched.page.getByRole("tab", { name: "General", exact: true }).click();
    await expect(settingsSection(launched.page, "general")).toBeVisible();
    await expect(launched.page.locator("[data-website-sign-ins]")).toHaveCount(0);
    await launched.close();
    launched = await launchSecrets({ userDataDir, scenarios: [savedSiteVisit] });
    const { app, page } = launched;
    const visit = async (name: string) => {
      const address = `${url}?visit=${name}`;
      const title = savedSiteTitle(address);
      await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${SAVED_SITE_VISIT}${address}`);
      await promptInput(page).press("Enter");
      const detail = async () => {
        const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title === title,
        );
        return task ? page.evaluate((id) => window.infinitary.tasks.detail(id), task.id) : null;
      };
      await expect
        .poll(async () => (await detail())?.outcome, { timeout: 60_000 })
        .toContain('text "');
      const task = await detail();
      if (!task) throw new Error("The club visit has no task");
      return task;
    };
    const first = await visit("first-task");
    // The rule outlived the restart, and the crewmate's own open used the kept sign-in.
    expect(first.outcome).toContain("Signed in as Sam");
    expect(first.browser).toMatchObject({ saved: [site], kept: true });
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).filter(
        (card) => card.taskId === first.id,
      ),
    ).toEqual([]);
    await expandDock(page, "now");
    await pressRow(page, first.key);
    await expectRecordBody(page);
    await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
    await runFromSearch(app, page, "browser.control");
    const picker = browserView(page, first.id).locator("[data-browser-rule]");
    await expect(picker.getByRole("radio", { name: USE_WITHOUT_ASKING_LABEL })).toBeChecked();
    const manage = browserView(page, first.id).getByRole("button", { name: "Manage", exact: true });
    await focusOn(manage);
    await pressKey(manage, "Enter");
    await openSiteRule(USE_WITHOUT_ASKING_LABEL);
    await expect(rule()).toHaveValue("automatic");
    await focusOn(rule());
    await rule().selectOption("ask");
    await expect(rule()).toHaveValue("ask");
    await page.keyboard.press("Escape");
    await runFromSearch(app, page, "browser.control");
    await browserView(page, first.id).getByRole("button", { name: "Hide", exact: true }).click();
    await expect(browserView(page, first.id)).toHaveCount(0);
    const second = await visit("after-ask");
    expect(second.outcome).toContain("Not signed in");
    expect(second.browser).not.toHaveProperty("saved");
    expect(second.browser).not.toHaveProperty("kept");
    // Ask me each time stops later grants; it never signs out a browser already using the profile.
    expect(await pageCookieNames(app, `${url}?visit=first-task`)).toContain("member");
    console.info(
      "Signed-in site rule observed",
      JSON.stringify({
        firstPage: first.outcome,
        firstBrowser: first.browser,
        askedPage: second.outcome,
        askedBrowser: second.browser,
      }),
    );
    await runFromSearch(app, page, "settings.secrets");
    await openSiteRule(ASK_EACH_TIME_LABEL);
    await expect(rule()).toHaveValue("ask");
    expect(await rule().locator("option").allTextContents()).toEqual([
      ASK_EACH_TIME_LABEL,
      USE_WITHOUT_ASKING_LABEL,
    ]);
    await row().getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row()).toHaveCount(0);
    await expect
      .poll(() => pageCookieNames(app, `${url}?visit=first-task`))
      .not.toContain("member");
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.infinitary.tasks.detail(id), first.id)).browser,
      )
      .not.toMatchObject({ saved: [site] });
    await page.evaluate((id) => window.infinitary.browser.stop(id), first.id);
    expect((await page.evaluate(() => window.infinitary.browser.signIns())).signIns).toEqual([]);
  } finally {
    await launched.close();
    await closeSite(server);
  }
});
