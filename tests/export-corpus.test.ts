import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@core/storage/cardStore";
import { openDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import type { WorkShape } from "@shared/routingPolicy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFleetTables } from "../scripts/dispatch-corpus/fleetTables.ts";
import {
  type CorpusExportResult,
  detectPackaged,
  exportCorpus,
  main,
  parseArgs,
  readSupervisionOutcomes,
  routingDispatches,
  type SupervisionRecord,
} from "../scripts/export-corpus.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The live corpus is on whichever machine the captain dogfoods on, so the
 * export is proven here against a fixture userData built with the app's OWN
 * migrations and stores: the schema under test is the real one, only the
 * rows are ours. The gate is proven both ways, because a packaged build that
 * exports transcripts is the failure this command must never have.
 */

const CONTEXT = [
  "[fm-op] context (not the user)",
  "repos:",
  "- nimbus-api (repo_id: repo-nimbus) /fleet/nimbus-api [clone, direct-pr, autonomy on]",
  "crew:",
  '- task t-flaky idle "Stabilize flaky tests" repo nimbus-api',
  "quota: anthropic 42% used",
].join("\n");

let stamp = Date.parse("2026-09-01T10:00:00.000Z");
function nextStamp(): string {
  stamp += 1000;
  return new Date(stamp).toISOString();
}

let entryId = 0;
function userEntry(text: string): string {
  entryId += 1;
  return JSON.stringify({
    type: "message",
    id: `e${entryId}`,
    parentId: null,
    timestamp: nextStamp(),
    message: { role: "user", content: text, timestamp: stamp },
  });
}

function assistantEntry(
  text: string,
  calls: { id: string; name: string; args: Record<string, unknown> }[] = [],
  stopReason = "toolUse",
): string {
  entryId += 1;
  return JSON.stringify({
    type: "message",
    id: `e${entryId}`,
    parentId: null,
    timestamp: nextStamp(),
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
      provider: "anthropic",
      model: "claude-fable-5",
      stopReason,
    },
  });
}

function toolResultEntry(callId: string, toolName: string, text: string): string {
  entryId += 1;
  return JSON.stringify({
    type: "message",
    id: `e${entryId}`,
    parentId: null,
    timestamp: nextStamp(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: stamp,
    },
  });
}

function fixtureJsonl(): string {
  return `${[
    JSON.stringify({ type: "session", version: 3, id: "sess-fm", timestamp: nextStamp() }),
    userEntry(`${CONTEXT}\n\n[user]\nFix the flaky tests in nimbus-api.`),
    assistantEntry("", [
      {
        id: "c1",
        name: "spawn_crewmate",
        args: {
          title: "Stabilize flaky tests",
          goal: "Stabilize the flaky tests.",
          user_words: "Fix the flaky tests in nimbus-api.",
          repo_id: "repo-nimbus",
        },
      },
    ]),
    toolResultEntry("c1", "spawn_crewmate", "Commissioned crewmate 1 on task t-flaky."),
    assistantEntry("done", [], "stop"),
    userEntry(`${CONTEXT}\n\n[user]\nAnything with the key sk-ant-api03-LIVEKEY?`),
    assistantEntry("", [
      { id: "c2", name: "emit_card", args: { kind: "note", title: "No", body: "Nothing." } },
    ]),
    toolResultEntry("c2", "emit_card", "Card shown: No (card-none)"),
    assistantEntry("done", [], "stop"),
  ].join("\n")}\n`;
}

