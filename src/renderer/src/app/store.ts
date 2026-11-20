import type { DeviceArrival } from "@shared/cards";
import type { ThisMac } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import type { CrewWord, FirstRunView } from "@shared/firstRun";
import type { LastTurn } from "@shared/lastTurn";
import type { ReleaseNotesView } from "@shared/releaseTracking";
import type { TaskBoard } from "@shared/tasks";
import { create, type StoreApi } from "zustand";
import {
  applyCrewDependencies,
  applyCrewEvent,
  crewOrbit,
  reconcileCrew,
  seedCrew,
} from "../character/crew/crewSignal";
import { requestCharacterEmote } from "../character/emoteSignal";
import { stageNow } from "../character/stageClock";
import { changesOff, changesOffWords, isView } from "../devices/viewWords";
import {
  beginPointing,
  offersSettingsSection,
  settingsPlaceState,
} from "../plugins/point/settingsPlace";
import { appReadExecutor, readBoardWithoutClosed } from "../plugins/reads/appExecutor";
import { resyncReads } from "../plugins/reads/resync";
import { detectVoiceSupport } from "../voice/voiceInput";
import { recognizerPlace } from "../voice/whisperClient";
import { type AppearanceSlice, appearanceSlice } from "./appearance";
import { type CardSlice, cardSlice } from "./cardActions";
import { type ComposerSlice, composerSlice, mainInputHeld } from "./composer";
import { projectFocus } from "./projectFocus";
import { mirrorCardAnswers } from "./savedCardAnswers";
import { shownEntry, withoutKey } from "./stack";
import { openNotifiedCard, readCardsAgain, type StackSlice, stackSlice } from "./stackActions";
import { type VoiceSlice, voiceSlice } from "./voice";

/**
 * Shell state on real orchestrator data, composed of one slice per owner:
 * the look (./appearance.ts), the card stack (./stackActions.ts over the
 * pure ./stack.ts), the main message (./composer.ts), hold-to-talk
 * (./voice.ts) and what the captain does on a card (./cardActions.ts).
 * This file keeps the window's own state, its boot, its reconnect and the
 * core's events. Any stack entry claims the Working layout; Firstmate
 * mid-turn is `firstmateBusy`; crew work never heats the character (a
 * working crewmate heats only its own glyph in the orbit).
 */
export type ShellView = "home" | "settings";

