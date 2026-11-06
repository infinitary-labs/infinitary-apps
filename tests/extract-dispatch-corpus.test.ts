import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FIRSTMATE_TOOLS } from "@core/session/tools";
import { CardStore } from "@core/storage/cardStore";
import { openDatabase } from "@core/storage/db";
import { SettingsStore } from "@core/storage/settingsStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { seedProject } from "@core/workspace/seedProject";
import type { WorkShape } from "@shared/routingPolicy";
import { frameServedInput } from "@shared/servedFrame";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolutionOf } from "../scripts/dispatch-corpus/cards.ts";
import {
  classifyTurn,
  extractTurnsFromJsonl,
  inferClassFromNames,
  parseContextBlock,
} from "../scripts/dispatch-corpus/dispatchTurns.ts";
import { EMPTY_TABLES } from "../scripts/dispatch-corpus/fleetTables.ts";
import { defaultUserDataDir } from "../scripts/dispatch-corpus/userData.ts";
import {
  buildRecord,
  type DispatchRecord,
  extractDispatchCorpus,
  main,
  parseArgs,
} from "../scripts/extract-dispatch-corpus.ts";
import { RELEASE_USER_DATA_FOLDER, USER_DATA_FOLDERS } from "../src/shared/userDataFolders";
import { scratchDir } from "./helpers/scratchDirs";
import { withScratchHome } from "./helpers/scratchHome";

/**
 * The live transcripts and firstmate.db are on whichever machine the captain
 * dogfoods on, so the extractor is proven here against a fixture userData
 * built with the app's OWN migrations and stores: the schema under test is
 * the real one, only the rows are ours.
 */

const CONTEXT = [
  "[fm-op] context (not the user)",
  "repos:",
  "- nimbus-api (repo_id: repo-nimbus) /fleet/nimbus-api [clone, direct-pr, autonomy off]",
  "- ledgerline-core (repo_id: repo-ledger) /fleet/ledgerline-core [clone, direct-pr, autonomy on]",
  "crew:",
  '- task a1b2c3d4 idle "Stabilize ledger reconciliation tests" repo ledgerline-core',
  '- task queued99 queued "Dark mode" repo nimbus-api (after task a1b2c3d4)',
  "quota: anthropic 42% used",
  "self-source: /Applications/Firstmate 3000.app/Contents/Resources/self-source",
].join("\n");

/**
 * The same block as the task-system P1 agent writes it: a task index and an
 * about line ride between the crew and quota lines. The extractor must read
 * the same fleet out of it - the new lines are for the model, not the corpus.
 */
const CONTEXT_P1 = [
  "[fm-op] context (not the user)",
  "repos:",
  "- nimbus-api (repo_id: repo-nimbus) /fleet/nimbus-api [clone, direct-pr, autonomy off]",
  "- ledgerline-core (repo_id: repo-ledger) /fleet/ledgerline-core [clone, direct-pr, autonomy on]",
  "crew:",
  '- task a1b2c3d4 idle "Stabilize ledger reconciliation tests" repo ledgerline-core',
  '- task queued99 queued "Dark mode" repo nimbus-api (after task a1b2c3d4)',
  "tasks (task_id for tools; kinds other than work are marked):",
  "- LEDG ledgerline-core: 0 open, 1 active, 0 delivered, 1 closed recently",
  '  - LEDG-3 (task_id: a1b2c3d4) idle "Stabilize ledger reconciliation tests"',
  '  - LEDG-2 (task_id: f00dbabe) landed "Ledger export"',
  "- SCR Scratch: 1 open, 0 active, 0 delivered, 4 closed recently",
  '  - SCR-9 (task_id: dec1s10n) decision waiting on you "Which release train?"',
  "quota: anthropic 42% used",
  "self-source: /Applications/Firstmate 3000.app/Contents/Resources/self-source",
  'about: LEDG-3 "Stabilize ledger reconciliation tests" (idle) - task_id a1b2c3d4; the open card points at it',
].join("\n");

let stamp = Date.parse("2026-09-01T10:00:00.000Z");
function nextStamp(): string {
  stamp += 1000;
  return new Date(stamp).toISOString();
}

function header(): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "sess-fm",
    timestamp: nextStamp(),
    cwd: "/userData/firstmate/home",
  });
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

type Call = { id: string; name: string; args: Record<string, unknown> };

function assistantEntry(text: string, calls: Call[] = [], stopReason = "toolUse"): string {
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
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      stopReason,
    },
  });
}

function toolResultEntry(callId: string, toolName: string, text: string, isError = false): string {
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
      isError,
      timestamp: stamp,
    },
  });
}

function turn(userText: string, lines: string[]): string[] {
  return [userEntry(userText), ...lines];
}

function captainTurn(text: string, lines: string[]): string[] {
  return turn(`${CONTEXT}\n\n[user]\n${text}`, lines);
}

