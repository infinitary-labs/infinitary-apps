import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import {
  SECRET_BRING_CARD_WORDS,
  type SecretBringAnswer,
  type SecretBringInput,
  type SecretBringOffer,
} from "@shared/secretBring";
import { z } from "zod";
import { bringCardBody, bringCardId, bringCardTitle } from "./bringCard";
import { readJson } from "./bringJson";
import type { SourceOutput } from "./bringOutput";
import {
  type BringReads,
  type ReadValue,
  readEnv0,
  readLines,
  readValue,
  zeroFill,
} from "./bringReaders";
import { type BoundSource, type BringSourceInput, bindSource, readSource } from "./bringSource";
import { type PreparedBringUnlock, prepareBringUnlock, validBringUses } from "./bringUnlock";
import { SECRET_BRING_WORDS } from "./commandWords";
import { canonical, sha256 } from "./custody";
import type { ProtectedSecrets } from "./protected";
import { SECRET_REQUEST_LIFETIME_MS } from "./requests";
import { newReference } from "./settings";

/**
 * Bringing secrets from another tool (docs/secrets.md, "Bringing secrets
 * from another tool"; INF-4718's plan, piece 1): the reverse of `inject`. A
 * crewmate names a source - a program to run, or a file to read - how its
 * output holds secrets, and the names it wants, never a value. Infinitary
 * raises its own card; on the captain's press it runs or reads the source
 * itself, reads the output through a pipe into buffers inside this
 * process, seals each ticked value with `putSecret`, fills every buffer
 * with zeros, and tells the crewmate names, references and outcomes once.
 */
export type SecretBringRequest = {
  /** The asker's own id for this bring: bringing again with it while it waits raises nothing new. */
  id: string;
  reason: string;
  from: {
    /** The asker's word for the other tool, shown on the card as theirs. */
    tool: string;
    source: BringSourceInput;
    reads: BringReads;
    /**
     * Each secret by the name the source gives it, with the name and place
     * it is kept under, or the reference of a kept secret it replaces.
     * Required for `value` (exactly one), `env0` and `json`; leaving it out of
     * `lines` brings every name the source holds, listed after a first read.
     */
    secrets?: { name: string; as?: string; place?: string; replace?: string }[];
    /** `value` only: drop one line end at the very end of the output. */
    trim?: "newline";
    /** Environment variable to kept secret reference; only for a run with named fields. */
    uses?: Record<string, string>;
  };
};

/** How one secret of a bring ended. Never a value. */
export type BringOutcome =
  | "kept"
  | "skipped"
  | "not-found"
  | "empty"
  | "too-large"
  | "not-text"
  | "changed";

export type BroughtSecret = {
  name: string;
  place: string;
  outcome: BringOutcome;
  ref?: string;
  version?: number;
};

/** What a bring answers at once. */
export type SecretBringStarted =
  | { bring: string; state: "waiting" }
  | { bring: string; state: "unavailable"; help: string };

/** What the asker hears once, through its inbox, when the bring ends; `status` reads the same. */
export type SecretBringEnded =
  /** The source ran and each named secret has its outcome. */
  | { bring: string; state: "kept"; secrets: BroughtSecret[] }
  /** The captain chose Don't bring. */
  | { bring: string; state: "not-brought" }
  /** The source failed: its exit code or signal, never its output. */
  | { bring: string; state: "failed"; exitCode?: number; signal?: string; why: string }
  /** The program or file changed since the card showed it: nothing ran or was kept. */
  | { bring: string; state: "changed" }
  | { bring: string; state: "expired" }
  | { bring: string; state: "withdrawn"; why: string };

export type SecretBringStatus = { bring: string; state: "waiting" } | SecretBringEnded;

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Words with something in them and no NUL; the command channel already bounds the whole request. */
const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
const only = (value: object, keys: string[]) => Object.keys(value).every((k) => keys.includes(k));

