import { type ApiProject, type ApiRoute, apiShapeOf, nextPageOf } from "../../api";
import { ForgeError } from "../../forge";

/**
 * Bitbucket Cloud's gateway policy (`docs/forge.md`, "On Bitbucket"): the
 * GitHub policy's rules in Bitbucket's paths. A read reaches whatever the
 * key may read (no read list). A write under the task's own repository,
 * `/repositories/{workspace}/{repo_slug}/...` by its slugs, goes at once;
 * any other waits on the captain's click. No write deletes the repository
 * itself, as the app's GitHub sign-in cannot delete one. Bitbucket names a
 * page's size `pagelen`, and its next page sits in the answer's `next`.
 */

const SCOPE =
  // i18n-exempt: served to the crewmate in the gateway's answer
  "A read reaches whatever the key may read through the REST API (the part after /2.0); a write to this task's own repository goes at once, and any other waits on the captain's click.";

/** Bitbucket's name for a page's size. */
export const BITBUCKET_PAGE_PARAM = "pagelen";

function refuse(why: string): never {
  throw new ForgeError("refused", why);
}

/**
 * Parse and check a Bitbucket request for a task whose repository is
 * `project` (its workspace and repository slugs), or null for a task with
 * none; throws `ForgeError("refused")` naming the rule it broke.
 */
export function parseBitbucketApiRequest(
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
    pageParam: BITBUCKET_PAGE_PARAM,
  });
  if (segments[0]?.toLowerCase() === "graphql") {
    // i18n-exempt: served to the crewmate in the gateway's answer
    refuse("GraphQL is not available: the gateway sends REST calls only.");
  }
  const inRepository =
    segments[0] === "repositories" && Boolean(segments[1]) && Boolean(segments[2]);
  const [, workspace = "", slug = "", ...restSegments] = segments;
  if (write && verb === "DELETE" && inRepository && restSegments.every((part) => part === "")) {
    // i18n-exempt: served to the crewmate in the gateway's answer
    refuse("Deleting the repository itself is not available.");
  }
  const isProject =
    inRepository &&
    project !== null &&
    decodeURIComponent(workspace).toLowerCase() === project.owner.toLowerCase() &&
    decodeURIComponent(slug).toLowerCase() === project.name.toLowerCase();
  const rest = inRepository ? restSegments.join("/") : "";
  const base =
    isProject && project
      ? `/repositories/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}${restSegments.length > 0 ? `/${rest}` : ""}`
      : `/${segments.join("/")}`;
  return {
    method: verb,
    write,
    path: `${base}${query ? `?${query}` : ""}`,
    rest,
    // Bitbucket's API offers no rerun of a pipeline or a step; a start is a new pipeline.
    rerun: false,
    own: isProject,
  };
}

/**
 * A release file goes to the repository's Downloads, never to an absolute
 * address: `/repositories/{workspace}/{repo_slug}/downloads`.
 */
export function bitbucketReleaseUpload(raw: string, project: ApiProject | null): ApiRoute {
  if (/^https?:\/\//i.test(raw)) {
    // i18n-exempt: served to the crewmate in the gateway's answer
    refuse("A release file goes to the repository's Downloads, not another address.");
  }
  const route = parseBitbucketApiRequest("POST", raw.split("?")[0] ?? raw, project, 0);
  if (route.rest.replace(/\/+$/, "") !== "downloads") {
    refuse(
      // i18n-exempt: served to the crewmate in the gateway's answer
      "Give the release file's place as /repositories/{workspace}/{repo_slug}/downloads. The file goes to that repository's Downloads.",
    );
  }
  return route;
}

/** The file name a Downloads upload stores, after quotes and separators are stripped. */
export function bitbucketDownloadName(file: string): string {
  return (file.split("/").pop() ?? "file").replace(/["\r\n\\/]/g, "") || "file";
}

/** Bitbucket's next page, under its policy for the task's repository. */
export function nextBitbucketPagePath(
  link: string | null,
  apiBase: string,
  project: ApiProject | null,
): string | null {
  return nextPageOf(link, apiBase, (method, raw) => parseBitbucketApiRequest(method, raw, project));
}
