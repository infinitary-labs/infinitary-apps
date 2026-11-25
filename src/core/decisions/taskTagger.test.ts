import type { DecisionAnswer, DecisionQuestion } from "@shared/decisions";
import { englishOf, type Said } from "@shared/i18n/said";
import { describe, expect, it } from "vitest";
import { DAY, taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import type { SavedTagCheck } from "../storage/settingsStore";
import { TagWork } from "../storage/tagWork";
import { seedProject } from "../workspace/seedProject";
import { TAG_RETRY_MS, TaskTagger } from "./taskTagger";

/**
 * Automatic tagging and Check existing tasks, from the approved task tags
 * plan's third piece: the decision model judges every new task in a project
 * with tags once, in one request, and a check backfills older tasks. The
 * record is real; only the decision model is scripted.
 */

type Asked = { taskId: string; tags: string[]; facts: Record<string, unknown> };
type Reply = "yes" | "no" | "unsure" | "fail" | "hang";

function tagged(script: (taskTitle: string, tag: string) => Reply = () => "no") {
  const f = taskProtocolFixture();
  f.tasks.create({ id: "old", title: "Filed before any tag", prompt: "", repoId: "r1" });
  const projectId = f.tasks.get("old")?.projectId as string;
  f.tick(1000);
  const add = (name: string, description: string) =>
    f.tasks
      .changeProjectTags({ op: "add", projectId, name, description })
      .tags.find((tag) => tag.name === name)?.id as string;
  const bug = add("bug", "Something that used to work and is broken now.");
  const docs = add("docs", "Work on the written guides.");
  f.tick(1000);

  const asked: Asked[] = [];
  const lines: Said[] = [];
  const saved: { check: SavedTagCheck | null; since: number | null } = { check: null, since: null };
  let on = true;
  let hanging: (() => void) | undefined;
  const models = {
    allowsUse: () => on,
    answererName: () => "Jev 2",
    decide: async (
      caller: { taskId?: string },
      state: { facts: Record<string, unknown> },
      questions: Record<string, DecisionQuestion>,
      signal: AbortSignal,
    ): Promise<Record<string, DecisionAnswer>> => {
      const names = Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [key, /tag "(.+?)"/.exec(q.instructions)?.[1]]),
      ) as Record<string, string>;
      asked.push({
        taskId: caller.taskId as string,
        tags: Object.values(names),
        facts: state.facts,
      });
      const title = String(state.facts.title);
      const replies = Object.fromEntries(
        Object.entries(names).map(([key, name]) => [key, script(title, name)]),
      );
      if (Object.values(replies).includes("hang"))
        await new Promise<void>((resolve) => {
          hanging = resolve;
          signal.addEventListener("abort", () => resolve());
        });
      return Object.fromEntries(
        Object.entries(replies).map(([key, reply]) => [
          key,
          reply === "fail"
            ? { value: "unsure", outcome: "failed" as const, reason: "timeout", version: "tg1" }
            : reply === "unsure" || reply === "hang"
              ? { value: "unsure", outcome: "abstained" as const, version: "tg1" }
              : { value: reply, outcome: "answered" as const, version: "tg1" },
        ]),
      );
    },
  };
  const settings = {
    getTagCheck: () => saved.check,
    setTagCheck: (check: SavedTagCheck | null) => {
      saved.check = check;
    },
    getTagAutoSince: () => saved.since,
    setTagAutoSince: (at: number) => {
      saved.since = at;
    },
  };
  const make = () => {
    const tagger = new TaskTagger({
      tasks: f.tasks,
      work: new TagWork(f.db),
      models,
      settings,
      now: f.clock,
      activity: (line) => lines.push(line),
    });
    f.tasks.onChange((change) => tagger.heard(change));
    return tagger;
  };
  const tagger = make();
  const file = async (id: string, title: string, extra: { parentId?: string } = {}) => {
    f.tick(10);
    f.tasks.create({ id, title, prompt: "", repoId: "r1", ...extra });
    await tagger.idle();
  };
  const tagsOf = (id: string) => f.tasks.tagsOf(id).map((tag) => `${tag.name}:${tag.by}`);
  const done = () => {
    tagger.dispose();
    f.protocol.dispose();
    f.db.close();
  };
  return {
    f,
    projectId,
    bug,
    docs,
    add,
    asked,
    lines,
    saved,
    tagger,
    make,
    file,
    tagsOf,
    done,
    turn: (value: boolean) => {
      on = value;
      tagger.useChanged();
    },
    release: () => hanging?.(),
  };
}

