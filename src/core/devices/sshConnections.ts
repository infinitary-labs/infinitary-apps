import { HERE } from "@shared/deviceNames";
import type { DeviceSsh, DeviceView, SshStopReason } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import type { RemoteLoginRefusal } from "@shared/remoteLogin";
import {
  controllerSaysSchema,
  readSshMessage,
  SSH_MESSAGE_VERSION,
  type SshAgentState,
  sshConnectionWords,
  sshMessageLine,
} from "@shared/sshConnection";
import type { BuildFlavor } from "@shared/userDataFolders";
import type { WorkDeviceContact } from "../connection/connection";
import { CONNECT, farFolderArgs } from "./farSystems";
import { readHostKey } from "./hostKey";
import { sameHostKey } from "./hostTrust";
import type { DevicePairing, SshCleanup } from "./pairing";
import { SSH_FAILED, SshMaster, type SshProgram } from "./ssh";
import { sshRefusal } from "./sshRefusal";

/**
 * This Mac's own SSH connection to each computer it added by its address
 * (docs/devices.md, "Through the home's SSH"; FI3-970): the home keeps one
 * per computer while it runs, and the computer's work reaches this Mac only
 * through it.
 *
 * Each connection is the captain's own SSH, as the master of a control
 * socket only this user can reach (`SshMaster`), whose own session runs the
 * controller there (`work connect --from-home`, docs/helper.md "Through the
 * home's SSH"). The controller makes a private socket there and says where;
 * this Mac forwards it to its own loopback listener over the control socket;
 * the controller checks this Mac answers through it and publishes the route
 * the work there dials; a beat every 15 seconds renews it. The connection is
 * `connected` only once that work's welcome arrives, never on SSH's word.
 *
 * It starts only when the shell attaches the paired connection, and stops
 * when the shell takes it back. One manager supervises each computer, and
 * every operation over SSH on one - setting it up, updating it, changing
 * its address - holds its connection while it runs (`hold`).
 *
 * A connection that drops or cannot be made is tried again after 1, 2, 4,
 * 8, 15, then every 30 seconds, each a little early or late so computers do
 * not try at once, and from the start again once one stayed up. What only
 * a person can mend - a Mac this Mac never reached, one that answers unlike
 * before, a key refused, Remote Login that will not carry the connection,
 * Firstmate gone there or another Firstmate's - stops it until Try again.
 * A key that is locked, or whose app did not answer, did not approve it or
 * is not open, stops it too, but is tried again quietly when this Mac wakes
 * and every five minutes, since the person mends it by unlocking, approving
 * or opening that app, never in Devices: Devices keeps saying it stopped
 * while it is tried, and the feed says it once (`QUIET_RETRY_STOPS`). While
 * this Mac sleeps nothing is tried, and waking tries each computer out of
 * reach once at once.
 *
 * A computer taken off the list keeps its connection until it heard it was
 * removed or a moment passed, then what Firstmate set up there is removed
 * over SSH, checked to be this home's and that computer's first, and tried
 * again for thirty days while it cannot be (`DevicePairing.sshCleanups`).
 */

/** A change in a connection the feed says once (`sshConnectionWords`). */
export type DeviceConnectionEvent = Extract<FmEvent, { type: "device_connection" }>;

/** How a removal over SSH went: removed, or nothing of this home's was there; or not yet. */
export type CleanUpThere = "done" | "failed";