function fixtureJsonl(): string {
  const lines = [
    header(),
    // 1 - answer: one note card carrying the answer, then a brief close.
    ...captainTurn("What is the current quota situation?", [
      assistantEntry("", [
        {
          id: "c1",
          name: "emit_card",
          args: {
            kind: "note",
            title: "Quota status",
            body: "anthropic is 42% used.",
            standalone: true,
          },
        },
      ]),
      toolResultEntry("c1", "emit_card", "Card shown: Quota status (card-fm-quota)"),
      assistantEntry("done", [], "stop"),
    ]),
    // 2 - ask: a decision card the captain later answered.
    ...captainTurn("Fix the flaky tests.", [
      assistantEntry("", [
        {
          id: "c2",
          name: "emit_card",
          args: {
            kind: "decision",
            title: "Which repository has the flaky tests?",
            body: "Two repositories run tests.",
            actions: [
              { id: "nimbus", label: "nimbus-api" },
              { id: "ledger", label: "ledgerline-core" },
            ],
          },
        },
      ]),
      toolResultEntry("c2", "emit_card", "Card shown: Which repository (card-fm-which-repo)"),
      assistantEntry("done", [], "stop"),
    ]),
    // 3 - spawn: the task id comes back in the tool result and joins to tasks.
    ...captainTurn("In nimbus-api, add cursor pagination to the list endpoint.", [
      assistantEntry("", [
        {
          id: "c3",
          name: "spawn_crewmate",
          args: {
            title: "Cursor pagination",
            goal: "Add cursor pagination to the list endpoint.",
            user_words: "In nimbus-api, add cursor pagination to the list endpoint.",
            repo_id: "repo-nimbus",
            constraints: [{ kind: "minimal-diff" }],
          },
        },
      ]),
      toolResultEntry("c3", "spawn_crewmate", "Commissioned crewmate 1 on task t-spawned."),
      assistantEntry("done", [], "stop"),
    ]),
    // 4 - steer at a task id no row backs: the join contradicts the turn.
    ...captainTurn("Tell that crewmate to inspect the fixture clock.", [
      assistantEntry("", [
        { id: "c4", name: "steer_crewmate", args: { task_id: "ghost123", text: "inspect it" } },
      ]),
      toolResultEntry("c4", "steer_crewmate", "Steered task ghost123."),
      assistantEntry("done", [], "stop"),
    ]),
    // 5 - settle on a live task.
    ...captainTurn("Land the ledger reconciliation work.", [
      assistantEntry("", [
        { id: "c5", name: "settle_task", args: { task_id: "a1b2c3d4", mode: "land" } },
      ]),
      toolResultEntry("c5", "settle_task", "Landing task a1b2c3d4."),
      assistantEntry("done", [], "stop"),
    ]),
    // 6 - operate: a note written, no card.
    ...captainTurn("Remember that I prefer small diffs.", [
      assistantEntry("", [{ id: "c6", name: "remember", args: { text: "Prefer small diffs." } }]),
      toolResultEntry("c6", "remember", "Noted."),
      assistantEntry("done", [], "stop"),
    ]),
    // 7 - an [fm-op] wake needing nothing: zero tools, closed with a brief response.
    ...turn('[fm-op] crewmate 1 reported on task t-spawned "Cursor pagination": PR is green.', [
      assistantEntry("done", [], "stop"),
    ]),
    // 8 - a typed task lookup turn, and a provider failure with a live key.
    ...captainTurn("What does the routing engine task do?", [
      assistantEntry("", [{ id: "c8", name: "tasks", args: { text: "routing engine" } }]),
      toolResultEntry("c8", "tasks", "The task ranks candidates by spend priority."),
      assistantEntry("", [], "error"),
    ]),
    // A trailing partial write, exactly as a live rolling session can end.
    '{"type":"message","id":"e99"',
  ];
  return `${lines.join("\n")}\n`;
}

