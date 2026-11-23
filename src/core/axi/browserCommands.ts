import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { HERE } from "../../shared/deviceNames";
import { BROWSER_COMMAND } from "../browser/commandWords";
import { BROWSER_KEYS } from "../browser/keys";
import { HIDDEN_VALUE_WORDS, REF_PATTERN } from "../browser/outline";
import type { AxiArguments, AxiCommand, TaskAxiCli } from "./cli";
import type { BrowserOp, BrowserOpInput, BrowserReply, ChannelAnswer } from "./protocol";

/**
 * `infinitary-browser-axi`, the task browser's command (docs/axi-commands.md, "The
 * browser command"; after chrome-devtools-axi): every way a crewmate opens,
 * reads, uses, photographs and closes its task's own browser, as commands
 * in its shell. The table only turns arguments into the task browser's own
 * operations and prints their answers; every decision - where a page may
 * go, what a crewmate reads, a stale ref, the captain's control, a final
 * submission - stays `TaskBrowsers`'s, reached through the task's channel.
 *
 * Nothing here runs script on a page, answers a dialog, emulates a device,
 * profiles, updates itself or installs a hook; a file goes to a page only
 * when the page asked for one, and only from the task's working copy.
 */

/** The task browser as one command reaches it: each operation, answered for this task alone. */
export type BrowserConnection = {
  call: <Op extends BrowserOp>(
    command: string,
    op: Op,
    input: BrowserOpInput[Op],
  ) => Promise<BrowserReply>;
};

const DESCRIPTION = `This task's own browser: open public websites over https, private sites the captain allowed and pages ${HERE.this} serves, read them as outlines with refs, use them with real input, and photograph them into your evidence folder.`;

/** A ref as a crewmate may write it: `@g1:e5`, `g1:e5` or `[g1:e5]`. */
const REF_ARG = new RegExp(`^@?\\[?(${REF_PATTERN})\\]?$`, "i");

/**
 * The browser's rules, in the help of the answers they apply to
 * (docs/task-browser.md): the sign-in rule where a page is opened, the
 * payment rule on the home view and in the help of every command that
 * presses, and the signed-in rule on every answer from a browser that may
 * show the captain's account. The document rule (INF-2375) rides the home
 * view and the click's help, where a site's one-time letter or receipt is
 * reached and downloaded. The prompt line carries the payment rule too.
 */
export const BROWSER_RULES = {
  signIn:
    "A sign-in you did not expect, or on another site: never sign in yourself; ask the captain on a card with emit_card browser_handoff",
  payment:
    "Never press the last step of a purchase or booking yourself, such as Pay or Place order: ask the captain on a card with emit_card browser_handoff that reviews it",
  signedIn:
    "This browser may show the captain's account: keep only the results the task needs, never passwords, codes or card numbers; a screenshot needs --reason",
  document:
    "A document the task must keep, such as a confirmation letter or receipt: before submitting, read how the site delivers it and name on the review card any choice that loses a mailed copy or later access; once offered, download it at once (it lands in your evidence folder) and open it before other work, since the site's page can expire while the tab stays open; a screenshot does not replace it; if it is lost, report needs_firstmate naming it, even while a card of yours waits",
} as const;

function invalid(message: string, help: string[] = []): never {
  throw new AxiError(message, "VALIDATION_ERROR", help);
}

function usage(command: string, spec: string): string[] {
  return [`Usage: ${BROWSER_COMMAND} ${spec}`, `Run \`${BROWSER_COMMAND} ${command} --help\``];
}

/** A ref argument, as the task browser reads it; validation only of its shape. */
function refArg(value: string | undefined, command: string, spec: string): string {
  const ref = value === undefined ? undefined : REF_ARG.exec(value.trim())?.[1];
  if (!ref) {
    invalid(
      value === undefined
        ? `${command} needs the ref of a control, such as @g1:e5`
        : `${JSON.stringify(value)} is not a ref: copy one whole from the latest answer, such as @g1:e5`,
      usage(command, spec),
    );
  }
  return ref.toLowerCase();
}

function isRef(value: string): boolean {
  return REF_ARG.test(value.trim());
}

