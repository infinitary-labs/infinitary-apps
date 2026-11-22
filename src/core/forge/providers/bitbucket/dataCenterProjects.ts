import type { ForgeProject } from "@shared/forges";
import { ForgeError } from "../../forge";
import { DataCenterClient, type DataCenterOptions } from "./dataCenterClient";

/** One repository as Data Center lists it. */
export type DataCenterRepository = {
  id?: unknown;
  slug?: unknown;
  public?: unknown;
  project?: { key?: unknown; type?: unknown; owner?: { name?: unknown } | null } | null;
  links?: { clone?: { href?: unknown; name?: unknown }[]; self?: { href?: unknown }[] };
};

/** The pages one project listing reads at most. */
const MAX_REPOSITORY_PAGES = 10;

/**
 * A Data Center project key as its REST paths take it, from the owner a
 * project's address names: `scm/prj` from a clone address over HTTPS and
 * `prj` over SSH are the project `PRJ`, and `~user` is that person's own
 * project. Data Center keeps project keys upper-case and user names
 * lower-case.
 */
export function dataCenterProjectKey(owner: string): string {
  const key = owner.replace(/^scm\//i, "");
  return key.startsWith("~") ? key.toLowerCase() : key.toUpperCase();
}

/** A repository's REST path under the server. */
export function dataCenterRepositoryPath(owner: string, name: string): string {
  return `/rest/api/latest/projects/${encodeURIComponent(dataCenterProjectKey(owner))}/repos/${encodeURIComponent(name.toLowerCase())}`;
}

/**
 * The projects a Bitbucket Data Center sign-in can read, up to a page
 * budget, and an exact `KEY/slug` lookup (`docs/forge.md`, "Bitbucket
 * Data Center"). A Data Center repository is `project/slug`: nothing nests.
 */
export class DataCenterProjects {
  readonly nestedNamespace = false;
  private readonly client: DataCenterClient;
  constructor(
    private readonly host: string,
    options: DataCenterOptions,
  ) {
    this.client = new DataCenterClient(host, options);
  }

  async listProjects(): Promise<ForgeProject[]> {
    return (await this.listProjectsPaged()).projects;
  }

  /** Every repository the token may read, up to the page budget; a cut listing says it is not complete. */
  async listProjectsPaged(): Promise<{ projects: ForgeProject[]; complete: boolean }> {
    const listed = await this.client.list<DataCenterRepository>(
      "/rest/api/latest/repos?permission=REPO_READ",
      MAX_REPOSITORY_PAGES,
    );
    return {
      projects: listed.values.map((row) => this.projectView(row)),
      complete: listed.complete,
    };
  }

  async findProject(fullName: string): Promise<ForgeProject | null> {
    const parts = fullName.replace(/^scm\//i, "").split("/");
    const [key, slug, ...rest] = parts;
    if (!key || !slug || rest.length > 0) return null;
    try {
      return this.projectView(
        await this.client.get<DataCenterRepository>(dataCenterRepositoryPath(key, slug)),
      );
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return null;
      throw caught;
    }
  }

  private projectView(repository: DataCenterRepository): ForgeProject {
    const key = repository.project?.key;
    const slug = repository.slug;
    if (
      typeof key !== "string" ||
      typeof slug !== "string" ||
      !/^[^/\s]+$/.test(key) ||
      !/^[^/\s]+$/.test(slug)
    )
      throw new ForgeError("transient", "Bitbucket's project could not be read.");
    const page = repository.links?.self?.[0]?.href;
    return {
      fullName: `${key}/${slug}`,
      // The server's own clone address names the account; the app's git sign-in names its own user.
      cloneUrl:
        this.cloneUrl(repository) ?? `https://${this.host}/scm/${key.toLowerCase()}/${slug}.git`,
      url:
        typeof page === "string" && page
          ? page
          : `https://${this.host}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}/browse`,
      updatedAt: null,
      private: repository.public !== true,
    };
  }

  /** The server's HTTPS clone address, without the user name it writes in, on this host only. */
  private cloneUrl(repository: DataCenterRepository): string | null {
    const href = repository.links?.clone?.find((link) => link.name === "http")?.href;
    if (typeof href !== "string") return null;
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== this.host) return null;
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return null;
    }
  }
}
