import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, type ActionName } from "@shared/actions";
import { knownPanels } from "@shared/panelArrangement";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeHost, quotaFixture } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { type Core, startCore } from "./index";
import { createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { STANDBY_WORDS } from "./standby/words";
import { keptJobsAt } from "./tasks/keptJobs";
import { keptRoot } from "./tasks/taskStops";

// This file is not about the utility-QoS clamp, so what the product spawns
// runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The captain's ask (INF-5326, piece 1 INF-5354): what a person can do in
 * Settings, the first mate can do through the same requests. Each new or
 * widened action runs through app_change in the whole core, changes only its
 * own part of its request and leaves one Activity line; what stays the
 * captain's is refused there, and app_state carries none of the captain's
 * private values.
 */
describe("the first mate's Settings actions, driven through the whole core", () => {
  let userDataDir: string;
  let core: Core;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-parity-");
    process.env.PI_OFFLINE = "1";
    quotaFixture("infinitary-parity-quota-", []);
    core = await startCore(fakeHost(userDataDir).host);
  }, 60_000);

  afterAll(async () => {
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  const tool = (name: "app_change" | "app_state") => {
    const found = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((each) => each.name === name);
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
  /** Runs one action as the captain asked it; answers its reply and the Activity lines it left. */
  const asked = async (
    action: ActionName,
    value: Record<string, unknown>,
    evidence = "Please.",
  ) => {
    const before = new Set(operations().map((task) => task.id));
    const answer = await tool("app_change").run({ action, value, evidence });
    let reply: { action?: string; answer?: Record<string, unknown>; current?: unknown } = {};
    try {
      reply = JSON.parse(answer.text);
    } catch {
      throw new Error(`${action} was refused: ${answer.text}`);
    }
    return {
      reply,
      lines: operations()
        .filter((task) => !before.has(task.id))
        .map((task) => task.title),
    };
  };
  const appearance = () => core.dispatch("inf:settings:appearance:get", []);

  it("resumes paused music, and sets card size, language and usage units, each alone", async () => {
    await core.dispatch("inf:settings:appearance:set", [
      { ...(await appearance()), ambientMusic: true, ambientPaused: true },
    ]);
    const paused = await appearance();
    const played = await asked("ambient-music", { on: true });
    // INF-5347: on true plays music the sound button paused, as the Settings switch does.
    expect(await appearance()).toEqual({ ...paused, ambientPaused: undefined });
    expect(played.lines).toEqual(["ambient music on, volume 40%, style star-cruise"]);
    expect((await asked("ambient-music", { on: true, paused: true })).lines).toEqual([
      "ambient music paused, volume 40%, style star-cruise",
    ]);
    expect((await appearance()).ambientPaused).toBe(true);

    const wasCards = await appearance();
    const sized = await asked("card-size", { size: "wide", keepMaximized: true });
    expect(await appearance()).toEqual({
      ...wasCards,
      defaultCardSize: "wide",
      keepCardsMaximized: true,
      cardsMaximized: false,
    });
    expect(sized.lines).toEqual(["cards open wide, keep maximized on"]);

    const wasUnit = await appearance();
    const unit = await asked("usage-unit", { unit: "usd" });
    expect(await appearance()).toEqual({ ...wasUnit, usageUnit: "usd" });
    expect(unit.lines).toEqual(["usage shown in usd"]);
  });

  it("chooses a language by its tag and goes back to the default with null", async () => {
    const tag = (
      ACTIONS.language.value.safeParse({ language: "zh-Hans" }).success ? "zh-Hans" : null
    ) as string | null;
    if (!tag) throw new Error("This build ships no Chinese catalog to choose");
    const was = await appearance();
    expect((await asked("language", { language: tag })).lines).toEqual([`language ${tag}`]);
    expect(await appearance()).toEqual({ ...was, language: tag });
    expect((await asked("language", { language: null })).lines).toEqual(["language default"]);
    expect((await appearance()).language).toBeUndefined();
  });

  it("changes dictation in the captain's words, keeping what it leaves out", async () => {
    const was = await core.dispatch("inf:settings:dictation:get", []);
    const turned = await asked("dictation", { enabled: !was.enabled }, "Turn dictation off.");
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      ...was,
      enabled: !was.enabled,
    });
    expect(turned.lines).toHaveLength(1);
    await core.dispatch("inf:settings:dictation:set", [was]);
  });

  it("picks a panel to its slot's edge, then puts every panel back where it asks to be", async () => {
    const [first] = knownPanels(core.services.personal.snapshot());
    if (!first) throw new Error("The core knows no panel");
    const pick = await asked("panel", { surface: first.id, pick: true });
    expect((await core.dispatch("inf:settings:layout:get", [])).morePick).toBe(first.id);
    expect(pick.lines.length).toBeLessThanOrEqual(1);
    await asked("panel", {
      surface: first.id,
      rail: first.preferred.x === "left" ? "right" : "left",
    });
    const reset = await asked("panel", { reset: true });
    const layout = await core.dispatch("inf:settings:layout:get", []);
    expect(layout.morePick).toBeUndefined();
    expect(layout.placements).toEqual({});
    expect(reset.lines).toHaveLength(1);
  });

  it("turns a decision model use off, and never on", async () => {
    const use = (await core.dispatch("inf:settings:decisions", [])).uses?.find(
      (each) => each.kind !== "always-on" && each.on,
    );
    if (!use) throw new Error("No decision model use is on to turn off");
    const off = await asked("decision-use-off", { use: use.id });
    expect(
      (await core.dispatch("inf:settings:decisions", [])).uses?.find((each) => each.id === use.id)
        ?.on,
    ).toBe(false);
    expect(off.lines).toEqual([`decision model use ${use.name} off`]);
    // The line's own request, asked for the other act, is refused and changes nothing.
    await expect(
      core.dispatch("inf:decisions:use:set", [{ id: use.id, on: true }], {
        kind: "firstmate",
        wake: "captain",
        action: "decision-use-off",
        evidence: "Turn it on.",
      }),
    ).rejects.toThrow("stays with the captain");
    expect(
      (await core.dispatch("inf:settings:decisions", [])).uses?.find((each) => each.id === use.id)
        ?.on,
    ).toBe(false);
    // The captain's own switch turns it back on, as Settings does.
    await core.dispatch("inf:decisions:use:set", [{ id: use.id, on: true }]);
  });

  it("checks a kept job, as its Check does", async () => {
    const jobs = keptJobsAt(core.services.paths.crewmatesDir);
    const folder = join(keptRoot(core.services.paths.crewmatesDir), "task-7-s1");
    mkdirSync(folder, { recursive: true });
    const marker = join(folder, "sync.timer");
    writeFileSync(marker, "[Timer]\n");
    const label = "Hourly sync of the photos folder";
    jobs.record(
      [
        {
          id: "s1",
          label,
          check: `test -f "${marker}"`,
          remove: `rm "${marker}"`,
          folder,
          account: "captain",
        },
      ],
      { computer: null, task: "task-7", key: "INF-7" },
    );
    const checked = await asked("kept-job-check", { id: "task-7-s1" });
    expect(checked.reply.answer).toEqual({ checked: "running" });
    expect(checked.lines).toEqual([`checked ${label}: running`]);
    await core.dispatch("inf:automation:kept-forget", ["task-7-s1"]);
  });

  it("checks for updates and changes the update channel through the update checker", async () => {
    const status = await core.dispatch("inf:update:status", []);
    const newer = { ...status, latestVersion: "10.0.0", updateAvailable: true };
    const check = vi.spyOn(core.services.updateChecker, "checkNow").mockResolvedValue(newer);
    const checked = await asked("update-check", {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(checked.reply.answer).toEqual({ latest: "10.0.0", available: true });
    expect(checked.lines).toEqual(["checked for updates: 10.0.0 is ready"]);
    check.mockRestore();
    const refused = await tool("app_change").run({
      action: "update-channel",
      value: { channel: "alpha" },
      evidence: "Switch me to alpha.",
    });
    // A build that cannot choose its own channel says so, and nothing changes.
    if (!core.services.updateChecker.setChannel)
      expect(refused.text).toContain("does not support changing its update channel");
  });

  it("answers an act that found nothing to do, leaving no Activity line", async () => {
    for (const [action, value] of [
      ["device-try-again", {}],
      ["home-move-cancel", {}],
      ["panel-retry", { surface: "nothing-stopped" }],
    ] as const) {
      const ran = await asked(action, value);
      expect(ran.lines, action).toEqual([]);
      expect(ran.reply.answer, action).toBeDefined();
    }
  });

  it("refuses own-words and asked lines without the captain's words, and acts their line does not own", async () => {
    for (const action of [
      "panel-retry",
      "private-site-remove",
      "secret-end-read",
      "dictation",
    ] as const)
      expect(ACTIONS[action].tier).toBe("own-words");
    const change = tool("app_change");
    for (const [action, value] of [
      ["private-site-remove", { site: "wiki.corp.example" }],
      ["secret-end-read", { id: "read-1" }],
      ["copy-stop", { deviceId: "mini" }],
    ] as const) {
      const answer = await change.run({ action, value });
      expect(answer.text, action).toContain("Give the captain's words");
    }
    for (const [channel, args, action] of [
      ["inf:secrets:action", [{ kind: "delete-history" }], "secret-end-read"],
      ["inf:standby:name", ["mini", true], "copy-stop"],
    ] as const)
      await expect(
        core.dispatch(channel, args as never, {
          kind: "firstmate",
          wake: "captain",
          action,
          evidence: "Please.",
        }),
      ).rejects.toThrow("stays with the captain");
  });

  it("leaves the captain's own clicks on newly claimed requests as they were", async () => {
    const before = operations().length;
    const copy = await core.dispatch("inf:standby:name", ["mini", true]);
    const secrets = await core.dispatch("inf:secrets:action", [{ kind: "delete-history" }]);
    // This core keeps no copies and has no Secrets turned on: each answers as Settings sees it.
    expect(copy).toEqual({ ok: false, text: STANDBY_WORDS.noCopies });
    expect(secrets.availability).toBe("not-enabled");
    // Starting a copy and every secret action but ending a read leave no line of the new actions.
    expect(operations()).toHaveLength(before);
  });

  it("keeps the captain's private values out of app_state (INF-5350)", async () => {
    await core.dispatch("inf:settings:sharing:set", ["diagnostics", true]);
    const sharing = await core.dispatch("inf:settings:sharing:get", []);
    const installId = sharing.diagnostics.installId;
    expect(installId).toBeTruthy();
    const state = (await tool("app_state").run({})).text;
    expect(state).not.toContain(installId as string);
    await core.dispatch("inf:settings:sharing:set", ["diagnostics", false]);
  });
});
