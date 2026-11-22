import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { UsageStore } from "../storage/usageStore";
import { seedTask, type TaskSeed } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { OBSERVE_DISABLED_MESSAGE } from "./gate";
import { ObserveService } from "./observeService";
import { createCrewmateTranscriptResolver } from "./transcriptSource";

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const USAGE_INSERT =
  "INSERT INTO usage_events (task_id, provider, model, input, output, cache_read, cache_write, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function taskRow(overrides: Partial<TaskSeed> & Pick<TaskSeed, "id" | "title">): TaskSeed {
  return {
    kind: "work",
    prompt: `[fm-op] brief for ${overrides.id}`,
    repoId: null,
    repoDir: "/w/default",
    worktreeDir: `/w/worktrees/${overrides.id}`,
    branch: `fm/task-${overrides.id}`,
    sessionFile: null,
    accountId: null,
    difficulty: null,
    gate: null,
    status: "idle",
    createdAt: 1_000,
    ...overrides,
  };
}

/** A fixture shaped like the vendored Claude client writes (2026-09-05). */
function claudeJsonl(sessionId: string, cwd: string): string {
  const usage = { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 0 };
  return jsonl([
    {
      type: "user",
      isSidechain: false,
      cwd,
      sessionId,
      uuid: "u1",
      timestamp: "2026-09-05T10:00:00.000Z",
      message: { role: "user", content: "You are a crewmate.\n\n# Task\nwrite the status note" },
    },
    {
      type: "assistant",
      isSidechain: false,
      sessionId,
      uuid: "a1",
      timestamp: "2026-09-05T10:00:02.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-opus-4-1",
        content: [{ type: "text", text: "Wrote the note to STATUS.md." }],
        stop_reason: "end_turn",
        usage,
      },
    },
  ]);
}

