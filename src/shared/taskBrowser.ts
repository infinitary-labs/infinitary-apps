import { z } from "zod";
import { CONNECTION_MAX_FRAME_BYTES } from "./connection";
import { HERE } from "./deviceNames";

/**
 * The page's own size: every check's, and every view's while no maximized
 * view asks for its room (docs/task-browser.md, "The view").
 */
export const TASK_BROWSER_PAGE = { width: 1280, height: 800 } as const;

/** The smallest and largest size a maximized view may give the page. */
export const TASK_BROWSER_PAGE_MIN = { width: 320, height: 240 } as const;
export const TASK_BROWSER_PAGE_MAX = { width: 3840, height: 2400 } as const;

/**
 * The room the captain's maximized view gives the page, in the page's own
 * pixels: the page lays out at it while he watches maximized.
 */
export const taskBrowserSizeSchema = z.object({
  width: z.number().int().min(TASK_BROWSER_PAGE_MIN.width).max(TASK_BROWSER_PAGE_MAX.width),
  height: z.number().int().min(TASK_BROWSER_PAGE_MIN.height).max(TASK_BROWSER_PAGE_MAX.height),
});
export type TaskBrowserSize = z.infer<typeof taskBrowserSizeSchema>;

/**
 * Pages one task browser holds at once (docs/task-browser.md, "A second
 * page"): its own, and one a page opened - a sign-in or a bank's check.
 */
export const TASK_BROWSER_PAGES_MAX = 2;

/** What stopped a task's browser, as the captain reads it (docs/task-browser.md, "The view"). */
export const TASK_BROWSER_STOPS = ["captain", "crewmate", "idle", "gone", "task-closed"] as const;
export type TaskBrowserStop = (typeof TASK_BROWSER_STOPS)[number];

/**
 * One task's browser as the captain reads it: open, with the site it shows
 * and what its crewmate did last, or stopped, with why and the page it was
 * on. Absent while the task never had one on this Mac.
 */
/**
 * Which browser a fact is about, as a card's attachment names it
 * (`LiveAttachment` in `./cards`): the run of this Mac's task browsers it
 * was open in, a new one each time the app starts, and which of the task's
 * browsers in that run it was. Optional on the wire, so a view on a newer
 * build still reads a home that sends neither.
 */
const browserIdentity = {
  session: z.string().optional(),
  generation: z.number().int().positive().optional(),
};

/**
 * Who holds an open browser besides its crewmate (docs/task-browser.md,
 * "Taking control"): `waiting` while the crewmate's request for the
 * captain's help stands, `taking` while the captain's Take control lets the
 * crewmate's current command finish, `captain` while the captain drives.
 * Absent, the browser is its crewmate's.
 */
export const TASK_BROWSER_CONTROLS = ["waiting", "taking", "captain"] as const;
export type TaskBrowserControl = (typeof TASK_BROWSER_CONTROLS)[number];

/**
 * How a crewmate speaks of a payment or submission the site never confirmed
 * (docs/task-browser.md, "A final submission"): it stays unknown until the
 * seller or its payment service shows what happened, and the crewmate never
 * guesses either way. The handoff's description and every browser wake that
 * meets an unknown outcome carry these same words.
 */
export const UNKNOWN_OUTCOME_WORDS =
  "Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again.";

/**
 * The longest clipboard text a paste on the view carries, in UTF-16 units:
 * at most six bytes each in a request, so a paste fits one connection frame
 * to a computer that runs work. A longer paste carries none, and the page
 * pastes from its own computer's clipboard.
 */
export const TASK_BROWSER_PASTE_MAX = Math.floor(CONNECTION_MAX_FRAME_BYTES / 8);

/** The longest reason, and next step, a crewmate's request for help carries. */
export const TASK_BROWSER_REQUEST_MAX = 200;
/** A request card's door to its browser when its crewmate names none. */
export const BROWSER_DOOR_LABEL = "Open browser";

/**
 * A crewmate's request for the captain to take over its browser, as it
 * declared it on its card (docs/task-browser.md, "Asking for help"): why it
 * needs the captain, and what it will do once control comes back. The host
 * reads neither; it shows them.
 */
export const taskBrowserRequestSchema = z.object({
  reason: z.string().min(1).max(TASK_BROWSER_REQUEST_MAX),
  after: z.string().min(1).max(TASK_BROWSER_REQUEST_MAX),
});
export type TaskBrowserRequest = z.infer<typeof taskBrowserRequestSchema>;

