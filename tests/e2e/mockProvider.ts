import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { parseServedInput, type ServedSegment } from "@shared/servedFrame";
import { BROWSER_COMMAND } from "../../src/core/browser/commandWords";
import { REF_PATTERN } from "../../src/core/browser/outline";
import { BUILD_IN_PLACE_OPENING } from "../../src/core/orchestrator/intentBrief";
import {
  ANSWER_MISSING_OPENING,
  BROWSER_RETURNED_OPENING,
  CARD_CLOSED_STEER_PREFIX,
  FINISHED_REPORT_WORDS,
  renderWake,
  SETUP_CARD_FAILED_WORDS,
  WELCOME_WAKE_WORDS,
} from "../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../src/core/pi/bashWords";
import { NOTHING_SPAWNED } from "../../src/core/pi/crewTools";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../../src/core/pi/piResources";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../../src/core/storage/sessionReader";
import { CREATE_PANEL_DRAFT } from "../../src/shared/createPanelSlot";
import { HERE } from "../../src/shared/deviceNames";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  writeAnthropicError,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../helpers/anthropicDialect";
import { completionCardBody } from "../helpers/completionCard";
import type { ScriptedArgs, ScriptedCall, ScriptedCardAction } from "../helpers/scriptedCalls";
import {
  API_WRITE_GUARD_MARKER,
  mergeWriteCases,
  READS_ANYWHERE_MARKER,
  SKIP_RULES_CARD_TITLE,
  SKIP_RULES_MERGE_MARKER,
  SKIP_RULES_MERGED_WAKE,
  SKIP_RULES_PULL,
  WRITE_ASK_ANSWER_MARKER,
  WRITE_ASK_CARD_TITLE,
  WRITE_ASK_MARKER,
  WRITE_ASK_SENT_WAKE,
  writeAskCall,
} from "./apiWriteCases";
import { DEMO_CAPTION, DEMO_POSTER } from "./demoFixtures";
import { GITLAB_STUB_PROJECT } from "./gitlabStub";
import {
  chessItems,
  LESSON_CHESS_ASK,
  LESSON_CHESS_CARD_ID,
  LESSON_CHESS_GOAL,
  LESSON_CHESS_TITLE,
  LESSON_FRACTIONS_ASK,
  LESSON_FRACTIONS_GOAL,
  LESSON_FRACTIONS_GOAL_BODY,
  LESSON_FRACTIONS_GOAL_TITLE,
  LESSON_FRACTIONS_TITLE,
  LESSON_GOAL_BODY,
  LESSON_GOAL_TITLE,
  LESSON_LEARNER_LINE,
  LESSON_NEXT_GOAL,
  LESSON_PROGRESS_STOP,
  LESSON_REPLY_ANSWER,
  LESSON_REPLY_WORDS,
  LESSON_ROUND_ONE_TITLE,
  LESSON_ROUND_REVIEW_TITLE,
  LESSON_ROUND_TWO_TITLE,
  LESSON_WELCOME_BODY,
  LESSON_WELCOME_TITLE,
  lessonRoundBody,
} from "./lessonFixtures";
import {
  bytesOf,
  CHANGE_AFTER_PICTURES,
  CHANGE_BEFORE_PICTURES,
  type PictureFixture,
} from "./pictureFixtures";
import {
  holdsSegment,
  latestContext,
  latestServedTurn,
  providerMessages,
  type ServedTurn,
} from "./providerRequest";
import { starterFor } from "./starters";

/**
 * A minimal OpenAI-completions-compatible server so e2e runs exercise the
 * real Pi pipeline (session -> provider request -> streamed deltas -> card)
 * without real credentials or network. The app points at it through its
 * app-scoped models.json - exactly how a real custom provider would connect.
 */

export const MOCK_COMPLETION_TEXT =
  "Steady as she goes. The worktree is ready and this report streamed from the mock provider.";

/** Marker prompt: the mock crewmate answers with emit_card tool calls first. */
export const EMIT_CARDS_PROMPT_MARKER = "show every card kind";

export const MOCK_REVISED_NOTE_TEXT = "Codex weekly is now at 58% - still routing on pace.";

/** Where the fetch probe card aims: the mock server itself, which counts every hit. */
export const CARD_FETCH_PROBE_PATH = "/card-fetch-probe";
export const SCRIPT_CARD_TITLES = {
  canvas: "Canvas probe",
  fetch: "Fetch probe",
  runaway: "Runaway probe",
  figure: "Figure probe",
} as const;

/**
 * Marker prompt: the mock crewmate emits two notes that each hold a text
 * field, one drawn inline (no script) and one served at a host of its own (a
 * script), so a key can be pressed with focus inside either kind of card
 * frame (tests/e2e/keyboard-routing.spec.ts).
 */
export const KEYBOARD_CARDS_PROMPT_MARKER = "show the keyboard cards";
export const KEYBOARD_CARD_TITLES = {
  inline: "A note field drawn inline",
  served: "A note field served on its own",
} as const;

/**
 * The risk every mock crewmate declares on its completion decision
 * (FI3-1128; docs/card-authoring.md "The risk chart"): the real emit_card
 * refuses a merge card without one, so a scripted crewmate call that
 * merges and names none is given this one on the wire, as a crewmate is
 * told to give its own. A saved-story card takes its risk from that story instead.
 */
export const MOCK_RISK = {
  blast: { level: "medium", why: "The meter and its settings row" },
  behavior: { level: "low", why: "Corrects how the meter reads" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "low", why: "Nothing added" },
} as const;

function withDeclaredRisk(call: ScriptedCall): ScriptedCall {
  if (call.name !== "emit_card") return call;
  // Named, not narrowed: the live tool set is a union too wide for the
  // compiler to narrow by name alone.
  const args = call.args as ScriptedArgs<"emit_card">;
  const merges = args.actions?.some(
    (action) => action.effect?.kind === "settle" && action.effect.mode === "merge",
  );
  return merges && (!("presentation" in args) || args.presentation === undefined)
    ? ({
        ...call,
        args: {
          ...args,
          risk: ("risk" in args ? args.risk : undefined) ?? MOCK_RISK,
          required_actions: args.required_actions ?? [],
        },
      } as ScriptedCall)
    : call;
}

function keyboardCardToolCalls(): ScriptedCall[] {
  const field =
    '<p>Write the note here.</p><p><label>Note <textarea name="note"></textarea></label></p>';
  return [
    { name: "emit_card", args: { title: KEYBOARD_CARD_TITLES.inline, body: field } },
    {
      name: "emit_card",
      args: {
        title: KEYBOARD_CARD_TITLES.served,
        body: `${field}<script>document.querySelector("textarea").placeholder = "a short note";</script>`,
      },
    },
  ];
}

export const FILE_CARD_PROMPT_MARKER = "show a file-backed card";
export const FILE_CARD_REVISE_MARKER = "show the edited card file";
export const FILE_CARD_TITLE = "A card edited in its file";
export const FILE_CARD_INITIAL =
  "<p>The original answer from the file.</p><p>The evidence stays unchanged.</p><p>The next check stays unchanged.</p><p>The scope stays unchanged.</p>";
export const FILE_CARD_REVISED =
  "<p>The updated answer from the file.</p><p>The evidence stays unchanged.</p><p>The next check stays unchanged.</p><p>The scope stays unchanged.</p>" +
  '<figure aria-label="Revised answer drawing"><svg viewBox="0 0 750 40" width="100%" role="img" aria-label="Revised answer drawing"><rect x="1" y="1" width="748" height="38" rx="6" fill="var(--accent-dim)" stroke="var(--accent)"/><text x="12" y="25">The revised file uses the wide card</text></svg></figure>';

/**
 * The longest command one bash call carries: `bash -c` takes its command as
 * one argument, and Linux refuses an argument over 128 KiB, so a crewmate
 * there writes a long run of files in several calls (a Mac allows far more).
 */
const LONGEST_COMMAND = 128 * 1024 - 1;

/** The bash calls a mock crewmate writes `files` into `shots/` of its working copy with, one file each. */
export function writeFilesCalls(
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
): ScriptedCall[] {
  return files.map(({ path, bytes }) => {
    const command = `mkdir -p shots && printf '%s' '${bytes.toString("base64")}' | base64 --decode > ${path}`;
    if (Buffer.byteLength(command) > LONGEST_COMMAND) {
      throw new Error(`${path} is too long to write in one bash call on Linux`);
    }
    return { name: "bash", args: { command } };
  });
}

/** A 2x2 opaque red PNG: small enough to read back pixel by pixel. */
export const INLINE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91" +
  "JpzAAAAFElEQVR4nGP8z4AATAxQxhAXAAAA//8DTQEBc0GFdgAAAABJRU5ErkJggg==";

export function writeChangePicturesCalls(): ScriptedCall[] {
  return writeFilesCalls([...CHANGE_BEFORE_PICTURES, ...CHANGE_AFTER_PICTURES].map(pictureFile));
}

export const DEMO_CARD_TITLE = "Dragging the box moves it";

export function demoCardCall(recording: string, title = DEMO_CARD_TITLE): ScriptedCall {
  const before = CHANGE_BEFORE_PICTURES[0] as PictureFixture;
  return {
    name: "emit_card",
    args: {
      title,
      body: completionCardBody(
        "<p>A box could not be moved by dragging.</p>",
        "<p>Dragging the box moves it to its new place.</p>",
        `<p>The box stayed where it was.</p><figure><img src="${before.path}" alt="${before.alt}"><figcaption>The box</figcaption></figure>`,
        `<p>The box slides to where it is dropped.</p><figure data-inf-demo="${recording}"><img src="${DEMO_POSTER.path}" alt="${DEMO_POSTER.alt}"><figcaption>${DEMO_CAPTION}</figcaption></figure>`,
      ),
      actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
    },
  };
}

export const pictureFile = (picture: PictureFixture) => ({
  path: picture.path,
  bytes: bytesOf(picture),
});

export const BEFORE_AFTER_NEW_PICTURE = CHANGE_AFTER_PICTURES[2] as PictureFixture;

/**
 * Marker prompt (card width, the captain's Q5 to Q7 A of 2026-09-28): the
 * mock crewmate emits three notes the host sizes three ways - prose alone
 * (regular), a five-column table beside a long paragraph and a 510-unit
 * figure (wide, from the body's own facts), and a plain body carrying the
 * author's full hint (`tests/e2e/card-width.spec.ts`).
 */
export const CARD_WIDTH_PROMPT_MARKER = "show the card widths";
export const WIDTH_CARD_TITLES = {
  defaultWide: "The drawing uses the wide card",
  regular: "The meter row reads on first paint",
  wide: "What each model costs per turn",
  full: "The whole settings screen at once",
} as const;
/** The regular card's one paragraph: prose alone. */
export const WIDTH_CARD_REGULAR_TEXT =
  "The meter row now reads on the first paint, all five meters in one line.";
/** The wide card's drawing: 510 units across, at width="100%". */
const WIDTH_CARD_FIGURE = "Cost grows with the turn";
const WIDTH_CARD_PARAGRAPH =
  "Each row is one model family, measured over the same forty recorded turns, and the columns read left to right from the cheapest input to the costliest output, so the row that matters most is the one whose last two columns grow fastest as the turn grows longer.";

/** FI3-234's fluid SVG; card-resize gives it the proportions of the card's overflow threshold. */
export const CARD_RESIZE_PROMPT_MARKER = "show the resize reproduction";
export const CARD_RESIZE_FIGURE = "Resize reproduction";
export const CARD_RESIZE_BODY = `<p>A drawing.</p><figure aria-label="${CARD_RESIZE_FIGURE}"><svg viewBox="0 0 510 290" width="100%" role="img" aria-label="${CARD_RESIZE_FIGURE}"><rect width="510" height="290" style="fill:var(--accent)"/></svg></figure>`;

function resizeCardToolCalls(): ScriptedCall[] {
  return [
    { name: "emit_card", args: { title: WIDTH_CARD_TITLES.regular, body: CARD_RESIZE_BODY } },
  ];
}

/** A clean emitted-card reproduction of the separate viewport-height feedback. */
export const CARD_VIEWPORT_PROMPT_MARKER = "show the viewport height reproduction";
export const CARD_VIEWPORT_TITLE = "A viewport-height card";
export const CARD_VIEWPORT_BODY =
  '<div data-viewport-content style="min-height:100vh;display:flex;flex-direction:column;justify-content:space-between"><span>Viewport-height content</span><span>Bottom of the content</span></div>';
export const CARD_VIEWPORT_SCRIPT =
  '<script>document.documentElement.setAttribute("data-body-script", "ran");</script>';

function viewportCardToolCalls(scripted: boolean): ScriptedCall[] {
  return [
    {
      name: "emit_card",
      args: {
        title: CARD_VIEWPORT_TITLE,
        body: CARD_VIEWPORT_BODY + (scripted ? CARD_VIEWPORT_SCRIPT : ""),
      },
    },
  ];
}

