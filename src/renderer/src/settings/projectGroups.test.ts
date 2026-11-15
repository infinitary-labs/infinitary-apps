import { type RepoView, repoViewSchema } from "@shared/repos";
import { type ProjectView, projectViewSchema } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { projectFact } from "../character/crew/projectFact";
import { projectsPage } from "./phonePages";
import { projectEntries } from "./projectGroups";

/**
 * INF-4220's approved plan: Settings → Projects lists projects, a project of
 * one repository keeps today's row, and one of several is one group with a
 * row for each repository; the phone groups the same way, and a task's
 * record names the project with the repository beside it only in a project
 * of several. This file owns those readings.
 * Fixture: the repository and project shapes a home sends (`inf:repos:list`,
 * `inf:projects:list`), parsed by their published schemas, for a person
 * whose wallet app and its service share one project, beside a project of
 * one and the personal workspace.
 */
const repo = (id: string, name: string, extra: Partial<RepoView> = {}): RepoView =>
  repoViewSchema.parse({
    id,
    name,
    path: `/Users/sam/Projects/${name}`,
    setupKind: "clone",
    kind: "project",
    origin: `https://github.com/sam/${name}.git`,
    host: { kind: "github", name: null },
    delivery: "direct-pr",
    autonomy: false,
    rigor: null,
    runsOn: null,
    ...extra,
  });

const counts = { needsYou: 0, waitingOnYou: 0, open: 1, active: 0, doneRecent: 2 };
const shape = (name: string) => ({ name, delivery: "direct-pr", autonomy: false });
const project = (id: string, key: string, name: string, repos: string[]): ProjectView =>
  projectViewSchema.parse({
    id,
    key,
    name,
    repo: repos[0] ? shape(repos[0]) : null,
    repos: repos.map(shape),
    archived: false,
    counts,
  });

const site = repo("r-site", "website");
const app = repo("r-app", "eddies-wallet");
const api = repo("r-api", "eddies-wallet-backend", { rigor: "reviewed" });
const personal = repo("r-me", "personal", { kind: "personal", origin: null, host: null });
const repos = [site, app, personal, api];
const projects = [
  project("scratch", "SCR", "Scratch", []),
  project("proj-r-site", "WEB", "website", ["website"]),
  project("proj-r-app", "EDW", "Eddie's Wallet", ["eddies-wallet", "eddies-wallet-backend"]),
  project("proj-r-me", "ME", "personal", ["personal"]),
];

describe("Settings → Projects with a project of several repositories", () => {
  it("keeps a project of one as its row and gathers a project of several where its first repository sits", () => {
    expect(
      projectEntries(repos, projects).map((entry) =>
        entry.kind === "one"
          ? [entry.repo.name, entry.project?.key]
          : [entry.project.name, entry.project.key, entry.repos.map((one) => one.name)],
      ),
    ).toEqual([
      ["website", "WEB"],
      ["Eddie's Wallet", "EDW", ["eddies-wallet", "eddies-wallet-backend"]],
      ["personal", "ME"],
    ]);
  });

  it("reads each repository as its own row before the projects are read, or from an older home", () => {
    const older = projects.map(({ repos: _repos, ...view }) => view);
    expect(projectEntries(repos, []).map((entry) => entry.kind)).toEqual([
      "one",
      "one",
      "one",
      "one",
    ]);
    expect(projectEntries(repos, older).every((entry) => entry.kind === "one")).toBe(true);
  });

  it("names the project once above its rows on the phone, and counts projects, not repositories", () => {
    const page = projectsPage({ repos, projects, folder: null, devices: null, home: "Mac mini" });
    expect(page.summary).toBe("2 projects");
    expect(page.projects.map((row) => [row.name, row.group?.name ?? null])).toEqual([
      ["website", null],
      ["eddies-wallet", "Eddie's Wallet"],
      ["eddies-wallet-backend", "Eddie's Wallet"],
      ["personal", null],
    ]);
    expect(page.projects[1]?.group?.line).toBe("EDW · 2 repositories");
  });
});

describe("a task record's Project fact", () => {
  it("names the project, with the repository beside it only in a project of several", () => {
    const [, website, wallet] = projects;
    expect(projectFact(wallet, "eddies-wallet-backend")).toBe(
      "Eddie's Wallet · eddies-wallet-backend",
    );
    expect(projectFact(website, "website")).toBe("website");
    expect(projectFact(undefined, "website")).toBe("website");
  });
});
