/**
 * A crewmate's turn as `CrewTurns` ends it when something fails
 * (docs/report-sort.md): a provider-failed turn reported, never dropped, Pi's
 * retries of a cut request, the sign-in card a typed sign-out raises, the
 * needs_reauth card, and recorded crewmate sessions replayed for their wakes.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { readFileSync } from "node:fs";
import {
  CLAUDE_ACCESS_REFUSED_LINE,
  CLAUDE_ACCESS_SIGN_IN_TITLE,
  claudeAccessRefusedText,
} from "@shared/claudeAccess";
import { NEEDS_REAUTH_CONSEQUENCE } from "@shared/credentialHealth";
import { PLAIN_PROBLEM_FALLBACK } from "@shared/plainProblem";
import { CLAUDE_PROVIDER_ID, COPILOT_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  queuedGuidanceLines,
  served,
  setup,
  syncCardId,
  tick,
  workComputer,
} from "../../../tests/helpers/crewHarness";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { piSessionEvents } from "../pi/piEvents";
import { holdingRecoverableAttempt } from "../pi/session";
import type { SessionEvent } from "../session/session";
import { ActivityStore } from "../storage/activityStore";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { legacyStateOf } from "../tasks/seedTask";
import { recentFeed, taskFeedLine } from "../tasks/taskFeed";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { QUEUED_GUIDANCE_LINE } from "./crewTurns";
import { PROVIDER_SIGN_IN_TITLE } from "./hostCards";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("pauses dispatch on typed GitHub askpass auth and resumes after Projects sign-in", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, cards, events } = setup(crewmate);
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new ForgeAuthRequiredError("could not read Username for GitHub"),
    );

    const { taskId, started } = await supervisor.intake.commission({
      title: "Update the GitHub project",
      intent: intentOf("update the project"),
    });
    // The spawn answers before its start runs (INF-3060); the start then
    // waits for the sign-in.
    await started;
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: { kind: "captain", ref: "forge-sign-in:github.com" },
    });
    await vi.waitFor(() =>
      expect(cards().find((card) => card.id === "card-forge-github.com")?.actions[0]).toMatchObject(
        {
          effect: { kind: "open", target: "projects", signIn: "github.com" },
        },
      ),
    );
    expect(events.some((event) => event.type === "task_started")).toBe(false);

    await supervisor.resumeForgeSignInTasks("github.com");
    await vi.waitFor(() => expect(tasks.get(taskId)?.status).toBe("active"));
    expect(workspace.createTaskWorktree).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "task_started")).toBe(true);
  });

  it("persists and routes a provider-initiated report exactly once without a captain nudge", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, events, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Finish background checks",
      intent: intentOf("finish the background checks"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");

    crewmate.emit({ type: "continuation_started" });
    expect(legacyStateOf(tasks.get(taskId))).toBe("running");
    await supervisor.steer.steerCrewmate(taskId, "include the latest branch head");
    // The steer names the lane row it delivers.
    expect(crewmate.steer).toHaveBeenCalledWith(
      "include the latest branch head",
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
    expect(specs[0]?.onReport?.("Background checks passed on the latest branch head.")).toContain(
      "Reported",
    );
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "continuation_ended" });
    // A duplicated provider completion cannot persist or route the result twice.
    crewmate.emit({ type: "continuation_ended" });
    await tick();

    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(tasks.get(taskId)?.outcome).toBe("Background checks passed on the latest branch head.");
    expect(tasks.timeline(taskId).filter((event) => event.kind === "report")).toHaveLength(1);
    expect(events.filter((event) => event.type === "task_report")).toHaveLength(1);
    expect(ops.filter((line) => line.includes("reported on task"))).toHaveLength(1);

    // A later autonomous failure uses the same boundary and keeps the task
    // idle and steerable rather than silently disappearing.
    crewmate.emit({ type: "continuation_started" });
    crewmate.emit({ type: "turn_failed", taskId, error: "Background command failed." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "continuation_ended", error: "Background command failed." });
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(ops.at(-1)).toContain("Background command failed");
  });

  // INF-849: the captain's "this card should display task key, not crewmate
  // number" - a sign-in refused as a turn starts keeps the task, so the card
  // carries it and the head reads its key and title.
  it("raises a decision card and notifies the agent when a task fails auth-shaped", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops, tasks, workspace } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Promote the latest alpha",
      intent: intentOf("do something"),
    });
    // The turn must be in flight before it can fail: a fixed tick lost the
    // race under a loaded suite and `failPrompt` failed nothing.
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    // Pi's real pre-flight text when a provider's credentials are gone.
    crewmate.failPrompt("Authentication failed for \"openai-codex\". Run '/login' again.");
    // The card rides a debounced broadcast, so wait for the card itself.
    await vi.waitFor(() =>
      expect(cards().find((card) => card.actions.length > 0)?.title).toBe(PROVIDER_SIGN_IN_TITLE),
    );
    const decision = cards().find((card) => card.actions.length > 0);
    // The agent-down set keeps its host card, with exactly its one way out.
    expect(decision?.author).toBe("host");
    expect(decision?.actions.map((a) => a.id)).toEqual(["open-settings"]);
    expect(decision?.taskId).toBe(taskId);
    expect(decision?.meta).toBe("Promote the latest alpha");
    expect(ops.at(-1)).toContain("failed");
    // The task stays open and idle with its working copy, never closed failed.
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    const result = supervisor.cardActions.act(decision?.id ?? "", "open-settings");
    // Sign-in is on the Intelligence tab: the way out lands there, not on General.
    expect(result.effect).toEqual({ kind: "open", target: "subscriptions" });
    await tick();
    expect(cards().find((card) => card.actions.length > 0)).toBeUndefined();
  });

  // INF-849: the captain's "it should offer an option to swap the crewmate to
  // a different provider" - the sign-in card's default moves the task to the
  // app's pick, with the failed provider left out, keeping its key, branch
  // and working copy; between two Pi providers the conversation goes on.
  it("offers Move to the app's pick on a crewmate's sign-in card, and the click moves the task in place", async () => {
    const copilot = { provider: COPILOT_PROVIDER_ID, id: "gpt-5.1" };
    const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const crewmate = fakeCrewmate({ model: copilot });
    const moved = fakeCrewmate({ model: codex });
    const left: (string | undefined)[] = [];
    const { supervisor, cards, tasks, sessionSpecs, specs, workspace, events } = setup(crewmate, {
      routedModel: copilot,
      crewmates: [moved],
      accounts: {
        selectForSpawn: (_taskId, provider) =>
          provider === "openai-codex" ? "acct_codex" : "acct_copilot",
        reselectForResume: () => ({ changed: false }),
        labelOf: () => undefined,
      },
      movePick: (_shape, options) => {
        left.push(options.withoutProvider);
        return options.withoutProvider === COPILOT_PROVIDER_ID ? codex : undefined;
      },
      modelName: (model) => (model.id === codex.id ? "GPT-6.1 Sol" : model.id),
    });
    const { taskId, started } = await supervisor.intake.commission({
      title: "Promote the latest alpha",
      intent: intentOf("do something"),
    });
    // Its branch and working copy are made behind the spawn's answer (INF-3060).
    await started;
    const before = tasks.get(taskId);
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    // INF-839's own words, thrown as its turn started.
    crewmate.failPrompt(`No API key found for ${COPILOT_PROVIDER_ID}`);
    await vi.waitFor(() =>
      expect(cards().find((card) => card.id === `card-auth-${taskId}`)).toBeDefined(),
    );
    const card = cards().find((card) => card.id === `card-auth-${taskId}`);
    expect(left).toContain(COPILOT_PROVIDER_ID);
    expect(card?.actions.map((action) => [action.label, action.default === true])).toEqual([
      // The captain's words: show "Move to <model>", the model it would run on.
      ["Move to GPT-6.1 Sol", true],
      ["Open settings", false],
    ]);
    // A message the captain sent meanwhile is tried again on Copilot, and the
    // click waits for that turn to end: a turn is never cut short.
    await supervisor.steer.steerCrewmate(taskId, "the release run finished");
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(2));
    supervisor.cardActions.act(card?.id ?? "", "move-task");
    await tick();
    expect(specs).toHaveLength(1);
    crewmate.failPrompt(`No API key found for ${COPILOT_PROVIDER_ID}`);
    await vi.waitFor(() => expect(moved.promptCalls.length).toBeGreaterThan(0));
    const after = tasks.get(taskId);
    expect(after).toMatchObject({
      key: before?.key,
      status: "active",
      branch: before?.branch,
      worktreeDir: before?.worktreeDir,
      model: "openai-codex/gpt-6.1-sol",
      accountId: "acct_codex",
    });
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    // The same conversation, reopened in the same working copy on the new model.
    expect(specs.at(-1)).toMatchObject({
      resumeToken: "/tmp/s1.jsonl",
      model: codex,
      cwd: before?.worktreeDir,
    });
    expect(sessionSpecs.at(-1)?.binding).toMatchObject({ accountId: "acct_codex" });
    expect(crewmate.dispose).toHaveBeenCalled();
    expect(moved.promptCalls.join("\n")).toContain("the release run finished");
    // The history says who moved it, and the card is down.
    expect(tasks.timeline(taskId).map((event) => [event.actor, event.text])).toContainEqual([
      "captain",
      "the captain moved it from Copilot to GPT-6.1 Sol on Codex",
    ]);
    await tick();
    expect(cards().find((entry) => entry.id === `card-auth-${taskId}`)).toBeUndefined();
    expect(events.some((event) => event.type === "task_finished")).toBe(false);
  });

  it("never mints the sign-in card for a failure that only sounds auth-shaped", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops } = setup(crewmate);
    await supervisor.intake.commission({ title: "t", intent: intentOf("do something") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    crewmate.failPrompt("Error Code null: Internal error during token generation");
    await vi.waitFor(() => expect(ops.at(-1)).toContain("failed"));
    // Any card the failure raised was broadcast on a shorter timer than this.
    await tick();
    expect(cards().find((card) => card.title === PROVIDER_SIGN_IN_TITLE)).toBeUndefined();
  });

  it("reports a provider-failed turn instead of '(no report)' and keeps the crewmate steerable", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, cards, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Refactor auth",
      intent: intentOf("do the work"),
    });
    await tick();

    // Pi resolves a provider-failed turn: turn_failed + turn_end, then the
    // prompt promise resolves normally (the report's REPRO A).
    crewmate.emit({
      type: "turn_failed",
      taskId,
      error: "Error Code null: Internal error during token generation",
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    // The failure reached every surface: the enriched feed event, the
    // agent's inbox - and never a fake "reported" line.
    const failedEvent = events.find((e) => e.type === "turn_failed");
    expect(failedEvent).toMatchObject({
      taskId,
      crewmate: "crewmate 1",
      title: "Refactor auth",
      error: "Error Code null: Internal error during token generation",
    });
    expect(events.find((e) => e.type === "task_report")).toBeUndefined();
    expect(ops.at(-1)).toContain("turn on task");
    expect(ops.at(-1)).toContain("failed at the provider: Error Code null");
    // The honest retry owns the brief it carried (docs/inbox.md).
    expect(ops.at(-1)).toContain("retries it on its own");
    expect(ops.at(-1)).toContain("You can still steer or interrupt it.");
    // Transient fault, not auth: no sign-in card.
    expect(cards().find((card) => card.title === PROVIDER_SIGN_IN_TITLE)).toBeUndefined();

    // The session survives: still steerable, and the next clean turn
    // reports normally again.
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    await supervisor.steer.steerCrewmate(taskId, "try again");
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "All done." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(events.find((e) => e.type === "task_report")).toMatchObject({
      title: "Refactor auth",
      summary: "All done.",
    });
    // The provider answered, so the brief the failed turn carried is due at
    // once instead of waiting out its backoff: the next turn delivers it,
    // and the report meanwhile sorts as still moving.
    expect(crewmate.promptCalls.at(-1)).toBe(crewmate.promptCalls[0]);
    expect(ops.at(-1)).not.toContain("reported on task");
  });

  /**
   * Pi's order for one attempt (agent-loop.js emits turn_end then agent_end;
   * agent-session.js adds willRetry, and emits auto_retry_end after the next
   * assistant message). Fed through the same holder the session uses.
   */
  function pipePiAttempt(
    taskId: string,
    emit: (event: SessionEvent) => void,
  ): (event: unknown) => void {
    const translate = piSessionEvents(taskId);
    return holdingRecoverableAttempt((raw) => {
      for (const event of translate(raw)) emit(event);
    });
  }

  it("keeps the report when Pi retries a cut request and the retry succeeds", async () => {
    // INF-248, the fix started from INF-243: a lid close cuts the request,
    // Pi retries inside the same prompt, and a retry that works is the turn.
    const recorded: Array<{ input?: number; output?: number }> = [];
    const crewmate = fakeCrewmate();
    const { supervisor, events, ops, tasks, inbox } = setup(crewmate, {
      recordUsage: (input) => recorded.push(input.usage),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Lid close",
      intent: intentOf("do the work"),
    });
    await tick();
    const pipe = pipePiAttempt(taskId, (event) => crewmate.emit(event));
    pipe({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
        content: [{ type: "text", text: "partial" }],
        usage: { input: 11, output: 2, cost: { total: 0.01 } },
      },
      toolResults: [],
    });
    pipe({ type: "agent_end", willRetry: true, messages: [] });
    pipe({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2000,
      errorMessage: "terminated",
    });
    pipe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "All done." },
    });
    pipe({
      type: "auto_retry_end",
      success: true,
      attempt: 1,
    });
    pipe({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "All done." }],
        usage: { input: 4, output: 3, cost: { total: 0.02 } },
      },
      toolResults: [],
    });
    pipe({ type: "agent_end", willRetry: false, messages: [] });
    pipe({ type: "agent_settled", aborted: false });
    crewmate.finishPrompt();
    await tick();

    expect(events.find((event) => event.type === "turn_failed")).toBeUndefined();
    expect(recorded).toEqual([
      expect.objectContaining({ input: 11, output: 2, cost: 0.01 }),
      expect.objectContaining({ input: 4, output: 3, cost: 0.02 }),
    ]);
    expect(events.find((event) => event.type === "task_report")).toMatchObject({
      title: "Lid close",
      summary: "All done.",
    });
    expect(tasks.get(taskId)?.outcome).toBe("All done.");
    expect(ops.some((line) => line.includes("failed at the provider"))).toBe(false);
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(inbox.inFlight(taskId)).toEqual([]);
  });

  it("records an unknown custom count when the retried attempt is dropped", async () => {
    // INF-253: a custom request with no volunteered counts is an empty usage
    // record. The ledger still receives it after the attempt is dropped.
    const recorded: Array<Record<string, unknown>> = [];
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate, {
      recordUsage: (input) => recorded.push(input.usage),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Lid close",
      intent: intentOf("do the work"),
    });
    await tick();
    const pipe = pipePiAttempt(taskId, (event) => crewmate.emit(event));
    pipe({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
        provider: "fm-custom-0123456789abcdef",
        content: [],
        usage: { input: 0, output: 0 },
      },
      toolResults: [],
    });
    pipe({ type: "agent_end", willRetry: true, messages: [] });
    pipe({ type: "auto_retry_end", success: true, attempt: 1 });
    pipe({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "All done." }],
      },
      toolResults: [],
    });
    crewmate.finishPrompt();
    await tick();
    expect(recorded[0]).toEqual({});
  });

  it("still fails the turn when Pi's retry of a cut request does not succeed", async () => {
    // INF-248's other half: retries that run out still take the honest retry.
    // Both attempts' measured usage is kept; only the last failure stands.
    const recorded: Array<{ input?: number }> = [];
    const crewmate = fakeCrewmate();
    const { supervisor, events, ops, inbox } = setup(crewmate, {
      recordUsage: (input) => recorded.push(input.usage),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Lid close",
      intent: intentOf("do the work"),
    });
    await tick();
    const pipe = pipePiAttempt(taskId, (event) => crewmate.emit(event));
    const failed = (input: number) => ({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
        content: [],
        usage: { input, output: 1, cost: { total: 0.01 } },
      },
      toolResults: [],
    });
    pipe(failed(11));
    pipe({ type: "agent_end", willRetry: true, messages: [] });
    pipe({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2000,
      errorMessage: "terminated",
    });
    pipe(failed(17));
    pipe({ type: "agent_end", willRetry: false, messages: [] });
    pipe({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "terminated",
    });
    pipe({ type: "agent_settled", aborted: false });
    crewmate.finishPrompt();
    await tick();

    expect(events.find((event) => event.type === "task_report")).toBeUndefined();
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
    expect(ops.at(-1)).toContain("failed at the provider: terminated");
    expect(inbox.allFor(taskId).map((row) => row.failures)).toEqual([1]);
    expect(recorded.map((usage) => usage.input)).toEqual([11, 17]);
  });

  it("still fails the turn when a retry of a cut request is cancelled", async () => {
    // INF-248: cancelling the backoff is not a success. Pi emits auto_retry_end
    // success false and does not start another attempt.
    const crewmate = fakeCrewmate();
    const { supervisor, ops, inbox } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Lid close",
      intent: intentOf("do the work"),
    });
    await tick();
    const pipe = pipePiAttempt(taskId, (event) => crewmate.emit(event));
    pipe({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
        content: [],
      },
      toolResults: [],
    });
    pipe({ type: "agent_end", willRetry: true, messages: [] });
    pipe({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "Retry cancelled",
    });
    pipe({ type: "agent_settled", aborted: false });
    crewmate.finishPrompt();
    await tick();
    expect(ops.at(-1)).toContain("failed at the provider: terminated");
    expect(inbox.allFor(taskId).map((row) => row.failures)).toEqual([1]);
  });

  it("raises the sign-in decision and refs its wake when a turn has a real auth failure", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards } = setup(crewmate);
    const wakes: Array<{ text: string; origin: string; ref?: string }> = [];
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) =>
        wakes.push({ text: served(wake), origin, ...(ref ? { ref } : {}) }),
      retryConverse: vi.fn(),
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await tick();
    crewmate.emit({
      type: "turn_failed",
      taskId,
      error: '401: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const decision = cards().find((card) => card.title === PROVIDER_SIGN_IN_TITLE);
    expect(decision).toBeDefined();
    // Product words, never the provider's own reply.
    expect(decision?.body).toBe(
      "The crewmate could not reach its subscription, which needs you to sign in again.",
    );
    // An auth failure is a host operation, not a crewmate report.
    expect(wakes).toContainEqual(expect.objectContaining({ ref: taskId, origin: "agent" }));
  });

  it("names a custom connection on the sign-in card and says how to check it, never quoting Pi", async () => {
    const custom = { provider: "fm-custom-0123456789abcdef", id: "operator-large-model" };
    let model = custom;
    const crewmate = { ...fakeCrewmate(), modelRef: () => model } satisfies FakeCrewmate;
    const { supervisor, cards } = setup(crewmate, {
      accounts: {
        selectForSpawn: () => "acct_custom",
        reselectForResume: () => ({ changed: false }),
        labelOf: () => "Operator gateway",
      },
      routedModel: custom,
    });
    await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    // A connection whose model lost its check has no runtime: Pi's session no
    // longer knows the provider, and its preflight throws its own sign-in help.
    model = { provider: "unknown", id: custom.id };
    crewmate.failPrompt(
      [
        "No API key found for the selected model.",
        "",
        "Use /login to log into a provider via OAuth or API key. See:",
        "  /Applications/Firstmate 3000.app/Contents/Resources/app/node_modules/@earendil-works/pi-coding-agent/docs/providers.md",
        "  /Applications/Firstmate 3000.app/Contents/Resources/app/node_modules/@earendil-works/pi-coding-agent/docs/models.md",
      ].join("\n"),
    );
    await vi.waitFor(() =>
      expect(cards().find((card) => card.title === PROVIDER_SIGN_IN_TITLE)).toBeDefined(),
    );
    expect(cards().find((card) => card.title === PROVIDER_SIGN_IN_TITLE)?.body).toBe(
      "The crewmate could not reach Operator gateway, your custom connection. In Settings → Intelligence, press Edit on it, then Save to check it again.",
    );
  });

  it("raises the sign-in card once for a typed sign-out on a Claude crewmate, never reading its words", async () => {
    const crewmate = {
      ...fakeCrewmate(),
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client", failureSignals: "typed" },
      modelRef: () => ({ provider: CLAUDE_PROVIDER_ID, id: "claude-opus" }),
    } satisfies FakeCrewmate;
    const { supervisor, cards, tasks } = setup(crewmate);
    const wakes: Array<{ origin: string; ref?: string }> = [];
    supervisor.setFirstmateHooks({
      notifyOp: (_wake, origin, ref) => wakes.push({ origin, ...(ref ? { ref } : {}) }),
      retryConverse: vi.fn(),
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await tick();
    const signedOut = () => {
      // Words no prose classifier would read as a sign-in: the class decides.
      crewmate.emit({
        type: "turn_failed",
        taskId,
        error: "Failed to reach Claude.",
        cutOff: { class: "signed_out" },
      });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
    };
    signedOut();
    await tick();
    await supervisor.steer.steerCrewmate(taskId, "try again");
    await tick();
    signedOut();
    await tick();
    const signIn = cards().filter((card) => card.id === `card-auth-${taskId}`);
    expect(signIn).toHaveLength(1);
    expect(signIn[0]?.title).toBe(PROVIDER_SIGN_IN_TITLE);
    // Product words, never the client's own (they name a terminal command).
    expect(signIn[0]?.body).toBe(
      "The crewmate could not reach Claude, which needs you to sign in again.",
    );
    expect(wakes).toContainEqual({ ref: taskId, origin: "agent" });
    // The record keeps the class, and the feed line reads it, not the words.
    const failed = tasks
      .timeline(taskId)
      .filter((event) => event.kind === "failed")
      .at(-1);
    expect(failed?.data).toMatchObject({
      error: "Failed to reach Claude.",
      failureSignals: "typed",
      cutOff: { class: "signed_out" },
    });
    expect(taskFeedLine(tasks.get(taskId) as TaskRecord, failed as TaskEvent)?.text).toBe(
      "Problem: the provider did not accept your sign-in - sign in again",
    );
  });

  // INF-3449 review: Claude access set up for Claude Code is renewed where
  // the person renews it for Claude Code, and only this computer's access is
  // known here; a task on another computer keeps that computer's sign-in words.
  it.each([
    { on: "this computer", device: undefined },
    { on: "another computer", device: "mini" },
  ])(
    "words the sign-in card for Claude access from Claude Code settings on $on",
    async ({ device }) => {
      const crewmate = {
        ...fakeCrewmate(),
        controlProfile: {
          ...PI_CONTROL_PROFILE,
          backgroundWork: "client",
          failureSignals: "typed",
        },
        modelRef: () => ({ provider: CLAUDE_PROVIDER_ID, id: "claude-opus" }),
      } satisfies FakeCrewmate;
      const { supervisor, cards, tasks } = setup(crewmate, {
        accounts: {
          selectForSpawn: () => "acct_claude",
          reselectForResume: () => ({ changed: false }),
          labelOf: () => undefined,
          accessOf: () => "organization",
        },
        routedModel: { provider: CLAUDE_PROVIDER_ID, id: "claude-opus" },
        ...(device
          ? {
              machines: workComputer(device, "Mac mini", {
                cutOffOf: () => undefined,
                folders: () => undefined,
              }),
            }
          : {}),
      });
      const { taskId } = await supervisor.intake.commission({
        title: "t",
        intent: intentOf("work"),
      });
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
      if (device) tasks.placement.setDevice(taskId, device);
      crewmate.emit({
        type: "turn_failed",
        taskId,
        error: "Failed to reach Claude.",
        cutOff: { class: "signed_out" },
      });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await vi.waitFor(() =>
        expect(cards().find((card) => card.id === `card-auth-${taskId}`)).toBeDefined(),
      );
      const signIn = cards().find((card) => card.id === `card-auth-${taskId}`);
      expect(signIn?.body).toBe(
        device
          ? "The crewmate on Mac mini could not reach Claude, which needs you to sign in again on Mac mini."
          : claudeAccessRefusedText("The crewmate", "organization"),
      );
      // Its title names the refused access too, never a sign-in to redo.
      expect(signIn?.title).toBe(device ? PROVIDER_SIGN_IN_TITLE : CLAUDE_ACCESS_SIGN_IN_TITLE);
      // And so does its feed line, read back from the record.
      const failed = tasks
        .timeline(taskId)
        .filter((event) => event.kind === "failed")
        .at(-1);
      expect(taskFeedLine(tasks.get(taskId) as TaskRecord, failed as TaskEvent)?.text).toBe(
        device
          ? "Problem: the provider did not accept your sign-in - sign in again"
          : `Problem: ${CLAUDE_ACCESS_REFUSED_LINE.organization}`,
      );
    },
  );

  it("never reads a sign-in from a typed backend's words, and keeps other cut-offs on the provider-failure path", async () => {
    const crewmate = {
      ...fakeCrewmate(),
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client", failureSignals: "typed" },
    } satisfies FakeCrewmate;
    const { supervisor, cards, ops, tasks } = setup(crewmate);
    const lastFeedLine = () => {
      const failed = tasks
        .timeline(taskId)
        .filter((event) => event.kind === "failed")
        .at(-1);
      return taskFeedLine(tasks.get(taskId) as TaskRecord, failed as TaskEvent)?.text;
    };
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await tick();
    // Words that say 401, with no typed class: an ordinary failed turn.
    crewmate.emit({ type: "turn_failed", taskId, error: "401: invalid_api_key" });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(cards().find((card) => card.id === `card-auth-${taskId}`)).toBeUndefined();
    // The honest retry keeps its guidance, as for any provider failure.
    expect(ops.at(-1)).toContain("failed at the provider: 401: invalid_api_key");
    // Nor does the feed line read a sign-in out of those words.
    // It says the app retries on its own (INF-3714), never asking for a sign-in.
    expect(lastFeedLine()).toMatch(
      /^Problem: something went wrong - the app tries again on its own \(/,
    );
    // A spent allowance or a refusal keeps today's provider-failure path,
    // and its feed line is its class's.
    for (const [cutOff, line] of [
      [
        { class: "no_headroom", resetsAt: 1_800_000_000_000 },
        "Problem: your plan's allowance ran out - it comes back when it resets",
      ],
      [{ class: "refused" }, `Problem: ${PLAIN_PROBLEM_FALLBACK}`],
    ] as const) {
      await supervisor.steer.steerCrewmate(taskId, "again");
      await tick();
      crewmate.emit({ type: "turn_failed", taskId, error: "Not now.", cutOff });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      expect(cards().find((card) => card.id === `card-auth-${taskId}`)).toBeUndefined();
      expect(lastFeedLine()).toBe(line);
    }
  });

  it("records a typed backend's session failure as typed, so its words never read as a sign-in", async () => {
    const crewmate = {
      ...fakeCrewmate(),
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client", failureSignals: "typed" },
    } satisfies FakeCrewmate;
    const { supervisor, cards, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await tick();
    // The client exited, in words a prose classifier would read as a sign-in.
    crewmate.failPrompt("Claude Code process exited with code 1: 401 Unauthorized");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "failed" });
    expect(cards().find((card) => card.id === `card-auth-${taskId}`)).toBeUndefined();
    const closed = tasks.timeline(taskId).find((event) => event.data?.reason === "failed");
    expect(closed?.data).toMatchObject({
      reason: "failed",
      error: "Claude Code process exited with code 1: 401 Unauthorized",
      failureSignals: "typed",
    });
    expect(taskFeedLine(tasks.get(taskId) as TaskRecord, closed as TaskEvent)?.text).toBe(
      `Failed: ${PLAIN_PROBLEM_FALLBACK}`,
    );
  });
});

