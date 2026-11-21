import { settingFrom } from "@shared/envSettings";
import { forgePlace } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { cutText } from "@shared/textCut";
import { API_RESPONSE_MAX_BYTES } from "../../api";
import { ForgeAllowanceSpent, ForgeError, type ForgeFailure, ForgeWriteError } from "../../forge";

/**
 * A Bitbucket Data Center server's address (`docs/forge.md`, "Bitbucket
 * Data Center"): the server's own host over HTTPS, its REST API under
 * `/rest/`. The override is only for unpackaged test and development runs.
 */
export function bitbucketDataCenterBaseFor(
  host: string,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): string {
  const override = settingFrom(options.env ?? process.env, "BITBUCKET_DATA_CENTER_URL")?.trim();
  if (!options.packaged && override) return override.replace(/\/+$/, "");
  return `https://${host}`;
}

export type DataCenterOptions = {
  token: () => Promise<string | undefined>;
  /** The server's address, such as `https://bitbucket.example.com`; paths start with `/rest/`. */
  serverUrl: string;
  fetch?: typeof fetch;
  onSignInRejected?: () => void;
};

/** One answer read whole: its status, body, and the header naming the signed-in user. */
export type DataCenterAnswer = { status: number; body: unknown; user: string | null };

/** One page of a Data Center list read. */
export type DataCenterPage<T> = {
  values?: T[];
  isLastPage?: boolean;
  nextPageStart?: number;
};

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bitbucket Data Center's REST API with the person's HTTP access token as a
 * bearer token. No redirects, no ambient credentials and no unbounded
 * answers; the token goes to this server alone.
 *
 * A refusal is typed by its status and Data Center's own exception name
 * (`docs/forge.md`, "Failures are typed"): Data Center answers 401 both for
 * a token it does not accept and for a permission the token lacks, so a 401
 * naming an authorisation exception is `permission` and only another 401 is
 * the token itself refused; a 403 is `permission`, a 404 `not-found`, a 429
 * or 5xx `transient`, and anything else `refused`.
 */
