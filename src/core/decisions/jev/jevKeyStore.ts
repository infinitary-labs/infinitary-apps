import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionModelId } from "@shared/decisions";

/**
 * A native decision model's key, in its own tiny store (S7b, design section
 * 6 rule 3): `userData/decisions/<id>/key`, a 0700 directory holding one
 * 0600 file.
 *
 * Why not the account vault: a vault account brings a Pi runtime, a status
 * row, quota windows, credential health and membership of the routing pool,
 * and a decision model has none of those (design section 4). Why not the
 * `settings` table: a row that is read, pushed to the window and exported
 * must never carry a secret. So it is a file, owned by this class, and
 * `remove()` deletes the whole directory.
 *
 * Two rules the class exists to keep: the key is entered only in Settings
 * and read only to place it in a request header - never from
 * `TYPESAFE_API_KEY`, never from any ambient config, the same rule that
 * keeps the app out of `~/.pi`; and `has()` is the only question any other
 * module is allowed to ask, so nothing outside this file can put the value
 * in a log, a card, a feed line or a view.
 */
export class DecisionKeyStore {
  constructor(private readonly userData: string) {}

  private dirFor(id: DecisionModelId): string {
    return join(this.userData, "decisions", id);
  }

  private fileFor(id: DecisionModelId): string {
    return join(this.dirFor(id), "key");
  }

  /** Whether a key is stored at all. The one question outside callers may ask. */
  has(id: DecisionModelId): boolean {
    return existsSync(this.fileFor(id));
  }

  /**
   * The stored key, for the one caller that places it in a header. It is
   * deliberately not exported through any view, IPC response or event.
   */
  read(id: DecisionModelId): string | undefined {
    try {
      const key = readFileSync(this.fileFor(id), "utf8").trim();
      return key.length > 0 ? key : undefined;
    } catch {
      return undefined;
    }
  }

  /** Writes the user's own key, 0700 directory and 0600 file, replacing any earlier one. */
  set(id: DecisionModelId, key: string): void {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("a decision model's key cannot be empty");
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `recursive` does not re-apply the mode to a directory that already
    // existed, so the permission is asserted rather than assumed.
    chmodSync(dir, 0o700);
    const file = this.fileFor(id);
    writeFileSync(file, trimmed, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** "Remove Jev": the key and its directory go; the D-13 purge does not touch them. */
  remove(id: DecisionModelId): void {
    rmSync(this.dirFor(id), { recursive: true, force: true });
  }
}
