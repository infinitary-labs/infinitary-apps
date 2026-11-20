import type { BrowserViewer } from "@core/browser/browserViews";
import { contractChange, listsChange } from "@core/connection/contractChanges";
import { HomeOutOfReachError } from "@core/devices/homeLink";
import type { JoinedHome } from "@core/devices/joinedHome";
import type { HostNotifications, HostPresence } from "@core/host";
import { AskedInstall } from "@core/update/homeUpdate";
import type { UpdateChecker } from "@core/update/updateChecker";
import type { CommandNotice } from "@shared/commandNotice";
import { dictationSettingsSchema } from "@shared/dictation";
import { replayedPointing } from "@shared/events";
import {
  type CoreInvokeChannel,
  type InvokeResponse,
  openPageSchema,
  type PushChannel,
  signInPageSchema,
} from "@shared/ipc";
import type { JoinAtOptions, LinkAtAnswer } from "@shared/joinByAddress";
import type { SavedKeymap, SavedKeymapRead } from "@shared/keymap";
import {
  dockPresenceSchema,
  type OwnWindowAnswer,
  type OwnWindowAsk,
  ownWindowAskedSchema,
} from "@shared/ownWindow";
import { type ShellPreferences, shellPreferencesSchema } from "@shared/preferences";
import type { UpdateStatus } from "@shared/update";
import type { WindowKeyReminders } from "@shared/windowAnswer";
import { commandNotice, entryWaitMs, type JoinedRun, runEnd, type StartEntry } from "./besideRun";
import type { CommandStarter } from "./commandStarter";
import { type OwnedRun, sameRun } from "./runCommand";
import type { RunStatus } from "./runStatus";
import { LocalWindow, type LocalWindowOptions } from "./view/localWindow";
import { answerOwnApp, OWN_APP } from "./view/viewBackend";
import { ViewLook } from "./view/viewLook";
import { ViewNotices } from "./view/viewNotices";
import type { PreferenceSource } from "./windowSize";

/**
 * The window opened beside a first mate a command started (docs/run.md,
 * "The window opened beside it"), under one rule: that first mate keeps
 * the settings, the records and the crew, and only this window touches
 * the desktop. The first mate stores each setting once and tells the
 * window; the window applies it to its own program. So the window joins
 * the first mate over its local door with no core of its own, follows its
 * look and keys, applies its Dock choice, answers what only a program in
 * the person's session can (Start at login, a file picker), posts its
 * cards' notifications, and installs an update for it where only a
 * window can. Once the command no longer runs the window says so over
 * itself and never starts a first mate by itself.
 */

/** Join by its address asked of the command's first mate (`join-by-address-beside.md`). */
const JOIN_BY_ADDRESS_BESIDE = contractChange("join-by-address-beside");

/** How often the window reads whether the command still runs while it is out of reach. */
const BESIDE_RUN_READ_MS = 1_000;

/**
 * How long a command that runs gets to answer the window before the window
 * says it does not (INF-4622): its door never opened, or it welcomed the
 * window and never answered its first asks. Counted after the window's own
 * wait to join, so a first start that updates a large saved-data file has
 * time; the notice goes the moment the command answers.
 */
const ANSWER_WAIT_MS = 30_000;

export type BesideOptions = {
  /** The command's local door, which the window dials. */
  door: string;
  /** Where the command's first mate keeps its card pictures. */
  crewmatesDir: string;
  /** Keeps the copy of the first mate's look and keys this window draws with before it answers. */
  look: JoinedHome;
  /** The command's own records in the data folder, read without starting anything. */
  status: () => Pick<RunStatus, "running" | "run" | "lastStop">;
  /** Which start entry the app wrote is in place now. */
  startEntry: () => StartEntry;
  /**
   * The command running now when it is the starter's own, read from the same
   * reading of the records as whether one runs: one this app's own agent
   * started, as the run's own note says (`ownedRunOf`, ./runCommand.ts);
   * null for any other. Joining and following along stop only that run,
   * never one the person started by hand.
   */
  ownedRun?: (status: Pick<RunStatus, "running" | "run" | "lastStop">) => OwnedRun | null;
  /** The entry's own wait before it starts the command again; a test stands in a shorter one. */
  restartWaitMs?: number;
  /** This program's own Dock icon and login item. */
  presence: HostPresence;
  /** This program's own file picker, over its window. */
  chooseFiles: (options: { multiple: boolean }) => Promise<string[]>;
  /**
   * Whether this window installs an update itself, for a first mate that
   * cannot replace the copy with no window (docs/alpha.md, "Saving work
   * before an update"); otherwise the first mate's own updater answers.
   */
  installsUpdates: boolean;
  /** Whether the program this window runs was replaced since it started. */
  programReplaced: () => boolean;
  /**
   * The starter this window starts the command with, where it may
   * (docs/run.md, "The window starts it"): Start it here starts the command
   * again through it, and Start at login is the command's.
   */
  starter?: CommandStarter;
  /** When this window started the command it opened beside, while that one has not welcomed it yet. */
  startedAt?: number;
  /**
   * Stops the command's first mate and its crew cleanly, as a signal does;
   * with `only`, just that run. False when none runs, or another one does.
   */
  stopCommand?: (only?: OwnedRun) => boolean;
  /** How long a running command gets to answer before the window says it does not; a test stands in a shorter one. */
  answerWaitMs?: number;
};

