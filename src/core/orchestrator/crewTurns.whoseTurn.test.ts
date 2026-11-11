/**
 * A crewmate's turn as `CrewTurns` runs it to its end and sorts whose
 * turn follows (docs/report-sort.md): a commissioned turn streamed to its
 * idle end, a real Pi stream cut and retried, the whose-turn rule at the
 * report's call site, a cardless internal step's report, and the usage
 * ledger a turn reaches even when a close cuts it.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * Some cases run on the real clock, a local HTTP server or real git, so the
 * file is an integration test.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codingSpec } from "../../../tests/helpers/codingSession";
import {
  askedOn,
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  type SetupExtras,
  served,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { CLAUDE_CONTROL_PROFILE } from "../claude/claudeQueryCore";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { catalogRefreshesSettled, createModelRuntime } from "../pi/modelRuntime";
import { piSessionEvents } from "../pi/piEvents";
import { createPiSessionFactory } from "../pi/session";
import type { KindInput } from "../routing/kindClassifier";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { UsageStore } from "../storage/usageStore";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { declareCheckAction, observeCheckRepair } from "./checkRepair";
import { QUIT_SETTLE_MS } from "./crewRuntime";
import { renderWake, type WakeFacts } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("streams a commissioned turn without a task card and leaves the task idle and steerable", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, cards, ops, tasks } = setup(crewmate);
    const {
      taskId,
      crewmate: name,
      started,
    } = await supervisor.intake.commission({
      title: "Refactor auth",
      intent: intentOf("refactor the auth middleware; acceptance: tests green"),
    });
    // The answer is the recorded task; its start runs behind it (INF-3060).
    expect(name).toBe("starting");
    await started;
    expect(tasks.get(taskId)?.assignee).toBe("crewmate 1");
    await tick();

    expect(events.some((e) => e.type === "task_started")).toBe(true);
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 1, idle: 0 });
    expect(cards()).toEqual([]);

    crewmate.emit({ type: "assistant_delta", taskId, text: "Refactor " });
    crewmate.emit({ type: "assistant_delta", taskId, text: "finished." });
    await tick();
    expect(cards().find((card) => card.taskId === taskId)).toBeUndefined();

    crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2 } });
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    expect(crewmate.dispose).not.toHaveBeenCalled();
    const report = events.find((e) => e.type === "task_report");
    expect(report).toMatchObject({
      type: "task_report",
      title: "Refactor auth",
      summary: "Refactor finished.",
    });
    expect(ops.at(-1)).toContain("reported on task");
    expect(ops.at(-1)).toContain("Refactor finished.");

    await supervisor.steer.steerCrewmate(taskId, "also make it blue");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("also make it blue");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 1, idle: 0 });
    crewmate.finishPrompt();
    await tick();

    // A finished crewmate stays idle until the captain settles it; landing
    // closes it done and tears the worktree down (WI-11 - no `finish`).
    const settled = await supervisor.settling.settle.settleTask(
      taskId,
      "land",
      undefined,
      "captain",
    );
    expect(settled).toContain("into main.");
    expect(crewmate.dispose).toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
    expect(events.filter((e) => e.type === "task_landed").at(-1)).toMatchObject({
      type: "task_landed",
      title: "Refactor auth",
    });
    expect(supervisor.facts.crewStatus().find((entry) => entry.taskId === taskId)).toBeUndefined();
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 0 });
  });

  it("keeps the report when a real Pi stream is cut and Pi retries it", {
    timeout: 30_000,
  }, async () => {
    // INF-253 R2: the holder tests feed Pi's events. This one is Pi's own
    // retry of a stream this process cuts, through the production session.
    vi.useRealTimers();
    let chats = 0;
    let cut = false;
    const server = createServer((req, res) => {
      const chat = req.method === "POST" && (req.url ?? "").includes("chat/completions");
      if (!chat) {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        chats += 1;
        const base = {
          id: `chatcmpl-${chats}`,
          object: "chat.completion.chunk",
          model: "mock-1",
        };
        const chunk = (delta: unknown, finish: string | null = null) =>
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (chats === 1) {
          cut = true;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(chunk({ role: "assistant", content: "part" }));
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(chunk({ role: "assistant" }));
        res.write(chunk({ content: "All done." }));
        res.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const dir = scratchDir("infinitary-cut-stream-");
    const modelsPath = join(dir, "models.json");
    writeFileSync(join(dir, "auth.json"), "{}", { mode: 0o600 });
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          "fm-mock": {
            name: "Mock",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock-key",
            models: [{ id: "mock-1", name: "Mock", input: ["text"] }],
          },
        },
      }),
    );
    const runtime = await createModelRuntime({
      authPath: join(dir, "auth.json"),
      modelsPath,
      catalogBaseUrl: `http://127.0.0.1:${port}`,
    });
    const opened = await createPiSessionFactory({ agentDir: join(dir, "agent") }).open(
      codingSpec({
        binding: { backend: "pi", runtime },
        cwd: dir,
        owner: "cut-stream",
        model: { provider: "fm-mock", id: "mock-1" },
        recordDir: join(dir, "record"),
      }),
    );
    const inner = (
      opened as unknown as {
        session: { settingsManager: { applyOverrides: (overrides: object) => void } };
      }
    ).session;
    inner.settingsManager.applyOverrides({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
    });
    const crewmate = fakeCrewmate();
    let promptError = "";
    crewmate.prompt = async (text) => {
      try {
        await opened.prompt(text);
      } catch (caught) {
        promptError = caught instanceof Error ? caught.message : String(caught);
        throw caught;
      }
    };
    crewmate.subscribe = (listener) => opened.subscribe(listener);
    const { supervisor, events, ops, tasks, inbox } = setup(crewmate);
    try {
      const { taskId } = await supervisor.intake.commission({
        title: "Lid close",
        intent: intentOf("do the work"),
      });
      // The first turn runs after commission returns.
      await vi.waitFor(
        () => {
          expect(chats, promptError || "the stream was never cut").toBeGreaterThan(1);
          expect(cut).toBe(true);
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(tasks.get(taskId)?.outcome).toBe("All done."), {
        timeout: 20_000,
      });
      expect(events.find((event) => event.type === "turn_failed")).toBeUndefined();
      expect(events.find((event) => event.type === "task_report")).toMatchObject({
        summary: "All done.",
      });
      expect(tasks.get(taskId)?.outcome).toBe("All done.");
      expect(ops.some((line) => line.includes("failed at the provider"))).toBe(false);
      expect(inbox.allFor(taskId)).toEqual([]);
      expect(inbox.inFlight(taskId)).toEqual([]);
    } finally {
      opened.dispose();
      // The runtime's catalog refresh writes its store into this folder; a
      // refresh still running would put the removed folder back.
      await catalogRefreshesSettled();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the whose-turn rule at the report's call site (S7c, R4.8)", () => {
  async function reportedTask(crewmate: FakeCrewmate, extras: SetupExtras = {}) {
    const harness = setup(crewmate, extras);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    return { ...harness, taskId };
  }

  async function report(crewmate: FakeCrewmate, taskId: string, text = "Done, tests green.") {
    crewmate.emit({ type: "assistant_delta", taskId, text });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
  }

  const reportWakes = (ops: string[]) => ops.filter((line) => line.includes("reported on task"));

  it("wakes on a stopped Pi crewmate, and records the rule that said so", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, sorts, taskId } = await reportedTask(crewmate);
    await report(crewmate, taskId);
    expect(reportWakes(ops)).toHaveLength(1);
    expect(reportWakes(ops)[0]).toContain("Done, tests green.");
    expect(sorts).toEqual([{ taskId, verdict: "captain", rule: "stopped" }]);
    expect(supervisor.cards.snapshot()).toEqual([]);
  });

  it("records the report's typed facts beside the text it was served as (P6)", async () => {
    const crewmate = fakeCrewmate();
    const { ops, ledger, ledgerFacts, taskId } = await reportedTask(crewmate);
    await report(crewmate, taskId);
    const facts = ledgerFacts.at(-1);
    expect(facts).toMatchObject({
      kind: "report",
      task: { id: taskId, title: "Job" },
      excerpt: "Done, tests green.",
    });
    // One wake, two copies: the ledger's text is the served text, and both
    // are the facts' one rendering.
    expect(ledger.at(-1)).toBe(renderWake({ facts: facts as WakeFacts }));
    expect(reportWakes(ops)).toEqual([ledger.at(-1)]);
  });

  it("holds the turn for the captain while a DECISION card is open, and not for a note", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, sorts, specs, taskId } = await reportedTask(crewmate);
    specs[0]?.onCard?.({
      title: "Pick a course",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    await tick();
    await report(crewmate, taskId, "Waiting on your pick.");
    expect(reportWakes(ops)).toHaveLength(0);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });

    // The captain answers it; the card leaves the stack and the next report
    // falls through the rule as if none had ever been up.
    const card = supervisor.cards.snapshot().find((entry) => entry.title === "Pick a course");
    supervisor.cardActions.act(card?.id ?? "", "change");
    await tick();
    await report(crewmate, taskId, "Course plotted.");
    expect(sorts.at(-1)?.rule).toBe("stopped");
  });

  it("a note-only card never holds the turn (R4.8 question 1)", async () => {
    const crewmate = fakeCrewmate();
    const { ops, sorts, specs, taskId } = await reportedTask(crewmate);
    specs[0]?.onCard?.({
      title: "Why the pin dropped",
      body: "<p>The pin dropped because the lock file moved.</p>",
      actions: [],
    });
    await tick();
    await report(crewmate, taskId, "Noted; nothing else to do.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "stopped" });
    expect(reportWakes(ops)).toHaveLength(1);
  });

  it("stays quiet while the crewmate is provably still moving", async () => {
    const crewmate = fakeCrewmate();
    const { ops, sorts, taskId } = await reportedTask(crewmate, {
      hasRunningJobs: () => true,
    });
    await report(crewmate, taskId, "Build running; watching it.");
    expect(reportWakes(ops)).toHaveLength(0);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
  });

  // INF-735 (INF-720's Fix 2), the captain's "file a fix so a hold on another
  // task's finding ends when that task reports it". PR #184's task was held
  // on INF-621's finding through the first mate's link; INF-621 reported it
  // at 2:54 PM while its own work still ran, so the report stayed quiet and
  // the hold lasted 2,393 more minutes, until a close days away.
  it("wakes for started work the first mate holds on the reporting task, until it ends the wait (INF-735)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, sorts, tasks, ledgerFacts, taskId } = await reportedTask(crewmate, {
      hasRunningJobs: () => true,
    });
    const held = seedTask(tasks, {
      id: "d8f35ffa",
      title: "Fix: task board Escape skips the open summary under load",
      status: "idle",
    });
    // Started work waiting on its merge through a blocks_me mark is waited
    // on too (INF-3167: every wait reads the same); planned work that has
    // not started is no hold on its finding.
    const merging = seedTask(tasks, { id: "inf-550", title: "Show the story", status: "idle" });
    tasks.graph.link(taskId, merging.id, "blocks", "host", true);
    const planned = seedTask(tasks, {
      id: "8bc93cc7",
      title: "Move phone checks off the Mac check lock",
      status: "queued",
      startPolicy: "on-request",
    });
    supervisor.intake.linkTasks(taskId, planned.id, "blocks");
    // The captain chose to wait for this task's findings: the first mate's link.
    supervisor.intake.linkTasks(taskId, held.id, "blocks");
    // INF-621's report at 2:54 PM (event 91322), its closing sentence.
    const finding =
      "PR #184's verdict remains the captured native readiness race and a controlled rerun, not an Escape-code rewrite.";
    await report(crewmate, taskId, finding);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waited-on" });
    expect(ledgerFacts.at(-1)).toMatchObject({
      kind: "report",
      excerpt: finding,
      waiting: [
        { id: held.id, key: held.key, title: held.title },
        { id: merging.id, key: merging.key, title: merging.title },
      ],
    });
    expect(reportWakes(ops)).toHaveLength(1);
    expect(reportWakes(ops)[0]).toContain(
      `through your link: ${held.key} "${held.title}", ${merging.key} "${merging.title}".`,
    );

    // The first mate passes the finding on and ends the waits: the next
    // report from the still-running task holds nobody and stays quiet.
    supervisor.intake.unlinkTasks(taskId, held.id, "blocks");
    supervisor.intake.unlinkTasks(taskId, merging.id, "blocks");
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    await report(crewmate, taskId, "Second clean phone run passed.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
    expect(reportWakes(ops)).toHaveLength(1);
  });

  it("wakes for the follow-ups a report filed, whatever else is true", async () => {
    const crewmate = fakeCrewmate();
    const { ops, sorts, specs, taskId } = await reportedTask(crewmate, {
      hasRunningJobs: () => true,
    });
    specs[0]?.onFollowup?.({ title: "Fix the flake", goal: "unflake it", why: "it is red" });
    await report(crewmate, taskId, "Filed one thing; still building.");
    expect(reportWakes(ops)).toHaveLength(1);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "filed-followups" });
  });

  it("stays quiet while a client-side backend's own count says its background task still runs", async () => {
    const crewmate = fakeCrewmate();
    const clientSide: FakeCrewmate = {
      ...crewmate,
      controlProfile: CLAUDE_CONTROL_PROFILE,
    };
    const { ops, sorts, taskId } = await reportedTask(clientSide);
    // The client lists the task it started (`background_tasks_changed`).
    clientSide.emit({
      type: "background_work_changed",
      count: 1,
      tasks: [{ id: "b7xk2", description: "pnpm test src/core/orchestrator" }],
    });
    await report(clientSide, taskId, "Kicked off a background task; I'll report back.");
    expect(reportWakes(ops)).toHaveLength(0);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
  });

  // INF-11, from the captain's words "make this missed escalation
  // structurally impossible" (2026-10-18): a crewmate that stops needing the
  // captain or the first mate, with no card up, is never sorted routine. The
  // host never reads its words, so a report nothing the host sees holds
  // wakes the first mate on every backend, and its words carry the need.
  describe("a cardless report nothing holds wakes the first mate on a backend the host cannot watch (INF-11)", () => {
    // DOP-18's report (event 63663), the one the captain saw sorted routine.
    const DOP_18_NOT_DONE =
      "The token file can read both repositories, but its Administration write capability is insufficient or otherwise unavailable for the second JIT mint; the log cannot distinguish the exact permission issue. The captain must provide a token with runner-registration write access for both repositories, then the supervisor can retry without another restart.";
    // INF-410's report (event 78325), sorted routine the same way.
    const INF_410_NOT_DONE =
      "Needs the app side: prepare_change must accept the head of the task's own branch, here fm/task-fb3b7e63 at 7c76c77, or this crewmate must be re-bound to that branch. Once it returns a revision, I will open the PR, read its checks and emit the card.";

    it("a Pi crewmate on a computer that runs work, whose count says no job runs (DOP-18)", async () => {
      const crewmate = fakeCrewmate();
      // The face such a computer's conversation presents here (placedSessions.ts).
      const placed: FakeCrewmate = {
        ...crewmate,
        controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
      };
      const { supervisor, ops, sorts, taskId } = await reportedTask(placed);
      // That computer publishes its Pi shell's job count, zero included (docs/helper.md).
      placed.emit({ type: "background_work_changed", count: 0 });
      await report(placed, taskId, DOP_18_NOT_DONE);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "cannot-tell" });
      expect(reportWakes(ops)).toEqual([
        `[fm-op] crewmate 1 reported on task ${taskId} "Job": ${DOP_18_NOT_DONE}`,
      ]);
      expect(supervisor.cards.snapshot()).toEqual([]);
    });

    it("a Claude crewmate whose client has listed no background task (INF-410)", async () => {
      const crewmate = fakeCrewmate();
      const claude: FakeCrewmate = { ...crewmate, controlProfile: CLAUDE_CONTROL_PROFILE };
      const { ops, sorts, specs, taskId } = await reportedTask(claude);
      expect(specs[0]?.onReport?.(INF_410_NOT_DONE)).toContain("Reported.");
      await report(claude, taskId, "Blocked; reported.");
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "cannot-tell" });
      expect(reportWakes(ops)).toEqual([
        `[fm-op] crewmate 1 reported on task ${taskId} "Job": ${INF_410_NOT_DONE}`,
      ]);
    });
  });

  // FI3-671: a wait on work nobody has started is the Firstmate's turn on
  // any backend - only it or the captain can start that work.
  it("wakes on a Claude-profile crewmate whose declared baseline wait names unstarted work", async () => {
    const crewmate = fakeCrewmate();
    const clientSide: FakeCrewmate = {
      ...crewmate,
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
    };
    const { supervisor, ops, sorts, tasks, taskId } = await reportedTask(clientSide);
    const owner = seedTask(tasks, {
      id: "baseline-owner",
      title: "Fix the flaky test",
      status: "queued",
      startPolicy: "on-request",
    });
    // The real producers: a failed reading, then the crewmate's declaration.
    const failed = [{ name: "linux-checks", state: "failure" as const }];
    seedDelivery(tasks, taskId, {
      headSha: "head-1",
      ci: "red",
      ...observeCheckRepair(undefined, "head-1", failed, 1),
    });
    const diagnosis = {
      headSha: "head-1",
      check: "linux-checks",
      classification: "baseline-blocked" as const,
      evidence: "The same assertion fails on untouched main",
      dependencyTask: owner.id,
    };
    expect(declareCheckAction(tasks, taskId, { diagnosis }, Date.now()).text).toContain(
      `Nobody has started ${owner.key}`,
    );
    await report(clientSide, taskId, "Blocked by a baseline failure.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waits-unstarted" });
    expect(reportWakes(ops)).toEqual([
      `[fm-op] crewmate 1 reported on task ${taskId} "Job": Blocked by a baseline failure. It waits on ${owner.key} "Fix the flaky test" (not started); nothing starts that work by itself.`,
    ]);

    // Once the work is underway nothing is the Firstmate's to start: the
    // crewmate moves again when that work closes (FI3-250).
    tasks.starts.dispatch(owner.id, {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
    });
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    await report(clientSide, taskId, "Still waiting on the flaky test fix.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
    expect(reportWakes(ops)).toHaveLength(1);
  });

  it("ends a baseline wait by itself at a new head, and never calls dropped work unstarted", async () => {
    const crewmate = fakeCrewmate();
    const clientSide: FakeCrewmate = {
      ...crewmate,
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
    };
    const { supervisor, ops, sorts, tasks, taskId } = await reportedTask(clientSide);
    const owner = seedTask(tasks, {
      id: "baseline-owner",
      title: "Fix main",
      status: "queued",
      startPolicy: "on-request",
    });
    const failed = [{ name: "linux-checks", state: "failure" as const }];
    seedDelivery(tasks, taskId, {
      headSha: "head-1",
      ci: "red",
      ...observeCheckRepair(undefined, "head-1", failed, 1),
    });
    declareCheckAction(
      tasks,
      taskId,
      {
        diagnosis: {
          headSha: "head-1",
          check: "linux-checks",
          classification: "baseline-blocked",
          evidence: "The same assertion fails on untouched main",
          dependencyTask: owner.id,
        },
      },
      Date.now(),
    );
    tasks.close(owner.id, { status: "dropped", reason: "cancelled", actor: "host" });
    await report(clientSide, taskId, "Waiting on the main-line fix.");
    expect(sorts.at(-1)?.rule).toBe("cannot-tell");
    expect(reportWakes(ops).at(-1)).toBe(
      `[fm-op] crewmate 1 reported on task ${taskId} "Job": Waiting on the main-line fix.`,
    );

    // The crewmate pushed again: the diagnosis was about another version.
    seedDelivery(tasks, taskId, { headSha: "head-2", ci: "pending" });
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    await report(clientSide, taskId, "Pushed a new version; its checks are running.");
    expect(sorts.at(-1)?.rule).toBe("cannot-tell");
    expect(reportWakes(ops).at(-1)).toBe(
      `[fm-op] crewmate 1 reported on task ${taskId} "Job": Pushed a new version; its checks are running.`,
    );
  });

  // INF-1428, built as INF-1670's piece 2 (the captain's Approve and build):
  // INF-785 waited on INF-1659, which starts on request and is itself
  // blocked by INF-1109, whose PR #496 was up for merge. Every report woke
  // the first mate and the idle ladder raised the stuck alert. A task that
  // cannot start until its own blockers close stands for those blockers.
  describe("a wait through a task that cannot start until its own blockers close (INF-1428)", () => {
    function inf785(tasks: ReturnType<typeof setup>["tasks"]) {
      const secrets = seedTask(tasks, {
        id: "1eb53573",
        title: "Continue: Secrets settings, app wiring and live platform proofs",
        status: "idle",
      });
      const storage = seedTask(tasks, {
        id: "707e2b88",
        title: "Enable production protected Secrets storage",
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.graph.link(secrets.id, storage.id, "blocks", "firstmate");
      return { secrets, storage };
    }

    it("stays quiet while the chain's blocker is underway, and names the task once it needs a start", async () => {
      const crewmate = fakeCrewmate();
      const clientSide: FakeCrewmate = {
        ...crewmate,
        controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
      };
      const { supervisor, ops, sorts, tasks, taskId } = await reportedTask(clientSide);
      const { secrets, storage } = inf785(tasks);
      supervisor.intake.linkTasks(storage.id, taskId, "blocks");
      supervisor.intake.linkTasks(secrets.id, taskId, "blocks");
      await report(
        clientSide,
        taskId,
        "Blocked on INF-1659 and INF-1109; nothing to do until #496 merges.",
      );
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
      expect(reportWakes(ops)).toHaveLength(0);

      // PR #496 merges: the storage task now waits only on a start.
      tasks.close(secrets.id, { status: "done", reason: "merged", actor: "host" });
      await supervisor.steer.steerCrewmate(taskId, "go on");
      await tick();
      await report(clientSide, taskId, "Still blocked on INF-1659.");
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waits-unstarted" });
      expect(reportWakes(ops)).toEqual([
        `[fm-op] crewmate 1 reported on task ${taskId} "Job": Still blocked on INF-1659. It waits on ${storage.key} "Enable production protected Secrets storage" (not started); nothing starts that work by itself.`,
      ]);
    });

    it("names the work at the chain's end when nobody has started it, and the blocked task when a dropped blocker holds it", async () => {
      const crewmate = fakeCrewmate();
      const clientSide: FakeCrewmate = {
        ...crewmate,
        controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
      };
      const { supervisor, ops, sorts, tasks, taskId } = await reportedTask(clientSide);
      const { secrets, storage } = inf785(tasks);
      supervisor.intake.linkTasks(storage.id, taskId, "blocks");
      // The blocker at the chain's end goes back to waiting on a start.
      const parked = seedTask(tasks, {
        id: "parked-1109",
        title: "Continue: Secrets settings, app wiring and live platform proofs",
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.close(secrets.id, { status: "dropped", reason: "cancelled", actor: "host" });
      tasks.graph.link(parked.id, storage.id, "blocks", "firstmate");
      await report(clientSide, taskId, "Blocked on INF-1659.");
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waits-unstarted" });
      expect(reportWakes(ops).at(-1)).toContain(
        `It waits on ${storage.key} "Enable production protected Secrets storage" (not started)`,
      );

      // With the dropped blocker gone from its waits, the parked one is what needs a start.
      supervisor.intake.unlinkTasks(secrets.id, storage.id, "blocks");
      await supervisor.steer.steerCrewmate(taskId, "go on");
      await tick();
      await report(clientSide, taskId, "Still blocked on INF-1659.");
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waits-unstarted" });
      expect(reportWakes(ops).at(-1)).toContain(
        `It waits on ${parked.key} "Continue: Secrets settings, app wiring and live platform proofs" (not started)`,
      );
    });
  });

  // INF-1428's own part: a crewmate names the tasks it waits on in its
  // report, and the app records each as a link, never reading its words.
  describe("a report's waits_on (INF-1428)", () => {
    it("records each named task as a wait that holds its merge until that task closes, and refuses unknown, closed, own or circular keys", async () => {
      const crewmate = fakeCrewmate();
      const { specs, tasks, taskId } = await reportedTask(crewmate, {
        hasRunningJobs: () => true,
      });
      const onReport = specs[0]?.onReport;
      if (!onReport) throw new Error("Missing production report callback");
      const secrets = seedTask(tasks, {
        id: "1eb53573",
        title: "Continue: Secrets settings, app wiring and live platform proofs",
        status: "idle",
      });
      const merged = seedTask(tasks, {
        id: "1c94b852",
        title: "Fix sign-in journey scanning disappearing temporary files",
        status: "idle",
      });
      tasks.close(merged.id, { status: "done", reason: "merged", actor: "host" });
      const own = tasks.get(taskId);
      const text = "Blocked on INF-1109's merge.";
      expect(() => onReport(text, undefined, { waitsOn: ["INF-99999"] })).toThrow(
        'waits_on names "INF-99999", which is no task',
      );
      expect(() => onReport(text, undefined, { waitsOn: [merged.key] })).toThrow(
        `waits_on names ${merged.key}, which is done`,
      );
      expect(() => onReport(text, undefined, { waitsOn: [own?.key ?? taskId] })).toThrow(
        "waits_on names your own task",
      );
      expect(() => onReport(text, undefined, { waitsOn: [secrets.key], finished: true })).toThrow(
        "pass it without finished",
      );
      expect(tasks.graph.linksTo(taskId)).toEqual([]);

      expect(onReport(text, undefined, { waitsOn: [secrets.key.toLowerCase()] })).toContain(
        `Recorded: your task waits on ${secrets.key}.`,
      );
      expect(tasks.graph.linksTo(taskId)).toEqual([
        expect.objectContaining({ fromId: secrets.id, type: "blocks", holdsMerge: false }),
      ]);
      // A recorded wait holds the merge until the named task closes (INF-3167).
      expect(tasks.graph.blockersHoldingClose(taskId).map((row) => row.id)).toEqual([secrets.id]);
      expect(tasks.timeline(taskId).at(-1)).toMatchObject({ actor: "crewmate", kind: "linked" });

      // The task the report waits on already waits on it: a cycle.
      const waiter = seedTask(tasks, { id: "waiter", title: "Waits on this job", status: "idle" });
      tasks.graph.link(taskId, waiter.id, "blocks", "firstmate");
      expect(() => onReport(text, undefined, { waitsOn: [secrets.key, waiter.key] })).toThrow(
        /^Report refused: .*would close a cycle/,
      );
      expect(tasks.graph.linksTo(taskId)).toHaveLength(1);
    });

    // INF-1826 (spec item 3): a wait named on replaced work is recorded on the
    // task carrying it, and a carrier already done is refused by name.
    it("records a wait named on replaced work on the task carrying it, and refuses a carrier already done", async () => {
      const crewmate = fakeCrewmate();
      const { specs, tasks, taskId } = await reportedTask(crewmate, {
        hasRunningJobs: () => true,
      });
      const onReport = specs[0]?.onReport;
      if (!onReport) throw new Error("Missing production report callback");
      const old = seedTask(tasks, { id: "inf-1550", title: "Runbooks piece 0", status: "idle" });
      const carrier = seedTask(tasks, {
        id: "inf-1641",
        title: "Publish Runbooks piece 0",
        status: "running",
      });
      tasks.dropWithChildren(old.id, {
        reason: "moved to a fresh task",
        actor: "firstmate",
        replacedBy: carrier.id,
      });
      expect(onReport("Waiting on runbooks.", undefined, { waitsOn: [old.key] })).toContain(
        `Recorded: your task waits on ${carrier.key}.`,
      );
      expect(tasks.graph.linksTo(taskId)).toEqual([
        expect.objectContaining({ fromId: carrier.id, type: "blocks" }),
      ]);

      const gone = seedTask(tasks, { id: "gone", title: "Old loader", status: "idle" });
      const merged = seedTask(tasks, { id: "merged", title: "New loader", status: "running" });
      tasks.dropWithChildren(gone.id, {
        reason: "moved",
        actor: "firstmate",
        replacedBy: merged.id,
      });
      tasks.close(merged.id, { status: "done", reason: "merged", actor: "host" });
      expect(() => onReport("Waiting on the loader.", undefined, { waitsOn: [gone.key] })).toThrow(
        `waits_on names ${gone.key}, whose work moved to ${merged.key}, which is already done`,
      );
    });
  });

  it("wakes on every report while a blocking filing stays planned, and not once it starts", async () => {
    const crewmate = fakeCrewmate();
    const clientSide: FakeCrewmate = {
      ...crewmate,
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
    };
    const { supervisor, ops, sorts, specs, tasks, taskId } = await reportedTask(clientSide);
    specs[0]?.onFollowup?.({ title: "Unblock", goal: "g", why: "w", blocksMe: true });
    await report(clientSide, taskId, "Filed what blocks me.");
    expect(sorts.at(-1)?.rule).toBe("filed-followups");
    // The Firstmate left it planned: the next report still names it.
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    await report(clientSide, taskId, "Still blocked.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "waits-unstarted" });
    const blocker = tasks.graph.blockersHoldingClose(taskId)[0];
    expect(reportWakes(ops).at(-1)).toContain(
      `It waits on ${blocker?.key} "Unblock" (not started)`,
    );
    tasks.starts.dispatch(blocker?.id ?? "", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
    });
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    await report(clientSide, taskId, "Waiting for it to merge.");
    expect(sorts.at(-1)?.rule).toBe("still-moving");
    expect(reportWakes(ops)).toHaveLength(2);
  });

  it("sorts a Careful builder's report like any other: the care's name skips nothing (INF-1876)", async () => {
    const crewmate = fakeCrewmate();
    const reviewer = fakeCrewmate();
    const { supervisor, repos, ops, sorts } = setup(crewmate, { crewmates: [reviewer] });
    const { repo } = await repos.setup({ kind: "init", name: "reviewed" });
    repos.configure(repo.id, { rigor: "reviewed", delivery: "direct-pr" });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("Start"),
      repoId: repo.id,
    });
    await tick();
    await report(crewmate, taskId, "Branch pushed.");
    expect(reportWakes(ops)).toHaveLength(1);
    // The report is sorted from its typed state as a Default one is; what
    // Careful asks of the report is the care guidance's, which has the
    // builder say what the first mate must do.
    expect(sorts).toEqual([{ taskId, verdict: "captain", rule: "stopped" }]);
  });

  // FI3-710 (grounded on FI3-703): a captain decision only the Firstmate can
  // carry out reached it only when the sort happened to wake it. FI3-696's
  // approval by reply sorted `cannot-tell` on a Claude crewmate and sat.
  describe("a report that asks the Firstmate to act (FI3-710)", () => {
    const APPROVAL = "for decision 5, raise the threshold from 8 to 32. now approve to build";
    const ASK = "start the builder on the approved plan, threshold 32";
    const RELAY = `The captain approved the plan by reply: "${APPROVAL}". The final plan keeps every decision, with the threshold at 32.`;

    /** A planner whose plan card is up and its first report sorted. */
    async function plannerWithCard(backgroundWork: "host" | "client") {
      const base = fakeCrewmate();
      const crewmate: FakeCrewmate = {
        ...base,
        controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork },
      };
      const harness = await reportedTask(crewmate);
      harness.specs[0]?.onCard?.({
        title: "Plan the threshold change",
        body: "<p>Raise the threshold.</p><p>Decision 5 sets it to 8.</p>",
        actions: [
          { id: "build", label: "Approve and build", default: true },
          { id: "later", label: "Not now" },
        ],
      });
      await tick();
      await report(crewmate, harness.taskId, "The plan is on its card.");
      expect(harness.sorts.at(-1)?.rule).toBe("captain-card");
      const card = harness.cards().find((entry) => entry.title === "Plan the threshold change");
      if (!card) throw new Error("the plan card is not up");
      return { ...harness, crewmate, card };
    }

    /** The turn the captain's reply started ends; the explicit report wins over its text. */
    for (const backgroundWork of ["host", "client"] as const) {
      it(`wakes the Firstmate for an approval relayed by reply with the plan card up and unchanged (${backgroundWork} background work)`, async () => {
        const { supervisor, crewmate, card, cards, ops, sorts, specs, tasks, taskId } =
          await plannerWithCard(backgroundWork);

        // Ordinary feedback stays quiet: the card still holds the turn.
        supervisor.cardActions.replyToCard(card.id, "say which decision moves");
        await tick();
        specs[0]?.onReply?.({
          cardId: card.id,
          text: "Decision 5 moves; the rest stand.",
          answersMessage: askedOn(supervisor, card.id),
        });
        specs[0]?.onReport?.("Answered the captain's question under the plan card.");
        await endTurn(crewmate, taskId);
        expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });
        expect(reportWakes(ops)).toHaveLength(0);

        // The approval by reply: one thread line, the card unchanged, the
        // relay declared.
        supervisor.cardActions.replyToCard(card.id, APPROVAL);
        await tick();
        specs[0]?.onReply?.({
          cardId: card.id,
          text: "Firstmate starts the builder next.",
          answersMessage: askedOn(supervisor, card.id),
        });
        expect(specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK })).toBe(
          "Reported. The first mate is woken for it when this turn ends.",
        );
        await endTurn(crewmate, taskId);

        expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "needs-firstmate" });
        expect(reportWakes(ops)).toHaveLength(1);
        const wake = reportWakes(ops)[0] ?? "";
        expect(wake).toContain(APPROVAL);
        expect(wake).toContain(
          `It asks the first mate to act: ${ASK}. The ask authorizes nothing by itself; the captain's own words do.`,
        );
        // The card is still up with its buttons; nothing was chosen for him.
        expect(cards().find((entry) => entry.id === card.id)?.actions).toEqual(card.actions);
        // The record keeps the request beside the report it rode.
        expect(
          tasks
            .timeline(taskId)
            .filter((event) => event.kind === "report")
            .at(-1),
        ).toMatchObject({
          text: RELAY,
          data: expect.objectContaining({ needsFirstmate: ASK }),
        });
        expect(tasks.get(taskId)?.delivery?.captainWait).toBeUndefined();
      });
    }

    // FI3-696's withdrawn card sat until INF-11: a report nothing holds now
    // wakes on any backend, and only the declaration carries the ask.
    it("wakes the Firstmate for the same relay after the planner withdrew its card, and names the ask only when declared", async () => {
      const { supervisor, crewmate, card, ops, sorts, specs, taskId } =
        await plannerWithCard("client");
      supervisor.cardActions.replyToCard(card.id, APPROVAL);
      await tick();
      // FI3-696's turn: the card withdrawn and the approval reported, with
      // nothing that says the Firstmate must act.
      specs[0]?.onCloseCard?.({ cardId: card.id, reason: "the captain approved it by reply" });
      expect(specs[0]?.onReport?.(RELAY)).toBe(
        "Reported. It goes on your task's record when this turn ends; whether the first mate is woken for it depends on your task's state. If the first mate must act on it, report again with needs_firstmate.",
      );
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "cannot-tell" });
      expect(reportWakes(ops)).toHaveLength(1);
      expect(reportWakes(ops)[0]).not.toContain("It asks the first mate to act");

      await supervisor.steer.steerCrewmate(taskId, "go on");
      await tick();
      specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK });
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "needs-firstmate" });
      expect(reportWakes(ops)).toHaveLength(2);
      expect(reportWakes(ops)[1]).toContain(`It asks the first mate to act: ${ASK}.`);
    });

    // INF-3202: work filed from a relayed approval quoted the planner's
    // first message, because the report named the captain's words in text
    // only. A report that names the card he replied under keeps his words,
    // so the filed work quotes the approval itself.
    it("keeps the captain's approval words a relay names, with when he typed them", async () => {
      const { supervisor, crewmate, card, ledgerFacts, specs, tasks, taskId } =
        await plannerWithCard("client");
      supervisor.cardActions.replyToCard(card.id, APPROVAL);
      await tick();
      const typed = supervisor.cards.messages(card.id).findLast((line) => line.who === "captain");
      specs[0]?.onReply?.({
        cardId: card.id,
        text: "Firstmate starts the builder next.",
        answersMessage: askedOn(supervisor, card.id),
      });
      // Where he typed nothing, the report is refused with the fix.
      expect(() =>
        specs[0]?.onReport?.(RELAY, undefined, {
          needsFirstmate: ASK,
          captainWordsFrom: CREWMATE_TAB_VIA,
        }),
      ).toThrow(
        `Report refused: captain_words_from names ${CREWMATE_TAB_VIA}, but the record holds no words the captain typed in ${tasks.get(taskId)?.key}'s Crewmate tab`,
      );
      specs[0]?.onReport?.(RELAY, undefined, {
        needsFirstmate: ASK,
        captainWordsFrom: ` ${card.id} `,
      });
      await endTurn(crewmate, taskId);
      const words = { text: APPROVAL, at: typed?.at };
      expect(ledgerFacts.at(-1)).toMatchObject({ kind: "report", captainWords: words });
      expect(
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "report")
          .at(-1)?.data?.captainWords,
      ).toEqual({ from: card.id, ...words });
    });

    it("answers the captain's reply first: a request beside an unanswered reply says so and wakes nobody", async () => {
      const { supervisor, crewmate, card, ops, sorts, specs, taskId } =
        await plannerWithCard("client");
      supervisor.cardActions.replyToCard(card.id, APPROVAL);
      await tick();
      expect(specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK })).toContain(
        "only if the captain's reply under your card has your answer by then",
      );
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "thread-unanswered" });
      expect(reportWakes(ops)).toHaveLength(0);
    });

    it("rides the durable report wake: one report per turn, and a repeated relay queues once", async () => {
      const { supervisor, crewmate, card, inbox, specs, sorts, taskId } =
        await plannerWithCard("client");
      const queued: (number | null)[] = [];
      supervisor.setFirstmateHooks({
        notifyOp: (wake, origin, ref) =>
          queued.push(inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref)),
        retryConverse: vi.fn(),
      });
      supervisor.cardActions.replyToCard(card.id, APPROVAL);
      await tick();
      specs[0]?.onReply?.({
        cardId: card.id,
        text: "Firstmate starts the builder next.",
        answersMessage: askedOn(supervisor, card.id),
      });
      // The same call twice in one turn is one report and one sort.
      specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK });
      specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK });
      await endTurn(crewmate, taskId);
      // The same relay on a later turn says nothing new: the inbox keeps one.
      await supervisor.steer.steerCrewmate(taskId, "go on");
      await tick();
      specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: ASK });
      await endTurn(crewmate, taskId);
      expect(sorts.slice(-2).map((sort) => sort.rule)).toEqual([
        "needs-firstmate",
        "needs-firstmate",
      ]);
      expect(queued).toHaveLength(2);
      expect(queued[1]).toBeNull();
      expect(
        inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => renderWake(row).includes(ASK)),
      ).toHaveLength(1);
    });

    it("refuses a request with no reason, and keeps nothing of it", async () => {
      const { specs, tasks, taskId } = await plannerWithCard("client");
      expect(() => specs[0]?.onReport?.(RELAY, undefined, { needsFirstmate: "  " })).toThrow(
        /needs_firstmate needs a reason/,
      );
      expect(tasks.timeline(taskId).at(-1)?.data).not.toMatchObject({ needsFirstmate: "  " });
    });
  });
});

