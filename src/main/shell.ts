import type { BrowserViewer } from "@core/browser/browserViews";
import type { HomeConnection } from "@core/connection/connection";
import { thisDeviceUser } from "@core/devices/deviceUser";
import { claimLink, dialHome, HomeKeyMismatchError, PairRefusedError } from "@core/devices/dial";
import { type Joined, JoinedHome } from "@core/devices/joinedHome";
import type { Launcher } from "@core/helper/background";
import { foldProof, windowFromWork, workFromWindow } from "@core/helper/fromWindow";
import { homeDialOptions } from "@core/helper/route";
import type { InBackground } from "@core/helper/words";
import { setUpWork } from "@core/helper/workSetup";
import type { HomeHandOver } from "@core/homeMove/outgoing";
import { HOME_MOVING, setAsideRecord, WAY_BACK_KEY } from "@core/homeMove/record";
import type { HostNotifications } from "@core/host";
import type { Core } from "@core/index";
import { hostPlatform, hostPlatformProfile } from "@core/platform";
import type { UpdateChecker } from "@core/update/updateChecker";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceFold,
  type DeviceGrant,
  type JoinOutcome,
  linkDialingFirst,
  linkNamesPrivateToo,
  parsePairingLink,
  systemRunsWork,
  type ThisMac,
} from "@shared/devices";
import { replayedPointing } from "@shared/events";
import type { CoreInvokeChannel, InvokeResponse, PushChannel } from "@shared/ipc";
import type { JoinAtAnswer, JoinAtOptions } from "@shared/joinByAddress";
import { DEFAULT_SAVED_KEYMAP, type SavedKeymap, type SavedKeymapRead } from "@shared/keymap";
import type { PanelFiles, PanelFilesRequest } from "@shared/personal/panelFiles";
import type { KeySystem } from "@shared/platform";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import type { WindowKeyReminders } from "@shared/windowAnswer";
import type { WorkSetupReport } from "@shared/workSetup";
import { type BesideOptions, BesideWindow } from "./besideWindow";
import type { PictureSource } from "./frames/frameProtocol";
import { InstalledKeymap, type SizeCommandHandlers } from "./keyboard";
import { type OwnedRun, sameRun } from "./runCommand";
import { LocalWindow, type LocalWindowOptions } from "./view/localWindow";
import { ViewBackend, type ViewBackendOptions } from "./view/viewBackend";
import { type PreferenceSource, sizeCommands } from "./windowSize";

/**
 * What this app is on its Mac, and the one place the rest of the main
 * process asks (docs/view.md). It holds Firstmate itself - its own core,
 * served to paired devices over the connection - or it controls Firstmate
 * on another Mac as a view, with no core at all. The window's calls, its
 * pushes, its look, its frames and its card pictures all go through here,
 * so nothing else in the main process reads a core directly.
 *
 * Joining switches from the first to the second in place: the core stops
 * and the window starts over as the other Mac's. Leaving, or being removed
 * there, switches back: the core starts - once per process, so a second
 * start means relaunching the app.
 */

type HomeMode = {
  kind: "home";
  core: Core;
  connection: HomeConnection;
  /**
   * The window here as a view of this first mate, over the local door
   * (docs/view.md, "The window on the first mate's own computer"); none
   * with no window, or while the door could not open.
   */
  window: LocalWindow | null;
  /** Ends this Mac's own SSH connections to the computers it reaches that way, within their bound. */
  stopSsh: () => Promise<void>;
  detach: () => void;
};
type ViewMode = { kind: "view"; view: ViewBackend };
/**
 * The window opened while a command runs this computer's first mate in
 * another program (docs/run.md, "The window opened beside it"): a view of
 * it over its local door, with no core here (`BesideWindow`).
 */
type BesideMode = { kind: "beside"; beside: BesideWindow };