export type BesideWindowOptions = {
  beside: BesideOptions;
  /** Hands a push to this computer's windows. */
  broadcast: (channel: PushChannel, payload: unknown) => void;
  notifications: HostNotifications;
  /** This program's own update checker. */
  updates: UpdateChecker;
  /** This computer's key reminder, which the first mate asks of this window (`src/shared/windowAnswer.ts`). */
  keyReminders?: () => WindowKeyReminders | null;
  openPage?: (url: string) => Promise<void>;
  /** Starts the app again; `startHere` as this computer's own first mate, whatever start entry is in place. */
  relaunch: (how?: { startHere?: boolean }) => void;
  /** The window reads everything again, as a view does after a gap. */
  readAgain: () => void;
  /** The link came back after a drop, replayed or not: the window asks its one-time reads again. */
  linkBack: () => void;
  /** Every window starts over: what it showed under the notice was read from nobody. */
  restartWindows: () => void;
  /** What this app is changed: every window hears it. */
  changed: () => void;
  localWindow?: Pick<LocalWindowOptions, "link"> & { readyMs?: number };
  now: () => number;
};

export class BesideWindow {
  /** The followed look and keys, which the window's size steps and installed keys read. */
  readonly preferences: PreferenceSource;
  private readonly window: LocalWindow;
  private readonly look: ViewLook;
  private readonly notices: ViewNotices;
  /** An update a paired view started through the first mate, installed here (`ownUpdate`). */
  private readonly asked: AskedInstall;
  /** The first mate's dictation switch, as last read or told. */
  private dictation = false;
  /** Whether this window is in front, as it last said; said again at each welcome. */
  private inFront = false;
  /** The command this window joined, as its note names it; null when it opened between two. */
  private joined: JoinedRun | null;
  /** When the window first saw that no command runs, for an end whose record names no time. */
  private stoppedAt: number | null = null;
  /** Since when a command that runs has not answered this window; null once it answers or ends. */
  private unansweredSince: number | null = null;
  /** The process of the command that count is for: a command started again is counted anew. */
  private unansweredOf: number | null = null;
  private shown: CommandNotice | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What the window takes from its first mate on a welcome, while it is being read; true once answered. */
  private reading: Promise<boolean> | null = null;
  /**
   * While the window waits for its first welcome: what it asks the first
   * mate meanwhile, a message typed before the welcome among them, waits
   * here and goes once the welcome was read, in the order it was asked.
   */
  private held: Promise<void> | null = null;
  private release: () => void = () => {};
  /** That reading, or the end of the wait for it: what the window's first draw waits on. */
  private answering: Promise<void> | null = null;
  private welcomed = false;
  private closed = false;
  /** When this window last started the command, until that one welcomes it. */
  private startedAt: number | null;
  /**
   * Restart it under way, until its own replacement is known or the run it
   * replaces is known to survive (`settleRestart`): that run, read once;
   * the window's start time before the press; whether its starter has
   * answered, and refused; and the connection a first mate welcomed this
   * window on since, unless the records named the run being replaced then.
   */
  private restart: {
    from: OwnedRun | null;
    startedBefore: number | null;
    settled: boolean;
    refused: boolean;
    welcomedOn: number | null;
  } | null = null;
  /** Start it here took the notice down: the window starts over once the command it started welcomes it. */
  private startsOver = false;
  /** Restart it ended a command that did not answer: the window waits under its notice for the one started again. */
  private restarting = false;
  /**
   * The first mate moved to another computer (docs/devices.md, "Moving the
   * first mate"): once its command ends, the window starts over as a window
   * of the new home, which the command left for it.
   */
  private moved = false;

  /** Whether this window starts the command itself, so leaving it lets nothing start it again. */
  get startsCommand(): boolean {
    return this.options.beside.starter !== undefined;
  }

