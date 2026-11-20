import { hasChangeRequests } from "@shared/forge";
import { type ForgeRepo, requestAtRepo, requestLinkAtRepo } from "../forge";

export { requestAtRepo, requestLinkAtRepo } from "../forge";

import type { TaskRecord } from "../storage/taskRecords";

/** A prepared task keeps its own publication identity; other managed targets keep theirs. */
export function publicationRepo<T extends ForgeRepo>(record: TaskRecord, repo: T): T {
  return "id" in repo && repo.id === record.repoId && record.delivery?.publicationOrigin
    ? {
        ...repo,
        origin: record.delivery.publicationOrigin,
        contribution: record.delivery.contribution,
      }
    : repo;
}

/** Verify saved evidence before using the number, independently of whichever request is selected. */
export function savedRequestAtRepo(
  record: TaskRecord,
  repo: ForgeRepo,
  number: number,
  branch: string,
  link?: string | null,
): boolean {
  if (link) return requestLinkAtRepo(repo, link);
  return (
    !hasChangeRequests(repo.host?.kind) ||
    Boolean(
      record.delivery?.mergeReviews?.some(
        (review) =>
          review.number === number &&
          review.branch === branch &&
          (review.repoId ?? record.repoId) === ("id" in repo ? repo.id : record.repoId) &&
          requestAtRepo(repo, review),
      ),
    )
  );
}
