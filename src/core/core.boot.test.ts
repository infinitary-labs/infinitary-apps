import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { CONNECTION_PORT } from "@shared/connection";
import { parsePairingLink } from "@shared/devices";
import { currentLanguage, setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { invokeContract, WORK_INVOKE_CHANNELS } from "@shared/ipc";
import { DEFAULT_APPEARANCE } from "@shared/preferences";
import { remoteLoginRefusedAnswerSchema, remoteLoginWords } from "@shared/remoteLogin";
import { BATCHES_OFF_REFUSAL } from "@shared/repos";
import { BATCHED_PULL_REQUESTS_OFFER } from "@shared/runbooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_PROVIDER_ID, mockModelsJson } from "../../tests/e2e/mockModels";
import { fakeHost, listening, quotaFixture, waitFor } from "../../tests/helpers/bootedCore";
import { recordNewerMigration } from "../../tests/helpers/database";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "./devices/identity";
import { RemoteLoginRefusedError } from "./devices/remoteLogin";
import { absentKeychain, type HostCapabilities, type HostTaskBrowser } from "./host";
import { type Core, startCore } from "./index";
import { appPathsFor, PERSONAL_WORKSPACE_NAME } from "./paths";
import { createAppTools } from "./pi/appTools";
import { EMIT_CARD_TOOL } from "./pi/cardTool";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import type { PlacedSessions } from "./placed/placedSessions";
import { PluginRecords } from "./plugins/pluginRecords";
import { PlacedWorkScores } from "./routing/placedWork";
import { offerInUse } from "./runbooks/runbooks";
import { bindTool } from "./session/tools";
import { openDatabase } from "./storage/db";
import { SettingsStore } from "./storage/settingsStore";
import { seedTask } from "./tasks/seedTask";
import { queryTasksAsync } from "./tasks/taskQuery";
import { TaskService } from "./tasks/taskService";
import { git } from "./workspace/git";
import { WorkspaceService } from "./workspace/workspaceService";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * What the whole core does at boot, by build and by what an earlier run
 * left (tests/helpers/bootedCore.ts): the dev-only local orchestrator, safe
 * mode, the knowledge gate, the idle ladder, an old microphone card, and
 * saved work this version cannot read.
 */

describe("the dev-only local orchestrator (roadmap 1.7)", () => {
  const LINE =
    "Your first mate is running on local-test at 127.0.0.1:9 for this dev checkout; crewmates route as usual.";
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  async function boot(
    packaged: boolean,
    environment = true,
    extra: Partial<HostCapabilities> = {},
  ): Promise<Core> {
    userDataDir = scratchDir("infinitary-core-local-");
    quotaDir = quotaFixture("infinitary-core-local-quota-");
    process.env.PI_OFFLINE = "1";
    if (environment) {
      process.env.INFINITARY_LOCAL_ORCHESTRATOR_URL = "http://127.0.0.1:9/v1";
      process.env.INFINITARY_LOCAL_ORCHESTRATOR_MODEL = "local-test";
    }
    core = await startCore({ ...fakeHost(userDataDir, packaged).host, ...extra });
    return core;
  }

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
    delete process.env.INFINITARY_LOCAL_ORCHESTRATOR_URL;
    delete process.env.INFINITARY_LOCAL_ORCHESTRATOR_MODEL;
  });

  // Regression: service composition must honor the host's optional reader capability.
  it.each(["absent", "available", "failed"] as const)(
    "agent and window searches and scoring honor the %s record-process capability",
    async (state) => {
      const mainHistory = vi.spyOn(PlacedWorkScores.prototype, "data");
      try {
        const booted = await boot(
          false,
          true,
          state === "absent"
            ? { recordProcess: undefined }
            : state === "failed"
              ? {
                  recordProcess: {
                    spawn: () => {
                      throw new Error("configured reader failed");
                    },
                  },
                }
              : {},
        );
        const tasks = booted.services.tasks;
        seedTask(tasks, {
          id: "archived-audit",
          title: "Audit the session report",
          status: "cancelled",
        });
        seedTask(tasks, {
          id: "other-history",
          title: "Update the release notes",
          status: "cancelled",
        });
        const processSearch = vi.spyOn(booted.services.recordReader, "tasks");
        const searching = queryTasksAsync(
          tasks,
          { text: "audit", status: "dropped" },
          undefined,
          undefined,
          undefined,
          booted.services.supervisor.toolHooks.taskQueryReach(),
        );
        if (state === "failed") await expect(searching).rejects.toThrow("configured reader failed");
        else {
          const found = await searching;
          expect(found.rows.map((row) => row.task_id)).toEqual(["archived-audit"]);
          expect(found.total).toBe(1);
        }
        expect(processSearch).toHaveBeenCalledTimes(state === "absent" ? 0 : 1);
        // The window's search of earlier work reads the same way (`inf:tasks:search`).
        const windowSearch = vi.spyOn(booted.services.recordReader, "closed");
        const earlier = booted.dispatch("inf:tasks:search", ["audit"]);
        if (state === "failed") await expect(earlier).rejects.toThrow("configured reader failed");
        else expect((await earlier).map((task) => task.id)).toEqual(["archived-audit"]);
        expect(windowSearch).toHaveBeenCalledTimes(state === "absent" ? 0 : 1);
        seedTask(tasks, {
          id: "ranking",
          title: "Audit the next session",
          status: "queued",
          startPolicy: "on-request",
        });
        mainHistory.mockClear();
        await booted.services.supervisor.placement.routeTask(
          "ranking",
          "Audit the next session",
          { kind: "implement", basis: "plan", basis_verified: true },
          null,
        );
        if (state === "absent") expect(mainHistory).toHaveBeenCalled();
        else expect(mainHistory).not.toHaveBeenCalled();
      } finally {
        mainHistory.mockRestore();
      }
    },
    60_000,
  );

  it("an unpackaged checkout seats the Firstmate on the named model: the gate closes and the feed says where", async () => {
    const booted = await boot(false);
    const feed = await booted.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).toContain(LINE);
    expect(feed.map((line) => line.text)).not.toContain(`First mate · note: ${LINE}`);
    // No account, no custom provider in the app's own models.json - only
    // the seat can answer, and that closes the first-run gate.
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(false);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator", "models.json"))).toBe(true);
    expect(existsSync(join(userDataDir, "auth", "models.json"))).toBe(false);
  }, 60_000);

  it("every build keeps task browsers on a host that has one, and a host with none keeps none", async () => {
    // The captain lifted the development gate (2026-10-07): an installed
    // build keeps task browsers exactly as a development one does. Only a
    // host with no browser engine keeps none.
    for (const { packaged, hasBrowser } of [
      { packaged: true, hasBrowser: true },
      { packaged: false, hasBrowser: true },
      { packaged: true, hasBrowser: false },
    ]) {
      let opened = 0;
      const proxies: { host: string; port: number }[] = [];
      const browser: HostTaskBrowser = {
        open: async (input) => {
          opened += 1;
          proxies.push({ host: input.proxy.host, port: input.proxy.port });
          throw new Error("this test makes no page");
        },
      };
      const booted = await boot(packaged, false, hasBrowser ? { browser } : {});
      // A core with task browsers hands a crewmate one, so its five tools are served.
      expect(booted.services.browsers !== undefined).toBe(hasBrowser);
      if (hasBrowser) {
        const answer = await booted.services.browsers
          ?.forTask("t1")
          .navigate({ url: "http://localhost:5173/" });
        expect(answer?.text).toBe(
          "This computer could not open a browser for this task right now.",
        );
        // Public websites (piece 5): the page's every connection off this
        // Mac goes through a guard listening on loopback, which goes with a
        // browser that did not open, so nothing is left listening.
        expect(proxies).toEqual([{ host: "127.0.0.1", port: expect.any(Number) }]);
        expect(await listening(proxies[0]?.port ?? 0)).toBe(false);
      }
      expect(opened).toBe(hasBrowser ? 1 : 0);
      // The captain's view of a task's browser (piece 2): Stop browser and
      // Open again reach a task browser wherever the host has one.
      expect(await booted.dispatch("inf:browser:stop", ["t1"])).toEqual(
        hasBrowser
          ? { ok: false, text: "This task's browser is not running." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(await booted.dispatch("inf:browser:reopen", ["t1"])).toEqual(
        hasBrowser
          ? { ok: false, text: "This task has no browser to open again." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      // Taking control and handing it back (piece 4) do too.
      const handle = { session: "run-1", generation: 1 };
      expect(await booted.dispatch("inf:browser:take", ["t1", handle])).toEqual(
        hasBrowser
          ? { ok: false, text: "This browser is no longer running, so there is nothing to take." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(await booted.dispatch("inf:browser:return", ["t1", handle])).toEqual(
        hasBrowser
          ? {
              ok: false,
              text: "This browser is no longer running, so there is nothing to return.",
            }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      // Signed-in sites (INF-4585): Settings lists them wherever the Mac
      // keeps task browsers, in a folder of their own that nothing writes
      // until the captain returns control from the kept profile.
      expect(await booted.dispatch("inf:browser:sign-ins", [])).toEqual({
        available: hasBrowser,
        signIns: [],
      });
      expect(await booted.dispatch("inf:browser:sign-ins:remove", ["aurora.example"])).toEqual(
        hasBrowser
          ? { ok: false, text: "This computer keeps no sign-in for aurora.example." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(
        await booted.dispatch("inf:browser:return", [
          "t1",
          handle,
          { site: "aurora.example", automatic: false },
        ]),
      ).toEqual(
        hasBrowser
          ? {
              ok: false,
              text: "This browser is no longer running, so there is nothing to return.",
            }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(existsSync(join(userDataDir, "web-sign-ins"))).toBe(false);
      expect(opened).toBe(hasBrowser ? 1 : 0);
      // A card's door to the browser (piece 3) needs a browser to name: a
      // crewmate is handed one only from this core's browsers, and only
      // with one does its emit_card offer browser_button.
      const emitCard = bindTool(EMIT_CARD_TOOL, {
        onCard: () => "card-t1-1",
        ...(booted.services.browsers ? { browser: booted.services.browsers.forTask("t1") } : {}),
      });
      expect(Object.hasOwn(emitCard.parameters.properties, "browser_button")).toBe(hasBrowser);
      // So does its request that the captain take the browser over.
      expect(Object.hasOwn(emitCard.parameters.properties, "browser_handoff")).toBe(hasBrowser);
      booted.dispose();
      core = undefined;
      await catalogRefreshesSettled();
    }
  });

  it("every build offers every device channel and card, packaged or not", async () => {
    for (const packaged of [true, false]) {
      const booted = await boot(packaged, false);
      // + A phone too, now the phone app is on TestFlight (the captain's
      // "Show it now, as you chose for TestFlight", INF-279).
      expect(await booted.dispatch("inf:devices:shown", [])).toEqual({
        shown: true,
      });
      // Joining by a command: another user on this Mac runs this one.
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "work", command: "another-user" }]),
      ).resolves.toMatchObject({
        kind: "work",
        command: {
          for: "another-user",
          text: expect.stringContaining("'work' 'join' 'infinitary://join?as=work"),
        },
      });
      // A development copy, outside an app bundle, cannot send itself to
      // another computer; an installed release sends the Firstmate published
      // for that computer's system (docs/devices.md, "Firstmate for another
      // system"). A command adds only a computer that runs work.
      if (packaged)
        await expect(
          booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-mac" }]),
        ).resolves.toMatchObject({ kind: "mac", command: { for: "another-mac" } });
      else
        await expect(
          booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-mac" }]),
        ).rejects.toThrow("cannot send itself to another computer");
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-user" }]),
      ).rejects.toThrow(
        "Only the command for another user on this computer adds one that only runs work",
      );
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "work", command: "another-mac" }]),
      ).rejects.toThrow(
        "Only the command for another user on this computer adds one that only runs work",
      );
      await expect(booted.dispatch("inf:devices:invite", [{ kind: "view" }])).rejects.toThrow(
        "A new link adds a computer that can control your first mate and run work",
      );
      expect(await booted.dispatch("inf:devices:list", [])).toEqual([]);
      expect(booted.services.appBundle()).toBeNull();
      await expect(booted.dispatch("inf:devices:keep", ["mini"])).rejects.toThrow(
        "No device with that id",
      );
      // Adding a computer by its address, its yes to leaving another
      // Firstmate there, and updating Firstmate there: a development copy
      // reaches no computer. An installed release asks the computer's system
      // first, so it is not asked here, where it would reach the network.
      if (!packaged) {
        await expect(booted.dispatch("inf:devices:add", ["sam@mini.local"])).rejects.toThrow(
          "This copy of Infinitary cannot send itself to another computer.",
        );
        await expect(
          booted.dispatch("inf:devices:add", ["sam@mini.local", { leave: true }]),
        ).rejects.toThrow("This copy of Infinitary cannot send itself to another computer.");
      }
      await expect(booted.dispatch("inf:devices:update", ["mini"])).rejects.toThrow(
        "No device with that id",
      );
      await expect(booted.dispatch("inf:devices:add", ["-oProxyCommand=x"])).rejects.toThrow();
      // This Mac's own SSH connections: the core starts none by itself -
      // only the shell does, once it attached the paired connection.
      await expect(booted.dispatch("inf:devices:try-again", [])).resolves.toEqual({ tried: 0 });
      await expect(
        booted.dispatch("inf:devices:change-address", ["mini", "sam@studio.local"]),
      ).rejects.toThrow("No device with that id");
      expect(booted.services.sshConnections.state("mini")).toBeUndefined();
      // A computer's own sign-in where projects live, asked whole.
      await expect(
        booted.dispatch("inf:devices:forge-sign-in", ["mini", "github.com"]),
      ).rejects.toThrow("No computer that runs work has that id");
      // A crewmate's conversation on a computer that runs work: every work
      // request is read, here refused only for its malformed request.
      const device = { kind: "device" as const, deviceId: "mini" };
      for (const channel of WORK_INVOKE_CHANNELS)
        await expect(
          booted.dispatch(channel, [{ task: "t1", callId: "c1" }], device),
        ).rejects.toThrow(`Rejected ${channel}: malformed request`);
      // A task whose record places it on such a computer never runs here
      // instead; no computer is ever in reach, and no Mac controls this
      // Firstmate, before the shell attaches the connection.
      seedTask(booted.services.tasks, {
        id: "t-placed",
        title: "website",
        status: "queued",
        deviceId: "mini",
      });
      await booted.services.supervisor.starts.dispatchQueuedTask("t-placed");
      expect(booted.services.tasks.get("t-placed")?.status).toBe("open");
      expect(booted.services.workDevices.inReach("mini")).toBe(false);
      expect(booted.services.workDevices.controlling("mini")).toBe(false);
      expect((booted.services.placed as PlacedSessions).factories("mini")).toBeDefined();
      // A working copy asked of that computer, or an artifact written there,
      // is refused only while it is out of reach.
      const placed = booted.services.placed as PlacedSessions;
      const prepared = placed.prepare("mini", "t-placed", null);
      const written = placed.copies.writeArtifact("t-placed", "mini", {
        runId: 1,
        artifactId: 1,
        bytes: new Uint8Array([1]),
      });
      await Promise.all(
        [prepared, written].map((asked) =>
          expect(asked).rejects.toThrow("That computer is out of reach, so nothing was sent."),
        ),
      );
      // What a task this Mac no longer records left there is removed once
      // that computer is in reach.
      const orders: string[] = [];
      const detach = booted.services.workDevices.attach({
        ask: async (_deviceId, channel) => {
          orders.push(channel);
          if (channel === "inf:sign-ins:list")
            return {
              providers: [],
              accounts: [
                {
                  id: "acct_claude_there",
                  providerId: "anthropic-claude",
                  kind: "subscription_oauth",
                  label: "Claude",
                  enabled: true,
                  connected: true,
                  pinned: false,
                  createdAt: 1,
                },
                {
                  id: "acct_codex_there",
                  providerId: "openai-codex",
                  kind: "subscription_oauth",
                  label: "Codex",
                  enabled: true,
                  connected: true,
                  pinned: true,
                  createdAt: 1,
                  cutOff: { class: "signed_out", since: 1 },
                },
              ],
              quota: null,
            };
          throw new Error("This test holds no computer.");
        },
        onWorkDevice: (listener) => {
          listener({ deviceId: "mini", contact: "in-reach" });
          return () => {};
        },
        onViewDevice: () => () => {},
      });
      await placed.copies.retireLeftover("mini", "t-gone");
      // A task there is routed among that computer's own sign-ins alone.
      const served = await placed.served("mini");
      expect(served.available).toContainEqual({
        provider: "anthropic-claude",
        id: "claude-sonnet-5-5",
      });
      expect(served.available.every((model) => model.provider === "anthropic-claude")).toBe(true);
      expect(served.accounts.get("anthropic-claude")).toBe("acct_claude_there");
      // A cut-off its sign-ins name is read: the cut-off sign-in is skipped,
      // and Claude there still serves, so nothing waits.
      expect(placed.cutOffOf("acct_codex_there@mini")?.class).toBe("signed_out");
      expect(placed.accountPlace("acct_codex_there@mini")).toEqual({
        provider: "Codex",
        where: "on the other computer",
      });
      expect(placed.signInWait("mini")).toBeUndefined();
      detach();
      expect(orders.includes("inf:session:close")).toBe(true);
      expect(orders.includes("inf:sign-ins:list")).toBe(true);
      const offered: string[] = [];
      const tools = createAppTools({
        dispatch: booted.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
        handover: (_target, offer) => {
          offered.push(offer.cardId);
          return "offered";
        },
      });
      const catalog = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "general" }))?.text ??
          "[]",
      ) as { action: string }[];
      for (const action of ["device-invite", "device-remove", "device-address", "device-update"])
        expect(catalog.some((line) => line.action === action)).toBe(true);
      // Signing a computer that runs work in to its own subscriptions.
      const intelligence = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "intelligence" }))
          ?.text ?? "[]",
      ) as { action: string }[];
      expect(intelligence.some((line) => line.action === "device-sign-in")).toBe(true);
      expect(await booted.dispatch("inf:devices:sign-ins", [])).toEqual([]);
      // Each device line offers its card, and the captain's click alone acts.
      const change = tools.find((tool) => tool.name === "app_change");
      for (const [value, evidence] of [
        [{ name: "MacBook Air" }, "connect my MacBook Air"],
        [{ how: "another-user" }, "run work as another user on this computer"],
        [{ how: "address", address: "sam@mini.local" }, "add my mini at sam@mini.local"],
      ] as const) {
        const asked = await change?.run({ action: "device-invite", value, evidence });
        expect(asked?.text, evidence).toBe("offered");
      }
      const signIn = await change?.run({
        action: "device-sign-in",
        value: { deviceId: "mini", provider: "openai-codex" },
        evidence: "sign in to codex on the mini",
      });
      expect(signIn?.text).toBe(
        "No computer that runs work has that deviceId. Look with app_state.",
      );
      // A project's Runs on is offered to the Firstmate and asked by the captain.
      const projects = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "projects" }))?.text ??
          "[]",
      ) as { action: string }[];
      expect(projects.some((line) => line.action === "project-runs-on")).toBe(true);
      expect(projects.some((line) => line.action === "project-settings")).toBe(true);
      const { repo } = await booted.dispatch("inf:repos:setup", [
        { kind: "init", name: "website" },
      ]);
      const runsOn = await change?.run({
        action: "project-runs-on",
        value: { repoId: repo.id, deviceId: "mini" },
        evidence: "run website on the mini",
        on_words: true,
      });
      expect(runsOn?.text).toBe(
        "No computer that runs work has that deviceId. Look with app_state.",
      );
      await expect(booted.dispatch("inf:devices:runs-on", [repo.id, null])).resolves.toMatchObject({
        id: repo.id,
        runsOn: null,
      });
      expect(
        (await booted.dispatch("inf:repos:list", [])).every((entry) => entry.runsOn === null),
      ).toBe(true);
      expect(offered).toEqual(["app-device-invite", "app-device-invite", "app-device-invite"]);
      // Devices says of a Mac a command added that macOS holds it on the
      // local network.
      const key = createKeyIdentity("Mac mini");
      const held = booted.services.devices.claim(
        {
          code: parsePairingLink(booted.services.devices.invite({ kind: "work" }).link).code,
          kind: "work",
          name: "Mac mini",
          user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1 },
        },
        {
          headers: {},
          socket: {
            remoteAddress: "192.168.4.30",
            localAddress: "192.168.4.48",
            localPort: CONNECTION_PORT,
            getPeerX509Certificate: () => new X509Certificate(key.cert),
          },
        } as unknown as IncomingMessage,
      );
      if (!held.ok) throw new Error(held.reason);
      expect(await booted.dispatch("inf:devices:list", [])).toEqual([
        expect.objectContaining({ id: held.grant.deviceId, heldOnLocalNetwork: true }),
      ]);
      booted.dispose();
      core = undefined;
      await catalogRefreshesSettled();
    }
  }, 60_000);

  it("an update refusal that may already have changed things says so only to a view that reads it", async () => {
    const booted = await boot(false, false);
    const said = remoteLoginWords.uncertain("Ubuntu worker");
    vi.spyOn(booted.services.computers, "update").mockRejectedValue(
      new RemoteLoginRefusedError("failed", said, said.join("\n"), true),
    );
    // An older view's strict reader, from before this field.
    const older = remoteLoginRefusedAnswerSchema.omit({ uncertain: true });
    const plain = await booted.dispatch("inf:devices:update", ["mini"]);
    expect(older.parse(plain)).toEqual({ refused: "failed", lines: [...said] });
    expect(plain).toEqual({ refused: "failed", lines: [...said] });
    for (const options of [{ packageFallback: true as const }, { address: "sam@ubuntu.local" }])
      expect(await booted.dispatch("inf:devices:update", ["mini", options])).toEqual({
        refused: "failed",
        lines: [...said],
        uncertain: true,
      });
  });

  // The review of INF-4930: a home that adds this computer takes it over in place only while
  // nothing was saved here, so a paired device counts as a model account does, read with no secret.
  it("calls a first launch untouched until a device is paired here", async () => {
    const booted = await boot(true);
    expect(await booted.dispatch("inf:app:first-run", [])).toMatchObject({
      gateOpen: true,
      untouched: true,
    });
    const key = createKeyIdentity("Phone");
    const held = booted.services.devices.claim(
      {
        code: parsePairingLink(booted.services.devices.invite({ kind: "work" }).link).code,
        kind: "work",
        name: "Mac mini",
        user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1 },
      },
      {
        headers: {},
        socket: {
          remoteAddress: "192.168.4.30",
          localAddress: "192.168.4.48",
          localPort: CONNECTION_PORT,
          getPeerX509Certificate: () => new X509Certificate(key.cert),
        },
      } as unknown as IncomingMessage,
    );
    if (!held.ok) throw new Error(held.reason);
    const after = await booted.dispatch("inf:app:first-run", []);
    expect(after.gateOpen).toBe(true);
    expect(after.untouched).toBeUndefined();
  }, 60_000);

  it("a packaged build cannot enable it: the same environment seats nothing, the Settings control is absent, and the write is refused", async () => {
    const booted = await boot(true);
    const feed = await booted.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).not.toContain(LINE);
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator"))).toBe(false);
    expect(await booted.dispatch("inf:settings:local-orchestrator:get", [])).toEqual({
      available: false,
      setting: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "" },
      active: null,
      problem: null,
    });
    await expect(
      booted.dispatch("inf:settings:local-orchestrator:set", [
        { enabled: true, baseUrl: "http://127.0.0.1:9/v1", model: "local-test" },
      ]),
    ).rejects.toThrow(/packaged build has none/);
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator"))).toBe(false);
  }, 60_000);

  it("an unpackaged checkout seats the Firstmate from the Settings row, and unseats it: the gate follows", async () => {
    // No environment at all: the row is the only way to ask for the seat.
    const booted = await boot(false, false);
    const before = await booted.dispatch("inf:settings:local-orchestrator:get", []);
    expect(before).toMatchObject({ available: true, active: null, problem: null });
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    const on = await booted.dispatch("inf:settings:local-orchestrator:set", [
      { enabled: true, baseUrl: "http://127.0.0.1:9/v1/", model: " local-test " },
    ]);
    expect(on).toEqual({
      available: true,
      setting: { enabled: true, baseUrl: "http://127.0.0.1:9/v1/", model: "local-test" },
      active: { model: "local-test", host: "127.0.0.1:9", source: "setting" },
      problem: null,
    });
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(false);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator", "models.json"))).toBe(true);
    const feedOn = await booted.dispatch("inf:feed:recent", []);
    expect(feedOn.map((line) => line.text)).toContain(LINE);
    expect(feedOn.map((line) => line.text)).not.toContain(`First mate · note: ${LINE}`);
    const off = await booted.dispatch("inf:settings:local-orchestrator:set", [
      { enabled: false, baseUrl: "http://127.0.0.1:9/v1/", model: "local-test" },
    ]);
    expect(off.active).toBeNull();
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    const feedOff = await booted.dispatch("inf:feed:recent", []);
    expect(feedOff.map((line) => line.text)).toContain(
      "Your first mate is back on its usual model; the local seat is off.",
    );
  }, 60_000);
});

