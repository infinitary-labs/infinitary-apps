import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Card } from "../../shared/cards";
import { type AppPaths, crewmateHandoverDir, crewmateTempDir } from "../paths";
import { InboxStore } from "../storage/inboxStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CrewSupervisor } from "./crewSupervisor";
import { SettleService, type SettleServiceHost } from "./settleService";

// Integration: real screenshot copies and a real close transaction; measured below one second.
vi.setConfig({ testTimeout: 15_000 });

// INF-1426 / INF-1389 finding 4: handed-on results are done, not discarded.
function fixture(deliverable: "answer" | "change" = "answer", reported = true) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "finder",
    title: "Hand the screenshot to the builder",
    status: "idle",
    ...(reported ? { outcome: "The screenshot is ready for the builder." } : {}),
    shape: { kind: "research", deliverable },
  });
  seedTask(tasks, { id: "builder", title: "Fix the clipped card", status: "idle" });
  const cards: unknown[] = [];
  const workStatus = vi.fn(async () => ({ dirty: false, unlandedCommits: 0 }));
  const host = {
    tasks,
    now: () => Date.now(),
    runtimeState: () => "idle",
    resolveTaskRef: (ref: string) => tasks.resolve(ref),
    deliverableOf: () => deliverable,
    cards: { snapshot: () => cards, retireTaskCards: () => {}, scheduleBroadcast: () => {} },
    inbox: new InboxStore(db),
    endLiveTask: () => {},
    stopRuntime: () => undefined,
    sweepGates: async () => {},
    broadcastCrewCounts: () => {},
    workspace: { taskWorkStatus: workStatus },
  } as unknown as SettleServiceHost;
  const service = new SettleService(host);
  return { tasks, service, cards, workStatus };
}

describe("handed-on result completion", () => {
  it("delivers a real screenshot before closing the source as done, and keeps the successor's copy", async () => {
    const { tasks, service } = fixture("change");
    const paths = { crewmatesDir: scratchDir("infinitary-handed-result-") } as AppPaths;
    const original = fileURLToPath(
      new URL("../../../release-notes/pictures/action-reply-line-dark.webp", import.meta.url),
    );
    const [kept] = await keepHandoverFiles([original], crewmateHandoverDir(paths, "finder"));
    const supervisor = { options: { tasks, paths } } as unknown as CrewSupervisor;
    const guidance = await CrewSupervisor.prototype.handFiles.call(supervisor, "finder", "builder");
    if (!kept) throw new Error("the screenshot was not retained");
    const delivered = join(crewmateTempDir(paths, "builder"), "handover", kept.file);
    expect(guidance).toContain(delivered);
    expect(await readFile(delivered)).toEqual(await readFile(original));
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: true });
    expect(tasks.get("finder")).toMatchObject({ status: "done", closedReason: "answered" });
    expect(await readFile(delivered)).toEqual(await readFile(original));
  });

  it("does not record a handoff when no files arrived", async () => {
    const { tasks } = fixture("change");
    const paths = { crewmatesDir: scratchDir("infinitary-missing-result-") } as AppPaths;
    const supervisor = { options: { tasks, paths } } as unknown as CrewSupervisor;
    await expect(
      CrewSupervisor.prototype.handFiles.call(supervisor, "finder", "builder"),
    ).rejects.toThrow("no reported files");
    expect(tasks.resultHandoffOf("finder")).toBe(false);
  });

  it.each(["answer", "change"] as const)(
    "closes a reported %s handed to another task without an internal-step declaration",
    async (kind) => {
      const { tasks, service } = fixture(kind);
      tasks.recordResultHandoff("finder", { taskId: "builder" });
      expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: true });
      expect(tasks.get("finder")).toMatchObject({ status: "done", closedReason: "answered" });
      expect(tasks.timeline("finder")).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ resultHandoff: { taskId: "builder" } }),
        }),
      );
    },
  );

  it("records a captain result choice on a change without closing it mid-turn, then finishes it as answered", async () => {
    const { tasks, service } = fixture("change");
    const card = {
      id: "card-finder-result",
      taskId: "finder",
      title: "Screenshot found",
      actions: [{ id: "use", label: "Use it" }],
    } as Card;
    expect(service.closeAnsweredTask(card, "use", "captain")).toBe(false);
    expect(tasks.resultHandoffOf("finder")).toBe(true);
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: true });
    expect(tasks.get("finder")?.status).toBe("done");
  });

  it.each(["dismissed", "closed", "invented"])("does not count %s as a result choice", (action) => {
    const { tasks, service } = fixture("change");
    service.closeAnsweredTask(
      { id: "card-finder-result", taskId: "finder", actions: [{ id: "use" }] } as Card,
      action,
      "captain",
    );
    expect(tasks.resultHandoffOf("finder")).toBe(false);
  });

  it("does not count a continuing consent card as a result", () => {
    const { tasks, service } = fixture("change");
    service.closeAnsweredTask(
      {
        id: "card-finder-consent",
        taskId: "finder",
        continues: true,
        actions: [{ id: "allow" }],
      } as Card,
      "allow",
      "captain",
    );
    expect(tasks.resultHandoffOf("finder")).toBe(false);
  });

  it("requires the source's report even when files were delivered", async () => {
    const { tasks, service } = fixture("change", false);
    tasks.recordResultHandoff("finder", { taskId: "builder" });
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
  });

  it("keeps a task-owned pull request on its normal delivery path", async () => {
    const { tasks, service } = fixture("change");
    tasks.recordResultHandoff("finder", { taskId: "builder" });
    seedDelivery(tasks, "finder", { prNumber: 497 });
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
    expect(tasks.get("finder")?.status).toBe("active");
  });

  it("preserves the open-child close rule after a result handoff", async () => {
    const { tasks, service } = fixture("change");
    tasks.recordResultHandoff("finder", { taskId: "builder" });
    seedTask(tasks, {
      id: "child",
      title: "Check screenshot dimensions",
      parentId: "finder",
      status: "idle",
    });
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
  });

  it("does not turn a report alone into permission to finish a captain-requested answer", async () => {
    const { tasks, service } = fixture();
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
    expect(tasks.get("finder")?.status).toBe("active");
  });

  it("does not let a change without a handoff bypass delivery", async () => {
    const { service } = fixture("change");
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
  });

  it.each([
    { dirty: true, unlandedCommits: 0 },
    { dirty: false, unlandedCommits: 1 },
  ])("keeps unmerged work after handoff: %j", async (work) => {
    const { tasks, service, workStatus } = fixture("change");
    tasks.recordResultHandoff("finder", { taskId: "builder" });
    tasks.dispatch("finder", {
      workspace: { repoDir: "/project", worktreeDir: "/working-copy", branch: "finder" },
      assignee: "crewmate",
      accountId: null,
    });
    tasks.setActivity("finder", "idle");
    workStatus.mockResolvedValue(work);
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
    expect(tasks.get("finder")?.status).toBe("active");
  });

  it("keeps a question and its result open after handoff", async () => {
    const { tasks, service, cards } = fixture();
    tasks.recordResultHandoff("finder", { taskId: "builder" });
    cards.push({
      id: "card-finder-result",
      taskId: "finder",
      title: "Which screenshot?",
      actions: [{ id: "pick" }],
    });
    expect(await service.closeAnswerUsedAsBasis("finder")).toMatchObject({ ok: false });
  });
});
