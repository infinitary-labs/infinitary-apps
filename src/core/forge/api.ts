import type { Readable } from "node:stream";
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
/** Calls a task may make through the gateway in one run of the app. */
export const API_CALLS_PER_TASK = 200;

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
 * that repeats no key and asks no page over 100. `encodedSlash` is
 * GitLab's paths: a segment may carry `%2F`, as its project and group ids
 * and file paths do, each piece it decodes to is held to the same rules as
 * a segment, and no segment may be empty, a trailing one included.
 */
export function apiShapeOf(
  method: string,
  raw: string,
  bodyBytes: number,
  rules: { encodedSlash: boolean; scope: string },
): ApiShape {
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
      key === "per_page" &&
      !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= API_PER_PAGE_MAX)
    ) {
      refuse(`per_page must be 1 to ${API_PER_PAGE_MAX}.`);
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
