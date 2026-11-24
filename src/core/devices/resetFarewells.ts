import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { readWorkOutcome } from "@shared/remoteLogin";
import type { BuildFlavor } from "@shared/userDataFolders";
import type { PairedDevice, PairedDevices } from "../connection/connection";
import {
  RESET_REMOVAL_MS,
  type ResetRemoval,
  type ResetRemovalComputer,
  readResetRemovals,
  writeResetRemovals,
} from "../reset/removals";
import { farFolderArgs, REMOVE } from "./farSystems";
import { hostTrustSshOptions, knownHostsLine } from "./hostTrust";
import { peerPin } from "./identity";
import { runSsh, SSH_OPTIONS, type SshProgram } from "./ssh";

/** What a computer out of reach at a reset came to: it heard it was removed, or 30 days passed. */
export type ResetFarewellOutcome = "removed" | "stayed";

/** Refusals in a row a computer reads as removed (`REFUSALS_TO_REMOVED`, src/core/devices/homeLink.ts). */
export const RESET_TELLS = 2;

/**
 * How long a computer refused twice in a row must stay quiet to count as
 * removed: one that read it dials no more, and one that did not dials again
 * within seconds (`DEFAULT_RETRY_MS`, src/core/devices/homeLink.ts).
 */
export const RESET_QUIET_MS = 30_000;

/** Waits between tries over Remote Login, as `SshConnections` waits for its own removals; the last repeats. */
export const RESET_SSH_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

/** How often the fresh first mate looks whether a reset's 30 days are up. */
const HORIZON_LOOK_MS = 60 * 60_000;

/** What the removal over Remote Login there came to: `done` once nothing of the old first mate's is left there. */
export type ResetRemoveThere = (
  reset: Pick<ResetRemoval, "home">,
  computer: ResetRemovalComputer & { ssh: NonNullable<ResetRemovalComputer["ssh"]> },
) => Promise<"done" | "failed">;

export type ResetFarewellsOptions = {
  /** The data folder the record sits beside. */
  dataDir: string;
  /** Says one computer's outcome once on the feed. */
  said: (computer: { id: string; name: string }, outcome: ResetFarewellOutcome) => void;
  /** Removes what the old first mate set up on a computer reached over Remote Login. */
  removeThere?: ResetRemoveThere;
  now?: () => number;
  retryMs?: readonly number[];
  quietMs?: number;
};

/**
 * The fresh first mate's side of a reset's computers out of reach
 * (docs/reset.md, "Computers out of reach"). It never treats one as paired:
 * its dial is answered with the old first mate's key only so it can hear it
 * was removed, and one reached over Remote Login has the removal asked there,
 * on the waits Remote Login's own removals use. Each is dropped from the
 * record once it heard it, and the record with its keys once none is left or
 * its 30 days are up.
 */