export type ShellOptions = {
  joined: JoinedHome;
  /** This computer's key reminder, once the window's profile has one (`./keyReminders.ts`). */
  keyReminders?: () => WindowKeyReminders | null;
  /**
   * Whether this computer's own first mate keeps a record here already, read
   * without starting it: true where that cannot be told. With none, nothing
   * can have been done here, so a grant waiting in the work folder opens the
   * window at once; with one, the first mate starts and its own first launch
   * says whether anything was (docs/view.md, "Following along").
   */
  recordHere: () => boolean;
  /**
   * This user's work folder (docs/helper.md, "Where it keeps its data"): a
   * Mac that runs its home's work keeps its grant there, which this app
   * controls that home with, and one that joined here sets its work up
   * there, in the background. None when absent.
   */
  work?: {
    dataDir: string;
    background?: (setUp: {
      launcher: Launcher | null;
      app: string | null;
    }) => Promise<InBackground>;
    /** Where the app that runs now is (`process.execPath`), which the background starts. */
    appPath?: string;
  };
  /**
   * Starts this Mac's own core. A process starts it at most once.
   * `onHomeMoved` hears the first mate move to another computer.
   */
  startCore: (hooks?: { onHomeMoved?: (handOver: HomeHandOver | null) => void }) => Promise<Core>;
  /**
   * A first mate started by a command with no window ends its run once it
   * moved to another computer (docs/devices.md, "Moving the first mate"):
   * `moved` for good, with nothing here to start it again, or `restart`
   * for a move that failed after it stopped. Absent, the app starts again.
   */
  endRun?: (how: "moved" | "restart") => void;
  /** Serves a started core to paired devices, and to this computer's window through the local door. */
  startConnection: (core: Core) => HomeConnection;
  /**
   * The local door's folder, which the window reads to reach its first mate
   * over the connection (docs/connection.md, "The local door"). Absent, as
   * for a first mate started by a command with no window, nothing here
   * dials it and the core's pushes go straight to `broadcast`.
   */
  localDoor?: (core: Core) => string;
  /**
   * Opens the window's link through the local door, and how long the shell
   * waits for its first welcome before the window asks directly; tests stand in their own.
   */
  localWindow?: Pick<LocalWindowOptions, "link"> & { readyMs?: number };
  /**
   * A command runs this computer's first mate in another program
   * (docs/run.md, "The window opened beside it"): the window joins it over
   * its local door and this process starts no core.
   */
  beside?: BesideOptions;
  /** Hands a push to every window. */
  broadcast: (channel: PushChannel, payload: unknown) => void;
  /** This Mac's Notification Center: a view posts the other Mac's cards here. */
  notifications: HostNotifications;
  /** This Mac's own name, which it joins another by. */
  deviceName: () => Promise<string>;
  /**
   * The version of Infinitary this app is, which its window's connection
   * tells the computer it controls (docs/devices.md, "Each copy's version").
   */
  appVersion?: string;
  /** What every window shows changed whole: each starts over. */
  restartWindows: () => void;
  /**
   * Starts the app again in a new process, for a core that already ran in
   * this one; `startHere` as this computer's own first mate, whatever
   * started the command the window stood beside (docs/run.md, "When the
   * command stops").
   */
  relaunch: (how?: { startHere?: boolean }) => void;
  /** This Mac's own installed app's update checker, which a view answers its update notice from. */
  updates: UpdateChecker;
  /**
   * Opens a page in this computer's browser, for a view of a first mate
   * (`ViewBackendOptions.openPage`).
   */
  openPage?: (url: string) => Promise<void>;
  /** Where a view catches a sign-in's return (`ViewBackendOptions.returnHost`). */
  returnHost?: string;
  /** This Mac's approver of Secrets uses, made when it becomes a view (`ViewBackendOptions.approver`). */
  approver?: ViewBackendOptions["approver"];
  /** What this computer confirms Take over with where the approver is not it (`ViewBackendOptions.takeOverAuthentication`). */
  takeOverAuthentication?: ViewBackendOptions["takeOverAuthentication"];
  /** How a view hears its home's announcement (`ViewBackendOptions.find`). */
  findHome?: () => Promise<readonly string[]>;
  now?: () => number;
  /** Opens a view; tests stand in their own link. */
  view?: Pick<ViewBackendOptions, "link">;
  /**
   * Whose keys this computer's keyboard presses (docs/keyboard.md, "Keys on
   * each system"): the app passes its desktop's; a Mac's when absent.
   */
  keySystem?: KeySystem;
};

/**
 * Whether this computer may run its home's work (docs/devices.md, "Joining"):
 * a Mac, a Linux computer and a Windows PC all may.
 */
function runsWorkHere(): boolean {
  return systemRunsWork(hostPlatformProfile().system ?? undefined);
}

/** The window's look and keys, from whichever this app is now; a switch tells every follower. */
class SwitchablePreferences implements PreferenceSource {
  private source: PreferenceSource | null = null;
  private detach: (() => void) | null = null;
  private readonly listeners = new Set<(value: ShellPreferences) => void>();

  use(source: PreferenceSource): void {
    this.detach?.();
    this.source = source;
    this.detach = source.subscribe((value) => this.tell(value));
    this.tell(source.get());
  }

  get(): ShellPreferences {
    return this.source?.get() ?? DEFAULT_SHELL_PREFERENCES;
  }

