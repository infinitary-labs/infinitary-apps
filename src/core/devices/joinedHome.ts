import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER } from "@shared/deviceNames";
import { type DeviceGrant, deviceGrantSchema, leftReasonSchema } from "@shared/devices";
import { type Appearance, appearanceSchema, type Layout, layoutSchema } from "@shared/preferences";
import { z } from "zod";
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
const LEFT_FILE = "left.json";
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
  grant: deviceGrantSchema,
  /** The other Mac's own name, from its welcome; null until it has said it. */
  name: z.string().min(1).max(128).nullable(),
  joinedAt: z.number().int().nonnegative(),
});
export type Joined = z.infer<typeof joinedSchema>;

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
    try {
      return joinedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      this.onProblem(
        `The ${COMPUTER.one} this app controlled cannot be read; it starts as its own.`,
      );
      return null;
    }
  }

  /** Joins: the grant and when, with no name until that Mac says it. Clears any left note. */
  join(grant: DeviceGrant, joinedAt: number): Joined {
    const joined: Joined = { version: 1, grant, name: null, joinedAt };
    this.write(HOME_FILE, joined);
    rmSync(join(this.dir, LEFT_FILE), { force: true });
    return joined;
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
    this.write(HOME_FILE, { ...joined, grant: { ...joined.grant, at, ...(via ? { via } : {}) } });
  }

  /** The other Mac said its own name; kept so it is said while that Mac is out of reach. */
  name(name: string): void {
    const joined = this.read();
    if (!joined || joined.name === name) return;
    this.write(HOME_FILE, { ...joined, name });
  }

  /**
   * The home said whether this computer runs on the home's own Mac; kept on
   * the grant, which its background and its run read while the home is out
   * of reach (docs/helper.md, "In the background").
   */
  onHomeMac(onHomeMac: boolean): void {
    const joined = this.read();
    if (!joined || joined.grant.onHomeMac === onHomeMac) return;
    this.write(HOME_FILE, { ...joined, grant: { ...joined.grant, onHomeMac } });
  }

  /**
   * Stops controlling it: the grant and its key are deleted, and one note says
   * which Mac and why. With `unfinished`, a computer that runs work notes too
   * that removing what Firstmate set up here has begun and not finished; with
   * `deviceId`, which device on that Mac's list this was.
   */
  leave(note: LeftNote, unfinished?: readonly string[], deviceId?: string): void {
    rmSync(join(this.dir, HOME_FILE), { force: true });
    rmSync(join(this.dir, LOOK_FILE), { force: true });
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
