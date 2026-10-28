import { readFileSync } from "node:fs";
import { HOME } from "@shared/deviceNames";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS } from "../../../tests/helpers/claudeMcpLimit";
import { pageTaskField, readPagedTaskQuery } from "../../../tests/helpers/taskQueryText";
import { renderIntentBrief } from "../orchestrator/intentBrief";
import { bindTool } from "../session/tools";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { queryTasks, taskResolutionBody } from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import {
  assembleTasksReads,
  createTasksQueryTool,
  createTaskTools,
  parseTasksQueryText,
  renderTasksFieldPage,
  renderTasksQueryResult,
  TASK_QUERY_PAGE_CHARACTERS,
  TASKS_QUERY_TOOL,
  type TaskToolsDelegate,
} from "./taskTools";
import { piToolsOf } from "./toolSpec";

/**
 * The Firstmate's graph tools (task-system P2): each routes into the
 * delegate with the flat params translated once, a refusal comes back as
 * result text, and malformed input throws (the loud tool error).
 */

type AnyTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

function toolset(overrides: Partial<TaskToolsDelegate> = {}) {
  const delegate: TaskToolsDelegate = {
    plan: vi.fn(() => ({ taskId: "ab12cd34", key: "SCR-3", text: "Planned SCR-3" })),
    update: vi.fn(() => ({ text: "Updated SCR-3: title", ok: true })),
    drop: vi.fn(() => "Dropped SCR-3"),
    withdrawMerge: vi.fn(() => "Withdrew the captain's kept merge approval on SCR-3."),
    override: vi.fn(() => "Recorded the captain's override on SCR-3."),
    withdrawOverride: vi.fn(() => "Took back the captain's override on SCR-3."),
    link: vi.fn(() => "Recorded: SCR-1 blocks SCR-3"),
    query: vi.fn(() => ({ rows: [], total: 0 })),
    startAgain: vi.fn(async () => "SCR-4 replaces SCR-3. Started SCR-4."),
    startNow: vi.fn(async () => 'Started SCR-3 "Fix meter".'),
    ...overrides,
  };
  const tools = piToolsOf(createTaskTools(delegate)) as unknown as AnyTool[];
  return { delegate, byName: new Map(tools.map((tool) => [tool.name, tool])) };
}

