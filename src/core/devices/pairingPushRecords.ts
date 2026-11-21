import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PhonePushAnswer,
  type PhonePushLetter,
  type PhonePushRegistration,
  type PhonePushTarget,
  phonePushRegistrationSchema,
} from "@shared/phonePush";
import { z } from "zod";

/**
 * Where each paired phone's cards are pushed (docs/phone-push.md), kept
 * beside the list in a file of its own, as what each device is, so a list an
 * older app reads is still the list it knows. A home move carries it with
 * the list (`RECORD_ROOTS`).
 */
const PUSHES_FILE = "pushes.json";
const pushesFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(
    z.string(),
    phonePushRegistrationSchema.extend({ at: z.number().int().nonnegative() }),
  ),
});
type PushRecord = z.infer<typeof pushesFileSchema>["devices"][string];
const PUSHES_UNREADABLE = "Where each phone's cards are pushed cannot be read.";
/**
 * Which phones remove the notifications a withdrawal names, each by when the
 * registration that asked was handed (docs/phone-push.md, "Withdrawals"),
 * beside `pushes.json`, which an older app reads strictly.
 */
const WITHDRAWALS_FILE = "push-withdrawals.json";
const withdrawalsFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), z.number()),
});

/**
 * What each phone's letters left (docs/phone-push.md, "Letters"): the key
 * kept after the relay refused its grant, with that grant and whether it took
 * withdrawals; when its box was last read; and when the phone wrote the last
 * letter taken. A file of its own beside `pushes.json`, which an older app
 * reads strictly and would read a new field there as a file it cannot read.
 */
const LETTERS_FILE = "push-letters.json";
const letterStateSchema = z.object({
  key: phonePushRegistrationSchema.shape.key.optional(),
  grant: phonePushRegistrationSchema.shape.grant.optional(),
  withdrawals: z.literal(true).optional(),
  read: z.number().optional(),
  at: z.number().optional(),
});
type LetterState = z.infer<typeof letterStateSchema>;
const lettersFileSchema = z.object({
  version: z.literal(1),
  devices: z.record(z.string(), letterStateSchema),
});

/**
 * How long after a refused grant would have expired the computer keeps the
 * phone's key and reads its box: a phone's newer grant lasts at most 30
 * days, so a letter carrying one can wait that long.
 */
const LETTER_KEY_LAPSE_MS = 30 * 86_400_000;

/** When a grant expires, in milliseconds: its expiry is the seconds before the dot. */
function grantExpiry(grant: string): number {
  return Number(grant.slice(0, grant.indexOf("."))) * 1000;
}

/** One phone whose box the computer reads: the key its box and letters derive from. */
export type PhoneLetterBox = { deviceId: string; key: string; read?: number };

/** What taking a letter did: renewed the registration, forgot it, or nothing. */
export type LetterTaken = "renewed" | "stopped" | "ignored";