  subscribe(listener: (value: ShellPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  keymap(): SavedKeymapRead {
    return this.source?.keymap() ?? { saved: DEFAULT_SAVED_KEYMAP, unreadable: false };
  }

  setKeymap(keymap: SavedKeymap): void {
    if (!this.source) throw new Error("Infinitary has not started yet.");
    this.source.setKeymap(keymap);
  }

  private tell(value: ShellPreferences): void {
    for (const listener of this.listeners) listener(value);
  }
}

export class Shell {
  readonly preferences = new SwitchablePreferences();
  /** The window's keys, this computer's own whichever this app is (docs/keyboard.md). */
  readonly keymap: InstalledKeymap;
  /**
   * The size steps every window's keys, the View menu and command search
   * share: one queue, written through `dispatch` as the picker's choice is.
   */
  readonly size: SizeCommandHandlers = sizeCommands(this);
  private mode: HomeMode | ViewMode | BesideMode | null = null;
  /** Whether a window of this program is in front, as it last said (`windowFront`). */
  private inFront = false;
  /** The windows that hold words not yet sent, as each last said (`windowUnsent`). */
  private readonly unsent = new Set<number>();
  private coreStarted = false;
  /**
   * The times the window on this computer had to read everything again
   * after a gap in what its first mate told it (docs/view.md, "The window
   * on the first mate's own computer"), which the window follows as a
   * view's `caughtUp`.
   */
  private homeCaughtUp = 0;
  /** The times the window's link to its first mate came back after a drop, which the window follows. */
  private homeLinkBack = 0;
  private switching: Promise<void> | null = null;
  /**
   * This computer's own first mate while it starts: a home that hears it was
   * taken over as it starts steps down only once it holds its core, so its
   * record goes aside and its core stops.
   */
  private homing: Promise<void> | null = null;
  /** This Mac's checks of its work half, for the window open now (`checkWork`). */
  private workChecks: {
    view: ViewBackend | null;
    connected: boolean;
    running: Promise<void> | null;
    again: boolean;
  } = { view: null, connected: false, running: null, again: false };
  /** The link Join by its address asked for, held in memory until the captain's yes or Cancel. */
  private held: { link: string; host: string | null } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ShellOptions) {
    this.now = options.now ?? Date.now;
    this.keymap = new InstalledKeymap(this.preferences, options.keySystem ?? "mac");
  }

  /**
   * Starts as whatever this app was: a view of the Mac it joined, or this
   * Mac's own Firstmate. A core that cannot start (saved data from a newer
   * version) throws, as `startCore` does.
   */
  async start(): Promise<void> {
    if (this.options.beside) {
      await this.becomeBeside(this.options.beside);
      return;
    }
    // A grant waiting opens the window only where nothing was done here: with
    // no record, at once; with one, once its own first launch says so.
    const waiting = this.options.joined.read() ? null : this.waitingGrant();
    const joined =
      this.options.joined.read() ??
      (waiting && !this.options.recordHere() ? this.openFromWork() : null);
    if (joined) {
      this.followWork(joined);
      this.becomeView();
      return;
    }
    await this.becomeHome();
    if (waiting)
      await this.followAdded().catch((error: unknown) =>
        console.warn(`[shell] could not follow the computer that added this one: ${String(error)}`),
      );
  }

  /** The running core, while this app holds Firstmate itself. */
  core(): Core | null {
    return this.mode?.kind === "home" ? this.mode.core : null;
  }

  thisMac(): ThisMac {
    if (this.mode?.kind === "view") return this.mode.view.thisMac();
    const beside = this.mode?.kind === "beside";
    const command = this.mode?.kind === "beside" ? this.mode.beside.notice() : null;
    return {
      role: "home",
      left: this.options.joined.left(),
      ...(this.homeCaughtUp ? { caughtUp: this.homeCaughtUp } : {}),
      ...(this.homeLinkBack ? { linkBack: this.homeLinkBack } : {}),
      ...(command ? { command } : {}),
      ...(beside ? { byCommand: true as const } : {}),
    };
  }

  /**
   * Stop, in Settings → General, beside a command (docs/run.md, "Quit and
   * Stop"): its first mate and crew stop cleanly until the person starts
   * Infinitary again. False where the window runs no first mate beside one.
   */
  stopCommand(): boolean {
    return this.mode?.kind === "beside" ? this.mode.beside.stop() : false;
  }

  /**
   * Start it here, on the notice over the window opened beside a command
   * that stopped (docs/run.md, "When the command stops"): the app starts
   * again as this computer's own first mate. False when nothing offers it.
   */
  startHere(): boolean {
    return this.mode?.kind === "beside" ? this.mode.beside.startHere() : false;
  }

  /**
   * Restart it, on the notice over the window opened beside a command that
   * runs and does not answer (docs/run.md, "A command that runs and does
   * not answer"): the command is ended by force and started again. False
   * when nothing offers it.
   */
  restartCommand(): boolean {
    return this.mode?.kind === "beside" ? this.mode.beside.restartCommand() : false;
  }

  /**
   * This program's own update is about to replace the copy and restart
   * it: the first mate a command started ends with its crew's work saved
   * (docs/alpha.md, "Saving work before an update").
   */
  async updateReplacing(): Promise<void> {
    if (this.mode?.kind === "beside") await this.mode.beside.replacing();
  }

  /** One core channel the window asked: this Mac's core, or the view's rules. */
  async dispatch<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown[],
    viewer?: BrowserViewer,
  ): Promise<InvokeResponse<C>> {
    const mode = this.mode;
    if (!mode) throw new Error("Infinitary is still starting.");
    if (mode.kind === "home")
      return mode.window
        ? mode.window.dispatch(channel, rawArgs, viewer)
        : mode.core.dispatch(channel, rawArgs, { kind: "captain" }, viewer);
    if (mode.kind === "beside") return mode.beside.dispatch(channel, rawArgs, viewer);
    return mode.view.dispatch(channel, rawArgs, viewer);
  }

  /**
   * Joins Firstmate on another Mac with a pasted link (docs/view.md): uses
   * the link once, keeps the grant, then stops this Mac's own Firstmate and
   * starts every window over as the other Mac's. Joined as a Mac, this Mac
   * also runs that Mac's work: the work folder keeps the same grant and the
   * work starts in the background. A refusal changes nothing here. Beside
   * a command this window starts, that command's first mate is this Mac's
   * own: it stops, and nothing starts it again (docs/run.md, "Joining
   * another computer"). Beside a boot entry, which would start it again, it
   * is refused.
   */
  async join(text: string): Promise<JoinOutcome> {
    if (!this.joinable() || this.switching) return { ok: false, refused: "other" };
    // Beside a command, the run this window's starter owns now: only it stops.
    const owned =
      this.mode?.kind === "beside" ? (this.mode.beside.ownedRun ?? undefined) : undefined;
    let kind: string;
    try {
      kind = parsePairingLink(text).kind;
    } catch {
      return { ok: false, refused: "not-a-link" };
    }
    // A link for another user on that Mac is not for Firstmate here.
    if (kind !== "mac" && kind !== "view") return { ok: false, refused: "kind" };
    // The claim begins the switch, so a second join asked meanwhile is
    // refused, never run beside this one into a second view.
    const claimed = this.claim(text, kind);
    this.switching = claimed.then(() => undefined);
    const grant = await claimed;
    if ("refused" in grant) {
      this.switching = null;
      return { ok: false, refused: grant.refused };
    }
    const joinedAt = this.now();
    this.options.joined.join(grant, joinedAt);
    // Its work is set up as the window starts over as the other Mac's (`checkWork`).
    void this.switchTo(async () => {
      // Answer the window first; the switch starts it over.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.stopHome(owned);
      this.becomeView();
    });
    return { ok: true };
  }