/**
 * One switch for every plugin, and safe mode counts them all (one plugin
 * vehicle, Phase A, the captain's A3a): a panel the captain added comes up
 * off after two launches that never settled, exactly like his own, and the
 * switch in Settings brings both back. The record of what he added is
 * untouched by the switch.
 */
describe("safe mode takes back the panels the captain added", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("boots an added panel off with the captain's own, then serves both again on the switch", async () => {
    userDataDir = scratchDir("infinitary-core-safe-");
    quotaDir = scratchDir("infinitary-core-safe-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    // An added panel as the installer leaves one - its files and its
    // record through the record's one writer - beside one of his own, and
    // a launch record that says the last launch did not settle either.
    const panel =
      'import type { PanelProps } from "@firstmate/contracts";\nexport default (props: PanelProps) => props.id;\n';
    const added = join(userDataDir, "plugins", "meter");
    mkdirSync(added, { recursive: true });
    writeFileSync(
      join(added, "manifest.json"),
      JSON.stringify({ name: "Acme", version: "1.0.0", title: "Meter", sql: ["v_usage_v1"] }),
    );
    writeFileSync(join(added, "panel.tsx"), panel);
    const own = join(userDataDir, "fleet", "personal", "clock");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "panel.tsx"), panel);
    const db = openDatabase(userDataDir);
    new PluginRecords(db).commit("meter", {
      source: "path",
      spec: "/somewhere/meter",
      pinned: "sha256:0",
      name: "Acme",
      version: "1.0.0",
      title: "Meter",
      capabilities: { sql: ["v_usage_v1"] },
      stagedAt: 1,
    });
    new SettingsStore(db).setLaunchRecord({ pending: true, earlyCrashes: 1 });
    db.close();

    core = await startCore(fakeHost(userDataDir).host);
    const listed = async () =>
      (await core?.dispatch("inf:plugins:personal:list", []))?.extensions.map(
        (view) => `${view.source}:${view.id}`,
      );
    expect(await core.dispatch("inf:shell:preferences", [])).toMatchObject({
      panels: { enabled: false, offReason: "safe-mode" },
    });
    expect(await listed()).toEqual([]);

    await core.dispatch("inf:settings:panels:set", [true]);
    await waitFor(() => core?.services.personal.snapshot().extensions.length === 2, 10_000);
    expect(await listed()).toEqual(["yours:clock", "installed:meter"]);
  });
});

