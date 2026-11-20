import { createHash, randomUUID } from "node:crypto";
import { STANDBY_LOCK_ORDER, type StandbyLock } from "@shared/standby";
import type { SecretCustody } from "../secrets/custody";
import type { RecoveryFiles } from "../secrets/recoveryArchive";
import { readStandbyLock } from "./lock";
import {
  isLockKey,
  openKeyWith,
  readSealedSecrets,
  readStandbyLocks,
  readTakenFile,
  type SealedSecrets,
  sealedFileId,
  sealedFor,
  sealKeyTo,
  writeSealedSecrets,
  writeStandbyLocks,
  writeTakenFile,
} from "./sealedSecrets";
import { STANDBY_WORDS } from "./words";

/** How often the home reads a computer's answer while the person there has not confirmed yet. */
const ASKING_POLL_MS = 2_000;

/** What the home's Secrets owner offers the copies: no value ever crosses here. */
export type StandbySecretsOwner = {
  /** What the values are now; undefined while Secrets are not open on this home. */
  sealedState: () => Promise<{ home: string; revisions: string[] } | undefined>;
  sealForStandbys: <T>(
    seal: (files: RecoveryFiles, home: string) => T,
  ) => Promise<T | "unavailable">;
  /** Takes the copy's values; `replaceOwn` only on the captain's word over values of this computer's own. */
  adoptStandby: (files: RecoveryFiles, replaceOwn?: boolean) => Promise<string>;
  /** One question on a card, each answer run here when the captain picks it. */
  offer: (
    group: string,
    title: string,
    body: string,
    actions: { label: string; run: () => Promise<void> }[],
  ) => void;
};

export type StandbySecretsOptions = {
  /** The home's data folder: the record the sealed file and the locks live in. */
  userData: string;
  secrets: StandbySecretsOwner | undefined;
  /** This computer's own lock, read when the first mate starts here from a copy. */
  ownLock: SecretCustody | undefined;
  /** Whether a computer's version can keep secrets with its copy. */
  speaks: (deviceId: string) => boolean;
  ask: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
  /** The computers that keep a copy now. */
  listed: () => string[];
  /** Something a computer's line shows changed. */
  changed: () => void;
  log: (line: string) => void;
  now?: () => number;
  /** How often an unanswered confirmation is read; `ASKING_POLL_MS` unless a test says. */
  pollMs?: number;
};

export type StandbySecretsState = "none" | "asking" | "kept";

/**
 * The home's side of keeping the first mate's secrets with each copy
 * (docs/devices.md, "Secrets on a computer that keeps a copy"). Each computer
 * the captain names keeps them only once the person confirmed there: that
 * computer then hands its lock's public half, and the home seals a recovery
 * archive of the values under a fresh key and that key to every lock, in one
 * file of the record that the stream carries like any other change. A first
 * mate that starts from a copy opens it with its own lock and takes the
 * values as a restore would.
 */
