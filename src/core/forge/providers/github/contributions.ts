import type { ContributionProject } from "@shared/contributions";
import type { ForgeContributions } from "../../contributions";
import { ForgeError } from "../../forge";

type Repository = {
  id: number;
  full_name: string;
  clone_url: string;
  owner?: { id: number };
  permissions?: { push?: boolean };
  fork?: boolean;
  parent?: Repository;
  source?: { id: number };
};
const identity = (repo: Repository): ContributionProject => ({
  id: repo.id,
  fullName: repo.full_name,
  origin: repo.clone_url,
});

/** GitHub's own fork and permission facts, never inferred from a failed push. */
export class GitHubContributions implements ForgeContributions {
  constructor(
    private readonly projectPath: string,
    private readonly request: (method: string, path: string, body?: unknown) => Promise<unknown>,
  ) {}
  async inspect() {
    const project = (await this.request("GET", this.projectPath)) as Repository;
    const user = (await this.request("GET", "/user")) as { id: number };
    if (typeof project.permissions?.push !== "boolean")
      throw new ForgeError("refused", "GitHub did not confirm whether this sign-in can push.");
    return {
      project: identity(project),
      canPush: project.permissions.push,
      owned: typeof user.id === "number" && project.owner?.id === user.id,
      ...(project.fork && project.parent ? { parent: identity(project.parent) } : {}),
    };
  }
  async findFork(): Promise<ContributionProject | null> {
    const user = (await this.request("GET", "/user")) as { id: number; login?: string };
    if (!Number.isSafeInteger(user.id) || user.id <= 0)
      throw new ForgeError("refused", "GitHub did not confirm the signed-in person's identity.");
    const project = (await this.request("GET", this.projectPath)) as Repository;
    const ownedFork = (repo: Repository) =>
      repo.fork &&
      repo.owner?.id === user.id &&
      (repo.parent?.id === project.id || repo.source?.id === (project.source?.id ?? project.id));
    if (user.login) {
      try {
        const candidate = (await this.request(
          "GET",
          `/repos/${user.login}/${project.full_name.split("/").at(-1)}`,
        )) as Repository;
        if (ownedFork(candidate)) return identity(candidate);
      } catch (error) {
        if (!(error instanceof ForgeError) || error.failure !== "not-found") throw error;
      }
    }
    // Renamed forks retain the complete owner-list fallback.
    for (let page = 1; ; page++) {
      const forks = (await this.request(
        "GET",
        `/user/repos?affiliation=owner&per_page=100&page=${page}`,
      )) as Repository[];
      for (const fork of forks) {
        if (!fork.fork || fork.owner?.id !== user.id) continue;
        const verified = (await this.request("GET", `/repos/${fork.full_name}`)) as Repository;
        if (ownedFork(verified)) return identity(verified);
      }
      if (forks.length < 100) return null;
    }
  }
  async createFork(): Promise<ContributionProject> {
    return identity((await this.request("POST", `${this.projectPath}/forks`, {})) as Repository);
  }
}