/**
 * The knowledge browser's reads at the protocol (docs/knowledge.md, "The
 * browser"): installed stable and alpha builds answer them, scoped and
 * counted, and a read makes no file of its own. Only this Mac's window
 * asks these browser reads.
 */
describe("the knowledge browser's reads, gated at the protocol", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  async function boot(version: string): Promise<Core> {
    userDataDir = scratchDir("infinitary-core-knowledge-");
    quotaDir = quotaFixture("infinitary-core-knowledge-quota-");
    process.env.PI_OFFLINE = "1";
    const { host } = fakeHost(userDataDir, true);
    core = await startCore({ ...host, app: { ...host.app, version } });
    return core;
  }

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  const READS = [
    ["inf:knowledge:collections", []],
    ["inf:knowledge:graph", [{ scope: "captain" }]],
    ["inf:knowledge:concepts", [{ scope: "captain" }]],
    ["inf:knowledge:findings", [{ scope: "captain", filter: "recheck" }]],
    ["inf:knowledge:entry", [{ id: "c-abcdef" }]],
    ["inf:knowledge:directions", [{ scope: "captain" }]],
    ["inf:knowledge:refs", [{ ids: ["f-abcdef"] }]],
    ["inf:knowledge:uses", [{ task: "t-1" }]],
  ] as const;

  it("a stable build answers every Knowledge read", async () => {
    const booted = await boot("0.2.0");
    expect(await booted.dispatch("inf:knowledge:enabled", [])).toEqual({
      enabled: true,
      held: false,
    });
    for (const [channel, args] of READS) {
      await expect(booted.dispatch(channel, [...args] as never)).resolves.toHaveProperty("state");
      // A view of this first mate asks them too (INF-1352's plan, piece 2).
      expect(invokeContract[channel].reach).toBe("views");
    }
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
  }, 60_000);

  it("an alpha answers them, and reading them makes no collection file", async () => {
    const booted = await boot("0.2.0-alpha.1");
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    expect(await booted.dispatch("inf:knowledge:enabled", [])).toEqual({
      enabled: true,
      held: false,
    });
    expect(await booted.dispatch("inf:knowledge:collections", [])).toEqual({
      state: "ready",
      collections: [
        {
          scope: "captain",
          name: "",
          private: true,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
        // The personal workspace is a project from the first start, so a
        // panel instruction can be a direction scoped to it (INF-1054).
        {
          scope: expect.any(String),
          name: PERSONAL_WORKSPACE_NAME,
          private: false,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
      ],
    });
    // Reading makes nothing: the first write makes the collection's file.
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    expect(await booted.dispatch("inf:knowledge:entry", [{ id: "c-abcdef" }])).toEqual({
      state: "missing",
    });
    expect(await booted.dispatch("inf:knowledge:refs", [{ ids: ["f-abcdef"] }])).toEqual({
      state: "ready",
      refs: [],
    });
    expect(await booted.dispatch("inf:knowledge:uses", [{ task: "t-1" }])).toEqual({
      state: "ready",
      uses: [],
      total: 0,
    });
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    await expect(
      booted.dispatch("inf:knowledge:graph", [{ scope: "repo-elsewhere" }]),
    ).rejects.toThrow("No collection repo-elsewhere");
  }, 60_000);
});

/**
 * The idle ladder's clock survives the app closing (the captain's Q8,
 * "durable next tick"): a record the ladder should already have acted on
 * while the app was shut acts at boot, from its saved clock and rung, once.
 * Driven through the real boot - migrations, the task writer, the boot
 * sweep - and the protocol a client reads cards through.
 */
describe("the idle ladder across a restart", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  afterEach(async () => {
    // Keep userData until the crew, the pool's background reset of the
    // dropped task's working copy, and its trash deletion have finished:
    // git still reading a tree this removes logs a late failure.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("raises the overdue stall card at boot, once, and its Discard ends the task", async () => {
    userDataDir = scratchDir("infinitary-core-idle-");
    quotaDir = scratchDir("infinitary-core-idle-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    // It holds a working copy, so boot reads it as dispatched, not as a
    // claim that never started: a real checkout, made the way a dispatch
    // makes one, so dropping the task can retire it.
    const tree = await new WorkspaceService(appPathsFor(userDataDir), {
      pool: false,
    }).createTaskWorktree("stuck-task");
    // A crewmate idle for an hour and a half when the app last closed; the
    // ladder had nudged it and sent both wakes, the second 35 minutes ago.
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    seedTask(tasks, {
      id: "stuck-task",
      title: "Tidy the docs",
      status: "completed",
      repoDir: tree.repoDir,
      worktreeDir: tree.cwd,
      branch: tree.branch,
    });
    const now = Date.now();
    tasks.turns.recordRecovery("stuck-task", {
      rung: 2,
      count: 2,
      at: now - 35 * 60_000,
      idleSince: now - 90 * 60_000,
    });
    db.close();

    core = await startCore(fakeHost(userDataDir).host);
    const booted = core;
    const stallCards = async () =>
      (await booted.dispatch("inf:cards:list", [])).filter(
        (card) => card.id === "card-stall-stuck-task",
      );
    await waitFor(() => booted.services.supervisor.cards.snapshot().length > 0, 10_000);
    const [card] = await stallCards();
    expect(card).toMatchObject({
      taskId: "stuck-task",
      author: "host",
      title: "Tidy the docs has been stuck for 1h 30m",
    });
    expect(booted.services.tasks.get("stuck-task")).toMatchObject({ recoveryRung: 3 });
    // The next tick changes nothing: the card holds the turn.
    booted.services.supervisor.watch.reconcileIdle(Date.now());
    expect(await stallCards()).toHaveLength(1);

    await booted.dispatch("inf:cards:act", ["card-stall-stuck-task", "discard", "chrome"]);
    await waitFor(() => booted.services.tasks.get("stuck-task")?.status === "dropped", 10_000);
    expect(booted.services.tasks.get("stuck-task")?.closedReason).toBe("discarded");
    expect(await stallCards()).toEqual([]);
    // The close retires the working copy after the row reads dropped; a
    // copy whose save failed would stay present.
    await waitFor(
      () => booted.services.tasks.get("stuck-task")?.workspaceState === "removed",
      10_000,
    );
    expect(existsSync(tree.cwd)).toBe(false);
  }, 60_000);
});

/**
 * The microphone note an earlier version raised on the first hold to talk
 * is a line under the input now (docs/composer.md, "Voice"): one still on
 * the stack comes down at the next launch.
 */
describe("a microphone card an earlier version left", () => {
  let core: Core | undefined;
  let userDataDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("comes down at the next launch", async () => {
    userDataDir = scratchDir("infinitary-core-mic-card-");
    process.env.PI_OFFLINE = "1";
    const earlier = await startCore(fakeHost(userDataDir).host);
    core = earlier;
    earlier.services.supervisor.cards.hostCards.addSystemNoteCard(
      "card-voice-mic-primer",
      "Microphone access",
      "macOS will ask for microphone access the first time you hold to talk.",
    );
    const ids = async (booted: Core) =>
      (await booted.dispatch("inf:cards:list", [])).map((card) => card.id);
    expect(await ids(earlier)).toContain("card-voice-mic-primer");
    await earlier.dispose();

    const next = await startCore(fakeHost(userDataDir).host);
    core = next;
    expect(await ids(next)).not.toContain("card-voice-mic-primer");
  }, 60_000);
});

/**
 * The review of the language choice (docs/i18n.md, "The language choice"):
 * the captain's saved choice is the language from the moment the settings
 * open, so boot recovery and the first mate's inbox word their turns in it,
 * never in the computer's own.
 */
describe("the captain's language choice at boot", () => {
  let core: Core | undefined;
  let userDataDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    setCurrentLanguage(SOURCE_LANGUAGE);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("speaks the saved choice over the computer's language before the core is handed back", async () => {
    userDataDir = scratchDir("infinitary-core-language-");
    process.env.PI_OFFLINE = "1";
    const db = openDatabase(userDataDir);
    new SettingsStore(db).setAppearance({ ...DEFAULT_APPEARANCE, language: "ja" });
    db.close();
    setCurrentLanguage("de");
    core = await startCore(fakeHost(userDataDir).host, { computerLanguage: "de" });
    expect(currentLanguage()).toBe("ja");
  }, 60_000);
});

/**
 * A wiped Windows install that skipped the sign-in screen: the app keeps
 * the whole Windows environment, Pi reads a provider's key from it when
 * nothing is saved, and that key outlives an uninstall and a data wipe.
 * A key only the environment holds is no account the person added, so the
 * gate stays open (docs/first-launch.md).
 */
describe("a provider key in the environment at first launch", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.INFINITARY_MOCK_PROVIDER_KEY;
  });

  it("leaves the sign-in screen up on a packaged build with OPENAI_API_KEY set", async () => {
    userDataDir = scratchDir("infinitary-core-env-key-");
    quotaDir = quotaFixture("infinitary-core-env-key-quota-");
    process.env.PI_OFFLINE = "1";
    process.env.OPENAI_API_KEY = "not-a-real-key";
    core = await startCore(fakeHost(userDataDir, true).host);
    const { auth } = core.services;
    // Pi's first availability pass has read the key once OpenAI's models serve account-less.
    await waitFor(
      () =>
        auth
          .accountless()
          .accountlessModels()
          .some((model) => model.provider === "openai"),
      30_000,
    );
    expect(await core.dispatch("inf:app:first-run", [])).toMatchObject({ gateOpen: true });
  }, 60_000);

  it("still counts a models.json provider whose key names an environment variable", async () => {
    userDataDir = scratchDir("infinitary-core-env-key-");
    quotaDir = quotaFixture("infinitary-core-env-key-quota-");
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_MOCK_PROVIDER_KEY = "not-a-real-key";
    const config = JSON.parse(mockModelsJson(9));
    config.providers[MOCK_PROVIDER_ID].apiKey = "INFINITARY_MOCK_PROVIDER_KEY";
    mkdirSync(join(userDataDir, "auth"), { recursive: true });
    writeFileSync(join(userDataDir, "auth", "models.json"), JSON.stringify(config));
    core = await startCore(fakeHost(userDataDir, true).host);
    const { auth } = core.services;
    await waitFor(
      () => auth.customProviderModels().some((model) => model.provider === MOCK_PROVIDER_ID),
      30_000,
    );
    expect(await core.dispatch("inf:app:first-run", [])).toMatchObject({ gateOpen: false });
  }, 60_000);
});

