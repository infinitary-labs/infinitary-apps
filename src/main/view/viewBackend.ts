import { createServer, type Server } from "node:http";
import type { BrowserViewer } from "@core/browser/browserViews";
import {
  BROWSER_FROM_ANY_VIEW,
  DEVICES_FROM_A_VIEW,
  EVERY_VIEW_ASKS,
} from "@core/connection/connection";
import { contractChange, listsChange } from "@core/connection/contractChanges";
import { HomeLink, type HomeLinkOptions, type HomeLinkState } from "@core/devices/homeLink";
import type { Joined, JoinedHome } from "@core/devices/joinedHome";
import type { HostNotifications } from "@core/host";
import { CardNotifier } from "@core/notifications";
import { SIGN_IN_RETURN } from "@core/signInReturns";
import type { UpdateChecker } from "@core/update/updateChecker";
import { cardsSnapshotSchema } from "@shared/cards";
import { sideToUpdate } from "@shared/contractFeatures";
import { HERE, HOME } from "@shared/deviceNames";
import { splitDialAddress, type ThisMac } from "@shared/devices";
import {
  type CoreInvokeChannel,
  type InvokeResponse,
  isViewInvokeChannel,
  openPageSchema,
  PROTOCOL_VERSION,
  type PushChannel,
  parseInvokeRequest,
  signInEndedSchema,
  signInPageSchema,
} from "@shared/ipc";
import { readKeepingUnknown } from "@shared/openLists";
import { type ShellPreferences, shellPreferencesSchema } from "@shared/preferences";
import { BrowserWatches, isBrowserWatchChannel } from "./browserWatches";
import { namedHere, namedHereError } from "./namedHere";
import { ViewLook } from "./viewLook";

/**
 * The app as a view of another Mac (docs/view.md): the main process's
 * stand-in for the core it no longer runs. The window keeps every call it
 * makes; this decides who answers each one.
 *
 * - The core channels a view may ask (`reach: "views"`) go to the other Mac
 *   over the connection (`HomeLink`), as the captain at another Mac, and a
 *   page it would open for one of them opens here.
 * - This Mac's own look is answered here (`ViewLook`), and so is its own
 *   update notice: this Mac's installed app and the release page it opens.
 * - A task's browser is watched over that connection too, as one viewer for
 *   every window here: the other Mac sends this connection its pictures, and
 *   each goes to the windows that watch that task (docs/view.md, "A task's
 *   browser on a view").
 * - Everything else stays on the other Mac - its Secrets, voice, panels and
 *   Observe - and is refused here without being sent.
 *
 * Only the pushes a view shows reach the window; the other Mac's own look
 * is never one of them. A change asked while that Mac is out of reach is
 * refused at once and never sent later.
 *
 * Its cards notify on this Mac as they do on the other (docs/view.md,
 * "Notifications"): the same notifier reads the same card pushes, while
 * this Mac's window is in the background and the other Mac's own switch
 * is on.
 */

/**
 * The pushes a view shows, with what its Settings follow: a sign-in's steps,
 * the sign-ins where projects live, integrations, Diagnostics, and the
 * computers and phones with their sign-ins (`devices-from-a-view.md`). The
 * rest are the other Mac's own: its look, voice and panels.
 */
export const VIEW_PUSHES: ReadonlySet<PushChannel> = new Set<PushChannel>([
  "inf:event",
  "inf:cards",
  "inf:cards:thread",
  "inf:quota",
  "inf:models:changed",
  "inf:tasks",
  "inf:tasks:delta",
  "inf:auth:prompt",
  "inf:auth:notice",
  "inf:forges",
  "inf:integrations",
  "inf:sharing",
  "inf:devices",
  "inf:devices:addresses",
  "inf:devices:nearby",
  "inf:devices:sign-ins",
  "inf:devices:sign-in",
  "inf:computers:presence",
  "inf:computers:resources",
]);

/** Channels answered from this Mac's own look. */
const OWN_LOOK = new Set<CoreInvokeChannel>([
  "inf:shell:preferences",
  "inf:settings:appearance:get",
  "inf:settings:appearance:set",
  "inf:settings:layout:get",
  "inf:settings:layout:set",
]);

/** Channels about the app installed on this Mac: its update notice and release page. */
const OWN_APP = new Set<CoreInvokeChannel>([
  "inf:update:status",
  "inf:update:check",
  "inf:update:channel",
  "inf:update:open-release",
  "inf:update:install",
  "inf:update:later",
]);

/** The pictures and project fonts this run has shown, by name, up to this many bytes; a name never changes its bytes. */
const PICTURE_CACHE_BYTES = 64 * 1024 * 1024;

