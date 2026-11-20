import { settingFrom } from "@shared/envSettings";
import { forgePlace } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { cutText } from "@shared/textCut";
import { API_RESPONSE_MAX_BYTES } from "../../api";
import { ForgeError, type ForgeFailure } from "../../forge";

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

  /** One read of a path under the API, or of a `next` page link Bitbucket gave on that API. */
  async get<T>(pathOrLink: string): Promise<T> {
    const path = this.pathOf(pathOrLink);
    const token = await this.options.token();
    if (!token) throw new ForgeError("sign-in", notSignedInText(this.place, this.host));
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.apiBaseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    if (!response.ok) {
      const said = await this.words(response);
      const what = `${this.place} answered ${response.status} to GET ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
      if (response.status === 401) this.options.onSignInRejected?.();
      throw new ForgeError(failureOf(response.status), what);
    }
    const text = await this.bounded(response, API_RESPONSE_MAX_BYTES);
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new ForgeError("transient", `${this.place}'s answer could not be read.`);
    }
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

  /** Bitbucket's own words for a refusal, bounded: `error.message`, else the text. */
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
    } catch {
      /* not JSON */
    }
    return cutText(text.trim(), 200);
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

function failureOf(status: number): ForgeFailure {
  if (status === 401) return "sign-in";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429 || status >= 500) return "transient";
  return "refused";
}
