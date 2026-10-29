import { describe, expect, it, vi } from "vitest";
import {
  type CrewDelegate,
  closingSentenceMissing,
  createCrewTools,
  groupSpawnArgs,
} from "./crewTools";
import { piToolsOf } from "./toolSpec";

/**
 * The crew control plane: each tool routes into the delegate and every
 * failure surfaces as a thrown error (a loud tool error to the agent),
 * never a silent fallback.
 */

type AnyTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: { type: string; text: string }[];
  }>;
};

function toolset(overrides: Partial<CrewDelegate> = {}) {
  const delegate: CrewDelegate = {
    commission: vi.fn(async () => ({ taskId: "ab12cd34", crewmate: "crewmate 1" })),
    steerCrewmate: vi.fn(async () => "mid-turn" as const),
    interruptCrewmate: vi.fn(async () => {}),
    crewStatus: vi.fn(() => []),
    isCaptainTurn: vi.fn(() => true),
    settleTask: vi.fn(async () => ({ text: "settled" })),
    carryOnTask: vi.fn(async () => "carried"),
    ...overrides,
  };
  const tools = piToolsOf(createCrewTools(delegate)) as unknown as AnyTool[];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { delegate, byName };
}

describe("crew tools", () => {
  it("exposes exactly the closed set", () => {
    const { byName } = toolset();
    expect([...byName.keys()].sort()).toEqual([
      "crew_status",
      "interrupt_crewmate",
      "settle_task",
      "spawn_crewmate",
      "steer_crewmate",
    ]);
  });

  it("spawn carries the structured intent and returns the admission handle immediately", async () => {
    const { delegate, byName } = toolset();
    const result = await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix meter",
      goal: "The meter reads correctly and its test passes",
      user_words: "the meter is broken, fix it",
      repo_id: "r1",
      constraints: [
        { kind: "tests-required" },
        { kind: "free", text: "keep the public API stable" },
      ],
      delivery_note: "single commit",
      shape: { kind: "fix" },
    });
    expect(delegate.commission).toHaveBeenCalledWith({
      title: "Fix meter",
      intent: {
        goal: "The meter reads correctly and its test passes",
        userWords: "the meter is broken, fix it",
        constraints: [
          { kind: "tests-required" },
          { kind: "free", text: "keep the public API stable" },
        ],
        deliveryNote: "single commit",
      },
      repoId: "r1",
      shape: { kind: "fix" },
    });
    expect(result?.content[0]?.text).toBe("Commissioned crewmate 1 on task ab12cd34.");
  });

  it("carries a declared skip reason into the commission without judging it", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Rename label",
      goal: "The label says Close",
      user_words: "rename the label",
      shape: { skipped_plan_because: "One label; no rule changes; inspect the screen" },
    });
    expect(delegate.commission).toHaveBeenCalledWith({
      title: "Rename label",
      intent: { goal: "The label says Close", userWords: "rename the label" },
      shape: { skipped_plan_because: "One label; no rule changes; inspect the screen" },
    });
  });

  // Intent: INF-1177 piece 2, declared facts replace a lesson-only spawn path.
  it.each([true, false])(
    "carries ongoing %s and requested intelligence through the spawn adapter",
    async (ongoing) => {
      const { delegate, byName } = toolset();
      await byName.get("spawn_crewmate")?.execute("subject", {
        title: "Teach chess",
        goal: "Practise rook moves",
        user_words: "teach me chess",
        personal_ui: true,
        shape: { ongoing, intelligence: "high" },
      });
      expect(delegate.commission).toHaveBeenCalledWith(
        expect.objectContaining({ shape: { ongoing, intelligence: "high" } }),
      );
    },
  );

  it("spawn marks a personal-ui ask on the intent and leaves the binding to the host", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Tokyo clock",
      goal: "A Tokyo clock panel exists",
      user_words: "make me a tokyo clock panel",
      personal_ui: true,
    });
    expect(delegate.commission).toHaveBeenCalledWith({
      title: "Tokyo clock",
      intent: {
        goal: "A Tokyo clock panel exists",
        userWords: "make me a tokyo clock panel",
        kind: "personal-ui",
      },
    });
    // The flag off is no kind at all, not a kind of "false".
    await byName.get("spawn_crewmate")?.execute("t2", {
      title: "Fix meter",
      goal: "g",
      user_words: "w",
      personal_ui: false,
    });
    expect(delegate.commission).toHaveBeenLastCalledWith({
      title: "Fix meter",
      intent: { goal: "g", userWords: "w" },
    });
  });

  it("carries the work shape's facts through, premium ask included (v2.8)", async () => {
    // The Firstmate reports facts; the host computes the tier from them.
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Redesign the dock",
      goal: "The dock layout is settled",
      user_words: "use premium for this, the dock layout is a mess",
      shape: { premium_ask: true, basis: "FM3K-12" },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ shape: { premium_ask: true, basis: "FM3K-12" } }),
    );
  });

  it("carries the first mate's declaration that the work is on the project's folder (INF-567)", async () => {
    // The captain's approved plan: the first mate declares folder work by its own judgment.
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Bring the business folder up to date",
      goal: "The business folder is clean, on main and at origin's main",
      user_words: "bring the business folder up to date",
      repo_id: "r1",
      shape: { in_folder: true },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "r1", shape: { in_folder: true } }),
    );
  });

  it("carries a task-level delivery ask through, without touching the repo", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix the meter",
      goal: "The meter test passes",
      user_words: "fix it but don't open a PR, land it locally",
      repo_id: "r1",
      shape: { delivery_ask: "local-only" },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: "r1",
        shape: { delivery_ask: "local-only" },
      }),
    );
  });

  it("carries a task-level autonomy ask through, in both directions", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix the meter",
      goal: "The meter test passes",
      user_words: "merge it yourself when it's green",
      repo_id: "r1",
      shape: { autonomy_ask: true },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "r1", shape: { autonomy_ask: true } }),
    );

    // `false` is an ask too - "ask me before merging this one" on an
    // autonomous repository - so it must reach the shape, not be dropped
    // as a falsy value the way an omitted flag is.
    await byName.get("spawn_crewmate")?.execute("t2", {
      title: "Fix the meter",
      goal: "The meter test passes",
      user_words: "ask me before merging this one",
      repo_id: "r1",
      shape: { autonomy_ask: false },
    });
    expect(delegate.commission).toHaveBeenLastCalledWith(
      expect.objectContaining({ shape: { autonomy_ask: false } }),
    );
  });

  it("carries the computer the captain named for this task through, trimmed", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix the meter",
      goal: "The meter test passes",
      user_words: "run this one on the mini",
      repo_id: "r1",
      shape: { runs_on_ask: " mini-id " },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "r1", shape: { runs_on_ask: "mini-id" } }),
    );
  });

  it("carries an exact model override through", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Redesign the dock",
      goal: "The dock layout is settled",
      user_words: "use gpt-6-astra for this",
      shape: { override_model_id: "gpt-6-astra" },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ shape: { override_model_id: "gpt-6-astra" } }),
    );
  });

  it("carries the reasoning effort the user named for the work through (FI3-1812)", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Redesign the dock",
      goal: "The dock layout is settled",
      user_words: "run this one at extra high reasoning",
      shape: { override_reasoning: "xhigh" },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ shape: { override_reasoning: "xhigh" } }),
    );
  });

  it("answers with the model that took the work when the user named one (FI3-444)", async () => {
    const spawn = async (model: { named: string; took: string | null }) => {
      const { byName } = toolset({
        commission: vi.fn(async () => ({ taskId: "ab12cd34", crewmate: "crewmate 1", model })),
      });
      const result = await byName.get("spawn_crewmate")?.execute("t1", {
        title: "Teach the colors",
        goal: "First run teaches the working and idle colors",
        user_words: "start it with a fable crewmate",
        shape: { override_model_id: model.named },
      });
      return result?.content[0]?.text;
    };
    expect(
      await spawn({ named: "claude-fable-5-1", took: "anthropic-claude/claude-fable-5-1" }),
    ).toBe(
      "Commissioned crewmate 1 on task ab12cd34; it runs on anthropic-claude/claude-fable-5-1.",
    );
    // Routing fell back: the answer never lets the named model stand alone.
    expect(await spawn({ named: "claude-fable-5-1", took: "openai-codex/gpt-6-astra" })).toBe(
      "Commissioned crewmate 1 on task ab12cd34; it runs on openai-codex/gpt-6-astra: claude-fable-5-1 was not available.",
    );
    expect(await spawn({ named: "claude-fable-5-1", took: null })).toBe(
      "Commissioned crewmate 1 on task ab12cd34; it runs with no model recorded, so claude-fable-5-1 is not confirmed.",
    );
  });

  it("says a queued spawn's model is known only once it starts, when the user named one", async () => {
    const { byName } = toolset({
      commission: vi.fn(async () => ({ taskId: "ab12cd34", crewmate: "queued" })),
    });
    const spawn = async (shape?: Record<string, unknown>) =>
      (
        await byName.get("spawn_crewmate")?.execute("t1", {
          title: "Teach the colors",
          goal: "First run teaches the working and idle colors",
          user_words: "after the audit, on fable",
          blocked_by: ["FI3-430"],
          ...(shape ? { shape } : {}),
        })
      )?.content[0]?.text;
    expect(await spawn({ override_model_id: "claude-fable-5-1" })).toBe(
      "Queued task ab12cd34; it starts when its wait ends and you will hear about it as [fm-op] messages. Which model takes it is known only once it starts.",
    );
    expect(await spawn()).toBe(
      "Queued task ab12cd34; it starts when its wait ends and you will hear about it as [fm-op] messages.",
    );
  });

  it("carries an escalation through on a captain turn (S4)", async () => {
    const { delegate, byName } = toolset();
    const result = await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix the meter test",
      goal: "The meter test is really fixed",
      user_words: "that is not a fix, try again with something smarter",
      shape: { escalate_from: "FM3K-12" },
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.objectContaining({ shape: { escalate_from: "FM3K-12" } }),
    );
    expect(result?.content[0]?.text).toContain("Commissioned");
  });

  it("refuses escalate_from on a turn that is not the captain's (Q2)", async () => {
    // Nothing climbs a tier without a human saying so, and the refusal
    // stops the whole spawn: quietly starting a duplicate at the tier that
    // already failed would be the worst of both.
    const { delegate, byName } = toolset({ isCaptainTurn: vi.fn(() => false) });
    const result = await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Fix the meter test",
      goal: "The meter test is really fixed",
      user_words: "[fm-op] crewmate 2 reported: I am blocked on this",
      shape: { escalate_from: "FM3K-12" },
    });
    expect(delegate.commission).not.toHaveBeenCalled();
    expect(result?.content[0]?.text).toContain("Nothing was spawned");
    // The ways out are structured data the Firstmate carries as the card's
    // actions (contract v3.6, captain lock 3), not a recipe in the prose.
    expect(result?.content[0]?.text).toContain('"held": "escalation-needs-captain"');
    expect(result?.content[0]?.text).toContain('"label": "Try a premium model"');
    expect(result?.content[0]?.text).toContain('"premium_ask": true');
    expect(result?.content[0]?.text).not.toContain("one decision card whose default");
  });

  it("keeps a single stronger-model refusal way when premium quota is exhausted", async () => {
    const { byName } = toolset({
      isCaptainTurn: vi.fn(() => false),
      escalationEligible: vi.fn(() => true),
      premiumCanServe: vi.fn(() => false),
    });
    const result = await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Blocked attempt",
      goal: "Fixed",
      user_words: "I am blocked",
      shape: { escalate_from: "FM3K-12" },
    });
    expect(result?.content[0]?.text).toContain('"label": "Try a stronger model"');
    expect(result?.content[0]?.text).not.toContain('"label": "Try a premium model"');
    expect(result?.content[0]?.text).not.toContain('"premium_ask"');
  });

  it("omits both model refusal ways when the rejected lineage has no rung left", async () => {
    const { byName } = toolset({
      isCaptainTurn: vi.fn(() => false),
      escalationEligible: vi.fn(() => false),
    });
    const result = await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Blocked attempt",
      goal: "Fixed",
      user_words: "I am blocked",
      shape: { escalate_from: "FM3K-12" },
    });
    expect(result?.content[0]?.text).not.toContain("Try a premium model");
    expect(result?.content[0]?.text).toContain("Retry with the captain's guidance");
  });

  it("passes no shape at all when the spawn carries none of its facts", async () => {
    // Absent is absent: an empty shape would read as "the captain said
    // nothing about any of this", which is exactly what undefined means.
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Notes",
      goal: "A summary exists",
      user_words: "summarize",
    });
    expect(delegate.commission).toHaveBeenCalledWith(
      expect.not.objectContaining({ shape: expect.anything() }),
    );
  });

  it("spawn validates the intent loudly at the tool boundary", async () => {
    const { delegate, byName } = toolset();
    await expect(
      byName.get("spawn_crewmate")?.execute("t1", { title: "x", goal: " ", user_words: "y" }),
    ).rejects.toThrow(/goal is required/);
    await expect(
      byName.get("spawn_crewmate")?.execute("t1", { title: "x", goal: "g", user_words: " " }),
    ).rejects.toThrow(/user_words is required/);
    await expect(
      byName.get("spawn_crewmate")?.execute("t1", {
        title: "x",
        goal: "g",
        user_words: "y",
        constraints: [{ kind: "free" }],
      }),
    ).rejects.toThrow(/needs its text/);
    expect(delegate.commission).not.toHaveBeenCalled();
  });

  it("steer routes the data plane and surfaces finished-task errors", async () => {
    const { delegate, byName } = toolset();
    await byName.get("steer_crewmate")?.execute("t1", { task_id: "ab12", message: "go blue" });
    expect(delegate.steerCrewmate).toHaveBeenCalledWith("ab12", "go blue");

    const failing = toolset({
      steerCrewmate: vi.fn(async () => {
        throw new Error("Task ab12 is completed and no longer steerable.");
      }),
    });
    await expect(
      failing.byName.get("steer_crewmate")?.execute("t1", { task_id: "ab12", message: "x" }),
    ).rejects.toThrow(/no longer steerable/);
  });

  it("steer hands another task's reported files on before the guidance, and refuses when that fails (INF-992)", async () => {
    // INF-992 direction B: "a second task can hand files to the waiting task".
    const handFiles = vi.fn(
      async () => "Files handed to you from INF-1: /t/temp/handover/a.pdf (2 KB).",
    );
    const { delegate, byName } = toolset({ handFiles });
    await byName.get("steer_crewmate")?.execute("t1", {
      task_id: "ab12",
      message: "Use the W-9 from INF-1.",
      files_from: "INF-1",
    });
    expect(handFiles).toHaveBeenCalledWith("INF-1", "ab12");
    expect(delegate.steerCrewmate).toHaveBeenCalledWith(
      "ab12",
      "Use the W-9 from INF-1.\n\nFiles handed to you from INF-1: /t/temp/handover/a.pdf (2 KB).",
    );
    const refused = toolset({
      handFiles: vi.fn(async () => {
        throw new Error("INF-1 has no reported files to hand on.");
      }),
    });
    await expect(
      refused.byName.get("steer_crewmate")?.execute("t1", {
        task_id: "ab12",
        message: "x",
        files_from: "INF-1",
      }),
    ).rejects.toThrow(/no reported files/);
    expect(refused.delegate.steerCrewmate).not.toHaveBeenCalled();
  });

  it("steer says a message queued behind in-flight handling is recorded, not lost", async () => {
    const { byName } = toolset({ steerCrewmate: vi.fn(async () => "recorded-queued" as const) });
    const result = await byName
      .get("steer_crewmate")
      ?.execute("t1", { task_id: "ab12", message: "change course" });
    const text = JSON.stringify(result?.content ?? []);
    expect(text).toContain("durably queued");
    expect(text).toContain("Do not resend");
    expect(text).not.toMatch(/try again|supervision/i);
  });

  it("interrupt carries the lifecycle mode", async () => {
    const { delegate, byName } = toolset();
    await byName.get("interrupt_crewmate")?.execute("t1", { task_id: "ab12", mode: "interrupt" });
    expect(delegate.interruptCrewmate).toHaveBeenCalledWith("ab12", "interrupt");
    await byName.get("interrupt_crewmate")?.execute("t1", {
      task_id: "ab12",
      mode: "cancel",
      closing_sentence: "The captain no longer needs the meter fix.",
    });
    expect(delegate.interruptCrewmate).toHaveBeenCalledWith(
      "ab12",
      "cancel",
      "The captain no longer needs the meter fix.",
    );
  });

  // INF-547: a close of started work the captain did not click carries the
  // first mate's one sentence, so it is refused without one.
  it("refuses a cancel or a settle that closes work without its sentence", async () => {
    const { delegate, byName } = toolset();
    const cancel = await byName
      .get("interrupt_crewmate")
      ?.execute("t1", { task_id: "ab12", mode: "cancel", closing_sentence: "  " });
    expect(cancel?.content[0]?.text).toBe(closingSentenceMissing("cancel"));
    expect(delegate.interruptCrewmate).not.toHaveBeenCalled();
    for (const mode of ["merge-pr", "land", "discard", "released", "finished"] as const) {
      const settled = await byName.get("settle_task")?.execute("t1", { task_id: "ab12", mode });
      expect(settled?.content[0]?.text).toBe(closingSentenceMissing(mode));
    }
    expect(delegate.settleTask).not.toHaveBeenCalled();
    await byName.get("settle_task")?.execute("t1", { task_id: "ab12", mode: "answered" });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "answered",
      undefined,
      undefined,
      undefined,
    );
  });

  it("settle_task routes PR merge, local land, and discard", async () => {
    const { delegate, byName } = toolset();
    const sentence = "The meter fix is merged.";
    await byName
      .get("settle_task")
      ?.execute("t0", { task_id: "ab12", mode: "merge-pr", closing_sentence: sentence });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "merge-pr",
      undefined,
      undefined,
      undefined,
      sentence,
    );

    const landed = await byName
      .get("settle_task")
      ?.execute("t1", { task_id: "ab12", mode: "land", closing_sentence: sentence });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "land",
      undefined,
      undefined,
      undefined,
      sentence,
    );
    expect(landed?.content[0]?.text).toBe("settled");

    await byName.get("settle_task")?.execute("t1", {
      task_id: "ab12",
      mode: "discard",
      confirm: true,
      closing_sentence: sentence,
    });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "discard",
      true,
      undefined,
      undefined,
      sentence,
    );

    await byName.get("settle_task")?.execute("t1", {
      task_id: "ab12",
      mode: "merge-pr",
      proceed_with_open: true,
      closing_sentence: sentence,
    });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "merge-pr",
      undefined,
      true,
      undefined,
      sentence,
    );

    await byName.get("settle_task")?.execute("t2", {
      task_id: "ab12",
      mode: "released",
      release_evidence: "v1.2.3 published and verified",
      closing_sentence: sentence,
    });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "released",
      undefined,
      undefined,
      "v1.2.3 published and verified",
      sentence,
    );
  });

  // INF-1825: work another task carries on closes through carried_by, with no closing sentence required.
  it("settle_task carried_on names the task carrying the work, and asks for one when it is missing", async () => {
    const { delegate, byName } = toolset();
    const missing = await byName
      .get("settle_task")
      ?.execute("t1", { task_id: "ab12", mode: "carried_on" });
    expect(missing?.content[0]?.text).toContain("carried_on needs carried_by");
    expect(delegate.carryOnTask).not.toHaveBeenCalled();

    const carried = await byName
      .get("settle_task")
      ?.execute("t1", { task_id: "ab12", mode: "carried_on", carried_by: " INF-1737 " });
    expect(delegate.carryOnTask).toHaveBeenCalledWith("ab12", "INF-1737", undefined);
    expect(carried?.content[0]?.text).toBe("carried");
    expect(delegate.settleTask).not.toHaveBeenCalled();
  });

  // INF-1279: success in a project folder reaches the task owner with its own evidence.
  it("routes finished folder work with completion evidence, never release evidence", async () => {
    const { delegate, byName } = toolset();
    const evidence = "Checked the folder and verified that the captain's draft is intact.";
    const sentence = "The project folder was checked.";
    await byName.get("settle_task")?.execute("t1", {
      task_id: "ab12",
      mode: "finished",
      completion_evidence: evidence,
      release_evidence: "not the evidence for this mode",
      closing_sentence: sentence,
    });
    expect(delegate.settleTask).toHaveBeenCalledWith(
      "ab12",
      "finished",
      undefined,
      undefined,
      evidence,
      sentence,
    );
  });

  it("settle_task carries a structured refusal in its details", async () => {
    const refusal = {
      refused: "children-open" as const,
      task: { id: "ab12", key: "SCR-1", title: "Parent" },
      tasks: [{ id: "cd34", key: "SCR-2", title: "Child" }],
      ways: [
        {
          label: "Merge the pull request, keeping it planned",
          tool: "settle_task" as const,
          args: { task_id: "ab12", mode: "merge-pr", proceed_with_open: true },
        },
      ],
      text: "Cannot close SCR-1 while its child is still open.",
    };
    const { byName } = toolset({
      settleTask: vi.fn(async () => ({ text: refusal.text, refusal })),
    });
    const result = (await byName.get("settle_task")?.execute("t1", {
      task_id: "ab12",
      mode: "merge-pr",
      closing_sentence: "The parent's work is merged.",
    })) as unknown as {
      content: { text: string }[];
      details: { refusal?: unknown };
    };
    expect(result.content[0]?.text).toBe(refusal.text);
    expect(result.details.refusal).toEqual(refusal);
  });

  it("crew_status returns fresh structured state or a calm empty note", async () => {
    const { byName } = toolset({
      crewStatus: vi.fn(() => [
        {
          taskId: "ab12",
          title: "Fix meter",
          status: "idle",
          branch: "fm/task-ab12",
          repoName: "quota-axi",
          autonomy: false,
        },
      ]),
    });
    const result = await byName.get("crew_status")?.execute("t1", {});
    expect(result?.content[0]?.text).toContain('"taskId": "ab12"');

    const empty = toolset();
    const none = await empty.byName.get("crew_status")?.execute("t1", {});
    expect(none?.content[0]?.text).toBe("No crew right now.");
  });
});

