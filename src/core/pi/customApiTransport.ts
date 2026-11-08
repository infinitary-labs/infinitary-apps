import { lookup } from "node:dns/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { rootCertificates } from "node:tls";
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import {
  approvedCustomApiCertificates,
  type CustomCertificateApproval,
} from "./customApiCertificates";
import {
  assertCustomApiAddresses,
  assertCustomApiException,
  assertCustomHeaders,
  assertLiteralBearerKey,
  type CustomApiDestination,
  CustomApiError,
  type CustomApiFailure,
  type CustomNetworkMode,
  classifyCustomApiAddresses,
  customApiHostname,
  normalizeCustomApiBase,
} from "./customApiPolicy";

const MAX_BYTES = 1024 * 1024;
/**
 * Bytes of conversation the wire cap allows per documented token. A connection
 * size bound, not a token estimate: Pi decides whether the request fits.
 */
export const CUSTOM_API_BYTES_PER_TOKEN = 3;
/** Bytes of a server error read, only to tell an overflow from any other failure. */
const ERROR_CLASSIFY_BYTES = 16 * 1024;

/**
 * The largest generation request for a model with this documented context
 * (FI3-563), so a large-context model is never cut off at a fixed size before
 * its own limit. The cap allows three bytes per token, and twice that on the
 * wire, where a tool call's arguments travel as JSON text inside JSON. The
 * 1 MiB every request may use covers the model name and fixed fields. Picture
 * bytes are added for the pictures the request sends.
 */
export function customApiRequestBytes(context?: number, pictureBytes = 0): number {
  if (!Number.isSafeInteger(pictureBytes) || pictureBytes < 0) throw new CustomApiError("limits");
  if (context === undefined) return MAX_BYTES + pictureBytes;
  if (!Number.isSafeInteger(context) || context <= 0) throw new CustomApiError("limits");
  return MAX_BYTES + 2 * CUSTOM_API_BYTES_PER_TOKEN * context + pictureBytes;
}

/**
 * How long one request may run and how large its reply may grow. `totalMs`
 * runs from before DNS to the reply's last byte; `idleMs`, where set, is the
 * longest the server may stay silent, waiting for its headers or between
 * reply bytes.
 */
export type CustomApiReplyLimits = Readonly<{
  totalMs: number;
  idleMs?: number;
  replyBytes: number;
}>;
const LIST_LIMITS: CustomApiReplyLimits = { totalMs: 15_000, replyBytes: MAX_BYTES };
/** FI3-337's connection check: each generation request within 60 seconds and 1 MiB. */
export const CUSTOM_API_CHECK_LIMITS: CustomApiReplyLimits = {
  totalMs: 60_000,
  replyBytes: MAX_BYTES,
};
/**
 * A real turn (FI3-490) may stream a long reply for as long as the server
 * keeps sending. Five silent minutes is Pi's own HTTP idle default for its
 * built-in providers, long enough for a slow server to read a large context
 * before its first token. The hour and the 64 MiB, room for a 128k-token reply
 * at about 500 bytes of stream per token, still cut off a server that never
 * stops.
 */
export const CUSTOM_API_TURN_LIMITS: CustomApiReplyLimits = {
  totalMs: 60 * 60_000,
  idleMs: 5 * 60_000,
  replyBytes: 64 * MAX_BYTES,
};

type Operation = "models" | "chat/completions" | "responses" | "messages";
/** Anthropic's documented API version; the Messages request carries it, never the connection. */
const ANTHROPIC_VERSION = "2023-06-01";
export type CustomApiHeader = Readonly<{ name: string; value: string; secret: boolean }>;
export type CustomApiResolver = (hostname: string) => Promise<readonly string[]>;
const lookupAll: CustomApiResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

/**
 * The network an address points to now, read from every DNS answer of its
 * name (or from the literal address itself): this Mac, an organization's
 * private network or the public internet. The class is then held on every
 * request, as an explicit choice was. A name that does not resolve could not
 * be reached; answers in two classes, or in a forbidden range, are refused.
 */