export type SshConnectionsOptions = {
  pairing: Pick<
    DevicePairing,
    | "sshConnections"
    | "sshCleanups"
    | "cleanedUp"
    | "subscribe"
    | "identity"
    | "list"
    | "rememberedHost"
    | "sshOptions"
    | "noteSystem"
  >;
  ssh: SshProgram;
  /** This app's flavor, which names the data folder its copy keeps there. */
  flavor: BuildFlavor;
  /** Where the paired connection listens now, as `host:port`; the forward goes to its loopback. */
  listening: () => readonly string[];
  /** Resolves once the connection listens for what pairing holds now. */
  settled: () => Promise<void>;
  /**
   * Whether a computer's work is connected now: welcomed through the
   * connection, whether or not its version takes new work.
   */
  welcomed: (deviceId: string) => boolean;
  /** Hears each computer come into reach and go. */
  onWorkDevice: (listener: (contact: WorkDeviceContact) => void) => () => void;
  /**
   * Removes what Firstmate set up on a computer this Mac removed, over SSH
   * (`RemoteLogin.cleanUpThere`): `done` once nothing of this home's is left
   * there, `failed` to try again later.
   */
  cleanUpThere: (cleanup: SshCleanup) => Promise<CleanUpThere>;
  /** One feed line for a change the captain should hear of once. */
  emit: (event: DeviceConnectionEvent) => void;
  /** A connection's state changed: Devices reads it again. */
  changed: () => void;
  /** Where control sockets' folders and the far end's are made; `/tmp` unless a test stands in its own. */
  controlBase?: string;
  now?: () => number;
  /** Jitter's source, 0 to 1. */
  random?: () => number;
  retryMs?: readonly number[];
  beatMs?: number;
  /** The wait between quiet tries of a connection stopped for a reason in `QUIET_RETRY_STOPS`. */
  quietRetryMs?: number;
  /** How long a connection must stay up before tries start over from the first wait. */
  stableMs?: number;
  /** How long a connection may read connecting before it reads reconnecting. */
  connectingMs?: number;
  /** Waits between tries to remove what Firstmate set up on a removed computer; the last repeats. */
  cleanupRetryMs?: readonly number[];
  /** How long a removed computer's connection is kept for it to hear it was removed. */
  revocationWaitMs?: number;
};

const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const QUIET_RETRY_MS = 5 * 60_000;
const BEAT_MS = 15_000;
const STABLE_MS = 60_000;
/**
 * How long a connection may read "connecting" - being made for the first
 * time, after an operation held it, or after its work's folder moved - before
 * it reads "reconnecting", an active retry in Devices. A few
 * minutes covers an update restarting a Mac and a move of its folder; past
 * that a person should see that the computer is not coming up. Not the move
 * lock's own limit, `MOVE_LOCK_TRUST_MS`, which bounds the probe's wait.
 */
export const CONNECTING_MS = 5 * 60_000;
const CLEANUP_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const REVOCATION_WAIT_MS = 15_000;
/** How long a removed computer's cleanup is tried, as the connection listens for one removed out of reach. */
export const CLEANUP_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Why a connection stops that the person mends outside Firstmate, by
 * unlocking the key or its app, approving it there, or opening that app:
 * it is tried again quietly when this Mac wakes and every few minutes,
 * besides Try again, and the feed says it once.
 */
export const QUIET_RETRY_STOPS: ReadonlySet<SshStopReason> = new Set<SshStopReason>([
  "key-locked",
  "agent-declined",
  "agent-not-running",
]);

/** Where one computer's connection stands, as this manager keeps it. */
type Phase =
  /** Waiting to try (again), or about to. */
  | "waiting"
  /** An attempt is under way: SSH, the forward, the check there. */
  | "connecting"
  /** Its route is published there; the work there may still be on its way. */
  | "up"
  /** Stopped until Try again. */
  | "stopped"
  /** An operation over SSH holds it. */
  | "held"
  /** Off the list, or the manager stopped. */
  | "closed";

