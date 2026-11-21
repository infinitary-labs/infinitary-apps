import type { Readable } from "node:stream";
import { type ChangeRequestKind, changeRequestKind } from "@shared/forgeKinds";
import { ForgeError } from "./forge";

/**
 * The JSON gateway's contract (`docs/forge.md`, "The gateway"): what a
 * forge's raw API answers, the checks every host's policy shares
 * (`apiShapeOf`), and GitHub's policy, which decides which requests a
 * crewmate may send there. A read reaches whatever the sign-in may read
 * (FI3-1571 piece 3: the host decides, there is no read list); GraphQL is
 * refused. A write is routed with whether it is the task's own project
 * (`own`): the gateway sends that one, and keeps any other for the
 * captain's click (piece 4). GitLab's policy keeps
 * the same rules in GitLab's paths (`providers/gitlab/api.ts`). The host
 * parses a relative path, never a URL, host, token or header from the
 * caller.
 */

export const API_REQUEST_MAX_BYTES = 256 * 1024;
export const API_RESPONSE_MAX_BYTES = 256 * 1024;
export const API_PER_PAGE_MAX = 100;
/**
 * The most of one oversized answer the gateway holds to page it: the largest
 * page, every item at the cap. An answer past it has items averaging over
 * the cap, so no smaller page of it would fit.
 */
export const API_OVERSIZE_HOLD_BYTES = API_PER_PAGE_MAX * API_RESPONSE_MAX_BYTES;
/** Calls a task may make through the gateway in one run of the app. */
export const API_CALLS_PER_TASK = 200;

/** The kinds whose REST API the crew reaches through the app's sign-in: every change-request kind. */
export type RawApiKind = ChangeRequestKind;

/** The kind, when the crew reaches its REST API. */
export function rawApiKind(kind: string | null | undefined): RawApiKind | undefined {
  return changeRequestKind(kind);
}

export type ApiProject = { owner: string; name: string };

export type ApiReadMethod = "GET" | "HEAD";
export type ApiWriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export type GithubReadInput = { path: string; method?: ApiReadMethod };
export type GithubWriteInput = {
  method: ApiWriteMethod;
  path: string;
  body?: string;
  validationEffect?: string;
  /** A regular file in the task's working copy, relative to it. Never a link. */
  file?: string;
};

/** A release file the gateway streams. The caller owns the stream until `upload` reads it. */
export type ReleaseUpload = {
  stream: Readable;
  size: number;
  contentType: string;
  filename: string;
};

export type ForgeApiResponse = {
  status: number;
  requestId: string | null;
  rateLimit: { remaining: number; resetAt: string | null } | null;
  retryAfterSeconds: number | null;
  /** The raw `Link` header, for the next page. */
  link: string | null;
  body: string;
};

/**
 * A forge's raw, signed JSON call, and the policy that decides what a
 * crewmate may send there. Every status answers; only transport and
 * sign-in fail. Each host keeps its own policy: GitHub's here
 * (`parseApiRequest`), GitLab's beside its forge.
 */
export interface ForgeApi {
  /** The host in a sentence: "GitHub", "GitLab", or a server's own address. */
  readonly place: string;
  /** The page size the host answers a list with when the read names no page size. */
  readonly defaultPerPage: number;
  /** The query key that names a page's size: `per_page`, or Bitbucket's `pagelen`. */
  readonly pageParam?: string;
  /** Parse and check a request; throws `ForgeError("refused")` naming the rule it broke. */
  route(method: string, raw: string, bodyBytes?: number): ApiRoute;
  /** The next page's relative path from a `Link` header, only where `route` would take it. */
  nextPath(link: string | null): string | null;
  call(
    method: ApiReadMethod | ApiWriteMethod,
    path: string,
    body?: string,
  ): Promise<ForgeApiResponse>;
  /**
   * Place a release-file upload: a relative assets path, or the release's
   * own upload address. Throws `ForgeError("refused")` unless it is this
   * host's upload address. Absent where the host takes no release file.
   */
  releaseUpload?(rawPath: string, filename: string): ApiRoute;
  /** Stream a release file to the route `releaseUpload` returned. */
  upload?(route: ApiRoute, file: ReleaseUpload): Promise<ForgeApiResponse>;
}