export async function readCustomApiDestination(
  baseUrl: string,
  resolve: CustomApiResolver = lookupAll,
): Promise<CustomApiDestination> {
  const hostname = customApiHostname(baseUrl);
  let addresses: readonly string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new CustomApiError("network");
    }
  }
  return normalizeCustomApiBase(baseUrl, classifyCustomApiAddresses(addresses));
}
export type CustomApiTransportOptions = {
  /** The Anthropic Messages format authenticates with `x-api-key` and names its API version. */
  anthropic?: boolean;
  baseUrl: string;
  mode: CustomNetworkMode;
  /**
   * The person made an exception for this address: its answers may be reserved
   * or span networks, and each request checks only what no exception reaches.
   */
  exception?: boolean;
  /**
   * A server that needs no key gets none, in any mode; a connection's own
   * headers may carry its credential instead. No availability marker on wire.
   */
  credential: { kind: "bearer"; key: string } | { kind: "local-no-key" };
  /** The person's extra headers, sent on every request; a secret value is guarded like the key. */
  headers?: readonly CustomApiHeader[];
  /** Public CA material approved for this private HTTPS connection only. */
  certificates?: CustomCertificateApproval;
  /**
   * Generation bounds: `turn` for real work, which may stream a long reply;
   * anything else keeps the connection check's short budget.
   */
  generation?: "check" | "turn";
};
export type CustomApiTransport = {
  /**
   * `context`, the model's documented context in tokens, sizes a generation
   * request's bound (`customApiRequestBytes`); without it a request keeps 1 MiB.
   */
  request: (
    operation: Operation,
    body?: string,
    signal?: AbortSignal,
    context?: number,
    pictureBytes?: number,
  ) => Promise<Response>;
  /** Never return a literal credential echo, or publish a closed transport's reply. */
  assertSafeOutput: (value: unknown) => void;
  /** Terminal: abort active requests, prevent later calls, release captured credential. */
  close: () => void;
};

/**
 * Opt-in boundary only; no built-in runtime, global fetch, proxy or trust edits.
 * Resolve on every request and give Node ONLY the checked IPs. A fresh, private
 * agent (agent:false) prevents connection reuse from bypassing the check. Node
 * retains the approved hostname for TLS verification and Host/SNI.
 *
 * The resolver seam can supply DNS answers but cannot bypass policy. Future
 * account/session integration must use this boundary for every custom request.
 */
