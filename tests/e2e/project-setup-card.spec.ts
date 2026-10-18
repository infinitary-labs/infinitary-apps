import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { type HelperRun, startHelper } from "../../src/core/helper/run";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import {
  SETUP_CARD_FIELDS,
  SETUP_CARD_WORDS,
  setupSettingsWords,
} from "../../src/shared/projectSetup";
import { devicePlace } from "../../src/shared/signIns";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type LaunchedApp, launchApp } from "./launch";
import {
  MOCK_PROPOSED_WORK,
  type MockProviderServer,
  PROPOSE_PROJECT_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "./mockProvider";
import { addFromSetupCard, projectRow, showSetupCard } from "./projects";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";

/**
 * The setup card (docs/fleet.md, "Asking the first mate to add a project"; the
 * captain's direction A on FI3-1531): a crewmate reports that its work needs
 * a project that is not on the list, and Firstmate proposes it from that
 * report. The app checks the folder, changes nothing and puts up its own
 * card; the captain picks the Mac mini and Careful care there and clicks Add
 * project. The project is added with those choices before Firstmate hears,
 * once, that it may start the work the card named, and its row in Settings
 * shows the choices - after a restart too.
 *
 * The Mac mini is the helper as the work mode composes it, in this test's
 * own process, joined as another Mac (`INFINITARY_JOINS_FROM_ANOTHER_MAC`).
 */

const MINI = {
  name: "Mac mini",
  user: { name: "sam", uid: (process.getuid?.() ?? userInfo().uid) + 1000 },
};

const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
let mock: MockProviderServer | undefined;
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
  await mock?.close();
});

/** A project folder whose remote is a bare repository on this disk. */
function folderWithRemote(): string {
  const root = scratchDir("infinitary-e2e-setup-card-");
  const origin = join(root, "origin.git");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const folder = join(root, "dotfiles-private");
  git(root, ["clone", "--quiet", origin, folder]);
  writeFileSync(join(folder, "README.md"), "# dotfiles\n");
  git(folder, ["add", "-A"]);
  git(folder, ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  git(folder, ["push", "--quiet", "origin", "HEAD:main"]);
  return folder;
}

test("Firstmate proposes a project after a crewmate's report, and Add project sets it up as the captain chose", async () => {
  mock = await startMockProvider();
  const env = { INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };
  const app = await launchApp({ reuseMockProvider: mock, env });
  apps.push(app);
  const { page } = app;
  const folder = folderWithRemote();
  const name = basename(folder);
  const title = SETUP_CARD_WORDS.title(name);

  const deviceId = await test.step("a Mac mini joins to run work", async () => {
    const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
    const dataDir = scratchDir("infinitary-e2e-mini-");
    const joined = await joinHome({
      text: invite.link,
      dataDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: MINI,
      timeoutMs: 5_000,
    });
    if (!joined.ok) throw new Error(joined.reason);
    const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    await expect
      .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
    return joined.grant.deviceId;
  });

  await test.step("a crewmate's report makes Firstmate propose the project, and nothing is added", async () => {
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${PROPOSE_PROJECT_PROMPT_MARKER}${folder}`);
    await input.press("Enter");
    await showSetupCard(page, name);
    expect(await page.evaluate(() => window.infinitary.repos.list())).toHaveLength(0);
    const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (entry) => entry.title === title,
    );
    expect(card?.author).toBe("host");
  });

  await test.step("the captain picks the Mac mini and Careful care, and clicks Add project", async () => {
    const frame = cardBody(page, title);
    await expect(frame.getByText(MOCK_PROPOSED_WORK, { exact: false })).toBeVisible();
    await expect(
      frame.locator(`input[name="${SETUP_CARD_FIELDS.landing}"][value="link"]`),
    ).toBeChecked();
    await frame
      .locator(`select[name="${SETUP_CARD_FIELDS.runsOn}"]`)
      .evaluate((select: HTMLSelectElement, id) => {
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, deviceId);
    await frame
      .locator(`input[name="${SETUP_CARD_FIELDS.care}"][value="reviewed"]`)
      .evaluate((control: HTMLInputElement) => control.click());
    await page.screenshot({ path: test.info().outputPath("project-setup-card.png") });
    await addFromSetupCard(page, name);
  });

  const repo =
    await test.step("the project is added with those choices, and Firstmate hears once", async () => {
      await expect
        .poll(async () => (await page.evaluate(() => window.infinitary.repos.list()))[0], {
          timeout: 30_000,
        })
        .toMatchObject({
          path: folder,
          setupKind: "adopt",
          delivery: "direct-pr",
          autonomy: false,
          rigor: "reviewed",
          runsOn: deviceId,
        });
      const [added] = await page.evaluate(() => window.infinitary.repos.list());
      if (!added) throw new Error("The project must be on the list");
      const devices = await page.evaluate(() => window.infinitary.devices.list());
      const told = renderWake({
        facts: {
          kind: "project-setup",
          outcome: "added",
          name,
          repoId: added.id,
          settings: setupSettingsWords(added, devices),
          work: MOCK_PROPOSED_WORK,
        },
      });
      const heard = () =>
        mock
          ?.requestBodies()
          .map(
            (body) =>
              providerMessages(body).filter(
                (message) => message.role === "user" && message.text.includes(told),
              ).length,
          )
          .filter((count) => count > 0) ?? [];
      await expect.poll(heard, { timeout: 30_000 }).not.toHaveLength(0);
      // Every request that carried it carried it once: one answer, told once.
      expect(heard().every((count) => count === 1)).toBe(true);
      return added;
    });

  await test.step("its row in Settings shows the choices", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const row = projectRow(page, repo.id);
    const where = devicePlace([{ id: deviceId, name: MINI.name }], deviceId).where;
    await expect(row.getByText(`runs ${where}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("project-setup-row.png") });
    await page.keyboard.press("Escape");
  });

  await test.step("after a restart the project keeps them", async () => {
    const { userDataDir, homeDir } = app;
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const again = await launchApp({ reuseMockProvider: mock, env, userDataDir, homeDir });
    apps.push(again);
    expect(
      (await again.page.evaluate(() => window.infinitary.repos.list())).find(
        (entry) => entry.id === repo.id,
      ),
    ).toMatchObject({
      delivery: "direct-pr",
      autonomy: false,
      rigor: "reviewed",
      runsOn: deviceId,
    });
  });
});
