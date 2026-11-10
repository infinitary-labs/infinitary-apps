import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { seedProject } from "../workspace/seedProject";
import { exportTaskRecords, parseTaskExport, TASK_EXPORT_FORMAT } from "./taskExport";
import { TaskService } from "./taskService";

/**
 * The JSONL export (task-system P5). The acceptance the build plan names:
 * export then reload reproduces the data. Proven as a round trip through
 * the real writer - a database with every kind of row the record has is
 * exported, loaded into an empty one, and exported again to the same
 * lines - plus the importer's refusals, which run before any write.
 */

function populated() {
  const db = openInMemoryDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    autonomy: true,
    addedAt: 1,
  });
  let now = 1_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  const tick = () => {
    now += 7;
  };
  tasks.create({
    id: "a",
    title: "Ship the meter",
    prompt: "brief a",
    repoId: "r1",
    intent: {
      goal: "The meter ships",
      userWords: "ship the meter",
      constraints: [{ kind: "tests-required" }, { kind: "free", text: "keep it small" }],
      deliveryNote: "PR please",
    },
    difficulty: "high",
    // The shape that tier was computed from travels with the record (S2).
    shape: {
      kind: "implement",
      kind_source: "classifier:x",
      basis: "FM3K-1",
      basis_verified: true,
    },
    priority: 1,
  });
  tick();
  tasks.create({ id: "b", title: "After a", prompt: "brief b", repoId: "r1", blockedBy: ["a"] });
  tick();
  tasks.create({
    id: "c",
    title: "Child of b",
    prompt: "brief c",
    repoId: null,
    parentId: "b",
    startPolicy: "on-request",
    gate: { kind: "captain", ref: "card-1", reason: "parked" },
  });
  tick();
  tasks.starts.dispatch("a", {
    workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
    accountId: "acct_1",
    assignee: "crewmate 1",
    model: { provider: "openai", id: "gpt-5" },
  });
  tick();
  tasks.turns.setSessionFile("a", "/ud/crewmates/a/sessions/s.jsonl");
  tick();
  tasks.capture.openAsk({
    id: "turn-1",
    text: "how is a going?",
    images: [{ mimeType: "image/png" }],
  });
  tasks.capture.attachAsk("turn-1", "a", "tool:steer_crewmate");
  tasks.capture.closeAsk("turn-1", "closed");
  tick();
  tasks.turns.recordReport("a", { text: "Done the thing. Details follow." });
  tick();
  tasks.noteProgress("a", "halfway");
  tick();
  tasks.graph.link("c", "a", "related", "firstmate");
  tick();
  // A pin rides the task's line (INF-3127).
  tasks.setPinned("b", true, { actor: "captain" });
  tick();
  seedDelivery(
    tasks,
    "a",
    { prUrl: "https://x/pr/1", prNumber: 1 },
    { kind: "pr_opened", text: "PR #1", feed: true },
  );
  tick();
  tasks.close("a", {
    status: "done",
    reason: "landed",
    actor: "captain",
    delivery: { landedMode: "fast-forward" },
  });
  tick();
  tasks.placement.markWorkspaceRemoved("a");
  tick();
  tasks.capture.fileDecision({ id: "d", title: "Which way?", cardId: "card-d" });
  tick();
  tasks.capture.fileOperation({ id: "o", title: "set up repo", outcome: "ok", tool: "setup_repo" });
  tick();
  tasks.capture.fileQuestion({
    id: "q",
    title: "What time is it?",
    outcome: "Late.",
    fallback: "question",
  });
  return { db, tasks, now: () => now };
}