function whole(value: string | undefined, what: string, command: string, spec: string): number {
  const number = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1)
    invalid(`${command} needs ${what}, a whole number from 1`, usage(command, spec));
  return number;
}

function words(positional: readonly string[], from: number): string | undefined {
  return positional.length > from ? positional.slice(from).join(" ") : undefined;
}

function none(args: AxiArguments, command: string, spec: string): void {
  if (args.positional.length > 0) {
    invalid(`${command} takes no arguments`, usage(command, spec));
  }
}

function helpOf(answer: ChannelAnswer, rules: readonly string[]): string[] {
  const next = answer.next ?? [];
  const picture = answer.picture
    ? ["Open the picture with your read tool to see it; a card can show it by its path"]
    : [];
  const signedIn = answer.page?.signedIn ? [BROWSER_RULES.signedIn] : [];
  return [...next, ...picture, ...rules, ...signedIn];
}

function pageOutput(answer: ChannelAnswer, rules: readonly string[]): string {
  const facts = answer.page;
  if (!facts) return messageOutput(answer, rules);
  const page: Record<string, unknown> = {
    title: facts.title || "(untitled)",
    url: facts.url,
    refs: facts.refs,
    ...(facts.controls !== undefined ? { controls: facts.controls } : {}),
    ...(facts.page ? { page: `${facts.page.place} of ${facts.page.of}` } : {}),
    errors: facts.errors,
  };
  const parts = [encode({ page, did: facts.did })];
  if (answer.body) parts.push(answer.body);
  if (answer.diagnostics) parts.push(diagnosticsOutput(answer.diagnostics));
  // The words name the picture's path and size; the help says how to see it.
  if (answer.picture) parts.push(encode({ picture: answer.picture.path }));
  const help = helpOf(answer, rules);
  if (help.length > 0) parts.push(encode({ help }));
  return parts.join("\n");
}

function messageOutput(answer: ChannelAnswer, rules: readonly string[]): string {
  if (answer.pages) {
    return encode({
      pages: answer.pages.map((page) => ({
        page: page.place,
        title: page.title || "(untitled)",
        url: page.url,
        current: page.current,
      })),
      help: [`\`${BROWSER_COMMAND} selectpage <n>\` makes a page current`, ...rules],
    });
  }
  return encode({ browser: answer.text, ...(rules.length > 0 ? { help: rules } : {}) });
}

function diagnosticsOutput(list: NonNullable<ChannelAnswer["diagnostics"]>): string {
  if (list.show === "console") {
    const counts = Object.entries(list.counts)
      .map(([level, count]) => `${level} ${count}`)
      .join(", ");
    const head = { console: { messages: list.total, ...(counts ? { levels: counts } : {}) } };
    if (!list.rows) {
      return encode({
        ...head,
        note: "On a page that may show the captain's account, only counts are passed on.",
      });
    }
    return encode({
      ...head,
      ...(list.rows.length > 0
        ? { rows: list.rows }
        : { rows: list.total > 0 ? "older messages not kept" : "0 messages" }),
      ...(list.total > list.rows.length && list.rows.length > 0
        ? { omitted: list.total - list.rows.length }
        : {}),
    });
  }
  return encode({
    network: {
      requests: list.total,
      note: "Addresses omit credentials, query and fragment; no bodies, headers or cookies.",
    },
    ...(list.rows.length > 0 ? { rows: list.rows } : { rows: "0 requests" }),
    ...(list.total > list.rows.length ? { omitted: list.total - list.rows.length } : {}),
  });
}

/** A refusal as the SDK prints an error: the browser's words, which say what to do. */
function refusal(answer: ChannelAnswer, lead = ""): never {
  throw new AxiError(
    `${lead}${answer.text}`,
    answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
  );
}