function buildFixtureUserData(dir: string): void {
  const db = openDatabase(dir);
  seedProject(db, {
    id: "repo-nimbus",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    addedAt: 1,
  });
  seedProject(db, {
    id: "repo-ledger",
    name: "ledgerline-core",
    path: "/fleet/ledgerline-core",
    delivery: "direct-pr",
    autonomy: true,
    addedAt: 2,
  });

  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "t-spawned",
    title: "Cursor pagination",
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-spawned",
    branch: "fm/pagination",
    sessionFile: null,
    accountId: null,
    status: "completed",
    // What the host routed this work from (S2), and the tier it chose.
    difficulty: "medium",
    // A pre-S7b row: `kind_confidence` is history the extractor still
    // passes through verbatim; the schema no longer names it.
    shape: {
      kind: "implement",
      kind_source: "classifier:xai/grok-4.6",
      kind_confidence: 0.81,
      basis: "FM3K-12",
    } as unknown as WorkShape,
    createdAt: 10,
  });
  // Asked for medium, served low: the ladder found nothing serveable in the
  // slot the policy chose. The `served` column (S5) is what makes that a
  // fact the corpus can count rather than a sentence in the reasons prose.
  db.prepare(
    "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("t-spawned", "openai-codex", "gpt-5.5", "medium", "R4", "low", "[]", 12);
  seedTask(tasks, {
    id: "a1b2c3d4",
    title: "Stabilize ledger reconciliation tests",
    prompt: "brief",
    repoId: "repo-ledger",
    repoDir: "/fleet/ledgerline-core",
    worktreeDir: "/worktrees/a1b2c3d4",
    branch: "fm/recon-tests",
    sessionFile: null,
    accountId: null,
    status: "idle",
    createdAt: 11,
  });

  const cards = new CardStore(db);
  cards.upsert({
    id: "card-fm-quota",
    author: "firstmate",
    priority: 1,
    title: "Quota status",
    meta: "",
    body: "anthropic is 42% used.",
    actions: [],
    status: "ready",
    createdAt: 20,
  });
  cards.upsert({
    id: "card-fm-which-repo",
    author: "firstmate",
    priority: 2,
    title: "Which repository",
    meta: "",
    body: "Two repositories run tests.",
    actions: [
      { id: "nimbus", label: "nimbus-api" },
      { id: "ledger", label: "ledgerline-core" },
    ],
    status: "ready",
    createdAt: 21,
  });
  cards.resolve("card-fm-which-repo", "nimbus");
  cards.resolve("card-fm-quota", "dismiss");

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

describe("dispatch extractor - classification", () => {
  it("maps each dispatch tool to the class the v1 contract gives it", () => {
    expect(inferClassFromNames(["spawn_crewmate"])).toBe("spawn");
    // Class 4 is "spawn or plan" (task-system P2): planning sorts with
    // spawn, shaping the graph is operate, the tasks query is a read.
    expect(inferClassFromNames(["create_task"])).toBe("spawn");
    expect(inferClassFromNames(["link_tasks"])).toBe("operate");
    expect(inferClassFromNames(["update_task", "tasks"])).toBe("operate");
    expect(classifyTurn(["tasks"], []).primary).toBe("answer");
    expect(inferClassFromNames(["settle_task"])).toBe("settle");
    expect(inferClassFromNames(["steer_crewmate"])).toBe("steer");
    expect(inferClassFromNames(["interrupt_crewmate"])).toBe("steer");
    expect(inferClassFromNames(["schedule_prompt"])).toBe("operate");
    expect(inferClassFromNames(["remember"])).toBe("operate");
    expect(inferClassFromNames(["emit_card"])).toBe("answer-or-ask");
    expect(inferClassFromNames([])).toBe("none");
    // Reading tools serve a class; on their own the turn still answered.
    expect(inferClassFromNames(["tasks", "crew_status"])).toBe("answer");
    // Withdrawing a card is hygiene: neutral in a turn, self-management alone.
    expect(inferClassFromNames(["close_card"])).toBe("operate");
    expect(inferClassFromNames(["tasks", "close_card"])).toBe("answer");
    expect(classifyTurn(["close_card"], []).primary).toBe("operate");
    expect(classifyTurn(["emit_card", "close_card"], ["note"]).primary).toBe("answer");
  });

  it("resolves emit_card into answer or ask by the card kind", () => {
    expect(classifyTurn(["emit_card"], ["note"]).primary).toBe("answer");
    expect(classifyTurn(["emit_card"], ["decision"]).primary).toBe("ask");
    expect(classifyTurn(["emit_card"], ["live-prototype"]).primary).toBe("answer");
  });

  it("keeps every class a composed turn exercised, with spawn first", () => {
    const composed = classifyTurn(["tasks", "emit_card", "spawn_crewmate"], ["note"]);
    expect(composed.primary).toBe("spawn");
    expect(composed.classes).toEqual(["spawn", "answer"]);
  });

  it("calls an unrecognised tool other rather than guessing a class", () => {
    expect(inferClassFromNames(["bash"])).toBe("other");
    expect(classifyTurn(["bash"], []).primary).toBe("other");
  });

  it("reads the action catalog's change as operate and its look as a read, keeping the tools it replaced", () => {
    expect(classifyTurn(["app_change"], [])).toEqual({
      primary: "operate",
      classes: ["operate"],
      basis: "tool",
    });
    expect(classifyTurn(["app_state"], [])).toEqual({
      primary: "answer",
      classes: ["answer"],
      basis: "fallback",
    });
    expect(inferClassFromNames(["app_state", "app_change"])).toBe("operate");
    expect(classifyTurn(["app_change", "emit_card"], ["note"]).classes).toEqual([
      "operate",
      "answer",
    ]);
    // A session recorded before the catalog still names the repo tools.
    for (const historical of ["setup_repo", "configure_repo", "unregister_repo"]) {
      expect(classifyTurn([historical], [])).toEqual({
        primary: "operate",
        classes: ["operate"],
        basis: "tool",
      });
    }
  });

  it("reads a panel from elsewhere and the captain's labels as operate, and the knowledge look as a read", () => {
    for (const name of [
      "install_plugin",
      "flag_missed_escalation",
      "flag_duplicate",
      "record_knowledge",
    ]) {
      expect(classifyTurn([name], []), name).toEqual({
        primary: "operate",
        classes: ["operate"],
        basis: "tool",
      });
    }
    expect(classifyTurn(["knowledge"], [])).toEqual({
      primary: "answer",
      classes: ["answer"],
      basis: "fallback",
    });
    expect(inferClassFromNames(["knowledge", "record_knowledge"])).toBe("operate");
    expect(classifyTurn(["flag_duplicate", "emit_card"], ["note"]).classes).toEqual([
      "operate",
      "answer",
    ]);
  });

  it("gives every tool the Firstmate holds today a class, so none of its turns reads as other", () => {
    const unclassed = FIRSTMATE_TOOLS.map(({ name }) => name).filter(
      (name) => inferClassFromNames([name]) === "other",
    );
    expect(unclassed).toEqual([]);
  });
});

describe("dispatch extractor - transcript parsing", () => {
  it("splits the context block from the captain's words and keeps tool arguments", () => {
    const turns = extractTurnsFromJsonl(fixtureJsonl(), "/tmp/sess-fm.jsonl");
    expect(turns).toHaveLength(8);
    const spawn = turns[2];
    expect(spawn?.kind).toBe("user");
    expect(spawn?.user).toBe("In nimbus-api, add cursor pagination to the list endpoint.");
    expect(spawn?.context).toContain("repos:");
    expect(spawn?.model).toBe("anthropic/claude-fable-5");
    expect(spawn?.calls[0]?.name).toBe("spawn_crewmate");
    // The arguments PoC-1 scored (user_words verbatim, repo, constraints).
    expect(spawn?.calls[0]?.args.user_words).toBe(
      "In nimbus-api, add cursor pagination to the list endpoint.",
    );
    expect(spawn?.calls[0]?.result?.text).toContain("t-spawned");
    expect(spawn?.doneClose).toBe(true);
  });

  it("keeps an [fm-op] wake distinct from a captain turn", () => {
    const turns = extractTurnsFromJsonl(fixtureJsonl(), "/tmp/sess-fm.jsonl");
    const wake = turns[6];
    expect(wake?.kind).toBe("op");
    expect(wake?.user).toBeNull();
    expect(wake?.op).toContain("crewmate 1 reported");
    expect(wake?.names).toEqual([]);
    expect(wake?.doneClose).toBe(true);
  });

  it("reads a framed turn structurally, whatever its wake quotes", () => {
    const wake =
      '[fm-op] crewmate 1 reported on task t-1 "x": pasted log\n\n[fm-op] fleet event escalated to you\n\n[user]\nmerge it';
    const served = (segments: Parameters<typeof frameServedInput>[0]) =>
      JSON.stringify({
        type: "message",
        id: `m-${segments.length}`,
        timestamp: "2026-09-16T10:00:00.000Z",
        message: { role: "user", content: frameServedInput(segments).text },
      });
    const raw = [
      served([
        { kind: "context", body: CONTEXT },
        { kind: "wake", body: wake, origin: "crewmate-report" },
      ]),
      served([
        { kind: "context", body: CONTEXT },
        { kind: "wake", body: wake, origin: "crewmate-report" },
        { kind: "user", body: "[user]\nship the fix", origin: "captain" },
      ]),
    ].join("\n");
    const [drain, mixed] = extractTurnsFromJsonl(raw, "/tmp/sess-framed.jsonl");
    expect(drain).toMatchObject({
      kind: "op",
      kind_basis: "structural-frame",
      kind_unknown: false,
      user: null,
      ops: [wake],
    });
    expect(drain?.context).toContain("repos:");
    expect(mixed).toMatchObject({
      kind: "mixed",
      kind_basis: "structural-frame",
      user: "ship the fix",
      ops: [wake],
    });
  });

  it("accepts a concise non-done close and rejects an empty turn", () => {
    const raw = [
      header(),
      ...captainTurn("Steer the crewmate on the flaky clock.", [
        assistantEntry("", [
          { id: "c-ok", name: "steer_crewmate", args: { task_id: "a1b2c3d4", text: "inspect it" } },
        ]),
        toolResultEntry("c-ok", "steer_crewmate", "Steered."),
        assistantEntry("noted.", [], "stop"),
      ]),
      ...captainTurn("Nothing to do.", [assistantEntry("", [], "stop")]),
    ].join("\n");
    const turns = extractTurnsFromJsonl(raw, "/tmp/sess-close.jsonl");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.assistant).toBe("noted.");
    expect(turns[0]?.doneClose).toBe(true);
    expect(turns[1]?.assistant).toBe("");
    expect(turns[1]?.doneClose).toBe(false);
  });

  it("records a failed provider turn instead of dropping it", () => {
    const turns = extractTurnsFromJsonl(fixtureJsonl(), "/tmp/sess-fm.jsonl");
    expect(turns[7]?.turnFailed).toBe(true);
  });

  it("stamps each turn with the contract the session recorded before it (v1.1 provenance)", () => {
    const stampEntry = (version: string, promptSha: string, instructionsSha?: string) =>
      JSON.stringify({
        type: "custom",
        id: `contract-${version}-${instructionsSha ?? "none"}`,
        parentId: null,
        timestamp: nextStamp(),
        customType: "fm-contract",
        data: {
          version,
          prompt_sha: promptSha,
          ...(instructionsSha ? { instructions_sha: instructionsSha } : {}),
        },
      });
    const raw = [
      header(),
      ...captainTurn("Before any stamp.", [assistantEntry("done", [], "stop")]),
      stampEntry("1.1", "sha-one"),
      ...captainTurn("After the stamp.", [assistantEntry("done", [], "stop")]),
      stampEntry("1.2", "sha-two"),
      ...captainTurn("After a newer prompt.", [assistantEntry("done", [], "stop")]),
      stampEntry("4.3", "sha-three", "doc-one"),
      ...captainTurn("With served instructions.", [assistantEntry("done", [], "stop")]),
      stampEntry("4.3", "sha-three", "doc-two"),
      ...captainTurn("After the captain edited them.", [assistantEntry("done", [], "stop")]),
    ].join("\n");
    const turns = extractTurnsFromJsonl(raw, "/sessions/rolling.jsonl");
    expect(turns.map((entry) => entry.contract)).toEqual([
      null,
      { version: "1.1", prompt_sha: "sha-one" },
      { version: "1.2", prompt_sha: "sha-two" },
      { version: "4.3", prompt_sha: "sha-three", instructions_sha: "doc-one" },
      { version: "4.3", prompt_sha: "sha-three", instructions_sha: "doc-two" },
    ]);
  });

  it("keeps matching inputs raw and redacts the finished corpus record", () => {
    const raw = [
      JSON.stringify({ type: "session", id: "s", timestamp: "2026-09-01T10:00:00.000Z" }),
      userEntry("[fm-op] context (not the user)\nquota: none\n\n[user]\nuse sk-ant-api03-LIVEKEY"),
      assistantEntry("", [], "error"),
    ].join("\n");
    const [only] = extractTurnsFromJsonl(raw, "/tmp/s.jsonl");
    expect(only?.user).toContain("LIVEKEY");
    const record = buildRecord(only as never, EMPTY_TABLES);
    expect(record.user).not.toContain("LIVEKEY");
    expect(record.user).toContain("[redacted api key]");
  });

  it("reads the same fleet out of a P1 context block (task index and about line)", () => {
    expect(parseContextBlock(CONTEXT_P1)).toEqual(parseContextBlock(CONTEXT));
  });

  it("decodes the current TOON context object back into the fleet snapshot", () => {
    const context = [
      "[fm-op] context (not the user)",
      "repos[1]{name,repo_id,path,setup,workspace,delivery,autonomy}:",
      "  nimbus-api,repo-nimbus,/fleet/nimbus,adopt,project,direct-pr,true",
      "crew[1]{task_id,status,title,repo,gate}:",
      '  task-1,idle,"Fix quota, then ship",nimbus-api,waiting for captain',
      "quota: codex 41% weekly on_pace",
      "self_source: /app/self-source",
    ].join("\n");
    expect(parseContextBlock(context)).toEqual({
      repos: [
        {
          id: "repo-nimbus",
          name: "nimbus-api",
          path: "/fleet/nimbus",
          setupKind: "adopt",
          delivery: "direct-pr",
          autonomy: true,
        },
      ],
      crew: [
        {
          taskId: "task-1",
          status: "idle",
          title: "Fix quota, then ship",
          repoName: "nimbus-api",
          gate: "waiting for captain",
        },
      ],
      quotaLine: "codex 41% weekly on_pace",
      selfSource: "/app/self-source",
    });
  });

  it("parses the context block back into the fleet the turn saw", () => {
    const fleet = parseContextBlock(CONTEXT);
    expect(fleet.repos).toEqual([
      {
        id: "repo-nimbus",
        name: "nimbus-api",
        path: "/fleet/nimbus-api",
        setupKind: "clone",
        delivery: "direct-pr",
        autonomy: false,
      },
      {
        id: "repo-ledger",
        name: "ledgerline-core",
        path: "/fleet/ledgerline-core",
        setupKind: "clone",
        delivery: "direct-pr",
        autonomy: true,
      },
    ]);
    expect(fleet.crew).toEqual([
      {
        taskId: "a1b2c3d4",
        status: "idle",
        title: "Stabilize ledger reconciliation tests",
        repoName: "ledgerline-core",
      },
      {
        taskId: "queued99",
        status: "queued",
        title: "Dark mode",
        repoName: "nimbus-api",
        gate: "after task a1b2c3d4",
      },
    ]);
    expect(fleet.quotaLine).toBe("anthropic 42% used");
    expect(fleet.selfSource).toContain("self-source");
  });
});