function buildFixtureUserData(dir: string): void {
  const db = openDatabase(dir);
  db.prepare(
    "INSERT INTO repos (id, path, name, setup_kind, origin, delivery, autonomy, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("repo-nimbus", "/fleet/nimbus-api", "nimbus-api", "clone", null, "direct-pr", 1, 1);

  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "t-flaky",
    title: "Stabilize flaky tests",
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-flaky",
    branch: "fm/flaky",
    sessionFile: null,
    accountId: null,
    status: "idle",
    difficulty: "high",
    // A pre-S7b row: `kind_confidence` is history the exporter still passes
    // through verbatim; the schema no longer names it.
    shape: {
      kind: "fix",
      kind_source: "classifier:xai/grok-4.6",
      kind_confidence: 0.9,
    } as unknown as WorkShape,
    createdAt: 10,
  });
  // The captain rejected that attempt and bought one rung (S4), so the
  // lineage carries an escalation the S5 rollup counts.
  seedTask(tasks, {
    id: "t-flaky-2",
    title: "Stabilize flaky tests (escalated)",
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-flaky-2",
    branch: "fm/flaky-2",
    sessionFile: null,
    accountId: null,
    status: "running",
    difficulty: "premium",
    shape: {
      kind: "fix",
      kind_source: "skipped:escalation",
      escalate_from: "t-flaky",
      escalation: { from: "t-flaky", attempt: 1, floor: "premium" },
    },
    createdAt: 11,
  });

  const cards = new CardStore(db);
  cards.upsert({
    id: "card-answered",
    author: "firstmate",
    priority: 2,
    title: "Land the flaky-test fix?",
    meta: "",
    body: "CI is green.",
    actions: [
      { id: "land", label: "Land it" },
      { id: "wait", label: "Wait" },
    ],
    status: "ready",
    createdAt: 20,
  });
  cards.resolve("card-answered", "land");
  cards.upsert({
    id: "card-dismissed",
    author: "firstmate",
    priority: 2,
    title: "Rebase the branch?",
    meta: "",
    body: "It is behind main.",
    actions: [{ id: "rebase", label: "Rebase" }],
    status: "ready",
    createdAt: 21,
  });
  cards.resolve("card-dismissed", "dismiss");
  db.prepare(
    "UPDATE cards SET kind = 'decision' WHERE id IN ('card-answered', 'card-dismissed')",
  ).run();
  // WI-14: the captain confirmed the rebase card repeated the landing one.
  cards.flagDuplicate({
    cardId: "card-dismissed",
    duplicateOf: "card-answered",
    note: "same question as the landing card",
    at: 30,
  });

  const supervision = new DecisionStore(db);
  // 1 - an escalation the captain acted on: corroborated precision.
  supervision.recordSort({
    taskId: "t-flaky",
    wake: "crewmate reported: CI green, PR open",
    verdict: "captain",
    summary: "Landing needs a call.",
    cardId: "card-answered",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    steered: false,
    wakeKind: "task_finished",
  });
  // 2 - an escalation the captain dismissed: contradicted.
  supervision.recordSort({
    taskId: "t-flaky",
    wake: "crewmate reported: branch is behind main",
    verdict: "captain",
    summary: "Rebase needs a call.",
    cardId: "card-dismissed",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    steered: false,
    wakeKind: "task_report",
  });
  // 3 - a routine verdict the captain later confirmed was a miss (C3).
  supervision.recordSort({
    taskId: "t-flaky",
    wake: "crewmate reported: rewrote the fixture clock",
    verdict: "routine",
    summary: "Noted, nothing for the captain.",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-b",
    toolsSha: "tools-a",
    steered: true,
    wakeKind: "task_report",
  });
  supervision.flagMissedEscalation({
    taskId: "t-flaky",
    note: "Rewriting a fixture clock is my call, not yours.",
    at: 30,
  });
  // 4 - a plain routine verdict with a provenance stamp.
  supervision.recordSort({
    taskId: "t-flaky",
    wake: "crewmate reported: ran the test suite",
    verdict: "routine",
    summary: "Routine progress.",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-b",
    toolsSha: "tools-a",
    wakeKind: "task_report",
  });
  // 5 - a pre-migration-15 shaped row (no stamp) on a task with no row left.
  supervision.recordSort({
    taskId: "t-gone",
    wake: "crewmate reported with the key sk-ant-api03-LIVEKEY",
    verdict: "routine",
    summary: "Routine.",
  });
  // The two dispatches' routing decisions, after the sort rows so each
  // outcome keeps the id the assertions name: the ledger numbers every kind
  // in one sequence.
  db.prepare(
    "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("t-flaky", "xai", "grok-4.6", "high", "R5", "medium", "[]", 12);
  db.prepare(
    "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("t-flaky-2", "anthropic", "claude-fable-5-1", "premium", "R1b", "premium", "[]", 13);

  const sessionsDir = join(dir, "firstmate", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "sess-fm.jsonl");
  writeFileSync(sessionFile, fixtureJsonl());
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "firstmate-session-file",
    sessionFile,
  );
  db.close();
}

