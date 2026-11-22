import type { QuotaWindowView } from "@shared/quota";
import type { ManagedAuth } from "../auth";
import {
  bytesAt,
  floatAt,
  GRPC_PERMISSION_DENIED,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAUTHENTICATED,
  type GrpcWebRead,
  messageAt,
  ProtoDecodeError,
  readGrpcWebResponse,
  safeNumber,
  scanProtobuf,
  timestampAt,
  varintAt,
} from "../grpcWeb";
import { isAuthFailure, type QuotaHttp, type QuotaResponse, requestHeaders } from "../http";
import { asNumber, asRecord, clampPercent } from "../json";
import {
  CREDENTIAL_UNAVAILABLE,
  failureFromResponse,
  type ProviderOutcome,
  succeeded,
} from "../outcome";
import { buildWindow } from "../pace";

const API_KEY_URL = "https://api.x.ai/v1/api-key";
const MODELS_URL = "https://api.x.ai/v1/models";

/**
 * The consumer credits meter behind the grok.com usage page, read with the
 * account's own OAuth access token - one read-only request (captain
 * direction, 2026-09-05). This is an undocumented consumer endpoint that can
 * change without notice; when it does, the reader refuses the shape it no
 * longer recognizes (`schema_unrecognized`) and never invents a window.
 *
 * The request is the smallest set the meter was observed to accept: the
 * bearer, the gRPC-web content type and marker, and an empty request
 * message. No browser Origin/Referer and no borrowed client identity - the
 * meter answers without them, so Infinitary does not claim to be something it is
 * not.
 */
export const GROK_USAGE_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

/** A gRPC-web frame carrying the empty `GetGrokCreditsConfigRequest`. */
const EMPTY_GRPC_REQUEST = Uint8Array.from([0, 0, 0, 0, 0]);

const GRPC_WEB_HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/grpc-web+proto",
  "x-grpc-web": "1",
};

/**
 * What Infinitary says about an xAI sign-in that answered with no window: the
 * vendor returned nothing Infinitary could read as usage. It states what
 * happened on this read - never that the credential is incapable of
 * exposing usage, which no test here has established.
 */
export const GROK_NO_WINDOW_DETAIL = "Grok didn't return an allowance reading for this sign-in.";

/**
 * The reverse-engineered `GetGrokCreditsConfigResponse` (field numbers as
 * the proven reference reads them, confirmed against a live capture on
 * 2026-09-05):
 *
 *   1  config
 *      1  credit_usage_percent   float   shared, 0-100
 *      2-5                               monetary fields and their period -
 *                                        never read: usage is never derived
 *                                        from money
 *      7  products (repeated)
 *         1  product               enum   GROK_PRODUCT_LABELS
 *         2  usage_percent         float  0-100
 *      8  current_period
 *         1  type                  enum   1 monthly, 2 weekly
 *         2  start                 Timestamp
 *         3  end                   Timestamp
 *      12 prepaid { 1 balance }            not a window; not read
 *
 * Proto3 omits a zero float, so a config whose current period is valid but
 * whose usage percent is absent is a real 0%-used reading, not a gap.
 */
export const GROK_PRODUCT_LABELS: Record<number, { id: string; label: string }> = {
  0: { id: "unspecified", label: "Other" },
  1: { id: "api", label: "API" },
  2: { id: "grok_build", label: "Grok Build" },
  3: { id: "grok_plugins", label: "Grok Plugins" },
  4: { id: "chat", label: "Chat" },
  5: { id: "imagine", label: "Imagine" },
  6: { id: "voice", label: "Voice" },
};

/** The shared credits window's label, the meter every Grok reading leads with. */
export const GROK_CREDITS_LABEL = "credits";

const PERIOD_MONTHLY = 1n;
const PERIOD_WEEKLY = 2n;

export type GrokUsageParse =
  | { kind: "windows"; windows: QuotaWindowView[] }
  /** A well-formed message with nothing Infinitary reads as a window. */
  | { kind: "empty" }
  | { kind: "unrecognized" };

export function parseGrokUsage(message: Uint8Array, now: number): GrokUsageParse {
  let config: ReturnType<typeof scanProtobuf> | undefined;
  let windows: QuotaWindowView[];
  try {
    config = messageAt(scanProtobuf(message), 1);
    if (!config) return { kind: "unrecognized" };
    windows = windowsFromConfig(config, now);
  } catch (caught) {
    if (caught instanceof ProtoDecodeError) return { kind: "unrecognized" };
    throw caught;
  }
  return windows.length > 0 ? { kind: "windows", windows } : { kind: "empty" };
}

