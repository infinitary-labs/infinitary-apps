import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIRSTMATE_CONTRACT_VERSION } from "@core/pi/piResources";
import { openDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { SettingsStore } from "@core/storage/settingsStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { DECISION_RECORD_SCHEMA, type DecisionRecord } from "@shared/provenance";
import { frameServedInput } from "@shared/servedFrame";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as exportMain } from "../scripts/export-corpus.ts";
import { main, type SupervisionTurnRecord } from "../scripts/extract-supervision-turns.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The extractor reads pre-S7c archives only. Exercise its real command entry
 * point with committed historical transcripts and a synthetic archive built
 * with current migrations and stores, not a live supervision writer.
 * The current-outcome case proves rows without transcripts are not dropped.
 */

const FIXTURES = join(process.cwd(), "tests", "fixtures", "replay");
const OPEN_GATE = { isPackaged: false, env: {} };

type OutcomeRow = {
  id: number;
  task_id: string;
  wake: string;
  verdict: string;
  summary: string;
  at: number;
  model?: string | null;
  prompt_sha?: string | null;
  tools_sha?: string | null;
  wake_kind?: string | null;
  missed_escalation?: number | null;
  missed_note?: string | null;
  missed_at?: number | null;
};

function insertOutcome(db: ReturnType<typeof openDatabase>, row: OutcomeRow): void {
  db.prepare(
    `INSERT INTO decisions (kind, id, task_id, wake, verdict, summary, at, model, prompt_sha, tools_sha, wake_kind,
       missed_escalation, missed_note, missed_at) VALUES ('sort', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.task_id,
    row.wake,
    row.verdict,
    row.summary,
    row.at,
    row.model ?? null,
    row.prompt_sha ?? null,
    row.tools_sha ?? null,
    row.wake_kind ?? null,
    row.missed_escalation ?? null,
    row.missed_note ?? null,
    row.missed_at ?? null,
  );
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line) as T) : [];
}

function runCli(argv: string[]): { code: number; stderr: string } {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { code: main(argv, OPEN_GATE), stderr };
  } finally {
    spy.mockRestore();
  }
}

let dir: string;
beforeEach(() => {
  dir = scratchDir("infinitary-g1-");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("supervision-turn extractor - the real historical sessions", () => {
  function exportFixture(name: string): {
    records: SupervisionTurnRecord[];
    rows: OutcomeRow[];
    turns: number;
    stderr: string;
  } {
    const tables = JSON.parse(readFileSync(join(FIXTURES, name, "tables.json"), "utf8")) as {
      supervision_outcomes?: OutcomeRow[];
    };
    const rows = tables.supervision_outcomes ?? [];
    const userData = join(dir, name);
    const db = openDatabase(userData);
    for (const row of rows) insertOutcome(db, row);
    db.close();
    const sessions = join(FIXTURES, name, "supervision", "sessions");
    const turns = readdirSync(sessions)
      .flatMap((file) => readFileSync(join(sessions, file), "utf8").split("\n"))
      .filter((line) => line.includes('"role":"user"')).length;
    const out = join(dir, `${name}.jsonl`);
    const { code, stderr } = runCli([
      "--user-data",
      userData,
      "--supervision-sessions",
      sessions,
      "--out",
      out,
    ]);
    expect(code).toBe(0);
    return { records: readJsonl<SupervisionTurnRecord>(out), rows, turns, stderr };
  }

  it("joins every one of sep14-real's 174 triage turns to its outcome row by (task_id, wake, at)", () => {
    const { records, rows, turns, stderr } = exportFixture("sep14-real");
    expect(rows).toHaveLength(174);
    expect(turns).toBe(174);
    expect(records).toHaveLength(174);
    expect(records.every((record) => record.join_basis === "text-exact")).toBe(true);
    expect(new Set(records.map((record) => record.outcome_id))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(stderr).toContain("joins: text-exact=174");

    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const record of records) {
      const row = byId.get(record.outcome_id as number) as OutcomeRow;
      // The served wake segment is exactly the host's `[wake] <stored payload>`.
      expect(record.served?.frame_basis).toBe("reframed-exact");
      expect(record.served?.segments?.map((segment) => segment.kind)).toEqual(["wake", "context"]);
      expect(record.served?.segments?.[0]?.body).toBe(`[wake] ${row.wake}`);
      expect(record.served?.segments?.[1]?.body.startsWith(`[context] task ${row.task_id} `)).toBe(
        true,
      );
      // The trajectory the outcome row never carried.
      expect(record.verdict).toBe(row.verdict);
      expect(record.report_outcome?.args).toMatchObject({
        task_id: row.task_id,
        verdict: row.verdict,
      });
      expect(record.crew_status.length).toBeGreaterThan(0);
      expect(record.crew_status.every((call) => call.result !== null)).toBe(true);
      expect(record.assistant.length).toBeGreaterThan(0);
      // Pre-R2 history is never re-badged with a contract it did not record.
      expect(record.contract).toBeNull();
      expect(record.prefix_message_count).toBeNull();
      expect(record.decision).toBeNull();
      expect(record.row_provenance?.prompt_sha).toBe(row.prompt_sha ?? null);
      expect(record.label).toEqual({ missed_escalation: null, missed_note: null, missed_at: null });
      expect(record.timestamps.outcome_at).toBe(row.at);
    }
  });

  it("joins sep04-real's excerpted stored wakes as text-prefix, never as exact", () => {
    const { records, rows } = exportFixture("sep04-real");
    expect(rows).toHaveLength(18);
    expect(records).toHaveLength(18);
    expect(records.every((record) => record.join_basis === "text-prefix")).toBe(true);
    // No exact boundary is claimed for a split the row cannot locate.
    expect(records.every((record) => record.served?.frame_basis === "reframed-marker")).toBe(true);
  });

  it("explains every reconstructed turn that has no outcome table instead of dropping it", () => {
    for (const name of ["sep14", "sep04"]) {
      const { records, turns } = exportFixture(name);
      expect(records).toHaveLength(turns);
      expect(records.every((record) => record.join_basis === "unjoined")).toBe(true);
      expect(new Set(records.map((record) => record.miss?.reason))).toEqual(
        new Set(["no-outcome-row"]),
      );
    }
  });
});

// --------------------------------------------------------------------------
// A userData written in today's (R2) shapes
// --------------------------------------------------------------------------

const T0 = Date.parse("2026-09-17T10:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();

function userEntry(id: string, parentId: string | null, at: number, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role: "user", content: [{ type: "text", text }], timestamp: at },
  });
}

function callEntry(
  id: string,
  parentId: string,
  at: number,
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  text = "",
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.args,
        })),
      ],
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      stopReason: calls.length ? "toolUse" : "stop",
    },
  });
}

function resultEntry(
  id: string,
  parentId: string,
  at: number,
  callId: string,
  name: string,
  text: string,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: [{ type: "text", text }],
      isError: false,
    },
  });
}

function decision(input: {
  id: string;
  actor?: "supervisor" | "host";
  taskId: string;
  at: number;
  sessionFile: string | null;
  entryId: string | null;
  textSha256: string;
  toolCalls: { id: string; name: string }[];
  verdict: "routine" | "captain" | null;
  outcomeId: number | null;
  handoffInboxId?: number | null;
  inboxId: number;
  served?: boolean;
}): DecisionRecord {
  return {
    schema: DECISION_RECORD_SCHEMA,
    decision: input.id,
    startedAt: input.at,
    endedAt: input.at + 3000,
    producer: {
      actor: input.actor ?? "supervisor",
      role: "supervision",
      model: input.actor === "host" ? null : { provider: "openai-codex", id: "gpt-5.6-luna" },
      accountId: input.actor === "host" ? null : "acct-codex",
      thinkingLevel: null,
    },
    contract: {
      version: FIRSTMATE_CONTRACT_VERSION,
      promptSha: input.actor === "host" ? null : "prompt-sha-sv",
      toolsSha: input.actor === "host" ? null : "tools-sha-sv",
    },
    trigger: "wake",
    served:
      input.served === false
        ? null
        : {
            sessionFile: input.sessionFile,
            prompt: {
              textSha256: input.textSha256,
              entryId: input.entryId,
              parentEntryId: null,
              frame: "v1",
              segments: [
                { kind: "wake", length: 10, inboxId: input.inboxId, ref: input.taskId },
                { kind: "context", length: 10 },
              ],
              prefix: { messageCount: 42, sha256: "prefix-sha" },
            },
            steers: [],
          },
    disposition: {
      outcome: "clean",
      error: null,
      inbox: "acked",
      asks: [],
      toolCalls: input.toolCalls.map((call) => ({ ...call, isError: false })),
      cards: [],
      tasks: [input.taskId],
      verdict: input.verdict,
      outcomeId: input.outcomeId,
      handoffInboxId: input.handoffInboxId ?? null,
    },
  };
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

describe("supervision-turn extractor - R2 framed sessions and decisions", () => {
  const WAKE = '[fm-op] crewmate 1 reported on task t-r2 "Fix flaky test": CI green.';
  // A report quoting the host's context label: only the frame tells the halves apart.
  const QUOTING =
    '[fm-op] crewmate 1 reported on task t-old "Old work": log says\n\n[context] task t9 fine';
  const LIVE_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

  async function buildUserData(): Promise<{ userData: string; sessionFile: string }> {
    const userData = join(dir, "userData");
    const db = openDatabase(userData);
    let now = T0;
    const tasks = new TaskService({ db, strict: true, now: () => now });
    for (const [id, title] of [
      ["t-r2", "Fix flaky test"],
      ["t-old", "Old work"],
      ["t-repeat", "Repeated update"],
    ] as const) {
      seedTask(tasks, { id, title, prompt: "brief", status: "idle", createdAt: T0 - 3_600_000 });
    }

    const sessions = join(userData, "supervision", "sessions");
    mkdirSync(sessions, { recursive: true });
    // The rolling session sits OUTSIDE the sessions dir; only the settings row names it.
    const elsewhere = join(dir, "moved");
    mkdirSync(elsewhere, { recursive: true });
    const sessionFile = join(elsewhere, "2026-09-17T10-00-00-000Z_sv.jsonl");

    const framed = frameServedInput([
      { kind: "wake", origin: "crewmate-report", body: `[wake] ${WAKE}` },
      {
        kind: "context",
        body: '[context] task t-r2 "Fix flaky test"; status idle; repo nimbus; delivery direct-pr; autonomy on\n[open cards] none\n\nHandle this per your operating procedure and finish with report_outcome (task_id t-r2).',
      },
    ]);
    const historical = `[wake] ${QUOTING}\n\n[context] task t-old "Old work"; status idle; repo nimbus; delivery direct-pr; autonomy off\n\nHandle this per your operating procedure and finish with report_outcome (task_id t-old).`;
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sv-session",
        timestamp: iso(T0 - 60_000),
        cwd: "/sv",
      }),
      JSON.stringify({
        type: "model_change",
        id: "m0",
        parentId: null,
        timestamp: iso(T0 - 60_000),
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      }),
      // A pre-R2 turn: unframed, joined by text.
      userEntry("h1", "m0", T0 - 30_000, historical),
      callEntry("h2", "h1", T0 - 29_000, [{ id: "hc1", name: "crew_status", args: {} }]),
      resultEntry(
        "h3",
        "h2",
        T0 - 28_900,
        "hc1",
        "crew_status",
        `[{"taskId":"t-old","lastReport":"token ${LIVE_KEY}"}]`,
      ),
      callEntry("h4", "h3", T0 - 28_000, [
        {
          id: "hc2",
          name: "report_outcome",
          args: { task_id: "t-old", verdict: "routine", summary: "Old work is fine." },
        },
      ]),
      resultEntry(
        "h5",
        "h4",
        T0 - 27_990,
        "hc2",
        "report_outcome",
        "Recorded as routine; one feed line published.",
      ),
      callEntry("h6", "h5", T0 - 27_000, [], "Reported."),
      // The framed R2 turn.
      userEntry("f1", "h6", T0, framed.text),
      callEntry("f2", "f1", T0 + 1000, [{ id: "fc1", name: "crew_status", args: {} }]),
      resultEntry(
        "f3",
        "f2",
        T0 + 1100,
        "fc1",
        "crew_status",
        '[{"taskId":"t-r2","status":"idle"}]',
      ),
      callEntry("f4", "f3", T0 + 2000, [
        {
          id: "fc2",
          name: "report_outcome",
          args: { task_id: "t-r2", verdict: "captain", summary: "Ready to merge." },
        },
      ]),
      resultEntry(
        "f5",
        "f4",
        T0 + 2010,
        "fc2",
        "report_outcome",
        "Recorded and escalated to the Firstmate agent.",
      ),
      callEntry("f6", "f5", T0 + 2500, [], "Escalated."),
      // A clean turn that never reported.
      userEntry(
        "u1",
        "f6",
        T0 + 60_000,
        `[wake] [fm-op] crewmate 1 reported on task t-r2 "Fix flaky test": hm\n\n[context] task t-r2 "Fix flaky test"`,
      ),
      callEntry("u2", "u1", T0 + 61_000, [], "Not sure."),
    ];
    writeFileSync(sessionFile, `${lines.join("\n")}\n`);
    // A backup copy of the same session in the sessions dir: never double-counted.
    writeFileSync(join(sessions, "backup-copy.jsonl"), `${lines.slice(0, 8).join("\n")}\n`);
    new SettingsStore(db).setSupervisionSessionFile(sessionFile);

    insertOutcome(db, {
      id: 1,
      task_id: "t-old",
      wake: QUOTING,
      verdict: "routine",
      summary: "Old work is fine.",
      at: T0 - 27_995,
      model: "gpt-5.6-luna",
      prompt_sha: "old-prompt",
      tools_sha: "old-tools",
      wake_kind: "crewmate-report",
      missed_escalation: 1,
      missed_note: "should have told me",
      missed_at: T0 + 100_000,
    });
    insertOutcome(db, {
      id: 2,
      task_id: "t-r2",
      wake: WAKE,
      verdict: "captain",
      summary: "Ready to merge.",
      at: T0 + 2005,
      model: "gpt-5.6-luna",
      prompt_sha: "prompt-sha-sv",
      tools_sha: "names-sha",
      wake_kind: "crewmate-report",
    });
    // A pre-R2 host-sorted repeat: no model, and an earlier row triaged the same wake.
    const repeatWake = '[fm-op] crewmate 1 reported on task t-repeat "Repeated update": done';
    insertOutcome(db, {
      id: 3,
      task_id: "t-repeat",
      wake: repeatWake,
      verdict: "routine",
      summary: "Done.",
      at: T0 - 50_000,
      model: "gpt-5.6-luna",
      prompt_sha: "p",
    });
    insertOutcome(db, {
      id: 4,
      task_id: "t-repeat",
      wake: repeatWake,
      verdict: "routine",
      summary: "same again",
      at: T0 - 40_000,
    });
    // An R2 host-sorted repeat: joined by id, no model turn.
    insertOutcome(db, {
      id: 5,
      task_id: "t-repeat",
      wake: repeatWake,
      verdict: "routine",
      summary: "same again",
      at: T0 + 90_000,
    });
    // The taskless-wake tripwire.
    insertOutcome(db, {
      id: 6,
      task_id: "fleet",
      wake: "[fm-op] fleet-wide notice",
      verdict: "routine",
      summary: "Nothing to do.",
      at: T0 - 20_000_000,
    });

    now = T0 + 3000;
    tasks.turns.recordDecision(
      decision({
        id: "sv-r2",
        taskId: "t-r2",
        at: T0,
        // Recorded on another machine: joined by the file's name, not its path.
        sessionFile: `/Users/someone-else/userData/supervision/sessions/${"2026-09-17T10-00-00-000Z_sv.jsonl"}`,
        entryId: "f1",
        textSha256: await sha256(framed.text),
        toolCalls: [
          { id: "fc1", name: "crew_status" },
          { id: "fc2", name: "report_outcome" },
        ],
        verdict: "captain",
        outcomeId: 2,
        handoffInboxId: 77,
        inboxId: 31,
      }),
    );
    tasks.turns.recordDecision(
      decision({
        id: "sv-repeat",
        actor: "host",
        taskId: "t-repeat",
        at: T0 + 90_000,
        sessionFile: null,
        entryId: null,
        textSha256: "",
        toolCalls: [],
        verdict: "routine",
        outcomeId: 5,
        inboxId: 32,
        served: false,
      }),
    );
    tasks.turns.recordSteer("t-r2", {
      text: "rerun the suite",
      actor: "captain",
      outcome: "queued-next-turn",
      via: "card",
      decision: null,
      cardId: "card-t-r2-1",
      inboxId: 90,
    });
    db.close();
    return { userData, sessionFile };
  }

  it("joins a framed turn by id, history by text, and explains every miss", async () => {
    const { userData, sessionFile } = await buildUserData();
    const out = join(dir, "turns.jsonl");
    const { code, stderr } = runCli(["--user-data", userData, "--out", out]);
    expect(code).toBe(0);
    const records = readJsonl<SupervisionTurnRecord>(out);
    const byOutcome = new Map(records.map((record) => [record.outcome_id, record]));

    const r2 = byOutcome.get(2) as SupervisionTurnRecord;
    expect(r2.join_basis).toBe("decision-id");
    expect(r2.id).toBe("decision:sv-r2");
    expect(r2.transcript).toEqual({
      file: sessionFile,
      header_id: "sv-session",
      entry_id: "f1",
      parent_entry_id: "h6",
    });
    expect(r2.served?.frame_basis).toBe("structural-frame");
    expect(r2.served?.segments?.map((segment) => segment.kind)).toEqual(["wake", "context"]);
    expect(r2.served?.segments?.[0]).toEqual({
      kind: "wake",
      origin: "crewmate-report",
      body: `[wake] ${WAKE}`,
    });
    expect(r2.served?.segments?.[1]?.origin).toBeUndefined();
    expect(r2.decision).toMatchObject({
      id: "sv-r2",
      actor: "supervisor",
      handoff_inbox_id: 77,
      text_sha_matches: true,
      unmatched_tool_call_ids: [],
    });
    expect(r2.crew_status).toEqual([
      {
        id: "fc1",
        name: "crew_status",
        args: {},
        result: { text: '[{"taskId":"t-r2","status":"idle"}]', isError: false, at: T0 + 1100 },
      },
    ]);
    expect(r2.report_outcome?.args).toEqual({
      task_id: "t-r2",
      verdict: "captain",
      summary: "Ready to merge.",
    });
    expect(r2.assistant).toBe("Escalated.");
    expect(r2.contract).toEqual({
      version: FIRSTMATE_CONTRACT_VERSION,
      prompt_sha: "prompt-sha-sv",
      tools_sha: "tools-sha-sv",
    });
    expect(r2.prefix_message_count).toBe(42);
    expect(r2.row_provenance).toEqual({
      model: "gpt-5.6-luna",
      prompt_sha: "prompt-sha-sv",
      tools_sha: "names-sha",
    });
    expect(r2.model).toBe("openai-codex/gpt-5.6-luna");

    const old = byOutcome.get(1) as SupervisionTurnRecord;
    expect(old.join_basis).toBe("text-exact");
    expect(old.contract).toBeNull();
    // The stored wake quotes `\n\n[context]`; the joined row puts the boundary where the host did.
    expect(old.served?.frame_basis).toBe("reframed-exact");
    expect(old.served?.segments?.[0]?.body).toBe(`[wake] ${QUOTING}`);
    expect(old.served?.segments?.every((segment) => segment.origin === undefined)).toBe(true);
    expect(old.served?.segments?.[1]?.body.startsWith('[context] task t-old "Old work"')).toBe(
      true,
    );
    expect(old.label).toEqual({
      missed_escalation: true,
      missed_note: "should have told me",
      missed_at: T0 + 100_000,
    });
    // Redacted at the record boundary: the planted key never survives.
    expect(JSON.stringify(old)).not.toContain(LIVE_KEY);

    expect(byOutcome.get(5)).toMatchObject({
      join_basis: "decision-id",
      transcript: null,
      served: null,
      miss: null,
    });
    expect(byOutcome.get(3)?.miss?.reason).toBe("outside-session-coverage");
    expect(byOutcome.get(4)?.miss?.reason).toBe("outside-session-coverage");
    expect(byOutcome.get(6)?.miss?.reason).toBe("outside-session-coverage");

    const unreported = records.find((record) => record.transcript?.entry_id === "u1");
    expect(unreported).toMatchObject({
      join_basis: "unjoined",
      outcome_id: null,
      miss: { reason: "unreported" },
    });

    // One record per outcome row plus one per unjoined served turn; the backup is excluded.
    expect(records).toHaveLength(7);
    expect(
      records.every((record) => record.join_basis !== "unjoined" || record.miss !== null),
    ).toBe(true);
    expect(stderr).toContain("1 backup copy/copies excluded");
    expect(stderr).toContain("warning: supervision_outcomes #6 has task_id 'fleet'");
  });

  it("is the corpus export's supervision-turns.jsonl, beside the R2 provenance rows", async () => {
    const { userData } = await buildUserData();
    const out = join(dir, "corpus");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(exportMain(["--user-data", userData, "--out", out], OPEN_GATE)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const turns = readJsonl<SupervisionTurnRecord>(join(out, "supervision-turns.jsonl"));
    expect(turns.find((record) => record.outcome_id === 2)?.join_basis).toBe("decision-id");
    const events = readJsonl<{ kind: string; ref: string | null; task_id: string; data: unknown }>(
      join(out, "decisions.jsonl"),
    );
    expect(events.map((event) => [event.kind, event.task_id, event.ref])).toEqual([
      ["decided", "t-r2", "sv-r2"],
      ["steered", "t-r2", null],
      ["decided", "t-repeat", "sv-repeat"],
    ]);
    expect(events[1]?.data).toEqual({
      outcome: "queued-next-turn",
      via: "card",
      decision: null,
      cardId: "card-t-r2-1",
      inboxId: 90,
    });
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.supervision_turns).toMatchObject({
      records: 7,
      outcome_rows: 6,
      decisions: 2,
      by_join_basis: { "decision-id": 2, "text-exact": 1, unjoined: 4 },
      unjoined_rows: 3,
      unjoined_turns: 1,
    });
    expect(manifest.supervision_turns.warnings).toHaveLength(1);
    expect(manifest.provenance_events).toEqual({ records: 3, by_kind: { decided: 2, steered: 1 } });
  });

  it("reads nothing when the gate is shut", async () => {
    const { userData } = await buildUserData();
    const out = join(dir, "never.jsonl");
    let stderr = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      expect(main(["--user-data", userData, "--out", out], { isPackaged: true, env: {} })).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(stderr).toContain("local-development only");
    expect(() => readFileSync(out)).toThrow();
  });
});

describe("supervision-turn extractor - archive scope", () => {
  it("retains a current rule outcome without inventing a supervision transcript in either export", () => {
    const userData = join(dir, "current");
    const db = openDatabase(userData);
    let outcomeId: number;
    try {
      const tasks = new TaskService({ db, strict: true });
      seedTask(tasks, {
        id: "current-task",
        title: "Current work",
        prompt: "brief",
        status: "idle",
      });
      outcomeId = new DecisionStore(db).recordSort({
        taskId: "current-task",
        wake: "crewmate reported: checks passed",
        verdict: "captain",
        summary: "The captain can merge the change.",
        rule: "captain",
      });
    } finally {
      db.close();
    }
    const out = join(dir, "current-turns.jsonl");
    expect(runCli(["--user-data", userData, "--out", out]).code).toBe(0);
    const records = readJsonl<SupervisionTurnRecord>(out);
    expect(records).toEqual([
      expect.objectContaining({
        outcome_id: outcomeId,
        join_basis: "unjoined",
        miss: expect.objectContaining({ reason: "outside-session-coverage" }),
        transcript: null,
        served: null,
        row_provenance: expect.objectContaining({ model: "rule:captain" }),
      }),
    ]);
    const corpus = join(dir, "current-corpus");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(exportMain(["--user-data", userData, "--out", corpus], OPEN_GATE)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(readJsonl<SupervisionTurnRecord>(join(corpus, "supervision-turns.jsonl"))).toEqual(
      records,
    );
    expect(readJsonl(join(corpus, "supervision.jsonl"))).toEqual([
      expect.objectContaining({ outcome_id: outcomeId, observed_verdict: "captain" }),
    ]);
    expect(existsSync(join(userData, "supervision"))).toBe(false);
  });
});