describe("ObserveService", () => {
  it("lists the orchestrator and every crewmate with usage totals from usage_events", async () => {
    const root = scratchDir("infinitary-observe-");
    const fmDir = join(root, "firstmate", "sessions");
    const crewDir = join(root, "crewmates", "ab12", "sessions");
    mkdirSync(fmDir, { recursive: true });
    mkdirSync(crewDir, { recursive: true });
    const fmFile = join(fmDir, "session.jsonl");
    const crewFile = join(crewDir, "session.jsonl");
    writeFileSync(
      fmFile,
      jsonl([
        { type: "session", version: 3, id: "fm-sess", timestamp: "2026-08-13T20:00:00.000Z" },
        {
          type: "message",
          id: "u1",
          timestamp: "2026-08-13T20:00:01.000Z",
          message: {
            role: "user",
            content:
              "[fm-op] context (not the user)\nrepos:\n- demo\ncrew:\n- none\nquota: ok\n\n[user]\nfix the flaky test",
          },
        },
      ]),
    );
    writeFileSync(
      crewFile,
      jsonl([
        { type: "session", version: 3, id: "crew-sess", timestamp: "2026-08-13T20:01:00.000Z" },
        {
          type: "message",
          id: "c1",
          timestamp: "2026-08-13T20:01:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "patched the timer." }],
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 10, output: 4 },
            stopReason: "stop",
          },
        },
      ]),
    );

    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const tasks = new TaskService({ db, strict: true });
    const repos = new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused"));
    settings.setFirstmateSessionFile(fmFile);
    settings.setFirstmateModel({ provider: "anthropic", id: "claude-sonnet" });
    seedTask(tasks, {
      id: "ab12",
      title: "fix the flaky test",
      prompt: "fix it",
      repoId: null,
      repoDir: join(root, "default-workspace"),
      worktreeDir: join(root, "worktrees", "ab12"),
      branch: "fm/task-ab12",
      sessionFile: crewFile,
      accountId: null,
      status: "idle",
      createdAt: 1_000,
    });
    db.prepare(
      "INSERT INTO usage_events (task_id, provider, model, input, output, cache_read, cache_write, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(FIRSTMATE_SESSION_ID, "anthropic", "claude-sonnet", 1200, 80, 400, 0, 0.01, 2_000);
    db.prepare(
      "INSERT INTO usage_events (task_id, provider, model, input, output, cache_read, cache_write, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("ab12", "openai", "gpt-5.5", 88000, 1200, 0, 0, null, 3_000);

    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings,
      repos,
      liveStatus: () => ({
        firstmateBusy: true,
        firstmateModel: { provider: "anthropic", id: "claude-sonnet" },
      }),
    });

    const sessions = await service.list();
    // No supervision row: nothing has written that transcript since S7c
    // retired the session, and this install never ran one.
    expect(sessions.map((session) => session.id)).toEqual([FIRSTMATE_SESSION_ID, "ab12"]);
    const firstmate = sessions[0];
    expect(firstmate).toMatchObject({
      kind: "orchestrator",
      title: "First mate",
      status: "streaming",
      model: "anthropic/claude-sonnet",
      authFailure: false,
    });
    expect(firstmate?.usage).toMatchObject({
      input: 1200,
      output: 80,
      cacheRead: 400,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
      records: 1,
      priced: 1,
      reported: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    const crew = sessions[1];
    expect(crew).toMatchObject({
      kind: "crewmate",
      title: "fix the flaky test",
      repo: "default workspace",
      status: "idle",
      model: "openai/gpt-5.5",
      backend: "pi",
      transcriptNote: null,
    });
    expect(crew?.usage?.input).toBe(88000);

    const detail = await service.detail(FIRSTMATE_SESSION_ID);
    expect(detail.turns.map((turn) => turn.kind)).toEqual(["context", "user"]);
    expect(detail.turns[1]?.text).toBe("fix the flaky test");
    expect((await service.detail("ab12")).turns.some((turn) => turn.kind === "assistant")).toBe(
      true,
    );
  });

  it("keeps the transcript model separate from tied and later supporting usage models", async () => {
    const root = scratchDir("infinitary-observe-models-");
    const file = join(root, "session.jsonl");
    writeFileSync(
      file,
      jsonl([
        {
          type: "message",
          id: "opus-reply",
          timestamp: "2026-10-05T12:00:00Z",
          message: {
            role: "assistant",
            provider: "anthropic-claude",
            model: "opus",
            content: "Plan ready.",
          },
        },
      ]),
    );
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, taskRow({ id: "plan", title: "Plan", sessionFile: file }));
    const usage = new UsageStore(db);
    usage.record({
      taskId: "plan",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: {
        models: [
          { model: "opus", input: 100, cost: 8 },
          { model: "haiku", input: 20, cost: 0.002 },
        ],
      },
      at: 2000,
    });
    usage.record({
      taskId: "plan",
      model: { provider: "openai-codex", id: "luna" },
      usage: { input: 3, cost: 0 },
      at: 3000,
    });
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(root, "repos")),
    });
    expect((await service.list())[1]).toMatchObject({
      model: "anthropic-claude/opus",
      usage: {
        records: 3,
        priced: 2,
        input: 123,
        reported: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect((await service.detail("plan")).usage?.models?.map((model) => model.model)).toEqual([
      "haiku",
      "opus",
      "luna",
    ]);
    unlinkSync(file);
    expect((await service.detail("plan")).model).toBeNull(); // no arbitrary ledger model fallback
    usage.record({ taskId: "single", model: { provider: "xai", id: "grok" }, usage: {}, at: 4000 });
    seedTask(tasks, taskRow({ id: "single", title: "Single" }));
    expect((await service.detail("single")).model).toBe("xai/grok");
  });

  it("refuses list and detail when the gate is off", async () => {
    const db = openInMemoryDatabase();
    const service = new ObserveService({
      enabled: false,
      db,
      tasks: new TaskService({ db, strict: true }),
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    expect(service.enabled).toBe(false);
    await expect(service.list()).rejects.toThrow(OBSERVE_DISABLED_MESSAGE);
    await expect(service.detail(FIRSTMATE_SESSION_ID)).rejects.toThrow(OBSERVE_DISABLED_MESSAGE);
  });

  it("marks auth failures from the session transcript", async () => {
    const root = scratchDir("infinitary-observe-auth-");
    const crewDir = join(root, "sessions");
    mkdirSync(crewDir, { recursive: true });
    const crewFile = join(crewDir, "session.jsonl");
    writeFileSync(
      crewFile,
      jsonl([
        { type: "session", version: 3, id: "crew-sess", timestamp: "2026-08-13T20:01:00.000Z" },
        {
          type: "message",
          id: "e1",
          timestamp: "2026-08-13T20:01:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "401 unauthorized: credential expired",
          },
        },
      ]),
    );
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: "dead",
      title: "auth died",
      prompt: "go",
      repoId: null,
      repoDir: root,
      worktreeDir: root,
      branch: "fm/task-dead",
      sessionFile: crewFile,
      accountId: null,
      status: "failed",
      createdAt: 1,
    });
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    const row = (await service.list()).find((session) => session.id === "dead");
    expect(row?.status).toBe("failed");
    expect(row?.authFailure).toBe(true);
    expect(row?.error).toMatch(/401/);
  });

  it("excludes the retired session from list/detail without deleting its evidence", async () => {
    const root = scratchDir("infinitary-observe-sup-");
    const fmFile = join(root, "firstmate.jsonl");
    const supFile = join(root, "supervision.jsonl");
    writeFileSync(
      fmFile,
      jsonl([
        { type: "session", version: 3, id: "fm-sess", timestamp: "2026-09-05T09:00:00.000Z" },
        {
          type: "message",
          id: "u1",
          timestamp: "2026-09-05T09:00:01.000Z",
          message: { role: "user", content: "[fm-op] context\nquota: ok\n\n[user]\nship it" },
        },
      ]),
    );
    writeFileSync(
      supFile,
      jsonl([
        { type: "session", version: 3, id: "sup-sess", timestamp: "2026-09-05T09:05:00.000Z" },
        {
          type: "message",
          id: "s1",
          timestamp: "2026-09-05T09:05:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "report_outcome", arguments: {} }],
            provider: "openai",
            model: "gpt-5.5-mini",
            usage: { input: 900, output: 20 },
            stopReason: "toolUse",
          },
        },
      ]),
    );
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setFirstmateSessionFile(fmFile);
    settings.setSupervisionSessionFile(supFile);
    db.prepare(USAGE_INSERT).run(
      FIRSTMATE_SESSION_ID,
      "xai",
      "grok-4.6",
      5000,
      100,
      0,
      0,
      null,
      10,
    );
    db.prepare(USAGE_INSERT).run("supervision", "openai", "gpt-5.5-mini", 900, 20, 0, 0, null, 20);
    const service = new ObserveService({
      enabled: true,
      db,
      tasks: new TaskService({ db, strict: true }),
      settings,
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
      liveStatus: () => ({
        firstmateBusy: false,
        firstmateModel: { provider: "xai", id: "grok-4.6" },
      }),
    });

    const [main] = await service.list();
    expect(main).toMatchObject({
      id: FIRSTMATE_SESSION_ID,
      kind: "orchestrator",
      title: "First mate",
      status: "idle",
      model: "xai/grok-4.6",
      backend: "pi",
    });
    expect(main?.usage?.input).toBe(5000);
    expect(await service.list()).toHaveLength(1);
    await expect(service.detail("supervision")).rejects.toThrow('Unknown session "supervision"');
    expect(readFileSync(supFile, "utf8")).toContain("report_outcome");
    expect(settings.getSupervisionSessionFile()).toBe(supFile);
    expect(
      db.prepare("SELECT input, output FROM usage_events WHERE task_id = 'supervision'").get(),
    ).toEqual({ input: 900, output: 20 });
    // A stale historical pointer must not resurrect a ghost row either.
    settings.setSupervisionSessionFile(join(root, "missing.jsonl"));
    expect(await service.list()).toHaveLength(1);
    await expect(service.detail("supervision")).rejects.toThrow('Unknown session "supervision"');
    const mainDetail = await service.detail(FIRSTMATE_SESSION_ID);
    expect(mainDetail.turns.map((turn) => turn.kind)).toEqual(["context", "user"]);
    expect(mainDetail.turns.some((turn) => turn.toolName === "report_outcome")).toBe(false);
  });

  it("says so, instead of nothing, while a singleton session has no file yet", async () => {
    const db = openInMemoryDatabase();
    const service = new ObserveService({
      enabled: true,
      db,
      tasks: new TaskService({ db, strict: true }),
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    const main = await service.detail(FIRSTMATE_SESSION_ID);
    expect(main.status).toBe("none");
    expect(main.transcriptNote).toMatch(/No session yet/);
    expect(main.turns).toEqual([]);
  });

  it("reads a Claude-served Firstmate session through the one reader (W1 S11)", async () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    // The Pi seat's rolling file is still recorded; the attached seat is Claude's.
    const piFile = join(scratchDir("infinitary-observe-fm-claude-"), "pi.jsonl");
    writeFileSync(piFile, jsonl([{ type: "session", id: "pi-1" }]));
    settings.setFirstmateSessionFile(piFile);
    const claudeFile = join(scratchDir("infinitary-observe-fm-claude-"), "c1.jsonl");
    writeFileSync(claudeFile, claudeJsonl("c1", "/app/firstmate/home"));
    let attached: string | null = claudeFile;
    const service = new ObserveService({
      enabled: true,
      db,
      tasks: new TaskService({ db, strict: true }),
      settings,
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
      liveStatus: () => ({
        firstmateBusy: false,
        firstmateModel: { provider: "anthropic-claude", id: "claude-opus-5-5" },
        firstmateSessionFile: attached,
      }),
    });
    const main = await service.detail(FIRSTMATE_SESSION_ID);
    expect(main).toMatchObject({ backend: "claude", transcriptNote: null, status: "idle" });
    expect(main.turns.filter((turn) => turn.kind === "assistant")).toEqual([
      expect.objectContaining({
        text: "Wrote the note to STATUS.md.",
        model: "anthropic-claude/claude-opus-4-1",
      }),
    ]);
    expect(main.turns.find((turn) => turn.kind === "usage")?.usage).toEqual({
      input: 30,
      output: 12,
    });
    // Nothing attached: the Pi seat's recorded file, read as Pi.
    attached = null;
    expect(await service.detail(FIRSTMATE_SESSION_ID)).toMatchObject({ backend: "pi", turns: [] });
  });

  it("carries the routing facts onto a crewmate summary, and nothing onto the singletons (S5)", async () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true });
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    seedTask(
      tasks,
      taskRow({
        id: "rt01",
        title: "fix the reconciliation test",
        difficulty: "high",
        // A pre-S7b row: `kind_confidence` is history the record still
        // carries; the schema no longer names it.
        shape: {
          kind: "fix",
          kind_source: "classifier:xai/grok-4.6",
          kind_confidence: 0.9,
        } as unknown as WorkShape,
      }),
    );
    // The policy asked for high; nothing in that slot could serve.
    db.prepare(
      "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("rt01", "openai", "gpt-5.5", "high", "R5", "medium", "[]", 2_000);
    // A row the policy never routed: no shape, no decision, nothing to say.
    seedTask(tasks, taskRow({ id: "rt02", title: "an older row" }));

    const list = await service.list();
    const byId = Object.fromEntries(list.map((session) => [session.id, session]));
    expect(byId.rt01?.routing).toEqual({
      tier: "high",
      served: "medium",
      rule: "R5",
      kind: "fix",
      kindSource: "classifier:xai/grok-4.6",
      rigor: null,
      deliverable: null,
      review: null,
      reviewOf: null,
    });
    expect(byId.rt02?.routing).toBeNull();
    // The Firstmate is not routed by the policy, so it claims no tier; nor
    // does the retired supervision session, which no longer lists at all.
    expect(byId[FIRSTMATE_SESSION_ID]?.routing).toBeNull();
    await expect(service.detail("supervision")).rejects.toThrow('Unknown session "supervision"');
    expect((await service.detail("rt01")).routing).toEqual(byId.rt01?.routing);
  });

  it("carries the rigor, a builder's review verdict and risk, and the builder a review task reads (phase 3)", async () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true });
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    seedTask(
      tasks,
      taskRow({
        id: "bld1",
        title: "Fix the meter test",
        difficulty: "high",
        shape: { kind: "fix", kind_source: "classifier:test", rigor: "reviewed" },
      }),
    );
    seedDelivery(tasks, "bld1", { reviewVerdict: "findings", reviewRisk: "medium" });
    seedTask(
      tasks,
      taskRow({
        id: "rev1",
        title: "Review: Fix the meter test",
        difficulty: "high",
        parentId: "bld1",
        shape: { kind: "review", kind_source: "host:review" },
      }),
    );
    db.prepare(
      "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("rev1", "xai", "grok-4.6", "high", "R9", "high", "[]", 3_000);
    const byId = Object.fromEntries((await service.list()).map((session) => [session.id, session]));
    expect(byId.bld1?.routing).toMatchObject({
      rigor: "reviewed",
      review: "findings · risk medium",
      reviewOf: null,
    });
    expect(byId.rev1?.routing).toMatchObject({
      rule: "R9",
      kind: "review",
      rigor: null,
      review: null,
      reviewOf: "Fix the meter test",
    });
  });

  it("reads which review a builder's verdict came from off the parent edge", async () => {
    const db = openInMemoryDatabase();
    let now = 1_000;
    const tasks = new TaskService({ db, strict: true, now: () => now });
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings: new SettingsStore(db),
      repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
    });
    const review = (id: string) =>
      seedTask(
        tasks,
        taskRow({
          id,
          title: "Review: Fix the meter test",
          difficulty: "high",
          parentId: "bld1",
          shape: { kind: "review", kind_source: "host:review", basis: "bld1" },
          createdAt: now,
        }),
      );
    const reviewOf = async (id: string) =>
      (await service.list()).find((session) => session.id === id)?.routing?.review ?? null;
    seedTask(
      tasks,
      taskRow({
        id: "bld1",
        title: "Fix the meter test",
        difficulty: "high",
        shape: { kind: "fix", kind_source: "classifier:test", rigor: "reviewed" },
      }),
    );
    now += 1_000;
    review("rev1");
    now += 1_000;
    seedDelivery(tasks, "bld1", {
      reviewVerdict: "findings",
      reviewRisk: "medium",
      reviewedAt: now,
    });
    expect(await reviewOf("rev1")).toBe("findings · risk medium");
    // A second review opened after the verdict has not answered: it claims
    // nothing, and the first keeps the verdict it returned.
    now += 1_000;
    review("rev2");
    expect(await reviewOf("rev1")).toBe("findings · risk medium");
    expect(await reviewOf("rev2")).toBeNull();
    // Its own verdict moves the claim to it.
    now += 1_000;
    seedDelivery(tasks, "bld1", { reviewVerdict: "pass", reviewRisk: "low", reviewedAt: now });
    expect(await reviewOf("rev1")).toBeNull();
    expect(await reviewOf("rev2")).toBe("pass · risk low");
  });

  describe("crewmates on non-Pi backends", () => {
    function fixture() {
      const root = scratchDir("infinitary-observe-backends-");
      const db = openInMemoryDatabase();
      const tasks = new TaskService({ db, strict: true });
      const accounts: Record<string, { backend: "pi" | "claude"; dir: string }> = {
        "acct-claude": { backend: "claude", dir: join(root, "accounts", "anthropic-claude", "a1") },
      };
      const service = new ObserveService({
        enabled: true,
        db,
        tasks,
        settings: new SettingsStore(db),
        repos: new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused")),
        crewmateTranscript: createCrewmateTranscriptResolver({
          backendOf: (accountId) => accounts[accountId]?.backend,
          configDirOf: (accountId) => accounts[accountId]?.dir,
          recordDirOf: (taskId) => join(root, "crewmates", taskId, "sessions"),
        }),
      });
      return { root, db, tasks, service, accounts };
    }

    it("renders a Claude crewmate from the transcript its client wrote in the account store", async () => {
      const { tasks, service, accounts } = fixture();
      // What the row really holds for a Claude crewmate: the minted session
      // id (the resume token), not a path - the shape that rendered blank.
      const sessionId = "9c1c2a4e-0000-4000-8000-000000000001";
      const cwd = "/w/worktrees/cl1";
      const dir = join(accounts["acct-claude"]?.dir ?? "", "projects", encodeClaudeProjectDir(cwd));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionId}.jsonl`), claudeJsonl(sessionId, cwd));
      seedTask(
        tasks,
        taskRow({
          id: "cl1",
          title: "write the status note",
          worktreeDir: cwd,
          sessionFile: sessionId,
          accountId: "acct-claude",
          status: "idle",
        }),
      );
      // WI-11 retired the `delivered`/`finish` close: a Claude crewmate that
      // finished is landed, which ends its session (its transcript stays in
      // the account store, keyed by the worktree cwd).
      tasks.close("cl1", { status: "done", reason: "landed", actor: "captain" });

      const row = (await service.list()).find((session) => session.id === "cl1");
      expect(row).toMatchObject({
        backend: "claude",
        transcriptNote: null,
        model: "anthropic-claude/claude-opus-4-1",
      });
      const detail = await service.detail("cl1");
      expect(detail.turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "usage"]);
      expect(detail.turns[1]?.text).toBe("Wrote the note to STATUS.md.");
      expect(detail.endedAt).toBe(Date.parse("2026-09-05T10:00:02.000Z"));
    });

    it("renders a crewmate on another computer from the copy this Mac keeps of its record", async () => {
      const { root, tasks, service } = fixture();
      // Its token names the file on that computer, which this Mac cannot read.
      const there =
        "/Users/builder/Library/Application Support/firstmate-3000/work/tasks/pl1/sessions/2026-10-04T08-00-00-000Z_pl1.jsonl";
      const copy = join(root, "crewmates", "pl1", "sessions", "2026-10-04T08-00-00-000Z_pl1.jsonl");
      mkdirSync(join(copy, ".."), { recursive: true });
      writeFileSync(
        copy,
        jsonl([
          { type: "session", version: 3, id: "pl1-sess", timestamp: "2026-10-04T08:00:00.000Z" },
          {
            type: "message",
            id: "p1",
            timestamp: "2026-10-04T08:00:02.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Fixed the footer there." }],
              provider: "openai",
              model: "gpt-6",
            },
          },
        ]),
      );
      seedTask(
        tasks,
        taskRow({
          id: "pl1",
          title: "fix the footer",
          worktreeDir: "",
          sessionFile: there,
          deviceId: "mini",
          status: "idle",
        }),
      );
      expect((await service.list()).find((session) => session.id === "pl1")).toMatchObject({
        backend: "pi",
        transcriptNote: null,
      });
      expect((await service.detail("pl1")).turns.map((turn) => turn.text)).toContain(
        "Fixed the footer there.",
      );
    });

    it("renders a Claude crewmate from the app's copy first, and from its client's file until then", async () => {
      const { root, tasks, service, accounts } = fixture();
      const sessionId = "9c1c2a4e-0000-4000-8000-000000000003";
      const cwd = "/w/worktrees/cl3";
      const clientDir = join(
        accounts["acct-claude"]?.dir ?? "",
        "projects",
        encodeClaudeProjectDir(cwd),
      );
      mkdirSync(clientDir, { recursive: true });
      const clientFile = join(clientDir, `${sessionId}.jsonl`);
      writeFileSync(clientFile, claudeJsonl(sessionId, cwd));
      seedTask(
        tasks,
        taskRow({
          id: "cl3",
          title: "write the status note",
          worktreeDir: cwd,
          sessionFile: sessionId,
          accountId: "acct-claude",
          status: "idle",
        }),
      );
      // Before the session's first boundary, only the client's file holds it.
      expect((await service.detail("cl3")).turns[1]?.text).toBe("Wrote the note to STATUS.md.");

      // The app's copy lands in the task's record dir, a turn behind the
      // client's file: the client's holds the tail, so it is what shows.
      const recordDir = join(root, "crewmates", "cl3", "sessions");
      mkdirSync(recordDir, { recursive: true });
      const whole = readFileSync(clientFile, "utf8");
      const copy = join(recordDir, `${sessionId}.jsonl`);
      writeFileSync(copy, `${whole.split("\n")[0]}\n`);
      expect((await service.detail("cl3")).turns[1]?.text).toBe("Wrote the note to STATUS.md.");

      // The copy catches up, and the client's file is swept: the copy is
      // what Observe reads.
      writeFileSync(copy, whole);
      unlinkSync(clientFile);
      const detail = await service.detail("cl3");
      expect(detail).toMatchObject({ backend: "claude", transcriptNote: null });
      expect(detail.turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "usage"]);
      expect(detail.turns[1]?.text).toBe("Wrote the note to STATUS.md.");
    });

    it("discloses a Claude transcript that is not written yet and shows the brief meanwhile", async () => {
      const { tasks, service } = fixture();
      seedTask(
        tasks,
        taskRow({
          id: "cl2",
          title: "not started",
          sessionFile: "9c1c2a4e-0000-4000-8000-000000000002",
          accountId: "acct-claude",
          status: "running",
        }),
      );
      const detail = await service.detail("cl2");
      expect(detail.backend).toBe("claude");
      expect(detail.transcriptNote).toMatch(/not written this session's transcript yet/);
      expect(detail.turns.map((turn) => turn.kind)).toEqual(["op"]);
      expect(detail.turns[0]?.text).toBe("[fm-op] brief for cl2");
    });

    it("names a removed account and a vanished Pi session file rather than rendering nothing", async () => {
      const { root, tasks, service } = fixture();
      seedTask(
        tasks,
        taskRow({ id: "gone", title: "account removed", sessionFile: "x", accountId: "acct-x" }),
      );
      seedTask(
        tasks,
        taskRow({
          id: "lost",
          title: "file deleted",
          sessionFile: join(root, "missing.jsonl"),
          status: "completed",
        }),
      );
      expect(await service.detail("gone")).toMatchObject({
        backend: null,
        transcriptNote: expect.stringMatching(/no longer registered/),
      });
      expect(await service.detail("lost")).toMatchObject({
        backend: "pi",
        transcriptNote: expect.stringMatching(/missing or unreadable \(missing\.jsonl\)/),
      });
      expect((await service.detail("lost")).turns.map((turn) => turn.text)).toEqual([
        "[fm-op] brief for lost",
      ]);
    });
  });

  it("opens a closed task's kept session (D2) and parses it once until the file changes (P5)", async () => {
    const root = scratchDir("infinitary-observe-closed-");
    const crewDir = join(root, "crewmates", "done1", "sessions");
    mkdirSync(crewDir, { recursive: true });
    const crewFile = join(crewDir, "session.jsonl");
    writeFileSync(
      crewFile,
      jsonl([
        { type: "session", version: 3, id: "crew-sess", timestamp: "2026-08-13T20:01:00.000Z" },
        {
          type: "message",
          id: "c1",
          timestamp: "2026-08-13T20:01:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Landed the fix; all green." }],
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 10, output: 4 },
            stopReason: "stop",
          },
        },
      ]),
    );
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const tasks = new TaskService({ db, strict: true });
    const repos = new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused"));
    // Landed and settled: the worktree is gone, the row is done, the
    // session file is exactly where it was.
    seedTask(
      tasks,
      taskRow({ id: "done1", title: "fix the meter", sessionFile: crewFile, status: "completed" }),
    );
    tasks.close("done1", {
      status: "done",
      reason: "landed",
      actor: "captain",
      delivery: { landedMode: "merge" },
    });
    tasks.placement.markWorkspaceRemoved("done1");
    expect(tasks.get("done1")).toMatchObject({ status: "done", workspaceState: "removed" });

    const service = new ObserveService({ enabled: true, db, tasks, settings, repos });
    const listed = (await service.list()).find((session) => session.id === "done1");
    expect(listed).toMatchObject({
      kind: "crewmate",
      status: "done",
      transcriptNote: null,
      model: "openai/gpt-5.5",
    });
    expect(listed?.endedAt).not.toBeNull();
    const detail = await service.detail("done1");
    expect(detail.turns.map((turn) => turn.kind)).toEqual(["assistant", "usage"]);
    expect(detail.turns[0]?.text).toBe("Landed the fix; all green.");

    // The list poll stats the closed file instead of parsing it again.
    const parses = service.transcriptParses;
    await service.list();
    await service.list();
    expect(service.transcriptParses).toBe(parses);
    writeFileSync(
      crewFile,
      `${readFileSync(crewFile, "utf8")}${jsonl([{ type: "compaction", id: "x", timestamp: "2026-08-13T21:00:00.000Z", summary: "later" }])}`,
    );
    await service.list();
    expect(service.transcriptParses).toBe(parses + 1);
    expect((await service.detail("done1")).turns.map((turn) => turn.kind)).toEqual([
      "assistant",
      "usage",
      "compaction",
    ]);
  });

  it.each(["main", "live crew"])(
    "caches unchanged %s files and invalidates append, truncate, replace, disappearance and rotation",
    async (kind) => {
      const root = scratchDir("infinitary-observe-cache-");
      const file = join(root, "session.jsonl");
      const message = (text: string) =>
        jsonl([
          {
            type: "message",
            id: text,
            timestamp: "2026-09-05T10:00:00Z",
            message: { role: "user", content: text },
          },
        ]);
      writeFileSync(file, message("first"));
      const db = openInMemoryDatabase();
      const tasks = new TaskService({ db, strict: true });
      const settings = new SettingsStore(db);
      const id = kind === "main" ? FIRSTMATE_SESSION_ID : "live";
      const point = (path: string) =>
        kind === "main"
          ? settings.setFirstmateSessionFile(path)
          : tasks.turns.setSessionFile(id, path);
      if (kind !== "main")
        seedTask(tasks, taskRow({ id, title: "Running", status: "running", sessionFile: file }));
      else point(file);
      const service = new ObserveService({
        enabled: true,
        db,
        tasks,
        settings,
        repos: new RepoRegistry(db, join(root, "fleet")),
      });
      const texts = async () => (await service.detail(id)).turns.map((turn) => turn.text);
      expect(await texts()).toEqual(["first"]);
      const parses = service.transcriptParses;
      await service.list();
      await service.list();
      expect(await texts()).toEqual(["first"]);
      expect(service.transcriptParses).toBe(parses);
      writeFileSync(file, message("second"), { flag: "a" });
      expect(await texts()).toEqual(["first", "second"]);
      writeFileSync(file, message("short"));
      expect(await texts()).toEqual(["short"]);
      const replacement = join(root, "replacement.jsonl");
      writeFileSync(replacement, message("equal")); // same byte length, new inode
      renameSync(replacement, file);
      expect(await texts()).toEqual(["equal"]);
      unlinkSync(file);
      expect((await service.detail(id)).transcriptNote).toMatch(/missing or unreadable/);
      writeFileSync(file, message("back"));
      expect(await texts()).toEqual(["back"]);
      writeFileSync(replacement, message("rotated"));
      point(replacement);
      expect(await texts()).toEqual(["rotated"]);
      expect(service.transcriptParses).toBe(parses + 5);
      db.close();
    },
  );

  it("surfaces card threads on the session detail, not the list", async () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const tasks = new TaskService({ db, strict: true });
    const repos = new RepoRegistry(db, join(tmpdir(), "infinitary-fleet-unused"));
    const threads = [
      {
        cardId: "card-fm-1",
        title: "Pick one",
        messages: [
          {
            id: 1,
            cardId: "card-fm-1",
            who: "captain" as const,
            text: "the second option is wrong",
            at: 1,
          },
        ],
      },
    ];
    const service = new ObserveService({
      enabled: true,
      db,
      tasks,
      settings,
      repos,
      cardThreads: (sessionId) => (sessionId === FIRSTMATE_SESSION_ID ? threads : []),
    });
    expect((await service.list())[0]).not.toHaveProperty("threads");
    expect((await service.detail(FIRSTMATE_SESSION_ID)).threads).toEqual(threads);
  });
});
