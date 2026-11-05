import { describe, expect, it } from "vitest";
import type { KnowledgeActor } from "./access";
import { type KnowledgeApproval, KnowledgeService } from "./knowledgeService";
import type { RecordInput } from "./writes";

/**
 * Retiring a captain-approved list in one write (docs/knowledge.md,
 * "Retiring an entry"): `retire_many` stands only on the closing choice the
 * captain clicked on a task's card, retires only what that card names, leaves
 * kept and already retired entries alone and lists them, keeps each entry's
 * history as a single retire does, and says the whole list in one feed line.
 */

const CAPTAIN: KnowledgeActor = { kind: "firstmate", origin: "captain-turn", canCreate: true };
const SCHEDULED: KnowledgeActor = { kind: "firstmate", origin: "agent", canCreate: false };
const CREW: KnowledgeActor = { kind: "crewmate", taskId: "task-a", repoId: "repo-alpha" };

async function fixture() {
  const approvals = new Map<string, KnowledgeApproval>();
  const announced: string[] = [];
  let changes = 0;
  let clock = 1_792_000_000_000;
  let given = 0;
  const service = new KnowledgeService({
    projects: { get: () => undefined, list: () => [] },
    now: () => (clock += 1000),
    newId: (prefix) => {
      given += 1;
      return `${prefix}-pin${String(given).padStart(3, "0")}`;
    },
    approvals: { of: (ref) => approvals.get(ref) },
    announce: (text) => announced.push(text),
    changed: () => {
      changes += 1;
    },
  });
  let request = 0;
  const record = (actor: KnowledgeActor, input: Omit<RecordInput, "requestId">) => {
    request += 1;
    return service.record(actor, { requestId: `r${request}`, ...input });
  };
  const publish = async (input: Omit<RecordInput, "requestId" | "action">) => {
    const outcome = await record(CREW, { action: "publish", ...input });
    if (!outcome.committed) throw new Error(outcome.text);
    return outcome.ids[0] as string;
  };
  // Three saved references from one import, and a finding about the first.
  const article = await publish({
    kind: "concept",
    title: "Scion",
    explanation: "A git-less, server-centered version control design.",
  });
  const servers = await publish({
    kind: "concept",
    title: "Server-held history",
    explanation: "History kept only on a server, never in a working copy.",
  });
  const review = await publish({
    kind: "concept",
    title: "Review queue",
    explanation: "Changes wait in one queue until a reviewer approves them.",
  });
  const claim = await publish({
    kind: "finding",
    statement: "Scion keeps every change's history on the server.",
    basis: "inference",
    about: [article, servers],
    conditions: "As the article describes it.",
  });
  const card = (key: string, action: string, ids: string[]): KnowledgeApproval => ({
    key,
    title: "Remove the imported version control notes?",
    body: `<p>These entries came from one article import: ${ids.join(", ")}.</p>`,
    action,
    resolvedAt: clock,
  });
  return {
    service,
    approvals,
    announced,
    changes: () => changes,
    record,
    card,
    ids: { article, servers, review, claim },
  };
}