export class StandbySecrets {
  private readonly asking = new Map<string, { request: string; timer?: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /**
   * Values another home sealed to this computer's lock that it did not take:
   * the record keeps them as they are, never sealed over. `retry` tries again
   * at the next change of Secrets here that the taking did not make itself,
   * when what stopped it - a locked store, a use under way - may be gone;
   * `run` holds for this run: Secrets of its own here, or an archive this
   * build cannot open.
   */
  private holding: "retry" | "run" | null = null;
  /** While the taking runs: the change it announces itself is no reason to try again. */
  private adopting = false;
  private readonly now: () => number;

  constructor(private readonly options: StandbySecretsOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Where one computer stands, for its line in Settings, Devices: kept only
   * while the sealed file holds a key for it, never on its lock alone.
   */
  state(deviceId: string): StandbySecretsState {
    if (this.asking.has(deviceId)) return "asking";
    return sealedFor(this.options.userData, deviceId) ? "kept" : "none";
  }

  /** Whether the secrets kept with copies can work here at all. */
  offered(): boolean {
    return this.options.secrets !== undefined;
  }

  /**
   * The captain's Keep secrets there: asks the computer to confirm the
   * person on it, then reads its answer until they did. Nothing is kept
   * there before that.
   */
  async keep(deviceId: string): Promise<StandbyLock["state"]> {
    if (!this.options.secrets || !this.options.speaks(deviceId)) return "unavailable";
    if (this.asking.has(deviceId)) return "asking";
    const request = randomUUID();
    let answer: StandbyLock;
    try {
      answer = await this.lockOrder(deviceId, request, true);
    } catch (error) {
      this.options.log(`asking ${deviceId} to keep secrets failed: ${messageOf(error)}`);
      return "unavailable";
    }
    if (answer.state === "kept") return this.kept(deviceId, answer);
    if (answer.state !== "asking") return answer.state;
    this.asking.set(deviceId, { request });
    this.options.changed();
    this.poll(deviceId, request);
    return "asking";
  }

  private poll(deviceId: string, request: string): void {
    const entry = this.asking.get(deviceId);
    if (!entry || entry.request !== request || this.disposed) return;
    entry.timer = setTimeout(() => {
      void this.lockOrder(deviceId, request, false).then(
        async (answer) => {
          if (this.asking.get(deviceId)?.request !== request) return;
          if (answer.state === "asking") return this.poll(deviceId, request);
          // Its line says kept only once the values are sealed to its lock.
          try {
            if (answer.state === "kept") await this.kept(deviceId, answer);
            else this.options.log(`${deviceId} kept no secrets: ${answer.state}`);
          } catch (error) {
            this.options.log(`keeping ${deviceId}'s lock failed: ${messageOf(error)}`);
          } finally {
            if (this.asking.get(deviceId)?.request === request) this.asking.delete(deviceId);
            this.options.changed();
          }
        },
        (error: unknown) => {
          // Out of reach a while: ask again once it answers.
          this.options.log(`reading ${deviceId}'s answer failed: ${messageOf(error)}`);
          this.poll(deviceId, request);
        },
      );
    }, this.options.pollMs ?? ASKING_POLL_MS);
    entry.timer.unref?.();
  }

  private async lockOrder(deviceId: string, request: string, ask: boolean): Promise<StandbyLock> {
    const answer = (await this.options.ask(deviceId, STANDBY_LOCK_ORDER, [
      { request, ask },
    ])) as StandbyLock;
    return answer;
  }

  private kept(deviceId: string, answer: StandbyLock): Promise<"kept" | "unavailable"> {
    const key = answer.key;
    if (!key || !isLockKey(key)) return Promise.resolve("unavailable");
    return this.inTurn(async () => {
      if (!this.options.listed().includes(deviceId)) return "unavailable";
      const locks = readStandbyLocks(this.options.userData);
      writeStandbyLocks(this.options.userData, {
        locks: [
          ...locks.locks.filter((each) => each.device !== deviceId),
          { device: deviceId, key, at: this.now() },
        ],
      });
      await this.sealNow();
      this.options.changed();
      return "kept";
    });
  }

  /**
   * A computer that keeps no copy now keeps no secrets: its lock leaves the
   * list and the file is sealed again without it.
   */
  sweep(): Promise<void> {
    const listed = new Set(this.options.listed());
    for (const [deviceId, entry] of this.asking)
      if (!listed.has(deviceId)) {
        clearTimeout(entry.timer);
        this.asking.delete(deviceId);
      }
    return this.inTurn(async () => {
      const locks = readStandbyLocks(this.options.userData);
      const kept = locks.locks.filter((each) => listed.has(each.device));
      if (kept.length !== locks.locks.length)
        writeStandbyLocks(this.options.userData, { locks: kept });
      await this.sealNow();
    });
  }

  /** The values or the locks may have changed: seal again if they did. */
  seal(): Promise<void> {
    const ownChange = this.adopting;
    return this.inTurn(async () => {
      // A taking that a locked or busy store stopped is tried again first.
      if (this.holding === "retry" && !ownChange) await this.adoptNow();
      await this.sealNow();
    });
  }

  private async sealNow(): Promise<void> {
    const secrets = this.options.secrets;
    if (!secrets || this.disposed || this.holding !== null) return;
    const userData = this.options.userData;
    const locks = readStandbyLocks(userData).locks;
    if (locks.length === 0) {
      if (readSealedSecrets(userData)) writeSealedSecrets(userData, null);
      return;
    }
    const state = await secrets.sealedState();
    // Secrets not open here now: the copies keep what was sealed last.
    if (!state) return;
    const made = createHash("sha256")
      .update(
        JSON.stringify({
          home: state.home,
          revisions: state.revisions,
          locks: locks.map(({ device, key }) => `${device}:${key}`).sort(),
        }),
      )
      .digest("hex");
    const current = readSealedSecrets(userData);
    if (current?.made === made && current.source === state.home) return;
    const at = this.now();
    const sealed = await secrets.sealForStandbys(
      (files, home): SealedSecrets => ({
        format: 1,
        source: home,
        made,
        at,
        archive: files.archive.toString("base64"),
        keys: locks.map((lock) => sealKeyTo(lock, files.archive, files.key)),
      }),
    );
    if (sealed === "unavailable") {
      this.options.log("sealing secrets for the copies failed");
      return;
    }
    writeSealedSecrets(userData, sealed);
  }

  /**
   * A first mate that starts from a copy: when the record carries values
   * another home sealed and this computer's own lock opens them, take them
   * as a restore would, then seal them again for the other copies.
   */
  adopt(): Promise<void> {
    return this.inTurn(() => this.adoptNow());
  }

  private async adoptNow(replaceOwn = false): Promise<void> {
    this.holding = null;
    if (this.disposed) return;
    const secrets = this.options.secrets;
    const custody = this.options.ownLock;
    const userData = this.options.userData;
    if (!secrets || !custody) return;
    const sealed = readSealedSecrets(userData);
    if (!sealed) return;
    const state = await secrets.sealedState();
    if (state?.home === sealed.source) return;
    const held = await readStandbyLock(custody);
    // Its own store locked or refusing: the lock may open them later.
    if (held === "unavailable") {
      this.holding = "retry";
      return;
    }
    if (!held) return;
    const key = openKeyWith(held, sealed);
    if (!key) return;
    const archive = Buffer.from(sealed.archive, "base64");
    let result: string;
    this.adopting = true;
    try {
      result = await secrets.adoptStandby({ archive, key }, replaceOwn);
      this.options.log(`taking the copy's secrets: ${result}`);
    } catch (error) {
      result = `failed: ${messageOf(error)}`;
      this.options.log(`taking the copy's secrets ${result}`);
    } finally {
      this.adopting = false;
      archive.fill(0);
      key.fill(0);
    }
    // An unknown answer took them when the values are here now.
    if (result === "unknown" && ((await secrets.sealedState())?.revisions.length ?? 0) > 0)
      result = "restored";
    if (result === "restored") writeTakenFile(userData, sealed);
    // Values of its own that it took from this very file before it could seal again.
    else if (result === "kept-own" && readTakenFile(userData) === sealedFileId(sealed))
      result = "restored";
    // Not taken: the values stay sealed as they are, for a later try.
    if (result !== "restored") {
      this.holding = result === "kept-own" || result === "invalid" ? "run" : "retry";
      // Both sets stay until the captain chooses which this first mate uses.
      if (result === "kept-own") this.askWhich(sealed);
      return;
    }
    await this.becomeHome(held.publicKey);
  }

  /** This computer is the home now and keeps no copy of its own: its lock leaves the list, and the values are sealed for the others. */
  private async becomeHome(ownKey: string): Promise<void> {
    const userData = this.options.userData;
    const locks = readStandbyLocks(userData);
    const others = locks.locks.filter((each) => each.key !== ownKey);
    if (others.length !== locks.locks.length) writeStandbyLocks(userData, { locks: others });
    await this.sealNow();
  }

  /**
   * This computer kept Secrets of its own and started from a copy that holds
   * others, sealed by the earlier home: one card asks which to use. Until
   * the captain answers, both stay as they are.
   */
  private askWhich(sealed: SealedSecrets): void {
    const secrets = this.options.secrets;
    if (!secrets) return;
    const file = sealedFileId(sealed);
    // An answer counts only while the copy still holds the file it was asked about.
    const same = () => {
      const now = readSealedSecrets(this.options.userData);
      return now !== undefined && sealedFileId(now) === file;
    };
    secrets.offer("standby-which", STANDBY_WORDS.whichTitle, STANDBY_WORDS.whichBody, [
      {
        label: STANDBY_WORDS.whichCopy,
        run: () =>
          this.inTurn(async () => {
            if (same()) await this.adoptNow(true);
          }),
      },
      {
        label: STANDBY_WORDS.whichOwn,
        run: () =>
          this.inTurn(async () => {
            const custody = this.options.ownLock;
            const now = readSealedSecrets(this.options.userData);
            if (!custody || !now || sealedFileId(now) !== file) return;
            // Decided: a later start knows this file and never asks again.
            writeTakenFile(this.options.userData, now);
            const held = await readStandbyLock(custody);
            // A locked store finishes at the next change, through the taken file.
            this.holding = "retry";
            if (!held || held === "unavailable") return;
            this.holding = null;
            await this.becomeHome(held.publicKey);
          }),
      },
    ]);
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch((error: unknown) =>
      this.options.log(`secrets for the copies: ${messageOf(error)}`),
    );
    return next;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.asking.values()) clearTimeout(entry.timer);
    this.asking.clear();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
