/**
 * The wakes the host builds and how a lane serves them (INF-2625's plan, the
 * wakes row): each builder's facts and once-name, and a lane's turn and quote.
 * A once-name is saved with the row it queued and read back by every later
 * build to queue that wake only once, so its exact string is what an
 * installed record holds; the words themselves are pinned in
 * `wakes.words.*.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { InboxRow } from "../storage/inboxStore";
import {
  dependencyClosedOnce,
  dependencyClosedWake,
  waitMovedOnce,
  waitMovedWake,
} from "./deliveryWakes";
import { checkBackAsk, checkBackAskOnce, jobBoundOnce, unnamedBackgroundWork } from "./jobWakes";
import {
  CUT_OFF_ONCE_PREFIX,
  cutOffOnce,
  outageFailedWake,
  providerBackOnce,
  recoveredWake,
  stillDownOnce,
} from "./outageWakes";
import { wakeBuiltOn } from "./reportWakes";
import { computerLeftOutOnce, computerLeftOutWake, systemWaitWake } from "./startWakes";
import { conversationRestartOnce, conversationRestartWake } from "./turnWakes";
import {
  laneText,
  laneTurnText,
  RESTART_REPLAY_NOTE,
  renderWake,
  replyWordsSpan,
  rowAttachments,
  type WakeEnvelope,
  withAttachmentsDropped,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";

const TASK = { id: "479823ee", key: "INF-2696", title: "Restructure the wakes file" };
const AT = 1_793_903_528_000;
const PICTURE = {
  id: "a1",
  kind: "image" as const,
  name: "settings.png",
  mimeType: "image/png" as const,
  bytes: 48_213,
  sha256: "9f2c4e1b7a0d3f6e8c5b2a1d4e7f0c3b6a9d2e5f8c1b4a7d0e3f6c9b2a5d8e1f",
  file: "m-118/settings.png",
};

describe("the names a wake goes out once for", () => {
  it("names each fact the way saved rows already hold it", () => {
    expect(stillDownOnce(AT)).toBe(`outage-still-down:${AT}`);
    expect(cutOffOnce("acct-1", AT)).toBe(`cut-off:acct-1:${AT}`);
    expect(cutOffOnce("acct-1", AT).startsWith(CUT_OFF_ONCE_PREFIX)).toBe(true);
    expect(providerBackOnce("acct-1", AT)).toBe(`provider-back:acct-1:${AT}`);
    expect(jobBoundOnce({ jobId: "j-9", startedAt: AT })).toBe(`job-bound:j-9:${AT}`);
    expect(checkBackAskOnce({ jobId: "j-9", startedAt: AT })).toBe(`check-back-ask:j-9:${AT}`);
    expect(dependencyClosedOnce({ id: "c1d2e3f4" })).toBe("dependency-closed:c1d2e3f4");
    expect(waitMovedOnce({ id: "c1d2e3f4" }, { id: "d2e3f4a5" })).toBe(
      "wait-moved:c1d2e3f4:d2e3f4a5",
    );
    expect(
      computerLeftOutOnce(
        { id: "b3483155" },
        {
          computerId: "dev-7",
          reasons: [
            { kind: "system", runs: "linux", heldTo: ["macos"] },
            { kind: "programs", missing: ["pnpm"] },
            { kind: "programs", missing: ["xcodebuild"] },
          ],
        },
      ),
    ).toBe("computer-left-out:b3483155:dev-7:programs+system");
  });

  it("names a renewal by its earlier conversation and what changed, in one order", () => {
    expect(conversationRestartOnce({ from: "s-77", changed: ["prompt", "instructions"] })).toBe(
      "conversation-restart:s-77:instructions+prompt",
    );
    expect(conversationRestartOnce({ from: "s-77", changed: "unopenable" })).toBe(
      "conversation-restart:s-77:unopenable",
    );
    expect(conversationRestartOnce({ from: "s-77", changed: "moved", to: "s-78" })).toBe(
      "conversation-restart:s-77:moved",
    );
    expect(conversationRestartOnce({ from: "s-77", changed: "computer", to: "Builder" })).toBe(
      "conversation-restart:s-77:computer",
    );
  });
});

describe("the wakes the host builds", () => {
  it("builds the honest retry's outage and recovery wakes from the task alone", () => {
    const task = { ...TASK, crewmate: "crewmate 61", difficulty: "high" as const };
    expect(outageFailedWake(task, "529 overloaded_error")).toEqual({
      facts: {
        kind: "outage-failed",
        task: { id: TASK.id, title: TASK.title },
        crewmate: "crewmate 61",
        error: "529 overloaded_error",
      },
    });
    expect(recoveredWake(task, 3)).toEqual({
      facts: {
        kind: "outage-recovered",
        task: { id: TASK.id, title: TASK.title },
        crewmate: "crewmate 61",
        failures: 3,
      },
    });
  });

  it("asks once per job for a check-back time, from how long it has run", () => {
    expect(
      checkBackAsk(
        { jobId: "j-9", command: "pnpm vitest run", startedAt: AT },
        AT + 420_000,
        7_200_000,
      ),
    ).toEqual({
      facts: {
        kind: "check-back-ask",
        command: "pnpm vitest run",
        runMs: 420_000,
        boundMs: 7_200_000,
      },
      once: `check-back-ask:j-9:${AT}`,
    });
  });

  it("names background work by where it runs", () => {
    expect(unnamedBackgroundWork("Builder")).toBe("background work on Builder");
    expect(unnamedBackgroundWork()).toBe("background work in the Claude client");
  });

  it("builds a system wait once per set of systems, whatever their order", () => {
    expect(
      systemWaitWake(
        { ...TASK, difficulty: "low" },
        {
          required: ["macos", "linux"],
          computers: [{ name: "This Mac", system: "macos" }],
        },
      ),
    ).toEqual({
      facts: {
        kind: "system-wait",
        task: { id: TASK.id, key: TASK.key, title: TASK.title },
        required: ["macos", "linux"],
        computers: [{ name: "This Mac", system: "macos" }],
      },
      once: "system-wait:linux+macos",
    });
  });

  it("builds a left-out computer's wake with only the facts it has", () => {
    const project = { id: "b3483155", name: "infinitary" };
    expect(
      computerLeftOutWake(TASK, project, {
        computerId: "dev-7",
        name: "Builder",
        system: "linux",
        chip: "x64",
        took: "This Mac",
        reasons: [{ kind: "chip", runs: "x64", heldTo: ["arm64"] }],
        widened: { chips: ["arm64", "x64"] },
      }),
    ).toEqual({
      facts: {
        kind: "computer-left-out",
        task: TASK,
        project,
        computer: { name: "Builder", system: "linux", chip: "x64" },
        took: "This Mac",
        reasons: [{ kind: "chip", runs: "x64", heldTo: ["arm64"] }],
        widened: { chips: ["arm64", "x64"] },
      },
      once: "computer-left-out:b3483155:dev-7:chip",
    });
    expect(
      computerLeftOutWake(TASK, project, {
        computerId: "dev-7",
        name: "Builder",
        reasons: [{ kind: "project" }],
      }),
    ).toEqual({
      facts: {
        kind: "computer-left-out",
        task: TASK,
        project,
        computer: { name: "Builder" },
        reasons: [{ kind: "project" }],
      },
      once: "computer-left-out:b3483155:dev-7:project",
    });
  });

  it("builds a closed dependency's steer by its key, else its id, and how it closed", () => {
    expect(
      dependencyClosedWake(
        {
          id: "c1d2e3f4",
          key: "INF-2763",
          title: "Repair main again",
          status: "done",
          pullRequest: 1062,
        },
        "blocks",
        ["INF-2758"],
      ),
    ).toEqual({
      facts: {
        kind: "dependency-closed",
        dependency: { key: "INF-2763", title: "Repair main again", pullRequest: 1062 },
        closed: "done",
        wait: "blocks",
        carried: ["INF-2758"],
      },
      once: "dependency-closed:c1d2e3f4",
    });
    expect(
      dependencyClosedWake(
        { id: "c1d2e3f4", key: "", title: "Repair main", status: "failed" },
        "baseline",
      ),
    ).toEqual({
      facts: {
        kind: "dependency-closed",
        dependency: { key: "c1d2e3f4", title: "Repair main" },
        closed: "dropped",
        wait: "baseline",
      },
      once: "dependency-closed:c1d2e3f4",
    });
  });

  it("builds a moved wait's steer by each task's key, else its id", () => {
    expect(
      waitMovedWake(
        { id: "c1d2e3f4", key: "", title: "Repair main" },
        { id: "d2e3f4a5", key: "INF-2763", title: "Repair main again" },
      ),
    ).toEqual({
      facts: {
        kind: "wait-moved",
        dependency: { key: "INF-2763", title: "Repair main again" },
        replaced: { key: "c1d2e3f4", title: "Repair main" },
      },
      once: "wait-moved:c1d2e3f4:d2e3f4a5",
    });
  });

  it("builds a renewal's wake with a copy of what changed and only the facts it has", () => {
    const changed = ["prompt"] as const;
    const wake = conversationRestartWake({
      restart: { from: "s-77", changed },
      taskKey: "INF-2696",
      brief: "Bring wakes.ts under 2,000 lines.",
      earlier: "",
    });
    expect(wake).toEqual({
      facts: {
        kind: "conversation-restart",
        restart: { from: "s-77", changed: ["prompt"] },
        taskKey: "INF-2696",
        brief: "Bring wakes.ts under 2,000 lines.",
      },
      once: "conversation-restart:s-77:prompt",
    });
    expect(wake.facts.kind === "conversation-restart" && wake.facts.restart.changed).not.toBe(
      changed,
    );
    expect(
      conversationRestartWake({
        restart: { from: "s-77", changed: "moved", to: "s-78" },
        taskKey: "INF-2696",
      }),
    ).toEqual({
      facts: {
        kind: "conversation-restart",
        restart: { from: "s-77", changed: "moved", to: "s-78" },
        taskKey: "INF-2696",
      },
      once: "conversation-restart:s-77:moved",
    });
  });

  it("names the work built on a task, with its close and change only when it has them", () => {
    expect(wakeBuiltOn([])).toBeUndefined();
    expect(
      wakeBuiltOn([
        {
          key: "INF-2697",
          task_id: "b9299a73",
          title: "Restructure the first mate files",
          status: "done",
          closed_reason: "merged",
          outcome_summary: "Split along owners.",
          change: {
            label: "#1064",
            url: "https://github.com/infinitary-labs/infinitary/pull/1064",
          },
        },
        {
          key: "INF-2760",
          task_id: "c1d2e3f4",
          title: "Continue: split wakes.ts",
          status: "open",
          change: {},
        },
      ]),
    ).toEqual([
      {
        key: "INF-2697",
        title: "Restructure the first mate files",
        status: "done",
        closedReason: "merged",
        change: "#1064",
      },
      { key: "INF-2760", title: "Continue: split wakes.ts", status: "open" },
    ]);
  });
});

describe("guidance wrapped for its delivery", () => {
  const WAYS = [
    {
      label: "Tell it what to do next",
      tool: "steer_crewmate" as const,
      args: { task_id: TASK.id },
    },
  ];
  const TAB_LINE = { kind: "crewmate-tab-line" as const, words: "Match this screenshot." };

  it("keeps a message's pictures around prose or typed guidance, with its ways", () => {
    expect(withAttachmentsKept("Match this screenshot.", [PICTURE])).toEqual({
      facts: {
        kind: "attachments-kept",
        guidance: "Match this screenshot.",
        attachments: [PICTURE],
      },
    });
    expect(withAttachmentsKept({ facts: TAB_LINE, ways: WAYS, once: "x" }, [PICTURE])).toEqual({
      facts: { kind: "attachments-kept", guidance: TAB_LINE, attachments: [PICTURE] },
      ways: WAYS,
    });
    expect(withAttachmentsKept({ facts: TAB_LINE }, [])).toEqual({
      facts: { kind: "attachments-kept", guidance: TAB_LINE, attachments: [] },
    });
  });

  it("says a legacy copy's pictures were dropped, around prose or typed guidance", () => {
    expect(withAttachmentsDropped("Match this screenshot.")).toEqual({
      facts: { kind: "attachments-dropped", guidance: "Match this screenshot." },
    });
    expect(withAttachmentsDropped({ facts: TAB_LINE, ways: WAYS })).toEqual({
      facts: { kind: "attachments-dropped", guidance: TAB_LINE },
      ways: WAYS,
    });
    expect(withAttachmentsDropped({ facts: TAB_LINE })).toEqual({
      facts: { kind: "attachments-dropped", guidance: TAB_LINE },
    });
  });

  it("marks the captain's guidance that holds a kept merge, keeping its ways and once-name", () => {
    expect(withGuidanceMark("Rename the test too.", 3)).toEqual({
      facts: { kind: "kept-merge-guidance", guidance: "Rename the test too.", mark: 3 },
    });
    expect(withGuidanceMark({ facts: TAB_LINE, ways: WAYS, once: "x" }, 4)).toEqual({
      facts: { kind: "kept-merge-guidance", guidance: TAB_LINE, mark: 4 },
      ways: WAYS,
      once: "x",
    });
    expect(withGuidanceMark({ facts: TAB_LINE }, 5)).toEqual({
      facts: { kind: "kept-merge-guidance", guidance: TAB_LINE, mark: 5 },
    });
  });

  it("finds the captain's own words in a thread reply or a Crewmate tab line, and nowhere else", () => {
    const reply = {
      facts: {
        kind: "thread-reply" as const,
        card: { id: "card-a", title: "Guardrails ready", messageId: 412 },
        words: "Also pin the saved rows.",
      },
    };
    const replySpan = replyWordsSpan(reply);
    expect(replySpan).toBeDefined();
    expect(renderWake(reply).slice(replySpan?.from, replySpan?.to)).toBe(
      "Also pin the saved rows.",
    );
    expect(renderWake(reply).slice(replySpan?.to)).toBe("");
    const line = { facts: TAB_LINE };
    const lineSpan = replyWordsSpan(line);
    expect(renderWake(line).slice(lineSpan?.from, lineSpan?.to)).toBe("Match this screenshot.");
    expect(replyWordsSpan("Also pin the saved rows.")).toBeUndefined();
    expect(
      replyWordsSpan({
        facts: { kind: "card-closed", card: { id: "card-a", title: "Guardrails ready" } },
      }),
    ).toBeUndefined();
  });
});

function row(id: number, body: Pick<WakeEnvelope, "facts" | "text">, cuts = 0): InboxRow {
  return {
    v: 1,
    id,
    recipient: TASK.id,
    origin: "supervision",
    ref: TASK.id,
    ...body,
    createdAt: AT + id,
    deliveredAt: null,
    attempts: 0,
    lastAttemptAt: null,
    escalatedAt: null,
    failures: 0,
    failingSince: null,
    nextAttemptAt: null,
    cuts,
    refusals: 0,
    stuckAt: null,
  };
}

describe("a crewmate lane's rows as one turn", () => {
  const steer = row(1, { text: "Rebase onto main and push." });
  const resumed = row(2, { facts: { kind: "turn-resumed", stopped: "quit" } });
  const restart = row(3, {
    facts: {
      kind: "conversation-restart",
      restart: { from: "s-77", changed: "unopenable" },
      taskKey: "INF-2696",
    },
  });
  const cut = row(4, { facts: { kind: "crewmate-tab-line", words: "Skip the iOS part." } }, 1);

  it("opens with why the conversation is new, then why the last turn stopped, then the rest in order", () => {
    expect(laneTurnText([steer, resumed, cut, restart])).toBe(
      [
        renderWake(restart),
        renderWake(resumed),
        renderWake(steer),
        `${RESTART_REPLAY_NOTE}\n\n${renderWake(cut)}`,
      ].join("\n\n"),
    );
  });

  it("quotes a lane's rows in order, joined by a space, with no replay note", () => {
    expect(laneText([steer, cut])).toBe(`Rebase onto main and push. ${renderWake(cut)}`);
  });

  it("finds the pictures a lane's messages keep, through the requests around them", () => {
    const kept = row(5, {
      facts: {
        kind: "response-request",
        requestId: "rq-41",
        guidance: {
          kind: "responses-cancelled",
          requests: ["rq-40"],
          guidance: { kind: "attachments-kept", guidance: "Match this.", attachments: [PICTURE] },
        },
      },
    });
    const turn = row(6, {
      facts: {
        kind: "captain-turn",
        words: "And this.",
        imagesDropped: false,
        attachments: [PICTURE],
      },
    });
    const bare = row(7, {
      facts: { kind: "captain-turn", words: "No picture.", imagesDropped: false },
    });
    const prose = row(8, {
      facts: { kind: "response-request", requestId: "rq-42", guidance: "Which?" },
    });
    expect(rowAttachments([kept, steer, turn, bare, prose])).toEqual([PICTURE, PICTURE]);
  });
});
