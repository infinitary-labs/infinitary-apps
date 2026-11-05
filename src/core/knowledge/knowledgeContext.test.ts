import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { contextKnowledge, knowledgeShortlist, renderBriefKnowledge } from "./context";
import { KnowledgeService } from "./knowledgeService";

/**
 * Knowledge first, as a turn and a brief carry it: candidates by name and
 * check, never a finding's words; no match, no words and no collection each
 * say so differently; and notes keep only preferences in view.
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

const crew = {
  kind: "crewmate",
  taskId: "t1",
  repoId: "repo-1",
} as const;

describe("knowledge first", () => {
  it("offers candidates by id, name and check, without what a finding says", async () => {
    const knowledge = service();
    const concept = await knowledge.record(crew, {
      action: "publish",
      requestId: "c",
      kind: "concept",
      title: "Refund window",
      explanation: "How long a refund stays open.",
    });
    await knowledge.record(crew, {
      action: "publish",
      requestId: "f",
      kind: "finding",
      statement: "Refunds close after exactly thirty days, secretly.",
      basis: "inference",
      about: [concept.ids[0] as string],
      conditions: "policy v3",
    });
    const found = knowledgeShortlist(knowledge, ["captain"], "when does the refund window close?");
    expect(found?.state).toBe("found");
    const lines = found?.state === "found" ? found.lines : [];
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain('"Refund window"');
    expect(lines.join("\n")).toContain("not yet checked");
    expect(lines.join("\n")).not.toContain("secretly");
    expect(contextKnowledge(found)).toMatchObject({ searched: "private", candidates: lines });

    const brief = renderBriefKnowledge(found, "shop");
    expect(brief.split("\n")[0]).toContain("knowledge for shop (candidates");
    expect(brief).toContain("Do not record project facts");
  });

  it("tells no words, no match and an unreadable collection apart", async () => {
    const knowledge = service();
    expect(knowledgeShortlist(knowledge, ["repo-1"], "?! .")).toBeUndefined();
    expect(contextKnowledge(undefined)).toBeUndefined();
    const none = knowledgeShortlist(knowledge, ["repo-1"], "warehouse robots");
    expect(none).toEqual({ state: "none", searched: "shop" });
    expect(renderBriefKnowledge(none, "shop")).toContain(
      "nothing matched this task's title and goal yet",
    );

    const dir = scratchDir("fm-knowledge-unreadable-");
    writeFileSync(join(dir, "knowledge.db"), "not a database");
    const broken = knowledgeShortlist(service(dir), ["repo-1"], "warehouse robots");
    expect(broken).toMatchObject({ state: "unavailable" });
    expect(contextKnowledge(broken)).toMatchObject({
      unavailable: expect.stringContaining("could not be read"),
    });
    expect(renderBriefKnowledge(broken, "shop")).toContain("knowledge for shop is unavailable");
  });
});
