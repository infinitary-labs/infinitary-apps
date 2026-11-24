import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StagedChangePresentation } from "@shared/changePresentation";
import { describe, expect, it, vi } from "vitest";
import { FakeForge, insertTask, setup } from "../../../tests/helpers/prCiHarness";
import { storyFixture } from "../../../tests/helpers/savedStory";

// Integration cohort (docs/test-cohorts.md): real git, each case well under
// vitest's 5 s default, so the file sets no budget.

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// INF-6536's finding 2: a first story saved with a mistyped Before base held
// its change's merge card, since every later revision had to repeat it.
describe("a story's Before base is a commit its version starts from", () => {
  async function project() {
    const forge = Object.assign(new FakeForge(), {
      storyDestination: async () => storyFixture().destination,
    });
    const at = setup({ forge });
    const { repo } = await at.repos.setup({ kind: "init", name: "story-base" });
    insertTask(at.tasks, { repoId: repo.id, repoDir: repo.path, worktreeDir: repo.path });
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo.path, ...args])
        .toString()
        .trim();
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    const base = run("rev-parse", "HEAD");
    run("checkout", "-b", "fm/task-ab12cd34");
    writeFileSync(join(repo.path, "tracked.txt"), "The change\n");
    run("add", "tracked.txt");
    run("commit", "-m", "fix: make the change");
    const head = run("rev-parse", "HEAD");
    at.readHead.mockResolvedValue(head);
    // A full id written by hand from the short one: its first nine characters are right.
    const mistyped = `${base.slice(0, 9)}d4047fd3ac4bba3b5a73cc21b3e2e85`;
    const story = (from: string): StagedChangePresentation => {
      const { taskId, revision, destination, ...rest } = storyFixture();
      return { ...rest, title: "fix: make the change", base: from, head };
    };
    const prepare = (from: string) => at.service.publication.prepareStory("ab12cd34", story(from));
    const kept = () => at.tasks.delivery.changePresentation("ab12cd34", "fm/task-ab12cd34");
    return { at, run, base, head, mistyped, prepare, kept };
  }

  it("refuses a first story whose Before base is no commit, or one its version does not descend from", async () => {
    const { run, base, head, mistyped, prepare, kept } = await project();
    expect(mistyped).toHaveLength(40);
    expect(await prepare(mistyped)).toMatchObject({
      said: expect.stringContaining(`The Before base ${mistyped} is not a commit in this project.`),
    });
    run("checkout", "--orphan", "elsewhere");
    run("commit", "-m", "chore: an unrelated start");
    const unrelated = run("rev-parse", "HEAD");
    run("checkout", "fm/task-ab12cd34");
    expect(await prepare(unrelated)).toMatchObject({
      said: expect.stringContaining(
        `The committed version ${head} does not descend from the Before base ${unrelated}.`,
      ),
    });
    expect(kept()).toBeUndefined();
    expect(await prepare(base)).toMatchObject({ revision: 1 });
    expect(kept()?.revisions.at(-1)?.base).toBe(base);
  });

  it("accepts a corrected Before base when the saved one is no commit, and otherwise keeps the first", async () => {
    const { at, base, mistyped, prepare, kept } = await project();
    expect(await prepare(base)).toMatchObject({ revision: 1 });
    // The same story as a build without the lookup saved it, with the mistyped base.
    at.tasks.delivery.updateChangePresentation(
      "ab12cd34",
      (saved) => ({
        ...saved,
        revisions: (saved?.revisions ?? []).map((revision) => ({ ...revision, base: mistyped })),
        receipts: saved?.receipts ?? [],
      }),
      "fm/task-ab12cd34",
    );
    expect(await prepare(base)).toMatchObject({ revision: 2 });
    expect(kept()?.revisions.at(-1)).toMatchObject({ revision: 2, base });
    // Now the saved base is a real commit: a later revision keeps it.
    expect(await prepare(mistyped)).toMatchObject({
      said: expect.stringContaining(`Keep the original Before base ${base}`),
    });
    expect(kept()?.revisions.at(-1)).toMatchObject({ revision: 2, base });
  });
});
