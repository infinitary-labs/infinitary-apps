import type { BrowserViewer } from "@core/browser/browserViews";
import { LOCAL_CLIENT } from "@core/connection/connection";
import { dialLocalDoor } from "@core/connection/localDoor";
import { HomeLink, type HomeLinkOptions, type HomeLinkState } from "@core/devices/homeLink";
import type { DeviceGrant } from "@shared/devices";
import type { CoreInvokeChannel, InvokeResponse, PushChannel } from "@shared/ipc";
import { BrowserWatches, isBrowserWatchChannel } from "./browserWatches";

/**
 * The window on the first mate's own computer as a view of it
 * (docs/view.md, "The window on the first mate's own computer"): every
 * core request the window makes goes over the connection, through the
 * local door, and every push the first mate makes comes back the same way,
 * as a view on another computer asks and hears. Admitted by the door's key,
 * it is no device on the list and asks what the window always could: every
 * request but a computer's work, as the captain himself, Secrets included.
 *
 * A task's browser is watched over the same connection, as one viewer for
 * every window here, and its pictures come back as the connection's `live`
 * frames. What only this process holds - its keys, frames, files and voice
 * - stays with the window and never crosses.
 */

type Link = Pick<HomeLink, "start" | "invoke" | "state" | "close">;

export type LocalWindowOptions = {
  /** The local door's folder, which the window reads as any local client does. */
  door: string;
  /** Hands a push to this computer's windows; `replayed` marks one a welcome sent again after a drop. */
  broadcast: (channel: PushChannel, payload: unknown, replayed: boolean) => void;
  /** A welcome after the first that could not replay what the window missed: it reads everything again. */
  onReload?: () => void;
  /** The door refused the window's key twice: the link has stopped dialing for good. */
  onLost?: () => void;
  /** The first mate welcomes the window, or no longer does. */
  onContact?: (inReach: boolean) => void;
  /**
   * Each welcome, on a connection the first mate never saw before: a drop
   * it dialed through at once changes no contact, and is still a new one.
   */
  onWelcome?: () => void;
  /** Opens the link; tests stand in their own. */
  link?: (options: HomeLinkOptions) => Link;
};

/**
 * What the link dials with: the door names where and admits by its key, so
 * this carries no key of a device. The id is the connection's own word for
 * a client of the local door.
 */
const DOOR_GRANT: DeviceGrant = {
  at: "127.0.0.1:1",
  homeKey: "local",
  deviceId: LOCAL_CLIENT,
  kind: "view",
  key: "local",
  cert: "local",
};

export class LocalWindow {
  private readonly link: Link;
  private readonly browsers: BrowserWatches;
  private welcomed: Promise<void>;
  private welcome: () => void = () => {};
  private closed = false;
  private welcomedOnce = false;
  /** `ready` stopped waiting before the first welcome, so the window read nothing yet. */
  private readBeforeWelcome = false;

  constructor(options: LocalWindowOptions) {
    this.welcomed = new Promise((resolve) => {
      this.welcome = resolve;
    });
    this.browsers = new BrowserWatches((channel, args) => this.link.invoke(channel, args));
    const open = options.link ?? ((linkOptions) => new HomeLink(linkOptions));
    this.link = open({
      grant: DOOR_GRANT,
      // The door's address and key are read again at each dial.
      dial: () => dialLocalDoor(options.door),
      // On one computer a drop is only a restart of the connection: dial again soon.
      retryMs: [100, 250, 500, 1_000],
      // Both ends share one process, so a long stall holds both: ping slowly.
      pingMs: 30_000,
      onPush: (channel, payload, replayed) =>
        options.broadcast(channel as PushChannel, payload, replayed),
      onLive: (channel, payload) => {
        if (channel === "inf:browser:frame") this.browsers.show(payload);
        // A streamed reply piece or a tool's start or end (`streamed-events-live.md`).
        if (channel === "inf:event") options.broadcast("inf:event", payload, false);
        // The computers' live readings (`computer-readings-live.md`).
        if (channel === "inf:computers:resources")
          options.broadcast("inf:computers:resources", payload, false);
      },
      onCaughtUp: (catchUp) => {
        // A new connection: the first mate forgot every watch with the last one.
        this.browsers.again();
        // The first welcome comes before the window reads anything; a later
        // reload means pushes the journal no longer held were missed.
        if (
          (catchUp === "reload" && this.welcomedOnce) ||
          (!this.welcomedOnce && this.readBeforeWelcome)
        )
          options.onReload?.();
        this.welcomedOnce = true;
        this.welcome();
        options.onWelcome?.();
      },
      onState: (state: HomeLinkState) => {
        // Two refusals of the key stop the link for good (docs/view.md,
        // "Leave, and Remove at the other Mac"): the shell takes the window back.
        if (state.removed && !this.closed) options.onLost?.();
        if (!this.closed) options.onContact?.(state.contact === "in-reach");
      },
    });
    this.link.start();
  }

  /** Resolves once the first mate welcomed the window, or after `timeoutMs` regardless. */
  ready(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A welcome after this finds a window that read nothing: it reads everything then.
        if (!this.welcomedOnce) this.readBeforeWelcome = true;
        resolve();
      }, timeoutMs);
      timer.unref?.();
      void this.welcomed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Whether the first mate welcomes the window now. */
  inReach(): boolean {
    return this.link.state().contact === "in-reach";
  }

  /** One core request the window asked, answered by the first mate over the connection. */
  async dispatch<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown[],
    viewer?: BrowserViewer,
  ): Promise<InvokeResponse<C>> {
    if (viewer && isBrowserWatchChannel(channel))
      return (await this.browsers.view(channel, rawArgs, viewer)) as InvokeResponse<C>;
    // The window's preload reads the answer against the contract, as before.
    return (await this.link.invoke(channel, rawArgs)) as InvokeResponse<C>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.browsers.clear();
    this.link.close();
  }
}
