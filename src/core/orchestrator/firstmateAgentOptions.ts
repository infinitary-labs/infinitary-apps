import type { ActionActor, ActionName } from "@shared/actions";
import type { CutOff } from "@shared/authFailure";
import type { TurnFailureReason, TurnTrigger } from "@shared/diagnostics";
import type { FmEvent, FmUsage } from "@shared/events";
import type { ForgeSignInState } from "@shared/forges";
import type { ModelsCatalogView, QuotaSnapshotView, Slot } from "@shared/quota";
import type { CorrectionCaseRequest } from "../decisions/correctionCases";
import type { IntegrationsService } from "../integrations";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import type { AppPaths } from "../paths";
import type { AppToolsDelegate } from "../pi/appTools";
import type { PersonalizeDelegate } from "../pi/personalizeTool";
import type { SecretAskReach } from "../pi/secretTools";
import type { ModelRuntime } from "../pi/types";
import type { PluginInstallRequest } from "../plugins/pluginInstaller";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import type { Runbooks } from "../runbooks/runbooks";
import type { SessionFactories } from "../session/session";
import type { DuplicateResult } from "../storage/cardStore";
import type { MissedEscalationResult, SupervisionOutcome } from "../storage/decisionStore";
import type { InboxStore } from "../storage/inboxStore";
import type { SettingsStore } from "../storage/settingsStore";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { CrewSupervisor } from "./crewSupervisor";
import type { Flagship } from "./flagship";
import type { LocalOrchestratorSeat } from "./localOrchestrator";

export type RunningComputerVersion = {
  id: string;
  name: string;
  role: string;
  connected: boolean;
  version: string | null;
};

