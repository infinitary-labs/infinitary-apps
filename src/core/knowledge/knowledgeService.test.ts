import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type KnowledgeActor,
  type KnowledgeProject,
  KnowledgeService,
  PRIVATE_SCOPE,
  type RecordInput,
} from "./knowledgeService";

/**
 * The knowledge owner through its own interface: what a crewmate records
 * is what the next one finds, scoped, checked against its source, and
 * never overwritten behind anyone's back.
 */

const ALPHA = { id: "repo-alpha", name: "alpha" };
const BETA = { id: "repo-beta", name: "beta" };

function fixture(options: { dir?: string; newId?: (prefix: string) => string } = {}) {
  const alphaRoot = scratchDir("fm-knowledge-alpha-");
  const betaRoot = scratchDir("fm-knowledge-beta-");
  const projects: KnowledgeProject[] = [
    { ...ALPHA, path: alphaRoot },
    { ...BETA, path: betaRoot },
  ];
  const reports = new Map<string, { id: number; text: string }[]>();
  const tasks = new Map<string, { id: string; key: string; repoId: string | null }>();
  let clock = 1_700_000_000_000;
  const service = new KnowledgeService({
    ...(options.dir ? { dir: options.dir } : {}),
    projects: {
      get: (id) => projects.find((project) => project.id === id),
      list: () => projects,
    },
    tasks: {
      resolve: (ref) => tasks.get(ref) ?? [...tasks.values()].find((task) => task.key === ref),
      reports: (taskId) => reports.get(taskId) ?? [],
    },
    gitFacts: async () => ({ commit: "a1b2c3d4e5f6a7b8c9d0", dirty: false }),
    now: () => (clock += 1000),
    ...(options.newId ? { newId: options.newId } : {}),
  });
  const crew = (taskId: string, repo = ALPHA.id, cwd = alphaRoot): KnowledgeActor => ({
    kind: "crewmate",
    taskId,
    repoId: repo,
    cwd,
  });
  const importer = (taskId: string, repo = ALPHA.id): KnowledgeActor => ({
    kind: "crewmate",
    taskId,
    repoId: repo,
    access: "references",
  });
  const firstmate = (origin: "captain-turn" | "agent" = "captain-turn", canCreate = true) =>
    ({ kind: "firstmate", origin, canCreate }) as const;
  let request = 0;
  const nextRequest = () => {
    request += 1;
    return `r${request}`;
  };
  const record = (
    actor: KnowledgeActor,
    input: Omit<RecordInput, "requestId"> & { requestId?: string },
  ) => service.record(actor, { requestId: nextRequest(), ...input });
  return {
    service,
    alphaRoot,
    betaRoot,
    reports,
    tasks,
    crew,
    importer,
    firstmate,
    record,
  };
}

async function seedConcepts(f: ReturnType<typeof fixture>) {
  const writer = f.firstmate();
  const inbox = await f.record(writer, {
    action: "publish",
    kind: "concept",
    title: "Inbox delivery",
    aliases: ["wake queue", "durable inbox"],
    explanation: "Every steer and wake rides one durable inbox row until it is acknowledged.",
  });
  const inboxId = inbox.ids[0] as string;
  const failure = await f.record(writer, {
    action: "publish",
    kind: "concept",
    title: "Provider failure",
    explanation: "A turn the model provider could not serve.",
    links: [{ to: inboxId, reason: "a failed turn is retried from the inbox" }],
  });
  return { writer, inboxId, failureId: failure.ids[0] as string };
}

