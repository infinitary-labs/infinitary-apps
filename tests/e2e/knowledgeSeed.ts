/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/knowledge/
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeActor } from "../../src/core/knowledge/access";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService";
import { captureFile, sha256 } from "../../src/core/knowledge/sources";
import type { RecordInput } from "../../src/core/knowledge/writes";
import { openDatabase } from "../../src/core/storage/db";
import { type FindingBody, KnowledgeStore } from "../../src/core/storage/knowledgeStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { seedHostedOrigins, seedProject } from "./projectSeed";

/**
 * A knowledge collection to browse (docs/knowledge.md, "The browser"),
 * recorded before the app starts through the one owner's own `record`, as
 * the crewmates on two tasks would record it: concepts with aliases and
 * read-together links, findings that claim relationships with their
 * predicates and cite a file in the project, a check with evidence, a
 * contrary check, a revision and a declared use. Saved file evidence is seeded
 * through KnowledgeStore because current writes deliberately refuse new files.
 *
 * The captain collection holds these saved references; the two projects
 * are their sources, not separate historical browser collections.
 */

export const HARBOR = { id: "repo-harbor", name: "harbor", key: "HAR" } as const;
export const WEBSITE = { id: "repo-website", name: "website", key: "WEB" } as const;

/**
 * The words of the claim Evidence pins Source versions, as the seed records
 * them: its two concepts' titles, its predicate, and the line its cited file
 * holds when it is kept.
 */
export const PINS_CLAIM = {
  from: "Evidence",
  predicate: "pins",
  to: "Source versions",
  cited: "A source reference names the exact version it was read at.",
} as const;

/** The concepts and findings the harbor collection holds, by a name the spec uses. */
export type HarborKnowledge = {
  evidence: string;
  versions: string;
  retry: string;
  identity: string;
  delivery: string;
  failures: string;
  lifecycle: string;
  reuse: string;
  /** Evidence pins Source versions: its cited file changed after it was kept. */
  pins: string;
  /** Retry policy keeps Message identity: checked with evidence. */
  keeps: string;
  /** Retry policy returns Message delivery: a contrary check with evidence. */
  returns: string;
  /** Task lifecycle retains Evidence: revised once, and declared used. */
  retains: string;
  website: string;
  /** The task the harbor crewmate worked on, which declared the use. */
  taskKey: string;
  /** Every concept the seed recorded, in both projects, by id: what the panel counts. */
  concepts: readonly string[];
};

function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@localhost", ...args], {
      stdio: "pipe",
    });
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

/**
 * The ids the seed's records get, counted per kind in the order it records
 * them (`c-seed01`, `f-seed01`, ...), in place of the owner's random ones.
 * The graph lays a collection out from its concepts' ids, so pinned ids
 * draw the same graph on every run: a journey that reads where a concept
 * is drawn reads the same places each time, never a layout drawn once in a
 * few hundred runs.
 */
function pinnedIds(): (prefix: string) => string {
  const counted = new Map<string, number>();
  return (prefix) => {
    const n = (counted.get(prefix) ?? 0) + 1;
    counted.set(prefix, n);
    return `${prefix}-seed${String(n).padStart(2, "0")}`;
  };
}