export function createCustomApiTransport(
  options: CustomApiTransportOptions,
  resolve: CustomApiResolver = lookupAll,
): CustomApiTransport {
  const destination = normalizeCustomApiBase(options.baseUrl, options.mode);
  const roots = [
    ...normalRoots,
    ...approvedCustomApiCertificates(options.certificates, destination.mode),
  ];
  let key: string | undefined;
  const headers = options.headers ?? [];
  if (options.credential.kind === "bearer") {
    assertLiteralBearerKey(options.credential.key);
    key = options.credential.key;
  } else if (options.credential.kind !== "local-no-key") {
    throw new CustomApiError("credential");
  }
  assertCustomHeaders(headers, key !== undefined);
  // Captured once like the key; there is no setter and close() releases them.
  let extra: Record<string, string> | undefined = Object.fromEntries(
    headers.map((header) => [header.name, header.value]),
  );
  let secrets = headers.filter((header) => header.secret).map((header) => header.value);
  const generation =
    options.generation === "turn" ? CUSTOM_API_TURN_LIMITS : CUSTOM_API_CHECK_LIMITS;
  let closed = false;
  const active = new Set<(reason: CustomApiError) => void>();

  async function request(
    operation: Operation,
    body?: string,
    signal?: AbortSignal,
    context?: number,
    pictureBytes = 0,
  ): Promise<Response> {
    if (closed) throw new CustomApiError("closed");
    if (!["models", "chat/completions", "responses", "messages"].includes(operation)) {
      throw new CustomApiError("address");
    }
    if ((operation === "models") !== (body === undefined)) throw new CustomApiError("malformed");
    if (
      body !== undefined &&
      Buffer.byteLength(body) > customApiRequestBytes(context, pictureBytes)
    ) {
      // The wire cap is the documented window's size bound. Refuse it as the
      // overflow Pi already compacts and retries, not as a plain size error.
      throw new CustomApiError("context-limit");
    }
    if (signal?.aborted) throw new CustomApiError("cancelled");
    const limits = operation === "models" ? LIST_LIMITS : generation;

    // Bounds start before DNS; cancellation/close also cuts off pending lookup.
    return new Promise<Response>((accept, reject) => {
      let req: ClientRequest | undefined;
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false;
      let failed = false;
      let completed = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(idle);
        signal?.removeEventListener("abort", abort);
        active.delete(fail);
      };
      const fail = (error: CustomApiError) => {
        if (failed || completed) return;
        failed = true;
        cleanup();
        req?.destroy();
        if (settled) stream?.error(error);
        else reject(error);
      };
      const abort = () => fail(new CustomApiError("cancelled"));
      const timer = setTimeout(() => fail(new CustomApiError("timeout")), limits.totalMs);
      // The server's headers and every reply byte restart the silence clock. A
      // reader that stops pulling pauses the reply, so it is cut off the same way.
      const heard = () => {
        if (limits.idleMs === undefined || failed) return;
        clearTimeout(idle);
        idle = setTimeout(() => fail(new CustomApiError("stalled")), limits.idleMs);
      };
      heard();
      active.add(fail);
      signal?.addEventListener("abort", abort, { once: true });
      const start = async () => {
        const addresses = isIP(destination.hostname)
          ? [destination.hostname]
          : await resolve(destination.hostname);
        if (failed || closed) return;
        if (options.exception) assertCustomApiException(addresses);
        else assertCustomApiAddresses(addresses, destination.mode);
        const address = addresses[0];
        if (!address) throw new CustomApiError("destination");
        const url = new URL(`${destination.baseUrl}/${operation}`);
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        req = send(
          url,
          {
            method: operation === "models" ? "GET" : "POST",
            agent: false,
            // One checked address keeps an explicit family, which disables Node's
            // multi-address connect. Several go to that connect, which tries the
            // next checked one when one refuses: localhost may answer ::1 first
            // to a server listening on 127.0.0.1 alone.
            ...(addresses.length > 1 ? { autoSelectFamily: true } : { family: isIP(address) }),
            // Never process NODE_EXTRA_CA_CERTS as a connection-specific approval.
            // Explicit normal roots also avoid ambient global-agent trust changes.
            ...(url.protocol === "https:" ? { ca: roots, rejectUnauthorized: true } : {}),
            lookup: (_hostname, lookupOptions, callback) => {
              // No second DNS resolution between validation and connect.
              if (lookupOptions.all) {
                callback(
                  null,
                  addresses.map((checked) => ({ address: checked, family: isIP(checked) })),
                );
              } else callback(null, address, isIP(address));
            },
            headers: {
              ...extra,
              Accept: operation === "models" ? "application/json" : "text/event-stream",
              ...(options.anthropic
                ? {
                    "anthropic-version": ANTHROPIC_VERSION,
                    ...(key !== undefined ? { "x-api-key": key } : {}),
                  }
                : key !== undefined
                  ? { Authorization: `Bearer ${key}` }
                  : {}),
              ...(body !== undefined
                ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
                : {}),
            },
          },
          (reply) => {
            if (failed) {
              reply.destroy();
              return;
            }
            heard();
            const status = reply.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const category = statusCategory(status);
              // Listing, redirects and auth failures are classified without
              // reading. A generation failure is read only far enough to tell
              // an overflow, which Pi compacts on, from any other server error.
              if (category === "server" && operation !== "models") {
                classifyServerError(reply, status, fail, heard);
                return;
              }
              fail(new CustomApiError(category, status));
              reply.destroy();
              return;
            }
            if (status === 204 || status === 205) {
              fail(new CustomApiError("malformed"));
              reply.destroy();
              return;
            }
            const type = reply.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
            if (type !== (operation === "models" ? "application/json" : "text/event-stream")) {
              fail(new CustomApiError("malformed"));
              reply.destroy();
              return;
            }
            const length = reply.headers["content-length"];
            if (length && (!/^\d+$/.test(length) || Number(length) > limits.replyBytes)) {
              fail(new CustomApiError("oversized"));
              reply.destroy();
              return;
            }
            let bytes = 0;
            const responseBody = new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                reply.on("data", (chunk: Buffer) => {
                  if (failed) return;
                  heard();
                  bytes += chunk.length;
                  if (bytes > limits.replyBytes) {
                    fail(new CustomApiError("oversized"));
                    reply.destroy();
                    return;
                  }
                  controller.enqueue(new Uint8Array(chunk));
                  // Do not buffer an entire reply for a slow/abandoned consumer.
                  if ((controller.desiredSize ?? 0) <= 0) reply.pause();
                });
                reply.on("end", () => {
                  if (failed) return;
                  cleanup();
                  completed = true;
                  controller.close();
                });
                reply.on("error", () => fail(new CustomApiError("network")));
                reply.on("aborted", () => fail(new CustomApiError("network")));
              },
              pull() {
                reply.resume();
              },
              cancel() {
                cleanup();
                failed = true;
                reply.destroy();
                req?.destroy();
              },
            });
            settled = true;
            accept(new Response(responseBody, { status, headers: { "Content-Type": type } }));
          },
        );
        req.on("error", (error: NodeJS.ErrnoException) => {
          fail(
            new CustomApiError(certificateCodes.has(error.code ?? "") ? "certificate" : "network"),
          );
        });
        req.end(body);
      };
      void start().catch((error: unknown) =>
        fail(new CustomApiError(error instanceof CustomApiError ? error.category : "network")),
      );
    });
  }

  return {
    request,
    assertSafeOutput: (value) => {
      if (closed) throw new CustomApiError("closed");
      const echoes = [...(key ? [key] : []), ...secrets].flatMap((secret) => {
        const escaped = JSON.stringify(secret).slice(1, -1);
        return [secret, escaped, JSON.stringify(escaped).slice(1, -1)];
      });
      if (!echoes.length) return;
      const pending: unknown[] = [value];
      while (pending.length) {
        const next = pending.pop();
        if (typeof next === "string" && echoes.some((echo) => next.includes(echo)))
          throw new CustomApiError("incompatible");
        if (Array.isArray(next)) pending.push(...next);
        else if (next && typeof next === "object") {
          for (const [name, value] of Object.entries(next)) pending.push(name, value);
        }
      }
    },
    close() {
      closed = true;
      key = undefined;
      extra = undefined;
      secrets = [];
      for (const stop of active) stop(new CustomApiError("closed"));
    },
  };
}

