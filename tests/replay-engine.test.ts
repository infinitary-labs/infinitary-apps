import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  factsWakeRef,
  firstmatePromptParts,
  readCrewRecording,
  readFirstmateRecording,
  wakeRef,
} from "../scripts/replay/recording.ts";
import { recordedQuestions, recordedShape } from "../scripts/replay/translation.ts";
import { renderWake, type WakeFacts } from "../src/core/orchestrator/wakes.ts";
import { lintCrewmateCard } from "../src/core/pi/cardLint.ts";
import { SessionRecordStore } from "../src/core/storage/sessionRecordStore.ts";
import { frameServedInput, parseServedInput } from "../src/shared/servedFrame.ts";
import {
  CREW_TWIN_TURNS,
  claudeCrewTwin,
  crewSessionsDir,
  crewTwinTime,
  piCrewTwin,
} from "./helpers/crewTwins.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

describe("framed replay inputs", () => {
  it("keeps every captain segment in served order", () => {
    const text = frameServedInput([
      { kind: "context", body: "[fm-op] context" },
      { kind: "user", body: "[user]\nfirst request", origin: "captain" },
      { kind: "user", body: "[user]\nsecond request", origin: "captain" },
    ]).text;

    expect(firstmatePromptParts(text).user).toBe("first request\n\nsecond request");
  });
});

