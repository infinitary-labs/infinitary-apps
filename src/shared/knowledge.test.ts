import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_ID_EXACT,
  KNOWLEDGE_REFS_MAX,
  knowledgeIdsIn,
  knowledgeRefsArgsSchema,
} from "./knowledge";

describe("knowledgeIdsIn", () => {
  it("finds every concept and finding id, once each, in order", () => {
    expect(knowledgeIdsIn("f-ejtt2f and c-9ab0cd, then f-ejtt2f again; (f-dqgwov).")).toEqual([
      "f-ejtt2f",
      "c-9ab0cd",
      "f-dqgwov",
    ]);
  });

  it("reads ids in markup and in the text around tags", () => {
    expect(
      knowledgeIdsIn(
        '<li>Retries keep it <span class="inf-mono">f-ejtt2f</span>,<code>c-abc123</code></li>',
      ),
    ).toEqual(["f-ejtt2f", "c-abc123"]);
  });

  it("leaves words that only look like ids", () => {
    expect(
      knowledgeIdsIn(
        "F-ejtt2f s-abc123 xf-abc123 f-abc1234 f-abc12 f-ABC123 f_abc123 claim:f-abc123-x",
      ),
    ).toEqual([]);
  });

  it("stops at KNOWLEDGE_REFS_MAX, which a refs read takes whole", () => {
    const ids = Array.from(
      { length: KNOWLEDGE_REFS_MAX + 4 },
      (_, n) => `f-${String(n).padStart(6, "0")}`,
    );
    const found = knowledgeIdsIn(ids.join(" "));
    expect(found).toHaveLength(KNOWLEDGE_REFS_MAX);
    expect(found.every((id) => KNOWLEDGE_ID_EXACT.test(id))).toBe(true);
    expect(knowledgeRefsArgsSchema.safeParse({ ids: found }).success).toBe(true);
    expect(
      knowledgeRefsArgsSchema.safeParse({ ids: ids.slice(0, KNOWLEDGE_REFS_MAX + 1) }).success,
    ).toBe(false);
  });
});
