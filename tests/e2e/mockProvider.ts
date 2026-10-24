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
  WELCOME_WAKE_WORDS,
} from "../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../src/core/pi/bashWords";
import { NOTHING_SPAWNED } from "../../src/core/pi/crewTools";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../../src/core/pi/piResources";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../../src/core/storage/sessionReader";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  writeAnthropicError,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../helpers/anthropicDialect";
import { completionCardBody } from "../helpers/completionCard";
import type { ScriptedArgs, ScriptedCall, ScriptedCardAction } from "../helpers/scriptedCalls";
import { WRITE_ASK_ANSWER_MARKER } from "./apiWriteCases";
import { DEMO_CAPTION, DEMO_POSTER } from "./demoFixtures";
import { LESSON_CHESS_GOAL, LESSON_FRACTIONS_GOAL } from "./lessonFixtures";
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

/** Where the fetch probe card aims: the mock server itself, which counts every hit. */
export const CARD_FETCH_PROBE_PATH = "/card-fetch-probe";
export const SCRIPT_CARD_TITLES = {
  canvas: "Canvas probe",
  fetch: "Fetch probe",
  runaway: "Runaway probe",
  figure: "Figure probe",
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

export const FM_THREAD_CARD_TITLE = "Two ways to phrase the welcome";
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

/** Scripted retrieval exercises plumbing, not live semantic accuracy. */
export const RETRIEVAL_TASK_ASK =
  "Look up the version and demo support in meterlab's release-info.json, with a citation.";
export const RETRIEVAL_TASK_GOAL =
  "Read release-info.json and report its version and demo support with a citation; do not test playback.";

/**
 * The captain's close reaches its crewmate (FI3-435): a crewmate steered
 * with the close of its card judges it read and finished and reports so
 * with `finished: true`; the mock Firstmate, woken by a report that
 * declared its work finished, closes the task the way its instructions say
 * - `settle_task answered` on an answer.
 */
export const CARD_CLOSED_STEER_NEEDLE = CARD_CLOSED_STEER_PREFIX.trim();
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
 * Review carefully (INF-562). A spawn whose title carries this asks for the
 * standard tier; the careful builder and its review are
 * `scenarios/reviewCarefully.ts`.
 */
export const REVIEW_CAREFULLY_MARKER = "ship at default care, then review carefully";
/** A spawn whose title carries this asks for the reviewed tier; the reviewer itself is `scenarios/reviewedTier.ts`. */
export const REVIEWED_TIER_PROMPT_MARKER = "ship at the reviewed tier";
/**
 * The captain's words on who merges (contract v3.9): a spawn whose title
 * carries this asks `autonomy_ask: true`; the autonomy-hold crewmate is
 * `scenarios/autonomy.ts`. Short on purpose: a task title is capped at 64
 * characters.
 */
export const AUTONOMY_ASK_MARKER = "merge it yourself";
/** "merge the task <title>" -> settle_task merge-pr, so a held merge is observable. */
export const MERGE_PROMPT_MARKER = "merge the task ";
/** The follow-up `scenarios/fileFollowup.ts` files; the kind classifier sorts it as research. */
export const MOCK_FOLLOWUP_TITLE = "Flaky meter test";

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
 * makes it emit one note answer card. Anything else is chit-chat: plain
 * text that the app does not map to a feed line or a card. A behavior only
 * some journeys need is a scenario under `tests/e2e/scenarios/`.
 */
// e2e-typed-words: the captain's own words that start a scripted spawn; they only share a phrase with the product's
export const SPAWN_PROMPT_MARKER = "commission a crewmate:";
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
 * Talk-to-personalize Step 1 (Tier A): the mock Firstmate answers
 * "catalog change <json>" with ONE app_change call of those arguments and
 * no card, the way the contract says.
 */
export const APP_CATALOG_PROMPT_MARKER = "catalog change ";
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
/** The tool boundary's refusal, as the spec looks for it in the served body. */
export const ESCALATION_REFUSAL_PHRASE = NOTHING_SPAWNED;
/**
 * The talk-to-personalize build loop (Step 4): the first mate's spawn and
 * remove are `scenarios/personalPanels.ts`. The mock crewmate, on a brief
 * that builds in place, writes the extension with Pi's own write tool, runs
 * lint_panel and capture_panel on the draft, places its version on the rail
 * with place_panel, photographs it there with capture_panel again, and
 * reports after a short delay so the running dot is observable; on the
 * change brief it rewrites the panel with smaller rows, captures, places
 * and captures it again, and reports after the same delay, so a spec can
 * watch the rails while the change is underway.
 */
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
  /** Whether it came on Anthropic's messages wire, the one Claude's client speaks. */
  anthropicMessages: boolean;
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
          anthropicMessages,
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
          if (!hasToolResults && latestUserTail.includes(FINISHED_WAKE_NEEDLE)) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            streamToolCalls([{ name: "settle_task", args: { task_id: taskId, mode: "answered" } }]);
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
          streamText(hasToolResults ? MOCK_FM_DONE_TEXT : MOCK_FM_CHAT_TEXT);
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