function widthCardToolCalls(): ScriptedCall[] {
  const row = (cells: string[], tag: "th" | "td") =>
    `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
  const table =
    "<table>" +
    row(["Model", "Input", "Cached", "Output", "Per turn"], "th") +
    row(["Small", "0.10", "0.01", "0.40", "0.02"], "td") +
    row(["Large", "3.00", "0.30", "15.00", "0.61"], "td") +
    "</table>";
  const figure =
    `<figure aria-label="${WIDTH_CARD_FIGURE}"><svg viewBox="0 0 750 60" width="100%" role="img" aria-label="${WIDTH_CARD_FIGURE}">` +
    '<rect x="1" y="10" width="748" height="40" rx="6" style="fill:var(--accent-dim);stroke:var(--accent)"/>' +
    '<text x="12" y="35">Small: 0.02 per turn</text><text x="610" y="35">Large: 0.61</text></svg></figure>';
  return [
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.defaultWide,
        body: `<p>The drawing fills the wide card while prose keeps its line.</p>${figure}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.regular,
        body: `<p>${WIDTH_CARD_REGULAR_TEXT}</p>`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.wide,
        body: `<p>The large model costs thirty times the small one per turn.</p><p>${WIDTH_CARD_PARAGRAPH}</p>${table}${figure}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.full,
        body: "<p>The settings screen shows every section without scrolling.</p>",
        width: "full",
      },
    },
  ];
}

/**
 * Marker prompt (task-system P2): the mock crewmate files a follow-up under
 * its own task and notes progress before it reports.
 */
export const FILE_FOLLOWUP_PROMPT_MARKER = "file a follow-up for the meter test";
/**
 * Delivery rigor, phase 1 (the standard tier): a crewmate briefed with
 * "ship at the standard tier" reports under the five headings the tier
 * prescribes and emits its completion card with the four-heading outline.
 * The mock is the shape the prompt asks for, so
 * the e2e proves the shape renders through the real emit -> lint -> frame
 * path and the report reaches the feed - not that a model obeyed.
 */
export const STANDARD_TIER_PROMPT_MARKER = "ship at the standard tier";
export const STANDARD_TIER_HEADINGS = [
  "Intent",
  "What changed",
  "Verified",
  "Risk",
  "Not done",
] as const;
export const MOCK_STANDARD_SECTIONS: Record<(typeof STANDARD_TIER_HEADINGS)[number], string> = {
  Intent: "The meter test passes ten runs in a row.",
  "What changed": "The test awaits the job queue flush before it reads the meter.",
  Verified:
    "pnpm test and pnpm test:e2e on the final commit; the meter test passed ten runs in a row. No screenshot: nothing a person sees changed.",
  Risk: "Low - one test file changed and no production code.",
  "Not done": "Nothing.",
};
/** The completion card's After words. */
export const MOCK_STANDARD_AFTER = "The read now follows the flush; ten consecutive runs passed.";
export const MOCK_STANDARD_CARD_BODY = completionCardBody(
  "<p>The meter test sometimes read before the pending write finished.</p>",
  `<p>${MOCK_STANDARD_SECTIONS["What changed"]}</p>`,
  "<p>The test could read the old meter value while a write was still queued.</p>",
  `<p>${MOCK_STANDARD_AFTER}</p>`,
);

/** The report under the same five headings; the feed line carries the outcome after Intent. */
export const MOCK_STANDARD_REPORT = STANDARD_TIER_HEADINGS.map(
  (heading) => `${heading}: ${MOCK_STANDARD_SECTIONS[heading]}`,
).join(" ");

/** The label the crewmate invents; the captain must never see it. */
export const MOCK_STANDARD_INVENTED_LABEL = "Ship it";

export const MOCK_STANDARD_DRAWN_BODY = completionCardBody(
  "<p>The meter test sometimes read before the pending write finished.</p>",
  `<p>${MOCK_STANDARD_SECTIONS["What changed"]}</p>`,
  "<p>The test could read the old meter value while a write was still queued.</p>",
  `<p>${MOCK_STANDARD_AFTER}</p>` +
    '<figure aria-label="Ten runs, all passed"><svg viewBox="0 0 510 50" width="100%"><rect x="5" y="5" width="500" height="40" rx="8" fill="var(--ok-dim)"/><text x="20" y="30" fill="var(--fg-1)">Ten consecutive runs passed</text></svg></figure>',
);

export const MOCK_STANDARD_MERGE_ONLY_ACTIONS: ScriptedCardAction[] = [
  {
    id: "ship",
    label: MOCK_STANDARD_INVENTED_LABEL,
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
];

/**
 * Cards as threads, phase 1: `THREAD_PROMPT_MARKER` emits a plain decision
 * card and then answers the captain's replies the two ways the shared
 * contract prescribes - a REVISION of the card under the same id when his
 * words change what the card should say, and a prose `reply` when nothing on
 * it changes. The settle hand-off is `scenarios/threadSettle.ts`.
 */
/**
 * Inline decisions (contract 4.22; tests/e2e/card-questions.spec.ts): a
 * crewmate whose card asks three questions in its body as named form
 * controls - a proposed radio, a required one with no proposal, and a free
 * note. On the captain's reply asking for a revision it revises the card,
 * renaming the required question (`writes` becomes `write-scope`) and
 * keeping the other two.
 */
export const INLINE_QUESTIONS_PROMPT_MARKER = "ask the access questions inline";
export const INLINE_QUESTIONS_TITLE = "Three calls settle the access plan";
export const INLINE_QUESTIONS_REVISED_TITLE = "Two calls left on the access plan";
/** The captain's reply that asks for the revision; his picks ride along. */
export const INLINE_QUESTIONS_REVISE_REPLY = "Settle the read scope with these answers";
export const INLINE_QUESTIONS_LOCK_LABEL = "Lock the plan";
export function inlineQuestionsBody(revised: boolean): string {
  const writes = revised ? "write-scope" : "writes";
  return [
    `<p>${revised ? "The read scope is settled; say which tasks may write." : "Each proposed answer is already picked; one needs yours."}</p>`,
    "<fieldset><legend>Which projects can a task read?</legend>",
    '<label><input type="radio" name="read-scope" value="registered" checked> Its registered project, and any you approve</label>',
    '<label><input type="radio" name="read-scope" value="all-visible"> Every project your sign-in can see</label>',
    '<label><input type="radio" name="read-scope" value="other" data-inf-write-in> Something else</label>',
    "</fieldset>",
    "<fieldset><legend>Which tasks can write?</legend>",
    `<label><input type="radio" name="${writes}" value="shipping" required> Tasks that ship a change</label>`,
    `<label><input type="radio" name="${writes}" value="any" required> Any task</label>`,
    `<label><input type="radio" name="${writes}" value="other" required data-inf-write-in> Something else</label>`,
    "</fieldset>",
    '<p><label>Anything else <textarea name="notes"></textarea></label></p>',
  ].join("");
}

export const THREAD_PROMPT_MARKER = "keep a thread open";
export const THREAD_TREE_PROMPT_MARKER = "with a waiting tree";
export const THREAD_TREE_PARENT_KEY = "SCR-1";
export const THREAD_WORKING_SIBLING_MARKER = "keep the sibling working";
export const THREAD_CARD_TITLE = "Two ways to fix the flaky test";
export const THREAD_CARD_REVISED_TITLE = "Await the queue, not the clock";
/** The captain's reply that changes what the card should say: a revision. */
export const THREAD_REVISE_REPLY = "the second option is wrong";
/** The crewmate's short answer, passed as the revision's `reply`. */
export const THREAD_REVISE_ANSWER = "You are right; the card now leads with awaiting the queue.";
/** The captain's reply that changes nothing on the card: prose in the thread. */
export const THREAD_PROSE_REPLY = "and the flaky retry - keep it?";
export const THREAD_PROSE_ANSWER = "Kept it; the queue flush makes the retry harmless either way.";
/**
 * The card return rule's case A (docs/card-threads.md "When a card reaches
 * the stage"): a reply the crewmate first ACKNOWLEDGES in the thread - the
 * shape the contract now forbids, scripted so the host is shown holding the
 * card anyway - then works on, held open until the spec calls
 * `releaseThreadAnswer`, and only then answers by revising the card and
 * reporting.
 */
export const THREAD_ACK_REPLY = "does it cover the retry on windows too?";
export const THREAD_ACK_TEXT = "I'll check the windows retry and update the card.";
export const THREAD_ACK_REVISED_TITLE = "Await the queue on every platform";
export const MOCK_THREAD_ACK_REPORT =
  "Checked the windows retry: awaiting the queue covers it too, and the card now says so.";

/**
 * Cards as threads, phase 2: a Firstmate-authored card. The captain's
 * reply is a captain TURN about that card (not a crewmate steer). The
 * Firstmate revises under the same id, or its closing words land as
 * prose in the thread - it has no reply tool.
 */

export const FM_THREAD_PROMPT_MARKER = "keep a firstmate thread open";
export const FM_THREAD_CARD_TITLE = "Two ways to phrase the welcome";
export const FM_THREAD_CARD_REVISED_TITLE = "Lead with the caption, not the chips";
export const FM_THREAD_REVISE_ANSWER = "Good catch; the card now leads with the caption.";
export const FM_THREAD_PROSE_ANSWER = "The chips stay; the caption is the first thing you read.";
/** Tiny PNG the image-on-steer e2e pastes. */
export const THREAD_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A crewmate's browser command, as it runs it in its shell
 * (docs/axi-commands.md): `infinitary-browser-axi` and its arguments, each one
 * shell word. Pi serves the shell as `bash` and Claude's client as `Bash`
 * (`servedToolName`), so one script drives both.
 */
export function browser(...args: (string | number)[]): ScriptedCall {
  const words = args.map((arg) => {
    const word = String(arg);
    return /^[A-Za-z0-9@:._/=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  });
  return {
    name: "bash",
    args: {
      command: [BROWSER_COMMAND, ...words].join(" "),
      description: "Use this task's browser",
    },
  };
}

/** Whether a tool answer is a browser command's: what infinitary-browser-axi printed. */
function isBrowserAnswer(text: string): boolean {
  return /^(?:page:|browser:|running:|earlier:|error:|pages\[|bin: )/m.test(shellOutput(text));
}

/** What a shell command printed, after the exit line Pi's shell (or Claude's on a failure) puts first. */
function shellOutput(text: string): string {
  return text.replace(/^(?:Error: )?(?:exit|Exit code) \d+\n/, "");
}

/**
 * A browser command's answer as the scripts read it, in the browser's own
 * words: an error is its message, and a quoted fact line reads unquoted, so
 * `did: Clicked button "Send" [g1:e3].` reads as the browser wrote it.
 */
function browserWords(text: string): string {
  const printed = shellOutput(text);
  const error = printed.match(/^error: (.*)$/m)?.[1];
  const unquote = (value: string): string => {
    try {
      return value.startsWith('"') ? (JSON.parse(value) as string) : value;
    } catch {
      return value;
    }
  };
  if (error !== undefined) return unquote(error);
  return printed
    .split("\n")
    .map((line) => {
      const fact = /^(\s*(?:did|title|url|browser|earlier): )(".*")$/.exec(line);
      return fact ? `${fact[1]}${unquote(fact[2] as string)}` : line;
    })
    .join("\n");
}

/** A command that ran past the shell's limit said so; its answer comes with the next look. */
function stillRunning(text: string): boolean {
  const printed = shellOutput(text);
  return /^running: /m.test(printed) || /^code: BUSY$/m.test(printed);
}

/**
 * INF-634: the shell may legitimately become a job before the launcher
 * reaches the app, or after its bounded grace. Its receipt is not browser
 * output. Resume from that job's exit wake, never by sending the action again.
 * Keep message positions so handoff scripts can still slice at their wake.
 */
export function browserShellMessages(messages: ReturnType<typeof providerMessages>) {
  const pending = new Set<string>();
  const readings = messages.map((message) => {
    const job =
      message.role === "tool" ? /^Still running as background job (\S+);/.exec(message.text) : null;
    if (job) {
      pending.add(job[1] as string);
      return { role: "assistant" as const, text: "" };
    }
    if (message.role !== "user") return message;
    const wakes = parseServedInput(message.text)
      ?.filter((part) => part.kind === "wake")
      .map((part) => part.body) ?? [message.text];
    for (const wake of wakes) {
      const exit = /^\[job\] background job (\S+) finished:/.exec(wake);
      if (!exit || !pending.delete(exit[1] as string)) continue;
      const output = wake.indexOf(". Output tail:\n");
      return {
        role: "tool" as const,
        text: output < 0 ? wake : wake.slice(output + ". Output tail:\n".length),
      };
    }
    return message;
  });
  return { readings, pending: pending.size > 0 };
}

/** Stands for the part of a composer's words a reader looks for around them. */
const HOLE = "\u0000";

/** The job a bash answer says is still running, read in the bash tool's own words; none when it finished. */
function receiptJob(answer: string): string | undefined {
  const [before, after] = backgroundJobReceipt(HOLE).split(HOLE) as [string, string];
  const end = answer.startsWith(before) ? answer.indexOf(after, before.length) : -1;
  return end < 0 ? undefined : answer.slice(before.length, end);
}

/** Whether `wake` is job `id`'s exit, read in the wake renderer's own words. */
function exitOf(wake: string, id: string): boolean {
  const exit = renderWake({
    facts: {
      kind: "job-exit",
      to: "crewmate",
      jobId: id,
      command: HOLE,
      exitCode: 0,
      durationMs: 0,
    },
  });
  return wake.startsWith(exit.slice(0, exit.indexOf(HOLE)));
}

/**
 * Whether a shell command of this conversation is still running as a
 * background job: its receipt came back and no exit wake has followed yet,
 * across every message, so several jobs may end in one wake turn. A file a
 * stand-in wrote that way is not written until its job has exited (INF-1128).
 */
export function shellJobsRunning(body: string): boolean {
  const running = new Set<string>();
  for (const message of providerMessages(body)) {
    const job = message.role === "tool" ? receiptJob(message.text) : undefined;
    if (job) running.add(job);
    if (message.role !== "user") continue;
    const wakes = parseServedInput(message.text)
      ?.filter((part) => part.kind === "wake")
      .map((part) => part.body) ?? [message.text];
    for (const id of running) if (wakes.some((wake) => exitOf(wake, id))) running.delete(id);
  }
  return running.size > 0;
}

/**
 * The tool answers after a place in the conversation, oldest first, each
 * browser command once in the browser's own words: one that ran past a
 * Pi shell's limit answered `running`, and its answer came with the next
 * look (`earlier`), so the two read as the one answer the browser gave.
 */
export function toolAnswers(messages: ReturnType<typeof providerMessages>, from = 0): string[] {
  const answers: string[] = [];
  let waiting = false;
  for (const message of browserShellMessages(messages).readings.slice(from)) {
    if (message.role !== "tool") continue;
    if (!isBrowserAnswer(message.text)) {
      answers.push(message.text);
      continue;
    }
    if (stillRunning(message.text)) {
      waiting = true;
      continue;
    }
    const words = browserWords(message.text);
    if (waiting) {
      waiting = false;
      answers.push(
        words
          .replace(/^earlier: .*\n/m, "")
          .replace(
            /^Your earlier \S+ finished(?:, so this \S+ was not run; run it again if you still need it)?: /,
            "",
          ),
      );
      continue;
    }
    answers.push(words);
  }
  return answers;
}

/** The wake a returned browser brings, which the browser journeys read. */
export const HANDOFF_WAKE = BROWSER_RETURNED_OPENING;

/** The first sentence of an answer, as a report quotes it. */
export function firstSentence(text: string | undefined): string {
  const passage =
    (text ?? "").split("\n").find((line) => line.startsWith("The captain returned control")) ??
    (text ?? "").match(/^did: (.*)$/m)?.[1] ??
    text;
  return (passage ?? "").split("\n")[0]?.split(/(?<=[.:])\s/)[0] ?? "";
}

/** The tool answers after a place in the conversation, oldest first, as the scripts read them. */
export function answersAfter(
  messages: ReturnType<typeof providerMessages>,
  from: number,
): string[] {
  return toolAnswers(messages, from);
}

/**
 * The ref an outline gave a control, by its role and the start of its name;
 * `text` with no name finds the first cut passage, the one text line a ref names.
 */
export function refOf(outline: string | undefined, role: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return outline?.match(new RegExp(`${role} "${escaped}[^"]*" \\[(${REF_PATTERN})\\]`))?.[1];
}

/** A same-page action need not repeat unchanged controls. Keep refs only in the current book. */
export function knownRefOf(
  answers: readonly string[],
  role: string,
  name: string,
): string | undefined {
  const book = [...answers]
    .reverse()
    .map((text) => text.match(/^\s*refs: (g\d+)$/m)?.[1])
    .find(Boolean);
  for (const answer of [...answers].reverse()) {
    const current = answer
      .split("\n")
      .filter((line) => !line.startsWith("- old line "))
      .join("\n");
    const ref = refOf(current, role, name);
    if (ref && (!book || ref.startsWith(`${book}:`))) return ref;
  }
  return undefined;
}

/**
 * A browser journey's next step, looking again first while the crewmate's
 * last command still runs in its browser: a command past a Pi shell's
 * limit keeps running, and the bare command reads its answer.
 */
export function lookingAgain(
  body: string,
  step: (body: string) => ScriptedCall[] | undefined,
): ScriptedCall[] | undefined {
  const { readings, pending } = browserShellMessages(providerMessages(body));
  if (pending) return undefined;
  const last = readings.at(-1);
  if (last?.role === "tool" && isBrowserAnswer(last.text) && stillRunning(last.text)) {
    return [browser()];
  }
  return step(body);
}

/**
 * The task browser (docs/task-browser.md, task-browser e2e). A brief
 * carrying this marker, a page this Mac serves and a name ("check the
 * sign-up page at http://127.0.0.1:PORT/ as Sam") drives the task's own
 * browser the way a crewmate would: open it there, type the name into the
 * Name field by the ref the outline gave it, click Send by its ref, reload,
 * photograph the page, close the browser, and report what the page said at
 * each step - read off the tool results, never assumed.
 */
export const TASK_BROWSER_PROMPT_MARKER = "check the sign-up page at ";
export const MOCK_BROWSER_REPORT_PREFIX = "The sign-up page said";
export const MOCK_BROWSER_PICTURE = "signed-up";