describe("task tools", () => {
  it("records a practical wait as blocks, and keeps related for work neither task waits on", () => {
    const link = createTaskTools({
      plan: () => ({ taskId: "ab12cd34", key: "SCR-3", text: "planned" }),
      update: () => ({ text: "updated", ok: true }),
      drop: () => "dropped",
      withdrawMerge: () => "withdrew",
      override: () => "overrode",
      withdrawOverride: () => "took back",
      link: () => "linked",
      query: () => ({ rows: [], total: 0 }),
      startAgain: async () => "again",
      startNow: async () => "started",
    }).find((tool) => tool.name === "link_tasks");
    expect(link?.description).toContain("related: work neither task is waiting on");
    expect(link?.description).toContain("cannot start until");
    expect(link?.description).not.toContain("cannot merge or close until");
    expect(link?.description).toContain("a cycle is refused as text");
    expect(link?.description).not.toContain("use it, not blocks");
  });

  it("start_again returns the replacement and refuses mixed edits before any delegate writes", async () => {
    const { delegate, byName } = toolset();
    const tool = byName.get("update_task");
    expect(
      (await tool?.execute("again", { task: "SCR-3", start_again: true }))?.content[0]?.text,
    ).toContain("SCR-4");
    expect(delegate.startAgain).toHaveBeenCalledWith({ task: "SCR-3" });
    for (const extra of [
      { start_now: true },
      { title: "Changed" },
      { drop: true },
      { autonomy: "on" },
    ]) {
      const result = await tool?.execute("mixed", { task: "SCR-3", start_again: true, ...extra });
      expect(result?.content[0]?.text).toContain("Pass only task and start_again");
    }
    expect(delegate.startAgain).toHaveBeenCalledTimes(1);
    expect(delegate.update).not.toHaveBeenCalled();
    expect(delegate.drop).not.toHaveBeenCalled();
    expect(delegate.startNow).not.toHaveBeenCalled();
  });

  // Intent: INF-1177 piece 2 keeps the same declared facts when work is filed before it starts.
  it.each([true, false])(
    "files ongoing %s and requested intelligence without a special kind",
    async (ongoing) => {
      const { delegate, byName } = toolset();
      await byName.get("create_task")?.execute("subject", {
        title: "Teach chess",
        goal: "Practise rook moves",
        user_words: "teach me chess",
        ongoing,
        intelligence: "high",
      });
      expect(delegate.plan).toHaveBeenCalledWith(
        expect.objectContaining({ shape: { ongoing, intelligence: "high" } }),
      );
    },
  );

  it("create_task carries the intent and the graph placement", async () => {
    const { delegate, byName } = toolset();
    const result = await byName.get("create_task")?.execute("c1", {
      title: "Write the ADR",
      goal: "An ADR exists",
      user_words: "plan the ADR but do not start",
      parent: "SCR-1",
      blocked_by: ["SCR-2"],
      start_policy: "when-ready",
      priority: 1,
    });
    expect(delegate.plan).toHaveBeenCalledWith({
      title: "Write the ADR",
      intent: { goal: "An ADR exists", userWords: "plan the ADR but do not start" },
      parent: "SCR-1",
      blockedBy: ["SCR-2"],
      startPolicy: "when-ready",
      priority: 1,
    });
    expect(result?.content[0]?.text).toBe("Planned SCR-3");
    await expect(
      byName.get("create_task")?.execute("c2", { title: "x", goal: " ", user_words: "y" }),
    ).rejects.toThrow(/goal is required/);
  });

  // INF-143: declaration presence, not the words of the task, controls automatic admission.
  it("keeps safe drafting and explicitly independent automatic creation available", async () => {
    const input = JSON.parse(
      readFileSync("tests/fixtures/accepted-plan/inf143-early-starts.json", "utf8"),
    ).calls[0].args;
    const { delegate, byName } = toolset();
    const refused = await byName.get("create_task")?.execute("undeclared", input);
    expect(delegate.plan).not.toHaveBeenCalled();
    expect(refused).toHaveProperty("details.refusal.kind", "undeclared-prerequisites");
    await byName.get("create_task")!.execute("independent", { ...input, blocked_by: [] });
    expect(delegate.plan).toHaveBeenLastCalledWith(
      expect.objectContaining({ startPolicy: "when-ready", blockedBy: [] }),
    );
    await byName.get("create_task")!.execute("draft", { ...input, start_policy: "on-request" });
    expect(delegate.plan).toHaveBeenLastCalledWith(
      expect.objectContaining({ startPolicy: "on-request" }),
    );
    expect(delegate.plan).toHaveBeenCalledTimes(2);
  });

  // INF-188 F2: an update must not turn an unfinished graph into automatic work.
  it("requires declared prerequisites before an automatic update or combined start", async () => {
    const { delegate, byName } = toolset();
    const update = byName.get("update_task")!;
    for (const extra of [{}, { start_now: true, title: "Changed too early" }]) {
      const refused = await update.execute("undeclared", {
        task: "SCR-3",
        start_policy: "when-ready",
        ...extra,
      });
      expect(refused).toHaveProperty("details.refusal.kind", "undeclared-prerequisites");
      // INF-461: the refusal points to the one home of what [] declares.
      expect(refused?.content[0]?.text).toContain("as create_task's blocked_by says");
      expect(delegate.update).not.toHaveBeenCalled();
      expect(delegate.startNow).not.toHaveBeenCalled();
    }
    for (const blocked_by of [[], ["SCR-2"]]) {
      await update.execute("declared", {
        task: "SCR-3",
        start_policy: "when-ready",
        blocked_by,
      });
      expect(delegate.update).toHaveBeenLastCalledWith({
        task: "SCR-3",
        startPolicy: "when-ready",
        declaredBlockers: blocked_by,
      });
    }
    await update.execute("draft", { task: "SCR-3", start_policy: "on-request" });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", startPolicy: "on-request" });
  });

  it("create_task carries constraints and a delivery note into the step's brief", async () => {
    const { delegate, byName } = toolset();
    const line = "implement: the simplest change that meets the accepted plan.";
    await byName.get("create_task")?.execute("c3", {
      title: "Implement the meter",
      goal: "The meter shows the week",
      user_words: "add a weekly meter",
      constraints: [{ kind: "free", text: line }, { kind: "tests-required" }],
      delivery_note: "stack on top of PR 41",
    });
    const intent = vi.mocked(delegate.plan).mock.calls[0]?.[0].intent;
    if (!intent) throw new Error("create_task planned nothing");
    const brief = renderIntentBrief(intent, "direct-pr").split("\n");
    const words = brief.indexOf("add a weekly meter");
    const constraints = brief.indexOf("Constraints:");
    expect(words).toBeGreaterThan(-1);
    expect(constraints).toBeGreaterThan(words);
    expect(brief[constraints + 1]).toBe(`- ${line}`);
    expect(brief).toContain("Delivery note: stack on top of PR 41");
  });

  it("update_task edits fields, and drops with a reason (confirm passes through)", async () => {
    const { delegate, byName } = toolset();
    await byName.get("update_task")?.execute("u1", {
      task: "SCR-3",
      title: "Renamed",
      parent: "",
      project: "NIA",
      start_policy: "on-request",
    });
    expect(delegate.update).toHaveBeenCalledWith({
      task: "SCR-3",
      title: "Renamed",
      parent: "",
      project: "NIA",
      startPolicy: "on-request",
    });
    await byName.get("update_task")?.execute("u2", {
      task: "SCR-3",
      drop: true,
      reason: "changed course",
      confirm: true,
    });
    expect(delegate.drop).toHaveBeenCalledWith({
      task: "SCR-3",
      reason: "changed course",
      confirm: true,
    });
    await expect(
      byName.get("update_task")?.execute("u3", { task: "SCR-3", drop: true }),
    ).rejects.toThrow(/reason is required/);
  });

  it("update_task withdraw_merge takes back the captain's kept merge and edits nothing else (FI3-304)", async () => {
    const { delegate, byName } = toolset();
    const result = await byName.get("update_task")?.execute("w1", {
      task: "SCR-3",
      withdraw_merge: true,
    });
    expect(result?.content[0]?.text).toBe("Withdrew the captain's kept merge approval on SCR-3.");
    expect(delegate.withdrawMerge).toHaveBeenCalledWith({ task: "SCR-3" });
    expect(delegate.update).not.toHaveBeenCalled();
    expect(delegate.drop).not.toHaveBeenCalled();
  });

  it("update_task start_now starts a queued row now, and only that (cards/tasks/agents P0)", async () => {
    const { delegate, byName } = toolset();
    const result = await byName.get("update_task")?.execute("s1", {
      task: "SCR-3",
      start_now: true,
    });
    expect(delegate.startNow).toHaveBeenCalledWith({ task: "SCR-3" });
    expect(delegate.update).not.toHaveBeenCalled();
    expect(result?.content[0]?.text).toBe('Started SCR-3 "Fix meter".');
    // A refusal is result text, never a throw.
    vi.mocked(delegate.startNow).mockResolvedValueOnce(
      "Cannot start SCR-3 now: it waits on SCR-1.",
    );
    const refused = await byName.get("update_task")?.execute("s2", {
      task: "SCR-3",
      start_now: true,
    });
    expect(refused?.content[0]?.text).toContain("Cannot start SCR-3 now");
  });

  it("applies combined edits before dispatch and serves the amended scope", async () => {
    let goal = "Original scope";
    const served: string[] = [];
    const { byName } = toolset({
      update: vi.fn((input) => {
        goal = input.goal ?? goal;
        return { text: "Updated SCR-3", ok: true };
      }),
      startNow: vi.fn(async () => {
        served.push(renderIntentBrief({ goal, userWords: "build it" }, "direct-pr"));
        return "Started SCR-3";
      }),
    });
    await byName.get("update_task")?.execute("combined", {
      task: "SCR-3",
      start_now: true,
      goal: "Replacement-only shell-height interpolation",
    });
    expect(served[0]).toContain("Goal: Replacement-only shell-height interpolation");
    expect(served[0]).not.toContain("Original scope");
  });

  it("names the user's model on the filed row before starting it, in one call (FI3-436)", async () => {
    const order: string[] = [];
    const { delegate, byName } = toolset({
      update: vi.fn((input) => {
        order.push(`update ${input.model}`);
        return { text: "Updated SCR-3: model claude-fable-5-1.", ok: true };
      }),
      startNow: vi.fn(async () => {
        order.push("start");
        return 'Started SCR-3 "Fix meter" on anthropic-claude/claude-fable-5-1.';
      }),
    });
    const result = await byName.get("update_task")?.execute("named", {
      task: "SCR-3",
      override_model_id: "claude-fable-5-1",
      start_now: true,
    });
    expect(delegate.update).toHaveBeenCalledWith({ task: "SCR-3", model: "claude-fable-5-1" });
    expect(order).toEqual(["update claude-fable-5-1", "start"]);
    expect(result?.content[0]?.text).toBe(
      'Updated SCR-3: model claude-fable-5-1.\nStarted SCR-3 "Fix meter" on anthropic-claude/claude-fable-5-1.',
    );
    // Empty clears it, and naming alone starts nothing.
    await byName.get("update_task")?.execute("cleared", { task: "SCR-3", override_model_id: "" });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", model: "" });
    expect(delegate.startNow).toHaveBeenCalledTimes(1);
  });

  it("names the user's reasoning effort on the filed row before starting it, in one call (FI3-1812)", async () => {
    const order: string[] = [];
    const { delegate, byName } = toolset({
      update: vi.fn((input) => {
        order.push(`update ${input.reasoning}`);
        return { text: "Updated SCR-3: reasoning high.", ok: true };
      }),
      startNow: vi.fn(async () => {
        order.push("start");
        return 'Started SCR-3 "Fix meter".';
      }),
    });
    await byName.get("update_task")?.execute("named", {
      task: "SCR-3",
      reasoning: "high",
      start_now: true,
    });
    expect(delegate.update).toHaveBeenCalledWith({ task: "SCR-3", reasoning: "high" });
    expect(order).toEqual(["update high", "start"]);
    // Null follows Models again, and naming alone starts nothing.
    await byName.get("update_task")?.execute("cleared", { task: "SCR-3", reasoning: null });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", reasoning: null });
    expect(delegate.startNow).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when a combined edit is refused", async () => {
    const { delegate, byName } = toolset({
      update: vi.fn(() => ({ text: "Cannot move started work", ok: false })),
    });
    const result = await byName
      .get("update_task")
      ?.execute("refused-edit", { task: "SCR-3", start_now: true, project: "OTHER" });
    expect(result?.content[0]?.text).toBe("Cannot move started work");
    expect(delegate.startNow).not.toHaveBeenCalled();
  });

  it("link_tasks passes the edge and remove; a refusal is result text", async () => {
    const { delegate, byName } = toolset({ link: vi.fn(() => "Refused: would close a cycle") });
    const result = await byName.get("link_tasks")?.execute("l1", {
      from: "SCR-3",
      to: "SCR-1",
      type: "blocks",
      remove: true,
    });
    expect(delegate.link).toHaveBeenCalledWith({
      from: "SCR-3",
      to: "SCR-1",
      type: "blocks",
      remove: true,
    });
    expect(result?.content[0]?.text).toBe("Refused: would close a cycle");
  });

  it("tasks renders the query rows and says so when nothing matches", async () => {
    const { delegate, byName } = toolset({
      query: vi.fn((input) =>
        input.text === "meter"
          ? {
              rows: [
                {
                  key: "SCR-3",
                  task_id: "ab12cd34",
                  kind: "work",
                  status: "open",
                  title: "Fix the meter",
                  project: "SCR",
                  priority: 2,
                  updated_at: "2026-09-09T00:00:00.000Z",
                },
              ],
              total: 1,
            }
          : { rows: [], total: 0 },
      ),
    });
    const hit = await byName.get("tasks")?.execute("q1", { text: "meter", status: "live" });
    expect(delegate.query).toHaveBeenCalledWith({ text: "meter", status: "live" });
    expect(hit?.content[0]?.text).toContain("1 of 1 matching task:");
    expect(hit?.content[0]?.text).toContain('"key": "SCR-3"');
    const miss = await byName.get("tasks")?.execute("q2", {});
    expect(miss?.content[0]?.text).toBe("No tasks match.");
  });
});

