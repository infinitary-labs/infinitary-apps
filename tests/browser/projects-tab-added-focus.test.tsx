import * as m from "@shared/i18n/messages.generated";
import type { RepoSetupResult, RepoView } from "@shared/repos";
import type { ProjectView } from "@shared/tasks";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { afterNextFrame, button, held, shown } from "./devicesTab";
import { seededHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Focus stays on a repository just added to a project of one in Settings ->
 * Projects (INF-4378; tests/e2e/add-project.spec.ts's add-a-second-repository
 * journey): the project's page chooses the new repository's tab and focuses
 * it. The add asks the app for four lists: the repositories, the projects
 * and the page's Tags box's projects again when the app says a repository
 * was set up, and the projects once the add answers. When the repository
 * list draws on its own first, the new repository shows for a moment as its
 * own project outside the open one, and the page must still focus the new
 * tab once the projects answer. On Linux the order the lists answer in lost
 * focus to the page in some of the journey's runs; this test answers the
 * repository list first.
 */

const PROJECT = { name: "wallet", key: "WAL" } as const;
const ADDED = "wallet-api";

test("a repository added to a project of one keeps focus when the repository list draws before the projects answer", async () => {
  // The app's own reading of the project once the new repository joined it.
  const home = await seededHome({ project: PROJECT, added: ADDED });
  const after = {
    repos: home["inf:repos:list"] as RepoView[],
    projects: home["inf:projects:list"] as ProjectView[],
  };
  const added = after.repos.find((repo) => repo.name === ADDED);
  if (!added) throw new Error(`The seeded home lists no ${ADDED}`);
  // The same reading before it joined: the project held its first repository alone.
  const before = {
    repos: after.repos.filter((repo) => repo.id !== added.id),
    projects: after.projects.map((project) =>
      project.key === PROJECT.key
        ? { ...project, repos: project.repos?.filter((repo) => repo.name !== ADDED) }
        : project,
    ),
  };

  const bridge = fakeBridge(home);
  // Until the add is sent, each list answers at once; after it, each waits for the test.
  let holding = false;
  const repoLists: ReturnType<typeof held<RepoView[]>>[] = [];
  const projectLists: ReturnType<typeof held<ProjectView[]>>[] = [];
  bridge.answer("inf:repos:list", () => {
    if (!holding) return before.repos;
    const list = held<RepoView[]>();
    repoLists.push(list);
    return list.promise;
  });
  bridge.answer("inf:projects:list", () => {
    if (!holding) return before.projects;
    const list = held<ProjectView[]>();
    projectLists.push(list);
    return list.promise;
  });
  const setup = held<RepoSetupResult>();
  bridge.answer("inf:repos:setup", () => setup.promise);

  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Projects", exact: true }));
  const first = before.repos.find((repo) => repo.name === PROJECT.name);
  if (!first) throw new Error(`The seeded home lists no ${PROJECT.name}`);
  (await shown(`[data-project-line="${first.id}"]`)).focus();
  await userEvent.keyboard("{Enter}");
  (await shown("[data-add-repository-tab]")).focus();
  await userEvent.keyboard("{Enter}");
  const into = await shown(`[data-add-repository="${PROJECT.key}"]`);
  button(into, m.settingsAddRepositoryNew()).focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(
    page.elementLocator(into).getByLabelText(m.settingsAddProjectName(), { exact: true }),
    ADDED,
  );
  holding = true;
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => bridge.requests("inf:repos:setup").length).toBe(1);

  bridge.push("inf:event", {
    type: "repo_setup",
    actor: "captain",
    repoId: added.id,
    name: added.name,
    path: added.path,
    kind: added.setupKind,
    project: PROJECT.name,
  });
  // The app says the repository was set up: the tab asks both lists again,
  // and the page's Tags box asks the projects again too.
  await expect.poll(() => [repoLists.length, projectLists.length]).toEqual([1, 2]);
  // The add answers: the tab asks the projects once more.
  setup.resolve({ repo: added, created: true });
  await expect.poll(() => projectLists.length).toBe(3);

  // The repository list draws alone, the new repository outside the open
  // project; every project list answers only after that drawing.
  repoLists[0]?.resolve(after.repos);
  await afterNextFrame();
  for (const list of projectLists) list.resolve(after.projects);

  const tab = await shown(
    `[data-project-repositories="${PROJECT.key}"] [data-repository-tab="${added.id}"]`,
  );
  await afterNextFrame();
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab);
});