export type ApiRoute = {
  method: ApiReadMethod | ApiWriteMethod;
  write: boolean;
  /** Canonical path (the project's own spelling when it is the project), plus its query. */
  path: string;
  /** Path under the project, no query: `actions/runs/9/rerun-failed-jobs`; empty for a read elsewhere. */
  rest: string;
  /** A rerun of a workflow run or job: an accepted request gets a check reading. */
  rerun: boolean;
  /** The path is the task's own project; any other write waits on the captain's click. */
  own: boolean;
};

const READS = new Set(["GET", "HEAD"]);
const WRITES = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const RERUN = /^actions\/(?:runs\/\d+\/rerun(?:-failed-jobs)?|jobs\/\d+\/rerun)$/;

const SCOPE =
  "A read reaches whatever the sign-in may read through the REST API; a write to this task's own project goes at once, and any other waits on the captain's click.";

function refuse(why: string): never {
  throw new ForgeError("refused", why);
}

/**
 * An answer past the JSON cap, as the typed fact a read is paged from
 * (`smallerPage`): how many bytes it reached, and the answer whole when it
 * ended within `API_OVERSIZE_HOLD_BYTES`. Anywhere else it refuses like the
 * cap always has.
 */
export class OversizedAnswer extends ForgeError {
  constructor(
    readonly bytes: number,
    readonly whole: string | null,
  ) {
    super("refused", `The answer exceeds the ${API_RESPONSE_MAX_BYTES / 1024} KiB read limit.`);
    this.name = "OversizedAnswer";
  }
}

/**
 * A gateway answer's body within the JSON cap. A longer one is read on, up to
 * `API_OVERSIZE_HOLD_BYTES`, and thrown as an `OversizedAnswer`. A body that
 * breaks off mid-read throws the reader's own error, for the host to word.
 */
export async function gatewayAnswerBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > API_OVERSIZE_HOLD_BYTES) {
    await response.body?.cancel();
    throw new OversizedAnswer(declared, null);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > API_OVERSIZE_HOLD_BYTES) {
        await reader.cancel();
        throw new OversizedAnswer(size, null);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (size > API_RESPONSE_MAX_BYTES) {
    throw new OversizedAnswer(size, new TextDecoder().decode(bytes));
  }
  return bytes;
}

/** An answer's one list, and the answer with only some of its items. */
function listIn(
  answer: unknown,
): { items: unknown[]; withItems: (kept: unknown[]) => unknown } | null {
  if (Array.isArray(answer)) return { items: answer, withItems: (kept) => kept };
  if (answer === null || typeof answer !== "object") return null;
  const lists = Object.entries(answer).filter(([, field]) => Array.isArray(field));
  if (lists.length !== 1) return null;
  const [key, items] = lists[0] as [string, unknown[]];
  return { items, withItems: (kept) => ({ ...answer, [key]: kept }) };
}

/** The same read at a smaller page that fits the cap, or why no smaller page would. */
export type SmallerPage = { path: string; perPage: number } | { refused: string };

/**
 * The read `path` again at the largest `per_page` whose items fit the JSON
 * cap, at the same place in the list: the new size divides the items before
 * the asked page, and `page` moves to the same first item, so the host's own
 * next page continues from it. The answer's items are the answer when it is
 * a list, or the one list it holds (a run listing's `workflow_runs`, a
 * search's `items`, Bitbucket's `values`); their sizes in the held answer say
 * how many fit. A path with no page size asked for the host's
 * `defaultPerPage`; `pageParam` is the host's name for that size.
 */
