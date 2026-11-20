import type { ContributionProject } from "@shared/contributions";
import type { ForgeContributions } from "../../contributions";
import { ForgeError } from "../../forge";
import type { GitLabClient } from "./client";

type Project = {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  namespace: { id: number; kind?: string; path: string };
  owner?: { id: number };
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
  forked_from_project?: Project;
};
const identity = (project: Project): ContributionProject => ({
  id: project.id,
  fullName: project.path_with_namespace,
  origin: project.http_url_to_repo,
});

/** GitLab exposes the parent and effective membership on its project reading. */
export class GitLabContributions implements ForgeContributions {
  constructor(
    private readonly path: string,
    private readonly client: GitLabClient,
  ) {}
  private read(path: string): Promise<unknown> {
    return this.client.request("GET", path);
  }
  async inspect() {
    const project = (await this.read(this.path)) as Project;
    const user = (await this.read("/user")) as { id: number; username: string };
    const owned =
      (typeof user.id === "number" && project.owner?.id === user.id) ||
      (project.namespace.kind === "user" && project.namespace.path === user.username);
    const levels = [
      project.permissions?.project_access?.access_level,
      project.permissions?.group_access?.access_level,
    ].filter((level): level is number => typeof level === "number");
    let canPush = owned || levels.some((level) => level >= 30);
    if (!canPush) {
      if (!Number.isSafeInteger(user.id) || user.id <= 0)
        throw new ForgeError("refused", "GitLab did not confirm the signed-in person's identity.");
      try {
        const member = (await this.read(`/projects/${project.id}/members/all/${user.id}`)) as {
          access_level?: number;
        };
        if (typeof member.access_level !== "number")
          throw new ForgeError("refused", "GitLab did not confirm effective project membership.");
        canPush = member.access_level >= 30;
      } catch (error) {
        if (!(error instanceof ForgeError) || error.failure !== "not-found") throw error;
        canPush = false;
      }
    }
    return {
      project: identity(project),
      canPush,
      owned,
      ...(project.forked_from_project ? { parent: identity(project.forked_from_project) } : {}),
    };
  }
  async findFork(): Promise<ContributionProject | null> {
    const user = (await this.read("/user")) as { id: number; username: string };
    for (let page = 1; ; page++) {
      const projects = (await this.read(
        `${this.path}/forks?owned=true&per_page=100&page=${page}`,
      )) as Project[];
      const found = projects.find(
        (fork) =>
          (typeof user.id === "number" && fork.owner?.id === user.id) ||
          (fork.namespace.kind === "user" && fork.namespace.path === user.username),
      );
      if (found) return identity(found);
      if (projects.length < 100) return null;
    }
  }
  async createFork(): Promise<ContributionProject> {
    return identity(
      (await this.client.write("POST", `${this.path}/fork`, {}, "making your fork")) as Project,
    );
  }
}