describe("update_task policies", () => {
  it("passes explicit false, translates resets and preserves omitted policies without starting", async () => {
    const { delegate, byName } = toolset();
    await byName
      .get("update_task")
      ?.execute("policies", { task: "SCR-3", autonomy: "off", rigor: "reviewed" });
    expect(delegate.update).toHaveBeenLastCalledWith({
      task: "SCR-3",
      policies: { autonomy: false, rigor: "reviewed" },
    });
    await byName.get("update_task")?.execute("reset", {
      task: "SCR-3",
      delivery: "project",
      autonomy: "project",
      rigor: "project",
    });
    expect(delegate.update).toHaveBeenLastCalledWith({
      task: "SCR-3",
      policies: { delivery: null, autonomy: null, rigor: null },
    });
    expect(delegate.startNow).not.toHaveBeenCalled();
  });
});

describe("update_task runs_on", () => {
  it("passes the computer the captain named, and project as a reset, without starting", async () => {
    const { delegate, byName } = toolset();
    await byName.get("update_task")?.execute("named", { task: "SCR-3", runs_on: "mini-id" });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", runsOn: "mini-id" });
    await byName.get("update_task")?.execute("here", { task: "SCR-3", runs_on: "this-mac" });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", runsOn: "this-mac" });
    await byName.get("update_task")?.execute("reset", { task: "SCR-3", runs_on: "project" });
    expect(delegate.update).toHaveBeenLastCalledWith({ task: "SCR-3", runsOn: null });
    expect(delegate.startNow).not.toHaveBeenCalled();
  });
});