describe("the task export (task-system P5)", () => {
  it("round-trips: export, reload into an empty database, export again to the same lines", () => {
    const source = populated();
    const exported = exportTaskRecords(source.tasks, 5_000);
    const header = JSON.parse(exported[0] as string) as {
      kind: string;
      format: string;
      counts: unknown;
    };
    expect(header).toMatchObject({
      kind: "header",
      format: TASK_EXPORT_FORMAT,
      counts: { projects: 2, tasks: 6, links: 2, asks: 1 },
    });
    expect(exported.length).toBe(1 + 2 + 6 + 2 + 1 + (header.counts as { events: number }).events);

    const bundle = parseTaskExport(exported.join("\n"));
    // An export Firstmate 3000 wrote before the Infinitary rename reads the same.
    const older = exported.join("\n").replace(TASK_EXPORT_FORMAT, "fm3000-tasks/1");
    expect(parseTaskExport(older).tasks).toEqual(bundle.tasks);
    expect(bundle.tasks.find((task) => task.id === "a")).toMatchObject({
      key: "NIA-1",
      status: "done",
      closedReason: "landed",
      workspaceState: "removed",
      sessionFile: "/ud/crewmates/a/sessions/s.jsonl",
      delivery: { mode: "direct-pr", prUrl: "https://x/pr/1", landedMode: "fast-forward" },
      intent: { goal: "The meter ships", userWords: "ship the meter" },
      // The record carries why it routed where it did, not just the tier.
      difficulty: "high",
      shape: { kind: "implement", basis: "FM3K-1" },
    });
    // The basis travels as the record names it; its verdict is derived at
    // read (`basisOf`), so the export never carries a stale stamp.
    expect(bundle.tasks.find((task) => task.id === "a")?.shape).not.toHaveProperty(
      "basis_verified",
    );

    const db = openInMemoryDatabase();
    const target = new TaskService({ db, strict: true });
    const seqBefore = target.boardSeq();
    const written = target.archive.importRecords(bundle);
    // Scratch already existed (migration 17); the repo's project was new.
    expect(written).toEqual({
      projects: 1,
      tasks: 6,
      events: bundle.events.length,
      links: 2,
      asks: 1,
    });
    expect(target.boardSeq()).toBe(seqBefore + 1);

    const again = exportTaskRecords(target, 5_000);
    expect(again).toEqual(exported);

    // The reloaded record behaves as the record: keys resolve, the graph
    // holds, the next key continues the sequence rather than reusing one.
    expect(target.byKey("NIA-1")?.id).toBe("a");
    expect(target.get("b")?.pinnedAt).toBe(source.tasks.get("b")?.pinnedAt);
    expect(target.get("b")?.pinnedAt).not.toBeNull();
    expect(target.graph.blockers("b").map((task) => task.id)).toEqual(["a"]);
    expect(target.graph.children("b").map((task) => task.id)).toEqual(["c"]);
    expect(target.capture.asksFor("a")).toHaveLength(1);
    expect(target.timeline("a").map((event) => event.kind)).toEqual(
      source.tasks.timeline("a").map((event) => event.kind),
    );
    // NIA-1, NIA-2, and c inherited b's project as NIA-3: the next is NIA-4.
    const next = target.create({ id: "z", title: "Z", prompt: "p", repoId: "r1" });
    expect(next.key).toBe("NIA-4");
  });

  // INF-1288 piece 3, the captain's "Remove the two fields nothing reads":
  // an export an older build wrote still carries them.
  it("imports an older build's export with its retired fields, and exports it again without them", () => {
    const exported = exportTaskRecords(populated().tasks, 5_000);
    const older = exported.map((line) => {
      const row = JSON.parse(line) as {
        kind: string;
        id?: string;
        closedAt?: number;
        shape?: Record<string, unknown>;
        delivery?: Record<string, unknown>;
      };
      if (row.kind !== "task" || row.id !== "a") return line;
      // The landing time the close wrote, and the knowledge grant's one value.
      return JSON.stringify({
        ...row,
        shape: { ...row.shape, knowledge_access: "references" },
        delivery: { ...row.delivery, landedAt: row.closedAt },
      });
    });
    expect(older).not.toEqual(exported);
    const bundle = parseTaskExport(older);
    const task = bundle.tasks.find((candidate) => candidate.id === "a");
    expect(task?.shape).not.toHaveProperty("knowledge_access");
    expect(task?.delivery).not.toHaveProperty("landedAt");
    const target = new TaskService({ db: openInMemoryDatabase(), strict: true });
    target.archive.importRecords(bundle);
    expect(exportTaskRecords(target, 5_000)).toEqual(exported);
  });

  it("refuses to overwrite: an existing task id, a taken key, a foreign project key - before writing", () => {
    const source = populated();
    const lines = exportTaskRecords(source.tasks, 5_000);
    const bundle = parseTaskExport(lines);

    // Into itself: every task already exists, and nothing moved.
    const seq = source.tasks.boardSeq();
    expect(() => source.tasks.archive.importRecords(bundle)).toThrow(
      /Import refused: task "a" already exists/,
    );
    expect(source.tasks.boardSeq()).toBe(seq);
    expect(exportTaskRecords(source.tasks, 5_000)).toEqual(lines);

    // A project keyed the same for another id is a refusal.
    const db = openInMemoryDatabase();
    const target = new TaskService({ db, strict: true });
    target.projects.ensureForRepo({ id: "other", name: "nimbus-api" });
    expect(() => target.archive.importRecords(bundle)).toThrow(
      /project key NIA belongs to "proj-other"/,
    );
    expect(target.list()).toEqual([]);
  });

  // Pinned before the task service splits into its owners (INF-2625's plan,
  // the task service row): every reference the bundle names must resolve,
  // and a refusal writes nothing.
  it("refuses every reference it cannot resolve, before writing", () => {
    const bundle = parseTaskExport(exportTaskRecords(populated().tasks, 5_000));
    const [first] = bundle.tasks;
    const [ask] = bundle.asks;
    const [event] = bundle.events;
    const [link] = bundle.links;
    if (!first || !ask || !event || !link) throw new Error("the populated record lost a row");
    const cases: [string, typeof bundle, RegExp][] = [
      [
        "a task in an unknown project",
        { ...bundle, tasks: [{ ...first, projectId: "proj-ghost" }, ...bundle.tasks.slice(1)] },
        new RegExp(`task ${first.key} names an unknown project "proj-ghost"`),
      ],
      [
        "a task under an unknown parent",
        { ...bundle, tasks: [{ ...first, parentId: "ghost" }, ...bundle.tasks.slice(1)] },
        new RegExp(`task ${first.key} names an unknown parent "ghost"`),
      ],
      [
        "an event on an unknown task",
        { ...bundle, events: [{ ...event, taskId: "ghost" }] },
        /an event names an unknown task "ghost"/,
      ],
      [
        "an event about an unknown task",
        {
          ...bundle,
          events: [{ ...event, concerns: [{ taskId: "ghost", relation: "related", via: null }] }],
        } as typeof bundle,
        /an event concerns an unknown task "ghost"/,
      ],
      [
        "a link to an unknown task",
        { ...bundle, links: [{ ...link, toId: "ghost" }] },
        new RegExp(`a link names an unknown task \\("${link.fromId}" -> "ghost"\\)`),
      ],
      [
        "an ask on an unknown task",
        { ...bundle, asks: [{ ...ask, taskId: "ghost" }] },
        new RegExp(`ask "${ask.id}" names an unknown task "ghost"`),
      ],
    ];
    for (const [name, broken, refusal] of cases) {
      const target = new TaskService({ db: openInMemoryDatabase(), strict: true });
      const seq = target.boardSeq();
      expect(() => target.archive.importRecords(broken), name).toThrow(refusal);
      expect(target.list()).toEqual([]);
      expect(target.boardSeq()).toBe(seq);
    }

    // A project keyed differently here, a taken key and an ask already here
    // refuse too, into a record that has them.
    const project = new TaskService({ db: openInMemoryDatabase(), strict: true });
    project.projects.ensureForRepo({ id: "r1", name: "nimbus-api" });
    const rekeyed = {
      ...bundle,
      projects: bundle.projects.map((entry) =>
        entry.id === "proj-r1" ? { ...entry, key: "ZZZ" } : entry,
      ),
    };
    expect(() => project.archive.importRecords(rekeyed)).toThrow(
      /Import refused: project "proj-r1" is keyed NIA here, not ZZZ/,
    );
    expect(project.list()).toEqual([]);
    const keyed = new TaskService({ db: openInMemoryDatabase(), strict: true });
    keyed.archive.importRecords({ ...bundle, events: [], links: [], asks: [] });
    const renamed = {
      ...bundle,
      tasks: [{ ...first, id: "fresh" }],
      events: [],
      links: [],
      asks: [],
    };
    expect(() => keyed.archive.importRecords(renamed)).toThrow(
      new RegExp(`task key ${first.key} is already taken`),
    );
    const asked = new TaskService({ db: openInMemoryDatabase(), strict: true });
    asked.archive.importRecords(bundle);
    expect(() =>
      asked.archive.importRecords({ ...bundle, projects: [], tasks: [], events: [], links: [] }),
    ).toThrow(new RegExp(`ask "${ask.id}" already exists`));
  });

  it("parses strictly: a missing header, a bad line, and a count mismatch each name themselves", () => {
    expect(() => parseTaskExport("")).toThrow(/No header line/);
    expect(() => parseTaskExport('{"kind":"task"}')).toThrow(/Line 1: a row before the header/);
    const header = JSON.stringify({
      kind: "header",
      format: TASK_EXPORT_FORMAT,
      exportedAt: 1,
      counts: { projects: 0, tasks: 1, events: 0, links: 0, asks: 0 },
    });
    expect(() => parseTaskExport(`${header}\nnot json`)).toThrow(/Line 2: not JSON/);
    expect(() => parseTaskExport(header)).toThrow(/declares 1 tasks, the file holds 0/);
    expect(() => parseTaskExport(`${header}\n${header}`)).toThrow(/a second header/);
  });

  it("reads a brief receipt back whole after a reload renumbers the report events it keeps by reference", () => {
    const source = new TaskService({ db: openInMemoryDatabase(), strict: true });
    source.create({ id: "plan", title: "Plan the meter", prompt: "p", repoId: null });
    const spec = `The agreed spec. ${"A clause kept word for word. ".repeat(40)}`;
    source.turns.recordReport("plan", { text: "A first draft." });
    source.turns.recordReport("plan", { text: spec });
    const report = source.timeline("plan").findLast((event) => event.kind === "report");
    source.create({ id: "build", title: "Build the meter", prompt: "p", repoId: null });
    const brief = [
      "Goal: build it\n\nIts report - the final answer it recorded:\n",
      { taskId: "plan", eventId: report?.id ?? 0, text: spec },
      "\n\nBuild on it.",
    ];
    source.recordBrief("build", brief);
    const served = `Goal: build it\n\nIts report - the final answer it recorded:\n${spec}\n\nBuild on it.`;
    const stored = source.timeline("build").find((event) => event.kind === "briefed");
    // The receipt keeps the report as a reference, not a second copy.
    expect(stored?.text).not.toContain("A clause kept word for word.");
    expect((stored?.text.length ?? 0) + JSON.stringify(stored?.data).length).toBeLessThan(
      served.length,
    );
    expect(source.servedBrief(stored as NonNullable<typeof stored>)).toBe(served);

    // A database whose own history moves every reloaded event to a new id.
    const db = openInMemoryDatabase();
    seedProject(db, { id: "r9", name: "other", path: "/fleet/other", autonomy: true, addedAt: 1 });
    const target = new TaskService({
      db,
      repos: { get: () => ({ delivery: "local-only" as const }) },
      strict: true,
    });
    target.create({ id: "earlier", title: "Earlier work", prompt: "p", repoId: "r9" });
    for (let i = 0; i < 5; i++) target.noteProgress("earlier", `checkpoint ${i}`);
    target.archive.importRecords(parseTaskExport(exportTaskRecords(source, 5_000)));
    const reloaded = target.timeline("plan").findLast((event) => event.kind === "report");
    expect(reloaded?.id).not.toBe(report?.id);
    const receipt = target.timeline("build").find((event) => event.kind === "briefed");
    expect(target.servedBrief(receipt as NonNullable<typeof receipt>)).toBe(served);
  });
});
