import { overridePasses } from "@shared/holds";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { LOAD_ORDER } from "@shared/load";
import { expect, it, vi } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { contractChange } from "../connection/contractChanges";
import { ComputerLoads } from "../placed/computerLoads";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// INF-2195: a two-second load round must not compose the whole saved task
// record, while preserving the recorded override's computer and version scope.
function fixture() {
  const db = freshDatabase();
  const tasks = new TaskService({ db });
  const add = (id: string, computer = "mini") =>
    seedTask(tasks, {
      id,
      title: "Check the computer reading",
      status: "queued",
      deviceId: computer,
    });
  const grant = (id: string, until: "task" | "version" = "task", head = "reviewed") =>
    seedDelivery(tasks, id, {
      headSha: head,
      override: {
        words: "Let this run proceed",
        holds: ["load-line"],
        until,
        head: "reviewed",
        at: 1,
      },
    });
  return { db, tasks, add, grant };
}

it("preserves computer, hold and version scope and follows saved changes, including closed groups", () => {
  const { db, tasks, add, grant } = fixture();
  try {
    for (const id of ["lifetime", "version", "expired", "different-hold", "ordinary", "closed"])
      add(id);
    add("other-computer", "studio");
    for (const id of ["lifetime", "closed", "other-computer"]) grant(id);
    grant("version", "version");
    grant("expired", "version", "new-work");
    seedDelivery(tasks, "different-hold", {
      override: { words: "Proceed without review", holds: ["checks"], until: "task", at: 1 },
    });
    tasks.close("closed", { status: "done", reason: "settled", actor: "host" });
    const read = () => tasks.passingOverridesForComputer("mini", "load-line").sort();
    const oldRead = () =>
      tasks
        .list()
        .filter(
          (task) =>
            task.deviceId === "mini" &&
            overridePasses(task.delivery, "load-line", task.delivery?.headSha),
        )
        .map((task) => task.id)
        .sort();
    expect(read()).toEqual(["closed", "lifetime", "version"]);
    expect(read()).toEqual(oldRead());
    tasks.setDevice("lifetime", "studio");
    seedDelivery(tasks, "version", { override: undefined, headSha: "new-work" });
    expect(read()).toEqual(["closed"]);
    expect(read()).toEqual(oldRead());
    grant("ordinary");
    expect(read()).toEqual(["closed", "ordinary"]);
    expect(tasks.passingOverridesForComputer("missing", "load-line")).toEqual([]);
  } finally {
    db.close();
  }
});

it("sends the persisted overrides in a load round without reading more rows when closed history quadruples", async () => {
  const { db, tasks, add, grant } = fixture();
  const snapshot = { runs: [] };
  const ask = vi.fn(async () => snapshot);
  const loads = new ComputerLoads({
    local: { snapshot: () => snapshot, taskIds: () => [], reconsider: () => {} },
    work: {
      ask,
      inReach: () => true,
      version: () => ({
        contract: PROTOCOL_VERSION,
        takesWork: true,
        changes: [contractChange("heavy-run-line")],
      }),
      onWorkDevice: () => () => {},
    },
    overrides: (computer) => tasks.passingOverridesForComputer(computer, "load-line"),
  });
  try {
    add("approved");
    grant("approved");
    // Permission-bearing history is realistic too: a closed PR keeps its
    // review/check evidence and required actions, not only its task row.
    const history = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const id = `finished-${i}`;
        add(id);
        seedDelivery(tasks, id, {
          headSha: "merged",
          requiredActionOffer: { cardId: `completion-${i}`, offerId: `offer-${i}`, actions: [] },
        });
        tasks.close(id, { status: "done", reason: "settled", actor: "host" });
      }
    };
    history(0, 40);
    tasks.passingOverridesForComputer("mini", "load-line"); // Warm schema probes.
    const read = () =>
      expect(tasks.passingOverridesForComputer("mini", "load-line")).toEqual(["approved"]);
    const before = rowsRead(db, read);
    history(40, 160);
    const after = rowsRead(db, read);
    expect(after).toBe(before);
    expect(after).toBe(1);
    // A regression to the old record composer must fail before the transport.
    const list = vi.spyOn(tasks, "list").mockImplementation(() => {
      throw new Error("full task scan");
    });
    const get = vi.spyOn(tasks, "get").mockImplementation(() => {
      throw new Error("task composition");
    });
    await loads.refresh("mini");
    expect(ask).toHaveBeenCalledExactlyOnceWith("mini", LOAD_ORDER, [{ overrides: ["approved"] }]);
    expect(loads.read("mini")).toEqual({ status: "fresh", runs: [] });
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    console.info(
      JSON.stringify({
        closedHistory: [40, 160],
        returnedRows: [before, after],
        order: LOAD_ORDER,
        payload: ask.mock.calls,
        reading: loads.read("mini"),
      }),
    );
  } finally {
    loads.dispose();
    db.close();
  }
});
