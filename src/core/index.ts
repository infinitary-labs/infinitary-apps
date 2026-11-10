import { askedFromAView } from "./askedFromAView";
import type { CoreServices } from "./coreServices";
import { type CoreDispatch, createCoreDispatcher } from "./dispatcher";
import { CoreEventBus } from "./events";
import type { HostCapabilities } from "./host";
import type { AppPaths } from "./paths";
import { createServices } from "./services";
import { recordStartAtLogin } from "./storage/startAtLoginRecord";

/**
 * The application core, entire (daemon study D1,
 * data/fm3000-daemon-process-study-s1 section 4.5).
 *
 * One function starts everything the product does, and hands back the two
 * seams a client needs: `dispatch` for requests and `events` for pushes.
 * `src/core/` imports no Electron - the fence in biome.json is what keeps
 * that true - so this whole tree runs, and is testable, in plain Node. The
 * Electron app is simply its first client (src/main/app.ts).
 */
export type Core = {
  readonly services: CoreServices;
  readonly paths: AppPaths;
  /** Push channels out; subscribe one sink per attached client. */
  readonly events: CoreEventBus;
  /** Request channels in; validates and answers every core-surface channel. */
  readonly dispatch: CoreDispatch;
  /**
   * Stops every timer, session, and child process the core owns. Resolves
   * once the crewmates it cut mid-turn have settled, within a bound.
   */
  dispose: () => Promise<void>;
};

export type CoreOptions = {
  /**
   * The app was started by a command, with no window (docs/run.md): nobody
   * sits at this computer to see a page it opens, so every page it would
   * open in a browser goes to each computer that controls it instead, as a
   * page a view's own request opens always does (`inf:app:open-page`).
   */
  startedByCommand?: boolean;
};

export async function startCore(given: HostCapabilities, options: CoreOptions = {}): Promise<Core> {
  const events = new CoreEventBus();
  const host: HostCapabilities = {
    ...given,
    openExternal: async (url) =>
      options.startedByCommand || askedFromAView()
        ? events.emit("inf:app:open-page", { url })
        : given.openExternal(url),
  };
  const services = await createServices(host, events.emit);
  const dispatch = createCoreDispatcher({
    services,
    host,
    emit: events.emit,
    onActionRecorded: (id, action, value) =>
      services.firstmate.appActionRecorded(id, action, value),
  });
  services.firstmate.bindAppDispatch(dispatch);
  // What the system starts at login, remembered in the folder for an app
  // that later moves it in (storage/startAtLoginRecord.ts).
  recordStartAtLogin(services.paths.userData, host.presence.getStartAtLogin());
  services.projectSetups.bindDispatch(dispatch);
  services.projectChanges.bindDispatch(dispatch);
  await services.projectChanges.inspectAll();
  services.queueChoice.bindDispatch(dispatch);
  // A batched choice that waited while the app was closed reads its
  // project's workflows again, in the background.
  void services.queueChoice.recheckAll().catch(() => {});
  // Each project's folder is read once against where the project lives, in
  // the background, so the window opens as fast as before (INF-572).
  void services.supervisor.inPlaceWork.checkFoldersAtStart();
  return {
    services,
    paths: services.paths,
    events,
    dispatch,
    dispose: () => {
      // The health log dates the quit and the sign-in on file first, so a
      // sign-in that dies while the app is closed is bracketed (docs/forge.md).
      services.forges.recordApp("quit");
      services.jobs.disposeAll();
      services.ticker.stop();
      services.stopWorkPresentation();
      services.scheduler.stop();
      services.firstmate.dispose();
      const crew = services.supervisor.disposeAll();
      // Every task browser goes with the app, its site data with it, and
      // the task channel with its keys.
      services.browsers?.closeAll();
      services.taskCommands?.close();
      // Every MCP server program the app started stops with it.
      void services.integrations.dispose();
      services.taskProtocol.dispose();
      services.quota.stop();
      services.stopLivenessSweep();
      services.personal.dispose();
      // The query process holds a read snapshot while it runs: stop it.
      services.sql.dispose();
      const records = services.recordReader.dispose();
      services.deviceSignIns.dispose();
      services.automaticPlacement.dispose();
      services.loadLine.dispose();
      services.computerLoads.dispose();
      services.computerResourceFeed.dispose();
      services.computerResources.dispose();
      services.devices.dispose();
      services.nearbyMacs.dispose();
      services.homeAnnouncement.dispose();
      services.phoneDoor?.close();
      services.privacyWatch?.dispose();
      services.freezeRecorder?.stop();
      // A clean quit is not a crash, however early it comes (Step 5).
      services.launchWatch.dispose();
      // Stop the Diagnostics retry and let an event already on the wire finish.
      void services.sharing.close(1_000);
      return Promise.all([crew, records]).then(() => undefined);
    },
  };
}

export type { CoreServices } from "./coreServices";
export type { CoreDispatch } from "./dispatcher";
export type { CoreEventSink } from "./events";
export type {
  HostCapabilities,
  HostChildProcess,
  HostChildSpawner,
  HostKeychain,
  HostKeychainOutcome,
} from "./host";