// INF-416 piece K (T4): a long by-key read pages by field and offset.
// The retired $ref / $text format must not return, and a distinct closing card stays whole.
it.each([false, true])(
  "pages a long accepted plan and keeps a distinct closing card (revised=%s)",
  (revised) => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf64.json", "utf8"));
    const db = openInMemoryDatabase();
    try {
      const tasks = new TaskService({ db });
      const cards = new CardStore(db);
      const task = tasks.create({
        id: "plan",
        title: fixture.taskTitle,
        prompt: fixture.userWords,
        repoId: null,
      });
      tasks.recordReport(task.id, { text: fixture.report });
      tasks.recordReport(task.id, { text: fixture.report });
      const card = {
        id: "card-plan",
        taskId: task.id,
        author: "crewmate",
        priority: 1,
        title: fixture.title,
        meta: "",
        body: fixture.body,
        actions: fixture.actions,
        status: "ready",
        createdAt: 1000,
      } as const;
      cards.upsert(card);
      cards.resolve("card-plan", "start-next", fixture.answers);
      if (revised) {
        tasks.recordReport(task.id, { text: "Finished." });
        cards.upsert({
          ...card,
          id: "card-later",
          createdAt: 2000,
          body: fixture.body + "<!-- current revision -->",
        });
      }
      const result = queryTasks(
        tasks,
        { key: task.key },
        () => undefined,
        (id) => cards.newestForTask(id)?.body,
        (id) => cards.resolvedSince(0, 1, () => true, id)[0],
      );
      const original = structuredClone(result.rows);
      const text = renderTasksQueryResult(result);
      expect(text).not.toContain("$ref");
      expect(text).not.toContain("$text");
      const reads = [text];
      for (const omitted of parseTasksQueryText(text).omitted) {
        let offset = 1;
        while (offset) {
          const page = renderTasksFieldPage(result.rows[0]!, omitted.field, offset);
          expect(page.length).toBeLessThanOrEqual(TASK_QUERY_PAGE_CHARACTERS);
          expect(Buffer.byteLength(page)).toBeLessThanOrEqual(TASK_QUERY_PAGE_CHARACTERS);
          reads.push(page);
          const next = page.match(/nextOffset (\d+|none)/)?.[1];
          offset = next && next !== "none" ? Number(next) : 0;
        }
      }
      const row = assembleTasksReads(reads)[0]!;
      expect(row).toEqual(original[0]);
      expect(result.rows).toEqual(original);
      expect(row.card).toBe(revised ? fixture.body + "<!-- current revision -->" : fixture.body);
      expect(taskResolutionBody(row, "card")).toBe(fixture.body);
      expect(row.reports).toHaveLength(original[0]!.reports!.length);
      expect(queryTasks(tasks, {}).rows).not.toHaveProperty("0.card");
    } finally {
      db.close();
    }
  },
);

