import { join } from "node:path";
import type { CutOff } from "@shared/authFailure";
import type { Card } from "@shared/cards";
import type { ClaudeAccessSource } from "@shared/claudeAccess";
import type { FmEvent } from "@shared/events";
import { vi } from "vitest";
import { createClaudeSessionFactory } from "../../src/core/claude/session";
import { CrewSupervisor } from "../../src/core/orchestrator/crewSupervisor";
import {
  Flagship,
  type FlagshipOptions,
  type FlagshipVaultView,
} from "../../src/core/orchestrator/flagship";
import { appPathsFor } from "../../src/core/paths";
import type { ModelRuntime } from "../../src/core/pi/types";
import type { ModelSession, SessionSpec } from "../../src/core/session/session";
import { CardStore } from "../../src/core/storage/cardStore";
import type { AccountDecisionInput } from "../../src/core/storage/decisionStore";
import { InboxStore } from "../../src/core/storage/inboxStore";
import { SessionRecordStore } from "../../src/core/storage/sessionRecordStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import type { WorkspaceService } from "../../src/core/workspace/workspaceService";
import { CLAUDE_ACCOUNT } from "./claudeFlagship";
import { freshDatabase as openInMemoryDatabase } from "./database";
import { fakeBinding, fakeSessionFactory } from "./fakeSession";
import {
  createTrackedAgent,
  type FakeSession,
  fakeSession,
  type HarnessDatabase,
  seatFactory,
} from "./firstmateHarness";
import { scratchDir } from "./scratchDirs";
import { type SDKUserMessage, scriptedClaudeQuery } from "./scriptedClaudeQuery";

/**
 * The flagship side of the first mate's tests: an agent over a fake account
 * vault with a per-account allowance, the real Claude seat on a scripted
 * client, and the Claude login those tests stand on.
 */

export type FlagshipAccount = {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  connected?: boolean;
  /** Connected, but withheld from serving: a client issue or a standing cut-off's reason. */
  withheld?: string;
  /** The client issue's one sentence, when that is what withholds it. */
  detail?: string;
  /** A standing cut-off, as the vault records it (`noteCutOff`). */
  cutOff?: { class: "signed_out" | "no_headroom" | "refused"; resetsAt?: number };
  /** Claude access set up for Claude Code, as the vault reads it (`accessSync`). */
  access?: ClaudeAccessSource;
};

/** Which runtime a Pi-bound spec was served on (the test runtimes carry a kind). */
export function runtimeKind(spec: SessionSpec | undefined): string | undefined {
  if (spec?.binding.backend !== "pi") return undefined;
  return (spec.binding.runtime as unknown as { kind?: string }).kind;
}

/**
 * A flagship-enabled agent over a fake vault and a mutable per-account
 * quota snapshot, for the attachment and ladder behavior. The vault holds
 * each account's facts as the real one does: `noteCutOff` records a
 * cut-off on the account (a refusal or a lost sign-in withholds it, a spent
 * allowance stands until its reset), and "Try again" clears a refusal.
 */