/** The most saved sign-ins one browser uses at once: one per site it was granted or saved. */
export const SAVED_SIGN_INS_PER_BROWSER = 8;

/** One page of an open browser, as the page selector names it: its own site and title. */
export const taskBrowserPageSchema = z.object({ site: z.string(), title: z.string() });
export type TaskBrowserPage = z.infer<typeof taskBrowserPageSchema>;

export const taskBrowserFactSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("open"),
    /** The current page's host and port, as the address names them (`localhost:5173`). */
    site: z.string(),
    url: z.string(),
    title: z.string(),
    /**
     * Every page, in the order they opened, while it holds more than one
     * (a page opened a second); absent with one. `page` is the current
     * one's place, from 1, whose site, address and title the fact names.
     */
    pages: z.array(taskBrowserPageSchema).max(TASK_BROWSER_PAGES_MAX).optional(),
    page: z.number().int().min(1).max(TASK_BROWSER_PAGES_MAX).optional(),
    /** What the crewmate did last, in a few words; never what it typed. */
    did: z.string().optional(),
    /** Who holds it besides the crewmate; absent while it is the crewmate's. */
    control: z.enum(TASK_BROWSER_CONTROLS).optional(),
    /** The crewmate's request for help, while it stands. */
    request: taskBrowserRequestSchema.optional(),
    /** The captain has handed it back: it may hold what he signed in to, until it stops. */
    returned: z.literal(true).optional(),
    /**
     * Started by the captain's own click on a page from the task's project
     * (docs/task-browser.md, "A page from the project"): his alone, so the
     * view closes it rather than handing it to a crewmate.
     */
    own: z.literal(true).optional(),
    /**
     * The sites whose saved sign-in this browser uses (docs/task-browser.md,
     * "Saved sign-ins"): one the captain let it use on its request card, or
     * one saved as the captain handed it back. Absent while it uses none.
     */
    saved: z.array(z.string()).min(1).max(SAVED_SIGN_INS_PER_BROWSER).optional(),
    ...browserIdentity,
  }),
  z.object({
    state: z.literal("stopped"),
    site: z.string(),
    /** The page it was on: Open again starts there. */
    url: z.string(),
    stopped: z.enum(TASK_BROWSER_STOPS),
    at: z.number(),
    ...browserIdentity,
  }),
]);
export type TaskBrowserFact = z.infer<typeof taskBrowserFactSchema>;

/** One picture of a task's page while the captain watches it: a JPEG, base64. */
export const taskBrowserFrameSchema = z.object({
  taskId: z.string().min(1).max(64),
  data: z.string().max(8_000_000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TaskBrowserFrame = z.infer<typeof taskBrowserFrameSchema>;

/**
 * The captain's own input to a task's page while he has control
 * (docs/task-browser.md, "Taking control"): a pointer at a point of the
 * page, a wheel, a key - the window's editing keys as their commands, paste
 * with the words on the captain's own clipboard - Back, Forward and
 * Reload, or a page of the selector. Points are the page's own pixels, at
 * whatever size it has now. Nothing records any of it.
 */
const pagePoint = {
  x: z.number().min(0).max(TASK_BROWSER_PAGE_MAX.width),
  y: z.number().min(0).max(TASK_BROWSER_PAGE_MAX.height),
};
/** Alt 1, Control 2, Meta 4, Shift 8: the browser protocol's own bits. */
const modifiers = z.number().int().min(0).max(15);
export const taskBrowserInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pointer"),
    type: z.enum(["move", "down", "up"]),
    ...pagePoint,
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers,
  }),
  z.object({
    kind: z.literal("wheel"),
    ...pagePoint,
    deltaX: z.number().min(-10_000).max(10_000),
    deltaY: z.number().min(-10_000).max(10_000),
    modifiers,
  }),
  z.object({
    kind: z.literal("key"),
    type: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255),
    /** What the key types, for a key that types. */
    text: z.string().max(4).optional(),
    modifiers,
    /** An editing command the key stands for in the window's own key system: select all, undo, paste. */
    command: z.enum(["selectAll", "undo", "redo", "cut", "copy", "paste"]).optional(),
    /**
     * With paste, the words on the clipboard of the computer whose window
     * the captain pressed it in, which need not be the page's own. Without
     * it, the page pastes from its own computer's clipboard.
     */
    clipboard: z.string().max(TASK_BROWSER_PASTE_MAX).optional(),
  }),
  z.object({ kind: z.literal("go"), go: z.enum(["back", "forward", "reload"]) }),
  /** The captain's pick in the page selector: the page his input and the crewmate's next look go to. */
  z.object({ kind: z.literal("page"), page: z.number().int().min(1).max(TASK_BROWSER_PAGES_MAX) }),
]);
export type TaskBrowserInput = z.infer<typeof taskBrowserInputSchema>;