/** A well-formed bring: one closed shape, refused when anything else is present. */
export function validSecretBring(input: SecretBringRequest): boolean {
  if (!input || typeof input !== "object" || !only(input, ["id", "reason", "from"])) return false;
  if (typeof input.id !== "string" || !REFERENCE.test(input.id)) return false;
  if (!filled(input.reason)) return false;
  const from = input.from;
  if (!from || typeof from !== "object") return false;
  if (!only(from, ["tool", "source", "reads", "secrets", "trim", "uses"])) return false;
  if (!filled(from.tool)) return false;
  if (!["value", "lines", "env0", "json"].includes(from.reads)) return false;
  if (from.trim !== undefined && (from.trim !== "newline" || from.reads !== "value")) return false;
  const source = from.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return false;
  if ("file" in source) {
    if (!only(source, ["file"]) || !filled(source.file)) return false;
    if (!(source.file as string).startsWith("/")) return false;
  } else {
    if (!only(source, ["run", "folder"]) || !Array.isArray(source.run)) return false;
    if (source.run.length === 0 || source.run.length > 256) return false;
    if (
      !source.run.every(
        (arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"),
      )
    )
      return false;
    if (!filled(source.run[0])) return false;
    if (source.folder !== undefined && !(filled(source.folder) && source.folder.startsWith("/")))
      return false;
  }
  if (
    from.uses !== undefined &&
    ("file" in source ||
      from.secrets === undefined ||
      !validBringUses(from.uses) ||
      !Object.values(from.uses).every((ref) => REFERENCE.test(ref)))
  )
    return false;
  if (from.secrets === undefined) return from.reads === "lines";
  if (!Array.isArray(from.secrets) || from.secrets.length === 0 || from.secrets.length > 1000)
    return false;
  if (from.reads === "value" && from.secrets.length !== 1) return false;
  const kept = new Set<string>();
  const named = new Set<string>();
  for (const secret of from.secrets) {
    if (!secret || typeof secret !== "object") return false;
    if (!only(secret, ["name", "as", "place", "replace"])) return false;
    if (!filled(secret.name)) return false;
    if (secret.as !== undefined && !filled(secret.as)) return false;
    if (
      secret.place !== undefined &&
      (typeof secret.place !== "string" || secret.place.length > 256)
    )
      return false;
    if (secret.replace !== undefined) {
      if (typeof secret.replace !== "string" || !REFERENCE.test(secret.replace)) return false;
      if (secret.as !== undefined || secret.place !== undefined) return false;
    }
    if (named.has(secret.name)) return false;
    named.add(secret.name);
    const key =
      secret.replace ?? `${(secret.as ?? secret.name).trim()}\0${secret.place?.trim() ?? ""}`;
    if (kept.has(key)) return false;
    kept.add(key);
  }
  return true;
}

const boundFileSchema = z.strictObject({ path: z.string(), sha256: z.string() });
const rowSchema = z.strictObject({
  id: z.string(),
  /** The name the source gives it. */
  source: z.string(),
  name: z.string(),
  place: z.string(),
  replaces: z
    .strictObject({ ref: z.string(), version: z.number(), revision: z.string() })
    .optional(),
  ticked: z.boolean(),
  cannot: z.enum(["empty", "too-large", "not-text"]).optional(),
});
const bringSchema = z.strictObject({
  key: z.string(),
  task: z.string(),
  id: z.string(),
  reason: z.string(),
  tool: z.string(),
  at: z.number(),
  reads: z.enum(["value", "lines", "env0", "json"]),
  unlocks: z
    .array(
      z.strictObject({
        name: z.string(),
        ref: z.string(),
        label: z.string(),
        version: z.number(),
        place: z.string().optional(),
      }),
    )
    .optional(),
  trim: z.literal("newline").optional(),
  source: z.union([
    z.strictObject({
      kind: z.literal("run"),
      program: boundFileSchema,
      interpreter: boundFileSchema.extend({ arg: z.string().optional() }).strict().optional(),
      argv: z.array(z.string()),
      folder: z.string(),
    }),
    z.strictObject({ kind: z.literal("file"), file: boundFileSchema }),
  ]),
  /** Null until a read of `lines` with no named secrets lists what the source holds. */
  rows: z.array(rowSchema).nullable(),
});
type BringRow = z.infer<typeof rowSchema>;
export type WaitingBring = z.infer<typeof bringSchema>;
const bookSchema = z.strictObject({ brings: z.array(bringSchema) });

/**
 * The brings still waiting for the captain, kept beside Secrets in one
 * small file (`<userData>/secret-brings.json`) only so a restart can end
 * each one and tell its asker. It holds names, places, the bound source and
 * reasons, never a value. `SecretBrings` is its one writer.
 */
class SecretBringBook {
  private readonly brings = new Map<string, WaitingBring>();

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const parsed = bookSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) for (const one of parsed.data.brings) this.brings.set(one.key, one);
    } catch {
      // No file yet, or one this build cannot read: no bring waits.
    }
  }

  get(key: string) {
    return this.brings.get(key);
  }

  all(): WaitingBring[] {
    return [...this.brings.values()].sort((a, b) => a.at - b.at);
  }

  put(bring: WaitingBring): void {
    this.brings.set(bring.key, bring);
    this.save();
  }

  drop(key: string): WaitingBring | undefined {
    const bring = this.brings.get(key);
    if (!bring) return undefined;
    this.brings.delete(key);
    this.save();
    return bring;
  }

  private save(): void {
    if (!this.file) return;
    if (this.brings.size === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    writeFileSync(next, `${JSON.stringify({ brings: this.all() })}\n`, { mode: 0o600 });
    renameSync(next, this.file);
  }
}