export function setupWithFlagship(options: {
  accounts: FlagshipAccount[];
  availableModels?: { provider: string; id: string }[];
  catalog?: {
    provider: string;
    id: string;
    label: string;
  }[];
  /** Serve Claude bindings on a fake Claude seat factory. */
  claudeSeat?: boolean;
  /** The fake Claude seat opens in a new session in place of this one, as for changed instructions. */
  claudeRenewedFrom?: string;
  /** A previous run's database: this setup is that app, restarted. */
  db?: ReturnType<typeof openInMemoryDatabase>;
  /** The captain's recheck of the allowance, as the composition root runs it. */
  recheckAllowance?: () => Promise<undefined>;
  /** Each Pi seat attach waits for this, as a real one waits on its runtime. */
  attachReady?: () => Promise<void>;
}) {
  const paths = appPathsFor(scratchDir("infinitary-agent-"));
  const db: HarnessDatabase = options.db ?? openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const events: FmEvent[] = [];
  let cards: Card[] = [];
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace: { removeTaskWorktree: vi.fn(async () => {}) } as unknown as WorkspaceService,
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox,
    paths,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: (snapshot) => {
      cards = snapshot;
    },
  });
  // Per-account headroom, mutable mid-test to simulate exhaustion/reset.
  const headroom = new Map<string, number | undefined>();
  const quota = {
    latest: () => ({
      generatedAt: "",
      fetchedAt: 0,
      providers: options.accounts.flatMap((account) => {
        if (!headroom.has(account.id)) return [];
        const percent = headroom.get(account.id);
        return [
          {
            provider:
              account.providerId === "github-copilot"
                ? "copilot"
                : account.providerId === "openai-codex"
                  ? "codex"
                  : account.providerId === "xai"
                    ? "grok"
                    : account.providerId === "anthropic-claude"
                      ? "claude"
                      : account.providerId,
            label: account.label,
            accountId: account.id,
            status: "ok" as const,
            stale: false,
            windows:
              percent === undefined
                ? []
                : [
                    {
                      id: "weekly",
                      label: "weekly",
                      percentRemaining: percent,
                      resetText: "resets Fri",
                    },
                  ],
          },
        ];
      }),
    }),
  };
  const find = (accountId: string) => options.accounts.find((account) => account.id === accountId);
  const withheldOf = (account: FlagshipAccount | undefined): string | undefined => {
    if (!account || account.connected === false) return undefined;
    if (account.withheld) return account.withheld;
    if (account.cutOff?.class === "refused" || account.cutOff?.class === "signed_out") {
      return account.cutOff.class;
    }
    return undefined;
  };
  const tryAgains: string[] = [];
  const ledger: AccountDecisionInput[] = [];
  const vault: FlagshipVaultView = {
    list: (providerId?: string) =>
      options.accounts.filter((account) => !providerId || account.providerId === providerId),
    get: (accountId) => find(accountId),
    connectedSync: (accountId) => find(accountId)?.connected,
    servesSync: (accountId) => {
      const account = find(accountId);
      if (withheldOf(account)) return false;
      return account?.connected;
    },
    withheldReason: (accountId) => withheldOf(find(accountId)),
    withheldDetail: (accountId) => find(accountId)?.detail,
    cutOff: (accountId) => find(accountId)?.cutOff,
    accessSync: (accountId) => find(accountId)?.access,
    tryAgain: (accountId) => {
      tryAgains.push(accountId);
      const account = find(accountId);
      if (account?.cutOff?.class !== "refused") return false;
      account.cutOff = undefined;
      return true;
    },
    runtimeFor: async (accountId) => ({ kind: `runtime-${accountId}` }) as unknown as ModelRuntime,
    binding: (accountId) => ({
      via: find(accountId)?.providerId === "anthropic-claude" ? "default-login" : "pi-runtime",
    }),
  };
  const flagshipOptions: FlagshipOptions = {
    vault,
    settings,
    quota,
    baseRuntime: { kind: "base" } as unknown as ModelRuntime,
    decisions: {
      recordAccount: (input) => {
        ledger.push(input);
        return ledger.length;
      },
    },
  };
  const flagship = new Flagship(flagshipOptions);
  const sessions: FakeSession[] = [];
  const specs: SessionSpec[] = [];
  const usages: { accountId?: string }[] = [];
  const noted: { accountId: string; cutOff: CutOff }[] = [];
  const agent = createTrackedAgent({
    paths,
    inbox,
    settings,
    modelRuntime: { kind: "base" } as unknown as ModelRuntime,
    flagship,
    ...(options.recheckAllowance ? { recheckAllowance: options.recheckAllowance } : {}),
    availableModels: () => options.availableModels ?? [{ provider: "openai-codex", id: "gpt-5.5" }],
    quotaModels: () => (options.catalog ? { generatedAt: "", models: options.catalog } : undefined),
    quotaLine: () => "quota",
    repos,
    supervisor,
    tasks,
    broadcastEvent: (event) => events.push(event),
    selfSourceDir: join(paths.userData, "self-source"),
    recordUsage: (input) => usages.push(input),
    // The vault's own rules, as S7 records them: a refusal or a lost
    // sign-in withholds the account; a spent allowance stands until its reset.
    noteCutOff: (accountId, cutOff) => {
      noted.push({ accountId, cutOff });
      const account = find(accountId);
      if (!account) return;
      if (account.cutOff?.class === "refused" && cutOff.class !== "refused") return;
      // A spent allowance with no known reset has nothing to clear it: not held.
      if (cutOff.class === "no_headroom" && (cutOff.resetsAt ?? 0) <= Date.now()) return;
      account.cutOff = cutOff;
    },
    coalesceMs: 0,
    seats: {
      pi: seatFactory("pi", async (spec) => {
        await options.attachReady?.();
        specs.push(spec);
        const session = fakeSession();
        sessions.push(session);
        return session;
      }),
      ...(options.claudeSeat
        ? {
            claude: seatFactory("claude", async (spec) => {
              // The real factory fails its attach with the client's sentence.
              const login =
                spec.binding.backend === "claude" ? find(spec.binding.accountId) : undefined;
              if (login?.withheld === "client_missing") throw new Error(login.detail);
              specs.push(spec);
              const session = fakeSession({ provider: "anthropic-claude", id: "claude-opus" });
              session.sessionId = "claude-session";
              if (options.claudeRenewedFrom) {
                session.sessionId = "claude-renewed";
                session.renewal = { from: options.claudeRenewedFrom, changed: ["instructions"] };
              }
              session.detach = vi.fn(async () => {});
              sessions.push(session);
              return session;
            }),
          }
        : {}),
    },
  });
  return {
    agent,
    settings,
    events,
    cards: () => cards,
    db,
    inbox,
    specs,
    sessions,
    usages,
    supervisor,
    tasks,
    ledger,
    noted,
    tryAgains,
    account: (accountId: string) => find(accountId) as FlagshipAccount,
    accounts: options.accounts,
    setHeadroom: (accountId: string, percent: number | undefined) =>
      headroom.set(accountId, percent),
  };
}

