import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CutOff } from "@shared/authFailure";
import type { Card } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { fakeBinding, fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import {
  createTrackedAgent,
  type FakeSession,
  fakeClockEachTest,
  fakeSession,
  seatFactory,
  tick,
} from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { claudeAvailableModels } from "../claude/claudeModels";
import { absentKeychain } from "../host";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import { startHomeQuota } from "../quota/homeQuota";
import type { QuotaHttp } from "../quota/http";
import { CardStore } from "../storage/cardStore";
import { InboxStore } from "../storage/inboxStore";
import { SettingsStore } from "../storage/settingsStore";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import { CrewSupervisor } from "./crewSupervisor";
import { Flagship } from "./flagship";
import { FIRSTMATE_BENCH_CARD_ID, RECHECK_ALLOWANCE_LABEL } from "./hostCards";

/**
 * The first mate's spent allowance when its Claude login changed where
 * Infinitary does not read it: a launcher passes the client a token for
 * another login, while the sign-in store Infinitary reads still names the
 * spent one. Real parts: the Claude account backend over a stand-in store,
 * the account vault, the home's allowance readings with the client's pushed
 * refusals, the seat and its card. Stand-ins: the vendor's usage answer (the
 * recorded fixture's shape), the model session and the clock.
 */

const vendor = vi.hoisted(() => ({
  http: undefined as unknown as (url: string, init: unknown) => Promise<unknown>,
}));
vi.mock("../quota/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quota/http")>();
  return {
    ...actual,
    createQuotaHttp: () => (url: string, init: unknown) => vendor.http(url, init),
  };
});

fakeClockEachTest();

const ACCOUNT = "acct_claude";
const CLAUDE_MODEL = { provider: "anthropic-claude", id: "claude-opus" };
const START = Date.parse("2026-11-20T09:00:00Z");
const WEEKLY_RESET = START + 14 * 60 * 60_000;
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/fixtures/quota-credits/claude-usage.json"), "utf8"),
);

/** The vendor's usage answer for the store's login: some of the week used, or all of it. */
const week = { used: 40 };
const usage: QuotaHttp = async () => {
  const json = structuredClone(FIXTURE);
  const resets = new Date(WEEKLY_RESET).toISOString();
  json.seven_day.utilization = week.used;
  json.seven_day.resets_at = resets;
  for (const limit of json.limits) {
    limit.percent = week.used;
    limit.resets_at = resets;
  }
  return { status: 200, json };
};

/** The machine's Claude sign-in store, as the client last wrote it. */
function writeStore(home: string) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const written = Date.now() / 1000;
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "uuid-a",
        organizationUuid: "org-a",
        emailAddress: "first@example.invalid",
      },
    }),
  );
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "stand-in-token-a",
        refreshToken: "stand-in-refresh-a",
        expiresAt: Date.now() + 30 * 24 * 3600_000,
        subscriptionType: "max",
      },
    }),
  );
  utimesSync(join(home, ".claude.json"), written, written);
  utimesSync(join(home, ".claude", ".credentials.json"), written, written);
}

function seedAccount(accountsDir: string) {
  mkdirSync(accountsDir, { recursive: true });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: ACCOUNT,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Claude",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
}

