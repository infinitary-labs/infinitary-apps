import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";

/**
 * A read task's delivery facts are composed from the rows the read took the
 * first time something reads them (INF-4314): a list of the board's
 * rows decodes none of their change evidence until a row's facts are asked
 * for, and what it answers then is what was saved when the list was read.
 */

const PULL = "https://example.test/acme/gauge/pull/7";

function seeded() {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "gauge", title: "Fix the gauge's reading", status: "running" });
  seedDelivery(tasks, "gauge", { mode: "direct-pr", prUrl: PULL, prNumber: 7, headSha: "a1" });
  return { db, tasks };
}

describe("a read task's delivery facts", () => {
  it("decode none of a listed task's change evidence until its delivery is read", () => {
    const { db, tasks } = seeded();
    const parse = vi.spyOn(JSON, "parse");
    try {
      const decodedEvidence = () =>
        parse.mock.calls.some(([text]) => typeof text === "string" && text.includes(PULL));
      const [listed] = tasks.listLiveOrClosedSince(0);
      expect(listed?.title).toBe("Fix the gauge's reading");
      expect(decodedEvidence()).toBe(false);
      expect(listed?.delivery?.prUrl).toBe(PULL);
      expect(decodedEvidence()).toBe(true);
    } finally {
      parse.mockRestore();
      db.close();
    }
  });

  it("answer what was saved when the task was read, even when first read after a later write", () => {
    const { db, tasks } = seeded();
    try {
      const [listed] = tasks.list();
      const got = tasks.get("gauge");
      seedDelivery(tasks, "gauge", { headSha: "b2" });
      expect(listed?.delivery?.headSha).toBe("a1");
      expect(got?.delivery?.headSha).toBe("a1");
      expect(tasks.get("gauge")?.delivery?.headSha).toBe("b2");
    } finally {
      db.close();
    }
  });

  it("travel with every copy of the record, and a write replaces them", () => {
    const { db, tasks } = seeded();
    try {
      const listed = tasks.get("gauge");
      if (!listed) throw new Error("the seeded task is missing");
      expect(Object.keys(listed)).toContain("delivery");
      expect({ ...listed }.delivery?.prNumber).toBe(7);
      expect(structuredClone(listed).delivery?.prNumber).toBe(7);
      expect(JSON.parse(JSON.stringify(listed)).delivery.prUrl).toBe(PULL);
      listed.delivery = null;
      expect(listed.delivery).toBeNull();
      expect({ ...listed }.delivery).toBeNull();
      expect(tasks.get("gauge")?.delivery?.prNumber).toBe(7);
    } finally {
      db.close();
    }
  });
});
