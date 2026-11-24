import { type FSWatcher, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import type { CustomApiFileView, CustomFileConnection } from "@shared/customApiFile";
import type { SettingsStore } from "../storage/settingsStore";
import type { AccountVault } from "./accountVault";
import { readCustomApiFile } from "./customApiFile";

/** A models.json is a few kilobytes; a larger file is not one. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Editors and sync apps write a file in several steps; read once they settle. */
const SETTLE_MS = 250;

/**
 * The connection file this computer reads custom connections from. It reads
 * at launch without holding it up, whenever the file or its folder changes,
 * and when a file is chosen. It never writes the file. A read that fails
 * keeps the last good one, so a half-synced or briefly missing file pauses
 * and forgets nothing; only a good reading reaches `apply`.
 */
export class CustomApiFileSource {
  private connections: CustomFileConnection[] = [];
  /** Whether the chosen file has had a good reading yet. */
  private goodReading = false;
  private failure?: CustomApiFileView["failure"];
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  /** Bumped by each new path and each close, so a read of an older one lands nowhere. */
  private generation = 0;
  private closed = false;

  constructor(
    private readonly options: {
      path: () => string | null;
      save: (path: string | null) => void;
      /** Each good reading's connections; null when no file is chosen, which holds nothing. */
      apply: (connections: CustomFileConnection[] | null) => void;
    },
  ) {}

  start(): void {
    this.follow();
  }

  view(): CustomApiFileView {
    return {
      path: this.options.path(),
      ...(this.failure ? { failure: this.failure } : {}),
      connections: this.connections,
    };
  }

  /** Chooses the file (null for none) and reads it now. A path must be absolute. */
  async set(path: string | null): Promise<CustomApiFileView> {
    if (path !== null && !isAbsolute(path)) throw new Error("Choose the file by its full path.");
    this.options.save(path);
    this.connections = [];
    this.goodReading = false;
    this.failure = undefined;
    if (path === null) this.options.apply(null);
    await this.follow();
    return this.view();
  }

  /** Applies the last good reading again, such as once a connection from it is saved. */
  reapply(): void {
    if (this.options.path() !== null && this.goodReading) this.options.apply(this.connections);
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
  }

  private follow(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const path = this.options.path();
    if (this.closed || path === null) return Promise.resolve();
    try {
      // The folder, not the file: editors and sync apps replace a file, which ends a watch on it.
      this.watcher = watch(dirname(path), (_event, name) => {
        if (name !== null && name !== basename(path)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.read(path, generation), SETTLE_MS);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // A folder that is not there yet is read as a missing file below.
    }
    return this.read(path, generation);
  }

  private async read(path: string, generation: number): Promise<void> {
    let text: string;
    try {
      const facts = await stat(path);
      if (!facts.isFile() || facts.size > MAX_FILE_BYTES) throw new Error("not a file");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (generation !== this.generation) return;
      this.failure = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
      return;
    }
    if (generation !== this.generation) return;
    const reading = readCustomApiFile(text);
    if (reading.failure) {
      this.failure = reading.failure;
      return;
    }
    this.failure = undefined;
    this.connections = reading.connections;
    this.goodReading = true;
    this.options.apply(this.connections);
  }
}

/**
 * Starts following the chosen file: each good reading updates the
 * connections approved from it now, and `changed` runs again once the model
 * checks it started settle.
 */
export function followCustomApiFile(
  settings: Pick<SettingsStore, "getCustomApiFile" | "setCustomApiFile">,
  vault: Pick<AccountVault, "applyCustomFile">,
  changed: () => void,
): CustomApiFileSource {
  const source = new CustomApiFileSource({
    path: () => settings.getCustomApiFile(),
    save: (path) => settings.setCustomApiFile(path),
    apply: (connections) => {
      const checks = vault.applyCustomFile(connections);
      changed();
      if (checks.length) void Promise.allSettled(checks).then(changed);
    },
  });
  source.start();
  return source;
}
