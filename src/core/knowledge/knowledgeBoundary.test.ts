import { describe, expect, it } from "vitest";
import {
  type KnowledgeActor,
  KnowledgeService,
  PRIVATE_SCOPE,
  type RecordInput,
} from "./knowledgeService";

/**
 * The boundary saved on FI3-1338: knowledge holds personal context and
 * deliberately saved references. Project facts are refused. Firstmate writes
 * personal statements on the captain's words. Every crewmate reads and writes factual knowledge, but cannot retire an entry.
 */

const ALPHA = { id: "repo-alpha", name: "harbor", path: "/alpha" };
const BETA = { id: "repo-beta", name: "beta", path: "/beta" };
const ARTICLE = {
  kind: "article" as const,
  url: "https://example.com/inbox-retries",
  title: "Inbox retries",
  excerpt: "A provider failure spends no delivery attempt.",
  author: "Ada Lovelace",
  published: "2026-01-02",
};

function service(): KnowledgeService {
  return new KnowledgeService({
    projects: {
      get: (id) => [ALPHA, BETA].find((project) => project.id === id),
      list: () => [ALPHA, BETA],
    },
    gitFacts: async () => ({ commit: null, dirty: false }),
    now: () => 1_700_000_000_000,
  });
}

describe("user-owned knowledge", () => {
  const captain: KnowledgeActor = { kind: "firstmate", origin: "captain-turn", canCreate: true };
  const reported: KnowledgeActor = {
    kind: "firstmate",
    origin: "crewmate-report:task-1",
    canCreate: true,
  };
  const harbor: KnowledgeActor = { kind: "crewmate", taskId: "task-a", repoId: ALPHA.id };
  const other: KnowledgeActor = { kind: "crewmate", taskId: "task-b", repoId: BETA.id };
  const importer: KnowledgeActor = {
    kind: "crewmate",
    taskId: "task-import",
    repoId: ALPHA.id,
    access: "references",
  };

  async function publish(svc: KnowledgeService, actor: KnowledgeActor, input: RecordInput) {
    return svc.record(actor, input);
  }

  it("keeps personal context readable by every crewmate while refusing project collections and report-origin writes", async () => {
    const svc = service();
    const saved = await publish(svc, captain, {
      action: "publish",
      requestId: "day",
      kind: "concept",
      title: "Deploy day",
      explanation: "Deploys happen on Tuesdays.",
      appliesTo: [ALPHA.id],
    });
    expect(saved.committed).toBe(true);
    expect(saved.text).toContain("in private");
    const id = saved.ids[0] as string;

    expect(
      (
        await publish(svc, reported, {
          action: "publish",
          requestId: "from-report",
          kind: "concept",
          title: "From a report",
          explanation: "A crewmate said so.",
        })
      ).text,
    ).toContain("only on the captain's words");
    expect(
      (
        await publish(svc, captain, {
          action: "publish",
          requestId: "project",
          kind: "concept",
          title: "How harbor retries",
          explanation: "The code retries three times.",
          scope: ALPHA.id,
        })
      ).text,
    ).toContain("How a project works stays in its code");
    expect(
      (
        await publish(svc, harbor, {
          action: "publish",
          requestId: "crew",
          kind: "concept",
          title: "Captain context",
          explanation: "The captain asked to keep this.",
          lane: "personal",
        })
      ).committed,
    ).toBe(true);

    expect(svc.get(harbor, id).summary.lane).toBe("personal");
    expect(svc.get(other, id).summary.lane).toBe("personal");
    expect(svc.get(importer, id).summary.lane).toBe("personal");
    expect(svc.search(harbor, { query: "deploy Tuesdays" }).hits.map((hit) => hit.id)).toEqual([
      id,
    ]);
    expect(svc.search(other, { query: "deploy Tuesdays" }).total).toBe(1);
  });

  it("saves an article once, keeps it findable, and lets the same crewmate read personal context", async () => {
    const svc = service();
    const personal = await publish(svc, captain, {
      action: "publish",
      requestId: "plans",
      kind: "concept",
      title: "Travel plans",
      explanation: "Private to the captain.",
    });
    const saved = await publish(svc, importer, {
      action: "publish",
      requestId: "article",
      kind: "concept",
      title: "Inbox retries",
      explanation: "A saved article about retries.",
      sources: [ARTICLE],
    });
    expect(saved.committed).toBe(true);
    const conceptId = saved.ids[0] as string;
    expect(saved.text).toContain(ARTICLE.url);
    const view = svc.get(importer, conceptId);
    expect(view.summary.lane).toBe("reference");
    expect(view.sources[0]?.origin).toMatchObject({
      kind: "article",
      url: ARTICLE.url,
      title: ARTICLE.title,
      author: ARTICLE.author,
      published: ARTICLE.published,
      retrieved: 1_700_000_000_000,
    });
    expect(view.sources[0]?.text).toBe(ARTICLE.excerpt);
    expect(view.sources[0]?.check.state).toBe("kept");

    const again = await publish(svc, importer, {
      action: "publish",
      requestId: "article-again",
      kind: "concept",
      title: "Inbox retries again",
      explanation: "A second copy.",
      sources: [ARTICLE],
    });
    expect(again.committed).toBe(false);
    expect(again.text).toContain(`already saved as ${conceptId}`);
    expect(svc.count([PRIVATE_SCOPE])).toBe(2);

    const finding = await publish(svc, importer, {
      action: "publish",
      requestId: "claim",
      kind: "finding",
      statement: "A failed wake is retried.",
      basis: "observation",
      about: [conceptId],
      conditions: "the saved article",
      sources: [{ ...ARTICLE, excerpt: "The wake is retried from the inbox." }],
    });
    expect(finding.committed).toBe(true);

    const bare = await publish(svc, importer, {
      action: "publish",
      requestId: "bare-claim",
      kind: "finding",
      statement: "An unsaved page says otherwise.",
      basis: "observation",
      about: [conceptId],
      conditions: "not saved",
      sources: [{ ...ARTICLE, url: "https://example.com/other", excerpt: "Other words." }],
    });
    expect(bare.text).toContain("Save https://example.com/other as a concept first");

    const huge = await publish(svc, importer, {
      action: "publish",
      requestId: "huge",
      kind: "concept",
      title: "Whole page",
      explanation: "Too much.",
      sources: [{ ...ARTICLE, url: "https://example.com/whole", excerpt: "x".repeat(1501) }],
    });
    expect(huge.text).toContain("excerpt");

    expect(svc.search(importer, { query: ARTICLE.url }).hits.map((hit) => hit.id)).toEqual([
      conceptId,
    ]);
    expect(svc.get(importer, personal.ids[0] as string).summary.lane).toBe("personal");
    expect(svc.shortlist([PRIVATE_SCOPE], "inbox retries", harbor).map((hit) => hit.id)).toContain(
      conceptId,
    );
    expect(svc.shortlist([PRIVATE_SCOPE], "travel plans", importer).map((hit) => hit.id)).toContain(
      personal.ids[0],
    );
    expect(
      (
        await publish(svc, importer, {
          action: "retire",
          requestId: "drop",
          id: conceptId,
          expectedRevision: 1,
          reason: "cleanup",
        })
      ).text,
    ).toContain("waits for the captain");

    const retired = await publish(svc, captain, {
      action: "retire",
      requestId: "drop-captain",
      id: conceptId,
      expectedRevision: 1,
      reason: "the captain asked",
    });
    expect(retired.committed).toBe(true);
  });
});
