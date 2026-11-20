import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import {
  ALLOW_ONCE_LABEL,
  askWords,
  NOT_NOW_LABEL,
  RETURN_CONTROL_LABEL,
  TAKE_CONTROL_LABEL,
  toldWords,
} from "../../src/shared/taskBrowser";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import { TASK_BROWSER_TAKE_MARKER, taskBrowserJourneys } from "./scenarios/taskBrowserJourneys";
import {
  clickOnPage,
  closeSite,
  onPage,
  pageSays,
  stopTaskBrowsers,
  browserView as view,
} from "./taskBrowser";

/**
 * What a site asks for while the captain holds a task's browser
 * (docs/task-browser.md, "A site's asks"), on the built-in engine.
 * INF-4585's plan has a site's permission asks reach the captain as Allow
 * once or Not now, and a passkey request on the built-in engine end as not
 * allowed with the captain told ("Tell the site no passkey is available, so
 * it offers a password or a code, and tell me").
 *
 * The promised result: Allow once lets the page's notifications through,
 * Not now ends its clipboard read as not allowed, its passkey request ends
 * at once with a line saying so while the page is told no quiet passkey
 * request is offered (INF-5199's plan), and Return control takes the
 * permission back. The data is one page this Mac serves on a loopback port; the
 * completion signal is the page's own answers and the view's rows; it needs
 * no Mac (the built-in engine runs on Linux too) and shares nothing but the
 * hermetic launcher's throwaway home. The crewmate is the take journey's
 * script, which waits on the page until the captain takes it.
 */

const PAGE = `<!doctype html><html><head><title>Video call</title>
<style>body{background:rgb(40,90,160);color:white;font:40px sans-serif;padding:24px}button{font:inherit;margin:6px}</style></head><body>
<h1>Video call</h1>
<p><button id="notify">Turn on notifications</button> <span id="notified">Notifications not asked</span></p>
<p><button id="paste">Paste from clipboard</button> <span id="pasted">Clipboard not asked</span></p>
<p><button id="passkey">Sign in with a passkey</button> <span id="passkeyAnswer">No passkey asked</span></p>
<script>
const say = (id, words) => { document.getElementById(id).textContent = words; };
document.getElementById('notify').addEventListener('click', async () => {
  say('notified', 'Notifications: ' + await Notification.requestPermission());
});
document.getElementById('paste').addEventListener('click', () => {
  navigator.clipboard.readText().then(() => 'read', (e) => e.name).then((a) => say('pasted', 'Clipboard: ' + a));
});
document.getElementById('passkey').addEventListener('click', () => {
  navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } })
    .then(() => 'a passkey', (e) => e.name).then((a) => say('passkeyAnswer', 'Passkey answer: ' + a));
});
</script></body></html>`;

test("a site's asks reach the captain as Allow once or Not now, and a passkey ends with a line saying so", async () => {
  test.setTimeout(180_000);
  const launched = await launchApp({ withMockProvider: true, scenarios: [taskBrowserJourneys] });
  const { page, app } = launched;
  const site = createServer((request, response) => {
    // The take journey's crewmate waits for words this page never says.
    if (request.url === "/ready") {
      response.end("no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  const siteName = `127.0.0.1:${port}`;
  const title = `${TASK_BROWSER_TAKE_MARKER}${url} open`;
  const detail = async (): Promise<TaskDetail> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find((t) => t.title === wanted);
      return (row ? await window.infinitary.tasks.detail(row.id) : null) as TaskDetail;
    }, title);
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const task = await test.step("the captain takes a task's browser on the page", async () => {
      await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail().catch(() => null))?.browser, { timeout: 60_000 })
        .toMatchObject({ state: "open" });
      const opened = await detail();
      await expandDock(page, "now");
      await pressRow(page, opened.key);
      await expectRecordBody(page);
      await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
      await view(page, opened.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: TAKE_CONTROL_LABEL })
        .click();
      await expect(view(page, opened.id)).toHaveAttribute("data-browser-state", "captain", {
        timeout: 30_000,
      });
      return opened;
    });
    const shown = view(page, task.id);
    const ask = shown.locator("[data-browser-ask]");

    await test.step("Allow once lets the site's notifications through", async () => {
      await clickOnPage(app, page, task.id, url, "notify");
      await expect(ask).toHaveAttribute("data-browser-ask", "notifications");
      await expect(ask).toHaveAccessibleName(askWords({ kind: "notifications", site: siteName }));
      // The page's call waits on the captain.
      expect(await pageSays(app, url, "notified")).toBe("Notifications not asked");
      await ask.getByRole("button", { name: ALLOW_ONCE_LABEL }).click();
      await expect.poll(() => pageSays(app, url, "notified")).toBe("Notifications: granted");
      expect(await onPage(app, url, "Notification.permission")).toBe("granted");
      await expect(ask).toHaveCount(0);
    });

    await test.step("Not now ends the site's clipboard read as not allowed", async () => {
      await clickOnPage(app, page, task.id, url, "paste");
      await expect(ask).toHaveAttribute("data-browser-ask", "clipboard");
      await ask.getByRole("button", { name: NOT_NOW_LABEL }).click();
      await expect.poll(() => pageSays(app, url, "pasted")).toBe("Clipboard: NotAllowedError");
      await expect(ask).toHaveCount(0);
    });

    await test.step("a passkey request ends at once, and the view says why", async () => {
      await clickOnPage(app, page, task.id, url, "passkey");
      await expect
        .poll(() => pageSays(app, url, "passkeyAnswer"))
        .toBe("Passkey answer: NotAllowedError");
      await expect(shown.locator("[data-browser-told]")).toHaveText(
        toldWords({ kind: "passkey", site: siteName, where: "engine" }),
      );
      await expect(ask).toHaveCount(0);
      // The quiet passkey request is not offered, so a site uses its passkey button.
      expect(await onPage(app, url, "PublicKeyCredential.isConditionalMediationAvailable()")).toBe(
        false,
      );
    });

    await test.step("Return control takes the permission back", async () => {
      await shown
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: RETURN_CONTROL_LABEL })
        .click();
      await expect(shown).not.toHaveAttribute("data-browser-state", "captain");
      await expect.poll(() => onPage(app, url, "Notification.permission")).toBe("denied");
      await expect(shown.locator("[data-browser-told]")).toHaveCount(0);
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(site);
    await launched.close();
  }
});
