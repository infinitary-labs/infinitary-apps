import { z } from "zod";
import {
  knowledgeCollectionsSchema,
  knowledgeConceptsArgsSchema,
  knowledgeConceptsSchema,
  knowledgeDirectionArgsSchema,
  knowledgeDirectionChangedSchema,
  knowledgeDirectionChangeSchema,
  knowledgeDirectionReadSchema,
  knowledgeDirectionsArgsSchema,
  knowledgeDirectionsSchema,
  knowledgeEntryArgsSchema,
  knowledgeEntryReadSchema,
  knowledgeFindingsArgsSchema,
  knowledgeFindingsSchema,
  knowledgeGraphArgsSchema,
  knowledgeGraphSchema,
  knowledgeRefsArgsSchema,
  knowledgeRefsSchema,
  knowledgeUsesArgsSchema,
  knowledgeUsesSchema,
} from "../knowledge";
import type { ChannelDeclaration } from "./common";

/** Knowledge: its collections, graph, entries, directions and uses (docs/knowledge.md). */
export const knowledgeChannels = {
  // Knowledge (docs/knowledge.md, "The browser"): whether this build keeps
  // it and whether there is any to show (`held`: an entry, or a collection
  // that cannot be read), which the window asks before it registers the
  // Knowledge panel, and the browser's reads, scoped as Firstmate's are.
  // Every build answers them (`knowledgeEnabled`,
  // src/core/knowledge/availability.ts). This Mac's own window only: a view
  // of another Mac reads none.
  "inf:knowledge:enabled": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ enabled: z.boolean(), held: z.boolean() }),
  },
  "inf:knowledge:collections": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: knowledgeCollectionsSchema,
  },
  "inf:knowledge:graph": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeGraphArgsSchema]),
    response: knowledgeGraphSchema,
  },
  "inf:knowledge:concepts": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeConceptsArgsSchema]),
    response: knowledgeConceptsSchema,
  },
  "inf:knowledge:findings": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeFindingsArgsSchema]),
    response: knowledgeFindingsSchema,
  },
  "inf:knowledge:entry": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeEntryArgsSchema]),
    response: knowledgeEntryReadSchema,
  },
  // With no arguments, every scope's first page: the catalog's `direction`
  // line reads its current value so.
  "inf:knowledge:directions": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionsArgsSchema.optional()]),
    response: knowledgeDirectionsSchema,
  },
  "inf:knowledge:direction": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionArgsSchema]),
    response: knowledgeDirectionReadSchema,
  },
  // One change to a standing direction, the app action catalog's
  // `direction` line (src/shared/actions.ts): the captain's window and the
  // first mate's app_change ask it alike (docs/knowledge.md, "Directions are
  // the first mate's to keep").
  "inf:knowledge:direction:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionChangeSchema]),
    response: knowledgeDirectionChangedSchema,
  },

  // The entries a card body names, for its references, and what one task's
  // work declared it used, for its record (docs/knowledge.md, "References in
  // an answer" and "Knowledge used on a task"): scoped and refused as the
  // browser's reads are.
  "inf:knowledge:refs": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeRefsArgsSchema]),
    response: knowledgeRefsSchema,
  },
  "inf:knowledge:uses": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeUsesArgsSchema]),
    response: knowledgeUsesSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
