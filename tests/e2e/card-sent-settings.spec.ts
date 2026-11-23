import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { DECLINE_ACTION_ID } from "../../src/shared/cardLeave";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { saveKeepOpenCard } from "./olderProfile";
import { heroShot, regionShot } from "./pictures";
import {
  cardLeave,
  cardReply,
  clickInBody,
  closeQuestion,
  putAwayAndRestore,
  shownEntry,
} from "./stack";

for (const preview of [true, false]) {
  test(`closing after sent ${preview ? "settings" : "answers"} loses nothing`, async () => {
    const userDataDir = scratchDir("infinitary-sent-settings-");
    const db = openDatabase(userDataDir);
    new CardStore(db).upsert({
      id: "settings",
      title: "Choose your settings",
      author: "firstmate",
      meta: "firstmate",
      createdAt: 1,
      priority: 50,
      status: "ready",
      body: preview
        ? '<style>label { display: block; }</style><label>Tone <input name="tone" value="warm"></label><script>document.documentElement.dataset.preview = "ready";</script>'
        : '<fieldset><legend>Tone</legend><label><input type="radio" name="tone" value="warm" data-inf-recommended>Warm</label><label><input type="radio" name="tone" value="plain">Plain</label></fieldset>',
      actions: [
        { id: "approve", label: "Build it", default: true },
        { id: "leave", label: "Leave it" },
      ],
    });
    db.close();
    const launched = await launchApp({ userDataDir });
    try {
      const { page } = launched;
      const frame = cardBody(page, "Choose your settings");
      const choose = async (label: string) => {
        const choice = frame.getByLabel(label, { exact: true });
        await clickInBody(choice);
        await expect(choice).toBeChecked();
      };
      if (preview) await frame.getByLabel("Tone").fill("plain");
      else await choose("Plain");
      await cardReply(page).field.fill("Use these settings.");
      await cardReply(page).send.click();
      await expect(page.locator('[data-card-thread] [data-thread-message="captain"]')).toHaveCount(
        1,
      );
      const thread = await page.evaluate(() => window.infinitary.cards.thread("settings"));
      expect(
        thread.messages.find((message) => message.who === "captain")?.answers?.[0]?.values,
      ).toEqual(["plain"]);
      // An edit after sending still needs confirmation, even back at the proposal.
      if (preview) await frame.getByLabel("Tone").fill("warm");
      else await choose("Warm");
      await putAwayAndRestore(page, "Choose your settings");
      if (preview) await frame.getByLabel("Tone").fill("plain");
      else await choose("Plain");
      if (process.env.FM_SENT_SETTINGS_EVIDENCE) {
        await regionShot(
          page.locator("[data-card-layer]"),
          `${process.env.FM_SENT_SETTINGS_EVIDENCE}/${preview ? "preview" : "decision"}-after.png`,
        );
      }
      await cardLeave(page, shownEntry(page)).click();

      await expect
        .poll(async () =>
          (await page.evaluate(() => window.infinitary.cards.list())).some(
            (card) => card.id === "settings" && card.minimized,
          ),
        )
        .toBe(true);
    } finally {
      await launched.app.close();
    }
  });
}

for (const status of ["ready", "streaming"] as const) {
  test(`upgrade a saved ${status} card removes Revise and preserves its choices and reply`, async () => {
    const userDataDir = scratchDir("infinitary-footer-settings-");
    saveKeepOpenCard(userDataDir, {
      id: "legacy",
      title: "Choose your settings",
      author: "firstmate",
      meta: "firstmate",
      createdAt: 1,
      priority: 50,
      status,
      body: '<p>Choose a tone for your project.</p><label>Tone <input name="tone" value="warm"></label>',
      actions: [
        { id: "leave", label: "Save and defer" },
        { id: "revise", label: "Revise", keepsOpen: true },
        { id: "build", label: "Approve and build", default: true },
      ],
    });
    const launched = await launchApp({ userDataDir });
    try {
      const { page } = launched;
      await resizeWindow(launched.app, page, { width: 1280, height: 800 });
      await expect(shownEntry(page)).toBeVisible();
      const cards = await page.evaluate(() => window.infinitary.cards.list());
      expect(cards.find((card) => card.id === "legacy")).toMatchObject({
        status: "ready",
        // The author's choices, and the app's Decline beside them (INF-3108).
        actions: [{ id: "leave" }, { id: "build" }, { id: DECLINE_ACTION_ID }],
      });
      await expect(
        shownEntry(page).getByRole("button", { name: "Approve and build", exact: true }),
      ).toBeEnabled();
      if (process.env.FM_KEEP_PICTURES) {
        await regionShot(
          page.locator("[data-card-layer]"),
          `${process.env.FM_KEEP_PICTURES}/${status === "ready" ? "ready" : "working"}-after.png`,
        );
        if (status === "ready")
          await heroShot(launched.app, page, {
            region: shownEntry(page),
            anchors: [],
            name: "retire-saved-revise",
          });
      }
      await cardBody(page, "Choose your settings").getByLabel("Tone").fill("plain");
      await cardReply(page).field.fill("Use these settings.");
      await cardReply(page).send.click();
      // The send is saved once its line is in the thread; read it after that.
      await expect(page.locator('[data-card-thread] [data-thread-message="captain"]')).toHaveCount(
        1,
      );
      const thread = await page.evaluate(() => window.infinitary.cards.thread("legacy"));
      expect(
        thread.messages.find((message) => message.who === "captain")?.answers?.[0]?.values,
      ).toEqual(["plain"]);
      await cardLeave(page, shownEntry(page)).click();

      await expect
        .poll(() =>
          page.evaluate(() =>
            window.infinitary.cards
              .list()
              .then((cards) => cards.some((card) => card.id === "legacy" && card.minimized)),
          ),
        )
        .toBe(true);
    } finally {
      await launched.close();
    }
  });
}