  /**
   * What a join beside this command would stop, from one reading of the
   * command's records (docs/view.md, "Following along"): `{ owned: null }`
   * while this window starts the command and the records say none runs,
   * which stops no run; `{ owned }` while the run its own agent started runs
   * (`BesideOptions.ownedRun`); "starting" while a command this window
   * started or restarted has not welcomed it yet, whose run may still open
   * this computer's first mate, however long it takes; "outside" only while
   * the records say a command runs that this window does not own or does not
   * start; and "unknown" while they cannot be read.
   */
  joinState(): { owned: OwnedRun | null } | "starting" | "outside" | "unknown" {
    const status = this.options.beside.status();
    if (!this.startsCommand) return status.running === true ? "outside" : "unknown";
    // The same reading settles Restart it and names what a join stops.
    this.settleRestart(status);
    if (this.startedAt !== null) return "starting";
    if (status.running === false) return { owned: null };
    if (status.running !== true) return "unknown";
    const owned = this.options.beside.ownedRun?.(status) ?? null;
    return owned ? { owned } : "outside";
  }

  constructor(private readonly options: BesideWindowOptions) {
    const { beside } = options;
    this.asked = new AskedInstall(options.updates);
    this.startedAt = beside.startedAt ?? null;
    this.joined = joinedRun(beside.status());
    this.look = new ViewLook(beside.look, (value) =>
      options.broadcast("inf:shell:preferences", value),
    );
    this.preferences = {
      get: () => this.look.get(),
      subscribe: (listener) => this.look.subscribe(listener),
      keymap: (): SavedKeymapRead => this.look.keymap(),
      // The first mate keeps the keys; this window installs them.
      setKeymap: (keymap: SavedKeymap) => {
        this.look.setKeymap(keymap);
        void this.ask("inf:settings:keys:set", [keymap]).catch(() => {
          // The copy here stands until the first mate is read again.
        });
      },
    };
    this.notices = new ViewNotices(options.notifications, (channel, args) =>
      this.window.dispatch(channel, args),
    );
    this.window = new LocalWindow({
      door: beside.door,
      ...(options.keyReminders ? { keyReminders: options.keyReminders } : {}),
      broadcast: (channel, payload, replayed) => this.heard(channel, payload, replayed),
      onReload: () => {
        this.notices.startOver();
        options.readAgain();
      },
      // A door that no longer takes its key: starting again reads the door anew.
      onLost: () => {
        if (!this.closed) options.relaunch();
      },
      onWelcome: () => this.back(),
      onBack: () => options.linkBack(),
      onMoved: () => {
        this.moved = true;
        this.away();
      },
      onContact: (inReach) => {
        if (!inReach) this.away();
      },
      ...(options.localWindow?.link ? { link: options.localWindow.link } : {}),
    });
  }

  /**
   * Returns at once, so the window draws before its first mate answers,
   * with the look kept here (docs/run.md, "The window opened beside it").
   * The door may open only after the window: the link dials until it does,
   * and what the window asks meanwhile waits for the first welcome
   * (`held`). A window opened while no command runs draws under its notice.
   */
  async start(): Promise<void> {
    if (this.startedAt === null && this.options.beside.status().running === false) {
      this.away();
      await this.window.ready(0);
      return;
    }
    this.countUnanswered();
    this.held = new Promise((resolve) => {
      this.release = resolve;
    });
    void this.firstWelcome();
  }

  /**
   * Waits for the first welcome as the window of a first mate run here
   * does, then lets what the window asked meanwhile go. A first mate that
   * never welcomes it leaves the window under its notice, and what waited
   * is refused as out of reach.
   */
  private async firstWelcome(): Promise<void> {
    try {
      await this.window.ready(this.options.localWindow?.readyMs);
      if (this.window.inReach()) await this.answering;
      else if (!this.closed) {
        console.warn("[shell] the command's first mate has not welcomed the window yet");
        this.away();
      }
    } finally {
      this.letHeldGo();
    }
  }

  /**
   * What waited for the first welcome goes, and nothing waits for it after:
   * a reaction rescheduled on `held` must find it gone, or it reschedules
   * itself forever and starves the program.
   */
  private letHeldGo(): void {
    this.held = null;
    this.release();
  }