/** Which browser the captain's Take control or Return control is about: the one his view shows. */
export const taskBrowserHandleSchema = z.object({
  session: z.string().min(1).max(64),
  generation: z.number().int().positive(),
});
export type TaskBrowserHandle = z.infer<typeof taskBrowserHandleSchema>;

/** What the captain's Stop browser or Open again answers: done, or why not in words. */
export const taskBrowserCommandResultSchema = z.union([
  z.object({ ok: z.literal(true), warning: z.string().optional() }),
  z.object({ ok: z.literal(false), text: z.string() }),
]);
export type TaskBrowserCommandResult = z.infer<typeof taskBrowserCommandResultSchema>;

/**
 * How the captain hands a browser back (docs/task-browser.md, "Saved
 * sign-ins"): `remember` saves an unsaved site; `savedId` refreshes the save shown
 * to the captain. `site` binds either choice to the displayed site.
 */
export const taskBrowserReturnSchema = z.object({
  remember: z.boolean().optional(),
  site: z.string().optional(),
  savedId: z.string().optional(),
});
export type TaskBrowserReturn = z.infer<typeof taskBrowserReturnSchema>;

/** One website sign-in saved on this Mac, as Settings lists it: its site and when it was saved. */
export const savedSignInSchema = z.object({
  site: z.string(),
  savedAt: z.number(),
  id: z.string().optional(),
  automatic: z.boolean().optional(),
});
export type SavedSignIn = z.infer<typeof savedSignInSchema>;

/**
 * The saved website sign-ins, for Settings: `available` is false where this
 * Mac keeps no task browsers (a host with no browser engine), and the list
 * is then empty.
 */
export const savedSignInsViewSchema = z.object({
  available: z.boolean(),
  signIns: z.array(savedSignInSchema),
});
export type SavedSignInsView = z.infer<typeof savedSignInsViewSchema>;

/**
 * Who is using a task's open browser: its crewmate, nobody, or the captain -
 * paused for his help, his Take control finishing the crewmate's command,
 * or his control (docs/task-browser.md, "Taking control").
 */
export type TaskBrowserDriver = "crewmate" | "nobody" | TaskBrowserControl;

/**
 * The captain's hold comes first, read off the browser's own fact. Past it,
 * the crewmate drives while its turn runs, since only a turn uses the
 * browser's tools; once the turn ends, nobody does and the browser stays
 * as it was left. Read off the same typed posture the record's pill reads.
 */
export function browserDriverOf(
  task: {
    workPosture?: { state: string; reason: string } | undefined;
    activity: "starting" | "running" | "idle" | "interrupted" | null;
  },
  fact?: TaskBrowserFact,
): TaskBrowserDriver {
  if (fact?.state === "open" && fact.control) return fact.control;
  if (task.workPosture) {
    return task.workPosture.state === "active" && task.workPosture.reason === "turn"
      ? "crewmate"
      : "nobody";
  }
  return task.activity === "running" || task.activity === "starting" ? "crewmate" : "nobody";
}

/** Who is driving, after the site on the record's line and a card's. */
export const DRIVER_WORDS: Record<TaskBrowserDriver, string> = {
  crewmate: "the crewmate is driving",
  nobody: "nobody is driving",
  waiting: "paused for your help",
  taking: "you are taking control",
  captain: "you have control",
};

/** Who is driving in the view's own row, which says more where the captain drives. */
export const VIEW_DRIVER_WORDS: Record<TaskBrowserDriver, string> = {
  ...DRIVER_WORDS,
  taking: "finishing the crewmate's current action…",
  captain: "you have control · the crewmate cannot see this page",
};

