import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RuleEffect } from "./authority";
import { canonical, type RootKeys } from "./custody";
import type { UseReceipt, UseState } from "./requests";

/** How a use was approved: fresh authentication here, a signed decision elsewhere, or a saved rule. */
export type ApprovalMethod = "local" | "remote" | "rule";

/** States a use can end in without launching, and the two a launch can end in. */
export type EndState = Exclude<UseState, "waiting" | "executing" | "completed">;

/**
 * Metadata only (docs/secrets.md, "History"): never a value, an environment
 * or a full request body. `program` is the bound executable's path and
 * `reason` the requester's own explanation, shown as theirs.
 */
export type JournalEntry =
  | {
      kind: "requested";
      request: string;
      intent: string;
      inputDigest: string;
      digest: string;
      secrets: string[];
      program: string;
      reason: string;
      rule: RuleEffect;
    }
  | { kind: "approved"; request: string; method: ApprovalMethod; device?: string }
  /** Written and synced before the recipient starts; the effect may follow. */
  | { kind: "consumed"; request: string }
  | { kind: "completed"; request: string; exitCode: number }
  /** `reconciled` marks a state the owner settled at its next open, not one it watched happen. */
  | { kind: "ended"; request: string; state: EndState; reconciled?: true };

type Line = { seq: number; at: number; entry: JournalEntry; mac: string };

/** One use as history shows it. */
export type HistoryItem = {
  request: string;
  intent: string;
  program: string;
  secrets: string[];
  reason: string;
  requestedAt: number;
  state: UseState;
  exitCode?: number;
  approval?: ApprovalMethod;
  device?: string;
  reconciled?: true;
};

/**
 * The durable use journal (docs/secrets.md, "Journal and reconciliation").
 * Each line is synced before the call returns, and each carries a check
 * chained to the line before it, so a forged or edited line ends what is read.
 * `consumed` is written before any launch; a journal that cannot be written
 * refuses the launch. At open, a use consumed with no recorded end becomes
 * `unknown` - its effect may have happened - and a use still waiting becomes
 * `invalidated`. Nothing is ever replayed. It keeps history until the captain
 * deletes it; it is local evidence, not an immutable audit log, and truncating
 * its last lines is not detected.
 */
export class UseJournal {
  private lines: Line[] = [];
  private lastMac = "";
  private writing: Promise<unknown> = Promise.resolve();
  /** True when a line failed its check: the lines after it were not read. */
  broken = false;

  private constructor(
    private readonly path: string,
    private readonly keys: RootKeys,
    private readonly now: () => number,
  ) {}

  static async open(
    dir: string,
    keys: RootKeys,
    now: () => number = Date.now,
  ): Promise<UseJournal> {
    const journal = new UseJournal(join(dir, "history.jsonl"), keys, now);
    await journal.load();
    await journal.reconcile();
    return journal;
  }

  /** Append and sync. Rejects when the line could not be made durable. */
  append(entry: JournalEntry): Promise<void> {
    const work = this.writing.then(async () => {
      const line = { seq: this.lines.length, at: this.now(), entry };
      const mac = this.keys.mac("journal", this.lastMac + canonical(line));
      const full: Line = { ...line, mac };
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(full)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.lines.push(full);
      this.lastMac = mac;
    });
    this.writing = work.catch(() => {});
    return work;
  }

  history(): HistoryItem[] {
    const items = new Map<string, HistoryItem>();
    for (const { at, entry } of this.lines) {
      if (entry.kind === "requested") {
        items.set(entry.request, {
          request: entry.request,
          intent: entry.intent,
          program: entry.program,
          secrets: entry.secrets,
          reason: entry.reason,
          requestedAt: at,
          state: "waiting",
        });
        continue;
      }
      const item = items.get(entry.request);
      if (!item) continue;
      if (entry.kind === "approved") {
        item.approval = entry.method;
        if (entry.device) item.device = entry.device;
      } else if (entry.kind === "consumed") item.state = "executing";
      else if (entry.kind === "completed") {
        item.state = "completed";
        item.exitCode = entry.exitCode;
      } else {
        item.state = entry.state;
        if (entry.reconciled) item.reconciled = true;
      }
    }
    return [...items.values()];
  }

  /** Settled receipts and the intents that named them, so a restart never runs an intent again. */
  restored(): { intent: string; inputDigest: string; receipt: UseReceipt }[] {
    const digests = new Map<string, string>();
    for (const { entry } of this.lines)
      if (entry.kind === "requested") digests.set(entry.request, entry.inputDigest);
    return this.history().map((item) => ({
      intent: item.intent,
      inputDigest: digests.get(item.request) ?? "",
      receipt: {
        request: item.request,
        state: item.state,
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      },
    }));
  }

  /** Bytes this history takes on disk, set-aside unreadable copies included, for the storage-use display. */
  async storageUse(): Promise<number> {
    let bytes = 0;
    for (const path of [this.path, ...(await this.setAside())]) {
      try {
        bytes += (await stat(path)).size;
      } catch {
        // Gone since it was listed.
      }
    }
    return bytes;
  }

  /** The history as the captain exports it: metadata only. */
  export(): string {
    return `${JSON.stringify({ exportedAt: this.now(), uses: this.history() }, null, 2)}\n`;
  }

  /**
   * The captain's deletion. Refused while a launched use has no recorded end,
   * so deleting history can never hide an outcome that is still unknown.
   */
  async clear(): Promise<"cleared" | "busy"> {
    await this.writing;
    if (this.history().some((item) => item.state === "executing")) return "busy";
    for (const path of [this.path, ...(await this.setAside())]) await rm(path, { force: true });
    this.lines = [];
    this.lastMac = "";
    this.broken = false;
    return "cleared";
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    const rows = text.split("\n").filter((row) => row.length > 0);
    for (const row of rows) {
      let line: Line;
      try {
        line = JSON.parse(row) as Line;
      } catch {
        this.broken = true;
        break;
      }
      const { mac, ...rest } = line;
      if (
        line.seq !== this.lines.length ||
        !this.keys.verify("journal", this.lastMac + canonical(rest), mac)
      ) {
        this.broken = true;
        break;
      }
      this.lines.push(line);
      this.lastMac = mac;
    }
    if (this.broken) {
      // Keep the readable prefix and continue the chain from it. The whole file
      // is set aside unchanged, so what failed its check is still there to read.
      await rename(this.path, join(dirname(this.path), `history.unreadable-${this.now()}.jsonl`));
      const kept = this.lines.map((line) => JSON.stringify(line)).join("\n");
      const handle = await open(this.path, "w", 0o600);
      try {
        await handle.write(kept.length > 0 ? `${kept}\n` : "");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private async setAside(): Promise<string[]> {
    const dir = dirname(this.path);
    try {
      return (await readdir(dir))
        .filter((name) => name.startsWith("history.unreadable-") && name.endsWith(".jsonl"))
        .map((name) => join(dir, basename(name)));
    } catch {
      return [];
    }
  }

  private async reconcile(): Promise<void> {
    for (const item of this.history()) {
      if (item.state === "executing")
        await this.append({
          kind: "ended",
          request: item.request,
          state: "unknown",
          reconciled: true,
        });
      else if (item.state === "waiting")
        await this.append({
          kind: "ended",
          request: item.request,
          state: "invalidated",
          reconciled: true,
        });
    }
  }
}
