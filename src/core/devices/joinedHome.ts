import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER } from "@shared/deviceNames";
import {
  type DeviceGrant,
  deviceGrantSchema,
  dialAddressSchema,
  leftReasonSchema,
  PAIRING_LINK_ALSO_MAX,
  type SteppedDown,
  steppedDownSchema,
} from "@shared/devices";
import { type Appearance, appearanceSchema, type Layout, layoutSchema } from "@shared/preferences";
import { z } from "zod";
import {
  type HeardTakeOver,
  HOME_NUMBER_FILE,
  HOME_TAKE_OVER_FILE,
  readHeardTakeOver,
  readHomeNumber,
  writeHeardTakeOver,
  writeHomeNumber,
} from "./homeNumber";
import { writePrivate } from "./identity";

/**
 * What an app that controls Firstmate on another Mac keeps (docs/view.md):
 * its grant to dial that Mac, that Mac's own name once it has said it, and
 * when it joined - in `userData/joined/` (0700, every file 0600), which this
 * class alone writes. It keeps no record of that Mac's work. When it stops
 * controlling that Mac it deletes the grant, and its own key with it, and
 * keeps one note of which Mac it left, which its first launch says. Its own
 * look - size, theme, wash, crew model names and how its panels sit - is
 * kept here too while it controls that Mac, and goes when it leaves, and so
 * are the keys a person changed on this Mac (docs/keyboard.md).
 */

const HOME_FILE = "home.json";
/**
 * The home's other addresses, beside the grant rather than in it, so a
 * version that knows only the grant still reads `home.json` as it was
 * (docs/devices.md, "Finding the home again").
 */
export const HOME_ADDRESSES_FILE = "home-addresses.json";
const LEFT_FILE = "left.json";
/** What this computer saved as the home after the copy that took over from it (docs/devices.md, "An old home that returns"). */
const STEPPED_DOWN_FILE = "stepped-down.json";
const LOOK_FILE = "appearance.json";

const lookSchema = z.strictObject({
  version: z.literal(1),
  appearance: appearanceSchema,
  layout: layoutSchema,
  // Read on its own (`readSavedKeymap`), so keys that cannot be read never cost the look.
  keyboard: z.unknown().optional(),
});
/**
 * This Mac's own look while it controls another: its appearance and layout
 * (captain's pick), and the keys a person changed here, as saved.
 */
export type OwnLook = { appearance: Appearance; layout: Layout; keyboard?: unknown };

const joinedSchema = z.strictObject({
  version: z.literal(1),
  // Never with `also`, which `HOME_ADDRESSES_FILE` keeps.
  grant: deviceGrantSchema.omit({ also: true }),
  /** The other Mac's own name, from its welcome; null until it has said it. */
  name: z.string().min(1).max(128).nullable(),
  joinedAt: z.number().int().nonnegative(),
});
export type Joined = Omit<z.infer<typeof joinedSchema>, "grant"> & { grant: DeviceGrant };

const addressesSchema = z.strictObject({
  version: z.literal(1),
  /** The grant these addresses lead to; another grant's are none. */
  deviceId: z.string().min(1).max(64),
  also: z.array(dialAddressSchema).min(1).max(PAIRING_LINK_ALSO_MAX),
});

const leftSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(128),
  reason: leftReasonSchema,
  at: z.number().int().nonnegative(),
  /**
   * A computer that runs work whose removal has not finished (docs/helper.md,
   * "Removed"): what it could not remove yet, empty until its first try ends.
   * Absent once it finished, and on an app that controls another Mac.
   */
  unfinished: z.array(z.string().min(1).max(4096)).max(64).optional(),
  /**
   * The device this app left or was removed as, so its window never opens
   * that home again with the grant its work still keeps while the home
   * brings that work back (docs/view.md, "Leave, and Remove at the other Mac").
   */
  deviceId: z.string().min(1).max(64).optional(),
});
export type LeftNote = Omit<z.infer<typeof leftSchema>, "version" | "unfinished" | "deviceId">;

export class JoinedHome {
  constructor(
    private readonly dir: string,
    private readonly onProblem: (text: string) => void = (text) => console.warn(`[joined] ${text}`),
  ) {}