export type SecretBringsOptions = {
  /** The protected owner, opened (and set up first when `initialize`), or none where it cannot open. */
  owner: (initialize?: boolean) => Promise<ProtectedSecrets | undefined>;
  /** Whether Secrets is offered here at all. */
  offered: boolean;
  /** The base environment a source starts from; only the recipient's base variables are kept. */
  environment: () => NodeJS.ProcessEnv;
  raise: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
  withdraw: (id: string, reason: string) => void;
  /** Secrets' page changed: something was kept. */
  changed: () => void;
  /** A bring ended: its asking task hears once through its inbox, never a value. */
  brought: (task: string, ended: SecretBringEnded) => void;
  taskOpen?: (task: string) => boolean;
  taskTitle?: (task: string) => string | undefined;
  /** Where waiting brings are kept so a restart ends them; none keeps them in memory. */
  file?: string;
  now?: () => number;
  /** How long a bring waits for the captain, and its source may run; the request lifetime by default. */
  lifetimeMs?: number;
};

type Offer = { key: string; kind: "bring" | "read" | "dont" };

/** The command a task's shell reaches for brings (`infinitary-secrets-axi bring`). */
export type SecretBringCommand = {
  bring: (input: SecretBringRequest, cwd?: string) => Promise<SecretBringStarted>;
  bringStatus: (id: string) => SecretBringStatus | undefined;
  cancelBring: (id: string) => boolean;
};

/**
 * The one owner of brings. Its passes are process-local and single-use, as
 * every Secrets card's are; the values a read holds stay in this process
 * only until they are sealed, the captain says Don't bring or the bring
 * expires, and are then filled with zeros. A bring whose task closes ends by
 * its expiry; its press finds the task closed and reads nothing.
 */
export class SecretBrings {
  private readonly book: SecretBringBook;
  private readonly offers = new Map<string, Offer>();
  /** What a read of `lines` with no named secrets found, by bring, until the captain picks. */
  private readonly held = new Map<string, Map<string, ReadValue>>();
  private readonly unlocks = new Map<string, PreparedBringUnlock>();
  private readonly ended = new Map<string, SecretBringEnded>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Brings whose press is running: a second press does nothing. */
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly lifetime: number;

  constructor(private readonly options: SecretBringsOptions) {
    this.book = new SecretBringBook(options.file);
    this.now = options.now ?? Date.now;
    this.lifetime = options.lifetimeMs ?? SECRET_REQUEST_LIFETIME_MS;
  }

  static key(task: string, id: string): string {
    return JSON.stringify(["bring", task, id]);
  }

