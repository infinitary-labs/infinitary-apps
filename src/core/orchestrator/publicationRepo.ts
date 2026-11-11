import type { ForgeRepo } from "../forge";
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