export function smallerPage(
  path: string,
  answer: OversizedAnswer,
  defaultPerPage: number,
  pageParam = "per_page",
): SmallerPage {
  const limit = `${API_RESPONSE_MAX_BYTES / 1024} KiB`;
  const [pathPart = "", query = ""] = path.split(/\?(.*)/s, 2);
  const params = new URLSearchParams(query);
  const askedSize = params.get(pageParam);
  const askedPage = params.get("page");
  if (askedPage !== null && !/^[1-9]\d*$/.test(askedPage)) {
    return { refused: "Its page is not a page number, so a smaller page cannot keep its place." };
  }
  const perPage = askedSize === null ? defaultPerPage : Number(askedSize);
  const page = askedPage === null ? 1 : Number(askedPage);
  if (answer.whole === null) {
    return {
      refused: `It passes ${API_OVERSIZE_HOLD_BYTES / 1024 / 1024} MiB, more than ${perPage} items of ${limit} each, so no smaller page would fit.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.whole);
  } catch {
    return { refused: "It is not JSON, so a smaller page cannot be read." };
  }
  const list = listIn(parsed);
  // The held answer's own bytes per byte of its compact form, so a host that
  // indents its answers is measured as it sends them.
  const scale = answer.bytes / Buffer.byteLength(JSON.stringify(parsed));
  let bytes = list ? Buffer.byteLength(JSON.stringify(list.withItems([]))) : Infinity;
  if (!list || list.items.length === 0 || bytes * scale > API_RESPONSE_MAX_BYTES) {
    return { refused: "It is one object, not a list, so a smaller page would not shrink it." };
  }
  const { items } = list;
  if (items.length > perPage) {
    return {
      refused: `It holds ${items.length} items where a page holds ${perPage}, so ${pageParam} does not page it.`,
    };
  }
  let fit = 0;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + (fit > 0 ? 1 : 0);
    if (bytes * scale > API_RESPONSE_MAX_BYTES) break;
    fit += 1;
  }
  if (fit === 0) {
    return {
      refused: `Its first item alone passes ${limit}, so even a page of one would not fit.`,
    };
  }
  const before = (page - 1) * perPage;
  let size = fit;
  while (before % size !== 0) size -= 1;
  const nextPage = before / size + 1;
  params.set(pageParam, String(size));
  if (askedPage !== null || nextPage > 1) params.set("page", String(nextPage));
  return { path: `${pathPart}?${params.toString()}`, perPage: size };
}

/** A request past the checks every host's policy shares, for that policy to place. */
export type ApiShape = {
  method: ApiRoute["method"];
  write: boolean;
  /** The path's raw segments, still encoded: `["repos", "octo", "meter", "pulls"]`. */
  segments: string[];
  /** The query in canonical form, without its `?`; empty when there is none. */
  query: string;
};

/**
 * The checks every host's policy shares: a method the gateway sends, a body
 * within its bounds, a relative path with no transport tricks, and a query
 * that repeats no key and asks no page over 100 (`pageParam`, `per_page`
 * unless the host names its own). `encodedSlash` is
 * GitLab's paths: a segment may carry `%2F`, as its project and group ids
 * and file paths do, each piece it decodes to is held to the same rules as
 * a segment, and no segment may be empty, a trailing one included.
 */
export function apiShapeOf(
  method: string,
  raw: string,
  bodyBytes: number,
  rules: { encodedSlash: boolean; scope: string; pageParam?: string },
): ApiShape {
  const pageParam = rules.pageParam ?? "per_page";
  const verb = method.toUpperCase();
  const write = WRITES.has(verb);
  if (!write && !READS.has(verb)) refuse(`${method} is not a method the gateway sends.`);
  if (bodyBytes > API_REQUEST_MAX_BYTES) refuse("The request body exceeds 256 KiB.");
  if (!write && bodyBytes > 0) refuse("A read carries no body.");
  if (typeof raw !== "string" || !raw.startsWith("/")) {
    refuse(`Give a relative path, never a URL or host. ${rules.scope}`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000- \u007f\\#]/.test(raw))
    refuse("The path holds a space, control character, backslash or fragment.");
  const [pathPart = "", query = ""] = raw.split(/\?(.*)/s, 2);
  if (rules.encodedSlash && /%(?:5c|2e|00|25)/i.test(pathPart))
    refuse("The path holds an encoded backslash, dot, percent sign or null.");
  if (!rules.encodedSlash && /%(?:2f|5c|2e|00)/i.test(pathPart))
    refuse("The path holds an encoded separator or dot.");
  const segments = pathPart.split("/").slice(1);
  if (pathPart.includes("//") || (rules.encodedSlash && segments.includes("")))
    refuse("The path holds an empty segment.");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    refuse("The path holds a . or .. segment.");
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      refuse("The path holds an invalid escape.");
    }
    if (!rules.encodedSlash || decoded === segment) continue;
    const pieces = decoded.split("/");
    if (pieces.some((piece) => piece === "")) refuse("The path holds an empty segment.");
    if (pieces.some((piece) => piece === "." || piece === "..")) {
      refuse("The path holds a . or .. segment.");
    }
  }
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) refuse(`The query repeats "${key}".`);
    seen.add(key);
    if (
      key === pageParam &&
      !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= API_PER_PAGE_MAX)
    ) {
      refuse(`${pageParam} must be 1 to ${API_PER_PAGE_MAX}.`);
    }
  }
  return { method: verb as ApiRoute["method"], write, segments, query: params.toString() };
}

/**
 * The next page's relative path from a `Link` header, only when it stays on
 * the API origin - under the API's own path, such as `/api/v3` on a GitHub
 * Enterprise Server or `/api/v4` on GitLab - and `route` takes it as a read.
 */
export function nextPageOf(
  link: string | null,
  apiBase: string,
  route: (method: string, raw: string) => ApiRoute,
): string | null {
  const next = link?.split(",").find((part) => /rel="next"/.test(part));
  const target = next?.match(/<([^>]+)>/)?.[1];
  if (!target) return null;
  try {
    const url = new URL(target);
    const base = new URL(apiBase);
    if (url.origin !== base.origin) return null;
    const prefix = base.pathname.replace(/\/+$/, "");
    if (prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    return route("GET", `${url.pathname.slice(prefix.length)}${url.search}`).path;
  } catch {
    return null;
  }
}

/** Parse and check a GitHub request; throws `ForgeError("refused")` naming the rule it broke. */
export function parseApiRequest(
  method: string,
  raw: string,
  project: ApiProject | null,
  bodyBytes = 0,
): ApiRoute {
  const {
    method: verb,
    write,
    segments,
    query,
  } = apiShapeOf(method, raw, bodyBytes, {
    encodedSlash: false,
    scope: SCOPE,
  });
  const lead = segments[0]?.toLowerCase();
  if (lead === "graphql") refuse("GraphQL is not available: the gateway sends REST calls only.");
  const inRepos = lead === "repos";
  if (inRepos && (segments[1] === undefined || segments[2] === undefined)) {
    refuse("A repository path is /repos/{owner}/{repo}/....");
  }
  const [, owner = "", name = "", ...restSegments] = segments;
  const isProject =
    inRepos &&
    project !== null &&
    owner.toLowerCase() === project.owner.toLowerCase() &&
    name.toLowerCase() === project.name.toLowerCase();
  const rest = inRepos ? restSegments.join("/") : "";
  // Decode only to recognize a rerun for its check reading; project operations
  // are not filtered by endpoint names. Scope and transport checks are above.
  const decoded = restSegments.map((segment) => decodeURIComponent(segment));
  const base =
    isProject && project
      ? `/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}${rest ? `/${restSegments.join("/")}` : ""}`
      : `/${segments.join("/")}`;
  return {
    method: verb,
    write,
    path: `${base}${query ? `?${query}` : ""}`,
    rest,
    rerun: isProject && write && verb === "POST" && RERUN.test(decoded.join("/")),
    own: isProject,
  };
}

/** GitHub's next page, under its policy for the task's project. */
export function nextPagePath(
  link: string | null,
  apiBase: string,
  project: ApiProject | null,
): string | null {
  return nextPageOf(link, apiBase, (method, raw) => parseApiRequest(method, raw, project));
}
