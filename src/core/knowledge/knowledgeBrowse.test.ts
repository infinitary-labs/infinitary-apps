import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_LIST_PAGE } from "@shared/knowledge";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type KnowledgeActor, PRIVATE_SCOPE } from "./access";
import { type KnowledgeProject, KnowledgeService } from "./knowledgeService";
import type { RecordInput } from "./writes";

/**
 * The knowledge browser's reads through the one owner (docs/knowledge.md,
 * "The browser"): what the captain's window reads of each collection -
 * counted, drawn as a bounded graph, paged as lists and read whole - is
 * what the crew recorded there, scoped to one collection at a time, with
 * every finding's standing as its checks and its sources say. Recorded
 * through `record`, as a crewmate or Firstmate records, never inserted.
 */

const ALPHA = { id: "repo-alpha", name: "alpha" };
const BETA = { id: "repo-beta", name: "beta" };

function fixture(options: { dir?: string } = {}) {
  const alphaRoot = scratchDir("fm-knowledge-browse-alpha-");
  const betaRoot = scratchDir("fm-knowledge-browse-beta-");
  const projects: KnowledgeProject[] = [
    { ...BETA, path: betaRoot },
    { ...ALPHA, path: alphaRoot },
  ];
  const tasks = new Map([
    ["task-a", { id: "task-a", key: "AL-1", repoId: ALPHA.id }],
    ["task-b", { id: "task-b", key: "AL-2", repoId: ALPHA.id }],
  ]);
  let changes = 0;
  let clock = 1_700_000_000_000;
  const service = new KnowledgeService({
    ...(options.dir ? { dir: options.dir } : {}),
    projects: {
      get: (id) => projects.find((project) => project.id === id),
      list: () => projects,
    },
    tasks: {
      resolve: (ref) => tasks.get(ref) ?? [...tasks.values()].find((task) => task.key === ref),
      reports: () => [],
    },
    now: () => (clock += 1000),
    changed: () => {
      changes += 1;
    },
  });
  const crew = (taskId = "task-a", repo = ALPHA.id, cwd = alphaRoot): KnowledgeActor => ({
    kind: "crewmate",
    taskId,
    repoId: repo,
    cwd,
  });
  const firstmate = (): KnowledgeActor => ({
    kind: "firstmate",
    origin: "captain-turn",
    canCreate: true,
  });
  let request = 0;
  const record = async (
    actor: KnowledgeActor,
    input: Omit<RecordInput, "requestId">,
  ): Promise<string> => {
    request += 1;
    const outcome = await service.record(actor, { requestId: `r${request}`, ...input });
    if (!outcome.committed) throw new Error(outcome.text);
    return outcome.ids[0] as string;
  };
  const concept = (title: string, extra: Partial<RecordInput> = {}, actor = firstmate()) =>
    record(actor, {
      action: "publish",
      kind: "concept",
      title,
      explanation: `${title}, explained.`,
      ...extra,
    });
  return {
    service,
    projects,
    alphaRoot,
    betaRoot,
    crew,
    firstmate,
    record,
    concept,
    changes: () => changes,
  };
}

/** Evidence, Source versions and Retry policy, a claim between two and a read-together link. */
async function seedAlpha(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.alphaRoot, "pins.ts"), "export const pinned = true;\n");
  const evidence = await f.concept("Evidence", { aliases: ["proof"] });
  const versions = await f.concept("Source versions");
  const retry = await f.concept("Retry policy", {
    links: [{ to: evidence, reason: "Inspect the evidence before retrying." }],
  });
  const pins = await f.record(f.firstmate(), {
    action: "publish",
    kind: "finding",
    statement: "A source reference pins the inspected version.",
    basis: "observation",
    about: [evidence, versions],
    relationship: { from: evidence, predicate: "pins", to: versions },
    conditions: "On main, with a clean working copy.",
    sources: [{ kind: "quote", text: "export const pinned = true;", citation: "pins.ts" }],
  });
  return { evidence, versions, retry, pins };
}

