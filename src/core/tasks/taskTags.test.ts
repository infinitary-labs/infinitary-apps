import { projectTagChangeSchema } from "@shared/tags";
import { describe, expect, it } from "vitest";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { seedProject } from "../workspace/seedProject";

/**
 * Tags on tasks (docs/task-tags.md), from the approved plan's first piece:
 * projects define tags with a name and a description, tasks carry them, and
 * each tag on a task records who set it; a tag removed by hand stays removed.
 */

function withProject() {
  const f = taskProtocolFixture();
  const projectId = f.tasks.get(
    f.tasks.create({ id: "work", title: "Fix the sign-in", prompt: "", repoId: "r1" }).id,
  )?.projectId as string;
  const add = (name: string, description: string) =>
    f.tasks.changeProjectTags({ op: "add", projectId, name, description });
  return { f, projectId, add };
}

const tagLines = (f: ReturnType<typeof taskProtocolFixture>, id: string) =>
  f.tasks
    .timeline(id)
    .filter((event) => event.data && "tags" in event.data)
    .map((event) => [event.actor, event.text, event.data?.news]);

describe("a project's tags", () => {
  it("lists them alphabetically, refuses a name the project has in any case, and needs a description", () => {
    const { f, add } = withProject();
    try {
      add("idea", "Something to design before anyone builds it.");
      const result = add("Bug", "Something that used to work and is broken now.");
      expect(result.tags.map((tag) => tag.name)).toEqual(["Bug", "idea"]);
      expect(result.done).toEqual({ op: "add", name: "Bug" });
      expect(() => add("bug", "Another description")).toThrow(/already has a tag named Bug/);
      const missing = projectTagChangeSchema.safeParse({
        op: "add",
        projectId: "p",
        name: "feature",
        description: "  ",
      });
      expect(missing.success).toBe(false);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("keeps a renamed tag on its tasks, and takes a removed one off every task with one line each", () => {
    const { f, add } = withProject();
    try {
      f.tasks.create({ id: "other", title: "Write the checklist", prompt: "", repoId: "r1" });
      const bug = add("bug", "Broken now.").tags[0]?.id as string;
      f.tasks.replaceTags("work", { ids: [bug] }, "captain");
      f.tasks.replaceTags("other", { names: ["BUG"] }, "firstmate");

      const renamed = f.tasks.changeProjectTags({ op: "edit", tagId: bug, name: "defect" });
      expect(renamed.done).toEqual({ op: "edit", name: "defect", was: "bug", described: false });
      expect(renamed.tags).toMatchObject([{ name: "defect", tasks: 2, revision: 1 }]);
      expect(f.tasks.tagsOf("work")).toEqual([{ id: bug, name: "defect", by: "captain" }]);
      expect(f.fresh().tasks.find((task) => task.id === "other")?.tags).toEqual([
        { id: bug, name: "defect", by: "firstmate" },
      ]);

      const described = f.tasks.changeProjectTags({
        op: "edit",
        tagId: bug,
        description: "Worked before, broken now.",
      });
      expect(described.tags[0]?.revision).toBe(2);

      const removed = f.tasks.changeProjectTags({ op: "remove", tagId: bug });
      expect(removed.done).toEqual({ op: "remove", name: "defect", tasks: 2 });
      expect(removed.tags).toEqual([]);
      expect(f.tasks.tagsOf("work")).toEqual([]);
      expect(f.fresh().tasks.find((task) => task.id === "other")?.tags).toBeUndefined();
      expect(tagLines(f, "other").at(-1)).toEqual([
        "host",
        "The tag defect was removed from this project, so this task no longer carries it.",
        false,
      ]);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
});

describe("the tags a task carries", () => {
  it("records who set each, one quiet line per change, and never lets the decision model undo a person's choice", () => {
    const { f, add } = withProject();
    try {
      const [bug, idea] = (() => {
        add("bug", "Broken now.");
        return add("idea", "Design first.").tags.map((tag) => tag.id);
      })() as [string, string];

      expect(f.tasks.setTags("work", [{ tagId: idea, on: true }], "decision")).toEqual({
        added: ["idea"],
        removed: [],
      });
      expect(f.tasks.replaceTags("work", { ids: [bug] }, "captain")).toEqual({
        added: ["bug"],
        removed: ["idea"],
      });
      // The person took idea off and set bug: the decision model's asks change neither.
      expect(
        f.tasks.setTags(
          "work",
          [
            { tagId: idea, on: true },
            { tagId: bug, on: false },
          ],
          "decision",
        ),
      ).toEqual({ added: [], removed: [] });
      // Asking for what is already so writes nothing.
      expect(f.tasks.replaceTags("work", { ids: [bug] }, "captain")).toEqual({
        added: [],
        removed: [],
      });

      expect(f.tasks.tagsOf("work")).toEqual([{ id: bug, name: "bug", by: "captain" }]);
      expect(tagLines(f, "work")).toEqual([
        ["host", "The decision model tagged this task idea.", false],
        ["captain", "You tagged this task bug.", false],
        ["captain", "You took idea off this task.", false],
      ]);
      expect(
        f.tasks
          .timeline("work")
          .filter((event) => event.data && "tags" in event.data)
          .every((event) => event.feed === false),
      ).toBe(true);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("refuses a tag of another project, and names the project's tags for an unknown name", () => {
    const { f, add } = withProject();
    try {
      add("bug", "Broken now.");
      seedProject(f.db, { id: "r2", name: "website", path: "/fleet/website", addedAt: 2 });
      f.tasks.create({ id: "site", title: "Redo the footer", prompt: "", repoId: "r2" });
      const siteProject = f.tasks.get("site")?.projectId as string;
      const elsewhere = f.tasks.changeProjectTags({
        op: "add",
        projectId: siteProject,
        name: "copy",
        description: "Words only.",
      }).tags[0]?.id as string;
      expect(() => f.tasks.replaceTags("work", { ids: [elsewhere] }, "captain")).toThrow(
        /has no tag/,
      );
      expect(() => f.tasks.replaceTags("work", { names: ["idea"] }, "firstmate")).toThrow(
        /has no tag idea\. Its tags: bug\./,
      );
      expect(f.tasks.tagsOf("work")).toEqual([]);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("drops a task's tags when it moves to another project", () => {
    const { f, add } = withProject();
    try {
      const bug = add("bug", "Broken now.").tags[0]?.id as string;
      seedProject(f.db, {
        id: "r2",
        name: "website",
        path: "/fleet/website",
        addedAt: 2,
        key: "WEB",
      });
      f.tasks.replaceTags("work", { ids: [bug] }, "captain");
      f.tasks.updateFields("work", { project: "WEB" }, "firstmate");
      expect(f.tasks.get("work")?.repoId).toBe("r2");
      expect(f.tasks.tagsOf("work")).toEqual([]);
      expect(f.fresh().tasks.find((task) => task.id === "work")?.tags).toBeUndefined();
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
});