/**
 * pnpm dev on the person's own data (INF-5635's plan, piece 1): the source's
 * package.json version names no release, so the record keeps the version the
 * installed app last opened it on, and the installed app's next start is no
 * upgrade from the source's version.
 */
describe("a run from source on the person's own data", () => {
  let core: Core | undefined;
  let userDataDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("leaves the version the installed app recorded as the record's last", async () => {
    userDataDir = scratchDir("infinitary-core-source-run-");
    process.env.PI_OFFLINE = "1";
    const installed = fakeHost(userDataDir).host;
    core = await startCore({ ...installed, app: { ...installed.app, version: "0.8.6-alpha.16" } });
    const recorded = core.services.settings.getReleaseTracking();
    expect(recorded.baseline?.version).toBe("0.8.6-alpha.16");
    await core.dispose();

    const source = fakeHost(userDataDir).host;
    core = await startCore({
      ...source,
      app: { ...source.app, version: "0.1.30", sourceOnOwnData: true },
    });
    expect(core.services.settings.getReleaseTracking()).toEqual(recorded);
  }, 60_000);
});

describe("unsupported saved work stops before services start", () => {
  it("leaves accounts, conversations and launch state untouched", async () => {
    const userData = scratchDir("fm-core-refusal-");
    const db = openDatabase(userData);
    recordNewerMigration(db);
    db.close();
    const shell = fakeHost(userData);
    const host = {
      ...shell.host,
      keychain: {
        ...absentKeychain,
        read: async () => {
          throw new Error("must not read sign-ins on refusal");
        },
      },
    };
    await expect(startCore(host)).rejects.toMatchObject({ code: "unsupported-saved-data" });
    expect(existsSync(join(userData, "accounts"))).toBe(false);
    expect(existsSync(join(userData, "auth"))).toBe(false);
    expect(existsSync(join(userData, "firstmate"))).toBe(false);
  });
});