export type FirstmateAgentOptions = {
  paths: AppPaths;
  /** Live running app versions; null means not known, never the available update. */
  computerVersions?: () => RunningComputerVersion[];
  /** The home's system (`host.app.platform`), whose settings an offered card names; a Mac's unless named. */
  platform?: string;
  /** The window's installed keys (`HostCapabilities.installedKeys`), for the `keyboard.keys` read. */
  installedKeys?: AppToolsDelegate["installedKeys"];
  /**
   * Only the replay harness and the developer evaluations set this: the
   * answer-delivery check judges nothing, so a replayed turn is never given a
   * retry or a notice it did not record.
   */
  answerDelivery?: "observe";
  /** The durable inbox; the agent drains its own "firstmate" lane. */
  inbox: InboxStore;
  /**
   * The host's one clock (the ticker's): what the lane's drains read the
   * inbox's due rows and the coalescing window against. Absent reads
   * `Date.now()`.
   */
  now?: () => number;
  settings: SettingsStore;
  runbooks?: Runbooks;
  modelRuntime: ModelRuntime;
  /** The flagship account binding (broker phase 6); absent = base runtime. */
  flagship?: Flagship;
  /**
   * The captain's recheck of the allowance: which login each store names
   * now, then a fresh reading that may ask for access, as Retry does
   * (`recheckAllowance`). Absent reads nothing.
   */
  recheckAllowance?: () => Promise<QuotaSnapshotView | undefined>;
  /**
   * Turn an account's Keep going on credits switch on, on the captain's
   * click on a run-out card (docs/quota.md "Keep going on credits").
   */
  keepGoingOnCredits?: (accountId: string) => void;
  /**
   * A card's Use a saved reset (docs/codex-client.md), by the account's key:
   * `ran` when it started at once, `sign-in` when the account's row is where
   * it goes on, since Codex has to sign in first.
   */
  redeemSavedReset?: (accountKey: string) => "ran" | "sign-in";
  /**
   * The seat's account is spent and no sibling has room, or it keeps going
   * on credits (docs/quota.md, "Saved resets on their own"): a saved reset
   * may be weighed and used on its own, when the account's switch is on.
   */
  savedResetsSpent?: (accountId: string) => void;
  /**
   * A run-out card's Use saved resets on their own, by the account's key:
   * `ran` when it turned on at once, `sign-in` when the account's row is
   * where it goes on, since Codex has to sign in first.
   */
  useSavedResets?: (accountKey: string) => "ran" | "sign-in";
  /**
   * The dev-only local seat (roadmap 1.7) as the boot found it: when set it
   * is the Firstmate's model and runtime outright - no pin, no account, no
   * ladder - and the persisted model pin is left exactly as it was. A later
   * change (the Settings row) arrives through `setLocalOrchestrator`.
   */
  localOrchestrator?: LocalOrchestratorSeat;
  availableModels: () => { provider: string; id: string }[];
  /**
   * The listed part of that pool (docs/model-lists.md): what the fallbacks
   * that fall through every slot may pick when nothing else answers, so an
   * unslotted catalog's first id - an old model nobody chose - never
   * becomes the orchestrator. Omitted means the whole pool (tests).
   */
  listedModels?: () => { provider: string; id: string }[];
  /** The slots an offering sits in; omitted means treat as medium. */
  slotsOf?: (ref: { provider: string; id: string }) => Slot[];
  quotaModels: () => ModelsCatalogView | undefined;
  quotaLine: () => string;
  repos: RepoRegistry;
  supervisor: CrewSupervisor;
  /** The one task writer: asks, the filed kinds, the index (task-system P1). */
  tasks: TaskService;
  /**
   * Knowledge (docs/knowledge.md): present in every build. Present, the Firstmate holds the knowledge pair and its context
   * says how much is saved, never a saved word; absent, its tools and context are exactly as before.
   */
  knowledge?: KnowledgeService;
  /** The cron-prompt scheduler (R3); absent = no scheduling tools. */
  scheduler?: import("./scheduler").Scheduler;
  /** Injectable project lookup (G-2); defaults to the real disk locator. */
  locateProject?: (name: string) => string | Promise<string>;
  /**
   * Where projects live (git integration PR 1.2): locate_project's remote
   * half from the app's own sign-in, and the not-signed-in refusal a clone
   * gets when its host needs a sign-in the app lacks. Absent in tests that
   * do not exercise it.
   */
  forges?: {
    remoteProjects: (name: string, foundLocally: boolean) => Promise<string>;
    /**
     * The app's sign-in for a host (PR 1.3): the context's `lives` fact.
     * Undefined where the host offers no sign-in, null where none is on file.
     */
    signInOn: (
      host: string,
    ) => { name: string; login: string | null; state: ForgeSignInState } | null | undefined;
  };
  /**
   * Integrations (docs/integrations.md): the `integrations` and
   * `use_integration` pair, and the context block's roster line. Absent in
   * tests that do not exercise them.
   */
  integrations?: IntegrationsService;
  /**
   * Asking the captain to keep a secret (docs/secrets.md, "Asking to keep a
   * secret"): the `ask_secret` tool. Absent in tests that do not exercise it.
   */
  secretAsks?: SecretAskReach;
  broadcastEvent: (event: FmEvent) => void;
  /** Synchronous acceptance witness; applies to main input and card-thread turns alike. */
  onCaptainTurnAccepted?: () => void;
  correctionCase?: (request: CorrectionCaseRequest) => Promise<unknown>;
  /** The Firstmate agent's packaged source tree, named for delegated source tasks. */
  selfSourceDir: string;
  selfSourceFacts?: () => import("../selfSource/resolve").SelfSourceFacts;
  /** Fresh source checks awaited before a turn, never during synchronous context rendering. */
  selfSourceFactsAsync?: () => Promise<import("../selfSource/resolve").SelfSourceFacts>;
  /**
   * A typed cut-off the seat's turn observed, recorded on its bound account
   * (`AccountVault.noteCutOff`), the same fact crew turns record.
   */
  noteCutOff?: (accountId: string, cutOff: CutOff) => void;
  /** Records the orchestrator's own burn under the "firstmate" surface. */
  recordUsage?: (input: {
    accountId?: string;
    model?: { provider: string; id: string };
    usage: FmUsage;
  }) => void;
  /**
   * The supervision outcome store's query side (design B): powers the
   * supervision_log tool and the context block's recent-outcomes lines;
   * absent = no supervision session in this build.
   */
  supervisionLog?: (limit: number) => SupervisionOutcome[];
  /**
   * The outcome store's label side (PoC-2 C3): writes a confirmed
   * missed-escalation label the captain has just confirmed in conversation.
   * Absent = no supervision session in this build.
   */
  flagMissedEscalation?: (input: {
    taskId: string;
    note: string;
    outcomeId?: number;
  }) => MissedEscalationResult;
  /**
   * The captain's confirmed duplicate label (WI-14): stamps the card and
   * closes it. Absent = no duplicate tool in this build.
   */
  flagDuplicate?: (input: { cardId: string; duplicateOf: string; note: string }) => DuplicateResult;
  /**
   * Talk-to-personalize Step 1: the preferences writer and the personal
   * surfaces behind the `personalize` tool and the context block's "your
   * surfaces" section. Absent = no personalize tool in this build.
   */
  personalize?: PersonalizeOptions;
  /**
   * One plugin vehicle, Phase A item 3: the installer behind the
   * `install_plugin` tool. Absent = no install tool in this build.
   */
  installPlugin?: (request: PluginInstallRequest) => Promise<string>;
  /**
   * The setup card behind `app_change project-setup` (docs/fleet.md,
   * "Asking the first mate to add a project"): checks the proposal and puts up
   * the host's card, answering what the Firstmate is told and the card's
   * id. Absent = app_change answers with the line alone.
   */
  proposeProject?: (value: unknown) => Promise<{ text: string; cardId?: string }>;
  changeProject?: (
    action: ActionName,
    value: unknown,
    actor: ActionActor,
  ) => Promise<{ text: string; cardId?: string }>;
  /**
   * The session factory per backend that opens the seat preset
   * (`seatSessionSpec`), chosen by the binding's backend. Injectable for
   * tests; production uses the contract-tested Pi factory, and no backend
   * without one can seat the Firstmate.
   */
  seats?: SessionFactories;
  /**
   * A turn settled: who it answered and, when it failed, the coarse kind
   * of failure. Diagnostics' `main_agent_turn_end` / `_failed` listen
   * (`docs/sharing.md`); nothing of the turn's content is passed.
   */
  onTurnSettled?: (outcome: FirstmateTurnOutcome) => void;
  /**
   * The wake-diet coalescing window (WI-13); defaults to `WAKE_COALESCE_MS`.
   * Tests set 0 for immediate drains, or a small value to exercise the window
   * without a real-time wait.
   */
  coalesceMs?: number;
};

export type FirstmateTurnOutcome =
  | { trigger: TurnTrigger; failed: false }
  | { trigger: TurnTrigger; failed: true; reason: TurnFailureReason };

type PersonalizeOptions = Pick<
  PersonalizeDelegate,
  "personal" | "removePersonal" | "uninstallPlugin" | "personalWorkspaceDir" | "gates" | "mounts"
> & { preferences: ShellPreferencesService };