/**
 * spawn_crewmate's args grouped since contract v4.12 (primitives P7): the
 * work-shape facts under `shape`, the waits under `start_after`. The
 * extractor reads a spawn by its tool name, the captain's words and the task
 * its result names, so a grouped call records exactly as a flat one did.
 */
describe("dispatch extractor - flat and grouped spawns (P7)", () => {
  const base = {
    title: "Cursor pagination",
    goal: "Add cursor pagination to the list endpoint.",
    user_words: "In nimbus-api, add cursor pagination to the list endpoint.",
    repo_id: "repo-nimbus",
  };
  function recordOf(args: Record<string, unknown>) {
    const raw = [
      header(),
      ...captainTurn(base.user_words, [
        assistantEntry("", [{ id: "s1", name: "spawn_crewmate", args }]),
        toolResultEntry("s1", "spawn_crewmate", "Commissioned crewmate 1 on task t-spawned."),
        assistantEntry("done", [], "stop"),
      ]),
    ].join("\n");
    const [only] = extractTurnsFromJsonl(raw, "/tmp/sess-fm.jsonl");
    return { turn: only, record: buildRecord(only as never, EMPTY_TABLES) };
  }

  it("records a grouped spawn exactly as the flat one", () => {
    const flat = recordOf({ ...base, premium_ask: true, after_task: "t-first" });
    const grouped = recordOf({
      ...base,
      shape: { premium_ask: true },
      start_after: { after_task: "t-first" },
    });
    for (const { turn, record } of [flat, grouped]) {
      expect(turn?.calls[0]?.args.user_words).toBe(base.user_words);
      expect(record.observed_class).toBe("spawn");
      expect(record.outcome.tasks[0]).toMatchObject({ task_id: "t-spawned" });
    }
    expect(grouped.record.outcome).toEqual(flat.record.outcome);
    expect(grouped.record.label).toEqual(flat.record.label);
  });
});

