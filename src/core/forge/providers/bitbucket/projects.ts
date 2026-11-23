import type { ForgeProject } from "@shared/forges";
import { ForgeError } from "../../forge";
import { BitbucketClient, type BitbucketOptions } from "./client";

type Page<T> = { values?: T[]; next?: string };
type Repository = {
  full_name?: unknown;
  is_private?: unknown;
  updated_on?: unknown;
  links?: { html?: { href?: unknown } };
};
/** One budget of pages across the workspaces and their projects. */
const MAX_PAGES = 10;
const WORKSPACE_FIELDS = "next,values.workspace.slug";
const REPOSITORY_FIELDS =
  "next,values.full_name,values.is_private,values.updated_on,values.links.html.href";

/**
 * Bitbucket Cloud's projects the signed-in account is a member of, across
 * its workspaces, newest first, up to a page budget, and an exact `workspace/name` lookup
 * (`docs/forge.md`, "Bitbucket sign-in and projects"). A Bitbucket
 * repository is always `workspace/name`: nothing nests.
 */
export class BitbucketProjects {
  readonly nestedNamespace = false;
  private readonly client: BitbucketClient;
  constructor(
    private readonly host: string,
    options: BitbucketOptions,
  ) {
    this.client = new BitbucketClient(host, options);
  }
  async listProjects(): Promise<ForgeProject[]> {
    return (await this.listProjectsPaged()).projects;
  }
  /**
   * Every workspace's first page before any workspace's second, so the
   * page budget reaches as many workspaces as it can before older pages;
   * a cut listing can still leave whole workspaces, and newer projects,
   * unchecked, and says it is not complete. Each page asks for the few
   * fields the listing reads, which keeps a full page well inside the
   * answer's size limit.
   */
  async listProjectsPaged(): Promise<{ projects: ForgeProject[]; complete: boolean }> {
    let pages = 0;
    const page = async <T>(link: string): Promise<{ rows: T[]; next?: string }> => {
      pages++;
      const read: Page<T> | null = await this.client.get<Page<T>>(link);
      if (!read || !Array.isArray(read.values))
        throw new ForgeError("transient", "Bitbucket's project list could not be read.");
      return {
        rows: read.values,
        ...(typeof read.next === "string" && read.next ? { next: read.next } : {}),
      };
    };
    const slugs: string[] = [];
    let workspaces: string | undefined = `/user/workspaces?pagelen=100&fields=${WORKSPACE_FIELDS}`;
    while (workspaces && pages < MAX_PAGES) {
      const read: { rows: { workspace?: { slug?: unknown } }[]; next?: string } =
        await page(workspaces);
      for (const entry of read.rows) {
        const slug = entry.workspace?.slug;
        if (typeof slug === "string" && slug.length > 0) slugs.push(slug);
      }
      workspaces = read.next;
    }
    let waiting = slugs.map(
      (slug) =>
        `/repositories/${encodeURIComponent(slug)}?role=member&sort=-updated_on&pagelen=100&fields=${REPOSITORY_FIELDS}`,
    );
    const projects: ForgeProject[] = [];
    while (waiting.length > 0 && pages < MAX_PAGES) {
      const later: string[] = [];
      for (const link of waiting) {
        if (pages >= MAX_PAGES) {
          later.push(link);
          continue;
        }
        const read = await page<Repository>(link);
        projects.push(...read.rows.map((row) => this.projectView(row)));
        if (read.next) later.push(read.next);
      }
      waiting = later;
    }
    projects.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { projects, complete: !workspaces && waiting.length === 0 };
  }
  async findProject(fullName: string): Promise<ForgeProject | null> {
    const [workspace, name, ...rest] = fullName.split("/");
    if (!workspace || !name || rest.length > 0) return null;
    try {
      return this.projectView(
        await this.client.get<Repository>(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}`,
        ),
      );
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return null;
      throw caught;
    }
  }

  private projectView(repository: Repository): ForgeProject {
    const fullName = repository.full_name;
    if (typeof fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
      throw new ForgeError("transient", "Bitbucket's project could not be read.");
    }
    const page = repository.links?.html?.href;
    return {
      fullName,
      // Bitbucket's own clone link names the account; the app's git sign-in names its own user.
      cloneUrl: `https://${this.host}/${fullName}.git`,
      url: typeof page === "string" && page ? page : `https://${this.host}/${fullName}`,
      updatedAt: typeof repository.updated_on === "string" ? repository.updated_on : null,
      private: repository.is_private !== false,
    };
  }
}