export function renderReply(
  command: string,
  reply: BrowserReply,
  rules: readonly string[],
  home = false,
): string {
  switch (reply.kind) {
    case "answer":
      if (reply.answer.refused) refusal(reply.answer);
      return pageOutput(reply.answer, rules);
    case "running":
      return encode({
        running: command,
        note: `The browser is still doing it past this shell's time limit; its answer is kept for your next \`${BROWSER_COMMAND}\` command.`,
        help: [
          `Run \`${BROWSER_COMMAND}\` to read its answer once it finishes`,
          `Never run ${command} again for it: that would do it twice`,
        ],
      });
    case "earlier": {
      const lead = home
        ? `Your earlier ${reply.command} finished`
        : `Your earlier ${reply.command} finished, so this ${command} was not run; run it again if you still need it`;
      if (reply.answer.refused) refusal(reply.answer, `${lead}: `);
      return `${encode({ earlier: lead })}\n${pageOutput(reply.answer, rules)}`;
    }
    case "busy":
      throw new AxiError(
        `Your earlier ${reply.command} is still running in the browser, so this command was not run`,
        "BUSY",
        [
          `Run \`${BROWSER_COMMAND}\` to read the earlier answer once it finishes, then run this again`,
        ],
      );
  }
}

function command(
  spec: string,
  description: string,
  run: (args: AxiArguments, browser: BrowserConnection) => Promise<string>,
  flags?: AxiCommand<BrowserConnection>["flags"],
): AxiCommand<BrowserConnection> {
  return { usage: spec, description, ...(flags ? { flags } : {}), run };
}

const NO_RULES: readonly string[] = [];
// i18n-exempt: a command's usage, read in the crewmate's shell
const OPEN_SPEC = "open <url> [--start <command> --within <seconds>]";
const OPEN_RULES = [BROWSER_RULES.signIn];
const SCROLL_DIRECTIONS = ["up", "down", "top", "bottom"] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

async function ask<Op extends BrowserOp>(
  browser: BrowserConnection,
  name: string,
  op: Op,
  input: BrowserOpInput[Op],
  rules: readonly string[],
): Promise<string> {
  return renderReply(name, await browser.call(name, op, input), rules);
}

