import { z } from "zod";
import {
  crewLiveSchema,
  crewPictureSchema,
  crewResultTextSchema,
  crewTranscriptSchema,
} from "../crewTranscript";
import { crewCountsSchema } from "../events";
import { feedLineSchema } from "../feed";
import {
  privateSiteChangeSchema,
  privateSiteSchema,
  privateSitesViewSchema,
} from "../privateSites";
import {
  savedSignInsViewSchema,
  taskBrowserCommandResultSchema,
  taskBrowserHandleSchema,
  taskBrowserInputSchema,
  taskBrowserReturnSchema,
  taskBrowserSizeSchema,
} from "../taskBrowser";
import { taskBoardSchema, taskDetailSchema, taskViewSchema } from "../tasks";
import { type ChannelDeclaration, okSchema } from "./common";

/** The feed, the crew's counts, the task board and records, and a task's browser. */
export const taskChannels = {
  "inf:feed:recent": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(feedLineSchema),
  },
  "inf:crew:counts": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: crewCountsSchema,
  },
  // The task protocol (task-system P3, design section 9): the board a
  // late-attaching client resyncs from (live pushes ride inf:tasks), one
  // record in full, and the project index. Reads, plus opening a filing,
  // which clears its new mark. The record's lifecycle toggles ride
  // `inf:task:run`; every other write to a task happens by talking to the
  // Firstmate.
  "inf:tasks:board": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: taskBoardSchema,
  },
  "inf:tasks:detail": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskDetailSchema,
  },
  // The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate
  // tab"): the crewmate's sessions read as a transcript, its running turn's
  // words that its session does not hold yet, and one call's whole result
  // or one picture it holds, read when the tab opens or shows it.
  "inf:tasks:crewmate": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewTranscriptSchema,
  },
  "inf:tasks:crewmate:live": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewLiveSchema,
  },
  "inf:tasks:crewmate:result": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(512)]),
    response: crewResultTextSchema.nullable(),
  },
  "inf:tasks:crewmate:picture": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(512)]),
    response: crewPictureSchema.nullable(),
  },
  // Closed work the board no longer lists, found by typed text (FI3-579
  // piece 3): the Tasks filter's "earlier" group. Empty text finds nothing.
  "inf:tasks:search": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(200)]),
    response: z.array(taskViewSchema),
  },
  // Opening a filing clears its new mark (quiet ledger). Not a verdict.
  "inf:tasks:opened": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ opened: z.boolean() }),
  },
  // The captain's view watches a task's browser (docs/task-browser.md, "The
  // view"): pictures of its page go to whoever asked - a window, or a
  // computer that controls the first mate over the connection - on
  // `inf:browser:frame`, until it unwatches, its window reloads or closes, or
  // its connection goes. False when there is no browser to watch.
  "inf:browser:watch": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ watching: z.boolean() }),
  },
  "inf:browser:unwatch": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // The room the asker's maximized view gives the task's page, or none once
  // it is restored (docs/task-browser.md, "The view"): the page lays out at
  // it while that asker watches. Asked of a watch the asker holds.
  "inf:browser:size": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), taskBrowserSizeSchema.nullable()]),
    response: okSchema,
  },
  // The captain's own input to a task's page while he has control
  // (docs/task-browser.md, "Taking control"): the pointer and keys of the
  // window he sits at, on whichever computer; the core refuses it unless he
  // holds the browser, and nothing records it.
  "inf:browser:input": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), taskBrowserInputSchema]),
    response: taskBrowserCommandResultSchema,
  },
  // A task's own browser, from the captain's view of it (docs/task-browser.md,
  // "The view"): Stop browser, and Open again on a stopped one, from any
  // view; refused in words when it cannot.
  "inf:browser:stop": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:reopen": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskBrowserCommandResultSchema,
  },
  // The captain's Take control and Return control (docs/task-browser.md,
  // "Taking control"), naming the browser his view shows, from any view.
  "inf:browser:take": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), taskBrowserHandleSchema]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:return": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(64),
      taskBrowserHandleSchema,
      taskBrowserReturnSchema.optional(),
    ]),
    response: taskBrowserCommandResultSchema,
  },
  // The website sign-ins saved on this Mac for task browsers, and the
  // captain's Remove in Settings (docs/task-browser.md, "Saved sign-ins").
  // They are this Mac's own, so no paired device asks.
  "inf:browser:sign-ins": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: savedSignInsViewSchema,
  },
  "inf:browser:sign-ins:automatic": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(260), z.string().min(1), z.boolean()]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:sign-ins:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(260)]),
    response: taskBrowserCommandResultSchema,
  },
  // The captain's private sites list for task browsers on every computer
  // (docs/task-browser.md, "Private sites"): kept at the home, so a
  // computer that only runs work never holds it.
  "inf:browser:private-sites": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: privateSitesViewSchema,
  },
  "inf:browser:private-sites:add": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(2_048)]),
    response: privateSiteChangeSchema,
  },
  "inf:browser:private-sites:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([privateSiteSchema]),
    response: privateSiteChangeSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