  /** One request to the first mate, once the first welcome was read. */
  private async ask<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown[],
    viewer?: BrowserViewer,
  ): Promise<InvokeResponse<C>> {
    if (this.held) await this.held;
    return this.window.dispatch(channel, rawArgs, viewer);
  }

  /** The notice over the window, while no command runs. */
  notice(): CommandNotice | null {
    return this.shown;
  }

  dictationEnabled(): boolean {
    return this.dictation;
  }

  crewmatesDir(): string {
    return this.options.beside.crewmatesDir;
  }

  /** The window came to the front: the first mate refreshes a stale allowance reading. */
  focused(): void {
    // A window that came to the front before its first welcome says so once welcomed.
    if (this.held) {
      void this.held.then(() => this.focused());
      return;
    }
    if (!this.window.inReach()) return;
    void this.window.dispatch("inf:own-window:focused", []).catch(() => {});
  }

  /**
   * The window came to the front or left it: the first mate pushes no card
   * to a phone while it is in front (docs/phone-push.md). A first mate that
   * forgot it as the connection dropped hears it again at the next welcome.
   */
  front(inFront: boolean): void {
    this.inFront = inFront;
    if (this.held || !this.window.inReach()) return;
    this.sayFront(inFront);
  }

  /** A first mate from before this request refuses it, and its phone pushes as it did. */
  private sayFront(inFront: boolean): void {
    void this.window.dispatch("inf:window:front", [inFront]).catch(() => {});
  }

  /**
   * Start it here: this window starts again as the computer's own first
   * mate. Only once the notice offers it, and never while a command runs
   * or its records cannot be read.
   */
  startHere(): boolean {
    if (this.shown?.state !== "stopped" || this.restart?.settled === false) return false;
    // A command that runs and does not answer is stopped first, never run beside.
    if (this.shown.ending === "not-answering") {
      void this.stopUnanswered();
      return true;
    }
    if (this.options.beside.status().running !== false) return false;
    const { starter } = this.options.beside;
    // A command that could not start is not started again: this window runs the first mate itself.
    if (!starter || this.shown.ending === "start-failed") {
      this.options.relaunch({ startHere: true });
      return true;
    }
    this.startedAt = this.options.now();
    this.startsOver = true;
    this.show(null);
    void starter.start().then((started) => {
      if (!started && !this.closed) this.options.relaunch({ startHere: true });
    });
    return true;
  }

  /**
   * Restart it, on the notice over a command that runs and does not
   * answer: the starter this window started it with ends it by force and
   * starts it again, and the window waits under its notice for the new one
   * to welcome it. Should that one not answer either, the notice offers
   * Restart it again once its wait is over. False where nothing offers it:
   * no notice that the command is not answering, or no starter to restart
   * it with.
   */
  restartCommand(): boolean {
    const { starter } = this.options.beside;
    // One restart at a time: the next waits until its starter answered.
    if (this.shown?.ending !== "not-answering" || !starter || this.restart?.settled === false)
      return false;
    const since = this.unansweredSince;
    // The run this restart replaces, read once: the one its starter ends, and a welcome from it,
    // reconnecting, is not the one started again.
    const recorded = this.options.beside.status().run;
    const outgoing = recorded ? { pid: recorded.pid, startedAt: recorded.startedAt } : null;
    const restart = {
      from: outgoing,
      startedBefore: this.startedAt,
      settled: false,
      refused: false,
      welcomedOn: null,
    };
    this.restart = restart;
    this.restarting = true;
    this.startedAt = this.options.now();
    // The wait counts from the press, even while the command ending still runs.
    this.unansweredSince = null;
    this.countUnanswered();
    this.show(this.restartingNotice());
    // The window hears the stopped command go, and dials the one started again.
    this.away();
    void starter.restart(outgoing ? { pid: outgoing.pid } : {}).then((restarted) => {
      restart.settled = true;
      restart.refused = !restarted;
      if (this.closed || this.restart !== restart) return;
      this.settleRestart(this.options.beside.status());
      if (restarted) return;
      // The command was not restarted: it is still the one that has not answered since then.
      this.restarting = false;
      if (this.unansweredOf === this.options.beside.status().run?.pid) this.unansweredSince = since;
      this.show(this.notAnswering());
    });
    return true;
  }

  /**
   * Stop, in Settings → General (docs/run.md, "Quit and Stop"): the
   * command's first mate and its crew stop cleanly, and nothing starts
   * them again until the person does. False while none runs.
   */
  stop(): boolean {
    if (this.shown !== null || !this.options.beside.stopCommand) return false;
    return this.options.beside.stopCommand();
  }

  /**
   * The copy is about to be replaced by this window's update: the first
   * mate ends with its crew's work saved, for whatever started it to start
   * the new copy. A first mate that kept no work saved changes nothing.
   * The starter this window started it with then lets it go: its agent
   * starts the run again after an update's exit, which would start the old
   * copy before the installer replaced it, and macOS's installer refuses
   * to replace a copy that runs. The new copy's window starts it again.
   */
  async replacing(): Promise<void> {
    if (!this.options.beside.installsUpdates || !this.window.inReach()) return;
    await this.window.dispatch("inf:update:hold", ["replaced"]);
    await this.options.beside.starter?.stop({ forget: false });
  }

  /** One core channel the window asked: the first mate's, but for what only this program holds. */
  async dispatch<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown[],
    viewer?: BrowserViewer,
  ): Promise<InvokeResponse<C>> {
    switch (channel) {
      // Read from the copy kept here, so the window draws right before the first mate answers.
      case "inf:shell:preferences":
      case "inf:settings:appearance:get":
      case "inf:settings:layout:get": {
        await this.answering;
        const look = this.look.get();
        return (
          channel === "inf:shell:preferences"
            ? look
            : channel === "inf:settings:appearance:get"
              ? look.appearance
              : look.layout
        ) as InvokeResponse<C>;
      }
      // Changed at the first mate, which keeps it; the copy follows its answer at once,
      // so a held size key steps from the size just set.
      case "inf:settings:appearance:set": {
        const appearance = await this.ask("inf:settings:appearance:set", rawArgs);
        return this.look.setAppearance(appearance) as InvokeResponse<C>;
      }
      case "inf:settings:layout:set": {
        const layout = await this.ask("inf:settings:layout:set", rawArgs);
        return this.look.setLayout(layout) as InvokeResponse<C>;
      }
      default:
    }
    if (OWN_APP.has(channel) && this.options.beside.installsUpdates) {
      // A status names the view that started an update under way (`ownUpdate`).
      const answer =
        channel === "inf:update:status"
          ? await this.asked.status()
          : await answerOwnApp(this.options.updates, channel, rawArgs);
      return (
        channel === "inf:update:status" || channel === "inf:update:check"
          ? await this.withResuming(answer as UpdateStatus)
          : answer
      ) as InvokeResponse<C>;
    }
    const answer = await this.ask(channel, rawArgs, viewer);
    if (channel === "inf:settings:dictation:get" || channel === "inf:settings:dictation:set")
      this.dictation = (answer as InvokeResponse<"inf:settings:dictation:get">).enabled;
    return answer;
  }

  /**
   * One step of Join by its address (docs/run.md, "Joining another
   * computer"): the command's first mate keeps this computer's SSH trust
   * and Infinitary's own key, so it signs in there and answers this
   * program, never the window's page. One from before the request answers
   * as a step that could not ask.
   */
  async linkAt(address: string, options: JoinAtOptions): Promise<LinkAtAnswer> {
    if (this.held) await this.held;
    if (!listsChange(this.window.homeChanges(), JOIN_BY_ADDRESS_BESIDE))
      return { refused: "failed" };
    return this.window.dispatch("inf:devices:link-at", [address, options]);
  }

  /**
   * The window joins a first mate on another computer: it closes, and the
   * command's first mate stops with nothing set to start it again; with
   * `only`, the window stops just that run, the one it joined or followed
   * along from, and a stop asked through the folder or a signal names its
   * process and start, so a run started by hand in its place keeps going. On
   * a Mac or Linux the agent's launchd job or user service is let go too,
   * which ends whichever run that job holds, one it started again during the
   * join included: it only ever runs the agent's own runs. With `only` null,
   * no run ran when the window joined: the agent is let go and no stop is
   * asked or signalled, so a run started by hand meanwhile keeps going.
   */
  async leave(only?: OwnedRun | null): Promise<void> {
    this.close();
    await this.options.beside.starter
      ?.stop({ forget: true, ...(only === undefined ? {} : { run: only }) })
      .catch((error: unknown) => {
        console.warn(`[shell] could not let the command's starter go: ${(error as Error).message}`);
      });
    if (only !== null) this.options.beside.stopCommand?.(only);
  }

  close(): void {
    this.closed = true;
    // A window closed before its first welcome lets what waited go; its closed link refuses it.
    this.letHeldGo();
    this.stopReading();
    this.notices.stop();
    this.window.close();
  }

  /** One push from the first mate. */
  private heard(channel: PushChannel, payload: unknown, replayed: boolean): void {
    switch (channel) {
      // Its look is this window's: followed, kept, and told to the window from the copy.
      case "inf:shell:preferences": {
        const theirs = shellPreferencesSchema.safeParse(payload);
        if (theirs.success) this.look.follow(theirs.data);
        return;
      }
      // Its Dock choice, applied to this program.
      case "inf:presence:dock": {
        const dock = dockPresenceSchema.safeParse(payload);
        if (dock.success) this.options.beside.presence.setShowInDock(dock.data.showInDock);
        return;
      }
      // What only a program in the person's session can do; an ask a welcome sent again is old.
      case "inf:own-window:ask": {
        const asked = ownWindowAskedSchema.safeParse(payload);
        if (asked.success && !replayed) void this.answer(asked.data.id, asked.data.ask);
        return;
      }
      // A command's first mate opens no page itself: it sends each to the
      // computers that control it, and this window is on the computer the
      // person is at, where a sign-in's return port is the first mate's
      // own. A page a welcome sent again after a drop is old news.
      case "inf:app:open-page":
      case "inf:app:sign-in-page": {
        const page = (
          channel === "inf:app:open-page" ? openPageSchema : signInPageSchema
        ).safeParse(payload);
        if (!replayed && page.success && this.options.openPage)
          void this.options.openPage(page.data.url).catch(() => {
            // The sign-in's own steps still offer its page to open by hand.
          });
        break;
      }
      // The microphone here follows the first mate's switch, wherever it was turned.
      case "inf:settings:dictation": {
        const settings = dictationSettingsSchema.safeParse(payload);
        if (settings.success) this.dictation = settings.data.enabled;
        break;
      }
      // The first mate never posts: its cards' notifications are posted here.
      case "inf:cards":
        this.notices.observe(payload);
        break;
      default:
    }
    if (!replayedPointing(channel, payload, replayed)) this.options.broadcast(channel, payload);
  }

  /** Answers one thing the first mate asked of this computer's window, from this program. */
  private async answer(id: string, ask: OwnWindowAsk): Promise<void> {
    const { presence, chooseFiles } = this.options.beside;
    let answer: OwnWindowAnswer;
    try {
      if (ask.kind === "start-at-login") {
        // Start at login starts the command where this window starts it, never the window.
        const login = this.options.beside.starter?.atLogin ?? {
          get: () => presence.getStartAtLogin(),
          set: (enabled: boolean) => presence.setStartAtLogin(enabled),
        };
        if (ask.set !== undefined) login.set(ask.set);
        answer = { kind: "start-at-login", enabled: login.get() };
      } else if (ask.kind === "update")
        answer = { kind: "update", status: await this.ownUpdate(ask.step, ask.from) };
      else answer = { kind: "choose-files", paths: await chooseFiles({ multiple: ask.multiple }) };
    } catch (error) {
      answer = { kind: "failed", message: (error as Error).message };
    }
    await this.window.dispatch("inf:own-window:answer", [id, answer]).catch(() => {
      // The first mate left: its ask ended with the connection.
    });
  }

  /**
   * This Mac's own update, asked by its first mate for a paired view
   * (docs/view.md, "Updating the first mate's computer"): this window
   * installs it as its own Update button does, saving the crew's work first,
   * and its notice opens, naming the view, so someone here can still choose
   * Update later. A window that does not install updates answers its first
   * mate's own status, which never offers one from here.
   */
  private async ownUpdate(
    step: "status" | "install" | "later",
    from: string | undefined,
  ): Promise<UpdateStatus> {
    if (step === "install") {
      this.asked.start(from);
      if (from) this.options.broadcast("inf:update:asked", { from });
    }
    if (step === "later") await this.asked.later();
    return this.withResuming(await this.asked.status());
  }

  /**
   * Waits for the first mate's answers after each welcome, for as long as
   * a running command gets to answer. A command that welcomed the window
   * and never answers would leave the window waiting with no end and no
   * word why (INF-4622): past the wait it draws from the copy kept here,
   * lets what it asked meanwhile go (`held`), and says under its notice
   * that its first mate is not answering. Every welcome
   * waits so, the first and any after Restart it or a reconnect.
   */
  private async firstAnswers(reading: Promise<boolean>): Promise<void> {
    const since = this.options.now();
    const of = this.options.beside.status().run?.pid;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      // Asks refused as the link dropped were never answered: the wait runs on.
      reading.then((answered) => answered || new Promise<boolean>(() => {})),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.answerWaitMs());
      }),
    ]);
    clearTimeout(timer);
    // A later welcome waits for its own answers.
    if (answered || this.closed || this.reading !== reading) return;
    // Out of reach, or with another command running since this welcome,
    // read() counts for the command that runs now.
    if (!this.window.inReach() || this.options.beside.status().run?.pid !== of) return;
    console.warn("[shell] the command's first mate welcomed the window and has not answered it");
    // Counted from the welcome, so every later reading agrees it has not answered.
    this.unansweredSince = since;
    this.unansweredOf = of ?? null;
    this.show(this.notAnswering());
  }

  /** The notice while Restart it waits for the command it started again. */
  private restartingNotice(): CommandNotice {
    return { state: "waiting", ending: "restart", byWindow: true };
  }

  /** The notice for a command that runs and has not answered in time. */
  private notAnswering(): CommandNotice {
    return {
      state: "stopped",
      ending: "not-answering",
      ...(this.options.beside.starter ? { byWindow: true as const } : {}),
    };
  }

  /** The running command by the process its own record names, for its starter to end by force. */
  private recordedRun(): { pid?: number } {
    const pid = this.options.beside.status().run?.pid;
    return pid === undefined ? {} : { pid };
  }

  private answerWaitMs(): number {
    return this.options.beside.answerWaitMs ?? ANSWER_WAIT_MS;
  }

  /**
   * Start it here over a command that does not answer: the command is
   * stopped first, ended by force through the starter this window started
   * it with (it never acts on a polite stop), or as Stop stops one, and the
   * app starts again as this computer's own first
   * mate. The agent stays in place, so a later launch starts the command
   * again as before; a command that cannot be stopped is joined again.
   */
  private async stopUnanswered(): Promise<void> {
    const { starter, stopCommand } = this.options.beside;
    if (starter)
      await starter.stop({ forget: false, force: this.recordedRun() }).catch((error: unknown) => {
        console.warn(
          `[shell] could not stop the command that does not answer: ${(error as Error).message}`,
        );
      });
    else stopCommand?.();
    if (!this.closed) this.options.relaunch({ startHere: true });
  }

  /** The first mate welcomes the window: the notice goes, and the window takes what is the first mate's. */
  private back(): void {
    if (this.closed) return;
    this.stopReading();
    this.stoppedAt = null;
    this.unansweredSince = null;
    // Beside Restart it, only its own replacement ends the wait, never the run it replaces: a
    // welcome while the records name that run is its own, and counts for nothing.
    if (this.restart) {
      const status = this.options.beside.status();
      this.restart.welcomedOn =
        status.running === true && sameRun(status.run, this.restart.from)
          ? null
          : this.window.connection();
      this.settleRestart(status);
    } else this.startedAt = null;
    this.restarting = false;
    const under = this.shown !== null || this.startsOver;
    this.startsOver = false;
    this.show(null);
    // The command came back on a new copy of the program: this window follows it.
    if (this.options.beside.programReplaced()) {
      this.options.relaunch();
      return;
    }
    // A window that stood under the notice starts over, on the command that came back.
    if (under) this.options.restartWindows();
    this.joined = joinedRun(this.options.beside.status()) ?? this.joined;
    const reading = this.readTheirs().then((answered) => {
      // Only a first mate that answered is back; asks refused as its link dropped say nothing.
      if (!answered || this.reading !== reading) return answered;
      // A later drop of this same command is counted anew.
      this.reading = null;
      this.unansweredSince = null;
      // A first mate that answered after its notice went up: the window starts over on it.
      if (this.shown?.ending === "not-answering" && this.window.inReach()) {
        this.show(null);
        this.options.restartWindows();
      }
      return answered;
    });
    this.reading = reading;
    // What the window asks next is answered from the copy kept here once the wait is over.
    this.answering = this.firstAnswers(reading);
  }

  /**
   * What the window takes from its first mate at each welcome: it says it
   * is open, on this connection, then reads the look, the keys, the Dock
   * choice and the dictation switch, and what the first mate shows now.
   * False when its asks were refused because the link dropped before the
   * first mate answered them.
   */
  private async readTheirs(): Promise<boolean> {
    const ask = <C extends CoreInvokeChannel>(channel: C) => this.window.dispatch(channel, []);
    const first = !this.welcomed;
    this.welcomed = true;
    try {
      await ask("inf:own-window:here");
      if (this.inFront) this.sayFront(true);
      const [look, keys, presence, dictation] = await Promise.all([
        ask("inf:shell:preferences"),
        ask("inf:settings:keys:get"),
        ask("inf:presence:get"),
        ask("inf:settings:dictation:get"),
      ]);
      const theirs: ShellPreferences = shellPreferencesSchema.parse(look);
      // Keys the first mate could not read are never installed over the copy here.
      this.look.follow(theirs, keys.unreadable ? undefined : keys.saved);
      this.options.beside.presence.setShowInDock(presence.showInDock);
      this.dictation = dictation.enabled;
    } catch (error) {
      // The copy kept here stands until the next welcome.
      if (error instanceof HomeOutOfReachError) {
        // Nothing was read: the next welcome reads everything, the notices included.
        if (first) this.welcomed = false;
        return false;
      }
    }
    if (first) await this.notices.seed();
    return true;
  }

  /**
   * Restart it's wait ends, from one reading of the records, once its
   * starter answered and either the records name a run this app's own agent
   * started that is not the one replaced, which welcomed this window on the
   * connection open now, or the starter refused and the run replaced, by
   * its process and start, still runs. Read at each welcome, at the
   * starter's answer and at each join reading, so records unreadable at
   * any of them are read again once they recover, with no further welcome.
   */
  private settleRestart(status: Pick<RunStatus, "running" | "run" | "lastStop">): void {
    const restart = this.restart;
    if (!restart?.settled || status.running !== true) return;
    // Refused: the run replaced still runs, and joins again as before the press.
    if (restart.refused && sameRun(status.run, restart.from)) {
      this.restart = null;
      this.startedAt = restart.startedBefore;
      return;
    }
    const owned = this.options.beside.ownedRun?.(status) ?? null;
    if (!owned || sameRun(owned, restart.from)) return;
    if (restart.welcomedOn === null || restart.welcomedOn !== this.window.connection()) return;
    this.restart = null;
    this.startedAt = null;
  }

  /** The first mate is out of reach: read whether its command still runs, until it is back. */
  private away(): void {
    if (this.closed || this.timer) return;
    this.read();
    this.timer = setInterval(() => this.read(), BESIDE_RUN_READ_MS);
    this.timer.unref?.();
  }

  /**
   * Starts counting how long the running command has not answered, unless
   * it already counts for that same command: one started again since, as
   * after an update, a crash or Restart it, gets a wait of its own.
   */
  private countUnanswered(status: Pick<RunStatus, "run"> = this.options.beside.status()): void {
    const of = status.run?.pid ?? null;
    if (this.unansweredSince !== null && this.unansweredOf === of) return;
    this.unansweredSince = this.options.now();
    this.unansweredOf = of;
  }

  private stopReading(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reading of the command's records: the notice, or none while a command runs. */
  private read(): void {
    const { beside, now } = this.options;
    const waitMs = entryWaitMs(beside.restartWaitMs, this.options.localWindow?.readyMs);
    const status = beside.status();
    if (this.moved && status.running === false) {
      this.stopReading();
      this.closed = true;
      this.options.relaunch();
      return;
    }
    let end = runEnd(status, this.joined);
    // The command this window started has not welcomed it yet: an end
    // recorded before it started is an earlier command's, and the window
    // waits for this one as long as it would for a start entry, then says
    // it stopped without saying why.
    const started = this.startedAt;
    if (started !== null && status.running === false && (end?.at ?? 0) < started)
      end =
        now() - started < waitMs
          ? null
          : { ending: "crashed", exitCode: null, of: null, at: started };
    if (!end) {
      this.stoppedAt = null;
      // A command that runs and has stayed out of reach past its wait is not answering.
      if (status.running === true) this.countUnanswered(status);
      else this.unansweredSince = null;
      const since = this.unansweredSince;
      const silent =
        status.running === true && since !== null && now() - since >= this.answerWaitMs();
      if (silent) this.restarting = false;
      this.show(silent ? this.notAnswering() : this.restarting ? this.restartingNotice() : null);
      return;
    }
    this.stoppedAt ??= now();
    // A command that ended is not one that does not answer: the next one is counted anew.
    this.unansweredSince = null;
    const notice = commandNotice({
      end,
      entry: beside.startEntry(),
      // Counted from the command's own record of its stop, where it left one.
      goneFor: now() - (end.at ?? this.stoppedAt),
      waitMs,
    });
    // Beside the program this window starts, the notice speaks of the person's first mate.
    this.show(notice && beside.starter ? { ...notice, byWindow: true } : notice);
  }

  private show(shown: CommandNotice | null): void {
    // While Restart it's starter has not answered, no notice offers what it would refuse: Restart
    // it again, or Start it here.
    const notice =
      shown?.state === "stopped" && this.restart?.settled === false
        ? this.restartingNotice()
        : shown;
    const was = this.shown;
    if (
      was?.state === notice?.state &&
      was?.ending === notice?.ending &&
      was?.byWindow === notice?.byWindow
    )
      return;
    this.shown = notice;
    this.options.changed();
  }

  /** This window's own update status, with the work the first mate still resumes after one. */
  private async withResuming(status: UpdateStatus): Promise<UpdateStatus> {
    if (status.work || !this.window.inReach()) return status;
    try {
      const hold = await this.window.dispatch("inf:update:hold", ["status"]);
      return hold.work ? { ...status, work: hold.work } : status;
    } catch {
      return status;
    }
  }
}

function joinedRun(status: Pick<RunStatus, "run">): JoinedRun | null {
  return status.run ? { pid: status.run.pid, startedAt: status.run.startedAt } : null;
}
