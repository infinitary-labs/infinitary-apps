import { RELEASE_NOTES_PICTURE_OWNER } from "@shared/cardPictures";
import { isCustomApiProvider } from "@shared/customApi";
import { WELCOME_NOTE } from "@shared/welcome";
import type { CoreEventSink } from "./events";
import { crewFacts, FirstRunService, hasPriorActivity } from "./firstRun";
import type { HostCapabilities } from "./host";
import type { CrewSupervisor } from "./orchestrator/crewSupervisor";
import type { FirstmateAgent } from "./orchestrator/firstmateAgent";
import { firstmateCanServe } from "./orchestrator/firstmateAvailability";
import type { Flagship } from "./orchestrator/flagship";
import type { LocalOrchestratorService } from "./orchestrator/localOrchestrator";
import { type AppPaths, crewmateCardPicturesDir } from "./paths";
import type { AccountVault } from "./pi/accountVault";
import { keepPictureFile } from "./pi/cardImages";
import type { PiAuthService } from "./pi/piAuth";
import { releaseNotesView } from "./releaseNotes/shown";
import { loadCatalog, ReleaseNotesService } from "./releaseNotes/startup";
import { bundledSource, recordLaunch } from "./releaseTracking";
import type { HomeRouting } from "./routing/homeRouting";
import type { SharingService } from "./sharing/sharingService";
import type { StandIns } from "./standIns";
import type { CardStore } from "./storage/cardStore";
import type { SettingsStore } from "./storage/settingsStore";
import type { TaskService } from "./tasks/taskService";
import type { RepoRegistry } from "./workspace/repoRegistry";

/**
 * The first launch and the startup note, reconciled together: the setup
 * gate and the welcome (docs/first-launch.md), and a forward upgrade's
 * release note, which waits on the welcome after a first installation.
 */
export type FirstLaunch = {
  firstRun: FirstRunService;
  /** This launch's first look, once the hooks below are wired. */
  begin: () => void;
  /** Accounts or models moved: the gate looks again, and a note waiting on the welcome. */
  reconcile: () => void;
  /** The stack changed: a note waiting on the welcome looks again. */
  cardsChanged: () => void;
  /** The captain's turn was accepted: the first launch has its first exchange. */
  captainTurnAccepted: () => void;
};