  /**
   * The Mac this app controls, or null when it controls none. A file that
   * cannot be read is none: the app holds Firstmate itself, and says so once
   * in its log.
   */
  read(): Joined | null {
    const path = join(this.dir, HOME_FILE);
    if (!existsSync(path)) return null;
    let joined: Joined;
    try {
      joined = joinedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      this.onProblem(
        `The ${COMPUTER.one} this app controlled cannot be read; it starts as its own.`,
      );
      return null;
    }
    const also = joined.grant.via === "ssh" ? null : this.readAddresses(joined.grant.deviceId);
    return also ? { ...joined, grant: { ...joined.grant, also } } : joined;
  }

  /** The home's other addresses this grant keeps; none when unread, unreadable or another grant's. */
  private readAddresses(deviceId: string): string[] | null {
    const path = join(this.dir, HOME_ADDRESSES_FILE);
    if (!existsSync(path)) return null;
    try {
      const read = addressesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      return read.deviceId === deviceId ? read.also : null;
    } catch {
      return null;
    }
  }

  /** Writes the grant without its other addresses, and those beside it. */
  private writeHome(joined: Joined): void {
    const { also, ...grant } = joined.grant;
    this.write(HOME_FILE, { ...joined, grant });
    if (also && also.length > 0 && grant.via !== "ssh")
      this.write(HOME_ADDRESSES_FILE, { version: 1, deviceId: grant.deviceId, also });
    else rmSync(join(this.dir, HOME_ADDRESSES_FILE), { force: true });
  }

  /**
   * Joins: the grant and when, with that Mac's name when it is known already,
   * else none until that Mac says it. Clears any left note. The record goes
   * in place whole, in one write: Windows refuses to replace a file another
   * program holds open, as one may the moment the file appears, so a second
   * write of the name could fail and leave the grant nameless.
   */
  join(grant: DeviceGrant, joinedAt: number, name: string | null = null): Joined {
    const joined: Joined = { version: 1, grant, name, joinedAt };
    this.writeHome(joined);
    rmSync(join(this.dir, LEFT_FILE), { force: true });
    rmSync(join(this.dir, HOME_NUMBER_FILE), { force: true });
    rmSync(join(this.dir, HOME_TAKE_OVER_FILE), { force: true });
    rmSync(join(this.dir, STEPPED_DOWN_FILE), { force: true });
    return joined;
  }

  /** Keeps what this computer saved as the home after the copy that took over from it. */
  keepSteppedDown(steppedDown: SteppedDown): void {
    if (!this.read()) return;
    this.write(STEPPED_DOWN_FILE, steppedDown);
  }

  /** What this computer saved as the home that never reached the copy that took over; null when it never stepped down. */
  steppedDown(): SteppedDown | null {
    try {
      return steppedDownSchema.parse(
        JSON.parse(readFileSync(join(this.dir, STEPPED_DOWN_FILE), "utf8")),
      );
    } catch {
      return null;
    }
  }

  /**
   * The highest home number this grant's home said (docs/devices.md,
   * "Moving the first mate"): a home with a lower one is one a move left
   * behind, which this computer never takes again. 1 before any said more.
   */
  homeNumber(): number {
    return readHomeNumber(this.dir);
  }

  /** Keeps a higher home number than the one kept; a lower or equal one changes nothing. */
  keepHomeNumber(homeNumber: number): void {
    if (!this.read() || homeNumber <= this.homeNumber()) return;
    writeHomeNumber(this.dir, homeNumber);
  }

  /** The takeover heard with the newest home number, or null (`./homeNumber.ts`). */
  heardTakeOver(): HeardTakeOver | null {
    return readHeardTakeOver(this.dir);
  }

  /** Keeps the takeover a welcome said with a number no lower than the one kept. */
  keepHeardTakeOver(heard: HeardTakeOver): void {
    if (!this.read() || heard.number < this.homeNumber()) return;
    writeHeardTakeOver(this.dir, heard);
  }

  /**
   * The other Mac answers at another address now (docs/devices.md, "Finding
   * the home again"): the grant dials there from now on, with the same key,
   * name and joining time. With `via`, it reaches that Mac only through that
   * Mac's own SSH connection from now on; nothing takes that away.
   */
  dialAt(at: string, via?: DeviceGrant["via"]): void {
    const joined = this.read();
    if (!joined || (joined.grant.at === at && (!via || joined.grant.via === via))) return;
    this.writeHome({ ...joined, grant: { ...joined.grant, at, ...(via ? { via } : {}) } });
  }