/** The view's controls and visible notice for the one-click handoff. */
export const TAKE_CONTROL_LABEL = "Take control";
export const RETURN_CONTROL_LABEL = "Return control";
/** The control on a browser the captain's own click opened: there is no crewmate to hand it to. */
export const CLOSE_PAGE_LABEL = "Close page";
export const RETURN_CONTROL_NOTICE =
  "Returning control lets the crewmate read and use this browser, including signed-in pages.";
/**
 * Where the first mate lives, as the browser's words name it: this computer,
 * or that computer by its name on a computer that controls it.
 */
export type FirstMatePlace = { readonly this: string };
/** The status beside a saved sign-in, naming the computer that keeps it. */
export function savedSignInStatus(place: FirstMatePlace = HERE): string {
  return `Sign-in saved on ${place.this} · updates on return`;
}
export const SAVED_SIGN_IN_STATUS = savedSignInStatus();
export const AUTOMATIC_SIGN_IN_LABEL = "Allow future tasks to use this sign-in automatically";
export const AUTOMATIC_SIGN_IN_NOTICE =
  "Applies to tasks across all projects sharing this computer. Turning this off stops future automatic access; Remove also signs out browsers already using it.";
/** What the crewmate did last, as the row reads it once control came back. */
export const FRESH_LOOK_WORDS = "fresh look at the page";
/** The unticked choice for a site with no saved sign-in. */
export function rememberSignInLabel(site: string, place: FirstMatePlace = HERE): string {
  return `Remember my ${site} sign-in on ${place.this}`;
}
/** A request card's default once a sign-in is saved for its site, beside `SIGN_IN_MYSELF_LABEL`. */
export function savedSignInLabel(site: string): string {
  return `Use my saved ${site} sign-in`;
}
/**
 * The saved sign-in's choice once a crewmate said it did not sign its page
 * in: a second choice beside `SIGN_IN_MYSELF_LABEL`, which leads. The card
 * names the site, so the label leaves it out to stay short.
 */
export const SAVED_SIGN_IN_FAILED_LABEL = "Use my saved sign-in (did not work last time)";
/**
 * The saved sign-in a request card may offer: its site, when it was saved,
 * and when a crewmate last said it did not sign its page in.
 */
export type OfferedSignIn = { site: string; savedAt: number; failedAt?: number };
/**
 * What a crewmate is told after a saved sign-in was used: how to say on
 * its next request card that the saved sign-in did not sign the page in.
 */
export const SAVED_SIGN_IN_FAILED_WORDS =
  "If the site still asks for a sign-in, it did not take the saved one: ask the captain again on a card with browser_handoff carrying saved_failed true, so the next card leads with the captain signing in.";
/** The request card's open-browser action, beside a saved sign-in. */
export const SIGN_IN_MYSELF_LABEL = "Sign in myself";
/** The id the host gives the saved sign-in action it adds to a request card. */
export const USE_SAVED_SIGN_IN_ACTION = "use-saved-sign-in";

/** What stopped it, in the record's Browser line. */
export const STOP_LINE_WORDS: Record<TaskBrowserStop, string> = {
  captain: "you stopped it",
  crewmate: "the crewmate closed it",
  idle: "stopped after 30 minutes unused",
  gone: "its page stopped working",
  "task-closed": "stopped when the task closed",
};

/** The view's sentence for a stopped browser, and the line under it. */
export const STOP_VIEW_WORDS: Record<TaskBrowserStop, { lead: string; detail: string }> = {
  captain: { lead: "You stopped this browser.", detail: "Nothing it signed in to was kept." },
  crewmate: {
    lead: "The crewmate closed this browser.",
    detail: "Nothing it signed in to was kept.",
  },
  idle: {
    lead: "This browser stopped after 30 minutes unused.",
    detail: "Nothing it signed in to was kept.",
  },
  gone: {
    lead: "This browser's page stopped working.",
    detail: "Nothing it signed in to was kept.",
  },
  "task-closed": {
    lead: "This browser was stopped when the task closed.",
    detail: "Its pictures are in the task's record.",
  },
};

/**
 * How the browser a card's attachment names stands against the task's
 * browser now (docs/task-browser.md, "From a card"): still the one (`same`,
 * open or stopped), stopped and followed by a newer one in the same run
 * (`replaced`), or ended by the app's quit since (`restarted`). A newer
 * browser keeps nothing the card's one had.
 */
export type AttachmentStanding = "same" | "replaced" | "restarted";

