import { readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type KnowledgeActor,
  KnowledgeRefusal,
  KnowledgeService,
  type RecordInput,
  type SourceInput,
} from "./knowledgeService";

/**
 * What the knowledge owner refuses, in the words the model reads
 * (docs/knowledge.md, "Who may write" and "Evidence"): a refusal is the
 * answer, never a failed turn, it commits nothing, and the collection reads
 * byte for byte as it did. Each row is a write a crewmate or the first mate
 * can send through `record_knowledge`.
 */

const ALPHA = { id: "repo-alpha", name: "alpha" };
const CAPTAIN: KnowledgeActor = { kind: "firstmate", origin: "captain-turn", canCreate: true };
const crew = (taskId = "task-a"): KnowledgeActor => ({
  kind: "crewmate",
  taskId,
  repoId: ALPHA.id,
});

async function fixture() {
  const root = scratchDir("fm-knowledge-refusals-");
  const dir = join(root, "knowledge");
  const reports = new Map([
    // A report whose own words carry a key: kept whole, it would carry the key into knowledge.
    ["task-k", [{ id: 7, text: "Deployed with api_key=hunter2hunter2 in the shell." }]],
  ]);
  const tasks = new Map([
    ["task-k", { id: "task-k", key: "AL-7", repoId: ALPHA.id }],
    ["task-q", { id: "task-q", key: "AL-8", repoId: ALPHA.id }],
  ]);
  let changes = 0;
  let clock = 1_792_000_000_000;
  const service = new KnowledgeService({
    dir,
    projects: {
      get: (id) => (id === ALPHA.id ? { ...ALPHA, path: root } : undefined),
      list: () => [{ ...ALPHA, path: root }],
    },
    tasks: {
      resolve: (ref) => tasks.get(ref) ?? [...tasks.values()].find((task) => task.key === ref),
      reports: (taskId) => reports.get(taskId) ?? [],
    },
    gitFacts: async () => ({ commit: null, dirty: false }),
    now: () => (clock += 1000),
    changed: () => {
      changes += 1;
    },
  });
  let request = 0;
  const record = (actor: KnowledgeActor, input: Omit<RecordInput, "requestId">) => {
    request += 1;
    return service.record(actor, { requestId: `r${request}`, ...input });
  };
  const kept = async (actor: KnowledgeActor, input: Omit<RecordInput, "requestId">) => {
    const outcome = await record(actor, input);
    if (!outcome.committed) throw new Error(outcome.text);
    return outcome.ids[0] as string;
  };
  const concept = (actor: KnowledgeActor, title: string, extra: Partial<RecordInput> = {}) =>
    kept(actor, {
      action: "publish",
      kind: "concept",
      title,
      explanation: `${title}, as the crew uses it.`,
      ...extra,
    });
  const personal = await concept(CAPTAIN, "Morning reviews");
  const inbox = await concept(crew(), "Inbox delivery");
  const failure = await concept(crew(), "Provider failure");
  const retired = await concept(crew(), "Old queue");
  await kept(CAPTAIN, {
    action: "retire",
    id: retired,
    expectedRevision: 1,
    reason: "The captain asked.",
  });
  const finding = await kept(crew(), {
    action: "publish",
    kind: "finding",
    statement: "A failed turn is retried from the inbox.",
    basis: "inference",
    about: [inbox, failure],
    conditions: "On main.",
  });
  const withdrawn = await kept(crew(), {
    action: "publish",
    kind: "finding",
    statement: "A failed turn is dropped.",
    basis: "inference",
    about: [inbox],
    conditions: "On an older build.",
  });
  await kept(CAPTAIN, {
    action: "retire",
    id: withdrawn,
    expectedRevision: 1,
    reason: "The captain asked.",
  });
  /** Every table of the collection, as saved, so a refusal is seen to change nothing. */
  const saved = () => {
    const db = new Database(join(dir, "knowledge.db"), { readonly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      return Object.fromEntries(
        tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
      );
    } finally {
      db.close();
    }
  };
  return {
    root,
    service,
    record,
    saved,
    changes: () => changes,
    ids: { personal, inbox, failure, retired, finding, withdrawn },
  };
}

const article: SourceInput = {
  kind: "article",
  url: "https://example.com/scion",
  title: "Scion",
  excerpt: "History lives on the server.",
};

describe("a refused write", () => {
  it("answers in its own words, commits nothing and leaves the collection as it was", async () => {
    const f = await fixture();
    const { personal, inbox, failure, retired, finding, withdrawn } = f.ids;
    const publishFinding = (extra: Partial<RecordInput>): Omit<RecordInput, "requestId"> => ({
      action: "publish",
      kind: "finding",
      statement: "Retries wait for the inbox.",
      basis: "inference",
      conditions: "On main.",
      ...extra,
    });
    const rows: [string, KnowledgeActor, Omit<RecordInput, "requestId">, string][] = [
      [
        "a field that carries a key",
        crew(),
        { action: "publish", kind: "concept", title: "Keys", explanation: "password: hunter2" },
        "Refused: explanation matches a credential pattern. Knowledge is not a place for credentials, instruction overrides or exfiltration links.",
      ],
      [
        "the first mate saving a reference",
        CAPTAIN,
        { action: "publish", kind: "concept", lane: "reference", title: "Scion", explanation: "x" },
        "An import or reconciliation is a crewmate's write.",
      ],
      [
        "the first mate importing an article",
        CAPTAIN,
        {
          action: "publish",
          kind: "concept",
          title: "Scion",
          explanation: "x",
          sources: [article],
        },
        "An article import is a crewmate's write. Ask a crewmate to save it, and do not extract the article yourself.",
      ],
      [
        "an article kept as personal context",
        crew(),
        {
          action: "publish",
          kind: "concept",
          lane: "personal",
          title: "Scion",
          explanation: "x",
          sources: [article],
        },
        "An article is a saved reference, not personal context.",
      ],
      [
        "a publish with no kind",
        crew(),
        { action: "publish", title: "Scion", explanation: "x" },
        "publish needs kind: concept or finding.",
      ],
      [
        "a concept with too many aliases",
        crew(),
        {
          action: "publish",
          kind: "concept",
          title: "Queues",
          explanation: "x",
          aliases: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        },
        "A concept has at most 8 aliases.",
      ],
      [
        "a link to a retired concept",
        crew(),
        {
          action: "publish",
          kind: "concept",
          title: "Queues",
          explanation: "x",
          links: [{ to: retired, reason: "older design" }],
        },
        `Link ${retired} is not an active concept in this collection.`,
      ],
      [
        "a title another concept has",
        crew(),
        { action: "publish", kind: "concept", title: "INBOX DELIVERY", explanation: "x" },
        `A concept titled "Inbox delivery" already exists as ${inbox}; revise or link it instead.`,
      ],
      [
        "applies to too many projects",
        crew(),
        {
          action: "publish",
          kind: "concept",
          title: "Queues",
          explanation: "x",
          appliesTo: Array.from({ length: 9 }, (_, index) => `repo-${index}`),
        },
        "An entry applies to at most 8 projects.",
      ],
      [
        "applies to a project the app does not know",
        crew(),
        {
          action: "publish",
          kind: "concept",
          title: "Queues",
          explanation: "x",
          appliesTo: ["repo-x"],
        },
        'Unknown project "repo-x" in applies_to.',
      ],
      [
        "a finding about a finding",
        crew(),
        publishFinding({ about: [finding] }),
        `about ${finding} is not an active concept in this collection; publish the concept first.`,
      ],
      [
        "a relationship from a concept to itself",
        crew(),
        publishFinding({ relationship: { from: inbox, predicate: "feeds", to: inbox } }),
        "A relationship joins two different concepts.",
      ],
      [
        "a finding about nothing",
        crew(),
        publishFinding({}),
        "Say which concepts a finding is about (about: concept ids); publish a concept first if none fits.",
      ],
      [
        "a report that carries a key",
        crew(),
        publishFinding({ about: [inbox], sources: [{ kind: "report", task: "AL-7" }] }),
        "Refused: a cited source matches a credential pattern; cite text without it.",
      ],
      [
        "a report of a task the app does not know",
        crew(),
        publishFinding({ about: [inbox], sources: [{ kind: "report", task: "AL-0" }] }),
        'No task "AL-0" to cite.',
      ],
      [
        "a report not written yet",
        crew(),
        publishFinding({ about: [inbox], sources: [{ kind: "report", task: "AL-8" }] }),
        "AL-8 has no report to cite yet.",
      ],
      [
        "a source of no kind the app keeps",
        crew(),
        publishFinding({
          about: [inbox],
          sources: [{ kind: "video", url: "https://example.com" } as unknown as SourceInput],
        }),
        "A source is a task's report, a quotation, or a short article excerpt.",
      ],
      [
        "an id that is not an entry's",
        crew(),
        { action: "revise", id: "inbox", expectedRevision: 1, title: "x" },
        'Give an entry id such as c-1a2b3c or f-1a2b3c; got "inbox".',
      ],
      [
        "revising a retired entry",
        crew(),
        { action: "revise", id: retired, expectedRevision: 2, title: "Newer queue" },
        `${retired} is retired; publish a new entry instead.`,
      ],
      [
        "the first mate reconciling a saved reference",
        CAPTAIN,
        { action: "revise", id: inbox, expectedRevision: 1, title: "Inbox" },
        "A saved reference is the importing crewmate's to reconcile. The first mate records personal statements and corrections, and retires an entry only on the captain's word.",
      ],
      [
        "the first mate citing an article on personal context",
        CAPTAIN,
        { action: "revise", id: personal, expectedRevision: 1, sources: [article] },
        "An article import is a crewmate's write, on the captain's request.",
      ],
      [
        "an assessment of a revision that does not exist",
        crew("task-b"),
        {
          action: "assess",
          id: finding,
          revision: 9,
          verdict: "supports",
          method: "m",
          conditions: "c",
        },
        `${finding} has no revision 9.`,
      ],
      [
        "an assessment with no verdict",
        crew("task-b"),
        { action: "assess", id: finding, method: "Read it.", conditions: "On main." },
        "assess needs verdict: supports, contradicts or inconclusive.",
      ],
      [
        "read-together links between findings",
        crew(),
        { action: "relate", from: finding, to: inbox, type: "related", reason: "x" },
        "related links two concepts; between findings use contradicts, supersedes or duplicates.",
      ],
      [
        "read-together links to a retired concept",
        crew(),
        { action: "relate", from: inbox, to: retired, type: "related", reason: "x" },
        "Both concepts must be active.",
      ],
      [
        "a relation of no type",
        crew(),
        { action: "relate", from: inbox, to: failure, reason: "x" },
        "relate needs type: related (concepts), or contradicts, supersedes or duplicates (findings).",
      ],
      [
        "a use of a revision that does not exist",
        crew("task-b"),
        { action: "use", id: finding, revision: 9, purpose: "Sized the retry." },
        `${finding} has no revision 9.`,
      ],
      [
        "an action the owner does not take",
        crew(),
        { action: "delete" as RecordInput["action"], id: inbox },
        "action must be publish, revise, assess, relate, retire, retire_many or use.",
      ],
      [
        "an observation with no evidence",
        crew(),
        publishFinding({ basis: "observation", about: [inbox] }),
        "An observation cites its evidence: pass sources (a task's report, a quotation, or a short article excerpt).",
      ],
      [
        "more sources than one write keeps",
        crew(),
        publishFinding({
          about: [inbox],
          sources: Array.from({ length: 7 }, (_, index) => ({
            kind: "quote" as const,
            text: `Line ${index}.`,
            citation: "inbox.ts",
          })),
        }),
        "Cite at most 6 sources in one write.",
      ],
      [
        "an article that is not a web link",
        crew(),
        {
          action: "publish",
          kind: "concept",
          title: "Scion",
          explanation: "x",
          sources: [{ ...article, url: "ftp://example.com/scion" }],
        },
        "An article source needs an http or https link.",
      ],
      [
        "a concept linking to itself",
        crew(),
        {
          action: "revise",
          id: inbox,
          expectedRevision: 1,
          links: [{ to: inbox, reason: "itself" }],
        },
        "A concept cannot link to itself.",
      ],
      [
        "an assessment of a concept",
        crew("task-b"),
        { action: "assess", id: inbox, verdict: "supports", method: "m", conditions: "c" },
        "assess takes a finding; revise a concept instead.",
      ],
      [
        "an assessment of a retired finding",
        crew("task-b"),
        { action: "assess", id: withdrawn, verdict: "supports", method: "m", conditions: "c" },
        `${withdrawn} is retired.`,
      ],
      [
        "an entry related to itself",
        crew(),
        { action: "relate", from: finding, to: finding, type: "duplicates", reason: "x" },
        "An entry cannot relate to itself.",
      ],
      [
        "a retired finding contradicting another",
        crew(),
        { action: "relate", from: withdrawn, to: finding, type: "contradicts", reason: "x" },
        `${withdrawn} is retired.`,
      ],
      [
        "retiring an entry twice",
        CAPTAIN,
        { action: "retire", id: retired, expectedRevision: 2, reason: "Asked." },
        `${retired} is already retired.`,
      ],
    ];
    const before = f.saved();
    const changes = f.changes();
    const answers = [];
    for (const [what, actor, input] of rows) {
      answers.push([what, await f.record(actor, input)]);
    }
    expect(answers).toEqual(
      rows.map(([what, , , words]) => [what, { text: words, committed: false, ids: [] }]),
    );
    expect(f.changes()).toBe(changes);
    expect(f.saved()).toEqual(before);
    expect(readdirSync(f.root)).toEqual(["knowledge"]);
  });

  it("refuses a write that another write moved past while it was prepared", async () => {
    const f = await fixture();
    const { inbox, failure } = f.ids;
    const [first, second] = await Promise.all([
      f.record(crew(), { action: "revise", id: inbox, expectedRevision: 1, explanation: "First." }),
      f.record(crew(), {
        action: "revise",
        id: inbox,
        expectedRevision: 1,
        explanation: "Second.",
      }),
    ]);
    expect(first).toMatchObject({ committed: true, text: `Revised ${inbox} to revision 2.` });
    expect(second).toEqual({
      text: `${inbox} moved to revision 2; read it again and revise from there.`,
      committed: false,
      ids: [],
    });
    const [revised, retired] = await Promise.all([
      f.record(crew(), {
        action: "revise",
        id: failure,
        expectedRevision: 1,
        explanation: "Newer.",
      }),
      f.record(CAPTAIN, { action: "retire", id: failure, expectedRevision: 1, reason: "Asked." }),
    ]);
    expect(revised.committed).toBe(true);
    expect(retired).toEqual({
      text: `${failure} moved to revision 2; read it again first.`,
      committed: false,
      ids: [],
    });
    expect(f.service.get(CAPTAIN, failure).summary).toMatchObject({ revision: 2, retired: false });
  });

  it("refuses a read of a scope the reader does not read, in words for who asks", async () => {
    const f = await fixture();
    expect(() => f.service.search(crew(), { query: "inbox", scope: ALPHA.id })).toThrow(
      new KnowledgeRefusal("You read the captain's factual knowledge. Leave scope out."),
    );
    expect(() => f.service.search(CAPTAIN, { query: "inbox", scope: "repo-x" })).toThrow(
      new KnowledgeRefusal(
        'Unknown scope "repo-x". Use captain or a repo_id from the context block.',
      ),
    );
    expect(() => f.service.search(crew(), { query: "  " })).toThrow(
      new KnowledgeRefusal(
        "Give a few words to search for: a name, an alias, or what the entry says.",
      ),
    );
    expect(
      f.service.search(crew(), { query: "inbox", scope: " captain " }).hits.map((hit) => hit.id),
    ).toEqual([f.ids.inbox]);
  });
});