/** One run of the app over an app folder and database, wired as the composition root wires it. */
async function boot(root: string, db: ReturnType<typeof freshDatabase>) {
  const paths = appPathsFor(root);
  const settings = new SettingsStore(db);
  const claude = new ClaudeAuthBackend({
    available: () => true,
    keychain: absentKeychain,
    configDir: () => join(process.env.HOME as string, ".claude"),
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  });
  const vault = AccountVault.create(paths, {
    backends: [claude],
    modelsForAccount: ({ providerId }) =>
      providerId === "anthropic-claude" ? claudeAvailableModels() : [],
  });
  let onQuota = () => {};
  const homeQuota = startHomeQuota({
    host: { keychain: absentKeychain },
    standIns: {},
    db,
    vault,
    served: { read: () => undefined } as never,
    auth: { catalogModels: () => [] } as never,
    broadcast: () => onQuota(),
  });
  const quota = homeQuota.quota;
  const flagship = new Flagship({
    vault,
    settings,
    quota,
    baseRuntime: { kind: "base" } as never,
    decisions: { recordAccount: () => 1 },
  });
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace: { removeTaskWorktree: vi.fn(async () => {}) } as unknown as WorkspaceService,
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox,
    paths,
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  const sessions: FakeSession[] = [];
  const agent = createTrackedAgent({
    paths,
    inbox,
    settings,
    modelRuntime: { kind: "base" } as never,
    flagship,
    recheckAllowance: () => quota.refresh("demand"),
    availableModels: () => [CLAUDE_MODEL],
    quotaModels: () => undefined,
    quotaLine: () => "quota",
    repos,
    supervisor,
    tasks,
    broadcastEvent: () => {},
    selfSourceDir: join(paths.userData, "self-source"),
    recordUsage: () => {},
    noteCutOff: (accountId: string, cutOff: CutOff) => homeQuota.noteCutOff(accountId, cutOff),
    coalesceMs: 0,
    seats: {
      claude: seatFactory("claude", async () => {
        const session = fakeSession(CLAUDE_MODEL);
        session.detach = vi.fn(async () => {});
        sessions.push(session);
        return session;
      }),
    },
  } as never);
  onQuota = () => agent.onQuotaRefreshed();
  vault.onCutOffChange(() => {
    supervisor.reconcileCutOffs();
    agent.onCutOffChanged();
  });
  vault.onLoginChange((accountId) => homeQuota.forgetLogin(accountId));
  await vault.health(ACCOUNT, { refresh: true });
  await quota.refresh("startup");
  settings.setFirstmateModel(CLAUDE_MODEL);
  return { settings, vault, homeQuota, quota, supervisor, agent, sessions };
}

type Run = Awaited<ReturnType<typeof boot>>;

/**
 * The store's login has spent its week, and the client says so: its pushed
 * refusal, then the seat's turn fails typed.
 */