  /** One task's bring command. The task is the channel's own, never the request's words. */
  commandFor(task: string): SecretBringCommand {
    return {
      bring: (input, cwd) => this.start(task, input, cwd),
      bringStatus: (id) => {
        const key = SecretBrings.key(task, id);
        if (this.book.get(key)) return { bring: id, state: "waiting" };
        return this.ended.get(key);
      },
      cancelBring: (id) => {
        const key = SecretBrings.key(task, id);
        // A press already running cannot be called back: its outcome reaches the inbox.
        if (!this.book.get(key) || this.running.has(key)) return false;
        this.end(key, { bring: id, state: "withdrawn", why: SECRET_BRING_WORDS.cancelled }, false);
        return true;
      },
    };
  }

  /** Whether this owner made the pass: Don't bring and Read it ride the shared card decision. */
  owns(pass: string): boolean {
    return this.offers.has(pass);
  }

  /**
   * A bring that waited through a restart ends `expired`: its card from the
   * earlier process is inert, and nothing was read or held across it.
   */
  resume(): void {
    for (const bring of this.book.all()) this.end(bring.key, { bring: bring.id, state: "expired" });
  }

  private async start(
    task: string,
    input: SecretBringRequest,
    cwd?: string,
  ): Promise<SecretBringStarted> {
    const copied = structuredClone(input);
    if (!validSecretBring(copied)) throw new Error("Invalid bring.");
    const unavailable = (help: string): SecretBringStarted => ({
      bring: copied.id,
      state: "unavailable",
      help,
    });
    if (!this.options.offered) return unavailable(SECRET_BRING_WORDS.notOffered);
    const key = SecretBrings.key(task, copied.id);
    const waiting = this.book.get(key);
    if (waiting) {
      // A running press raises the card again itself, or ends the bring.
      if (!this.running.has(key)) this.raise(waiting);
      return { bring: copied.id, state: "waiting" };
    }
    const bound = await bindSource(copied.from.source, this.options.environment(), cwd).catch(
      () => "program" as const,
    );
    if (typeof bound === "string") return unavailable(SECRET_BRING_WORDS.refused[bound]);
    const owner = await this.options.owner().catch(() => undefined);
    const state = owner ? await owner.status().catch(() => "unavailable" as const) : "unavailable";
    if (state !== "available" && state !== "uninitialized")
      return unavailable(SECRET_BRING_WORDS.cannotRead);
    const entries =
      state === "available" && owner
        ? (await owner.metadata().catch(() => [])).filter((one) => one.discoverable)
        : [];
    let rows: BringRow[] | null = null;
    if (copied.from.secrets) {
      rows = [];
      for (const secret of copied.from.secrets) {
        const id = `s${rows.length + 1}`;
        if (secret.replace !== undefined) {
          const entry = entries.find((one) => one.ref === secret.replace);
          if (!entry) return unavailable(SECRET_BRING_WORDS.noSuchSecret);
          rows.push({
            id,
            source: secret.name,
            name: entry.label,
            place: entry.environment ?? "",
            replaces: { ref: entry.ref, version: entry.version, revision: entry.revision },
            ticked: false,
          });
          continue;
        }
        const name = (secret.as ?? secret.name).trim();
        const place = secret.place?.trim() ?? "";
        rows.push(this.row(id, secret.name, name, place, entries));
      }
    }
    const prepared =
      copied.from.uses && owner && state === "available" && bound.kind === "run"
        ? await prepareBringUnlock(
            owner,
            bound,
            copied.from.uses,
            copied.reason,
            key,
            this.lifetime,
            () => {
              const entry = this.book.get(key);
              return (
                !!entry &&
                this.now() < entry.at + this.lifetime &&
                this.running.has(key) &&
                (!this.options.taskOpen || this.options.taskOpen(task))
              );
            },
          ).catch(() => undefined)
        : undefined;
    if (copied.from.uses && !prepared) return unavailable(SECRET_BRING_WORDS.unlockUnavailable);
    const existing = this.book.get(key);
    if (existing) {
      await prepared?.use.dispose("cancelled").catch(() => undefined);
      return { bring: copied.id, state: "waiting" };
    }
    const unlocks =
      prepared &&
      Object.entries(prepared.described.facts.env).flatMap(([name, ref]) => {
        const entry = prepared.described.secrets.find((one) => one.ref === ref);
        return entry
          ? [{ name, ref, label: entry.label, version: entry.version, place: entry.environment }]
          : [];
      });
    const bring: WaitingBring = {
      key,
      task,
      id: copied.id,
      reason: copied.reason.trim(),
      tool: copied.from.tool.trim(),
      at: this.now(),
      reads: copied.from.reads,
      ...(copied.from.trim ? { trim: copied.from.trim } : {}),
      source: bound,
      ...(unlocks ? { unlocks } : {}),
      rows,
    };
    this.ended.delete(key);
    this.book.put(bring);
    if (prepared) this.unlocks.set(key, prepared);
    this.arm(key);
    this.raise(bring);
    return { bring: copied.id, state: "waiting" };
  }

