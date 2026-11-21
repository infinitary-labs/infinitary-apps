import { z } from "zod";
import { privateSiteSchema } from "./privateSites";
import {
  heldSignInSchema,
  savedSignInSchema,
  TASK_BROWSER_ASK_ANSWERS,
  taskBrowserCommandResultSchema,
  taskBrowserFactSchema,
  taskBrowserHandleSchema,
  taskBrowserInputSchema,
  taskBrowserPlacesSchema,
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
 * control, Stop browser and Open again, a crewmate's request card, a
 * signed-in site he lets it use, its rule or its removal, and the task's
 * close. Each answers live and none is kept: a browser is gone once that
 * computer quits. From `kept-sign-ins` on, that computer keeps its own
 * signed-in sites in its own kept profile, and nothing of a sign-in
 * crosses between computers.
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
  /**
   * The captain's input and Take control. With `here` (`browser-asks`), whether
   * the window the captain used is on that computer, where only Chrome can show
   * a passkey's prompt (docs/task-browser.md, "A site's asks").
   */
  "inf:task-browser:input": {
    effect: "change",
    request: aboutBrowser({ input: taskBrowserInputSchema, here: z.boolean().optional() }),
    response: taskBrowserCommandResultSchema,
  },
  /**
   * What the outline of the task's page names on screen now (`card-note-places`), for the
   * captain's Point at (docs/task-browser.md, "Pointing at a page"). Nothing is recorded.
   */
  "inf:task-browser:places": {
    effect: "read",
    request: aboutBrowser({}),
    response: taskBrowserPlacesSchema,
  },
  "inf:task-browser:take": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema.optional(),
      here: z.boolean().optional(),
    }),
    response: taskBrowserCommandResultSchema,
  },
  /** The captain's answer to what a page there asks (`browser-asks`): Allow once (Use passkey), Not now, or Show Chrome window. */
  "inf:task-browser:ask": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      id: z.number().int().positive(),
      answer: z.enum(TASK_BROWSER_ASK_ANSWERS),
      here: z.boolean(),
    }),
    response: taskBrowserCommandResultSchema,
  },
  /**
   * His Return control. With `rule` (`kept-sign-ins`), his rule for the
   * site he signed in to in that computer's kept profile, which it keeps
   * there. `remember` was the retired copies' tick: a computer with
   * `kept-sign-ins` takes none.
   */
  "inf:task-browser:return": {
    effect: "change",
    request: aboutBrowser({
      handle: taskBrowserHandleSchema,
      rule: z.object({ site: z.string(), automatic: z.boolean() }).optional(),
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
  /**
   * A turn of the task's crewmate began or ended at the home (`page-start`):
   * a build Infinitary started there lives through the turn, and stops at its
   * end if the browser is still stopped.
   */
  "inf:task-browser:turn": {
    effect: "change",
    request: aboutBrowser({ running: z.boolean() }),
    response: doneSchema,
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
   * The retired lending of a saved sign-in's copy: a computer with
   * `kept-sign-ins` refuses it in words, and uses `use-sign-in` instead.
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
  /** The retired sign-out of a lent copy: a computer with `kept-sign-ins` does nothing. */
  "inf:task-browser:sign-out": {
    effect: "change",
    request: z.tuple([z.object({ site: z.string().min(1) })]),
    response: doneSchema,
  },
  /**
   * The captain's click on a request card's signed-in site
   * (`kept-sign-ins`): the browser opens its page in that computer's kept
   * profile, signed in, and goes back to its crewmate.
   */
  "inf:task-browser:use-sign-in": {
    effect: "change",
    request: aboutBrowser({ handle: taskBrowserHandleSchema }),
    response: taskBrowserCommandResultSchema,
  },
  /** The crewmate said the signed-in site it was given did not sign its page in (`kept-sign-ins`). */
  "inf:task-browser:sign-in-failed": {
    effect: "change",
    request: aboutBrowser({ site: z.string().min(1) }),
    response: z.object({ ok: z.boolean() }),
  },
  /** The signed-in sites that computer keeps, for Settings (`kept-sign-ins`). */
  "inf:task-browser:sign-ins": {
    effect: "read",
    request: z.tuple([]),
    response: z.object({ signIns: z.array(savedSignInSchema) }),
  },
  /** The captain's rule for a site there, bound to the entry Settings showed (`kept-sign-ins`). */
  "inf:task-browser:sign-in-rule": {
    effect: "change",
    request: z.tuple([
      z.object({ site: z.string().min(1), id: z.string().min(1), automatic: z.boolean() }),
    ]),
    response: taskBrowserCommandResultSchema,
  },
  /** The captain's Remove in Settings: that computer's kept profile signs the site out (`kept-sign-ins`). */
  "inf:task-browser:sign-in-remove": {
    effect: "change",
    request: z.tuple([z.object({ site: z.string().min(1) })]),
    response: taskBrowserCommandResultSchema,
  },
  /** The captain's Remove all in Settings: that computer's kept profile signs out of every site (`kept-sign-ins`). */
  "inf:task-browser:sign-in-remove-all": {
    effect: "change",
    request: z.tuple([]),
    response: taskBrowserCommandResultSchema,
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
