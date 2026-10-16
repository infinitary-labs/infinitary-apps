import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { piToolsOf } from "../pi/toolSpec";
import { bindTools } from "../session/tools";
import { contextKnowledge, knowledgeShortlist, renderBriefKnowledge } from "./context";
import { type KnowledgeActor, KnowledgeService } from "./knowledgeService";
import { KNOWLEDGE_TOOLS, knowledgeBinding } from "./knowledgeTools";

/**
 * The knowledge pair as a model meets it: the words each read and write
 * answers, bounded pages with a cursor, and a write committed once.
 */

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

function harness() {
  const root = scratchDir("fm-knowledge-tools-");
  const service = new KnowledgeService({
    projects: {
      get: (id) => (id === "repo-1" ? { id, name: "shop", path: root } : undefined),
      list: () => [{ id: "repo-1", name: "shop", path: root }],
    },
    gitFacts: async () => ({ commit: "0123456789abcdef", dirty: false }),
  });
  const recorded: string[] = [];
  const bind = (actor: KnowledgeActor) => {
    const tools = piToolsOf(
      bindTools(KNOWLEDGE_TOOLS, {
        knowledge: knowledgeBinding(
          service,
          () => actor,
          (outcome) => recorded.push(...outcome.ids),
        ),
      }),
    ) as unknown as Tool[];
    const call = async (name: string, params: Record<string, unknown>) =>
      (await tools.find((tool) => tool.name === name)?.execute("c", params))?.content[0]?.text ??
      "";
    return {
      read: (params: Record<string, unknown>) => call("knowledge", params),
      record: (params: Record<string, unknown>) => call("record_knowledge", params),
    };
  };
  const crew = bind({
    kind: "crewmate",
    taskId: "t1",
    repoId: "repo-1",
    cwd: root,
    access: "references",
  });
  return { root, service, recorded, crew, bind };
}

