import { settingFrom } from "@shared/envSettings";
import { forgePlace } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { API_RESPONSE_MAX_BYTES, type ForgeApiResponse } from "../../api";
import { ForgeError, type ForgeFailure } from "../../forge";

/** A host's GitLab API; the override is only for unpackaged test/development runs. */
export function gitlabApiBaseFor(
  host: string,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): string {
  const override = settingFrom(options.env ?? process.env, "GITLAB_API_URL")?.trim();
  return !options.packaged && override ? override.replace(/\/+$/, "") : `https://${host}/api/v4`;
}

export type GitLabOptions = {
  token: () => Promise<string | undefined>;
  apiBaseUrl: string;
  fetch?: typeof fetch;
  onSignInRejected?: () => void;
};

/** The most a delivery read (a merge request, a pipeline's jobs) may answer. */
export const GITLAB_READ_MAX_BYTES = 4 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;
/** Redirects a download may follow to the storage GitLab keeps it on. */
const MAX_DOWNLOAD_REDIRECTS = 3;

/**
 * Where GitLab sends a job's artifacts from: gitlab.com's artifacts CDN and
 * Google Cloud Storage, and the object stores a self-hosted server keeps
 * them in most - Amazon S3, Azure Blob storage, Google Cloud Storage - over
 * HTTPS. The address is the grant; the key never goes there.
 */
export function isArtifactStorage(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "cdn.artifacts.gitlab-static.net" ||
    host === "storage.googleapis.com" ||
    host.endsWith(".storage.googleapis.com") ||
    host.endsWith(".blob.core.windows.net") ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host)
  );
}

/**
 * No redirects, ambient credentials, or unbounded responses; sign-in stays
 * on this host. The one redirect followed is a download's to the storage
 * GitLab keeps it on, by hand and without the key (`download`).
 *
 * A refusal is typed by its status (`docs/forge.md`, "Failures are typed"):
 * a 403 is `permission`, a 404 `not-found`, a 429 or 5xx `transient`, and
 * anything else `refused`. GitLab also answers 401 when the key is fine but
 * may not do the one thing asked - accepting a merge request it cannot
 * merge - so a 401 on anything but the key's own read asks GitLab who the
 * key is: a key it still answers for makes the refusal `permission`, and
 * only a key it refuses there is `sign-in` and asks the health service to
 * look again.
 */
export class GitLabClient {
  private readonly fetcher: typeof fetch;
  readonly place: string;
  constructor(
    readonly host: string,
    private readonly options: GitLabOptions,
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.place = forgePlace({ kind: "gitlab", host }) ?? host;
  }

  async get<T>(path: string, maxBytes = API_RESPONSE_MAX_BYTES): Promise<T> {
    return (await this.request("GET", path, undefined, maxBytes)) as T;
  }

  /**
   * A JSON list plus GitLab's `X-Total`, for a page of jobs.
   * `total` is null when the header is absent.
   */
  async list<T>(path: string): Promise<{ body: T; total: number | null }> {
    const answer = await this.exchange("GET", path, undefined, API_RESPONSE_MAX_BYTES);
    return { body: answer.body as T, total: answer.total };
  }