/** The window's own state: where it is, what it read from the core, and its boot. */
type ShellCore = {
  view: ShellView;
  /** The Firstmate agent is mid-turn: the character thinks while no entry is on the stack. */
  firstmateBusy: boolean;
  /** The Firstmate agent is shortening its conversation: the character's cinch. */
  firstmateFolding: boolean;
  /** Shortenings begun, counted: each one plays a cinch, even one heard only ending. */
  firstmateFoldStarts: number;
  /** Active work-task activity, keyed for card-thread indicators. */
  crewActivity: Record<string, import("@shared/tasks").TaskView["activity"]>;
  /** Keyboard settings is recording a key: the window's keys run nothing (docs/keyboard.md). */
  recordingKeys: boolean;
  /**
   * The release notes the app showed, newest first, and the version running
   * now (docs/release-notes.md "Reading a note again"); null until read.
   */
  releaseNotes: ReleaseNotesView | null;
  /**
   * The first-launch state (docs/first-launch.md): null until read. While
   * the gate is open the stage carries the caption and the input is
   * disabled; the two stamps drive the input's hint.
   */
  firstRun: FirstRunView | null;
  /**
   * Whether the first read of `firstRun` has settled, answered or not.
   * Until it has, the main input takes nothing (`mainInputHeld`): a fresh
   * profile's gate may be up, and a turn sent then would skip its welcome.
   */
  firstRunSettled: boolean;
  /**
   * The last turn above the input (./LastTurn, docs/composer.md "The last
   * turn"): the captain's newest message and the Firstmate's reply line,
   * with the round before it (`previous`).
   * Read from the core as the window opens; `user_turn` and
   * `firstmate_reply` keep it after that.
   */
  lastTurn: LastTurn | null;
  /** The messages this window saw sent, so a new one enters as a new pair. */
  lastTurnSeq: number;
  /** Replies this window saw, so a repeated line still starts a fresh fade. */
  lastTurnReplySeq: number;
  initialized: boolean;
  /** Boot cards are present without an entrance; later shown surfaces may reveal. */
  cardsSnapshotLoaded: boolean;
  bootCardId: string | null;
  /**
   * Settings section to select when opening Settings (the restore card
   * lands on Subscriptions so the sign-in notice has a home).
   */
  settingsSection: string | null;
  /**
   * What a Settings section shows on arrival, named by a panel's
   * `point.openSettings` (docs/ui-plugins.md, "Pointing and the view"): an
   * id the section itself reads, such as an automation rule's, consumed
   * once by that section.
   */
  settingsItem: { section: string; item: string } | null;
  /** One-step restore: Subscriptions starts sign-in for this account. */
  pendingRestoreAccountId: string | null;
  /**
   * A sign-in where projects live to start on arrival (git integration PR
   * 1.2): Projects starts the host's sign-in, so the code is on screen.
   */
  pendingForgeSignIn: string | null;
  /**
   * What Settings -> Devices does on arrival from a card (docs/devices.md,
   * "Asking the first mate"): make a link, remove a device, add a Mac at an
   * address, or update Firstmate on one added that way.
   */
  pendingDeviceArrival: DeviceArrival | null;
  /**
   * A private site Settings -> General adds on arrival from the app's Allow
   * card (docs/task-browser.md, "Private sites"), then forgets.
   */
  pendingPrivateSite: string | null;
  /**
   * A sign-in on a computer that runs work to start on arrival in Settings
   * -> Intelligence (docs/helper.md, "Its own sign-ins").
   */
  pendingDeviceSignIn: { deviceId: string; providerId: string } | null;
  /** A computer's own sign-in where projects live that Settings -> Projects starts on arrival. */
  pendingDeviceForgeSignIn: { deviceId: string; host: string } | null;
  /**
   * What this app is on its Mac (docs/view.md): the one holding Firstmate,
   * or one controlling Firstmate on another Mac, with how well it hears it.
   * null until read. While changes are off there, nothing is sent.
   */
  thisMac: ThisMac | null;
  applyThisMac: (thisMac: ThisMac) => void;
  /**
   * The newest `caughtUp` of the Mac this one controls whose reading of
   * everything again has finished here; while it is behind, the window says
   * it is catching up (docs/view.md, "Live, catching up or out of reach").
   * -1 until the first `thisMac` is read, whose count the window's own
   * first reads cover.
   */
  rereadThrough: number;
  /**
   * How many times the link to the first mate came back while this window
   * stayed open: a panel it could not mount is mounted again on each
   * (FrameMount), as a mount refused during the gap is never retried.
   */
  linkReturns: number;
  /**
   * Whether Settings -> Devices is offered here (`inf:devices:shown`,
   * docs/devices.md): its commands are listed only then. False until read;
   * a computer that controls the first mate reads it from that computer.
   */
  devicesShown: boolean;
  /**
   * Whether Settings -> Secrets is offered here (`inf:secrets:shown`,
   * docs/secrets.md): a build without protected storage has no tab and its
   * command is not listed. False until read, and on a Mac that controls another.
   */
  secretsShown: boolean;
  /**
   * Reads the stage again from the Mac this one controls, after a gap it
   * could not replay (that Mac restarted, or this one was away too long),
   * settling once the cards, their threads, the board, the release notes,
   * the first launch's state and the last turn are read.
   */
  resync: () => Promise<void>;
  init: () => void;
  /** Re-read the first-launch state from the core (after an account change). */
  loadFirstRun: () => Promise<void>;
  /** The captain's first turn just left: the first-run hint is over. */
  markFirstTurn: () => void;
  /** Read the last turn from the core; a message seen sent meanwhile is newer and wins. */
  loadLastTurn: () => Promise<void>;
  noteCrewWord: (word: CrewWord) => void;
  setView: (view: ShellView) => void;
  /** Command search is open over the window (docs/keyboard.md). */
  commandSearchOpen: boolean;
  setCommandSearchOpen: (open: boolean) => void;
  clearSettingsSection: () => void;
  clearSettingsItem: () => void;
  clearPendingRestore: () => void;
  clearPendingForgeSignIn: () => void;
  clearPendingDeviceArrival: () => void;
  clearPendingDeviceSignIn: () => void;
  clearPendingDeviceForgeSignIn: () => void;
  applyEvent: (event: FmEvent) => void;
};

export type ShellState = ShellCore &
  AppearanceSlice &
  StackSlice &
  ComposerSlice &
  VoiceSlice &
  CardSlice;
