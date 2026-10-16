import type { ServerStore, StoreEntry, StoreValue } from "@shared/personal/contracts";
import {
  PERSONAL_STORE_KEY_MAX_LENGTH,
  PERSONAL_STORE_MAX_BYTES,
  PERSONAL_STORE_VALUE_MAX_BYTES,
} from "@shared/personal/manifest";
import type { AppDatabase } from "../storage/db";

/**
 * The personal-extension store (talk-to-personalize Step 2): every
 * extension's slice of `plugin_kv` (migration 33), namespaced by extension
 * id. One writer for the panel side (over `inf:plugins:db`) and the server
 * side (`context.db`, bound through `forExtension`); one listener list, so
 * a write from either side reaches the renderer as one `inf:plugins:db`
 * notice and re-evaluates `presence`.
 *
 * Caps are enforced here and nowhere else: a key at most
 * PERSONAL_STORE_KEY_MAX_LENGTH characters, a value at most
 * PERSONAL_STORE_VALUE_MAX_BYTES of JSON, a slice at most
 * PERSONAL_STORE_MAX_BYTES. A write over a cap throws with the cap named
 * and changes nothing; the caller (a panel's `store.set`, a server action)
 * sees the message.
 */
export class PersonalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalStoreError";
  }
}

export type PersonalStoreListener = (extensionId: string, key: string) => void;

type Row = { key: string; value: string; updated_at: number };

export class PersonalStore {
  private readonly listeners = new Set<PersonalStoreListener>();
  /**
   * A slice's cap, by extension id: PERSONAL_STORE_MAX_BYTES unless the
   * plugin's `storage` grant asked for less (one plugin vehicle, Phase A).
   * The plugin host sets it; it can only ever lower the cap.
   */
  private sliceCap: (extensionId: string) => number = () => PERSONAL_STORE_MAX_BYTES;

  setSliceCap(cap: (extensionId: string) => number): void {
    this.sliceCap = (extensionId) => Math.min(cap(extensionId), PERSONAL_STORE_MAX_BYTES);
  }

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  get(extensionId: string, key: string): StoreValue | undefined {
    const row = this.db
      .prepare("SELECT value FROM plugin_kv WHERE extension_id = ? AND key = ?")
      .get(extensionId, key) as { value: string } | undefined;
    if (!row) return undefined;
    return parseValue(row.value);
  }

  set(extensionId: string, key: string, value: StoreValue): void {
    checkKey(key);
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new PersonalStoreError(`"${key}" is not a JSON value`);
    }
    const bytes = Buffer.byteLength(json);
    if (bytes > PERSONAL_STORE_VALUE_MAX_BYTES) {
      throw new PersonalStoreError(
        `"${key}" is ${bytes} bytes of JSON; a value may be at most ${PERSONAL_STORE_VALUE_MAX_BYTES}`,
      );
    }
    const current = this.bytesOf(extensionId, key);
    const cap = this.sliceCap(extensionId);
    if (current + bytes > cap) {
      throw new PersonalStoreError(
        `writing "${key}" would take the store past ${cap} bytes ` +
          `(${current} used by other keys); delete something first`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO plugin_kv (extension_id, key, value, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(extension_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(extensionId, key, json, this.now());
    this.notify(extensionId, key);
  }

  delete(extensionId: string, key: string): void {
    const result = this.db
      .prepare("DELETE FROM plugin_kv WHERE extension_id = ? AND key = ?")
      .run(extensionId, key);
    if (result.changes > 0) this.notify(extensionId, key);
  }

  list(extensionId: string, prefix = ""): StoreEntry[] {
    const rows = this.db
      .prepare(
        "SELECT key, value, updated_at FROM plugin_kv WHERE extension_id = ? AND key >= ? AND key < ? ORDER BY key",
      )
      .all(extensionId, prefix, `${prefix}￿`) as Row[];
    return rows.map((row) => ({
      key: row.key,
      value: parseValue(row.value),
      updatedAt: row.updated_at,
    }));
  }

  /** Every key an extension holds is gone; one notice per key. */
  clearExtension(extensionId: string): void {
    const rows = this.db
      .prepare("SELECT key FROM plugin_kv WHERE extension_id = ?")
      .all(extensionId) as { key: string }[];
    this.db.prepare("DELETE FROM plugin_kv WHERE extension_id = ?").run(extensionId);
    for (const row of rows) this.notify(extensionId, row.key);
  }

  /**
   * Makes slice `to` an exact copy of slice `from`, in one write and with no
   * notice: the store a draft starts from is its panel's own
   * (docs/personal-panels.md, "Built apart").
   */
  copySlice(from: string, to: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM plugin_kv WHERE extension_id = ?").run(to);
      this.db
        .prepare(
          "INSERT INTO plugin_kv (extension_id, key, value, updated_at) " +
            "SELECT ?, key, value, updated_at FROM plugin_kv WHERE extension_id = ?",
        )
        .run(to, from);
    })();
  }

  /** Every slice that holds a key. */
  slices(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT extension_id FROM plugin_kv ORDER BY extension_id")
        .all() as {
        extension_id: string;
      }[]
    ).map((row) => row.extension_id);
  }

  /** The D-13 purge: every slice. */
  clear(): void {
    this.db.prepare("DELETE FROM plugin_kv").run();
  }

  subscribe(listener: PersonalStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The server side's view of one slice: synchronous and pre-bound. */
  forExtension(extensionId: string): ServerStore {
    return {
      get: (key) => this.get(extensionId, key),
      set: (key, value) => this.set(extensionId, key, value),
      delete: (key) => this.delete(extensionId, key),
      list: (prefix) => this.list(extensionId, prefix),
    };
  }

  /** Bytes of JSON the slice holds, excluding the key about to be written. */
  private bytesOf(extensionId: string, exceptKey: string): number {
    const rows = this.db
      .prepare("SELECT value FROM plugin_kv WHERE extension_id = ? AND key <> ?")
      .all(extensionId, exceptKey) as { value: string }[];
    let total = 0;
    for (const row of rows) total += Buffer.byteLength(row.value);
    return total;
  }

  private notify(extensionId: string, key: string): void {
    for (const listener of this.listeners) listener(extensionId, key);
  }
}

function checkKey(key: string): void {
  if (key.length === 0 || key.length > PERSONAL_STORE_KEY_MAX_LENGTH) {
    throw new PersonalStoreError(
      `a store key is 1 to ${PERSONAL_STORE_KEY_MAX_LENGTH} characters; got ${key.length}`,
    );
  }
}

function parseValue(json: string): StoreValue {
  try {
    return JSON.parse(json) as StoreValue;
  } catch {
    // A row this process did not write; the store never returns garbage.
    return null;
  }
}
