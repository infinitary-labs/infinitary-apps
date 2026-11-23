import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { settingFrom } from "@shared/envSettings";
import { forgePlace } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { cutText } from "@shared/textCut";
import {
  API_RESPONSE_MAX_BYTES,
  type ForgeApiResponse,
  gatewayAnswerBytes,
  type ReleaseUpload,
} from "../../api";
import { ForgeAllowanceSpent, ForgeError, type ForgeFailure, ForgeWriteError } from "../../forge";
import { RELEASE_UPLOAD_TIMEOUT_MS } from "../../releaseFile";
import { bitbucketDownloadName } from "./api";

/**
 * Bitbucket Cloud's REST API (`docs/forge.md`, "Bitbucket sign-in and
 * projects"): `https://api.bitbucket.org/2.0` for bitbucket.org, the one
 * Bitbucket host the app signs in to for now. The override is only for
 * unpackaged test and development runs.
 */
export function bitbucketApiBaseFor(
  host: string,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): string {
  const override = settingFrom(options.env ?? process.env, "BITBUCKET_API_URL")?.trim();
  if (!options.packaged && override) return override.replace(/\/+$/, "");
  return host === "bitbucket.org" ? "https://api.bitbucket.org/2.0" : `https://${host}/2.0`;
}

export type BitbucketOptions = {
  token: () => Promise<string | undefined>;
  apiBaseUrl: string;
  fetch?: typeof fetch;
  onSignInRejected?: () => void;
};

const REQUEST_TIMEOUT_MS = 30_000;
/** Redirects a log download may follow to the storage Bitbucket keeps it on. */
const MAX_DOWNLOAD_REDIRECTS = 3;

/**
 * Where Bitbucket may send a step's log from: its own hosts and Amazon S3,
 * over HTTPS. The address is the grant; the token never goes there.
 */
export function isBitbucketLogStorage(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "bitbucket.org" ||
    host.endsWith(".bitbucket.org") ||
    host.endsWith(".bitbucket-pipelines.com") ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host)
  );
}

/**
 * Reads with the person's API token as a bearer token, which Bitbucket
 * accepts without the account's email. No redirects, no ambient
 * credentials and no unbounded answers; the token goes to this API alone.
 *
 * A refusal is typed by its status (`docs/forge.md`, "Failures are
 * typed"): a 401 is the token itself refused, which asks the health service
 * to look again; a 403 is `permission` (a scope the token lacks); a 404
 * `not-found`; a 429 or 5xx `transient`; anything else `refused`.
 */
export class BitbucketClient {
  private readonly fetcher: typeof fetch;
  readonly place: string;
  constructor(
    readonly host: string,
    private readonly options: BitbucketOptions,
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.place = forgePlace({ kind: "bitbucket", host }) ?? host;
  }

  async get<T>(pathOrLink: string): Promise<T> {
    return (await this.request("GET", pathOrLink)).body as T;
  }