  /** Uses a pasted link once, or says why it did not join. */
  private async claim(
    text: string,
    kind: "mac" | "view",
  ): Promise<DeviceGrant | Exclude<JoinOutcome, { ok: true }>> {
    try {
      // A link for a Mac: it joins with its window, and the work that may
      // run here runs as this user. An older Mac's link for a view hears neither.
      const user =
        kind === "mac"
          ? await thisDeviceUser({ platform: hostPlatform(), getuid: process.getuid })
          : null;
      if (kind === "mac" && !user) return { ok: false, refused: "other" };
      // A Windows PC says so: a home from before Windows ran work lists it
      // as one that only controls, and sets nothing up for work there
      // (docs/devices.md, "Joining").
      const system = hostPlatformProfile().system;
      return await claimLink(text, {
        kind,
        name: await this.options.deviceName(),
        ...(user ? { window: true as const, user } : {}),
        ...(system === "windows" || (system && !runsWorkHere()) ? { system } : {}),
      });
    } catch (error) {
      return { ok: false, refused: joinRefusal(error) };
    }
  }

  /**
   * Whether this app may join another computer: as this computer's own
   * first mate, or beside a command this window starts while the command
   * running is its own agent's, whose first mate stops for good (docs/run.md,
   * "Joining another computer"). Never beside one started by hand, which
   * joining would stop.
   */
  private joinable(): boolean {
    return (
      this.mode?.kind === "home" ||
      (this.mode?.kind === "beside" &&
        this.mode.beside.startsCommand &&
        this.mode.beside.ownedRun !== null)
    );
  }

  /**
   * One step of Join by its address (docs/view.md, "Joining by its
   * address"): this computer's first mate asks the computer at `address`
   * for a one-use link over the person's own SSH - this app's own core, or
   * beside a command this window starts, the command's first mate, which
   * keeps this computer's SSH trust. Once it has one, the link stays here,
   * never in the window, and the window asks the paste path's question.
   */
  async joinAt(address: string, options: JoinAtOptions = {}): Promise<JoinAtAnswer> {
    this.held = null;
    const mode = this.mode;
    if (!this.joinable() || !mode || mode.kind === "view" || this.switching)
      return { refused: "failed" };
    const answer =
      mode.kind === "home"
        ? await mode.core.services.remoteLogin.linkAt(address, options)
        : await mode.beside.linkAt(address, options);
    if (!("link" in answer)) return answer;
    const link = parsePairingLink(answer.link);
    // A link for another user there is not for Firstmate here.
    if (link.kind !== "mac" && link.kind !== "view") return { refused: "no-link" };
    this.held = answer;
    return {
      asks: "join",
      runsWork: link.kind === "mac" && runsWorkHere(),
      alsoPrivate: linkNamesPrivateToo(link),
    };
  }

  /**
   * The captain's answer to the paste path's question after Join by its
   * address: join with the held link exactly as a pasted one, dialing first
   * the host their SSH reached, or forget it.
   */
  async joinHeld(choice: "join" | "forget"): Promise<JoinOutcome> {
    const held = this.held;
    this.held = null;
    if (choice === "forget" || !held) return { ok: false, refused: "other" };
    return this.join(linkDialingFirst(held.link, held.host));
  }

  /**
   * Following along at first launch (docs/view.md, "A Mac that runs work"):
   * while this computer's first launch is still up and nothing has been
   * done here, a home that added it by its address left its grant in the
   * work folder, and the window opens it now with no relaunch, stopping the
   * empty first mate beside it as `join` does. False when nothing changed.
   */
  async followAdded(): Promise<boolean> {
    if (!this.joinable() || this.switching || !this.options.work) return false;
    // Beside a command, only the run this window's starter owns stops by itself.
    const owned =
      this.mode?.kind === "beside" ? (this.mode.beside.ownedRun ?? undefined) : undefined;
    // Only a grant waiting asks the first mate anything: most polls find none.
    const waiting = this.waitingGrant();
    if (!waiting) return false;
    const firstRun = await this.dispatch("inf:app:first-run", []).catch(() => null);
    // Only a profile with nothing done here: no turn, sign-in, connection,
    // ask, task, card or project (`FirstRunView.untouched`). A profile with
    // something done keeps its own first mate, after a restart too.
    if (firstRun && firstRun.untouched !== true)
      this.options.joined.keepOwn(waiting.grant.deviceId);
    if (firstRun?.untouched !== true) return false;
    // Asked again after the wait: a join, a switch or another run may have started meanwhile.
    if (!this.joinable() || this.switching) return false;
    if (this.mode?.kind === "beside" && !sameRun(this.mode.beside.ownedRun, owned)) return false;
    const joined = this.openFromWork();
    if (!joined) return false;
    this.followWork(joined);
    void this.switchTo(async () => {
      // Answer the window first; the switch starts it over.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.stopHome(owned);
      this.becomeView();
    });
    return true;
  }

  /**
   * What this window does once its first mate's computer adds it: `follows`
   * when it would follow along (`followAdded`), able to join with this
   * computer's work; and `joins` when Paste its link and Join by its address
   * work here: as its own first mate, or beside a command its starter owns,
   * never one started by hand (`joinable`). The window promises only these.
   */
  followsAdded(): { follows: boolean; joins: boolean } {
    const joins = this.joinable();
    return { follows: joins && Boolean(this.options.work), joins };
  }

