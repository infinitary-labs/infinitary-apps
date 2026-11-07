import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { knownPanels } from "@shared/panelArrangement";
import type { PersonalSnapshot } from "@shared/personal/manifest";
import type { CoreEventSink } from "../events";
import type { HostCapabilities } from "../host";
import type { IntegrationsService, PanelAsks } from "../integrations";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { PersonalLiveDelegate } from "../orchestrator/crewSupervisorOptions";
import type { TypedWake } from "../orchestrator/wakes";
import { PanelLog } from "../panels/panelLog";
import { PanelRuntimes } from "../panels/panelRuntimes";
import { PanelStops } from "../panels/panelStops";
import type { AppPaths } from "../paths";
import type { PluginRecords } from "../plugins/pluginRecords";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import type { SqlService } from "../sql/sqlService";
import type { AppDatabase } from "../storage/db";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { carryPanelInstructions } from "./panelInstructions";
import { PanelMountsHolder } from "./panelMounts";
import { PersonalExtensions } from "./personalExtensions";
import type { PersonalStore } from "./personalStore";

/**
 * The home's personal setup: the personal workspace's panels, seeded,
 * compiled and watched, the rails' arrangement they write into, and the
 * live build loop's seam the supervisor runs a crewmate on the personal
 * workspace through. Presence and the running dot derive from the store
 * and the task record, so the service subscribes to both. Started before
 * the supervisor because the live build loop (Step 4) is the supervisor's
 * delegate.
 */
export type HomePersonal = {
  personal: PersonalExtensions;
  /** What the window did with each panel, as it last said. */
  panelMounts: PanelMountsHolder;
  /** The live build loop's seam (Step 4), the supervisor's delegate. */
  live: PersonalLiveDelegate;
  /** The captain's Update panel press reaches the first mate from here on (INF-2470). */
  attachFirstmate: (tell: (wake: TypedWake) => void) => void;
};

