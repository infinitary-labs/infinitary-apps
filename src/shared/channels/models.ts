import { z } from "zod";
import { crewSpeedSchema } from "../crewSpeed";
import { localOrchestratorSettingSchema, localOrchestratorViewSchema } from "../localOrchestrator";
import { modelSlotsViewSchema, reasoningChoiceSchema, slotSchema } from "../modelSlots";
import {
  modelsCatalogViewSchema,
  piModelRefViewSchema,
  quotaSnapshotViewSchema,
  routingSettingsSchema,
} from "../quota";
import type { ChannelDeclaration } from "./common";

/** The first mate's account and model, quota, routing and the models crewmates use. */
export const modelChannels = {
  "inf:settings:firstmate-account:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.string().nullable(),
  },
  "inf:settings:firstmate-account:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().nullable()]),
    response: z.string().nullable(),
  },
  "inf:quota:snapshot": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: quotaSnapshotViewSchema.nullable(),
  },
  "inf:quota:refresh": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: quotaSnapshotViewSchema.nullable(),
  },
  // An older window opened Subscriptions. No allowance is read only on that
  // press any more, so the home answers its snapshot; the request stays in
  // the contract until a major that breaks views removes it.
  "inf:quota:opened": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: quotaSnapshotViewSchema.nullable(),
  },
  "inf:quota:models": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: modelsCatalogViewSchema.nullable(),
  },
  "inf:settings:routing:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: routingSettingsSchema,
  },
  "inf:settings:routing:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([routingSettingsSchema]),
    response: routingSettingsSchema,
  },
  "inf:settings:firstmate-model:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: piModelRefViewSchema.nullable(),
  },
  "inf:settings:firstmate-model:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([piModelRefViewSchema.nullable()]),
    response: piModelRefViewSchema.nullable(),
  },
  // The dev-only local seat (roadmap 1.7): a packaged build answers
  // `available: false` and refuses the write; docs/local-orchestrator.md.
  "inf:settings:local-orchestrator:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: localOrchestratorViewSchema,
  },
  "inf:settings:local-orchestrator:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([localOrchestratorSettingSchema]),
    response: localOrchestratorViewSchema,
  },
  "inf:models:available": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(piModelRefViewSchema),
  },
  "inf:models:slots": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: modelSlotsViewSchema,
  },
  "inf:models:slots:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    /** key, slot, on - adds or removes one slot from an offering's membership. */
    request: z.tuple([z.string(), slotSchema, z.boolean()]),
    response: modelSlotsViewSchema,
  },
  "inf:models:speed:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), crewSpeedSchema]),
    response: modelSlotsViewSchema,
  },
  "inf:models:reasoning:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), slotSchema, reasoningChoiceSchema.nullable()]),
    response: modelSlotsViewSchema,
  },
  "inf:models:slots:reset": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.union([z.tuple([]), z.tuple([z.string()])]),
    response: modelSlotsViewSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