describe("automatic tagging", () => {
  it("asks once about a new task, every tag in one request, adding only the tags answered yes", async () => {
    const t = tagged((_, tag) => (tag === "bug" ? "yes" : "unsure"));
    try {
      await t.file("parent", "Sign-in work");
      await t.file("crash", "The app crashes on sign-in", { parentId: "parent" });

      const asking = t.asked.filter((ask) => ask.taskId === "crash");
      expect(asking).toHaveLength(1);
      expect(asking[0]?.tags).toEqual(["bug", "docs"]);
      expect(asking[0]?.facts).toMatchObject({
        project: "nimbus-api",
        title: "The app crashes on sign-in",
        parent_title: "Sign-in work",
      });
      expect(t.tagsOf("crash")).toEqual(["bug:decision"]);

      t.f.tick(TAG_RETRY_MS * 2);
      t.tagger.retry();
      t.tagger.wake();
      await t.tagger.idle();
      expect(t.asked.filter((ask) => ask.taskId === "crash")).toHaveLength(1);
      expect(t.asked.some((ask) => ask.taskId === "old")).toBe(false);
    } finally {
      t.done();
    }
  });

  it("asks nothing about a task in a project with no tags", async () => {
    const t = tagged(() => "yes");
    try {
      seedProject(t.f.db, { id: "r2", name: "website", path: "/fleet/website", addedAt: 2 });
      t.f.tick(10);
      t.f.tasks.create({ id: "site", title: "Redo the footer", prompt: "", repoId: "r2" });
      await t.tagger.idle();
      expect(t.asked).toEqual([]);
    } finally {
      t.done();
    }
  });

  it("asks a task moved into a project with tags, and once more about decision tags when its title changes", async () => {
    const t = tagged((title, tag) =>
      title.includes("guide") ? (tag === "docs" ? "yes" : "no") : tag === "bug" ? "yes" : "no",
    );
    try {
      seedProject(t.f.db, { id: "r2", name: "website", path: "/fleet/website", addedAt: 2 });
      t.f.tick(10);
      t.f.tasks.create({ id: "site", title: "Footer is broken", prompt: "", repoId: "r2" });
      await t.tagger.idle();
      expect(t.asked).toEqual([]);
      t.f.tasks.moveToProject("site", t.projectId, "captain");
      await t.tagger.idle();
      expect(t.tagsOf("site")).toEqual(["bug:decision"]);

      await t.file("hand", "Write the setup guide");
      t.f.tasks.setTags("hand", [{ tagId: t.bug, on: true }], "captain");
      expect(t.tagsOf("hand")).toEqual(["bug:captain", "docs:decision"]);
      t.f.tasks.updateFields("hand", { title: "Something broke in setup" }, "firstmate");
      await t.tagger.idle();
      const last = t.asked.at(-1);
      expect(last).toMatchObject({ taskId: "hand", tags: ["docs"] });
      expect(t.tagsOf("hand")).toEqual(["bug:captain"]);
    } finally {
      t.done();
    }
  });

  it("leaves a task unchecked when the model gives no answer, and asks again only after an hour", async () => {
    let reply: Reply = "fail";
    const t = tagged(() => reply);
    try {
      await t.file("crash", "The app crashes");
      expect(t.asked).toHaveLength(1);
      expect(t.tagsOf("crash")).toEqual([]);
      t.tagger.retry();
      t.tagger.wake();
      await t.tagger.idle();
      expect(t.asked).toHaveLength(1);

      reply = "yes";
      t.f.tick(TAG_RETRY_MS);
      t.tagger.retry();
      await t.tagger.idle();
      expect(t.asked).toHaveLength(2);
      expect(t.tagsOf("crash")).toEqual(["bug:decision", "docs:decision"]);
      expect(t.lines).toEqual([]);
    } finally {
      t.done();
    }
  });

  it("lets go of the waiting request when the use turns off, and asks only about newer tasks once it is on again", async () => {
    const t = tagged((title) => (title === "Hangs" ? "hang" : "yes"));
    try {
      t.f.tick(10);
      t.f.tasks.create({ id: "hangs", title: "Hangs", prompt: "", repoId: "r1" });
      const pending = t.tagger.idle();
      t.turn(false);
      await pending;
      expect(t.tagsOf("hangs")).toEqual([]);

      await t.file("off", "Filed while off");
      expect(t.asked.map((ask) => ask.taskId)).toEqual(["hangs"]);

      t.turn(true);
      await t.file("on", "Filed once on");
      await t.tagger.idle();
      expect(t.asked.map((ask) => ask.taskId)).toEqual(["hangs", "on"]);
      expect(t.tagsOf("off")).toEqual([]);
    } finally {
      t.release();
      t.done();
    }
  });
});

