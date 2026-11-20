import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PhonePushAnswer,
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
  }

  refuseWhileUnreadable(): void {
    if (this.pushesUnreadable) throw new Error(PUSHES_UNREADABLE);
  }

  remove(deviceId: string): void {
    if (this.pushes.delete(deviceId) && !this.pushesUnreadable) this.savePushes();
    this.setWithdrawals(deviceId, undefined);
    this.refusedGrants.delete(deviceId);
  }

  /**
   * Where a paired phone's cards are pushed (docs/phone-push.md), kept
   * beside its entry until it hands another, null, or leaves the list.
   * Only a phone on the list keeps one. Answers whether it is kept: not
   * for null, nor for a grant the relay refused this run.
   */
  set(deviceId: string, registration: PhonePushRegistration | null): PhonePushAnswer {
    if (registration === null) {
      if (this.pushes.delete(deviceId)) this.savePushes();
      this.setWithdrawals(deviceId, undefined);
      return { kept: false };
    }
    if (this.refusedGrants.get(deviceId) === registration.grant) return { kept: false };
    const { withdrawals, ...where } = registration;
    const at = Math.max(this.now(), this.lastStamp + 1);
    this.lastStamp = at;
    this.pushes.set(deviceId, { ...where, at });
    this.savePushes();
    this.setWithdrawals(deviceId, withdrawals === true ? at : undefined);
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
    if (this.pushesUnreadable || this.pushes.get(deviceId)?.grant !== grant) return;
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

  private savePushes(): void {
    this.writeFile(PUSHES_FILE, { version: 1, devices: Object.fromEntries(this.pushes) });
  }
}