describe("needs_reauth card (CD-3=A)", () => {
  it("a proof-gated needs_reauth card is a singleton with a one-step Sign in restore", () => {
    const { supervisor } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addAuthDecisionCard(
      "card-auth-account-acct_cl1",
      "Claude",
      "Claude (Personal) needs you to sign in again.",
      { restoreAccountId: "acct_cl1" },
    );
    const card = supervisor.cards
      .snapshot()
      .find((entry) => entry.id === "card-auth-account-acct_cl1");
    expect(card?.title).toBe("Claude (Personal) needs you to sign in again.");
    expect(card?.body).toBe(NEEDS_REAUTH_CONSEQUENCE);
    expect(card?.actions.map((action) => action.id)).toEqual(["sign-in"]);
    expect(supervisor.cardActions.act(card?.id ?? "", "sign-in").effect).toEqual({
      kind: "open",
      target: "subscriptions",
      restoreAccountId: "acct_cl1",
    });
    expect(
      supervisor.cards.snapshot().find((entry) => entry.id === "card-auth-account-acct_cl1"),
    ).toBeUndefined();
  });

  it("clears a recovered needs_reauth card without leaving it on the stack", () => {
    const { supervisor } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addAuthDecisionCard(
      "card-auth-account-acct_cl1",
      "Claude",
      "Claude (Personal) needs you to sign in again.",
      { restoreAccountId: "acct_cl1" },
    );
    supervisor.cards.hostCards.clearAuthDecisionCard("card-auth-account-acct_cl1");
    expect(
      supervisor.cards.snapshot().find((entry) => entry.id === "card-auth-account-acct_cl1"),
    ).toBeUndefined();
  });
});

