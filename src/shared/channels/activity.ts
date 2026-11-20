import { z } from "zod";
import {
  automationListSchema,
  automationNotesSchema,
  automationPreviewSchema,
  automationRuleSchema,
  automationRunSchema,
  automationSaveSchema,
  automationSpecSchema,
} from "../automation";
import { keptJobsViewSchema, keptJobViewSchema, keptRemoveResultSchema } from "../keptJobs";
import {
  observeLiveSchema,
  observeSessionDetailSchema,
  observeSessionSummarySchema,
} from "../observe";
import {
  usageQuerySchema,
  usageSummarySchema,
  usageTasksQuerySchema,
  usageTasksSchema,
} from "../usage";
import type { ChannelDeclaration } from "./common";

/** Observe, Automation and usage. */
export const activityChannels = {
  "inf:observe:enabled": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ enabled: z.boolean() }),
  },
  "inf:observe:sessions": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(observeSessionSummarySchema),
  },
  "inf:observe:detail": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: observeSessionDetailSchema,
  },
  "inf:observe:live": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: observeLiveSchema,
  },
  // Settings → Automation (docs/automation.md): the schedules as rules.
  // They run only where Firstmate lives; a Mac that controls it reads and
  // changes the same rules, so each reaches views.
  "inf:automation:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: automationListSchema,
  },
  "inf:automation:history": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: z.array(automationRunSchema),
  },
  // The next dates a schedule would run; it sends nothing and changes nothing.
  "inf:automation:preview": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([automationSpecSchema]),
    response: automationPreviewSchema,
  },
  "inf:automation:save": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([automationSaveSchema]),
    response: automationRuleSchema,
  },
  "inf:automation:state": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), z.enum(["pause", "resume"])]),
    response: automationRuleSchema,
  },
  // A rule's notes: the newest version (`current`) or every version
  // (`all`), newest first, and the captain's edit or clear, answering the
  // version it saved (docs/automation.md, "A rule's notes"). Saving makes
  // no new revision of the rule.
  "inf:automation:notes": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), z.enum(["current", "all"])]),
    response: z.array(automationNotesSchema),
  },
  "inf:automation:notes-save": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), z.string()]),
    response: automationNotesSchema.nullable(),
  },
  "inf:automation:pause-all": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({ paused: z.number().int() }),
  },
  "inf:automation:delete": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: z.object({ id: z.string() }),
  },
  // Kept running (docs/leftover-programs.md, "Kept running"): the jobs the
  // captain asked to keep past their task's close, recorded at the home,
  // and one's own check or remove, run on the computer it runs on.
  "inf:automation:kept": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: keptJobsViewSchema,
  },
  "inf:automation:kept-check": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(256)]),
    response: keptJobViewSchema,
  },
  "inf:automation:kept-remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(256)]),
    response: keptRemoveResultSchema,
  },
  "inf:automation:kept-forget": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(256)]),
    response: z.object({ id: z.string() }),
  },
  // Settings → Usage (docs/usage.md): the usage ledger over a period and a
  // kind of work, in tokens and in estimated dollars at once. This Mac's
  // own: a Mac that controls it has no Usage tab.
  "inf:usage:summary": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([usageQuerySchema]),
    response: usageSummarySchema,
  },
  // Usage's recent tasks: the newest tasks with recorded usage in a period
  // and kind of work, as many as asked, and how many there are.
  "inf:usage:tasks": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([usageTasksQuerySchema]),
    response: usageTasksSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
