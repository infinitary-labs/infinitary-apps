import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@core/storage/db";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { DECISION_RECORD_SCHEMA, type DecisionRecord } from "@shared/provenance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CandidateMiss,
  type EscalationRecord,
  main,
} from "../scripts/derive-miss-candidates.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * C2 consuming R2's forward events (supervision coverage W2): the fixture is
 * written through the app's own migrations and its one task writer -
 * `TaskService.turns.recordSteer` / `recordInterrupt` / `recordDecision` are exactly
 * what the crew control plane and `DecisionCapture` call - and the REAL CLI
 * derives over it. Only the rows are ours.
 */

const T0 = Date.parse("2026-09-17T09:00:00.000Z");
const MINUTE = 60_000;

/** The evidence keys C2 wrote before R2 was consumed; a pre-R2 database must not grow any. */
const PRE_R2_EVIDENCE_KEYS = new Set([
  "kind",
  "at",
  "rationale",
  "outcome_id",
  "card_id",
  "wake",
  "summary",
  "wake_kind",
  "chosen_action",
  "resolution",
  "created_at",
  "actor",
]);

function insertOutcome(
  db: ReturnType<typeof openDatabase>,
  row: {
    taskId: string;
    wake: string;
    verdict: "routine" | "captain";
    summary: string;
    at: number;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO decisions (kind, task_id, wake, verdict, summary, at) VALUES ('sort', ?, ?, ?, ?, ?)`,
      )
      .run(row.taskId, row.wake, row.verdict, row.summary, row.at).lastInsertRowid,
  );
}

function decision(input: {
  id: string;
  role: "supervision" | "firstmate";
  at: number;
  tasks: string[];
  outcomeId?: number | null;
  handoffInboxId?: number | null;
  wakeInboxIds?: number[];
  cards?: string[];
  toolCalls?: string[];
  outcome?: DecisionRecord["disposition"]["outcome"];
  inbox?: DecisionRecord["disposition"]["inbox"];
}): DecisionRecord {
  return {
    schema: DECISION_RECORD_SCHEMA,
    decision: input.id,
    startedAt: input.at - 1000,
    endedAt: input.at,
    producer: {
      actor: input.role === "supervision" ? "supervisor" : "firstmate",
      role: input.role,
      model: { provider: "mock", id: "m" },
      accountId: null,
      thinkingLevel: null,
    },
    contract: { version: "2.7", promptSha: "p", toolsSha: "t" },
    trigger: "wake",
    served: {
      sessionFile: null,
      prompt: {
        textSha256: "sha",
        entryId: "e1",
        parentEntryId: null,
        frame: "v1",
        segments: [
          ...(input.role === "firstmate" ? [{ kind: "context" as const, length: 5 }] : []),
          ...(input.wakeInboxIds ?? []).map((inboxId) => ({
            kind: "wake" as const,
            length: 5,
            inboxId,
          })),
        ],
        prefix: null,
      },
      steers: [],
    },
    disposition: {
      outcome: input.outcome ?? "clean",
      error: input.outcome === "failed" ? "provider failed" : null,
      inbox: input.inbox ?? "acked",
      asks: [],
      toolCalls: (input.toolCalls ?? []).map((name, index) => ({
        id: `c${index}`,
        name,
        isError: false,
      })),
      cards: input.cards ?? [],
      tasks: input.tasks,
      verdict: input.role === "supervision" ? "captain" : null,
      outcomeId: input.outcomeId ?? null,
      handoffInboxId: input.handoffInboxId ?? null,
    },
  };
}

function run(argv: string[]): { code: number; stderr: string } {
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { code: main(argv), stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as T) : [];
}

let dir = "";
beforeEach(() => {
  dir = scratchDir("infinitary-c2-r2-");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Routine verdicts on five tasks, and nothing else - the shape of every database before R2. */
function buildBase(): {
  db: ReturnType<typeof openDatabase>;
  tasks: TaskService;
  setNow: (at: number) => void;
} {
  const db = openDatabase(dir);
  let now = T0 - 60 * MINUTE;
  const tasks = new TaskService({ db, strict: true, now: () => now });
  for (const id of ["t-card", "t-tool", "t-abort", "t-quiet", "t-escalated"]) {
    seedTask(tasks, { id, title: id, prompt: "brief", status: "idle", createdAt: now });
  }
  for (const id of ["t-card", "t-tool", "t-abort", "t-quiet", "t-escalated"]) {
    insertOutcome(db, {
      taskId: id,
      wake: `[fm-op] crewmate 1 reported on task ${id} "${id}": progress.`,
      verdict: "routine",
      summary: "Progressing.",
      at: T0,
    });
  }
  return { db, tasks, setNow: (at) => (now = at) };
}

describe("miss deriver - R2 direct-control evidence and the escalation chain", () => {
  it("leaves the output on a pre-R2 database unchanged", () => {
    const { db } = buildBase();
    // Card-derived and outcome-derived evidence still flow exactly as before.
    insertOutcome(db, {
      taskId: "t-escalated",
      wake: '[fm-op] crewmate 1 reported on task t-escalated "t-escalated": red CI.',
      verdict: "captain",
      summary: "CI is red.",
      at: T0 + 10 * MINUTE,
    });
    db.close();
    const out = join(dir, "candidates.jsonl");
    const escalations = join(dir, "escalations.jsonl");
    const { code, stderr } = run([
      "--user-data",
      dir,
      "--out",
      out,
      "--escalations-out",
      escalations,
    ]);
    expect(code).toBe(0);
    const candidates = readJsonl<CandidateMiss>(out);
    expect(candidates.map((row) => row.task_id)).toEqual(["t-escalated"]);
    for (const item of candidates.flatMap((row) => row.evidence)) {
      expect(Object.keys(item).every((key) => PRE_R2_EVIDENCE_KEYS.has(key))).toBe(true);
    }
    expect(readFileSync(escalations, "utf8")).toBe("");
    expect(stderr).not.toContain("escalations followed");
    expect(stderr).toContain("evidence: captain_escalation=1");
  });

  it("reads captain card and task card steers, Firstmate tool steers and captain interrupts as direct control, and follows the handoff", () => {
    const { db, tasks, setNow } = buildBase();

    // Counted: the captain steers via a card, the Firstmate via its tool, the captain aborts.
    setNow(T0 + 5 * MINUTE);
    tasks.turns.recordSteer("t-card", {
      text: "use the blue one",
      actor: "captain",
      outcome: "queued-next-turn",
      via: "card",
      decision: null,
      cardId: "card-t-card-1",
      inboxId: 11,
    });
    // The task card's Continue is the captain's own steer too (FI3-695).
    tasks.turns.recordSteer("t-card", {
      text: "carry on",
      actor: "captain",
      outcome: "queued-next-turn",
      via: "task-card",
      decision: null,
      cardId: null,
      inboxId: 15,
    });
    setNow(T0 + 6 * MINUTE);
    tasks.turns.recordSteer("t-tool", {
      text: "rebase first",
      actor: "firstmate",
      outcome: "mid-turn",
      via: "tool",
      decision: "fm-steerer",
      cardId: null,
      inboxId: 12,
    });
    setNow(T0 + 7 * MINUTE);
    tasks.turns.recordInterrupt("t-abort", {
      actor: "captain",
      mode: "interrupt",
      effect: "requested",
      via: "shell",
      decision: null,
    });
    tasks.turns.recordInterrupt("t-abort", {
      actor: "captain",
      mode: "interrupt",
      effect: "aborted-turn",
      via: "shell",
      decision: null,
    });

    // Not counted: supervision's own steer, and the Firstmate interrupting on its own call.
    setNow(T0 + 8 * MINUTE);
    tasks.turns.recordSteer("t-quiet", {
      text: "carry on",
      actor: "supervisor",
      outcome: "mid-turn",
      via: "supervision",
      decision: "sv-self",
      cardId: null,
      inboxId: 13,
    });
    tasks.turns.recordInterrupt("t-quiet", {
      actor: "firstmate",
      mode: "interrupt",
      effect: "aborted-turn",
      via: "tool",
      decision: "fm-x",
    });
    // Not subsequent: a steer before the routine verdict.
    setNow(T0 - MINUTE);
    tasks.turns.recordSteer("t-quiet", {
      text: "earlier",
      actor: "captain",
      outcome: "mid-turn",
      via: "card",
      decision: null,
      cardId: "card-early",
      inboxId: 14,
    });

    // A later captain verdict on t-escalated, handed to the Firstmate as inbox row 501,
    // which a Firstmate decision consumed by raising a card.
    const captainId = insertOutcome(db, {
      taskId: "t-escalated",
      wake: '[fm-op] crewmate 1 reported on task t-escalated "t-escalated": red CI.',
      verdict: "captain",
      summary: "CI is red.",
      at: T0 + 10 * MINUTE,
    });
    tasks.turns.recordDecision(
      decision({
        id: "sv-esc",
        role: "supervision",
        at: T0 + 10 * MINUTE,
        tasks: ["t-escalated"],
        outcomeId: captainId,
        handoffInboxId: 501,
        wakeInboxIds: [500],
      }),
    );
    tasks.turns.recordDecision(
      decision({
        id: "fm-consumer",
        role: "firstmate",
        at: T0 + 11 * MINUTE,
        tasks: ["t-escalated"],
        wakeInboxIds: [499, 501],
        cards: ["card-fm-ci"],
        toolCalls: ["crew_status", "emit_card"],
      }),
    );
    // A second escalation the Firstmate answered by steering, and a third nobody has consumed yet.
    setNow(T0 + 20 * MINUTE);
    const steeredId = insertOutcome(db, {
      taskId: "t-tool",
      wake: "[fm-op] crewmate 1 reported on task t-tool: stuck.",
      verdict: "captain",
      summary: "Stuck.",
      at: T0 + 20 * MINUTE,
    });
    tasks.turns.recordDecision(
      decision({
        id: "sv-2",
        role: "supervision",
        at: T0 + 20 * MINUTE,
        tasks: ["t-tool"],
        outcomeId: steeredId,
        handoffInboxId: 601,
      }),
    );
    tasks.turns.recordDecision(
      decision({
        id: "fm-2",
        role: "firstmate",
        at: T0 + 21 * MINUTE,
        tasks: ["t-tool"],
        wakeInboxIds: [601],
        toolCalls: ["steer_crewmate"],
      }),
    );
    setNow(T0 + 21 * MINUTE);
    tasks.turns.recordSteer("t-tool", {
      text: "try again",
      actor: "firstmate",
      outcome: "mid-turn",
      via: "tool",
      decision: "fm-2",
      cardId: null,
      inboxId: 602,
    });
    const pendingId = insertOutcome(db, {
      taskId: "t-card",
      wake: "[fm-op] crewmate 1 reported on task t-card: help.",
      verdict: "captain",
      summary: "Help.",
      at: T0 + 30 * MINUTE,
    });
    tasks.turns.recordDecision(
      decision({
        id: "sv-3",
        role: "supervision",
        at: T0 + 30 * MINUTE,
        tasks: ["t-card"],
        outcomeId: pendingId,
        handoffInboxId: 701,
      }),
    );
    db.close();

    const out = join(dir, "candidates.jsonl");
    const escalationsOut = join(dir, "escalations.jsonl");
    const { code, stderr } = run([
      "--db",
      join(dir, "firstmate.db"),
      "--out",
      out,
      "--escalations-out",
      escalationsOut,
    ]);
    expect(code).toBe(0);
    const byTask = new Map(readJsonl<CandidateMiss>(out).map((row) => [row.task_id, row]));

    expect(byTask.get("t-card")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "direct_control",
          event_kind: "steered",
          actor: "captain",
          via: "card",
          card_id: "card-t-card-1",
          effect: "queued-next-turn",
        }),
        expect.objectContaining({
          kind: "direct_control",
          event_kind: "steered",
          actor: "captain",
          via: "task-card",
          effect: "queued-next-turn",
        }),
      ]),
    );
    expect(byTask.get("t-tool")?.evidence.filter((item) => item.kind === "direct_control")).toEqual(
      [
        expect.objectContaining({
          event_kind: "steered",
          actor: "firstmate",
          via: "tool",
          decision: "fm-steerer",
        }),
        expect.objectContaining({
          event_kind: "steered",
          actor: "firstmate",
          via: "tool",
          decision: "fm-2",
        }),
      ],
    );
    // The requested/aborted pair is one interrupt.
    expect(byTask.get("t-abort")?.evidence).toEqual([
      expect.objectContaining({
        kind: "direct_control",
        event_kind: "interrupted",
        actor: "captain",
        effect: "aborted-turn",
      }),
    ]);
    expect(byTask.has("t-quiet")).toBe(false);

    const escalated = byTask
      .get("t-escalated")
      ?.evidence.find((item) => item.kind === "captain_escalation");
    expect(escalated?.escalation_outcome).toEqual({
      supervision_decision: "sv-esc",
      handoff_inbox_id: 501,
      firstmate_decision: "fm-consumer",
      class: "card",
      outcome: "clean",
      cards: ["card-fm-ci"],
      tool_calls: ["crew_status", "emit_card"],
      controls: [],
      at: T0 + 11 * MINUTE,
    });
    for (const candidate of byTask.values()) {
      expect(candidate.label).toEqual({
        kind: "under_escalation",
        weak: true,
        confirmed: false,
        confidence: "unconfirmed",
      });
    }

    const escalations = readJsonl<EscalationRecord>(escalationsOut);
    expect(escalations.map((row) => [row.task_id, row.escalation_outcome.class])).toEqual([
      ["t-escalated", "card"],
      ["t-tool", "steer"],
      ["t-card", "none"],
    ]);
    expect(escalations[1]?.escalation_outcome.controls).toEqual([
      { kind: "steered", task_id: "t-tool", actor: "firstmate" },
    ]);
    expect(stderr).toContain("escalations followed: 3 (card=1 steer=1 none=1)");

    // Never C3's columns.
    const check = openDatabase(dir);
    try {
      const labelled = check
        .prepare(
          "SELECT COUNT(*) AS n FROM supervision_outcomes WHERE missed_escalation IS NOT NULL OR missed_note IS NOT NULL OR missed_at IS NOT NULL",
        )
        .get() as { n: number };
      expect(labelled.n).toBe(0);
    } finally {
      check.close();
    }
  });

  it("uses the acknowledged retry and preserves effects from released attempts", () => {
    const { db, tasks, setNow } = buildBase();
    const captainId = insertOutcome(db, {
      taskId: "t-escalated",
      wake: "[fm-op] crewmate reported a retryable failure.",
      verdict: "captain",
      summary: "Needs Firstmate handling.",
      at: T0 + 10 * MINUTE,
    });
    tasks.turns.recordDecision(
      decision({
        id: "sv-retry",
        role: "supervision",
        at: T0 + 10 * MINUTE,
        tasks: ["t-escalated"],
        outcomeId: captainId,
        handoffInboxId: 801,
      }),
    );
    tasks.turns.recordDecision(
      decision({
        id: "fm-released",
        role: "firstmate",
        at: T0 + 11 * MINUTE,
        tasks: ["t-escalated"],
        wakeInboxIds: [801],
        toolCalls: ["steer_crewmate"],
        outcome: "failed",
        inbox: "released",
      }),
    );
    setNow(T0 + 11 * MINUTE);
    tasks.turns.recordSteer("t-escalated", {
      text: "preserve this guidance",
      actor: "firstmate",
      outcome: "mid-turn",
      via: "tool",
      decision: "fm-released",
      cardId: null,
      inboxId: 802,
    });
    tasks.turns.recordDecision(
      decision({
        id: "fm-retry",
        role: "firstmate",
        at: T0 + 12 * MINUTE,
        tasks: ["t-escalated"],
        wakeInboxIds: [801],
        cards: ["card-fm-retry"],
        toolCalls: ["emit_card"],
        inbox: "acked",
      }),
    );
    db.close();

    const escalationsOut = join(dir, "retry-escalations.jsonl");
    expect(
      run([
        "--db",
        join(dir, "firstmate.db"),
        "--out",
        join(dir, "retry-candidates.jsonl"),
        "--escalations-out",
        escalationsOut,
      ]).code,
    ).toBe(0);
    const outcome = readJsonl<EscalationRecord>(escalationsOut).find(
      (row) => row.outcome_id === captainId,
    )?.escalation_outcome;
    expect(outcome).toEqual({
      supervision_decision: "sv-retry",
      handoff_inbox_id: 801,
      firstmate_decision: "fm-retry",
      class: "card",
      outcome: "clean",
      cards: ["card-fm-retry"],
      tool_calls: ["steer_crewmate", "emit_card"],
      controls: [{ kind: "steered", task_id: "t-escalated", actor: "firstmate" }],
      at: T0 + 12 * MINUTE,
    });
  });

  it("keeps an in-window interrupt request when its completion falls outside the window", () => {
    const { db, tasks, setNow } = buildBase();
    setNow(T0 + 23 * 60 * MINUTE);
    tasks.turns.recordInterrupt("t-abort", {
      actor: "captain",
      mode: "interrupt",
      effect: "requested",
      via: "shell",
      decision: null,
    });
    setNow(T0 + 25 * 60 * MINUTE);
    tasks.turns.recordInterrupt("t-abort", {
      actor: "captain",
      mode: "interrupt",
      effect: "aborted-turn",
      via: "shell",
      decision: null,
    });
    db.close();

    const out = join(dir, "window-edge.jsonl");
    expect(run(["--db", join(dir, "firstmate.db"), "--out", out]).code).toBe(0);
    const candidate = readJsonl<CandidateMiss>(out).find((row) => row.task_id === "t-abort");
    expect(candidate?.evidence).toEqual([
      expect.objectContaining({
        kind: "direct_control",
        event_kind: "interrupted",
        effect: "requested",
      }),
    ]);
  });
});
