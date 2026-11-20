/**
 * The runtime catalog reads (lean model lists, captain 2026-09-23;
 * docs/model-lists.md): what each signed-in account can actually serve,
 * read from the provider's own answer rather than a list Infinitary shipped.
 *
 * Two rules carry the whole module, both the captain's:
 *
 * - NOTHING WAITS ON A READ. `refresh` starts a read and returns; no user
 *   path - launch, the first-run gate, opening Settings, starting a
 *   crewmate, routing - ever awaits one. What is on screen until a read
 *   lands is the shipped catalog, and a read only ever updates the list
 *   after it finishes.
 * - A FAILED READ FALLS BACK TO OUR CATALOG. A timeout, a missing client, a
 *   sign-in problem, an answer in a shape we do not recognise, and an empty
 *   answer are all failures: the account's result is forgotten and the
 *   shipped catalog serves again, silently. A failure is never evidence
 *   that a model is gone - only a successful read, compared with the
 *   previous successful read, can say that (`ModelSlots.departures`).
 *
 * A failure is logged once per account until its reason changes, and the
 * next pass retries it. A read that could not start because its store was
 * busy is DEFERRED, not failed: whatever was in hand stays in hand.
 */

import type { CrewSpeed } from "@shared/crewSpeed";

export type ServedModel = { id: string; name?: string; speeds?: CrewSpeed[] };

/** Metadata older than the daily catalog pass is not speed entitlement. */
const SPEED_FRESH_MS = 24 * 60 * 60 * 1000;

export type CatalogReadFailure =
  | "timeout"
  | "no_client"
  | "signed_out"
  | "unrecognised"
  | "empty"
  | "error";

export type CatalogReadResult =
  | { status: "ok"; models: ServedModel[] }
  | { status: "failed"; reason: CatalogReadFailure; detail?: string }
  | { status: "deferred" }
  /** Nothing to read here (Pi offline, a provider with no own list): no log. */
  | { status: "skipped" };

export type CatalogAccount = { accountId: string; providerId: string };

export type CatalogReader = (account: CatalogAccount) => Promise<CatalogReadResult>;

/** How one read settled: a deferred read could not start while its store was busy. */
export type CatalogReadSettled = CatalogReadResult["status"];

export type ServedModelsOptions = {
  /** One reader per provider id; a provider without one is never read. */
  readers: Readonly<Record<string, CatalogReader>>;
  /** The enabled accounts a pass reads. */
  accounts: () => CatalogAccount[];
  /**
   * A last say on a successful answer before it is used - the Pi filters'
   * safety rail (docs/model-lists.md). A refusal is a failed read.
   */
  accept?: (
    account: CatalogAccount,
    models: readonly ServedModel[],
  ) => { ok: true } | { ok: false; detail: string };
  /** The ceiling on one read, whatever the reader's own bound. */
  timeoutMs?: number;
  /** After every settled read, so the lists and the news can follow it. */
  onSettled?: (account: CatalogAccount) => void;
  /** A failed read, once per account until its reason changes. */
  log?: (line: string) => void;
  /**
   * A successful read, once per account until what it served changes - the
   * positive trace a live check reads (docs/model-lists.md).
   */
  info?: (line: string) => void;
  now?: () => number;
};

/** Longer than the slowest reader's own bound (a cold Claude client start). */
export const CATALOG_READ_CEILING_MS = 120_000;

export class ServedModels {
  private readonly latest = new Map<string, { models: ServedModel[]; at: number }>();
  private readonly speedMetadata = new Map<string, { models: ServedModel[]; at: number }>();
  private readonly inFlight = new Map<string, Promise<CatalogReadSettled>>();
  private readonly logged = new Map<string, string>();
  private readonly announced = new Map<string, string>();

  constructor(private readonly options: ServedModelsOptions) {}

  /**
   * Start a read for one account. Returns at once; the promise it hands
   * back settles when the read does, with how it settled, and never rejects
   * - it exists for tests and for a caller that keeps its own schedule of
   * reads, never for a user path to await. Undefined: nothing to read.
   */
  refresh(accountId: string): Promise<CatalogReadSettled | undefined> {
    const account = this.options.accounts().find((entry) => entry.accountId === accountId);
    if (!account) return Promise.resolve(undefined);
    return this.start(account);
  }

  /** A read for every enabled account that has a reader. */
  refreshAll(): Promise<void> {
    return Promise.all(this.options.accounts().map((account) => this.start(account))).then(
      () => undefined,
    );
  }

