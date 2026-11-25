/**
 * GitHub's asynchronous merge (`PUT .../merge-async`), the call every merge
 * on GitHub goes through, and the request GitHub holds for a pull request
 * while it runs (docs/forge.md, "The host's merge queue" and "A merge
 * request GitHub holds"). `GitHubForge` owns the sign-in and the HTTP; this
 * file owns the call's own protocol.
 */

import {
  ForgeError,
  type ForgeMergeRequest,
  ForgeMergeUnconfirmed,
  type MergeAnswer,
} from "../../forge";

/** GitHub documents its asynchronous merge at this version. */
export const ASYNC_MERGE_API_VERSION = "2026-03-10";
/** How long the app waits before each read of an asynchronous merge's result; after the last it calls the result unknown. */
const ASYNC_MERGE_READ_DELAYS_MS = [250, 500, 1000, 2000, 3000, 4000];

export type AsyncMergeJson = {
  status?: string;
  details?: { uuid?: string; message?: string; sha?: string };
};

/** One request to GitHub at the asynchronous merge's API version, answered with its JSON. */
type Ask = (method: "PUT" | "GET", path: string, body?: object) => Promise<unknown>;

/** What a merge within the rules names: GitHub as the person calls it, and the pull request's label. */
type Ordinary = { place: string; label: string };

/**
 * GitHub's 409 to a background merge request: it already holds one for that
 * pull request, whose id (`request`) its answer names, with that request's
 * merge options.
 */
export class MergeAlreadyHeld extends ForgeError {
  constructor(
    message: string,
    readonly request?: string,
  ) {
    super("transient", message);
    this.name = "MergeAlreadyHeld";
  }
}

/**
 * The failure a 409 to a background merge request is. A version that moved
 * is GitHub's verdict and is left to the caller (undefined); any other says
 * GitHub already holds a merge request of that pull request.
 */
export function mergeAlreadyHeld(
  status: number,
  method: string,
  path: string,
  said: string,
  text: string,
  what: string,
): MergeAlreadyHeld | undefined {
  if (
    status !== 409 ||
    method !== "PUT" ||
    !/\/pulls\/\d+\/merge-async(\?|$)/.test(path) ||
    /^Head branch was modified\b/i.test(said)
  )
    return undefined;
  let request: string | undefined;
  try {
    const uuid = (JSON.parse(text) as { details?: { uuid?: unknown } }).details?.uuid;
    if (typeof uuid === "string") request = uuid;
  } catch {
    // A 409 with no body names no request.
  }
  return new MergeAlreadyHeld(what, request);
}

/**
 * Send one asynchronous merge and read its result by the id GitHub
 * returns until it is no longer pending or the reads end. Sent once: a
 * result the app could not read in time is unknown, never a reason to
 * send again. `ordinary` marks a merge within the rules, whose request
 * GitHub may answer with one it already holds for that pull request (a
 * 409): that request is read once by its id, and while it is still pending
 * the answer is `ForgeMergeUnconfirmed` with the id. `direct` is the merge
 * for a GitHub that does not know the call.
 */
export async function asyncMerge(
  ask: Ask,
  sleep: (ms: number) => Promise<void>,
  path: string,
  body: object,
  how?: { ordinary: Ordinary; direct?: () => Promise<MergeAnswer> },
): Promise<AsyncMergeJson | { direct: MergeAnswer } | null> {
  let reading: AsyncMergeJson | null;
  try {
    reading = (await ask("PUT", path, body)) as AsyncMergeJson;
  } catch (caught) {
    if (!(caught instanceof ForgeError)) throw caught;
    // A GitHub that does not know the call, or the version it is documented
    // at (an Enterprise Server that supports only an older version answers
    // 400 "... is not a supported version"), sent nothing on.
    const unknown =
      caught.failure === "not-found" ||
      /^GitHub answered 400 [^:]*: .*\b(?:API version|is not a supported version)\b/i.test(
        caught.message,
      );
    if (how?.direct && unknown) return { direct: await how.direct() };
    if (!(caught instanceof MergeAlreadyHeld)) throw caught;
    // A merge past the rules reads no other request's outcome: its 409 is GitHub's refusal.
    if (!how?.ordinary) throw new ForgeError("refused", caught.message);
    throw await heldInstead(ask, path, how.ordinary, caught);
  }
  for (const delay of ASYNC_MERGE_READ_DELAYS_MS) {
    const uuid = pendingId(reading);
    if (!uuid) break;
    await sleep(delay);
    try {
      reading = (await ask("GET", `${path}/${encodeURIComponent(uuid)}`)) as AsyncMergeJson | null;
    } catch (caught) {
      // A result GitHub no longer keeps leaves the outcome unknown, like one still pending.
      if (caught instanceof ForgeError && caught.failure === "not-found") break;
      throw caught;
    }
  }
  return reading;
}

/** The id of a request GitHub took and has not finished. */
export function pendingId(reading: AsyncMergeJson | null): string | undefined {
  return reading?.status === "pending" ? reading.details?.uuid : undefined;
}

/**
 * GitHub answered a merge request with one it already holds for that pull
 * request. The held request is read once by its id: still pending, nothing
 * was sent on and it is the one to follow; ended, or not named, the pull
 * request is read before anything else.
 */
async function heldInstead(
  ask: Ask,
  path: string,
  { place, label }: Ordinary,
  held: MergeAlreadyHeld,
): Promise<ForgeError> {
  if (!held.request)
    return new ForgeMergeUnconfirmed(
      // i18n-exempt: a forge failure's words, read by the first mate and kept on the timeline in English
      `${place} is holding an earlier merge request of ${label} and did not name it, so this one was not taken`,
      undefined,
      true,
    );
  let reading: AsyncMergeJson | null = null;
  try {
    reading = (await ask(
      "GET",
      `${path}/${encodeURIComponent(held.request)}`,
    )) as AsyncMergeJson | null;
  } catch (caught) {
    if (!(caught instanceof ForgeError)) throw caught;
  }
  if (reading === null || reading.status === "pending")
    return new ForgeMergeUnconfirmed(
      // i18n-exempt: a forge failure's words, read by the first mate and kept on the timeline in English
      `${place} is holding an earlier merge request of ${label} (${held.request}) that has not finished, so this one was not taken`,
      held.request,
      true,
    );
  return new ForgeError(
    "transient",
    // i18n-exempt: a forge failure's words, read by the first mate and kept on the timeline in English
    `the earlier merge request of ${label} that ${place} was holding ended (${reading.status ?? "no status"}), so this one was not taken`,
  );
}

/** How the merge request GitHub holds under `path` stands, by its id (`Forge.heldMergeState`). */
export async function heldMergeState(
  ask: Ask,
  path: string,
  place: string,
): Promise<ForgeMergeRequest> {
  let reading: AsyncMergeJson | null;
  try {
    reading = (await ask("GET", path)) as AsyncMergeJson | null;
  } catch (caught) {
    // GitHub keeps a result for a day after its last change, then answers 404 for its id.
    if (caught instanceof ForgeError && caught.failure === "not-found") return { status: "gone" };
    throw caught;
  }
  const message = reading?.details?.message;
  switch (reading?.status) {
    case "pending":
      return { status: "pending" };
    case "merged":
      return { status: "merged" };
    case "enqueued":
      return { status: "queued" };
    case "failed":
      return { status: "failed", ...(message ? { message } : {}) };
    default:
      // i18n-exempt: a forge failure's words, read by the first mate and kept on the timeline in English
      throw new ForgeError("transient", `${place} did not say how a held merge request stands`);
  }
}