type Link = Pick<HomeLink, "start" | "invoke" | "state" | "leave" | "close">;

export type ViewBackendOptions = {
  joined: JoinedHome;
  record: Joined;
  /** Hands a push to this Mac's windows. */
  broadcast: (channel: PushChannel, payload: unknown) => void;
  /** This Mac's Notification Center, and whether its window is in front. */
  notifications: HostNotifications;
  /** What this app is changed; the window follows it. */
  onThisMac: (thisMac: ThisMac) => void;
  /** The other Mac took this one off its list. */
  onRemoved: () => void;
  /** This Mac's own installed app's update checker. */
  updates: UpdateChecker;
  /**
   * Opens a page in this computer's browser: one the first mate would have
   * opened there (`inf:app:open-page`). Absent, such a page is not opened.
   */
  openPage?: (url: string) => Promise<void>;
  /**
   * The loopback address this computer catches a sign-in's return on
   * (docs/view.md, "A sign-in that returns to the first mate's computer"):
   * 127.0.0.1, as the provider sends the browser there; a test playing two
   * computers on one Linux PC gives another of its own addresses.
   */
  returnHost?: string;
  /** Opens the link to the other Mac; tests stand in their own. */
  link?: (options: HomeLinkOptions) => Link;
  /**
   * How the link dials: for a Mac that Mac reaches over its own SSH, the
   * route this Mac's work keeps (docs/view.md, "A Mac that runs work");
   * by default the grant's address.
   */
  dial?: HomeLinkOptions["dial"];
};

export class ViewBackend {
  readonly look: ViewLook;
  private readonly link: Link;
  private readonly notifier: CardNotifier;
  private readonly joined: JoinedHome;
  private readonly record: Joined;
  private caughtUp = 0;
  private readonly pictures = new Map<string, Uint8Array>();
  private pictureBytes = 0;
  private seeding: Promise<void> | null = null;
  private disposed = false;
  /**
   * Each task's browser a window here watches: the other Mac hears one
   * watch per task, asked again whenever this connection is welcomed again.
   */
  private readonly browsers: BrowserWatches;
  /** The sign-in there whose return this computer waits for, and its listener while it has one. */
  private signInReturn: { id: string; caught: boolean; server: Server | null } | null = null;

  constructor(private readonly options: ViewBackendOptions) {
    this.joined = options.joined;
    this.record = options.record;
    this.look = new ViewLook(options.joined, (value) =>
      options.broadcast("inf:shell:preferences", value),
    );
    this.notifier = new CardNotifier({
      enabled: () => options.notifications.supported(),
      focused: () => options.notifications.focused(),
      show: (notification) => void this.notify(notification),
    });
    this.browsers = new BrowserWatches(
      (channel, args) => this.link.invoke(channel, args),
      () => this.browserWaitsThere(),
    );
    const open = options.link ?? ((linkOptions) => new HomeLink(linkOptions));
    this.link = open({
      grant: options.record.grant,
      // A Mac that also runs this home's work says this connection controls it.
      as: "view",
      ...(options.dial ? { dial: options.dial } : {}),
      onPush: (channel, payload, replayed) => {
        if (channel === "inf:cards") this.observeCards(payload);
        if (channel === "inf:app:open-page") this.openPage(payload, replayed);
        if (channel === "inf:app:sign-in-page") void this.openSignInPage(payload, replayed);
        if (channel === "inf:app:sign-in-ended") this.signInEnded(payload);
        if (VIEW_PUSHES.has(channel as PushChannel))
          options.broadcast(channel as PushChannel, payload);
      },
      onLive: (channel, payload) => {
        if (channel === "inf:browser:frame") this.browsers.show(payload);
        // A streamed reply piece or a tool's start or end (`streamed-events-live.md`).
        if (channel === "inf:event") options.broadcast("inf:event", payload);
      },
      onCaughtUp: (catchUp) => {
        if (!this.look.seeded()) void this.seedLook();
        // A new connection: the other Mac forgot every watch with the last one.
        this.browsers.again();
        // Read again whole - at the start too - what the other Mac holds is
        // old news here, as restored cards are there. A replay needs
        // nothing: the missed pushes follow, and a card that became ready
        // while this Mac could not hear it is news.
        if (catchUp === "reload") {
          // Whether the sign-in there still waits is not known: its page again starts anew.
          this.endSignInReturn();
          this.notifier.forget();
          void this.seedNotifier();
          this.caughtUp += 1;
          this.changed();
        }
      },
      onState: (state) => this.followed(state),
    });
    this.link.start();
  }

