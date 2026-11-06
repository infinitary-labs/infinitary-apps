import { execFileSync } from "node:child_process";
import { runsHereOnly } from "@shared/repos";
import { describe, expect, it, vi } from "vitest";
import { decodeContext, fakeClockEachTest, setup } from "../../../tests/helpers/firstmateHarness";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readTaskQueryText } from "../../../tests/helpers/taskQueryText";
import { toolsFingerprint } from "../pi/piResources";
import { piToolsOf } from "../pi/toolSpec";
import { FIRSTMATE_TOOLS } from "../session/tools";
import { CardStore } from "../storage/cardStore";
import { queueWaitOf } from "../tasks/queueWait";
import { queryTasks, taskResolutionBody } from "../tasks/taskQuery";
import { formatFlagshipError } from "./firstmateSeat";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: the served tool surface and the graph tools (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

describe("the Firstmate's served tool surface", () => {
  it("serves the Pi seat the whole tool set", async () => {
    const served = piToolsOf(await firstmateTools());
    expect(served.map((tool) => tool.name)).toEqual([
      "emit_card",
      "close_card",
      "emote",
      ...FIRSTMATE_TOOLS.slice(2).map((tool) => tool.name),
    ]);
  });

  it("stamps a fingerprint that moves with any tool's name, description or schema", async () => {
    // What the model is offered is contract text too (R2 provenance), so
    // the stamp's fingerprint changes whenever one word of it does - no
    // number to move by hand, and none for two changes to collide on.
    type Surface = { name: string; description: string; parameters: unknown }[];
    const served: Surface = piToolsOf(await firstmateTools()).map(
      ({ name, description, parameters }) => ({ name, description, parameters }),
    );
    const fingerprint = toolsFingerprint(served);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(toolsFingerprint(structuredClone(served))).toBe(fingerprint);
    const edited = (edit: (tool: Surface[number]) => void) => {
      const copy = structuredClone(served);
      const tool = copy.find((candidate) => candidate.name === "emote");
      if (!tool) throw new Error("emote is not served");
      edit(tool);
      return toolsFingerprint(copy);
    };
    expect(edited((tool) => (tool.name = "emote_again"))).not.toBe(fingerprint);
    expect(edited((tool) => (tool.description = `${tool.description} Always.`))).not.toBe(
      fingerprint,
    );
    expect(
      edited((tool) => {
        const parameters = tool.parameters as { properties: Record<string, unknown> };
        parameters.properties.extra = { type: "string" };
      }),
    ).not.toBe(fingerprint);
    expect(toolsFingerprint([...served].reverse())).not.toBe(fingerprint);
  });
});

describe("formatFlagshipError", () => {
  it("names the catalog provider and model id", () => {
    expect(
      formatFlagshipError(
        { provider: "xai", id: "grok-4.6" },
        "Response incomplete: max_time_limit",
      ),
    ).toBe("Grok grok-4.6: Response incomplete: max_time_limit");
    expect(
      formatFlagshipError(
        { provider: "xai", id: "grok-4.6" },
        "Error Code null: Internal error during token generation",
      ),
    ).toBe("Grok grok-4.6: Error Code null: Internal error during token generation");
  });

  it("does not double-prefix", () => {
    const labeled = "Grok grok-4.6: Response incomplete: max_time_limit";
    expect(formatFlagshipError({ provider: "xai", id: "grok-4.6" }, labeled)).toBe(labeled);
  });
});

describe("the graph tools at the Firstmate boundary (task-system P2)", () => {
  type GraphTool = {
    name: string;
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<{ content: { type: string; text?: string }[] }>;
  };

  it("stores what the Firstmate declares about a step at creation, and infers nothing", async () => {
    const { agent, specs, tasks } = setup();
    await agent.converse("fix the meter");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const tool = (name: string) => tools.find((entry) => entry.name === name) as GraphTool;
    const text = async (name: string, params: Record<string, unknown>) =>
      (await tool(name).execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    await text("create_task", {
      title: "Fix the meter",
      goal: "The meter keeps its reading",
      user_words: "fix the meter",
    });
    await text("create_task", {
      title: "Reproduce the meter reset",
      goal: "The reset is reproduced",
      user_words: "fix the meter",
      parent: "SCR-1",
      internal_step: true,
    });
    await text("create_task", {
      title: "Reproduce it again",
      goal: "The reset is reproduced",
      user_words: "fix the meter",
      parent: "SCR-1",
    });
    expect(tasks.byKey("SCR-2")?.shape?.internal_step).toBe(true);
    // Under the same parent, but not declared: the host does not guess.
    expect(tasks.byKey("SCR-3")?.shape?.internal_step).toBeUndefined();
  });

  it("executes separate grounding recovery and a reachable clarification/hold through native tools", async () => {
    const { agent, specs, tasks, supervisor, cards } = setup();
    await agent.converse("Implement the handoff correction");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return (await tool.execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    };
    await text("create_task", {
      title: "Requested change",
      goal: "Requested change works",
      user_words: "Implement the handoff correction",
    });
    await text("create_task", {
      title: "Read-only plan",
      goal: "A ready plan",
      user_words: "Implement the handoff correction",
      parent: "SCR-1",
    });
    const plan = tasks.byKey("SCR-2");
    if (!plan) throw new Error("missing plan");
    tasks.turns.recordReport(plan.id, {
      text: "The full ready specification is recorded; selections are authoritative.",
    });
    tasks.turns.recordReport(plan.id, {
      text: "Later evidence preserves the original accepted scope.",
    });
    await text("create_task", {
      title: "Existing implementation",
      goal: "Implement the accepted specification",
      user_words: "Implement the handoff correction",
      parent: "SCR-1",
    });
    const build = tasks.byKey("SCR-3");
    if (!build) throw new Error("missing builder");
    await expect(
      text("update_task", { task: build.key, basis: plan.key, start_now: true }),
    ).rejects.toThrow("separate start_now");
    expect(tasks.get(build.id)?.shape?.basis).toBeUndefined();
    expect(tasks.get(build.id)?.status).toBe("open");
    await expect(
      text("steer_crewmate", { task_id: build.id, message: "Ask a question" }),
    ).rejects.toThrow("no longer steerable");
    await text("emit_card", {
      id: "fm-motion-question",
      task_id: tasks.byKey("SCR-1")?.id,
      title: "Choose reduced-motion reveal",
      body: "<p>Reduced-motion reveal needs one choice.</p><p>Should it appear instantly or with a short opacity fade?</p>",
      actions: [
        { id: "instant", label: "Instant reveal", default: true },
        { id: "fade", label: "Short opacity fade" },
      ],
    });
    supervisor.cards.flushBroadcast();
    expect(cards()).toContainEqual(
      expect.objectContaining({
        taskId: tasks.byKey("SCR-1")?.id,
        title: "Choose reduced-motion reveal",
      }),
    );
    await text("create_task", {
      title: "Welcome prerequisite",
      goal: "Welcome merges",
      user_words: "Hold until welcome merges",
    });
    await text("link_tasks", { from: "SCR-4", to: "SCR-3", type: "blocks" });
    expect(tasks.graph.waitingOn(build.id).map((task) => task.key)).toEqual(["SCR-4"]);
    expect(tasks.get(build.id)?.startPolicy).toBe("on-request");
    const question = cards().find((card) => card.title === "Choose reduced-motion reveal");
    if (!question) throw new Error("missing question");
    supervisor.act(question.id, "instant");
    supervisor.cards.flushBroadcast();
    expect(cards().find((card) => card.id === question.id)).toBeUndefined();
    // This test explicitly removes its test hold before authorized recovery;
    // production must retain a captain's real hold until its prerequisite closes.
    await text("link_tasks", { from: "SCR-4", to: "SCR-3", type: "blocks", remove: true });
    expect(await text("update_task", { task: "SCR-3", basis: "SCR-2" })).toContain("basis SCR-2");
    expect(tasks.get(build.id)?.shape?.basis).toBe("SCR-2");
    const amendedGoal = "Implement the full accepted specification and its amendment";
    expect(
      await text("update_task", { task: "SCR-3", goal: amendedGoal, start_now: true }),
    ).toContain("Started");
    expect(tasks.get(build.id)?.intent?.goal).toBe(amendedGoal);
    const read = await text("tasks", { key: "SCR-3" });
    const receipt = JSON.parse(read.slice(read.indexOf("[")))[0];
    expect(receipt.brief).toContain(`Goal: ${amendedGoal}`);
    expect(receipt.brief).toContain("The full ready specification is recorded");
    expect(receipt.brief).toContain("Later evidence preserves the original accepted scope");
    expect(tasks.get(build.id)?.status).toBe("active");
    expect(tasks.list().filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("starts dropped work again through update_task and returns its new key without a second replacement", async () => {
    const { agent, specs, tasks } = setup({
      seedTasks: [{ id: "old-draft", title: "Finish the draft", status: "cancelled" }],
    });
    await agent.converse("start the dropped draft again");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const update = tools.find((tool) => tool.name === "update_task");
    if (!update) throw new Error("missing update_task");
    const answer = await update.execute(
      "again",
      { task: "old-draft", start_again: true },
      undefined,
      undefined,
      {},
    );
    const replacement = tasks.graph.replacementOf("old-draft");
    expect(replacement).toBeTruthy();
    expect(answer.content[0]?.text).toContain(`${replacement} replaces`);
    expect(tasks.resolve(replacement ?? "")?.status).toBe("active");
    expect(tasks.get("old-draft")?.status).toBe("dropped");
    const seq = tasks.boardSeq();
    const refused = await update.execute(
      "duplicate",
      { task: "old-draft", start_again: true },
      undefined,
      undefined,
      {},
    );
    expect(refused.content[0]?.text).toContain("already replaces");
    expect(tasks.boardSeq()).toBe(seq);
  });

  it("starts a filed task on the model the captain named through native tools, never a replacement (FI3-436)", async () => {
    const { agent, specs, tasks } = setup();
    await agent.converse("start FI3-431 with a fable crewmate");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return (await tool.execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    };
    await text("create_task", { title: "Onboarding", goal: "Onboarding", user_words: "onboard" });
    await text("create_task", {
      title: "Teach working colors",
      goal: "First run teaches the working and idle colors",
      user_words: "teach the colors during first run",
      parent: "SCR-1",
    });
    await text("create_task", { title: "Color audit", goal: "Audit", user_words: "audit" });
    await text("link_tasks", { from: "SCR-3", to: "SCR-2", type: "related" });
    const filed = tasks.byKey("SCR-2");
    if (!filed) throw new Error("missing filed task");
    const before = tasks.list().length;

    const answer = await text("update_task", {
      task: "SCR-2",
      override_model_id: "claude-fable-5-1",
      start_now: true,
    });
    expect(answer).toContain("Updated SCR-2: model claude-fable-5-1.");
    expect(answer).toContain('Started SCR-2 "Teach working colors"');
    expect(tasks.get(filed.id)).toMatchObject({
      key: "SCR-2",
      status: "active",
      parentId: tasks.byKey("SCR-1")?.id,
      shape: { override_model_id: "claude-fable-5-1" },
    });
    expect(tasks.graph.linksTo(filed.id)).toEqual([
      expect.objectContaining({ fromId: tasks.byKey("SCR-3")?.id, type: "related" }),
    ]);
    expect(tasks.list()).toHaveLength(before);
    // Once it is under way a named model moves it (INF-849); with automatic
    // model choice off here, the move is refused as text and nothing changes.
    expect(await text("update_task", { task: "SCR-2", override_model_id: "gpt-6-astra" })).toBe(
      "Automatic model choice is off, so the app cannot pick another model.",
    );
    expect(tasks.get(filed.id)?.shape?.override_model_id).toBe("claude-fable-5-1");
  });

  it("answers a spawn on a named model through native tools without confirming a model nothing recorded (FI3-444)", async () => {
    // This harness routes nothing and its crew sessions name no model, so
    // nothing confirms the one the captain named.
    const { agent, specs, tasks } = setup();
    await agent.converse("start the color lesson with a fable crewmate");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const spawn = tools.find((entry) => entry.name === "spawn_crewmate");
    if (!spawn) throw new Error("missing spawn_crewmate");
    const answer =
      (
        await spawn.execute(
          "c",
          {
            title: "Teach working colors",
            goal: "First run teaches the working and idle colors",
            user_words: "start the color lesson with a fable crewmate",
            shape: { override_model_id: "claude-fable-5-1" },
          },
          undefined,
          undefined,
          {},
        )
      ).content[0]?.text ?? "";
    const started = tasks.list().find((task) => task.title === "Teach working colors");
    expect(started).toMatchObject({ status: "active", model: null });
    expect(answer).toBe(
      `Commissioned crewmate 1 on task ${started?.id}; it runs with no model recorded, so claude-fable-5-1 is not confirmed.`,
    );
  });

  // INF-8: INF-3, moved from firstmate-3000's project into Infinitary's,
  // still worked in the old repository and would have opened its pull
  // request there.
  it("moves a planned task with update_task's project into that project's repository, where it starts", async () => {
    const { agent, specs, tasks, repos } = setup();
    const folder = (name: string, origin: string) => {
      const dir = scratchDir(`infinitary-move-${name}-`);
      execFileSync("git", ["init", "--initial-branch=main", dir], { stdio: "pipe" });
      execFileSync("git", ["-C", dir, "remote", "add", "origin", origin], { stdio: "pipe" });
      return dir;
    };
    const archive = await repos.setup({
      kind: "adopt",
      path: folder("archive", "https://github.com/infinitary-labs/firstmate-3000-archive.git"),
      name: "firstmate-3000-archive",
      key: "FI3",
    });
    const infinitary = await repos.setup({
      kind: "adopt",
      path: folder("infinitary", "https://github.com/infinitary-labs/infinitary.git"),
      name: "infinitary",
      key: "INF",
    });
    await agent.converse("open infinitary's first pull request");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return (await tool.execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    };
    await text("create_task", {
      title: "Open the first pull request",
      goal: "infinitary-labs/infinitary's first pull request passes every check",
      user_words: "open infinitary's first pull request",
      repo_id: archive.repo.id,
    });
    const step = tasks.byKey("FI3-1");
    expect(step?.repoId).toBe(archive.repo.id);
    // Where firstmate-3000-archive ran, as its Runs on placed the task before it started.
    tasks.placement.setDevice(step?.id as string, "mini-mac");

    expect(await text("update_task", { task: "FI3-1", project: "INF" })).toBe(
      "Updated INF-1: moved to infinitary as INF-1.",
    );
    const read = await text("tasks", { key: "INF-1" });
    expect(JSON.parse(read.slice(read.indexOf("[")))[0]).toMatchObject({
      project: "INF",
      repo: "infinitary",
    });
    // infinitary runs on this Mac, so the task goes there before it starts.
    expect(tasks.get(step?.id as string)?.deviceId ?? null).toBeNull();
    expect(await text("update_task", { task: "INF-1", start_now: true })).toContain("Started");
    expect(tasks.get(step?.id as string)).toMatchObject({
      status: "active",
      repoId: infinitary.repo.id,
      repoDir: infinitary.repo.path,
    });
  });

  // INF-61's F2: runs_on was judged in the project a task was leaving.
  it("judges where a task runs in the project the same update_task moves it to", async () => {
    const { agent, specs, tasks, repos } = setup();
    const notes = await repos.setup({ kind: "init", name: "notes", key: "NOTE" });
    const dir = scratchDir("infinitary-move-infinitary-");
    execFileSync("git", ["init", "--initial-branch=main", dir], { stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", dir, "remote", "add", "origin", "https://github.com/infinitary-labs/infinitary.git"],
      { stdio: "pipe" },
    );
    await repos.setup({ kind: "adopt", path: dir, name: "infinitary", key: "INF" });
    await agent.converse("write the release checklist and run it on this Mac");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return (await tool.execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    };
    await text("create_task", {
      title: "Write the release checklist",
      goal: "The release checklist is written",
      user_words: "write the release checklist",
      repo_id: notes.repo.id,
    });
    const id = tasks.byKey("NOTE-1")?.id as string;
    const keptHere = runsHereOnly(notes.repo) as string;
    expect(await text("update_task", { task: "NOTE-1", runs_on: "this-mac" })).toContain(keptHere);

    const moved = await text("update_task", {
      task: "NOTE-1",
      project: "INF",
      runs_on: "this-mac",
    });
    expect(moved).toMatch(/^Updated INF-1: moved to infinitary as INF-1, Runs on: /);
    expect(tasks.get(id)).toMatchObject({ key: "INF-1", shape: { runs_on_ask: "this-mac" } });

    // Back to a project that keeps its tasks here: refused there, and nothing moves.
    const before = tasks.get(id);
    expect(
      await text("update_task", { task: "INF-1", project: "NOTE", runs_on: "this-mac" }),
    ).toContain(keptHere);
    expect(tasks.get(id)).toEqual(before);
  });

  it("plans, edits, links and queries records, attaching the turn's ask to each task it acts on", async () => {
    const { agent, specs, tasks, supervisor, db } = setup();
    await agent.converse("plan the ADR, then the implementation behind it");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const tool = (name: string) => tools.find((entry) => entry.name === name) as GraphTool;
    const text = async (name: string, params: Record<string, unknown>) =>
      (await tool(name).execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";

    const planned = await text("create_task", {
      title: "Write the ADR",
      goal: "An ADR exists",
      user_words: "plan the ADR",
    });
    const adr = tasks.byKey("SCR-1");
    if (!adr) throw new Error("The planned ADR was not filed");
    // INF-1605: filing receipts use the same dated wait the first mate reads.
    const wait = queryTasks(tasks, { key: adr.id }, () => undefined).rows[0]?.waiting;
    expect(planned).toBe(`Planned ${adr.key} "Write the ADR" (task_id ${adr.id}) - ${wait}.`);
    expect(adr).toMatchObject({ status: "open", startPolicy: "on-request" });
    expect(tasks.capture.asksFor(adr?.id as string).map((ask) => ask.attachedVia)).toEqual([
      "tool:create_task",
    ]);
    // The same turn's second plan is about the same ask; it lands there too.
    await text("create_task", {
      title: "Implement the ADR",
      goal: "The ADR is implemented",
      user_words: "then the implementation behind it",
      parent: "SCR-1",
      blocked_by: ["scr-1"],
      start_policy: "when-ready",
    });
    const impl = tasks.byKey("SCR-2");
    expect(impl).toMatchObject({ parentId: adr?.id, startPolicy: "when-ready" });
    expect(tasks.graph.waitingOn(impl?.id as string).map((r) => r.key)).toEqual(["SCR-1"]);
    expect(tasks.timeline(impl?.id as string).filter((e) => e.kind === "ask")).toHaveLength(1);

    // Refusals are text the agent reads, never thrown tool errors.
    expect(await text("link_tasks", { from: "SCR-2", to: "SCR-1", type: "blocks" })).toMatch(
      /would close a cycle/,
    );
    expect(await text("update_task", { task: "SCR-1", parent: "SCR-2" })).toMatch(
      /already under SCR-1; making it the parent would close a cycle/,
    );
    expect(await text("update_task", { task: "SCR-1", drop: true, reason: "no" })).toMatch(
      /^Cannot close SCR-1 while its child is still open: SCR-2/,
    );
    expect(await text("update_task", { task: "SCR-1", title: "Write the ADR" })).toBe(
      "SCR-1 is unchanged.",
    );
    expect(await text("update_task", { task: "SCR-2", title: "Build it", priority: 0 })).toBe(
      'Updated SCR-2: title "Build it", priority 0.',
    );
    await expect(text("update_task", { task: "NOPE-1", title: "x" })).rejects.toThrow(
      /Unknown task "NOPE-1"/,
    );

    // The query side, with the derived flags.
    const rows = await text("tasks", { status: "open" });
    expect(rows).toContain("2 of 2 matching tasks:");
    expect(readTaskQueryText(rows).find((row) => row.key === impl?.key)?.waiting).toBe(
      queryTasks(tasks, { key: impl?.id }, () => undefined).rows[0]?.waiting,
    );
    expect(rows).toContain('"parent": "SCR-1"');
    expect(rows).toContain('"children": "1 open of 1"');
    expect(await text("tasks", { key: "SCR-2" })).toContain('"title": "Build it"');
    expect(await text("tasks", { project: "NOPE" })).toBe("No tasks match.");

    // Recovery through the real Firstmate tasks tool sees actual saved welcome
    // answers, even when the old report still calls them unresolved.
    const store = new CardStore(db);
    store.upsert({
      id: "card-welcome-recovery",
      taskId: adr?.id,
      author: "crewmate",
      priority: 1,
      title: "Welcome plan",
      meta: "",
      body: "Agreement records design only.",
      actions: [{ id: "agree", label: "Agree to this plan", default: true }],
      status: "ready",
      createdAt: 1,
    });
    const answers = [
      { name: "copy", values: ["orientation"], changed: true },
      { name: "race", values: ["skip"], changed: true },
    ];
    store.resolve("card-welcome-recovery", "agree", answers);
    tasks.turns.recordReport(adr?.id as string, { text: "Copy and race still unresolved." });
    const recovered = await text("tasks", { key: "SCR-1" });
    const recoveredRow = readTaskQueryText(recovered)[0]!;
    expect(recoveredRow.resolution).toMatchObject({ action: "agree", answers });
    expect(taskResolutionBody(recoveredRow, "card")).toBe("Agreement records design only.");
    expect(recoveredRow.outcome).toBe("Copy and race still unresolved.");
    expect(await text("tasks", { status: "open" })).not.toContain('"resolution"');
    expect(tasks.get(impl?.id as string)?.status).toBe("open");
    expect(await text("update_task", { task: "SCR-2", basis: "SCR-1" })).toContain("basis SCR-1");
    expect(tasks.get(impl?.id as string)?.shape?.basis).toBe("SCR-1");
    expect(await text("tasks", { key: "SCR-2" })).toContain('"basis": "SCR-1"');
    expect(await text("update_task", { task: "SCR-2", basis: "SCR-2" })).toContain("own basis");
    expect(await text("update_task", { task: "SCR-2", basis: "NOPE-1" })).toContain(
      "Unknown basis",
    );
    await expect(
      text("update_task", { task: "SCR-2", basis: "SCR-1", start_now: true }),
    ).rejects.toThrow("separate start_now");

    // Unstarted, both are the backlog's count (INF-1712); the tasks read
    // names the graph: the parent's open child, the child's blocker.
    const context = decodeContext(agent.buildContextBlock());
    expect(context.backlog?.projects).toEqual([
      expect.objectContaining({ project: "SCR", unstarted: 2 }),
    ]);
    expect(readTaskQueryText(await text("tasks", { key: "SCR-1" }))[0]).toMatchObject({
      children: "1 open of 1",
    });
    expect(readTaskQueryText(await text("tasks", { key: "SCR-2" }))[0]).toMatchObject({
      blocked_by: [expect.stringContaining("SCR-1")],
    });
    expect(supervisor.crewStatus().map((entry) => entry.gate)).toEqual(
      [adr, impl].map(
        (record) => queryTasks(tasks, { key: record?.id }, () => undefined).rows[0]?.waiting,
      ),
    );
  });

  // INF-416 piece I, captain's retype-test yes: a queued update adds a declared
  // prerequisite that is not linked yet. INF-143's omitted list stays refused.
  it("adds a declared prerequisite that is not linked yet and never removes one", async () => {
    const { agent, specs, tasks } = setup();
    await agent.converse(
      "file the ADR and its implementation; enable automatic work after linking",
    );
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) =>
      (
        await tools
          .find((tool) => tool.name === name)!
          .execute("c", params, undefined, undefined, {})
      ).content[0]?.text ?? "";
    for (const title of ["Write the ADR", "Implement the ADR"])
      await text("create_task", {
        title,
        goal: title,
        user_words: "file the ADR and its implementation",
      });
    const prerequisite = tasks.byKey("SCR-1")!;
    const piece = tasks.byKey("SCR-2")!;
    const before = tasks.get(piece.id);
    const eventsBefore = tasks.timeline(piece.id);
    expect(
      await text("update_task", {
        task: piece.key,
        start_policy: "when-ready",
        title: "Must not change",
      }),
    ).toContain("must declare blocked_by");
    expect(tasks.get(piece.id)).toEqual(before);
    expect(tasks.timeline(piece.id)).toEqual(eventsBefore);
    const added = await text("update_task", {
      task: piece.key,
      start_policy: "when-ready",
      blocked_by: [prerequisite.key],
      title: "Build it",
      start_now: true,
    });
    expect(added).toContain("waits for SCR-1");
    expect(added).toContain("Cannot start");
    expect(tasks.get(piece.id)).toMatchObject({
      status: "open",
      startPolicy: "when-ready",
      title: "Build it",
    });
    expect(tasks.graph.waitingOn(piece.id).map((row) => row.key)).toEqual(["SCR-1"]);
    // An empty declaration does not remove the link the update just added.
    expect(
      await text("update_task", {
        task: piece.key,
        blocked_by: [],
        goal: "The ADR is implemented",
      }),
    ).toMatch(/^Updated SCR-2: goal /);
    expect(tasks.graph.blockers(piece.id).map((row) => row.id)).toEqual([prerequisite.id]);
    // Ids and keys name the same prerequisite; duplicate references add nothing.
    expect(
      await text("update_task", {
        task: piece.key,
        blocked_by: [prerequisite.id, prerequisite.key.toLowerCase()],
      }),
    ).toBe("SCR-2 is unchanged.");
    expect(tasks.graph.blockers(piece.id).map((row) => row.id)).toEqual([prerequisite.id]);
    expect(
      await text("update_task", {
        task: prerequisite.key,
        blocked_by: [piece.key],
        title: "Must not cycle",
      }),
    ).toMatch(/would close a cycle/);
    expect(tasks.get(prerequisite.id)).toMatchObject({
      title: "Write the ADR",
      startPolicy: "on-request",
    });
    expect(tasks.graph.blockers(prerequisite.id)).toEqual([]);
    // Explicit independence keeps the existing automatic-start capability.
    expect(
      await text("update_task", {
        task: prerequisite.key,
        start_policy: "when-ready",
        blocked_by: [],
      }),
    ).toMatch(/^Updated SCR-1:/);
    expect(tasks.get(prerequisite.id)?.status).toBe("active");
    expect(tasks.get(piece.id)?.status).toBe("open");
  });

  // INF-2062: the captain asked that pausing a task moves it back to the backlog, never a steer to stay idle.
  it("moves started work back to the backlog with update_task start_policy on-request, and start_now picks it up", async () => {
    const { agent, specs, tasks, supervisor } = setup();
    await agent.converse("pause the color work");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const text = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return (await tool.execute("c", params, undefined, undefined, {})).content[0]?.text ?? "";
    };
    await text("create_task", { title: "Color audit", goal: "Audit", user_words: "audit" });
    expect(await text("update_task", { task: "SCR-1", start_now: true })).toContain(
      "Started SCR-1",
    );
    const started = tasks.byKey("SCR-1");
    if (started?.status !== "active") throw new Error("The task did not start");
    const moving = vi.spyOn(supervisor, "moveToBacklog");

    const answer = await text("update_task", {
      task: "SCR-1",
      start_policy: "on-request",
      reason: "The captain asked to pause it.",
    });
    expect(answer).toContain("back to the backlog");
    expect(moving).toHaveBeenCalledWith(
      started.id,
      { actor: "firstmate", via: "tool", decision: null },
      "The captain asked to pause it.",
    );
    expect(tasks.get(started.id)).toMatchObject({ status: "active" });
    expect(tasks.get(started.id)?.backlogSince).toEqual(expect.any(Number));
    expect(await text("update_task", { task: "SCR-1", start_policy: "on-request" })).toContain(
      "already waits in the backlog",
    );

    expect(await text("update_task", { task: "SCR-1", start_now: true })).toContain(
      'Started SCR-1 "Color audit" again from the backlog',
    );
    expect(tasks.get(started.id)?.backlogSince).toBeNull();
  });

  it("names the filed wait while an independent when-ready task starts immediately", async () => {
    const { agent, specs, tasks, supervisor } = setup();
    await agent.converse("fix the meter");
    const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as GraphTool[];
    const create = tools.find((entry) => entry.name === "create_task") as GraphTool;
    const filing = vi.spyOn(supervisor.intake, "plan");
    const planned = await create.execute(
      "c",
      {
        title: "Fix the meter",
        goal: "The meter keeps its reading",
        user_words: "fix the meter",
        // INF-143: this existing independent-work case now declares that it has no blockers.
        blocked_by: [],
        start_policy: "when-ready",
      },
      undefined,
      undefined,
      {},
    );
    const record = tasks.byKey("SCR-1");
    if (!record) throw new Error("The independent task was not filed");
    // The receipt describes filing, before the plan's immediate sweep starts work.
    const filed = filing.mock.results[0]?.value;
    if (!filed) throw new Error("The filing snapshot was not recorded");
    const wait = queueWaitOf(
      filed,
      tasks.graph.blockers(filed.id),
      tasks.graph.linksTo(filed.id),
    )?.line;
    expect(planned.content[0]?.text).toBe(
      `Planned ${record.key} "Fix the meter" (task_id ${record.id}) - ${wait}.`,
    );
    expect(record.status).toBe("active");
  });
});