/**
 * The real Claude seat under the agent (W1 S6), on a scripted client that
 * says what the pinned client was measured saying: a running/idle pair
 * around every prompt, an acknowledgement of each pushed message by its
 * uuid, one result per turn.
 */
export function claudeSeat(
  onInput: (message: SDKUserMessage, emit: (message: unknown) => void, attachment: number) => void,
  clientReady: Promise<void> = Promise.resolve(),
) {
  const dir = scratchDir("infinitary-agent-claude-seat-");
  const scripted = scriptedClaudeQuery({
    onInput: (message, emit) => onInput(message, emit, scripted.attachments.length),
  });
  const transcripts = new SessionRecordStore(join(dir, "firstmate", "claude"));
  const sessions: ModelSession[] = [];
  const factory = createClaudeSessionFactory({
    configDir: join(dir, "claude-config"),
    records: () => transcripts,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    env: () => ({ PATH: "", HOME: dir }),
    checkClient: async () => {
      // Let the factory open; only the later client attachment waits.
      if (sessions.length > 0) await clientReady;
      return { state: "ready", executable: "/bin/claude" };
    },
    query: scripted.factory,
  });
  return {
    factory: async (spec: SessionSpec) => {
      const session = await factory.open(spec);
      sessions.push(session);
      return session;
    },
    scripted,
    /** Every session the agent attached, once its client has exited and its stamps landed. */
    closed: async () => {
      for (const session of sessions) {
        session.dispose();
        await session.closed();
      }
      await transcripts.flushed();
    },
  };
}

export const CLAUDE_MODEL = { provider: "anthropic-claude", id: "claude-opus" };
export const CODEX_MODEL = { provider: "openai-codex", id: "gpt-5.5" };

/** The one Claude login, as the vault fake holds it. */
export function claudeLogin(): FlagshipAccount {
  return {
    id: CLAUDE_ACCOUNT,
    providerId: "anthropic-claude",
    label: "Claude",
    enabled: true,
    connected: true,
  };
}

/** A seat on the Claude login, optionally with a Codex account beside it. */
export async function claudeLoginSeat(
  options: {
    codex?: number;
    recheckAllowance?: () => Promise<undefined>;
    /** A previous run's accounts and database: the app restarted. */
    restart?: {
      accounts: FlagshipAccount[];
      db: ReturnType<typeof openInMemoryDatabase>;
      /** The seat's session starts over at open, as for instructions changed meanwhile. */
      renewedFrom?: string;
    };
  } = {},
) {
  if (options.restart) {
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: options.restart.accounts,
      availableModels: [CLAUDE_MODEL],
      db: options.restart.db,
      ...(options.restart.renewedFrom ? { claudeRenewedFrom: options.restart.renewedFrom } : {}),
    });
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    return t;
  }
  const accounts = [claudeLogin()];
  if (options.codex !== undefined) {
    accounts.push({
      id: "acct_codex",
      providerId: "openai-codex",
      label: "Codex",
      enabled: true,
      connected: true,
    });
  }
  const t = setupWithFlagship({
    claudeSeat: true,
    accounts,
    availableModels: [CLAUDE_MODEL, ...(options.codex !== undefined ? [CODEX_MODEL] : [])],
    ...(options.recheckAllowance ? { recheckAllowance: options.recheckAllowance } : {}),
  });
  t.settings.setFirstmateModel(CLAUDE_MODEL);
  t.setHeadroom(CLAUDE_ACCOUNT, 80);
  if (options.codex !== undefined) t.setHeadroom("acct_codex", options.codex);
  return t;
}

export const notes = (events: FmEvent[]) =>
  events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