class DeviceLine {
  phase: Phase = "waiting";
  reason: SshStopReason | undefined;
  agent: SshAgentState = "unknown";
  failures = 0;
  /** It was up since this Mac started: a drop is reconnecting, not connecting. */
  wasUp = false;
  /**
   * Made again by design, after any operation held it or its work's folder
   * moved: until an attempt fails it is connecting, not reconnecting.
   */
  fresh = false;
  /** When it began reading connecting, for `CONNECTING_MS`, read when state is read. */
  connectingSince = 0;
  upAt: number | null = null;
  master: SshMaster | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  beat: ReturnType<typeof setInterval> | null = null;
  /** The feed said it stopped; it says once when it is back. */
  toldStopped = false;
  /** Why the feed last said it stopped, until it is back or Try again: said once. */
  toldReason: SshStopReason | undefined;
  /** A quiet try of a stopped connection is under way: Devices still says it stopped. */
  quiet = false;
  /** The feed said its work could not start; once a connection. */
  toldNotStarted = false;
  /** A setup holds it until it is done. */
  heldBySetup = false;
  /** Attempts begun: one that waited goes on only while it is the latest and the line still waits on it. */
  tries = 0;

  constructor(
    readonly deviceId: string,
    public address: string,
  ) {}
}

export class SshConnections {
  private running = false;
  private paused = false;
  private readonly lines = new Map<string, DeviceLine>();
  private readonly holds = new Map<string, Promise<void>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<
    string,
    { tries: number; timer: ReturnType<typeof setTimeout> | null; busy: boolean }
  >();
  private setups = 0;
  private stopHearing: (() => void) | null = null;
  /** The states last compared by `due`, so a passing limit pushes once. */
  private dueStates = "";

  constructor(private readonly options: SshConnectionsOptions) {}

  /**
   * Starts keeping a connection to every computer pairing reaches over SSH,
   * and removing what this Mac set up on those it removed. Answers the stop,
   * which ends every connection within its bound and resolves once each is
   * gone. The shell calls it once it attached the paired connection.
   */
  start(): () => Promise<void> {
    if (this.running) return () => this.stop();
    this.running = true;
    const stopPairing = this.options.pairing.subscribe(() => this.reconcile());
    const stopReach = this.options.onWorkDevice((contact) => this.heard(contact));
    this.stopHearing = () => {
      stopPairing();
      stopReach();
    };
    this.reconcile();
    return () => this.stop();
  }

  /**
   * Whether a read of every line's state differs from the last time this
   * was asked. The connecting limit is that read, so the host clock asks
   * this and pushes only when a line has flipped.
   */
  due(): boolean {
    const next = [...this.lines.keys()]
      .map((id) => `${id}:${this.state(id)?.state ?? ""}`)
      .join(",");
    if (next === this.dueStates) return false;
    this.dueStates = next;
    return true;
  }

  /**
   * Where the connection to a computer stands, for Devices: undefined for
   * one this Mac does not reach over SSH, and while the manager is not
   * running.
   */
  state(deviceId: string): DeviceSsh | undefined {
    const state = this.connectionState(deviceId);
    const line = this.lines.get(deviceId);
    const reported = this.options.pairing
      .list()
      .find((device) => device.id === deviceId)?.automaticStartup;
    const startup = line?.phase === "up" && line.agent === "unavailable" ? "unavailable" : reported;
    // Ordinary work progress (including agent unknown) is not a startup failure.
    // Supported outcomes already have the existing connection state and row words.
    return state && (startup === "unavailable" || startup === "unknown")
      ? { ...state, automaticStartup: startup }
      : state;
  }

  private connectionState(deviceId: string): DeviceSsh | undefined {
    const line = this.lines.get(deviceId);
    if (!line || !this.running) return undefined;
    if (this.options.welcomed(deviceId)) return { state: "connected" };
    if (line.quiet && (line.phase === "waiting" || line.phase === "connecting"))
      return { state: "stopped", ...(line.reason ? { reason: line.reason } : {}) };
    switch (line.phase) {
      case "stopped":
        return { state: "stopped", ...(line.reason ? { reason: line.reason } : {}) };
      case "up":
        if (line.agent === "at-login") return { state: "at-login" };
        if (line.agent === "failed" || line.agent === "unavailable")
          return { state: "not-started" };
        return { state: this.timedOut(line) ? "reconnecting" : "connecting" };
      case "waiting":
      case "connecting":
        return {
          state:
            this.timedOut(line) || (!line.fresh && (line.wasUp || line.failures > 0))
              ? "reconnecting"
              : "connecting",
        };
      case "held":
      case "closed":
        return undefined;
    }
  }