  /**
   * One call under the API, its answer read whole and bounded. A refusal
   * throws its typed failure; a spent allowance (429) carries the time
   * Bitbucket said to wait. `beforeSend` runs once the call is about to
   * leave, after the sign-in is read. A write's caller decides what a
   * failure means for it (`write`).
   */
  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathOrLink: string,
    body?: unknown,
    beforeSend?: () => void,
  ): Promise<{ status: number; body: unknown; location: string | null }> {
    const path = this.pathOf(pathOrLink);
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host), true);
    let response: Response;
    beforeSend?.();
    try {
      response = await this.fetcher(`${this.options.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    if (!response.ok) {
      const said = await this.words(response);
      const what = `${this.place} answered ${response.status} to ${method} ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
      if (response.status === 401) this.options.onSignInRejected?.();
      const wait = Number(response.headers.get("retry-after"));
      if (response.status === 429 && Number.isFinite(wait) && wait > 0)
        throw new ForgeAllowanceSpent(Date.now() + wait * 1000, what);
      throw new BitbucketRefusal(response.status, what);
    }
    const text = await this.bounded(response, API_RESPONSE_MAX_BYTES);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    }
    return { status: response.status, body: parsed, location: response.headers.get("location") };
  }

  /**
   * A write whose outcome the caller must know: a refusal Bitbucket gave
   * before acting is `failed`; no answer, a server error or an unreadable
   * success is `uncertain`, read back before any retry.
   */
  async write(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    what: string,
  ): Promise<{ status: number; body: unknown; location: string | null }> {
    try {
      return await this.request(method, path, body);
    } catch (caught) {
      if (!(caught instanceof ForgeError)) throw caught;
      if (
        caught.beforeSend ||
        caught instanceof ForgeAllowanceSpent ||
        (caught instanceof BitbucketRefusal && caught.status < 500)
      )
        throw new ForgeWriteError("failed", caught.failure, caught.message);
      throw new ForgeWriteError(
        "uncertain",
        "transient",
        `${this.place} gave no clear answer when ${what}; read it back before any retry. ${caught.message}`,
      );
    }
  }

  /**
   * The gateway's raw call (`docs/forge.md`, "The gateway"): every status
   * answers, a redirect is never followed, the answer is bounded. Bitbucket
   * names the next page in the answer's `next`, which reaches the gateway as
   * a `Link` header's `rel="next"` so every forge pages one way.
   */
  async call(method: string, path: string, body?: string): Promise<ForgeApiResponse> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.apiBaseUrl}${path}`, {
        method,
        headers: {
          // i18n-exempt: an HTTP header, not words
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    return this.gatewayAnswer(response);
  }

  /**
   * Put a release file in the repository's Downloads (`docs/forge.md`,
   * "Release files"): one multipart `POST .../downloads` whose `files` part
   * streams the bytes. A file of the same name there is replaced.
   */
  async upload(path: string, file: ReleaseUpload): Promise<ForgeApiResponse> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    const url = `${this.options.apiBaseUrl}${path.split("?")[0]}`;
    if (new URL(url).origin !== new URL(this.options.apiBaseUrl).origin) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on this API's address.",
        true,
      );
    }
    const boundary = `----infinitary${randomBytes(12).toString("hex")}`;
    const name = bitbucketDownloadName(file.filename);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const stream = Readable.from(
      (async function* () {
        yield head;
        for await (const chunk of file.stream) yield chunk as Buffer;
        yield tail;
      })(),
    );
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        redirect: "manual",
        // i18n-exempt: HTTP headers, not words
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(head.byteLength + file.size + tail.byteLength),
        },
        // Node's fetch reads a stream and requires duplex; the DOM types name neither.
        body: stream,
        duplex: "half",
        signal: AbortSignal.timeout(RELEASE_UPLOAD_TIMEOUT_MS),
      } as unknown as RequestInit);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    return this.gatewayAnswer(response);
  }

  /**
   * A file Bitbucket serves rather than JSON - a pipeline step's log -
   * bounded to `maxBytes`. Bitbucket may send it from storage through a
   * redirect: up to three are followed by hand, only to this API's own
   * address or to its log storage over HTTPS, and the token goes only with
   * the first request. A failure never repeats a signed address.
   */
  async download(path: string, maxBytes: number, what: string): Promise<Uint8Array> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let url = new URL(`${this.options.apiBaseUrl}${path}`);
    const apiOrigin = url.origin;
    let signed = true;
    try {
      for (let hops = 0; hops <= MAX_DOWNLOAD_REDIRECTS; hops++) {
        const response = await this.fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal,
          // i18n-exempt: an HTTP header, not words
          headers: signed ? { Authorization: `Bearer ${token}` } : {},
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location)
            throw new ForgeError("refused", `${this.place} supplied no download address.`);
          const next = new URL(location, url);
          if (
            next.username ||
            next.password ||
            (next.origin !== apiOrigin && !isBitbucketLogStorage(next))
          ) {
            throw new ForgeError("refused", `${this.place} supplied an unsafe download address.`);
          }
          url = next;
          signed = false;
          continue;
        }
        if (!response.ok && !signed) {
          await response.body?.cancel();
          throw new ForgeError(
            "refused",
            `The download answered ${response.status}; ask for it again.`,
          );
        }
        if (!response.ok) {
          const said = await this.words(response);
          // i18n-exempt: names the request in an error served to the crewmate
          const answered = `${this.place} answered ${response.status} to GET ${path}${said ? `: ${said}` : ""}`;
          if (response.status === 401) this.options.onSignInRejected?.();
          throw new BitbucketRefusal(response.status, answered);
        }
        return await this.boundedBytes(response, maxBytes, what);
      }
      throw new ForgeError("refused", `${this.place} redirected the download too many times.`);
    } catch (caught) {
      if (caught instanceof ForgeError) throw caught;
      // A fetch failure may name a signed storage address: never echo it.
      throw new ForgeError(
        "transient",
        `Could not finish the download from ${this.place}; try a fresh read.`,
      );
    }
  }

  /** Every status answers. A redirect is refused, and the answer stays within the JSON cap. */
  private async gatewayAnswer(response: Response): Promise<ForgeApiResponse> {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ForgeError(
        "refused",
        `${this.place} answered with a redirect, which the gateway does not follow.`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await gatewayAnswerBytes(response);
    } catch (caught) {
      if (caught instanceof ForgeError) throw caught;
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    }
    if (response.status === 401) this.options.onSignInRejected?.();
    const text = new TextDecoder().decode(bytes);
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      rateLimit:
        remaining === null || !Number.isFinite(Number(remaining))
          ? null
          : { remaining: Number(remaining), resetAt: null },
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      link: response.ok ? nextLinkOf(text) : null,
      body: text,
    };
  }

  /**
   * A path under the API: a relative path as given, or the path of a
   * `next` link Bitbucket wrote on this same API. A link anywhere else is
   * refused, so the token never leaves for another address.
   */
  private pathOf(pathOrLink: string): string {
    if (pathOrLink.startsWith("/")) return pathOrLink;
    const base = this.options.apiBaseUrl;
    if (pathOrLink.startsWith(`${base}/`)) return pathOrLink.slice(base.length);
    throw new ForgeError("refused", `${this.place} named a page outside its own API.`);
  }

  private async words(response: Response): Promise<string> {
    let text = "";
    try {
      text = await this.bounded(response, 16 * 1024);
    } catch {
      return "";
    }
    try {
      const json = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof json.error?.message === "string") return cutText(json.error.message, 300);
    } catch {}
    return cutText(text.trim(), 200);
  }

  private async boundedBytes(
    response: Response,
    maxBytes: number,
    what: string,
  ): Promise<Uint8Array> {
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new ForgeError("refused", `The ${what} is larger than the app reads.`);
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new ForgeError("refused", `The ${what} is larger than the app reads.`);
        }
        chunks.push(chunk.value);
      }
      return new Uint8Array(Buffer.concat(chunks, bytes));
    } finally {
      reader.releaseLock();
    }
  }

  private async bounded(response: Response, maxBytes: number): Promise<string> {
    const tooLarge = () =>
      new ForgeError("refused", `${this.place}'s answer is too large to read.`);
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks, bytes).toString("utf8");
    } catch (caught) {
      if (caught instanceof ForgeError) throw caught;
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    } finally {
      reader.releaseLock();
    }
  }
}

/** Bitbucket refused a call with this status, before or instead of acting on it. */
export class BitbucketRefusal extends ForgeError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(failureOf(status), message);
    this.name = "BitbucketRefusal";
  }
}

function nextLinkOf(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { next?: unknown };
    // The gateway takes it only on this same API (`nextPageOf`).
    return typeof parsed?.next === "string" && !/[<>\s]/.test(parsed.next)
      ? `<${parsed.next}>; rel="next"`
      : null;
  } catch {
    return null;
  }
}

function failureOf(status: number): ForgeFailure {
  if (status === 401) return "sign-in";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429 || status >= 500) return "transient";
  return "refused";
}

/** A failure before a write left: nothing was sent, which a caller may retry. */
export function sentNothing(caught: unknown): unknown {
  if (caught instanceof ForgeError && (caught.beforeSend || caught instanceof ForgeAllowanceSpent))
    return caught;
  const message = caught instanceof Error ? caught.message : String(caught);
  return new ForgeError(caught instanceof ForgeError ? caught.failure : "transient", message, true);
}
