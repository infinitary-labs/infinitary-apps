import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, type ActionName } from "@shared/actions";
import type { DeviceView } from "@shared/devices";
import type { IntegrationsView } from "@shared/integrations";
import { knownPanels } from "@shared/panelArrangement";
import type { SecretsView } from "@shared/secrets";
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
    // A More pick is one line, even for a panel already at its slot's edge.
    expect(pick.lines).toHaveLength(1);
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

  it("keeps the captain's private values out of app_state (INF-5350, INF-5339)", async () => {
    await core.dispatch("inf:settings:sharing:set", ["diagnostics", true]);
    const sharing = await core.dispatch("inf:settings:sharing:get", []);
    const installId = sharing.diagnostics.installId;
    expect(installId).toBeTruthy();
    // A sign-in under way, a computer reached by its Remote Login and an MCP
    // server's command, as Settings reads each.
    const userCode = "WDJB-MJHT";
    const login = "kiran@studio-4.local";
    const runs = "npx -y @acme/notes-server --token-file /Users/sam/.notes-token";
    const forges = core.services.forges.view();
    const forgesView = vi.spyOn(core.services.forges, "view").mockReturnValue({
      ...forges,
      flow: {
        host: "github.com",
        userCode,
        verificationUri: "https://github.com/login/device",
        expiresAt: Date.now() + 600_000,
      },
    } as typeof forges);
    const devices = vi
      .spyOn(core.services.computers, "list")
      .mockReturnValue([device({ remoteLogin: login })]);
    const integrations = core.services.integrations.view();
    const integrationsView = vi.spyOn(core.services.integrations, "view").mockReturnValue({
      ...integrations,
      integrations: [
        ...integrations.integrations,
        {
          id: "notes",
          kind: "mcp",
          name: "Notes",
          account: null,
          health: "ok",
          paused: false,
          runs,
          actions: [],
        },
      ],
    } as IntegrationsView);
    try {
      const state = (await tool("app_state").run({})).text;
      // Each sentinel reached the reads app_state makes: the device and the integration are there.
      expect(forgesView).toHaveBeenCalled();
      expect(devices).toHaveBeenCalled();
      expect(state).toContain("Mac mini");
      expect(state).toContain("Notes");
      const lines = JSON.parse(state) as { action: string }[];
      for (const secret of [installId as string, userCode, login, runs])
        for (const line of lines)
          expect(JSON.stringify(line), `${line.action} reads ${secret}`).not.toContain(secret);
    } finally {
      forgesView.mockRestore();
      devices.mockRestore();
      integrationsView.mockRestore();
      await core.dispatch("inf:settings:sharing:set", ["diagnostics", false]);
    }
  });

  /** A Mac on Settings → Devices, as its row reads. */
  const device = (extra: Partial<DeviceView> = {}): DeviceView =>
    ({ id: "mini", kind: "mac", name: "Mac mini", inReach: true, ...extra }) as DeviceView;

  it("follows the alpha releases through the update checker's own channel", async () => {
    const status = await core.dispatch("inf:update:status", []);
    let channel = status.channel;
    const checker = core.services.updateChecker;
    const hadSetChannel = checker.setChannel;
    const read = vi
      .spyOn(checker, "getStatus")
      .mockImplementation(async () => ({ ...status, channel, channelChoice: true }));
    const setChannel = vi.fn(async (next: typeof channel) => {
      channel = next;
      return { ...status, channel, channelChoice: true };
    });
    checker.setChannel = setChannel as typeof checker.setChannel;
    try {
      const changed = await asked("update-channel", { channel: "alpha" });
      expect(setChannel).toHaveBeenCalledWith("alpha");
      expect((await core.dispatch("inf:update:status", [])).channel).toBe("alpha");
      expect(changed.lines).toEqual(["updates follow the alpha releases"]);
    } finally {
      read.mockRestore();
      checker.setChannel = hadSetChannel;
    }
  });

  it("makes the Infinitary command's link while it is offered", async () => {
    let state: "offered" | "linked" = "offered";
    const real = core.services.integrations.view();
    const view = vi.spyOn(core.services.integrations, "view").mockImplementation(
      () =>
        ({
          ...real,
          integrations: [
            {
              id: "inbox",
              kind: "inbox",
              name: "Inbox",
              account: null,
              health: "ok",
              paused: false,
              actions: [],
              door: {
                command: "/Applications/Infinitary.app/Contents/Resources/bin/infinitary",
                line: "infinitary inbox",
                link: { state, path: "/usr/local/bin/infinitary" },
              },
            },
          ],
        }) as IntegrationsView,
    );
    // Stands in for the link a click makes in /usr/local/bin, outside the scratch home.
    const link = vi.spyOn(core.services.integrationInbox, "link").mockImplementation(() => {
      state = "linked";
      return undefined as never;
    });
    try {
      const made = await asked("inbox-link", {});
      expect(link).toHaveBeenCalledTimes(1);
      expect(made.lines).toEqual(["Infinitary command link linked"]);
    } finally {
      view.mockRestore();
      link.mockRestore();
    }
  });

  it("retries a stopped panel and asks again for its integration call", async () => {
    const retry = vi.spyOn(core.services.personal, "retry").mockResolvedValue(true);
    const askAgain = vi.spyOn(core.services.personal, "askAgain").mockReturnValue(true);
    try {
      const retried = await asked("panel-retry", { surface: "tokyo" }, "Start Tokyo again.");
      expect(retry).toHaveBeenCalledWith("tokyo", undefined);
      expect(retried.reply.answer).toEqual({ retried: true });
      expect(retried.lines).toEqual(["tokyo started again"]);
      const again = await asked("panel-ask-again", {
        surface: "tokyo",
        integration: "calendar",
        action: "list-events",
      });
      expect(askAgain).toHaveBeenCalledWith("tokyo", "calendar", "list-events");
      expect(again.reply.answer).toEqual({ asked: true });
      expect(again.lines).toEqual(["asked again for tokyo's list-events"]);
    } finally {
      retry.mockRestore();
      askAgain.mockRestore();
    }
  });

  it("ends a permission to read secrets by its id, in the captain's words", async () => {
    const real = await core.dispatch("inf:secrets:view", []);
    const read = {
      id: "read-1",
      key: "k1",
      label: "the deploy token",
      destination: "INF-12",
      secrets: ["deploy"],
      expires: Date.now() + 600_000,
      remaining: 1,
    };
    let reads = [read];
    const view = vi
      .spyOn(core.services.secrets, "view")
      .mockImplementation(async () => ({ ...real, reads }) as SecretsView);
    const action = vi.spyOn(core.services.secrets, "action").mockImplementation(async () => {
      reads = [];
      return { ...real, reads } as SecretsView;
    });
    try {
      const ended = await asked("secret-end-read", { id: "read-1" }, "End the deploy read now.");
      expect(action).toHaveBeenCalledWith({ kind: "end-read", id: "read-1" });
      expect(ended.lines).toEqual(["ended the permission to read the deploy token"]);
    } finally {
      view.mockRestore();
      action.mockRestore();
    }
  });

  it("keeps a computer waiting to be removed, and asks a Mac to set up its work again", async () => {
    let removal: DeviceView["removal"] = "when-back";
    const list = vi
      .spyOn(core.services.computers, "list")
      .mockImplementation(() => [
        device({ ...(removal ? { removal } : {}), workSetup: { state: "blocked" } }),
      ]);
    const keep = vi.spyOn(core.services.computers, "keep").mockImplementation(() => {
      removal = undefined;
      return device({ workSetup: { state: "blocked" } });
    });
    const fixWork = vi.spyOn(core.services.computers, "fixWork").mockReturnValue(true);
    try {
      const kept = await asked("device-keep", { deviceId: "mini" });
      expect(keep).toHaveBeenCalledWith("mini");
      expect(kept.lines).toEqual(["Mac mini stays on the list"]);
      const fixed = await asked("device-fix-work", { deviceId: "mini" });
      expect(fixWork).toHaveBeenCalledWith("mini");
      expect(fixed.reply.answer).toEqual({ asked: true });
      expect(fixed.lines).toEqual(["asked Mac mini to set up its work again"]);
    } finally {
      list.mockRestore();
      keep.mockRestore();
      fixWork.mockRestore();
    }
  });

  it("tries an SSH connection again", async () => {
    const tryAgain = vi.spyOn(core.services.sshConnections, "tryAgain").mockReturnValue(1);
    try {
      const tried = await asked("device-try-again", { deviceId: "mini" });
      expect(tryAgain).toHaveBeenCalledWith("mini");
      expect(tried.reply.answer).toEqual({ tried: 1 });
      expect(tried.lines).toEqual(["tried 1 SSH connection again"]);
    } finally {
      tryAgain.mockRestore();
    }
  });

  it("removes a private site on the list, and leaves no line for one it never held", async () => {
    let sites = ["wiki.corp.example"];
    const store = {
      list: () => sites,
      add: (site: string) => {
        sites = [...sites, site];
        return { ok: true as const, sites };
      },
      remove: (site: string) => {
        sites = sites.filter((each) => each !== site);
        return { ok: true as const, sites };
      },
    };
    const had = core.services.browsers;
    // Stands in for the task browsers' own list where this core keeps none.
    const browsers = had ?? ({ privateSites: store } as unknown as NonNullable<typeof had>);
    const privateSites = had ? vi.spyOn(had, "privateSites", "get") : undefined;
    privateSites?.mockReturnValue(store as never);
    core.services.browsers = browsers;
    try {
      const removed = await asked(
        "private-site-remove",
        { site: "wiki.corp.example" },
        "Take wiki.corp.example off the private sites.",
      );
      expect(sites).toEqual([]);
      expect(removed.lines).toEqual(["removed wiki.corp.example from private sites"]);
      const absent = await asked(
        "private-site-remove",
        { site: "wiki.corp.example" },
        "Take wiki.corp.example off the private sites.",
      );
      expect(absent.lines).toEqual([]);
    } finally {
      privateSites?.mockRestore();
      core.services.browsers = had;
    }
  });

  it("stops no copy a computer does not keep, leaving no line", async () => {
    const stopped = await asked("copy-stop", { deviceId: "mini" });
    expect(stopped.reply.answer).toEqual({ ok: false, text: STANDBY_WORDS.noCopies });
    expect(stopped.lines).toEqual([]);
  });

  it("restores the saved model pins after the current ones", async () => {
    const settings = core.services.settings;
    const was = settings.getRoutingSettings();
    const pin = { provider: "xai", id: "grok-4" };
    // Only the always-route migration saves pins aside; this stands in for its result.
    let saved = true;
    const realGet = settings.getRoutingSettings.bind(settings);
    const realSet = settings.setRoutingSettings.bind(settings);
    const get = vi
      .spyOn(settings, "getRoutingSettings")
      .mockImplementation(() =>
        saved ? { ...realGet(), pins: [], dormantPins: [pin] } : realGet(),
      );
    const set = vi.spyOn(settings, "setRoutingSettings").mockImplementation((next) => {
      saved = false;
      realSet(next);
    });
    try {
      const restored = await asked("model-pins", { restore: true });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ pins: [pin], dormantPins: [] }));
      const after = await core.dispatch("inf:settings:routing:get", []);
      expect(after.pins).toEqual([pin]);
      expect(after.dormantPins ?? []).toEqual([]);
      expect(restored.lines).toEqual(["model pins xai/grok-4"]);
    } finally {
      get.mockRestore();
      set.mockRestore();
      settings.setRoutingSettings(was);
    }
  });

  it("hands reconnect to the scheduler, leaving no line when nothing moved", async () => {
    const created = await core.dispatch("inf:automation:save", [
      { name: "Morning", spec: { kind: "every", minutes: 60 }, prompt: "Say good morning." },
    ]);
    const update = vi.spyOn(core.services.scheduler, "update");
    try {
      const edited = await asked("automation-edit", { id: created.id, reconnect: true });
      expect(update).toHaveBeenCalledWith(
        created.id,
        expect.objectContaining({ reconnect: true }),
        expect.anything(),
      );
      // A timed rule has no connection to move, so nothing changed and no line is left.
      expect(edited.lines).toEqual([]);
    } finally {
      update.mockRestore();
      await core.dispatch("inf:automation:delete", [created.id]);
    }
  });

  /**
   * The captain's pick on the review (add-window-target): what the first mate
   * changes of a window's own Settings goes to the window the captain names.
   * A Mac's window is played here by its own answers to the live frame, as
   * `ViewBackend` answers it from that Mac's own look.
   */
  const playWindow = (
    deviceId: string,
    own: { appearance: Record<string, unknown>; reminders?: boolean },
  ) =>
    vi
      .spyOn(core.services.workDevices, "liveToView")
      .mockImplementation((to, channel, payload, change) => {
        const ask = payload as { id: string; deviceId: string; channel: string; args: unknown[] };
        if (to !== deviceId || channel !== "inf:view:ask" || change !== "window-asks") return false;
        if (ask.channel === "inf:settings:appearance:set") {
          own.appearance = ask.args[0] as Record<string, unknown>;
        }
        if (ask.channel === "inf:keyboard:reminders:set") own.reminders = ask.args[0] === true;
        const result = ask.channel.startsWith("inf:keyboard:reminders")
          ? { on: own.reminders ?? true, pressed: {} }
          : own.appearance;
        queueMicrotask(
          () =>
            void core.dispatch("inf:view:answer", [ask.id, { ok: true, result }], {
              kind: "captain",
              view: deviceId,
            }),
        );
        return true;
      });

  it("changes the named Mac's own look through its window, and leaves this computer's alone", async () => {
    const devices = vi
      .spyOn(core.services.computers, "list")
      .mockReturnValue([device({ id: "studio", name: "Studio" })]);
    const theirs = { appearance: { ...(await appearance()), usageUnit: "tokens" } };
    const window = playWindow("studio", theirs);
    try {
      const here = await appearance();
      const before = operations().length;
      const answer = await tool("app_change").run({
        action: "usage-unit",
        value: { unit: "usd" },
        evidence: "Show dollars on this Mac.",
        computer: "studio",
      });
      expect(JSON.parse(answer.text).current).toEqual({ unit: "usd" });
      expect(theirs.appearance.usageUnit).toBe("usd");
      expect(await appearance()).toEqual(here);
      expect(
        operations()
          .slice(before)
          .map((task) => task.title),
      ).toEqual(["usage shown in usd on Studio"]);
      // A setting of the first mate's computer is never asked of a window.
      const refused = await tool("app_change").run({
        action: "decision-use-off",
        value: { use: "anything" },
        evidence: "Turn it off there.",
        computer: "Studio",
      });
      expect(refused.text).toContain("only for a window's own setting");
      const unknown = await tool("app_change").run({
        action: "usage-unit",
        value: { unit: "tokens" },
        evidence: "Tokens on the laptop.",
        computer: "Laptop",
      });
      expect(unknown.text).toContain("No Mac that controls this one is named Laptop");
    } finally {
      window.mockRestore();
      devices.mockRestore();
    }
  });

  it("asks this computer's own window for its key reminder, and says when no window answers", async () => {
    const window = playWindow("local", { appearance: {}, reminders: true });
    try {
      const switched = await asked("key-reminders", { on: false });
      expect(switched.reply.current).toEqual({ on: false });
      expect(switched.lines).toEqual(["key reminders off on this computer"]);
    } finally {
      window.mockRestore();
    }
    const unanswered = await tool("app_change").run({
      action: "key-reminders",
      value: { on: true },
      evidence: "Turn key reminders on.",
    });
    expect(unanswered.text).toContain("is not connected now");
  });
});