// Bundled Node roots plus a connection's approved public CA material, never
// a process-global agent, ambient extra-root setting or system trust edit.
const normalRoots = [...rootCertificates];
const certificateCodes = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  // A certificate the approved CA did not sign, such as one from another CA
  // with the same name, or one whose signature was damaged.
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_REVOKED",
]);

/**
 * Read at most 16 KiB of bytes from a generation error, test the decoded text
 * with Pi's overflow check, and discard it. Only the yes or no leaves the transport.
 */
function classifyServerError(
  reply: IncomingMessage,
  status: number,
  fail: (error: CustomApiError) => void,
  heard: () => void,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    const text = Buffer.concat(chunks).toString("utf8");
    chunks.length = 0;
    const overflow = isContextOverflow({
      stopReason: "error",
      errorMessage: text,
    } as AssistantMessage);
    fail(new CustomApiError(overflow ? "context-limit" : "server", status));
    reply.destroy();
  };
  reply.on("data", (chunk: Buffer) => {
    if (settled) return;
    heard();
    if (bytes < ERROR_CLASSIFY_BYTES) {
      const slice = chunk.subarray(0, ERROR_CLASSIFY_BYTES - bytes);
      chunks.push(slice);
      bytes += slice.length;
    }
    if (bytes >= ERROR_CLASSIFY_BYTES) finish();
  });
  reply.on("end", finish);
  reply.on("error", finish);
  reply.on("aborted", finish);
}

function statusCategory(status: number): CustomApiFailure {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401) return "key-rejected";
  if (status === 403) return "access-refused";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  return "server";
}