function exported(result: CorpusExportResult): Extract<CorpusExportResult, { status: "exported" }> {
  if (result.status !== "exported") throw new Error(`expected an export, got ${result.status}`);
  return result;
}

describe("corpus export - the hard gate", () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = scratchDir("infinitary-c4-gate-");
    buildFixtureUserData(dir);
    out = join(dir, "corpus");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const options = () => ({
    dbPath: join(dir, "firstmate.db"),
    sessionsDir: join(dir, "firstmate", "sessions"),
    outDir: out,
  });

  it("refuses a packaged build with INFINITARY_DEV_OBSERVE unset, and writes nothing", () => {
    const result = exportCorpus({ ...options(), gate: { isPackaged: true } });
    expect(result.status).toBe("blocked");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses every value of the flag except exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const result = exportCorpus({
        ...options(),
        gate: { isPackaged: true, env: { INFINITARY_DEV_OBSERVE: value } },
      });
      expect(result.status).toBe("blocked");
    }
    expect(existsSync(out)).toBe(false);
  });

  it("exports for an unpackaged build, and for a packaged build with the explicit override", () => {
    expect(exportCorpus({ ...options(), gate: { isPackaged: false } }).status).toBe("exported");
    rmSync(out, { recursive: true, force: true });
    expect(
      exportCorpus({
        ...options(),
        gate: { isPackaged: true, env: { INFINITARY_DEV_OBSERVE: "1" } },
      }).status,
    ).toBe("exported");
  });

  it("reads packaged-ness off where the script actually sits, and only ever tightens", () => {
    expect(detectPackaged({ moduleUrl: "/repo/scripts/export-corpus.ts" })).toBe(false);
    expect(detectPackaged({ moduleUrl: "file:///repo/scripts/export-corpus.ts" })).toBe(false);
    expect(
      detectPackaged({
        moduleUrl: "/Applications/Firstmate 3000.app/Contents/Resources/self-source/scripts/x.ts",
      }),
    ).toBe(true);
    expect(
      detectPackaged({ moduleUrl: "/Applications/App.app/Contents/Resources/app.asar/x.js" }),
    ).toBe(true);
    // The env var can declare a build packaged; it can never declare one loose.
    expect(
      detectPackaged({ moduleUrl: "/repo/scripts/x.ts", env: { INFINITARY_PACKAGED: "1" } }),
    ).toBe(true);
    expect(
      detectPackaged({
        moduleUrl: "/Applications/App.app/Contents/Resources/app.asar/x.js",
        env: { INFINITARY_PACKAGED: "0" },
      }),
    ).toBe(true);
  });

  it("exits non-zero from the CLI when the gate is shut", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(main(["--out", out, "--user-data", dir], { isPackaged: true, env: {} })).toBe(3);
      expect(existsSync(out)).toBe(false);
      expect(main(["--out", out, "--user-data", dir], { isPackaged: false })).toBe(0);
      expect(existsSync(join(out, "manifest.json"))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("corpus export - over a fixture userData", () => {
  let dir: string;
  let result: Extract<CorpusExportResult, { status: "exported" }>;
  const byId = (id: number): SupervisionRecord => {
    const record = result.supervision.find((row) => row.outcome_id === id);
    if (!record) throw new Error(`no supervision record ${id}`);
    return record;
  };

  beforeEach(() => {
    dir = scratchDir("infinitary-c4-");
    buildFixtureUserData(dir);
    result = exported(
      exportCorpus({
        gate: { isPackaged: false },
        dbPath: join(dir, "firstmate.db"),
        sessionsDir: join(dir, "firstmate", "sessions"),
        outDir: join(dir, "corpus"),
        now: Date.parse("2026-09-01T12:00:00.000Z"),
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the five corpus files and nothing else", () => {
    expect(result.files.map((file) => file.split("/").pop())).toEqual([
      "supervision.jsonl",
      "supervision-turns.jsonl",
      "decisions.jsonl",
      "dispatch.jsonl",
      "manifest.json",
    ]);
    const supervision = readFileSync(join(result.outDir, "supervision.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SupervisionRecord);
    expect(supervision).toHaveLength(5);
    expect(supervision.every((row) => row.dataset === "supervision")).toBe(true);
    const dispatch = readFileSync(join(result.outDir, "dispatch.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { observed_class: string });
    expect(dispatch.map((row) => row.observed_class)).toEqual(["spawn", "answer"]);
  });

  it("carries C1's provenance so the corpus can be sliced by prompt version", () => {
    expect(byId(1).provenance).toEqual({
      model: "ollama/gemma4:12b",
      prompt_sha: "prompt-a",
      tools_sha: "tools-a",
      versioned: true,
    });
    expect(byId(5).provenance).toEqual({
      model: null,
      prompt_sha: null,
      tools_sha: null,
      versioned: false,
    });
    expect(byId(5).label.evidence.join(" ")).toContain("predates migration 15");
    expect(result.manifest.supervision.by_prompt_sha).toEqual({
      "prompt-a": 2,
      "prompt-b": 2,
      unstamped: 1,
    });
    expect(result.manifest.supervision.with_provenance).toBe(4);
  });

  it("labels precision from the card join the captain answered", () => {
    const acted = byId(1);
    expect(acted.card).toMatchObject({ card_id: "card-answered", resolution: "acted" });
    expect(acted.label).toMatchObject({ gold_verdict: "captain", confidence: "corroborated" });
    const dismissed = byId(2);
    expect(dismissed.card).toMatchObject({ resolution: "dismissed" });
    expect(dismissed.label.confidence).toBe("contradicted");
  });

  it("carries the captain-confirmed duplicate label on the card join (WI-14)", () => {
    expect(byId(2).card).toMatchObject({
      card_id: "card-dismissed",
      duplicate_of: "card-answered",
      duplicate_note: "same question as the landing card",
      duplicate_at: 30,
    });
    // An unflagged card is no label, never a confirmed non-duplicate.
    expect(byId(1).card).toMatchObject({
      duplicate_of: null,
      duplicate_note: null,
      duplicate_at: null,
    });
  });

  it("carries C3's confirmed miss as the one gold label in the set", () => {
    const missed = byId(3);
    expect(missed.observed_verdict).toBe("routine");
    expect(missed.label).toMatchObject({
      gold_verdict: "captain",
      weak: false,
      confidence: "confirmed",
      missed_escalation: true,
      missed_at: 30,
    });
    expect(missed.label.missed_note).toContain("fixture clock");
    // An unflagged routine row is no label at all, never a confirmed negative.
    expect(byId(4).label).toMatchObject({
      gold_verdict: "routine",
      weak: true,
      confidence: "observed",
      missed_escalation: null,
    });
    expect(result.manifest.supervision.confirmed_misses).toBe(1);
  });

  it("joins the task and its repo posture, and records an absent one honestly", () => {
    expect(byId(1).task).toEqual({
      task_id: "t-flaky",
      found: true,
      title: "Stabilize flaky tests",
      // The tasks table's own status vocabulary (task-system P0): an idle
      // crewmate is an active record whose activity is idle.
      status: "active",
      kind: "work",
      repo_id: "repo-nimbus",
      repo_name: "nimbus-api",
      delivery: "direct-pr",
      autonomy: true,
      // The routing facts ride the supervision join too (S5): the shape the
      // host computed - classifier stamp and all - the rule that read it,
      // the tier asked for and the tier served.
      // A pre-S7b row: `kind_confidence` is history the exporter still passes
      // through verbatim; the schema no longer names it.
      shape: {
        kind: "fix",
        kind_source: "classifier:xai/grok-4.6",
        kind_confidence: 0.9,
      } as unknown as WorkShape,
      tier: "high",
      rule: "R5",
      served: "medium",
    });
    expect(byId(5).task).toEqual({ task_id: "t-gone", found: false });
  });

  it("rolls up how the fleet's work was routed, scored by the one home (S5)", () => {
    const routing = result.manifest.routing;
    expect(routing.dispatches).toBe(2);
    expect(routing.by_tier).toEqual({ high: 1, premium: 1 });
    expect(routing.by_served).toEqual({ medium: 1, premium: 1 });
    expect(routing.by_rule).toEqual({ R5: 1, R1b: 1 });
    expect(routing.by_kind_source).toEqual({
      "classifier:xai/grok-4.6": 1,
      "skipped:escalation": 1,
    });
    expect(routing.by_kind_source_class).toEqual({ classified: 1, skipped: 1 });
    expect(routing.escalated_lineages).toBe(1);
    // The numbers are the metric module's, not a second implementation: one
    // of two dispatches was downgraded, one lineage spent one escalation,
    // and the tier mix is a distribution, never a verdict.
    expect(routing.metrics).toMatchObject({
      tier_share_premium: 0.5,
      tier_share_high: 0.5,
      tier_share_medium: 0,
      tier_share_low: 0,
      kind_classified_share: 0.5,
      kind_skipped_share: 0.5,
      kind_abstained_share: 0,
      kind_failed_share: 0,
      tier_downgrade_rate: 0.5,
      escalations_per_lineage: 1,
    });
  });

  it("redacts credentials out of both halves of the corpus", () => {
    const raw = readFileSync(join(result.outDir, "supervision.jsonl"), "utf8");
    expect(raw).not.toContain("LIVEKEY");
    expect(byId(5).wake).toContain("[redacted api key]");
    expect(readFileSync(join(result.outDir, "dispatch.jsonl"), "utf8")).not.toContain("LIVEKEY");
  });

  it("writes a manifest that says what was packaged and how the gate opened", () => {
    const manifest = JSON.parse(readFileSync(join(result.outDir, "manifest.json"), "utf8"));
    expect(manifest.generated_at).toBe("2026-09-01T12:00:00.000Z");
    expect(manifest.gate).toEqual({ is_packaged: false, dev_observe_override: false });
    expect(manifest.sources.transcripts).toHaveLength(1);
    expect(manifest.supervision).toMatchObject({
      records: 5,
      by_verdict: { captain: 2, routine: 3 },
      by_confidence: { corroborated: 1, contradicted: 1, confirmed: 1, observed: 2 },
      card_joined: 2,
    });
    expect(manifest.dispatch).toMatchObject({ records: 2, by_class: { spawn: 1, answer: 1 } });
  });

  it("returns the same redacted manifest it writes", () => {
    const secretSession = join(dir, "firstmate", "sessions", "password=OPAQUEMANIFEST.jsonl");
    writeFileSync(
      secretSession,
      readFileSync(join(dir, "firstmate", "sessions", "sess-fm.jsonl"), "utf8"),
    );
    const secretResult = exported(
      exportCorpus({
        gate: { isPackaged: false },
        dbPath: join(dir, "firstmate.db"),
        sessionFiles: [secretSession],
        outDir: join(dir, "corpus-secret"),
        now: Date.parse("2026-09-01T12:00:00.000Z"),
      }),
    );
    const written = JSON.parse(readFileSync(join(secretResult.outDir, "manifest.json"), "utf8"));
    expect(secretResult.manifest).toEqual(written);
    expect(JSON.stringify(secretResult)).not.toContain("OPAQUEMANIFEST");
  });

  it("exports the dispatch half with no database at all", () => {
    const noDb = exported(
      exportCorpus({
        gate: { isPackaged: false },
        dbPath: join(dir, "does-not-exist.db"),
        sessionsDir: join(dir, "firstmate", "sessions"),
        outDir: join(dir, "corpus-nodb"),
      }),
    );
    expect(noDb.supervision).toEqual([]);
    expect(noDb.manifest.sources.db).toBeNull();
    expect(noDb.dispatch).toHaveLength(2);
    expect(readFileSync(join(noDb.outDir, "supervision.jsonl"), "utf8")).toBe("");
  });

  it("packages a Claude-served Firstmate session beside the Pi one (W1 S11)", () => {
    const claudeDir = join(__dirname, "fixtures", "replay", "sep26-claude", "firstmate", "claude");
    const both = exported(
      exportCorpus({
        gate: { isPackaged: false },
        dbPath: join(dir, "does-not-exist.db"),
        sessionsDir: join(dir, "firstmate", "sessions"),
        claudeSessionsDir: claudeDir,
        outDir: join(dir, "corpus-both-seats"),
      }),
    );
    // The two Pi turns, and the Claude session's five - its sidecar is not a transcript.
    expect(both.dispatch).toHaveLength(7);
    expect(both.manifest.sources.transcripts).toHaveLength(2);
    expect(both.manifest.sources.transcripts.some((file) => file.startsWith(claudeDir))).toBe(true);
    expect(
      both.dispatch
        .filter((record) => record.model === "anthropic-claude/mock-1")
        .map((record) => record.observed_class),
    ).toEqual(["spawn", "answer", "spawn", "ask", "none"]);
  });

  it("reads a database with no supervision table as empty, not as a crash", () => {
    const bare = scratchDir("infinitary-c4-bare-");
    try {
      openDatabase(bare, 12).close();
      expect(readSupervisionOutcomes(join(bare, "firstmate.db"))).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("corpus export - CLI arguments", () => {
  it("derives every path from --user-data and requires an output directory", () => {
    const args = parseArgs(["--user-data", "/exported/userData", "--out", "/tmp/corpus"]);
    expect(args.dbPath).toBe("/exported/userData/firstmate.db");
    expect(args.sessionsDir).toBe("/exported/userData/firstmate/sessions");
    expect(args.claudeSessionsDir).toBe("/exported/userData/firstmate/claude");
    expect(args.outDir).toBe("/tmp/corpus");
    expect(args.includeOps).toBe(true);
    expect(() => parseArgs(["--user-data", "/exported/userData"])).toThrow("--out");
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("takes explicit inputs so an exported copy runs identically", () => {
    const args = parseArgs([
      "--db",
      "/copy/firstmate.db",
      "--session-file",
      "/copy/a.jsonl",
      "--session-file",
      "/copy/b.jsonl",
      "-o",
      "/tmp/corpus",
      "--user-turns-only",
    ]);
    expect(args.dbPath).toBe("/copy/firstmate.db");
    expect(args.sessionFiles).toEqual(["/copy/a.jsonl", "/copy/b.jsonl"]);
    expect(args.includeOps).toBe(false);
  });
});

it("does not count policy-edited queued or dropped work as dispatches, and retains the actual dispatch care", () => {
  const dir = scratchDir("fm-policy-corpus-");
  const db = openDatabase(dir);
  const tasks = new TaskService({ db });
  const task = seedTask(tasks, { id: "policy-queued", title: "Queued work", status: "queued" });
  tasks.updateFields(task.id, { policies: { rigor: "reviewed" } }, "firstmate");
  const readings = () => routingDispatches(readFleetTables(join(dir, "firstmate.db")));
  expect(readings()).toEqual([]);
  tasks.close(task.id, { status: "dropped", reason: "discarded", actor: "captain" });
  expect(readings()).toEqual([]);
  const started = seedTask(tasks, {
    id: "policy-started",
    title: "Started work",
    status: "idle",
    shape: { kind: "fix", rigor: "quick" },
  });
  tasks.updateFields(started.id, { policies: { rigor: "standard" } }, "firstmate");
  tasks.close(started.id, { status: "done", reason: "landed", actor: "captain" });
  expect(readings()).toMatchObject([{ taskId: started.id, rigor: "quick" }]);
  db.close();
});