// INF-416 piece K: the production INF-91 row is larger than one page. Paging keeps the
// report, answers and offer, and INF-133's 100,000-token cap stays the outer limit.
it("pages the large design record without losing the report, answers or offer", async () => {
  expect(TASK_QUERY_PAGE_CHARACTERS).toBe(CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS);
  const rows = JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8"));
  const original = structuredClone(rows);
  const tool = createTasksQueryTool(() => ({ rows, total: 1 }));
  const first = await tool.run({ key: "182c1d82" });
  expect(first.text.length).toBeLessThanOrEqual(TASK_QUERY_PAGE_CHARACTERS);
  expect(first.text).not.toContain("$ref");
  expect(first.text).not.toContain("$text");
  const reads = [first.text];
  for (const omitted of parseTasksQueryText(first.text).omitted) {
    reads.push(...(await pageTaskField((args) => tool.run(args), "182c1d82", omitted.field)));
  }
  expect(readPagedTaskQuery(reads)).toEqual(original);
  expect(rows).toEqual(original);
  const row = readPagedTaskQuery(reads)[0]!;
  expect(row.outcome).toBe(original[0].outcome);
  expect(row.resolution?.offer?.body).toBe(original[0].resolution.offer.body);
  expect(row.resolution?.answers).toEqual(original[0].resolution.answers);
  expect((await tool.run({ field: "outcome", offset: 1 })).text).toBe(
    "field and offset apply only with a key.",
  );
  expect((await tool.run({ key: "182c1d82", offset: 1 })).text).toBe(
    "offset applies only with a field.",
  );
});