describe("KnowledgeService", () => {
  it("lets the next crewmate find a finding by another word, follow its link and read its evidence", async () => {
    const f = fixture();
    writeFileSync(
      join(f.alphaRoot, "inbox.ts"),
      [
        "export function retry() {",
        "  // a provider failure spends no attempt",
        "  return true;",
        "}",
        "",
      ].join("\n"),
    );
    const { writer, inboxId, failureId } = await seedConcepts(f);
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "A provider failure spends no delivery attempt; the row is retried.",
      basis: "observation",
      about: [inboxId],
      relationship: { from: failureId, predicate: "is retried through", to: inboxId },
      conditions: "main at a1b2c3d, macOS",
      sources: [
        { kind: "quote", text: "a provider failure spends no attempt", citation: "inbox.ts" },
      ],
    });
    expect(finding.committed).toBe(true);
    const findingId = finding.ids[0] as string;

    // A different task on the same project, asking in other words.
    const reader = f.crew("task-b");
    const found = f.service.search(reader, { query: "wake queue retries" });
    expect(found.hits.map((hit) => hit.id)).toContain(inboxId);
    const concept = found.hits.find((hit) => hit.id === inboxId);
    expect(concept?.findings).toBe(1);

    const near = f.service.neighbors(reader, { id: inboxId });
    const about = near.neighbors.find((item) => item.layer === "about");
    expect(about?.other.id).toBe(findingId);
    const claim = near.neighbors.find((item) => item.layer === "relationship");
    expect(claim).toMatchObject({ label: "is retried through", outgoing: false, via: findingId });
    expect(claim?.other.id).toBe(failureId);
    const context = near.neighbors.find((item) => item.layer === "context");
    expect(context).toMatchObject({
      outgoing: false,
      label: "a failed turn is retried from the inbox",
    });

    const view = f.service.get(reader, findingId);
    expect(view.summary.status?.state).toBe("unchecked");
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]?.text).toBe("a provider failure spends no attempt");
    expect(view.sources[0]?.origin).toMatchObject({ kind: "quote", citation: "inbox.ts" });
    expect(view.sources[0]?.check.state).toBe("kept");
  });

  it("refuses project collections but gives all crewmates equal access to captain entries", async () => {
    const f = fixture();
    const { inboxId } = await seedConcepts(f);
    const secret = await f.record(f.firstmate(), {
      action: "publish",
      kind: "concept",
      title: "Captain's travel plans",
      explanation: "Private to the captain.",
      appliesTo: [BETA.id],
    });
    expect(secret.committed).toBe(true);
    const secretId = secret.ids[0] as string;

    const outsider = f.crew("task-beta", BETA.id, f.betaRoot);
    expect(() => f.service.get(outsider, "c-zzzzzz")).toThrow(
      "No entry c-zzzzzz in a collection you can read.",
    );
    const crossWrite = await f.record(outsider, {
      action: "publish",
      kind: "concept",
      title: "Sneaky",
      explanation: "Into alpha.",
      scope: ALPHA.id,
    });
    expect(crossWrite.text).toContain("captain's collection");

    const crewmate = f.crew("task-b");
    expect(f.service.search(crewmate, { query: "travel plans" }).total).toBe(1);
    expect(f.service.get(crewmate, secretId).summary.id).toBe(secretId);
    expect(f.service.search(crewmate, { query: "inbox delivery" }).hits[0]?.id).toBe(inboxId);
    expect(f.service.get(outsider, secretId).summary.id).toBe(secretId);

    expect(f.service.search(f.firstmate(), { query: "travel" }).hits[0]?.id).toBe(secretId);
    expect(f.service.search(f.firstmate(), { query: "inbox" }).hits[0]?.id).toBe(inboxId);
    expect(f.service.scopesFor(f.firstmate())).toEqual([PRIVATE_SCOPE]);
  });

  it("answers a repeated request once and refuses a request id reused for another write", async () => {
    const f = fixture();
    const writer = f.importer("task-a");
    const input: RecordInput = {
      action: "publish",
      requestId: "same",
      kind: "concept",
      title: "Idle ladder",
      explanation: "How an idle crewmate is nudged.",
    };
    const first = await f.service.record(writer, input);
    const second = await f.service.record(writer, input);
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.ids).toEqual(first.ids);
    expect(second.text).toContain("Already done");
    expect(f.service.count([PRIVATE_SCOPE])).toBe(1);
    const other = await f.service.record(writer, { ...input, title: "Something else" });
    expect(other).toMatchObject({ committed: false, ids: [] });
    expect(other.text).toContain("already used for a different write");
    // Another actor's request ids are its own.
    const peer = await f.service.record(f.importer("task-b"), {
      ...input,
      title: "Peer ladder",
    });
    expect(peer.committed).toBe(true);
  });

  it("refuses a stale revision, keeps a finding its author's, and lets anyone in scope revise a concept", async () => {
    const f = fixture();
    const writer = f.importer("task-a");
    const inbox = await f.record(writer, {
      action: "publish",
      kind: "concept",
      title: "Inbox delivery",
      explanation: "Every steer and wake rides one durable inbox row.",
    });
    const inboxId = inbox.ids[0] as string;
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Rows are acknowledged only after handling.",
      basis: "inference",
      about: [inboxId],
      conditions: "any build",
    });
    const findingId = finding.ids[0] as string;
    const peer = f.importer("task-b");
    const takeover = await f.record(peer, {
      action: "revise",
      id: findingId,
      expectedRevision: 1,
      statement: "Rows are never acknowledged.",
    });
    expect(takeover.text).toContain("another author's finding");
    expect(f.service.get(peer, findingId).shown.body).toMatchObject({
      statement: "Rows are acknowledged only after handling.",
    });

    const revised = await f.record(peer, {
      action: "revise",
      id: inboxId,
      expectedRevision: 1,
      explanation: "One durable inbox row per steer or wake, acknowledged after handling.",
    });
    expect(revised).toMatchObject({ committed: true });
    const stale = await f.record(writer, {
      action: "revise",
      id: inboxId,
      expectedRevision: 1,
      explanation: "An older idea.",
    });
    expect(stale.committed).toBe(false);
    expect(stale.text).toContain("is at revision 2, not 1");
    const missing = await f.record(writer, { action: "revise", id: inboxId, explanation: "x" });
    expect(missing.text).toContain("Pass expected_revision");
    const history = f.service.history(writer, { id: inboxId });
    expect(history.revisions.map((row) => [row.revision, row.op, row.actor])).toEqual([
      [2, "revise", "task:task-b"],
      [1, "publish", "task:task-a"],
    ]);
  });

  it("checks a finding only with evidence, disputes it on contrary evidence and forgets checks of older revisions", async () => {
    const f = fixture();
    f.tasks.set("t-9", { id: "t-9", key: "FI3-9", repoId: ALPHA.id });
    f.reports.set("t-9", [{ id: 41, text: "Verified: pnpm test inbox passes; rows retried." }]);
    const { writer, inboxId } = await seedConcepts(f);
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Rows are retried after a provider failure.",
      basis: "inference",
      about: [inboxId],
      conditions: "main",
    });
    const id = finding.ids[0] as string;
    const checker = writer;
    const bare = await f.record(checker, {
      action: "assess",
      id,
      verdict: "supports",
      method: "read the code",
      conditions: "main",
    });
    expect(bare.text).toContain("checks nothing");
    expect(f.service.get(checker, id).summary.status?.state).toBe("unchecked");

    await f.record(checker, {
      action: "assess",
      id,
      verdict: "supports",
      method: "pnpm test inbox",
      conditions: "main at a1b2c3d",
      sources: [{ kind: "report", task: "FI3-9" }],
    });
    const checked = f.service.get(checker, id);
    expect(checked.summary.status).toMatchObject({ state: "checked" });
    expect(checked.assessments.at(-1)?.sources[0]).toMatchObject({
      origin: { kind: "report", key: "FI3-9", event: 41 },
      check: { state: "unchanged" },
    });

    await f.record(writer, {
      action: "assess",
      id,
      verdict: "contradicts",
      method: "reran on a cut-off account",
      conditions: "account cut off",
      sources: [{ kind: "quote", text: "the row stayed pending", citation: "FI3-10 transcript" }],
    });
    expect(f.service.get(checker, id).summary.status).toMatchObject({
      state: "disputed",
      disputedBy: ["firstmate"],
    });

    await f.record(writer, {
      action: "revise",
      id,
      expectedRevision: 1,
      statement: "Rows are retried after a provider failure, unless the account is cut off.",
    });
    expect(f.service.get(checker, id).summary.status).toMatchObject({
      state: "unchecked",
      earlierChecked: true,
    });
  });

  it("relates findings and concepts without erasing either side", async () => {
    const f = fixture();
    const { writer, inboxId, failureId } = await seedConcepts(f);
    const old = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Wakes are dropped on restart.",
      basis: "inference",
      about: [inboxId],
      conditions: "before the durable inbox",
    });
    const fresh = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Wakes survive a restart in the durable inbox.",
      basis: "inference",
      about: [inboxId],
      conditions: "main",
    });
    const [oldId, freshId] = [old.ids[0] as string, fresh.ids[0] as string];
    const related = await f.record(writer, {
      action: "relate",
      from: freshId,
      to: oldId,
      type: "supersedes",
      reason: "the inbox made rows durable",
    });
    expect(related.committed).toBe(true);
    const reader = f.crew("task-c");
    expect(f.service.get(reader, oldId).summary.status).toMatchObject({
      state: "superseded",
      supersededBy: freshId,
    });
    expect(f.service.get(reader, oldId).shown.body).toMatchObject({
      statement: "Wakes are dropped on restart.",
    });
    const history = f.service.neighbors(reader, { id: oldId, layer: "history" });
    expect(history.neighbors[0]).toMatchObject({ label: "supersedes", outgoing: false });

    const linked = await f.record(writer, {
      action: "relate",
      from: inboxId,
      to: failureId,
      type: "related",
      reason: "failures are what the inbox retries",
    });
    expect(linked.committed).toBe(true);
    const twice = await f.record(writer, {
      action: "relate",
      from: inboxId,
      to: failureId,
      type: "related",
      reason: "again",
    });
    expect(twice.text).toContain("already links");
    const mixed = await f.record(writer, {
      action: "relate",
      from: inboxId,
      to: oldId,
      type: "contradicts",
      reason: "no",
    });
    expect(mixed.text).toContain("relates two findings");
  });

  it("retires only on its author's or the captain's word, and keeps the history", async () => {
    const f = fixture();
    const { writer, inboxId } = await seedConcepts(f);
    const refused = await f.record(f.crew("task-b"), {
      action: "retire",
      id: inboxId,
      expectedRevision: 1,
      reason: "not mine",
    });
    expect(refused.text).toContain("Removing an entry waits for the captain");
    const scheduled = await f.record(f.firstmate("agent"), {
      action: "retire",
      id: inboxId,
      expectedRevision: 1,
      reason: "tidy",
    });
    expect(scheduled.committed).toBe(false);
    const retired = await f.record(f.firstmate("captain-turn"), {
      action: "retire",
      id: inboxId,
      expectedRevision: 1,
      reason: "the captain asked",
    });
    expect(retired.committed).toBe(true);
    expect(
      f.service.search(writer, { query: "inbox delivery" }).hits.map((hit) => hit.id),
    ).not.toContain(inboxId);
    const view = f.service.get(writer, inboxId);
    expect(view.summary.retired).toBe(true);
    expect(f.service.history(writer, { id: inboxId }).revisions.map((row) => row.op)).toEqual([
      "retire",
      "publish",
    ]);
    const old = f.service.get(writer, inboxId, 1);
    expect(old.shown.body).toMatchObject({ title: "Inbox delivery" });
  });

  it("records a declared use with what its sources read like then", async () => {
    const f = fixture();
    writeFileSync(join(f.alphaRoot, "a.ts"), "one\ntwo\n");
    const { writer, inboxId } = await seedConcepts(f);
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "a.ts has two lines.",
      basis: "observation",
      about: [inboxId],
      conditions: "main",
      sources: [{ kind: "quote", text: "one\ntwo", citation: "a.ts" }],
    });
    const id = finding.ids[0] as string;
    const used = await f.record(f.crew("task-b"), {
      action: "use",
      id,
      purpose: "sized the buffer",
    });
    expect(used.committed).toBe(true);
    expect(used.text).not.toContain("changed");
    const view = f.service.get(writer, id);
    expect(view.uses.count).toBe(1);
    expect(view.uses.recent[0]).toMatchObject({
      actor: "task:task-b",
      taskId: "task-b",
      revision: 1,
      purpose: "sized the buffer",
      observed: { current: 1, sources: { [view.sources[0]?.id as string]: "kept" } },
    });
  });

  it("names what it records by the ids a test pins, and by fresh random ones otherwise", async () => {
    const given: string[] = [];
    const pinned = fixture({
      newId: (prefix) => {
        given.push(prefix);
        return `${prefix}-pin${String(given.length).padStart(3, "0")}`;
      },
    });
    const { writer, inboxId, failureId } = await seedConcepts(pinned);
    expect([inboxId, failureId]).toEqual(["c-pin001", "c-pin002"]);
    const finding = await pinned.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "A failed turn waits in the inbox.",
      basis: "observation",
      about: [inboxId, failureId],
      conditions: "main",
      sources: [{ kind: "quote", text: "the row stays until acknowledged", citation: "inbox.ts" }],
    });
    const findingId = finding.ids[0] as string;
    const view = pinned.service.get(writer, findingId);
    expect(findingId).toMatch(/^f-pin00\d$/);
    expect(view.sources.map((source) => source.id)).toEqual([expect.stringMatching(/^s-pin00\d$/)]);
    expect(given).toEqual(["c", "c", "s", "f"]);

    // Two collections recorded alike draw the same ids only when a test pins them.
    const first = await seedConcepts(fixture());
    const second = await seedConcepts(fixture());
    expect(first.inboxId).toMatch(/^c-[a-z0-9]{6}$/);
    expect(first.inboxId).not.toBe(second.inboxId);
  });

  it("holds Firstmate to captain-carried turns for new entries and to quotes and reports for evidence", async () => {
    const f = fixture();
    const scheduled = await f.record(f.firstmate("agent", false), {
      action: "publish",
      kind: "concept",
      title: "Scheduled idea",
      explanation: "From a timer.",
    });
    expect(scheduled.text).toContain("only on the captain's words");
    const file = await f.record(f.firstmate(), {
      action: "publish",
      kind: "concept",
      title: "From a file",
      explanation: "x",
      sources: [{ kind: "file", path: "/etc/passwd" }],
    });
    expect(file.text).toContain("stays with the project");
    const observation = await f.record(f.firstmate(), {
      action: "publish",
      kind: "concept",
      title: "Captain prefers mornings",
      explanation: "Said on a call.",
      scope: "nowhere",
    });
    expect(observation.text).toContain("How a project works stays in its code");
  });

  it("cites only plain files inside the crewmate's own working copy", async () => {
    const f = fixture();
    const { writer, inboxId } = await seedConcepts(f);
    writeFileSync(join(f.betaRoot, "outside.txt"), "beta secret\n");
    const attempt = (path: string) =>
      f.record(writer, {
        action: "publish",
        kind: "finding",
        statement: "s",
        basis: "observation",
        about: [inboxId],
        conditions: "c",
        sources: [{ kind: "file", path }],
      });
    expect((await attempt(`../${f.betaRoot.split("/").at(-1)}/outside.txt`)).text).toContain(
      "stays with the project",
    );
  });

  it("refuses a write over its bound before anything is kept", async () => {
    const f = fixture();
    const big = await f.record(f.crew("task-a"), {
      action: "publish",
      kind: "concept",
      title: "Huge",
      explanation: "x".repeat(17 * 1024),
    });
    expect(big.text).toContain("at most 16 KB");
    expect(f.service.count([ALPHA.id])).toBe(0);
  });

  it("leaves a collection a newer version wrote untouched and refuses knowledge alone", async () => {
    const dir = scratchDir("fm-knowledge-newer-");
    const writer = fixture({ dir });
    await seedConcepts(writer);
    writer.service.close();
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(join(dir, "knowledge.db"));
    raw.prepare("INSERT INTO schema_migrations (version) VALUES (99)").run();
    raw.close();
    const snapshot = () =>
      Object.fromEntries(
        readdirSync(dir).map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
      );
    const before = snapshot();
    const reader = fixture({ dir });
    expect(reader.service.availability()).toMatchObject({ state: "unavailable" });
    const write = await reader.record(reader.crew("task-a"), {
      action: "publish",
      kind: "concept",
      title: "Later",
      explanation: "x",
    });
    expect(write).toMatchObject({ committed: false });
    expect(write.text).toContain("newer version");
    expect(snapshot()).toEqual(before);
  });

  it("purges the whole collection, its folder included", async () => {
    const dir = scratchDir("fm-knowledge-purge-");
    const f = fixture({ dir: join(dir, "knowledge") });
    await seedConcepts(f);
    expect(readdirSync(join(dir, "knowledge"))).toContain("knowledge.db");
    f.service.purge();
    expect(readdirSync(dir)).toEqual([]);
    expect(f.service.count([ALPHA.id])).toBe(0);
  });

  it("requires a name hit or two body words and ignores conditions, numbers and loose prefixes", async () => {
    const f = fixture();
    const { writer, inboxId } = await seedConcepts(f);
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Galaxies contain luminous nebulae.",
      basis: "inference",
      about: [inboxId],
      conditions: "promote latest alpha stable release 32",
    });
    const findingId = finding.ids[0] as string;
    const ids = (query: string) => f.service.search(writer, { query }).hits.map((hit) => hit.id);
    expect(ids("inbox")).toContain(inboxId);
    expect(ids("queue")).toContain(inboxId);
    expect(ids("galaxies")).not.toContain(findingId);
    expect(ids("galaxies nebulae")).toContain(findingId);
    expect(ids("galaxies galaxies")).not.toContain(findingId);
    expect(ids("galaxies absent")).not.toContain(findingId);
    expect(ids("gal neb")).not.toContain(findingId);
    expect(ids("promote latest alpha stable release")).toEqual([]);
    expect(ids("32 galaxies")).not.toContain(findingId);
    expect(ids("32")).toEqual([]);
    expect(ids(findingId)).toContain(findingId);
    expect(f.service.shortlist([ALPHA.id], "32")).toEqual([]);
    expect(f.service.shortlist([ALPHA.id], "galaxies")).toEqual([]);
    expect(f.service.shortlist([PRIVATE_SCOPE], "galaxies nebulae").map((hit) => hit.id)).toEqual([
      findingId,
    ]);
  });

  it("removes conditions from existing indexes without changing saved entries or sources", async () => {
    const dir = scratchDir("fm-knowledge-index-upgrade-");
    const f = fixture({ dir });
    const { writer, inboxId } = await seedConcepts(f);
    const finding = await f.record(writer, {
      action: "publish",
      kind: "finding",
      statement: "Galaxies contain luminous nebulae.",
      basis: "observation",
      about: [inboxId],
      conditions: "promote latest alpha stable release",
      sources: [{ kind: "quote", text: "original evidence", citation: "fixture" }],
    });
    const findingId = finding.ids[0] as string;
    f.service.close();
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(join(dir, "knowledge.db"));
    // Reproduce the previous projection and schema history on disposable data.
    raw.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    raw
      .prepare(
        "UPDATE search SET body = body || ' promote latest alpha stable release' WHERE entry_id = ?",
      )
      .run(findingId);
    const snapshot = () => ({
      entries: raw.prepare("SELECT * FROM entries").all(),
      revisions: raw.prepare("SELECT * FROM revisions").all(),
      sources: raw.prepare("SELECT * FROM sources").all(),
    });
    const before = snapshot();
    raw.close();
    const reader = fixture({ dir });
    expect(
      reader.service.search(reader.crew("reader"), { query: "promote latest alpha stable release" })
        .hits,
    ).toEqual([]);
    expect(
      reader.service
        .search(reader.crew("reader"), { query: "galaxies nebulae" })
        .hits.map((hit) => hit.id),
    ).toEqual([findingId]);
    const view = reader.service.get(reader.crew("reader"), findingId);
    expect(view.sources[0]?.text).toBe("original evidence");
    reader.service.close();
    const after = new Database(join(dir, "knowledge.db"), { readonly: true });
    expect({
      entries: after.prepare("SELECT * FROM entries").all(),
      revisions: after.prepare("SELECT * FROM revisions").all(),
      sources: after.prepare("SELECT * FROM sources").all(),
    }).toEqual(before);
    after.close();
  });

  it("offers a short list of candidates without what any finding says", async () => {
    const f = fixture();
    const { writer, inboxId } = await seedConcepts(f);
    for (let index = 0; index < 8; index += 1) {
      await f.record(writer, {
        action: "publish",
        kind: "finding",
        statement: `Inbox detail number ${index} about delivery.`,
        basis: "inference",
        about: [inboxId],
        conditions: "main",
      });
    }
    const listed = f.service.shortlist([PRIVATE_SCOPE], "how does inbox delivery work");
    expect(listed).toHaveLength(5);
    expect(listed[0]?.id).toBe(inboxId);
    expect(f.service.shortlist([BETA.id], "inbox delivery")).toEqual([]);
    expect(f.service.shortlist([ALPHA.id], "?? !!")).toEqual([]);
  });
});

