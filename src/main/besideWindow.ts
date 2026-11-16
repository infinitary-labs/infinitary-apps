import type { BrowserViewer } from "@core/browser/browserViews";
import type { JoinedHome } from "@core/devices/joinedHome";
import type { HostNotifications, HostPresence } from "@core/host";
import { AskedInstall } from "@core/update/homeUpdate";
import type { UpdateChecker } from "@core/update/updateChecker";
import type { CommandNotice } from "@shared/commandNotice";
import { dictationSettingsSchema } from "@shared/dictation";
import {
  type CoreInvokeChannel,
  type InvokeResponse,
  openPageSchema,
  type PushChannel,
  signInPageSchema,
} from "@shared/ipc";
import type { SavedKeymap, SavedKeymapRead } from "@shared/keymap";
import {
  dockPresenceSchema,
  type OwnWindowAnswer,
  type OwnWindowAsk,
  ownWindowAskedSchema,
} from "@shared/ownWindow";
import { type ShellPreferences, shellPreferencesSchema } from "@shared/preferences";
import type { UpdateStatus } from "@shared/update";
import { commandNotice, entryWaitMs, type JoinedRun, runEnd, type StartEntry } from "./besideRun";
import type { CommandStarter } from "./commandStarter";
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

/** How often the window reads whether the command still runs while it is out of reach. */
const BESIDE_RUN_READ_MS = 1_000;

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
  /** Stops the command's first mate and its crew cleanly, as a signal does; false when none runs. */
  stopCommand?: () => boolean;
};

export type BesideWindowOptions = {
  beside: BesideOptions;
  /** Hands a push to this computer's windows. */
  broadcast: (channel: PushChannel, payload: unknown) => void;
  notifications: HostNotifications;
  /** This program's own update checker. */
  updates: UpdateChecker;
  openPage?: (url: string) => Promise<void>;
  /** Starts the app again; `startHere` as this computer's own first mate, whatever start entry is in place. */
  relaunch: (how?: { startHere?: boolean }) => void;
  /** The window reads everything again, as a view does after a gap. */
  readAgain: () => void;
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
  /** The command this window joined, as its note names it; null when it opened between two. */
  private joined: JoinedRun | null;
  /** When the window first saw that no command runs, for an end whose record names no time. */
  private stoppedAt: number | null = null;
  private shown: CommandNotice | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What the window takes from its first mate on a welcome, while it is being read. */
  private reading: Promise<void> | null = null;
  private welcomed = false;
  private closed = false;
  /** When this window last started the command, until that one welcomes it. */
  private startedAt: number | null;
  /** Start it here took the notice down: the window starts over once the command it started welcomes it. */
  private startsOver = false;
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
        void this.window.dispatch("inf:settings:keys:set", [keymap]).catch(() => {
          // The copy here stands until the first mate is read again.
        });
      },
    };
    this.notices = new ViewNotices(options.notifications, (channel, args) =>
      this.window.dispatch(channel, args),
    );
    this.window = new LocalWindow({
      door: beside.door,
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
   * Waits for the first welcome as the window of a first mate run here
   * does. The door may open only after the window: the link dials until it
   * does, and the window reads everything once welcomed. A window opened
   * while no command runs draws at once, under its notice.
   */
  async start(): Promise<void> {
    if (this.startedAt === null && this.options.beside.status().running === false) {
      this.away();
      await this.window.ready(0);
      return;
    }
    await this.window.ready(this.options.localWindow?.readyMs);
    if (this.window.inReach()) await this.reading;
    else {
      console.warn("[shell] the command's first mate has not welcomed the window yet");
      this.away();
    }
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
    if (!this.window.inReach()) return;
    void this.window.dispatch("inf:own-window:focused", []).catch(() => {});
  }

  /**
   * Start it here: this window starts again as the computer's own first
   * mate. Only once the notice offers it, and never while a command runs
   * or its records cannot be read.
   */
  startHere(): boolean {
    if (this.shown?.state !== "stopped") return false;
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
        await this.reading;
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
        const appearance = await this.window.dispatch("inf:settings:appearance:set", rawArgs);
        return this.look.setAppearance(appearance) as InvokeResponse<C>;
      }
      case "inf:settings:layout:set": {
        const layout = await this.window.dispatch("inf:settings:layout:set", rawArgs);
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
    const answer = await this.window.dispatch(channel, rawArgs, viewer);
    if (channel === "inf:settings:dictation:get" || channel === "inf:settings:dictation:set")
      this.dictation = (answer as InvokeResponse<"inf:settings:dictation:get">).enabled;
    return answer;
  }

  /**
   * The window joins a first mate on another computer: it closes, and the
   * command's first mate stops with nothing set to start it again.
   */
  async leave(): Promise<void> {
    this.close();
    await this.options.beside.starter?.stop({ forget: true }).catch((error: unknown) => {
      console.warn(`[shell] could not let the command's starter go: ${(error as Error).message}`);
    });
    this.options.beside.stopCommand?.();
  }

  close(): void {
    this.closed = true;
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
    this.options.broadcast(channel, payload);
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

  /** The first mate welcomes the window: the notice goes, and the window takes what is the first mate's. */
  private back(): void {
    if (this.closed) return;
    this.stopReading();
    this.stoppedAt = null;
    this.startedAt = null;
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
    const reading = this.readTheirs().finally(() => {
      if (this.reading === reading) this.reading = null;
    });
    this.reading = reading;
  }

  /**
   * What the window takes from its first mate at each welcome: it says it
   * is open, on this connection, then reads the look, the keys, the Dock
   * choice and the dictation switch, and what the first mate shows now.
   */
  private async readTheirs(): Promise<void> {
    const ask = <C extends CoreInvokeChannel>(channel: C) => this.window.dispatch(channel, []);
    const first = !this.welcomed;
    this.welcomed = true;
    try {
      await ask("inf:own-window:here");
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
    } catch {
      // The copy kept here stands until the next welcome.
    }
    if (first) await this.notices.seed();
  }

  /** The first mate is out of reach: read whether its command still runs, until it is back. */
  private away(): void {
    if (this.closed || this.timer) return;
    this.read();
    this.timer = setInterval(() => this.read(), BESIDE_RUN_READ_MS);
    this.timer.unref?.();
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
      this.show(null);
      return;
    }
    this.stoppedAt ??= now();
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

  private show(notice: CommandNotice | null): void {
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
