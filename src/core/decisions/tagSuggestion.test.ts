import { describe, expect, it } from "vitest";
import { DAY, taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { captainTurn, renderWake } from "../orchestrator/wakes";
import { TagWork } from "../storage/tagWork";
import { TaskTagger } from "./taskTagger";

/**
 * Suggest tags, from the approved plan (docs/task-tags.md, "Suggesting
 * tags"): the press tells the first mate the project, how many tasks each
 * check reach holds, whether Tag tasks automatically asks and who answers,
 * and sends nothing for a project that already has a tag. The record is
 * real; the decision models are a stand-in that is never asked.
 */

function harbour(options: { on: boolean; answerer: string | null }) {
  const f = taskProtocolFixture();
  const create = (id: string) => {
    f.tick(10);
    f.tasks.create({ id, title: `Task ${id}`, prompt: "", repoId: "r1" });
  };
  create("done-long-ago");
  f.tasks.close("done-long-ago", { status: "done", reason: "landed", actor: "host" });
  f.tick(20 * DAY);
  create("done-this-week");
  f.tasks.close("done-this-week", { status: "done", reason: "landed", actor: "host" });
  f.tick(2 * DAY);
  create("open-1");
  create("open-2");
  create("dropped");
  f.tasks.close("dropped", { status: "dropped", reason: "cancelled", actor: "host" });
  const projectId = f.tasks.get("open-1")?.projectId as string;
  const tagger = new TaskTagger({
    tasks: f.tasks,
    work: new TagWork(f.db),
    models: {
      allowsUse: () => options.on,
      answererName: () => options.answerer,
      decide: async () => {
        throw new Error("Suggest tags asks the decision model nothing.");
      },
    },
    settings: {
      getTagCheck: () => null,
      setTagCheck: () => {},
      getTagAutoSince: () => null,
      setTagAutoSince: () => {},
    },
    now: f.clock,
    activity: () => {},
  });
  const done = () => {
    tagger.dispose();
    f.protocol.dispose();
    f.db.close();
  };
  return { f, projectId, tagger, done };
}

describe("Suggest tags", () => {
  it("names the project, each reach's task count and who answers", () => {
    const { f, projectId, tagger, done } = harbour({ on: true, answerer: "Jev 2" });
    try {
      const project = f.tasks.projects.get(projectId);
      expect(tagger.suggestion(projectId)).toEqual({
        projectId,
        key: project?.key,
        name: "nimbus-api",
        // Two open; plus the one done two days ago; plus the one done 22 days ago and the dropped one.
        reaches: { open: 2, week: 3, all: 5 },
        auto: true,
        answerer: "Jev 2",
      });
    } finally {
      done();
    }
  });

  it("sends nothing for an unknown project or one that already has a tag", () => {
    const { f, projectId, tagger, done } = harbour({ on: true, answerer: null });
    try {
      expect(tagger.suggestion("no-such-project")).toBe("unknown");
      f.tasks.changeProjectTags({
        op: "add",
        projectId,
        name: "bug",
        description: "Something that used to work and is broken now.",
      });
      expect(tagger.suggestion(projectId)).toBe("tagged");
    } finally {
      done();
    }
  });

  it("puts the note under the words only when the press sent them", () => {
    const { projectId, tagger, done } = harbour({ on: false, answerer: null });
    try {
      const facts = tagger.suggestion(projectId);
      if (typeof facts === "string") throw new Error(`refused: ${facts}`);
      const words = "Suggest tags for nimbus-api";
      const pressed = renderWake(captainTurn(words, false, undefined, undefined, undefined, facts));
      expect(pressed).toContain(`[user]\n${words}\n\n[tag suggestion request]`);
      expect(pressed).toContain(`project nimbus-api (key ${facts.key}, id ${projectId})`);
      // With the use off, the card leaves the check question out.
      expect(pressed).toContain("Tag tasks automatically is off");
      expect(pressed).not.toContain("open tasks 2");
      expect(renderWake(captainTurn(words, false))).not.toContain("[tag suggestion request]");
    } finally {
      done();
    }
  });
});
