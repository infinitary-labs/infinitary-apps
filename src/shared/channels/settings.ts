import { z } from "zod";
import { appCostLimitViewSchema, costLimitSchema } from "../costLimit";
import { dictationSettingsSchema } from "../dictation";
import {
  appearanceSchema,
  layoutMoveSchema,
  layoutSchema,
  personalPanelsSchema,
  shellPreferencesSchema,
} from "../preferences";
import { runbookViewSchema } from "../runbooks";
import {
  phoneDiagnosticSchema,
  sharingAskAnswerSchema,
  sharingChannelSchema,
  sharingPreviewSchema,
  sharingViewSchema,
} from "../sharing";
import { projectViewSchema } from "../tasks";
import type { ChannelDeclaration } from "./common";

/** Projects and the window's settings: look, layout, panels, sharing, dictation, runbooks and notifications. */
export const settingsChannels = {
  "inf:projects:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(projectViewSchema),
  },
  // A project of several repositories takes a name of its own (INF-4220,
  // `project-repositories-settings.md`); a project of one is named with its
  // repository through `inf:repos:configure`.
  "inf:projects:rename": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1), z.string().trim().min(1)]),
    response: z.object({ id: z.string(), name: z.string(), was: z.string() }),
  },
  // The captain's presentation choices, held by the core so a fresh window
  // profile cannot forget them (src/shared/preferences.ts).
  "inf:settings:appearance:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: appearanceSchema,
  },
  "inf:settings:appearance:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([appearanceSchema]),
    response: appearanceSchema,
  },
  "inf:settings:layout:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: layoutSchema,
  },
  "inf:settings:layout:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([layoutSchema, layoutMoveSchema.optional()]),
    response: layoutSchema,
  },
  // The host-owned switch over the captain's own panels (talk-to-personalize
  // Step 5). Only the window writes it, and only `enabled`: the reason is
  // the core's - `captain` here, `safe-mode` when a boot decides it.
  "inf:settings:panels:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.boolean()]),
    response: personalPanelsSchema,
  },
  // Every preference as ONE value, the `shell.preferences` read
  // (talk-to-personalize Step 1): what the host applies to the window on
  // the captain's behalf, pushed whole on every write, whoever wrote it.
  "inf:shell:preferences": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: shellPreferencesSchema,
  },
  // The two switches (roadmap 1.4, `src/shared/sharing.ts`): what may leave
  // this machine for us. The window sets a switch, says the payload was
  // viewed, reads the payload, and answers the one-time ask; every write
  // pushes the whole view as `inf:sharing`.
  "inf:settings:sharing:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([sharingChannelSchema, z.boolean()]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:viewed": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([sharingChannelSchema]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:preview": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: sharingPreviewSchema,
  },
  "inf:settings:sharing:ask": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([sharingAskAnswerSchema]),
    response: sharingViewSchema,
  },
  // A paired phone hands one of its usage events to its computer, which
  // sends it only while its own Diagnostics would (docs/sharing.md, "A
  // phone's events"). The answer says nothing of the switch.
  "inf:settings:sharing:phone": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([phoneDiagnosticSchema]),
    response: z.null(),
  },
  "inf:settings:dictation:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: dictationSettingsSchema,
  },
  "inf:settings:dictation:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([dictationSettingsSchema]),
    response: dictationSettingsSchema,
  },
  "inf:settings:runbooks:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:runbooks:copy": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.string(), z.string().min(1)]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:runbooks:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean()]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:personal-resources:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.boolean(),
  },
  "inf:settings:personal-resources:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.boolean()]),
    response: z.boolean(),
  },
  // The app's own cost limit for each task, and how many recent tasks it would have asked about (docs/usage.md, "The cost limit").
  "inf:settings:cost-limit:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: appCostLimitViewSchema,
  },
  "inf:settings:cost-limit:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([costLimitSchema]),
    response: appCostLimitViewSchema,
  },
  // A view of this Mac follows the switch for its own notifications (docs/view.md).
  "inf:settings:notifications:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.boolean(),
  },
  "inf:settings:notifications:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.boolean()]),
    response: z.boolean(),
  },
} as const satisfies Record<string, ChannelDeclaration>;
