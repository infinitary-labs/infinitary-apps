import type { ForgeProject } from "./forge";
import { isSignInForgeFailure } from "./forge";
import { renderSignInRefusal, signInRefusal } from "./signInRefusal";

/**
 * locate_project's remote half (git integration PR 1.2): the person's
 * projects where they live, from the app's own sign-in, so the Firstmate's
 * "which project?" card is one call rather than a request for a link. No
 * new tool - the Firstmate's count stays 24.
 *
 * With a sign-in, the listing reads every page the host gives, looks up an
 * exact owner/name (or a pasted address) on its own, matches loosely
 * (case, spaces, dashes, underscores and a github.com/.git wrapper do not
 * matter), says how many projects it searched, and names what matches
 * first, else the newest.
 * Without one, it says so - with the sign-in way - only when nothing was
 * found on this Mac either: a project found here never needs a host, and
 * nothing here suggests it does.
 */

const MAX_LISTED = 8;

export type RemoteHost = {
  host: string;
  name: string;
  signedIn: boolean;
  login: string | null;
  /** Every project the sign-in lists, and whether that is all of them. */
  list: () => Promise<{ projects: ForgeProject[]; complete: boolean }>;
  /** One project by its exact owner/name, or null; absent where the host cannot. */
  find?: (fullName: string) => Promise<ForgeProject | null>;
  /** Project owners may have multiple path segments; page routes then use /-/. */
  nestedNamespace?: boolean;
};

/** What a captain wrote for a project, reduced to the owner/name it may mean, or null. */
export function exactName(written: string, nestedNamespace = false): string | null {
  const text = written
    .trim()
    .replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/:\s]*\.[^/:\s]+[:/]/i, "")
    .replace(/[?#].*$/, "");
  const segments = text.split("/").filter((part) => part !== "");
  // GitLab marks page routes with /-/ so subgroup names can be kept whole.
  const route = segments.indexOf("-");
  const githubRoute = segments.findIndex(
    (part, index) =>
      index >= 2 && /^(?:tree|blob|pull|pulls|issues|actions|commit|commits|releases)$/.test(part),
  );
  const end =
    route >= 2 ? route : !nestedNamespace && githubRoute >= 2 ? githubRoute : segments.length;
  const project = segments.slice(0, end);
  if (
    (!nestedNamespace && project.length > 2) ||
    project.length < 2 ||
    project.some((part) => /\s/.test(part) || part === "." || part === "..")
  )
    return null;
  return project.join("/").replace(/\.git$/i, "");
}

/** Case, spaces, dashes, underscores, dots and slashes do not tell two names apart. */
function loose(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function remoteProjectsText(input: {
  name: string;
  foundLocally: boolean;
  hosts: RemoteHost[];
}): Promise<string> {
  const parts: string[] = [];
  for (const host of input.hosts) {
    if (!host.signedIn) {
      if (input.foundLocally) continue;
      parts.push(
        renderSignInRefusal(
          signInRefusal({
            host: host.host,
            name: host.name,
            context: `with the captain's ${host.name} sign-in, the projects there are listed here too.`,
          }),
        ),
      );
      continue;
    }
    let projects: ForgeProject[];
    let complete: boolean;
    try {
      ({ projects, complete } = await host.list());
    } catch (caught) {
      if (isSignInForgeFailure(caught)) {
        parts.push(
          renderSignInRefusal(
            signInRefusal({
              host: host.host,
              name: host.name,
              context: `${host.name} no longer accepts the sign-in, so its projects cannot be listed.`,
            }),
          ),
        );
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        parts.push(`Could not list the projects on ${host.name}: ${message}`);
      }
      continue;
    }
    const written = input.name.trim();
    const exact = exactName(written, host.nestedNamespace);
    const needle = loose(exact ?? written);
    const matching = projects.filter((project) => loose(project.fullName).includes(needle));
    if (
      exact &&
      host.find &&
      !projects.some((p) => p.fullName.toLowerCase() === exact.toLowerCase())
    ) {
      try {
        const found = await host.find(exact);
        if (found) matching.unshift(found);
      } catch {
        // The listing above still stands; a failed lookup is a miss, not an error.
      }
    }
    const who = host.login ? `, signed in as ${host.login}` : "";
    const searched = `searched ${projects.length} ${projects.length === 1 ? "project" : "projects"}${
      complete ? "" : ", the newest only: older ones were not read"
    }`;
    if (matching.length > 0) {
      parts.push(
        [
          `On ${host.name}${who} (${searched}):`,
          ...matching.slice(0, MAX_LISTED).map(projectLine),
        ].join("\n"),
      );
    } else if (projects.length > 0) {
      parts.push(
        [
          `On ${host.name}${who} (${searched}): nothing named like "${input.name}"${
            exact ? ` and no ${exact} the sign-in can see` : ""
          }; the newest are:`,
          ...projects.slice(0, MAX_LISTED).map(projectLine),
        ].join("\n"),
      );
    } else {
      parts.push(`On ${host.name}${who}: no projects.`);
    }
  }
  return parts.join("\n\n");
}

/** One listed project: its name, when it last changed, and what app_change project-setup kind clone takes. */
function projectLine(project: ForgeProject): string {
  const updated = project.updatedAt ? ` (updated ${project.updatedAt.slice(0, 10)})` : "";
  const kept = project.private ? " | private" : "";
  return `- ${project.fullName}${updated}${kept} | clone origin ${project.cloneUrl}`;
}
