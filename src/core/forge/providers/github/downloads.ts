import { GITHUB_COM } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { ForgeError } from "../../forge";
import type { ArchiveRanges } from "../../workflows";
import { failureOf } from "./failures";

const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;

export type GitHubDownloadEnv = {
  base: string;
  place: string;
  host: string | null;
  fetch: typeof fetch;
  token: () => Promise<string | undefined>;
  onSignInRejected: () => void;
};

/** A workflow's evidence downloaded through GitHub's signed redirects (`docs/forge.md`, workflow evidence). */
export class GitHubDownloads {
  constructor(private readonly env: GitHubDownloadEnv) {}

  /** Follow signed download redirects manually: the sign-in never leaves the API origin. */
  async downloadBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    const token = await this.env.token();
    if (!token)
      throw new ForgeError("sign-in", notSignedInText(this.env.place, this.env.host ?? GITHUB_COM));
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return downloadAnswer(async () => {
      const { response } = await this.signedGet(
        { url: new URL(`${this.env.base}${path}`), authenticated: true },
        token,
        path,
        signal,
      );
      return await boundedBytes(response, maxBytes);
    });
  }

  /**
   * The archive behind `path` read in parts (`ArchiveRanges`): the first
   * part follows the redirects as a whole download does, later parts go
   * straight to the storage it reached, and each part has its own request
   * bound. A large file may take longer than a single request. Storage that
   * does not answer a part with exactly those bytes is refused, never read whole.
   */
  async archiveRanges(path: string, size: number): Promise<ArchiveRanges> {
    const token = await this.env.token();
    if (!token)
      throw new ForgeError("sign-in", notSignedInText(this.env.place, this.env.host ?? GITHUB_COM));
    let at = { url: new URL(`${this.env.base}${path}`), authenticated: true };
    const read = (start: number, end: number) =>
      downloadAnswer(async () => {
        if (!Number.isSafeInteger(start) || start < 0 || end > size || start >= end)
          throw new ForgeError("refused", "The archive part asked for is outside the archive.");
        const reached = await this.signedGet(
          at,
          token,
          path,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          `bytes=${start}-${end - 1}`,
        );
        at = { url: reached.url, authenticated: reached.authenticated };
        const { response } = reached;
        if (
          response.status !== 206 ||
          !samePart(response.headers.get("content-range"), start, end, size)
        ) {
          await response.body?.cancel();
          throw new ForgeError(
            "refused",
            "GitHub's storage did not send the part of the archive asked for, so the archive cannot be read in parts.",
          );
        }
        const bytes = await boundedBytes(response, end - start, "The archive part");
        if (bytes.byteLength !== end - start)
          throw new ForgeError(
            "transient",
            "GitHub's storage sent a part of the archive short; try a fresh read.",
          );
        return bytes;
      });
    return { size, read };
  }

  /**
   * One GET of a workflow download through GitHub's signed redirects: the
   * sign-in goes only with the request to the API, and a next address must
   * be GitHub's HTTPS storage. Answers the final response and where it came
   * from, so a later part can go straight there.
   */
  private async signedGet(
    from: { url: URL; authenticated: boolean },
    token: string,
    path: string,
    signal: AbortSignal,
    range?: string,
  ): Promise<{ response: Response; url: URL; authenticated: boolean }> {
    let { url, authenticated } = from;
    const apiOrigin = new URL(this.env.base).origin;
    for (let hops = 0; hops <= 3; hops++) {
      const response = await this.env.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          ...(authenticated
            ? {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
              }
            : {}),
          ...(range ? { Range: range } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new ForgeError("refused", "GitHub supplied no download address.");
        const next = new URL(location, url);
        // Dev stubs can redirect within their own origin. Production only follows
        // GitHub's HTTPS storage; neither credentials nor a signed URL are returned.
        const storage =
          next.protocol === "https:" &&
          (next.hostname.endsWith(".githubusercontent.com") ||
            next.hostname.endsWith(".blob.core.windows.net"));
        if (next.username || next.password || (next.origin !== apiOrigin && !storage)) {
          throw new ForgeError("refused", "GitHub supplied an unsafe download address.");
        }
        url = next;
        authenticated = false;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (authenticated && response.status === 401) this.env.onSignInRejected?.();
        if (response.status === 410)
          throw new ForgeError("not-found", "The workflow evidence has expired on GitHub.");
        if (!authenticated)
          throw new ForgeError(
            "refused",
            `The workflow download answered ${response.status}; request a fresh download.`,
          );
        throw failureOf(response, "GET", path, "");
      }
      return { response, url, authenticated };
    }
    throw new ForgeError("refused", "GitHub redirected the workflow download too many times.");
  }
}

/** A workflow download's answer: fetch failures may hold a signed storage URL, so they are never echoed. */
async function downloadAnswer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (caught) {
    if (caught instanceof ForgeError) throw caught;
    throw new ForgeError(
      "transient",
      "Could not finish the workflow download from GitHub; try a fresh read.",
    );
  }
}

/** Whether storage's Content-Range names exactly the part asked for, of an archive this size. */
function samePart(header: string | null, start: number, end: number, size: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
  return (
    !!match &&
    Number(match[1]) === start &&
    Number(match[2]) === end - 1 &&
    Number(match[3]) === size
  );
}

/** Bound the actual response, not only the host's size metadata. */
async function boundedBytes(
  response: Response,
  maxBytes: number,
  what = "The workflow evidence",
): Promise<Uint8Array> {
  const limit =
    maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes / 1024} KiB`;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ForgeError("refused", `${what} exceeds the ${limit} read limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ForgeError("refused", `${what} exceeds the ${limit} read limit.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}