describe("the knowledge pair", () => {
  it("measures candidate context and entry reads through the tool interface", async () => {
    const h = harness();
    const concept = await h.crew.record({
      action: "publish",
      request_id: "measure-concept",
      kind: "concept",
      title: "Alpha-to-stable promotion",
      aliases: ["release promotion"],
      text: "The checks required before promoting an alpha.",
    });
    const conceptId = /c-[a-z0-9]{6}/.exec(concept)?.[0] as string;
    const finding = await h.crew.record({
      action: "publish",
      request_id: "measure-finding",
      kind: "finding",
      text: "The reply line shows only the new task title.",
      basis: "observation",
      about: [conceptId],
      conditions: "promote latest alpha to stable release btw 32",
      sources: [
        { quote: "Kept evidence line.\n".repeat(180), citation: "isolated measurement fixture" },
      ],
    });
    const findingId = /f-[a-z0-9]{6}/.exec(finding)?.[0] as string;
    const queries = [
      "promote latest alpha to stable release btw",
      "line",
      "32",
      "unrelated galaxies",
    ];
    const contexts = queries.map((query) => {
      const shortlist = knowledgeShortlist(h.service, ["captain"], query);
      return {
        query,
        context: contextKnowledge(shortlist),
        brief: renderBriefKnowledge(shortlist, "shop"),
      };
    });
    const read = await h.crew.read({ action: "get", ids: [findingId] });
    const sourceId = /s-[a-z0-9]{6}/.exec(read)?.[0] as string;
    const source = await h.crew.read({ action: "get", ids: [sourceId] });
    expect(source).toContain("Kept evidence line.");
    expect(read).toContain("statement: The reply line");
    expect(read).not.toContain("Kept evidence line.");
    expect(contexts[0]?.context?.candidates).toHaveLength(1);
    expect(contexts[0]?.brief).toContain(conceptId);
    expect(contexts[0]?.brief).not.toContain(findingId);
    for (const item of contexts.slice(1)) {
      expect(item.context?.found).toBe("nothing matched these words");
      expect(item.brief).not.toContain(findingId);
    }
    if (process.env.INFINITARY_KNOWLEDGE_EVIDENCE) {
      writeFileSync(
        join(process.env.INFINITARY_KNOWLEDGE_EVIDENCE, "tool-measurement.json"),
        JSON.stringify(
          {
            fixture: "Synthetic audit-shaped entries, not the captain's collection",
            contexts,
            contextBytes: Buffer.byteLength(JSON.stringify(contexts.map((item) => item.context))),
            briefBytes: contexts.reduce((total, item) => total + Buffer.byteLength(item.brief), 0),
            read,
            readBytes: Buffer.byteLength(read),
            source,
            sourceBytes: Buffer.byteLength(source),
          },
          null,
          2,
        ),
      );
    }
  });

  it("records a concept and a finding with file evidence, then reads them back as a model would", async () => {
    const h = harness();
    writeFileSync(join(h.root, "cart.ts"), "export const MAX = 50;\n// carts hold fifty lines\n");
    const concept = await h.crew.record({
      action: "publish",
      request_id: "c1",
      kind: "concept",
      title: "Cart limit",
      aliases: ["basket size"],
      text: "How many lines one cart holds.",
    });
    const conceptId = /c-[a-z0-9]{6}/.exec(concept)?.[0] as string;
    expect(concept).toBe(`Recorded concept ${conceptId} "Cart limit" (revision 1) in private.`);
    const finding = await h.crew.record({
      action: "publish",
      request_id: "f1",
      kind: "finding",
      text: "A cart holds at most 50 lines.",
      basis: "observation",
      about: [conceptId],
      conditions: "main at 0123456",
      sources: [{ quote: "A cart holds at most 50 lines.", citation: "cart.ts" }],
    });
    const findingId = /f-[a-z0-9]{6}/.exec(finding)?.[0] as string;
    expect(finding).toContain("Evidence kept: s-");
    expect(finding).toContain("quotation from cart.ts");
    expect(finding).toContain("not yet checked");
    expect(h.recorded).toEqual([conceptId, findingId]);

    const search = await h.crew.read({ action: "search", query: "basket size" });
    expect(search.split("\n")[0]).toBe(
      "1 match in private, best first (candidates: get one before relying on it):",
    );
    expect(search).toContain(
      `${conceptId} concept "Cart limit" r1 [private, saved reference]; also called basket size; 1 findings`,
    );

    const read = await h.crew.read({ action: "get", ids: [findingId] });
    expect(read).toContain("statement: A cart holds at most 50 lines.");
    expect(read).toContain("conditions: main at 0123456");
    expect(read).toContain("status: not yet checked");
    expect(read).toContain("quotation from cart.ts");
    expect(read).toContain("kept");
    const sourceId = /s-[a-z0-9]{6}/.exec(read)?.[0] as string;
    const kept = await h.crew.read({ action: "get", ids: [sourceId] });
    expect(kept).toContain("A cart holds at most 50 lines.");
    expect(kept).toContain("kept");
    const combined = await h.crew.read({ action: "get", ids: [findingId, sourceId] });
    expect(combined).toContain("statement: A cart holds");
    expect(combined).toContain("quotation from cart.ts");

    const near = await h.crew.read({ action: "neighbors", id: conceptId });
    expect(near).toContain(
      `- finding about this: ${findingId} finding r1 [private, saved reference]`,
    );

    const history = await h.crew.read({ action: "history", id: conceptId });
    expect(history).toContain("revision 1 (publish) by task:t1");
  });

  it("pages a long search with a cursor inside its byte bound", async () => {
    const h = harness();
    for (let index = 0; index < 14; index += 1) {
      await h.crew.record({
        action: "publish",
        request_id: `c${index}`,
        kind: "concept",
        title: `Checkout step ${index}`,
        text: `Checkout detail ${index} ${"with a long explanation ".repeat(4)}`,
      });
    }
    const first = await h.crew.read({ action: "search", query: "checkout" });
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(4096);
    expect(first.split("\n")[0]).toContain("14 matches in private");
    const cursor = /next: cursor (\d+)/.exec(first)?.[1];
    expect(cursor).toBe("10");
    const second = await h.crew.read({ action: "search", query: "checkout", cursor });
    expect(second.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
    expect(second).not.toContain("next: cursor");
  });

  it("tells no match from an unavailable collection", async () => {
    const h = harness();
    expect(await h.crew.read({ action: "search", query: "refunds" })).toContain(
      'No knowledge matched "refunds" in private',
    );
  });

  it("answers a refusal as words and repeats nothing", async () => {
    const h = harness();
    expect(await h.crew.read({ action: "get", ids: ["c-nope00"] })).toBe(
      "No entry c-nope00 in a collection you can read.",
    );
    expect(
      await h.crew.record({ action: "publish", request_id: "x", kind: "finding", text: "s" }),
    ).toContain("basis");
    const call = {
      action: "publish",
      request_id: "once",
      kind: "concept",
      title: "Shipping",
      text: "Getting orders out.",
    };
    await h.crew.record(call);
    expect(await h.crew.record(call)).toContain("Already done (same request_id)");
    expect(h.recorded).toHaveLength(1);
  });
});
