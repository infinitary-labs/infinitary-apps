import { BOARD_RECENT_MS } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";

/**
 * The captain's words (INF-3127): "when a task is pinned, it always show in a
 * "pinned" section in the tasks panel at the top, no matter what state it's
 * in". The pin is a fact on the task, written once with its timeline line,
 * and the board keeps a pinned task whatever its state or age, so the panel,
 * the board and the phone all read it.
 */
describe("pinning a task (INF-3127)", () => {
  it("records the pin and its timeline line once, and clears it on unpin", () => {
    const f = taskProtocolFixture();
    try {
      f.tasks.create({
        id: "work",
        title: "Write the release checklist",
        prompt: "",
        repoId: "r1",
      });
      const pinnedAt = f.tick();
      expect(f.tasks.setPinned("work", true, { actor: "captain", panel: "now" })).toEqual({
        ok: true,
        changed: true,
      });
      expect(f.tasks.get("work")?.pinnedAt).toBe(pinnedAt);
      f.tick();
      expect(f.tasks.setPinned("work", true, { actor: "captain" })).toEqual({
        ok: true,
        changed: false,
      });
      expect(f.tasks.get("work")?.pinnedAt).toBe(pinnedAt);
      expect(f.tasks.setPinned("work", false, { actor: "captain" })).toEqual({
        ok: true,
        changed: true,
      });
      expect(f.tasks.get("work")?.pinnedAt).toBeNull();
      const pins = f.tasks
        .timeline("work")
        .filter((event) => event.data && "pin" in event.data)
        .map((event) => [event.actor, event.data?.pin, event.data?.panel]);
      expect(pins).toEqual([
        ["captain", "pinned", "now"],
        ["captain", "unpinned", undefined],
      ]);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("refuses a task it does not know and writes nothing", () => {
    const f = taskProtocolFixture();
    try {
      const result = f.tasks.setPinned("missing", true, { actor: "captain" });
      expect(result.ok).toBe(false);
      expect(f.tasks.get("missing")).toBeUndefined();
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("keeps pinned work closed long ago on the board, warm and fresh, until it is unpinned", () => {
    const f = taskProtocolFixture();
    try {
      f.tasks.create({ id: "old", title: "Retire the old sign-in page", prompt: "", repoId: "r1" });
      f.tasks.close("old", { status: "done", reason: "settled", actor: "host" });
      f.tick(BOARD_RECENT_MS + 1);
      const listed = () => f.protocol.board().tasks.find((task) => task.id === "old");
      expect(listed()).toBeUndefined();

      const pinnedAt = f.tick();
      f.tasks.setPinned("old", true, { actor: "captain" });
      expect(listed()?.pinnedAt).toBe(pinnedAt);
      expect(f.fresh().tasks.find((task) => task.id === "old")?.pinnedAt).toBe(pinnedAt);

      f.tasks.setPinned("old", false, { actor: "captain" });
      expect(listed()).toBeUndefined();
      expect(f.fresh().tasks.find((task) => task.id === "old")).toBeUndefined();
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // The approved plan's rule that a pinned task lists in Pinned and nowhere
  // else: an old pinned part brings no old closed parent into Done · 7d,
  // while a live part still brings its parent, as before.
  it("pulls no old closed parent onto the board with old pinned work", () => {
    const f = taskProtocolFixture();
    try {
      const ids = (board = f.protocol.board()) => board.tasks.map((task) => task.id).sort();
      f.tasks.create({ id: "parent", title: "Move the docs site", prompt: "", repoId: "r1" });
      f.tasks.create({
        id: "part",
        title: "Copy the pages",
        prompt: "",
        repoId: "r1",
        parentId: "parent",
      });
      f.tasks.close("part", { status: "done", reason: "settled", actor: "host" });
      f.tasks.close("parent", { status: "done", reason: "settled", actor: "host" });
      f.tick(BOARD_RECENT_MS + 1);
      f.tasks.setPinned("part", true, { actor: "captain" });
      expect(ids()).toEqual(["part"]);
      expect(ids(f.fresh())).toEqual(["part"]);

      f.tasks.create({
        id: "live",
        title: "Fix a link",
        prompt: "",
        repoId: "r1",
        parentId: "parent",
      });
      expect(ids()).toEqual(["live", "parent", "part"]);
      expect(ids(f.fresh())).toEqual(["live", "parent", "part"]);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
});
