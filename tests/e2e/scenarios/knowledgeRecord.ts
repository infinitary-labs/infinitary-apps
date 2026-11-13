import type { Scenario } from "../mockProvider";
import { calledTool, toolCallCount } from "../providerRequest";

/**
 * Knowledge (docs/knowledge.md, knowledge.spec.ts). A crewmate whose task
 * title carries KNOWLEDGE_RECORD_PROMPT_MARKER is granted saved references.
 * It records MOCK_KNOWLEDGE_CONCEPT from MOCK_KNOWLEDGE_ARTICLE, a finding
 * citing that article, then the same link again, which must not add a
 * second concept, and reports. One whose title carries
 * KNOWLEDGE_REUSE_PROMPT_MARKER searches in other words, since its brief
 * lists no saved entry, follows the concept it finds to the finding, reads the excerpt, declares that it relied on it, and
 * reports. Both titles name the project they bind to.
 */
export const KNOWLEDGE_RECORD_PROMPT_MARKER = "learn how the harbor inbox retries";

export const KNOWLEDGE_REUSE_PROMPT_MARKER = "check the harbor wake queue";

export const MOCK_KNOWLEDGE_ARTICLE = {
  url: "https://example.com/inbox-retries",
  title: "Inbox delivery",
  author: "Ada Lovelace",
  published: "2026-01-02",
  excerpt: "A provider failure spends no delivery attempt;",
};

export const MOCK_KNOWLEDGE_CONCEPT = {
  title: "Inbox delivery",
  aliases: ["wake queue"],
  explanation: "A saved note on how a durable inbox retries a wake.",
};

export const MOCK_KNOWLEDGE_FINDING = {
  statement: "A provider failure spends no delivery attempt: the wake is retried from the inbox.",
  path: "src/inbox.ts",
  startLine: 1,
  endLine: 2,
};

export const MOCK_KNOWLEDGE_RECORD_REPORT = "Recorded how the inbox retries, with its evidence.";

export const MOCK_KNOWLEDGE_REUSE_REPORT =
  "Read the inbox finding and its evidence before checking.";

/**
 * One crewmate saves an article as a concept and a sourced finding, then a
 * second save of the same link reuses the concept; a later crewmate finds the
 * concept by searching in other words, follows it to the finding, reads the excerpt and
 * declares its use.
 */
export const knowledgeRecord: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // The knowledge crewmates (knowledge.spec.ts): one saves an article
    // as a concept, cites it from a finding, and is refused a second
    // concept for the same link; a later one finds the concept by a
    // search in other words, follows it to the finding, reads the excerpt and
    // declares its use. Each step reads the ids the app answered with.
    if (!isFirstmate && body.includes(KNOWLEDGE_RECORD_PROMPT_MARKER) && wantsStream) {
      const concept = /Recorded concept (c-[a-z0-9]{6})/.exec(latestUserTail)?.[1];
      const article = {
        url: MOCK_KNOWLEDGE_ARTICLE.url,
        title: MOCK_KNOWLEDGE_ARTICLE.title,
        author: MOCK_KNOWLEDGE_ARTICLE.author,
        published: MOCK_KNOWLEDGE_ARTICLE.published,
        excerpt: MOCK_KNOWLEDGE_ARTICLE.excerpt,
      };
      if (!concept) {
        return {
          calls: [
            {
              name: "record_knowledge",
              args: {
                action: "publish",
                request_id: "inbox-concept",
                kind: "concept",
                title: MOCK_KNOWLEDGE_CONCEPT.title,
                aliases: MOCK_KNOWLEDGE_CONCEPT.aliases,
                text: MOCK_KNOWLEDGE_CONCEPT.explanation,
                sources: [article],
              },
            },
          ],
        };
      } else if (!/Recorded finding f-[a-z0-9]{6}/.test(latestUserTail)) {
        return {
          calls: [
            {
              name: "record_knowledge",
              args: {
                action: "publish",
                request_id: "inbox-finding",
                kind: "finding",
                text: MOCK_KNOWLEDGE_FINDING.statement,
                basis: "observation",
                about: [concept],
                conditions: "the saved article, as read",
                sources: [article],
              },
            },
          ],
        };
      } else if (!latestUserTail.includes("already saved")) {
        return {
          calls: [
            {
              name: "record_knowledge",
              args: {
                action: "publish",
                request_id: "inbox-again",
                kind: "concept",
                title: "Inbox delivery again",
                text: "A second copy of the same article.",
                sources: [article],
              },
            },
          ],
        };
      } else if (!calledTool(latestUserTail, "report")) {
        return { calls: [{ name: "report", args: { text: MOCK_KNOWLEDGE_RECORD_REPORT } }] };
      } else {
        return { text: MOCK_KNOWLEDGE_RECORD_REPORT };
      }
    }
    if (!isFirstmate && body.includes(KNOWLEDGE_REUSE_PROMPT_MARKER) && wantsStream) {
      const concept = /(c-[a-z0-9]{6}) concept \\?"Inbox delivery/.exec(body)?.[1];
      const finding = /finding about this: (f-[a-z0-9]{6})/.exec(latestUserTail)?.[1];
      if (!calledTool(latestUserTail, "knowledge")) {
        // Nothing saved is in the brief: the crewmate looks it up in its own words.
        return {
          calls: [{ name: "knowledge", args: { action: "search", query: "harbor wake queue" } }],
        };
      } else if (concept && toolCallCount(latestUserTail, "knowledge") === 1) {
        return { calls: [{ name: "knowledge", args: { action: "neighbors", id: concept } }] };
      } else if (finding && !latestUserTail.includes("statement:")) {
        return { calls: [{ name: "knowledge", args: { action: "get", ids: [finding] } }] };
      } else if (finding && !latestUserTail.includes(MOCK_KNOWLEDGE_ARTICLE.excerpt)) {
        const source = /s-[a-z0-9]{6}/.exec(latestUserTail)?.[0];
        if (!source) throw new Error("Knowledge finding read returned no source id.");
        return { calls: [{ name: "knowledge", args: { action: "get", ids: [source] } }] };
      } else if (finding && !calledTool(latestUserTail, "record_knowledge")) {
        return {
          calls: [
            {
              name: "record_knowledge",
              args: {
                action: "use",
                request_id: "inbox-use",
                id: finding,
                reason: "checked the wake queue against how the inbox retries",
              },
            },
          ],
        };
      } else if (!calledTool(latestUserTail, "report")) {
        return {
          calls: [
            {
              name: "report",
              args: {
                text: concept
                  ? MOCK_KNOWLEDGE_REUSE_REPORT
                  : "My search found no knowledge about the inbox.",
              },
            },
          ],
        };
      } else {
        return { text: MOCK_KNOWLEDGE_REUSE_REPORT };
      }
    }
    return undefined;
  };
