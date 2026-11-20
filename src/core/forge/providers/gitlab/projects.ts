import type { ForgeProject } from "@shared/forges";
import { ForgeError } from "../../forge";
import { GitLabClient, type GitLabOptions } from "./client";

type Project = {
  path_with_namespace: string;
  http_url_to_repo: string;
  web_url: string;
  last_activity_at: string | null;
  visibility: string;
};
const MAX_PAGES = 10;

/** Account listing and exact lookup, independent of merge-request delivery. */
export class GitLabProjects {
  readonly nestedNamespace = true;
  private readonly client: GitLabClient;
  constructor(host: string, options: GitLabOptions) {
    this.client = new GitLabClient(host, options);
  }
  async listProjects(): Promise<ForgeProject[]> {
    return (await this.listProjectsPaged()).projects;
  }
  async listProjectsPaged(): Promise<{ projects: ForgeProject[]; complete: boolean }> {
    const projects: ForgeProject[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.client.get<Project[]>(
        `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`,
      );
      if (!Array.isArray(rows))
        throw new ForgeError("transient", "GitLab's project list could not be read.");
      projects.push(...rows.map(projectView));
      if (rows.length < 100) return { projects, complete: true };
    }
    return { projects, complete: false };
  }
  async findProject(fullName: string): Promise<ForgeProject | null> {
    try {
      return projectView(
        await this.client.get<Project>(`/projects/${encodeURIComponent(fullName)}`),
      );
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return null;
      throw caught;
    }
  }
}

function projectView(project: Project): ForgeProject {
  if (
    typeof project.path_with_namespace !== "string" ||
    typeof project.http_url_to_repo !== "string" ||
    typeof project.web_url !== "string" ||
    typeof project.visibility !== "string"
  ) {
    throw new ForgeError("transient", "GitLab's project could not be read.");
  }
  return {
    fullName: project.path_with_namespace,
    cloneUrl: project.http_url_to_repo,
    url: project.web_url,
    updatedAt: project.last_activity_at ?? null,
    private: project.visibility !== "public",
  };
}
