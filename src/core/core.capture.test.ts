import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FmEvent } from "@shared/events";
import { SETUP_CARD_WORDS } from "@shared/projectSetup";
import type { TaskBoard } from "@shared/tasks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockModelsJson } from "../../tests/e2e/mockModels";
import {
  ANSWER_PROMPT_MARKER,
  FINISH_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  MOCK_FM_CHAT_TEXT,
  type MockProviderServer,
  SPAWN_PROMPT_MARKER,
  STEER_PROMPT_MARKER,
  startMockProvider,
} from "../../tests/e2e/mockProvider";
import { captainCardChoice, holdsSegment, latestServedTurn } from "../../tests/e2e/providerRequest";
import { ADOPT_REPO_PROMPT_MARKER, projectSetup } from "../../tests/e2e/scenarios/projectSetup";
import {
  AMBIGUOUS_PROMPT_MARKER,
  workspaceInference,
} from "../../tests/e2e/scenarios/workspaceInference";
import { fakeHost, waitFor } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { type Core, startCore } from "./index";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import type { AskRecord } from "./storage/askStore";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Capture through the whole booted core (tests/helpers/bootedCore.ts), with
 * real Firstmate and crewmate sessions against the mock provider.
 */

/**
 * Capture (task-system P1, design section 6, acceptance in section 12): the
 * seven turn shapes the six-way contract produces - answer, ask, steer,
 * spawn, settle, operate, and a turn that does nothing - each driven through
 * `inf:converse` against a real Pi session scripted by the e2e mock provider,
 * and each ending with exactly one ask attached to a task. Plus the hinted
 * fallback: a turn that names a task and does nothing lands on that task.
 *
 * Each case owns its prerequisites (docs/testing.md): the core is shared to
 * save its boot, never as a prerequisite, so any case passes selected alone.
 * A case that needs a project registers its own. The crewmate's journey -
 * spawned, steered, nudged, settled, then read back through the protocol -
 * is one test with named sections, because each part acts on the task the
 * part before it made.
 */