  /**
   * Leave (docs/view.md): tells the other Mac when it is in reach, forgets
   * it, and returns this app to its own first launch.
   */
  async leave(): Promise<void> {
    const mode = this.mode;
    if (mode?.kind !== "view" || this.switching) return;
    const name = mode.view.thisMac();
    const deviceId = this.options.joined.read()?.grant.deviceId;
    await mode.view.leave();
    this.options.joined.leave(
      {
        name: name.role === "view" ? name.name : `the other ${COMPUTER.one}`,
        reason: "left",
        at: this.now(),
      },
      undefined,
      deviceId,
    );
    await this.switchTo(async () => {
      mode.view.dispose();
      await this.becomeHomeAgain();
    });
  }

  /**
   * Take over: this Mac becomes the first mate's computer from the copy it
   * keeps, while that computer is out of reach (docs/devices.md, "Taking
   * over"). On success the window starts over as its own first mate.
   */
  async takeOver(): Promise<{ ok: boolean; text: string }> {
    const mode = this.mode;
    if (mode?.kind !== "view" || this.switching)
      return { ok: false, text: "This Mac cannot take over now." };
    return mode.view.takeOver();
  }

  /** Whether the window may hear the microphone: voice stays on the Mac where Firstmate lives. */
  dictationEnabled(): boolean {
    if (this.mode?.kind === "beside") return this.mode.beside.dictationEnabled();
    const core = this.core();
    return core ? core.services.settings.getDictation().enabled : false;
  }

  /**
   * The window was focused: a stale allowance reading is refreshed on the
   * Mac that holds it. That reading observes any login switched meanwhile.
   */
  windowFocused(): void {
    if (this.mode?.kind === "beside") this.mode.beside.focused();
    const core = this.core();
    core?.services.quota.onWindowFocus();
  }

  /**
   * A window of this program came to the front or left it. A first mate in
   * this same program sees its own windows; one a command started, or one
   * on another Mac, hears it, so it pushes no card to a phone meanwhile
   * (docs/phone-push.md). Kept here for the next first mate this window follows.
   * A window whose work could not start checks it again as it comes back to
   * the front, so a trip to System Settings clears its notice
   * (docs/view.md, "Setting its work up again").
   */
  windowFront(inFront: boolean): void {
    this.inFront = inFront;
    if (this.mode?.kind === "beside") this.mode.beside.front(inFront);
    if (this.mode?.kind === "view") {
      const view = this.mode.view;
      view.front(inFront);
      const here = view.thisMac();
      if (inFront && here.role === "view" && here.workSetup?.state === "blocked")
        void this.checkWork();
    }
  }

  /**
   * A window said whether it holds words not yet sent, or closed (docs/view.md,
   * "Following the home's version"): an app catching up with the computer it
   * controls starts again only while none does.
   */
  windowUnsent(windowId: number, holds: boolean): void {
    if (holds) this.unsent.add(windowId);
    else this.unsent.delete(windowId);
    if (!holds && this.mode?.kind === "view") this.mode.view.noticed();
  }

  /** The Mac woke. */
  resumed(): void {
    const core = this.core();
    core?.services.quota.onResumed();
    // Each computer out of reach over this Mac's own SSH is tried at once.
    core?.services.sshConnections.resume();
  }

  /** The Mac goes to sleep: no SSH connection is tried until it wakes. */
  suspended(): void {
    this.core()?.services.sshConnections.suspend();
    // Each device hears it first, so a computer that keeps a copy says the home slept.
    void this.core()?.services.workDevices.tellGoodbye();
  }

  /** Where a card picture's, recording's or project font's bytes come from now. */
  pictures(): PictureSource {
    const mode = this.mode;
    if (mode?.kind === "view") {
      return {
        fetch: (fileName: string) => mode.view.picture(fileName),
        fetchMedia: (fileName: string, offset: number, length: number) =>
          mode.view.recordingPiece(fileName, offset, length),
        fetchTypeface: (fileName: string) => mode.view.typeface(fileName),
      };
    }
    if (mode?.kind === "beside") return { root: mode.beside.crewmatesDir() };
    return { root: mode?.core.paths.crewmatesDir ?? "" };
  }

  /**
   * A panel's built files, its own or one the captain added, as the first
   * mate answers them: asked the way every core request is, so the window
   * on the first mate's own computer, the window opened beside a first mate
   * a command started and a window on another computer draw the same panel
   * (docs/view.md, "Panels in every window").
   */
  panelFiles(request: PanelFilesRequest): Promise<PanelFiles> {
    return this.dispatch("inf:plugins:files", [request]);
  }

  /** Stops whatever this app is running, for a quit. */
  async dispose(): Promise<void> {
    await this.switching;
    const mode = this.mode;
    this.mode = null;
    if (mode?.kind === "view") mode.view.dispose();
    if (mode?.kind === "beside") mode.beside.close();
    if (mode?.kind === "home") {
      mode.detach();
      mode.window?.close();
      // Devices hear the home quit through its SSH connections, which go after.
      await mode.connection.close();
      await mode.stopSsh();
      await mode.core.dispose();
    }
  }

  private async becomeHome(): Promise<void> {
    // Held before the core starts, so a step-down it hears at once waits too.
    let started: () => void = () => {};
    const homing = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.homing = homing;
    try {
      await this.startHome();
    } finally {
      if (this.homing === homing) this.homing = null;
      started();
    }
  }