/**
 * Crewmate session replays (interaction P0, WI-1 + WI-2). Each fixture is a
 * Pi session JSONL reconstructed from the Sep 14 evidence timeline: every
 * user message starts a turn (the brief, a background job's result, a card
 * choice), every assistant message ends one Pi turn, and a `replay_control`
 * line cancels the task. The replay drives the real supervisor through the
 * same entry points production uses and counts what reached supervision.
 */
describe("crewmate session replays (Sep 14)", () => {
  type ReplayLine =
    | { type: "session" }
    | { type: "replay_control"; action: "cancel"; timestamp: string }
    | {
        type: "message";
        timestamp: string;
        message:
          | { role: "user"; content: string }
          | { role: "toolResult" }
          | {
              role: "assistant";
              content: Array<
                | { type: "text"; text: string }
                | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
              >;
            };
      };

  function readFixture(name: string): ReplayLine[] {
    const url = new URL(`../../../tests/fixtures/replay/${name}`, import.meta.url);
    return readFileSync(url, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ReplayLine);
  }

  async function replay(name: string) {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { supervisor, ops, specs } = harness;
    const lines = readFixture(name);
    let taskId = "";
    const cardIds: string[] = [];
    let cancelledAt: number | undefined;
    let wakesAtCancel = 0;
    // Every wake the turn ends earned the Firstmate: one lane since S7c.
    const wakes = () => ops.filter((line) => taskId && line.includes(taskId));
    for (const [index, line] of lines.entries()) {
      if (line.type === "replay_control") {
        wakesAtCancel = wakes().length;
        cancelledAt = Date.parse(line.timestamp);
        await supervisor.sessions.interruptCrewmate(taskId, "cancel");
        await tick();
        continue;
      }
      if (line.type !== "message") continue;
      const { message } = line;
      if (message.role === "user") {
        if (!taskId) {
          ({ taskId } = await supervisor.intake.commission({
            title: "Replay",
            intent: intentOf(message.content),
          }));
        } else if (message.content.startsWith("[job]")) {
          supervisor.watch.deliverJobResult(taskId, message.content);
        } else {
          const chosen = /\((\S+)\)\.$/.exec(message.content)?.[1] ?? "";
          supervisor.cardActions.act(cardIds.at(-1) ?? "", chosen);
        }
        await tick();
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "text") {
          crewmate.emit({ type: "assistant_delta", taskId, text: part.text });
        } else if (part.name === "emit_card") {
          const args = part.arguments as {
            title: string;
            body: string;
            actions: { id: string; label: string }[];
          };
          cardIds.push(syncCardId(specs[0]?.onCard?.(args)) ?? "");
        }
      }
      crewmate.emit({ type: "turn_end", taskId });
      // The prompt resolves after its last assistant message.
      const next = lines.slice(index + 1).find((entry) => entry.type !== "session");
      if (next?.type !== "message" || next.message.role === "user") {
        crewmate.finishPrompt();
        await tick();
      }
    }
    return {
      ...harness,
      taskId,
      cancelledAt,
      wakesEmitted: cancelledAt === undefined ? wakes().length : wakesAtCancel,
      // Wakes EMITTED after the cancel: one lane since S7c, and an emitted
      // wake cannot be taken back, so the count is what came after it.
      wakesAfterCancel: cancelledAt === undefined ? 0 : wakes().length - wakesAtCancel,
    };
  }

  it("ba13eadd: eleven empty-text turn ends and one garbage turn yield at most one wake, and none after the cancel", async () => {
    const run = await replay(
      "sep14/crewmates/ba13eadd/sessions/2026-09-14T02-18-13-396Z_ba13eadd.jsonl",
    );
    // Before WI-1/WI-2 (69a350ca): 12 wakes, all 12 still queued at the cancel.
    expect(run.wakesEmitted).toBeLessThanOrEqual(1);
    expect(run.wakesAfterCancel).toBe(0);
    expect(run.tasks.get(run.taskId)?.outcome ?? "").not.toContain("to=functions");
  });

  it("c9dab1e7: a plan card then a card-approved investigation yields no stale self-brief wakes", async () => {
    const run = await replay(
      "sep14/crewmates/c9dab1e7/sessions/2026-09-14T02-34-20-625Z_c9dab1e7.jsonl",
    );
    // Before WI-1 (69a350ca): 9 wakes, each re-sending the stale self-brief.
    expect(run.wakesEmitted).toBeLessThanOrEqual(1);
    expect(
      run.inbox.allFor("supervision").some((row) => renderWake(row).includes("Self-brief")),
    ).toBe(false);
  });

  it("lock refusals: the 21 Firstmate verbs refused during triage yield 0 refusals and every steer lands once", async () => {
    type LockLine =
      | { type: "source" }
      | { type: "task"; alias: string; title: string }
      | {
          type: "call";
          entry: string | null;
          task: string;
          verb: "steer";
          message: string;
        }
      | {
          type: "call";
          entry: string | null;
          task: string;
          verb: "interrupt";
          mode: "interrupt" | "cancel";
        };
    const url = new URL(
      "../../../tests/fixtures/replay/lock-refusals-sep14.jsonl",
      import.meta.url,
    );
    const lines = readFileSync(url, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LockLine);
    const crewmate = fakeCrewmate();
    const { supervisor, ops } = setup(crewmate);
    const ids = new Map<string, string>();
    for (const line of lines) {
      if (line.type !== "task") continue;
      const { taskId } = await supervisor.intake.commission({
        title: line.title,
        intent: intentOf(line.title),
      });
      await tick();
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      ids.set(line.alias, taskId);
    }

    const refusals: string[] = [];
    const steers: string[] = [];
    let calls = 0;
    for (const line of lines) {
      if (line.type !== "call") continue;
      calls += 1;
      const taskId = ids.get(line.task) ?? "";
      try {
        if (line.verb === "steer") {
          steers.push(line.message);
          await supervisor.steer.steerCrewmate(taskId, line.message);
        } else {
          await supervisor.sessions.interruptCrewmate(taskId, line.mode);
        }
      } catch (caught) {
        refusals.push(`${line.entry ?? line.task}: ${String(caught)}`);
      }
      await tick();
    }

    expect(calls).toBe(21);
    // Before WI-4 (f1f4443): 21 refusals, and every refused steer was lost.
    // S7c retired the claim that produced them, so there is nothing left to
    // refuse a steer - the fixture still proves every one is delivered once.
    expect(refusals).toEqual([]);
    expect(ops.filter((line) => line.includes("guidance"))).toEqual([]);
    const delivered = [
      ...crewmate.promptCalls,
      ...vi.mocked(crewmate.steer).mock.calls.map(([text]) => String(text)),
    ].join("\n\n");
    for (const message of steers) {
      expect(delivered.split(message).length - 1, message).toBe(1);
    }
  });

  it("guidance queued: steers that become next turns wake the Firstmate 0 times (Sep 14: 39)", async () => {
    // The Sep 14 steers from the lock-refusal fixture, each arriving while
    // the crewmate's turn runs on a backend that takes guidance only as the
    // next turn - the path that announced "the guidance queued ... is being
    // delivered now" to the Firstmate once per delivery before WI-5.
    const url = new URL(
      "../../../tests/fixtures/replay/lock-refusals-sep14.jsonl",
      import.meta.url,
    );
    const steers = readFileSync(url, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string; verb?: string; message?: string })
      .flatMap((line) =>
        line.type === "call" && line.verb === "steer" && line.message ? [line.message] : [],
      );
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, ops, tasks, db } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Replay",
      intent: intentOf("go"),
    });
    await tick();
    for (const message of steers) {
      expect(await supervisor.steer.steerCrewmate(taskId, message)).toBe("queued-next-turn");
      crewmate.finishPrompt();
      await tick();
    }

    expect(steers.length).toBeGreaterThan(10);
    expect(ops.filter((line) => line.startsWith("[fm-op]"))).toEqual([]);
    // Each delivery stays on the task's timeline, and Activity shows the
    // newest once: the captain's audit (INF-1137) found one busy task
    // repeating it up to ten times there.
    const announced = queuedGuidanceLines(tasks, taskId);
    expect(announced).toHaveLength(steers.length);
    const feed = recentFeed(tasks, new ActivityStore(db), 200);
    expect(feed.filter((line) => line.text === QUEUED_GUIDANCE_LINE)).toEqual([
      expect.objectContaining({ taskKey: tasks.get(taskId)?.key, at: announced.at(-1)?.at }),
    ]);
    for (const message of steers) {
      expect(
        crewmate.promptCalls.filter((call) => call === message),
        message,
      ).toHaveLength(1);
    }
  });
});