describe("capture: every captain ask lands in a task", () => {
  let userDataDir: string;
  let adoptDir: string;
  let core: Core;
  let mock: MockProviderServer;
  /** The ask each captain turn of this file opened, oldest first. */
  const turnAsks: string[] = [];

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-capture-");
    adoptDir = scratchDir("infinitary-capture-repo-");
    mock = await startMockProvider({ scenarios: [workspaceInference, projectSetup] });
    // The same seam the e2e suite uses: the app-scoped models.json points Pi
    // at the mock, so the Firstmate and its crewmate run real sessions.
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
  }, 120_000);

  /**
   * Every ask of the session is attached and closed, checked after each case
   * so it holds whichever cases ran: the asks are exactly the ones this
   * file's turns opened, one per turn, and none is left open or unattached.
   */
  afterEach(() => {
    const asks = core.services.tasks.capture.listAsks();
    expect(asks.map((ask) => ask.id)).toEqual(turnAsks);
    expect(asks.every((ask) => ask.taskId !== null && ask.turnState === "closed")).toBe(true);
  });

  afterAll(async () => {
    // Keep userData until the crew, the worktree pool's background reset,
    // its trash deletion, and Pi's catalog writes have all finished. Removing
    // it while git resets a returned tree races rmSync with ENOTEMPTY on macOS.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    await mock?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(adoptDir, { recursive: true, force: true });
    expect(existsSync(userDataDir)).toBe(false);
    expect(existsSync(adoptDir)).toBe(false);
  }, 30_000);

  /** One captain turn: the ask closes when the turn ends. */
  async function turn(payload: string | { text: string; taskId?: string }): Promise<AskRecord> {
    const before = new Set(core.services.tasks.capture.listAsks().map((ask) => ask.id));
    await core.dispatch("inf:converse", [payload]);
    const opened = core.services.tasks.capture.listAsks().find((ask) => !before.has(ask.id));
    if (!opened) throw new Error("the turn opened no ask");
    turnAsks.push(opened.id);
    await waitFor(
      () => core.services.tasks.capture.getAsk(opened.id)?.turnState !== "open",
      60_000,
    );
    const closed = core.services.tasks.capture.getAsk(opened.id);
    if (!closed) throw new Error("the ask vanished");
    return closed;
  }

  async function crewIdle(title: string): Promise<string> {
    let taskId = "";
    await waitFor(() => {
      const entry = core.services.supervisor
        .crewStatus()
        .find((row) => row.title === title && row.status === "idle");
      taskId = entry?.taskId ?? "";
      return taskId !== "";
    }, 60_000);
    return taskId;
  }

  /** A named part of one journey: a failure says which part it stopped in. */
  async function section<T>(name: string, part: () => Promise<T>): Promise<T> {
    try {
      return await part();
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`;
      throw error;
    }
  }

  it("operate: a fleet operation files an operation task", async () => {
    const ask = await turn(`${ADOPT_REPO_PROMPT_MARKER}${adoptDir}`);
    expect(ask.attachedVia).toBe("tool:app_change");
    // The ask lands on the setup card's own row; the captain's Add project
    // answers it and files the setup's own operation.
    const asked = core.services.tasks.get(ask.taskId ?? "");
    expect(asked?.kind).toBe("operation");
    const card = core.services.supervisor
      .cardsSnapshot()
      .find((c) => c.title === SETUP_CARD_WORDS.title(basename(adoptDir)));
    expect(asked?.gate?.ref).toBe(card?.id);
    await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
    await waitFor(() => core.services.repos.list().some((r) => r.path === adoptDir), 30_000);
    expect(core.services.tasks.get(ask.taskId ?? "")).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    const task = core.services.tasks
      .list()
      .find((t) => t.kind === "operation" && /^Set up project /.test(t.title));
    expect(task?.status).toBe("done");
    expect(task?.closedReason).toBe("settled");
    const repoId = task?.repoId ?? "";
    expect(core.services.repos.managesProjectPath(repoId, adoptDir)).toBe(true);
    // Scratch first; the adopted repo's project rides the board with its repo facts.
    const board = await core.dispatch("inf:tasks:board", []);
    expect(board.projects[0]?.id).toBe("scratch");
    expect(board.projects.find((project) => project.id === `proj-${repoId}`)?.repo?.name).toBe(
      core.services.repos.get(repoId)?.name,
    );
  }, 120_000);

  it("answer: a standalone note files a closed question task", async () => {
    const ask = await turn(ANSWER_PROMPT_MARKER);
    expect(ask.attachedVia).toBe("tool:emit_card");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("question");
    expect(task?.status).toBe("done");
    expect(task?.title).toBe(MOCK_ANSWER_TITLE);
    expect(task?.outcome).toBe(MOCK_ANSWER_TEXT);
  }, 120_000);

  it("ask: a task-less decision opens a decision task the captain's choice closes", async () => {
    // The mock Firstmate offers the projects in its context as the choices,
    // and a decision gives two or three, so this case registers both it
    // offers rather than borrowing the one an earlier case adopts.
    await core.services.repos.setup({ kind: "init", name: "capture-decision" });
    await core.services.repos.setup({ kind: "init", name: "capture-decision-other" });
    const ask = await turn(AMBIGUOUS_PROMPT_MARKER);
    expect(ask.attachedVia).toBe("tool:emit_card");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("decision");
    expect(task?.status).toBe("open");
    const cardId = task?.gate?.ref ?? "";
    const card = core.services.supervisor.cardsSnapshot().find((c) => c.id === cardId);
    expect(card?.actions.length).toBeGreaterThan(0);
    const choice = card?.actions.find((action) => action.id !== "later");
    await core.dispatch("inf:cards:act", [cardId, choice?.id ?? "", "chrome"]);
    const closed = core.services.tasks.get(task?.id ?? "");
    expect(closed?.status).toBe("done");
    expect(closed?.closedReason).toBe("answered");
    // The choice returns to the Firstmate as a turn of its own; the case ends
    // once that turn has, so nothing it writes outlives the case.
    const returned = captainCardChoice(
      { id: cardId, title: card?.title ?? "", taskId: task?.id ?? "" },
      { id: choice?.id ?? "", label: choice?.label ?? "" },
    );
    await waitFor(
      () =>
        mock.requestBodies().some((body) => {
          const served = latestServedTurn(body);
          return served !== undefined && holdsSegment(served, returned);
        }) && !core.services.firstmate.isBusy(),
      60_000,
    );
  }, 120_000);

  it("crewmate journey: spawn, steer, a hinted turn and settle land on its task, and the protocol carries that record", async () => {
    const title = "Fix the flaky test";
    const taskId = await section("spawn: the ask lands on the new work task", async () => {
      const ask = await turn(`${SPAWN_PROMPT_MARKER} ${title}`);
      expect(ask.attachedVia).toBe("tool:spawn_crewmate");
      const task = core.services.tasks.get(ask.taskId ?? "");
      expect(task?.kind).toBe("work");
      expect(task?.title).toBe(title);
      expect(await crewIdle(title)).toBe(task?.id);
      return task?.id ?? "";
    });

    await section("steer: guidance lands on the task it names", async () => {
      const ask = await turn(`${STEER_PROMPT_MARKER}${title}: add a regression test`);
      expect(ask.attachedVia).toBe("tool:steer_crewmate");
      expect(ask.taskId).toBe(taskId);
      const steered = core.services.tasks
        .timeline(taskId)
        .filter((event) => event.kind === "ask")
        .map((event) => event.text);
      expect(steered).toContain(`${STEER_PROMPT_MARKER}${title}: add a regression test`);
      expect(await crewIdle(title)).toBe(taskId);
    });

    await section(
      "hinted fallback: a turn that names a task and does nothing lands on it",
      async () => {
        const ask = await turn({ text: "how is this going?", taskId });
        expect(ask.hintTaskId).toBe(taskId);
        expect(ask.taskId).toBe(taskId);
        expect(ask.attachedVia).toBe("host:fallback");
      },
    );

    await section("settle: landing an idle crewmate lands on the task it names", async () => {
      expect(await crewIdle(title)).toBe(taskId);
      const ask = await turn(`${FINISH_PROMPT_MARKER}${title}`);
      expect(ask.attachedVia).toBe("tool:settle_task");
      expect(ask.taskId).toBe(taskId);
      // WI-11 retired `finish`: an idle crewmate is settled by landing it. The
      // scratch task's branch has nothing new, so the land is a clean
      // fast-forward that closes the record and removes the real git worktree;
      // under a loaded full-suite run that took over 30s once, so the wait
      // matches crewIdle's window.
      await waitFor(() => core.services.tasks.get(taskId)?.workspaceState === "removed", 60_000);
      expect(core.services.tasks.get(taskId)).toMatchObject({
        status: "done",
        closedReason: "landed",
      });
      // The retired worktree goes back to the warm pool, not the trash.
      await core.services.workspace.poolSettled();
      expect(core.services.workspace.pooledTrees()).toHaveLength(1);
    });

    /**
     * The task protocol through the real core (task-system P3, design section
     * 9): the board a client resyncs from equals what the emitter pushed, the
     * detail carries the timeline the parts above wrote, and the feed is a
     * view over that timeline, keyed to the task.
     */
    await section(
      "protocol: the pushed board equals a fresh read, the detail and feed carry the record",
      async () => {
        // The landed task: no longer crew, still a record with a key.
        const key = core.services.tasks.get(taskId)?.key ?? "";
        expect(core.services.tasks.byKey(key)?.id).toBe(taskId);
        const boards: TaskBoard[] = [];
        const events: FmEvent[] = [];
        let fresh: TaskBoard | undefined;
        const detach = core.events.subscribe((channel, payload) => {
          if (channel === "inf:tasks") boards.push(payload as TaskBoard);
          if (channel === "inf:event") events.push(payload as FmEvent);
        });
        try {
          // A mutation the Firstmate would make: the board push that follows is
          // the snapshot rebuilt after the commit.
          core.services.tasks.noteProgress(taskId, "protocol probe", "host");
          await waitFor(() => boards.length > 0);
          const pushed = boards.at(-1) as TaskBoard;
          fresh = await core.dispatch("inf:tasks:board", []);
          expect(fresh.seq).toBe(pushed.seq);
          expect({ ...fresh, at: 0 }).toEqual({ ...pushed, at: 0 });
          const view = fresh.tasks.find((task) => task.id === taskId);
          expect(view).toMatchObject({
            key,
            kind: "work",
            status: "done",
            closedReason: "landed",
            assignee: "crewmate 1",
            flags: { blocked: false, held: false, needsYou: false, ready: false },
          });
          // Scratch first, then a project for each managed repo.
          expect(fresh.projects.map((project) => project.id)).toEqual([
            "scratch",
            ...core.services.repos.list().map((repo) => `proj-${repo.id}`),
          ]);
          expect(
            events.some((event) => event.type === "task_changed" && event.taskId === taskId),
          ).toBe(true);
          expect(
            events.find((event) => event.type === "task_event" && event.taskId === taskId),
          ).toMatchObject({ key, kind: "progress", text: "protocol probe", feed: false });
        } finally {
          detach();
        }
        const detail = await core.dispatch("inf:tasks:detail", [taskId]);
        expect(detail.brief.length).toBeGreaterThan(0);
        expect(detail.intent?.userWords).toContain(title);
        const kinds = detail.events.map((event) => event.kind);
        // The dispatch's quiet line about its working copy follows `dispatched`.
        expect(kinds.slice(0, 6)).toEqual([
          "created",
          "dispatched",
          "note",
          "briefed",
          "ask",
          "report",
        ]);
        expect(detail.events[2]?.text).toBe(
          "a new working copy was made, starting from the project's current commit",
        );
        // The landing close, then its clean worktree retiring (WI-7), then the probe.
        expect(kinds.slice(-3)).toEqual(["landed", "note", "progress"]);
        expect(detail.asks.map((ask) => ask.attachedVia)).toEqual([
          "tool:spawn_crewmate",
          "tool:steer_crewmate",
          "host:fallback",
          "tool:settle_task",
        ]);
        await expect(core.dispatch("inf:tasks:detail", ["nope"])).rejects.toThrow(
          'Unknown task "nope"',
        );
        expect(await core.dispatch("inf:projects:list", [])).toEqual(fresh?.projects);
        // The feed reads the timeline back: the lines the runtime used to author
        // now come from the record, prefixed by its key.
        const feed = await core.dispatch("inf:feed:recent", []);
        const keyed = feed.filter((line) => line.taskKey === key).map((line) => line.text);
        expect(keyed).toContain("Started");
        expect(keyed.some((text) => text.startsWith("Reported"))).toBe(true);
        // WI-11 retired `finish`: the idle crewmate was settled by a land, so its
        // close reads as the landing, not a decommission.
        expect(keyed.some((text) => text === "Merged")).toBe(true);
        // Task-less lines still ride beside them, unkeyed, and no line appears twice.
        expect(
          feed.some((line) => line.taskKey === undefined && line.text.startsWith("Captain: ")),
        ).toBe(true);
        expect(new Set(feed.map((line) => `${line.at}|${line.text}`)).size).toBe(feed.length);
      },
    );
  }, 120_000);

  it("nothing: a turn with no tool call files a question task with the closing text", async () => {
    const ask = await turn("hello there, all well?");
    expect(ask.attachedVia).toBe("host:fallback");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("question");
    expect(task?.title).toBe("hello there, all well?");
    expect(task?.outcome).toBe(MOCK_FM_CHAT_TEXT);
  }, 120_000);
});