/** The table, command by command (docs/axi-commands.md has it as a list). */
export const BROWSER_COMMANDS: Record<string, AxiCommand<BrowserConnection>> = {
  open: command(
    OPEN_SPEC,
    `Open a public website over https, a private site the captain allowed (over https or http, by its name), or a page a project serves on ${HERE.this} (localhost, 127.0.0.1, a name ending in .localhost), and show its outline. A fresh browser has nothing signed in. A private-network address, an unlisted private site, other plain http, a certificate error and a site's sign-in box are refused. For a page a project serves on ${HERE.this}, --start saves the command that starts its server and --within how many seconds it may take to answer: when the captain opens the page and nothing answers there, Infinitary runs it in this folder, with the person's login environment rather than this shell's, and asks you only if it fails, and if nothing answers now it runs it at once. A program it starts stops with this browser, after your turn if you are working, and needs no registered stop.`,
    async (args, browser) => {
      const url = args.positional[0];
      if (!url || args.positional.length > 1)
        invalid("open needs one address", usage("open", OPEN_SPEC));
      const start = args.flags["--start"];
      const within = args.flags["--within"];
      if (start === undefined && within === undefined)
        return ask(browser, "open", "navigate", { url }, OPEN_RULES);
      if (typeof start !== "string" || !start.trim())
        // i18n-exempt: a command refusal read in the crewmate's shell
        invalid(
          "--within goes with --start, the command that starts the page",
          usage("open", OPEN_SPEC),
        );
      const seconds = typeof within === "string" && /^\d+$/.test(within) ? Number(within) : 0;
      if (!Number.isSafeInteger(seconds) || seconds < 1)
        // i18n-exempt: a command refusal read in the crewmate's shell
        invalid(
          "--start needs --within, how many seconds the page may take to answer, a whole number from 1",
          usage("open", OPEN_SPEC),
        );
      return ask(
        browser,
        "open",
        "navigate",
        { url, start: { command: start, withinSeconds: seconds } },
        OPEN_RULES,
      );
    },
    { "--start": "value", "--within": "value" },
  ),
  back: command("back", "Go back a page.", async (args, browser) => {
    none(args, "back", "back");
    return ask(browser, "back", "navigate", { go: "back" }, NO_RULES);
  }),
  forward: command("forward", "Go forward a page.", async (args, browser) => {
    none(args, "forward", "forward");
    return ask(browser, "forward", "navigate", { go: "forward" }, NO_RULES);
  }),
  reload: command(
    "reload",
    "Reload the page. A page that answers a form that was sent is never reloaded: the browser never sends a form twice.",
    async (args, browser) => {
      none(args, "reload", "reload");
      return ask(browser, "reload", "navigate", { go: "reload" }, NO_RULES);
    },
  ),
  snapshot: command(
    "snapshot [@ref] [--from <line>] [--find <words>] [--full]",
    `Read the page again as an outline window: from the top, from a line, or around some words. --full shows every line. With a ref, read a passage marked cut short in full. Text you did not type yourself once the captain handed the page back reads ${HIDDEN_VALUE_WORDS}.`,
    async (args, browser) => {
      const spec = "snapshot [@ref] [--from <line>] [--find <words>] [--full]";
      const [first, ...rest] = args.positional;
      if (rest.length > 0) invalid("snapshot takes at most one ref", usage("snapshot", spec));
      const from = args.flags["--from"];
      const find = args.flags["--find"];
      const full = args.flags["--full"] === true;
      if (first !== undefined) {
        const ref = refArg(first, "snapshot", spec);
        if (from !== undefined || find !== undefined || full)
          invalid("snapshot with a ref reads that passage alone", usage("snapshot", spec));
        return ask(browser, "snapshot", "inspect", { ref }, NO_RULES);
      }
      if (full && find !== undefined)
        invalid("--full shows every line; it takes no --find", usage("snapshot", spec));
      return ask(
        browser,
        "snapshot",
        "inspect",
        {
          ...(from !== undefined
            ? { from: whole(String(from), "a line after --from", "snapshot", spec) }
            : {}),
          ...(typeof find === "string" ? { find } : {}),
          ...(full ? { full: true } : {}),
        },
        NO_RULES,
      );
    },
    { "--from": "value", "--find": "value", "--full": "switch" },
  ),
  wait: command(
    "wait <text>",
    "Wait up to ten seconds for words to appear on a page that loads on its own, then read the part that holds them.",
    async (args, browser) => {
      const text = words(args.positional, 0);
      if (!text?.trim()) invalid("wait needs the words to wait for", usage("wait", "wait <text>"));
      return ask(browser, "wait", "inspect", { waitFor: text }, NO_RULES);
    },
  ),
  click: command(
    "click @ref",
    `Click a control by its ref. A click on a link waits for the page it opens. ${BROWSER_RULES.payment}. ${BROWSER_RULES.document}.`,
    async (args, browser) => {
      if (args.positional.length !== 1)
        invalid("click needs one ref", usage("click", "click @ref"));
      const ref = refArg(args.positional[0], "click", "click @ref");
      return ask(browser, "click", "act", { action: "click", ref }, NO_RULES);
    },
  ),
  hover: command(
    "hover @ref",
    "Move the pointer onto a control without clicking.",
    async (args, browser) => {
      if (args.positional.length !== 1)
        invalid("hover needs one ref", usage("hover", "hover @ref"));
      const ref = refArg(args.positional[0], "hover", "hover @ref");
      return ask(browser, "hover", "act", { action: "hover", ref }, NO_RULES);
    },
  ),
  drag: command(
    "drag @from @to",
    "Drag one element onto another with real pointer input; both must be on screen together.",
    async (args, browser) => {
      if (args.positional.length !== 2)
        invalid("drag needs two refs", usage("drag", "drag @from @to"));
      const ref = refArg(args.positional[0], "drag", "drag @from @to");
      const to = refArg(args.positional[1], "drag", "drag @from @to");
      return ask(browser, "drag", "act", { action: "drag", ref, to }, NO_RULES);
    },
  ),
  fill: command(
    "fill @ref <text>",
    'Put text in a field, replacing what it holds, or choose the option of that label in a list. It never sends a form; "" clears a field.',
    async (args, browser) => {
      const spec = "fill @ref <text>";
      const ref = refArg(args.positional[0], "fill", spec);
      const text = words(args.positional, 1);
      if (text === undefined)
        invalid('fill needs the text to put in; "" clears the field', usage("fill", spec));
      return ask(browser, "fill", "act", { action: "set", ref, text }, NO_RULES);
    },
  ),
  fillform: command(
    "fillform @ref=<text>...",
    "Fill up to 50 text fields in order without sending the form. Every ref is checked first, so a stale one fills none; a page that moves stops the rest.",
    async (args, browser) => {
      const spec = "fillform @ref=<text>...";
      if (args.positional.length === 0 || args.positional.length > 50)
        invalid(
          "fillform needs between 1 and 50 fields, each @ref=<text>",
          usage("fillform", spec),
        );
      const fields = args.positional.map((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) invalid(`${JSON.stringify(pair)} is not @ref=<text>`, usage("fillform", spec));
        return { ref: refArg(pair.slice(0, at), "fillform", spec), text: pair.slice(at + 1) };
      });
      return ask(browser, "fillform", "act", { action: "fill", fields }, NO_RULES);
    },
  ),
  upload: command(
    "upload <path>...",
    "Give the page the files it asked for, after a click on its file button or field: each a file in your working copy, by its path there. Nothing outside your working copy is ever attached.",
    async (args, browser) => {
      if (args.positional.length === 0)
        invalid(
          "upload needs the path of a file in your working copy",
          usage("upload", "upload <path>..."),
        );
      return ask(browser, "upload", "act", { action: "upload", files: args.positional }, NO_RULES);
    },
  ),
  press: command(
    "press <key> [@ref]",
    `Press a key on a control, or on whatever has focus. Keys: ${BROWSER_KEYS.join(", ")}. ${BROWSER_RULES.payment}.`,
    async (args, browser) => {
      const spec = "press <key> [@ref]";
      const [name, target, ...rest] = args.positional;
      const key = BROWSER_KEYS.find((known) => known.toLowerCase() === name?.toLowerCase());
      if (!key || rest.length > 0)
        invalid(
          name ? `${JSON.stringify(name)} is not a key this browser presses` : "press needs a key",
          [`Keys: ${BROWSER_KEYS.join(", ")}`, ...usage("press", spec)],
        );
      return ask(
        browser,
        "press",
        "act",
        {
          action: "press",
          key,
          ...(target !== undefined ? { ref: refArg(target, "press", spec) } : {}),
        },
        NO_RULES,
      );
    },
  ),
  scroll: command(
    "scroll <up|down|top|bottom> [@ref]",
    "Scroll the page about a window's height, or to its top or bottom; with a ref, bring that element into view. Answers with the lines on screen.",
    async (args, browser) => {
      const spec = "scroll <up|down|top|bottom> [@ref]";
      let direction: ScrollDirection | undefined;
      let ref: string | undefined;
      for (const arg of args.positional) {
        const named = SCROLL_DIRECTIONS.find((each) => each === arg.toLowerCase());
        if (isRef(arg) && ref === undefined) ref = refArg(arg, "scroll", spec);
        else if (named && !direction) direction = named;
        else invalid(`${JSON.stringify(arg)} is not a direction or a ref`, usage("scroll", spec));
      }
      if (!direction && !ref) invalid("scroll needs a direction or a ref", usage("scroll", spec));
      return ask(
        browser,
        "scroll",
        "act",
        { action: "scroll", ...(ref ? { ref } : { direction }) },
        NO_RULES,
      );
    },
  ),
  screenshot: command(
    "screenshot [name] [--uid @ref] [--full-page] [--reason <why>]",
    "Photograph the visible page, the whole page, or one element's visible part into your evidence folder as name.png; open the file with your read tool to see it, and a card can show it by its path. Once the captain has handed the browser back, it needs --reason, and a page holding text you did not type is not photographed.",
    async (args, browser) => {
      const spec = "screenshot [name] [--uid @ref] [--full-page] [--reason <why>]";
      if (args.positional.length > 1)
        invalid("screenshot takes at most one name", usage("screenshot", spec));
      const uid = args.flags["--uid"];
      const fullPage = args.flags["--full-page"] === true;
      const reason = args.flags["--reason"];
      if (uid !== undefined && fullPage)
        invalid("Give --uid or --full-page, not both", usage("screenshot", spec));
      return ask(
        browser,
        "screenshot",
        "capture",
        {
          ...(args.positional[0] !== undefined ? { name: args.positional[0] } : {}),
          ...(typeof uid === "string" ? { ref: refArg(uid, "screenshot", spec) } : {}),
          ...(fullPage ? { fullPage: true } : {}),
          ...(typeof reason === "string" ? { reason } : {}),
        },
        [],
      );
    },
    { "--uid": "value", "--full-page": "switch", "--reason": "value" },
  ),
  pages: command(
    "pages",
    "List the browser's pages: its own, and one a page opened.",
    async (args, browser) => {
      none(args, "pages", "pages");
      return ask(browser, "pages", "pages", {}, []);
    },
  ),
  selectpage: command(
    "selectpage <n>",
    "Make page n current: your commands act on it.",
    async (args, browser) => {
      if (args.positional.length !== 1)
        invalid("selectpage needs one page", usage("selectpage", "selectpage <n>"));
      const page = whole(args.positional[0], "a page", "selectpage", "selectpage <n>");
      return ask(browser, "selectpage", "navigate", { page }, NO_RULES);
    },
  ),
  closepage: command(
    "closepage <n>",
    "Close page n, one a page opened; the first page goes only with stop.",
    async (args, browser) => {
      if (args.positional.length !== 1)
        invalid("closepage needs one page", usage("closepage", "closepage <n>"));
      const page = whole(args.positional[0], "a page", "closepage", "closepage <n>");
      return ask(browser, "closepage", "close", { page }, NO_RULES);
    },
  ),
  console: command(
    "console",
    "The page's console messages since it opened or the last handback, newest 100; after a handback only counts.",
    async (args, browser) => {
      none(args, "console", "console");
      return ask(browser, "console", "inspect", { show: "console" }, []);
    },
  ),
  network: command(
    "network",
    "The page's requests since it opened or the last handback, newest 100: method, address without query, type and outcome.",
    async (args, browser) => {
      none(args, "network", "network");
      return ask(browser, "network", "inspect", { show: "network" }, []);
    },
  ),
  withdraw: command(
    "withdraw",
    "Take back your request for the captain's help: the browser is yours again, with its pages, history and sign-ins kept. Refused once the captain has taken control.",
    async (args, browser) => {
      none(args, "withdraw", "withdraw");
      return ask(browser, "withdraw", "close", { withdraw: true }, []);
    },
  ),
  stop: command(
    "stop",
    "Stop this task's browser: its pages, history and site data are gone. A request waiting for the captain is withdrawn.",
    async (args, browser) => {
      none(args, "stop", "stop");
      return ask(browser, "stop", "close", {}, []);
    },
  ),
};