async function refusedTurn(run: Run, refusal: { resetsAt?: number } = { resetsAt: WEEKLY_RESET }) {
  const { resetsAt } = refusal;
  week.used = 100;
  const seat = run.sessions.at(-1) as FakeSession;
  run.homeQuota.recordClaudeRateLimit(ACCOUNT, {
    status: "rejected",
    windowId: "seven_day",
    utilization: 1,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
  seat.emit({
    type: "turn_failed",
    taskId: "firstmate",
    error: "You've hit your weekly limit",
    cutOff: { class: "no_headroom", ...(resetsAt === undefined ? {} : { resetsAt }) },
  });
  seat.emit({ type: "turn_end", taskId: "firstmate" });
  seat.emit({ type: "turn_closed" });
  seat.resolveNextPrompt();
  await tick();
  await run.quota.refresh("demand");
  await tick();
}

const pauseCard = (run: Run) =>
  run.supervisor.cards.snapshot().find((card: Card) => card.id === FIRSTMATE_BENCH_CARD_ID);
const actionsOf = (run: Run) =>
  pauseCard(run)?.actions.map((action) => `${action.label}${action.default ? " (default)" : ""}`);
const prompts = (run: Run) => run.sessions.flatMap((session) => session.prompts);
const refusals = (run: Run) =>
  run.homeQuota.pushed.windowsFor(ACCOUNT).filter((window) => window.status === "rejected");

describe("a spent allowance on a login Infinitary does not read", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedConfigDir: string | undefined;
  beforeEach(() => {
    vi.setSystemTime(START);
    home = scratchDir("spent-attempt-home-");
    savedHome = process.env.HOME;
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    writeStore(home);
    week.used = 40;
    vendor.http = usage as never;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  async function pausedSeat() {
    const root = scratchDir("spent-attempt-app-");
    const db = freshDatabase();
    seedAccount(appPathsFor(root).accountsDir);
    const run = await boot(root, db);
    await run.agent.converse("hello");
    await refusedTurn(run);
    // A token swapped outside the store changes nothing Infinitary reads:
    // the captain writes, and the seat keeps the words.
    await run.agent.converse("are you there?");
    await tick();
    expect(run.settings.getFirstmatePaused()).toMatchObject({ class: "no_headroom" });
    expect(prompts(run)).toHaveLength(1);
    // Recheck reads the store's login again and sees no change.
    expect(actionsOf(run)).toEqual([`${RECHECK_ALLOWANCE_LABEL} (default)`, "Open settings"]);
    run.supervisor.cardActions.act(FIRSTMATE_BENCH_CARD_ID, "recheck-allowance");
    await tick();
    await run.agent.recheckAllowance();
    await tick();
    expect(run.settings.getFirstmatePaused()).toMatchObject({ class: "no_headroom" });
    return { run, root, db };
  }

  it("offers one attempt once a recheck sees no change, and a served attempt ends the pause, its cut-off and its refused reading together", async () => {
    const { run, root, db } = await pausedSeat();
    expect(actionsOf(run)).toEqual([
      `${RECHECK_ALLOWANCE_LABEL} (default)`,
      "Try Claude again",
      "Open settings",
    ]);

    run.supervisor.cardActions.act(FIRSTMATE_BENCH_CARD_ID, "try-again");
    await tick();
    await run.quota.refresh("demand");
    await tick();
    expect(run.vault.cutOff(ACCOUNT)).toBeUndefined();
    expect(refusals(run)).toEqual([]);
    expect(run.settings.getFirstmatePaused()).toBeNull();
    expect(pauseCard(run)).toBeUndefined();
    // The kept words go once: the attempt is the next turn.
    expect(prompts(run)).toHaveLength(2);
    expect(prompts(run)[1]).toContain("are you there?");

    // Served: the seat goes by the provider's answer, not the store login's
    // reading, which still says the week is spent - after a restart too.
    const seat = run.sessions.at(-1) as FakeSession;
    seat.emitTurnEnd("Here.");
    seat.resolveNextPrompt();
    await tick();
    run.agent.dispose();
    vi.setSystemTime(START + 60 * 60_000);
    const again = await boot(root, db);
    await again.agent.converse("still there?");
    await tick();
    expect(again.settings.getFirstmatePaused()).toBeNull();
    expect(prompts(again).at(-1)).toContain("still there?");
    again.agent.dispose();
  });

  it("an attempt the provider refuses again pauses again with the same card, and tries nothing on its own", async () => {
    const { run } = await pausedSeat();
    run.supervisor.cardActions.act(FIRSTMATE_BENCH_CARD_ID, "try-again");
    await tick();
    expect(prompts(run)).toHaveLength(2);

    await refusedTurn(run);
    expect(run.vault.cutOff(ACCOUNT)).toMatchObject({ class: "no_headroom" });
    expect(refusals(run)).toHaveLength(1);
    expect(run.settings.getFirstmatePaused()).toMatchObject({ class: "no_headroom" });
    expect(actionsOf(run)).toEqual([`${RECHECK_ALLOWANCE_LABEL} (default)`, "Open settings"]);
    await run.agent.converse("anyone?");
    run.agent.pokeInbox();
    await tick();
    expect(prompts(run)).toHaveLength(2);
    run.agent.dispose();
  });

  it("a hold ended by credits keeps its refused reading: only the captain's attempt ends both", async () => {
    const root = scratchDir("spent-attempt-app-");
    const db = freshDatabase();
    seedAccount(appPathsFor(root).accountsDir);
    const run = await boot(root, db);
    await run.agent.converse("hello");
    await refusedTurn(run);
    expect(run.vault.cutOff(ACCOUNT)).toMatchObject({ class: "no_headroom" });

    // Credits answer past the spent week: the hold ends, but the refusal
    // still stands and keeps the account in the credits band.
    run.homeQuota.setKeepGoingOnCredits(ACCOUNT, true);
    expect(run.vault.noteCreditsAvailable(ACCOUNT)).toBe(true);
    await tick();
    expect(run.vault.cutOff(ACCOUNT)).toBeUndefined();
    expect(refusals(run)).toHaveLength(1);
    run.agent.dispose();
  });

  it("an attempt refused with no reset named pauses again too, on the store login's spent reading", async () => {
    const { run } = await pausedSeat();
    run.supervisor.cardActions.act(FIRSTMATE_BENCH_CARD_ID, "try-again");
    await tick();
    expect(prompts(run)).toHaveLength(2);

    expect(run.vault.goesByAnswers(ACCOUNT)).toBe(true);
    // Claude's refusal can name no reset: the vault holds nothing then, but
    // the attempt is still answered, so the spent reading pauses the seat.
    await refusedTurn(run, {});
    expect(run.vault.goesByAnswers(ACCOUNT)).toBe(false);
    expect(run.settings.getFirstmatePaused()).toMatchObject({ class: "no_headroom" });
    await run.agent.converse("anyone?");
    run.agent.pokeInbox();
    await tick();
    expect(prompts(run)).toHaveLength(2);
    run.agent.dispose();
  });
});
