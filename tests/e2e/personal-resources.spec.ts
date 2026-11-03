import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { PERSONAL_RESOURCES_WORDS } from "../../src/renderer/src/settings/subscriptionsWords";
import { personalResourcesHome } from "./homeFixtures";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { requestToolNames } from "./providerRequest";
import { readSavedData } from "./savedData";
import { assertReadableSettingsFeedback, REFUSAL, refuseNext, settingRow } from "./settings";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

const PERSONAL_MARKER = "Personal local tone marker: use short sentences.";
const SKILL_NAME = "personal-local-rivets";

test("a person opts in by keyboard, new crew receives local resources and the choice survives restart", async () => {
  let launched = await launchApp({
    withMockProvider: true,
    prepareHome: personalResourcesHome(PERSONAL_MARKER, SKILL_NAME),
  });
  const { userDataDir, homeDir } = launched;
  try {
    const crewRequests = () =>
      launched.mockProvider
        ?.requestBodies()
        .filter((body) => requestToolNames(body).includes("report")) ?? [];
    const send = async (title: string) => {
      const field = promptInput(launched.page);
      await field.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await pressKey(field, "Enter");
    };
    await send("Isolated crew example");
    await expect.poll(() => crewRequests().length).toBeGreaterThan(0);
    expect(
      crewRequests().every((body) => !body.includes(PERSONAL_MARKER) && !body.includes(SKILL_NAME)),
    ).toBe(true);
    await pressWindowKey(launched.app, ",", ["meta"]);
    const intelligence = launched.page.locator('[role="tab"][id$="-tab-subscriptions"]');
    await focusOn(intelligence);
    await pressKey(intelligence, "Enter");
    const toggle = settingRow(launched.page, "personal-resources").getByRole("switch", {
      name: PERSONAL_RESOURCES_WORDS.title,
    });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await focusOn(toggle);
    await expect(toggle).toBeFocused();
    await pressKey(toggle, "Space");
    await expect(toggle).toBeChecked();
    expect(
      readSavedData(userDataDir, (db) => new SettingsStore(db).getPersonalResourcesEnabled()),
    ).toBe(true);
    await pressWindowKey(launched.app, "Escape");
    await send("Personal crew example");
    await expect
      .poll(() =>
        crewRequests().some((body) => body.includes(PERSONAL_MARKER) && body.includes(SKILL_NAME)),
      )
      .toBe(true);
    const requests = crewRequests();
    writeFileSync(
      test.info().outputPath("served-personal-resources.json"),
      JSON.stringify({ enabled: true, requests }, null, 2),
    );
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, withMockProvider: true });
    await pressWindowKey(launched.app, ",", ["meta"]);
    const reopenedIntelligence = launched.page.locator('[role="tab"][id$="-tab-subscriptions"]');
    await focusOn(reopenedIntelligence);
    await pressKey(reopenedIntelligence, "Enter");
    const restored = settingRow(launched.page, "personal-resources").getByRole("switch");
    await expect(restored).toBeChecked();
    await expect(restored).toBeEnabled();
    await refuseNext(launched.app, "inf:settings:personal-resources:set");
    await focusOn(restored);
    await pressKey(restored, "Space");
    await assertReadableSettingsFeedback(
      settingRow(launched.page, "personal-resources").getByRole("alert"),
      REFUSAL,
    );
    await expect(restored).toBeChecked();
    await regionShot(
      settingRow(launched.page, "personal-resources"),
      test.info().outputPath("refused-save.png"),
    );
    expect(
      readSavedData(userDataDir, (db) => new SettingsStore(db).getPersonalResourcesEnabled()),
    ).toBe(true);
    await expect(restored).toBeEnabled();
    await pressKey(restored, "Space");
    await expect(restored).not.toBeChecked();
    expect(
      readSavedData(userDataDir, (db) => new SettingsStore(db).getPersonalResourcesEnabled()),
    ).toBe(false);
    expect(readFileSync(join(homeDir, "AGENTS.md"), "utf8")).toBe(PERSONAL_MARKER);
  } finally {
    await launched.close();
  }
});