/**
 * A crewmate whose backend reports a turn's usage only once the turn
 * settles, as Claude's does: an abort just asks, the cut turn's `turn_end`
 * arrives after the abort returned, and the session is gone (`closed()`)
 * only when that turn has settled.
 */
function settlingCrewmate(): FakeCrewmate & {
  settleCut: (taskId: string, usage: { input: number; output: number; cost: number }) => void;
} {
  const crewmate = fakeCrewmate();
  const gone = deferred<void>();
  let disposed = false;
  const settle = crewmate.finishPrompt;
  return Object.assign(crewmate, {
    dispose: vi.fn(() => {
      disposed = true;
      if (!crewmate.isStreaming()) gone.resolve();
    }),
    closed: () => gone.promise,
    settleCut: (taskId: string, usage: { input: number; output: number; cost: number }) => {
      crewmate.emit({ type: "turn_end", taskId, usage });
      crewmate.emit({ type: "turn_closed" });
      settle();
      if (disposed) gone.resolve();
    },
  });
}

describe("a turn cut by a close still reaches the usage ledger", () => {
  const usage = { input: 1200, output: 340, cost: 0.42 };

  it("records the turn a close interrupted once it settles, exactly once", async () => {
    const crewmate = settlingCrewmate();
    const recordUsage = vi.fn();
    const { supervisor, tasks, events } = setup(crewmate, { recordUsage });
    const { taskId } = await supervisor.intake.commission({
      title: "Answer the rivet question",
      intent: intentOf("how many rivets hold the hatch?"),
    });
    await tick();
    expect(crewmate.isStreaming()).toBe(true);

    await supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
    });
    expect(crewmate.aborts).toEqual([undefined]);
    expect(tasks.get(taskId)?.status).toBe("done");
    expect(recordUsage).not.toHaveBeenCalled();

    // The interrupted turn's result arrives after the close returned.
    crewmate.settleCut(taskId, usage);
    await tick();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith({
      taskId,
      model: { provider: "fm-mock", id: "mock-1" },
      usage,
    });
    // Only the usage: the closed task's feed and record are not the cut
    // turn's to change.
    expect(events.some((event) => event.type === "turn_end")).toBe(false);
    expect(tasks.get(taskId)?.status).toBe("done");

    // The session is gone: nothing it says later is heard.
    crewmate.emit({ type: "turn_end", taskId, usage });
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it("records context-shortening work that settles after the task closes", async () => {
    const crewmate = settlingCrewmate();
    const recordUsage = vi.fn();
    const { supervisor } = setup(crewmate, { recordUsage });
    const { taskId } = await supervisor.intake.commission({
      title: "Shorten before answering",
      intent: intentOf("answer the question"),
    });
    await tick();
    await supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
    });
    crewmate.emit({
      type: "tool_end",
      taskId,
      callId: `${taskId}:compaction`,
      toolName: "compact_context",
      isError: false,
      usage,
    });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ taskId, usage }));
    crewmate.settleCut(taskId, { input: 1, output: 1, cost: 0.01 });
    await tick();
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it("counts a turn that settled during the abort once, through the task itself", async () => {
    const crewmate = fakeCrewmate();
    const recordUsage = vi.fn();
    const { supervisor } = setup(crewmate, { recordUsage });
    const { taskId } = await supervisor.intake.commission({
      title: "Answer the hatch question",
      intent: intentOf("which hatch leaks?"),
    });
    await tick();
    // A backend whose abort waits for its turn (Pi's): the usage lands
    // while the task still hears the session.
    crewmate.abort = async () => {
      crewmate.emit({ type: "turn_end", taskId, usage });
      crewmate.finishPrompt();
    };

    await supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId, usage });
    await tick();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ taskId, usage }));
  });

  it("records the rejected attempt's cut turn when an escalation supersedes it", async () => {
    const attempt = settlingCrewmate();
    const recordUsage = vi.fn();
    const { supervisor, tasks } = setup(attempt, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      recordUsage,
      crewmates: [fakeCrewmate()],
    });
    const { taskId: previousId } = await supervisor.intake.commission({
      title: "Fix the flaky meter test",
      intent: intentOf("fix the flaky meter test"),
    });
    await tick();
    const previous = tasks.get(previousId);
    if (!previous) throw new Error("the attempt has no record");

    await supervisor.intake.commission({
      title: "Fix the flaky meter test",
      intent: intentOf("that is not a fix, try again"),
      shape: { escalate_from: previous.key },
    });
    await tick();
    expect(tasks.get(previousId)).toMatchObject({ status: "dropped", closedReason: "superseded" });
    expect(recordUsage).not.toHaveBeenCalled();

    attempt.settleCut(previousId, usage);
    await tick();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: previousId, usage }),
    );
  });

  it("records a turn the retention purge cut", async () => {
    const crewmate = settlingCrewmate();
    const recordUsage = vi.fn();
    const { supervisor, tasks } = setup(crewmate, { recordUsage });
    const { taskId } = await supervisor.intake.commission({
      title: "Count the rivets",
      intent: intentOf("count the rivets"),
    });
    await tick();

    await supervisor.purgeAllTasks();
    expect(tasks.get(taskId)).toBeUndefined();
    crewmate.settleCut(taskId, usage);
    await tick();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ taskId, usage }));
  });

  it("holds the quit until a cut turn settles, records it, and leaves the task to resume", async () => {
    const crewmate = settlingCrewmate();
    const recordUsage = vi.fn();
    const { supervisor, tasks, ops } = setup(crewmate, { recordUsage });
    const { taskId } = await supervisor.intake.commission({
      title: "Count the rivets",
      intent: intentOf("count the rivets"),
    });
    await tick();
    const opsBefore = ops.length;

    let quit = false;
    const quitting = supervisor.disposeAll().then(() => {
      quit = true;
    });
    await tick();
    expect(quit).toBe(false);
    crewmate.settleCut(taskId, usage);
    await quitting;
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ taskId, usage }));
    // A quit is not a close: the record stays where the next launch finds
    // it, and no report or wake is made of the cut turn.
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(ops.length).toBe(opsBefore);
  });

  it("never holds the quit past its bound for a client that does not answer", async () => {
    const crewmate = settlingCrewmate();
    const { supervisor } = setup(crewmate);
    await supervisor.intake.commission({ title: "Count", intent: intentOf("count the rivets") });
    await tick();
    vi.useFakeTimers();

    let quit = false;
    const quitting = supervisor.disposeAll().then(() => {
      quit = true;
    });
    await vi.advanceTimersByTimeAsync(QUIT_SETTLE_MS - 1);
    expect(quit).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    expect(quit).toBe(true);
  });
});