export function startFirstLaunch(options: {
  host: Pick<HostCapabilities, "app">;
  paths: AppPaths;
  standIns: Pick<StandIns, "releaseNotesDir">;
  settings: SettingsStore;
  routing: Pick<HomeRouting, "routableModels" | "availableModels">;
  flagship: Pick<Flagship, "servesFirstmate" | "standsOnCutOff" | "resolveAccountId" | "pause">;
  localOrchestrator: Pick<LocalOrchestratorService, "seat">;
  vault: Pick<AccountVault, "list" | "customUnchecked" | "availableModelsByAccount">;
  auth: Pick<PiAuthService, "customProviderModels">;
  firstmate: Pick<FirstmateAgent, "preflightModel">;
  tasks: Pick<
    TaskService,
    "list" | "capture" | "hasKind" | "hasFinishedTask" | "finishedCrewmates"
  >;
  cards: Pick<CardStore, "hasHistory">;
  repos: Pick<RepoRegistry, "list">;
  supervisor: Pick<CrewSupervisor, "addRecordedFirstmateNote" | "hasCard">;
  sharing: Pick<SharingService, "record">;
  now: () => number;
  emit: CoreEventSink;
}): FirstLaunch {
  const { host, paths, settings, routing, flagship, localOrchestrator, vault, supervisor } =
    options;
  const { now } = options;
  // The first launch (docs/first-launch.md): the gate is the Firstmate's
  // own pre-flight - no model that can answer it: its provider's role and
  // an account the seat can stand on (`Flagship.servesFirstmate`), exactly
  // what `FirstmateAgent.resolveModel` derives from - unless an account the
  // seat could stand on is only paused by a typed cut-off, when the pause
  // card speaks instead (`Flagship.standsOnCutOff`). Welcome eligibility is
  // separate: the selected serving model must not be paused, and the host
  // commits approved Firstmate copy before publishing a normal ready state.
  const firstmateServedModels = () =>
    [
      ...routing.routableModels(),
      ...routing
        .availableModels()
        .filter(
          (model) =>
            isCustomApiProvider(model.provider) &&
            settings.getFirstmateModel()?.provider === model.provider &&
            settings.getFirstmateModel()?.id === model.id,
        ),
    ].filter((model) => model.provider !== "anthropic" && flagship.servesFirstmate(model.provider));
  const firstRun = new FirstRunService({
    settings,
    gateOpen: () =>
      firstmateServedModels().length === 0 &&
      !flagship.standsOnCutOff() &&
      !localOrchestrator.seat(),
    // A custom-only profile whose saved checks an earlier version made
    // (docs/saved-data-compatibility.md): the gate names the connection the
    // Firstmate was chosen on and asks for its one fresh check in place.
    freshCheck: () => {
      const chosen = settings.getFirstmateModel();
      if (!chosen || !isCustomApiProvider(chosen.provider)) return undefined;
      const account = vault.list(chosen.provider).find((entry) => entry.enabled);
      if (!account) return undefined;
      const models = vault.customUnchecked(account.id);
      return models.length > 0
        ? { accountId: account.id, label: account.label, models }
        : undefined;
    },
    usable: () =>
      firstmateCanServe({
        local: Boolean(localOrchestrator.seat()),
        model: options.firstmate.preflightModel(),
        available: routing.availableModels(),
        custom: options.auth.customProviderModels(),
        accounts: vault.availableModelsByAccount(),
        flagship,
      }),
    hasActivity: () =>
      hasPriorActivity({ tasks: options.tasks, cards: options.cards, repos: options.repos }),
    ...crewFacts(options.tasks),
    createWelcome: (consume) => {
      // The welcome takes no reply - the message box under it is where to
      // type - and is the regular card its picture was drawn for.
      supervisor.addRecordedFirstmateNote(WELCOME_NOTE, consume, {
        replies: false,
        width: "regular",
      });
    },
    now,
    onStep: (step) => options.sharing.record({ name: `ftue_${step}`, data: {} }),
  });
  // Release notes (docs/release-notes.md "The startup note"): a packaged
  // build reads the catalog it carries; a dev or e2e run reads one only from
  // INFINITARY_RELEASE_NOTES_DIR, like the update overrides, and otherwise
  // just records its version. After first-run eligibility and before the
  // window's first card snapshot, a forward upgrade commits its note on top
  // of the stack with the new baseline. A failed write never holds startup;
  // the next launch retries. A first installation shows no note: its quiet
  // record waits on the welcome, so setup and card changes look again.
  const notesDir = host.app.packaged
    ? host.app.resourcesDir
    : (options.standIns.releaseNotesDir ?? null);
  const releaseNotes = notesDir
    ? new ReleaseNotesService(
        {
          settings,
          isOpen: (cardId) => supervisor.hasCard(cardId),
          catalog: () => loadCatalog(notesDir, host.app.version),
          createNote: (note, record) => {
            supervisor.addRecordedFirstmateNote(note, record, { onTop: true });
            // What's new can open it now: the window and the Help menu look again.
            options.emit(
              "inf:release-notes",
              releaseNotesView(settings.getReleaseTracking(), host.app.version),
            );
          },
          // Kept under a reserved owner where card pictures live, so the
          // note keeps its pictures after the next upgrade replaces this
          // build's files.
          keepPicture: (file) =>
            keepPictureFile(file, {
              dir: crewmateCardPicturesDir(paths, RELEASE_NOTES_PICTURE_OWNER),
              taskId: RELEASE_NOTES_PICTURE_OWNER,
            }),
          now,
        },
        { version: host.app.version, source: bundledSource(notesDir, host.app.version) },
      )
    : null;
  const reconcileReleaseNotes = () => {
    if (releaseNotes) {
      releaseNotes.reconcile();
      return;
    }
    try {
      recordLaunch(settings, { version: host.app.version, source: null }, now);
    } catch (error) {
      console.warn("[release-tracking] this launch could not be recorded:", error);
    }
  };
  return {
    firstRun,
    begin: () => {
      firstRun.reconcile();
      reconcileReleaseNotes();
    },
    reconcile: () => {
      firstRun.reconcile();
      if (releaseNotes?.awaitingWelcome) releaseNotes.reconcile();
    },
    cardsChanged: () => {
      if (releaseNotes?.awaitingWelcome) releaseNotes.reconcile();
    },
    captainTurnAccepted: () => {
      firstRun.noteCaptainTurn();
    },
  };
}
