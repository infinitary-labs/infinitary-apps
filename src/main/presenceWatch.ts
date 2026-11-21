import type { Presence } from "@shared/channels/shell";

/**
 * Why nobody is at this computer: its screen turned off, it locked, its
 * screen saver started, or another person's session came to the front
 * (docs/ambient-music.md, "When nobody is at the computer").
 */
export type AwayReason = "screen-off" | "locked" | "screen-saver" | "other-session";

/**
 * Each reason begins and ends on its own, and someone is back only once
 * every reason ended, so a screen that wakes to a lock screen stays away
 * until the unlock.
 */
export class PresenceWatch {
  readonly #reasons = new Set<AwayReason>();
  readonly #listeners = new Set<(presence: Presence) => void>();

  constructor(readonly watched: boolean) {}

  presence(): Presence {
    return { away: this.#reasons.size > 0, watched: this.watched };
  }

  /** One reason began or ended; listeners hear only a change to `away`. */
  set(reason: AwayReason, on: boolean): void {
    const was = this.#reasons.size > 0;
    if (on) this.#reasons.add(reason);
    else this.#reasons.delete(reason);
    if (this.#reasons.size > 0 === was) return;
    const presence = this.presence();
    for (const listener of this.#listeners) listener(presence);
  }

  listen(listener: (presence: Presence) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * `GUID_SESSION_DISPLAY_STATUS`, {2B84C20E-AD23-4ddf-93DB-05FFBD7EFCA5}, as
 * Windows lays a GUID out in memory: its first three parts little-endian.
 */
export const DISPLAY_STATUS_GUID = Buffer.from([
  0x0e, 0xc2, 0x84, 0x2b, 0x23, 0xad, 0xdf, 0x4d, 0x93, 0xdb, 0x05, 0xff, 0xbd, 0x7e, 0xfc, 0xa5,
]);

/** A `POWERBROADCAST_SETTING` up to its first four bytes of data: the GUID, its length, its data. */
export const POWER_SETTING_BYTES = 24;

/**
 * Whether a `POWERBROADCAST_SETTING` Windows sent with `PBT_POWERSETTINGCHANGE`
 * says the display turned off: its data is 0 off, 1 on, 2 dimmed, and dimmed
 * still shows the screen. Null for another setting.
 */
export function displayOff(setting: Buffer): boolean | null {
  if (setting.length < POWER_SETTING_BYTES) return null;
  if (!setting.subarray(0, 16).equals(DISPLAY_STATUS_GUID)) return null;
  if (setting.readUInt32LE(16) < 4) return null;
  return setting.readUInt32LE(20) === 0;
}
