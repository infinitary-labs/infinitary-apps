/**
 * What a crewmate's session calls back into the host as `CrewToolHooks`
 * answers it: the sign-in where a project lives and the delivery tools a task
 * is handed, and session events that reach the feed as operational lines.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import type { Card } from "@shared/cards";
import { fixedHoldWords } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  queuedGuidanceLines,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedTask } from "../tasks/seedTask";
import { QUEUED_GUIDANCE_LINE } from "./crewTurns";

fakeCrewTimersEachTest();

/**
 * The app's own sign-in where projects live (git integration PR 1.2): the
 * one host card when the host refused it, the typed refusal a put-in gets
 * without one, and the crewmate's pair of tools where a change ships.
 */
describe("the sign-in where a project lives", () => {
  it("raises one host card on the host's refusal whose action starts the sign-in in Projects", () => {
    const { supervisor } = setup(fakeCrewmate());
    supervisor.cards.addForgeSignInCard("card-forge-github.com", "github.com", "GitHub", 2);
    supervisor.cards.addForgeSignInCard("card-forge-github.com", "github.com", "GitHub", 2);
    const raised = supervisor.cards
      .snapshot()
      .filter((card) => card.id === "card-forge-github.com");
    expect(raised).toHaveLength(1);
    const card = raised[0] as Card;
    expect(card.author).toBe("host");
    expect(card.title).toBe("Sign in to GitHub again");
    expect(card.body).toContain("2 pull requests are waiting on it.");
    expect(card.body).toContain("Projects kept on this computer are not affected.");
    expect(supervisor.cardActions.act(card.id, "sign-in").effect).toEqual({
      kind: "open",
      target: "projects",
      signIn: "github.com",
    });
  });

  it("refuses a put-in without the sign-in with its two ways, never a raw 401", async () => {
    const mergePullRequest = vi.fn(async () => ({
      ok: false,
      text: "Cannot merge yet - the checks could not be read.",
      problem: "Not signed in to GitHub (github.com)",
      signIn: { host: "github.com", name: "GitHub", repoId: "repo-1" },
    }));
    const { supervisor, tasks } = setup(fakeCrewmate(), { mergePullRequest });
    seedTask(tasks, {
      id: "signin-merge",
      title: "Ship the fix",
      status: "idle",
      worktreeDir: "/work/signin-merge",
    });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const result = await supervisor.settling.settle.settleTaskDetailed(
      "signin-merge",
      "merge-pr",
      undefined,
      undefined,
      "captain",
    );
    expect(result.text).toBe(
      `Cannot merge: Not signed in to GitHub (github.com): merging "Ship the fix" needs the captain's GitHub sign-in, or the project kept on this computer. ${fixedHoldWords("sign-in")}`,
    );
    expect(result.refusal).toMatchObject({
      refused: "not-signed-in",
      task: { id: "signin-merge", title: "Ship the fix" },
      ways: [
        {
          label: "Sign in to GitHub",
          effect: { kind: "open", target: "projects", signIn: "github.com" },
        },
        {
          label: "Keep it on this computer",
          tool: "app_change",
          args: {
            action: "project-settings",
            value: { repoId: "repo-1", changes: { delivery: "local-only" } },
            evidence: "Keep it on this computer",
          },
        },
      ],
    });
    expect(tasks.get("signin-merge")?.status).not.toBe("done");
  });

  it("hands the crewmate open_change and check_change where its task ships a change", async () => {
    const crewmate = fakeCrewmate();
    const openChange = vi.fn(async () => "opened");
    const checkChange = vi.fn(async () => "crew verdict: green");
    const readWorkflow = vi.fn(async () => "workflow log");
    const downloadArtifact = vi.fn(async () => "downloaded ZIP");
    const { supervisor, specs } = setup(crewmate, {
      openChange,
      checkChange,
      readWorkflow,
      downloadArtifact,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Fix it",
      intent: intentOf("fix the thing"),
    });
    await tick();
    const spec = specs[0];
    expect(await spec?.onOpenChange?.({ title: "t", body: "b" })).toBe("opened");
    expect(await spec?.onCheckChange?.()).toBe("crew verdict: green");
    expect(openChange).toHaveBeenCalledWith(taskId, { title: "t", body: "b" });
    expect(checkChange).toHaveBeenCalledWith(taskId, undefined);
    expect(await spec?.onReadWorkflow?.({ runId: 10, jobId: 20 })).toBe("workflow log");
    expect(readWorkflow).toHaveBeenCalledWith(taskId, { runId: 10, jobId: 20 });
    expect(await spec?.onDownloadArtifact?.({ runId: 10, artifactId: 30 })).toBe("downloaded ZIP");
    expect(downloadArtifact).toHaveBeenCalledWith(taskId, { runId: 10, artifactId: 30 });
  });

  it("gives an answer task evidence tools but neither delivery tool: it ships nothing", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs } = setup(crewmate, {
      openChange: vi.fn(async () => "opened"),
      checkChange: vi.fn(async () => "green"),
      readWorkflow: vi.fn(async () => "workflow log"),
      downloadArtifact: vi.fn(async () => "downloaded ZIP"),
    });
    await supervisor.intake.commission({
      title: "Read the router",
      intent: {
        goal: "explain the ladder",
        userWords: "how does routing pick a model?",
        constraints: [{ kind: "read-only" }],
      },
    });
    await tick();
    expect(specs[0]?.onOpenChange).toBeUndefined();
    expect(specs[0]?.onCheckChange).toBeUndefined();
    expect(specs[0]?.onReadWorkflow).toBeDefined();
    expect(specs[0]?.onDownloadArtifact).toBeDefined();
  });

  // INF-2146 piece 2: an operation that reads a red workflow run reserves its one
  // rerun on its own record, as alpha 44's fix tasks could not.
  it("gives an operation check_change for a run's diagnosis and rerun, never its pull request reading", async () => {
    const crewmate = fakeCrewmate();
    const checkChange = vi.fn(async () => "pull request reading");
    const { supervisor, specs, tasks } = setup(crewmate, {
      openChange: vi.fn(async () => "opened"),
      checkChange,
      readWorkflow: vi.fn(async () => "workflow log"),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Rerun the nightly full check's failed Linux journeys",
      intent: {
        goal: "rerun the failed journeys of run 40862271620",
        userWords: "rerun the failed linux journeys on last night's full check",
        constraints: [{ kind: "operation" }],
      },
    });
    await tick();
    const head = "41163dc192c032c622880d19e1ecc3759cf276ad";
    const check = "linux-e2e / journeys (desktop 3/4)";
    // What read_workflow kept of verify run 77's second attempt.
    tasks.delivery.recordChangeEvidence(taskId, {
      ciRepair: {
        failures: [{ headSha: head, checks: ["mac", check] }],
        runs: [{ runId: 40862271620, headSha: head, attempt: 2, failed: ["mac", check] }],
        diagnoses: [],
        repairs: [],
      },
    });
    const spec = specs[0];
    expect(spec?.onOpenChange).toBeUndefined();
    const rerun = { headSha: head, check, evidence: "One rerun of the timed-out journeys shard" };
    expect(await spec?.onCheckChange?.({ rerun })).toBe(
      "Crew check declaration recorded with evidence. No merge was authorized.",
    );
    expect(tasks.get(taskId)?.delivery?.ciRepair?.rerun).toEqual({ ...rerun, runId: 40862271620 });
    expect(await spec?.onCheckChange?.({ pull: 4 })).toContain("ships no change");
    expect(checkChange).not.toHaveBeenCalled();
  });
});

