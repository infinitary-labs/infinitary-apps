import { z } from "zod";
import { CARD_REPLY_MAX_CHARS } from "./cards";
import { CONNECTION_MAX_FRAME_BYTES } from "./connection";
import { HERE } from "./deviceNames";
import * as m from "./i18n/messages.generated.ts";

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
  /**
   * The crewmate declared it asks the captain to sign in
   * (docs/task-browser.md, "Signed-in sites"): the captain's Take control opens the
   * site in the computer's kept profile. The host never guesses it.
   */
  signIn: z.literal(true).optional(),
});
export type TaskBrowserRequest = z.infer<typeof taskBrowserRequestSchema>;

/** The most signed-in sites one task is allowed at once: one per site it was granted or signed in to. */
export const SAVED_SIGN_INS_PER_TASK = 8;

/**
 * The signed-in site a request card may offer: its site, when the captain
 * signed in, and when a crewmate last said it did not sign its page in.
 */
export const offeredSignInSchema = z.object({
  site: z.string(),
  savedAt: z.number(),
  failedAt: z.number().optional(),
});
export type OfferedSignIn = z.infer<typeof offeredSignInSchema>;

/** One page of an open browser, as the page selector names it: its own site and title. */
export const taskBrowserPageSchema = z.object({ site: z.string(), title: z.string() });
export type TaskBrowserPage = z.infer<typeof taskBrowserPageSchema>;

/**
 * What a page may ask the captain for while holding its browser
 * (docs/task-browser.md, "A site's asks"): its camera, microphone or both,
 * its notifications, the clipboard's words, or a passkey, which only Google
 * Chrome on the computer the captain sits at can answer.
 */
export const TASK_BROWSER_ASK_KINDS = [
  "camera",
  "microphone",
  "camera-microphone",
  "notifications",
  "clipboard",
  "passkey",
] as const;
export type TaskBrowserAskKind = (typeof TASK_BROWSER_ASK_KINDS)[number];

/** The page's one ask waiting on the captain: its number, what it is and the site asking. */
export const taskBrowserAskSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(TASK_BROWSER_ASK_KINDS),
  site: z.string(),
  /** A passkey the captain let run with Use passkey: Chrome's own prompt answers it now. */
  allowed: z.literal(true).optional(),
});
export type TaskBrowserAsk = z.infer<typeof taskBrowserAskSchema>;

/**
 * A passkey request the browser told the site no to while the captain held
 * it (docs/task-browser.md, "A site's asks"): `engine` when the built-in
 * engine has no passkey to offer, `away` when Chrome would show its prompt
 * only on a computer the captain is not at.
 */
export const taskBrowserToldSchema = z.object({
  kind: z.literal("passkey"),
  site: z.string(),
  where: z.enum(["engine", "away"]),
});
export type TaskBrowserTold = z.infer<typeof taskBrowserToldSchema>;

/**
 * The captain's answer to a page's ask: let it once (Use passkey for a
 * passkey), not now, or show Chrome's window for a passkey let run.
 */
export const TASK_BROWSER_ASK_ANSWERS = ["allow", "not-now", "show"] as const;
export type TaskBrowserAskAnswer = (typeof TASK_BROWSER_ASK_ANSWERS)[number];

export const ALLOW_ONCE_LABEL = "Allow once";
export const NOT_NOW_LABEL = "Not now";
export const SHOW_CHROME_WINDOW_LABEL = "Show Chrome window";
export const USE_PASSKEY_LABEL = "Use passkey";
/** What the view says when the captain's answer could not reach the browser. */
export const ASK_FAILED_WORDS = "The page did not take that answer.";

const ASK_THINGS: Record<Exclude<TaskBrowserAskKind, "passkey">, string> = {
  camera: "your camera",
  microphone: "your microphone",
  "camera-microphone": "your camera and microphone",
  notifications: "send you notifications",
  clipboard: "read your clipboard",
};

/** The line a page's ask shows beside the page, above its buttons. */
export function askWords(ask: Pick<TaskBrowserAsk, "kind" | "site" | "allowed">): string {
  if (ask.kind === "passkey") {
    return ask.allowed
      ? `${ask.site} asks for a passkey. Chrome shows its prompt in its own window.`
      : `${ask.site} asks for a passkey. Using it brings Chrome's window onto your screen.`;
  }
  const thing = ASK_THINGS[ask.kind];
  return ask.kind === "notifications" || ask.kind === "clipboard"
    ? `${ask.site} asks to ${thing}.`
    : `${ask.site} asks to use ${thing}.`;
}