  /** One API call: its JSON answer, or a typed `ForgeError` naming GitLab's status and words. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    maxBytes = API_RESPONSE_MAX_BYTES,
  ): Promise<unknown> {
    return (await this.exchange(method, path, body, maxBytes)).body;
  }

  private async exchange(
    method: string,
    path: string,
    body: unknown,
    maxBytes: number,
  ): Promise<{ body: unknown; total: number | null }> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    let response: Response;
    try {
      response = await this.send(token, method, path, body);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    const total = totalOf(response.headers.get("x-total"));
    if (!response.ok) {
      const said = await this.words(response);
      const what = `${this.place} answered ${response.status} to ${method} ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
      if (response.status === 401) {
        const failure = path === "/user" ? "sign-in" : await this.whoAmI(token);
        if (failure === "sign-in") this.options.onSignInRejected?.();
        throw new ForgeError(failure, what);
      }
      throw new ForgeError(failureOf(response.status), what);
    }
    const text = await this.bounded(response, maxBytes);
    if (!text) return { body: null, total };
    try {
      return { body: JSON.parse(text) as unknown, total };
    } catch {
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    }
  }

  /**
   * The gateway's raw call (`docs/forge.md`, "The gateway"): every status
   * answers, a redirect is never followed, the answer is bounded. A 401 is
   * a sign-in only when GitLab no longer answers for the key.
   */
  async call(method: string, path: string, body?: string): Promise<ForgeApiResponse> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    let response: Response;
    try {
      response = await this.send(token, method, path, body, { raw: true, redirect: "manual" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ForgeError(
        "refused",
        `${this.place} answered with a redirect, which the gateway does not follow.`,
      );
    }
    const bytes = await this.boundedBytes(response, API_RESPONSE_MAX_BYTES, "The answer");
    if (response.status === 401 && (await this.whoAmI(token)) === "sign-in") {
      this.options.onSignInRejected?.();
    }
    const remaining = response.headers.get("ratelimit-remaining");
    const reset = Number(response.headers.get("ratelimit-reset"));
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      rateLimit:
        remaining === null
          ? null
          : {
              remaining: Number(remaining),
              resetAt:
                Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
            },
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      link: response.headers.get("link"),
      body: new TextDecoder().decode(bytes),
    };
  }

  /**
   * A file GitLab serves rather than JSON - a job's log, its artifacts
   * archive - bounded to `maxBytes`. GitLab may send it from object storage
   * through a redirect: up to three are followed by hand, only to this API's
   * own address or to known artifact storage over HTTPS, and the key goes
   * only with the first request. A failure never repeats a signed address.
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
            (next.origin !== apiOrigin && !isArtifactStorage(next))
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
          const answered = `${this.place} answered ${response.status} to GET ${path}${said ? `: ${said}` : ""}`;
          if (response.status === 401) {
            const failure = await this.whoAmI(token);
            if (failure === "sign-in") this.options.onSignInRejected?.();
            throw new ForgeError(failure, answered);
          }
          throw new ForgeError(failureOf(response.status), answered);
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

  private send(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    options: { raw?: boolean; redirect?: RequestRedirect } = {},
  ): Promise<Response> {
    return this.fetcher(`${this.options.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: options.raw ? (body as string) : JSON.stringify(body) }),
      redirect: options.redirect ?? "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** After a 401: whether GitLab still answers for the key, which makes the refusal a permission. */
  private async whoAmI(token: string): Promise<ForgeFailure> {
    try {
      const response = await this.send(token, "GET", "/user");
      await response.body?.cancel();
      return response.ok ? "permission" : "sign-in";
    } catch {
      return "sign-in";
    }
  }

  /** GitLab's own words for a refusal, bounded: `message` (a string or a list per field) or `error`. */
  private async words(response: Response): Promise<string> {
    let text = "";
    try {
      text = await this.bounded(response, 16 * 1024);
    } catch {
      return "";
    }
    try {
      const json = JSON.parse(text) as { message?: unknown; error?: unknown };
      const said = json.message ?? json.error;
      if (typeof said === "string") return said.slice(0, 300);
      if (said !== undefined) return JSON.stringify(said).slice(0, 300);
    } catch {
      /* not JSON */
    }
    return text.trim().slice(0, 200);
  }

  private async bounded(response: Response, maxBytes: number): Promise<string> {
    return Buffer.from(await this.boundedBytes(response, maxBytes)).toString("utf8");
  }

  /** A body read whole, or refused once it passes `maxBytes`; `what` names it in the refusal. */
  private async boundedBytes(
    response: Response,
    maxBytes: number,
    what?: string,
  ): Promise<Uint8Array> {
    const tooLarge = () => {
      const limit =
        maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes / 1024} KiB`;
      return new ForgeError(
        "refused",
        what
          ? `${what} exceeds the ${limit} read limit.`
          : `${this.place}'s answer is too large to read.`,
      );
    };
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
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
          throw tooLarge();
        }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks, bytes);
    } catch (caught) {
      if (caught instanceof ForgeError) throw caught;
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    } finally {
      reader.releaseLock();
    }
  }
}

function failureOf(status: number): ForgeFailure {
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429 || status >= 500) return "transient";
  return "refused";
}

function totalOf(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}
