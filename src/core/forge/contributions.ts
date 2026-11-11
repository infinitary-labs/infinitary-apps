import type { ContributionProject } from "@shared/contributions";

export const CONTRIBUTION_DELIVERY_WORDS =
  "This contribution waits for the original project's maintainers, not your merge approval. This replaces the project's ordinary merge instructions for this task. Push task branches to the configured fork and open the change upstream. Read its checks, then show the published presentation as a note with no actions. Never merge it or mark their queue. Read maintainer comments through the host's reads and push requested fixes to the same fork branch. Name checks requiring upstream write access as not run in the story. Pictures remain on the card; the upstream story is text.";

/** Facts the host returned about the signed-in person's relationship to a project. */
export type ContributionFacts = {
  project: ContributionProject;
  /** Null means the host did not list an effective role; its write answer remains authoritative. */
  canPush: boolean | null;
  owned: boolean;
  parent?: ContributionProject;
};

/** Fork operations live behind the same forge and sign-in as every other project operation. */
export interface ForgeContributions {
  inspect(): Promise<ContributionFacts>;
  findFork(): Promise<ContributionProject | null>;
  /** Only the host's consent-card callback may call this. */
  createFork(): Promise<ContributionProject>;
}