export function attachmentStanding(
  from: { session: string; generation: number },
  fact: TaskBrowserFact | undefined,
): AttachmentStanding {
  if (!fact || fact.session !== from.session) return "restarted";
  return fact.generation === from.generation ? "same" : "replaced";
}

/** A card's attachment line once its browser is no longer the task's. */
export const STALE_ATTACHMENT_LINE = "this card's browser has stopped";

/** The view's line under its row when a card opened it on a browser that is no longer the task's. */
export const STALE_ATTACHMENT_WORDS: Record<Exclude<AttachmentStanding, "same">, string> = {
  replaced:
    "This card's browser has stopped, so this is the task's newer one, which kept nothing from it.",
  restarted:
    "This card's browser stopped when Infinitary quit, and nothing it signed in to was kept.",
};

/** Whether Open again is offered: never once the task has closed. */
export function canOpenAgain(fact: TaskBrowserFact): boolean {
  return fact.state === "stopped" && fact.stopped !== "task-closed";
}

/** The foot line's caption: what this browser holds of the captain's own. */
export const SIGN_IN_CAPTION = "temporary · none of your sign-ins";
/** The caption while the captain drives: what returning control shares. */
export const CAPTAIN_CAPTION = "temporary · returning control shares this page";
/** The caption on a browser his own click opened: no crewmate ever reads it. */
export const OWN_CAPTION = "temporary · the crewmate never sees this page";
/** The caption once he handed it back: what it holds of his, and for how long. */
export const RETURNED_CAPTION = "temporary · keeps what you signed in to until it stops";
/** The caption while it uses a saved sign-in: which site's, and where it is kept. */
export function savedCaption(sites: readonly string[], place: FirstMatePlace = HERE): string {
  const named =
    sites.length > 1 ? `${sites.slice(0, -1).join(", ")} and ${sites.at(-1)}` : (sites[0] ?? "");
  return `signed in on ${named} · saved on ${place.this}`;
}

/**
 * The foot line's caption for an open browser (docs/task-browser.md, "The
 * view"): what it holds of the captain's own. The captain's control comes
 * first, then a saved sign-in in use, then a page the captain handed back.
 */
export function signInCaption(
  fact: Extract<TaskBrowserFact, { state: "open" }>,
  captain: boolean,
  place: FirstMatePlace = HERE,
): string {
  if (captain) return fact.own ? OWN_CAPTION : CAPTAIN_CAPTION;
  if (fact.saved?.length) return savedCaption(fact.saved, place);
  return fact.returned ? RETURNED_CAPTION : SIGN_IN_CAPTION;
}
export const OPEN_AGAIN_LABEL = "Open again";
export const OPEN_AGAIN_CAPTION = "A fresh browser, with nothing signed in";
/** Report a problem's start in the Firstmate input, which the captain finishes. */
export const REPORT_PROBLEM_DRAFT = "This task's browser has a problem: ";

/** The task card's first tab, the record. */
export const INFO_TAB_LABEL = "Info";
/** The Cards tab's label (INF-2261): its count sits beside it in mono. */
export const CARDS_TAB_LABEL = "Cards";
/** The Activity tab's label (INF-2261): it shows no count. */
export const ACTIVITY_TAB_LABEL = "Activity";

/**
 * A browser tab's words on the task card: Browser, then the page's title when
 * it has one. The site stays in the browser's own row, since nearly every
 * page is a localhost port.
 */
export function browserTabLabel(title: string | undefined): string {
  return title ? `Browser · ${title}` : "Browser";
}

/**
 * One cookie of a site's sign-in, the way a browser keeps it (`HostCookie`
 * in the core): what a saved sign-in's file holds, and what crosses to a
 * computer whose task's browser the captain lets use one
 * (docs/task-browser.md, "On another computer").
 */
export const webCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  hostOnly: z.boolean(),
  path: z.string(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  expirationDate: z.number().optional(),
  sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]),
});

/** One origin's page storage, as a browser holds it (`HostOriginStorage` in the core). */
export const originStorageSchema = z.object({
  origin: z.string().min(1),
  items: z.array(z.tuple([z.string(), z.string()])),
});

/**
 * What a browser holds of one site's sign-in: its cookies, its own origins'
 * local storage, and their session storage when it was read (absent from a
 * computer without session storage in saves, which reads as none).
 */
export const heldSignInSchema = z.object({
  cookies: z.array(webCookieSchema),
  storage: z.array(originStorageSchema),
  session: z.array(originStorageSchema).optional(),
});