describe("dispatch extractor - who closed a card", () => {
  // The extractor's own rule (resolutionOf): the card_resolved row's actor
  // says who closed the card, and only the card's declared actions are
  // answers. INF-2625's plan pins it before the extractor is split.
  const card = {
    resolved_at: 21,
    chosen_action: "nimbus",
    actions_json: JSON.stringify([
      { id: "nimbus", label: "nimbus-api" },
      { id: "ledger", label: "ledgerline-core" },
    ]),
  };

  it("reads a card the host closed as retired, even when it stored a declared action", () => {
    expect(resolutionOf(card, { actor: "captain", action: "nimbus" })).toBe("acted");
    expect(resolutionOf(card, { actor: "host", action: "nimbus" })).toBe("retired");
  });

  it("reads a stored id the card never declared as a withdrawal, never an answer", () => {
    expect(resolutionOf({ ...card, chosen_action: "duplicate" })).toBe("retired");
    expect(resolutionOf({ ...card, chosen_action: "close" })).toBe("dismissed");
    expect(resolutionOf({ ...card, resolved_at: null })).toBe("open");
  });
});

describe("dispatch extractor - end to end over a fixture userData", () => {
  let dir: string;
  let records: DispatchRecord[];
  const byClass = (name: string) => records.filter((r) => r.observed_class === name);

  beforeEach(() => {
    dir = scratchDir("infinitary-c5-");
    buildFixtureUserData(dir);
    records = extractDispatchCorpus({
      sessionsDir: join(dir, "firstmate", "sessions"),
      dbPath: join(dir, "firstmate.db"),
    }).records;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces one record per orchestrator turn, in time order", () => {
    expect(records).toHaveLength(8);
    expect(records.map((record) => record.observed_class)).toEqual([
      "answer",
      "ask",
      "spawn",
      "steer",
      "settle",
      "operate",
      "none",
      "answer",
    ]);
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]?.at).toBeGreaterThanOrEqual(records[i - 1]?.at ?? 0);
    }
  });

  it("joins a spawn to the task row it created, with the repo posture", () => {
    const [spawn] = byClass("spawn");
    expect(spawn?.outcome.tasks).toEqual([
      {
        task_id: "t-spawned",
        via: "spawn_crewmate",
        found: true,
        title: "Cursor pagination",
        // The tasks table's own vocabulary (task-system P0; WI-11 retired
        // `delivered`): a crewmate that finished its work stays active and
        // idle, resumable until the captain merges, lands, or discards it.
        status: "active",
        kind: "work",
        repo_id: "repo-nimbus",
        repo_name: "nimbus-api",
        delivery: "direct-pr",
        autonomy: false,
        // The routing shape and its rule ride the join (S2), and the tier
        // the ladder actually served rides it too (S5).
        shape: {
          kind: "implement",
          kind_source: "classifier:xai/grok-4.6",
          kind_confidence: 0.81,
          basis: "FM3K-12",
        },
        tier: "medium",
        // A shape from before delivery rigor carries no rigor: it exports as
        // the quick work it was, never as unknown (phase 2). The same rule
        // reads a shape from before the deliverable axis as a change (Task B).
        rigor: "quick",
        deliverable: "change",
        rule: "R4",
        served: "low",
        // No review anywhere on a pre-phase-2 row: every review field is
        // null, never a guessed verdict (delivery rigor phase 3).
        review_of: null,
        review_verdict: null,
        review_risk: null,
      },
    ]);
    expect(spawn?.label).toMatchObject({
      gold_class: "spawn",
      weak: true,
      confidence: "corroborated",
    });
  });

  it("joins an ask to the card and to the captain's answer", () => {
    const [ask] = byClass("ask");
    expect(ask?.outcome.cards[0]).toMatchObject({
      card_id: "card-fm-which-repo",
      kind: "decision",
      found: true,
      chosen_action: "nimbus",
      resolution: "acted",
    });
    expect(ask?.label.confidence).toBe("corroborated");
    expect(ask?.label.evidence.join(" ")).toContain("answered with");
  });

  it("reads a dismissed note card as a resolution, not as a wrong answer", () => {
    const [answer] = byClass("answer");
    expect(answer?.outcome.cards[0]).toMatchObject({
      card_id: "card-fm-quota",
      resolution: "dismissed",
    });
    // A note is dismissed by definition; only a decision card can contradict.
    expect(answer?.label.confidence).toBe("observed");
  });

  it("contradicts a steer at a task id no row backs", () => {
    const [steer] = byClass("steer");
    expect(steer?.outcome.tasks[0]).toEqual({
      task_id: "ghost123",
      via: "steer_crewmate",
      found: false,
    });
    expect(steer?.label.confidence).toBe("contradicted");
    expect(steer?.label.evidence.join(" ")).toContain("no row in tasks");
  });

  it("corroborates a settle against the live task", () => {
    const [settle] = byClass("settle");
    expect(settle?.outcome.tasks[0]).toMatchObject({
      task_id: "a1b2c3d4",
      found: true,
      status: "active",
    });
    expect(settle?.label.confidence).toBe("corroborated");
  });

  it("counts the restraint signals PoC-1 scored as G4", () => {
    const [ask] = byClass("ask");
    expect(ask?.restraint).toEqual({
      tool_calls: 1,
      spawns: 0,
      steers: 0,
      cards: 1,
      decision_cards: 1,
      note_cards: 0,
    });
    const lookedUp = records.at(-1);
    expect(lookedUp?.restraint.tool_calls).toBe(1);
    expect(lookedUp?.restraint.cards).toBe(0);
  });

  it("carries the G5 contract signals on every record", () => {
    expect(records.filter((record) => record.doneClose)).toHaveLength(7);
    expect(records.filter((record) => record.turnFailed)).toHaveLength(1);
    // The card payloads ride the record so an eval can run the real cardLint.
    const [answer] = byClass("answer");
    expect(answer?.calls[0]?.args).toMatchObject({ kind: "note", title: "Quota status" });
  });

  it("drops [fm-op] wakes only when asked", () => {
    const only = extractDispatchCorpus({
      sessionsDir: join(dir, "firstmate", "sessions"),
      dbPath: join(dir, "firstmate.db"),
      includeOps: false,
    });
    expect(only.skippedOps).toBe(1);
    expect(only.records).toHaveLength(7);
  });

  it("reads the settings row the way the app writes it (JSON-encoded)", () => {
    const moved = scratchDir("infinitary-c5-moved-");
    const file = join(moved, "rolling.jsonl");
    writeFileSync(file, fixtureJsonl());
    const db = openDatabase(dir);
    new SettingsStore(db).setFirstmateSessionFile(file);
    db.close();
    const result = extractDispatchCorpus({
      sessionsDir: join(moved, "absent"),
      dbPath: join(dir, "firstmate.db"),
    });
    expect(result.sources).toEqual([file]);
    rmSync(moved, { recursive: true, force: true });
  });

  it("still extracts turns when no database is available at all", () => {
    const result = extractDispatchCorpus({
      sessionsDir: join(dir, "firstmate", "sessions"),
      dbPath: join(dir, "absent.db"),
    });
    expect(result.dbPath).toBeNull();
    expect(result.records).toHaveLength(8);
    // An absent join is absent evidence, never counter-evidence: nothing may
    // be labelled contradicted by a row that was never read.
    expect(result.records.every((record) => record.label.confidence === "observed")).toBe(true);
    const spawn = result.records.find((record) => record.observed_class === "spawn");
    expect(spawn?.outcome.tasks[0]).toMatchObject({ task_id: "t-spawned", found: false });
    expect(spawn?.label.evidence).toContain(
      "no database was joined, so the turn's effects are unverified",
    );
  });

  it("carries the work shape and the rule that routed it onto the task join (S2)", () => {
    // The corpus's whole point is a label beside the decision: what the
    // host took the work to be, and which row of the captain's table read
    // it. A task routed before the shape existed carries nulls, never a
    // guessed kind.
    const result = extractDispatchCorpus({
      sessionsDir: join(dir, "firstmate", "sessions"),
      dbPath: join(dir, "firstmate.db"),
    });
    const spawn = result.records.find((record) => record.observed_class === "spawn");
    expect(spawn?.outcome.tasks[0]).toMatchObject({
      task_id: "t-spawned",
      found: true,
      tier: "medium",
      rule: "R4",
      served: "low",
      shape: {
        kind: "implement",
        kind_source: "classifier:xai/grok-4.6",
        kind_confidence: 0.81,
        basis: "FM3K-12",
      },
    });
    const unrouted = result.records
      .flatMap((record) => record.outcome.tasks)
      .find((task) => task.task_id === "a1b2c3d4");
    expect(unrouted).toMatchObject({
      found: true,
      shape: null,
      tier: null,
      rule: null,
      served: null,
    });
  });

  it("emits one JSON object per line, each round-tripping", () => {
    const out = join(dir, "corpus.jsonl");
    expect(main(["--user-data", dir, "--out", out])).toBe(0);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    const parsed = lines.map((line) => JSON.parse(line) as DispatchRecord);
    expect(parsed[2]?.observed_class).toBe("spawn");
    expect(parsed[2]?.label.gold_class).toBe("spawn");
    expect(new Set(parsed.map((record) => record.id)).size).toBe(8);
  });
});

