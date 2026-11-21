import type { FmEvent } from "@shared/events";
import type { CoreServices } from "../coreServices";
import type { startCorrections } from "../decisions/startCorrections";
import type { Computers } from "../devices/computers";
import type { HomeForges } from "../forge/homeForges";
import type { HostCapabilities } from "../host";
import type { IntegrationsService } from "../integrations/service";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import type { AppPaths } from "../paths";
import type { HomePersonal } from "../personal/homePersonal";
import type { PersonalExtensions } from "../personal/personalExtensions";
import type { AccountVault } from "../pi/accountVault";
import type { PiAuthService } from "../pi/piAuth";
import { parseAccountKey } from "../placed/placedAccounts";
import type { WorkDevices } from "../placed/workDevices";
import type { PluginInstaller } from "../plugins/pluginInstaller";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import type { HomeQuota } from "../quota/homeQuota";
import type { QuotaService } from "../quota/quotaService";
import type { HomeRouting } from "../routing/homeRouting";
import type { ModelSlots } from "../routing/modelSlots";
import type { Runbooks } from "../runbooks/runbooks";
import type { SecretsSettings } from "../secrets/settings";
import { readSelfSourceAsync, type SelfSourceFacts } from "../selfSource/resolve";
import type { SessionFactories } from "../session/session";
import type { SharingService } from "../sharing/sharingService";
import type { DecisionStore } from "../storage/decisionStore";
import type { HomeUsage } from "../storage/homeUsage";
import type { InboxStore } from "../storage/inboxStore";
import type { SettingsStore } from "../storage/settingsStore";
import type { TaskService } from "../tasks/taskService";
import type { ProjectChanges } from "../workspace/projectChanges";
import type { ProjectSetups } from "../workspace/projectSetups";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { CrewSupervisor } from "./crewSupervisor";
import {
  FirstmateAgent,
  type FirstmateAgentOptions,
  type RunningComputerVersion,
} from "./firstmateAgent";
import type { Flagship } from "./flagship";
import type { Scheduler } from "./scheduler";
import type { Ticker } from "./ticker";

/**
 * Home wiring for the first mate (docs/orchestrator-contract.md): the one
 * agent over the durable inbox, with the versions each computer runs, its
 * seats and models, the crew, Automation, knowledge and the personal
 * surfaces it reaches. Built once the crew, Automation and the plugin
 * installer exist; what reaches it later is late-bound by the caller.
 */