describe("operational chatter is feed lines (interaction P0, WI-5)", () => {
  const fmOps = (ops: string[]) => ops.filter((line) => line.startsWith("[fm-op]"));

  it("queued guidance going out as the next turn is a feed line, not a Firstmate wake", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, ops, events, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Tidy the meter test",
      intent: intentOf("Start"),
    });
    await tick();

    expect(await supervisor.steer.steerCrewmate(taskId, "also cover the reset")).toBe(
      "queued-next-turn",
    );
    crewmate.finishPrompt();
    await tick();

    expect(crewmate.promptCalls.at(-1)).toBe("also cover the reset");
    expect(fmOps(ops)).toEqual([]);
    expect(queuedGuidanceLines(tasks, taskId)).toEqual([
      expect.objectContaining({ kind: "note", feed: true, text: QUEUED_GUIDANCE_LINE }),
    ]);
    expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
  });

  it("guidance a cancel leaves undelivered stays on the task's timeline and wakes nobody", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Tidy the meter test",
      intent: intentOf("Start"),
    });
    await tick();

    await supervisor.steer.steerCrewmate(taskId, "stop after the first file");
    // Cancel mid-turn: the lane still holds the steer when the turn ends.
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    crewmate.failPrompt("aborted");
    await tick();

    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(fmOps(ops)).toEqual([]);
    const note = tasks.timeline(taskId).find((event) => event.kind === "note");
    expect(note).toMatchObject({ feed: true, data: { undelivered: 1 } });
    expect(note?.text).toContain("stop after the first file");
  });

  it("a background job that outlives its task is a feed line, not a Firstmate wake", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Tidy the meter test",
      intent: intentOf("Start"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    crewmate.failPrompt("aborted");
    await tick();

    supervisor.watch.deliverJobResult(
      taskId,
      '[job] background job j1 finished: "pnpm test" exited 0',
    );
    expect(fmOps(ops)).toEqual([]);
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: 'A background job finished after "Tidy the meter test" ended; its output was set aside.',
      taskId: expect.any(String),
    });
  });
});