  /** Whether this provider's accounts have a list of their own to read. */
  reads(providerId: string): boolean {
    return Object.hasOwn(this.options.readers, providerId);
  }

  /** The account's last successful read this session, if one is in hand. */
  read(accountId: string): { models: readonly ServedModel[]; at: number } | undefined {
    return this.latest.get(accountId);
  }

  /** Independent of the listing rail: a fallback catalog never grants faster service. */
  speeds(accountId: string, id: string): readonly CrewSpeed[] | undefined {
    const read = this.speedMetadata.get(accountId);
    if (!read || this.now() - read.at >= SPEED_FRESH_MS) return undefined;
    return read.models.find((model) => model.id === id)?.speeds;
  }

  speedExpiresAt(accountId: string, id: string): number | undefined {
    return this.speeds(accountId, id)
      ? (this.speedMetadata.get(accountId)?.at ?? 0) + SPEED_FRESH_MS
      : undefined;
  }

  /** Drop what is known about an account (it was removed). */
  forget(accountId: string): void {
    this.latest.delete(accountId);
    this.speedMetadata.delete(accountId);
    this.logged.delete(accountId);
    this.announced.delete(accountId);
  }

  private start(account: CatalogAccount): Promise<CatalogReadSettled | undefined> {
    const reader = this.options.readers[account.providerId];
    if (!reader) return Promise.resolve(undefined);
    const running = this.inFlight.get(account.accountId);
    if (running) return running;
    const promise = this.run(account, reader).finally(() => {
      this.inFlight.delete(account.accountId);
    });
    this.inFlight.set(account.accountId, promise);
    return promise;
  }

  private async run(account: CatalogAccount, reader: CatalogReader): Promise<CatalogReadSettled> {
    const result = await this.bounded(reader, account);
    if (result.status === "deferred" || result.status === "skipped") {
      this.options.onSettled?.(account);
      return result.status;
    }
    if (result.status === "failed") {
      this.fail(account, result.reason, result.detail);
      return "failed";
    }
    const models = dedupe(result.models);
    if (models.length === 0) {
      this.fail(account, "empty");
      return "failed";
    }
    this.speedMetadata.set(account.accountId, { models, at: this.now() });
    const verdict = this.options.accept?.(account, models) ?? { ok: true };
    if (!verdict.ok) {
      this.fail(account, "unrecognised", verdict.detail, true);
      return "failed";
    }
    this.latest.set(account.accountId, { models, at: this.now() });
    this.logged.delete(account.accountId);
    const line = `${account.providerId} model list read: ${models.length} model${models.length === 1 ? "" : "s"}`;
    const signature = `${line}|${models.map((model) => model.id).join(",")}`;
    if (this.announced.get(account.accountId) !== signature) {
      this.announced.set(account.accountId, signature);
      this.options.info?.(line);
    }
    this.options.onSettled?.(account);
    return "ok";
  }

  private async bounded(
    reader: CatalogReader,
    account: CatalogAccount,
  ): Promise<CatalogReadResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        reader(account).catch(
          (caught): CatalogReadResult => ({
            status: "failed",
            reason: "error",
            detail: caught instanceof Error ? caught.message : String(caught),
          }),
        ),
        new Promise<CatalogReadResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "failed", reason: "timeout" }),
            this.options.timeoutMs ?? CATALOG_READ_CEILING_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private fail(
    account: CatalogAccount,
    reason: CatalogReadFailure,
    detail?: string,
    listingOnly = false,
  ): void {
    if (!listingOnly) this.speedMetadata.delete(account.accountId);
    // The shipped catalog serves again: a stale read must never outlive a
    // failed one, and the failure itself says nothing about any model.
    this.latest.delete(account.accountId);
    const line = `${account.providerId} model list unavailable (${reason})${detail ? `: ${detail}` : ""}; using the shipped catalog`;
    if (this.logged.get(account.accountId) !== line) {
      this.logged.set(account.accountId, line);
      this.options.log?.(line);
    }
    this.options.onSettled?.(account);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function dedupe(models: readonly ServedModel[]): ServedModel[] {
  const seen = new Set<string>();
  const out: ServedModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ...(model.name?.trim() ? { name: cleanName(model.name) } : {}),
      ...(model.speeds ? { speeds: model.speeds } : {}),
    });
  }
  return out;
}

/** Vendors pad names with zero-width characters and doubled spaces. */
function cleanName(name: string): string {
  return name.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
}
