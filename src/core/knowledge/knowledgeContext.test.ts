import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { contextSavedKnowledge, renderBriefKnowledge, savedKnowledge } from "./context";
import { KnowledgeService } from "./knowledgeService";

/**
 * The captain's ruling on INF-4008: "saved knowledge should be discoverable
 * by the agent but not automatically injected". A first mate conversation and
 * a brief are told only how much is saved, by category; an empty collection
 * says nothing, and an unreadable one says so rather than reading as empty.
 */

function service(dir?: string) {
  const root = scratchDir("fm-knowledge-context-");
  return new KnowledgeService({
    ...(dir ? { dir } : {}),
    projects: {
      get: (id) => (id === "repo-1" ? { id, name: "shop", path: root } : undefined),
      list: () => [{ id: "repo-1", name: "shop", path: root }],
    },
  });
}

const crew = { kind: "crewmate", taskId: "t1", repoId: "repo-1" } as const;

describe("saved knowledge as counts", () => {
  it("counts personal entries and saved sources with their findings, never their words", async () => {
    const knowledge = service();
    const home = await knowledge.record(crew, {
      action: "publish",
      requestId: "home",
      kind: "concept",
      lane: "personal",
      title: "Where the captain lives",
      explanation: "The captain lives in Lisbon.",
    });
    const article = await knowledge.record(crew, {
      action: "publish",
      requestId: "article",
      kind: "concept",
      title: "Refund window",
      explanation: "How long a refund stays open.",
    });
    for (const n of [1, 2]) {
      await knowledge.record(crew, {
        action: "publish",
        requestId: `f${n}`,
        kind: "finding",
        statement: `Refunds close after ${n === 1 ? "thirty" : "forty"} days, secretly.`,
        basis: "inference",
        about: [article.ids[0] as string],
        conditions: "policy v3",
      });
    }
    const saved = savedKnowledge(knowledge);
    expect(saved).toEqual({ state: "held", counts: { personal: 1, sources: 1, findings: 2 } });
    const context = contextSavedKnowledge(saved) ?? "";
    const brief = renderBriefKnowledge(saved) ?? "";
    for (const line of [context, brief]) {
      expect(line).toContain("1 personal entry and 1 saved source with 2 findings");
      for (const word of ["Lisbon", "Refund window", "secretly", home.ids[0], article.ids[0]])
        expect(line).not.toContain(word);
    }
  });

  it("says nothing for an empty collection and creates no file reading it", () => {
    const dir = scratchDir("fm-knowledge-empty-");
    const saved = savedKnowledge(service(dir));
    expect(saved).toEqual({ state: "empty" });
    expect(contextSavedKnowledge(saved)).toBeUndefined();
    expect(renderBriefKnowledge(saved)).toBeUndefined();
    expect(existsSync(join(dir, "knowledge.db"))).toBe(false);
  });

  it("says an unreadable collection cannot be read", () => {
    const dir = scratchDir("fm-knowledge-unreadable-");
    writeFileSync(join(dir, "knowledge.db"), "not a database");
    const saved = savedKnowledge(service(dir));
    expect(saved).toMatchObject({ state: "unavailable" });
    expect(contextSavedKnowledge(saved)).toContain("cannot be read");
    expect(renderBriefKnowledge(saved)).toContain("cannot be read");
  });
});