  private async startHome(): Promise<void> {
    this.coreStarted = true;
    const core = await this.options.startCore({
      onHomeMoved: (handOver) => void this.homeMoved(handOver),
    });
    const connection = this.options.startConnection(core);
    // This computer's window is a view of its first mate like any other
    // (docs/view.md): its requests and pushes go over the connection,
    // through the local door, once the door is open.
    const door = this.options.localDoor?.(core);
    // With no window over the door, the core's pushes go straight to this
    // computer's windows, as before.
    let direct: (() => void) | null = null;
    const goDirect = () => {
      direct ??= core.events.subscribe((channel, payload) =>
        this.options.broadcast(channel, payload),
      );
    };
    let window: LocalWindow | null = null;
    if (door) {
      await connection.settled();
      if (connection.localDoor()) {
        const opened: LocalWindow = new LocalWindow({
          door,
          // An old ask to point the window, sent again after a drop, moves nobody.
          broadcast: (channel, payload, replayed) => {
            if (!replayedPointing(channel, payload, replayed))
              this.options.broadcast(channel, payload);
          },
          ...(this.options.keyReminders ? { keyReminders: this.options.keyReminders } : {}),
          // A gap the first mate could not replay: the window reads everything again.
          onReload: () => this.readAgainHere(),
          // A drop the link dialed through: the window asks its one-time reads again.
          onBack: () => this.linkBackHere(),
          // A door that no longer takes its key: the window asks directly, and reads again.
          onLost: () => {
            if (this.mode?.kind !== "home" || this.mode.window !== opened) return;
            console.warn(
              "[shell] the local door refused the window; it asks its first mate directly",
            );
            opened.close();
            this.mode.window = null;
            goDirect();
            this.readAgainHere();
          },
          ...(this.options.localWindow?.link ? { link: this.options.localWindow.link } : {}),
        });
        await opened.ready(this.options.localWindow?.readyMs);
        if (opened.inReach()) window = opened;
        else {
          console.warn(
            "[shell] the window could not reach its first mate through the local door; it asks directly",
          );
          opened.close();
        }
      } else
        console.warn(
          "[shell] the local door did not open; the window asks its first mate directly",
        );
    }
    if (!window) goDirect();
    const detach = () => {
      direct?.();
      direct = null;
    };
    // The core reaches the computers that run work through it (docs/helper.md),
    // each one the connection welcomed while the window opened included.
    const unreach = core.services.workDevices.attach(connection);
    // It listens where this Mac is now, and Devices says it, as the network
    // moves (docs/devices.md).
    const unfollow = core.services.devices.followNetwork();
    // And those it added by their address through its own SSH connection to
    // each, which only an attached connection carries (docs/devices.md).
    const stopSsh = core.services.sshConnections.start();
    this.mode = {
      kind: "home",
      core,
      connection,
      window,
      stopSsh,
      detach: () => {
        unfollow();
        unreach();
        detach();
      },
    };
    this.preferences.use(core.services.preferences);
  }

  /** The window beside a command's first mate (`BesideWindow`). */
  private async becomeBeside(options: BesideOptions): Promise<void> {
    const beside = new BesideWindow({
      beside: options,
      broadcast: this.options.broadcast,
      notifications: this.options.notifications,
      updates: this.options.updates,
      ...(this.options.keyReminders ? { keyReminders: this.options.keyReminders } : {}),
      ...(this.options.openPage ? { openPage: this.options.openPage } : {}),
      relaunch: (how) => {
        if (this.mode?.kind === "beside") this.options.relaunch(how);
      },
      readAgain: () => this.readAgainHere(),
      linkBack: () => this.linkBackHere(),
      restartWindows: this.options.restartWindows,
      changed: () => this.options.broadcast("inf:devices:this-mac", this.thisMac()),
      ...(this.options.localWindow ? { localWindow: this.options.localWindow } : {}),
      now: this.now,
    });
    this.mode = { kind: "beside", beside };
    if (this.inFront) beside.front(true);
    this.preferences.use(beside.preferences);
    await beside.start();
  }

  /** The window here reads everything again, as a view does after a gap. */
  private readAgainHere(): void {
    this.homeCaughtUp += 1;
    this.options.broadcast("inf:devices:this-mac", this.thisMac());
  }

  /** The window's link came back after a drop: it asks what it read only once again. */
  private linkBackHere(): void {
    this.homeLinkBack += 1;
    this.options.broadcast("inf:devices:this-mac", this.thisMac());
  }

  /**
   * Back to this Mac's own Firstmate after controlling another: in place
   * when this process never ran its core, otherwise in a new process.
   */
  private async becomeHomeAgain(): Promise<void> {
    if (this.coreStarted) {
      this.mode = null;
      this.options.relaunch();
      return;
    }
    try {
      await this.becomeHome();
    } catch {
      this.mode = null;
      this.options.relaunch();
    }
  }

  /**
   * A Mac a command or its address added, opened with its window
   * (docs/view.md, "A Mac that runs work"): it controls the home its work
   * runs for, with the grant its work keeps, and no new link. Never the
   * device this app last left or was removed as.
   */
  private openFromWork(): Joined | null {
    const found = this.waitingGrant();
    if (!found) return null;
    this.options.joined.join(found.grant, found.joinedAt, found.name);
    return this.options.joined.read();
  }

  /**
   * The grant this computer's work keeps for its window (`windowFromWork`),
   * unless this window kept its own first mate when that grant came: a
   * profile with something done stays itself, a restart included.
   */
  private waitingGrant(): Joined | null {
    const work = this.options.work;
    if (!work) return null;
    const found = windowFromWork(work.dataDir, this.options.joined.leftDeviceId());
    if (!found || found.grant.deviceId === this.options.joined.keptOwnDeviceId()) return null;
    return found;
  }