/** The phone push records that DevicePairing reads and writes beside its device list. */
export class PairingPushRecords {
  /** Where each paired phone's cards are pushed. */
  private pushes = new Map<string, PushRecord>();
  /** That could not be read this run: it is never written over, and nothing is pushed. */
  private pushesUnreadable = false;
  /** The phones whose registration said `withdrawals: true`, and when it was handed. */
  private withdrawals = new Map<string, number>();
  /** That could not be read this run: it is never written over, and no withdrawal is sent. */
  private withdrawalsUnreadable = false;
  /** Memory holds a phone that stopped taking withdrawals that the file does not yet. */
  private withdrawalsUnsaved = false;
  /** The newest stamp a registration was handed with, saved or not: the next one is later. */
  private lastStamp = 0;
  /**
   * The grant the relay refused for each phone this run: handed again, it
   * is not kept, and the phone is told to register anew.
   */
  private readonly refusedGrants = new Map<string, string>();
  /** Each phone's letter state (`push-letters.json`). */
  private letters = new Map<string, LetterState>();
  /** That could not be read this run: it is never written over, and no box is read. */
  private lettersUnreadable = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
    private readonly writeFile: (file: string, value: unknown) => void,
    private readonly onProblem: (text: string) => void,
  ) {}

  load(): void {
    try {
      const path = join(this.dir, PUSHES_FILE);
      if (existsSync(path))
        this.pushes = new Map(
          Object.entries(pushesFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices),
        );
    } catch {
      this.pushesUnreadable = true;
      this.onProblem(`${PUSHES_UNREADABLE} No phone's cards are pushed until it is moved away.`);
    }
    try {
      const path = join(this.dir, WITHDRAWALS_FILE);
      if (existsSync(path)) {
        const { devices } = withdrawalsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        this.withdrawals = new Map(Object.entries(devices));
      }
      const stamps = [...this.pushes.values()].map((kept) => kept.at);
      this.lastStamp = Math.max(0, ...stamps, ...this.withdrawals.values());
    } catch {
      this.withdrawalsUnreadable = true;
      this.onProblem(
        "Which phones take withdrawals cannot be read; no phone's notifications are withdrawn until it is moved away.",
      );
    }
    try {
      const path = join(this.dir, LETTERS_FILE);
      if (existsSync(path)) {
        const { devices } = lettersFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        this.letters = new Map(Object.entries(devices));
      }
    } catch {
      this.lettersUnreadable = true;
      this.onProblem(
        // i18n-exempt: a log line, never shown to a person
        "What each phone's letters left cannot be read; no letter is read until it is moved away.",
      );
    }
  }

  refuseWhileUnreadable(): void {
    if (this.pushesUnreadable) throw new Error(PUSHES_UNREADABLE);
  }

  remove(deviceId: string): void {
    if (this.pushes.delete(deviceId) && !this.pushesUnreadable) this.savePushes();
    this.setWithdrawals(deviceId, undefined);
    this.refusedGrants.delete(deviceId);
    this.setLetters(deviceId, undefined);
  }

  /**
   * Where a paired phone's cards are pushed (docs/phone-push.md), kept
   * beside its entry until it hands another, null, or leaves the list.
   * Only a phone on the list keeps one. Answers whether it is kept: not
   * for null, nor for a grant the relay refused this run.
   */
  set(deviceId: string, registration: PhonePushRegistration | null): PhonePushAnswer {
    const before = this.pushes.get(deviceId)?.key ?? this.letters.get(deviceId)?.key;
    if (registration === null) {
      if (this.pushes.delete(deviceId)) this.savePushes();
      this.setWithdrawals(deviceId, undefined);
      this.dropKeptKey(deviceId, before, undefined);
      return { kept: false };
    }
    if (this.refusedGrants.get(deviceId) === registration.grant) return { kept: false };
    const { withdrawals, ...where } = registration;
    const at = Math.max(this.now(), this.lastStamp + 1);
    this.lastStamp = at;
    this.pushes.set(deviceId, { ...where, at });
    this.savePushes();
    this.setWithdrawals(deviceId, withdrawals === true ? at : undefined);
    this.dropKeptKey(deviceId, before, where.key);
    return { kept: true };
  }

  /** Each phone on the list whose cards are pushed: where, and if its newest registration asked, withdrawals. */
  targets(entries: readonly { id: string }[]): PhonePushTarget[] {
    if (this.pushesUnreadable) return [];
    return entries.flatMap((entry) => {
      const kept = this.pushes.get(entry.id);
      const withdrawals =
        !this.withdrawalsUnreadable && kept && this.withdrawals.get(entry.id) === kept.at;
      return kept
        ? [
            {
              deviceId: entry.id,
              registration: {
                token: kept.token,
                environment: kept.environment,
                grant: kept.grant,
                key: kept.key,
                ...(withdrawals ? { withdrawals: true as const } : {}),
              },
            },
          ]
        : [];
    });
  }

  /** Keeps whether a phone takes withdrawals; a stop holds at once, a start once saved. */
  private setWithdrawals(deviceId: string, at: number | undefined): void {
    if (this.withdrawalsUnreadable) return;
    if (this.withdrawals.get(deviceId) === at && !this.withdrawalsUnsaved) return;
    const next = new Map(this.withdrawals);
    if (at === undefined) next.delete(deviceId);
    else next.set(deviceId, at);
    if (at === undefined) this.withdrawals = next;
    try {
      this.writeFile(WITHDRAWALS_FILE, { version: 1, devices: Object.fromEntries(next) });
      this.withdrawals = next;
      this.withdrawalsUnsaved = false;
    } catch (error) {
      this.withdrawalsUnsaved = true;
      this.onProblem(`could not keep whether a phone takes withdrawals: ${error}`);
    }
  }

  /**
   * The relay said a phone's registration no longer works (its push address
   * is gone, or its grant expired): it is forgotten, unless the phone handed
   * a new grant since, and the phone is told to register anew when it hands
   * that grant again.
   */
  forget(deviceId: string, grant: string): void {
    const kept = this.pushes.get(deviceId);
    if (this.pushesUnreadable || kept?.grant !== grant) return;
    // The key stays in the letter file, so its box is still read and a
    // letter with a newer grant renews the registration (INF-5275).
    const withdrawals = !this.withdrawalsUnreadable && this.withdrawals.get(deviceId) === kept.at;
    this.setLetters(deviceId, {
      ...this.letters.get(deviceId),
      key: kept.key,
      grant,
      ...(withdrawals ? { withdrawals: true as const } : { withdrawals: undefined }),
    });
    this.refusedGrants.set(deviceId, grant);
    this.pushes.delete(deviceId);
    this.setWithdrawals(deviceId, undefined);
    try {
      this.savePushes();
    } catch (error) {
      this.onProblem(
        `could not forget where a phone's cards are pushed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Each phone on the list whose box the computer reads (docs/phone-push.md,
   * "Letters"): one with a registration, by its key, or one whose grant the
   * relay refused, by the key kept then until 30 days after that grant would
   * have expired, when the key is forgotten.
   */
  letterBoxes(entries: readonly { id: string }[]): PhoneLetterBox[] {
    if (this.pushesUnreadable || this.lettersUnreadable) return [];
    const now = this.now();
    return entries.flatMap((entry) => {
      const state = this.letters.get(entry.id);
      const read = state?.read !== undefined ? { read: state.read } : {};
      const kept = this.pushes.get(entry.id);
      if (kept) return [{ deviceId: entry.id, key: kept.key, ...read }];
      if (!state?.key || !state.grant) return [];
      if (now > grantExpiry(state.grant) + LETTER_KEY_LAPSE_MS) {
        this.dropKeptKey(entry.id, state.key, undefined);
        return [];
      }
      return [{ deviceId: entry.id, key: state.key, ...read }];
    });
  }

  /** The relay answered a read of this phone's box at `at`: the next read is a day later. */
  noteLetterRead(deviceId: string, at: number): void {
    if (this.lettersUnreadable) return;
    this.setLetters(deviceId, { ...this.letters.get(deviceId), read: at });
  }

  /**
   * A letter opened from the box of `key`. It is taken only while that key is
   * still the phone's and only when the phone wrote it after the last letter
   * taken. A stop forgets the registration, as the relay's refusal does, and
   * the key with it. A renew replaces the push address, service and grant,
   * keeping the key and whether the phone takes withdrawals, but only with a
   * grant that expires later than the one kept or refused, and never one the
   * relay refused this run.
   */
  takeLetter(deviceId: string, key: string, letter: PhonePushLetter): LetterTaken {
    if (this.pushesUnreadable || this.lettersUnreadable) return "ignored";
    const kept = this.pushes.get(deviceId);
    const state = this.letters.get(deviceId) ?? {};
    if ((kept?.key ?? state.key) !== key) return "ignored";
    if (state.at !== undefined && letter.at <= state.at) return "ignored";
    if (letter.kind === "stop") {
      if (kept && this.pushes.delete(deviceId)) this.savePushesOrSay();
      this.setWithdrawals(deviceId, undefined);
      this.setLetters(deviceId, { at: letter.at });
      return "stopped";
    }
    const floor = kept?.grant ?? state.grant;
    if (floor && grantExpiry(letter.grant) <= grantExpiry(floor)) return "ignored";
    if (this.refusedGrants.get(deviceId) === letter.grant) return "ignored";
    const withdrawals = kept
      ? !this.withdrawalsUnreadable && this.withdrawals.get(deviceId) === kept.at
      : state.withdrawals === true;
    const at = Math.max(this.now(), this.lastStamp + 1);
    this.lastStamp = at;
    const { token, environment, grant } = letter;
    this.pushes.set(deviceId, { token, environment, grant, key, at });
    this.savePushesOrSay();
    this.setWithdrawals(deviceId, withdrawals ? at : undefined);
    this.setLetters(deviceId, {
      ...(state.read !== undefined ? { read: state.read } : {}),
      at: letter.at,
    });
    return "renewed";
  }

  /**
   * A registration or null was handed: the key kept after a refusal goes,
   * since the phone now names its key itself. A new key's box has not been
   * read yet; the time of the last letter taken stays, by the phone's clock.
   */
  private dropKeptKey(deviceId: string, before: string | undefined, key: string | undefined): void {
    const state = this.letters.get(deviceId);
    if (!state) return;
    const newBox = key !== before;
    if (!state.key && !(newBox && state.read !== undefined)) return;
    const { key: _key, grant: _grant, withdrawals: _withdrawals, ...rest } = state;
    this.setLetters(deviceId, { ...rest, ...(newBox ? { read: undefined } : {}) });
  }

  /** Keeps one phone's letter state, or forgets it; a write that fails is one line. */
  private setLetters(deviceId: string, state: LetterState | undefined): void {
    if (this.lettersUnreadable) return;
    const tidy =
      state && Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));
    if (tidy && Object.keys(tidy).length > 0) this.letters.set(deviceId, tidy);
    else if (!this.letters.delete(deviceId)) return;
    try {
      this.writeFile(LETTERS_FILE, { version: 1, devices: Object.fromEntries(this.letters) });
    } catch (error) {
      // i18n-exempt: a log line, never shown to a person
      this.onProblem(`could not keep what a phone's letters left: ${(error as Error).message}`);
    }
  }

  private savePushesOrSay(): void {
    try {
      this.savePushes();
    } catch (error) {
      this.onProblem(
        // i18n-exempt: a log line, never shown to a person
        `could not keep where a phone's cards are pushed: ${(error as Error).message}`,
      );
    }
  }

  private savePushes(): void {
    this.writeFile(PUSHES_FILE, { version: 1, devices: Object.fromEntries(this.pushes) });
  }
}