  /** The other Mac's address, as its grant dials it. */
  private homeAddress(): string {
    return splitDialAddress(this.record.grant.at)?.host ?? this.record.grant.at;
  }

  /** The other Mac's name: as it says it, as it was saved when this Mac joined, or its address. */
  private homeName(): string {
    return (
      this.link.state().name ?? this.joined.read()?.name ?? this.record.name ?? this.homeAddress()
    );
  }

  /** What this app is now, for the window. */
  thisMac(): ThisMac {
    const state = this.link.state();
    return {
      role: "view",
      name: this.homeName(),
      address: this.homeAddress(),
      joinedAt: this.record.joinedAt,
      contact: state.contact,
      readOnly: readOnly(state),
      heardAt: state.heardAt,
      caughtUp: this.caughtUp,
      ...(this.record.grant.kind === "mac" ? { runsWork: true } : {}),
      ...(state.homeChanges !== null && !listsChange(state.homeChanges, EVERY_VIEW_ASKS)
        ? { needsUpdateThere: true as const }
        : {}),
      ...(this.browserWaitsThere() ? { browserNeedsUpdateThere: true as const } : {}),
      ...(state.homeChanges !== null && !listsChange(state.homeChanges, DEVICES_FROM_A_VIEW)
        ? { devicesNeedUpdateThere: true as const }
        : {}),
      ...(state.homeChanges !== null && !listsChange(state.homeChanges, SIGN_IN_RETURN)
        ? { returnsNeedUpdateThere: true as const }
        : {}),
      ...(this.signInReturn
        ? { signInReturn: { id: this.signInReturn.id, caught: this.signInReturn.caught } }
        : {}),
    };
  }