/**
 * INF-638. On INF-626's card the captain chose the fixes, one of them a
 * standing direction; the first mate, woken by the crewmate's report, was
 * refused, and only his third typed message saved it (d:d-9yi5fx). His
 * ruling: "why not just give first mate a tool to freely read and write
 * standing directions, and then rely on the agent's judgment on when/how to
 * do it?" A direction now changes through the app action catalog's
 * `direction` line, the one path the captain's window and the first mate's
 * app_change share; `changeDirection` is what that line runs.
 */
describe("a standing direction changes through the app action catalog", () => {
  // d:d-9yi5fx, the direction he finally typed.
  const RULE =
    "In Infinitary, a fix for a broken main or a failed alpha merges on its own once all checks pass: set that task's autonomy on and cite this direction.";
  let clock = 1_792_512_100_000;
  const service = () =>
    new KnowledgeService({
      projects: { get: () => undefined, list: () => [] },
      gitFacts: async () => ({ commit: null, dirty: false }),
      now: () => (clock += 1000),
    });
  const scheduled: KnowledgeActor = { kind: "firstmate", origin: "agent", canCreate: false };

  it("adds, revises and retires a direction as the captain's instruction, keeping each reason", () => {
    const knowledge = service();
    const saved = knowledge.changeDirection({
      op: "add",
      id: "fix-merge",
      text: RULE,
      reason: "The captain checked Fix 3 on INF-626's card.",
    });
    expect(saved).toMatchObject({ op: "add", direction: { id: "fix-merge", revision: 1 } });
    // His instruction, not the first mate's advice.
    expect(knowledge.standingDirections(scheduled)).toMatchObject([
      { id: "fix-merge", text: RULE, origin: "captain-turn", authority: "instruction" },
    ]);
    knowledge.changeDirection({
      op: "revise",
      id: "d:fix-merge",
      text: `${RULE} Product changes stay ask-first.`,
      reason: "Fix 3 keeps product changes ask-first.",
    });
    // A stale revision is refused, so a change never overwrites one it did not read.
    expect(() =>
      knowledge.changeDirection({
        op: "retire",
        id: "d:fix-merge",
        expectedRevision: 1,
        reason: "The captain chose to stop it.",
      }),
    ).toThrow("revision 2");
    knowledge.changeDirection({
      op: "retire",
      id: "d:fix-merge",
      expectedRevision: 2,
      reason: "The captain chose to stop it.",
    });
    expect(knowledge.standingDirections(scheduled)).toEqual([]);
    const read = knowledge.direction({ id: "fix-merge" });
    expect(read.state === "ready" && read.direction.history.map((row) => row.evidence)).toEqual([
      "The captain chose to stop it.",
      "Fix 3 keeps product changes ask-first.",
      "The captain checked Fix 3 on INF-626's card.",
    ]);
  });

  it("refuses adding a direction twice and changing one that does not exist", () => {
    const knowledge = service();
    knowledge.changeDirection({ op: "add", id: "fix-merge", text: RULE, reason: "asked" });
    expect(() =>
      knowledge.changeDirection({ op: "add", id: "fix-merge", text: RULE, reason: "asked" }),
    ).toThrow("already exists");
    expect(() =>
      knowledge.changeDirection({ op: "retire", id: "d:nothing", reason: "asked" }),
    ).toThrow("No direction d:nothing");
  });

  it("refuses a direction through record_knowledge, pointing each caller at its own way", async () => {
    const knowledge = service();
    const crewmate: KnowledgeActor = { kind: "crewmate", taskId: "82437b56", repoId: "infinitary" };
    const refused = await knowledge.record(crewmate, {
      action: "publish",
      requestId: "crew",
      kind: "direction",
      statement: RULE,
      reason: "The captain checked Fix 3.",
    });
    expect(refused.text).toContain("needs_firstmate");
    const firstmate = await knowledge.record(
      { kind: "firstmate", origin: "captain-turn", canCreate: true },
      {
        action: "publish",
        requestId: "firstmate",
        kind: "direction",
        statement: RULE,
        reason: "The captain checked Fix 3.",
      },
    );
    expect(firstmate.text).toContain("app_change direction");
    expect(knowledge.standingDirections(scheduled)).toEqual([]);
  });
});