  /**
   * Where the home answered and every other address it offered in its
   * welcome (docs/devices.md, "Finding the home again"): the grant dials
   * there first, then the others, from now on. A grant that reaches its home
   * only through the home's SSH keeps no address of its own to try.
   */
  routes(at: string, also: readonly string[]): void {
    const joined = this.read();
    if (!joined || joined.grant.via === "ssh") return;
    const kept = joined.grant.also ?? [];
    if (
      joined.grant.at === at &&
      kept.length === also.length &&
      kept.every((each, index) => also[index] === each)
    )
      return;
    this.writeHome({ ...joined, grant: { ...joined.grant, at, also: [...also] } });
  }

  /** The other Mac said its own name; kept so it is said while that Mac is out of reach. */
  name(name: string): void {
    this.heard({ name });
  }

  /**
   * The home said whether this computer runs on the home's own Mac; kept on
   * the grant, which its background and its run read while the home is out
   * of reach (docs/helper.md, "In the background").
   */
  onHomeMac(onHomeMac: boolean): void {
    this.heard({ onHomeMac });
  }

  /**
   * What the home said at once, its own name and whether this computer runs
   * on its Mac, kept in one write (`name`, `onHomeMac`): a second write right
   * after the first could find the file held open by another program, which
   * Windows refuses to replace. What was not said, or is kept already, stays.
   */
  heard(said: { name?: string; onHomeMac?: boolean }): void {
    const joined = this.read();
    if (!joined) return;
    const name = said.name ?? joined.name;
    const onHomeMac = said.onHomeMac ?? joined.grant.onHomeMac;
    if (name === joined.name && onHomeMac === joined.grant.onHomeMac) return;
    this.writeHome({
      ...joined,
      name,
      grant: onHomeMac === undefined ? joined.grant : { ...joined.grant, onHomeMac },
    });
  }

  /**
   * Stops controlling it: the grant and its key are deleted, and one note says
   * which Mac and why. With `unfinished`, a computer that runs work notes too
   * that removing what Firstmate set up here has begun and not finished; with
   * `deviceId`, which device on that Mac's list this was.
   */
  leave(note: LeftNote, unfinished?: readonly string[], deviceId?: string): void {
    rmSync(join(this.dir, HOME_FILE), { force: true });
    rmSync(join(this.dir, HOME_ADDRESSES_FILE), { force: true });
    rmSync(join(this.dir, LOOK_FILE), { force: true });
    rmSync(join(this.dir, HOME_NUMBER_FILE), { force: true });
    rmSync(join(this.dir, STEPPED_DOWN_FILE), { force: true });
    this.write(LEFT_FILE, {
      version: 1,
      ...note,
      ...(unfinished ? { unfinished } : {}),
      ...(deviceId ? { deviceId } : {}),
    });
  }

  /** The device this app last left or was removed as, when the note says. */
  leftDeviceId(): string | null {
    return this.readLeft()?.deviceId ?? null;
  }

  /** A removal here that has not finished: what it could not remove yet, or null when none waits. */
  unfinished(): string[] | null {
    return this.readLeft()?.unfinished ?? null;
  }

  /** What a removal here could not remove yet; none clears it, as the removal finished. */
  setUnfinished(paths: readonly string[]): void {
    const read = this.readLeft();
    if (!read) return;
    const { unfinished: _unfinished, ...note } = read;
    this.write(LEFT_FILE, paths.length > 0 ? { ...note, unfinished: paths.slice(0, 64) } : note);
  }

  /** This Mac's own look while it controls another, or null before it has one. */
  look(): OwnLook | null {
    const path = join(this.dir, LOOK_FILE);
    if (!existsSync(path)) return null;
    try {
      const { appearance, layout, keyboard } = lookSchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      );
      return keyboard === undefined ? { appearance, layout } : { appearance, layout, keyboard };
    } catch {
      return null;
    }
  }

  setLook(look: OwnLook): void {
    this.write(LOOK_FILE, { version: 1, ...look });
  }

  /** The Mac this app last stopped controlling, or null. */
  left(): LeftNote | null {
    const read = this.readLeft();
    if (!read) return null;
    const { version: _version, unfinished: _unfinished, deviceId: _deviceId, ...note } = read;
    return note;
  }

  private readLeft(): z.infer<typeof leftSchema> | null {
    const path = join(this.dir, LEFT_FILE);
    if (!existsSync(path)) return null;
    try {
      return leftSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writePrivate(join(this.dir, file), `${JSON.stringify(value, null, 2)}\n`);
  }
}
