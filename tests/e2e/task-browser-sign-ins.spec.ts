import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WebSignIns } from "../../src/core/browser/webSignIns";
import { AUTOMATIC_SIGN_IN_LABEL, SAVED_SIGN_IN_STATUS } from "../../src/shared/taskBrowser";
import { scratchDir } from "../helpers/scratchDirs";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import { SAVED_SITE_VISIT, savedSiteTitle, savedSiteVisit } from "./scenarios/savedSiteVisit";
import { launchSecrets } from "./secretsHarness";
import { settingsSection } from "./settings";
import { browserView, closeSite, pageSays } from "./taskBrowser";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

// Approved INF-920 direction C. Fixture: a disposable club whose own-origin storage
// is its session. Signal: the real Electron page and the crewmate's actual reading.
// Desktop prerequisites only; its server, task homes and saved sign-ins are private.
// INF-1493's approved direction A: with protected storage on (disposable custody), the
// sign-ins sit last in Settings → Secrets, and Manage opens them there.
test("one site permission survives restart, signs future tasks in, and revocation leaves existing access until Remove", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<h1>Club</h1><p id="state"></p><script>document.getElementById("state").textContent=localStorage.getItem("member") ? "Signed in as Sam" : "Not signed in"</script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const site = new URL(url).host;
  const userDataDir = scratchDir("infinitary-trusted-site-");
  const store = new WebSignIns(join(userDataDir, "web-sign-ins"));
  store.save(site, {
    cookies: [],
    storage: [{ origin: new URL(url).origin, items: [["member", "Sam"]] }],
  });
  let launched = await launchSecrets({ userDataDir, scenarios: [savedSiteVisit] });
  try {
    await runFromSearch(launched.app, launched.page, "settings.secrets");
    const row = () =>
      settingsSection(launched.page, "secrets").locator(`[data-website-sign-in="${site}"]`);
    const permission = () => row().getByRole("checkbox", { name: AUTOMATIC_SIGN_IN_LABEL });
    await expect(permission()).not.toBeChecked();
    await focusOn(permission());
    await pressKey(permission(), "Space");
    await expect(permission()).toBeChecked();
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
    expect(first.outcome).toContain("Signed in as Sam");
    expect(first.browser).toMatchObject({ saved: [site] });
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
    await expect(browserView(page, first.id).locator("[data-browser-saved]")).toContainText(
      SAVED_SIGN_IN_STATUS,
    );
    await expect(browserView(page, first.id).getByRole("checkbox")).toHaveCount(0);
    const manage = browserView(page, first.id).getByRole("button", { name: "Manage", exact: true });
    await focusOn(manage);
    await pressKey(manage, "Enter");
    await expect(permission()).toBeChecked();
    await focusOn(permission());
    await pressKey(permission(), "Space");
    await expect(permission()).not.toBeChecked();
    await page.keyboard.press("Escape");
    await runFromSearch(app, page, "browser.control");
    await browserView(page, first.id).getByRole("button", { name: "Hide", exact: true }).click();
    await expect(browserView(page, first.id)).toHaveCount(0);
    const second = await visit("after-revocation");
    expect(second.outcome).toContain("Not signed in");
    expect(second.browser).not.toHaveProperty("saved");
    // Revocation stops future grants; it never signs out a browser already using the save.
    expect(await pageSays(app, `${url}?visit=first-task`, "state")).toBe("Signed in as Sam");
    console.info(
      "Saved-site permission observed",
      JSON.stringify({
        firstPage: first.outcome,
        firstBrowser: first.browser,
        revokedPage: second.outcome,
        revokedBrowser: second.browser,
      }),
    );
    await runFromSearch(app, page, "settings.secrets");
    await row().getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row()).toHaveCount(0);
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