/**
 * INF-4754's approved plan with the captain's answers: Batched pull requests
 * starts off, so a project cannot newly choose them, and the start after the
 * update keeps it on for a home with a project already batching, which then
 * cannot turn it off while that project still uses it.
 */
describe("Batched pull requests across the update that starts it off", () => {
  let core: Core | undefined;
  let userDataDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("refuses the choice while off and keeps the runbook on for a project already batching", async () => {
    userDataDir = scratchDir("infinitary-core-batches-");
    process.env.PI_OFFLINE = "1";
    const earlier = await startCore(fakeHost(userDataDir).host);
    core = earlier;
    const batches = async (booted: Core) =>
      (await booted.dispatch("inf:settings:runbooks:get", [])).find((book) => book.id === "batches")
        ?.enabled;
    expect(await batches(earlier)).toBe(false);
    const { repo } = await earlier.services.repos.setup({ kind: "init", name: "meter" });
    const origin = "https://github.com/o/meter.git";
    await git(repo.path, ["remote", "add", "origin", origin]);
    await earlier.dispatch("inf:repos:configure", [repo.id, { origin, delivery: "direct-pr" }]);
    expect(
      (await earlier.dispatch("inf:repos:list", [])).find((each) => each.id === repo.id),
    ).toMatchObject({ batchesOffered: false });
    await expect(
      earlier.dispatch("inf:repos:configure", [repo.id, { delivery: "queue-pr" }]),
    ).rejects.toThrow(BATCHES_OFF_REFUSAL);
    await earlier.dispatch("inf:settings:runbooks:set", ["batches", true]);
    expect(
      await earlier.dispatch("inf:repos:configure", [repo.id, { delivery: "queue-pr" }]),
    ).toMatchObject({ delivery: "queue-pr", batchesOffered: true });
    // What an earlier version saved: a batched project and no switch for the runbook.
    earlier.services.settings.setRunbookStates({});
    await earlier.dispose();

    const next = await startCore(fakeHost(userDataDir).host);
    core = next;
    expect(await batches(next)).toBe(true);
    await expect(next.dispatch("inf:settings:runbooks:set", ["batches", false])).rejects.toThrow(
      offerInUse(BATCHED_PULL_REQUESTS_OFFER, ["meter"]),
    );
    expect(await batches(next)).toBe(true);
  }, 60_000);
});