describe("a cardless internal step's report", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const byTitle = {
    classify: async (input: KindInput) =>
      input.title.startsWith("Reproduce")
        ? ({ kind: "reproduce", source: "classifier:test", version: "kc1" } as const)
        : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
  };
  const ANSWER =
    "reproduced: yes\n\nThe card's Checks cell is fixed when the card goes up. The failing check is in crewSupervisor.test.ts.";

  async function scenario(backgroundWork: "host" | "client") {
    const base = fakeCrewmate();
    const crewmate: FakeCrewmate = {
      ...base,
      controlProfile: backgroundWork === "client" ? CLAUDE_CONTROL_PROFILE : PI_CONTROL_PROFILE,
    };
    const harness = setup(crewmate, { classifier: byTitle });
    const { supervisor, tasks, inbox, ops } = harness;
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => {
        const id = inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref);
        ops.push(`[${origin}] ${served(wake)}`);
        if (id !== null) {
          inbox.markDelivered([id]);
          inbox.ack([id]);
        }
      },
      retryConverse: vi.fn(),
    });
    // The sequence as the Firstmate opens it (docs/sequences.md): a parent
    // on request, the reproduce step running as a declared internal step,
    // and the fix step planned on request with the step as its basis.
    const parent = supervisor.intake.plan({
      title: "Check results stay stale",
      intent: intentOf("it seems this is not updated when the external status changes"),
    });
    const step = await supervisor.intake.commission({
      title: "Reproduce: check results stay stale after GitHub changes",
      intent: {
        goal: "Reproduce a shown check result staying unchanged",
        userWords: "it seems this is not updated when the external status changes",
        constraints: [{ kind: "read-only" }],
      },
      parent: parent.key,
      shape: { internal_step: true },
    });
    await tick();
    const stepKey = tasks.get(step.taskId)?.key ?? step.taskId;
    const fix = supervisor.intake.plan({
      title: "Fix: refresh check results everywhere from one source",
      intent: intentOf("fix it"),
      parent: parent.key,
      shape: { basis: stepKey },
    });
    return { ...harness, crewmate, parent, step, stepKey, fix };
  }

  for (const backgroundWork of ["host", "client"] as const) {
    for (const reportVia of ["tool", "final-text"] as const) {
      it(`wakes the Firstmate when the step reports its answer (${backgroundWork} background work, ${reportVia})`, async () => {
        const { crewmate, specs, step, fix, tasks, ops, sorts, ledgerFacts, supervisor } =
          await scenario(backgroundWork);
        const taskId = step.taskId;
        // The crewmate does exactly what its brief says: the answer as its
        // report, no card, and no declaration its tool descriptions allow.
        if (reportVia === "tool") {
          const receipt = specs[0]?.onReport?.(ANSWER, "Reproduced: the strip is frozen at emit.");
          expect(receipt).toContain("Your internal step's report is handed to the first mate");
        } else {
          crewmate.emit({ type: "assistant_delta", taskId, text: ANSWER });
        }
        crewmate.emit({ type: "turn_end", taskId });
        crewmate.finishPrompt();
        await tick();
        expect(tasks.get(taskId)?.shape).toMatchObject({
          internal_step: true,
          deliverable: "answer",
          kind: "reproduce",
        });
        expect(tasks.get(fix.id)?.status).toBe("open");
        expect(supervisor.cards.snapshot()).toHaveLength(0);
        expect(ledgerFacts.at(-1)).toMatchObject({ kind: "report" });
        // The failing check: the step's report is the Firstmate's cue to start
        // the next step (docs/sequences.md), so it must wake the Firstmate now.
        expect(sorts.find((sort) => sort.taskId === taskId)?.rule).toBe("step-answered");
        expect(ops.filter((line) => line.includes("reported on task")).length).toBeGreaterThan(0);
      });
    }
  }
  for (const backgroundWork of ["host", "client"] as const) {
    it(`an internal step owns its decision, reply and captain-choice handoff (${backgroundWork})`, async () => {
      const { crewmate, specs, step, fix, tasks, ops, sorts, supervisor, inbox } =
        await scenario(backgroundWork);
      const taskId = step.taskId;
      specs[0]?.onCard?.({
        id: "repro-choice",
        title: "The link did not reproduce",
        body: "<p>The link opened in fourteen clean runs.</p><p>Logging a refresh would narrow the cause.</p>",
        actions: [
          { id: "log", label: "Add logging", default: true },
          { id: "stop", label: "Stop here" },
        ],
      });
      specs[0]?.onReport?.("reproduced: no - fourteen clean runs; logging would narrow the cause.");
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      const card = supervisor.cards.snapshot().find((entry) => entry.taskId === taskId)!;
      expect(card.author).toBe("crewmate");
      expect(sorts.at(-1)?.rule).toBe("captain-card");
      expect(ops).toEqual([]);
      expect(tasks.get(fix.id)?.status).toBe("open");

      const before = crewmate.promptCalls.length;
      supervisor.cardActions.replyToCard(card.id, "What does logging cost?");
      await tick();
      expect(crewmate.promptCalls.slice(before).join("\n")).toContain("What does logging cost?");
      expect(ops).toEqual([]);
      specs[0]?.onReply?.({
        cardId: card.id,
        text: "Logging adds no account access.",
        answersMessage: askedOn(supervisor, card.id),
      });
      specs[0]?.onReport?.("The choice remains logging or stopping.");
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      expect(sorts.at(-1)?.rule).toBe("captain-card");
      expect(ops).toEqual([]);

      supervisor.cardActions.act(card.id, "log");
      await tick();
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
      expect(
        tasks
          .timeline(taskId)
          .find((event) => (event.data as { reason?: string } | null)?.reason === "answered"),
      ).toMatchObject({
        actor: "captain",
      });
      expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ facts: expect.objectContaining({ kind: "answer-closed" }) }),
        ]),
      );
      expect(tasks.get(fix.id)?.status).toBe("open");
      if (process.env.INFINITARY_OWNERSHIP_PROOF_DIR) {
        mkdirSync(process.env.INFINITARY_OWNERSHIP_PROOF_DIR, { recursive: true });
        writeFileSync(
          join(process.env.INFINITARY_OWNERSHIP_PROOF_DIR, `owner-${backgroundWork}.json`),
          JSON.stringify(
            {
              card,
              deliveredReplies: crewmate.promptCalls.slice(before),
              sorts,
              handoff: inbox.allFor(FIRSTMATE_RECIPIENT),
              closedAnswer: tasks.get(taskId),
              nextStep: tasks.get(fix.id),
            },
            null,
            2,
          ),
        );
      }
    });
  }
});

