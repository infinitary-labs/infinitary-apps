import { type ApiProject, type ApiRoute, apiShapeOf, nextPageOf } from "../../api";
import { ForgeError } from "../../forge";
import { dataCenterProjectKey } from "./dataCenterProjects";

/**
 * Bitbucket Data Center's gateway policy (`docs/forge.md`, "On Bitbucket
 * Data Center"): the GitHub policy's rules in the server's own paths. A
 * path is the part after the server's address and starts with `/rest/`,
 * as every one of its REST APIs does (`/rest/api/latest/...`,
 * `/rest/build-status/latest/...`, `/rest/branch-utils/latest/...`). A
 * read reaches whatever the token may read (no read list). A write under
 * the task's own repository,
 * `/rest/{api}/{version}/projects/{KEY}/repos/{slug}/...`, goes at once;
 * any other waits on the captain's click. A person's own project is
 * `/projects/~{name}` or `/users/{name}`. No write deletes the repository
 * itself. The server names a page's size `limit` and its place `start`,
 * and the next page's place sits in the answer's `nextPageStart`.
 */

const SCOPE =
  // i18n-exempt: served to the crewmate in the gateway's answer
  "A path is the part after the server's address, starting with /rest/. A read reaches whatever the token may read through the REST API; a write to this task's own repository goes at once, and any other waits on the captain's click.";

/** Data Center's name for a page's size. */
export const DATA_CENTER_PAGE_PARAM = "limit";

/** The page size Data Center answers a list with when the read names none. */
export const DATA_CENTER_DEFAULT_PAGE_LENGTH = 25;

function refuse(why: string): never {
  throw new ForgeError("refused", why);
}

/**
 * Parse and check a Data Center request for a task whose repository is
 * `project` (its project key or `scm/key` owner, and slug), or null for a
 * task with none; throws `ForgeError("refused")` naming the rule it broke.
 * A route's `rest` is the API's name and the path under the repository:
 * `api/pull-requests/3/merge`, `branch-utils/branches`, or `api` for the
 * repository itself.
 */
export function parseDataCenterApiRequest(
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
    pageParam: DATA_CENTER_PAGE_PARAM,
  });
  if (segments[0] !== "rest" || !segments[1] || !segments[2]) {
    // i18n-exempt: served to the crewmate in the gateway's answer
    refuse(`Give a REST path such as /rest/api/latest/... ${SCOPE}`);
  }
  const [, module = "", version = "", root = "", owner = "", repos = "", slug = "", ...under] =
    segments;
  const inRepository =
    (root === "projects" || root === "users") && Boolean(owner) && repos === "repos" && !!slug;
  if (write && verb === "DELETE" && inRepository && under.every((part) => part === "")) {
    // i18n-exempt: served to the crewmate in the gateway's answer
    refuse("Deleting the repository itself is not available.");
  }
  const key = inRepository
    ? root === "users"
      ? `~${decodeURIComponent(owner).toLowerCase()}`
      : dataCenterProjectKey(decodeURIComponent(owner))
    : "";
  const isProject =
    inRepository &&
    project !== null &&
    key === dataCenterProjectKey(project.owner) &&
    decodeURIComponent(slug).toLowerCase() === project.name.toLowerCase();
  const below = under.join("/").replace(/\/+$/, "");
  const rest = inRepository ? (below ? `${module}/${below}` : module) : "";
  const base =
    isProject && project
      ? `/rest/${module}/${version}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(project.name.toLowerCase())}${under.length > 0 ? `/${under.join("/")}` : ""}`
      : `/${segments.join("/")}`;
  return {
    method: verb,
    write,
    path: `${base}${query ? `?${query}` : ""}`,
    rest,
    // Data Center runs no checks of its own, so nothing reruns one.
    rerun: false,
    own: isProject,
  };
}

/**
 * The next page of a Data Center list answer, as a `Link` header names it:
 * the same read with `start` at the answer's `nextPageStart`, under the
 * server's address. Null when the answer is the last page or is no list.
 */
export function dataCenterNextLink(serverUrl: string, path: string, text: string): string | null {
  let parsed: { isLastPage?: unknown; nextPageStart?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.isLastPage !== false ||
    typeof parsed.nextPageStart !== "number" ||
    !Number.isSafeInteger(parsed.nextPageStart) ||
    parsed.nextPageStart < 0
  )
    return null;
  const [pathPart = "", query = ""] = path.split(/\?(.*)/s, 2);
  const params = new URLSearchParams(query);
  params.set("start", String(parsed.nextPageStart));
  return `<${serverUrl}${pathPart}?${params.toString()}>; rel="next"`;
}

/** Data Center's next page, under its policy for the task's repository. */
export function nextDataCenterPagePath(
  link: string | null,
  serverUrl: string,
  project: ApiProject | null,
): string | null {
  return nextPageOf(link, serverUrl, (method, raw) =>
    parseDataCenterApiRequest(method, raw, project),
  );
}
