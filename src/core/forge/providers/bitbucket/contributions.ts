import type { ContributionProject } from "@shared/contributions";
import type { ContributionFacts, ForgeContributions } from "../../contributions";
import { ForgeError } from "../../forge";
import type { BitbucketClient } from "./client";

type Repository = {
  uuid?: string;
  full_name?: string;
  owner?: { uuid?: string } | null;
  parent?: Repository | null;
};

type Paged<T> = { values?: T[]; next?: string };

/** Bitbucket's largest page of a list read. */
const PAGE_LENGTH = 100;

/** How many pages of forks or workspaces one look reads before it stops. */
const MAX_PAGES = 10;

/** The repository fields every read here needs. */
const REPOSITORY_FIELDS = "uuid,full_name,owner.uuid,parent.uuid,parent.full_name";

/**
 * A repository's number: Bitbucket names a repository by a UUID, never a
 * number, so the number is the UUID's first 52 bits, the same for the same
 * repository each time (as the story's place reads it).
 */
export function bitbucketRepositoryNumber(uuid: unknown): number | undefined {
  const digits = typeof uuid === "string" ? uuid.replace(/[^0-9a-f]/gi, "").slice(0, 13) : "";
  const id = digits.length === 13 ? Number.parseInt(digits, 16) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Contributing through a fork on Bitbucket Cloud (docs/forge.md,
 * "Contributing through an owned fork"). Whether the sign-in may push is
 * the person's effective permission on the repository; a fork is a
 * repository whose parent is this one, in a workspace the person
 * administers; a new fork goes to the person's own workspace.
 */
export class BitbucketContributions implements ForgeContributions {
  constructor(
    private readonly host: string,
    private readonly workspace: string,
    private readonly slug: string,
    private readonly client: BitbucketClient,
  ) {}

  private path(): string {
    return `/repositories/${encodeURIComponent(this.workspace)}/${encodeURIComponent(this.slug)}`;
  }

  private identity(repository: Repository | null | undefined): ContributionProject {
    const id = bitbucketRepositoryNumber(repository?.uuid);
    const fullName = repository?.full_name;
    if (!id || typeof fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fullName))
      throw new ForgeError("transient", "Bitbucket's answer about a repository could not be read.");
    return { id, fullName, origin: `https://${this.host}/${fullName}.git` };
  }

  async inspect(): Promise<ContributionFacts> {
    const repository = await this.client.get<Repository | null>(
      `${this.path()}?fields=${REPOSITORY_FIELDS}`,
    );
    const project = this.identity(repository);
    const permission = await this.permission(project.fullName);
    return {
      project,
      canPush: permission === "admin" || permission === "write",
      owned: permission === "admin",
      ...(repository?.parent ? { parent: this.identity(repository.parent) } : {}),
    };
  }

  /**
   * The person's effective permission on the repository, `admin`, `write`
   * or `read`; null when Bitbucket lists none, as for a public repository
   * the person was given no access to.
   */
  private async permission(fullName: string): Promise<string | null> {
    const query = `repository.full_name="${fullName.replaceAll('"', '\\"')}"`;
    let listed: Paged<{ permission?: unknown; repository?: { full_name?: unknown } }> | null;
    try {
      listed = await this.client.get(
        `/user/workspaces/${encodeURIComponent(this.workspace)}/permissions/repositories?q=${encodeURIComponent(query)}`,
      );
    } catch (caught) {
      // Outside the workspace, Bitbucket answers no list at all: no permission.
      if (
        caught instanceof ForgeError &&
        (caught.failure === "not-found" || caught.failure === "permission")
      )
        return null;
      throw caught;
    }
    if (!Array.isArray(listed?.values))
      throw new ForgeError("transient", "Bitbucket did not answer the repository's permission.");
    const own = listed.values.find(
      (entry) =>
        typeof entry.repository?.full_name === "string" &&
        entry.repository.full_name.toLowerCase() === fullName.toLowerCase(),
    );
    return typeof own?.permission === "string" ? own.permission : null;
  }

  async findFork(): Promise<ContributionProject | null> {
    const upstream = this.identity(
      await this.client.get<Repository | null>(`${this.path()}?fields=uuid,full_name`),
    );
    let link: string | undefined =
      `${this.path()}/forks?role=admin&pagelen=${PAGE_LENGTH}&fields=next,values.${REPOSITORY_FIELDS.replaceAll(",", ",values.")}`;
    for (let page = 0; link && page < MAX_PAGES; page++) {
      const read: Paged<Repository> | null = await this.client.get(link);
      if (!Array.isArray(read?.values))
        throw new ForgeError("transient", "Bitbucket did not answer the repository's forks.");
      const found = read.values.find(
        (fork) => bitbucketRepositoryNumber(fork.parent?.uuid) === upstream.id,
      );
      if (found) return this.identity(found);
      link = typeof read.next === "string" && read.next ? read.next : undefined;
    }
    if (link)
      throw new ForgeError(
        "transient",
        "Bitbucket lists more forks of this repository than one look reads; no fork was made.",
      );
    return null;
  }

  async createFork(): Promise<ContributionProject> {
    const workspace = await this.ownWorkspace();
    const made = await this.client.write(
      "POST",
      `${this.path()}/forks`,
      { workspace: { slug: workspace } },
      // i18n-exempt: names the request in an error served to the crewmate
      "making your fork",
    );
    return this.identity(made.body as Repository | null);
  }

  /**
   * Where a new fork goes: the person's own workspace, which shares their
   * account's UUID, or the only workspace they administer. Anything else
   * is the person's choice, so nothing is sent.
   */
  private async ownWorkspace(): Promise<string> {
    const user = await this.client.get<{ uuid?: unknown } | null>("/user?fields=uuid");
    const administered: { slug: string; uuid?: string }[] = [];
    let link: string | undefined =
      `/user/workspaces?administrator=true&pagelen=${PAGE_LENGTH}&fields=next,values.workspace.slug,values.workspace.uuid`;
    for (let page = 0; link && page < MAX_PAGES; page++) {
      const read: Paged<{ workspace?: { slug?: unknown; uuid?: unknown } }> | null =
        await this.client.get(link);
      if (!Array.isArray(read?.values))
        throw new ForgeError("transient", "Bitbucket did not answer your workspaces.", true);
      for (const entry of read.values)
        if (typeof entry.workspace?.slug === "string" && entry.workspace.slug)
          administered.push({
            slug: entry.workspace.slug,
            ...(typeof entry.workspace.uuid === "string" ? { uuid: entry.workspace.uuid } : {}),
          });
      link = typeof read.next === "string" && read.next ? read.next : undefined;
    }
    const personal =
      typeof user?.uuid === "string"
        ? administered.find((workspace) => workspace.uuid === user.uuid)
        : undefined;
    // A list past the pages read may hold more: never take the first page's one as the only one.
    const only = administered.length === 1 && !link ? administered[0] : undefined;
    const chosen = personal ?? only;
    if (chosen) return chosen.slug;
    throw new ForgeError(
      "refused",
      administered.length === 0 && !link
        ? "You administer no Bitbucket workspace to make your fork in, so nothing was sent. Make a workspace on Bitbucket, then choose Make my fork again."
        : "You administer several Bitbucket workspaces, so nothing was sent. Make your fork on Bitbucket in the workspace you want, then choose Make my fork again to use it.",
      true,
    );
  }
}
