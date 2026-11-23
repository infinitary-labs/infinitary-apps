import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import { AUTOMATIC_COMPUTER, placementReason } from "../../src/shared/placement";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { waitForFirstmateIdle } from "./crew";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_PROVIDER_ID, mockModelsJson } from "./mockModels";
import { regionShot } from "./pictures";
import {
  computerReading,
  holdCpuBusy,
  homeReading,
  replayedCpu,
  replayHelperCpuAvailable,
} from "./placementCpu";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { seedQuotaFixture } from "./quotaFixtures";
import { expandDock, expectRecordBody, expectRecordSized, pressRow, recordFrame } from "./rails";
import { BASIS_EVIDENCE, BASIS_PROBE, basisPlacement } from "./scenarios/basisPlacement";
import { starterFor } from "./starters";
import { pressWindowKey, typeInto } from "./windowKeys";

const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };
const MINI = "Mac mini";
const GROK = starterFor("xai", "medium");

const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
const restores: (() => void)[] = [];
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  for (const restore of restores.splice(0)) restore();
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
});

function projectWithOrigin(): string {
  const root = scratchDir("infinitary-e2e-task-move-");
  const origin = join(root, "origin.git");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  git(website, ["add", "-A"]);
  git(website, ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  return website;
}

/**
 * A Grok key, the crew's one account (`automatic-placement.spec.ts` seeds
 * the same): its model answers at the stand-in. `dir` is an app's data
 * folder, the home's or the computer's.
 */
function seedGrokKey(dir: string): void {
  seedAccountStore(dir, "xai", "acct_crew");
  seedAccountAuth(dir, "xai", "acct_crew", { xai: { type: "api_key", key: "disposable-key" } });
  seedAccountRegistry(dir, [
    {
      id: "acct_crew",
      providerId: "xai",
      kind: "api_key",
      label: "Crew",
      enabled: true,
      createdAt: 1,
    },
  ]);
}

function grokModels(port: number): string {
  const config = JSON.parse(mockModelsJson(port));
  config.providers.xai = {
    ...config.providers[MOCK_PROVIDER_ID],
    models: [{ id: GROK, name: "Mock Grok", input: ["text", "image"] }],
  };
  return JSON.stringify(config);
}

async function homeAndComputer() {
  process.env.PI_OFFLINE = "1";
  const userDataDir = scratchDir("infinitary-e2e-task-move-home-");
  seedGrokKey(userDataDir);
  const quota = join(userDataDir, "quota");

  const generatedAt = new Date().toISOString();
  seedQuotaFixture(
    quota,
    { generatedAt, providers: [] },
    {
      generatedAt,
      models: [{ provider: "grok", id: GROK, label: "Mock Grok", effectivePercentRemaining: 80 }],
    },
  );

  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [basisPlacement],
    modelsJson: grokModels,
    env: { INFINITARY_QUOTA_FIXTURE_DIR: quota },
  });
  apps.push(app);
  const { page } = app;
  // Both users read this one physical computer. Under a full parallel run
  // its real processor stays busy, and Automatic rightly waits for room, so
  // replay INF-1129's recorded available counters in the app and the helper.
  await (await holdCpuBusy(app))();
  await expect
    .poll(() => homeReading(app), { timeout: 90_000 })
    .toMatchObject({ status: "fresh", observation: { cpu: replayedCpu("available") } });
  restores.push(replayHelperCpuAvailable());
  const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const dataDir = scratchDir("infinitary-e2e-computer-");
  const port = app.mockProvider?.port;
  if (!port) throw new Error("The stand-in provider did not start.");
  seedGrokKey(dataDir);
  mkdirSync(join(dataDir, "pi-base"), { recursive: true });
  writeFileSync(join(dataDir, "pi-base", "models.json"), grokModels(port));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: MINI, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  await expect.poll(() => homeReading(app)).toMatchObject({ status: "fresh" });
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    // This helper is another user of this physical computer. Unlike a work
    // app, its Node process has no Electron memory adapter. Supply the same
    // computer's actual fresh memory through the existing shared feed.
    resourceMemory: async () => {
      const reading = await homeReading(app);
      return reading?.status === "fresh" ? reading.observation.memory : null;
    },
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  // The helper's own reading is the replay too, not the runner's load.
  await expect
    .poll(() => computerReading(app, joined.grant.deviceId), { timeout: 90_000 })
    .toMatchObject({ status: "fresh", observation: { cpu: replayedCpu("available") } });
  return { app, page, deviceId: joined.grant.deviceId, dataDir };
}

