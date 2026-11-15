import { z } from "zod";
import { privateSiteSchema } from "./privateSites";
import {
  heldSignInSchema,
  taskBrowserCommandResultSchema,
  taskBrowserFactSchema,
  taskBrowserHandleSchema,
  taskBrowserInputSchema,
  taskBrowserRequestSchema,
  taskBrowserSizeSchema,
} from "./taskBrowser";
import { placedTaskIdSchema } from "./workIdentity";

const doneSchema = z.object({ ok: z.literal(true) });

/** One order about a task's browser on that computer: the task it names. */
function aboutBrowser<T extends z.ZodRawShape>(shape: T) {
  return z.tuple([z.object({ task: placedTaskIdSchema, ...shape })]);
}

/**
 * The orders a home asks a computer that runs work about its tasks'
 * browsers (docs/task-browser.md, "On another computer"), from
 * `TASK_BROWSERS_THERE_SINCE` on: the captain's side of a browser that runs
 * there - his view's pictures and room, his Take control, input and Return
 * control, Stop browser and Open again, a crewmate's request card, a saved
 * sign-in he lets it use or removes, and the task's close. Each answers
 * live and none is kept: a browser is gone once that computer quits, and an
 * answer may hold a sign-in, which nothing writes down there.
 */
export const browserOrders = {
  /** Every browser fact it keeps, by task: asked each time it comes into reach. */
  "inf:task-browser:facts": {
    effect: "read",
    request: z.tuple([]),
    response: z.object({
      facts: z.array(z.object({ task: placedTaskIdSchema, fact: taskBrowserFactSchema })),
    }),
  },
  /** Whether the captain watches the task's browser now: pictures come while he does. */
  "inf:task-browser:watch": {
    effect: "change",
    request: aboutBrowser({ watching: z.boolean() }),
    response: doneSchema,
  },
  /** The room his maximized view gives the page, or null for its own size. */
  "inf:task-browser:size": {
    effect: "change",
    request: aboutBrowser({ size: taskBrowserSizeSchema.nullable() }),
    response: doneSchema,
  },
  "inf:task-browser:input": {
    effect: "change",
    request: aboutBrowser({ input: taskBrowserInputSchema }),
    response: taskBrowserCommandResultSchema,
  },
  "inf:task-browser:take": {
    effect: "change",
    request: aboutBrowser({ handle: taskBrowserHandleSchema.optional() }),
    response: taskBrowserCommandResultSchema,
  },
  /**
   * His Return control. With `remember`, the tick that saves the site's
   * sign-in on the home: the answer carries what the browser holds of it,
   * which the home saves under that id.
   */
  "inf:task-browser:return": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      remember: z
        .object({
          id: z.string().min(1).max(128),
          site: z.string().optional(),
          refresh: z.boolean().optional(),
        })
        .optional(),
    }),
    response: z.union([
      z.object({
        ok: z.literal(true),
        remembered: z.object({ site: z.string(), held: heldSignInSchema }).optional(),
        warning: z.string().optional(),
      }),
      z.object({ ok: z.literal(false), text: z.string() }),
    ]),
  },
  "inf:task-browser:stop": {
    effect: "change",
    request: aboutBrowser({}),
    response: taskBrowserCommandResultSchema,
  },
  "inf:task-browser:reopen": {
    effect: "change",
    request: aboutBrowser({}),
    response: taskBrowserCommandResultSchema,
  },
  /** A crewmate's card asks the captain to take over: the browser pauses before the card goes up. */
  "inf:task-browser:request": {
    effect: "change",
    request: aboutBrowser({ request: taskBrowserRequestSchema.extend({ site: z.string() }) }),
    response: z.union([
      z.object({ ok: z.literal(true), handle: taskBrowserHandleSchema }),
      z.object({ ok: z.literal(false), text: z.string() }),
    ]),
  },
  /**
   * The captain's click on a request card's saved sign-in: the save the home
   * lends that browser, which holds it in memory only and copies back into
   * it, by its id, as it stops.
   */
  "inf:task-browser:grant": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      signIn: heldSignInSchema.extend({
        site: z.string().min(1),
        id: z.string().min(1).max(128),
        savedAt: z.number(),
      }),
    }),
    response: taskBrowserCommandResultSchema,
  },
  /** The captain removed a site's saved sign-in: every browser there using it signs out of it. */
  "inf:task-browser:sign-out": {
    effect: "change",
    request: z.tuple([z.object({ site: z.string().min(1) })]),
    response: doneSchema,
  },
  /** The captain changed the private sites list: every browser there checks names against it at once. */
  "inf:task-browser:private-sites": {
    effect: "change",
    request: z.tuple([z.strictObject({ sites: z.array(privateSiteSchema) })]),
    response: doneSchema,
  },
  /** The task closed: its browser there goes, and its command answers nothing more. */
  "inf:task-browser:close": {
    effect: "change",
    request: aboutBrowser({}),
    response: doneSchema,
  },
} as const satisfies Record<
  `inf:task-browser:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type BrowserOrderChannel = keyof typeof browserOrders;
export type BrowserOrderRequest<C extends BrowserOrderChannel> = z.infer<
  (typeof browserOrders)[C]["request"]
>;
export type BrowserOrderResponse<C extends BrowserOrderChannel> = z.infer<
  (typeof browserOrders)[C]["response"]
>;
export const BROWSER_ORDER_CHANNELS = Object.keys(browserOrders) as BrowserOrderChannel[];

export function isBrowserOrderChannel(channel: string): channel is BrowserOrderChannel {
  return Object.hasOwn(browserOrders, channel);
}