  /** A row for one name, unticked when Secrets already keeps that name and place. */
  private row(
    id: string,
    source: string,
    name: string,
    place: string,
    entries: Awaited<ReturnType<ProtectedSecrets["metadata"]>>,
  ): BringRow {
    const kept = entries.find((one) => one.label === name && (one.environment ?? "") === place);
    return {
      id,
      source,
      name,
      place,
      ...(kept
        ? { replaces: { ref: kept.ref, version: kept.version, revision: kept.revision } }
        : {}),
      ticked: !kept,
    };
  }

  /** The bring ends `expired` once it has waited its lifetime. */
  private arm(key: string): void {
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      const bring = this.book.get(key);
      if (bring && !this.running.has(key)) this.end(key, { bring: bring.id, state: "expired" });
    }, this.lifetime);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private raise(bring: WaitingBring, notice?: string): void {
    for (const [id, offer] of this.offers) if (offer.key === bring.key) this.offers.delete(id);
    const words = SECRET_BRING_CARD_WORDS;
    const dont = randomUUID();
    const go = randomUUID();
    this.offers.set(dont, { key: bring.key, kind: "dont" });
    const reading = bring.rows === null;
    this.offers.set(go, { key: bring.key, kind: reading ? "read" : "bring" });
    const rows = bring.rows ?? [];
    const offer: SecretBringOffer = {
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.source !== row.name ? { source: row.source } : {}),
        ...(row.place ? { place: row.place } : {}),
        ...(row.replaces
          ? { replaces: { ref: row.replaces.ref, version: row.replaces.version } }
          : {}),
        ticked: row.ticked,
        ...(row.cannot ? { cannot: row.cannot } : {}),
      })),
    };
    const pickable = rows.length > 0;
    this.options.raise({
      id: bringCardId(bring.task, bring.id),
      title: bringCardTitle(bring),
      body: bringCardBody(bring, notice),
      // Its crewmate answers a reply under the card, and the head names its task.
      meta: this.options.taskTitle?.(bring.task) ?? FIRSTMATE_CARD_META,
      answeredBy: "crewmate",
      taskId: bring.task,
      actions: [
        {
          id: dont,
          label: words.dontBring,
          variant: "ghost" as const,
          declines: true,
          effect: { kind: "host" as const, op: "secrets-decision" as const, arg: dont },
        },
        ...(reading
          ? [
              {
                id: go,
                label: words.read,
                default: true,
                variant: "primary" as const,
                effect: { kind: "host" as const, op: "secrets-decision" as const, arg: go },
              },
            ]
          : pickable
            ? [
                {
                  id: go,
                  label: words.bring,
                  default: true,
                  variant: "primary" as const,
                  effect: {
                    kind: "host" as const,
                    op: "secrets-bring" as const,
                    arg: JSON.stringify(offer),
                  },
                },
              ]
            : []),
      ],
    });
  }

  /**
   * Don't bring, or Read it, from the card's chrome (`secrets-decision`).
   * Bring into Secrets never comes here: it rides `inf:secrets:bring` with
   * the ticked rows.
   */
  async decide(pass: string): Promise<void> {
    const offer = this.offers.get(pass);
    if (!offer || offer.kind === "bring") return;
    const bring = this.book.get(offer.key);
    if (!bring || this.running.has(bring.key)) return;
    if (offer.kind === "dont") {
      this.end(bring.key, { bring: bring.id, state: "not-brought" });
      return;
    }
    if (!this.taskStillOpen(bring)) return;
    this.running.add(bring.key);
    for (const [id, one] of this.offers) if (one.key === bring.key) this.offers.delete(id);
    try {
      const owner = await this.options.owner(true).catch(() => undefined);
      // The read runs the source too, so What happened lists it, keeping nothing.
      const use = owner ? await journaled(owner, bring, [], []).catch(() => undefined) : undefined;
      if (!use) {
        this.reraise(bring, SECRET_BRING_CARD_WORDS.unavailable);
        return;
      }
      const read = await this.readOnce(bring);
      await use.ended("values" in read ? undefined : read.ended);
      if (!("values" in read)) {
        this.end(bring.key, read.ended);
        return;
      }
      const entries = owner
        ? (await owner.metadata().catch(() => [])).filter((one) => one.discoverable)
        : [];
      const rows: BringRow[] = [];
      for (const [name, value] of read.values) {
        const row = this.row(`s${rows.length + 1}`, name, name, "", entries);
        if (!Buffer.isBuffer(value)) rows.push({ ...row, ticked: false, cannot: value });
        else rows.push(row);
      }
      if (rows.length === 0) {
        zeroFill(read.values.values());
        this.end(bring.key, { bring: bring.id, state: "kept", secrets: [] });
        return;
      }
      this.held.set(bring.key, read.values);
      const next = { ...bring, rows };
      this.book.put(next);
      // The values a read holds wait one lifetime more, then go.
      this.arm(bring.key);
      this.raise(next, SECRET_BRING_CARD_WORDS.found(rows.length));
    } finally {
      this.running.delete(bring.key);
    }
  }

  private taskStillOpen(bring: WaitingBring): boolean {
    if (!this.options.taskOpen || this.options.taskOpen(bring.task)) return true;
    this.end(bring.key, { bring: bring.id, state: "withdrawn", why: SECRET_BRING_WORDS.closed });
    return false;
  }

  /** Runs or reads the source once and reads its output by the bring's shape. */
  private async readOnce(
    bring: WaitingBring,
    captured?: SourceOutput,
  ): Promise<{ values: Map<string, ReadValue> } | { ended: SecretBringEnded }> {
    const output =
      captured ??
      (await readSource(
        bring.source as BoundSource,
        this.options.environment(),
        this.lifetime,
      ).catch(() => ({ failed: {} }) as const));
    if (output === "changed") return { ended: { bring: bring.id, state: "changed" } };
    if (output === "too-large")
      return {
        ended: { bring: bring.id, state: "failed", why: SECRET_BRING_WORDS.tooLarge },
      };
    if ("failed" in output)
      return {
        ended: {
          bring: bring.id,
          state: "failed",
          ...output.failed,
          why: SECRET_BRING_WORDS.failed,
        },
      };
    try {
      if (bring.reads === "json") {
        const values = readJson(output.output, bring.rows?.map((row) => row.source) ?? []);
        return values
          ? { values }
          : { ended: { bring: bring.id, state: "failed", why: SECRET_BRING_WORDS.invalidJson } };
      }
      if (bring.reads === "env0") return { values: readEnv0(output.output) };
      if (bring.reads === "lines") return { values: readLines(output.output) };
      const only = bring.rows?.[0]?.source ?? "";
      return { values: new Map([[only, readValue(output.output, bring.trim)]]) };
    } finally {
      output.output.fill(0);
    }
  }

  /**
   * Bring into Secrets (`inf:secrets:bring`), from the window that shows the
   * card: its pass and the ticked rows, never a value. The pass is spent
   * once storage can take what it keeps; the source runs once (or what a
   * read already holds is used), each ticked value is sealed and every
   * buffer is filled with zeros. The asker hears each outcome once.
   */
  async bringInto(input: SecretBringInput): Promise<SecretBringAnswer> {
    const words = SECRET_BRING_CARD_WORDS;
    const offer = this.offers.get(input.pass);
    const bring = offer?.kind === "bring" ? this.book.get(offer.key) : undefined;
    if (!offer || !bring?.rows) return { brought: false, words: words.gone };
    if (this.running.has(bring.key)) return { brought: false, words: words.gone };
    if (!this.taskStillOpen(bring)) return { brought: false, words: words.closed };
    const picked = new Set(input.picked);
    if (bring.unlocks && !picked.size) return { brought: false, words: words.gone };
    const rows = bring.rows;
    if ([...picked].some((id) => !rows.some((row) => row.id === id && !row.cannot)))
      return { brought: false, words: words.gone };
    const owner = await this.options.owner(true).catch(() => undefined);
    const state = owner ? await owner.status().catch(() => "unavailable" as const) : null;
    if (!owner || state !== "available")
      return { brought: false, words: state === "locked" ? words.locked : words.unavailable };
    // Recheck after the awaits: another press, withdrawal or expiry may have won.
    if (
      this.running.has(bring.key) ||
      this.offers.get(input.pass) !== offer ||
      !this.taskStillOpen(bring)
    )
      return { brought: false, words: words.gone };
    // Spent before anything runs, so a second press in flight does nothing.
    this.running.add(bring.key);
    for (const [id, one] of this.offers) if (one.key === bring.key) this.offers.delete(id);
    let values = this.held.get(bring.key);
    this.held.delete(bring.key);
    let captured: SourceOutput | undefined;
    try {
      const chosen = rows.filter((row) => picked.has(row.id));
      const taken = [
        ...(await owner.metadata()).map((entry) => entry.ref),
        ...(owner.authority()?.rules.map((rule) => rule.secret) ?? []),
        ...owner.history().flatMap((item) => item.secrets),
      ];
      const refs = new Map<string, string>();
      for (const row of chosen) {
        const ref = row.replaces?.ref ?? newReference(row.name, taken);
        taken.push(ref);
        refs.set(row.id, ref);
      }
      const use = await journaled(owner, bring, [...refs.values()], chosen).catch(() => undefined);
      if (!use) {
        this.reraise(bring, words.unavailable);
        return { brought: false, words: words.unavailable };
      }
      if (!values) {
        if (bring.unlocks) {
          const unlocked = await this.captureWithUnlock(owner, bring);
          if ("ended" in unlocked) {
            await use.ended(unlocked.ended);
            this.end(bring.key, unlocked.ended);
            return { brought: true };
          }
          captured = unlocked.output;
        }
        const read = await this.readOnce(bring, captured);
        if (!("values" in read)) {
          await use.ended(read.ended);
          this.end(bring.key, read.ended);
          return { brought: true };
        }
        values = read.values;
      }
      const secrets: BroughtSecret[] = [];
      for (const row of rows) {
        const out = { name: row.name, place: row.place };
        if (!picked.has(row.id)) {
          secrets.push({ ...out, outcome: "skipped" });
          continue;
        }
        const value = values.get(row.source);
        if (value === undefined) {
          secrets.push({ ...out, outcome: "not-found" });
          continue;
        }
        if (!Buffer.isBuffer(value)) {
          secrets.push({ ...out, outcome: value });
          continue;
        }
        const written = await owner
          .putSecret(refs.get(row.id) as string, row.name, value, {
            discoverable: true,
            expectedVersion: row.replaces?.version ?? 0,
            expectedRevision: row.replaces?.revision ?? null,
            ...(row.place ? { environment: row.place } : {}),
          })
          .catch(() => undefined);
        secrets.push(
          written
            ? { ...out, outcome: "kept", ref: written.ref, version: written.version }
            : { ...out, outcome: "changed" },
        );
      }
      await use.ended();
      this.end(bring.key, { bring: bring.id, state: "kept", secrets });
      this.options.changed();
      return { brought: true };
    } finally {
      if (typeof captured === "object" && "output" in captured) captured.output.fill(0);
      if (values) zeroFill(values.values());
      this.running.delete(bring.key);
    }
  }

  private async captureWithUnlock(
    owner: ProtectedSecrets,
    bring: WaitingBring,
  ): Promise<{ output: SourceOutput } | { ended: SecretBringEnded }> {
    const prepared = this.unlocks.get(bring.key);
    const words = SECRET_BRING_CARD_WORDS;
    const changed = { ended: { bring: bring.id, state: "changed" } } as const;
    if (!prepared) return changed;
    const { request, use } = prepared;
    try {
      if (!(await use.current())) return changed;
      const expires = bring.at + this.lifetime;
      const proof = await owner.confirmUse(request, use.digest, expires, words.confirmUnlock);
      if (!proof || this.now() >= expires)
        return { ended: { bring: bring.id, state: "not-brought" } };
      if (
        !(await owner.authenticate(request, use.digest, expires, proof)) ||
        !(await use.current())
      )
        return changed;
      await use.execute();
      const output = prepared.takeOutput();
      return output ? { output } : changed;
    } catch {
      return { ended: { bring: bring.id, state: "failed", why: SECRET_BRING_WORDS.unlockFailed } };
    }
  }

  /** A press that could not start: the card stays, with new passes and why. */
  private reraise(bring: WaitingBring, notice: string): void {
    if (this.book.get(bring.key)) this.raise(bring, notice);
  }

  /** The bring ended: its passes stop working, held values are zero-filled, its card goes and its asker hears once. */
  private end(key: string, ended: SecretBringEnded, tell = true): void {
    const bring = this.book.drop(key);
    const unlock = this.unlocks.get(key);
    this.unlocks.delete(key);
    if (unlock) {
      const output = unlock.takeOutput();
      if (typeof output === "object" && "output" in output) output.output.fill(0);
      const state =
        ended.state === "not-brought"
          ? "denied"
          : ended.state === "changed"
            ? "invalidated"
            : ended.state === "kept"
              ? "completed"
              : ended.state === "failed"
                ? "unknown"
                : ended.state === "withdrawn"
                  ? "cancelled"
                  : ended.state;
      void unlock.use.dispose(state).catch(() => undefined);
    }
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const held = this.held.get(key);
    if (held) zeroFill(held.values());
    this.held.delete(key);
    for (const [id, offer] of this.offers) if (offer.key === key) this.offers.delete(id);
    if (!bring) return;
    this.ended.set(key, ended);
    this.options.withdraw(bringCardId(bring.task, bring.id), "This bring ended.");
    if (tell) this.options.brought(bring.task, ended);
  }
}