  /**
   * The work's grant moves when its home is found at another address, or
   * starts reaching this Mac over the home's own SSH: the window follows it.
   */
  private followWork(joined: Joined): void {
    const work = this.options.work;
    if (!work || joined.grant.kind !== "mac") return;
    const there = windowFromWork(work.dataDir, null);
    if (!there || there.grant.deviceId !== joined.grant.deviceId) return;
    if (there.grant.via === "ssh") this.options.joined.dialAt(there.grant.at, there.grant.via);
    else this.options.joined.routes(there.grant.at, there.grant.also ?? joined.grant.also ?? []);
  }

  /**
   * The entry this Mac's work keeps for the same home as `record`, when it is
   * another one than the window holds (docs/helper.md, "A Mac that also
   * controls"): a `mac`'s, never the one `record` names.
   */
  private workEntryBeside(record: Joined): Joined | null {
    const work = this.options.work;
    if (!work || record.grant.kind !== "mac") return null;
    const there = windowFromWork(work.dataDir, record.grant.deviceId);
    if (!there || there.grant.homeKey !== record.grant.homeKey) return null;
    return there;
  }

  /** The fold this window asks when its work keeps another entry for the same home. */
  private foldFor(record: Joined): { fold?: DeviceFold } {
    const kept = this.workEntryBeside(record);
    const fold = kept ? foldProof(record, kept) : null;
    return fold ? { fold } : {};
  }

