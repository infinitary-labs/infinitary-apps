import {
  DeviceOutOfReachError,
  type HomeConnection,
  type RunningDeviceVersion,
  type ViewDeviceContact,
  type WorkDeviceContact,
  type WorkDeviceVersion,
} from "../connection/connection";

/**
 * The core's way to the computers that run work for this home
 * (docs/helper.md, "Holding a conversation"): the connection's `ask` and
 * `onWorkDevice`, held in one place the core's parts read, with which Macs
 * that control this Firstmate are connected now (`onViewDevice`), which
 * Settings -> Devices says (docs/devices.md, "Settings -> Devices"). The
 * connection starts after the core, so the shell attaches it here once it
 * listens; until then every ask is refused as out of reach and no device is
 * ever in reach.
 */

/** What the core needs of the home's connection. */
export type WorkDeviceLink = Pick<HomeConnection, "ask" | "onWorkDevice" | "onViewDevice"> &
  Partial<
    Pick<
      HomeConnection,
      "settled" | "listening" | "onWorkVersion" | "onListening" | "onAppSent" | "runningVersions"
    >
  >;

export class WorkDevices {
  private link: WorkDeviceLink | null = null;
  private stopHearing: (() => void) | null = null;
  private readonly listeners = new Set<(contact: WorkDeviceContact) => void>();
  private readonly reached = new Set<string>();
  private readonly viewListeners = new Set<(contact: ViewDeviceContact) => void>();
  private readonly viewing = new Set<string>();
  private readonly versionListeners = new Set<
    (deviceId: string, version: WorkDeviceVersion | null) => void
  >();
  private readonly versions = new Map<string, WorkDeviceVersion>();
  private readonly listeningListeners = new Set<() => void>();
  private readonly sentListeners = new Set<(deviceId: string, bytes: number) => void>();

  /**
   * The connection listens now: asks go through it and its contacts are
   * heard. Returns the detach, which says every device in reach went.
   */
  attach(link: WorkDeviceLink): () => void {
    this.detach();
    this.link = link;
    const stopWork = link.onWorkDevice((contact) => this.hear(contact));
    const stopViews = link.onViewDevice((contact) => this.see(contact));
    const stopVersion = link.onWorkVersion?.((deviceId, version) => this.heard(deviceId, version));
    const stopListening = link.onListening?.(() => this.moved());
    const stopSent = link.onAppSent?.((deviceId, bytes) => {
      for (const listener of [...this.sentListeners]) listener(deviceId, bytes);
    });
    this.stopHearing = () => {
      stopWork();
      stopViews();
      stopVersion?.();
      stopListening?.();
      stopSent?.();
    };
    return () => {
      if (this.link === link) this.detach();
    };
  }

  /**
   * Asks a computer in reach one order (src/shared/work.ts); refused at once
   * when none is. With `anyVersion` - the update and download orders alone -
   * one connected that takes no work is asked too.
   */
  ask(
    deviceId: string,
    channel: string,
    args: unknown,
    options?: { anyVersion?: boolean },
  ): Promise<unknown> {
    if (!this.link) return Promise.reject(new DeviceOutOfReachError());
    return options
      ? this.link.ask(deviceId, channel, args, options)
      : this.link.ask(deviceId, channel, args);
  }

  /** Hears each computer come into reach and go, across attaches; answers its own unsubscribe. */
  onWorkDevice(listener: (contact: WorkDeviceContact) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Resolves once the connection listens for what pairing holds now, so a
   * Mac the home hands a link to finds it listening; at once while none is
   * attached.
   */
  async settled(): Promise<void> {
    await this.link?.settled?.();
  }

  /**
   * Where the connection listens now, as `host:port`; none while none is
   * attached or it listens nowhere.
   */
  listening(): string[] {
    return this.link?.listening?.() ?? [];
  }

  /**
   * Hears each time where the connection listens changes, across attaches -
   * this Mac's address moved, say; answers its own unsubscribe.
   */
  onListening(listener: () => void): () => void {
    this.listeningListeners.add(listener);
    return () => {
      this.listeningListeners.delete(listener);
    };
  }

  /** Live versions of every connected device, not just computers taking work. */
  runningVersions(): RunningDeviceVersion[] {
    return this.link?.runningVersions?.() ?? [];
  }

  /** The computer is welcomed and takes work now. */
  inReach(deviceId: string): boolean {
    return this.reached.has(deviceId);
  }

  /** Hears each Mac that controls this Firstmate connect and go, across attaches; answers its own unsubscribe. */
  onViewDevice(listener: (contact: ViewDeviceContact) => void): () => void {
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  /** The Mac that controls this Firstmate is connected now: Firstmate is open on it. */
  controlling(deviceId: string): boolean {
    return this.viewing.has(deviceId);
  }

  /**
   * What a connected computer said of its version, whether or not it takes
   * work; undefined while none of its connections is up.
   */
  version(deviceId: string): WorkDeviceVersion | undefined {
    return this.versions.get(deviceId);
  }

  /**
   * Hears each piece of Firstmate this home sends a computer on its list, by
   * that computer's id and the piece's bytes, across attaches; answers its
   * own unsubscribe.
   */
  onAppSent(listener: (deviceId: string, bytes: number) => void): () => void {
    this.sentListeners.add(listener);
    return () => {
      this.sentListeners.delete(listener);
    };
  }

  /** Hears each computer's version at each welcome, and null once it went; answers its own unsubscribe. */
  onVersion(listener: (deviceId: string, version: WorkDeviceVersion | null) => void): () => void {
    this.versionListeners.add(listener);
    return () => {
      this.versionListeners.delete(listener);
    };
  }

  private detach(): void {
    const listened = this.listening().length > 0;
    this.stopHearing?.();
    this.stopHearing = null;
    this.link = null;
    for (const deviceId of [...this.reached]) this.hear({ deviceId, contact: "gone" });
    for (const deviceId of [...this.viewing]) this.see({ deviceId, contact: "gone" });
    for (const deviceId of [...this.versions.keys()]) this.heard(deviceId, null);
    if (listened) this.moved();
  }

  private moved(): void {
    for (const listener of [...this.listeningListeners]) {
      try {
        listener();
      } catch (caught) {
        console.warn("[placed] a listening listener failed:", caught);
      }
    }
  }

  private heard(deviceId: string, version: WorkDeviceVersion | null): void {
    if (version) this.versions.set(deviceId, version);
    else this.versions.delete(deviceId);
    for (const listener of [...this.versionListeners]) {
      try {
        listener(deviceId, version);
      } catch (caught) {
        console.warn("[placed] a work version listener failed:", caught);
      }
    }
  }

  private hear(contact: WorkDeviceContact): void {
    if (contact.contact === "in-reach") this.reached.add(contact.deviceId);
    else this.reached.delete(contact.deviceId);
    for (const listener of [...this.listeners]) {
      try {
        listener(contact);
      } catch (caught) {
        console.warn("[placed] a work device listener failed:", caught);
      }
    }
  }

  private see(contact: ViewDeviceContact): void {
    if (contact.contact === "in-reach") this.viewing.add(contact.deviceId);
    else this.viewing.delete(contact.deviceId);
    for (const listener of [...this.viewListeners]) {
      try {
        listener(contact);
      } catch (caught) {
        console.warn("[placed] a view device listener failed:", caught);
      }
    }
  }
}