/** The store's own writer and reader, as each slice (`(set, get)`) is handed them. */
export type ShellSet = StoreApi<ShellState>["setState"];
export type ShellGet = StoreApi<ShellState>["getState"];

/** Reads the notes the app showed; unanswered, the last known stay. */
function readReleaseNotes(): Promise<void> {
  return window.infinitary.releaseNotes
    .list()
    .then((releaseNotes) => useShellStore.setState({ releaseNotes }))
    .catch(() => {});
}

/** Whether Settings -> Devices is offered (`inf:devices:shown`); unanswered, the last known stays. */
function readDevicesShown(): void {
  void window.infinitary.devices
    .shown()
    .then(({ shown }) => useShellStore.setState({ devicesShown: shown }))
    .catch(() => {});
}

/** Whether Settings -> Secrets is offered (`inf:secrets:shown`); unanswered, the last known stays. */
function readSecretsShown(): void {
  void window.infinitary.secrets
    .shown()
    .then(({ shown }) => useShellStore.setState({ secretsShown: shown }))
    .catch(() => {});
}

/**
 * The reads the window asks once and otherwise follows by push: a read
 * refused while the link was down is asked again when it comes back
 * (applyThisMac), so the Version row never waits on a lost answer.
 */
function readOnceAgain(): void {
  void readReleaseNotes();
  readDevicesShown();
  readSecretsShown();
}

/** Seeds the crew orbit's roster from the board, and each active work task's activity. */
function readBoard(): Promise<void> {
  // The orbit has no use for closed rows: they never fly.
  return readBoardWithoutClosed()
    .then((board) => {
      seedCrew(crewOrbit(), board.tasks, stageNow(), board.links);
      reconcileCrew(crewOrbit(), board, stageNow());
      useShellStore.setState({
        crewActivity: Object.fromEntries(
          board.tasks
            .filter((task) => task.kind === "work" && task.status === "active")
            .map((task) => [task.id, task.activity]),
        ),
      });
    })
    .catch(() => {});
}

/**
 * Each read of the first-launch state, and the newest one applied: a read
 * waiting at the window's fence never overwrites an answer read after it.
 */
let firstRunReads = 0;
let firstRunApplied = 0;