/**
 * A run or read of a bring's source as a use in Secrets' journal, before it
 * starts: the tool, the program or file, the reason and the references it
 * would keep, never a value. `ended` records how it ended: completed, with
 * the source's exit code, or invalidated when it never ran.
 */
async function journaled(
  owner: ProtectedSecrets,
  bring: WaitingBring,
  refs: string[],
  rows: readonly BringRow[],
): Promise<{ ended: (how?: SecretBringEnded) => Promise<void> }> {
  const request = randomUUID();
  const program = bring.source.kind === "run" ? bring.source.program : bring.source.file;
  const facts = { source: bring.source, reads: bring.reads, rows };
  await owner.journalBring({
    kind: "requested",
    request,
    intent: `${bring.key}:${request}`,
    inputDigest: sha256(canonical(facts)),
    digest: sha256(canonical({ request, facts, program })),
    secrets: refs,
    program: program.path,
    reason: bring.reason,
    rule: "ask",
    brought: bring.tool,
  });
  await owner.journalBring({ kind: "consumed", request });
  return {
    ended: async (how) => {
      const line: Parameters<ProtectedSecrets["journalBring"]>[0] =
        how === undefined
          ? { kind: "completed", request, exitCode: 0 }
          : how.state === "failed"
            ? {
                kind: "completed",
                request,
                ...(how.exitCode !== undefined ? { exitCode: how.exitCode } : {}),
              }
            : { kind: "ended", request, state: "invalidated" };
      await owner.journalBring(line).catch(() => undefined);
    },
  };
}
