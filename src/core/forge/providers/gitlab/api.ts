import { type ApiRoute, apiShapeOf, nextPageOf } from "../../api";
import { ForgeError } from "../../forge";

/**
 * GitLab's gateway policy (`docs/forge.md`, "The gateway"): the GitHub
 * policy's rules in GitLab's paths. A read reaches whatever the key may
 * read (FI3-1571 piece 3: no read list). A write under the task's own
 * project, named by its URL-encoded path, goes at once; any other waits on
 * the captain's click (piece 4). No write deletes a project itself: the
 * app's GitHub sign-in cannot delete a repository, so neither does its
 * GitLab key.
 */

const SCOPE =
  "A read reaches whatever the key may read through the REST API; a write to this task's own project goes at once, and any other waits on the captain's click.";

/** A pipeline or job run again, or a manual job started: an accepted one gets a check reading. */
const RERUN = /^(?:jobs\/\d+\/(?:retry|play)|pipelines\/\d+\/retry)$/;

function refuse(why: string): never {
  throw new ForgeError("refused", why);
}

/**
 * Parse and check a GitLab request for a task whose project is `project`
 * (its full path, `group/subgroup/name`), or null for a task with none;
 * throws `ForgeError("refused")` naming the rule it broke.
 */
export function parseGitLabApiRequest(
  method: string,
  raw: string,
  project: string | null,
  bodyBytes = 0,
): ApiRoute {
  const {
    method: verb,
    write,
    segments,
    query,
  } = apiShapeOf(method, raw, bodyBytes, { encodedSlash: true, scope: SCOPE });
  if (segments[0]?.toLowerCase() === "graphql") {
    refuse("GraphQL is not available: the gateway sends REST calls only.");
  }
  const inProject = segments[0]?.toLowerCase() === "projects" && segments[1] !== undefined;
  const [, id = "", ...restSegments] = segments;
  if (write && verb === "DELETE" && inProject && restSegments.length === 0) {
    refuse("Deleting the project itself is not available.");
  }
  const isProject =
    inProject && project !== null && decodeURIComponent(id).toLowerCase() === project.toLowerCase();
  const rest = inProject ? restSegments.join("/") : "";
  const decoded = restSegments.map((segment) => decodeURIComponent(segment));
  const base =
    isProject && project
      ? `/projects/${encodeURIComponent(project)}${rest ? `/${rest}` : ""}`
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

/**
 * A release file is attached to a release, never sent to an absolute address.
 * The path names the release: `/projects/{id}/releases/{tag}`.
 */
export function gitLabReleaseUpload(raw: string, project: string | null): ApiRoute {
  if (/^https?:\/\//i.test(raw)) {
    refuse("A release file goes to the project's release, not another address.");
  }
  const route = parseGitLabApiRequest("POST", raw, project, 0);
  const rest = route.rest
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/")
    .replace(/\/+$/, "");
  const tag = rest.startsWith("releases/") ? rest.slice("releases/".length) : "";
  if (!tag || tag === "." || tag === "..") {
    refuse(
      "Give the release as /projects/{id}/releases/{tag}. The file is attached to that release.",
    );
  }
  return route;
}

/** The file name a release upload stores, after quotes and separators are stripped. */
export function gitlabReleaseFileName(file: string): string {
  return (file.split("/").pop() ?? "file").replace(/["\r\n\\/]/g, "") || "file";
}

/**
 * The release read, the package put, and the release link a GitLab file uses.
 * The card and the upload share this, so the names cannot drift.
 */
export function gitlabReleaseFileCalls(
  path: string,
  file: string,
): { release: string; put: string; link: string; filename: string } | undefined {
  const match = path.split("?")[0]?.match(/^\/projects\/([^/]+)\/releases\/(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  let tag: string;
  try {
    tag = decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
  if (!tag || tag === "." || tag === "..") return undefined;
  const version = encodeURIComponent(tag);
  const filename = gitlabReleaseFileName(file);
  const project = match[1];
  return {
    release: `/projects/${project}/releases/${version}`,
    put: `/projects/${project}/packages/generic/release/${version}/${encodeURIComponent(filename)}`,
    link: `/projects/${project}/releases/${version}/assets/links`,
    filename,
  };
}

/** GitLab's next page, under its policy for the task's project. */
export function nextGitLabPagePath(
  link: string | null,
  apiBase: string,
  project: string | null,
): string | null {
  return nextPageOf(link, apiBase, (method, raw) => parseGitLabApiRequest(method, raw, project));
}