describe("the knowledge browser's reads", () => {
  it("counts each collection, private first and then each project by name", async () => {
    const f = fixture();
    await seedAlpha(f);
    await f.concept("Beta idea");
    const read = f.service.window.collections();
    expect(read).toEqual({
      state: "ready",
      collections: [
        {
          scope: PRIVATE_SCOPE,
          name: "",
          private: true,
          concepts: 4,
          findings: 1,
          directions: 0,
        },
        {
          scope: ALPHA.id,
          name: "alpha",
          private: false,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
        {
          scope: BETA.id,
          name: "beta",
          private: false,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
      ],
    });
  });

  it("draws a collection's concepts with directed claims and undirected read-together links", async () => {
    const f = fixture();
    const { evidence, versions, retry, pins } = await seedAlpha(f);
    const graph = f.service.window.graph({ scope: PRIVATE_SCOPE });
    if (graph.state !== "ready") throw new Error("unavailable");
    expect(graph.concepts.map((concept) => concept.title).sort()).toEqual([
      "Evidence",
      "Retry policy",
      "Source versions",
    ]);
    expect(graph.concepts.find((concept) => concept.id === evidence)).toMatchObject({
      aliases: ["proof"],
      findings: 1,
      degree: 2,
    });
    // A claim reads subject to object with its finding's own predicate and
    // standing; a read-together link keeps its reason and is no claim.
    expect(graph.connections).toEqual(
      expect.arrayContaining([
        {
          kind: "claim",
          id: `claim:${pins}`,
          from: evidence,
          to: versions,
          predicate: "pins",
          finding: pins,
          standing: "unchecked",
        },
        {
          kind: "context",
          id: `context:${retry}:${evidence}`,
          from: retry,
          to: evidence,
          reason: "Inspect the evidence before retrying.",
        },
      ]),
    );
    expect(graph.connections).toHaveLength(2);
    expect(graph.shown).toEqual({ concepts: 3, connections: 2 });
    expect(graph.total).toEqual({ concepts: 3, connections: 2 });
    // Never another collection's: beta is empty, the private one too.
    const beta = f.service.window.graph({ scope: BETA.id });
    expect(beta.state === "ready" && beta.concepts).toEqual([]);
    expect(() => f.service.window.graph({ scope: "repo-gone" })).toThrow("No collection repo-gone");
  });

  it("narrows the graph to a neighborhood, one hop or two, or to what typed words find", async () => {
    const f = fixture();
    const { evidence, versions, retry } = await seedAlpha(f);
    const far = await f.concept("Archive", {
      links: [{ to: versions, reason: "Old versions live here." }],
    });
    const ids = (graph: ReturnType<typeof f.service.window.graph>) =>
      graph.state === "ready" ? graph.concepts.map((concept) => concept.id).sort() : [];
    expect(ids(f.service.window.graph({ scope: PRIVATE_SCOPE, focus: retry, hops: 1 }))).toEqual(
      [retry, evidence].sort(),
    );
    expect(ids(f.service.window.graph({ scope: PRIVATE_SCOPE, focus: retry, hops: 2 }))).toEqual(
      [retry, evidence, versions].sort(),
    );
    const near = f.service.window.graph({ scope: PRIVATE_SCOPE, focus: retry, hops: 2 });
    expect(near.state === "ready" && near.focus).toBe(retry);
    expect(near.state === "ready" && near.total.concepts).toBe(3);
    expect(ids(f.service.window.graph({ scope: PRIVATE_SCOPE, focus: far, hops: 1 }))).toEqual(
      [far, versions].sort(),
    );
    // By an alias, and by a finding's words, which bring its concepts.
    expect(ids(f.service.window.graph({ scope: PRIVATE_SCOPE, query: "proof" }))).toEqual([
      evidence,
    ]);
    expect(ids(f.service.window.graph({ scope: PRIVATE_SCOPE, query: "pins" }))).toEqual(
      [evidence, versions].sort(),
    );
    // A focus no longer in the collection draws the whole collection.
    const lost = f.service.window.graph({ scope: PRIVATE_SCOPE, focus: "c-zzzzzz" });
    expect(lost.state === "ready" && lost.focus).toBeNull();
    expect(ids(lost)).toHaveLength(4);
  });

  it("pages concepts by name, finds them by alias, and counts their findings", async () => {
    const f = fixture();
    const { evidence } = await seedAlpha(f);
    for (let i = 0; i < 22; i++) await f.concept(`Topic ${String(i).padStart(2, "0")}`);
    const first = f.service.window.concepts({ scope: PRIVATE_SCOPE });
    if (first.state !== "ready") throw new Error("unavailable");
    expect(first.total).toBe(25);
    expect(first.rows).toHaveLength(KNOWLEDGE_LIST_PAGE);
    expect(first.rows[0]).toMatchObject({
      id: evidence,
      title: "Evidence",
      explanation: "Evidence, explained.",
      findings: 1,
    });
    const last = f.service.window.concepts({ scope: PRIVATE_SCOPE, page: 9 });
    expect(last.state === "ready" && [last.page, last.rows.length]).toEqual([1, 5]);
    const found = f.service.window.concepts({ scope: PRIVATE_SCOPE, query: "proof" });
    expect(found.state === "ready" && found.rows.map((row) => row.id)).toEqual([evidence]);
  });

  it("gives each finding its standing, and filters for rechecking and differing evidence", async () => {
    const f = fixture();
    const { evidence, pins } = await seedAlpha(f);
    writeFileSync(join(f.alphaRoot, "steady.ts"), "export const steady = 1;\n");
    const steady = await f.record(f.firstmate(), {
      action: "publish",
      kind: "finding",
      statement: "Steady things stay steady.",
      basis: "inference",
      about: [evidence],
      conditions: "Always.",
      sources: [{ kind: "quote", text: "export const steady = 1;", citation: "steady.ts" }],
    });
    await f.record(f.firstmate(), {
      action: "assess",
      id: steady,
      revision: 1,
      verdict: "supports",
      method: "Read the file again.",
      conditions: "main",
      sources: [{ kind: "quote", text: "export const steady = 1;", citation: "steady.ts" }],
    });
    const disputed = await f.record(f.firstmate(), {
      action: "publish",
      kind: "finding",
      statement: "Every retry is safe.",
      basis: "inference",
      about: [evidence],
      conditions: "Always.",
    });
    await f.record(f.firstmate(), {
      action: "assess",
      id: disputed,
      revision: 1,
      verdict: "contradicts",
      method: "A provider failure repeated a side effect.",
      conditions: "On a provider failure.",
      sources: [{ kind: "quote", text: "The charge ran twice.", citation: "incident notes" }],
    });
    // The pinned file changes after it was kept.
    writeFileSync(join(f.alphaRoot, "pins.ts"), "export const pinned = false;\n");

    const standing = (filter?: "all" | "recheck" | "differing") => {
      const read = f.service.window.findings({
        scope: PRIVATE_SCOPE,
        ...(filter ? { filter } : {}),
      });
      if (read.state !== "ready") throw new Error("unavailable");
      return Object.fromEntries(read.rows.map((row) => [row.id, row.standing]));
    };
    expect(standing()).toEqual({
      [pins]: "unchecked",
      [steady]: "checked",
      [disputed]: "differing",
    });
    expect(standing("recheck")).toEqual({});
    expect(standing("differing")).toEqual({ [disputed]: "differing" });
    const all = f.service.window.findings({ scope: PRIVATE_SCOPE });
    const pinned = all.state === "ready" ? all.rows.find((row) => row.id === pins) : undefined;
    expect(pinned).toMatchObject({
      basis: "observation",
      conditions: "On main, with a clean working copy.",
      attention: { recheck: false, differing: false },
      sources: 1,
      checks: 0,
      relationship: { predicate: "pins" },
    });
    const found = f.service.window.findings({ scope: PRIVATE_SCOPE, query: "retry safe" });
    expect(found.state === "ready" && found.rows.map((row) => row.id)).toEqual([disputed]);
  });

  it("reads an entry whole: its connections and findings, its kept sources, checks, history and declared uses", async () => {
    const f = fixture();
    const { evidence, versions, retry, pins } = await seedAlpha(f);
    const concept = f.service.window.entry({ id: evidence });
    if (concept.state !== "ready") throw new Error(concept.state);
    expect(concept.entry).toMatchObject({
      kind: "concept",
      title: "Evidence",
      aliases: ["proof"],
      explanation: "Evidence, explained.",
      standing: null,
      author: "the first mate",
      findingsTotal: 1,
    });
    expect(concept.entry.connections.map((link) => [link.kind, link.id])).toEqual(
      expect.arrayContaining([
        ["claim", `claim:${pins}`],
        ["context", `context:${retry}:${evidence}`],
      ]),
    );
    expect(concept.entry.findings).toEqual([
      {
        id: pins,
        statement: "A source reference pins the inspected version.",
        standing: "unchecked",
      },
    ]);

    await f.record(f.crew("task-b"), {
      action: "use",
      id: pins,
      purpose: "Chose the pinned path.",
    });
    await f.record(f.firstmate(), {
      action: "revise",
      id: pins,
      expectedRevision: 1,
      statement: "A source reference pins the exact inspected version.",
      basis: "observation",
      about: [evidence, versions],
      relationship: { from: evidence, predicate: "pins", to: versions },
      conditions: "On main, with a clean working copy.",
      sources: [{ kind: "quote", text: "export const pinned = true;", citation: "pins.ts" }],
      reason: "More exact.",
    });
    const finding = f.service.window.entry({ id: pins });
    if (finding.state !== "ready") throw new Error(finding.state);
    expect(finding.entry).toMatchObject({
      kind: "finding",
      revision: 2,
      current: 2,
      title: "A source reference pins the exact inspected version.",
      relationship: { from: { id: evidence }, predicate: "pins", to: { id: versions } },
      standing: "unchecked",
    });
    expect(finding.entry.sources[0]).toMatchObject({
      origin: { kind: "quote", citation: "pins.ts" },
      text: "export const pinned = true;",
      check: { state: "kept" },
    });
    expect(finding.entry.revisions.map((revision) => [revision.revision, revision.op])).toEqual([
      [2, "revise"],
      [1, "publish"],
    ]);
    expect(finding.entry.revisions[1]?.title).toBe(
      "A source reference pins the inspected version.",
    );
    expect(finding.entry.uses).toEqual({
      count: 1,
      recent: [
        expect.objectContaining({ revision: 1, task: "AL-2", purpose: "Chose the pinned path." }),
      ],
    });
    // The revision it was used at, as it read then.
    const earlier = f.service.window.entry({ id: pins, revision: 1 });
    expect(earlier.state === "ready" && [earlier.entry.revision, earlier.entry.title]).toEqual([
      1,
      "A source reference pins the inspected version.",
    ]);
    expect(f.service.window.entry({ id: pins, revision: 9 })).toEqual({ state: "missing" });
    expect(f.service.window.entry({ id: "f-zzzzzz" })).toEqual({ state: "missing" });
  });

  it("names the entries a card cites, as they stand now, and leaves out any the window cannot read", async () => {
    const f = fixture();
    const { evidence, pins } = await seedAlpha(f);
    const beta = await f.concept("Beta idea", {});
    const before = f.changes();
    // In the order asked, each once; an id no collection holds is left out.
    expect(f.service.window.refs({ ids: [pins, evidence, "f-zzzzzz", pins, beta] })).toEqual({
      state: "ready",
      refs: [
        {
          id: pins,
          kind: "finding",
          scope: PRIVATE_SCOPE,
          title: "A source reference pins the inspected version.",
          revision: 1,
          retired: false,
          standing: "unchecked",
        },
        {
          id: evidence,
          kind: "concept",
          scope: PRIVATE_SCOPE,
          title: "Evidence",
          revision: 1,
          retired: false,
          standing: null,
        },
        {
          id: beta,
          kind: "concept",
          scope: PRIVATE_SCOPE,
          title: "Beta idea",
          revision: 1,
          retired: false,
          standing: null,
        },
      ],
    });
    // A saved quotation does not ask for a recheck: the app does not re-read it.
    const changed = f.service.window.refs({ ids: [pins] });
    expect(changed.state === "ready" && changed.refs[0]?.standing).toBe("unchecked");
    // Removing a project does not hide the captain's own entries.
    f.projects.splice(
      f.projects.findIndex((project) => project.id === BETA.id),
      1,
    );
    const still = f.service.window.refs({ ids: [beta] });
    expect(still.state === "ready" && still.refs).toHaveLength(1);
    // Reading them recorded nothing.
    expect(f.changes()).toBe(before);
    const read = f.service.window.entry({ id: pins });
    expect(read.state === "ready" && read.entry.uses.count).toBe(0);
  });

  it("lists what one task's work declared it used, each revision once, beside the current revision", async () => {
    const f = fixture();
    const { evidence, versions, pins } = await seedAlpha(f);
    await f.record(f.firstmate(), {
      action: "use",
      id: pins,
      purpose: "Chose the pinned path.",
    });
    await f.record(f.crew("task-b"), { action: "use", id: pins, purpose: "Kept the pinned path." });
    await f.record(f.firstmate(), {
      action: "revise",
      id: pins,
      expectedRevision: 1,
      statement: "A source reference pins the exact inspected version.",
      basis: "observation",
      about: [evidence, versions],
      relationship: { from: evidence, predicate: "pins", to: versions },
      conditions: "On main, with a clean working copy.",
      sources: [{ kind: "quote", text: "export const pinned = true;", citation: "pins.ts" }],
      reason: "More exact.",
    });
    await f.record(f.crew("task-b"), { action: "use", id: evidence, purpose: "Named the idea." });
    // Another task's use, and Firstmate's, are not this task's.
    await f.record(f.crew("task-a"), { action: "use", id: pins, purpose: "Its own reason." });
    const before = f.changes();
    expect(f.service.window.uses({ task: "task-b" })).toEqual({
      state: "ready",
      total: 2,
      uses: [
        {
          id: evidence,
          kind: "concept",
          scope: PRIVATE_SCOPE,
          revision: 1,
          title: "Evidence",
          current: 1,
          currentTitle: "Evidence",
          retired: false,
          standing: null,
          purpose: "Named the idea.",
          at: expect.any(Number),
        },
        // The revision it relied on, as it read then, beside what it says now.
        {
          id: pins,
          kind: "finding",
          scope: PRIVATE_SCOPE,
          revision: 1,
          title: "A source reference pins the inspected version.",
          current: 2,
          currentTitle: "A source reference pins the exact inspected version.",
          retired: false,
          standing: "unchecked",
          purpose: "Kept the pinned path.",
          at: expect.any(Number),
        },
      ],
    });
    expect(f.service.window.uses({ task: "task-none" })).toEqual({
      state: "ready",
      uses: [],
      total: 0,
    });
    expect(f.changes()).toBe(before);
  });

  it("answers empty without making the file until the first write, and again after the purge", async () => {
    const dir = join(scratchDir("fm-knowledge-browse-unmade-"), "knowledge");
    const f = fixture({ dir });
    const file = join(dir, "knowledge.db");
    expect(f.service.window.collections()).toMatchObject({ state: "ready" });
    expect(f.service.window.graph({ scope: PRIVATE_SCOPE })).toMatchObject({
      state: "ready",
      concepts: [],
    });
    expect(f.service.window.findings({ scope: PRIVATE_SCOPE, filter: "recheck" })).toMatchObject({
      total: 0,
    });
    expect(f.service.window.entry({ id: "c-abcdef" })).toEqual({ state: "missing" });
    expect(f.service.window.refs({ ids: ["c-abcdef"] })).toEqual({ state: "ready", refs: [] });
    expect(f.service.window.uses({ task: "task-a" })).toEqual({
      state: "ready",
      uses: [],
      total: 0,
    });
    expect(f.service.held()).toBe(false);
    expect(existsSync(file)).toBe(false);
    await f.concept("First");
    expect(existsSync(file)).toBe(true);
    expect(f.service.held()).toBe(true);
    f.service.purge();
    expect(f.service.held()).toBe(false);
    expect(f.service.window.concepts({ scope: PRIVATE_SCOPE })).toMatchObject({
      rows: [],
      total: 0,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("is told after each committed write, never after a read or a refusal", async () => {
    const f = fixture();
    await seedAlpha(f);
    const before = f.changes();
    f.service.window.collections();
    f.service.window.graph({ scope: PRIVATE_SCOPE });
    const refused = await f.service.record(f.crew(), {
      requestId: "bad",
      action: "publish",
      kind: "concept",
      title: "",
    });
    expect(refused.committed).toBe(false);
    expect(f.changes()).toBe(before);
    await f.concept("One more");
    expect(f.changes()).toBe(before + 1);
  });

  it("says why a collection cannot be read, and never answers it as empty", () => {
    const dir = scratchDir("fm-knowledge-browse-unreadable-");
    writeFileSync(join(dir, "knowledge.db"), "this is not a database");
    const f = fixture({ dir });
    for (const read of [
      f.service.window.collections(),
      f.service.window.graph({ scope: PRIVATE_SCOPE }),
      f.service.window.concepts({ scope: PRIVATE_SCOPE }),
      f.service.window.findings({ scope: PRIVATE_SCOPE }),
      f.service.window.entry({ id: "c-abcdef" }),
      f.service.window.refs({ ids: ["c-abcdef"] }),
      f.service.window.uses({ task: "task-a" }),
    ]) {
      // A collection that cannot be read still has something to say.
      expect(f.service.held()).toBe(true);
      expect(read).toEqual({
        state: "unavailable",
        reason: "Knowledge could not be read, so this version leaves it untouched.",
      });
    }
  });
});