export const useShellStore = create<ShellState>()((set, get) => ({
  ...appearanceSlice(set, get),
  ...stackSlice(set, get),
  ...composerSlice(set, get),
  ...voiceSlice(set, get),
  ...cardSlice(set, get),
  view: "home",
  firstmateBusy: false,
  firstmateFolding: false,
  firstmateFoldStarts: 0,
  crewActivity: {},
  recordingKeys: false,
  releaseNotes: null,
  firstRun: null,
  firstRunSettled: false,
  lastTurn: null,
  lastTurnSeq: 0,
  lastTurnReplySeq: 0,
  initialized: false,
  cardsSnapshotLoaded: false,
  bootCardId: null,
  settingsSection: null,
  settingsItem: null,
  pendingRestoreAccountId: null,
  pendingForgeSignIn: null,
  pendingDeviceArrival: null,
  pendingPrivateSite: null,
  pendingDeviceSignIn: null,
  pendingDeviceForgeSignIn: null,
  thisMac: null,
  rereadThrough: -1,
  linkReturns: 0,
  devicesShown: false,
  secretsShown: false,
  applyThisMac: (thisMac) => {
    const before = get().thisMac;
    set({ thisMac });
    // The window's own first reads cover what the first answer counts.
    if (get().rereadThrough < 0 && isView(thisMac)) set({ rereadThrough: thisMac.caughtUp });
    if (isView(before) && changesOff(before) && !changesOff(thisMac)) {
      // Changes are on again: what said they were off goes, the words stay.
      const off = changesOffWords(before);
      set((s) => ({
        composerNotice: s.composerNotice === "away" ? null : s.composerNotice,
        replyNotices: Object.fromEntries(
          Object.entries(s.replyNotices).filter(([, notice]) => notice !== "away"),
        ),
        cardActionErrors: Object.fromEntries(
          Object.entries(s.cardActionErrors).filter(([, error]) => error !== off),
        ),
      }));
    }
    if (isView(before) && isView(thisMac) && thisMac.caughtUp > before.caughtUp) {
      const through = thisMac.caughtUp;
      void get()
        .resync()
        .then(() => set((s) => ({ rereadThrough: Math.max(s.rereadThrough, through) })));
    }
    // The window on the first mate's own computer missed pushes over the
    // local door, or now asks directly (docs/view.md): it reads everything again.
    if (
      thisMac.role === "home" &&
      before?.role === "home" &&
      (thisMac.caughtUp ?? 0) > (before.caughtUp ?? 0)
    )
      void get().resync();
    // The link came back, here or to the Mac this one controls: what the
    // window asked once is asked again, as a refused read is never retried.
    if (
      (thisMac.role === "home" &&
        before?.role === "home" &&
        (thisMac.linkBack ?? 0) > (before.linkBack ?? 0)) ||
      (isView(thisMac) &&
        thisMac.contact === "in-reach" &&
        !(isView(before) && before.contact === "in-reach"))
    ) {
      readOnceAgain();
      set((s) => ({ linkReturns: s.linkReturns + 1 }));
    }
  },
  resync: async () => {
    set({ cardsSnapshotLoaded: false });
    const reads: Promise<unknown>[] = [
      readCardsAgain(get, () => set({ cardsSnapshotLoaded: true })).catch(() => {}),
    ];
    // Every thread this window has read is read again.
    for (const cardId of Object.keys(get().threads))
      reads.push(
        window.infinitary.cards
          .thread(cardId)
          .then((thread) => get().applyThread(thread.cardId, thread.messages))
          .catch(() => {}),
      );
    reads.push(readReleaseNotes());
    // A turn that ended while this Mac was away said so to nobody here.
    set({ firstmateBusy: false, firstmateFolding: false });
    reads.push(readBoard(), get().loadFirstRun(), get().loadLastTurn());
    resyncReads();
    await Promise.allSettled(reads);
  },
  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    // What this app is: the one holding Firstmate, or a view of another Mac.
    window.infinitary.devices.onThisMac((thisMac) => get().applyThisMac(thisMac));
    void window.infinitary.devices
      .thisMac()
      .then((thisMac) => {
        if (get().thisMac) return;
        set({ thisMac });
        // The window's own first reads cover what the first answer counts.
        if (get().rereadThrough < 0 && isView(thisMac)) set({ rereadThrough: thisMac.caughtUp });
      })
      .catch(() => {});
    // Asked once: a build offers Devices or not for as long as it runs. A
    // view asks that first mate, so an ask refused while it is away is asked
    // again when it comes back in reach (applyThisMac).
    readDevicesShown();
    // Asked once too: a build keeps protected storage or not for as long as it runs.
    readSecretsShown();
    window.infinitary.cards.onCards((cards) => get().applyCards(cards));
    // The project focus holds other projects' cards back (docs/project-focus.md "The card stack").
    projectFocus.subscribe(() => get().applyHold());
    window.infinitary.cards.onThread((thread) => get().applyThread(thread.cardId, thread.messages));
    // A click on a card's notification brings that card to the front, here or
    // in the window the click opened (src/main/notifiedCard.ts).
    window.infinitary.cards.onNotified(() => void openNotifiedCard(get).catch(() => {}));
    window.infinitary.events.on((event) => get().applyEvent(event));
    // Unanswered (a Mac this one controls is out of reach): the stage stays
    // as it is, and reads again when that Mac is back (resync).
    void readCardsAgain(get, () =>
      set({ cardsSnapshotLoaded: true, bootCardId: shownEntry(get())?.id ?? null }),
    )
      .then(() => openNotifiedCard(get))
      .catch(() => {});
    // The crew orbit's roster at boot (a side channel, never shell state).
    void readBoard();
    // A new or cleared wait, and a task's parts and their links, arrive on the
    // sequenced board, not on task_changed, and so does a record erased with
    // no close of its own, such as a failed start's (INF-2371). The stage reads the board the
    // Tasks panel reads, which folds the core's deltas above the trigger (P5)
    // and reads again on a gap, so a large board moves the stage too.
    appReadExecutor().subscribe(
      "tasks.board",
      { closed: false },
      {
        onValue: (value) => {
          const board = value as TaskBoard;
          applyCrewDependencies(crewOrbit(), board.tasks, board.links, stageNow());
          reconcileCrew(crewOrbit(), board, stageNow());
        },
        onError: () => {},
      },
    );
    // The activity feed is not shell state: its rail panel reads it from
    // the core over the read catalog (feed.recent - docs/ui-plugins.md),
    // which is also where its persistence across restarts lives.
    window.infinitary.settings.onDictation(get().applyDictation);
    void window.infinitary.settings
      .getDictation()
      .then(get().applyDictation)
      .catch(() => {});
    // What's new reads the notes the app showed (docs/release-notes.md).
    window.infinitary.releaseNotes.onChange((releaseNotes) => set({ releaseNotes }));
    void readReleaseNotes();
    // The graphics gate: no card or adapter where the model runs means the
    // voice affordance hides entirely.
    void recognizerPlace()
      .then(detectVoiceSupport)
      .then((supported) => set({ voiceSupported: supported }));
    void window.infinitary.voice
      .status()
      .then((status) => set({ voiceModelReady: status.modelReady }))
      .catch(() => {});
    // The first-launch gate is read once here and again on every quota
    // push, which follows each account change (docs/first-launch.md).
    void get().loadFirstRun();
    void get().loadLastTurn();
    window.infinitary.quota.onSnapshot(() => {
      void get().loadFirstRun();
    });
    window.infinitary.models.onChanged(() => {
      void get().loadFirstRun();
    });
    window.infinitary.voice.onProgress((progress) => {
      const notice = get().voiceNotice;
      if (notice?.kind === "download") {
        set({ voiceNotice: { kind: "download", fraction: progress.fraction } });
      }
    });
  },
  loadFirstRun: async () => {
    const read = ++firstRunReads;
    try {
      const firstRun = await window.infinitary.app.firstRun();
      // An answer that opens the input waits at the window's fence: the core
      // publishes the welcome before it answers, and Chromium can hand the
      // window this answer ahead of that push (docs/first-launch.md).
      if (mainInputHeld(get()) && !mainInputHeld({ firstRun, firstRunSettled: true }))
        await window.infinitary.app.fence();
      if (read < firstRunApplied) return;
      firstRunApplied = read;
      // In one update, so a gated profile's input never opens in between.
      set({ firstRun, firstRunSettled: true });
    } catch {
      // An unreadable core answer leaves the last known state in place. A
      // first read that fails still settles: the input opens as it did
      // before any read, rather than holding for a read that may not come.
      set({ firstRunSettled: true });
    }
  },
  markFirstTurn: () =>
    set((s) =>
      s.firstRun && s.firstRun.firstTurnAt === null
        ? { firstRun: { ...s.firstRun, firstTurnAt: Date.now() } }
        : {},
    ),
  loadLastTurn: async () => {
    const seq = get().lastTurnSeq;
    try {
      const lastTurn = await window.infinitary.conversation.lastTurn();
      if (get().lastTurnSeq === seq) set({ lastTurn });
    } catch {
      // An unreadable answer leaves the area as it is.
    }
  },
  noteCrewWord: (word) => {
    const key = word === "working" ? "workingWordAt" : "idleWordAt";
    // Taught on the stage at once, so the word never shows again while the core writes it.
    set((s) => (s.firstRun ? { firstRun: { ...s.firstRun, [key]: Date.now() } } : {}));
    void window.infinitary.app
      .noteCrewWord(word)
      .then((firstRun) => set({ firstRun }))
      .catch(() => {});
  },
  setView: (view) => set({ view }),
  commandSearchOpen: false,
  setCommandSearchOpen: (commandSearchOpen) => set({ commandSearchOpen }),
  clearSettingsSection: () => set({ settingsSection: null }),
  clearSettingsItem: () => set({ settingsItem: null }),
  clearPendingRestore: () => set({ pendingRestoreAccountId: null }),
  clearPendingForgeSignIn: () => set({ pendingForgeSignIn: null }),
  clearPendingDeviceArrival: () => set({ pendingDeviceArrival: null }),
  clearPendingDeviceSignIn: () => set({ pendingDeviceSignIn: null }),
  clearPendingDeviceForgeSignIn: () => set({ pendingDeviceForgeSignIn: null }),
  applyEvent: (event) => {
    // The shared show-card door (inf:cards:show-past): Firstmate's pointing
    // and the shell's own gestures open the same held past-card entry.
    if (event.type === "past_card_shown") get().openPastCard(event.cardId);
    if (event.type === "open_card_shown") get().focusCard(event.cardId);
    // The first mate's show-task and show-settings point as a panel's
    // `point.openRecord` and `point.openSettings` do (primitives/app-actions.md).
    if (event.type === "task_record_shown") {
      beginPointing();
      if (get().view !== "home") get().setView("home");
      get().openRecord(event.taskId);
    }
    if (event.type === "settings_shown") {
      // The check a panel's point.openSettings meets: a section this window
      // does not offer opens nothing, never another tab.
      const place = { section: event.section, ...(event.item ? { item: event.item } : {}) };
      const newest = beginPointing();
      void offersSettingsSection(place.section, get().thisMac).then((offered) => {
        if (offered && newest()) set(settingsPlaceState(place));
      });
    }
    // Fleet moments the character reacts to (captain-approved emote set),
    // keyed on the record since task-system P5: work landing or merging is
    // the rare success worth a celebrate; a task failing for good, or a
    // failed turn, earns a brief confusion. Only a status TRANSITION fires
    // (`from` differs), so a later write on a closed row - its worktree
    // going, a card resolving - never re-fires it. The motion is purely
    // visual - a side channel, not state - and the machine holds it off
    // while the voice has the conn.
    if (event.type === "task_changed" && event.from !== event.status) {
      const reason = event.closedReason;
      if (
        event.status === "done" &&
        (reason === "landed" ||
          reason === "merged" ||
          reason === "released" ||
          // An answer task delivered (Task B): the captain resolved its card
          // and the row closed done/answered. Keyed on the event's kind, so a
          // question row the Firstmate answered does not celebrate.
          (reason === "answered" && event.kind === "work"))
      ) {
        requestCharacterEmote("celebrate");
      } else if (event.status === "dropped" && reason === "failed") {
        requestCharacterEmote("confused");
      }
    }
    // The record states the third of the captain's crewmates that finished
    // (the create-your-own-panel slot, docs/first-launch.md): until it does,
    // a task closing done is the moment to read it again.
    if (
      event.type === "task_changed" &&
      event.status === "done" &&
      event.from !== "done" &&
      get().firstRun?.thirdCrewmateDoneAt === undefined
    )
      void get().loadFirstRun();
    if (event.type === "turn_failed") requestCharacterEmote("confused");
    // An emote's words reach the window only as a turn's reply line, which
    // the core chooses and sends (`firstmate_reply`).
    if (event.type === "firstmate_emote") requestCharacterEmote(event.emote);
    // The last turn above the input (./LastTurn): a message sent starts a
    // new round, the newest becomes the older one, and the turn that read
    // it fills in the reply line.
    if (event.type === "user_turn") {
      set((s) => ({
        lastTurn: {
          you: event.text,
          reply: null,
          ...(event.through ? { through: event.through } : {}),
          previous: s.lastTurn
            ? {
                you: s.lastTurn.you,
                reply: s.lastTurn.reply,
                ...(s.lastTurn.through ? { through: s.lastTurn.through } : {}),
              }
            : null,
        },
        lastTurnSeq: s.lastTurnSeq + 1,
      }));
    }
    if (event.type === "firstmate_reply") {
      const reply = {
        text: event.text,
        ...(event.problem ? { problem: true } : {}),
        ...(event.eligibility ? { eligibility: event.eligibility } : {}),
        ...(event.words ? { words: event.words } : {}),
      };
      set((s) =>
        s.lastTurn
          ? {
              lastTurn: { ...s.lastTurn, reply },
              lastTurnReplySeq: s.lastTurnReplySeq + 1,
            }
          : {},
      );
    }
    // The crew orbit follows the same stream: spawns, activity, packets,
    // closes (character/crew/crewSignal.ts) - a side channel like the emotes.
    applyCrewEvent(crewOrbit(), event, stageNow());
    if (event.type === "task_changed" && event.kind === "work") {
      set((s) => ({
        crewActivity:
          event.status === "active"
            ? { ...s.crewActivity, [event.taskId]: event.activity }
            : withoutKey(s.crewActivity, event.taskId),
      }));
    }
    if (event.type === "firstmate_state") {
      const folding = event.folding === true;
      set((s) => ({
        firstmateBusy: event.busy,
        firstmateFolding: folding,
        firstmateFoldStarts: s.firstmateFoldStarts + (folding && !s.firstmateFolding ? 1 : 0),
      }));
    }
  },
}));

// A card's picks outlive a restart: the saved copy follows every reading and
// every retirement the shell makes (./savedCardAnswers.ts, INF-2710).
useShellStore.subscribe((state, previous) =>
  mirrorCardAnswers(state.cardAnswers, previous.cardAnswers),
);