export function startHomeFirstmate({
  corrections,
  workDevices,
  computers,
  homeComputerName,
  host,
  runbooks,
  paths,
  inbox,
  ticker,
  settings,
  onCaptainTurnAccepted,
  forges,
  integrations,
  secrets,
  sharing,
  auth,
  flagship,
  quota,
  vault,
  setKeepGoingOnCredits,
  redeemSavedReset,
  broadcastEvent,
  sessionFactories,
  localSeat,
  availableModels,
  slots,
  homeQuota,
  repos,
  supervisor,
  tasks,
  knowledge,
  scheduler,
  selfSourceDir,
  source,
  sourceLocation,
  noteCutOff,
  recordUsage,
  ledger,
  preferences,
  personal,
  pluginInstaller,
  panelMounts,
  projectSetups,
  projectChanges,
}: {
  corrections: Pick<ReturnType<typeof startCorrections>, "cases">;
  workDevices: Pick<WorkDevices, "runningVersions">;
  /** Your devices' computers, for the versions each one runs. */
  computers: Pick<Computers, "list">;
  homeComputerName: string;
  host: HostCapabilities;
  runbooks: Runbooks;
  paths: AppPaths;
  inbox: InboxStore;
  ticker: Pick<Ticker, "now">;
  settings: SettingsStore;
  /** Late-bound: the first launch is built after the first mate. */
  onCaptainTurnAccepted: () => void;
  forges: Pick<HomeForges, "access">;
  integrations: IntegrationsService;
  secrets: Pick<SecretsSettings, "firstMateAsks">;
  sharing: Pick<SharingService, "record">;
  auth: Pick<PiAuthService, "modelRuntime">;
  flagship: Flagship;
  quota: Pick<QuotaService, "refresh" | "latestModels">;
  vault: Pick<AccountVault, "get" | "codexSignedIn">;
  /** Late-bound: the credits cards are built after the first mate. */
  setKeepGoingOnCredits: CoreServices["setKeepGoingOnCredits"];
  /** Late-bound like it: using a saved Codex reset (docs/codex-client.md). */
  redeemSavedReset: CoreServices["redeemSavedReset"];
  broadcastEvent: (event: FmEvent) => void;
  sessionFactories: SessionFactories;
  localSeat: FirstmateAgentOptions["localOrchestrator"];
  availableModels: HomeRouting["availableModels"];
  slots: Pick<ModelSlots, "listedOf" | "slotsOf">;
  homeQuota: Pick<HomeQuota, "contextLine">;
  repos: RepoRegistry;
  supervisor: CrewSupervisor;
  tasks: TaskService;
  knowledge: KnowledgeService;
  scheduler: Scheduler;
  selfSourceDir: string;
  source: () => SelfSourceFacts;
  sourceLocation: Parameters<typeof readSelfSourceAsync>[0];
  noteCutOff: HomeQuota["noteCutOff"];
  recordUsage: HomeUsage["recordUsage"];
  ledger: Pick<DecisionStore, "recent" | "flagMissedEscalation">;
  preferences: ShellPreferencesService;
  personal: Pick<PersonalExtensions, "snapshot" | "remove">;
  pluginInstaller: Pick<PluginInstaller, "uninstall" | "install">;
  panelMounts: HomePersonal["panelMounts"];
  projectSetups: Pick<ProjectSetups, "propose">;
  projectChanges: Pick<ProjectChanges, "request">;
}): FirstmateAgent {
  const firstmate = new FirstmateAgent({
    correctionCase: (request) => corrections.cases.handle(request),
    computerVersions: () => {
      const running = workDevices.runningVersions();
      return [
        {
          id: "this-mac",
          name: homeComputerName,
          role: "home",
          connected: true,
          version: host.app.version,
        },
        ...computers.list().flatMap((device): RunningComputerVersion[] => {
          const live = running.filter((row) => row.deviceId === device.id);
          return live.length > 0
            ? live.map((row) => ({
                id: device.id,
                name: device.name,
                role: row.role,
                connected: true,
                version: row.version,
              }))
            : [
                {
                  id: device.id,
                  name: device.name,
                  role: device.kind,
                  connected: false,
                  version: null,
                },
              ];
        }),
      ];
    },
    runbooks,
    paths,
    platform: host.app.platform,
    ...(host.installedKeys ? { installedKeys: host.installedKeys } : {}),
    inbox,
    now: ticker.now,
    settings,
    onCaptainTurnAccepted: () => onCaptainTurnAccepted(),
    forges: forges.access,
    integrations,
    secretAsks: secrets.firstMateAsks(),
    // Diagnostics' turn events: who the turn answered and, failed, its kind.
    onTurnSettled: (outcome) =>
      sharing.record(
        outcome.failed
          ? {
              name: "main_agent_turn_failed",
              data: { trigger: outcome.trigger, reason: outcome.reason },
            }
          : { name: "main_agent_turn_end", data: { trigger: outcome.trigger } },
      ),
    modelRuntime: auth.modelRuntime,
    flagship,
    recheckAllowance: () => quota.refresh("demand"),
    // A run-out card's button names a computer's account by its key (`accountKey`).
    keepGoingOnCredits: (arg) => {
      const there = vault.get(arg) ? undefined : parseAccountKey(arg);
      void setKeepGoingOnCredits(there?.accountId ?? arg, true, there?.deviceId).catch((error) =>
        broadcastEvent({ type: "firstmate_note", text: String(error?.message ?? error) }),
      );
    },
    // A card's Use a saved reset: at once when Codex keeps a sign-in for this
    // Mac's own account, else on the account's row, where Codex can sign in.
    redeemSavedReset: (arg) => {
      const there = vault.get(arg) ? undefined : parseAccountKey(arg);
      if (there?.deviceId || !vault.codexSignedIn(arg)) return "sign-in";
      void redeemSavedReset(arg, {}).catch((error) =>
        broadcastEvent({ type: "firstmate_note", text: String(error?.message ?? error) }),
      );
      return "ran";
    },
    // Each backend's seat (W1): the seat preset, opened by the one factory
    // per backend.
    seats: sessionFactories,
    ...(localSeat ? { localOrchestrator: localSeat } : {}),
    availableModels,
    listedModels: () => slots.listedOf(availableModels()),
    slotsOf: (ref) => slots.slotsOf(ref),
    quotaModels: () => quota.latestModels(),
    quotaLine: homeQuota.contextLine,
    repos,
    supervisor,
    tasks,
    knowledge,
    scheduler,
    broadcastEvent,
    selfSourceDir,
    selfSourceFacts: source,
    selfSourceFactsAsync: () => readSelfSourceAsync(sourceLocation),
    noteCutOff,
    // The orchestrator's own burn is tracked under the conversation surface.
    recordUsage: ({ accountId, model, usage }) =>
      recordUsage({
        taskId: "firstmate",
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
        usage,
      }),
    supervisionLog: (limit) => ledger.recent(limit),
    flagMissedEscalation: (input) => ledger.flagMissedEscalation(input),
    flagDuplicate: (input) => supervisor.flagDuplicate(input),
    // Talk-to-personalize Step 1: the preferences writer and the personal
    // surfaces behind `personalize` and the "your surfaces" section.
    personalize: {
      preferences,
      personal: () => personal.snapshot(),
      removePersonal: (id) => personal.remove(id),
      uninstallPlugin: (id) => pluginInstaller.uninstall(id),
      personalWorkspaceDir: paths.personalWorkspaceDir,
      // The Knowledge panel is a surface only while there is knowledge to show (docs/knowledge.md),
      // and the Automation panel while a rule is saved (docs/automation.md).
      gates: () => ({
        knowledge: knowledge.held(),
        automation: scheduler.rules().length > 0,
      }),
      mounts: () => panelMounts.current(),
    },
    installPlugin: (request) => pluginInstaller.install(request),
    proposeProject: (value) => projectSetups.propose(value),
    changeProject: (action, value, actor) => projectChanges.request(action, value, actor),
  });
  return firstmate;
}