describe("check existing tasks", () => {
  it("counts each reach's requests, checks behind new tasks, keeps what it did when stopped and ends with one Activity line", async () => {
    const t = tagged((title) => (title.startsWith("Bug") ? "yes" : "no"));
    try {
      t.turn(false);
      for (const id of ["a", "b", "c"]) {
        t.f.tick(10);
        t.f.tasks.create({ id, title: `Bug ${id}`, prompt: "", repoId: "r1" });
      }
      t.f.tick(10);
      t.f.tasks.create({ id: "closed", title: "Closed long ago", prompt: "", repoId: "r1" });
      t.f.tasks.close("closed", { status: "done", reason: "merged", actor: "host" });
      t.f.tick(8 * DAY);
      t.f.tasks.create({ id: "recent", title: "Done this week", prompt: "", repoId: "r1" });
      t.f.tasks.close("recent", { status: "done", reason: "merged", actor: "host" });
      t.turn(true);
      await t.tagger.idle();
      expect(t.asked).toEqual([]);

      const [view] = t.tagger.views({ projectId: t.projectId });
      expect(view).toMatchObject({
        auto: true,
        answerer: "Jev 2",
        reaches: { open: 4, week: 5, all: 6 },
      });

      t.tagger.change({ op: "start", projectId: t.projectId, reach: "open" });
      await t.tagger.idle();
      expect(t.asked.map((ask) => ask.taskId).sort()).toEqual(["a", "b", "c", "old"]);
      expect(t.tagsOf("a")).toEqual(["bug:decision", "docs:decision"]);
      expect(t.tagsOf("old")).toEqual([]);
      expect(t.saved.check).toBeNull();
      expect(t.lines.map(englishOf)).toEqual(["nimbus-api: checked 4 tasks for tags."]);
      expect(t.tagger.views({ projectId: t.projectId })[0]?.reaches).toEqual({
        open: 0,
        week: 1,
        all: 2,
      });
    } finally {
      t.done();
    }
  });

  it("stops keeping every answer it recorded, and resumes where it stood after a restart", async () => {
    let hangs = true;
    const t = tagged((title) => (title === "Bug b" && hangs ? "hang" : "yes"));
    try {
      t.turn(false);
      for (const id of ["a", "b", "c"]) {
        t.f.tick(10);
        t.f.tasks.create({ id, title: `Bug ${id}`, prompt: "", repoId: "r1" });
      }
      t.turn(true);
      t.tagger.change({ op: "start", projectId: t.projectId, reach: "all" });
      // Newest first: c is answered, then b waits on the model.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(t.tagger.views({ projectId: t.projectId })[0]?.running).toMatchObject({
        reach: "all",
        total: 4,
        done: 1,
      });
      t.tagger.change({ op: "stop", projectId: t.projectId });
      await t.tagger.idle();
      expect(t.saved.check).toBeNull();
      expect(t.tagsOf("c")).toEqual(["bug:decision", "docs:decision"]);
      expect(t.tagsOf("b")).toEqual([]);
      expect(t.lines).toEqual([]);

      hangs = false;
      t.tagger.change({ op: "start", projectId: t.projectId, reach: "all" });
      expect(t.saved.check?.total).toBe(3);
      // Quitting at once lets go of the first request; the saved check outlives this tagger.
      t.tagger.dispose();
      const asked = t.asked.length;
      const restarted = t.make();
      restarted.wake();
      await restarted.idle();
      expect(t.asked.slice(asked).map((ask) => ask.taskId)).toEqual(["b", "a", "old"]);
      expect(t.lines.map(englishOf)).toEqual(["nimbus-api: checked 3 tasks for tags."]);
      restarted.dispose();
    } finally {
      t.release();
      t.done();
    }
  });

  it("checks only a tag added later, and a tag whose description changed, on tasks the model judged before", async () => {
    const t = tagged((_, tag) => (tag === "ux" ? "yes" : "no"));
    try {
      await t.file("judged", "Tidy the settings page");
      expect(t.asked).toHaveLength(1);
      t.f.tick(10);
      const ux = t.add("ux", "How the app looks and feels.");
      await t.tagger.idle();
      expect(t.asked).toHaveLength(1);

      expect(t.tagger.views({ projectId: t.projectId, tagIds: [ux] })[0]?.reaches.open).toBe(2);
      t.tagger.change({ op: "start", projectId: t.projectId, reach: "open", tagIds: [ux] });
      await t.tagger.idle();
      expect(t.asked.slice(1).map((ask) => [ask.taskId, ask.tags])).toEqual([
        ["judged", ["ux"]],
        ["old", ["ux"]],
      ]);
      expect(t.tagsOf("judged")).toEqual(["ux:decision"]);

      // The task filed before the tags was never asked about bug; the judged one was.
      const bugChecks = () =>
        t.tagger.views({ projectId: t.projectId, tagIds: [t.bug] })[0]?.reaches.open;
      expect(bugChecks()).toBe(1);
      t.f.tasks.changeProjectTags({
        op: "edit",
        tagId: t.bug,
        description: "A crash or a wrong result.",
      });
      expect(bugChecks()).toBe(2);
      expect(t.tagger.views({ projectId: t.projectId, tagIds: [t.docs] })[0]?.reaches.open).toBe(1);
    } finally {
      t.done();
    }
  });

  it("refuses a second project's check while one runs, and any check while the use is off", async () => {
    const t = tagged((title) => (title === "Bug a" ? "hang" : "no"));
    try {
      seedProject(t.f.db, { id: "r2", name: "website", path: "/fleet/website", addedAt: 2 });
      t.f.tasks.create({ id: "site", title: "Footer", prompt: "", repoId: "r2" });
      const website = t.f.tasks.get("site")?.projectId as string;
      t.f.tasks.changeProjectTags({
        op: "add",
        projectId: website,
        name: "bug",
        description: "Broken.",
      });
      t.turn(false);
      t.f.tick(10);
      t.f.tasks.create({ id: "a", title: "Bug a", prompt: "", repoId: "r1" });
      t.turn(true);
      t.tagger.change({ op: "start", projectId: t.projectId, reach: "open" });
      expect(() => t.tagger.change({ op: "start", projectId: website, reach: "open" })).toThrow(
        "A check of nimbus-api's tasks is under way; stop it first.",
      );
      expect(t.tagger.views({ projectId: website })[0]?.elsewhere).toBe("nimbus-api");
      t.turn(false);
      expect(t.saved.check).toBeNull();
      expect(() => t.tagger.change({ op: "start", projectId: website, reach: "open" })).toThrow(
        /Tag tasks automatically is off/,
      );
    } finally {
      t.release();
      t.done();
    }
  });
});
