import type { IntegrationScope } from "@shared/writeAsk";

/**
 * What one Allow for the rest of this task covers for each kind
 * (docs/integrations.md, "The rules"; INF-2993): the same kind of request
 * to the same place. An action with no scope of its own is covered whole on
 * its connection (`IntegrationActionSpec.scope`).
 */

/** The scope of an action whose kind names no narrower place. */
export const WHOLE_ACTION: IntegrationScope = { key: "", words: "any input" };

/**
 * A path segment that could leave the place it seems to be in: a dot
 * segment, an escaped dot (which a URL reads as one) or a backslash.
 */
const UNSAFE_SEGMENT = /^\.{1,2}$|%2e|%5c|\\/i;
/** An escaped slash: only a GitLab project's id holds one, as its encoded path. */
const ESCAPED_SLASH = /%2f/i;

/**
 * The path's segments without its query or fragment, and whether any is
 * unsafe; `encodedAt` is the one segment that may hold an escaped slash.
 */
function segments(path: string, encodedAt?: number): { parts: string[]; unsafe: boolean } {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const parts = bare.split("/").filter((part, index) => index > 0 || part !== "");
  return {
    parts,
    unsafe: parts.some(
      (part, index) =>
        UNSAFE_SEGMENT.test(part) || (index !== encodedAt && ESCAPED_SLASH.test(part)),
    ),
  };
}

/** The path without its query or fragment, with one leading slash. */
function bare(path: string): string {
  const head = path.split(/[?#]/, 1)[0] ?? "";
  return head.startsWith("/") ? head : `/${head}`;
}

/**
 * A REST call through a forge's sign-in (GitHub, GitHub Enterprise or
 * GitLab): the method plus the repository (`/repos/{owner}/{repo}`, in
 * lower case) or the GitLab project (`/projects/{id}`). A path outside one,
 * or one with a segment that could leave it, is its own place, exactly as
 * written without its query.
 */
export function forgeScope(kind: "github" | "gitlab"): (input: unknown) => IntegrationScope {
  return (input) => {
    const { method = "GET", path } = input as { method?: string; path: string };
    const { parts, unsafe } = segments(path, kind === "gitlab" ? 1 : undefined);
    const [root, first, second] = parts;
    if (!unsafe && kind === "github" && root === "repos" && first && second) {
      const place = `${first}/${second}`.toLowerCase();
      return { key: `${method} /repos/${place}`, words: `${method} requests to ${place}` };
    }
    if (!unsafe && kind === "gitlab" && root === "projects" && first) {
      const id = first.toLowerCase();
      let name = id;
      try {
        name = decodeURIComponent(id);
      } catch {
        // An id that does not decode is named as written.
      }
      return { key: `${method} /projects/${id}`, words: `${method} requests to project ${name}` };
    }
    const exact = bare(path);
    return { key: `${method} ${exact}`, words: `${method} requests to ${exact}` };
  };
}

/** Who a calendar change notifies, by `send_updates`. */
const NOTIFIES: Record<string, string> = {
  none: "notifying nobody",
  all: "notifying every guest",
  externalOnly: "notifying guests outside your organization",
};

/** A calendar change: the calendar, primary when omitted, and whom it notifies. */
export function calendarScope(input: unknown): IntegrationScope {
  const { calendar = "primary", send_updates = "none" } = input as {
    calendar?: string;
    send_updates?: string;
  };
  return {
    key: JSON.stringify([calendar, send_updates]),
    words: `events in the ${calendar} calendar, ${NOTIFIES[send_updates] ?? send_updates}`,
  };
}

/** A message sent: exactly these recipients, to and cc together, in any order. */
export function recipientsScope(input: unknown): IntegrationScope {
  const { to, cc = [] } = input as { to: string[]; cc?: string[] };
  const all = [...new Set([...to, ...cc].map((address) => address.trim().toLowerCase()))].sort();
  return { key: JSON.stringify(all), words: `messages to ${all.join(", ")}` };
}