export async function startHomePersonal(options: {
  host: Pick<HostCapabilities, "capture" | "panelProcess">;
  paths: Pick<
    AppPaths,
    | "personalWorkspaceDir"
    | "personalCacheDir"
    | "panelLogPath"
    | "crewmatesDir"
    | "pluginsDir"
    | "installedCacheDir"
  >;
  db: AppDatabase;
  /** The installed plugins' and panels' saved data. */
  store: PersonalStore;
  repos: Pick<RepoRegistry, "ensurePersonal" | "personal">;
  knowledge: Pick<KnowledgeService, "directions">;
  /** The tree the Firstmate reads itself from, which seeds the workspace's skills. */
  skillsSourceDir: string;
  /** The host-owned switch (Step 5), as this launch read it. */
  enabled: boolean;
  tasks: Pick<TaskService, "get" | "onChange">;
  preferences: Pick<ShellPreferencesService, "reconcile" | "subscribe">;
  sql: Pick<SqlService, "query">;
  integrations: Pick<IntegrationsService, "forPanel">;
  panelAsks: PanelAsks;
  /** The crew, built after the panels and read only once the captain asks again. */
  crew: () => Pick<CrewSupervisor, "cards" | "integrationAsks">;
  pluginRecords: Pick<PluginRecords, "installed">;
  now: () => number;
  emit: CoreEventSink;
}): Promise<HomePersonal> {
  const { host, paths, repos, tasks, preferences, panelAsks, pluginRecords } = options;
  const panelMounts = new PanelMountsHolder();
  // Every panel's lines and the host's own about panels go to one file in
  // the data folder, with a window or without one (docs/personal-panels.md,
  // "The panel log"): an app opened from the Dock keeps none of its console.
  const panelLog = new PanelLog(paths.panelLogPath);
  const log = (message: string) => panelLog.write(message);
  // The personal workspace is a project from the first start, so a panel
  // instruction can be a direction scoped to it before any panel exists;
  // what an older build kept in the workspace's captain skill is carried
  // there once, before the seeder or any agent touches the workspace.
  await carryPanelInstructions({
    workspaceDir: paths.personalWorkspaceDir,
    scope: repos.ensurePersonal(paths.personalWorkspaceDir).id,
    knowledge: options.knowledge,
    log,
  });
  // The captain's Update panel press reaches the first mate (INF-2470);
  // late-bound because the first mate is built below.
  let tellPanelUpdate: (wake: TypedWake) => void = () => {};
  const personal = await PersonalExtensions.start({
    workspaceDir: paths.personalWorkspaceDir,
    // The app's own design skill and the authoring skills are seeded from
    // the same tree the Firstmate reads itself from (Step 3).
    skillsSourceDir: options.skillsSourceDir,
    cacheRoot: paths.personalCacheDir,
    // The host-owned switch (Step 5): off, the service never seeds, scans,
    // compiles, or loads a server module.
    enabled: options.enabled,
    store: options.store,
    tasks: { get: (id) => tasks.get(id), onChange: (listener) => tasks.onChange(listener) },
    // Each snapshot writes its new panels into the rails' arrangement
    // (INF-2344) before the window hears of them, so the window and the
    // first mate read one place for each.
    emit: (channel, payload) => {
      if (channel === "inf:plugins:personal")
        preferences.reconcile(knownPanels(payload as PersonalSnapshot));
      options.emit(channel, payload);
    },
    log,
    ...(host.capture ? { capture: host.capture } : {}),
    captureDirFor: (taskId) => join(paths.crewmatesDir, taskId, "captures"),
    mounts: panelMounts,
    sql: (request) => options.sql.query(request),
    // The one owner of every panel's background work (INF-2205 piece B):
    // each permitted module in a process of its own, watched from outside,
    // with its stops kept in the record until the captain's Retry.
    runtimes: new PanelRuntimes({
      ...(host.panelProcess ? { spawner: host.panelProcess } : {}),
      stops: new PanelStops(options.db),
    }),
    askUpdate: (ask) => {
      const repoId = repos.personal()?.id;
      tellPanelUpdate({
        facts: {
          kind: "panel-update-asked",
          panel: { id: ask.id, title: ask.title },
          api: ask.api,
          serves: ask.serves,
          ...(repoId ? { repoId } : {}),
        },
      });
    },
    // Every panel reaches outside your projects through the integrations,
    // the same way every other caller does (docs/integrations.md, "Panels").
    integrations: (panel) => options.integrations.forPanel(panel),
    panelAsks: {
      of: (panel) => panelAsks.of(panel),
      subscribe: (listener) => panelAsks.subscribe(listener),
      askAgain: (panel, integration, action) => {
        const held = panelAsks.held(panel, integration, action);
        if (!held) return false;
        // Its card is still up: show it again rather than raise a second.
        const { cards } = options.crew();
        if (held.state === "asking" && held.card && cards.has(held.card)) {
          cards.showOpenCard(held.card);
          return true;
        }
        const ask = {
          ...held.ask,
          id: `ia${randomBytes(6).toString("hex")}`,
          at: options.now(),
        };
        panelAsks.asking(ask, options.crew().integrationAsks.askIntegrationForPanel(ask));
        return true;
      },
    },
    installed: {
      dir: paths.pluginsDir,
      cacheRoot: paths.installedCacheDir,
      list: () =>
        pluginRecords
          .installed()
          .flatMap((record) =>
            record.kind === "panel" && record.name && record.capabilities
              ? [{ id: record.id, name: record.name, capabilities: record.capabilities }]
              : [],
          ),
    },
  });
  // The app's own panels have their places even when no snapshot was pushed
  // (the captain's panels off at launch).
  preferences.reconcile(knownPanels(personal.snapshot()));
  // The switch has one follower in the core (Step 5): every write of the
  // `panels` row reaches the host, which unmounts or remounts in one tick.
  preferences.subscribe((value) => {
    void personal.setEnabled(value.panels.enabled);
  });
  // The live build loop's seam (Step 4): the personal workspace as a repo
  // registered on first need, the surfaces for the brief and the context
  // block, and the commit, lint and capture the supervisor runs for a
  // crewmate on the personal workspace.
  const personalSurfaces = () => {
    const { extensions, drafts = [] } = personal.snapshot();
    // A new panel still being built is on no rail yet, but its directory
    // is taken: the next crewmate changes it rather than starting another.
    const building = drafts.filter((draft) => !extensions.some((e) => e.id === draft.id));
    return [
      ...extensions,
      ...building.map((draft) => ({ ...draft, present: false, running: true })),
    ].map((extension) => ({
      id: extension.id,
      title: extension.title,
      placement: extension.placement,
      present: extension.present,
      running: extension.running,
      reads: extension.reads,
      error: extension.error?.message ?? null,
    }));
  };
  const live: PersonalLiveDelegate = {
    workspaceDir: paths.personalWorkspaceDir,
    repo: () => repos.ensurePersonal(paths.personalWorkspaceDir),
    surfaces: personalSurfaces,
    beginLiveTask: (taskId) => personal.beginLiveTask(taskId),
    endLiveTask: (taskId) => personal.endLiveTask(taskId),
    commitTurn: (taskId, message) => personal.commitTurn(taskId, message),
    lint: (input) => personal.lint(input.id),
    place: (input) => personal.place(input.taskId, input.id),
    capture: (input) => personal.capture(input.id, input.taskId),
  };
  return {
    personal,
    panelMounts,
    live,
    attachFirstmate: (tell) => {
      tellPanelUpdate = tell;
    },
  };
}