/** The task browser's next scripted step, from the browser answers so far. */
function taskBrowserStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/check the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const found = (at: number, pattern: RegExp): string | undefined =>
    answers[at]?.match(pattern)?.[1];
  const missing = (what: string): ScriptedCall[] => [
    {
      name: "report",
      args: {
        text: `${MOCK_BROWSER_REPORT_PREFIX} nothing with ${what}: ${(answers.at(-1) ?? "").slice(0, 400)}`,
      },
    },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(answers[0], "textbox", "Name");
      return ref ? [browser("fill", `@${ref}`, name)] : missing("a Name field");
    }
    case 2: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("a Send button");
    }
    case 3: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("a Send button");
    }
    case 4:
      return [browser("reload")];
    case 5:
      return [browser("screenshot", MOCK_BROWSER_PICTURE)];
    case 6:
      return [browser("stop")];
    case 7: {
      const state = /text "((?:Not signed up yet|Signed up as [^"]+))"/;
      const first = found(0, state);
      const after = found(2, /text "(Thanks, [^"]+)"/);
      const reloaded = found(4, state);
      const reach = found(0, /text "(This page (?:cannot )?reach(?:es)? the app)"/);
      const privately = found(
        0,
        new RegExp(
          `Blocked what the page asked for on ${HERE.this}'s network or another private one: (.+?)\\. This`,
        ),
      );
      const plain = found(
        0,
        /Blocked what the page asked for from websites over plain http: (.+?)\. This/,
      );
      const local = found(
        0,
        new RegExp(
          `Blocked what the page asked for from other servers on ${HERE.this}: (.+?)\\. Open`,
        ),
      );
      const atConnection = answers[0]?.includes("refused at the connection")
        ? " at the connection"
        : "";
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_REPORT_PREFIX} "${first}" first, "${after}" after Send and "${reloaded}" after a reload, and "${reach}". It blocked ${privately} on a private network${atConnection}, ${plain} over plain http, and ${local} on this Mac. Browser answers:\n${answers.slice(0, 5).join("\n\n")}`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * A crewmate on a Mac with no git of its own on the search path (git
 * integration phase 2, app-git e2e): a brief carrying this marker runs
 * `git --version` and `git status` in its working copy, then reports the
 * version and the branch line that came back, verbatim.
 */
export const GIT_STATUS_PROMPT_MARKER = "say which git this project runs";
export const MOCK_GIT_REPORT_PREFIX = "The working copy's git answers";

/**
 * The deliverable axis (crew-posture rationalization Task B). A Firstmate
 * turn carrying "find out and answer:" spawns an investigation with the
 * typed `read-only` constraint, so the host derives `deliverable: answer`
 * from a fact rather than from the classifier's mood; the crewmate that
 * receives that brief lands ONE decision card carrying the answer and
 * reports. It emits no completion card and never commits: the brief told
 * it so, and the host refuses either way.
 */
/** Scripted retrieval exercises plumbing, not live semantic accuracy. */
export const RETRIEVAL_TASK_ASK =
  "Look up the version and demo support in meterlab's release-info.json, with a citation.";
export const RETRIEVAL_TASK_GOAL =
  "Read release-info.json and report its version and demo support with a citation; do not test playback.";

export const ANSWER_TASK_PROMPT_MARKER = "find out and answer:";
export const MOCK_ANSWER_CARD_TITLE = "The meter idles because the claim query filters on repo_id";
export const MOCK_ANSWER_ACTION_LABEL = "Fix the claim query";
const MOCK_ANSWER_CARD_BODY =
  "<p>The meter idles because the claim query filters on repo_id, and seven rows carry none.</p>" +
  "<p>Every idle row shares an empty repo_id; the sweep skips each one, so nothing is ever claimed.</p>" +
  "<details><summary>Evidence</summary><p>src/core/tasks/taskStore.ts listReady, line 211.</p></details>";
export const MOCK_ANSWER_REPORT =
  "The claim query filters on repo_id and seven idle rows carry none; the card shows where.";
/**
 * The captain's close reaches its crewmate (FI3-435). The answer-task
 * crewmate steered with the close of its card judges it read and finished
 * and reports so with `finished: true`; the mock Firstmate, woken by a
 * report that declared its work finished, closes the task the way its
 * instructions say - `settle_task answered` on an answer.
 */
export const CARD_CLOSED_STEER_NEEDLE = CARD_CLOSED_STEER_PREFIX.trim();
export const MOCK_ANSWER_FINISHED_REPORT =
  "The captain read the answer on the card, and nothing is left for me to do.";
export const FINISHED_WAKE_NEEDLE = FINISHED_REPORT_WORDS;

/**
 * Delivery rigor, phase 2 (the reviewed tier). A builder briefed with "ship
 * at the reviewed tier" on a direct-pr repository reports under the five
 * headings that its PR is green and emits NO card (its brief's rigor line
 * says so); when steered with the reviewer's auto-fix finding it reports the
 * fix and the new head; when told the review passed it emits the completion
 * card. The reviewer - recognised by the host's review brief - answers its
 * first brief with one auto-fix and one ask-user finding, and a re-review
 * steer with a pass. The mock Firstmate routes exactly as the contract's
 * rule says: read the wake's recorded checks, then spawn_crewmate with
 * review_of on the green report, the auto-fix as a steer plus one decision card for the ask-user
 * finding, and a steer to emit the completion card on the pass (the
 * repository's autonomy is off). The re-review is the captain's word in the
 * spec, so the merge hold can be observed in between.
 */
/**
 * The host-attached completion buttons and the freed body (contract v3.6,
 * captain lock 3). Briefed with this marker on a direct-pr repository, the
 * mock crewmate emits a completion card that declares ONE action - a merge
 * under a label of its own invention - and a body with the completion
 * outline and a figure rather than the five-heading report record. Both are
 * what the audit's
 * locks changed: the host writes the pair from the task's posture, and the
 * lint no longer asks a card for the record the report and the PR carry.
 */
export const STANDARD_TIER_HOST_BUTTONS_MARKER = "ship at the standard tier with host buttons";
/**
 * The autonomy hold (contract v3.9). Briefed with this marker, the mock
 * crewmate emits a completion card declaring the merge and reports - the
 * ordinary end of a direct-pr task. The task title carries the marker, so
 * the card's title carries it too and two tasks in one app never collide.
 * `AUTONOMY_ASK_MARKER` in the title is the captain's words on who merges,
 * which the mock Firstmate relays as `autonomy_ask: true`.
 */
export const AUTONOMY_PROMPT_MARKER = "ship and wait to be merged";
/** Short on purpose: a task title is capped at 64 characters. */
export const AUTONOMY_ASK_MARKER = "merge it yourself";
export const MOCK_AUTONOMY_CARD_TITLE = (title: string) => `Ready to merge - ${title}`;
export const MOCK_AUTONOMY_REPORT =
  "Intent: the meter reads on the first paint. What changed: the panel awaits the snapshot. Verified: pnpm test on the final commit; the PR is green. Risk: low. Not done: nothing.";

/**
 * Review carefully (INF-562). A spawn whose title carries this asks for the
 * standard tier; the careful builder and its review are
 * `scenarios/reviewCarefully.ts`.
 */
export const REVIEW_CAREFULLY_MARKER = "ship at default care, then review carefully";
/** A spawn whose title carries this asks for the reviewed tier; the reviewer itself is `scenarios/reviewedTier.ts`. */
export const REVIEWED_TIER_PROMPT_MARKER = "ship at the reviewed tier";
/** "merge the task <title>" -> settle_task merge-pr, so a held merge is observable. */
export const MERGE_PROMPT_MARKER = "merge the task ";
export const MOCK_FOLLOWUP_TITLE = "Flaky meter test";
export const MOCK_FOLLOWUP_GOAL = "The meter test passes ten runs in a row.";
export const MOCK_FOLLOWUP_WHY = "It failed twice while I ran the suite.";
export const MOCK_PROGRESS_TEXT = "Filed the follow-up; finishing the note now.";

/**
 * Persona detection: requests carry their session's system prompt, so the
 * persona line identifies who is asking (the Firstmate or a crewmate).
 */
export const FM_SYSTEM_MARKER = FIRSTMATE_PERSONA;

/**
 * A Claude crewmate's turn (mockClaudeClient.ts turn mode). A commission
 * whose title carries this phrase makes the mock Firstmate pin the spawn to
 * CLAUDE_CREW_MODEL through `override_model_id`. The crewmate behind it
 * emits one card, then its next step is held open - the model still
 * working - until the spec calls `releaseHeldCrew`, which answers it with a
 * progress note. A steer the captain sent meanwhile rides into the running
 * turn at that step; a request carrying CLAUDE_STEER_MARKER reports that it
 * heard the steer and closes. The hold is what makes "mid-turn" a fact
 * rather than a race.
 */
export const CLAUDE_CREW_PROMPT_MARKER = "on the Claude login";
export const CLAUDE_CREW_MODEL = `anthropic-claude/${starterFor("anthropic-claude", "low")}`;
/**
 * A commission whose title carries this is put on the Claude crew model
 * too, like CLAUDE_CREW_PROMPT_MARKER, without that marker's own script:
 * the rest of the title picks the crewmate's script, so one journey runs on
 * a Pi crewmate and a Claude crewmate alike (task-browser-booking.spec.ts).
 */
export const CLAUDE_CREWMATE_MARKER = "with a Claude crewmate";
export const MOCK_CLAUDE_CARD_TITLE = "Rivet count";
export const MOCK_CLAUDE_CARD_TEXT = "Forty rivets on the port hatch, all tight.";
export const CLAUDE_STEER_MARKER = "count the starboard hatch too";
export const MOCK_CLAUDE_STEERED_REPORT =
  "Counted the starboard hatch too, as steered: thirty-eight rivets, all tight.";
/** The progress note `releaseHeldCrew` answers the held step with. */
export const MOCK_CLAUDE_HELD_PROGRESS = "Counted the port hatch.";
/** A ready decision released by report while the client remains in its held step. */
export const CLAUDE_CARD_RETIRE_MARKER = "with a choice to retire";

/**
 * A Claude crewmate on a login its organisation refuses (W1 S8). A
 * commission whose title carries this phrase beside CLAUDE_CREW_PROMPT_MARKER
 * runs on Claude, and while the server refuses Claude (`refuseClaude`) every
 * turn it starts is answered with the vendor's organisation refusal: a 403
 * carrying CLAUDE_ORG_REFUSAL_MESSAGE, which the real client types
 * `oauth_org_not_allowed`. Once the server stops refusing, a turn carrying
 * CLAUDE_REFUSAL_OVER_MARKER reports MOCK_CLAUDE_REFUSAL_OVER_REPORT.
 */
export const CLAUDE_REFUSED_PROMPT_MARKER = "while refused";
export const CLAUDE_REFUSAL_OVER_MARKER = "count the rivets again now";
export const MOCK_CLAUDE_REFUSAL_OVER_REPORT =
  "Counted the rivets again once Claude answered: forty, all tight.";
/**
 * The refused-login crewmate with a card first (FI3-592, the thread's
 * waiting line): a commission whose title also carries this phrase puts up
 * MOCK_CLAUDE_HELD_CARD_TITLE on its first turn, while Claude still serves
 * it (the spec turns `refuseClaude` off first: the server starts refusing). A captain reply carrying CLAUDE_HELD_REPLY that gets through is
 * answered in the card's thread with MOCK_CLAUDE_HELD_ANSWER.
 */
export const CLAUDE_HELD_CARD_MARKER = "with a chart first";
export const MOCK_CLAUDE_HELD_CARD_TITLE = "Reef chart";
export const CLAUDE_HELD_REPLY = "chart the northern reef too";
export const MOCK_CLAUDE_HELD_ANSWER = "Charted the northern reef too: two shoals, both marked.";
/**
 * A Claude crewmate that relays a captain decision only the Firstmate can
 * carry out (FI3-710). A commission whose title carries this phrase beside
 * CLAUDE_CREW_PROMPT_MARKER puts up MOCK_CLAUDE_PLAN_CARD_TITLE, a decision
 * with two actions, and reports. A captain reply carrying
 * CLAUDE_RELAY_APPROVAL is answered with one thread line
 * (MOCK_CLAUDE_RELAY_ANSWER), the card left as it is, and a report that
 * quotes his words and declares needs_firstmate (MOCK_CLAUDE_RELAY_ASK).
 */
export const CLAUDE_RELAY_MARKER = "with a plan to approve";
export const MOCK_CLAUDE_PLAN_CARD_TITLE = "Raise the rivet threshold";
export const MOCK_CLAUDE_PLAN_REPORT = "The plan to raise the rivet threshold is on its card.";
export const CLAUDE_RELAY_APPROVAL =
  "for decision 5, raise the threshold from 8 to 32. now approve to build";
export const MOCK_CLAUDE_RELAY_ANSWER =
  "The first mate starts the builder next, with the threshold at 32.";
export const MOCK_CLAUDE_RELAY_ASK = "start the builder on the approved plan, threshold 32";
export const MOCK_CLAUDE_RELAY_REPORT = `The captain approved the plan by reply: "${CLAUDE_RELAY_APPROVAL}". The final plan keeps every decision, with the threshold at 32.`;
/** The words the vendor's organisation refusal carries; the client types it by them. */
export const CLAUDE_ORG_REFUSAL_MESSAGE =
  "OAuth authentication is currently not allowed for this organization.";

/**
 * The Firstmate on the Claude seat (W1 S12). A captain turn carrying
 * FM_SEAT_HOLD_MARKER looks at the crew, then its next step is held open -
 * the model still working - until the spec calls `releaseHeldFirstmate`,
 * which answers it with another look at the crew. A steer the captain sent
 * meanwhile rides into the running turn at that step; a request carrying
 * FM_SEAT_STEER_WORD answers with the FM_SEAT_STEERED_TITLE card.
 */
export const FM_SEAT_HOLD_MARKER = "keep looking at the crew";
export const FM_SEAT_STEER_WORD = "and check the anchor chain";
export const FM_SEAT_STEERED_TITLE = "Anchor chain checked";

/**
 * A Claude seat cut off (`cutClaudeSeat`): the typed refusal every
 * Firstmate request the Claude client makes meets, per class - the
 * vendor's 401, a 429 on a spent plan with its reset, or its 403
 * organisation refusal.
 */
export type ClaudeSeatCut =
  | { class: "signed_out" }
  | { class: "no_headroom"; resetsAt: number }
  | { class: "refused" };

/**
 * Orchestrator markers. "commission a crewmate: <title>" makes the mock
 * Firstmate call spawn_crewmate with that title (bound to a registered repo
 * when the title names one from the context block); "answer with a card"
 * makes it emit one note answer card. The fleet markers drive the
 * agent-operated fleet: "manage my folder at <path>" (app_change project-setup adopt),
 * "manage the remote repository at <url>" (app_change project-setup clone), "start a new
 * project <name>" (app_change project-setup init), "make the repository <name>
 * autonomous" (configure_repo), and "unregister the repository <name>"
 * (app_change project-remove). Anything else is chit-chat: plain text that the app
 * does not map to a feed line or a card.
 */
export const FILE_TASK_PROMPT_MARKER = "file a task:";
// e2e-typed-words: the captain's own words that start a scripted spawn; they only share a phrase with the product's
export const SPAWN_PROMPT_MARKER = "commission a crewmate:";
export const ADOPT_REPO_PROMPT_MARKER = "manage my folder at ";
export const CLONE_REPO_PROMPT_MARKER = "manage the remote repository at ";
export const INIT_REPO_PROMPT_MARKER = "start a new project ";
// e2e-typed-words: the captain's own words that ask the mock for an answer card; they only share a phrase with the product's
export const ANSWER_PROMPT_MARKER = "answer with a card";
export const TALL_ANSWER_PROMPT_MARKER = `a tall ${ANSWER_PROMPT_MARKER}`;
/**
 * The first-launch welcome wake (docs/first-launch.md): the host's wake
 * says the captain "has never seen a card", and the mock Firstmate answers
 * it with one standalone note - the app's first card.
 */
export const FIRST_RUN_WAKE_MARKER = WELCOME_WAKE_WORDS;
export const MOCK_WELCOME_TITLE = "How I work";
// e2e-typed-words: the mock Firstmate's own welcome note, written as the wake asks; it only shares a phrase with the wake
export const MOCK_WELCOME_TEXT =
  "<p>Ask for something and a card comes back: an answer, a decision, or word that a crewmate is on it. There is no chat to scroll.</p><p>Start by pointing me at a project.</p>";
/**
 * The mock Firstmate asked to remember a fact where knowledge is on: it
 * tries remember, and on the refusal records the fact with record_knowledge.
 */
export const KNOWLEDGE_FACT_PROMPT_MARKER = "remember that deploys happen on tuesdays";
/**
 * Talk-to-personalize Step 1 (Tier A): the mock Firstmate answers each of
 * these with ONE app_change call and no card, the way the contract says.
 */
export const APP_CATALOG_PROMPT_MARKER = "catalog change ";
export const PERSONALIZE_THEME_PROMPT_MARKER = "switch to light";
/**
 * Install by talking (one plugin vehicle, Phase A): "add the panel from
 * <full folder path>" -> ONE install_plugin call naming that folder, and no
 * card of the Firstmate's own - the host's consent card is the only one.
 */
export const ADD_PANEL_PROMPT_MARKER = "add the panel from ";
/** Provider-failure markers: the mock rejects the request itself, so the
 * turn ends with Pi's stopReason "error" path (report REPRO A). */
export const FAIL_AUTH_PROMPT_MARKER = "fail this turn with a 401";
export const FAIL_PROVIDER_PROMPT_MARKER = "fail this turn with a provider error";
export const LAND_PROMPT_MARKER = "land the task ";
/** Steer marker: "steer the task <title>: <guidance>" -> steer_crewmate on that task. */
export const STEER_PROMPT_MARKER = "steer the task ";
/**
 * Every request answering a message that carries this phrase reports a huge
 * token count (past the token flicker's top), so the character that spent it
 * flickers at full brightness; every other request reports a few dozen.
 */
export const BIG_USAGE_PROMPT_MARKER = "a mountain of tokens";
export const DISCARD_PROMPT_MARKER = "discard the task ";
/**
 * "finish the task <title>" -> settle it. WI-11 retired the `finish` mode
 * and the `delivered` status, so the mock now lands the task (the successor
 * close for an idle crewmate whose work is accepted): a scratch task lives
 * in the app-managed default repo, so landing its unchanged branch is a
 * clean fast-forward that closes the record as done/landed.
 */
export const FINISH_PROMPT_MARKER = "finish the task ";
export const CANCEL_PROMPT_MARKER = "cancel the task ";
/**
 * The mock Firstmate's one sentence for each close of started work it makes
 * (INF-547): the tools refuse such a close without one, and a close that
 * leaves nothing of the task on the stack puts it up as the Firstmate's note.
 */
export const MOCK_CLOSING_SENTENCES = {
  "merge-pr": "The pull request is merged, as the captain asked.",
  land: "The branch is merged into the project, as the captain asked.",
  discard: "Not needed any more, as the captain asked.",
  released: "It went out in the verified external release.",
  cancel: "Stopped, as the captain asked.",
} as const;
/**
 * A crewmate that makes one real change: a brief carrying "write the file
 * <path> with <text>" writes <text> into <path> in its working copy with
 * Pi's own write tool, then reports. The change is left uncommitted, the
 * way a crewmate stopped mid-work leaves it, so whatever reads the working
 * copy afterwards reads the tree, not only the branch.
 */
export const WRITE_FILE_PROMPT_MARKER = "write the file ";
export const MOCK_WRITE_FILE_REPORT = "Wrote the file the task asked for.";
/** The tool boundary's refusal, as the spec looks for it in the served body. */
export const ESCALATION_REFUSAL_PHRASE = NOTHING_SPAWNED;
/**
 * The talk-to-personalize build loop (Step 4). "make me a panel: <title>"
 * makes the mock Firstmate spawn with personal_ui true; "change my panel
 * <id>: <ask>" spawns a personal_ui change naming the surface; "remove my
 * panel <id>" is the Tier A `personalize remove`. The mock crewmate, on a
 * brief whose delivery is live, writes the extension with Pi's own write
 * tool, runs lint_panel and capture_panel on the draft, places its version
 * on the rail with place_panel, photographs it there with capture_panel
 * again, and reports after a short delay so the running dot is observable;
 * on the change brief it rewrites the panel with smaller rows, captures,
 * places and captures it again, and reports after the same delay, so a
 * spec can watch the rails while the change is underway.
 */
export const PERSONAL_PANEL_PROMPT_MARKER = "make me a panel:";
export const PERSONAL_REMOVE_PROMPT_MARKER = "remove my panel ";
export const MOCK_PANEL_ID = "tokyo-clock";
export const MOCK_PANEL_TITLE = "Tokyo clock";
export const MOCK_PANEL_REPORT =
  "Tokyo clock panel added; it shows the time in Tokyo and how many lines the activity feed holds.";
export const MOCK_PANEL_REVISED_REPORT = "The Tokyo clock rows are smaller now.";
export const MOCK_PANEL_REPORT_DELAY_MS = 2_500;
/**
 * What tells the mock crewmate its task builds in place: the personal
 * workspace's own brief sentence. It read `Delivery: live` until the
 * crew-posture rationalization's Task A made the workspace a KIND - a
 * personal brief carries no Delivery line at all now.
 */
const LIVE_BRIEF_MARKER = `${BUILD_IN_PLACE_OPENING}:`;
const ROWS_SMALLER_MARKER = "rows smaller";

function mockPanelSource(rows: "regular" | "small"): string {
  return [
    'import type { PanelFeedLine, PanelProps } from "@infinitary/contracts";',
    'import { MicroLabel, Row } from "@infinitary/ui";',
    'import { useEffect, useState } from "react";',
    "",
    'const clock = new Intl.DateTimeFormat("en-GB", {',
    '  timeZone: "Asia/Tokyo",',
    '  hour: "2-digit",',
    '  minute: "2-digit",',
    "});",
    "",
    "export default function Panel({ reads }: PanelProps) {",
    "  const [lines, setLines] = useState<PanelFeedLine[]>([]);",
    '  useEffect(() => reads.subscribe("feed.recent", setLines), [reads]);',
    "  return (",
    "    <div",
    '      data-mock-panel=""',
    `      data-mock-rows="${rows}"`,
    `      style={{ display: "flex", flexDirection: "column", gap: "${rows === "small" ? "var(--space-1)" : "var(--space-2)"}" }}`,
    "    >",
    "      <MicroLabel count={lines.length}>Activity</MicroLabel>",
    `      <Row title="Tokyo" tone="idle" trailing={clock.format(Date.now())}${rows === "small" ? ' style={{ padding: "1px 6px" }}' : ""} />`,
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n");
}

// No placement: the panel lands where a panel that names none does.
const MOCK_PANEL_MANIFEST = `${JSON.stringify(
  {
    title: MOCK_PANEL_TITLE,
    reads: ["feed.recent"],
  },
  null,
  2,
)}\n`;

/**
 * The Responses dialect Codex's client speaks (`POST .../codex/responses`,
 * server-sent events), for a Firstmate seat moved onto Codex. Its client
 * tries a WebSocket first; this server takes no upgrade, so the client falls
 * back to these events, as it does wherever a socket cannot open.
 */
function writeResponsesEvent(
  res: ServerResponse,
  data: { type: string } & Record<string, unknown>,
) {
  res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function beginResponsesStream(res: ServerResponse, request: number): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  writeResponsesEvent(res, {
    type: "response.created",
    response: { id: `resp_mock_${request}`, status: "in_progress" },
  });
}

function finishResponsesStream(
  res: ServerResponse,
  request: number,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  writeResponsesEvent(res, {
    type: "response.completed",
    response: {
      id: `resp_mock_${request}`,
      status: "completed",
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
    },
  });
  res.end();
}

/**
 * The prefix Claude's client serves an in-process tool under: the app's
 * tool server is named `infinitary`, so `emit_card` reaches the model as
 * `mcp__infinitary__emit_card` (docs/claude-client.md). The scripts name
 * tools as the app does; the Anthropic dialect adds the prefix where the
 * request declared it, so one marker drives a Pi turn and a Claude turn.
 */
const CLAUDE_TOOL_PREFIX = CLAUDE_SEAT_TOOL_PREFIX;

/** Claude's client serves its own shell to a coding session as `Bash`, where Pi serves `bash`. */
const CLAUDE_SHELL = "Bash";

/** The name a scripted call goes out under: the way the request serves the tool. */
function servedToolName(body: string, name: string): string {
  const prefixed = `${CLAUDE_TOOL_PREFIX}${name}`;
  if (body.includes(`"name":"${prefixed}"`)) return prefixed;
  if (name === "bash" && body.includes(`"name":"${CLAUDE_SHELL}"`)) return CLAUDE_SHELL;
  return name;
}

/** Whether the conversation so far carries a CALL of the named tool (not its definition). */
export function calledTool(body: string, name: string): boolean {
  return toolCallCount(body, name) > 0;
}

/** How many CALLs of the named tool the conversation so far carries (not its definition). */
function toolCallCount(body: string, name: string): number {
  let count = 0;
  for (const served of [name, `${CLAUDE_TOOL_PREFIX}${name}`]) {
    for (const call of [
      `"name":"${served}","arguments"`,
      `"name": "${served}", "arguments"`,
      // Anthropic messages calls carry `input`; definitions carry `input_schema`.
      `"name":"${served}","input":`,
      `"name": "${served}", "input":`,
    ]) {
      count += body.split(call).length - 1;
    }
  }
  return count;
}

/**
 * Pi 0.87's OpenRouter catalog serves Claude models on anthropic-messages.
 * The mock still decides from the raw body (the markers are in the text);
 * only the wire format changes (`tests/helpers/anthropicDialect.ts`). A
 * follow-up leg carries `tool_use_id`.
 */
/** The kind classifier's system prompt (routing S3), recognised by its opening. */
export const CLASSIFIER_SYSTEM_MARKER = KIND_CLASSIFIER_OPENING;
/** Work whose title carries this is sorted as a chore by the mock classifier. */
export const CLASSIFY_CHORE_MARKER = "tidy the rivet gauge";
export const MOCK_ANSWER_TITLE = "Mock answer";
export const MOCK_ANSWER_TEXT = "Codex has 62% of the weekly window left and is on pace.";
export const MOCK_FM_CHAT_TEXT = "All quiet on deck.";

/**
 * Answer delivery (docs/task-capture.md): a captain message the mock answers
 * with hidden closing words only. The retry then shows one answer card
 * (default), nothing at all (`RETRY_SILENT_MARKER`) or tries to put work on
 * the record, which the retry refuses (`RETRY_ACTS_MARKER`).
 */
export const SILENT_ANSWER_MARKER = "say nothing the captain can see";
/** A captain message the mock acknowledges with a reaction, which covers it. */
export const REACT_PROMPT_MARKER = "give a thumbs up";
export const RETRY_SILENT_MARKER = "stay silent again";
export const RETRY_ACTS_MARKER = "try to start work in the retry";
export const RETRY_ACTS_TASK_TITLE = "Work the retry tried to start";
export const RETRY_ANSWER_TITLE = "Here is the answer";
const RETRY_ANSWER_BODY = "<p>The retry showed this answer in a card.</p>";
/** Closing words with markup and a script, which must never become a card. */
export const SILENT_CLOSING_WORDS = "<p>HIDDEN closing words</p><script>alert(1)</script>";
export const MOCK_FM_DONE_TEXT = "The crew has it under way.";

/** The class the preview's own stylesheet lays its row of choices out by. */
const MOCK_PROTOTYPE_ROW_CLASS = "course-row";
/**
 * A working preview, which is what a decision body may be: it brings a
 * stylesheet of its own, in ordinary CSS the token-only document profile
 * would strip.
 */
export const MOCK_PROTOTYPE_HTML = [
  `<style>.${MOCK_PROTOTYPE_ROW_CLASS}{display:flex;gap:14px;padding:6px 0}</style>`,
  "<h2>Course options</h2>",
  '<p class="inf-muted">Pick a heading; this preview is sandboxed.</p>',
  `<div class="${MOCK_PROTOTYPE_ROW_CLASS}">`,
  '<button type="button" data-inf-action="hold-course">Hold course</button>',
  '<button type="button" data-inf-action="new-course">Plot new course</button>',
  "</div>",
].join("");

export const MOCK_LONG_ACTION_LABEL =
  "Mock the clock while preserving every queued write in its original execution order";

/** The card-kinds crewmate's three cards (`EMIT_CARDS_PROMPT_MARKER`): its decision, its note and its working preview. */
export const MOCK_CHOICE_CARD_TITLE = "Two ways to fix the flaky test";
export const MOCK_QUOTA_NOTE_TITLE = "Quota note";
export const MOCK_PREVIEW_CARD_TITLE = "Course preview";

/** The decision the card-kinds crewmate shows first. */
const MOCK_CHOICE_CARD = {
  name: "emit_card",
  args: {
    title: MOCK_CHOICE_CARD_TITLE,
    body:
      "<p>Awaiting the job queue removes the race entirely.</p>" +
      '<p class="inf-muted">Mocking time leaves write order uncertain.</p>' +
      '<figure><svg viewBox="0 0 320 62" width="100%" role="img" ' +
      'aria-label="Mock clock can leave the race">' +
      '<rect x="4" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--bg-1);stroke:var(--line-2)"></rect>' +
      '<rect x="180" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--accent-dim);stroke:var(--accent)"></rect>' +
      '<path d="M140 31 H174 M166 25 L174 31 L166 37" fill="none" ' +
      'style="stroke:var(--fg-2)"></path>' +
      '<g font-size="14" text-anchor="middle" style="fill:var(--fg-1)">' +
      '<text x="72" y="36">Mock clock</text><text x="248" y="36">Race can return</text>' +
      "</g></svg></figure>" +
      '<p class="inf-muted">Awaiting the queue orders both writes.</p>' +
      '<figure><svg viewBox="0 0 320 62" width="100%" role="img" ' +
      'aria-label="Await queue orders the writes">' +
      '<rect x="4" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--bg-1);stroke:var(--line-2)"></rect>' +
      '<rect x="180" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--accent-dim);stroke:var(--accent)"></rect>' +
      '<path d="M140 31 H174 M166 25 L174 31 L166 37" fill="none" ' +
      'style="stroke:var(--fg-2)"></path>' +
      '<g font-size="14" text-anchor="middle" style="fill:var(--fg-1)">' +
      '<text x="72" y="36">Await queue</text><text x="248" y="36">Ordered writes</text>' +
      "</g></svg></figure>" +
      "<details><summary>Latency trade-off</summary>" +
      "<p>Awaiting the queue adds 40ms to the run.</p></details>",
    actions: [
      { id: "mock-clock", label: MOCK_LONG_ACTION_LABEL },
      { id: "await-queue", label: "Await the queue", default: true },
    ],
  },
} satisfies ScriptedCall;

const MOCK_TOOL_CALLS = [
  MOCK_CHOICE_CARD,
  {
    name: "emit_card",
    args: {
      id: "quota-note",
      title: MOCK_QUOTA_NOTE_TITLE,
      body:
        '<p>Codex weekly at <span class="inf-mono">41%</span> - routing stays put.</p>' +
        '<svg viewBox="0 0 200 8" width="100%" role="img" aria-label="Codex weekly quota">' +
        '<rect width="200" height="8" rx="4" style="fill:var(--bg-3)"></rect>' +
        '<rect width="82" height="8" rx="4" style="fill:var(--accent)"></rect></svg>' +
        "<details><summary>Windows</summary><h6>Weekly</h6>" +
        "<p><mark>41%</mark> used, resets Fri.</p></details>",
    },
  },
  {
    name: "emit_card",
    args: {
      // A working preview is a decision whose body is interactive: the card
      // that shows the thing carries the choice about it (its actions are
      // what make it a decision - nothing on the wire declares a kind).
      title: MOCK_PREVIEW_CARD_TITLE,
      body: MOCK_PROTOTYPE_HTML,
      actions: [
        { id: "hold-course", label: "Hold course" },
        { id: "new-course", label: "Plot new course", default: true },
      ],
    },
  },
] satisfies ScriptedCall[];

/** The step goal a sequences reproduce step carries; the kind classifier sorts it (`scenarios/sequences.ts`). */
export const SEQ_REPRODUCE_GOAL =
  "as reported, in a clean setup; open your report with reproduced:";

export type ChatRequest = { messages?: { role: string; content?: unknown }[] };

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      (part as { type?: string; text?: string }).type === "text"
        ? ((part as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * A message's tool results, in order: a `tool` message's text, or the
 * `tool_result` blocks the Anthropic dialect carries in a user message.
 */
export function toolResults(message: { role: string; content?: unknown }): string[] {
  if (message.role === "tool") return [messageText(message.content)];
  if (message.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part) => (part as { type?: string }).type === "tool_result")
    .map((part) => messageText((part as { content?: unknown }).content));
}

/** A note Claude's client adds to a message on its own (`<system-reminder>`), never anyone's words. */
const CLIENT_NOTE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/** A message's text, the client's own notes aside. */
function saidIn(content: unknown): string {
  if (!Array.isArray(content)) return messageText(content);
  return messageText(
    content.filter((part) => !CLIENT_NOTE.test((part as { text?: string }).text ?? "")),
  );
}

/**
 * The newest user message's text and the tool results that followed it, in
 * order. A user message that carries tool results and nobody's words (the
 * Anthropic dialect's) is a step of that turn, not a new one.
 */
export function sinceLastUser(body: string): { user: string; results: string[]; tail: string } {
  if (!body.trimStart().startsWith("{")) return { user: "", results: [], tail: "" };
  const messages = (JSON.parse(body) as ChatRequest).messages ?? [];
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const step = message && toolResults(message).length > 0 && !saidIn(message.content);
    if (message?.role === "user" && !step) {
      at = index;
      break;
    }
  }
  if (at < 0) return { user: "", results: [], tail: "" };
  return {
    user: messageText(messages[at]?.content),
    tail: JSON.stringify(messages.slice(at)),
    results: messages.slice(at + 1).flatMap(toolResults),
  };
}

/** The instructions a request carries (system or developer), whichever dialect. */
export function servedInstructions(body: string): string {
  if (!body.trimStart().startsWith("{")) return "";
  const request = JSON.parse(body) as {
    system?: unknown;
    instructions?: unknown;
    messages?: { role: string; content?: unknown }[];
  };
  const roles = new Set(["system", "developer"]);
  return [
    request.system,
    request.instructions,
    ...(request.messages ?? []).filter((m) => roles.has(m.role)).map((m) => m.content),
  ]
    .map(messageText)
    .join("\n");
}

/** A task's id off the current context block's task index, by its exact title. */
export function indexTaskId(body: string, title: string): string | undefined {
  for (const line of latestContext(body)?.task_index ?? []) {
    if (!line.includes(`"${title}"`)) continue;
    const id = line.match(/\(task_id: ([\w-]+)\)/)?.[1];
    if (id) return id;
  }
  return undefined;
}

export type { ScriptedCall } from "../helpers/scriptedCalls";

/**
 * What became of a Firstmate turn a spec scripted ahead: `armed` until its
 * input is served, `answered` once its calls went out, `closed` once their
 * results came back. `unmatched` is the bounded diagnostic - the other
 * inputs the Firstmate was served while it waited, newest last - and
 * `results` what came back for its calls.
 */
export type ScriptedTurnOutcome = {
  state: "armed" | "answered" | "closed";
  unmatched: string[];
  results: string[];
};

/** How many unmatched inputs a scripted turn keeps, and how much of each. */
const SCRIPTED_DIAGNOSTIC_LIMIT = 5;
const SCRIPTED_DIAGNOSTIC_CHARS = 240;

const clipped = (text: string) =>
  text.length > SCRIPTED_DIAGNOSTIC_CHARS ? `${text.slice(0, SCRIPTED_DIAGNOSTIC_CHARS)}...` : text;

/** A served turn, in brief: who each non-context segment came from and what it opens with. */
function servedSummary(turn: ServedTurn | undefined): string {
  if (!turn) return "(an input the host did not frame)";
  const parts = turn.segments
    .filter((segment) => segment.kind !== "context")
    .map((segment) => `${segment.kind} ${segment.origin ?? "(no origin)"}: ${segment.body}`);
  return clipped(parts.join(" | ") || "(context only)");
}

/** What a journey's scenario reads of one request. */
export type ScenarioRequest = {
  body: string;
  isFirstmate: boolean;
  wantsStream: boolean;
  latestUserTail: string;
  hasToolResults: boolean;
  /** The stand-in's own port, for a card that loads a page the stand-in serves. */
  port: number;
};
/**
 * A scenario's answer: tool calls, text, or a refusal the way the service
 * sends one, or `held`, a turn the stand-in keeps open the way a crewmate
 * goes on working. `afterMs` holds the answer back that long, the way a real
 * model takes its time over a turn's last line.
 */
export type ScenarioAnswer = (
  | { calls: ScriptedCall[] }
  | { text: string }
  | { refusal: { status: number; error: { type: string; message: string } } }
  | { held: true }
) & { afterMs?: number };
/**
 * A journey's own stand-in behavior, in its own file under
 * `tests/e2e/scenarios/` (`docs/testing.md`, "A journey's own scenarios").
 * The stand-in starts each named scenario once, so its state lives as long
 * as that stand-in, and asks the answerers in the order named; an
 * answerer returns undefined to pass the request on.
 */
export type Scenario = () => (request: ScenarioRequest) => ScenarioAnswer | undefined;

export type MockProviderServer = {
  port: number;
  requests: () => number;
  /** Observe decoded requests, including history, without retaining authentication headers. */
  recordRequests: (record: (body: string) => void) => () => void;
  /** Reject every Firstmate inference, including any unexpected setup composition. */
  failFirstmate: (fail: boolean) => void;
  /** Raw completion request bodies, oldest first (contract tests). */
  requestBodies: () => string[];
  /** The headers of each completion request, in the same order as requestBodies. */
  requestHeaders: () => IncomingHttpHeaders[];
  /** Requests that reached CARD_FETCH_PROBE_PATH (a scripted card must never land one). */
  cardFetchProbeHits: () => number;
  /** Crewmate steps held open right now, a turn waiting on the model (CLAUDE_CREW_PROMPT_MARKER). */
  heldRequests: () => number;
  /** Answer every held crewmate step with a progress note (MOCK_CLAUDE_HELD_PROGRESS). */
  releaseHeldCrew: () => void;
  /** Refuse the refused-login crewmate's turns (CLAUDE_REFUSED_PROMPT_MARKER), or stop. */
  refuseClaude: (refusing: boolean) => void;
  /** Cut the Firstmate's Claude seat off with a class's typed refusal, or stop (null). */
  cutClaudeSeat: (cut: ClaudeSeatCut | null) => void;
  /** Firstmate steps held open right now (FM_SEAT_HOLD_MARKER). */
  heldFirstmate: () => number;
  /** Answer every held Firstmate step with another look at the crew. */
  releaseHeldFirstmate: () => void;
  /** Thread-crewmate steps held after an acknowledgement (THREAD_ACK_REPLY). */
  heldThreadAnswers: () => number;
  /** Let every held thread answer go on: the revision, then the report. */
  releaseThreadAnswer: () => void;
  /**
   * Script the Firstmate's answer to one input the spec knows ahead: when a
   * Firstmate turn's newest served input holds exactly this segment - kind,
   * origin and body, as `captainCardChoice` renders it - the mock answers
   * with these calls, once, and closes the loop briefly. Nothing else
   * answers it, and no phrase in a body is read. The outcome is the spec's
   * checkpoint.
   */
  scriptFirstmateTurn: (
    input: ServedSegment,
    calls: ScriptedCall[],
  ) => { outcome: () => ScriptedTurnOutcome };
  close: () => Promise<void>;
};

function contextCrew(body: string) {
  return latestContext(body)?.crew ?? [];
}

export function contextRepos(body: string): Array<[name: string, id: string]> {
  return (latestContext(body)?.repos ?? []).map((repo) => [repo.name, repo.repo_id]);
}

export function findCrewTaskId(body: string, titleNeedle: string): string | undefined {
  const needle = titleNeedle.trim();
  return needle
    ? contextCrew(body).find((entry) => entry.title.includes(needle))?.task_id
    : undefined;
}

export function settleNeedle(haystack: string, marker: string): string {
  const after = haystack.split(marker)[1] ?? "";
  return after.split(/["\\]/)[0]?.trim() ?? "";
}

export async function startMockProvider(
  options: { scenarios?: readonly Scenario[] } = {},
): Promise<MockProviderServer> {
  const scenarios = (options.scenarios ?? []).map((start) => start());
  let requestCount = 0;
  let failFirstmate = false;
  let cardFetchProbeHits = 0;
  const requestBodies: string[] = [];
  const recorders = new Set<(body: string) => void>();
  const requestHeaders: IncomingHttpHeaders[] = [];
  /** Held crewmate steps, each with the request that opened it. */
  const held = new Map<ServerResponse, { body: string; request: number }>();
  /** The thread crewmate's work after its acknowledgement, waiting on the spec. */
  const heldThreadAnswers: (() => void)[] = [];
  let refusingClaude = true;
  let seatCut: ClaudeSeatCut | null = null;
  /** Held Firstmate steps, each with the request that opened it. */
  const heldFirstmate = new Map<ServerResponse, { body: string; request: number }>();
  /** The Firstmate turns a spec scripted ahead (`scriptFirstmateTurn`), oldest first. */
  const scripted: Array<{
    input: ServedSegment;
    calls: ScriptedCall[];
    outcome: ScriptedTurnOutcome;
  }> = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "HEAD" && req.url === "/api/hello") {
      // Claude's client checks it can reach its API before a session starts.
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url?.startsWith(CARD_FETCH_PROBE_PATH)) {
      // A scripted card that could reach the network would land here.
      cardFetchProbeHits += 1;
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("reached");
      return;
    }
    const anthropicMessages =
      req.method === "POST" &&
      Boolean(req.url?.includes("/messages")) &&
      !req.url?.includes("/chat/completions");
    const codexResponses = req.method === "POST" && Boolean(req.url?.includes("/codex/responses"));
    if (
      req.method === "POST" &&
      (req.url?.includes("/chat/completions") || anthropicMessages || codexResponses)
    ) {
      requestCount += 1;
      const requestNumber = requestCount;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        // Codex's client compresses its request body (zstd); read it plain.
        const raw = Buffer.concat(chunks);
        const body = (
          req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw
        ).toString("utf8");
        requestBodies.push(body);
        for (const record of recorders) record(body);
        requestHeaders.push(req.headers);
        const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
        const isFirstmate = body.includes(FM_SYSTEM_MARKER);
        // The body carries the whole conversation history, so every check
        // scopes to what follows the LATEST user message: markers from old
        // turns must not re-trigger, and tool results count only when this
        // request is the follow-up leg of the current tool loop.
        const lastUserIndex = Math.max(
          body.lastIndexOf('"role":"user"'),
          body.lastIndexOf('"role": "user"'),
        );
        const latestUserTail = lastUserIndex >= 0 ? body.slice(lastUserIndex) : body;
        const usage = latestUserTail.includes(BIG_USAGE_PROMPT_MARKER)
          ? { prompt_tokens: 600_000, completion_tokens: 4_000, total_tokens: 604_000 }
          : { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 };
        const hasToolResults =
          latestUserTail.includes('"tool_call_id"') ||
          latestUserTail.includes('"tool_use_id"') ||
          latestUserTail.includes('"function_call_output"');

        const streamToolCalls = (scripted: ScriptedCall[]) => {
          // A crewmate's completion decision carries its risk, as the real
          // tool asks; the Firstmate's cards carry none.
          const calls = isFirstmate ? scripted : scripted.map(withDeclaredRisk);
          if (codexResponses) {
            beginResponsesStream(res, requestNumber);
            calls.forEach((call, index) => {
              const item = {
                type: "function_call",
                id: `fc_${requestNumber}_${index + 1}`,
                call_id: `call_${requestNumber}_${index + 1}`,
                name: call.name,
              };
              const args = JSON.stringify(call.args);
              writeResponsesEvent(res, {
                type: "response.output_item.added",
                output_index: index,
                item: { ...item, arguments: "" },
              });
              writeResponsesEvent(res, {
                type: "response.function_call_arguments.delta",
                output_index: index,
                delta: args,
              });
              writeResponsesEvent(res, {
                type: "response.output_item.done",
                output_index: index,
                item: { ...item, arguments: args },
              });
            });
            finishResponsesStream(res, requestNumber, usage);
            return;
          }
          if (anthropicMessages) {
            beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            calls.forEach((call, index) => {
              writeAnthropicToolUse(res, index, {
                id: `toolu_${requestNumber}_${index + 1}`,
                name: servedToolName(body, call.name),
                args: call.args,
              });
            });
            finishAnthropicStream(res, "tool_use", usage.completion_tokens);
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const base = {
            id: "chatcmpl-mock-tools",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: MOCK_MODEL_ID,
          };
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          calls.forEach((call, index) => {
            chunk({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: `call_${requestNumber}_${index + 1}`,
                        type: "function",
                        function: { name: call.name, arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            chunk({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }],
                  },
                  finish_reason: null,
                },
              ],
            });
          });
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage,
          });
          res.write("data: [DONE]\n\n");
          res.end();
        };

        const streamText = (text: string) => {
          if (codexResponses) {
            beginResponsesStream(res, requestNumber);
            const item = { type: "message", id: `msg_${requestNumber}`, role: "assistant" };
            writeResponsesEvent(res, {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            });
            writeResponsesEvent(res, {
              type: "response.output_text.delta",
              output_index: 0,
              delta: text,
            });
            writeResponsesEvent(res, {
              type: "response.output_item.done",
              output_index: 0,
              item: { ...item, content: [{ type: "output_text", text }] },
            });
            finishResponsesStream(res, requestNumber, usage);
            return;
          }
          if (anthropicMessages) {
            beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            writeAnthropicText(res, 0, text);
            finishAnthropicStream(res, "end_turn", usage.completion_tokens);
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const base = {
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: MOCK_MODEL_ID,
          };
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
            chunk({
              ...base,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            });
          }
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        };

        // A crewmate's step left waiting on the model: the response starts
        // and never ends, until the spec releases it (`releaseHeldCrew`),
        // the client closes it, or the server does.
        const holdOpen = () => {
          if (anthropicMessages) beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
          else res.writeHead(200, { "Content-Type": "text/event-stream" });
          held.set(res, { body, request: requestNumber });
          res.on("close", () => held.delete(res));
        };

        if (isFirstmate && failFirstmate) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "mock deterministic inference failure", type: "mock_error" },
            }),
          );
          return;
        }

        // Provider failures: reject the HTTP request itself. Pi converts
        // these into an assistant message with stopReason "error" and
        // RESOLVES the turn - the exact silent-failure path under test.
        if (isFirstmate && !hasToolResults && latestUserTail.includes(FAIL_AUTH_PROMPT_MARKER)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Incorrect API key provided: mock-key.",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            }),
          );
          return;
        }
        if (
          isFirstmate &&
          !hasToolResults &&
          latestUserTail.includes(FAIL_PROVIDER_PROMPT_MARKER)
        ) {
          // 400 with non-retryable text: fails fast, carries no auth signal.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "mock deterministic provider failure", type: "mock_error" },
            }),
          );
          return;
        }

        // The Firstmate's Claude seat cut off (`cutClaudeSeat`): the class's
        // typed refusal, the way the vendor answers it.
        if (isFirstmate && anthropicMessages && seatCut) {
          if (seatCut.class === "signed_out") {
            writeAnthropicError(res, 401, {
              type: "authentication_error",
              message: "invalid x-api-key",
            });
          } else if (seatCut.class === "no_headroom") {
            const reset = String(Math.floor(seatCut.resetsAt / 1000));
            writeAnthropicError(
              res,
              429,
              { type: "rate_limit_error", message: "rate limited" },
              {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-reset": reset,
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": reset,
                "anthropic-ratelimit-unified-5h-utilization": "1.0",
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
              },
            );
          } else {
            writeAnthropicError(res, 403, {
              type: "permission_error",
              message: CLAUDE_ORG_REFUSAL_MESSAGE,
            });
          }
          return;
        }

        // The Firstmate holding its turn open for a steer (FM_SEAT_HOLD_MARKER).
        if (isFirstmate && wantsStream && body.includes(FM_SEAT_HOLD_MARKER)) {
          if (latestUserTail.includes(FM_SEAT_STEER_WORD)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: FM_SEAT_STEERED_TITLE,
                  body: "<p>The anchor chain is sound, and the crew is idle.</p>",
                  standalone: true,
                },
              },
            ]);
            return;
          }
          if (hasToolResults && body.includes(FM_SEAT_STEER_WORD)) {
            streamText("Done.");
            return;
          }
          if (hasToolResults) {
            if (anthropicMessages) beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            else res.writeHead(200, { "Content-Type": "text/event-stream" });
            heldFirstmate.set(res, { body, request: requestNumber });
            res.on("close", () => heldFirstmate.delete(res));
            return;
          }
          streamToolCalls([{ name: "crew_status", args: {} }]);
          return;
        }

        // The mock kind classifier (routing S3): the real stateless call is
        // made on every spawn, so the mock answers it rather than letting it
        // fall through to the chat default. It abstains, which is exactly
        // what an unclassified spawn did before S3 - so every spec's routing
        // is unchanged while the real call path is still exercised.
        if (body.includes(CLASSIFIER_SYSTEM_MARKER)) {
          // A sequences reproduce step is sorted as what it is, so it is an
          // answer task the way a real classifier makes it one.
          if (body.includes(LESSON_CHESS_GOAL) || body.includes(LESSON_FRACTIONS_GOAL))
            streamText("teach");
          else if (body.includes(RETRIEVAL_TASK_GOAL)) streamText("retrieval");
          else if (body.includes(SEQ_REPRODUCE_GOAL)) streamText("reproduce");
          else if (body.includes(CLASSIFY_CHORE_MARKER)) streamText("chore");
          // A crewmate's filed follow-up is sorted as research, so started
          // it runs as an answer the way a real classifier can make it one.
          else if (body.includes(MOCK_FOLLOWUP_TITLE)) streamText("research");
          else streamText("unclear");
          return;
        }

        // The mock Firstmate: spawn on the commission marker, settle on
        // land/discard/finish, one answer card on the answer marker, a
        // short close-out after tool results, plain chat text otherwise.
        if (isFirstmate && wantsStream) {
          // The answer-delivery retry (a captain message nothing took effect
          // after, such as plain chat the mock answers in closing words): the
          // mock reacts, as a model with nothing more to show does, so the
          // message is covered quietly. It never re-reads the captain's quoted
          // words as a new ask.
          if (latestUserTail.includes(ANSWER_MISSING_OPENING)) {
            if (latestUserTail.includes(RETRY_SILENT_MARKER) || hasToolResults) {
              streamText(MOCK_FM_DONE_TEXT);
            } else if (latestUserTail.includes(RETRY_ACTS_MARKER)) {
              // Tries to put work on the record; the retry refuses it, and the
              // turn then shows nothing, so the message ends in the notice.
              streamToolCalls([
                {
                  name: "create_task",
                  args: {
                    title: RETRY_ACTS_TASK_TITLE,
                    goal: "Do the work the captain asked for.",
                    user_words: RETRY_ACTS_MARKER,
                  },
                },
              ]);
            } else if (latestUserTail.includes(SILENT_ANSWER_MARKER)) {
              streamToolCalls([
                {
                  name: "emit_card",
                  args: { title: RETRY_ANSWER_TITLE, body: RETRY_ANSWER_BODY, standalone: true },
                },
              ]);
            } else {
              streamToolCalls([{ name: "emote", args: { emote: "nod" } }]);
            }
            return;
          }
          // A captain message the mock acknowledges with a reaction: an action
          // that covers it, so it is never retried.
          if (
            !hasToolResults &&
            latestUserTail.includes("[user]") &&
            latestUserTail.includes(REACT_PROMPT_MARKER)
          ) {
            streamToolCalls([{ name: "emote", args: { emote: "nod" } }]);
            return;
          }
          // A captain message the mock answers with closing words only: no
          // card, no reaction, no work - what answer delivery exists to catch.
          if (
            !hasToolResults &&
            latestUserTail.includes("[user]") &&
            latestUserTail.includes(SILENT_ANSWER_MARKER)
          ) {
            streamText(SILENT_CLOSING_WORDS);
            return;
          }
          // A turn a spec scripted ahead: recognized by the whole segment
          // it expects in the newest served input, and by nothing else.
          if (scripted.length > 0) {
            const turn = latestServedTurn(body);
            const fresh = turn !== undefined && turn.toolResults.length === 0;
            const script = turn && scripted.find((entry) => holdsSegment(turn, entry.input));
            if (script && fresh && script.outcome.state === "armed") {
              script.outcome.state = "answered";
              streamToolCalls(script.calls);
              return;
            }
            if (script && !fresh && script.outcome.state === "answered") {
              script.outcome.state = "closed";
              script.outcome.results = (turn?.toolResults ?? []).map(clipped);
              streamText(MOCK_FM_DONE_TEXT);
              return;
            }
            if (fresh || !turn) {
              for (const entry of scripted) {
                if (entry.outcome.state === "closed" && entry !== script) continue;
                const seen =
                  entry === script ? `served again: ${servedSummary(turn)}` : servedSummary(turn);
                entry.outcome.unmatched = [...entry.outcome.unmatched, seen].slice(
                  -SCRIPTED_DIAGNOSTIC_LIMIT,
                );
              }
            }
          }
        }
        // A journey's own scenarios (`docs/testing.md`, "A journey's own
        // scenarios"): asked in the order the journey named them, after the
        // first mate's answer-missing retry and scripted turns and before
        // every shared answer below. The first to answer wins.
        const scenarioRequest = {
          body,
          isFirstmate,
          wantsStream,
          latestUserTail,
          hasToolResults,
          port: (server.address() as AddressInfo).port,
        };
        for (const scenario of scenarios) {
          const answer = scenario(scenarioRequest);
          if (!answer) continue;
          const send = () => {
            if ("calls" in answer) streamToolCalls(answer.calls);
            else if ("text" in answer) streamText(answer.text);
            else if ("held" in answer) holdOpen();
            else writeAnthropicError(res, answer.refusal.status, answer.refusal.error);
          };
          if (answer.afterMs) setTimeout(send, answer.afterMs);
          else send();
          return;
        }
        if (isFirstmate && wantsStream) {
          const settleCall = (
            marker: string,
            mode: "land" | "discard",
          ): ScriptedCall | undefined => {
            if (hasToolResults || !latestUserTail.includes(marker)) return undefined;
            const needle = settleNeedle(latestUserTail, marker);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            return {
              name: "settle_task",
              args: { task_id: taskId, mode, closing_sentence: MOCK_CLOSING_SENTENCES[mode] },
            };
          };
          if (!hasToolResults && latestUserTail.includes(MERGE_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, MERGE_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "settle_task",
                args: {
                  task_id: taskId,
                  mode: "merge-pr",
                  closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
                },
              },
            ]);
            return;
          }
          const land = settleCall(LAND_PROMPT_MARKER, "land");
          if (land) {
            streamToolCalls([land]);
            return;
          }
          const discard = settleCall(DISCARD_PROMPT_MARKER, "discard");
          if (discard) {
            streamToolCalls([discard]);
            return;
          }
          // WI-11 retired `finish`: the successor close for an accepted idle
          // crewmate is a land.
          const finish = settleCall(FINISH_PROMPT_MARKER, "land");
          if (finish) {
            streamToolCalls([finish]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(CANCEL_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, CANCEL_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "interrupt_crewmate",
                args: {
                  task_id: taskId,
                  mode: "cancel",
                  closing_sentence: MOCK_CLOSING_SENTENCES.cancel,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(STEER_PROMPT_MARKER)) {
            const after = latestUserTail.split(STEER_PROMPT_MARKER)[1] ?? "";
            const needle = after.split(/[:"\\]/)[0]?.trim() ?? "";
            const message = after.includes(":")
              ? (after.split(":")[1] ?? "").split(/["\\]/)[0]?.trim() || "carry on"
              : "carry on";
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([{ name: "steer_crewmate", args: { task_id: taskId, message } }]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(ADD_PANEL_PROMPT_MARKER)) {
            const after = latestUserTail.split(ADD_PANEL_PROMPT_MARKER)[1] ?? "";
            const spec = after.split(/["\\\n]/)[0]?.trim() ?? "";
            streamToolCalls([
              {
                name: "install_plugin",
                args: { from: "path", spec, evidence: `add the panel from ${spec}` },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(PERSONAL_REMOVE_PROMPT_MARKER)) {
            const surface = latestUserTail
              .match(/remove my panel ([a-z0-9-]+)/)?.[1]
              ?.trim() as string;
            streamToolCalls([
              {
                name: "personalize",
                args: { action: "remove", surface, evidence: `remove my panel ${surface}` },
              },
            ]);
            return;
          }
          // The marker, or the words the create-your-own-panel slot puts in
          // the message box, finished by the captain.
          const slotAsk = latestUserTail.match(new RegExp(`${CREATE_PANEL_DRAFT}([^"\\\\]+)`));
          if (
            !hasToolResults &&
            (latestUserTail.includes(PERSONAL_PANEL_PROMPT_MARKER) || slotAsk)
          ) {
            const title =
              (latestUserTail.match(/make me a panel: ([^"\\]+)/) ?? slotAsk)?.[1]?.trim() ??
              "A panel";
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title,
                  goal: `Add a panel: ${title}`,
                  user_words: slotAsk
                    ? `${CREATE_PANEL_DRAFT}${title}`
                    : `make me a panel: ${title}`,
                  personal_ui: true,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FINISHED_WAKE_NEEDLE)) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            streamToolCalls([{ name: "settle_task", args: { task_id: taskId, mode: "answered" } }]);
            return;
          }
          for (const lesson of [
            { ask: LESSON_CHESS_ASK, title: LESSON_CHESS_TITLE, goal: LESSON_CHESS_GOAL },
            {
              ask: LESSON_FRACTIONS_ASK,
              title: LESSON_FRACTIONS_TITLE,
              goal: LESSON_FRACTIONS_GOAL,
            },
          ]) {
            if (!hasToolResults && latestUserTail.includes(lesson.ask)) {
              streamToolCalls([
                {
                  name: "spawn_crewmate",
                  args: {
                    title: lesson.title,
                    goal: lesson.goal,
                    user_words: lesson.ask,
                    personal_ui: true,
                  },
                },
              ]);
              return;
            }
          }
          if (!hasToolResults && latestUserTail.includes(ANSWER_TASK_PROMPT_MARKER)) {
            const title =
              latestUserTail.match(/find out and answer: ([^"\\]+)/)?.[1]?.trim() ??
              "Mock investigation";
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title,
                  goal: `Find out ${title} and answer it.`,
                  user_words: `${ANSWER_TASK_PROMPT_MARKER} ${title}`,
                  constraints: [{ kind: "read-only" }],
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FILE_TASK_PROMPT_MARKER)) {
            const title =
              latestUserTail.match(/file a task: ([^"\\]+)/)?.[1]?.trim() ?? "Mock planned task";
            streamToolCalls([
              {
                name: "create_task",
                args: {
                  title,
                  goal: `Complete ${title}`,
                  user_words: `${FILE_TASK_PROMPT_MARKER} ${title}`,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(SPAWN_PROMPT_MARKER)) {
            const titleMatches = [...latestUserTail.matchAll(/commission a crewmate: ([^"\\]+)/g)];
            const title = titleMatches[0]?.[1]?.trim() ?? "Mock task";
            const repoMatches = contextRepos(body);
            const bound = repoMatches.find(([name]) => title.includes(name));
            // spawn v2: a structured intent, never an authored brief. The
            // user's verbatim words carry any crewmate-side marker through
            // the host-rendered template.
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title,
                  goal: `Complete the task "${title}" and report the outcome.`,
                  user_words: `commission a crewmate: ${title}`,
                  ...(bound ? { repo_id: bound[1] } : {}),
                  // A task that only answers, in its project (FI3-1571 piece 4).
                  ...(title.includes(WRITE_ASK_ANSWER_MARKER)
                    ? { constraints: [{ kind: "read-only" as const }] }
                    : {}),
                  ...(title.includes(THREAD_TREE_PROMPT_MARKER) ||
                  title.includes(THREAD_WORKING_SIBLING_MARKER)
                    ? { parent: THREAD_TREE_PARENT_KEY }
                    : {}),
                  // Rigor derives standard by default (captain ruling
                  // 2026-09-19); reviewed is only ever asked for, so the
                  // marker is the captain's words on care. Every other
                  // scripted spawn asks quick: the specs that ride it
                  // exercise settle and card machinery with plain card
                  // bodies, not the standard tier's evidence contract
                  // (rigor-standard.spec.ts covers that on its own repo).
                  // The captain's words on who merges this one (v3.9);
                  // omitted entirely when he said nothing.
                  // Both ride the work-shape group (contract v4.12).
                  shape: {
                    ...(title.includes(AUTONOMY_ASK_MARKER) ? { autonomy_ask: true } : {}),
                    ...(title.includes(CLAUDE_CREW_PROMPT_MARKER) ||
                    title.includes(CLAUDE_CREWMATE_MARKER)
                      ? { override_model_id: CLAUDE_CREW_MODEL }
                      : {}),
                    rigor_ask: title.includes(REVIEWED_TIER_PROMPT_MARKER)
                      ? "reviewed"
                      : title.includes(STANDARD_TIER_PROMPT_MARKER) ||
                          title.includes(STANDARD_TIER_HOST_BUTTONS_MARKER) ||
                          title.includes(REVIEW_CAREFULLY_MARKER)
                        ? "standard"
                        : "quick",
                  },
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(ADOPT_REPO_PROMPT_MARKER)) {
            const path = latestUserTail
              .match(/manage my folder at ([^"\\]+)/)?.[1]
              ?.trim() as string;
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-setup",
                  value: { kind: "adopt", path },
                  evidence: latestUserTail,
                },
              },
            ]);
            return;
          }
          // The captain's Add project on a clone's setup card could not
          // clone it without a sign-in: the card's answer carries the
          // typed refusal, and the Firstmate offers its ways on one card.
          if (!hasToolResults && latestUserTail.includes(SETUP_CARD_FAILED_WORDS)) {
            const json = sinceLastUser(body).user.match(/```json\n([\s\S]*?)\n```/)?.[1];
            const refusal = json ? JSON.parse(json) : undefined;
            if (refusal?.refused === "not-signed-in") {
              streamToolCalls([
                {
                  name: "emit_card",
                  args: {
                    title: "Sign in before cloning your project",
                    body: "<p>The app needs your sign-in before it can clone this project.</p><p>The clone failed without your GitHub sign-in. Sign in opens Projects with a code, then you can try again.</p>",
                    standalone: true,
                    // A clone has no project to keep on this Mac, so its one
                    // way out stands beside a choice to leave it for now: a
                    // decision gives 2 or 3 actions.
                    actions: [
                      ...refusal.ways.map(
                        (
                          way: {
                            label: string;
                            effect: { kind: string; target: string; signIn: string };
                          },
                          index: number,
                        ) => ({
                          id: `clone-sign-in-${index}`,
                          label: way.label,
                          effect: {
                            kind: way.effect.kind,
                            target: way.effect.target,
                            sign_in: way.effect.signIn,
                          },
                          default: index === 0,
                        }),
                      ),
                      ...(refusal.ways.length < 2
                        ? [{ id: "clone-later", label: "Leave it for now" }]
                        : []),
                    ],
                  },
                },
              ]);
              return;
            }
          }
          if (!hasToolResults && latestUserTail.includes(CLONE_REPO_PROMPT_MARKER)) {
            const origin = latestUserTail
              .match(/manage the remote repository at ([^"\\]+)/)?.[1]
              ?.trim() as string;
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-setup",
                  value: { kind: "clone", origin },
                  evidence: latestUserTail,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(INIT_REPO_PROMPT_MARKER)) {
            const name = latestUserTail.match(/start a new project ([\w.-]+)/)?.[1] as string;
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-setup",
                  value: { kind: "init", name },
                  evidence: latestUserTail,
                },
              },
            ]);
            return;
          }
          // Cards as threads, phase 2: a Firstmate card. Checked before the
          // first-run wake - a coalesced captain turn carries that wake, and
          // the captain's words outrank it. Revise/prose require the about
          // line so thread-activity excerpts of earlier replies cannot steal
          // the prompt.
          if (
            !hasToolResults &&
            latestUserTail.includes("about: card") &&
            latestUserTail.includes(THREAD_REVISE_REPLY)
          ) {
            const aboutCardId =
              latestUserTail.match(/about: card (card-[\w-]+)/)?.[1] ?? "fm-thread-card";
            // The revision lands at once: the body frame the thread's opening
            // just remounted is swapped while its first document still loads.
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: aboutCardId.startsWith("card-fm-") ? aboutCardId : "fm-thread-card",
                  reply: FM_THREAD_REVISE_ANSWER,
                  title: FM_THREAD_CARD_REVISED_TITLE,
                  body: '<p>Lead with the caption, not the chips.</p><p>The chips stay underneath once the caption has said what this is.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
                  actions: [
                    { id: "chips-first", label: "Keep the chips first" },
                    { id: "caption-first", label: "Lead with the caption", default: true },
                  ],
                  standalone: true,
                },
              },
            ]);
            return;
          }
          if (
            !hasToolResults &&
            latestUserTail.includes("about: card") &&
            latestUserTail.includes(THREAD_PROSE_REPLY)
          ) {
            streamText(FM_THREAD_PROSE_ANSWER);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FM_THREAD_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "fm-thread-card",
                  title: FM_THREAD_CARD_TITLE,
                  body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
                  actions: [
                    { id: "chips-first", label: "Lead with the chips" },
                    { id: "caption-first", label: "Lead with the caption", default: true },
                  ],
                  standalone: true,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FIRST_RUN_WAKE_MARKER)) {
            // The welcome: one standalone note in the Firstmate's own voice.
            streamToolCalls([
              {
                name: "emit_card",
                args: { title: MOCK_WELCOME_TITLE, body: MOCK_WELCOME_TEXT, standalone: true },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(ANSWER_PROMPT_MARKER)) {
            // Attach first (task-system P1): an answer about no existing work
            // asserts standalone, and the host files it as its own question.
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_ANSWER_TITLE,
                  body: latestUserTail.includes(TALL_ANSWER_PROMPT_MARKER)
                    ? MOCK_ANSWER_TEXT.repeat(100)
                    : MOCK_ANSWER_TEXT,
                  standalone: true,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(APP_CATALOG_PROMPT_MARKER)) {
            const input =
              latestServedTurn(body)?.segments.findLast((part) =>
                part.body.includes(APP_CATALOG_PROMPT_MARKER),
              )?.body ?? "";
            const json = input
              .slice(
                input.lastIndexOf(APP_CATALOG_PROMPT_MARKER) + APP_CATALOG_PROMPT_MARKER.length,
              )
              .split("\n")[0];
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  ...JSON.parse(json ?? "{}"),
                  on_words: true,
                  evidence: "captain requested catalog change",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(PERSONALIZE_THEME_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "app_change",
                args: { action: "theme", value: { theme: "light" }, evidence: "switch to light" },
              },
            ]);
            return;
          }
          if (latestUserTail.includes(KNOWLEDGE_FACT_PROMPT_MARKER)) {
            if (!calledTool(latestUserTail, "record_knowledge")) {
              streamToolCalls([
                {
                  name: "record_knowledge",
                  args: {
                    action: "publish",
                    request_id: "deploy-day",
                    kind: "concept",
                    title: "Deploy day",
                    text: "Deploys happen on Tuesdays.",
                  },
                },
              ]);
            } else {
              streamText(MOCK_FM_DONE_TEXT);
            }
            return;
          }
          streamText(hasToolResults ? MOCK_FM_DONE_TEXT : MOCK_FM_CHAT_TEXT);
          return;
        }

        // The mock teacher (FI3-1474): scripted rounds from the shipped lesson
        // parts, one batch of calls per captain event, never a model's teaching.
        if (
          !isFirstmate &&
          wantsStream &&
          (body.includes(LESSON_CHESS_ASK) || body.includes(LESSON_FRACTIONS_ASK))
        ) {
          const lessonCard = (
            id: string,
            title: string,
            cardBody: string,
            actions: { id: string; label: string; default?: boolean }[],
          ): ScriptedCall => ({
            name: "emit_card",
            args: { id, title, body: cardBody, holds_place: true, actions },
          });
          const roundActions = [
            { id: "next-round", label: "Next round", default: true },
            { id: "stop-today", label: "Stop for today" },
          ];
          // The served body is JSON, so the choice's quotes arrive escaped.
          const choseOnCard = (label: string) => latestUserTail.includes(`chose \\"${label}\\"`);
          const ready: ScriptedCall = { name: "report", args: { text: "Round ready." } };
          if (body.includes(LESSON_FRACTIONS_ASK)) {
            const results = toolAnswers(providerMessages(body)).join("\n");
            if (!hasToolResults) {
              streamToolCalls([{ name: "read", args: { path: "lessons/learner.md" } }]);
            } else if (!calledTool(body, "emit_card")) {
              if (!results.includes(LESSON_LEARNER_LINE))
                throw new Error("The second subject did not read the shared learner file");
              streamToolCalls([
                {
                  name: "write",
                  args: {
                    path: "lessons/fractions/progress.md",
                    content: "# Fractions\nGoal: not yet asked\n## Skills\n- halves | next\n",
                  },
                },
                lessonCard(
                  "lessons-fractions",
                  LESSON_FRACTIONS_GOAL_TITLE,
                  LESSON_FRACTIONS_GOAL_BODY,
                  [
                    { id: "start", label: "Let's start", default: true },
                    { id: "stop-today", label: "Stop for today" },
                  ],
                ),
                ready,
              ]);
            } else streamText("Round ready.");
            return;
          }
          if (hasToolResults) {
            streamText("Round ready.");
            return;
          }
          if (choseOnCard("Stop these lessons")) {
            streamToolCalls([
              { name: "report", args: { text: "Lessons stopped; records kept.", finished: true } },
            ]);
            return;
          }
          if (choseOnCard("Start today's lesson")) {
            streamToolCalls([
              lessonCard(
                LESSON_CHESS_CARD_ID,
                LESSON_ROUND_REVIEW_TITLE,
                lessonRoundBody(
                  chessItems(1),
                  "the rook with a piece in the way",
                  "A little review before new work.",
                ),
                roundActions,
              ),
              ready,
            ]);
            return;
          }
          if (choseOnCard("Stop for today")) {
            streamToolCalls([
              {
                name: "write",
                args: { path: "lessons/chess/progress.md", content: LESSON_PROGRESS_STOP },
              },
              lessonCard(`lessons-welcome-chess`, LESSON_WELCOME_TITLE, LESSON_WELCOME_BODY, [
                { id: "start-lesson", label: "Start today's lesson", default: true },
                { id: "stop-lessons", label: "Stop these lessons" },
              ]),
              ready,
            ]);
            return;
          }
          if (choseOnCard("Next round")) {
            streamToolCalls([
              lessonCard(
                LESSON_CHESS_CARD_ID,
                LESSON_ROUND_TWO_TITLE,
                lessonRoundBody(
                  chessItems(2),
                  "the rook with a piece in the way",
                  "Ranks and files, together.",
                ),
                roundActions,
              ),
              ready,
            ]);
            return;
          }
          if (choseOnCard("Let's start")) {
            streamToolCalls([
              {
                name: "write",
                args: {
                  path: "lessons/learner.md",
                  content: `# Learner\n${LESSON_LEARNER_LINE}\n`,
                },
              },
              {
                name: "write",
                args: {
                  path: "lessons/chess/progress.md",
                  content:
                    "# Chess\nGoal: beat my dad at chess\n## Skills\n- rook slides | practising | first seen 2026-10-10\n",
                },
              },
              lessonCard(
                LESSON_CHESS_CARD_ID,
                LESSON_ROUND_ONE_TITLE,
                lessonRoundBody(
                  chessItems(1),
                  LESSON_NEXT_GOAL,
                  "Today: how the rook slides along a file.",
                ),
                roundActions,
              ),
              ready,
            ]);
            return;
          }
          if (latestUserTail.includes(LESSON_REPLY_WORDS)) {
            const shown =
              latestUserTail.match(/Card \\+"[^"]*\\+" \(([^)]+)\)/)?.[1] ?? LESSON_CHESS_CARD_ID;
            streamToolCalls([
              { name: "reply", args: { card_id: shown, text: LESSON_REPLY_ANSWER } },
            ]);
            return;
          }
          // The first turn: the goal comes first.
          streamToolCalls([
            lessonCard(LESSON_CHESS_CARD_ID, LESSON_GOAL_TITLE, LESSON_GOAL_BODY, [
              { id: "start", label: "Let's start", default: true },
              { id: "stop-today", label: "Stop for today" },
            ]),
            ready,
          ]);
          return;
        }
        // The mock live-build crewmate (Step 4): write the extension with
        // Pi's own write tool, lint it and photograph its draft, place it on
        // the rail and photograph it there (docs/personal-panels.md, "Placed
        // on the rail"), then report after a pause so the running dot is
        // observable; a change brief rewrites, photographs, places,
        // photographs and reports. Each capture is its own turn, so the
        // first reads the draft and the second the rail the place left.
        // Match the task brief across the whole conversation. Tool-result
        // follow-ups can be serialized as a newer user message, so limiting
        // this session marker to `latestUserTail` makes the second leg fall
        // through to the generic crewmate response before it can report.
        if (!isFirstmate && body.includes(LIVE_BRIEF_MARKER) && wantsStream) {
          // The change brief, by the same whole-conversation match: a
          // capture's pictures come back as a newer user message.
          if (body.includes(ROWS_SMALLER_MARKER)) {
            if (!calledTool(body, "write")) {
              streamToolCalls([
                {
                  name: "write",
                  args: { path: `${MOCK_PANEL_ID}/panel.tsx`, content: mockPanelSource("small") },
                },
              ]);
              return;
            }
            if (!calledTool(body, "capture_panel")) {
              streamToolCalls([{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }]);
              return;
            }
            if (!calledTool(body, "place_panel")) {
              streamToolCalls([{ name: "place_panel", args: { id: MOCK_PANEL_ID } }]);
              return;
            }
            if (toolCallCount(body, "capture_panel") < 2) {
              streamToolCalls([{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }]);
              return;
            }
            if (!calledTool(body, "report")) {
              setTimeout(() => {
                streamToolCalls([{ name: "report", args: { text: MOCK_PANEL_REVISED_REPORT } }]);
              }, MOCK_PANEL_REPORT_DELAY_MS);
              return;
            }
            streamText("done");
            return;
          }
          if (!calledTool(body, "write")) {
            streamToolCalls([
              {
                name: "write",
                args: { path: `${MOCK_PANEL_ID}/panel.tsx`, content: mockPanelSource("regular") },
              },
              {
                name: "write",
                args: { path: `${MOCK_PANEL_ID}/manifest.json`, content: MOCK_PANEL_MANIFEST },
              },
              { name: "note_progress", args: { text: "Wrote the panel; checking it next." } },
            ]);
            return;
          }
          if (!calledTool(body, "lint_panel")) {
            streamToolCalls([
              { name: "lint_panel", args: {} },
              { name: "capture_panel", args: { id: MOCK_PANEL_ID } },
            ]);
            return;
          }
          if (!calledTool(body, "place_panel")) {
            streamToolCalls([{ name: "place_panel", args: { id: MOCK_PANEL_ID } }]);
            return;
          }
          if (toolCallCount(body, "capture_panel") < 2) {
            streamToolCalls([{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }]);
            return;
          }
          if (!calledTool(body, "report")) {
            setTimeout(() => {
              streamToolCalls([{ name: "report", args: { text: MOCK_PANEL_REPORT } }]);
            }, MOCK_PANEL_REPORT_DELAY_MS);
            return;
          }
          streamText("done");
          return;
        }
        // Inline decisions (contract 4.22): a card that asks its questions
        // with its own form. The captain's reply brings the answers back and
        // the revision renames one question, so a spec can watch the other
        // picks survive by name and the renamed one start fresh.
        if (!isFirstmate && body.includes(INLINE_QUESTIONS_PROMPT_MARKER) && wantsStream) {
          const revise = latestUserTail.includes(INLINE_QUESTIONS_REVISE_REPLY);
          if (!hasToolResults && (!calledTool(body, "emit_card") || revise)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "inline-questions",
                  ...(revise ? { reply: "Renamed one question; your other picks stay." } : {}),
                  title: revise ? INLINE_QUESTIONS_REVISED_TITLE : INLINE_QUESTIONS_TITLE,
                  body: inlineQuestionsBody(revise),
                  actions: [
                    { id: "later", label: "Not now" },
                    { id: "lock-plan", label: INLINE_QUESTIONS_LOCK_LABEL, default: true },
                  ],
                },
              },
            ]);
            return;
          }
          streamText("The questions are on the card.");
          return;
        }
        // Cards as threads, phase 1: the crewmate that keeps a thread. Its
        // card's id is the one emit_card handed back, read out of the
        // transcript exactly as a real model would read it.
        if (!isFirstmate && body.includes(THREAD_PROMPT_MARKER) && wantsStream) {
          const shownCardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
          // Case A: acknowledge, work (held until released), then answer by
          // revising the card, and report. Every step reads only this
          // reply's own leg of the conversation.
          if (latestUserTail.includes(THREAD_ACK_REPLY)) {
            if (!calledTool(latestUserTail, "reply")) {
              streamToolCalls([
                { name: "reply", args: { card_id: shownCardId, text: THREAD_ACK_TEXT } },
              ]);
              return;
            }
            if (!calledTool(latestUserTail, "emit_card")) {
              heldThreadAnswers.push(() =>
                streamToolCalls([
                  {
                    name: "emit_card",
                    args: {
                      id: "thread-card",
                      title: THREAD_ACK_REVISED_TITLE,
                      body: "<p>Awaiting the job queue removes the race on every platform.</p><p>The windows retry waits on the same queue flush.</p>",
                      actions: [
                        { id: "mock-clock", label: "Mock the clock" },
                        { id: "await-queue", label: "Await the queue", default: true },
                      ],
                    },
                  },
                ]),
              );
              return;
            }
            if (!calledTool(latestUserTail, "report")) {
              streamToolCalls([{ name: "report", args: { text: MOCK_THREAD_ACK_REPORT } }]);
              return;
            }
            streamText("Answered on the card.");
            return;
          }
          // The captain's words change what the card says: revise the head
          // under the same id. The thread gets the host's "revised" line.
          if (!hasToolResults && latestUserTail.includes(THREAD_REVISE_REPLY)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "thread-card",
                  reply: THREAD_REVISE_ANSWER,
                  title: THREAD_CARD_REVISED_TITLE,
                  body: "<p>Awaiting the job queue removes the race entirely.</p><p>Mocking the clock leaves write order uncertain, which is what you spotted.</p>",
                  actions: [
                    { id: "mock-clock", label: "Mock the clock" },
                    { id: "await-queue", label: "Await the queue", default: true },
                  ],
                },
              },
            ]);
            return;
          }
          // Nothing on the card changes: answer in the thread itself.
          if (!hasToolResults && latestUserTail.includes(THREAD_PROSE_REPLY)) {
            streamToolCalls([
              {
                name: "reply",
                args: { card_id: shownCardId, text: THREAD_PROSE_ANSWER },
              },
            ]);
            return;
          }
          if (!hasToolResults && !calledTool(body, "emit_card")) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "thread-card",
                  title: THREAD_CARD_TITLE,
                  body: "<p>Awaiting the job queue removes the race entirely.</p><p>Mocking the clock is quicker but leaves write order uncertain.</p>",
                  actions: [
                    { id: "mock-clock", label: "Mock the clock" },
                    { id: "await-queue", label: "Await the queue", default: true },
                  ],
                },
              },
            ]);
            return;
          }
          streamText("The card is up and I am holding for the captain.");
          return;
        }
        // The Claude crewmate on a refused login (CLAUDE_REFUSED_PROMPT_MARKER):
        // the organisation refusal while the server refuses, then a report.
        if (
          !isFirstmate &&
          anthropicMessages &&
          wantsStream &&
          body.includes(CLAUDE_REFUSED_PROMPT_MARKER)
        ) {
          if (refusingClaude) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                type: "error",
                error: { type: "permission_error", message: CLAUDE_ORG_REFUSAL_MESSAGE },
              }),
            );
            return;
          }
          if (hasToolResults) {
            streamText("done");
            return;
          }
          if (body.includes(CLAUDE_HELD_CARD_MARKER)) {
            const cardId = latestUserTail.includes(CLAUDE_HELD_REPLY)
              ? latestUserTail.match(/\((card-[\w-]+)\)/)?.[1]
              : undefined;
            streamToolCalls([
              cardId
                ? { name: "reply", args: { card_id: cardId, text: MOCK_CLAUDE_HELD_ANSWER } }
                : {
                    name: "emit_card",
                    args: {
                      title: MOCK_CLAUDE_HELD_CARD_TITLE,
                      body: "<p>The reef has one shoal on the southern side.</p><p>It is marked on the chart.</p>",
                    },
                  },
            ]);
            return;
          }
          if (latestUserTail.includes(CLAUDE_REFUSAL_OVER_MARKER)) {
            streamToolCalls([{ name: "report", args: { text: MOCK_CLAUDE_REFUSAL_OVER_REPORT } }]);
            return;
          }
          streamText("Nothing new to add.");
          return;
        }
        // The Claude crewmate that relays an approval (CLAUDE_RELAY_MARKER):
        // its plan card and report, then the captain's approval by reply
        // answered in the thread and reported with needs_firstmate.
        if (
          !isFirstmate &&
          anthropicMessages &&
          wantsStream &&
          body.includes(CLAUDE_CREW_PROMPT_MARKER) &&
          body.includes(CLAUDE_RELAY_MARKER)
        ) {
          if (hasToolResults) {
            streamText("done");
            return;
          }
          const cardId = latestUserTail.includes(CLAUDE_RELAY_APPROVAL)
            ? latestUserTail.match(/\((card-[\w-]+)\)/)?.[1]
            : undefined;
          streamToolCalls(
            cardId
              ? [
                  { name: "reply", args: { card_id: cardId, text: MOCK_CLAUDE_RELAY_ANSWER } },
                  {
                    name: "report",
                    args: {
                      text: MOCK_CLAUDE_RELAY_REPORT,
                      needs_firstmate: MOCK_CLAUDE_RELAY_ASK,
                    },
                  },
                ]
              : [
                  {
                    name: "emit_card",
                    args: {
                      title: MOCK_CLAUDE_PLAN_CARD_TITLE,
                      body: "<p>Raise the rivet threshold before the next inspection.</p><p>Decision 5 sets it to 8 today.</p>",
                      actions: [
                        { id: "build", label: "Approve and build", default: true },
                        { id: "later", label: "Not now" },
                      ],
                    },
                  },
                  { name: "report", args: { text: MOCK_CLAUDE_PLAN_REPORT } },
                ],
          );
          return;
        }
        // The Claude crewmate (CLAUDE_CREW_PROMPT_MARKER): card, held step,
        // steer, report. The steer is checked first because the client
        // sends it in the same user message as the held step's tool result.
        if (!isFirstmate && body.includes(CLAUDE_CREW_PROMPT_MARKER) && wantsStream) {
          if (latestUserTail.includes(CLAUDE_STEER_MARKER)) {
            streamToolCalls([{ name: "report", args: { text: MOCK_CLAUDE_STEERED_REPORT } }]);
            return;
          }
          if (hasToolResults && body.includes(CLAUDE_STEER_MARKER)) {
            streamText("done");
            return;
          }
          if (hasToolResults) {
            holdOpen();
            return;
          }
          const retireChoice = body.includes(CLAUDE_CARD_RETIRE_MARKER);
          streamToolCalls([
            {
              name: "emit_card",
              args: {
                title: MOCK_CLAUDE_CARD_TITLE,
                body: `<p>${MOCK_CLAUDE_CARD_TEXT}</p>${retireChoice ? "<p>Inspect port first because it is closest; starboard can wait.</p>" : ""}`,
                ...(retireChoice
                  ? {
                      actions: [
                        { id: "port", label: "Inspect the port hatch", default: true },
                        { id: "starboard", label: "Inspect the starboard hatch" },
                      ],
                    }
                  : {}),
              },
            },
            ...(retireChoice
              ? [
                  {
                    name: "report",
                    args: { text: MOCK_CLAUDE_HELD_PROGRESS },
                  } satisfies ScriptedCall,
                ]
              : []),
          ]);
          return;
        }

        if (!isFirstmate && latestUserTail.includes(READS_ANYWHERE_MARKER) && wantsStream) {
          // FI3-1571 piece 3: reads past the old read list, from a project
          // kept on this computer, through the github.com sign-in.
          const { results } = sinceLastUser(body);
          const next = JSON.parse(results[1] ?? "{}").nextPath as string | undefined;
          const reads = [
            "/notifications",
            "/repos/octo/website/pulls?per_page=1",
            next ?? "/repositories/0/pulls",
            "/graphql",
          ];
          const path = reads[results.length];
          if (path) streamToolCalls([{ name: "github_read", args: { path } }]);
          else if (results.length === reads.length) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: results.join("\n"),
                  summary: "Read the notifications and both pages through the github.com sign-in.",
                },
              },
            ]);
          } else streamText("Reads reported.");
          return;
        }
        if (
          !isFirstmate &&
          (latestUserTail.includes(WRITE_ASK_MARKER) ||
            latestUserTail.includes(WRITE_ASK_ANSWER_MARKER)) &&
          wantsStream
        ) {
          // FI3-1571 piece 4: a write that is kept, then asked for on a card.
          const { results } = sinceLastUser(body);
          const ask = results[0]?.match(/Kept as ask (wa[0-9a-f]+)/)?.[1];
          if (!results.length) {
            streamToolCalls([{ name: "github_write", args: writeAskCall(latestUserTail) }]);
          } else if (results.length === 1 && ask) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "write-ask",
                  title: WRITE_ASK_CARD_TITLE,
                  body: "<p>This write is outside what I may send myself, so it waits on you.</p><p>It records what this task found where the people who need it will look.</p>",
                  actions: [
                    { id: "send", effect: { kind: "request_write", ask } },
                    { id: "not-now", label: "Not now" },
                  ],
                },
              },
            ]);
          } else if (results.length <= 2) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: results.join("\n"),
                  summary: "The write waits on the captain's card.",
                },
              },
            ]);
          } else streamText("The write is waiting on the captain.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(WRITE_ASK_SENT_WAKE) && wantsStream) {
          // Once sent, the same ask on a revised card sends nothing again.
          const { results } = sinceLastUser(body);
          const ask = body.match(/Kept as ask (wa[0-9a-f]+)/)?.[1] ?? "";
          if (!results.length) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "write-ask",
                  title: WRITE_ASK_CARD_TITLE,
                  body: "<p>Asking again for the same write.</p><p>The first answer did not reach me, so I am checking it went.</p>",
                  actions: [
                    { id: "send", effect: { kind: "request_write", ask } },
                    { id: "not-now", label: "Not now" },
                  ],
                },
              },
            ]);
          } else if (results.length === 1) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: `Asking again: ${results[0]}\nThe answer I heard: ${latestUserTail.match(/answered (\d{3})/)?.[1] ?? "none"}`,
                  summary: "The captain sent the write once.",
                },
              },
            ]);
          } else streamText("The write was sent.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(SKIP_RULES_MERGE_MARKER) && wantsStream) {
          // FI3-1571 piece 2: prepare the adopted release pull request as a
          // merge past the rules at the version read, then ask on a card.
          const { results } = sinceLastUser(body);
          const review = results[0]?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
          if (!results.length) {
            streamToolCalls([
              {
                name: "check_change",
                args: {
                  pull: SKIP_RULES_PULL.number,
                  skipRules: { headSha: SKIP_RULES_PULL.headSha, method: "squash" },
                },
              },
            ]);
          } else if (results.length === 1 && review) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "release-past-rules",
                  title: SKIP_RULES_CARD_TITLE,
                  body: "<p>The release pull request waits on a code owner's review, and one check failed.</p><p>Your account may skip both, so I prepared the merge at the version I read.</p>",
                  actions: [
                    { id: "merge", effect: { kind: "request_merge", review } },
                    { id: "not-now", label: "Not now" },
                  ],
                },
              },
            ]);
          } else if (results.length <= 2) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: results.join("\n"),
                  summary: "The release merge past the rules is on a card for the captain.",
                },
              },
            ]);
          } else streamText("The release merge is waiting on the captain.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(SKIP_RULES_MERGED_WAKE) && wantsStream) {
          // After the click, the same review on a revised card sends nothing again.
          const { results } = sinceLastUser(body);
          const review = body.match(/Merge review (mr[0-9a-f]+)/)?.[1] ?? "";
          if (!results.length) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "release-past-rules",
                  title: SKIP_RULES_CARD_TITLE,
                  body: "<p>Asking again for the same merge.</p><p>I want to be sure the release went in at the version I read.</p>",
                  actions: [
                    { id: "merge", effect: { kind: "request_merge", review } },
                    { id: "not-now", label: "Not now" },
                  ],
                },
              },
            ]);
          } else if (results.length === 1) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: `Asking again: ${results[0]}`,
                  summary: "The release pull request merged past its rules.",
                },
              },
            ]);
          } else streamText("The release merged.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(API_WRITE_GUARD_MARKER) && wantsStream) {
          const { results } = sinceLastUser(body);
          const gitlab = latestUserTail.includes("guard-gitlab");
          const project = gitlab
            ? `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`
            : "/repos/octo/meterlab";
          const calls = mergeWriteCases(gitlab ? "gitlab" : "github", project);
          const next = calls[results.length];
          if (next) {
            streamToolCalls([{ name: "github_write", args: next }]);
          } else if (results.length === calls.length) {
            streamToolCalls([{ name: "bash", args: { command: "git rev-parse HEAD" } }]);
          } else if (results.length === calls.length + 1) {
            const sha = results.at(-1)?.match(/\b[0-9a-f]{40}\b/)?.[0];
            streamToolCalls([
              {
                name: "github_write",
                args: gitlab
                  ? { method: "DELETE", path: `${project}/repository/branches/topic` }
                  : {
                      method: "PATCH",
                      path: `${project}/git/refs/heads/topic`,
                      body: JSON.stringify({ sha, force: false }),
                    },
              },
            ]);
          } else if (results.length === calls.length + 2) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: results.join("\n"),
                  summary:
                    "Merge and default-branch writes were refused; another branch write reached the host.",
                },
              },
            ]);
          } else streamText("Merge API guard reported.");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_PROMPT_MARKER) && wantsStream) {
          const step = calledTool(body, "report") ? undefined : lookingAgain(body, taskBrowserStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        // Claude's client sends each tool result as the latest user message,
        // so on its wire the marker is earlier in the conversation.
        const gitStatusAsked =
          latestUserTail.includes(GIT_STATUS_PROMPT_MARKER) ||
          (anthropicMessages && body.includes(GIT_STATUS_PROMPT_MARKER));
        if (!isFirstmate && gitStatusAsked && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              { name: "bash", args: { command: "git --version && git status --short --branch" } },
            ]);
            return;
          }
          if (latestUserTail.includes(MOCK_GIT_REPORT_PREFIX) || calledTool(body, "report")) {
            streamText("done");
            return;
          }
          // Only what came back from the shell: the tool result follows the
          // call, or is the latest user message itself on Claude's wire.
          const call = latestUserTail.indexOf('"tool_calls"');
          const result = call >= 0 ? latestUserTail.slice(call) : latestUserTail;
          const version = result.match(/git version \d+\.\d+\.\d+/)?.[0];
          const branch = result.match(/## [^\s"\\]+/)?.[0];
          const answer =
            version && branch
              ? `${version} on ${branch}`
              : (result.match(/command not found|not found/)?.[0] ?? "nothing");
          streamToolCalls([
            { name: "report", args: { text: `${MOCK_GIT_REPORT_PREFIX} ${answer}.` } },
          ]);
          return;
        }
        // The answer-task crewmate told the captain closed its card: it
        // judges the answer read and finished (FI3-435).
        if (
          !isFirstmate &&
          (body.includes(ANSWER_TASK_PROMPT_MARKER) || body.includes(RETRIEVAL_TASK_ASK)) &&
          latestUserTail.includes(CARD_CLOSED_STEER_NEEDLE) &&
          wantsStream
        ) {
          if (!hasToolResults) {
            streamToolCalls([
              { name: "report", args: { text: MOCK_ANSWER_FINISHED_REPORT, finished: true } },
            ]);
            return;
          }
          streamText("done");
          return;
        }
        // The answer-task crewmate (Task B): one decision card carrying the
        // answer, and a report. No completion card, nothing committed.
        if (!isFirstmate && latestUserTail.includes(ANSWER_TASK_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_ANSWER_CARD_TITLE,
                  body: MOCK_ANSWER_CARD_BODY,
                  actions: [
                    { id: "fix-it", label: MOCK_ANSWER_ACTION_LABEL, default: true },
                    { id: "leave-it", label: "Leave it for now" },
                  ],
                },
              },
              { name: "report", args: { text: MOCK_ANSWER_REPORT } },
            ]);
            return;
          }
          streamText("done");
          return;
        }
        // The autonomy-hold crewmate (contract v3.9): an ordinary finished
        // direct-pr task - one completion card declaring the merge, and the
        // report. Who may click that merge is the host's question, not its.
        if (!isFirstmate && latestUserTail.includes(AUTONOMY_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "bash",
                args: { command: 'git commit --allow-empty -m "fix: make the meter read on time"' },
              },
            ]);
            return;
          }
          if (!latestUserTail.includes(MOCK_AUTONOMY_REPORT)) {
            const title = latestUserTail.match(/commission a crewmate: ([^"\\]+)/)?.[1]?.trim();
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_AUTONOMY_CARD_TITLE(title ?? AUTONOMY_PROMPT_MARKER),
                  body: MOCK_STANDARD_CARD_BODY,
                  actions: [
                    {
                      id: "ship",
                      label: "Ship it",
                      default: true,
                      effect: { kind: "settle", mode: "merge" },
                    },
                  ],
                },
              },
              { name: "report", args: { text: MOCK_AUTONOMY_REPORT } },
            ]);
            return;
          }
          streamText("done");
          return;
        }
        const wantsCards = latestUserTail.includes(EMIT_CARDS_PROMPT_MARKER) && !hasToolResults;
        if (wantsCards && wantsStream) {
          streamToolCalls(MOCK_TOOL_CALLS);
          return;
        }
        if (
          latestUserTail.includes(KEYBOARD_CARDS_PROMPT_MARKER) &&
          !hasToolResults &&
          wantsStream
        ) {
          streamToolCalls(keyboardCardToolCalls());
          return;
        }
        if (
          !isFirstmate &&
          (latestUserTail.includes(CARD_WIDTH_PROMPT_MARKER) ||
            latestUserTail.includes(CARD_RESIZE_PROMPT_MARKER) ||
            latestUserTail.includes(CARD_VIEWPORT_PROMPT_MARKER)) &&
          !hasToolResults &&
          wantsStream
        ) {
          streamToolCalls(
            latestUserTail.includes(CARD_VIEWPORT_PROMPT_MARKER)
              ? viewportCardToolCalls(latestUserTail.includes("scripted"))
              : latestUserTail.includes(CARD_RESIZE_PROMPT_MARKER)
                ? resizeCardToolCalls()
                : widthCardToolCalls(),
          );
          return;
        }
        // Presentation regression: a real host job continues alongside a question.
        if (
          !isFirstmate &&
          latestUserTail.includes("verify background posture") &&
          wantsStream &&
          !hasToolResults
        ) {
          const calls: ScriptedCall[] = [
            {
              name: "bash",
              args: {
                command: "while [ ! -f .posture-release ]; do sleep 0.1; done",
                background: true,
              },
            },
          ];
          if (latestUserTail.includes("without a question")) {
            streamToolCalls(calls);
            return;
          }
          streamToolCalls([
            ...calls,
            {
              name: "emit_card",
              args: {
                title: "Background posture question",
                body: "<p>Continue after the background work finishes.</p><p>The disposable command is still running; Continue keeps this task available for its result.</p>",
                actions: [
                  { id: "continue", label: "Continue", default: true },
                  { id: "stop", label: "Stop" },
                ],
              },
            },
          ]);
          return;
        }
        // File-body journey: use the host-provided folder, never a project file.
        if (
          !isFirstmate &&
          wantsStream &&
          (latestUserTail.includes(FILE_CARD_PROMPT_MARKER) ||
            latestUserTail.includes(FILE_CARD_REVISE_MARKER))
        ) {
          const dir = body.match(
            /Your card body folder is ([^(]+) \(create it if it is missing\)/,
          )?.[1];
          if (!dir)
            throw new Error("File card journey requires the real card body folder instruction");
          if (!hasToolResults && !latestUserTail.includes(FILE_CARD_REVISE_MARKER)) {
            const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
            streamToolCalls([
              {
                name: "bash",
                args: {
                  command: `mkdir -p ${quote(dir)} && printf '%s' ${quote(FILE_CARD_INITIAL)} > ${quote(`${dir}/answer.html`)}`,
                },
              },
            ]);
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: FILE_CARD_TITLE,
                  id: "file-answer",
                  reply: "Updated the answer from the file.",
                  body_file: `${dir}/answer.html`,
                },
              },
            ]);
            return;
          }
        }
        // The mock crewmate files a follow-up (task-system P2) and notes
        // progress, then reports on the follow-up leg like any other turn.
        if (
          latestUserTail.includes(FILE_FOLLOWUP_PROMPT_MARKER) &&
          // The follow-up's own brief names the task it was found on; the
          // crewmate that takes it up does not file it again.
          !latestUserTail.includes("Filed as a follow-up by") &&
          !hasToolResults &&
          wantsStream
        ) {
          streamToolCalls([
            {
              name: "file_followup",
              args: {
                title: MOCK_FOLLOWUP_TITLE,
                goal: MOCK_FOLLOWUP_GOAL,
                why: MOCK_FOLLOWUP_WHY,
              },
            },
            { name: "note_progress", args: { text: MOCK_PROGRESS_TEXT } },
          ]);
          return;
        }
        // The one-file crewmate: its brief rides every leg of the tool loop,
        // so the marker is matched across the whole conversation.
        if (!isFirstmate && body.includes(WRITE_FILE_PROMPT_MARKER) && wantsStream) {
          if (!calledTool(body, "write")) {
            const [, path, text] =
              body.match(/write the file (\S+) with ([^"\\]+)/) ?? ([] as string[]);
            streamToolCalls([
              { name: "write", args: { path: path ?? "change.txt", content: `${text ?? ""}\n` } },
            ]);
            return;
          }
          if (!calledTool(body, "report")) {
            streamToolCalls([{ name: "report", args: { text: MOCK_WRITE_FILE_REPORT } }]);
            return;
          }
          streamText("done");
          return;
        }
        if (wantsStream || anthropicMessages) {
          // The default close-out. Anthropic catalog models (Pi 0.87 OpenRouter
          // Claude) take the messages wire; everything else stays completions.
          streamText(MOCK_COMPLETION_TEXT);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: MOCK_MODEL_ID,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: MOCK_COMPLETION_TEXT },
                  finish_reason: "stop",
                },
              ],
              usage,
            }),
          );
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider failed to bind");
  return {
    port: address.port,
    requests: () => requestCount,
    recordRequests: (record) => {
      for (const body of requestBodies) record(body);
      recorders.add(record);
      return () => {
        recorders.delete(record);
      };
    },
    failFirstmate: (fail) => {
      failFirstmate = fail;
    },
    requestBodies: () => [...requestBodies],
    requestHeaders: () => [...requestHeaders],
    cardFetchProbeHits: () => cardFetchProbeHits,
    heldRequests: () => held.size,
    heldThreadAnswers: () => heldThreadAnswers.length,
    releaseThreadAnswer: () => {
      for (const answer of heldThreadAnswers.splice(0)) answer();
    },
    releaseHeldCrew: () => {
      for (const [res, opened] of held) {
        held.delete(res);
        writeAnthropicToolUse(res, 0, {
          id: `toolu_${opened.request}_held`,
          name: servedToolName(opened.body, "note_progress"),
          args: { text: MOCK_CLAUDE_HELD_PROGRESS },
        });
        finishAnthropicStream(res, "tool_use", 17);
      }
    },
    refuseClaude: (refusing) => {
      refusingClaude = refusing;
    },
    cutClaudeSeat: (cut) => {
      seatCut = cut;
    },
    scriptFirstmateTurn: (input, calls) => {
      const outcome: ScriptedTurnOutcome = { state: "armed", unmatched: [], results: [] };
      scripted.push({ input, calls, outcome });
      return { outcome: () => structuredClone(outcome) };
    },
    heldFirstmate: () => heldFirstmate.size,
    releaseHeldFirstmate: () => {
      for (const [res, opened] of heldFirstmate) {
        heldFirstmate.delete(res);
        writeAnthropicToolUse(res, 0, {
          id: `toolu_${opened.request}_held`,
          name: servedToolName(opened.body, "crew_status"),
          args: {},
        });
        finishAnthropicStream(res, "tool_use", 17);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        // `server.close` alone waits for every socket still open, and an
        // app that has just exited can leave a keep-alive connection the
        // kernel has not torn down yet - a teardown that then never
        // finishes and takes its `afterAll` hook's whole timeout with it.
        // Nothing is in flight here by definition, so drop the sockets.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The provider the app's models.json defines the mock model under. */
export const MOCK_PROVIDER_ID = "fm-mock";

/** The id of the one mock model, as the app's models.json defines it. */
export const MOCK_MODEL_ID = "mock-1";

/** The catalog name of the one mock model - what a card's model chip calls it. */
const MOCK_MODEL_LABEL = "Mock model";

/** The app-scoped models.json contents pointing Pi at the mock server. */
/**
 * A models.json that defines NO custom provider and only points a real,
 * key-signed catalog provider at the mock server. The base runtime then
 * serves nothing (no key), so the first-launch gate is up; a key pasted
 * through the gate's own chip signs an OpenRouter account in, and that
 * account's runtime - reading the same app-scoped file - sends every turn
 * to the mock. The one hermetic way to connect an account through the UI.
 */
export const MOCK_KEY_PROVIDER_ID = "openrouter";

export function mockProviderOverrideModelsJson(port: number): string {
  return `${JSON.stringify(
    {
      providers: {
        [MOCK_KEY_PROVIDER_ID]: { baseUrl: `http://127.0.0.1:${port}/v1` },
      },
    },
    null,
    2,
  )}\n`;
}

export function mockModelsJson(port: number): string {
  return `${JSON.stringify(
    {
      providers: {
        [MOCK_PROVIDER_ID]: {
          name: "Mock provider",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "mock-key",
          models: [{ id: MOCK_MODEL_ID, name: MOCK_MODEL_LABEL, input: ["text", "image"] }],
        },
      },
    },
    null,
    2,
  )}\n`;
}