// INF-133 F2: captain chose byte-for-byte compatibility for every read that already fits.
it("leaves fitting reads byte for byte as before, including repeated report text", () => {
  const db = openInMemoryDatabase();
  try {
    const tasks = new TaskService({ db });
    const task = tasks.create({
      id: "welcome",
      title: "Immediate welcome",
      prompt: "Finish the welcome plan.",
      repoId: null,
    });
    tasks.recordReport(task.id, {
      text: readFileSync("tests/fixtures/approval-handoff/welcome-spec.md", "utf8"),
    });
    const result = queryTasks(tasks, { key: task.key }, () => undefined);
    const original = `1 of 1 matching task:\n${JSON.stringify(result.rows, null, 2)}`;
    expect(original.length).toBeLessThan(CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS);
    expect(renderTasksQueryResult(result)).toBe(original);
  } finally {
    db.close();
  }
});

// INF-1217, direction A: a crewmate asks for project folders instead of
// searching the whole disk for one, which made macOS ask about other apps' data.
it("answers project folders, and where they are, when a crewmate asks for projects", async () => {
  const asked: unknown[] = [];
  const tool = bindTool(TASKS_QUERY_TOOL, {
    onQueryTasks: (input) => {
      asked.push(input);
      return {
        rows: [],
        total: 0,
        projects: [{ key: "INF", name: "infinitary", folder: "/fleet/infinitary" }],
      };
    },
  });
  const text = (await tool.run({ projects: true })).text;
  expect(asked).toEqual([{ projects: true }]);
  expect(text).toContain(HOME.the);
  expect(text).toContain('"folder": "/fleet/infinitary"');
  expect(text).not.toBe("No tasks match.");
});
