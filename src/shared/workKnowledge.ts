import { z } from "zod";

/**
 * The shapes a crewmate on a computer that runs work hands its home for the
 * home's knowledge (docs/knowledge.md, "The tools"), beside the work
 * requests that carry them (`work.ts`).
 */

/**
 * A read of the home's knowledge, as the `knowledge` tool hands it to the
 * host (`KnowledgeReadInput`, docs/knowledge.md "The tools"). The home's
 * `KnowledgeService` checks the rest, as it does for a crewmate of its own.
 */
export const knowledgeReadInputSchema = z.object({
  action: z.enum(["search", "get", "neighbors", "history"]),
  query: z.string().optional(),
  ids: z.array(z.string()).optional(),
  id: z.string().optional(),
  revision: z.number().int().min(1).optional(),
  scope: z.string().optional(),
  cursor: z.string().optional(),
});

/** One source a write cites, as the tool names it; the home keeps or refuses it. */
const knowledgeSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal("report"), task: z.string() }),
  z.object({ kind: z.literal("quote"), text: z.string(), citation: z.string() }),
  z.object({
    kind: z.literal("article"),
    url: z.string(),
    title: z.string(),
    excerpt: z.string(),
    author: z.string().optional(),
    published: z.string().optional(),
  }),
]);

/** A write to the home's knowledge, as the `record_knowledge` tool hands it to the host (`RecordInput`). */
export const recordKnowledgeInputSchema = z.object({
  action: z.enum(["publish", "revise", "assess", "relate", "retire", "retire_many", "use"]),
  requestId: z.string(),
  kind: z.enum(["concept", "finding", "direction"]).optional(),
  lane: z.enum(["personal", "reference"]).optional(),
  id: z.string().optional(),
  expectedRevision: z.number().int().min(1).optional(),
  revision: z.number().int().min(1).optional(),
  scope: z.string().optional(),
  title: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  links: z.array(z.object({ to: z.string(), reason: z.string() })).optional(),
  statement: z.string().optional(),
  basis: z.enum(["observation", "inference"]).optional(),
  about: z.array(z.string()).optional(),
  relationship: z.object({ from: z.string(), predicate: z.string(), to: z.string() }).optional(),
  conditions: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
  sources: z.array(knowledgeSourceInputSchema).optional(),
  verdict: z.enum(["supports", "contradicts", "inconclusive"]).optional(),
  method: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(["related", "contradicts", "supersedes", "duplicates"]).optional(),
  reason: z.string().optional(),
  purpose: z.string().optional(),
  task: z.string().optional(),
  ids: z.array(z.string()).optional(),
  except: z.array(z.string()).optional(),
});
