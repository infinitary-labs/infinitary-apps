import { z } from "zod";

/**
 * Why the host could not bring a project's folder up to date after a merge
 * (INF-549; `WorkspaceService.refreshManagedCheckout`). The host only ever
 * fast-forwards a clean folder on its default branch (FI3-55); every other
 * state is one of these, and the task the host then files carries it.
 */
export const folderRefreshCauseSchema = z.enum([
  "no-origin",
  "no-default-branch",
  "dirty",
  "detached",
  "other-branch",
  "fetch-failed",
  "no-remote-branch",
  "diverged",
  "changed",
  "fast-forward-refused",
  "unreadable",
]);
export type FolderRefreshCause = z.infer<typeof folderRefreshCauseSchema>;

/** A refused refresh: the typed cause, and what the host read before it stopped. */
export type FolderRefreshRefusal = {
  refreshed: false;
  cause: FolderRefreshCause;
  /** The default branch origin declares, when it was read. */
  branch?: string;
  /** Origin's default branch as last fetched, when it was read. */
  remote?: string;
};

/** Each cause in the words a person reads, after "could not be brought up to date: ". */
export function folderRefreshWords(cause: FolderRefreshCause): string {
  switch (cause) {
    case "no-origin":
      return "it does not know where the project lives";
    case "no-default-branch":
      return "where the project lives does not name its default branch";
    case "dirty":
      return "it has edits that are not committed";
    case "detached":
      return "it is not on a branch";
    case "other-branch":
      return "it is on another branch than the default branch";
    case "fetch-failed":
      return "fetching from where the project lives failed or timed out";
    case "no-remote-branch":
      return "the default branch could not be read from where the project lives";
    case "diverged":
      return "its default branch has commits that are not where the project lives";
    case "changed":
      return "it changed while it was being brought up to date";
    case "fast-forward-refused":
      return "git refused to move its default branch forward";
    case "unreadable":
      return "git could not read it";
  }
}
