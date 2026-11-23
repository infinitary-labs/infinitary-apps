import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { secretHistorySchema } from "@shared/secrets";
import { z } from "zod";
import type { RuleEffect } from "./authority";
import { canonical, type RootKeys, writePrivateFile } from "./custody";
import type { UseReceipt, UseState } from "./requests";

/** How a use was approved: fresh authentication here, a signed decision elsewhere, or a saved rule. */
/** `sign-in`: the app spent its own sign-in, made in the app, which is the consent. */
export type ApprovalMethod = "local" | "remote" | "rule" | "short-read" | "sign-in";

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
      /**
       * The person gave its keys with the program, which is the consent, so no
       * approval line follows (docs/secrets.md, "Programs that keep running").
       * It rides the request rather than a new approval method, so a build that
       * predates it reads the use as one with no approval.
       */
      given?: true;
      /**
       * The computer that runs work the program ran on, by the name the person
       * knows it by (docs/secrets.md, "On a computer that runs work").
       */
      computer?: string;
      /**
       * A bring, by the asker's word for the other tool (docs/secrets.md,
       * "Bringing secrets from another tool"): its program or file ran or was
       * read, and `secrets` names what it would keep. It rides the request, so
       * a build that predates it reads the bring as a use with no approval.
       */
      brought?: string;
    }
  | { kind: "approved"; request: string; method: ApprovalMethod; device?: string }
  /** Written and synced before the recipient starts; the effect may follow. */
  | { kind: "consumed"; request: string }
  | { kind: "completed"; request: string; exitCode?: number }
  /** `reconciled` marks a state the owner settled at its next open, not one it watched happen. */
  | { kind: "ended"; request: string; state: EndState; reconciled?: true };

type Line = { seq: number; at: number; entry: JournalEntry; mac: string };

export type HistoryItem = {
  request: string;
  intent: string;
  program: string;
  secrets: string[];
  reason: string;
  requestedAt: number;
  state: UseState;
  exitCode?: number;
  approval?: Exclude<ApprovalMethod, "sign-in">;
  /** An app sign-in covered it (docs/secrets.md, "App sign-ins"); no one approved it. */
  signIn?: true;
  /** The person gave its keys with the program (docs/secrets.md, "Programs that keep running"); no one approved it. */
  given?: true;
  /** The computer that runs work the program ran on, when it was not this one. */
  computer?: string;
  /** A bring, by the tool it brought secrets from (docs/secrets.md, "Bringing secrets from another tool"). */
  brought?: string;
  device?: string;
  reconciled?: true;
  recoveredFrom?: string;
  recoveredAt?: number;
};

const recoveredSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    home: z.string(),
    at: z.number(),
    uses: z.array(secretHistorySchema),
  }),
);
export type RecoveredHistory = z.infer<typeof recoveredSchema>[number];
export type JournalSnapshot = {
  entries: Pick<Line, "at" | "entry">[];
  recovered: RecoveredHistory[];
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
  private recovered: RecoveredHistory[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  /** A partial deletion may have removed the chain on disk; never append to that uncertain state. */
  private writable = true;
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
    await journal.loadRecovered();
    await journal.reconcile();
    return journal;
  }

  /** A verified snapshot taken after the coordinator has paused and drained its uses. */
  async snapshot(): Promise<JournalSnapshot> {
    await this.writing;
    return structuredClone({
      entries: this.lines.map(({ at, entry }) => ({ at, entry })),
      recovered: this.recovered,
    });
  }

  /**
   * Re-key local history without replaying it; archive history remains a
   * separate read-only collection. Starting over imports no archive, so it
   * adds no collection and keeps only the ones already recovered.
   */
  static async restore(
    dir: string,
    keys: RootKeys,
    snapshot: JournalSnapshot,
    recovered?: RecoveredHistory,
  ): Promise<void> {
    const journal = new UseJournal(join(dir, "history.jsonl"), keys, Date.now);
    for (const { at, entry } of snapshot.entries) await journal.appendAt(entry, at);
    const collections = recoveredSchema.parse(
      recovered ? [...snapshot.recovered, recovered] : snapshot.recovered,
    );
    if (collections.length === 0) return;
    await writePrivateFile(
      join(dir, "history.recovered.json"),
      JSON.stringify({
        collections,
        mac: keys.mac("journal", `recovered-history:${canonical(collections)}`),
      }),
    );
  }

  /** Append and sync. Rejects when the line could not be made durable. */
  append(entry: JournalEntry): Promise<void> {
    return this.appendAt(entry, this.now());
  }

  private appendAt(entry: JournalEntry, at: number): Promise<void> {
    const work = this.writing.then(async () => {
      if (!this.writable) throw new Error("Secrets history is unavailable.");
      const line = { seq: this.lines.length, at, entry };
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
    return [
      ...this.liveHistory(),
      ...this.recovered.flatMap((collection) =>
        collection.uses.map((item) => ({
          ...item,
          request: `recovered:${collection.id}:${item.request}`,
          recoveredFrom: item.recoveredFrom ?? collection.home,
          recoveredAt: item.recoveredAt ?? collection.at,
        })),
      ),
    ];
  }

  private liveHistory(): HistoryItem[] {
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
          ...(entry.given ? { given: true as const } : {}),
          ...(entry.computer ? { computer: entry.computer } : {}),
          ...(entry.brought ? { brought: entry.brought } : {}),
        });
        continue;
      }
      const item = items.get(entry.request);
      if (!item) continue;
      if (entry.kind === "approved") {
        if (entry.method === "sign-in") item.signIn = true;
        else item.approval = entry.method;
        if (entry.device) item.device = entry.device;
      } else if (entry.kind === "consumed") item.state = "executing";
      else if (entry.kind === "completed") {
        item.state = "completed";
        if (entry.exitCode !== undefined) item.exitCode = entry.exitCode;
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
    return this.liveHistory().map((item) => ({
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
    for (const path of [
      this.path,
      join(dirname(this.path), "history.recovered.json"),
      ...(await this.setAside()),
    ]) {
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
   * The captain's deletion shares the append writer. Pending and running uses
   * keep their request metadata, so a later outcome still has its durable identity.
   * The protected owner supplies retained history paths from earlier generations.
   */
  clear(retained: readonly string[] = []): Promise<"cleared" | "busy"> {
    const paths = [...retained];
    const work = this.writing.then(async (): Promise<"cleared" | "busy"> => {
      if (this.liveHistory().some((item) => item.state === "waiting" || item.state === "executing"))
        return "busy";
      try {
        for (const path of new Set([
          this.path,
          join(dirname(this.path), "history.recovered.json"),
          ...(await this.setAside()),
          ...paths,
        ]))
          await rm(path, { force: true });
        this.recovered = [];
        this.lines = [];
        this.lastMac = "";
        this.broken = false;
        this.writable = true;
        return "cleared";
      } catch (error) {
        this.writable = false;
        throw error;
      }
    });
    this.writing = work.catch(() => {});
    return work;
  }

  private async loadRecovered(): Promise<void> {
    const path = join(dirname(this.path), "history.recovered.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return;
    }
    try {
      const stored = JSON.parse(text);
      const parsed = recoveredSchema.safeParse(stored.collections);
      if (
        parsed.success &&
        this.keys.verify("journal", `recovered-history:${canonical(parsed.data)}`, stored.mac)
      ) {
        this.recovered = parsed.data;
        return;
      }
    } catch {
      /* Keep unreadable history rather than trusting it or deleting it. */
    }
    this.broken = true;
    await rename(path, join(dirname(path), `history.unreadable-recovered-${randomUUID()}.jsonl`));
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
    for (const item of this.liveHistory()) {
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
