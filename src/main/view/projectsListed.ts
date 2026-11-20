import { contractChange, listsChange } from "@core/connection/contractChanges";
import type { ForgeProject, ForgeProjectListing } from "@shared/forges";

/** A home that answers `inf:forges:projects-listed` (`bitbucket-sign-in.md`). */
const PROJECTS_LISTED = contractChange("bitbucket-sign-in");

/**
 * The listing request as a home can answer it: one that lists the change
 * answers `inf:forges:projects-listed` itself, and every refusal it gives
 * stays the person's to read. An older home has only `inf:forges:projects`,
 * which cannot say whether it read every project, so its answer reads as a
 * whole listing, as Add project always read it there.
 */
export async function projectsListedFrom(
  homeChanges: readonly string[] | null,
  host: unknown,
  ask: {
    listed: (args: unknown[]) => Promise<ForgeProjectListing>;
    projects: (args: unknown[]) => Promise<ForgeProject[]>;
  },
): Promise<ForgeProjectListing> {
  if (listsChange(homeChanges, PROJECTS_LISTED)) return ask.listed([host]);
  return { projects: await ask.projects([host]), complete: true };
}