/**
 * The home view (AXI's content first): the page as it is now with how to
 * use it, or that no browser is open and how to open one. A kept answer
 * from a command past the shell's limit is read here. It never refuses.
 */
async function home(browser: BrowserConnection): Promise<string> {
  const reply = await browser.call("snapshot", "inspect", {});
  if (reply.kind === "answer" && reply.answer.refused) {
    return encode({
      browser: reply.answer.text,
      help: [
        `\`${BROWSER_COMMAND} open <url>\` opens a page`,
        BROWSER_RULES.signIn,
        BROWSER_RULES.payment,
        BROWSER_RULES.document,
      ],
    });
  }
  if (reply.kind === "busy") {
    return encode({
      running: reply.command,
      help: [`Run \`${BROWSER_COMMAND}\` again to read its answer once it finishes`],
    });
  }
  return renderReply(
    "snapshot",
    reply,
    [BROWSER_RULES.signIn, BROWSER_RULES.payment, BROWSER_RULES.document],
    true,
  );
}

/** The whole command, for the command process (`./axiProcess.ts`). */
export function browserAxi(
  version: string,
  connect: () => Promise<BrowserConnection>,
): TaskAxiCli<BrowserConnection> {
  return {
    name: BROWSER_COMMAND,
    description: DESCRIPTION,
    version,
    commands: BROWSER_COMMANDS,
    home,
    connect,
  };
}