describe("retiring an approved list", () => {
  it("retires exactly the entries the resolved card names, each with its history, in one feed line", async () => {
    const f = await fixture();
    const { article, servers, review, claim } = f.ids;
    f.approvals.set("INF-9", f.card("INF-9", "remove", [article, claim, servers]));
    const before = f.changes();
    const outcome = await f.record(CAPTAIN, {
      action: "retire_many",
      task: " INF-9 ",
      reason: "The captain approved removing the import.",
    });
    expect(outcome).toEqual({
      text: `Retired 3 entries approved on INF-9: ${article}, ${claim}, ${servers}. Their history and evidence stay readable.`,
      committed: true,
      ids: [article, claim, servers],
    });
    expect(f.announced).toEqual([
      "First mate · retired 3 knowledge entries the captain approved (INF-9)",
    ]);
    expect(f.changes()).toBe(before + 1);
    for (const id of [article, claim, servers]) {
      const history = f.service.history({ id });
      expect(history.entry.retired).toBe(true);
      expect(
        history.revisions.map(({ revision, op, reason, actor, origin }) => ({
          revision,
          op,
          reason,
          actor,
          origin,
        })),
      ).toEqual([
        {
          revision: 2,
          op: "retire",
          reason: "The captain approved removing the import. (approved on INF-9)",
          actor: "firstmate",
          origin: "captain-turn",
        },
        { revision: 1, op: "publish", reason: "", actor: "task:task-a", origin: "crewmate" },
      ]);
    }
    // Not on the card, so still active.
    expect(f.service.get(CAPTAIN, review).summary.retired).toBe(false);
  });

  it("narrows to the ids asked, keeps the exceptions and lists what it left alone", async () => {
    const f = await fixture();
    const { article, servers, review, claim } = f.ids;
    f.approvals.set("INF-9", f.card("INF-9", "remove", [article, servers, review, claim]));
    await f.record(CAPTAIN, {
      action: "retire",
      id: claim,
      expectedRevision: 1,
      reason: "The captain asked.",
    });
    const outcome = await f.record(CAPTAIN, {
      action: "retire_many",
      task: "INF-9",
      ids: [claim, article, ` ${servers} `, article],
      except: [servers],
      reason: "Approved.",
    });
    expect(outcome).toEqual({
      text: `Retired 1 entries approved on INF-9: ${article}. Their history and evidence stay readable. Left alone: ${claim} (already retired).`,
      committed: true,
      ids: [article],
    });
    expect(f.announced).toEqual([
      "First mate · retired 1 knowledge entry the captain approved (INF-9)",
    ]);
    expect(f.service.get(CAPTAIN, servers).summary.retired).toBe(false);
    expect(f.service.get(CAPTAIN, review).summary.retired).toBe(false);
  });

  it("lists an entry the card names that no collection holds, and retires the rest", async () => {
    const f = await fixture();
    const { article } = f.ids;
    f.approvals.set("INF-9", f.card("INF-9", "remove", [article, "f-gone00"]));
    const outcome = await f.record(CAPTAIN, {
      action: "retire_many",
      task: "INF-9",
      reason: "Approved.",
    });
    expect(outcome.text).toBe(
      `Retired 1 entries approved on INF-9: ${article}. Their history and evidence stay readable. Left alone: f-gone00 (not readable).`,
    );
  });

  it("refuses without the captain's turn, a resolved choice, or ids the card names, and changes nothing", async () => {
    const f = await fixture();
    const { article, servers, review } = f.ids;
    f.approvals.set("INF-9", f.card("INF-9", "remove", [article, servers]));
    f.approvals.set("INF-10", f.card("INF-10", "close", [article, servers]));
    f.approvals.set("INF-11", f.card("INF-11", "remove", [article]));
    const before = f.changes();
    const refusals: [KnowledgeActor, Omit<RecordInput, "requestId">, string][] = [
      [
        CREW,
        { action: "retire_many", task: "INF-9", reason: "Approved." },
        "Removing entries waits for the captain. The first mate retires them on the captain's word.",
      ],
      [
        SCHEDULED,
        { action: "retire_many", task: "INF-9", reason: "Approved." },
        "The first mate records a personal statement or correction only on the captain's words. An import or a reconciliation is the crewmate's write. A scheduled turn records nothing.",
      ],
      [
        CAPTAIN,
        { action: "retire_many", task: "INF-404", reason: "Approved." },
        "INF-404 has no card the captain resolved with a choice, so there is no approval to stand on. Retire one entry at a time, or ask them first.",
      ],
      [
        CAPTAIN,
        { action: "retire_many", task: "INF-10", reason: "Approved." },
        "The captain dismissed INF-10's card without choosing; a dismissal approves nothing.",
      ],
      [
        CAPTAIN,
        { action: "retire_many", task: "INF-9", ids: [article, review], reason: "Approved." },
        `${review} is not named on the card INF-9 showed; the approval covers only what it listed.`,
      ],
      [
        CAPTAIN,
        {
          action: "retire_many",
          task: "INF-9",
          ids: [review, "c-other0", article],
          reason: "Approved.",
        },
        `${review}, c-other0 are not named on the card INF-9 showed; the approval covers only what it listed.`,
      ],
      [
        CAPTAIN,
        { action: "retire_many", task: "INF-11", except: [article], reason: "Approved." },
        "Nothing to retire: every entry that card names is retired already or kept.",
      ],
      [CAPTAIN, { action: "retire_many", reason: "Approved." }, "task is required."],
      [CAPTAIN, { action: "retire_many", task: "INF-9" }, "reason is required."],
    ];
    for (const [actor, input, words] of refusals) {
      expect(await f.record(actor, input)).toEqual({ text: words, committed: false, ids: [] });
    }
    expect(f.announced).toEqual([]);
    expect(f.changes()).toBe(before);
    for (const id of [article, servers, review]) {
      expect(f.service.get(CAPTAIN, id).summary.retired).toBe(false);
    }
  });
});