it("completed context shortening reaches the task ledger and every Usage grouping once", async () => {
  const crewmate = fakeCrewmate();
  const now = Date.now();
  let ledger: UsageStore;
  const { supervisor, db } = setup(crewmate, {
    recordUsage: (input) => ledger.record({ ...input, at: now }),
  });
  ledger = new UsageStore(db);
  const { taskId } = await supervisor.intake.commission({
    title: "Shorten context",
    intent: intentOf("do the work"),
  });
  await tick();
  const translate = piSessionEvents(taskId);
  const emit = (event: unknown) => {
    for (const normalized of translate(event)) crewmate.emit(normalized);
  };
  emit({ type: "compaction_start", reason: "overflow" });
  const end = {
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    result: {
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 4,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      },
    },
  };
  emit(end);
  emit({ ...end });
  crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2, cost: 0.01 } });
  const row = ledger.byTask()[0];
  expect(row).toMatchObject({
    task_id: taskId,
    input: 110,
    output: 22,
    cache_read: 30,
    cache_write: 4,
    cost: 0.38,
    records: 2,
  });
  const summary = ledger.summary(
    { period: "all", scope: "all" },
    { now, names: { model: (ref) => ref.id, provider: (provider) => provider } },
  );
  expect(summary.total).toMatchObject({
    records: 2,
    tokens: { input: 110, output: 22, cacheRead: 30, cacheWrite: 4 },
    cost: 0.38,
  });
  expect(summary.models[0]?.amount).toEqual(summary.total);
  expect(summary.days[0]?.amount).toEqual(summary.total);
  expect(summary.where.projects[0]?.amount).toEqual(summary.total);
  expect(
    ledger.tasks({ period: "all", scope: "task", limit: 10 }, { now }).tasks[0]?.amount,
  ).toEqual(summary.total);
});
