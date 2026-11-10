import { userInfo } from "node:os";
import type { BrowserViewer } from "@core/browser/browserViews";
import type { HomeConnection } from "@core/connection/connection";
import { claimLink, dialHome, HomeKeyMismatchError, PairRefusedError } from "@core/devices/dial";
import type { Joined, JoinedHome } from "@core/devices/joinedHome";
import type { Launcher } from "@core/helper/background";
import { windowFromWork, workFromWindow } from "@core/helper/fromWindow";
import { homeDialOptions } from "@core/helper/route";
import type { InBackground } from "@core/helper/words";
import type { HostNotifications } from "@core/host";
import type { Core } from "@core/index";
import type { PersonalExtensions } from "@core/personal/personalExtensions";
import type { UpdateChecker } from "@core/update/updateChecker";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceGrant,
  type JoinOutcome,
  linkDialingFirst,
  linkNamesPrivateToo,
  parsePairingLink,
  type ThisMac,
} from "@shared/devices";
import type { CoreInvokeChannel, InvokeResponse, PushChannel } from "@shared/ipc";
import type { JoinAtAnswer, JoinAtOptions } from "@shared/joinByAddress";
import { DEFAULT_SAVED_KEYMAP, type SavedKeymap, type SavedKeymapRead } from "@shared/keymap";
import type { KeySystem } from "@shared/platform";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import type { PictureSource } from "./frames/frameProtocol";
import { InstalledKeymap, type MainCommandHandlers } from "./keyboard";
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
  /** Ends this Mac's own SSH connections to the computers it reaches that way, within their bound. */
  stopSsh: () => Promise<void>;
  detach: () => void;
};
type ViewMode = { kind: "view"; view: ViewBackend };

