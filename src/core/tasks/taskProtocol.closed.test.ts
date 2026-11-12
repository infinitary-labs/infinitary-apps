import { boardWithoutClosed } from "@shared/boardWithoutClosed";
import { applyTaskBoardDelta, taskBoardSchema } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";

/**
 * The board read without its closed rows (INF-3750's option B, which the
 * captain chose to start: every view's first board read leaves out the week's
 * closed tasks and reads them later, when it needs them). Read from a real
 * record through the real writer, so a view coming back reads the live work
 * and what it hangs on, and counts the Done rows it left out.
 */
describe("the board without its closed rows (INF-3750, option B)", () => {
  function record() {
    const f = taskProtocolFixture({ deltaTrigger: { rows: 0, bytes: 0 } });
    const { tasks, tick } = f;
    const work = (id: string, extra: { parentId?: string; repoId?: string | null } = {}) => {
      tasks.create({ id, title: id, prompt: "p", repoId: extra.repoId ?? "r1", ...extra });
      tick();
    };
    const done = (id: string) => {
      tasks.close(id, { status: "done", reason: "landed", actor: "captain" });
      tick();
    };
    work("live");
    work("program");
    work("finished-part", { parentId: "program" });
    work("live-part", { parentId: "program" });
    done("finished-part");
    work("closed-parent");
    work("open-child", { parentId: "closed-parent" });
    done("closed-parent");
    work("done-a");
    done("done-a");
    work("done-scratch", { repoId: null });
    done("done-scratch");
    work("dropped");
    tasks.close("dropped", { status: "dropped", reason: "discarded", actor: "captain" });
    tick();
    work("pinned-done");
    done("pinned-done");
    tasks.setPinned("pinned-done", true, { actor: "captain" });
    tick();
    work("carded");
    done("carded");
    f.cards.push({
      id: "card-carded",
      taskId: "carded",
      author: "crewmate",
      priority: 2,
      title: "What was built",
      meta: "",
      body: "",
      actions: [],
      status: "ready",
      createdAt: 1,
    });
    return f;
  }

  it("keeps live work and what it hangs on, and names the Done rows it left out", () => {
    const f = record();
    const whole = f.protocol.board();
    const lesser = f.protocol.board({ closed: false });
    expect(taskBoardSchema.parse(lesser)).toEqual(lesser);
    expect(lesser.tasks.map((task) => task.id).sort()).toEqual(
      [
        "carded",
        "closed-parent",
        "finished-part",
        "live",
        "live-part",
        "open-child",
        "pinned-done",
        "program",
      ].sort(),
    );
    const scratch = whole.tasks.find((task) => task.id === "done-scratch")?.projectId;
    const project = whole.tasks.find((task) => task.id === "done-a")?.projectId;
    expect(lesser.closedLeftOut).toEqual({
      done: { [project ?? ""]: ["done-a"], [scratch ?? ""]: ["done-scratch"] },
    });
    // The same rows and links as the whole board, with its counts and seq.
    for (const task of lesser.tasks) {
      expect(task).toEqual(whole.tasks.find((row) => row.id === task.id));
    }
    expect(lesser.projects).toEqual(whole.projects);
    expect(lesser.seq).toBe(whole.seq);
    expect(whole.closedLeftOut).toBeUndefined();
    expect(boardWithoutClosed(whole, new Set(["carded"]))).toEqual(lesser);
  });

  it("stays without its closed rows as the deltas of the whole board fold onto it", async () => {
    const f = record();
    const lesser = f.protocol.board({ closed: false });
    await f.settle();
    const pushed = f.deltas().length;
    f.tasks.close("live", { status: "done", reason: "landed", actor: "captain" });
    f.tick();
    // A left-out row that changes comes back, and is no longer counted as left out.
    f.tasks.setPinned("done-a", true, { actor: "captain" });
    await f.settle();
    let board = lesser;
    for (const delta of f.deltas().slice(pushed)) {
      const next = applyTaskBoardDelta(board, delta);
      expect(next).not.toBeNull();
      if (next) board = next;
    }
    const whole = f.protocol.board();
    expect(board.seq).toBe(whole.seq);
    const ids = board.tasks.map((task) => task.id);
    expect(ids).toContain("live");
    expect(ids).toContain("done-a");
    expect(ids).not.toContain("dropped");
    expect(ids).not.toContain("done-scratch");
    expect(Object.values(board.closedLeftOut?.done ?? {}).flat()).toEqual(["done-scratch"]);
  });
});