export class DataCenterClient {
  private readonly fetcher: typeof fetch;
  readonly place: string;
  constructor(
    readonly host: string,
    private readonly options: DataCenterOptions,
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.place = forgePlace({ kind: "bitbucket", host }) ?? host;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request("GET", path)).body as T;
  }

  /**
   * Every page of a list read, up to `pages` pages: `complete` is false when
   * the server had more than that budget read.
   */
  async list<T>(
    path: string,
    pages: number,
    limit = 100,
  ): Promise<{ values: T[]; complete: boolean }> {
    const values: T[] = [];
    let start: number | undefined = 0;
    const join = path.includes("?") ? "&" : "?";
    for (let page = 0; start !== undefined && page < pages; page++) {
      const read: DataCenterPage<T> | null = await this.get(
        `${path}${join}start=${start}&limit=${limit}`,
      );
      if (!read || !Array.isArray(read.values))
        throw new ForgeError("transient", `${this.place}'s list could not be read.`);
      values.push(...read.values);
      start =
        read.isLastPage === false &&
        typeof read.nextPageStart === "number" &&
        read.nextPageStart > start
          ? read.nextPageStart
          : undefined;
    }
    return { values, complete: start === undefined };
  }

  /**
   * One call under the server, its answer read whole and bounded. A refusal
   * throws its typed failure (`DataCenterRefusal`); a spent allowance (429)
   * carries the time the server said to wait. `beforeSend` runs once the
   * call is about to leave, after the sign-in is read.
   */
  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    beforeSend?: () => void,
  ): Promise<DataCenterAnswer> {
    if (!path.startsWith("/rest/") && !path.startsWith("/plugins/"))
      throw new ForgeError("refused", `${this.place} was asked for a page outside its API.`, true);
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host), true);
    let response: Response;
    beforeSend?.();
    try {
      response = await this.fetcher(`${this.options.serverUrl}${path}`, {
        method,
        headers: {
          // i18n-exempt: HTTP headers, not words
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // Data Center refuses a write without it as a cross-site request.
          "X-Atlassian-Token": "no-check",
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
    const user = response.headers.get("x-ausername");
    if (!response.ok) {
      const said = await this.refusalOf(response);
      // i18n-exempt: names the request in an error served to the crewmate
      const what = `${this.place} answered ${response.status} to ${method} ${path.split("?")[0]}${said.message ? `: ${said.message}` : ""}`;
      const refusal = new DataCenterRefusal(response.status, said.exception, what);
      if (refusal.failure === "sign-in") this.options.onSignInRejected?.();
      const wait = Number(response.headers.get("retry-after"));
      if (response.status === 429 && Number.isFinite(wait) && wait > 0)
        throw new ForgeAllowanceSpent(Date.now() + wait * 1000, what);
      throw refusal;
    }
    const text = await this.bounded(response, API_RESPONSE_MAX_BYTES);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    }
    return { status: response.status, body: parsed, user };
  }

  /**
   * The user name the server's application-links page answers for the
   * token, as plain text: the fallback when an answer carried no
   * `X-AUSERNAME` header. Null when the page answers nothing usable.
   */
  async signedInUser(): Promise<string | null> {
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host), true);
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.serverUrl}/plugins/servlet/applinks/whoami`, {
        method: "GET",
        // i18n-exempt: an HTTP header, not words
        headers: { Authorization: `Bearer ${token}`, Accept: "text/plain" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const text = (await this.bounded(response, 1024)).trim();
    return text && !/[\s<>"]/.test(text) ? text : null;
  }

  /**
   * A write whose outcome the caller must know: a refusal the server gave
   * before acting is `failed`; no answer, a server error or an unreadable
   * success is `uncertain`, read back before any retry.
   */
  async write(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    what: string,
  ): Promise<DataCenterAnswer> {
    try {
      return await this.request(method, path, body);
    } catch (caught) {
      if (!(caught instanceof ForgeError)) throw caught;
      if (
        caught.beforeSend ||
        caught instanceof ForgeAllowanceSpent ||
        (caught instanceof DataCenterRefusal && caught.status < 500)
      )
        throw new ForgeWriteError("failed", caught.failure, caught.message);
      throw new ForgeWriteError(
        "uncertain",
        "transient",
        `${this.place} gave no clear answer when ${what}; read it back before any retry. ${caught.message}`,
      );
    }
  }

  /** Data Center's own words for a refusal, bounded: the first error's message and exception name. */
  private async refusalOf(response: Response): Promise<{ message: string; exception: string }> {
    let text = "";
    try {
      text = await this.bounded(response, 16 * 1024);
    } catch {
      return { message: "", exception: "" };
    }
    try {
      const json = JSON.parse(text) as {
        errors?: { message?: unknown; exceptionName?: unknown }[];
      };
      const first = Array.isArray(json.errors) ? json.errors[0] : undefined;
      if (first)
        return {
          message: typeof first.message === "string" ? cutText(first.message, 300) : "",
          exception: typeof first.exceptionName === "string" ? first.exceptionName : "",
        };
    } catch {
      /* not JSON */
    }
    return { message: cutText(text.trim(), 200), exception: "" };
  }

  /** A body read whole, or refused once it passes `maxBytes`. */
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

/**
 * Data Center refused a call with this status, before or instead of acting
 * on it; `exception` is its own exception name, which tells a 409's out-of-date
 * version, a veto and a conflict apart, and a 401's missing permission from a
 * refused token.
 */
export class DataCenterRefusal extends ForgeError {
  constructor(
    readonly status: number,
    readonly exception: string,
    message: string,
  ) {
    super(dataCenterFailureOf(status, exception), message);
    this.name = "DataCenterRefusal";
  }
}

export function dataCenterFailureOf(status: number, exception: string): ForgeFailure {
  if (status === 401) return /Authori[sz]ation/i.test(exception) ? "permission" : "sign-in";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429 || status >= 500) return "transient";
  return "refused";
}
