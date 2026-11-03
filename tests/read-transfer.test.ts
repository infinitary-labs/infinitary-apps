import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../src/core/storage/db";
import { seedTask } from "../src/core/tasks/seedTask";
import { TaskProtocol } from "../src/core/tasks/taskProtocol";
import { TaskService } from "../src/core/tasks/taskService";
import {
  READ_VALUE_DECODER,
  type ReadTransfer,
  transferReadValue,
} from "../src/shared/plugins/readTransfer";
import type { TaskBoard, TaskView } from "../src/shared/tasks";

// INF-2221: a task change must not clone the unchanged history into every
// panel. Exercise the exact frame decoder with readings from the real board
// owner, across structured clone (the browser message boundary), not source
// text or a second implementation of the decoder.
const receive = runInNewContext(`(${READ_VALUE_DECODER})`) as (
  previous: unknown,
  message: ReadTransfer,
) => unknown;

function fixture() {
  const db = openInMemoryDatabase();
  let now = 10_000;
  const tasks = new TaskService({ db, now: () => ++now });
  const protocol = new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
    now: () => now,
  });
  seedTask(tasks, { id: "writing", title: "Check typing while crew writes", status: "idle" });
  seedTask(tasks, { id: "earlier", title: "Review task navigation", status: "completed" });
  tasks.close("earlier", { status: "done", reason: "merged", actor: "host" });
  return {
    tasks,
    protocol,
    close: () => {
      protocol.dispose();
      db.close();
    },
  };
}

describe("read values across the frame boundary (INF-2221)", () => {
  it("delivers every board field but transfers only changed rows after the first snapshot", () => {
    const f = fixture();
    try {
      const first = f.protocol.board();
      const initial = transferReadValue(undefined, first);
      expect(initial.reuse).toBeUndefined();
      const held = receive(undefined, structuredClone(initial)) as TaskBoard;
      expect(held).toEqual(first);
      expect(held.tasks[0]).not.toBe(first.tasks[0]);

      f.tasks.setActivity("writing", "running");
      seedTask(f.tasks, { id: "queued", title: "Check the updated frame", status: "queued" });
      const next = f.protocol.board();
      const message = transferReadValue(first, next);
      const changed = next.tasks.filter((row) => !first.tasks.includes(row));
      expect((message.value as TaskBoard).tasks).toEqual(changed);
      const received = receive(held, structuredClone(message)) as TaskBoard;
      expect(received).toEqual(next);
      const earlier = held.tasks.find((row) => row.id === "earlier");
      expect(earlier).toBeDefined();
      expect(received.tasks.find((row) => row.id === "earlier")).toBe(earlier);
      expect(received.tasks.find((row) => row.id === "writing")).not.toBe(
        held.tasks.find((row) => row.id === "writing"),
      );
      // A fresh source read or a new subscription has no retained identities:
      // the same values still arrive whole, replacing the receiver's base.
      const fresh = transferReadValue(next, structuredClone(next));
      expect(fresh.reuse).toBeUndefined();
      expect(receive(received, structuredClone(fresh))).toEqual(next);
      expect(transferReadValue(undefined, next).reuse).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it("keeps a list read's order and unchanged rows without changing its array shape", () => {
    const f = fixture();
    try {
      const first = f.protocol.board().tasks;
      const held = receive(
        undefined,
        structuredClone(transferReadValue(undefined, first)),
      ) as TaskView[];
      f.tasks.setActivity("writing", "running");
      const next = f.protocol.board().tasks;
      const message = transferReadValue(first, next);
      const received = receive(held, structuredClone(message)) as TaskView[];
      expect(received).toEqual(next);
      const earlier = held.find((row) => row.id === "earlier");
      expect(earlier).toBeDefined();
      expect(received.find((row) => row.id === "earlier")).toBe(earlier);
      expect(receive(received, { value: [] })).toEqual([]);
      expect(receive(received, { value: null })).toBeNull();
    } finally {
      f.close();
    }
  });
});
