import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_NAMES, ACTIONS } from "@shared/actions";
import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { inLanguage, setCurrentLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { englishOf, wordedCardText, wordSaidMarks } from "@shared/i18n/said";
import { defaultArrangement, knownPanels, movePanel, panelSlot } from "@shared/panelArrangement";
import type { Layout } from "@shared/preferences";
import { SETUP_CARD_WORDS } from "@shared/projectSetup";
import type { QuotaSnapshotView } from "@shared/quota";
import { noChecksSaid } from "@shared/repos";
import { wordedTitle } from "@shared/welcome";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeHost, quotaFixture, waitFor } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { type Core, startCore } from "./index";
import { renderWake } from "./orchestrator/wakes";
import { createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { seedTask } from "./tasks/seedTask";
import { git, setManagedOriginPush } from "./workspace/git";
import { STALE_MOVE_CARD } from "./workspace/repositoryMove";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("the core, driven with no Electron in the process", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-");
    // The same isolation e2e uses: no pi.dev catalog fetch, quota off files.
    process.env.PI_OFFLINE = "1";
    quotaFixture("infinitary-core-quota-", [
      {
        provider: "codex",
        label: "Codex",
        status: "ok",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
      },
    ]);
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host);
  }, 60_000);

  afterAll(async () => {
    // Keep userData until the core has shut down and its background writes
    // have landed: removing it under a late write fails with ENOTEMPTY.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("runs Intelligence catalog actions through real settings and disposable accounts", async () => {
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");
    const run = async (action: string, value: unknown) => {
      const before = core.services.tasks.list().filter((t) => t.kind === "operation").length;
      const result = await change.run({ action, value, evidence: "captain asked" });
      const after = core.services.tasks.list().filter((t) => t.kind === "operation").length;
      expect(after - before).toBeLessThanOrEqual(1);
      return JSON.parse(result.text).current;
    };
    const account = await core.services.vault.add("xai", "api_key", {
      prompt: async () => "disposable-test-key",
      notify: () => {},
      openExternal: async () => {},
    });
    const before = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    expect(
      (await run("account-rename", { accountId: account.id, label: "Work" })).accounts,
    ).toContainEqual({ id: account.id, label: "Work" });
    expect(
      (await run("account-pause", { accountId: account.id, paused: true })).accounts,
    ).toContainEqual({ id: account.id, paused: true });
    await run("account-pause", { accountId: account.id, paused: false });
    expect(
      (await run("account-prefer", { provider: "xai", accountId: account.id })).accounts,
    ).toContainEqual({ id: account.id, provider: "xai", preferred: true });
    await run("account-prefer", { provider: "xai", accountId: null });
    // Firstmate's own account is its own action, apart from crew work's
    // preference, and its line names the account by label, never by id.
    const seatBefore = core.services.settings.getFirstmateAccount();
    const modelBefore = core.services.settings.getFirstmateModel();
    // An account of another provider than Firstmate's model is refused in
    // words that point at the model, and nothing is saved or written.
    core.services.settings.setFirstmateModel({ provider: "openai-codex", id: "gpt-5.5" });
    const linesBefore = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    expect(
      (
        await change.run({
          action: "firstmate-account",
          value: { accountId: account.id },
          evidence: "captain asked",
        })
      ).text,
    ).toBe(
      "Work is a Grok account, and your first mate answers with Codex. Choose a Grok model for your first mate first.",
    );
    expect(core.services.settings.getFirstmateAccount()).toBe(seatBefore);
    expect(core.services.tasks.list().filter((t) => t.kind === "operation")).toHaveLength(
      linesBefore,
    );
    // The seat starts on Auto: on a fresh profile the welcome's readiness
    // check has already saved the only account as Auto's pick, and a pick
    // that changes nothing files no line.
    core.services.settings.setFirstmateBinding({ provider: "xai", id: "grok-4" }, null);
    expect(await run("firstmate-account", { accountId: account.id })).toEqual({
      accountId: account.id,
    });
    expect(core.services.settings.getFirstmateAccount()).toBe(account.id);
    expect(
      (await core.dispatch("inf:accounts:list", [])).find((entry) => entry.id === account.id)
        ?.pinned,
    ).toBe(false);
    const seatLines = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation" && t.title.startsWith("First mate account"));
    expect(seatLines.map((t) => t.title)).toEqual(["First mate account Work"]);
    core.services.settings.setFirstmateBinding(modelBefore, seatBefore);
    const routing = await core.dispatch("inf:settings:routing:get", []);
    await run("model-pins", { pins: [{ provider: "xai", id: "grok-4" }] });
    await core.dispatch("inf:settings:routing:set", [{ ...routing, dynamicRouting: false }]);
    expect(await core.dispatch("inf:settings:routing:get", [])).toEqual({
      dynamicRouting: true,
      pins: [{ provider: "xai", id: "grok-4" }],
    });
    await expect(
      core.dispatch(
        "inf:settings:routing:set",
        [{ dynamicRouting: routing.dynamicRouting, pins: [] }],
        { kind: "firstmate", wake: "captain", action: "routing" as never, evidence: "asked" },
      ),
    ).rejects.toThrow("outside its action catalog");
    await run("crew-slots", { key: "xai/grok-4", slot: "high", on: true });
    await run("crew-slots", { key: "xai/grok-4", slot: "high", on: false });
    await run("crew-slots-reset", { provider: "xai" });
    const decisions = await core.dispatch("inf:settings:decisions", []);
    const answerer = { kind: "adapted", offering: "xai/grok-4" };
    expect(await run("decision-model", { answerer })).toEqual({ answerer });
    expect((await core.dispatch("inf:settings:decisions", [])).settings.egress).toEqual(
      decisions.settings.egress,
    );
    await expect(
      core.dispatch(
        "inf:settings:decisions:set",
        [{ ...decisions.settings, egress: { jev: { enabled: true } } }],
        { kind: "firstmate", wake: "captain", action: "decision-model", evidence: "asked" },
      ),
    ).rejects.toThrow("outbound consent");
    const refusal = await change.run({
      action: "firstmate-model",
      value: { model: { provider: "cursor", id: "missing" } },
      evidence: "asked",
    });
    expect(refusal.text).toMatch(/cannot run|not connected/);
    // Before attachment, the saved seat is protected too.
    core.services.settings.setFirstmateAccount(account.id);
    expect(
      (
        await change.run({
          action: "account-disconnect",
          value: { accountId: account.id },
          evidence: "asked",
        })
      ).text,
    ).toContain("account it is running on");
    core.services.settings.setFirstmateAccount(null);
    const attachment = vi
      .spyOn(core.services.firstmate, "boundAccount")
      .mockReturnValue(account.id);
    try {
      expect(
        (
          await change.run({
            action: "account-disconnect",
            value: { accountId: account.id },
            evidence: "asked",
          })
        ).text,
      ).toContain("account it is running on");
    } finally {
      attachment.mockRestore();
    }
    await run("firstmate-model", { model: null });
    const priorRefresh = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    await run("refresh-usage", {});
    await run("refresh-usage", {});
    expect(core.services.tasks.list().filter((t) => t.kind === "operation")).toHaveLength(
      priorRefresh + 2,
    );
    // INF-751: his typed words in a schedule he set disconnect on its wake.
    const scheduled = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "scheduled" }),
    }).find((t) => t.name === "app_change");
    if (!scheduled) throw new Error("Missing change tool");
    expect(
      JSON.parse(
        (
          await scheduled.run({
            action: "account-disconnect",
            value: { accountId: account.id },
            evidence: "Disconnect the Work account on Friday evening.",
          })
        ).text,
      ).action,
    ).toBe("account-disconnect");
    expect(await core.dispatch("inf:accounts:list", [])).not.toContainEqual(
      expect.objectContaining({ id: account.id }),
    );
    const lines = JSON.parse((await state.run({ area: "intelligence" })).text);
    expect(lines.map((l: { action: string }) => l.action)).toEqual(
      ACTION_NAMES.filter((name) => ACTIONS[name].area === "intelligence"),
    );
    expect(
      lines.every(
        (l: { action: keyof typeof ACTIONS; captainAllowed: boolean; firstmateAllowed: boolean }) =>
          l.captainAllowed &&
          l.firstmateAllowed === ["asked", "own-words"].includes(ACTIONS[l.action].tier),
      ),
    ).toBe(true);
    expect(core.services.tasks.list().filter((t) => t.kind === "operation").length).toBeGreaterThan(
      before,
    );
    await core.dispatch("inf:settings:routing:set", [routing]);
    await core.dispatch("inf:settings:decisions:set", [decisions.settings]);
  });

  it("adds projects through one catalog path with one actor trail and no duplicate or refused entries", async () => {
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const folder = scratchDir("catalog-adopt-");
    const setups = () =>
      core.services.tasks
        .list()
        .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")).length;
    const before = setups();
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    try {
      const added = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
      expect(added).toMatchObject({
        created: true,
        initializedGit: true,
        createdInitialCommit: true,
        repo: { kind: "project", delivery: "local-only", autonomy: false },
      });
      expect(setups()).toBe(before + 1);
      expect(events.filter((e) => e.type === "repo_setup")).toMatchObject([
        { actor: "captain", repoId: added.repo.id },
      ]);
      expect(
        core.services.tasks.list().find((t) => t.kind === "operation" && t.repoId === added.repo.id)
          ?.title,
      ).toBe(`Set up project ${added.repo.name}`);
      const cardsBefore = core.services.supervisor.cards.snapshot().length;
      expect(
        (
          await change.run({
            action: "project-setup",
            value: { kind: "adopt", path: folder },
            evidence: "add this folder",
          })
        ).text,
      ).toContain(`repo_id ${added.repo.id}`);
      expect(core.services.supervisor.cards.snapshot()).toHaveLength(cardsBefore);
      expect(setups()).toBe(before + 1);
      expect(events.filter((e) => e.type === "repo_setup")).toHaveLength(1);
      // Firstmate's ask puts up the setup card and adds nothing; the
      // captain's click on it adds the project, as his.
      const proposed = await change.run({
        action: "project-setup",
        value: { kind: "init", name: "catalog-setup", rigor: "quick" },
        evidence: "start catalog-setup",
      });
      const card = core.services.supervisor.cards
        .snapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("catalog-setup"));
      expect(card?.author).toBe("host");
      expect(proposed.text).toContain(card?.id);
      expect(core.services.repos.list().some((r) => r.name === "catalog-setup")).toBe(false);
      expect(setups()).toBe(before + 1);
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > 0, 10_000);
      expect(core.services.repos.list()).toContainEqual(
        expect.objectContaining({ name: "catalog-setup", delivery: "local-only", rigor: "quick" }),
      );
      expect(setups()).toBe(before + 2);
      expect(events.filter((e) => e.type === "repo_setup")).toMatchObject([
        { actor: "captain" },
        { actor: "captain" },
      ]);
      expect(told.mock.calls[0]?.[0].facts).toMatchObject({
        kind: "project-setup",
        outcome: "added",
        name: "catalog-setup",
      });
      await expect(
        core.dispatch("inf:repos:setup", [{ kind: "init", name: "../outside" }]),
      ).rejects.toThrow();
      const refused = vi
        .spyOn(core.services.repos, "setup")
        .mockRejectedValueOnce(new Error("host refused clone"));
      await expect(
        core.dispatch("inf:repos:setup", [
          { kind: "clone", origin: "https://github.com/octo/private.git" },
        ]),
      ).rejects.toThrow(
        "GitHub did not let this app add private. Sign in to GitHub at the top of this tab, then try again.",
      );
      refused.mockRestore();
      expect(setups()).toBe(before + 2);
      // A report's proposal still only asks; Firstmate itself can never set up.
      const autonomous = createAppTools({
        dispatch: core.dispatch,
        propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
        actor: () => ({ kind: "firstmate", wake: "other" }),
      }).find((t) => t.name === "app_change");
      expect(
        (
          await autonomous?.run({
            action: "project-setup",
            value: { kind: "init", name: "not-requested" },
            evidence: "my idea",
          })
        )?.text,
      ).toContain("setup card");
      await expect(
        core.dispatch("inf:repos:setup", [{ kind: "init", name: "not-requested" }], {
          kind: "firstmate",
          wake: "captain",
          action: "project-setup",
          evidence: "start not-requested",
        }),
      ).rejects.toThrow("This action stays with the captain in Settings.");
      expect(core.services.repos.list().some((r) => r.name === "not-requested")).toBe(false);
      expect(setups()).toBe(before + 2);
    } finally {
      told.mockRestore();
      off();
      for (const card of core.services.supervisor.cards.snapshot())
        if (card.id.startsWith("card-project-setup-"))
          core.services.supervisor.cards.hostCards.withdrawHostCard(card.id, "test over");
      for (const repo of core.services.repos.list()) {
        if (repo.path === folder || repo.name === "catalog-setup")
          core.services.repos.unregister(repo.id);
      }
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("carries a clone sign-in way to Firstmate while Settings keeps its own sentence", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const before = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")).length;
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const setup = vi
      .spyOn(core.services.repos, "setup")
      .mockRejectedValue(new Error("clone failed"));
    const signedIn = vi.spyOn(core.services.forges, "isSignedIn").mockReturnValue(false);
    const addFromCard = async (value: { kind: "clone"; origin: string }) => {
      const calls = told.mock.calls.length;
      await change.run({ action: "project-setup", value, evidence: "clone private" });
      const card = core.services.supervisor.cards
        .snapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("private"));
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > calls, 10_000);
      const wake = told.mock.calls.at(-1)?.[0];
      if (!wake) throw new Error("Firstmate was not told");
      return renderWake(wake);
    };
    try {
      const value = { kind: "clone" as const, origin: "https://github.com/octo/private.git" };
      await expect(core.dispatch("inf:repos:setup", [value])).rejects.toThrow(
        "GitHub did not let this app add private. Sign in to GitHub at the top of this tab, then try again.",
      );
      const text = await addFromCard(value);
      expect(text).toContain("Not signed in to GitHub (github.com)");
      expect(text).not.toContain("this tab");
      const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
      if (!json) throw new Error("Missing typed clone refusal");
      const refusal = JSON.parse(json);
      expect(refusal).toEqual({
        refused: "not-signed-in",
        host: "github.com",
        ways: [
          {
            label: "Sign in to GitHub",
            effect: { kind: "open", target: "projects", signIn: "github.com" },
          },
        ],
      });
      signedIn.mockReturnValue(true);
      expect(await addFromCard(value)).toContain(": clone failed. Nothing was added.");
      signedIn.mockReturnValue(false);
      expect(
        await addFromCard({ kind: "clone", origin: "https://git.example.com/octo/private.git" }),
      ).toContain(": clone failed. Nothing was added.");
      expect(
        core.services.tasks
          .list()
          .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")),
      ).toHaveLength(before);
      expect(events.filter((e) => e.type === "repo_setup")).toHaveLength(0);
    } finally {
      setup.mockRestore();
      signedIn.mockRestore();
      told.mockRestore();
      off();
    }
  });

  it("adds a project with the task key Firstmate asked for, shown on its card, and refuses a key in use", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const signedIn = vi.spyOn(core.services.forges, "isSignedIn").mockReturnValue(false);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const keyOf = async (name: string) =>
      (await core.dispatch("inf:projects:list", [])).find((project) => project.name === name)?.key;
    try {
      await change.run({
        action: "project-setup",
        value: { kind: "init", name: "keyed-setup", key: "kys" },
        evidence: "start keyed-setup, its tasks as KYS",
      });
      const card = core.services.supervisor.cards
        .snapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("keyed-setup"));
      expect(card?.body).toContain(`>${SETUP_CARD_WORDS.key}</span>`);
      expect(card?.body).toContain(">KYS</span>");
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > 0, 10_000);
      expect(told.mock.calls[0]?.[0].facts).toMatchObject({
        outcome: "added",
        name: "keyed-setup",
      });
      expect(await keyOf("keyed-setup")).toBe("KYS");

      const cards = core.services.supervisor.cards.snapshot().length;
      const inUse = "KYS is already the task key of keyed-setup. Choose another.";
      expect(
        (
          await change.run({
            action: "project-setup",
            value: { kind: "init", name: "keyed-other", key: "KYS" },
            evidence: "start keyed-other as KYS",
          })
        ).text,
      ).toBe(inUse);
      expect(core.services.supervisor.cards.snapshot()).toHaveLength(cards);
      // Settings' clone hears the same refusal, never a sign-in it does not need.
      await expect(
        core.dispatch("inf:repos:setup", [
          { kind: "clone", origin: "https://github.com/octo/keyed-other.git", key: "kys" },
        ]),
      ).rejects.toThrow(inUse);
      expect(await keyOf("keyed-other")).toBeUndefined();
    } finally {
      signedIn.mockRestore();
      told.mockRestore();
      for (const card of core.services.supervisor.cards.snapshot())
        if (card.id.startsWith("card-project-setup-"))
          core.services.supervisor.cards.hostCards.withdrawHostCard(card.id, "test over");
      for (const repo of core.services.repos.list())
        if (repo.name === "keyed-setup") core.services.repos.unregister(repo.id);
    }
  });

  // INF-4220's piece 2: the first mate's add card can put a repository in an existing project, whose
  // next task takes the project's key, the feed names the project, and the project takes a name of its own.
  it("adds a repository to an existing project from the first mate's card, and names the project on its own", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const events: { type: string; project?: string; text?: string }[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as (typeof events)[number]);
    });
    try {
      const wallet = await core.dispatch("inf:repos:setup", [
        { kind: "init", name: "wallet-app", key: "WAL" },
      ]);
      await change.run({
        action: "project-setup",
        value: { kind: "init", name: "wallet-service", project: "wal" },
        evidence: "put wallet-service in the WAL project",
      });
      const card = core.services.supervisor.cards
        .snapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.titleInto("wallet-service", "wallet-app"));
      expect(card?.body).toContain(`>${SETUP_CARD_WORDS.project}</span>`);
      expect(card?.body).not.toContain(`>${SETUP_CARD_WORDS.key}</span>`);
      expect(card?.actions?.[0]?.label).toBe(SETUP_CARD_WORDS.addInto);
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > 0, 10_000);
      expect(told.mock.calls[0]?.[0].facts).toMatchObject({
        outcome: "added",
        name: "wallet-service",
      });

      const service = core.services.repos.list().find((repo) => repo.name === "wallet-service");
      const project = (await core.dispatch("inf:projects:list", [])).find(
        (one) => one.key === "WAL",
      );
      expect(project?.repos?.map((repo) => repo.name)).toEqual(["wallet-app", "wallet-service"]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "repo_setup",
          name: "wallet-service",
          project: "wallet-app",
        }),
      );
      const task = core.services.tasks.create({
        id: "wallet-service-task",
        title: "Check the service",
        prompt: "p",
        repoId: service?.id ?? null,
      });
      expect(task.key).toMatch(/^WAL-\d+$/);

      await core.dispatch("inf:projects:rename", [project?.id ?? "", "Wallet"]);
      const renamed = (await core.dispatch("inf:projects:list", [])).find(
        (one) => one.key === "WAL",
      );
      expect(renamed?.name).toBe("Wallet");
      expect(core.services.repos.get(wallet.repo.id)?.name).toBe("wallet-app");
      await change.run({
        action: "project-name",
        value: { projectId: project?.id ?? "", name: "Harbor Ledger" },
        evidence: "call the wallet project Harbor Ledger",
      });
      expect(
        (await core.dispatch("inf:projects:list", [])).find((one) => one.key === "WAL")?.name,
      ).toBe("Harbor Ledger");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "personalized",
          text: "Renamed project Wallet to Harbor Ledger",
        }),
      );
    } finally {
      detach();
      told.mockRestore();
      for (const card of core.services.supervisor.cards.snapshot())
        if (card.id.startsWith("card-project-setup-"))
          core.services.supervisor.cards.hostCards.withdrawHostCard(card.id, "test over");
    }
  });

  // INF-5005's plan, part 1, with the captain's answer "keep each task's
  // key": repositories move into another project on the app's move card, and
  // nothing that names a repository or a task changes.
  it("moves two repositories into a third on the app's move card, keeping names, folders, settings and task keys, and back out again", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      changeProject: async (action, value, actor) =>
        (await core.services.projectChanges.request(action, value, actor)).text,
      actor: () => ({ kind: "firstmate", wake: "other" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const outcome = async (count: number) => {
      await waitFor(() => told.mock.calls.length >= count, 10_000);
      return told.mock.calls[count - 1]?.[0].facts;
    };
    const card = (id: string) => {
      const found = core.services.supervisor.cards.snapshot().find((c) => c.id === id);
      if (!found) throw new Error(`No card ${id}`);
      return found;
    };
    const click = (id: string, label: string) =>
      core.dispatch("inf:cards:act", [
        id,
        card(id).actions?.find((action) => action.label === label)?.id ?? "",
        "chrome",
      ]);
    const projects = () => core.dispatch("inf:projects:list", []);
    const projectId = async (key: string) => {
      const found = (await projects()).find((project) => project.key === key);
      if (!found) throw new Error(`No project ${key}`);
      return found.id;
    };
    const setup = async (name: string, place: { key: string } | { project: string }) =>
      (await core.dispatch("inf:repos:setup", [{ kind: "init", name, ...place }])).repo;
    const made: string[] = [];
    try {
      const target = await setup("ledger-app", { key: "LED" });
      const business = await setup("ledger-business", { key: "LEB" });
      const infra = await setup("ledger-infra", { key: "LEI" });
      made.push(target.id, business.id, infra.id);
      core.services.repos.configure(infra.id, { scope: "Servers and deploys." });
      core.services.repos.recordNoChecks(business.id, { at: 1, task: "LEB-9" });
      const planned = core.services.tasks.create({
        id: "ledger-planned",
        title: "Plan the invoice page",
        prompt: "p",
        repoId: business.id,
      });
      const running = seedTask(core.services.tasks, {
        id: "ledger-running",
        title: "Fix the deploy",
        repoId: infra.id,
        status: "running",
      });
      const finished = seedTask(core.services.tasks, {
        id: "ledger-finished",
        title: "Rotate the logs",
        repoId: infra.id,
        status: "cancelled",
      });
      const rule = core.services.scheduler.create(
        { kind: "daily", hour: 9, minute: 0, timeZone: "America/Los_Angeles" },
        "Read the business inbox.",
        true,
        "Business inbox",
        planned.projectId,
      );
      const direction = core.services.knowledge
        ? (
            await core.dispatch("inf:knowledge:direction:set", [
              { op: "add", text: "Keep invoices in euros.", scope: business.id, reason: "test" },
            ])
          ).direction.id
        : undefined;
      const kept = [business, infra].map((repo) => core.services.repos.get(repo.id));
      const targetProject = await projectId("LED");
      const value = { repoIds: [business.id, infra.id], project: "led" };
      const cardId = `card-project-change-project-move-${targetProject}`;

      expect(
        (
          await change.run({
            action: "project-move",
            value,
            evidence: "combine the ledger projects",
          })
        ).text,
      ).toContain(cardId);
      const offered = card(cardId);
      expect(offered.title).toBe("Move ledger-business and ledger-infra into ledger-app?");
      expect(offered.actions?.map((action) => action.label)).toEqual(["Apply move", "Not now"]);
      for (const words of [
        planned.key,
        running.key,
        "finished tasks follow, keys kept",
        "1 automation",
        `ledger-business (<span class="inf-mono">LEB</span>)`,
        `ledger-infra (<span class="inf-mono">LEI</span>)`,
      ])
        expect(offered.body).toContain(words);
      expect(offered.body).not.toContain(finished.key);
      await click(cardId, "Not now");
      expect(await outcome(1)).toMatchObject({ kind: "project-change", outcome: "not-now" });
      expect(core.services.repos.projectOf(business.id)?.key).toBe("LEB");

      // Apply move: one write moves both repositories, every task and the automation.
      await change.run({ action: "project-move", value, evidence: "combine the ledger projects" });
      await click(cardId, "Apply move");
      expect(await outcome(2)).toMatchObject({ kind: "project-change", outcome: "applied" });
      expect([business, infra].map((repo) => core.services.repos.get(repo.id))).toEqual(kept);
      const all = await projects();
      expect(all.find((project) => project.key === "LED")?.repos?.map((repo) => repo.name)).toEqual(
        ["ledger-app", "ledger-business", "ledger-infra"],
      );
      expect(
        all.filter((project) => ["LEB", "LEI"].includes(project.key)).map((p) => p.archived),
      ).toEqual([true, true]);
      for (const task of [planned, running, finished]) {
        const now = core.services.tasks.get(task.id);
        expect({ key: now?.key, projectId: now?.projectId, status: now?.status }).toEqual({
          key: task.key,
          projectId: targetProject,
          status: task.status,
        });
      }
      expect(core.services.scheduler.rules().find((r) => r.id === rule.id)?.projectId).toBe(
        targetProject,
      );
      if (direction)
        expect(
          core.services.knowledge?.directions.applying(target.id).map((row) => row.id),
        ).toContain(direction);
      expect(
        core.services.tasks.create({
          id: "ledger-next",
          title: "Next",
          prompt: "p",
          repoId: infra.id,
        }).key,
      ).toMatch(/^LED-\d+$/);
      await expect(setup("ledger-other", { key: "LEB" })).rejects.toThrow(
        "LEB is already the task key of ledger-business, a project combined into ledger-app.",
      );

      // A project of its own again: its removed project comes back with its
      // key, and only its own tasks go with it.
      const back = `card-project-change-project-move-${await projectId("LEI")}`;
      await change.run({
        action: "project-move",
        value: { repoIds: [infra.id], project: { own: true } },
        evidence: "put ledger-infra back on its own",
      });
      expect(card(back).title).toBe("Move ledger-infra into a project of its own?");
      await click(back, "Apply move");
      expect(await outcome(3)).toMatchObject({ outcome: "applied" });
      expect(core.services.repos.projectOf(infra.id)).toMatchObject({
        key: "LEI",
        repositories: 1,
      });
      expect(
        [running, finished, planned].map((task) => core.services.tasks.get(task.id)?.key),
      ).toEqual([running.key, finished.key, planned.key]);
      expect(core.services.tasks.get(running.id)?.projectId).toBe(running.projectId);
      expect(core.services.tasks.get(planned.id)?.projectId).toBe(targetProject);
      // Its numbering carries on from the tasks it had before it was combined.
      expect(
        core.services.tasks.create({
          id: "ledger-infra-next",
          title: "Next",
          prompt: "p",
          repoId: infra.id,
        }).key,
      ).toBe(`LEI-${Math.max(...[running, finished].map((t) => Number(t.key.split("-")[1]))) + 1}`);

      const personal = core.services.repos.list().find((repo) => repo.kind === "personal");
      if (!personal) throw new Error("No personal workspace");
      const personalKey = core.services.repos.projectOf(personal.id)?.key ?? "";
      for (const [repoIds, project, refusal] of [
        [
          [infra.id],
          { own: true },
          "ledger-infra is already in a project of its own, ledger-infra.",
        ],
        [[infra.id], "LEB", "ledger-business was removed, so nothing can join it."],
        [[infra.id], personalKey, "is the personal workspace and takes no repository."],
        [[personal.id], "LED", "The personal workspace keeps a project of its own."],
      ] as const)
        await expect(core.dispatch("inf:repos:move", [[...repoIds], project])).rejects.toThrow(
          refusal,
        );
      expect(core.services.repos.projectOf(infra.id)?.key).toBe("LEI");
      expect(core.services.repos.projectOf(personal.id)?.key).toBe(personalKey);

      // A card is refused once what it showed changed, a task that would
      // join as much as the repositories, and the refusal changes nothing.
      const own = `card-project-change-project-move-${await projectId("LEB")}`;
      const askOwn = () =>
        change.run({
          action: "project-move",
          value: { repoIds: [business.id], project: { own: true } },
          evidence: "put ledger-business back on its own",
        });
      await askOwn();
      core.services.tasks.create({
        id: "ledger-later",
        title: "Filed after the card",
        prompt: "p",
        repoId: business.id,
      });
      await click(own, "Apply move");
      expect(await outcome(4)).toMatchObject({ outcome: "failed", reason: STALE_MOVE_CARD });
      expect(core.services.repos.projectOf(business.id)?.key).toBe("LED");
      await askOwn();
      await core.dispatch("inf:repos:move", [[business.id], "LEI"]);
      await click(own, "Apply move");
      expect(await outcome(5)).toMatchObject({ outcome: "failed", reason: STALE_MOVE_CARD });
      expect(core.services.repos.projectOf(business.id)?.key).toBe("LEI");
      // The key's refusal names the project LEB was combined into, whatever
      // its repository did after.
      await expect(setup("ledger-again", { key: "LEB" })).rejects.toThrow(
        "LEB is already the task key of ledger-business, a project combined into ledger-app.",
      );
    } finally {
      told.mockRestore();
      for (const open of core.services.supervisor.cards.snapshot())
        if (open.id.startsWith("card-project-change-project-move-"))
          core.services.supervisor.cards.hostCards.withdrawHostCard(open.id, "test over");
      for (const id of made) if (core.services.repos.get(id)) core.services.repos.unregister(id);
    }
  });

  // INF-5005's plan: the captain's exact words apply a move at once, a click
  // proposes, and a move that splits an open task from its part is refused.
  it("applies a move on the captain's exact words with no card, and refuses one that splits a task from its part", async () => {
    const tool = (wake: "captain" | "captain-choice") => {
      const found = createAppTools({
        dispatch: core.dispatch,
        changeProject: async (action, value, actor) =>
          (await core.services.projectChanges.request(action, value, actor)).text,
        actor: () => ({ kind: "firstmate", wake }),
      }).find((t) => t.name === "app_change");
      if (!found) throw new Error("Missing app_change");
      return found;
    };
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const setup = async (name: string, place: { key: string } | { project: string }) =>
      (await core.dispatch("inf:repos:setup", [{ kind: "init", name, ...place }])).repo;
    const made: string[] = [];
    try {
      const web = await setup("shop-web", { key: "SHW" });
      const api = await setup("shop-api", { project: "SHW" });
      const kit = await setup("shop-kit", { key: "SHK" });
      made.push(web.id, api.id, kit.id);
      const words = tool("captain");
      const moveCards = () =>
        core.services.supervisor.cards
          .snapshot()
          .filter((c) => c.id.startsWith("card-project-change-project-move-"));

      // A card for a move that empties two projects and leaves a third
      // with a repository lists every project that leaves, with the key
      // nobody can take again, and not the one that stays.
      const pay = await setup("shop-pay", { key: "SHP" });
      const docs = await setup("shop-docs", { key: "SHD" });
      made.push(pay.id, docs.id);
      await tool("captain-choice").run({
        action: "project-move",
        value: { repoIds: [api.id, kit.id, pay.id], project: "SHD" },
        evidence: "the captain picked Combine",
        on_words: true,
      });
      const [three] = moveCards();
      if (!three) throw new Error("No move card");
      expect(three.title).toBe("Move shop-api and 2 more into shop-docs?");
      const leaves = three.body?.split("These 2 projects leave the project list")[1] ?? "";
      for (const words of [
        'shop-kit (<span class="inf-mono">SHK</span>)',
        'shop-pay (<span class="inf-mono">SHP</span>)',
      ])
        expect(leaves).toContain(words);
      expect(leaves).not.toContain("SHW");
      core.services.supervisor.cards.hostCards.withdrawHostCard(three.id, "test over");
      expect(moveCards()).toEqual([]);

      // A click on a card of the first mate's own is no authority: it
      // proposes. The card saves its English with the facts it was worded
      // from, so each view words it in its own language (the captain's
      // answer to the review: translate the move card) - here a home that
      // speaks French writes it, and an English and a French view read it.
      setCurrentLanguage("fr");
      try {
        await tool("captain-choice").run({
          action: "project-move",
          value: { repoIds: [kit.id], project: "SHW" },
          evidence: "the captain picked Combine",
          on_words: true,
        });
      } finally {
        setCurrentLanguage("en");
      }
      const [proposed] = moveCards();
      if (!proposed) throw new Error("No move card");
      const shown = (language: string) =>
        inLanguage(language, () => ({
          title: wordedTitle(proposed.title, proposed.body),
          labels: proposed.actions?.map((action) => wordedCardText(action.label, proposed.body)),
          body: wordSaidMarks(proposed.body ?? ""),
        }));
      const french = inLanguage("fr", () => ({
        title: m.projectsMoveTitleInto({ repositories: "shop-kit", project: "shop-web" }),
        labels: [m.projectsMoveApply(), m.projectsMoveNotNow()],
        asks: m.projectsMoveAsks({ count: 1 }),
      }));
      expect(proposed.title).toBe("Move shop-kit into shop-web?");
      expect(shown("en")).toMatchObject({
        title: "Move shop-kit into shop-web?",
        labels: ["Apply move", "Not now"],
      });
      expect(shown("fr")).toMatchObject({ title: french.title, labels: french.labels });
      expect(shown("fr").body).toContain(french.asks);
      expect(shown("fr").body).not.toContain("Your first mate asks");
      expect(core.services.repos.projectOf(kit.id)?.key).toBe("SHK");

      const applied = await words.run({
        action: "project-move",
        value: { repoIds: [kit.id], project: "SHW" },
        evidence: "move shop-kit into shop-web",
        on_words: true,
      });
      expect(JSON.parse(applied.text).action).toBe("project-move");
      expect(core.services.repos.projectOf(kit.id)).toMatchObject({ key: "SHW", repositories: 3 });
      expect(
        events.filter(
          (event) => event.type === "personalized" && event.text === "Moved shop-kit into shop-web",
        ),
      ).toHaveLength(1);
      expect(moveCards().map(({ id, title, body }) => ({ id, title, body }))).toEqual([
        { id: proposed.id, title: proposed.title, body: proposed.body },
      ]);

      // A part working in shop-api under an open task in shop-web stays with it.
      const parent = core.services.tasks.create({
        id: "shop-parent",
        title: "Launch the shop",
        prompt: "p",
        repoId: web.id,
      });
      const part = core.services.tasks.create({
        id: "shop-part",
        title: "Add the orders endpoint",
        prompt: "p",
        repoId: api.id,
        parentId: parent.id,
      });
      const refused = await words.run({
        action: "project-move",
        value: { repoIds: [api.id], project: { own: true, key: "SHA" } },
        evidence: "give shop-api a project of its own called SHA",
        on_words: true,
      });
      expect(refused.text).toContain(
        `Refused: ${parent.key} and its part ${part.key} would end up in different projects.`,
      );
      expect(core.services.repos.projectOf(api.id)?.key).toBe("SHW");
      expect(core.services.tasks.get(part.id)?.projectId).toBe(parent.projectId);
      expect((await core.dispatch("inf:projects:list", [])).some((p) => p.key === "SHA")).toBe(
        false,
      );
      expect(
        (
          await words.run({
            action: "project-move",
            value: { repoIds: [api.id], project: "SCR" },
            evidence: "move shop-api to scratch",
            on_words: true,
          })
        ).text,
      ).toContain("Scratch takes no repository.");

      // Only an open task and its open part hold a move: with the part
      // closed, shop-api - which joined a project at setup - takes a new
      // project of its own, and its closed part goes with it, keeping its key.
      core.services.tasks.close(part.id, { status: "dropped", reason: "cancelled", actor: "host" });
      const ownApi = await words.run({
        action: "project-move",
        value: { repoIds: [api.id], project: { own: true, key: "SHA" } },
        evidence: "give shop-api a project of its own called SHA",
        on_words: true,
      });
      expect(ownApi.text).toContain('"project-move"');
      expect(core.services.repos.projectOf(api.id)).toMatchObject({ key: "SHA", repositories: 1 });
      expect(core.services.tasks.get(part.id)).toMatchObject({
        key: part.key,
        projectId: core.services.repos.projectOf(api.id)?.id,
      });
      expect(core.services.tasks.get(parent.id)?.projectId).toBe(parent.projectId);

      // The other way round, from the repository its project was made
      // with: shop-web leaves shop-web's project, which keeps shop-kit, for
      // a new one; its closed task leaves that task's open part in shop-kit.
      const lead = core.services.tasks.create({
        id: "shop-lead",
        title: "Plan the storefront",
        prompt: "p",
        repoId: web.id,
      });
      const kitPart = core.services.tasks.create({
        id: "shop-kit-part",
        title: "Add the storefront parts",
        prompt: "p",
        repoId: kit.id,
        parentId: lead.id,
      });
      core.services.tasks.close(lead.id, { status: "dropped", reason: "cancelled", actor: "host" });
      expect(core.services.tasks.get(kitPart.id)?.status).not.toBe("dropped");
      const ownWeb = await words.run({
        action: "project-move",
        value: { repoIds: [web.id], project: { own: true, key: "SHX" } },
        evidence: "give shop-web a project of its own called SHX",
        on_words: true,
      });
      expect(ownWeb.text).toContain('"project-move"');
      const webProject = core.services.repos.projectOf(web.id);
      expect(webProject).toMatchObject({ key: "SHX", repositories: 1 });
      expect(core.services.repos.projectOf(kit.id)).toMatchObject({
        id: parent.projectId,
        key: "SHW",
        repositories: 1,
      });
      expect(
        [parent, lead, kitPart].map((task) => {
          const now = core.services.tasks.get(task.id);
          return { key: now?.key, projectId: now?.projectId };
        }),
      ).toEqual([
        { key: parent.key, projectId: webProject?.id },
        { key: lead.key, projectId: webProject?.id },
        { key: kitPart.key, projectId: parent.projectId },
      ]);
    } finally {
      off();
      for (const open of core.services.supervisor.cards.snapshot())
        if (open.id.startsWith("card-project-change-project-move-"))
          core.services.supervisor.cards.hostCards.withdrawHostCard(open.id, "test over");
      for (const id of made) if (core.services.repos.get(id)) core.services.repos.unregister(id);
    }
  });

  // Regression: the normal Settings and removal callers release the app's fork push address before changing metadata.
  it("cleans a contribution push address through Settings and project removal", async () => {
    const folder = scratchDir("contribution-cleanup-");
    const { repo } = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
    const upstream = {
      id: 1296269,
      fullName: "octocat/Hello-World",
      origin: "https://github.com/octocat/Hello-World.git",
    };
    const fork = {
      id: 210,
      fullName: "contributor/Hello-World",
      origin: "https://github.com/contributor/Hello-World.git",
    };
    try {
      await git(folder, ["remote", "add", "origin", upstream.origin]);
      core.services.repos.configure(repo.id, { origin: upstream.origin });
      core.services.repos.setContribution(repo.id, { upstream, fork, destination: "upstream" });
      await setManagedOriginPush(folder, fork.origin);
      await git(folder, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/octocat/Spoon-Knife.git",
      ]);
      const changed = await core.dispatch("inf:repos:configure", [
        repo.id,
        { origin: "https://github.com/octocat/Spoon-Knife.git" },
      ]);
      expect(changed.contribution).toBeUndefined();
      expect(await git(folder, ["config", "--get", "remote.origin.pushurl"]).catch(() => "")).toBe(
        "",
      );
      await git(folder, ["remote", "set-url", "origin", upstream.origin]);
      core.services.repos.configure(repo.id, { origin: upstream.origin });
      core.services.repos.setContribution(repo.id, { upstream, fork, destination: "upstream" });
      await setManagedOriginPush(folder, fork.origin);
      await core.dispatch("inf:repos:remove", [repo.id]);
      expect(core.services.repos.get(repo.id)).toBeUndefined();
      expect(existsSync(folder)).toBe(true);
      expect(await git(folder, ["config", "--get", "remote.origin.pushurl"]).catch(() => "")).toBe(
        "",
      );
    } finally {
      if (core.services.repos.get(repo.id)) await core.dispatch("inf:repos:remove", [repo.id]);
    }
  });

  it("removes a project through one catalog path: names busy tasks, leaves the folder, on the captain's own words wherever they reach the first mate", async () => {
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const folder = scratchDir("catalog-remove-");
    writeFileSync(join(folder, "keep.txt"), "mine\n");
    const { repo } = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
    try {
      const own = createAppTools({
        dispatch: core.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
      }).find((t) => t.name === "app_change");
      const reported = createAppTools({
        dispatch: core.dispatch,
        actor: () => ({ kind: "firstmate", wake: "other" }),
      }).find((t) => t.name === "app_change");
      if (!own || !reported) throw new Error("Missing app_change");

      const busy = seedTask(core.services.tasks, {
        id: "remove-busy",
        title: "Fix the sign-up form",
        repoId: repo.id,
        status: "running",
      });
      expect(await core.dispatch("inf:repos:removal", [repo.id])).toEqual({
        tasks: [{ key: busy.key, title: "Fix the sign-up form", status: "working" }],
      });
      const refusal = `${repo.name} still has 1 task: ${busy.key} "Fix the sign-up form" (working). Finish or drop it, then remove it.`;
      await expect(core.dispatch("inf:repos:remove", [repo.id])).rejects.toThrow(refusal);
      // His typed words in his own turn, and the same words a crewmate relays
      // in its report (INF-751), meet the same check.
      for (const [tool, evidence] of [
        [own, "remove it"],
        [reported, 'The captain replied under SCR-1\'s card: "remove it from the app".'],
      ] as const)
        expect(
          (await tool.run({ action: "project-remove", value: { repoId: repo.id }, evidence })).text,
        ).toContain(refusal);
      expect(core.services.repos.get(repo.id)).toBeDefined();
      expect(events.filter((e) => e.type === "repo_unregistered")).toHaveLength(0);

      core.services.tasks.close(busy.id, {
        status: "dropped",
        reason: "cancelled",
        actor: "captain",
      });
      expect(await core.dispatch("inf:repos:removal", [repo.id])).toEqual({ tasks: [] });
      const operations = () =>
        core.services.tasks.list().filter((t) => t.kind === "operation" && t.repoId === repo.id);
      await core.dispatch("inf:repos:remove", [repo.id]);
      expect(core.services.repos.get(repo.id)).toBeUndefined();
      expect(existsSync(join(folder, "keep.txt"))).toBe(true);
      expect(events.filter((e) => e.type === "repo_unregistered")).toMatchObject([
        { actor: "captain", repoId: repo.id, name: repo.name },
      ]);
      expect(operations().map((t) => t.title)).toContain(`Removed project ${repo.name}`);
      await expect(core.dispatch("inf:repos:remove", [repo.id])).rejects.toThrow("not here");
    } finally {
      off();
      if (core.services.repos.get(repo.id)) core.services.repos.unregister(repo.id);
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps project downloads off the Settings queue", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = core.services.repos.setup.bind(core.services.repos);
    const setup = vi.spyOn(core.services.repos, "setup").mockImplementation(async (spec) => {
      await held;
      return original(spec);
    });
    const pending = core.dispatch("inf:repos:setup", [{ kind: "init", name: "catalog-queue" }]);
    try {
      await core.dispatch("inf:settings:appearance:set", [
        { theme: "dark", size: 100, washStrength: 0, showCrewModelNames: true },
      ]);
      expect(setup).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      const result = await pending;
      setup.mockRestore();
      core.services.repos.unregister(result.repo.id);
    }
  });

  it("folds project, theme and panel actions into one attributed trail and preserves other values", async () => {
    const created = await core.services.repos.setup({ kind: "init", name: "catalog-policy" });
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const apply = (action: string, value: unknown) =>
      change.run({ action, value, evidence: "captain asks", on_words: true });
    const count = () => core.services.tasks.list().filter((t) => t.kind === "operation").length;
    const initial = count();
    try {
      const changed = await apply("project-settings", {
        repoId: created.repo.id,
        changes: { autonomy: true, rigor: "reviewed" },
      });
      expect(
        JSON.parse(changed.text).current.projects.find(
          (r: { id: string }) => r.id === created.repo.id,
        ),
      ).toMatchObject({ delivery: "local-only", autonomy: true, rigor: "reviewed" });
      expect(count()).toBe(initial + 1);
      expect(events.filter((e) => e.type === "repo_configured")).toMatchObject([
        { actor: "firstmate" },
      ]);
      expect(events.filter((e) => e.type === "personalized")).toHaveLength(0);
      const operation = core.services.tasks
        .list()
        .find((t) => t.kind === "operation" && t.repoId === created.repo.id);
      expect(
        core.services.tasks.timeline(operation?.id ?? "").find((e) => e.kind === "status")?.actor,
      ).toBe("firstmate");
      await apply("project-settings", { repoId: created.repo.id, changes: { autonomy: true } });
      expect(count()).toBe(initial + 1);
      expect(
        (await apply("project-settings", { repoId: "missing", changes: { autonomy: true } })).text,
      ).toContain("Unknown repo_id");
      expect(
        (await apply("project-settings", { repoId: created.repo.id, changes: {} })).text,
      ).toContain("pass delivery");
      expect(count()).toBe(initial + 1);
      // INF-751: the captain's choices, relayed in a crewmate's report, apply
      // on its wake, each with its trail.
      wake = "other";
      const beforeRelayed = count();
      await apply("theme", { theme: "light" });
      expect((await core.dispatch("inf:settings:appearance:get", [])).theme).toBe("light");
      await apply("panel", { surface: "now", visible: false });
      expect((await core.dispatch("inf:settings:layout:get", [])).hiddenPanels.now).toBe(true);
      await apply("project-settings", { repoId: created.repo.id, changes: { autonomy: false } });
      expect(core.services.repos.get(created.repo.id)?.autonomy).toBe(false);
      expect(count()).toBe(beforeRelayed + 3);
      wake = "scheduled";
      const appearance = {
        theme: "dark" as const,
        size: 125 as const,
        washStrength: 37,
        showCrewModelNames: false,
      };
      await core.dispatch("inf:settings:appearance:set", [appearance]);
      await apply("theme", { theme: "light" });
      expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
        ...appearance,
        theme: "light",
      });
      const afterTheme = count();
      await apply("theme", { theme: "light" });
      expect(count()).toBe(afterTheme);
      const layout = { collapsedPanels: { activity: true }, hiddenPanels: {}, placements: {} };
      await core.dispatch("inf:settings:layout:set", [layout]);
      // INF-2344: a move is written in the one saved arrangement, never in
      // the placements an older build read.
      const where = (saved: Layout) =>
        saved.arrangement ? panelSlot(saved.arrangement, "now")?.slot : undefined;
      await apply("panel", { surface: "now", rail: "left", position: "top", visible: false });
      const moved = await core.dispatch("inf:settings:layout:get", []);
      expect(moved).toMatchObject({ ...layout, hiddenPanels: { now: true } });
      expect(where(moved)).toEqual({ x: "left", y: "top" });
      const arranged = count();
      await apply("panel", { surface: "Tasks", rail: "left", position: "top", visible: false });
      expect(count()).toBe(arranged);
      await apply("panel", { surface: "now", rail: "right", position: "bottom", visible: true });
      const back = await core.dispatch("inf:settings:layout:get", []);
      expect(back).toMatchObject(layout);
      expect(back.hiddenPanels).toEqual({});
      expect(where(back)).toEqual({ x: "right", y: "bottom" });
      expect((await apply("panel", { surface: "missing", visible: false })).text).toContain(
        "Your surfaces:",
      );
      expect((await apply("panel", { surface: "now" })).text).toContain("panel needs");
      await expect(
        core.dispatch("inf:settings:appearance:set", [{ ...appearance, theme: "dark" }], {
          kind: "firstmate",
          wake: "captain",
          action: "window-wash",
          evidence: "asked",
        }),
      ).rejects.toThrow("named appearance");
      await expect(
        core.dispatch("inf:settings:layout:set", [{ ...layout, hiddenPanels: { now: true } }], {
          kind: "firstmate",
          wake: "captain",
          action: "panel-collapse",
          evidence: "asked",
        }),
      ).rejects.toThrow("named panel");
      await expect(
        core.dispatch(
          "inf:settings:layout:set",
          [{ ...layout, collapsedPanels: {}, hiddenPanels: { now: true } }],
          { kind: "firstmate", wake: "captain", action: "panel", evidence: "asked" },
        ),
      ).rejects.toThrow("named panel");
      const beforeCaptain = count();
      await core.dispatch("inf:repos:configure", [created.repo.id, { autonomy: true }]);
      expect(count()).toBe(beforeCaptain + 1);
      expect(events.filter((e) => e.type === "repo_configured")).toMatchObject([
        { actor: "firstmate" },
        { actor: "firstmate" },
        { actor: "captain" },
      ]);
    } finally {
      detach();
      core.services.repos.unregister(created.repo.id);
    }
  });

  it("keeps panel defaults on the shared write path and docks a fourth panel on a rail", async () => {
    const old = await core.dispatch("inf:settings:layout:get", []);
    const snapshot = vi.spyOn(core.services.personal, "snapshot").mockReturnValue({
      extensions: ["clock", "quota"].map((id) => ({
        id,
        source: "yours" as const,
        by: null,
        frame: null,
        title: id,
        placement: { x: "right" as const, y: "top" as const },
        order: 100,
        size: "content" as const,
        present: true,
        ownPresence: false,
        moves: false,
        running: false,
        reads: [],
        sql: [],
        panel: null,
        server: null,
        cardViews: [],
        cards: {},
        header: [],
        commands: [],
        error: null,
      })),
    });
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    try {
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      // INF-609, the captain: "allow more panels ... not refusing it." Tasks,
      // clock and quota hold the right rail; Activity joins them as a fourth.
      // INF-2344: each move lands in its slot's middle in the one saved
      // arrangement, and the placements an older build read stay as they were.
      const arranged = async () => {
        const layout = await core.dispatch("inf:settings:layout:get", []);
        expect(layout.placements).toEqual({});
        return layout.arrangement;
      };
      await change.run({
        action: "panel",
        value: { surface: "activity", rail: "right" },
        evidence: "move activity right",
      });
      expect((await arranged())?.right.bottom[0]).toBe("activity");
      expect((await arranged())?.right.bottom).toContain("now");
      await change.run({
        action: "panel",
        value: { surface: "activity", rail: "left" },
        evidence: "put activity back",
      });
      expect((await arranged())?.left.bottom).toEqual(["activity"]);
      await change.run({
        action: "panel",
        value: { surface: "clock", rail: "left", position: "bottom" },
        evidence: "move clock left",
      });
      expect((await arranged())?.left.bottom).toEqual(["clock", "activity"]);
      await change.run({
        action: "panel",
        value: { surface: "clock", rail: "right", position: "top" },
        evidence: "put clock back",
      });
      expect((await arranged())?.right.top).toEqual(["quota", "clock"]);
    } finally {
      // Restore the layout while the roster that owns any deviations is still present.
      await core.dispatch("inf:settings:layout:set", [old]);
      snapshot.mockRestore();
    }
  });

  // INF-2344: the first mate edits the same arrangement the rails draw, just
  // above or below a panel the captain names, and Activity says where it
  // went; a Reset to defaults that puts several back is one line.
  it("moves a panel just above or below another and says where in one Activity line, naming the panel moved", async () => {
    const old = await core.dispatch("inf:settings:layout:get", []);
    const extensions = ["clock", "quota"].map((id) => ({
      id,
      source: "yours" as const,
      by: null,
      frame: null,
      title: id,
      placement: { x: "right" as const, y: "top" as const },
      order: 100,
      size: "content" as const,
      present: true,
      ownPresence: false,
      moves: false,
      running: false,
      reads: [],
      sql: [],
      panel: null,
      server: null,
      cardViews: [],
      cards: {},
      header: [],
      commands: [],
      error: null,
    }));
    const snapshot = vi.spyOn(core.services.personal, "snapshot").mockReturnValue({ extensions });
    const feed: string[] = [];
    let detach = () => {};
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const arrangement = async () =>
      (await core.dispatch("inf:settings:layout:get", [])).arrangement;
    const defaults = defaultArrangement(knownPanels({ extensions }));
    try {
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {}, arrangement: defaults },
      ]);
      detach = core.events.subscribe((channel, payload) => {
        const event = payload as { type: string; text?: string };
        if (channel === "inf:event" && event.type === "personalized") feed.push(event.text ?? "");
      });
      await change.run({
        action: "panel",
        value: { surface: "quota", above: "clock" },
        evidence: "put quota above the clock",
      });
      expect((await arrangement())?.right.top).toEqual(["quota", "clock"]);
      await change.run({
        action: "panel",
        value: { surface: "now", below: "activity" },
        evidence: "put tasks under activity",
      });
      expect((await arrangement())?.left.bottom).toEqual(["activity", "now"]);
      expect(feed).toEqual([
        "quota moved to the right rail, top, above clock",
        "Tasks moved to the left rail, bottom, below Activity",
      ]);
      const refused = await change.run({
        action: "panel",
        value: { surface: "now", above: "create-panel" },
        evidence: "put tasks above the slot",
      });
      expect(refused.text).toContain("not a panel to move next to");
      // The captain's Reset to defaults in Settings → Panels.
      const layout = await core.dispatch("inf:settings:layout:get", []);
      await core.dispatch("inf:settings:layout:set", [{ ...layout, arrangement: defaults }]);
      expect(await arrangement()).toEqual(defaults);
      expect(feed.slice(2)).toEqual(["Panels put back where each asks to be"]);
      // The captain drags quota's header above clock: the two trade places,
      // which reads either way, so the window names the panel it moved.
      const reset = await core.dispatch("inf:settings:layout:get", []);
      const dragged = movePanel(defaults, "quota", {
        slot: { x: "right", y: "top" },
        above: "clock",
      });
      await core.dispatch("inf:settings:layout:set", [
        { ...reset, arrangement: dragged },
        { moved: "quota" },
      ]);
      expect(feed.slice(3)).toEqual(["quota moved to the right rail, top, above clock"]);
    } finally {
      detach();
      await core.dispatch("inf:settings:layout:set", [old]);
      snapshot.mockRestore();
    }
  });

  it("hides and shows the create-your-own-panel slot by its id and never moves it", async () => {
    const old = await core.dispatch("inf:settings:layout:get", []);
    const snapshot = vi.spyOn(core.services.personal, "snapshot").mockReturnValue({
      extensions: ["clock", "quota"].map((id) => ({
        id,
        source: "yours" as const,
        by: null,
        frame: null,
        title: id,
        placement: { x: "right" as const, y: "top" as const },
        order: 100,
        size: "content" as const,
        present: true,
        ownPresence: false,
        moves: false,
        running: false,
        reads: [],
        sql: [],
        panel: null,
        server: null,
        cardViews: [],
        cards: {},
        header: [],
        commands: [],
        error: null,
      })),
    });
    const feed: string[] = [];
    let detach = () => {};
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const layout = () => core.dispatch("inf:settings:layout:get", []);
    try {
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      detach = core.events.subscribe((channel, payload) => {
        const event = payload as { type: string; text?: string };
        if (channel === "inf:event" && event.type === "personalized") feed.push(event.text ?? "");
      });
      // "Hide it" to the Firstmate: one feed line, and the record the rails read.
      await change.run({
        action: "panel",
        value: { surface: "create-panel", visible: false },
        evidence: "hide the create your own panel slot",
      });
      expect((await layout()).hiddenPanels).toEqual({ "create-panel": true });
      expect(feed).toEqual(["Create your own panel hidden"]);
      const moved = await change.run({
        action: "panel",
        value: { surface: "create-panel", rail: "right" },
        evidence: "put it on the right",
      });
      expect(moved.text).toContain("can only be hidden or shown");
      expect((await layout()).placements).toEqual({});
      await change.run({
        action: "panel",
        value: { surface: "create-panel", visible: true },
        evidence: "show it again",
      });
      expect((await layout()).hiddenPanels).toEqual({});
      // The slot's own Hide is the captain's write on the same path.
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: { "create-panel": true }, placements: {} },
      ]);
      expect(feed).toEqual([
        "Create your own panel hidden",
        "Create your own panel shown",
        "Create your own panel hidden",
      ]);
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      // Two panels move to the left rail beside Activity and the slot, each
      // at the middle of its group in the saved arrangement (INF-2344).
      for (const surface of ["clock", "quota"])
        await change.run({
          action: "panel",
          value: { surface, rail: "left" },
          evidence: `move ${surface} left`,
        });
      expect((await layout()).arrangement?.left.top).toEqual(["clock", "quota"]);
    } finally {
      detach();
      // Restore the layout while the roster that owns any deviations is still present.
      await core.dispatch("inf:settings:layout:set", [old]);
      snapshot.mockRestore();
    }
  });

  it("configures repository policy through the dispatcher and broadcasts", async () => {
    const created = await core.services.repos.setup({ kind: "init", name: "policy-ui" });
    const origin = scratchDir("policy-ui-origin-");
    await git(origin, ["init", "--bare", "--initial-branch=main"]);
    await git(created.repo.path, ["remote", "add", "origin", origin]);
    const events: string[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push((payload as { type: string }).type);
    });
    const updated = await core.dispatch("inf:repos:configure", [
      created.repo.id,
      { delivery: "direct-pr", autonomy: true, rigor: "standard", origin },
    ]);
    detach();
    expect(updated).toMatchObject({
      id: created.repo.id,
      delivery: "direct-pr",
      autonomy: true,
      rigor: "standard",
    });
    expect(core.services.repos.get(created.repo.id)).toEqual(updated);
    expect(events).toContain("repo_configured");
    const operation = core.services.tasks
      .list()
      .find((task) => task.kind === "operation" && task.repoId === created.repo.id);
    expect(operation).toMatchObject({
      title: "Changed settings for project policy-ui",
      closedReason: "settled",
    });
    const status = core.services.tasks
      .timeline(operation?.id ?? "")
      .find((event) => event.kind === "status");
    expect(status?.actor).toBe("captain");
    expect(status?.text).toBe("settled by app_change");
    const notes: string[] = [];
    const watchNotes = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event" && (payload as { type: string }).type === "firstmate_note") {
        notes.push((payload as { text: string }).text);
      }
    });
    try {
      await expect(
        core.dispatch("inf:repos:configure", ["no-such-repo", { autonomy: true }]),
      ).rejects.toThrow(/Unknown repo_id/);
      expect(notes.some((text) => text.startsWith("Could not change the project's settings"))).toBe(
        true,
      );
    } finally {
      watchNotes();
      core.services.repos.unregister(created.repo.id);
    }
  });

  // INF-2114, the captain's choice ("Also in Settings → Projects, as a switch
  // beside Care"): Require pull request checks writes the project's
  // no-checks record through the dispatcher with its Activity line, and the
  // record a crewmate makes, or a check that ends it, reaches Activity too.
  it("turns Require pull request checks off and on, and says the crew's record and its end in Activity", async () => {
    const created = await core.services.repos.setup({ kind: "init", name: "no-checks" });
    // A project whose changes go through pull requests on GitHub, where the switch applies.
    core.services.repos.configure(created.repo.id, {
      origin: "https://github.com/o/no-checks.git",
      delivery: "direct-pr",
    });
    const configured: Extract<FmEvent, { type: "repo_configured" }>[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      const event = payload as FmEvent;
      if (channel === "inf:event" && event.type === "repo_configured") configured.push(event);
    });
    try {
      const off = await core.dispatch("inf:repos:configure", [
        created.repo.id,
        { requireChecks: false },
      ]);
      expect(off.noChecks).toEqual({ at: expect.any(Number) });
      expect(configured.at(-1)?.description).toBe(
        "Changed no-checks: runs no pull request checks.",
      );
      const on = await core.dispatch("inf:repos:configure", [
        created.repo.id,
        { requireChecks: true },
      ]);
      expect(on.noChecks).toBeUndefined();
      expect(configured.at(-1)?.description).toBe(
        "Changed no-checks: requires pull request checks.",
      );

      const record = { at: 1, task: "INF-7", head: "feedbeef", evidence: "No workflows." };
      core.services.repos.recordNoChecks(created.repo.id, record);
      const recorded = noChecksSaid("no-checks", { kind: "recorded", record });
      expect(configured.at(-1)).toMatchObject({
        repoId: created.repo.id,
        description: englishOf(recorded),
        said: recorded,
      });
      core.services.repos.endNoChecks(created.repo.id, { check: "build", change: "#23" });
      const ended = noChecksSaid("no-checks", { kind: "ended", check: "build", change: "#23" });
      expect(configured.at(-1)).toMatchObject({ description: englishOf(ended), said: ended });
      expect(core.services.repos.get(created.repo.id)?.noChecks).toBeUndefined();
    } finally {
      detach();
      core.services.repos.unregister(created.repo.id);
    }
  });

  it("records a feed line that names its task on that task, and the feed reads it back as written", async () => {
    const { tasks, broadcastEvent } = core.services;
    tasks.create({ id: "feed-line-task", title: "Feed line", prompt: "p", repoId: null });
    const key = tasks.get("feed-line-task")?.key;
    broadcastEvent({
      type: "firstmate_note",
      text: 'Could not deliver the reply on "Which way?": the session is gone',
      taskId: "feed-line-task",
    });
    broadcastEvent({ type: "firstmate_note", text: "A line about no task." });
    const note = tasks.timeline("feed-line-task").find((event) => event.kind === "note");
    expect(note).toMatchObject({
      text: 'Could not deliver the reply on "Which way?": the session is gone',
      feed: true,
      data: { news: true, feedLine: true },
    });
    const feed = await core.dispatch("inf:feed:recent", []);
    expect(feed).toContainEqual(
      expect.objectContaining({
        taskKey: key,
        text: 'Could not deliver the reply on "Which way?": the session is gone',
      }),
    );
    expect(feed).toContainEqual(expect.objectContaining({ text: "A line about no task." }));
    expect(feed.filter((line) => line.text.startsWith("Could not deliver the reply"))).toHaveLength(
      1,
    );
  });

  it("pushes an event to every attached sink and stops when one detaches", async () => {
    const cardId = "card-core-test";
    const hasCard = (cards: Card[]) => cards.some((card) => card.id === cardId);
    const attach = () => {
      const events: FmEvent[] = [];
      const cardPushes: Card[][] = [];
      const detach = core.events.subscribe((channel, payload) => {
        if (channel === "inf:event") events.push(payload as FmEvent);
        if (channel === "inf:cards") cardPushes.push(payload as Card[]);
      });
      return { events, cardPushes, detach };
    };
    const leaving = attach();
    const staying = attach();
    try {
      const { broadcastEvent, supervisor } = core.services;
      const event: FmEvent = { type: "firstmate_emote", emote: "nod" };
      supervisor.cards.hostCards.addSystemNoteCard(cardId, "Core test", "A note body.");
      broadcastEvent(event);
      await waitFor(() => staying.cardPushes.some(hasCard));
      expect(leaving.cardPushes.some(hasCard)).toBe(true);
      expect(leaving.events).toContain(event);
      expect(staying.events).toContain(event);
      // The fake shell's Notification Center gets the card through the same broadcast.
      expect(shell.notified.at(-1)?.body.split("\n")[0]).toBe("Core test");

      // A shared core can push unrelated events before detach. Count only new deliveries.
      leaving.detach();
      const beforeEvents = leaving.events.length;
      const beforeCards = leaving.cardPushes.length;
      const cardStart = staying.cardPushes.length;
      const afterDetach: FmEvent = { type: "firstmate_emote", emote: "tuck" };
      supervisor.pressNote(cardId);
      broadcastEvent(afterDetach);
      await waitFor(() => staying.cardPushes.slice(cardStart).some((cards) => !hasCard(cards)));
      expect(staying.events).toContain(afterDetach);
      expect(leaving.cardPushes).toHaveLength(beforeCards);
      expect(leaving.events).toHaveLength(beforeEvents);
      expect((await core.dispatch("inf:cards:list", [])).some((card) => card.id === cardId)).toBe(
        false,
      );
    } finally {
      leaving.detach();
      staying.detach();
    }
  });

  it("reads the quota snapshot the sensor produced without any provider HTTP", async () => {
    const snapshot = (await core.dispatch("inf:quota:refresh", [])) as QuotaSnapshotView | null;
    expect(snapshot?.providers[0]?.provider).toBe("codex");
    expect(await core.dispatch("inf:quota:snapshot", [])).not.toBeNull();
  });
});
