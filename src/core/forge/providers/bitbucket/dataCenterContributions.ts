import type { ContributionProject } from "@shared/contributions";
import type { ContributionFacts, ForgeContributions } from "../../contributions";
import { ForgeError } from "../../forge";
import type { DataCenterClient } from "./dataCenterClient";
import type { DataCenterRepository } from "./dataCenterProjects";
import { dataCenterRepositoryPath } from "./dataCenterProjects";

/** A repository as Data Center answers it, with the repository it was forked from. */
type Repository = DataCenterRepository & { origin?: DataCenterRepository | null };

/** How many pages of repositories or forks one look reads before it stops. */
const MAX_PAGES = 10;

/**
 * A Data Center repository's own `owner/name` as its HTTPS clone address
 * spells it, `scm/{key}/{slug}`, the form the app reads a project's address
 * in, so a fork's address and name agree (`contributionOriginMatches`).
 */
export function dataCenterFullName(key: string, slug: string): string {
  return `scm/${key.toLowerCase()}/${slug.toLowerCase()}`;
}

/** The REST path of a repository named `scm/{key}/{slug}` or `{key}/{slug}`. */
export function dataCenterPathOf(fullName: string): string {
  const cut = fullName.lastIndexOf("/");
  return dataCenterRepositoryPath(fullName.slice(0, cut), fullName.slice(cut + 1));
}

/**
 * Contributing through a fork on Bitbucket Data Center (docs/forge.md,
 * "Contributing through an owned fork"). Whether the sign-in may push is
 * whether the server lists the repository among those the person may write
 * to; a fork is a repository forked from this one in the person's own
 * project (`~<user slug>`), where a new fork goes too. A project read over SSH
 * names no `scm/` owner, and a fork's address is its HTTPS clone address,
 * so only a project read over HTTPS is offered a fork.
 */
export class DataCenterContributions implements ForgeContributions {
  constructor(
    private readonly host: string,
    private readonly owner: string,
    private readonly slug: string,
    private readonly client: DataCenterClient,
  ) {}

  private path(): string {
    return dataCenterRepositoryPath(this.owner, this.slug);
  }

  private identity(repository: DataCenterRepository | null | undefined): ContributionProject {
    const id = repository?.id;
    const key = repository?.project?.key;
    const slug = repository?.slug;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof key !== "string" ||
      typeof slug !== "string" ||
      !/^[^/\s]+$/.test(key) ||
      !/^[^/\s]+$/.test(slug)
    )
      throw new ForgeError("transient", "Bitbucket's answer about a repository could not be read.");
    const fullName = dataCenterFullName(key, slug);
    return { id, fullName, origin: `https://${this.host}/${fullName}.git` };
  }

  async inspect(): Promise<ContributionFacts> {
    const repository = await this.client.get<Repository | null>(this.path());
    const project = this.identity(repository);
    const parent = repository?.origin ? this.identity(repository.origin) : undefined;
    const write = await this.listed(project, "REPO_WRITE");
    // Only a fork's admin is asked: an owned fork is the one case that reads it.
    const admin = parent && write === true ? await this.listed(project, "REPO_ADMIN") : false;
    return {
      project,
      canPush: write,
      owned: admin === true,
      ...(parent ? { parent } : {}),
    };
  }

  /**
   * Whether the server lists the repository among those the person holds
   * `permission` on; null when the list is longer than one look reads.
   */
  private async listed(
    project: ContributionProject,
    permission: "REPO_WRITE" | "REPO_ADMIN",
  ): Promise<boolean | null> {
    const listed = await this.client.list<DataCenterRepository>(
      `/rest/api/latest/repos?permission=${permission}`,
      MAX_PAGES,
    );
    if (listed.values.some((repository) => repository.id === project.id)) return true;
    return listed.complete ? false : null;
  }

  async findFork(): Promise<ContributionProject | null> {
    const user = await this.signedInName();
    const forks = await this.client.list<DataCenterRepository>(`${this.path()}/forks`, MAX_PAGES);
    // A personal project's key is `~` and the owner's slug, which differs from
    // the name for a name such as `jane@example.com`: match the owner first.
    const found = forks.values.find(({ project }) =>
      project?.type === "PERSONAL" && typeof project.owner?.name === "string"
        ? project.owner.name.toLowerCase() === user
        : typeof project?.key === "string" && project.key.toLowerCase() === `~${user}`,
    );
    if (found) return this.identity(found);
    if (!forks.complete)
      throw new ForgeError(
        "transient",
        "Bitbucket lists more forks of this repository than one look reads; no fork was made.",
      );
    return null;
  }

  async createFork(): Promise<ContributionProject> {
    // With no project named, the server makes the fork in the person's own project.
    const made = await this.client.write(
      "POST",
      this.path(),
      {},
      // i18n-exempt: names the request in an error served to the crewmate
      "making your fork",
    );
    return this.identity(made.body as DataCenterRepository | null);
  }

  /** The signed-in person's user name, in lower case. */
  private async signedInName(): Promise<string> {
    const user =
      (await this.client.request("GET", "/rest/api/latest/application-properties")).user ??
      (await this.client.signedInUser());
    if (!user)
      throw new ForgeError("transient", "Bitbucket did not name the signed-in user.", true);
    return user.toLowerCase();
  }
}