async function ask(app: LaunchedApp, words: string, calls: ScriptedCall[]): Promise<string[]> {
  if (!app.mockProvider) throw new Error("Asking Firstmate needs the mock provider");
  await waitForFirstmateIdle(app.page);
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(app.page);
  await pressWindowKey(app.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+A");
  await typeInto(input, words);
  await input.press("Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome().results;
}

async function started(page: Page, title: string): Promise<{ key: string; id: string }> {
  const { tasks } = await page.evaluate(() => window.infinitary.tasks.board());
  const task = tasks.find((each) => each.title === title);
  if (!task) throw new Error(`No task "${title}" was started`);
  return { key: task.key, id: task.id };
}

/**
 * INF-1870 approved: one direct answered basis supplies a soft locality hint.
 * A real paired helper and isolated Git project prove Automatic execution,
 * retained evidence access, explicit override, fallback and the existing
 * record explanation. No real account, physical-network or load claim.
 */
test("Automatic continues beside its basis, while explicit choice and unavailable-basis fallback stay authoritative", async () => {
  test.setTimeout(240_000);
  const { app, page, deviceId, dataDir } = await homeAndComputer();
  // Both computers read this one computer's real memory, beside the app, the helper and the
  // suite: a standard task asks 2 GiB above the margin, which GitHub's 7 GB Mac did not have
  // spare (INF-6336), so the project declares tasks of the smallest size, which every computer
  // the suite runs on has room for.
  const { repo } = await page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({ kind: "adopt", path, name: "website" });
    await window.infinitary.devices.runsOn(result.repo.id, "automatic");
    await window.infinitary.repos.configure(result.repo.id, {
      placementRequirements: { profile: "conversation" },
    });
    return result;
  }, projectWithOrigin());
  const detail = (id: string) => page.evaluate((id) => window.infinitary.tasks.detail(id), id);
  const commission = async (
    title: string,
    basis?: string,
    explicit?: string,
    evidence?: string,
    readOnly = false,
  ) => {
    const words = `${BASIS_PROBE}: ${title}. ${evidence ?? ""}`.trim();
    await ask(app, words, [
      {
        name: "spawn_crewmate",
        args: {
          title,
          goal: words,
          user_words: words,
          repo_id: repo.id,
          ...(readOnly ? { constraints: [{ kind: "read-only" as const }] } : {}),
          shape: {
            kind: "fix",
            skipped_plan_because: "A bounded placement verification",
            ...(basis ? { basis } : {}),
            ...(explicit ? { runs_on_ask: explicit } : {}),
          },
        },
      },
    ]);
    const task = await started(page, title);
    await expect
      .poll(async () => (await detail(task.id)).outcome, { timeout: 90_000 })
      .toBeTruthy();
    await expect.poll(async () => (await detail(task.id)).activity).toBe("idle");
    return { ...task, record: await detail(task.id) };
  };

  const basis = await commission("Reproduce the footer", undefined, deviceId);
  expect(basis.record.executionDeviceId).toBe(deviceId);
  const path = basis.record.outcome?.match(/BASIS_FILE=(\/[^\s"<>]+)/)?.[1];
  if (!path) throw new Error("The basis reported no retained evidence file.");
  expect(existsSync(path)).toBe(true);
  expect(dirname(realpathSync(path))).toBe(realpathSync(join(dataDir, "worktrees", basis.id)));

  const next = await commission(
    "Fix the reproduced footer",
    basis.key,
    AUTOMATIC_COMPUTER,
    `BASIS_FILE=${path}`,
  );
  await test.info().attach("basis-and-continuation.json", {
    body: JSON.stringify({ basis: basis.record, continuation: next.record }, null, 2),
    contentType: "application/json",
  });
  console.info(
    "Basis admission",
    JSON.stringify({
      startedAt: basis.record.startedAt,
      computer: basis.record.executionDeviceId,
      placement: next.record.placement,
    }),
  );
  expect(next.record.executionDeviceId).toBe(deviceId);
  expect(next.record.outcome).toBe(BASIS_EVIDENCE);
  expect(next.record.placement?.computerId).toBe(deviceId);
  // Both users share physical capacity and the same model preference, so
  // ordinary tie-breaking chooses home. The basis must change that winner.
  expect(next.record.placement?.basis).toEqual({
    taskId: basis.id,
    taskKey: basis.key,
    computerId: deviceId,
  });
  if (!next.record.placement) throw new Error("Automatic saved no placement explanation.");
  expect(next.record.runsOn?.reason).toBe(placementReason(next.record.placement));
  await resizeWindow(app.app, page, { width: 1280, height: 900 });
  await expandDock(page, "now");
  await pressRow(page, next.key);
  await expectRecordBody(page);
  const frame = recordFrame(page);
  await frame
    .locator('[data-record-section="details"] > summary')
    .evaluate((el: HTMLElement) => el.click());
  await expectRecordSized(page);
  await expect(frame.locator('[data-record-fact="computer-choice"]')).toContainText(
    placementReason(next.record.placement),
  );
  if (process.env.BASIS_PICTURE) {
    const picture = process.env.BASIS_PICTURE.replace(
      /\.png$/,
      `-${test.info().repeatEachIndex}.png`,
    );
    await regionShot(frame.locator('[data-record-fact="computer-choice"]'), picture);
  }
  await test.info().attach("continuation-placement.json", {
    body: JSON.stringify(next.record, null, 2),
    contentType: "application/json",
  });

  const override = await commission("Check the explicit home choice", basis.key, "this-mac");
  expect(override.record.executionDeviceId ?? null).toBeNull();
  expect(override.record.placement).toBeUndefined();

  // A change basis retains the existing strict branch handoff, which can
  // itself require the source online. Use an answered inspection, with no
  // branch to hand over, to isolate Automatic's unavailable-computer fallback.
  const answer = await commission(
    "Inspect retained evidence for fallback",
    undefined,
    deviceId,
    `BASIS_FILE=${path}`,
    true,
  );
  expect(answer.record.outcome).toBe(BASIS_EVIDENCE);
  const helper = runs.pop();
  if (!helper) throw new Error("The paired helper was not retained.");
  await helper.stop();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.devices.list())).find(
          (device) => device.id === deviceId,
        )?.inReach,
    )
    .toBe(false);
  const fallback = await commission(
    "Continue while the basis computer is unavailable",
    answer.key,
    AUTOMATIC_COMPUTER,
  );
  expect(fallback.record.executionDeviceId ?? null).toBeNull();
  expect(fallback.record.placement?.computerId).toBeNull();
  expect(fallback.record.placement?.basis).toBeUndefined();
  await test.info().attach("fallback-placement.json", {
    body: JSON.stringify(fallback.record, null, 2),
    contentType: "application/json",
  });
});