export type ShellOptions = {
  joined: JoinedHome;
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
  };
  /** Starts this Mac's own core. A process starts it at most once. */
  startCore: () => Promise<Core>;
  /** Serves a started core to paired devices. */
  startConnection: (core: Core) => HomeConnection;
  /** Hands a push to every window. */
  broadcast: (channel: PushChannel, payload: unknown) => void;
  /** This Mac's Notification Center: a view posts the other Mac's cards here. */
  notifications: HostNotifications;
  /** This Mac's own name, which it joins another by. */
  deviceName: () => Promise<string>;
  /** What every window shows changed whole: each starts over. */
  restartWindows: () => void;
  /** Starts the app again in a new process, for a core that already ran in this one. */
  relaunch: () => void;
  /** This Mac's own installed app's update checker, which a view answers its update notice from. */
  updates: UpdateChecker;
  /**
   * Opens a page in this computer's browser, for a view of a first mate
   * (`ViewBackendOptions.openPage`).
   */
  openPage?: (url: string) => Promise<void>;
  /** Where a view catches a sign-in's return (`ViewBackendOptions.returnHost`). */
  returnHost?: string;
  now?: () => number;
  /** Opens a view; tests stand in their own link. */
  view?: Pick<ViewBackendOptions, "link">;
  /**
   * Whose keys this computer's keyboard presses (docs/keyboard.md, "Keys on
   * each system"): the app passes its desktop's; a Mac's when absent.
   */
  keySystem?: KeySystem;
};

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
  readonly size: MainCommandHandlers = sizeCommands(this);
  private mode: HomeMode | ViewMode | null = null;
  private coreStarted = false;
  private switching: Promise<void> | null = null;
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
    const joined = this.options.joined.read() ?? this.openFromWork();
    if (joined) {
      this.followWork(joined);
      this.becomeView();
    } else await this.becomeHome();
  }

  /** The running core, while this app holds Firstmate itself. */
  core(): Core | null {
    return this.mode?.kind === "home" ? this.mode.core : null;
  }

  thisMac(): ThisMac {
    if (this.mode?.kind === "view") return this.mode.view.thisMac();
    return { role: "home", left: this.options.joined.left() };
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
      return mode.core.dispatch(channel, rawArgs, { kind: "captain" }, viewer);
    return mode.view.dispatch(channel, rawArgs, viewer);
  }

  /**
   * Joins Firstmate on another Mac with a pasted link (docs/view.md): uses
   * the link once, keeps the grant, then stops this Mac's own Firstmate and
   * starts every window over as the other Mac's. Joined as a Mac, this Mac
   * also runs that Mac's work: the work folder keeps the same grant and the
   * work starts in the background. A refusal changes nothing here.
   */
  async join(text: string): Promise<JoinOutcome> {
    if (this.mode?.kind !== "home" || this.switching) return { ok: false, refused: "other" };
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
    const work = this.options.work;
    if (grant.kind === "mac" && work)
      void workFromWindow({
        dataDir: work.dataDir,
        grant,
        name: null,
        joinedAt,
        ...(work.background ? { background: work.background } : {}),
      })
        .then((outcome) => {
          if (outcome !== "running" && outcome !== "none")
            console.warn(
              `[shell] ${HERE.this}'s work for the ${COMPUTER.one} it joined: ${outcome}`,
            );
        })
        .catch((error: unknown) =>
          console.warn(`[shell] could not set up ${HERE.this}'s work: ${(error as Error).message}`),
        );
    void this.switchTo(async () => {
      // Answer the window first; the switch starts it over.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.stopHome();
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
      const user = userInfo();
      return await claimLink(text, {
        kind,
        name: await this.options.deviceName(),
        // A link for a Mac: it joins with its window, and the work that may
        // run here runs as this user. An older Mac's link for a view hears neither.
        ...(kind === "mac"
          ? {
              window: true as const,
              user: { name: user.username, uid: process.getuid?.() ?? user.uid },
            }
          : {}),
      });
    } catch (error) {
      return { ok: false, refused: joinRefusal(error) };
    }
  }

  /**
   * One step of Join by its address (docs/view.md, "Joining by its
   * address"): this app's core asks the computer at `address` for a one-use
   * link over the person's own SSH. Once it has one, the link stays here,
   * never in the window, and the window asks the paste path's question.
   */
  async joinAt(address: string, options: JoinAtOptions = {}): Promise<JoinAtAnswer> {
    this.held = null;
    if (this.mode?.kind !== "home" || this.switching) return { refused: "failed" };
    const answer = await this.mode.core.services.remoteLogin.linkAt(address, options);
    if (!("link" in answer)) return answer;
    const link = parsePairingLink(answer.link);
    // A link for another user there is not for Firstmate here.
    if (link.kind !== "mac" && link.kind !== "view") return { refused: "no-link" };
    this.held = answer;
    return { asks: "join", runsWork: link.kind === "mac", alsoPrivate: linkNamesPrivateToo(link) };
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

  /** Whether the window may hear the microphone: voice stays on the Mac where Firstmate lives. */
  dictationEnabled(): boolean {
    const core = this.core();
    return core ? core.services.settings.getDictation().enabled : false;
  }

  /**
   * The window was focused: a stale allowance reading is refreshed on the
   * Mac that holds it. That reading observes any login switched meanwhile.
   */
  windowFocused(): void {
    const core = this.core();
    core?.services.quota.onWindowFocus();
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
    return { root: mode?.core.paths.crewmatesDir ?? "" };
  }

  /** A panel's compiled files, its own or one the captain added, while this Mac holds Firstmate; a view has none. */
  framePanelDir(...args: Parameters<PersonalExtensions["framePanelDir"]>): string | null {
    return this.core()?.services.personal.framePanelDir(...args) ?? null;
  }

  /** Stops whatever this app is running, for a quit. */
  async dispose(): Promise<void> {
    await this.switching;
    const mode = this.mode;
    this.mode = null;
    if (mode?.kind === "view") mode.view.dispose();
    if (mode?.kind === "home") {
      mode.detach();
      // Devices hear the home quit through its SSH connections, which go after.
      await mode.connection.close();
      await mode.stopSsh();
      await mode.core.dispose();
    }
  }

  private async becomeHome(): Promise<void> {
    this.coreStarted = true;
    const core = await this.options.startCore();
    // One sink per attached client: this Mac's windows, then paired devices.
    const detach = core.events.subscribe((channel, payload) =>
      this.options.broadcast(channel, payload),
    );
    const connection = this.options.startConnection(core);
    // The core reaches the computers that run work through it (docs/helper.md).
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
      stopSsh,
      detach: () => {
        unfollow();
        unreach();
        detach();
      },
    };
    this.preferences.use(core.services.preferences);
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
    const work = this.options.work;
    if (!work) return null;
    const found = windowFromWork(work.dataDir, this.options.joined.leftDeviceId());
    if (!found) return null;
    this.options.joined.join(found.grant, found.joinedAt);
    if (found.name) this.options.joined.name(found.name);
    return this.options.joined.read();
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
    this.options.joined.dialAt(there.grant.at, there.grant.via);
  }

  private becomeView(): void {
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
      broadcast: this.options.broadcast,
      notifications: this.options.notifications,
      onThisMac: (thisMac) => this.options.broadcast("inf:devices:this-mac", thisMac),
      onRemoved: () => void this.removedThere(),
      updates: this.options.updates,
      ...(this.options.openPage ? { openPage: this.options.openPage } : {}),
      ...(this.options.returnHost ? { returnHost: this.options.returnHost } : {}),
      ...(this.options.view?.link ? { link: this.options.view.link } : {}),
    });
    this.mode = { kind: "view", view };
    this.preferences.use(view.look);
  }

  /** The other Mac removed this one: it returns to its own first launch, saying so. */
  private async removedThere(): Promise<void> {
    const mode = this.mode;
    if (mode?.kind !== "view" || this.switching) return;
    const now = mode.view.thisMac();
    const deviceId = this.options.joined.read()?.grant.deviceId;
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

  private async stopHome(): Promise<void> {
    const mode = this.mode;
    if (mode?.kind !== "home") return;
    this.mode = null;
    mode.detach();
    await mode.connection.close();
    await mode.stopSsh();
    await mode.core.dispose();
  }

  /** One switch at a time; every window starts over once it is done. */
  private switchTo(change: () => Promise<void>): Promise<void> {
    this.switching = (async () => {
      try {
        await change();
      } finally {
        this.switching = null;
        if (this.mode) this.options.restartWindows();
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
