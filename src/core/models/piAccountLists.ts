import type { CrewSpeed } from "@shared/crewSpeed";
import type { ManagedAuth } from "../quota/auth";
import {
  createQuotaHttp,
  type QuotaHttp,
  QuotaTransportError,
  requestHeaders,
} from "../quota/http";
import { chatgptAccountId } from "../quota/providers/codex";
import type { CatalogReader, CatalogReadResult, ServedModel } from "./servedModels";

/**
 * The account's OWN model list for a Pi-served subscription (Codex, Grok) -
 * docs/model-lists.md. Pi's catalog says what Pi can drive; this says what
 * this account may spend, so a model Pi lists that the plan does not carry
 * (gpt-5.3-codex-spark on a plan without it) stops being offered.
 *
 * It is a FILTER, never a source: Pi cannot run an id it has no definition
 * for, so an id only this list names adds nothing. And it sits behind a
 * safety rail (the captain's decision A, 2026-09-23): neither answer can be
 * checked against a live account from here, so an answer that omits any
 * starter or kept id Pi can serve is treated as unrecognised - no filter,
 * silent fallback - rather than trusted to remove a default. The rail lives
 * with the caller (`ServedModels.accept`), which knows what is kept.
 */

/**
 * The Codex client version the list is requested as. Codex's list endpoint
 * requires one, and its answer is the catalog a Codex client of that version
 * is offered; this is the version whose answer Infinitary was built against
 * (Codex CLI 0.159.0; Pi 1.0.0 keeps the Pi 0.99.1 Codex catalog unchanged).
 * It is pinned like the Pi SDK version in package.json - review the two
 * together, because Pi decides which listed ids Infinitary can actually run.
 */
export const CODEX_MODELS_CLIENT_VERSION = "0.159.0";

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const GROK_MODELS_URL = "https://api.x.ai/v1/models";

/**
 * The most an account's model list may be. The shared transport refuses a
 * reply past 64 KB, a meter's bound; a list describes every model the account
 * serves and may run past that, so it reads under its own, wider one.
 */
export const ACCOUNT_LIST_LIMIT_BYTES = 8 * 1024 * 1024;

export type PiListReaderOptions = {
  /** The account's auth, resolved the same way a quota read resolves it. */
  resolveAuth: (accountId: string) => Promise<ManagedAuth | undefined>;
  http?: QuotaHttp;
  /** Pi's own switch for startup network (e2e sets it): no read at all. */
  offline?: boolean;
  /** Dev/e2e endpoint override; a packaged app never passes one. */
  url?: string;
};

/**
 * The safety rail (captain's decision A, 2026-09-23): an account list is
 * trusted to remove models only when it names every protected id - each
 * starter row and each model the user kept - that Pi can serve for the
 * account. One missing is read as an answer we do not understand, so the
 * filter does not apply at all: a read is never evidence that a default is
 * gone. The accepted cost is that a Pi default's death shows in the CI
 * check and at spawn, not here.
 */
export function railVerdict(input: {
  answer: readonly ServedModel[];
  protectedIds: readonly string[];
  /** What Pi's catalog serves the account, unfiltered; undefined while it loads. */
  piIds: readonly string[] | undefined;
}): { ok: true } | { ok: false; detail: string } {
  if (!input.piIds) return { ok: false, detail: "the account's catalog is not ready" };
  const named = new Set(input.answer.map((model) => model.id));
  const pi = new Set(input.piIds);
  const missing = input.protectedIds.filter((id) => pi.has(id) && !named.has(id));
  return missing.length > 0 ? { ok: false, detail: `omits ${missing.join(", ")}` } : { ok: true };
}

/** Codex: `{ models: [{ slug }] }`, hidden rows included - they are still served. */
export function parseCodexModelList(body: unknown): ServedModel[] | undefined {
  const models = asRecord(body)?.models;
  if (!Array.isArray(models)) return undefined;
  const out: ServedModel[] = [];
  for (const entry of models) {
    const row = asRecord(entry);
    const id = typeof row?.slug === "string" ? row.slug : undefined;
    if (!id) return undefined;
    const tiers = row?.service_tiers;
    const speeds: CrewSpeed[] | undefined = Array.isArray(tiers)
      ? [
          "standard",
          ...tiers.flatMap((tier): CrewSpeed[] => {
            const value = asRecord(tier)?.id;
            return value === "ultrafast"
              ? ["ultrafast"]
              : value === "priority" || value === "fast"
                ? ["fast"]
                : [];
          }),
        ]
      : undefined;
    out.push({
      id,
      ...(typeof row?.display_name === "string" ? { name: row.display_name } : {}),
      ...(speeds ? { speeds } : {}),
    });
  }
  return out;
}

/** xAI: the OpenAI-compatible `{ data: [{ id }] }`. */
export function parseGrokModelList(body: unknown): ServedModel[] | undefined {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return undefined;
  const out: ServedModel[] = [];
  for (const entry of data) {
    const id = asRecord(entry)?.id;
    if (typeof id !== "string" || !id) return undefined;
    out.push({ id });
  }
  return out;
}

export function codexListReader(options: PiListReaderOptions): CatalogReader {
  return (account) =>
    readList(options, account.accountId, (auth) => {
      const url = new URL(options.url ?? CODEX_MODELS_URL);
      url.searchParams.set("client_version", CODEX_MODELS_CLIENT_VERSION);
      const accountId = auth.apiKey ? chatgptAccountId(auth.apiKey) : undefined;
      return {
        url: url.toString(),
        headers: requestHeaders(auth, accountId ? { "chatgpt-account-id": accountId } : {}),
        parse: parseCodexModelList,
      };
    });
}

export function grokListReader(options: PiListReaderOptions): CatalogReader {
  return (account) =>
    readList(options, account.accountId, (auth) => ({
      url: options.url ?? GROK_MODELS_URL,
      headers: requestHeaders(auth),
      parse: parseGrokModelList,
    }));
}

async function readList(
  options: PiListReaderOptions,
  accountId: string,
  request: (auth: ManagedAuth) => {
    url: string;
    headers: Record<string, string>;
    parse: (body: unknown) => ServedModel[] | undefined;
  },
): Promise<CatalogReadResult> {
  if (options.offline && !options.url) return { status: "skipped" };
  const auth = await options.resolveAuth(accountId).catch(() => undefined);
  if (!auth) return { status: "failed", reason: "signed_out" };
  const { url, headers, parse } = request(auth);
  const http = options.http ?? createQuotaHttp();
  try {
    const response = await http(url, { headers, limitBytes: ACCOUNT_LIST_LIMIT_BYTES });
    if (response.status === 401 || response.status === 403) {
      return { status: "failed", reason: "signed_out", detail: `HTTP ${response.status}` };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "failed", reason: "error", detail: `HTTP ${response.status}` };
    }
    const models = parse(response.json);
    if (!models) return { status: "failed", reason: "unrecognised" };
    return { status: "ok", models };
  } catch (caught) {
    if (caught instanceof QuotaTransportError && caught.failure === "timeout") {
      return { status: "failed", reason: "timeout" };
    }
    return {
      status: "failed",
      reason: "error",
      detail: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