export async function seedKnowledge(userDataDir: string): Promise<HarborKnowledge> {
  const harborDir = gitRepo(join(userDataDir, "projects", "harbor"), {
    "pins.ts": `// ${PINS_CLAIM.cited}\nexport const pinned = true;\n`,
    "retry.ts":
      "// A retry keeps the original message id.\nexport function retry(message: { id: string }) {\n  return { ...message };\n}\n",
  });
  const websiteDir = gitRepo(join(userDataDir, "projects", "website"), {
    "README.md": "# Website\n",
  });

  const db = openDatabase(userDataDir);
  const now = Date.now();
  seedProject(db, {
    id: HARBOR.id,
    path: harborDir,
    name: HARBOR.name,
    setupKind: "clone",
    origin: "https://github.com/o/harbor.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: HARBOR.key,
  });
  seedHostedOrigins(db, userDataDir);
  seedProject(db, {
    id: WEBSITE.id,
    path: websiteDir,
    name: WEBSITE.name,
    setupKind: "clone",
    origin: "https://github.com/o/website.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: WEBSITE.key,
  });
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "harbor-retry",
    title: "Learn how retries keep messages",
    status: "completed",
    repoId: HARBOR.id,
    outcome: "The retry path keeps the original message id.",
  });
  const taskKey = tasks.get("harbor-retry")?.key ?? "";
  const projects = [
    { id: HARBOR.id, name: HARBOR.name, path: harborDir },
    { id: WEBSITE.id, name: WEBSITE.name, path: websiteDir },
  ];
  const store = KnowledgeStore.open(join(userDataDir, "knowledge"));
  const service = new KnowledgeService({
    store,
    dir: join(userDataDir, "knowledge"),
    projects: {
      get: (id) => projects.find((project) => project.id === id),
      list: () => projects,
    },
    tasks: {
      resolve: (ref) => {
        const task = tasks.resolve(ref);
        return task ? { id: task.id, key: task.key, repoId: task.repoId } : undefined;
      },
      reports: (taskId) =>
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "report")
          .map((event) => ({ id: event.id, text: event.text })),
    },
    newId: pinnedIds(),
  });
  const crew: KnowledgeActor = {
    kind: "crewmate",
    taskId: "harbor-retry",
    repoId: HARBOR.id,
    cwd: harborDir,
  };
  const checker: KnowledgeActor = { ...crew, taskId: "harbor-check" };
  let request = 0;
  const concepts: string[] = [];
  const record = async (actor: KnowledgeActor, input: Omit<RecordInput, "requestId">) => {
    request += 1;
    const outcome = await service.record(actor, { requestId: `seed-${request}`, ...input });
    if (!outcome.committed) throw new Error(`seed refused: ${outcome.text}`);
    const id = outcome.ids[0] as string;
    if (input.action === "publish" && input.kind === "concept") concepts.push(id);
    return id;
  };
  const concept = (title: string, explanation: string, extra: Partial<RecordInput> = {}) =>
    record(crew, { action: "publish", kind: "concept", title, explanation, ...extra });

  const evidence = await concept(
    PINS_CLAIM.from,
    "What was observed, how it was checked, and where its limits are.",
    { aliases: ["proof"] },
  );
  const versions = await concept(
    PINS_CLAIM.to,
    "The exact version a finding describes, distinct from the current version.",
  );
  const identity = await concept(
    "Message identity",
    "The durable identity that connects an attempt to the original message.",
  );
  const delivery = await concept(
    "Message delivery",
    "How a message reaches its intended conversation without disappearing.",
  );
  const failures = await concept(
    "Provider failures",
    "Failures that happen before a provider completes a request.",
  );
  const retry = await concept(
    "Retry policy",
    "When failed work can be attempted again, and what must stay unchanged.",
    {
      aliases: ["retries", "another attempt"],
      links: [
        { to: failures, reason: "Read together when deciding whether another attempt is safe." },
      ],
    },
  );
  const lifecycle = await concept(
    "Task lifecycle",
    "How a task changes while its records and evidence remain available.",
  );
  const reuse = await concept(
    "Knowledge reuse",
    "Reading an earlier finding before relying on it again.",
    { links: [{ to: evidence, reason: "Inspect supporting material before reusing a finding." }] },
  );

  // Existing saved file evidence is still read, but new writes cannot cite files.
  // Seed that persisted contract through its storage owner, with real captured bytes.
  const keptFile = async (id: string, path: string, startLine: number, endLine: number) => {
    const captured = await captureFile({
      root: harborDir,
      project: HARBOR.id,
      path,
      startLine,
      endLine,
      gitFacts: async () => ({ commit: "4f1c2a9e7b3d5f6a8c0e", dirty: false }),
    });
    if ("refused" in captured) throw new Error(captured.refused);
    store.insertSource({
      id,
      scope: "captain",
      kind: "file",
      origin: captured.origin,
      text: captured.text,
      digest: sha256(captured.text),
      actor: "task:harbor-retry",
      capturedAt: now,
    });
    return id;
  };
  const keptFinding = (id: string, body: FindingBody) => {
    const entry = {
      id,
      scope: "captain",
      kind: "finding" as const,
      revision: 1,
      lifecycle: "active" as const,
      author: "task:harbor-retry",
      createdAt: now,
      updatedAt: now,
      lane: "reference" as const,
    };
    store.transaction(() => {
      store.insertEntry(entry);
      store.insertRevision({
        entryId: id,
        revision: 1,
        op: "publish",
        body,
        actor: entry.author,
        origin: "crewmate",
        reason: "A saved reference",
        at: now,
      });
      store.replaceEdges(id, [
        ...body.about.map((toId) => ({ fromId: id, toId, layer: "about" as const, label: "" })),
        ...(body.relationship
          ? [
              {
                fromId: body.relationship.from,
                toId: body.relationship.to,
                layer: "relationship" as const,
                label: body.relationship.predicate,
              },
            ]
          : []),
      ]);
      store.index(entry, {
        title: "",
        aliases: body.relationship?.predicate ?? "",
        body: body.statement,
      });
    });
    return id;
  };
  const pins = keptFinding("f-pinned", {
    statement: "A source reference pins the inspected version.",
    basis: "observation",
    about: [evidence, versions],
    relationship: { from: evidence, predicate: PINS_CLAIM.predicate, to: versions },
    conditions: "The saved file reference.",
    sources: [await keptFile("s-pinned", "pins.ts", 1, 2)],
  });
  const keeps = keptFinding("f-keeps1", {
    statement: "A retry keeps the original message identity.",
    basis: "observation",
    about: [retry, identity],
    relationship: { from: retry, predicate: "keeps", to: identity },
    conditions: "A provider failure before the model answered.",
    sources: [await keptFile("s-keeps1", "retry.ts", 1, 4)],
  });
  store.insertAssessment({
    id: "a-keeps1",
    entryId: keeps,
    revision: 1,
    verdict: "supports",
    method: "Read the retry path and replayed one failure.",
    conditions: "main, macOS",
    sources: [await keptFile("s-check1", "retry.ts", 2, 3)],
    actor: "task:harbor-check",
    at: now,
  });
  const returns = await record(crew, {
    action: "publish",
    kind: "finding",
    statement: "Every failed request is safe to send again.",
    basis: "inference",
    about: [retry, delivery],
    relationship: { from: retry, predicate: "returns", to: delivery },
    conditions: "Any failure, any provider.",
  });
  await record(checker, {
    action: "assess",
    id: returns,
    revision: 1,
    verdict: "contradicts",
    method: "A failure after the model answered repeated a side effect.",
    conditions: "A failure after the answer arrived.",
    sources: [
      { kind: "quote", text: "The second attempt ran the tool again.", citation: "incident notes" },
    ],
  });
  const retains = await record(crew, {
    action: "publish",
    kind: "finding",
    statement: "Closing a task keeps its evidence.",
    basis: "observation",
    about: [lifecycle, evidence],
    relationship: { from: lifecycle, predicate: "retains", to: evidence },
    conditions: "Done or dropped, after its working copy is retired.",
    sources: [{ kind: "report", task: "harbor-retry" }],
  });
  await record(crew, {
    action: "use",
    id: retains,
    purpose: "Kept the evidence when the task closed.",
  });
  await record(crew, {
    action: "revise",
    id: retains,
    expectedRevision: 1,
    statement: "Closing a task keeps its supporting evidence.",
    basis: "observation",
    about: [lifecycle, evidence],
    relationship: { from: lifecycle, predicate: "retains", to: evidence },
    conditions: "Done or dropped, after its working copy is retired.",
    sources: [{ kind: "report", task: "harbor-retry" }],
    reason: "Said what is kept.",
  });
  const website = await record(
    {
      kind: "crewmate",
      taskId: "website-1",
      repoId: WEBSITE.id,
      cwd: websiteDir,
    },
    {
      action: "publish",
      kind: "concept",
      title: "Landing page",
      explanation: "The first page of the website.",
    },
  );
  service.close();
  db.close();

  // The pinned file changes after it was kept: that finding needs rechecking.
  writeFileSync(join(harborDir, "pins.ts"), "export const pinned = false;\n");

  return {
    evidence,
    versions,
    retry,
    identity,
    delivery,
    failures,
    lifecycle,
    reuse,
    pins,
    keeps,
    returns,
    retains,
    website,
    taskKey,
    concepts,
  };
}
