import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { COMPUTER } from "../../src/shared/deviceNames";
import { inLanguage } from "../../src/shared/i18n/current";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { atRest, resizeWindow } from "./layout";
import { mockProviderOverrideModelsJson } from "./mockModels";
import { startMockProvider } from "./mockProvider";
import { windowShot } from "./pictures";

// The desktop translation work asks that sign-in and joining speak the chosen language.
// Two isolated apps and the normal mock provider exercise the real join and remote view.
test("Japanese first launch joins another computer and reports its connection", async () => {
  test.setTimeout(120_000);
  const guestData = scratchDir("infinitary-language-join-");
  const homeData = scratchDir("infinitary-language-home-");
  for (const data of [guestData, homeData]) {
    const db = openDatabase(data);
    new SettingsStore(db).setAppearance({ theme: "dark", language: "ja" });
    db.close();
  }
  const provider = await startMockProvider();
  let home: LaunchedApp | undefined;
  let guest: LaunchedApp | undefined;
  try {
    home = await launchApp({
      withMockProvider: true,
      userDataDir: homeData,
      env: { INFINITARY_DEVICE_NAME: "Studio" },
    });
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    guest = await launchApp({
      userDataDir: guestData,
      reuseMockProvider: provider,
      modelsJson: mockProviderOverrideModelsJson,
      env: { INFINITARY_DEVICE_NAME: "Laptop" },
    });
    const { app, page } = guest;
    await resizeWindow(app, page, { width: 1280, height: 960 });
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    const gate = page.locator('[data-first-run-gate="open"]');
    await expect(gate).toBeVisible();
    await atRest(gate);
    await windowShot(page, test.info().outputPath("evidence", "sign-in.png"));
    await gate.locator('[data-connect-provider="openrouter"]').click();
    const method = gate.locator('[data-connect-method="openrouter"]');
    await expect(method).toContainText(
      inLanguage("ja", () => m.accountsConnectHow({ provider: "OpenRouter" })),
    );
    await atRest(method);
    await windowShot(page, test.info().outputPath("evidence", "sign-in-choice.png"));
    await method
      .getByRole("button", { name: inLanguage("ja", () => m.accountsConnectCancel()) })
      .click();
    await page.locator("[data-join-chip]").click();
    const join = page.locator('[data-join-another-mac="paste"]');
    await expect(join).toBeVisible();
    await atRest(join);
    await expect(join).toContainText(
      inLanguage("ja", () => m.devicesJoinPasteHead({ computer: COMPUTER.one })),
    );
    await windowShot(page, test.info().outputPath("evidence", "join.png"));
    await join.locator("input").fill(invite.link);
    await join.locator('button[type="submit"]').click();
    const confirm = page.locator('[data-join-another-mac="confirm"]');
    await expect(confirm).toBeVisible();
    await atRest(confirm);
    await windowShot(page, test.info().outputPath("evidence", "confirm.png"));
    await confirm.locator("button").first().click();
    const remote = page.locator("[data-remote-control]");
    await expect(remote).toHaveAttribute("data-remote-control", "in-reach");
    await expect(remote.getByRole("img")).toHaveAttribute(
      "aria-label",
      inLanguage("ja", () => m.devicesRemoteControlling({ name: "Studio" })),
    );
    await windowShot(page, test.info().outputPath("evidence", "remote.png"));
    await home.close();
    home = undefined;
    await expect(remote).toHaveAttribute("data-remote-control", "closed");
    await expect(remote.getByRole("img")).toHaveAttribute(
      "aria-label",
      inLanguage("ja", () => m.devicesRemoteOutOfReach({ name: "Studio" })),
    );
    await expect(page.locator("[data-view-pill]")).toBeVisible();
    await windowShot(page, test.info().outputPath("evidence", "remote-away.png"));
  } finally {
    await guest?.close();
    await home?.close();
    await provider.close();
  }
});