  private becomeView(carriedOn?: { at: number; from: ViewBackend }): void {
    const record = this.options.joined.read();
    if (!record) throw new Error(`This app has joined no other ${COMPUTER.one}.`);
    const workDir = this.options.work?.dataDir;
    const view = new ViewBackend({
      // Reached over that Mac's own SSH, it dials the route its work keeps.
      ...(workDir && record.grant.via === "ssh"
        ? { dial: (grant) => dialHome(grant, homeDialOptions(workDir, grant)) }
        : {}),
      joined: this.options.joined,
      record,
      ...(workDir ? { workDir } : {}),
      broadcast: this.options.broadcast,
      notifications: this.options.notifications,
      onThisMac: (thisMac) => this.options.broadcast("inf:devices:this-mac", thisMac),
      onRemoved: () => void this.removedThere(),
      onMovedHere: () => this.options.relaunch(),
      updates: this.options.updates,
      ...(this.options.openPage ? { openPage: this.options.openPage } : {}),
      ...(this.options.returnHost ? { returnHost: this.options.returnHost } : {}),
      ...(this.options.approver ? { approver: this.options.approver } : {}),
      ...(this.options.takeOverAuthentication
        ? { takeOverAuthentication: this.options.takeOverAuthentication }
        : {}),
      name: this.options.deviceName,
      ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}),
      ...(this.options.findHome ? { find: this.options.findHome } : {}),
      ...(this.options.view?.link ? { link: this.options.view.link } : {}),
      ...(carriedOn ? { carriedOn: carriedOn.at, from: carriedOn.from } : {}),
      ...this.foldFor(record),
      onConnected: () => {
        // A welcome proves this Mac is still on its home's list, so each
        // connection, the first of a launch included, checks its work.
        if (this.workChecks.view !== view) return;
        this.workChecks.connected = true;
        void this.checkWork();
      },
      onSetUpWork: () => void this.checkWork(),
      ...(this.options.keyReminders ? { keyReminders: this.options.keyReminders } : {}),
      nobodyHere: () => !this.inFront && this.unsent.size === 0,
      wordsLeft: () => this.unsent.size > 0,
    });
    this.mode = { kind: "view", view };
    if (this.inFront) view.front(true);
    this.workChecks = { view, connected: false, running: null, again: false };
    this.preferences.use(view.look);
  }

  /**
   * Checks this Mac's work half and sets it up again by itself (docs/view.md,
   * "A Mac that runs work"; `setUpWork`): at every connection to its home,
   * the first of each launch included, on the window's Try again, on its
   * home's Fix it, and as its window comes back to the front while its work
   * could not start. Never before this launch's first welcome, which proves the
   * Mac is still on its home's list: a Mac removed while its app was closed
   * sets nothing up again. One check at a time; one asked meanwhile runs once
   * more after it. Nothing for a window that only controls, or on a computer
   * that runs no work.
   */
  async checkWork(): Promise<void> {
    const checks = this.workChecks;
    const work = this.options.work;
    if (!checks.view || this.mode?.kind !== "view" || this.mode.view !== checks.view) return;
    if (!checks.connected) return;
    if (!work || !runsWorkHere() || this.options.joined.read()?.grant.kind !== "mac") return;
    if (checks.running) {
      checks.again = true;
      await checks.running;
      return;
    }
    const view = checks.view;
    checks.running = (async () => {
      do {
        checks.again = false;
        const record = this.options.joined.read();
        if (record?.grant.kind !== "mac") return;
        const found = setUpWork({
          dataDir: work.dataDir,
          grant: record.grant,
          name: record.name ?? null,
          joinedAt: record.joinedAt,
          ...(work.background ? { background: work.background } : {}),
          ...(work.appPath ? { appPath: work.appPath } : {}),
        }).catch((error: unknown): WorkSetupReport | null => {
          console.warn(`[shell] could not check ${HERE.this}'s work: ${(error as Error).message}`);
          return null;
        });
        this.tellWork(view, await found);
      } while (checks.again && this.mode?.kind === "view" && this.mode.view === view);
    })();
    try {
      await checks.running;
    } finally {
      checks.running = null;
    }
  }

  /** What a check found goes to the window it was made for, while it is still the one open. */
  private tellWork(view: ViewBackend, report: WorkSetupReport | null): void {
    if (this.mode?.kind !== "view" || this.mode.view !== view) return;
    if (report?.state === "blocked")
      console.warn(`[shell] ${HERE.this}'s work cannot run: ${report.reason ?? "unknown"}`);
    view.workSetupFound(report);
  }

  /**
   * The other Mac removed this one: it returns to its own first launch,
   * saying so - unless this Mac's work still runs for that same home as
   * another entry, when the window carries on as that one at once, and says
   * so (docs/view.md, "A Mac that runs work").
   */
  private async removedThere(): Promise<void> {
    const mode = this.mode;
    if (mode?.kind !== "view" || this.switching) return;
    const now = mode.view.thisMac();
    const record = this.options.joined.read();
    const deviceId = record?.grant.deviceId;
    const carryOn = record ? this.workEntryBeside(record) : null;
    if (carryOn) {
      const homeNumber = this.options.joined.homeNumber();
      this.options.joined.join(
        carryOn.grant,
        carryOn.joinedAt,
        carryOn.name ?? record?.name ?? null,
      );
      this.options.joined.keepHomeNumber(homeNumber);
      const at = this.now();
      // The same home with the same record: the windows stay as they are,
      // and catch up at the new connection's welcome, which also asks their
      // watches of tasks' browsers again.
      await this.switchTo(async () => {
        this.becomeView({ at, from: mode.view });
        mode.view.dispose();
      }, true);
      return;
    }
    this.options.joined.leave(
      {
        name: now.role === "view" ? now.name : `the other ${COMPUTER.one}`,
        reason: "removed",
        at: this.now(),
      },
      undefined,
      deviceId,
    );
    await this.switchTo(async () => {
      mode.view.dispose();
      await this.becomeHomeAgain();
    });
  }

  /**
   * The first mate moved to another computer (docs/devices.md, "Moving the
   * first mate"): it stops here, its record goes aside where nothing opens
   * it again, and this computer opens as a window of the new home with the
   * grant handed over. A move that failed after it stopped starts it again.
   */
  private async homeMoved(handOver: HomeHandOver | null): Promise<void> {
    // Heard as the first mate here starts: it goes once this app holds it.
    await this.homing;
    const end = (how: "moved" | "restart") => {
      this.mode = null;
      if (this.options.endRun) this.options.endRun(how);
      else this.options.relaunch();
    };
    if (!handOver) {
      await this.stopHome().catch(() => {});
      end("restart");
      return;
    }
    const userData = this.mode?.kind === "home" ? this.mode.core.paths.userData : null;
    await this.stopHome().catch((error: unknown) =>
      console.warn(`[shell] the first mate did not stop cleanly: ${String(error)}`),
    );
    try {
      if (userData) setAsideRecord(userData, handOver.move, [HOME_MOVING, WAY_BACK_KEY]);
    } catch (error) {
      console.warn(`[shell] could not set the moved record aside: ${String(error)}`);
    }
    const joinedAt = this.now();
    this.options.joined.join(handOver.grant, joinedAt, handOver.name);
    this.options.joined.keepHomeNumber(handOver.homeNumber);
    if (handOver.steppedDown) this.options.joined.keepSteppedDown(handOver.steppedDown);
    // It stays a computer that runs work: its work keeps the same grant and
    // starts in the background, as a Mac that joined does.
    const work = this.options.work;
    if (work) {
      const outcome = await workFromWindow({
        dataDir: work.dataDir,
        grant: handOver.grant,
        name: handOver.name,
        joinedAt,
        ...(work.background ? { background: work.background } : {}),
      }).catch((error: unknown) => {
        console.warn(`[shell] could not set up ${HERE.this}'s work: ${(error as Error).message}`);
        return "failed" as const;
      });
      if (outcome === "running" || outcome === "at-login" || outcome === "none")
        new JoinedHome(work.dataDir, () => {}).keepHomeNumber(handOver.homeNumber);
      else console.warn(`[shell] ${HERE.this}'s work for the moved first mate: ${outcome}`);
    }
    end("moved");
  }

  private async stopHome(only?: OwnedRun): Promise<void> {
    const mode = this.mode;
    if (mode?.kind === "beside") {
      this.mode = null;
      await mode.beside.leave(only);
      return;
    }
    if (mode?.kind !== "home") return;
    this.mode = null;
    mode.detach();
    mode.window?.close();
    await mode.connection.close();
    await mode.stopSsh();
    await mode.core.dispose();
  }

  /** One switch at a time; every window starts over once it is done. */
  /** Changes mode; the windows start again for the new one unless `keepWindows` (the same home, carried on). */
  private switchTo(change: () => Promise<void>, keepWindows = false): Promise<void> {
    this.switching = (async () => {
      try {
        await change();
      } finally {
        this.switching = null;
        if (this.mode && !keepWindows) this.options.restartWindows();
      }
    })();
    return this.switching;
  }
}

/** What a failed join says, from what the other Mac or the network answered. */
function joinRefusal(error: unknown): Exclude<JoinOutcome, { ok: true }>["refused"] {
  if (error instanceof HomeKeyMismatchError) return "not-that-mac";
  if (error instanceof PairRefusedError) {
    switch (error.refused) {
      case "used":
      case "expired":
      case "unknown":
      case "kind":
        return error.refused;
      default:
        return "other";
    }
  }
  return "unreachable";
}