describe("live wakes classified by their typed facts (P6)", () => {
  const task = { id: "ab12cd34", title: "Fix the meter" };
  // Every typed kind the recordings have a word for: its facts name the
  // same kind and task the recorded half reads off the words.
  const spoken: WakeFacts[] = [
    { kind: "report", task, crewmate: "crewmate 1", excerpt: "Done.", filed: [], cards: [] },
    { kind: "turn-failed", task, crewmate: "crewmate 1", error: "HTTP 529" },
    { kind: "task-failed", task, error: "boom" },
    { kind: "job-bound", task, jobId: "j1", command: "pnpm test", runMs: 7_200_000 },
    { kind: "guidance-set-aside", task, attempts: 3, excerpt: "rebase it" },
    {
      kind: "card-choice",
      to: "firstmate",
      card: { title: "Land it?" },
      choice: { id: "land", label: "Land" },
    },
  ];

  it("speaks the recorded half's vocabulary for every kind the recordings name", () => {
    for (const facts of spoken) {
      if (facts.kind === "card-choice") {
        // The recorded wake used to be operational; live Firstmate choices
        // now enter as the captain's own user segment. Preserve the old
        // ref so the historical turn can still be matched.
        expect(factsWakeRef(facts)).toBe("chose:Land it?");
        expect(renderWake({ facts })).toBe('[user]\nLand\nChoice on card "Land it?".');
        continue;
      }
      expect(factsWakeRef(facts)).toBe(wakeRef(renderWake({ facts })));
    }
  });

  // INF-87: the existing approval recording must still answer the same receipt.
  it("matches the real recorded acceptance after the wake gains a recovery read", () => {
    const rows = readFileSync(
      "tests/fixtures/replay/sep30-handoff-agree/firstmate/sessions/2026-09-23T06-07-33-769Z_01a0cce0-6789-73aa-966d-818286673091.jsonl",
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const texts = rows
      .flatMap((row) => (row.message?.role === "user" ? row.message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text as string);
    const receipt = texts
      .flatMap((text) => parseServedInput(text) ?? [])
      .find(
        (part) =>
          part.kind === "wake" &&
          part.body.startsWith('[fm-op] {"version":1,"event":"answer_task_closed"'),
      )!.body;
    expect(receipt).toBeDefined();
    const handoff = JSON.parse(receipt.slice("[fm-op] ".length));
    const facts: WakeFacts = { kind: "answer-closed", handoff };
    const live = renderWake({ facts });
    expect(live).not.toBe(receipt);
    expect(wakeRef(receipt)).toBe(factsWakeRef(facts));
    expect(wakeRef(live)).toBe(wakeRef(receipt));
    expect(wakeRef(live)).not.toBe("other:");
  });

  it("reads an outage's first failure as the failed turn a recording of that moment named", () => {
    expect(
      factsWakeRef({ kind: "outage-failed", task, crewmate: "crewmate 1", error: "529" }),
    ).toBe("turn-failed:ab12cd34");
  });

  it("gives a kind the recordings never named no ref, whatever its words happen to contain", () => {
    const facts: WakeFacts = {
      kind: "outage-still-down",
      task,
      key: "SCR-1",
      since: 0,
      downMs: 900_000,
      failures: 4,
    };
    // Its words mention guidance, so the text rule would call it a guidance wake.
    expect(wakeRef(renderWake({ facts }))).toBe("guidance:ab12cd34");
    expect(factsWakeRef(facts)).toBeNull();
  });
});

/**
 * A recorded spawn replays against today's tool (contract v4.12): a flat
 * recording's work-shape facts and wait move under `shape` and
 * `start_after`, a grouped one passes through, and either way the recording
 * replays as the quick work it was unless it asked for a rigor itself.
 */
describe("recorded spawns in today's grouped vocabulary (P7)", () => {
  const intent = { title: "Fix it", goal: "It is fixed", user_words: "fix it" };

  it("groups a flat recording, its pre-v2.8 judgment included", () => {
    const args: Record<string, unknown> = {
      ...intent,
      difficulty: "premium",
      model_id: "gpt-6-astra",
      basis: "FM3K-1",
      after_task: "FM3K-2",
      priority: 1,
    };
    recordedShape(args);
    expect(args).toEqual({
      ...intent,
      priority: 1,
      shape: {
        basis: "FM3K-1",
        premium_ask: true,
        override_model_id: "gpt-6-astra",
        rigor_ask: "quick",
      },
      start_after: { after_task: "FM3K-2" },
    });
  });

  it("passes a grouped recording through, keeping the rigor it asked for", () => {
    const args: Record<string, unknown> = {
      ...intent,
      shape: { escalate_from: "FM3K-1", rigor_ask: "reviewed" },
      start_after: { at_time: "2026-10-01T09:00:00Z" },
    };
    recordedShape(args);
    expect(args).toEqual({
      ...intent,
      shape: { escalate_from: "FM3K-1", rigor_ask: "reviewed" },
      start_after: { at_time: "2026-10-01T09:00:00Z" },
    });
  });
});

describe("recorded questions in today's authoring (contract 4.56)", () => {
  const actions = [
    { id: "agree", label: "Agree the plan", default: true },
    { id: "revise", label: "Revise" },
  ];
  const lead = "<p>One direction fits.</p><p>It needs no core change.</p>";
  const card = (body: string) => ({ title: "Plan: one direction", body, actions });

  it("turns a checked or selected proposal into the recommendation mark, byte for byte elsewhere", () => {
    const recorded = [
      lead,
      '<fieldset><legend>Where?</legend><label><input type="radio" name="q1_place" value="front" checked required> Front</label>',
      '<label><input type="radio" name="q1_place" value="back"> Back</label></fieldset>',
      '<label>When <select name="when" required><option value="fri" selected="selected">Friday</option><option value="mon">Monday</option></select></label>',
      '<label>How <select name="how" required><option value="a">A</option><option value="b">B</option></select></label>',
      '<label>Note <textarea name="note" required>Keep it</textarea></label>',
    ].join("");
    expect(lintCrewmateCard(card(recorded))).toContain('the required question "q1_place"');
    const today = recordedQuestions(recorded, actions);
    expect(today).toBe(
      [
        lead,
        '<fieldset><legend>Where?</legend><label><input type="radio" name="q1_place" value="front" data-inf-recommended required> Front</label>',
        '<label><input type="radio" name="q1_place" value="back"> Back</label>',
        '<label><input type="radio" name="q1_place" value="other" data-inf-write-in> Something else</label></fieldset>',
        '<label>When <select name="when" required><option value="">Choose</option><option value="fri" data-inf-recommended>Friday</option><option value="mon">Monday</option><option value="other" data-inf-write-in>Something else</option></select></label>',
        '<label>How <select name="how" required><option value="">Choose</option><option value="a" data-inf-recommended>A</option><option value="b">B</option><option value="other" data-inf-write-in>Something else</option></select></label>',
        '<label>Note <textarea name="note" required>Keep it</textarea></label>',
      ].join(""),
    );
    expect(lintCrewmateCard(card(today))).toBeUndefined();
  });

  it("leaves what the lint passes as recorded: optional questions, quoted words, notes and previews", () => {
    const optional = `${lead}<label><input type="checkbox" name="notify" value="yes" checked> Notify</label>`;
    expect(recordedQuestions(optional, actions)).toBe(optional);
    const quoted = `${lead}<label><input type="radio" name="pace" title="was checked" value="slow" required checked> Slow</label>`;
    expect(recordedQuestions(quoted, actions)).toBe(
      `${lead}<label><input type="radio" name="pace" title="was checked" value="slow" required data-inf-recommended> Slow</label><label><input type="radio" name="pace" value="other" data-inf-write-in> Something else</label>`,
    );
    // A question that already ends with Something else, or is marked as
    // options only, is the author's as written (FI3-1002).
    const asked = `${lead}<fieldset><legend>Where?</legend><label><input type="radio" name="place" value="front"> Front</label><label><input type="radio" name="place" value="other" data-inf-write-in> Something else</label></fieldset><fieldset data-inf-options-only><legend>Who?</legend><label><input type="radio" name="who" value="me"> Me</label></fieldset>`;
    expect(recordedQuestions(asked, actions)).toBe(asked);
    const preanswered = `${lead}<label><input type="radio" name="pace" value="slow" checked required> Slow</label>`;
    expect(recordedQuestions(preanswered, [])).toBe(preanswered);
    const preview = `${preanswered}<script>fm.stage("look", {})</script>`;
    expect(recordedQuestions(preview, actions)).toBe(preview);
  });
});

/**
 * One Firstmate session written twice by hand, the way each seat records it
 * (W1 S11): Pi's session file, and the Claude client's transcript in the
 * app's store with its served sidecar. The replay reads both through the
 * one session reader, so they are the same recorded turns.
 */
describe("a Claude-served session replays like its Pi twin (W1 S11)", () => {
  type Turn = {
    served: string;
    /** The captain's words folded into the running turn after its tool ran. */
    steer?: string;
    tool: { name: string; args: Record<string, unknown>; result: string };
    closing: string;
  };
  const captain = (words: string) =>
    frameServedInput([
      { kind: "context", body: "[fm-op] context (not the user)\nrepos: []" },
      { kind: "user", body: `[user]\n${words}`, origin: "captain" },
    ]).text;
  const wake = (words: string) =>
    frameServedInput([
      { kind: "context", body: "[fm-op] context (not the user)\nrepos: []" },
      { kind: "wake", body: `[fm-op] ${words}`, origin: "agent" },
    ]).text;
  const turns: Turn[] = [
    {
      served: captain("How is the crew doing?"),
      steer: captain("Also start on the settings typo."),
      tool: { name: "crew_status", args: {}, result: "No crew right now." },
      closing: "The crew is idle; starting the typo fix.",
    },
    {
      served: wake('on your card "Release tonight?" the user chose "Wait" (wait).'),
      tool: { name: "close_card", args: { card_id: "card-1" }, result: "Card closed." },
      closing: "Holding the release.",
    },
  ];
  const time = (turn: number, step: number) =>
    new Date(Date.UTC(2026, 8, 26, 10, turn, step)).toISOString();
  const contract = { version: "4.13", prompt_sha: "prompt-sha", instructions_sha: "ins-sha" };

  function piTwin(dir: string): string {
    const lines: unknown[] = [
      { type: "session", version: 3, id: "pi-twin", timestamp: time(0, 0), cwd: "/app" },
      { type: "custom", customType: "fm-contract", data: contract, id: "c0" },
    ];
    turns.forEach((turn, n) => {
      const message = (step: number, body: Record<string, unknown>) => ({
        type: "message",
        id: `m${n}-${step}`,
        timestamp: time(n, step),
        message: body,
      });
      lines.push(message(1, { role: "user", content: [{ type: "text", text: turn.served }] }));
      lines.push(
        message(2, {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: `call-${n}`, name: turn.tool.name, arguments: turn.tool.args },
          ],
        }),
      );
      lines.push(
        message(3, {
          role: "toolResult",
          toolCallId: `call-${n}`,
          toolName: turn.tool.name,
          content: [{ type: "text", text: turn.tool.result }],
          isError: false,
        }),
      );
      if (turn.steer) {
        lines.push(message(4, { role: "user", content: [{ type: "text", text: turn.steer }] }));
      }
      lines.push(
        message(5, {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5",
          stopReason: "stop",
          content: [{ type: "text", text: turn.closing }],
        }),
      );
    });
    const path = join(dir, "2026-09-26T10-00-00-000Z_pi-twin.jsonl");
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return path;
  }

  function claudeTwin(dir: string): string {
    const sessionId = "c1a0de00-0000-4000-8000-000000000001";
    const store = new SessionRecordStore(dir);
    const line = (body: Record<string, unknown>) => ({
      sessionId,
      isSidechain: false,
      userType: "external",
      cwd: "/app",
      version: "2.1.234",
      ...body,
    });
    const lines: unknown[] = [];
    const served: unknown[] = [{ kind: "contract", at: 0, ...contract, tools_sha: "tools-sha" }];
    turns.forEach((turn, n) => {
      const uuid = (step: number) => `u${n}-${step}`;
      lines.push(
        line({
          type: "queue-operation",
          operation: "enqueue",
          timestamp: time(n, 1),
          content: turn.served,
        }),
      );
      lines.push(
        line({
          type: "user",
          uuid: uuid(1),
          timestamp: time(n, 1),
          message: { role: "user", content: turn.served },
        }),
      );
      lines.push(
        line({
          type: "assistant",
          uuid: uuid(2),
          timestamp: time(n, 2),
          message: {
            id: `msg-${n}-a`,
            role: "assistant",
            model: "claude-opus-5-5",
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: `toolu-${n}`,
                name: `mcp__firstmate__${turn.tool.name}`,
                input: turn.tool.args,
              },
            ],
          },
        }),
      );
      lines.push(
        line({
          type: "user",
          uuid: uuid(3),
          timestamp: time(n, 3),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `toolu-${n}`,
                content: [{ type: "text", text: turn.tool.result }],
              },
            ],
          },
        }),
      );
      if (turn.steer) {
        lines.push(
          line({
            type: "attachment",
            uuid: uuid(4),
            timestamp: time(n, 4),
            attachment: { type: "queued_command", prompt: turn.steer, source_uuid: `steer-${n}` },
          }),
        );
      }
      lines.push(
        line({
          type: "assistant",
          uuid: uuid(5),
          timestamp: time(n, 5),
          message: {
            id: `msg-${n}-b`,
            role: "assistant",
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: turn.closing }],
          },
        }),
      );
      served.push({
        kind: "served",
        at: Date.parse(time(n, 6)),
        prompt: { textSha256: "", uuid: uuid(1) },
        steers: turn.steer ? [{ textSha256: "", uuid: `steer-${n}` }] : [],
      });
    });
    const path = store.transcriptPath(sessionId);
    writeFileSync(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    writeFileSync(
      store.sidecarPath(sessionId),
      `${served.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    return path;
  }

  it("yields the same recorded turns from either seat's record", () => {
    const pi = readFirstmateRecording([piTwin(scratchDir("infinitary-pi-twin-"))]);
    const claude = readFirstmateRecording([claudeTwin(scratchDir("infinitary-claude-twin-"))]);
    expect(claude).toEqual(pi);
    // And they are the session: two captain turns (the steer is its own),
    // one drain, each tool answered.
    expect(pi.captain.map((turn) => [turn.user, turn.calls.map((call) => call.name)])).toEqual([
      ["How is the crew doing?", ["crew_status"]],
      ["Also start on the settings typo.", []],
    ]);
    expect(pi.op.map((turn) => [turn.refs, turn.closing])).toEqual([
      [["chose:Release tonight?"], "Holding the release."],
    ]);
  });

  it("trims both the same way to a replay window", () => {
    const window = { from: Date.parse(time(1, 0)), to: null };
    const pi = readFirstmateRecording([piTwin(scratchDir("infinitary-pi-twin-"))], window);
    const claude = readFirstmateRecording(
      [claudeTwin(scratchDir("infinitary-claude-twin-"))],
      window,
    );
    expect(claude).toEqual(pi);
    expect(pi.captain).toEqual([]);
    expect(pi.op).toHaveLength(1);
  });
});

describe("a Claude-served crewmate replays like its Pi twin (the session contract's step 6)", () => {
  const pi = () => piCrewTwin(crewSessionsDir(scratchDir("infinitary-pi-crew-"), "pi"));
  const claude = () => claudeCrewTwin(crewSessionsDir(scratchDir("infinitary-claude-crew-"), "cl"));

  it("yields the same recorded work from either backend's record", () => {
    const fromPi = readCrewRecording("crewmate", [pi()]);
    const fromClaude = readCrewRecording("crewmate", [claude()]);
    expect(fromClaude).toEqual(fromPi);
    // And they are the work: each brief and the folded steer open a
    // segment, the app's tools under their bare names, each one answered.
    expect(
      fromPi.segments.map((segment) => ({
        user: segment.user,
        calls: segment.messages.flatMap((message) =>
          message.parts.flatMap((part) => (part.type === "toolCall" ? [part.name] : [])),
        ),
        results: [...segment.results.values()],
      })),
    ).toEqual([
      {
        user: CREW_TWIN_TURNS[0]?.brief,
        calls: [CREW_TWIN_TURNS[0]?.tool.name],
        results: [CREW_TWIN_TURNS[0]?.tool.result],
      },
      { user: CREW_TWIN_TURNS[0]?.steer, calls: [], results: [] },
      {
        user: CREW_TWIN_TURNS[1]?.brief,
        calls: [CREW_TWIN_TURNS[1]?.tool.name],
        results: [CREW_TWIN_TURNS[1]?.tool.result],
      },
    ]);
  });

  it("trims both the same way to a replay window", () => {
    const window = { from: Date.parse(crewTwinTime(1, 0)), to: null };
    const fromPi = readCrewRecording("crewmate", [pi()], window);
    const fromClaude = readCrewRecording("crewmate", [claude()], window);
    expect(fromClaude).toEqual(fromPi);
    expect(fromPi.segments.map((segment) => segment.user)).toEqual([CREW_TWIN_TURNS[1]?.brief]);
  });
});