  /**
   * Try again: each named computer's connection - every stopped one when
   * none is named - is tried once now, from the first wait. Answers how
   * many it tried.
   */
  tryAgain(deviceId?: string): number {
    let tried = 0;
    for (const line of this.lines.values()) {
      if (deviceId ? line.deviceId !== deviceId : line.phase !== "stopped") continue;
      if (line.phase === "held" || line.phase === "closed") continue;
      if (line.phase === "connecting" || line.phase === "up") continue;
      // A Mac that left for another Firstmate is not coming back.
      if (line.reason === "other-home") continue;
      line.failures = 0;
      line.reason = undefined;
      line.toldReason = undefined;
      line.quiet = false;
      this.startConnecting(line, false, true);
      line.phase = "waiting";
      tried += 1;
      this.attempt(line);
    }
    if (deviceId && tried === 0 && !this.lines.has(deviceId))
      throw new Error(`${HERE.This} does not reach that computer over SSH.`);
    return tried;
  }

  /**
   * Runs one operation over SSH on a computer - an update, a change of
   * address, finding it again - with its connection held: ended first,
   * nothing tried while it runs, and tried again from the start after.
   * One at a time per computer.
   */
  async hold<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const before = this.holds.get(deviceId) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = before.then(() => mine);
    this.holds.set(deviceId, chained);
    await before;
    const line = this.lines.get(deviceId);
    try {
      if (line && line.phase !== "closed") {
        this.clearTimer(line);
        line.phase = "held";
        line.quiet = false;
        this.options.changed();
        await line.master?.stop();
      }
      return await operation();
    } finally {
      // The line it held, or one the operation made - a computer found again
      // that reaches this Mac over its SSH from now on.
      const after = this.lines.get(deviceId);
      if (after && after.phase === "held" && !after.heldBySetup) {
        after.phase = "waiting";
        after.failures = 0;
        after.reason = undefined;
        this.startConnecting(after, true, true);
        this.attempt(after);
      }
      release();
      if (this.holds.get(deviceId) === chained) this.holds.delete(deviceId);
    }
  }

  /**
   * Runs a setup over SSH (`RemoteLogin.add`): a computer that joins while
   * it runs is not tried until it is done, so the controller there never
   * finds a folder the join has yet to write.
   */
  async settingUp<T>(operation: () => Promise<T>): Promise<T> {
    this.setups += 1;
    try {
      return await operation();
    } finally {
      this.setups -= 1;
      if (this.setups === 0)
        for (const line of this.lines.values()) {
          if (!line.heldBySetup) continue;
          line.heldBySetup = false;
          if (line.phase === "held") {
            line.phase = "waiting";
            this.attempt(line);
          }
        }
    }
  }

  /** This Mac goes to sleep: nothing is tried until it wakes. */
  suspend(): void {
    this.paused = true;
    for (const line of this.lines.values()) this.clearTimer(line);
    for (const cleanup of this.cleanups.values()) {
      if (cleanup.timer) clearTimeout(cleanup.timer);
      cleanup.timer = null;
    }
  }

  /**
   * This Mac woke, or its network changed: each computer out of reach is
   * tried once at once, from the first wait, a connection that may have
   * died in the sleep with it; each stopped for a key that may be unlocked
   * now, quietly; and each removal waiting to be finished there.
   */
  resume(): void {
    this.paused = false;
    if (!this.running) return;
    for (const line of this.lines.values()) {
      if (this.options.welcomed(line.deviceId)) continue;
      if (line.phase === "stopped" && line.reason && QUIET_RETRY_STOPS.has(line.reason)) {
        this.quietly(line);
        continue;
      }
      if (line.phase !== "waiting" && line.phase !== "connecting" && line.phase !== "up") continue;
      line.failures = 0;
      void this.restart(line);
    }
    for (const cleanup of this.options.pairing.sshCleanups()) this.cleanUp(cleanup, true);
  }

  // ---- inside -------------------------------------------------------------------

  private async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopHearing?.();
    this.stopHearing = null;
    for (const cleanup of this.cleanups.values()) if (cleanup.timer) clearTimeout(cleanup.timer);
    this.cleanups.clear();
    const lines = [...this.lines.values()];
    this.lines.clear();
    await Promise.all(lines.map((line) => this.close(line)));
    await Promise.all(this.retiring.values());
  }

  /** What pairing holds now: a line for each computer reached over SSH, a cleanup for each removed. */
  private reconcile(): void {
    if (!this.running) return;
    const wanted = new Map(
      this.options.pairing.sshConnections().map((entry) => [entry.deviceId, entry.address]),
    );
    for (const [deviceId, address] of wanted) {
      const line = this.lines.get(deviceId);
      if (!line) {
        const made = new DeviceLine(deviceId, address);
        this.startConnecting(made, false);
        this.lines.set(deviceId, made);
        if (this.setups > 0) {
          made.phase = "held";
          made.heldBySetup = true;
        } else if (this.holds.has(deviceId)) made.phase = "held";
        else this.attempt(made);
        continue;
      }
      // Its address changed: the next attempt reaches it there.
      if (line.address !== address) line.address = address;
    }
    for (const [deviceId, line] of this.lines) {
      if (wanted.has(deviceId)) continue;
      this.lines.delete(deviceId);
      this.retire(line);
    }
    for (const cleanup of this.options.pairing.sshCleanups()) this.cleanUp(cleanup, false);
    this.options.changed();
  }

  /**
   * A computer taken off the list: its connection stays until it heard it
   * was removed - its work let its connection go - or a moment passed, so
   * the word reaches it; then it ends.
   */
  private retire(line: DeviceLine): void {
    const done = (async () => {
      this.clearTimer(line);
      if (line.master && this.options.welcomed(line.deviceId)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, this.options.revocationWaitMs ?? REVOCATION_WAIT_MS);
          const stop = this.options.onWorkDevice((contact) => {
            if (contact.deviceId === line.deviceId && contact.contact === "gone") finish();
          });
          function finish() {
            clearTimeout(timer);
            stop();
            resolve();
          }
        });
      }
      await this.close(line);
    })();
    this.retiring.set(line.deviceId, done);
    void done.finally(() => {
      if (this.retiring.get(line.deviceId) === done) this.retiring.delete(line.deviceId);
    });
  }

  /** Ends a line's connection within its bound, with nothing tried after. */
  private async close(line: DeviceLine): Promise<void> {
    line.phase = "closed";
    this.clearTimer(line);
    await line.master?.stop();
  }

  /** Ends a line's connection now and tries it again at once. */
  private async restart(line: DeviceLine): Promise<void> {
    this.clearTimer(line);
    const master = line.master;
    line.phase = "waiting";
    if (master) await master.stop();
    // At once, not after the first wait.
    this.attempt(line);
  }

  private clearTimer(line: DeviceLine): void {
    if (line.timer) clearTimeout(line.timer);
    line.timer = null;
    if (line.beat) clearInterval(line.beat);
    line.beat = null;
  }

  /** One attempt: SSH, the controller's socket forwarded here, its route published there. */
  private async attempt(line: DeviceLine): Promise<void> {
    if (!this.running || this.paused || line.phase !== "waiting" || line.master) return;
    this.clearTimer(line);
    const port = loopbackPort(this.options.listening());
    if (port === null) {
      // Nothing listens here yet: nothing could answer through the forward.
      this.retryLater(line);
      return;
    }
    line.phase = "connecting";
    const turn = ++line.tries;
    this.options.changed();
    let stopFor: SshStopReason | null = null;
    let routed = false;
    let movedAway = false;
    let master: SshMaster;
    // What this attempt's controller says counts only while the line is still
    // its own: once an operation holds the line, or it closed, a late word -
    // a route that arrives as the hold ends it - changes nothing.
    const ours = () =>
      line.master === master && (line.phase === "connecting" || line.phase === "up");
    const said = async (text: string) => {
      const message = readSshMessage(controllerSaysSchema, text);
      if (!message || !ours()) return;
      switch (message.firstmate) {
        case "socket": {
          await this.options.settled();
          if (!ours()) return;
          if (await master.forward(message.socket, port)) {
            master.write(sshMessageLine({ firstmate: "forwarded", v: SSH_MESSAGE_VERSION }));
            return;
          }
          // Still connected, SSH there would not carry it: only a person mends that.
          if (master.alive()) {
            stopFor = "forwarding-refused";
            void master.stop();
          }
          return;
        }
        case "route":
          if (line.phase !== "connecting") return;
          routed = true;
          line.phase = "up";
          line.quiet = false;
          line.reason = undefined;
          line.wasUp = true;
          line.upAt = this.now();
          this.agent(line, message.agent);
          line.beat = setInterval(
            () => master.write(sshMessageLine({ firstmate: "beat", v: SSH_MESSAGE_VERSION })),
            this.options.beatMs ?? BEAT_MS,
          );
          line.beat.unref?.();
          this.options.changed();
          return;
        case "agent":
          this.agent(line, message.agent);
          this.options.changed();
          return;
        case "refused":
          movedAway = message.reason === "moved";
          stopFor = stopForRefusal(message.reason);
          return;
      }
    };
    const remembered = this.options.pairing.rememberedHost(line.address);
    if (remembered) {
      const live = await readHostKey(this.options.ssh, line.address);
      // An operation held it, or it closed, while the check line was read: nothing is made.
      if (!this.running || line.tries !== turn || line.phase !== "connecting") return;
      if ("refusal" in live) {
        // Could not read the check line: nothing was signed in to. Try later.
        line.fresh = false;
        line.phase = "waiting";
        this.retryLater(line);
        return;
      }
      if (!sameHostKey(remembered, live)) {
        this.stopped(line, "host-changed");
        return;
      }
    }
    // The remembered check, and Firstmate's own key where it is let in.
    const trusted = this.options.pairing.sshOptions(line.address);
    try {
      master = new SshMaster({
        ssh: this.options.ssh,
        address: line.address,
        ...(trusted ? { options: trusted } : {}),
        command: [
          "/bin/sh",
          "-c",
          CONNECT,
          "firstmate",
          ...farFolderArgs(this.options.flavor),
          this.options.pairing.identity().pin,
          line.deviceId,
        ],
        onLine: (text) => void said(text),
        ...(this.options.controlBase ? { controlBase: this.options.controlBase } : {}),
      });
    } catch {
      line.fresh = false;
      line.phase = "waiting";
      this.retryLater(line);
      return;
    }
    line.master = master;
    void master.exited.then((ended) => {
      if (line.master === master) line.master = null;
      if (line.beat) clearInterval(line.beat);
      line.beat = null;
      if (line.phase === "closed" || line.phase === "held") return;
      if (ended.code === SSH_FAILED && !routed && !stopFor)
        stopFor = stopForSsh(sshRefusal(ended.stderr));
      if (stopFor) {
        this.stopped(line, stopFor);
        return;
      }
      // Up long enough to call stable: the waits start over.
      if (line.upAt !== null && this.now() - line.upAt >= (this.options.stableMs ?? STABLE_MS))
        line.failures = 0;
      line.upAt = null;
      // Its work's folder moved: made again by design, so connecting, not a drop.
      // Its tries keep backing off: a far end that keeps ending this way is not coming up.
      if (movedAway) this.startConnecting(line, true);
      else line.fresh = false;
      line.agent = "unknown";
      line.toldNotStarted = false;
      // Past what stopped it: dropped like any other, so tried again as one.
      line.quiet = false;
      line.reason = undefined;
      line.phase = "waiting";
      this.options.changed();
      this.retryLater(line);
    });
  }

  /** Waits, then tries again: 1, 2, 4, 8, 15, then every 30 seconds, each a little early or late. */
  private retryLater(line: DeviceLine): void {
    if (!this.running || this.paused || line.phase !== "waiting") return;
    const waits = this.options.retryMs ?? RETRY_MS;
    const wait = waits[Math.min(line.failures, waits.length - 1)] ?? 30_000;
    line.failures += 1;
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
    line.timer = setTimeout(
      () => {
        line.timer = null;
        this.attempt(line);
      },
      Math.round(wait * jitter),
    );
    line.timer.unref?.();
  }

  /**
   * Stopped until Try again, or tried quietly again later for a key that is
   * locked, or whose app did not answer, did not approve it or is not open:
   * said once in the feed.
   */
  private stopped(line: DeviceLine, reason: SshStopReason): void {
    line.phase = "stopped";
    line.fresh = false;
    line.reason = reason;
    line.quiet = false;
    line.upAt = null;
    this.options.changed();
    if (QUIET_RETRY_STOPS.has(reason)) this.quietLater(line);
    if (line.toldReason === reason) return;
    line.toldReason = reason;
    const device = this.device(line.deviceId);
    if (!device) return;
    line.toldStopped = true;
    for (const text of sshConnectionWords.stopped(reason, { address: line.address, device }))
      this.say(line, device, "stopped", text, "warn");
  }

  /** A quiet try, after the wait, of a connection stopped for a key that may be unlocked by then. */
  private quietLater(line: DeviceLine): void {
    if (!this.running || this.paused) return;
    this.clearTimer(line);
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
    line.timer = setTimeout(
      () => {
        line.timer = null;
        this.quietly(line);
      },
      Math.round((this.options.quietRetryMs ?? QUIET_RETRY_MS) * jitter),
    );
    line.timer.unref?.();
  }

  /** Tries a stopped connection once, with Devices still saying it stopped and the feed saying nothing new. */
  private quietly(line: DeviceLine): void {
    if (!this.running || this.paused || line.phase !== "stopped") return;
    this.clearTimer(line);
    line.failures = 0;
    line.quiet = true;
    line.phase = "waiting";
    this.attempt(line);
  }

  /** What the controller said of the work there; that it cannot start is said once a connection. */
  private agent(line: DeviceLine, agent: SshAgentState): void {
    line.agent = agent;
    const reported = this.device(line.deviceId)?.automaticStartup;
    const startup =
      agent === "unavailable"
        ? agent
        : agent !== "unknown" && reported !== undefined
          ? agent === "running"
            ? "available"
            : agent
          : undefined;
    if (startup) this.options.pairing.noteSystem(line.deviceId, { automaticStartup: startup });
    if (agent !== "failed" || line.toldNotStarted) return;
    line.toldNotStarted = true;
    const device = this.device(line.deviceId);
    if (!device) return;
    for (const text of sshConnectionWords.notStarted(device))
      this.say(line, device, "not-started", text, "warn");
  }

  /** A computer came into reach or went: back after it was stopped is said once. */
  private heard(contact: WorkDeviceContact): void {
    const line = this.lines.get(contact.deviceId);
    if (!line) return;
    // Welcomed, the episode of connecting by design is over; the next one starts its own clock.
    if (contact.contact === "in-reach") line.fresh = false;
    // Its work stopped answering while SSH stays up, such as a run restarting:
    // the few minutes before it reads out of reach count from now.
    else if (line.phase === "up") this.startConnecting(line, false, true);
    if (contact.contact === "in-reach" && line.toldStopped) {
      line.toldStopped = false;
      line.toldReason = undefined;
      const device = this.device(line.deviceId);
      if (device) this.say(line, device, "connected", sshConnectionWords.back(device), "info");
    }
    this.options.changed();
  }

  /**
   * Removes what Firstmate set up on a computer this Mac removed: once its
   * connection let go, then again after each wait while it cannot, for
   * thirty days, after which the feed says it stays there.
   */
  private cleanUp(cleanup: SshCleanup, now: boolean): void {
    if (!this.running) return;
    const kept = this.cleanups.get(cleanup.deviceId);
    if (kept?.busy || (kept?.timer && !now)) return;
    if (kept?.timer) clearTimeout(kept.timer);
    const entry = kept ?? { tries: 0, timer: null, busy: false };
    entry.timer = null;
    this.cleanups.set(cleanup.deviceId, entry);
    if (this.paused) return;
    entry.busy = true;
    void (async () => {
      await this.retiring.get(cleanup.deviceId);
      if (!this.running) return;
      const outcome = await this.options.cleanUpThere(cleanup).catch((): CleanUpThere => "failed");
      entry.busy = false;
      if (!this.running) return;
      if (outcome === "done") {
        this.cleanups.delete(cleanup.deviceId);
        this.options.pairing.cleanedUp(cleanup.deviceId);
        return;
      }
      if (this.now() - cleanup.at >= CLEANUP_HORIZON_MS) {
        this.cleanups.delete(cleanup.deviceId);
        this.options.pairing.cleanedUp(cleanup.deviceId);
        const [what, todo] = sshConnectionWords.gaveUp(cleanup);
        for (const text of [what, todo])
          this.options.emit({
            type: "device_connection",
            deviceId: cleanup.deviceId,
            name: cleanup.name,
            state: "gave-up",
            text,
            tone: "warn",
          });
        return;
      }
      const waits = this.options.cleanupRetryMs ?? CLEANUP_RETRY_MS;
      const wait = waits[Math.min(entry.tries, waits.length - 1)] ?? 30 * 60_000;
      entry.tries += 1;
      if (this.paused) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const still = this.options.pairing
          .sshCleanups()
          .find((each) => each.deviceId === cleanup.deviceId);
        if (still) this.cleanUp(still, true);
      }, wait);
      entry.timer.unref?.();
    })();
  }

  private say(
    line: DeviceLine,
    device: DeviceView,
    state: DeviceConnectionEvent["state"],
    text: string,
    tone: "info" | "warn",
  ): void {
    this.options.emit({
      type: "device_connection",
      deviceId: line.deviceId,
      name: device.name,
      state,
      text,
      tone,
    });
  }

  private device(deviceId: string): DeviceView | undefined {
    return this.options.pairing.list().find((entry) => entry.id === deviceId);
  }

  /** It has read connecting for longer than `CONNECTING_MS`. */
  private timedOut(line: DeviceLine): boolean {
    return this.now() - line.connectingSince >= (this.options.connectingMs ?? CONNECTING_MS);
  }

  /**
   * It begins reading connecting now - made for the first time, tried again
   * by design, or its work's folder moved - unless it has been reading it
   * already (unless `restart`, a new operation), so a far end that keeps
   * ending that way times out as one. The limit is read when `state` is
   * read (`timedOut`); the host clock re-reads the list, so no timer flips it.
   */
  private startConnecting(line: DeviceLine, fresh: boolean, restart = false): void {
    if (line.fresh && fresh && !restart) return;
    line.fresh = fresh;
    line.connectingSince = this.now();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** The loopback port the paired connection listens at now, or null while it listens nowhere. */
function loopbackPort(listening: readonly string[]): number | null {
  for (const at of listening) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(at);
    if (match) return Number(match[1]);
  }
  return null;
}

/** What only a person mends, from SSH's own refusal; the rest is tried again. */
function stopForSsh(refusal: RemoteLoginRefusal): SshStopReason | null {
  switch (refusal) {
    case "host-unknown":
    case "host-changed":
    case "key-refused":
    case "key-locked":
    case "agent-declined":
    case "agent-not-running":
      return refusal;
    default:
      return null;
  }
}

/** What only a person mends, from the controller's refusal; the rest is tried again. */
function stopForRefusal(reason: string): SshStopReason | null {
  switch (reason) {
    case "not-joined":
      return "not-set-up";
    case "other-home":
    case "not-ssh":
      return "other-home";
    default:
      return null;
  }
}