describe("spawn_crewmate on the graph (task-system P2)", () => {
  it("carries parent, blocked_by and priority, and after_task stays an alias", async () => {
    const { delegate, byName } = toolset();
    await byName.get("spawn_crewmate")?.execute("t1", {
      title: "Step two",
      goal: "Two is done",
      user_words: "do two after one",
      parent: "SCR-1",
      blocked_by: ["SCR-2", "ab12cd34"],
      priority: 0,
    });
    expect(delegate.commission).toHaveBeenCalledWith({
      title: "Step two",
      intent: { goal: "Two is done", userWords: "do two after one" },
      parent: "SCR-1",
      blockedBy: ["SCR-2", "ab12cd34"],
      priority: 0,
    });
    await byName.get("spawn_crewmate")?.execute("t2", {
      title: "Step three",
      goal: "Three is done",
      user_words: "then three",
      start_after: { after_task: "SCR-3" },
      blocked_by: [],
    });
    expect(delegate.commission).toHaveBeenLastCalledWith({
      title: "Step three",
      intent: { goal: "Three is done", userWords: "then three" },
      startAfter: { afterTask: "SCR-3" },
    });
  });
});

/**
 * spawn_crewmate's grouped parameters (contract v4.12, primitives P7): the
 * work-shape facts ride `shape`, the waits `start_after`, one level deep;
 * a call in the flat shape a durable session or a recording still carries
 * reads exactly as the grouped one does.
 */
