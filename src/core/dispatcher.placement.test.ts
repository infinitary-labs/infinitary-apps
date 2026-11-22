import { rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, placesAs } from "@shared/deviceNames";
import { englishOf } from "@shared/i18n/said";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { expect, it, vi } from "vitest";
import { fakeHost } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { startCore } from "./index";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { git } from "./workspace/git";

it("records and broadcasts a project's move from automatic placement to this computer", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const userData = scratchDir("dispatcher-placement-home-");
  const projectRoot = scratchDir("dispatcher-placement-project-");
  const origin = join(projectRoot, "origin.git");
  const project = join(projectRoot, "website");
  const core = await startCore(fakeHost(userData).host);
  try {
    await git(projectRoot, ["init", "--bare", "--initial-branch=main", origin]);
    await git(projectRoot, ["clone", origin, project]);
    const { repo } = await core.services.repos.setup({ kind: "adopt", path: project });
    expect(repo.runsOn).toBe(AUTOMATIC_COMPUTER);
    const events: unknown[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload);
    });
    try {
      const changed = await core.dispatch("inf:devices:runs-on", [repo.id, null]);
      expect(changed.runsOn).toBeNull();
      expect(core.services.repos.get(repo.id)?.runsOn).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "repo_runs_on",
          repoId: repo.id,
          runsOn: null,
          actor: "captain",
        }),
      );
      // INF-3676: its feed line says this computer and here as places, which a computer that
      // controls the first mate names.
      const moved = (await core.dispatch("inf:feed:recent", [])).find((line) =>
        line.text.startsWith(`${repo.name} runs on`),
      );
      expect(moved).toMatchObject({
        text: `${repo.name} runs on ${HERE.this} now. Its next task starts here.`,
        saidHere: true,
      });
      expect(moved?.said && englishOf(placesAs(moved.said, "MacBook Pro"))).toBe(
        `${repo.name} runs on MacBook Pro now. Its next task starts on MacBook Pro.`,
      );
      expect(core.services.tasks.list()).toContainEqual(
        expect.objectContaining({
          kind: "operation",
          repoId: repo.id,
          title: `Changed settings for project ${repo.name}`,
        }),
      );
      // A card written before the move must not apply its stale project settings.
      await expect(
        core.dispatch("inf:repos:configure", [repo.id, { name: "renamed" }], {
          kind: "captain",
          projectBefore: repo,
        }),
      ).rejects.toThrow("The project changed since this card was written.");
      expect(core.services.repos.get(repo.id)?.name).toBe(repo.name);
      // Only an exact-change card can change where an existing project lives.
      await expect(
        core.dispatch("inf:repos:configure", [repo.id, { origin }], {
          kind: "firstmate",
          wake: "captain",
          action: "project-settings",
          evidence: "Change the project location",
        }),
      ).rejects.toThrow("Where a project lives changes only on the app’s exact-change card.");
    } finally {
      detach();
    }
  } finally {
    await core.dispose();
    await core.services.workspace.poolSettled();
    await core.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