/**
 * The Claude-served fixture (W1 S11): the app's copy of the real client's
 * transcript and its served sidecar, recorded by
 * `tests/replay-claude-session.test.ts`.
 */
describe("dispatch extractor - a Claude-served session (W1 S11)", () => {
  const claudeDir = join(__dirname, "fixtures", "replay", "sep26-claude", "firstmate", "claude");

  it("reads the Claude dialect into the same records, stamped from the sidecar", () => {
    const result = extractDispatchCorpus({ claudeSessionsDir: claudeDir });
    // The sidecar beside the transcript is its companion, not a session.
    expect(result.sources.map((source) => basename(source))).toEqual([
      expect.stringMatching(/^[0-9a-f-]+\.jsonl$/),
    ]);
    expect(result.sources[0]).not.toMatch(/\.served\.jsonl$/);
    expect(result.copiedEntriesExcluded).toBe(0);
    expect(
      result.records.map((record) => [record.kind, record.observed_class, record.names]),
    ).toEqual([
      ["user", "spawn", ["spawn_crewmate"]],
      ["user", "answer", ["crew_status"]],
      // The steer the client folded into the running turn: a turn of its own.
      ["user", "spawn", ["spawn_crewmate"]],
      ["user", "ask", ["emit_card"]],
      ["op", "none", []],
    ]);
    const [steer] = result.records.filter((record) => record.user?.startsWith("Also have"));
    expect(steer?.calls[0]?.result?.text).toMatch(/^Commissioned crewmate 2 on task /);
    const sidecar = readFileSync(
      join(claudeDir, `${basename(result.sources[0] as string, ".jsonl")}.served.jsonl`),
      "utf8",
    );
    const stamped = JSON.parse(sidecar.split("\n")[0] as string) as Record<string, string>;
    for (const record of result.records) {
      expect(record.contract).toEqual({
        version: stamped.version,
        prompt_sha: stamped.prompt_sha,
        instructions_sha: stamped.instructions_sha,
      });
      expect(record.model).toBe("anthropic-claude/mock-1");
    }
  });

  it("reads both seats' sessions of one userData in time order", () => {
    const userData = scratchDir("infinitary-both-seats-");
    const sessionsDir = join(userData, "firstmate", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "pi.jsonl"),
      [
        { type: "session", id: "pi-1", timestamp: "2026-09-27T00:00:00.000Z" },
        {
          type: "message",
          id: "m1",
          timestamp: "2026-09-27T00:00:01.000Z",
          message: { role: "user", content: "after the Claude session" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const result = extractDispatchCorpus({ sessionsDir, claudeSessionsDir: claudeDir });
    expect(result.sources).toHaveLength(2);
    expect(result.records.at(-1)?.user).toBe("after the Claude session");
    expect(result.records).toHaveLength(6);
  });
});

describe("dispatch extractor - CLI", () => {
  it("takes every input as an argument so exported data runs anywhere", () => {
    const args = parseArgs(["--user-data", "/exported/userData"]);
    expect(args.sessionsDir).toBe("/exported/userData/firstmate/sessions");
    expect(args.claudeSessionsDir).toBe("/exported/userData/firstmate/claude");
    expect(parseArgs(["--claude-sessions", "/c"]).claudeSessionsDir).toBe("/c");
    expect(args.dbPath).toBe("/exported/userData/firstmate.db");
    const split = parseArgs(["--sessions", "/a", "--db", "/b.db", "--out", "/c.jsonl"]);
    expect(split.sessionsDir).toBe("/a");
    expect(split.dbPath).toBe("/b.db");
    expect(split.out).toBe("/c.jsonl");
    expect(parseArgs(["--session-file", "/x.jsonl", "--user-turns-only"])).toMatchObject({
      sessionFiles: ["/x.jsonl"],
      includeOps: false,
    });
    // pnpm forwards its own separator; the CLI must not choke on it.
    expect(parseArgs(["--", "--db", "/b.db"]).dbPath).toBe("/b.db");
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--db"])).toThrow(/needs a value/);
  });

  it("defaults to the installed release's userData on this machine", () => {
    const previous = process.env.INFINITARY_USER_DATA_DIR;
    process.env.INFINITARY_USER_DATA_DIR = "/tmp/override";
    expect(defaultUserDataDir()).toBe("/tmp/override");
    delete process.env.INFINITARY_USER_DATA_DIR;
    // The folder the release app really opens (src/shared/userDataFolders.ts),
    // or, before the one-time move, Firstmate 3000's (the Infinitary rename's
    // step 10), read under a scratch home rather than this computer's.
    withScratchHome((appData) => {
      expect(defaultUserDataDir()).toBe(join(appData, RELEASE_USER_DATA_FOLDER));
      mkdirSync(join(appData, USER_DATA_FOLDERS.fm.release), { recursive: true });
      expect(defaultUserDataDir()).toBe(join(appData, USER_DATA_FOLDERS.fm.release));
      mkdirSync(join(appData, RELEASE_USER_DATA_FOLDER));
      expect(defaultUserDataDir()).toBe(join(appData, RELEASE_USER_DATA_FOLDER));
    });
    if (previous !== undefined) process.env.INFINITARY_USER_DATA_DIR = previous;
  });

  it("fails loudly rather than writing an empty corpus when nothing is found", () => {
    const empty = scratchDir("infinitary-c5-empty-");
    expect(main(["--user-data", empty])).toBe(1);
    rmSync(empty, { recursive: true, force: true });
  });
});