describe("spawn_crewmate's groups (contract v4.12, primitives P7)", () => {
  type Schema = {
    description?: string;
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
  };
  const spawnSchema = () => {
    const tools = createCrewTools(toolset().delegate) as unknown as {
      name: string;
      parameters: Schema;
    }[];
    return tools.find((tool) => tool.name === "spawn_crewmate")?.parameters as Schema;
  };

  it("serves fifteen top-level parameters, the two groups one level deep", () => {
    const properties = spawnSchema().properties ?? {};
    expect(Object.keys(properties)).toHaveLength(15);
    expect(Object.keys(properties.shape?.properties ?? {})).toEqual([
      "ongoing",
      "intelligence",
      "kind",
      "delivery_ask",
      "basis",
      "premium_ask",
      "override_model_id",
      "override_speed",
      "override_reasoning",
      "escalate_from",
      "rigor_ask",
      "autonomy_ask",
      "runs_on_ask",
      "internal_step",
      "in_folder",
      "skipped_plan_because",
      "review_of",
    ]);
    expect(Object.keys(properties.start_after?.properties ?? {})).toEqual([
      "after_task",
      "when_quota_resets",
      "at_time",
    ]);
    // Since v4.13 every field's rule rides its group's own description, the
    // level a Claude seat's client serves, and no field keeps one of its own.
    for (const group of ["shape", "start_after"]) {
      const description = properties[group]?.description ?? "";
      for (const [name, field] of Object.entries(properties[group]?.properties ?? {})) {
        expect(description, `${group} states ${name}'s rule`).toMatch(
          new RegExp(`^${name}: \\S`, "m"),
        );
        expect(field.description, `${group}.${name} is described on its group`).toBeUndefined();
        expect(field.type, `${group}.${name} nests no further`).not.toBe("object");
      }
    }
  });

  const flat = {
    title: "Fix the meter test",
    goal: "The meter test is really fixed",
    user_words: "that is not a fix; ship it reviewed, after SCR-3",
    escalate_from: "FM3K-12",
    rigor_ask: "reviewed",
    autonomy_ask: false,
    after_task: "SCR-3",
  };
  const grouped = {
    title: flat.title,
    goal: flat.goal,
    user_words: flat.user_words,
    shape: { escalate_from: "FM3K-12", rigor_ask: "reviewed", autonomy_ask: false },
    start_after: { after_task: "SCR-3" },
  };

  it("reads a flat call from before v4.12 exactly as the grouped one", async () => {
    const fromFlat = toolset();
    const fromGrouped = toolset();
    await fromFlat.byName.get("spawn_crewmate")?.execute("t1", flat);
    await fromGrouped.byName.get("spawn_crewmate")?.execute("t1", grouped);
    const expected = {
      title: flat.title,
      intent: { goal: flat.goal, userWords: flat.user_words },
      shape: { escalate_from: "FM3K-12", rigor_ask: "reviewed", autonomy_ask: false },
      startAfter: { afterTask: "SCR-3" },
    };
    expect(fromFlat.delegate.commission).toHaveBeenCalledWith(expected);
    expect(fromGrouped.delegate.commission).toHaveBeenCalledWith(expected);
  });

  it("holds a flat escalation to the captain's turn as it holds a grouped one", async () => {
    for (const args of [flat, grouped]) {
      const { delegate, byName } = toolset({ isCaptainTurn: vi.fn(() => false) });
      const result = await byName.get("spawn_crewmate")?.execute("t1", args);
      expect(delegate.commission).not.toHaveBeenCalled();
      expect(result?.content[0]?.text).toContain("Nothing was spawned");
    }
  });

  it("still refuses two waits at once, whichever shape carries them", async () => {
    const { byName } = toolset();
    await expect(
      byName.get("spawn_crewmate")?.execute("t1", {
        ...grouped,
        start_after: { after_task: "SCR-3", at_time: "2026-10-01T09:00:00Z" },
      }),
    ).rejects.toThrow(/at most one/);
    await expect(
      byName.get("spawn_crewmate")?.execute("t1", {
        ...grouped,
        start_after: undefined,
        at_time: "2026-10-01T09:00:00Z",
        when_quota_resets: "codex",
      }),
    ).rejects.toThrow(/at most one/);
  });

  it("groups flat args, keeps the group's own value, and carries no field of the wrong type", () => {
    expect(
      groupSpawnArgs({
        title: "t",
        basis: "FM3K-1",
        premium_ask: "yes",
        shape: { basis: "FM3K-2" },
        at_time: "2026-10-01T09:00:00Z",
      }),
    ).toEqual({
      title: "t",
      shape: { basis: "FM3K-2" },
      start_after: { at_time: "2026-10-01T09:00:00Z" },
    });
    expect(groupSpawnArgs(grouped)).toEqual(grouped);
  });
});