function windowsFromConfig(config: ReturnType<typeof scanProtobuf>, now: number) {
  const period = messageAt(config, 8);
  const periodType = period ? varintAt(period, 1) : undefined;
  const startsAtMs = period ? timestampAt(period, 2) : undefined;
  const resetsAtMs = period ? timestampAt(period, 3) : undefined;
  const validPeriod =
    (periodType === PERIOD_WEEKLY || periodType === PERIOD_MONTHLY) &&
    startsAtMs !== undefined &&
    resetsAtMs !== undefined &&
    resetsAtMs > startsAtMs;
  const cycle = {
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(validPeriod ? { startsAtMs, windowSeconds: (resetsAtMs - startsAtMs) / 1000 } : {}),
  };
  const window = (id: string, label: string, percentUsed: number) =>
    buildWindow({
      id,
      label,
      percentRemaining: roundPercent(100 - clampPercent(percentUsed)),
      ...cycle,
      now,
    });

  const windows: QuotaWindowView[] = [];
  const shared = floatAt(config, 1);
  if (shared !== undefined || validPeriod)
    windows.push(window("credits", GROK_CREDITS_LABEL, shared ?? 0));
  for (const raw of bytesAt(config, 7)) {
    const product = scanProtobuf(raw);
    const explicit = floatAt(product, 2);
    if (explicit === undefined && !validPeriod) continue;
    const number = safeNumber(varintAt(product, 1) ?? 0n);
    if (number === undefined) continue;
    const named = GROK_PRODUCT_LABELS[number] ?? {
      id: `unknown_${number}`,
      label: `Product ${number}`,
    };
    windows.push(window(`product:${named.id}`, named.label, explicit ?? 0));
  }
  return windows;
}

/** A float32 off the wire, kept to the precision a meter can mean. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseGrokKey(body: unknown, now: number): { windows: QuotaWindowView[] } {
  const root = asRecord(body);
  if (!root) return { windows: [] };
  const remaining = asNumber(root.remaining_credits) ?? asNumber(root.credits_remaining);
  const limit = asNumber(root.credit_limit) ?? asNumber(root.credits_limit);
  if (remaining === undefined) return { windows: [] };
  const percentRemaining =
    limit !== undefined && limit > 0 ? clampPercent((remaining / limit) * 100) : undefined;
  return {
    windows: [
      buildWindow({
        id: "credits",
        label: GROK_CREDITS_LABEL,
        ...(percentRemaining !== undefined ? { percentRemaining } : {}),
        now,
      }),
    ],
  };
}

const NO_WINDOW: ProviderOutcome = {
  status: "not_measured",
  windows: [],
  detail: GROK_NO_WINDOW_DETAIL,
  reason: "no_window_read",
};

export async function fetchGrokQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
  usageUrl: string = GROK_USAGE_URL,
  keyUrl: string = API_KEY_URL,
): Promise<ProviderOutcome> {
  if (!auth.apiKey && !auth.headers) return CREDENTIAL_UNAVAILABLE;
  if (!auth.usingOAuth) {
    // An API key can carry team credit metadata on the key probe.
    const result = await http(keyUrl, { headers: requestHeaders(auth) });
    if (!succeeded(result)) return failureFromResponse(result);
    const parsed = parseGrokKey(result.json, now);
    return parsed.windows.length > 0 ? { status: "ok", ...parsed } : NO_WINDOW;
  }

  const result = await http(usageUrl, {
    method: "POST",
    headers: requestHeaders(auth, GRPC_WEB_HEADERS),
    body: EMPTY_GRPC_REQUEST,
    responseType: "bytes",
  });
  if (!succeeded(result)) {
    if (result.status === 401 || result.status === 403) {
      return refusedByMeter(http, auth, `meter_http_${result.status}`);
    }
    return failureFromResponse(result);
  }
  const read = readGrpcWebResponse(result);
  if (read.kind === "protocol") return unrecognized();
  if (read.kind === "status") return outcomeForGrpcStatus(http, auth, read, result);
  const parsed = parseGrokUsage(read.message, now);
  if (parsed.kind === "windows") return { status: "ok", windows: parsed.windows };
  return parsed.kind === "empty" ? NO_WINDOW : unrecognized();
}

function unrecognized(): ProviderOutcome {
  return { status: "unavailable", windows: [], reason: "schema_unrecognized" };
}

async function outcomeForGrpcStatus(
  http: QuotaHttp,
  auth: ManagedAuth,
  read: Extract<GrpcWebRead, { kind: "status" }>,
  result: QuotaResponse,
): Promise<ProviderOutcome> {
  if (read.code === GRPC_UNAUTHENTICATED || read.code === GRPC_PERMISSION_DENIED) {
    return refusedByMeter(http, auth, `meter_grpc_${read.code}`);
  }
  if (read.code === GRPC_RESOURCE_EXHAUSTED) {
    return {
      status: "rate_limited",
      windows: [],
      reason: "rate_limited",
      ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
    };
  }
  return { status: "unavailable", windows: [], reason: `grpc_${read.code}` };
}

/**
 * The meter refused the credential. That is NOT yet a verdict on the
 * sign-in: whether this account's token reaches the consumer meter at all is
 * the one thing no test has established (quota-visibility diagnosis §8.2),
 * and inference may be working fine on the same bearer. So the sign-in is
 * asked directly, once. A live sign-in with a refused meter is the honest
 * disclosed line, with the refusal as its reason; only a sign-in that the
 * vendor's own API rejects is a rejected credential.
 */
async function refusedByMeter(
  http: QuotaHttp,
  auth: ManagedAuth,
  reason: string,
): Promise<ProviderOutcome> {
  const probe = await http(MODELS_URL, { headers: requestHeaders(auth) });
  if (isAuthFailure(probe.status)) return failureFromResponse(probe);
  if (!succeeded(probe)) return failureFromResponse(probe);
  return { ...NO_WINDOW, reason };
}