export class ResetFarewells {
  private resets: ResetRemoval[];
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  /** The old key each address showed a waiting computer's dial, by the old key's pin. */
  private readonly learned = new Map<string, string>();
  private readonly tries = new Map<
    string,
    { count: number; timer: NodeJS.Timeout | null; busy: boolean }
  >();
  /** The address each computer's latest refusal came from, by its id. */
  private readonly refusedFrom = new Map<string, string>();
  /** The look, after a computer's latest refusal, whether it stayed quiet since. */
  private readonly quiet = new Map<string, NodeJS.Timeout>();
  private horizon: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: ResetFarewellsOptions) {
    this.now = options.now ?? Date.now;
    this.resets = readResetRemovals(options.dataDir);
    this.prune();
  }

  /** Whether any computer still waits to hear it was removed. */
  waiting(): boolean {
    this.prune();
    return this.resets.length > 0;
  }

  /** The computers still waiting, with the reset each belongs to. */
  computers(): { id: string; name: string; at: number }[] {
    this.prune();
    return this.resets.flatMap((reset) =>
      reset.computers.map(({ id, name }) => ({ id, name, at: reset.at })),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The connection's pairing seam, answering for both: what `paired` holds
   * comes first, and a dial showing a waiting computer's key is refused,
   * which it reads as removed at the second time in a row. While `paired` listens
   * for nothing of its own, every dial is shown the newest reset's key, so
   * the fresh first mate makes no key of its own until it pairs something;
   * once it does, its own key is shown, and an address whose dial gave up on
   * it is shown each reset's old key in turn from its next dial
   * (`identityFor`).
   */
  answering(paired: PairedDevices): PairedDevices {
    const ownKey = () => !paired.any() && this.waiting();
    return {
      ...bound(paired),
      any: () => paired.any() || this.waiting(),
      subscribe: (listener) => {
        const one = paired.subscribe(listener);
        const two = this.subscribe(listener);
        return () => {
          one();
          two();
        };
      },
      identity: () => (ownKey() ? (this.newest()?.home ?? paired.identity()) : paired.identity()),
      identityTag: () =>
        ownKey() ? `reset:${this.newest()?.home.pin ?? ""}` : (paired.identityTag?.() ?? ""),
      identityFor: (address) => this.identityFor(address),
      noticed: (socket, servedCert) => this.noticed(socket, servedCert),
      abandoned: (address, servedCert) => this.abandoned(address, servedCert),
      admit: (request: IncomingMessage) => {
        const admitted = paired.admit(request);
        const settle = (device: PairedDevice | null) => {
          if (!device) this.refused(peerPin(request.socket), request.socket.remoteAddress);
          return device;
        };
        return admitted instanceof Promise ? admitted.then(settle) : settle(admitted);
      },
    };
  }

  /** The old key to show a dial from `address`, while its dials are tried with one. */
  identityFor(address: string | undefined): { key: string; cert: string } | undefined {
    if (!address) return undefined;
    const pin = this.learned.get(plain(address));
    return pin ? this.resets.find((reset) => reset.home.pin === pin)?.home : undefined;
  }

  /**
   * A dial finished its handshake: one that showed a waiting computer's key
   * is shown that computer's old key from its address's next dial; one an
   * old key was shown that is no waiting computer's is shown the first
   * mate's own key again.
   */
  noticed(socket: TLSSocket, servedCert: string): void {
    const address = socket.remoteAddress ? plain(socket.remoteAddress) : undefined;
    const pin = peerPin(socket);
    if (!address || !pin) return;
    const found = this.find(pin);
    if (!found) {
      if (this.resets.some((reset) => reset.home.cert === servedCert)) this.learned.delete(address);
      return;
    }
    if (found.reset.home.cert === servedCert) return;
    // Shown a key it does not expect, its run of refusals starts over.
    this.learned.set(address, found.reset.home.pin);
    if (found.computer.told > 0) {
      found.computer.told = 0;
      this.save();
    }
  }

  /**
   * A dial gave up on the key it was shown, as a device does on a key it does
   * not expect, and says nothing of its own: its address is shown the next
   * key - the first mate's own, then each waiting reset's from the newest -
   * from its next dial. A device that expects the key after next gives up
   * once more, at most once for each reset waiting.
   */
  abandoned(address: string | undefined, servedCert: string): void {
    if (!address || !this.waiting()) return;
    const at = plain(address);
    const keys: (string | null)[] = [null, ...this.resets.map((reset) => reset.home.pin).reverse()];
    const shown = this.resets.find((reset) => reset.home.cert === servedCert)?.home.pin ?? null;
    const next = keys[(keys.indexOf(shown) + 1) % keys.length] ?? null;
    if (next) this.learned.set(at, next);
    else this.learned.delete(at);
    // The computer refused from this address may be the one that gave up,
    // which starts its run of refusals over.
    let changed = false;
    for (const reset of this.resets)
      for (const computer of reset.computers)
        if (computer.told > 0 && this.refusedFrom.get(computer.id) === at) {
          computer.told = 0;
          changed = true;
        }
    if (changed) this.save();
  }

  /**
   * A dial nothing paired admitted: a waiting computer's is one more refusal
   * in a row. Once it met enough, it is removed when it stays quiet for
   * `RESET_QUIET_MS`; a dial in between starts that wait again.
   */
  refused(pin: string | null, address?: string): void {
    if (!pin) return;
    const found = this.find(pin);
    if (!found) return;
    if (address) this.refusedFrom.set(found.computer.id, plain(address));
    found.computer.told += 1;
    found.computer.toldAt = this.now();
    this.save();
    if (found.computer.told >= RESET_TELLS) this.waitQuiet(found.computer.id);
  }

  private waitQuiet(id: string): void {
    const found = this.findById(id);
    if (!found || found.computer.told < RESET_TELLS) return;
    const quietMs = this.options.quietMs ?? RESET_QUIET_MS;
    const left = (found.computer.toldAt ?? 0) + quietMs - this.now();
    const before = this.quiet.get(id);
    if (before) clearTimeout(before);
    const timer = setTimeout(
      () => {
        this.quiet.delete(id);
        const still = this.findById(id);
        if (!still || still.computer.told < RESET_TELLS) return;
        if (this.now() - (still.computer.toldAt ?? 0) >= quietMs) this.drop(id, "removed");
        else this.waitQuiet(id);
      },
      Math.max(0, left),
    );
    timer.unref?.();
    this.quiet.set(id, timer);
  }

  /** Starts the removals over Remote Login, and the look for the 30 days' end; answers its own stop. */
  start(): () => void {
    this.running = true;
    for (const computer of this.sshComputers()) this.tryThere(computer.id, true);
    for (const reset of this.resets)
      for (const computer of reset.computers) this.waitQuiet(computer.id);
    this.horizon = setInterval(() => {
      if (this.prune()) this.changed();
    }, HORIZON_LOOK_MS);
    this.horizon.unref?.();
    return () => this.stop();
  }

  /** This computer woke, or its network changed: each removal over Remote Login is tried at once. */
  resume(): void {
    if (!this.running) return;
    for (const computer of this.sshComputers()) this.tryThere(computer.id, true);
  }

  private stop(): void {
    this.running = false;
    if (this.horizon) clearInterval(this.horizon);
    this.horizon = null;
    for (const entry of this.tries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.tries.clear();
    for (const timer of this.quiet.values()) clearTimeout(timer);
    this.quiet.clear();
  }

  private sshComputers() {
    return this.resets.flatMap((reset) => reset.computers.filter((computer) => computer.ssh));
  }

  private tryThere(id: string, now: boolean): void {
    const removeThere = this.options.removeThere;
    if (!this.running || !removeThere) return;
    const entry = this.tries.get(id) ?? { count: 0, timer: null, busy: false };
    if (entry.busy || (entry.timer && !now)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.tries.set(id, entry);
    const found = this.findById(id);
    const ssh = found?.computer.ssh;
    if (!found || !ssh) {
      this.tries.delete(id);
      return;
    }
    entry.busy = true;
    void removeThere(found.reset, { ...found.computer, ssh })
      .catch(() => "failed" as const)
      .then((outcome) => {
        entry.busy = false;
        if (!this.running) return;
        if (outcome === "done") {
          this.tries.delete(id);
          if (this.findById(id)) this.drop(id, "removed");
          return;
        }
        const waits = this.options.retryMs ?? RESET_SSH_RETRY_MS;
        const wait = waits[Math.min(entry.count, waits.length - 1)] ?? 30 * 60_000;
        entry.count += 1;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          this.tryThere(id, true);
        }, wait);
        entry.timer.unref?.();
      });
  }

  private newest(): ResetRemoval | undefined {
    this.prune();
    return this.resets.at(-1);
  }

  private find(pin: string) {
    for (const reset of this.resets) {
      const computer = reset.computers.find((each) => each.keyPin === pin);
      if (computer) return { reset, computer };
    }
    return undefined;
  }

  private findById(id: string) {
    for (const reset of this.resets) {
      const computer = reset.computers.find((each) => each.id === id);
      if (computer) return { reset, computer };
    }
    return undefined;
  }

  /** Takes a computer off the record, saying so once; the last one takes the record and its keys. */
  private drop(id: string, outcome: ResetFarewellOutcome): void {
    const found = this.findById(id);
    if (!found) return;
    found.reset.computers = found.reset.computers.filter((each) => each !== found.computer);
    this.resets = this.resets.filter((reset) => reset.computers.length > 0);
    this.forget(id);
    this.forgetLearned();
    this.save();
    this.options.said({ id, name: found.computer.name }, outcome);
    this.changed();
  }

  /** Every reset whose 30 days are up goes, with its key, naming each computer that stayed. */
  private prune(): boolean {
    const now = this.now();
    const ended = this.resets.filter((reset) => reset.at + RESET_REMOVAL_MS <= now);
    if (ended.length === 0) return false;
    this.resets = this.resets.filter((reset) => !ended.includes(reset));
    for (const reset of ended) for (const computer of reset.computers) this.forget(computer.id);
    this.forgetLearned();
    this.save();
    for (const reset of ended)
      for (const computer of reset.computers)
        this.options.said({ id: computer.id, name: computer.name }, "stayed");
    return true;
  }

  /** Stops every wait for one computer. */
  private forget(id: string): void {
    const tried = this.tries.get(id);
    if (tried?.timer) clearTimeout(tried.timer);
    this.tries.delete(id);
    const quiet = this.quiet.get(id);
    if (quiet) clearTimeout(quiet);
    this.quiet.delete(id);
    this.refusedFrom.delete(id);
  }

  /** An address keeps an old key only while that key's reset still waits. */
  private forgetLearned(): void {
    const pins = new Set(this.resets.map((reset) => reset.home.pin));
    for (const [address, pin] of this.learned) if (!pins.has(pin)) this.learned.delete(address);
  }

  private save(): void {
    try {
      writeResetRemovals(this.options.dataDir, this.resets);
    } catch {
      // Kept in memory: the next change writes it again.
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** An IPv4 address as the socket says it on a dual-stack listener, without its IPv6 wrapping. */
function plain(address: string): string {
  return address.replace(/^::ffff:/, "");
}

/** Every method of `paired`'s seam, called on `paired` itself. */
function bound(paired: PairedDevices): PairedDevices {
  return {
    any: () => paired.any(),
    subscribe: (listener) => paired.subscribe(listener),
    identity: () => paired.identity(),
    admit: (request) => paired.admit(request),
    holds: (deviceId) => paired.holds(deviceId),
    claim: (body, request) => paired.claim(body, request),
    leave: (deviceId) => paired.leave(deviceId),
    ...(paired.offerTargets ? { offerTargets: (phone) => paired.offerTargets?.(phone) ?? [] } : {}),
    ...(paired.welcomeTargets
      ? { welcomeTargets: (phone) => paired.welcomeTargets?.(phone) ?? [] }
      : {}),
    ...(paired.homeNumber ? { homeNumber: () => paired.homeNumber?.() ?? 0 } : {}),
    ...(paired.takeOver ? { takeOver: () => paired.takeOver?.() ?? null } : {}),
    ...(paired.phoneStandbys ? { phoneStandbys: () => paired.phoneStandbys?.() ?? [] } : {}),
    ...(paired.opened ? { opened: (body, request) => paired.opened?.(body, request) ?? null } : {}),
    ...(paired.noteSystem
      ? { noteSystem: (deviceId, said) => paired.noteSystem?.(deviceId, said) }
      : {}),
  };
}

/**
 * Asks the old first mate's removal on a computer it reached over Remote
 * Login (`work remove --from-home`), with the old first mate's pin and that
 * computer's id, which the work mode there checks before it touches
 * anything; the host key the captain checked is the only one SSH takes.
 * `done` once it removed it, or nothing of the old first mate's is there.
 */
export function removeThereOverSsh(options: {
  ssh: SshProgram;
  flavor: BuildFlavor;
  timeoutMs?: number;
}): ResetRemoveThere {
  return async (reset, computer) => {
    const { address, hostKey } = computer.ssh;
    let folder: string | null = null;
    try {
      let trust: string[] = [];
      if (hostKey) {
        folder = mkdtempSync(join(tmpdir(), "infinitary-reset-"));
        const knownHosts = join(folder, "known_hosts");
        writeFileSync(knownHosts, `${knownHostsLine(address, hostKey)}\n`, { mode: 0o600 });
        trust = hostTrustSshOptions(knownHosts, address, hostKey);
      }
      const ran = await runSsh({
        ssh: options.ssh,
        address,
        options: [...SSH_OPTIONS, ...trust],
        command: [
          "/bin/sh",
          "-c",
          REMOVE,
          "firstmate",
          ...farFolderArgs(options.flavor),
          reset.home.pin,
          computer.id,
        ],
        timeoutMs: options.timeoutMs ?? 90_000,
      });
      const outcome = readWorkOutcome(ran.stdout);
      if (outcome?.firstmate === "removed") return "done";
      if (
        outcome?.firstmate === "refused" &&
        (outcome.reason === "not-joined" || outcome.reason === "other-home")
      )
        return "done";
      return "failed";
    } finally {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  };
}