  /** Answers one core channel the window asked, as above. */
  async dispatch<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown[],
    viewer?: BrowserViewer,
  ): Promise<InvokeResponse<C>> {
    if (OWN_LOOK.has(channel)) return (await this.ownLook(channel, rawArgs)) as InvokeResponse<C>;
    if (OWN_APP.has(channel)) return (await this.ownApp(channel, rawArgs)) as InvokeResponse<C>;
    if (viewer && isBrowserWatchChannel(channel))
      return (await this.browsers.view(channel, rawArgs, viewer)) as InvokeResponse<C>;
    if (!isViewInvokeChannel(channel))
      throw new Error(`${channel} is answered only on ${HOME.the}.`);
    // An older home strips unknown command settings, potentially preserving an old key.
    const commandInput =
      channel === "inf:accounts:custom:connect"
        ? rawArgs[0]
        : channel === "inf:devices:custom:connect"
          ? rawArgs[1]
          : undefined;
    if (
      commandInput &&
      typeof commandInput === "object" &&
      "tokenCommand" in commandInput &&
      !listsChange(this.link.state().homeChanges, contractChange("custom-token-command"))
    )
      throw new Error(`Update Infinitary on ${HOME.the} before saving a token command.`);
    // The window's preload reads the answer against the contract, as it reads this Mac's own,
    // with the other Mac's own words naming it where they say this computer.
    const name = () => this.homeName();
    try {
      return namedHere(
        channel,
        await this.link.invoke(channel, rawArgs),
        name,
      ) as InvokeResponse<C>;
    } catch (caught) {
      throw namedHereError(caught, name);
    }
  }

  /** A card picture by its name, from the other Mac, kept for this run. */
  async picture(fileName: string): Promise<Uint8Array> {
    const kept = this.pictures.get(fileName);
    if (kept) return kept;
    const answer = (await this.link.invoke("inf:cards:picture", [
      fileName,
    ])) as InvokeResponse<"inf:cards:picture">;
    const bytes = new Uint8Array(Buffer.from(answer.data, "base64"));
    this.keepPicture(fileName, bytes);
    return bytes;
  }

  /**
   * A project font by its name, from the other Mac (`inf:cards:typeface`),
   * kept for this run with the pictures.
   */
  async typeface(fileName: string): Promise<Uint8Array> {
    const kept = this.pictures.get(fileName);
    if (kept) return kept;
    const answer = (await this.link.invoke("inf:cards:typeface", [
      fileName,
    ])) as InvokeResponse<"inf:cards:typeface">;
    const bytes = new Uint8Array(Buffer.from(answer.data, "base64"));
    this.keepPicture(fileName, bytes);
    return bytes;
  }

  /**
   * A piece of a card's demo recording by its name, from the other Mac
   * (`inf:cards:media`): never kept, since a player asks for what it needs.
   */
  async recordingPiece(
    fileName: string,
    offset: number,
    length: number,
  ): Promise<{ data: Uint8Array; size: number }> {
    const answer = (await this.link.invoke("inf:cards:media", [
      fileName,
      offset,
      length,
    ])) as InvokeResponse<"inf:cards:media">;
    return { data: new Uint8Array(Buffer.from(answer.data, "base64")), size: answer.size };
  }

  /**
   * Leave: tells the other Mac when it is in reach, then stops. True when
   * that Mac heard it.
   */
  async leave(): Promise<boolean> {
    if (this.disposed) return false;
    return this.link.leave();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.browsers.clear();
    this.signInReturn?.server?.close();
    this.signInReturn = null;
    this.link.close();
  }

  /** A first mate there that is known not to show its task's browsers to a view. */
  private browserWaitsThere(): boolean {
    const changes = this.link.state().homeChanges;
    return changes !== null && !listsChange(changes, BROWSER_FROM_ANY_VIEW);
  }

  private async ownLook(channel: CoreInvokeChannel, rawArgs: unknown[]): Promise<unknown> {
    // The window paints nothing until it has a look; a first one waits for
    // the other Mac's, which this Mac starts from.
    if (!this.look.seeded()) await this.seedLook();
    switch (channel) {
      case "inf:shell:preferences":
        return this.look.get();
      case "inf:settings:appearance:get":
        return this.look.get().appearance;
      case "inf:settings:layout:get":
        return this.look.get().layout;
      case "inf:settings:appearance:set": {
        const [appearance] = parseInvokeRequest("inf:settings:appearance:set", rawArgs);
        return this.look.setAppearance(appearance);
      }
      case "inf:settings:layout:set": {
        const [layout] = parseInvokeRequest("inf:settings:layout:set", rawArgs);
        return this.look.setLayout(layout);
      }
      default:
        throw new Error(`${channel} is not ${HERE.this}'s own.`);
    }
  }

  /**
   * A page the first mate would have opened, opened here as it arrives. One
   * a welcome sent again after a drop is old news and is not opened.
   */
  private openPage(payload: unknown, replayed: boolean): void {
    if (replayed || !this.options.openPage) return;
    const page = openPageSchema.safeParse(payload);
    if (!page.success) return;
    void this.options.openPage(page.data.url).catch(() => {
      // The sign-in's own steps still offer its page to open by hand.
    });
  }

  /**
   * A sign-in page whose browser comes back to the other computer's loopback
   * address (docs/view.md, "A sign-in that returns to the first mate's
   * computer"): this computer listens on the same port of its own, then
   * opens the page here. What the browser brings back goes to the other
   * computer, and its answer back to the browser. When the port is taken
   * here, Settings asks for the address the browser ended on instead.
   */
  private async openSignInPage(payload: unknown, replayed: boolean): Promise<void> {
    if (replayed || !this.options.openPage || this.disposed) return;
    const page = signInPageSchema.safeParse(payload);
    if (!page.success) return;
    this.endSignInReturn();
    const { id, port, url } = page.data;
    const waiting: { id: string; caught: boolean; server: Server | null } = {
      id,
      caught: false,
      server: null,
    };
    this.signInReturn = waiting;
    const server = createServer((request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405, { connection: "close" }).end();
        return;
      }
      void this.handBack(waiting, request.url ?? "/").then(({ status, page: answer }) => {
        response.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          connection: "close",
        });
        response.end(answer);
      });
    });
    waiting.caught = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, this.options.returnHost ?? "127.0.0.1", () => resolve(true));
    });
    if (this.signInReturn !== waiting) {
      server.close();
      return;
    }
    if (waiting.caught) waiting.server = server;
    this.changed();
    void this.options.openPage(url).catch(() => {
      // The sign-in's own steps still offer its page again.
    });
  }

  /** Hands the browser's return to the other computer, answering the page it said. */
  private async handBack(
    waiting: { id: string; caught: boolean; server: Server | null },
    address: string,
  ): Promise<{ status: number; page: string }> {
    try {
      const answer = (await this.link.invoke("inf:integrations:sign-in-return", [
        { id: waiting.id, address },
      ])) as InvokeResponse<"inf:integrations:sign-in-return">;
      // Taken once: nothing else reaches the other computer through here.
      if (answer.status === 200) {
        waiting.server?.close();
        waiting.server = null;
      }
      return answer;
    } catch (refusal) {
      // Out of reach, or no longer waiting: Settings asks for the address.
      if (this.signInReturn === waiting && waiting.caught) {
        waiting.caught = false;
        this.changed();
      }
      return { status: 502, page: returnLostPage((refusal as Error).message) };
    }
  }

  /** The sign-in there stopped waiting: this computer stops listening for it. */
  private signInEnded(payload: unknown): void {
    const ended = signInEndedSchema.safeParse(payload);
    if (!ended.success || this.signInReturn?.id !== ended.data.id) return;
    this.endSignInReturn();
  }

  private endSignInReturn(): void {
    const waiting = this.signInReturn;
    if (!waiting) return;
    this.signInReturn = null;
    waiting.server?.close();
    waiting.server?.closeAllConnections();
    this.changed();
  }

  private observeCards(payload: unknown): void {
    const cards = readKeepingUnknown(cardsSnapshotSchema, payload);
    if (cards.success) this.notifier.observe(cards.data);
  }

  /** What the other Mac shows now, so the next card it gains is news here. */
  private async seedNotifier(): Promise<void> {
    try {
      const cards = readKeepingUnknown(
        cardsSnapshotSchema,
        await this.link.invoke("inf:cards:list", []),
      );
      if (cards.success) this.notifier.seed(cards.data);
    } catch {
      // The next push seeds it instead.
    }
  }

  /**
   * One card-worthy moment, posted here when the other Mac's Notifications
   * switch is on. Unknown is off: a switch the other Mac could not be asked
   * about posts nothing.
   */
  private async notify(notification: { title: string; body: string }): Promise<void> {
    let on: unknown = false;
    try {
      on = await this.link.invoke("inf:settings:notifications:get", []);
    } catch {
      return;
    }
    if (on !== true || this.disposed || this.options.notifications.focused()) return;
    this.options.notifications.show(notification);
  }

  /**
   * This Mac's own update notice, never the other Mac's: a newer Firstmate
   * there asks this Mac to update, and this is where it finds how.
   */
  private async ownApp(channel: CoreInvokeChannel, rawArgs: unknown[]): Promise<unknown> {
    switch (channel) {
      case "inf:update:channel": {
        const [next] = parseInvokeRequest("inf:update:channel", rawArgs);
        if (!this.options.updates.setChannel)
          throw new Error("This installation does not support changing its update channel here.");
        return this.options.updates.setChannel(next);
      }
      case "inf:update:status":
        return this.options.updates.getStatus();
      case "inf:update:check":
        return this.options.updates.checkNow();
      case "inf:update:open-release":
        await this.options.updates.openReleasePage();
        return { ok: true };
      case "inf:update:install":
        return this.options.updates.install();
      case "inf:update:later":
        return this.options.updates.later?.() ?? this.options.updates.getStatus();
      default:
        throw new Error(`${channel} is not ${HERE.this}'s own.`);
    }
  }

  /** Takes the other Mac's look once, when this Mac has none of its own yet. */
  private seedLook(): Promise<void> {
    this.seeding ??= this.link
      .invoke("inf:shell:preferences", [])
      .then((value) => {
        const parsed: ShellPreferences = shellPreferencesSchema.parse(value);
        this.look.seed({ appearance: parsed.appearance, layout: parsed.layout });
      })
      .catch(() => {
        // Out of reach: the defaults stand in until it is back.
      })
      .finally(() => {
        this.seeding = null;
      });
    return this.seeding;
  }

  private followed(state: HomeLinkState): void {
    if (state.name) {
      try {
        this.joined.name(state.name);
      } catch {
        // Said again at the next welcome.
      }
    }
    if (state.removed) {
      this.options.onRemoved();
      return;
    }
    this.changed();
  }

  private changed(): void {
    if (!this.disposed) this.options.onThisMac(this.thisMac());
  }

  private keepPicture(fileName: string, bytes: Uint8Array): void {
    if (bytes.byteLength > PICTURE_CACHE_BYTES) return;
    this.pictures.set(fileName, bytes);
    this.pictureBytes += bytes.byteLength;
    for (const [name, kept] of this.pictures) {
      if (this.pictureBytes <= PICTURE_CACHE_BYTES) break;
      this.pictures.delete(name);
      this.pictureBytes -= kept.byteLength;
    }
  }
}

/**
 * The page the browser shows when its return could not reach the first
 * mate's computer: what happened, and the way through Settings.
 */
function returnLostPage(why: string): string {
  const words = `${why} If Infinitary is still waiting, copy this page's address and paste it in Settings, Integrations.`;
  const escaped = words.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>Infinitary</title><body style="font:15px system-ui;margin:3em">${escaped}</body>`;
}

/** Whether the two Firstmates are too far apart for this Mac to make changes, and which is newer. */
function readOnly(state: HomeLinkState): "newer-there" | "older-there" | null {
  if (!state.access || !state.homeVersion) return null;
  const side = sideToUpdate(state.access, PROTOCOL_VERSION, state.homeVersion);
  return side === "home" ? "older-there" : side === "this" ? "newer-there" : null;
}