/** The line a passkey request the browser said no to shows, while its site is on the page. */
export function toldWords(told: TaskBrowserTold): string {
  const why =
    told.where === "engine"
      ? "This browser has no passkeys"
      : "Chrome shows a passkey only on the computer it runs on";
  return `${told.site} asked for a passkey. ${why}, so it told the site none is available. Look on the page for a password or a code.`;
}

/**
 * Why a page's own address is one its browser refuses
 * (docs/task-browser.md, "Where a page may go"): another server on the
 * browser's computer the task has not opened, an address on a private
 * network, or a website over plain http.
 */
export const TASK_BROWSER_BLOCKS = ["local", "private", "insecure"] as const;
export type TaskBrowserBlock = (typeof TASK_BROWSER_BLOCKS)[number];

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
     * The signed-in sites this browser may use (docs/task-browser.md,
     * "Signed-in sites"): one the captain let it use on its request card,
     * one whose rule lets tasks use it without asking, or one the captain
     * signed in to as he held it. Absent while it may use none.
     */
    saved: z.array(z.string()).min(1).max(SAVED_SIGN_INS_PER_TASK).optional(),
    /**
     * Its pages run in the computer's kept profile, where the captain's
     * sign-ins stay (docs/task-browser.md, "Signed-in sites"); absent while
     * they run in its own empty context.
     */
    kept: z.literal(true).optional(),
    /**
     * While the captain holds it in the kept profile, the captain's rule for
     * the page's site on the computer it runs on (docs/task-browser.md, "The
     * rule"): the Return control question starts from it. Absent while that
     * computer lists no sign-in for the site.
     */
    rule: z.enum(["ask", "automatic"]).optional(),
    /**
     * While the captain does not hold it, the signed-in site the computer it
     * runs on keeps for the page's site, which a request card offers;
     * absent when it keeps none the browser does not already use.
     */
    offer: offeredSignInSchema.optional(),
    /** While the captain holds it, what its page asks the captain now (docs/task-browser.md, "A site's asks"). */
    ask: taskBrowserAskSchema.optional(),
    /** While the captain holds it, the passkey request it last told the site no to. */
    told: taskBrowserToldSchema.optional(),
    /**
     * Nothing answers at the loopback address its page is on: a connection
     * to it was refused (docs/task-browser.md, "When nothing answers"). It
     * stays until that address answers again.
     */
    unanswered: z.literal(true).optional(),
    /**
     * While nothing answers there, Infinitary runs the start command its
     * crewmate saved for the page and waits for it to answer
     * (docs/task-browser.md, "Starting a page again").
     */
    starting: z.literal(true).optional(),
    /**
     * The page is on an address its browser refuses, so it shows the
     * browser's own refusal (docs/task-browser.md, "A page on a refused
     * address"): another server on the browser's computer, a private
     * network, or a website over plain http. Read off the page's address as
     * it is now, so it goes once the page moves on.
     */
    blocked: z.enum(TASK_BROWSER_BLOCKS).optional(),
    ...browserIdentity,
  }),
  z.object({
    state: z.literal("stopped"),
    site: z.string(),
    /** The page it was on: Open again starts there. */
    url: z.string(),
    stopped: z.enum(TASK_BROWSER_STOPS),
    at: z.number(),
    /**
     * It was open when Infinitary quit, read again after the restart from
     * the page kept with its task (docs/task-browser.md, "After a
     * restart"); its `stopped` is then `gone`, which a reader without this
     * field shows.
     */
    quit: z.literal(true).optional(),
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
 * A page names at most this many places in one answer (docs/task-browser.md, "Pointing at a
 * page"): the answer rides one connection frame, and the outline's first ones on screen are kept.
 */
export const TASK_BROWSER_PLACES_MAX = 400;

/** One thing the page's outline names on screen: its role and name, and its box in the page's own pixels. */
export const taskBrowserPlaceSchema = z.object({
  role: z.string().max(64),
  name: z.string().max(240),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TaskBrowserPlace = z.infer<typeof taskBrowserPlaceSchema>;

/**
 * What the outline of a task's page names on screen now, in the outline's order, with the size
 * the page is laid out at and the page's address and title as its crewmate's own reads give
 * them; or that it could not be read, which a view shows no words for: a mark then names its
 * box alone. Names only: never a value typed into the page.
 */
export const taskBrowserPlacesSchema = z.union([
  z.object({
    ok: z.literal(true),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    url: z.string().max(2_048),
    title: z.string().max(240),
    places: z.array(taskBrowserPlaceSchema).max(TASK_BROWSER_PLACES_MAX),
  }),
  z.object({ ok: z.literal(false) }),
]);
export type TaskBrowserPlaces = z.infer<typeof taskBrowserPlacesSchema>;

/**
 * How the captain hands a browser back (docs/task-browser.md, "Signed-in
 * sites"): from the kept profile, `automatic` is the captain's rule for the site they
 * signed in to - true lets later tasks use it without asking, false asks
 * the captain each time - and `site` binds it to the displayed site. `words`
 * are what they left in the reply field of the request docked beside the page
 * ("Asking for help"), which ride the crewmate's one wake. `remember` and
 * `savedId` were the retired copies' choices and are no longer read.
 */
export const taskBrowserReturnSchema = z.object({
  remember: z.boolean().optional(),
  site: z.string().optional(),
  savedId: z.string().optional(),
  words: z.string().max(CARD_REPLY_MAX_CHARS).optional(),
  automatic: z.boolean().optional(),
});
export type TaskBrowserReturn = z.infer<typeof taskBrowserReturnSchema>;

/**
 * One signed-in site a computer keeps, as Settings lists it: its site,
 * when the captain signed in, the entry's id, and its rule (`automatic`:
 * use it without asking). Nothing of the sign-in itself is in it.
 */
export const savedSignInSchema = z.object({
  site: z.string(),
  savedAt: z.number(),
  id: z.string().optional(),
  automatic: z.boolean().optional(),
});
export type SavedSignIn = z.infer<typeof savedSignInSchema>;

/**
 * One other computer's signed-in sites, for Settings: the computer that
 * runs work, by id and name, and its list, or `unreachable` while it could
 * not be asked.
 */
export const computerSignInsSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  signIns: z.array(savedSignInSchema),
  unreachable: z.literal(true).optional(),
});
export type ComputerSignIns = z.infer<typeof computerSignInsSchema>;

/**
 * The signed-in sites, for Settings: `available` is false where this Mac
 * keeps no task browsers (a host with no browser engine), and its list is
 * then empty; `computers` lists each computer that runs work for it.
 */
export const savedSignInsViewSchema = z.object({
  available: z.boolean(),
  signIns: z.array(savedSignInSchema),
  computers: z.array(computerSignInsSchema).optional(),
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
  get crewmate() {
    return m.taskBrowserDriverCrewmate();
  },
  get nobody() {
    return m.taskBrowserDriverNobody();
  },
  get waiting() {
    return m.taskBrowserDriverWaiting();
  },
  get taking() {
    return m.taskBrowserDriverTaking();
  },
  get captain() {
    return m.taskBrowserDriverCaptain();
  },
};

/** Who is driving in the view's own row, which says more where the captain drives. */
export const VIEW_DRIVER_WORDS: Record<TaskBrowserDriver, string> = {
  get crewmate() {
    return m.taskBrowserDriverCrewmate();
  },
  get nobody() {
    return m.taskBrowserDriverNobody();
  },
  get waiting() {
    return m.taskBrowserDriverWaiting();
  },
  taking: "finishing the crewmate's current action…",
  captain: "you have control · the crewmate cannot see this page",
};

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
/** The Electron partition that is a computer's kept profile for the built-in engine (docs/task-browser.md, "Signed-in sites"). */
export const KEPT_PARTITION = "persist:task-browser-kept";
/** The return question's legend: the sign-in stays on the computer, and later tasks follow the rule picked. */
export function signInRuleLegend(site: string, place: FirstMatePlace = HERE): string {
  return `Your ${site} sign-in stays on ${place.this}. Later tasks:`;
}
/** The rule that asks the captain on a card each time a task needs the site. */
export const ASK_EACH_TIME_LABEL = "Ask me each time";
/** The rule that lets later tasks use the site's sign-in without asking. */
export const USE_WITHOUT_ASKING_LABEL = "Use it without asking";
/** Settings' name for a site's rule. */
export const SIGN_IN_RULE_LABEL = "Later tasks";
export const AUTOMATIC_SIGN_IN_NOTICE =
  "A rule applies to tasks across all projects on that computer. Use it without asking never covers a payment or a final submission; Remove signs the site out there.";
/** What the crewmate did last, as the row reads it once control came back. */
export const FRESH_LOOK_WORDS = "fresh look at the page";
/** A request card's default once the computer keeps a sign-in for its site, beside `SIGN_IN_MYSELF_LABEL`. */
export function savedSignInLabel(site: string): string {
  return `Use my ${site} sign-in`;
}
/**
 * The saved sign-in's choice once a crewmate said it did not sign its page
 * in: a second choice beside `SIGN_IN_MYSELF_LABEL`, which leads. The card
 * names the site, so the label leaves it out to stay short.
 */
export const SAVED_SIGN_IN_FAILED_LABEL = "Use my sign-in (did not work last time)";

/**
 * What a crewmate is told after a saved sign-in was used: how to say on
 * its next request card that the saved sign-in did not sign the page in.
 */
export const SAVED_SIGN_IN_FAILED_WORDS =
  "If the site still asks for a sign-in, the kept one has ended: ask the captain again on a card with browser_handoff carrying saved_failed true and browser_sign_in true, so the next card leads with the captain signing in.";
/** The request card's open-browser action, beside a saved sign-in. */
export const SIGN_IN_MYSELF_LABEL = "Sign in myself";
/** The id the host gives the saved sign-in action it adds to a request card. */
export const USE_SAVED_SIGN_IN_ACTION = "use-saved-sign-in";

/** What stopped it, in the record's Browser line. */
export const STOP_LINE_WORDS: Record<TaskBrowserStop, string> = {
  get captain() {
    return m.taskBrowserStoppedCaptain();
  },
  get crewmate() {
    return m.taskBrowserStoppedCrewmate();
  },
  get idle() {
    return m.taskBrowserStoppedIdle();
  },
  get gone() {
    return m.taskBrowserStoppedGone();
  },
  get "task-closed"() {
    return m.taskBrowserStoppedTaskClosed();
  },
};

/**
 * What a stopped browser leaves of the captain's sign-ins: what the
 * captain signed in to for a sign-in request stays in that computer's kept
 * profile ("Signed-in sites"); nothing else does.
 */
const STOPPED_KEPT_WORDS =
  "What you signed in to for a sign-in request stays; nothing else was kept.";

/** The view's sentence for a stopped browser, and the line under it. */
export const STOP_VIEW_WORDS: Record<TaskBrowserStop, { lead: string; detail: string }> = {
  captain: { lead: "You stopped this browser.", detail: STOPPED_KEPT_WORDS },
  crewmate: {
    lead: "The crewmate closed this browser.",
    detail: STOPPED_KEPT_WORDS,
  },
  idle: {
    lead: "This browser stopped after 30 minutes unused.",
    detail: STOPPED_KEPT_WORDS,
  },
  gone: {
    lead: "This browser's page stopped working.",
    detail: STOPPED_KEPT_WORDS,
  },
  "task-closed": {
    lead: "This browser was stopped when the task closed.",
    detail: "Its pictures are in the task's record.",
  },
};

/** What stopped it, in the record's Browser line: Infinitary's quit when it was open then. */
export function stopLineWords(fact: Extract<TaskBrowserFact, { state: "stopped" }>): string {
  return fact.quit ? m.taskBrowserStoppedQuit() : STOP_LINE_WORDS[fact.stopped];
}

/** The view's sentence for a stopped browser and the line under it, a quit's included. */
export function stopViewWords(fact: Extract<TaskBrowserFact, { state: "stopped" }>): {
  lead: string;
  detail: string;
} {
  return fact.quit
    ? { lead: m.cardBrowserQuitLead(), detail: STOPPED_KEPT_WORDS }
    : STOP_VIEW_WORDS[fact.stopped];
}

/**
 * The view's line while nothing answers at its page's address
 * (docs/task-browser.md, "When nothing answers"): its crewmate was asked to
 * start it again, or is working now and was not asked; or, with `starting`,
 * Infinitary runs the start its crewmate saved ("Starting a page again").
 */
export function unansweredWords(
  site: string,
  driver: TaskBrowserDriver,
  starting?: boolean,
): string {
  if (starting) return m.cardBrowserUnansweredStarting({ site });
  return driver === "crewmate"
    ? m.cardBrowserUnansweredWorking({ site })
    : m.cardBrowserUnansweredAsked({ site });
}

/**
 * The view's line while its page is on an address the browser refuses
 * (docs/task-browser.md, "A page on a refused address"): the page shows the
 * browser engine's own error, so the line says in Infinitary's words what
 * was blocked and why, and while the captain holds a page a program on its
 * computer blocked, that returning control lets the crewmate open it.
 */
export function blockedWords(
  site: string,
  block: TaskBrowserBlock,
  driver: TaskBrowserDriver,
): string {
  switch (block) {
    case "local":
      return driver === "captain"
        ? m.cardBrowserBlockedLocalHeld({ site })
        : m.cardBrowserBlockedLocal({ site });
    case "private":
      return m.cardBrowserBlockedPrivate({ site });
    case "insecure":
      return m.cardBrowserBlockedInsecure({ site });
  }
}

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
export const STALE_ATTACHMENT_LINE = m.taskBrowserStaleAttachment();

/** The view's line under its row when a card opened it on a browser that is no longer the task's. */
export const STALE_ATTACHMENT_WORDS: Record<Exclude<AttachmentStanding, "same">, string> = {
  replaced:
    "This card's browser has stopped, so this is the task's newer one, which kept nothing from it.",
  restarted:
    "This card's browser stopped when Infinitary quit; only what you signed in to for a sign-in request stays.",
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
/** The caption while the captain holds it in the kept profile: what they sign in to stays. */
export function keptCaptainCaption(place: FirstMatePlace = HERE): string {
  return `what you sign in to here stays on ${place.this}`;
}
/** The caption once handed back from the kept profile with no site listed: what they signed in to stays. */
export function keptReturnedCaption(place: FirstMatePlace = HERE): string {
  return `what you signed in to here stays on ${place.this}`;
}
/** The caption while it may use signed-in sites: which, and the computer that keeps them. */
export function savedCaption(sites: readonly string[], place: FirstMatePlace = HERE): string {
  const named =
    sites.length > 1 ? `${sites.slice(0, -1).join(", ")} and ${sites.at(-1)}` : (sites[0] ?? "");
  return `signed in on ${named} · kept on ${place.this}`;
}

/**
 * The foot line's caption for an open browser (docs/task-browser.md, "The
 * view"): what it holds of the captain's own. The captain's control comes
 * first, then a saved sign-in in use, then the kept profile, where what the
 * captain signed in to stays, then a page the captain handed back.
 */
export function signInCaption(
  fact: Extract<TaskBrowserFact, { state: "open" }>,
  captain: boolean,
  place: FirstMatePlace = HERE,
): string {
  if (captain) {
    if (fact.own) return OWN_CAPTION;
    return fact.kept ? keptCaptainCaption(place) : CAPTAIN_CAPTION;
  }
  if (fact.saved?.length) return savedCaption(fact.saved, place);
  if (fact.kept) return keptReturnedCaption(place);
  return fact.returned ? RETURNED_CAPTION : SIGN_IN_CAPTION;
}
export const OPEN_AGAIN_LABEL = "Open again";
export const OPEN_AGAIN_CAPTION = "A fresh browser, with nothing signed in";
/** Report a problem's start in the Firstmate input, which the captain finishes. */
export const REPORT_PROBLEM_DRAFT = "This task's browser has a problem: ";

/** The task card's first tab, the record. */
export const INFO_TAB_LABEL = m.taskTabInfo();
/** The Cards tab's label (INF-2261): its count sits beside it in mono. */
export const CARDS_TAB_LABEL = m.taskTabCards();
/** The Activity tab's label (INF-2261): it shows no count. */
export const ACTIVITY_TAB_LABEL = m.taskTabActivity();

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
