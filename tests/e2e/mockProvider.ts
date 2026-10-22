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
import { HIDDEN_VALUE_WORDS, REF_PATTERN } from "../../src/core/browser/outline";
import { GIF_LOOP_WORDS } from "../../src/core/gifFormat";
import { BUILD_IN_PLACE_OPENING } from "../../src/core/orchestrator/intentBrief";
import {
  ANSWER_MISSING_OPENING,
  BROWSER_GONE_OPENING,
  BROWSER_RETURNED_OPENING,
  CARD_CLOSED_STEER_PREFIX,
  FINISHED_REPORT_WORDS,
  RESTART_REPLAY_NOTE,
  SETUP_CARD_FAILED_WORDS,
  WELCOME_WAKE_WORDS,
} from "../../src/core/orchestrator/wakes";
import { SEQUENCES_SEED } from "../../src/core/personal/sequencesSkill";
import { DEMO_UNPLAYED_WORDS, TYPEFACE_UNREAD_WORDS } from "../../src/core/pi/cardImages";
import {
  PREANSWERED_WORDS,
  untaggedNewMarkRefusal,
  WRITE_IN_GAP_WORDS,
} from "../../src/core/pi/cardLint";
import { BROWSER_PAY_STEP, BROWSER_SIGN_IN_STEP } from "../../src/core/pi/cardTool";
import { NOTHING_SPAWNED } from "../../src/core/pi/crewTools";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../../src/core/pi/piResources";
import { APPROVE_AND_BUILD, SAVE_AND_DEFER } from "../../src/core/prompts/cardContract";
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
import { damagedFontBytes, projectFontBytes } from "../helpers/fontFixture";
import { mp4 } from "../helpers/mp4Fixture";
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
import {
  DEMO_CAPTION,
  DEMO_POSTER,
  DEMO_RECORDING,
  GIF_DEMO_RECORDING,
  LOOPING_GIF_DEMO,
} from "./demoFixtures";
import { GITLAB_STUB_OTHER_PROJECT, GITLAB_STUB_PROJECT } from "./gitlabStub";
import {
  chessItems,
  FRACTION_ITEMS,
  LESSON_CHESS_ASK,
  LESSON_CHESS_CARD_ID,
  LESSON_CHESS_GOAL,
  LESSON_CHESS_TITLE,
  LESSON_FRACTIONS_ASK,
  LESSON_FRACTIONS_GOAL,
  LESSON_FRACTIONS_GOAL_BODY,
  LESSON_FRACTIONS_GOAL_TITLE,
  LESSON_FRACTIONS_ROUND_TITLE,
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
  dataUrl,
  FIRST_GROUP,
  INLINE_PICTURE,
  type PictureFixture,
  SECOND_GROUP,
  TALL_PICTURE,
  WIDE_PICTURE,
  WORKING_COPY_PICTURES,
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

/**
 * Marker steer: the card-kinds crewmate revises its "Quota note" in place
 * (same id, WI-12), so a collapsed note can come back (fable review M1).
 */
export const REVISE_NOTE_PROMPT_MARKER = "revise the quota note";
export const MOCK_REVISED_NOTE_TEXT = "Codex weekly is now at 58% - still routing on pace.";

/** Marker prompt: the mock crewmate emits three cards whose bodies carry scripts (WI-16). */
export const SCRIPT_CARDS_PROMPT_MARKER = "show scripted cards";
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

/** Marker prompt: the mock crewmate emits a note, a decision and a scripted card, each with a local-subdomain link. */
export const LOCAL_LINK_CARDS_PROMPT_MARKER = "show the local link cards";
export const LOCAL_LINK_HREF =
  "http://task-c5db2568.soapbox.localhost:1355/reports/probe?view=agenda";
export const LOCAL_LINK_CARD_TITLES = {
  note: "Local link note",
  decision: "Local link decision",
  scripted: "Local link scripted",
} as const;

function localLinkCardToolCalls(): ScriptedCall[] {
  const anchor = `<a href="${LOCAL_LINK_HREF}">Open the report</a>`;
  return [
    {
      name: "emit_card",
      args: { title: LOCAL_LINK_CARD_TITLES.note, body: `<p>${anchor}</p>` },
    },
    {
      name: "emit_card",
      args: {
        title: LOCAL_LINK_CARD_TITLES.decision,
        body: `<p>The report is ready to read.</p><p>${anchor}</p>`,
        actions: [
          { id: "keep", label: "Keep it", default: true },
          { id: "drop", label: "Drop it" },
        ],
      },
    },
    {
      name: "emit_card",
      args: {
        title: LOCAL_LINK_CARD_TITLES.scripted,
        body:
          "<p></p><script>const link = document.createElement('a');" +
          `link.href = ${JSON.stringify(LOCAL_LINK_HREF)}; link.textContent = 'Open the report';` +
          "document.querySelector('p').append(link);</script>",
      },
    },
  ];
}

function scriptCardToolCalls(port: number): ScriptedCall[] {
  const note = (title: string, body: string): ScriptedCall => ({
    name: "emit_card",
    args: { title, body },
  });
  return [
    note(
      SCRIPT_CARD_TITLES.canvas,
      '<p>Drawn by the card.</p><canvas width="120" height="40"></canvas>' +
        '<script>const sample = "</body>"; const canvas = document.querySelector("canvas");' +
        'const ink = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "cyan";' +
        'const pen = canvas.getContext("2d"); pen.fillStyle = ink; pen.fillRect(0, 0, 120, 40);</script>',
    ),
    note(
      SCRIPT_CARD_TITLES.fetch,
      '<p role="status">pending</p>' +
        `<script>const out = document.querySelector("[role=status]");` +
        `fetch("http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}").then(` +
        `() => { out.textContent = "reached"; }, () => { out.textContent = "blocked"; });</script>`,
    ),
    note(
      SCRIPT_CARD_TITLES.runaway,
      "<p>This card never yields.</p><script>while (true) {}</script>",
    ),
    note(
      SCRIPT_CARD_TITLES.figure,
      "<figure><div></div><figcaption>Drawn by the card itself.</figcaption></figure>" +
        '<script>const ns = "http://www.w3.org/2000/svg";' +
        'const svg = document.createElementNS(ns, "svg");' +
        'svg.setAttribute("viewBox", "0 0 480 40"); svg.setAttribute("width", "100%");' +
        'svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "One crewmate, running");' +
        'const dot = document.createElementNS(ns, "circle");' +
        'dot.setAttribute("cx", "12"); dot.setAttribute("cy", "20"); dot.setAttribute("r", "6");' +
        'dot.setAttribute("style", "fill:var(--ok)"); svg.append(dot);' +
        'document.querySelector("figure div").append(svg);</script>',
    ),
  ];
}
/**
 * Marker prompt: the mock crewmate emits the containment corpus - every
 * attack vector the retired sanitizer used to strip, in one body per
 * vehicle. There is no sanitizer any more (captain decision, 2026-09-15):
 * the frame's sandbox, its CSP and the host's bridge validation are the
 * boundary, and `tests/e2e/card-containment.spec.ts` measures them.
 */
export const ATTACK_CARDS_PROMPT_MARKER = "show the containment corpus";
export const ATTACK_CARD_TITLES = {
  /** No `<script>` element, so this body rides srcdoc. */
  srcdoc: "Containment corpus",
  /** Carries scripts, so the host serves it as a card mount. */
  mount: "Containment corpus with scripts",
  /** A `data:` image, the one thing a frame may now load (captain decision). */
  image: "Inline image",
  /** Navigation of the frame away from its own document: a self-inflicted nuisance. */
  selfNav: "Navigating away",
} as const;
/** Any vector that executes sets this on the frame's window; none may. */
export const ATTACK_MARKER = "fmAttackRan";
/** A 2x2 opaque red PNG: small enough to read back pixel by pixel. */
export const INLINE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91" +
  "JpzAAAAFElEQVR4nGP8z4AATAxQxhAXAAAA//8DTQEBc0GFdgAAAABJRU5ErkJggg==";

/**
 * Every vector that needs no `<script>` element of its own: event handler
 * attributes, `javascript:` URLs, and every element that names a resource.
 * Each URL aims at the mock server's probe path, which counts what arrives.
 */
function scriptlessAttackBody(probe: string): string {
  const M = ATTACK_MARKER;
  const fire = `window.${M} = true`;
  return (
    `<p onclick="${fire}" onmouseover="${fire}">Every vector the sanitizer used to strip.</p>` +
    `<div onload="${fire}" onerror="${fire}" onfocus="${fire}" onanimationstart="${fire}"></div>` +
    `<details ontoggle="${fire}"><summary onfocus="${fire}">Evidence</summary>` +
    `<a href="javascript:${fire}">a javascript URL</a>` +
    `<a href="${probe}?anchor" download="x.txt">a download</a></details>` +
    `<img src="${probe}?img" onerror="${fire}" alt="">` +
    `<iframe src="${probe}?iframe"></iframe>` +
    `<object data="${probe}?object"></object><embed src="${probe}?embed">` +
    `<link rel="stylesheet" href="${probe}?link">` +
    `<style>@import url(${probe}?import);.x{background-image:url(${probe}?css)}</style>` +
    `<base href="${probe}/">` +
    `<form action="${probe}?form" method="post"><button type="submit">Submit</button></form>` +
    `<video src="${probe}?video" autoplay><source src="${probe}?source"></video>` +
    `<audio src="${probe}?audio" autoplay></audio>` +
    `<svg><image href="${probe}?svgimage"></image>` +
    `<use href="${probe}?use#icon"></use>` +
    `<a href="javascript:${fire}"><text>svg link</text></a>` +
    `<set attributeName="href" to="javascript:${fire}"></set>` +
    `<foreignObject width="80" height="20"><iframe src="${probe}?fo"></iframe></foreignObject>` +
    "</svg>"
  );
}

/**
 * The same corpus on the mount vehicle, plus the two vectors that need a
 * script element: a `<script src>` the CSP must refuse, and a script the
 * card injects at run time, which has no hash. The card's OWN inline script
 * runs by design (WI-16) and is what reports both verdicts.
 */
function scriptedAttackBody(probe: string): string {
  const M = ATTACK_MARKER;
  return (
    scriptlessAttackBody(probe) +
    `<p role="status">pending</p>` +
    `<script src="${probe}?scriptsrc"></script>` +
    "<script>(function () {" +
    `var injected = document.createElement("script");` +
    `injected.textContent = "window.${M} = true;";` +
    "document.body.appendChild(injected);" +
    `var img = new Image(); img.src = ${JSON.stringify(`${probe}?runtimeimg`)};` +
    `fetch(${JSON.stringify(`${probe}?fetch`)}).catch(function () {});` +
    `try { new WebSocket(${JSON.stringify(probe.replace("http://", "ws://"))}); } catch (e) {}` +
    `try { navigator.sendBeacon(${JSON.stringify(`${probe}?beacon`)}); } catch (e) {}` +
    `document.querySelector("[role=status]").textContent = "ran";` +
    "})();</script>"
  );
}

function attackCardToolCalls(port: number): ScriptedCall[] {
  const probe = `http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}`;
  return [
    {
      name: "emit_card",
      args: { title: ATTACK_CARD_TITLES.srcdoc, body: scriptlessAttackBody(probe) },
    },
    {
      name: "emit_card",
      args: { title: ATTACK_CARD_TITLES.mount, body: scriptedAttackBody(probe) },
    },
    {
      name: "emit_card",
      args: {
        title: ATTACK_CARD_TITLES.image,
        body: `<p>An image the body carries itself.</p><img src="${INLINE_PNG}" width="2" height="2" alt="">`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: ATTACK_CARD_TITLES.selfNav,
        body:
          `<p>This body navigates its own frame.</p>` +
          `<meta http-equiv="refresh" content="0;url=${probe}?meta">`,
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
 * Marker prompt: the mock crewmate writes real picture files into its
 * working copy with bash, then names them in its card bodies - the real card
 * path since card pictures phase 2 (`tests/e2e/card-picture-fit.spec.ts`):
 * one wide and one tall picture alone, a card mixing lone pictures with one
 * the body carries itself as a `data:` URL, and a card with two groups.
 */
export const CARD_PICTURES_PROMPT_MARKER = "show the card pictures";
export const PICTURE_CARD_TITLES = {
  wide: "A wide picture",
  tall: "A tall picture",
  mixed: "Pictures of every shape",
  groups: "Two groups of pictures",
} as const;
const PICTURE_GROUP_CAPTION = "Before and after, at 640 px";

/**
 * The longest command one bash call carries: `bash -c` takes its command as
 * one argument, and Linux refuses an argument over 128 KiB, so a crewmate
 * there writes a long run of files in several calls (a Mac allows far more).
 */
const LONGEST_COMMAND = 128 * 1024 - 1;

/** The bash calls a mock crewmate writes `files` into `shots/` of its working copy with, one file each. */
function writeFilesCalls(files: ReadonlyArray<{ path: string; bytes: Buffer }>): ScriptedCall[] {
  return files.map(({ path, bytes }) => {
    const command = `mkdir -p shots && printf '%s' '${bytes.toString("base64")}' | base64 --decode > ${path}`;
    if (Buffer.byteLength(command) > LONGEST_COMMAND) {
      throw new Error(`${path} is too long to write in one bash call on Linux`);
    }
    return { name: "bash", args: { command } };
  });
}

const pictureFile = (picture: PictureFixture) => ({ path: picture.path, bytes: bytesOf(picture) });

function writePicturesCalls(): ScriptedCall[] {
  return writeFilesCalls(WORKING_COPY_PICTURES.map(pictureFile));
}

function pictureCardToolCalls(): ScriptedCall[] {
  const img = (picture: PictureFixture) => `<img src="${picture.path}" alt="${picture.alt}">`;
  return [
    {
      name: "emit_card",
      args: {
        title: PICTURE_CARD_TITLES.wide,
        body: `<p>The meter row now reads on the first paint, all five meters in one line.</p>${img(WIDE_PICTURE)}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: PICTURE_CARD_TITLES.tall,
        body: `<p>The transcript keeps its newest line in view after every turn.</p>${img(TALL_PICTURE)}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: PICTURE_CARD_TITLES.mixed,
        body:
          "<p>The settings screen, the meter row and the transcript, as they look now.</p>" +
          `<img src="${dataUrl(INLINE_PICTURE)}" alt="${INLINE_PICTURE.alt}">` +
          img(WIDE_PICTURE) +
          img(TALL_PICTURE),
      },
    },
    {
      name: "emit_card",
      args: {
        title: PICTURE_CARD_TITLES.groups,
        body:
          "<p>The row no longer wraps at 640 px.</p>" +
          `<figure class="inf-pictures">${FIRST_GROUP.map(img).join("")}<figcaption>${PICTURE_GROUP_CAPTION}</figcaption></figure>` +
          "<p>The checks passed on the change, in both themes.</p>" +
          `<figure class="inf-pictures">${SECOND_GROUP.map(img).join("")}</figure>`,
      },
    },
  ];
}

/**
 * Marker prompt (contract v4.69, `tests/e2e/card-before-after.spec.ts`): the
 * mock crewmate writes two before pictures and three after pictures, one of
 * them of a new view, and offers a completion decision that shows them. Its
 * first card marks the new picture itself, where no New tag can be drawn; it
 * reads the card check's refusal and offers the card again with the mark on
 * the picture's figure.
 */
export const BEFORE_AFTER_PROMPT_MARKER = "show the before and after";
export const BEFORE_AFTER_CARD_TITLE = "The meter row and transcript read at a glance";
export const BEFORE_AFTER_NEW_PICTURE = CHANGE_AFTER_PICTURES[2] as PictureFixture;
export const BEFORE_AFTER_MARK_REFUSAL = untaggedNewMarkRefusal("img");

function writeChangePicturesCalls(): ScriptedCall[] {
  return writeFilesCalls([...CHANGE_BEFORE_PICTURES, ...CHANGE_AFTER_PICTURES].map(pictureFile));
}

function beforeAfterCardCall(newMark: "figure" | "picture"): ScriptedCall {
  const mark = (fresh: boolean, on: typeof newMark) =>
    fresh && newMark === on ? " data-inf-new" : "";
  const view = (picture: PictureFixture, caption: string, fresh = false) =>
    `<figure${mark(fresh, "figure")}><img${mark(fresh, "picture")} src="${picture.path}" alt="${picture.alt}"><figcaption>${caption}</figcaption></figure>`;
  const [meterBefore, transcriptBefore] = CHANGE_BEFORE_PICTURES as [
    PictureFixture,
    PictureFixture,
  ];
  const [meterAfter, transcriptAfter, history] = CHANGE_AFTER_PICTURES as [
    PictureFixture,
    PictureFixture,
    PictureFixture,
  ];
  return {
    name: "emit_card",
    args: {
      title: BEFORE_AFTER_CARD_TITLE,
      body: completionCardBody(
        "<p>The meter row and the transcript were hard to read at a glance.</p>",
        "<p>Both views are rearranged, and a history list is added.</p>",
        `<p>The meters wrapped and the transcript ran together.</p>${view(meterBefore, "The meter row")}${view(transcriptBefore, "The transcript")}`,
        `<p>The meters sit in one line and the transcript has room.</p>${view(meterAfter, "The meter row")}${view(transcriptAfter, "The transcript")}${view(history, "The history list", true)}`,
      ),
      actions: [
        {
          id: "put-in",
          label: "Put it in",
          default: true,
          effect: { kind: "settle", mode: "merge" },
        },
      ],
    },
  };
}

/**
 * Marker prompt (demo recordings, `tests/e2e/card-demo.spec.ts`): the mock
 * crewmate writes a demo recording and its poster into its working copy,
 * beside a recording whose boxes are sound and whose pictures are filler.
 * It offers its completion decision with that recording first - which the
 * host's decoder refuses - then, reading the refusal, with the real one: a
 * still picture under Before, the demo under After.
 */
export const DEMO_PROMPT_MARKER = "show the demo";
export const DEMO_CARD_TITLE = "Dragging the box moves it";
export const DEMO_REFUSAL = DEMO_UNPLAYED_WORDS;
const BROKEN_DEMO = "shots/filler-demo.mp4";

function writeDemoCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: DEMO_RECORDING.path, bytes: DEMO_RECORDING.bytes },
    pictureFile(DEMO_POSTER),
    {
      path: BROKEN_DEMO,
      bytes: mp4({ width: DEMO_RECORDING.width, height: DEMO_RECORDING.height, seconds: 3 }),
    },
  ]);
}

function demoCardCall(recording: string, title = DEMO_CARD_TITLE): ScriptedCall {
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

/**
 * Marker prompt (GIF demos, `tests/e2e/card-demo-gif.spec.ts`): the mock
 * crewmate could make no MP4, so it attaches the single-play GIF fallback.
 * It offers its completion decision with a GIF told to loop first - which
 * the host refuses - then, reading the refusal, with the one that plays once.
 */
export const GIF_DEMO_PROMPT_MARKER = "show the gif fallback";
export const GIF_DEMO_CARD_TITLE = "Dragging the box moves it, shown once";
export const GIF_DEMO_REFUSAL = GIF_LOOP_WORDS;

function writeGifDemoCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: GIF_DEMO_RECORDING.path, bytes: GIF_DEMO_RECORDING.bytes },
    { path: LOOPING_GIF_DEMO.path, bytes: LOOPING_GIF_DEMO.bytes },
    pictureFile(DEMO_POSTER),
  ]);
}

/**
 * Marker prompt (project fonts, `tests/e2e/card-containment.spec.ts`): the
 * mock crewmate writes its project's own font file into its working copy,
 * beside a copy damaged inside its compressed data, and names one in a
 * preview's `@font-face`. It offers the preview with the damaged copy first
 * - which the host's test load refuses - then, reading the refusal, with
 * the real file. The same preview names a second face by a web address,
 * first in its family list, which no frame loads.
 */
export const PROJECT_FONT_PROMPT_MARKER = "show the project font";
export const PROJECT_FONT_CARD_TITLE = "The balance screen in the project's own type";
/** The family the preview's `@font-face` names the project's file by. */
export const PROJECT_FONT_FAMILY = "Project Face";
export const PROJECT_FONT_REFUSAL = TYPEFACE_UNREAD_WORDS;
const PROJECT_FONT = "shots/project-face.woff2";
const DAMAGED_FONT = "shots/project-face-damaged.woff2";

function writeProjectFontCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: PROJECT_FONT, bytes: projectFontBytes() },
    { path: DAMAGED_FONT, bytes: damagedFontBytes() },
  ]);
}

function projectFontCardCall(font: string, port: number): ScriptedCall {
  const probe = `http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}`;
  return {
    name: "emit_card",
    args: {
      title: PROJECT_FONT_CARD_TITLE,
      body:
        "<p>The balance screen, drawn in the project's own type.</p>" +
        "<style>" +
        `@font-face{font-family:"${PROJECT_FONT_FAMILY}";font-weight:300 700;src:url("${font}") format("woff2")}` +
        `@font-face{font-family:"Web Face";src:url("${probe}?font") format("woff2")}` +
        // The web face comes first, so the frame tries it - and loads nothing - before the project's.
        `.balance{font-family:"Web Face","${PROJECT_FONT_FAMILY}",sans-serif;background:#fbf4e6;color:#1d2a24;border-radius:16px;padding:16px 20px;max-width:320px}` +
        ".balance h2{margin:0 0 6px;font-size:22px;font-weight:700;color:#1d2a24}.balance p{margin:0;color:#1d2a24}" +
        ".balance .amount{font-size:40px;font-weight:700}" +
        "</style>" +
        `<div class="balance"><h2>Eddie's Wallet</h2><p>Balance</p><p class="amount">$42.50</p><p>Saving for a bike - 3 weeks to go</p></div>`,
    },
  };
}

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
 * The Sep 15 Claude crewmate case (contract v2.0): a completion card whose
 * body arrives entity-escaped. The mock crewmate emits it that way first,
 * and emits the raw-tag version only after the tool result names the
 * escaping - so the corrected card on screen is proof the refusal said so.
 */
export const ESCAPED_CARD_PROMPT_MARKER = "show an escaped card";
export const MOCK_ESCAPED_CARD_TITLE = "Transcript scroll is fixed";
export const MOCK_ESCAPED_CARD_LEAD = "PR 140 keeps the transcript on its newest line.";
const MOCK_ESCAPED_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the branch",
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
];
/** The escaped card's one list item, which the frame must show as words, never as markup. */
export const MOCK_ESCAPED_CARD_ITEM = "Scrolls with the stream, stops when you scroll up.";
const MOCK_ESCAPED_CARD_BODY = completionCardBody(
  "<p>The newest transcript line should stay in view.</p>",
  "<p>The transcript follows the stream until you scroll up.</p>",
  "<p>The newest line could scroll out of view.</p>",
  `<p>${MOCK_ESCAPED_CARD_LEAD}</p><ul><li>${MOCK_ESCAPED_CARD_ITEM}</li></ul>`,
);
const ESCAPED_BODY_REFUSAL_PHRASE = "arrived HTML-escaped";
/**
 * Delivery rigor, phase 1 (the standard tier): a crewmate briefed with
 * "ship at the standard tier" reports under the five headings the tier
 * prescribes and emits its completion card with the four-heading outline.
 * The mock is the shape the prompt asks for, so
 * the e2e proves the shape renders through the real emit -> lint -> frame
 * path and the report reaches the feed - not that a model obeyed.
 */
export const STANDARD_TIER_PROMPT_MARKER = "ship at the standard tier";
export const STANDARD_TIER_MISSING_HEADING_MARKER = "ship at the standard tier missing a heading";
export const MOCK_STANDARD_CARD_TITLE = "The meter test is steady";
export const STANDARD_TIER_HEADINGS = [
  "Intent",
  "What changed",
  "Verified",
  "Risk",
  "Not done",
] as const;
const MOCK_STANDARD_SECTIONS: Record<(typeof STANDARD_TIER_HEADINGS)[number], string> = {
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
const MOCK_STANDARD_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the branch",
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
];
/**
 * Cards as threads, phase 1. Three marked crewmates, one per scenario the
 * captain's build order names as binding evidence:
 *
 *  - `THREAD_PROMPT_MARKER` emits a plain decision card and then answers
 *    the captain's replies the two ways the shared contract prescribes -
 *    a REVISION of the card under the same id when his words change what
 *    the card should say, and a prose `reply` when nothing on it changes.
 *  - `THREAD_SETTLE_PROMPT_MARKER` emits a completion card and, on a reply
 *    asking for the change to go in, closes its own card and reports the
 *    captain's words verbatim - the settle hand-off, with no classifier
 *    anywhere: the crewmate's instruction does the routing and the report
 *    wake is what reaches the Firstmate.
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
/**
 * Unpicked choices (contract 4.56; tests/e2e/card-questions.spec.ts): a
 * crewmate that first writes its required questions already answered, the
 * way cards were authored before 4.56, reads the card lint's refusal from
 * the tool result, and emits the same card again with every choice unpicked
 * and its recommendations marked.
 */
export const UNPICKED_PROMPT_MARKER = "ask the release questions unpicked";
export const UNPICKED_TITLE = "Two calls settle the release notes";
export const UNPICKED_DEFAULT_LABEL = "Ship the notes";
export const UNPICKED_REFUSAL = PREANSWERED_WORDS;
export function unpickedQuestionsBody(preanswered: boolean): string {
  return [
    "<p>The release notes can go out once two calls are made.</p>",
    "<p>Both calls change who reads the notes and when they arrive.</p>",
    "<fieldset><legend>Who reads the notes?</legend>",
    `<label><input type="radio" name="audience" value="project" required ${preanswered ? "checked" : "data-inf-recommended"}> The whole project</label>`,
    '<label><input type="radio" name="audience" value="me"> Only me</label>',
    '<label><input type="radio" name="audience" value="other" data-inf-write-in> Something else</label>',
    "</fieldset>",
    '<label for="ship-day">When should they arrive?</label><select id="ship-day" name="ship-day" required>',
    preanswered
      ? '<option value="friday" selected>Friday</option>'
      : '<option value="">Choose</option><option value="friday" data-inf-recommended>Friday</option>',
    '<option value="monday">Monday</option><option value="other" data-inf-write-in>Something else</option></select>',
  ].join("");
}
/**
 * Something else (FI3-1002; tests/e2e/card-questions.spec.ts): a crewmate
 * that first asks its questions with no Something else row, reads the card
 * lint's refusal from the tool result, and emits the same card again with
 * the row on each question - one question opted out with
 * `data-inf-options-only` instead.
 */
export const WRITE_IN_PROMPT_MARKER = "ask the launch questions with a way out";
export const WRITE_IN_TITLE = "Two calls before the launch check";
export const WRITE_IN_DEFAULT_LABEL = "Send answers";
export const WRITE_IN_REFUSAL = WRITE_IN_GAP_WORDS;
export function writeInQuestionsBody(rows: boolean): string {
  return [
    "<p>The launch check can run once you make two calls.</p>",
    "<p>Your key's app did not answer when this Mac woke.</p>",
    "<fieldset><legend>What should happen when your key's app does not answer?</legend>",
    '<label><input type="radio" name="key_app" value="retry" required data-inf-recommended> Keep trying quietly, and say it once</label>',
    '<label><input type="radio" name="key_app" value="keep" required> Keep it as built</label>',
    rows
      ? '<label><input type="radio" name="key_app" value="other" required data-inf-write-in> Something else</label>'
      : "",
    "</fieldset>",
    '<label for="retry_every">How often should it try again?</label><select id="retry_every" name="retry_every">',
    '<option value="">Choose</option><option value="5m" data-inf-recommended>Every 5 minutes</option><option value="wake">Only when this Mac wakes</option>',
    rows ? '<option value="other" data-inf-write-in>Something else</option>' : "",
    "</select>",
    "<fieldset data-inf-options-only><legend>Which account runs the check?</legend>",
    '<label><input type="radio" name="account" value="work" data-inf-recommended> Work account</label>',
    '<label><input type="radio" name="account" value="home"> Home account</label>',
    "</fieldset>",
  ].join("");
}
/**
 * Card evidence (docs/card-evidence.md, "The stage"): a crewmate that puts
 * its card up with its report, then revises the same card in the same turn
 * and keeps working, held until the spec releases it or the app closes. The
 * stage keeps showing the first offer while the stored head is the second,
 * so a click on the stage chooses from an offer the card row no longer holds.
 */
export const STALE_OFFER_PROMPT_MARKER = "revise the offer after reporting";
export const STALE_OFFER_TITLE = "Retry on the queue flush";
export const STALE_OFFER_REVISED_TITLE = "Retry on the clock instead";
export const STALE_OFFER_CHOICE_LABEL = "Retry on the flush";

/**
 * A crewmate whose one long turn the app closes under, again and again
 * (quit-mid-turn.spec.ts; docs/inbox.md, "A turn a quit or crash cut"). Its
 * turn is held open - the model still working - each time its message
 * arrives, until that message has come back after RESTART_REPLAY_QUITS
 * restarts, each one saying so; then it reports.
 */
export const RESTART_REPLAY_PROMPT_MARKER = "keep working through restarts";
export const RESTART_REPLAY_QUITS = 3;
export const MOCK_RESTART_REPLAY_REPORT =
  "I picked the work up again after three restarts and checked what had already happened first.";

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
/**
 * What changed since the captain looked (the accepted FI3-472 plan): the
 * Firstmate puts one card up and revises it under the same id, one version
 * per captain turn - "show the change marks at version 3". Its cards redraw
 * at once, so each turn is one revision on the stage.
 */
export const CHANGE_MARKS_PROMPT_MARKER = "show the change marks at version ";
export const CHANGE_MARKS_TITLE = "Two ways to fix the flaky upload test";
const CHANGE_MARKS_FIGURE = (fill: string, label: string) =>
  `<figure aria-label="${label}"><svg viewBox="0 0 510 40" width="100%" role="img" aria-label="${label}"><rect x="0" y="8" width="510" height="24" rx="6" style="fill:${fill}"/></svg></figure>`;
const CHANGE_MARKS_V2 =
  "<p>The upload test fails when the queue drains late.</p>" +
  "<p>Mocking the clock also fixes the retry failure you asked about.</p>" +
  "<ul><li>Mock the clock: 12 lines, tests only</li><li>Await the queue: 40 lines, touches the uploader</li></ul>" +
  "<table><tr><th>Route</th><th>Lines</th></tr><tr><td>Mock the clock</td><td>12</td></tr><tr><td>Await the queue</td><td>40</td></tr></table>" +
  CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix") +
  "<p>Evidence is in the CI log.</p>";
const CHANGE_MARKS_QUESTION =
  '<fieldset><legend>Which route?</legend><label><input type="radio" name="route" value="clock" checked> Mock the clock</label><label><input type="radio" name="route" value="queue"> Await the queue</label><label><input type="radio" name="route" value="other" data-inf-write-in> Something else</label></fieldset>';
/** The figure version 7 adds: ten runs, one more on each press of Next run. */
const CHANGE_MARKS_PLAYABLE_FIGURE =
  '<figure aria-label="Ten runs after the fix, one more on each press">' +
  '<button type="button">Next run</button>' +
  '<svg viewBox="0 0 510 64" width="100%" role="img" aria-label="Ten runs, all passed">' +
  Array.from(
    { length: 10 },
    (_, i) =>
      `<rect data-run x="${i * 51}" y="8" width="45" height="24" rx="6" style="fill:var(--ok);transition:opacity var(--dur-med) var(--ease-out)"/>`,
  ).join("") +
  '<text data-runs-label x="0" y="54" style="fill:var(--fg-2)">10 of 10 passed</text>' +
  "</svg>" +
  "<script>(function(){var figure=document.currentScript.closest('figure');var runs=figure.querySelectorAll('[data-run]');var label=figure.querySelector('[data-runs-label]');var shown=runs.length;figure.querySelector('button').addEventListener('click',function(){shown=shown%runs.length+1;runs.forEach(function(run,i){run.style.opacity=i<shown?'1':'0';});label.textContent=shown+' of '+runs.length+' passed';});})();</script>" +
  "</figure>";
/** Each version's body, by the number the captain names. */
export const CHANGE_MARKS_VERSIONS: Record<number, string> = {
  1:
    "<p>The upload test fails when the queue drains late.</p>" +
    "<ul><li>Mock the clock: 12 lines, tests only</li><li>Rewrite the uploader: 200 lines</li></ul>" +
    "<table><tr><th>Route</th><th>Lines</th></tr><tr><td>Mock the clock</td><td>12</td></tr></table>" +
    CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix") +
    "<p>Evidence is in the CI log.</p>",
  // One new paragraph, one list item and one table row changed or added.
  2: CHANGE_MARKS_V2,
  // A question, then (unseen) a new drawing: marked together.
  3: CHANGE_MARKS_V2 + CHANGE_MARKS_QUESTION,
  4:
    CHANGE_MARKS_V2.replace(
      CHANGE_MARKS_FIGURE("var(--bg-3)", "Ten runs before the fix"),
      CHANGE_MARKS_FIGURE("var(--ok-dim)", "Ten runs after the fix, all passed"),
    ) + CHANGE_MARKS_QUESTION,
  // Rewritten: more than half the card is new.
  5:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>",
  // A playable preview: its own script draws it, so only the line says what changed.
  6:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>" +
    "<p>Drag to replay the ten runs.</p>" +
    '<canvas id="runs" width="510" height="40"></canvas>' +
    "<script>const c=document.getElementById('runs').getContext('2d');c.fillStyle=getComputedStyle(document.body).getPropertyValue('--ok');c.fillRect(0,8,510,24);</script>",
  // A figure that moves: its script sits inside it, so the card is still
  // prose and is marked like any other.
  7:
    "<p>Await the queue: the race is gone in production too.</p>" +
    "<ul><li>40 lines in the uploader</li><li>One new test for the drain</li></ul>" +
    "<p>Ten runs passed on the Mac and in CI.</p>" +
    "<p>Press Next run to replay the ten runs one at a time.</p>" +
    CHANGE_MARKS_PLAYABLE_FIGURE,
};

export const FM_THREAD_PROMPT_MARKER = "keep a firstmate thread open";
export const FM_THREAD_CARD_TITLE = "Two ways to phrase the welcome";
export const FM_THREAD_CARD_REVISED_TITLE = "Lead with the caption, not the chips";
export const FM_THREAD_REVISE_ANSWER = "Good catch; the card now leads with the caption.";
export const FM_THREAD_PROSE_ANSWER = "The chips stay; the caption is the first thing you read.";
/** Tiny PNG the image-on-steer e2e pastes. */
export const THREAD_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const THREAD_SETTLE_PROMPT_MARKER = "hand the settle over";
export const THREAD_SETTLE_CARD_TITLE = "The queue flush is ready";
/** The captain's words under that card - a settle is not the crewmate's to run. */
export const THREAD_SETTLE_REPLY = "merge it";
/**
 * The phrase the crewmate's report carries so the mock Firstmate can find
 * the hand-off. In the product the Firstmate reads the captain's words; a
 * scripted model needs a needle, and this is it.
 */
export const THREAD_HANDOFF_PHRASE = "this one is yours to run";
export const MOCK_THREAD_HANDOFF_REPORT =
  `The captain replied under my card, verbatim: "${THREAD_SETTLE_REPLY}". ` +
  `Putting the change in is not mine to do, so I closed my card - ${THREAD_HANDOFF_PHRASE}.`;

/**
 * A crewmate on a Mac opened from the Dock (host-env e2e): a brief carrying
 * this marker runs `node --version` in its shell, then reports what came
 * back, verbatim, so the spec reads the answer off the feed.
 */
export const NODE_VERSION_PROMPT_MARKER = "say which node this Mac runs";
export const MOCK_NODE_REPORT_PREFIX = "This Mac's node answers";

/**
 * A crewmate's browser command, as it runs it in its shell
 * (docs/axi-commands.md): `infinitary-browser-axi` and its arguments, each one
 * shell word. Pi serves the shell as `bash` and Claude's client as `Bash`
 * (`servedToolName`), so one script drives both.
 */
function browser(...args: (string | number)[]): ScriptedCall {
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
function browserShellMessages(messages: ReturnType<typeof providerMessages>) {
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

/**
 * The tool answers after a place in the conversation, oldest first, each
 * browser command once in the browser's own words: one that ran past a
 * Pi shell's limit answered `running`, and its answer came with the next
 * look (`earlier`), so the two read as the one answer the browser gave.
 */
function toolAnswers(messages: ReturnType<typeof providerMessages>, from = 0): string[] {
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

/**
 * A browser journey's next step, looking again first while the crewmate's
 * last command still runs in its browser: a command past a Pi shell's
 * limit keeps running, and the bare command reads its answer.
 */
function lookingAgain(
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
 * A page that opens a release without a full load, a long passage, a time,
 * and a plain-text feed. The marker names the page; the script clicks the
 * release, tries the release link's ref from before the page moved, reads
 * the cut passage, reads the feed, photographs the whole page and reports
 * what the tools actually said.
 */
export const TASK_BROWSER_READING_MARKER = "read the release page at ";
export const MOCK_BROWSER_READING_REPORT_PREFIX = "The release page said";
export const MOCK_BROWSER_READING_PICTURE = "release-page";

function taskBrowserReadingStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/read the release page at (http:\/\/127\.0\.0\.1:\d+\/reading)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const answers = toolAnswers(providerMessages(body));
  const missing = (what: string): ScriptedCall[] => [
    {
      name: "report",
      args: {
        text: `${MOCK_BROWSER_READING_REPORT_PREFIX} nothing with ${what}: ${(answers.at(-1) ?? "").slice(0, 500)}`,
      },
    },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(
        answers[0],
        "link",
        "Firstmate 3000 0.2.1-alpha.52 (private alpha, alpha channel)",
      );
      return ref ? [browser("click", `@${ref}`)] : missing("the release link");
    }
    case 2: {
      // The release link's ref from before the page moved, used where a
      // stale ref would do least: a scroll.
      const ref = refOf(
        answers[0],
        "link",
        "Firstmate 3000 0.2.1-alpha.52 (private alpha, alpha channel)",
      );
      return ref ? [browser("scroll", `@${ref}`)] : missing("the release link");
    }
    case 3: {
      const ref = refOf(answers[1], "text", "");
      return ref ? [browser("snapshot", `@${ref}`)] : missing("a cut passage");
    }
    case 4:
      return [browser("screenshot", MOCK_BROWSER_READING_PICTURE, "--full-page")];
    case 5:
      return [browser("open", `${url}/feed`)];
    case 6: {
      const ref = refOf(answers[5], "text", "");
      return ref ? [browser("snapshot", `@${ref}`)] : missing("the feed passage");
    }
    case 7:
      return [browser("stop")];
    case 8: {
      const listed = answers[0] ?? "";
      const click = answers[1] ?? "";
      const stale = answers[2] ?? "";
      const notes = answers[3] ?? "";
      const feed = answers[6] ?? "";
      const moved = click.includes("/reading/one") ? "moved" : "stayed";
      const title = click.includes('heading "Firstmate 3000 0.2.1-alpha.52"')
        ? "new title"
        : "old title";
      const time = listed.includes("2026-10-08T21:52:52Z") ? "exact time" : "no time";
      const tip = listed.includes("Oct 8, 2026, 2:52 PM PDT") ? "title tooltip" : "no tooltip";
      const tail = notes.includes("anything stays secret in the notes")
        ? "notes in full"
        : "notes cut";
      const atom = feed.includes("feed ends with the atom tail") ? "feed in full" : "feed cut";
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_READING_REPORT_PREFIX} ${moved}, ${title}, ${time}, ${tip}, ${tail}, ${atom}. The old ref: "${firstSentence(stale)}"`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * A page too long for one answer (docs/task-browser.md, "Reading a long
 * page"). The marker names the page; the script opens it, finds words in
 * its last section, reads on from the line the first answer's next lines
 * name, scrolls down, and reports what each answer actually showed.
 */
export const TASK_BROWSER_LONG_MARKER = "read the long changelog at ";
export const MOCK_BROWSER_LONG_REPORT_PREFIX = "The long changelog said";
/** Words only the changelog's last section holds. */
export const TASK_BROWSER_LONG_LAST_WORDS = "the last release ends here";

/** The first outline line an answer shows, from its `outline:` line. */
function firstShownLine(answer: string | undefined): number | undefined {
  const line = answer?.match(/^outline: lines (\d+)-\d+ of \d+/m)?.[1];
  return line === undefined ? undefined : Number(line);
}

function taskBrowserLongStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/read the long changelog at (http:\/\/127\.0\.0\.1:\d+\/long)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const answers = toolAnswers(providerMessages(body));
  // The line the first answer says to read on from, read off its next lines.
  const readOn = answers[0]?.match(/`infinitary-browser-axi snapshot --from (\d+)`/)?.[1];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1:
      return [browser("snapshot", "--find", TASK_BROWSER_LONG_LAST_WORDS)];
    case 2:
      return [browser("snapshot", "--from", Number(readOn ?? 0))];
    case 3:
      return [browser("scroll", "down")];
    case 4:
      return [browser("stop")];
    case 5: {
      const [opened = "", found = "", read = "", scrolled = ""] = answers;
      const facts = [
        /^map\[\d+\]:$/m.test(opened) && opened.includes('region "Release 40"')
          ? "a map"
          : "no map",
        opened.includes("(same as line ") ? "folded repeats" : "no folds",
        (firstShownLine(found) ?? 1) > 1 &&
        found.includes(`text "And ${TASK_BROWSER_LONG_LAST_WORDS}."`)
          ? "found the end"
          : "did not find the end",
        readOn !== undefined && firstShownLine(read) === Number(readOn)
          ? "read on"
          : "did not read on",
        (firstShownLine(scrolled) ?? 1) > 1 && scrolled.includes(", those on screen")
          ? "scrolled past the top"
          : "scrolled to the same top",
      ];
      const sizes = answers
        .slice(0, 4)
        .map((answer) => answer.length)
        .join(", ");
      return [
        {
          name: "report",
          args: {
            text: `${MOCK_BROWSER_LONG_REPORT_PREFIX} ${facts.join(", ")}. Characters per answer: ${sizes}.`,
          },
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * A page opens a second page (docs/task-browser.md, "A second page"). A
 * brief carrying this marker, a shop and a bank this Mac serves, and a
 * site whose certificate does not verify ("pay at the shop page at
 * http://127.0.0.1:A/ with the bank at http://localhost:B/ after
 * https://localhost:C/") drives the task's own browser the way a crewmate
 * would: it opens the untrusted site first and reads the refusal, opens the
 * bank (so the shop's page may reach it), then the shop, and clicks Pay.
 * The shop opens the bank's check as a second page; the crewmate waits on
 * it for the bank to say "Ready to approve" - which it does once the spec
 * tells its server so, keeping the turn and both pages up meanwhile -
 * clicks Approve, waits for the shop to say it was paid once the check has
 * closed itself, and reports what each answer said, read off the tool
 * results, never assumed.
 */
export const TASK_BROWSER_PAGES_MARKER = "pay at the shop page at ";
export const MOCK_PAGES_REPORT_PREFIX = "The shop and its bank said";
/** The words the bank's check shows once the spec lets the crewmate approve. */
export const TASK_BROWSER_APPROVE_WORDS = "Ready to approve";

/** The second-page journey's next scripted step, from the browser answers so far. */
function taskBrowserPagesStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /pay at the shop page at (http:\/\/127\.0\.0\.1:\d+\/) with the bank at (http:\/\/localhost:\d+\/) after (https:\/\/localhost:\d+\/)/,
  );
  if (!ask) return undefined;
  const [, shop, bank, untrusted] = ask as unknown as [string, string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const last = answers.at(-1) ?? "";
  const report = (text: string): ScriptedCall[] => [
    { name: "report", args: { text: `${MOCK_PAGES_REPORT_PREFIX} ${text}` } },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", untrusted)];
    case 1:
      return [browser("open", bank)];
    case 2:
      return [browser("open", shop)];
    case 3: {
      const ref = refOf(last, "button", "Pay");
      return ref
        ? [browser("click", `@${ref}`)]
        : report(`nothing with a Pay button: ${last.slice(0, 400)}`);
    }
    default:
      break;
  }
  // Waiting on the bank's check until it is ready: each wait is up to ten seconds of turn.
  const approved = answers.some((text) => text.includes('did: Clicked button "Approve"'));
  if (!approved) {
    if (!last.includes(`Found "${TASK_BROWSER_APPROVE_WORDS}"`)) {
      return [browser("wait", TASK_BROWSER_APPROVE_WORDS)];
    }
    const ref = refOf(last, "button", "Approve");
    return ref
      ? [browser("click", `@${ref}`)]
      : report(`nothing with an Approve button: ${last.slice(0, 400)}`);
  }
  if (!last.includes('Found "Paid with"') && !last.includes("Waited")) {
    return [browser("wait", "Paid with")];
  }
  const all = answers.join("\n");
  const opened = all.match(/The page opened a second page[^.]*\./)?.[0] ?? "no second page";
  const closed = all.match(/Page 2 \([^)]+\) closed itself[^.]*\./)?.[0] ?? "it never closed";
  const paid = last.match(/text "(Paid[^"]*)"/)?.[1];
  return report(
    `"${firstSentence(answers[0])}" Then: "${opened}" The check: "${answers.some((text) => /^\s*page: 2 of 2$/m.test(text)) ? "page 2 of 2" : "one page"}". After Approve: "${closed}" The shop: "${paid}".`,
  );
}

/**
 * The captain watches a task's browser (docs/task-browser.md, "The view").
 * A brief carrying this marker, a page this Mac serves and a name ("watch
 * the sign-up page at http://127.0.0.1:PORT/ as Sam") opens the task's
 * browser there and types the name, then keeps its turn running - the
 * crewmate driving - by waiting for the page to say "Ready to send", which
 * it does once the spec tells the server so. Then it clicks Send and
 * reports what the page said, leaving its browser open: nobody drives it.
 */
export const TASK_BROWSER_WATCH_MARKER = "watch the sign-up page at ";
export const MOCK_BROWSER_WATCH_REPORT_PREFIX = "The watched sign-up page said";
/** The words the watched page shows once the spec lets the crewmate go on. */
export const TASK_BROWSER_READY_WORDS = "Ready to send";

/** The watched check's next scripted step, from the browser answers so far. */
function taskBrowserWatchStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/watch the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const last = answers.at(-1) ?? "";
  if (answers.length === 0) return [browser("open", url)];
  if (answers.length === 1) {
    const ref = refOf(last, "textbox", "Name");
    return ref
      ? [browser("fill", `@${ref}`, name)]
      : [{ name: "report", args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} no Name field.` } }];
  }
  // Driving until the page is ready: each wait is up to ten seconds of turn.
  if (!last.includes(`Found "${TASK_BROWSER_READY_WORDS}"`) && !last.includes("Clicked")) {
    return [browser("wait", TASK_BROWSER_READY_WORDS)];
  }
  if (!last.includes("Clicked")) {
    const ref = knownRefOf(answers, "button", "Send");
    return ref
      ? [browser("click", `@${ref}`)]
      : [{ name: "report", args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} no Send button.` } }];
  }
  const thanks = last.match(/text "(Thanks, [^"]+)"/)?.[1];
  return [
    {
      name: "report",
      args: { text: `${MOCK_BROWSER_WATCH_REPORT_PREFIX} "${thanks}", and left its browser open.` },
    },
  ];
}

/**
 * A card that opens its task's browser (docs/task-browser.md, "From a
 * card"). A brief carrying this marker, a page this Mac serves and a name
 * ("show the sign-up page at http://127.0.0.1:PORT/ as Sam") opens the
 * task's browser there, types the name and clicks Send by the outline's
 * refs, then emits a decision whose browser button reads "Try it" and
 * reports, leaving its browser open for the captain to try.
 */
export const TASK_BROWSER_CARD_MARKER = "show the sign-up page at ";
export const MOCK_BROWSER_CARD_TITLE = "The sign-up page thanks the name after Send";
export const MOCK_BROWSER_BUTTON = "Try it";
export const MOCK_BROWSER_CARD_REPORT = "I left the sign-up page open for the captain to try.";

/**
 * A crewmate asks the captain to sign in (docs/task-browser.md, "Asking for
 * help"). A brief carrying this marker and a page this Mac serves ("sign in
 * to the account page at http://127.0.0.1:PORT/") opens the task's browser
 * there, emits an ordinary decision that asks the captain to take the
 * browser over - the site, why, what it does after - then tries to read the
 * page once more and reports what its browser answered. Woken by the
 * captain's Return control, it clicks Sign in by its ref from before the
 * handoff, takes a fresh look - waiting for the page to say "Ready to go
 * on", which it does once the spec tells the server so - and reports what
 * each answer said, read off the tool results, never assumed.
 */
export const TASK_BROWSER_HANDOFF_MARKER = "sign in to the account page at ";
export const MOCK_HANDOFF_CARD_TITLE = "Sign in to the account page to continue";
/** Why the crewmate asks the captain to take its browser: its card's words and its request's reason. */
export const MOCK_HANDOFF_REASON = "The account page needs your sign-in";
export const MOCK_HANDOFF_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_HANDOFF_ASKED_REPORT = "I asked the captain to sign in.";
export const MOCK_HANDOFF_RETURNED_REPORT = "The captain returned my browser.";
export const TASK_BROWSER_HANDOFF_READY_WORDS = "Ready to go on";
/** The picture it takes of the signed-in page, once with a reason (docs/task-browser.md, "A signed-in page"). */
export const MOCK_SIGNED_IN_PICTURE = "signed-in-account";
export const MOCK_SIGNED_IN_PICTURE_REASON = "the task needs to show which account is signed in";
const HANDOFF_WAKE = BROWSER_RETURNED_OPENING;

/** The first sentence of an answer, as a report quotes it. */
function firstSentence(text: string | undefined): string {
  const passage =
    (text ?? "").split("\n").find((line) => line.startsWith("The captain returned control")) ??
    (text ?? "").match(/^did: (.*)$/m)?.[1] ??
    text;
  return (passage ?? "").split("\n")[0]?.split(/(?<=[.:])\s/)[0] ?? "";
}

/** The handoff's next scripted step, from the browser answers so far. */
function taskBrowserHandoffStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/sign in to the account page at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findIndex(
    (message) => message.role === "user" && message.text.includes(HANDOFF_WAKE),
  );
  const answers = (from: number) => toolAnswers(messages, from);
  if (wake === -1) {
    if (calledTool(body, "report")) return undefined;
    const before = answers(0);
    switch (before.length) {
      case 0:
        return [browser("open", url)];
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "sign-in-request",
              title: MOCK_HANDOFF_CARD_TITLE,
              body: `<p>${MOCK_HANDOFF_REASON} before I can go on, so I paused the browser on its sign-in page.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>`,
              browser_handoff: {
                site: new URL(url).host,
                reason: MOCK_HANDOFF_REASON,
                after: "read the account page and report what it says",
              },
              actions: [
                { id: "leave", label: "Leave waiting" },
                {
                  id: "sign-in",
                  label: MOCK_HANDOFF_ACTION,
                  default: true,
                  effect: { kind: "open", target: "browser" },
                },
              ],
            },
          },
        ];
      case 2:
        return [browser("snapshot")];
      case 3:
        return [
          {
            name: "report",
            args: {
              text: `${MOCK_HANDOFF_ASKED_REPORT} My browser then said: "${firstSentence(before[2])}"`,
            },
          },
        ];
      default:
        return undefined;
    }
  }
  const after = answers(wake);
  // Its report's own answer: this turn has said what it found.
  if (after.some((text) => text.startsWith("Reported."))) return undefined;
  if (after.length === 0) {
    // The Sign in button's ref from before the handoff.
    const ref = refOf(answers(0)[0], "button", "Sign in") ?? "g1:e1";
    return [browser("click", `@${ref}`)];
  }
  const looked = after.findIndex(
    (text, index) =>
      index > 0 &&
      (text.includes(`Found "${TASK_BROWSER_HANDOFF_READY_WORDS}"`) || text.includes("Waited")),
  );
  if (looked === -1) {
    return [browser("wait", TASK_BROWSER_HANDOFF_READY_WORDS)];
  }
  // The page may show the captain's account now: a picture only with a reason.
  const refused = after.find((text) =>
    text.includes("a picture is taken only when the task needs one"),
  );
  const saved = after.find((text) => /^did: Saved /m.test(text));
  if (!refused) return [browser("screenshot", MOCK_SIGNED_IN_PICTURE)];
  if (!saved) {
    return [
      browser("screenshot", MOCK_SIGNED_IN_PICTURE, "--reason", MOCK_SIGNED_IN_PICTURE_REASON),
    ];
  }
  const look = after.slice(1, looked + 1).join("\n");
  const state = look.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  const kept = ["private sign-in note", "tracker.example"].filter((word) => look.includes(word));
  return [
    {
      name: "report",
      args: {
        text: `${MOCK_HANDOFF_RETURNED_REPORT} The old ref: "${firstSentence(after[0])}" The fresh look said "${firstSentence(after[1])}" and the page said "${state}". It kept ${kept.length ? kept.join(" and ") : "nothing from the captain's time"}. A picture without a reason: "${refused.split("\n")[0]}" With one: "${saved.match(/^did: (.*?) \(/m)?.[1]}".`,
      },
    },
  ];
}

/**
 * A sign-in saved on this Mac reaches a later task (docs/task-browser.md,
 * "Saved sign-ins"). A brief carrying this marker and a club page this Mac
 * serves ("use the club page at http://127.0.0.1:PORT/ as ...") opens the
 * task's browser there and asks the captain to sign in on an ordinary
 * decision - the host may add a saved sign-in beside its own action - and
 * reports that it asked. Woken, by Return control or by the saved sign-in,
 * it opens the page again, so the club's server sees its sign-in, and
 * reports the wake's first sentence and what the page said, read off the
 * tool results, never assumed.
 */
export const TASK_BROWSER_SAVED_MARKER = "use the club page at ";
export const MOCK_SAVED_CARD_TITLE = "Sign in to the club page to continue";
export const MOCK_SAVED_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_SAVED_ASKED_REPORT = "I asked the captain to sign in to the club page.";
export const MOCK_SAVED_REPORT_PREFIX = "The club page said";
const SAVED_WAKES = [
  BROWSER_RETURNED_OPENING,
  `The captain let this task use the sign-in saved on ${HERE.this}`,
];

/** The saved sign-in journey's next scripted step, from the browser answers so far. */
function taskBrowserSavedStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/use the club page at (http:\/\/127\.0\.0\.1:\d+\/)/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findIndex(
    (message) =>
      message.role === "user" && SAVED_WAKES.some((words) => message.text.includes(words)),
  );
  const answers = (from: number) => toolAnswers(messages, from);
  if (wake === -1) {
    if (calledTool(body, "report")) return undefined;
    const before = answers(0);
    if (before.length === 0) return [browser("open", url)];
    if (before.length === 1) {
      return [
        {
          name: "emit_card",
          args: {
            id: "club-sign-in",
            title: MOCK_SAVED_CARD_TITLE,
            body: "<p>The club page needs your sign-in before I can read your membership, so I paused the browser on it.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
            browser_handoff: {
              site: new URL(url).host,
              reason: "The club page needs your sign-in",
              after: "read the club page and report what it says",
            },
            actions: [
              { id: "leave", label: "Leave waiting" },
              {
                id: "sign-in",
                label: MOCK_SAVED_ACTION,
                default: true,
                effect: { kind: "open", target: "browser" },
              },
            ],
          },
        },
      ];
    }
    // A refused card is reported as it was refused, so a spec reads why.
    const refused = before[1]?.startsWith("Card refused") ? ` ${before[1]}` : "";
    return [{ name: "report", args: { text: `${MOCK_SAVED_ASKED_REPORT}${refused}` } }];
  }
  const after = answers(wake);
  if (after.some((text) => text.startsWith("Reported."))) return undefined;
  if (after.length === 0) return [browser("open", url)];
  const state = after[0]?.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  const woken = firstSentence(messages[wake]?.text);
  return [
    {
      name: "report",
      args: { text: `${MOCK_SAVED_REPORT_PREFIX} "${state}". The wake said "${woken}"` },
    },
  ];
}

/** The browser card's next scripted step, from the browser answers so far. */
function taskBrowserCardStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/show the sign-up page at (http:\/\/127\.0\.0\.1:\d+\/) as (\w+)/);
  if (!ask) return undefined;
  const [, url, name] = ask as unknown as [string, string, string];
  const answers = toolAnswers(providerMessages(body));
  const last = answers.at(-1) ?? "";
  const missing = (what: string): ScriptedCall[] => [
    { name: "report", args: { text: `The sign-up page has no ${what}: ${last.slice(0, 400)}` } },
  ];
  switch (answers.length) {
    case 0:
      return [browser("open", url)];
    case 1: {
      const ref = refOf(last, "textbox", "Name");
      return ref ? [browser("fill", `@${ref}`, name)] : missing("Name field");
    }
    case 2: {
      const ref = knownRefOf(answers, "button", "Send");
      return ref ? [browser("click", `@${ref}`)] : missing("Send button");
    }
    case 3:
      return [
        {
          name: "emit_card",
          args: {
            id: "try-sign-up",
            title: MOCK_BROWSER_CARD_TITLE,
            body:
              `<p>The sign-up page said "Thanks, ${name}" after I typed the name and pressed Send.</p>` +
              "<p>Its browser is still open on this Mac, so you can try the page yourself.</p>",
            actions: [
              { id: "change-words", label: "Change the words" },
              { id: "looks-right", label: "Looks right", default: true },
            ],
            browser_button: MOCK_BROWSER_BUTTON,
          },
        },
      ];
    case 4:
      return [{ name: "report", args: { text: MOCK_BROWSER_CARD_REPORT } }];
    default:
      return undefined;
  }
}

/**
 * Booking a flight in a task's browser (docs/task-browser.md, "A final
 * submission"; tests/e2e/task-browser-booking.spec.ts). A brief carrying
 * this marker, the invented airline this Mac serves and a passenger ("book
 * the Lisbon flight at http://aurora.localhost:PORT/ for Sam Rivera")
 * books the way the crewmate's instructions say, on Pi and on Claude alike:
 *
 * 1. It opens the airline's search and asks which fare to prepare, on a
 *    decision whose door reads View search.
 * 2. Told to prepare the 07:40 nonstop, it selects it, meets the airline's
 *    sign-in, and asks the captain to sign in on an ordinary request card.
 *    Told the captain closed that card, it says its browser stays paused.
 * 3. Woken by Return control, it fills in the passenger details and goes on
 *    to the payment page, where it stops: its review card names the trip,
 *    the passenger, the seller, the total and currency, the baggage, the
 *    fare rules and what is still uncertain, marks a total that changed
 *    since the search, and asks the captain to make the payment himself.
 * 4. Woken again, it reads the confirmation and leaves a note with the
 *    reference, its door reading View booking.
 *
 * Every value it reports is read off the tool results, never assumed.
 */
export const TASK_BROWSER_BOOKING_MARKER = "book the Lisbon flight at ";
export const MOCK_FARES_CARD_TITLE = "Three fares fit 18 to 25 Oct";
export const MOCK_FARES_CHOICE = "Prepare the 07:40 nonstop";
export const MOCK_FARES_BUTTON = "View search";
export const MOCK_FARES_ASKED_REPORT = "I compared three fares and asked which one to prepare.";
export const MOCK_AIRLINE_SIGN_IN_TITLE = "Sign in to Aurora Air to hold the fare";
export const MOCK_AIRLINE_SIGN_IN_ACTION = BROWSER_SIGN_IN_STEP;
export const MOCK_AIRLINE_SIGN_IN_REPORT = "I asked the captain to sign in to Aurora Air.";
export const MOCK_SIGN_IN_CLOSED_REPORT =
  "The captain closed my sign-in request without choosing; my browser stays paused on the sign-in for the captain.";
export const MOCK_REVIEW_PAY_ACTION = BROWSER_PAY_STEP;
export const MOCK_REVIEW_STOP_ACTION = "Stop here";
export const MOCK_REVIEW_REPORT_PREFIX = "I prepared the booking and stopped before paying.";
export const MOCK_BOOKED_BUTTON = "View booking";
export const MOCK_BOOKED_REPORT_PREFIX = "Booked:";
/** The review card's title: the total and the site, as the payment page shows them. */
export const reviewCardTitle = (total: string, site: string): string =>
  `Ready to pay ${total} on ${site}`;
/** The booked note's title, with the reference the confirmation gave. */
export const bookedNoteTitle = (reference: string): string =>
  `Booked: London to Lisbon, 18 to 25 Oct, ${reference}`;

/** Where a booking conversation stands: the wakes it has had, newest last, by kind and place. */
type BookingSteer = { kind: "choice" | "closed" | "returned"; at: number };
function bookingSteers(messages: ReturnType<typeof providerMessages>): BookingSteer[] {
  return messages.flatMap((message, at): BookingSteer[] => {
    if (message.role !== "user") return [];
    if (message.text.includes(`chose "${MOCK_FARES_CHOICE}"`)) return [{ kind: "choice", at }];
    if (message.text.includes(CARD_CLOSED_STEER_NEEDLE)) return [{ kind: "closed", at }];
    if (message.text.includes(HANDOFF_WAKE)) return [{ kind: "returned", at }];
    return [];
  });
}

/** The tool answers after a place in the conversation, oldest first, as the scripts read them. */
function answersAfter(messages: ReturnType<typeof providerMessages>, from: number): string[] {
  return toolAnswers(messages, from);
}

/**
 * The ref an outline gave a control, by its role and the start of its name;
 * `text` with no name finds the first cut passage, the one text line a ref names.
 */
function refOf(outline: string | undefined, role: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return outline?.match(new RegExp(`${role} "${escaped}[^"]*" \\[(${REF_PATTERN})\\]`))?.[1];
}

/** A same-page action need not repeat unchanged controls. Keep refs only in the current book. */
function knownRefOf(answers: readonly string[], role: string, name: string): string | undefined {
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

/** What the review card marks when the total moved since the search. */
export function fareRoseWords(searched: string, total: string): string {
  return `The total rose from ${searched} to ${total} since the search`;
}

/** A review card for the payment page the crewmate stopped on (docs/task-browser.md, "A final submission"). */
function reviewCard(
  site: string,
  passenger: string,
  total: string,
  searched: string | undefined,
): ScriptedCall {
  const changed =
    searched && `${searched}.00` !== total
      ? `<p><mark>${fareRoseWords(searched, total)}</mark>, so I stopped for your review.</p>`
      : "";
  return {
    name: "emit_card",
    args: {
      id: "review-and-pay",
      title: reviewCardTitle(total, site),
      body:
        "<p>I filled in the booking and stopped before paying: the payment is yours to make on Aurora Air's page.</p>" +
        "<table>" +
        "<tr><td>Route</td><td>London Heathrow (LHR) to Lisbon (LIS), nonstop both ways</td></tr>" +
        "<tr><td>Dates</td><td>Sat 18 Oct, 07:40 London time · return Sat 25 Oct, 18:05 Lisbon time</td></tr>" +
        `<tr><td>Passenger</td><td>${passenger}, 1 adult</td></tr>` +
        `<tr><td>Seller</td><td>Aurora Air, ${site}</td></tr>` +
        `<tr><td>Total</td><td>${total} EUR</td></tr>` +
        "<tr><td>Baggage</td><td>1 cabin bag, no checked bag</td></tr>" +
        "<tr><td>Fare rules</td><td>Non-refundable, changes €60</td></tr>" +
        "<tr><td>Still uncertain</td><td>Seats are assigned at check-in</td></tr>" +
        "</table>" +
        changed +
        "<p>You enter the card details on Aurora Air's page. Infinitary records none of them.</p>",
      browser_handoff: {
        site,
        reason: "The final payment is yours to make",
        after: "read the confirmation and keep the reference",
      },
      actions: [
        { id: "stop-here", label: MOCK_REVIEW_STOP_ACTION },
        {
          id: "pay",
          label: MOCK_REVIEW_PAY_ACTION,
          default: true,
          effect: { kind: "open", target: "browser" },
        },
      ],
    },
  };
}

/** The booking journey's next scripted step, from the wakes and browser answers so far. */
function taskBrowserBookingStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /book the Lisbon flight at (http:\/\/aurora\.localhost:\d+\/) for ([A-Z][a-z]+ [A-Z][a-z]+)/,
  );
  if (!ask) return undefined;
  const [, url, passenger] = ask as unknown as [string, string, string];
  const site = new URL(url).host;
  const messages = providerMessages(body);
  const steers = bookingSteers(messages);
  const last = steers.at(-1);
  const answers = answersAfter(messages, last?.at ?? 0);
  // Its report's own answer: this turn has said what it found.
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  const refused = (answer: string | undefined): string =>
    answer?.startsWith("Card refused") ? ` ${answer}` : "";
  const search = answersAfter(messages, 0)[0];
  const searched = search?.match(/text "07:40 to 10:25 · nonstop · (€\d+)/)?.[1];
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", url)];
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "choose-fare",
              title: MOCK_FARES_CARD_TITLE,
              body:
                `<p>I would prepare the 07:40 nonstop at ${searched ?? "its fare"}: it costs €67 more than the cheapest and saves about 3 hours each way.</p>` +
                "<table>" +
                `<tr><td>Aurora Air · 07:40 · nonstop</td><td>${searched ?? "not shown"}</td></tr>` +
                "<tr><td>Aurora Air · 09:15 · 1 stop in Madrid</td><td>€231</td></tr>" +
                "<tr><td>Aurora Air · 13:30 · 1 stop in Paris</td><td>€254</td></tr>" +
                "</table>",
              browser_button: MOCK_FARES_BUTTON,
              actions: [
                { id: "more", label: "Show me more" },
                { id: "prepare", label: MOCK_FARES_CHOICE, default: true },
              ],
            },
          },
        ];
      case 2:
        return report(`${MOCK_FARES_ASKED_REPORT}${refused(answers[1])}`);
      default:
        return undefined;
    }
  }
  if (last.kind === "choice") {
    switch (answers.length) {
      case 0: {
        const ref = refOf(search, "link", "Select the 07:40 nonstop");
        return ref
          ? [browser("click", `@${ref}`)]
          : report(`No Select link for the 07:40 nonstop: ${(search ?? "").slice(0, 400)}`);
      }
      case 1:
        return [
          {
            name: "emit_card",
            args: {
              id: "airline-sign-in",
              title: MOCK_AIRLINE_SIGN_IN_TITLE,
              body: "<p>Aurora Air needs your account to hold the fare, so I paused the browser on its sign-in page.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
              browser_handoff: {
                site,
                reason: "Aurora Air needs your account to hold the fare",
                after: "fill in the passenger details",
              },
              actions: [
                { id: "leave", label: "Leave waiting" },
                {
                  id: "sign-in",
                  label: MOCK_AIRLINE_SIGN_IN_ACTION,
                  default: true,
                  effect: { kind: "open", target: "browser" },
                },
              ],
            },
          },
        ];
      case 2:
        return report(`${MOCK_AIRLINE_SIGN_IN_REPORT}${refused(answers[1])}`);
      default:
        return undefined;
    }
  }
  if (last.kind === "closed") return report(MOCK_SIGN_IN_CLOSED_REPORT);
  const returns = steers.filter((steer) => steer.kind === "returned").length;
  if (returns === 1) {
    const form = answers[0];
    switch (answers.length) {
      case 0:
        return [browser("snapshot")];
      case 1: {
        const ref = refOf(form, "textbox", "Full name");
        return ref
          ? [browser("fill", `@${ref}`, passenger)]
          : report(`No passenger form after the sign-in: ${(form ?? "").slice(0, 400)}`);
      }
      case 2: {
        const ref = refOf(form, "textbox", "Date of birth");
        return ref
          ? [browser("fill", `@${ref}`, "12 Mar 1988")]
          : report(`No date of birth field: ${(form ?? "").slice(0, 400)}`);
      }
      case 3: {
        const ref = refOf(form, "button", "Continue to payment");
        return ref
          ? [browser("click", `@${ref}`)]
          : report(`No Continue to payment button: ${(form ?? "").slice(0, 400)}`);
      }
      case 4: {
        const total = answers[3]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1];
        return total
          ? [reviewCard(site, passenger, total, searched)]
          : report(`No total on the payment page: ${(answers[3] ?? "").slice(0, 400)}`);
      }
      case 5: {
        const total = answers[3]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1];
        return report(
          `${MOCK_REVIEW_REPORT_PREFIX} The total is ${total}; the search said ${searched}.${refused(answers[4])}`,
        );
      }
      default:
        return undefined;
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("snapshot")];
    case 1: {
      const reference = answers[0]?.match(/text "Reference (AUR-\w+)"/)?.[1];
      if (!reference) {
        return report(`The page did not confirm the booking: ${(answers[0] ?? "").slice(0, 400)}`);
      }
      return [
        {
          name: "emit_card",
          args: {
            id: "booked",
            title: bookedNoteTitle(reference),
            body: `<p>I read Aurora Air's confirmation after you returned control. The reference is ${reference}, and the receipt went to your Aurora Air account email.</p><p>I kept the itinerary and the reference, not the page itself.</p>`,
            browser_button: MOCK_BOOKED_BUTTON,
          },
        },
      ];
    }
    case 2: {
      const reference = answers[0]?.match(/text "Reference (AUR-\w+)"/)?.[1];
      return report(`${MOCK_BOOKED_PREFIX_TEXT(reference)}${refused(answers[1])}`);
    }
    default:
      return undefined;
  }
}

const MOCK_BOOKED_PREFIX_TEXT = (reference: string | undefined): string =>
  `${MOCK_BOOKED_REPORT_PREFIX} London to Lisbon, 18 to 25 Oct, reference ${reference}. I kept the itinerary and the reference, not the page.`;

/**
 * A payment whose answer is lost, then a restart (docs/task-browser.md, "A
 * final submission"; tests/e2e/task-browser-booking.spec.ts). A brief
 * carrying this marker and the airline's payment page ("pay for the held
 * Lisbon fare at http://aurora.localhost:PORT/pay") opens the page and
 * stops before paying, on a review card that asks the captain to pay.
 * Woken by Return control on a page that could not confirm the payment, it
 * tries to reload it - as a careless crewmate would, so the browser's
 * refusal shows - then looks at My bookings and keeps watching it for a
 * confirmation that never comes, its turn running. Woken once more, after
 * the app restarted and redelivered that wake, it finds its browser gone,
 * opens My bookings afresh, and asks the captain to check in the browser,
 * on a decision that says the outcome is unknown and that it did not pay
 * again. Told that the captain chose to check on that card after the app
 * quit once more, with its browser gone, it opens My bookings again and asks
 * anew on a new card. Every value it reports is read off the tool results.
 */
export const TASK_BROWSER_LOST_MARKER = "pay for the held Lisbon fare at ";
export const MOCK_LOST_ASKED_REPORT = "I prepared the payment and stopped before paying.";
export const MOCK_LOST_CHECK_ACTION = "Open browser and check";
export const MOCK_LOST_NOT_BOOKED_ACTION = "Treat as not booked";
export const MOCK_LOST_REPORT_PREFIX = "The payment's outcome on Aurora Air is unknown.";
export const MOCK_LOST_ASKED_AGAIN_REPORT =
  "My browser was gone when the captain chose to check, so I opened My bookings again and asked anew.";
/** The decision that says the outcome is unknown. */
export const unknownCardTitle = (site: string): string => `The payment on ${site} is unknown`;

/** The decision that asks the captain to check a payment whose outcome is unknown, in the browser. */
function unknownCard(site: string, id: string, lead: string): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      id,
      title: unknownCardTitle(site),
      body: `<p>${lead}</p><p>Its bookings page shows nothing yet, and your bank may show a pending charge. Check in the browser before anything else is paid.</p>`,
      browser_handoff: {
        site,
        reason: "Aurora Air never confirmed your payment",
        after: "read what you found and report it",
      },
      actions: [
        { id: "not-booked", label: MOCK_LOST_NOT_BOOKED_ACTION },
        {
          id: "check",
          label: MOCK_LOST_CHECK_ACTION,
          default: true,
          effect: { kind: "open", target: "browser" },
        },
      ],
    },
  };
}

/** The lost payment's next scripted step, from the wakes and browser answers so far. */
function taskBrowserLostStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/pay for the held Lisbon fare at (http:\/\/aurora\.localhost:\d+\/)pay/);
  if (!ask) return undefined;
  const home = ask[1] as string;
  const site = new URL(home).host;
  const messages = providerMessages(body);
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  // The captain chose to check on a card whose browser was gone: it asks anew.
  const told = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(BROWSER_GONE_OPENING),
  );
  if (told !== -1) {
    const again = answersAfter(messages, told);
    if (again.some((text) => text.startsWith("Reported."))) return undefined;
    switch (again.length) {
      case 0:
        return [browser("open", `${home}bookings`)];
      case 1:
        return [
          unknownCard(
            site,
            "payment-unknown-again",
            "My browser was gone when you chose to check, so I opened Aurora Air's bookings again. It still has not confirmed the payment, and I did not pay again.",
          ),
        ];
      case 2:
        return report(
          `${MOCK_LOST_ASKED_AGAIN_REPORT}${again[1]?.startsWith("Card refused") ? ` ${again[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  const steers = bookingSteers(messages).filter((steer) => steer.kind === "returned");
  const last = steers.at(-1);
  const answers = answersAfter(messages, last?.at ?? 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", `${home}pay`)];
      case 1: {
        const total = answers[0]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1] ?? "the total";
        return [reviewCard(site, "Sam Rivera", total, undefined)];
      }
      case 2:
        return report(
          `${MOCK_LOST_ASKED_REPORT}${answers[1]?.startsWith("Card refused") ? ` ${answers[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  if (answers.length === 0) return [browser("snapshot")];
  const gone = answers[0]?.includes("No browser is open");
  if (!gone) {
    // Before the restart: the page could not confirm the payment.
    if (answers.length === 1) return [browser("reload")];
    if (answers.length === 2) {
      return [browser("open", `${home}bookings`)];
    }
    // Watching My bookings for a confirmation that never comes: its turn runs on.
    return [browser("wait", "Booking confirmed")];
  }
  switch (answers.length) {
    case 1:
      return [browser("open", `${home}bookings`)];
    case 2:
      return [
        unknownCard(
          site,
          "payment-unknown",
          "Aurora Air did not confirm the payment after you pressed Pay, and I did not pay again.",
        ),
      ];
    case 3: {
      const all = answersAfter(messages, 0);
      const reload = all
        .flatMap((text) => text.split("\n"))
        .map((line) => line.replace(/^did: /, ""))
        .find((line) => line.startsWith("Did not reload"));
      const listed = answers[1]?.match(/text "(No bookings yet[^"]*)"/)?.[1];
      return report(
        `${MOCK_LOST_REPORT_PREFIX} My bookings said "${listed}", and I did not pay again.${reload ? ` Reloading the unconfirmed page said: "${reload}"` : ""} After the restart my browser was gone: "${firstSentence(answers[0])}"${answers[2]?.startsWith("Card refused") ? ` ${answers[2]}` : ""}`,
      );
    }
    default:
      return undefined;
  }
}

/**
 * A payment the captain leaves unpaid (docs/task-browser.md, "A signed-in
 * page"; tests/e2e/task-browser-booking.spec.ts). A brief carrying this
 * marker and the airline's payment page ("prepare the Lisbon payment at
 * http://aurora.localhost:PORT/pay") opens the page and stops before
 * paying, on a review card that asks the captain to pay. Woken by Return
 * control on the page with his card details typed and never sent, it takes
 * its fresh look, asks for a picture of the page with a reason, and
 * reports how each card field read and what the picture's answer said.
 * Every value it reports is read off the tool results.
 */
export const TASK_BROWSER_UNPAID_MARKER = "prepare the Lisbon payment at ";
export const MOCK_UNPAID_ASKED_REPORT = "I prepared the payment for the captain to make.";
export const MOCK_UNPAID_REPORT_PREFIX = "The captain handed the payment page back unpaid.";
export const MOCK_UNPAID_PICTURE = "unpaid-payment";
/** The card fields the crewmate reads after the return, by their labels on the page. */
export const MOCK_UNPAID_FIELDS = ["Card number", "Expiry", "Security code"] as const;

/** The unpaid payment's next scripted step, from the wakes and browser answers so far. */
function taskBrowserUnpaidStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/prepare the Lisbon payment at (http:\/\/aurora\.localhost:\d+\/)pay/);
  if (!ask) return undefined;
  const home = ask[1] as string;
  const site = new URL(home).host;
  const messages = providerMessages(body);
  const last = bookingSteers(messages)
    .filter((steer) => steer.kind === "returned")
    .at(-1);
  const answers = answersAfter(messages, last?.at ?? 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  if (!last) {
    switch (answers.length) {
      case 0:
        return [browser("open", `${home}pay`)];
      case 1: {
        const total = answers[0]?.match(/text "Total (€[\d.]+) \(EUR\)"/)?.[1] ?? "the total";
        return [reviewCard(site, "Sam Rivera", total, undefined)];
      }
      case 2:
        return report(
          `${MOCK_UNPAID_ASKED_REPORT}${answers[1]?.startsWith("Card refused") ? ` ${answers[1]}` : ""}`,
        );
      default:
        return undefined;
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("snapshot")];
    case 1:
      return [
        browser(
          "screenshot",
          MOCK_UNPAID_PICTURE,
          "--reason",
          "the task needs to show what the payment page says now",
        ),
      ];
    case 2: {
      // Each field as the fresh look read it: its value, hidden, or not there.
      const lines = (answers[0] ?? "").split("\n").map((line) => line.trim());
      const read = MOCK_UNPAID_FIELDS.map((label) => {
        const line = lines.find((text) => text.startsWith(`textbox "${label}`));
        if (!line) return `${label}: missing`;
        if (line.includes(HIDDEN_VALUE_WORDS)) return `${label}: hidden`;
        return `${label}: ${line.match(/\]: ("[^"]*")/)?.[1] ?? "empty"}`;
      });
      return report(
        `${MOCK_UNPAID_REPORT_PREFIX} The fresh look read ${read.join("; ")}. The picture: "${firstSentence(answers[1])}"`,
      );
    }
    default:
      return undefined;
  }
}

/**
 * The captain takes a task's browser while its crewmate's command runs
 * (docs/task-browser.md, "Taking control"; task-browser.spec.ts). A brief
 * carrying this marker and the account page this Mac serves ("keep the
 * account page at http://127.0.0.1:PORT/ open") opens its browser there and
 * waits on the page for "Ready to go on", again and again, its turn
 * running, until its browser refuses it; then it reports that refusal and
 * the answer before it. Woken by Return control, it takes its fresh look
 * and reports what the page says, read off the tool results.
 */
export const TASK_BROWSER_TAKE_MARKER = "keep the account page at ";
export const MOCK_TAKE_REFUSED_REPORT = "The captain took my browser while I waited on the page.";
export const MOCK_TAKE_RETURNED_REPORT = "The captain handed my browser back.";

/** The take-in-flight journey's next scripted step, from the wakes and browser answers so far. */
function taskBrowserTakeStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(/keep the account page at (http:\/\/127\.0\.0\.1:\d+\/) open/);
  if (!ask) return undefined;
  const url = ask[1] as string;
  const messages = providerMessages(body);
  const wake = messages.findLastIndex(
    (message) => message.role === "user" && message.text.includes(HANDOFF_WAKE),
  );
  const answers = answersAfter(messages, wake === -1 ? 0 : wake);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  if (wake === -1) {
    if (answers.length === 0) return [browser("open", url)];
    const refused = answers.findIndex((text) =>
      text.startsWith("The captain has control of this task's browser"),
    );
    if (refused === -1) {
      return [browser("wait", TASK_BROWSER_HANDOFF_READY_WORDS)];
    }
    return report(
      `${MOCK_TAKE_REFUSED_REPORT} The command before it answered "${firstSentence(answers[refused - 1])}" Then my browser said "${firstSentence(answers[refused])}"`,
    );
  }
  if (answers.length === 0) return [browser("snapshot")];
  const state = answers[0]?.match(/text "((?:Not signed in|Signed in as [^"]+))"/)?.[1];
  return report(
    `${MOCK_TAKE_RETURNED_REPORT} The fresh look said "${firstSentence(answers[0])}" and the page said "${state}".`,
  );
}

/**
 * One task's browser reaches nothing of another's, nor a private address a
 * redirect leads to (docs/task-browser.md, "Where a page may go";
 * task-browser.spec.ts). A brief carrying this marker and a page this Mac
 * serves, "for task A", opens it twice and reports what it says. With
 * "beside" a second page's address, the crewmate opens its own page - which
 * asks the other task's server for data and a picture - then asks the
 * captain to take over the other task's site, follows two redirects of its
 * own page's, one to a public name that leads to this Mac and one to a
 * private address, opens the other task's page itself, and reports what each
 * answer said, read off the tool results.
 */
export const TASK_BROWSER_FENCE_MARKER = "fence the page at ";
export const MOCK_FENCE_A_REPORT = "Task A's page said";
export const MOCK_FENCE_B_REPORT = "Task B's browser said";

/** The fence journey's next scripted step, from the browser answers so far. */
function taskBrowserFenceStep(body: string): ScriptedCall[] | undefined {
  const ask = body.match(
    /fence the page at (http:\/\/127\.0\.0\.1:\d+\/) (for task A|beside (http:\/\/127\.0\.0\.1:\d+\/))/,
  );
  if (!ask) return undefined;
  const [, own, , other] = ask as unknown as [string, string, string, string | undefined];
  const messages = providerMessages(body);
  const answers = answersAfter(messages, 0);
  if (answers.some((text) => text.startsWith("Reported."))) return undefined;
  const report = (text: string): ScriptedCall[] => [{ name: "report", args: { text } }];
  const visits = (text: string | undefined) => text?.match(/text "(Visited [^"]+)"/)?.[1];
  if (!other) {
    switch (answers.length) {
      case 0:
        return [browser("open", own)];
      case 1:
        return [browser("open", own)];
      default:
        return report(`${MOCK_FENCE_A_REPORT} "${visits(answers[1])}".`);
    }
  }
  switch (answers.length) {
    case 0:
      return [browser("open", own)];
    case 1:
      return [
        {
          name: "emit_card",
          args: {
            id: "other-task-sign-in",
            title: "Sign in to the other task's page",
            body: "<p>The other page needs your sign-in.</p><p>I paused my browser for you.</p>",
            browser_handoff: {
              site: new URL(other).host,
              reason: "The other page needs your sign-in",
              after: "read the other page",
            },
            actions: [
              { id: "leave", label: "Leave waiting" },
              {
                id: "sign-in",
                label: "Open browser and sign in",
                default: true,
                effect: { kind: "open", target: "browser" },
              },
            ],
          },
        },
      ];
    case 2:
      return [browser("open", `${own}leave`)];
    case 3:
      return [browser("open", `${own}intranet`)];
    case 4:
      return [browser("open", other)];
    default: {
      const line = (text: string | undefined, start: string) =>
        text?.split("\n").find((each) => each.startsWith(start));
      return report(
        `${MOCK_FENCE_B_REPORT}: "${line(answers[0], `Blocked what the page asked for from other servers on ${HERE.this}`)}" The request: "${answers[1]?.split("\n")[0]}" The redirect to a public name: "${line(answers[2], `Blocked what the page asked for on ${HERE.this}'s network`)}" The redirect to a private address: "${line(answers[3], `Blocked what the page asked for on ${HERE.this}'s network`)}" The other task's page: "${visits(answers[4])}".`,
      );
    }
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
 * A project on a plain Git host (git integration PR 1.1, forge-seam e2e): a
 * brief carrying this marker saves a point in its working copy and sends it
 * up with its own shell, then declares the completion card and reports - so
 * the host's forge seam finds the sent-up copy, reads it green with no
 * checks, and the captain's click puts it in.
 */
export const SEND_UP_PROMPT_MARKER = "send the meter fix up to its host";
export const MOCK_SENT_UP_CARD_TITLE = "The meter fix is ready to go in";

export const WORKFLOW_DISPATCH_MARKER = "request the project verification workflow";
export const WORKFLOW_EVIDENCE_MARKER = "inspect the hosted measurement evidence";
/**
 * A project on GitLab (gitlab-evidence e2e): a brief carrying this marker
 * lists its version's pipelines and the failed one's jobs with
 * `github_read`, pages that job's log with `read_workflow`, saves its
 * artifacts archive with `download_artifact` and reads it, tries a write to
 * another project, and reports what each answered.
 */
export const GITLAB_EVIDENCE_MARKER = "inspect the GitLab pipeline evidence";
/**
 * locate_project's listing from the app's own sign-in (PR 1.2): a Firstmate
 * turn carrying this marker calls locate_project with the name that
 * follows it, then lands one note listing what the tool answered from
 * where the projects live.
 */
export const LOCATE_PROJECTS_PROMPT_MARKER = "which of my projects is ";
export const MOCK_LOCATED_CARD_TITLE = "Your projects where they live";

/**
 * The context's `lives` fact (git integration PR 1.3): a Firstmate turn
 * carrying this marker lands one note listing each project's `lives` as the
 * served context block carried it - what the model was told, decoded from
 * the request itself.
 */
export const PROJECT_LIVES_PROMPT_MARKER = "say where each of my projects lives";
export const MOCK_PROJECT_LIVES_CARD_TITLE = "Where each project lives";

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
export const RETRIEVAL_TASK_TITLE = "Read meterlab release facts";
export const RETRIEVAL_TASK_GOAL =
  "Read release-info.json and report its version and demo support with a citation; do not test playback.";
export const RETRIEVAL_CARD_TITLE = "Release 0.1.31 includes video demos";
export const RETRIEVAL_SOURCE = '{"version":"0.1.31","videoDemos":true}';

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
const FINISHED_WAKE_NEEDLE = FINISHED_REPORT_WORDS;
/** FI3-1581: a finished wake whose task title contains this puts a note up, then settles. */
export const OWN_RENT_TITLE = "own vs rent";
export const OWN_RENT_CARD_TITLE = "Own vs rent: owning Macs wins for steady use";
const OWN_RENT_SETTLE_DELAY_MS = 2_500;

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
export const MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE = "The meter test is steady, drawn";
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
/** The note the mock Firstmate remembers on REMEMBER_PROMPT_MARKER and retires on FORGET_PROMPT_MARKER. */
export const MOCK_NOTE = { id: "squash-merges", content: "Always squash-merge when landing work." };
export const ADOPT_REPO_PROMPT_MARKER = "manage my folder at ";
export const CLONE_REPO_PROMPT_MARKER = "manage the remote repository at ";
export const INIT_REPO_PROMPT_MARKER = "start a new project ";
export const CONFIGURE_REPO_PROMPT_MARKER = "make the repository ";
export const UNREGISTER_REPO_PROMPT_MARKER = "unregister the repository ";
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
export const REMEMBER_PROMPT_MARKER = "remember that I always squash-merge";
/**
 * Knowledge (docs/knowledge.md, knowledge.spec.ts). A crewmate whose task
 * title carries KNOWLEDGE_RECORD_PROMPT_MARKER is granted saved references.
 * It records MOCK_KNOWLEDGE_CONCEPT from MOCK_KNOWLEDGE_ARTICLE, a finding
 * citing that article, then the same link again, which must not add a
 * second concept, and reports. One whose title carries
 * KNOWLEDGE_REUSE_PROMPT_MARKER reads the concept its brief offers, follows
 * it to the finding, reads the excerpt, declares that it relied on it, and
 * reports. Both titles name the project they bind to.
 */
export const KNOWLEDGE_RECORD_PROMPT_MARKER = "learn how the harbor inbox retries";
export const KNOWLEDGE_REUSE_PROMPT_MARKER = "check the harbor wake queue";
export const MOCK_KNOWLEDGE_ARTICLE = {
  url: "https://example.com/inbox-retries",
  title: "Inbox delivery",
  author: "Ada Lovelace",
  published: "2026-01-02",
  excerpt: "A provider failure spends no delivery attempt;",
};
export const MOCK_KNOWLEDGE_CONCEPT = {
  title: "Inbox delivery",
  aliases: ["wake queue"],
  explanation: "A saved note on how a durable inbox retries a wake.",
};
export const MOCK_KNOWLEDGE_FINDING = {
  statement: "A provider failure spends no delivery attempt: the wake is retried from the inbox.",
  path: "src/inbox.ts",
  startLine: 1,
  endLine: 2,
};
export const MOCK_KNOWLEDGE_RECORD_REPORT = "Recorded how the inbox retries, with its evidence.";
export const MOCK_KNOWLEDGE_REUSE_REPORT =
  "Read the inbox finding and its evidence before checking.";
/**
 * The mock Firstmate asked to remember a fact where knowledge is on: it
 * tries remember, and on the refusal records the fact with record_knowledge.
 */
export const KNOWLEDGE_FACT_PROMPT_MARKER = "remember that deploys happen on tuesdays";
/**
 * The mock Firstmate retires every `c-` or `f-` id the turn names as
 * `id@revision`, then closes. The collapsed-panel refresh journey uses it.
 */
export const KNOWLEDGE_RETIRE_PROMPT_MARKER = "retire these knowledge entries";
/**
 * Any captain turn carrying this phrase gets its closing line after its tool
 * calls only once MOCK_SLOW_CLOSE_MS has passed, the way a real model writes
 * its final hidden line after a tool result: the Firstmate's turn stays
 * open, so what happens mid-turn and what waits for the turn's end differ
 * observably (the reply emotes).
 */
export const SLOW_CLOSE_PROMPT_MARKER = "and take your time closing";
export const MOCK_SLOW_CLOSE_MS = 2_500;
/**
 * The reply line (docs/composer.md "The last turn"): the mock Firstmate
 * answers a turn carrying SALUTE_PROMPT_MARKER with one wordless salute, and
 * closes with MOCK_FM_DONE_TEXT, which becomes the turn's reply line. Beside
 * SLOW_CLOSE_PROMPT_MARKER the turn stays open after the call, so the
 * Firstmate's bubble works a while before the reply. A turn carrying
 * WORDLESS_CLOSE_PROMPT_MARKER closes with no words after its tool calls,
 * so the line is the app's typed fallback.
 */
export const SALUTE_PROMPT_MARKER = "salute me";
export const WORDLESS_CLOSE_PROMPT_MARKER = "and close without words";
/**
 * Talk-to-personalize Step 1 (Tier A): the mock Firstmate answers each of
 * these with ONE personalize call and no card, the way the contract says.
 */
export const APP_CATALOG_PROMPT_MARKER = "catalog change ";
export const PERSONALIZE_THEME_PROMPT_MARKER = "switch to light";
export const PERSONALIZE_HIDE_PROMPT_MARKER = "hide tasks";
export const PERSONALIZE_SHOW_PROMPT_MARKER = "show tasks again";
export const PERSONALIZE_INSTRUCTION_PROMPT_MARKER = "always use compact rows in my panels";
/** The standing instruction the mock Firstmate writes for that turn. */
export const MOCK_STANDING_INSTRUCTION = "Always use compact rows in my panels.";
/**
 * Install by talking (one plugin vehicle, Phase A): "add the panel from
 * <full folder path>" -> ONE install_plugin call naming that folder, and no
 * card of the Firstmate's own - the host's consent card is the only one.
 */
export const ADD_PANEL_PROMPT_MARKER = "add the panel from ";
export const FORGET_PROMPT_MARKER = "forget the squash-merge note";
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
/** Test-only explicit release verification through the Firstmate's typed settle tool. */
export const RELEASE_PROMPT_MARKER = "verified external release for the task ";
/**
 * "finish the task <title>" -> settle it. WI-11 retired the `finish` mode
 * and the `delivered` status, so the mock now lands the task (the successor
 * close for an idle crewmate whose work is accepted): a scratch task lives
 * in the app-managed default repo, so landing its unchanged branch is a
 * clean fast-forward that closes the record as done/landed.
 */
export const FINISH_PROMPT_MARKER = "finish the task ";
export const CANCEL_PROMPT_MARKER = "cancel the task ";
export const AMBIGUOUS_PROMPT_MARKER = "which project should take this";
/** The one decision card the mock Firstmate asks with on an ambiguous request. */
export const MOCK_WHICH_PROJECT_TITLE = "Which project?";
/**
 * Escalation (intelligence-bucket routing S4). "not good enough, escalate
 * the task <title>" is the captain turn Q2 requires: the mock Firstmate
 * spawns again with `escalate_from` naming that task. The blocked-report
 * pair is the other half - a crewmate briefed with "report that you are
 * blocked" ends its turn with a report that says so, and the whose-turn
 * rule hands it to the Firstmate as an [fm-op] because the crewmate has
 * stopped; the mock Firstmate then tries the same `escalate_from` off that
 * wake, which the tool boundary must refuse.
 */
export const ESCALATE_PROMPT_MARKER = "not good enough, escalate the task ";
export const BLOCKED_REPORT_PROMPT_MARKER = "report that you are blocked";
/**
 * A project proposed after a crewmate's report (the setup card, docs/fleet.md
 * "Asking the first mate to add a project"): a crewmate briefed with "report that
 * the runner fixes need the folder at <path>" ends its turn with a report
 * saying that folder must be set up as a project first, which reaches the
 * Firstmate as an [fm-op]; the mock Firstmate then proposes it with
 * app_change project-setup, naming the work it starts once it is added.
 */
export const PROPOSE_PROJECT_PROMPT_MARKER = "report that the runner fixes need the folder at ";
const PROPOSE_PROJECT_REPORT_NEEDLE = "set up as a project first";
export const MOCK_PROPOSED_WORK = "open the pull request for the runner fixes";
export const MOCK_BLOCKED_REPORT =
  "I cannot get the meter to reset, so I am blocked; escalate this to the captain.";
const BLOCKED_REPORT_NEEDLE = "I cannot get the meter to reset";
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
export const PERSONAL_CHANGE_PROMPT_MARKER = "change my panel ";
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

/**
 * Sequences (docs/sequences.md, contracts v4.6 and v4.19): the mock Firstmate
 * opens each of these asks the way the served instructions say - an ask of
 * more than one step as a parent task left on request, the step that runs
 * now spawned under it, and the next step planned on request with the first
 * as its basis; a one-step ask as one spawn with no parent - and hands off
 * on the wakes it already receives. The crewmates are keyed by their step's
 * goal.
 */
export const SEQ_FEATURE_ASK = "the settings page feels cluttered, can we do something about it";
export const SEQ_SMALL_ASK = "the settings page title says Setings, please fix the spelling";
export const SEQ_BUG_YES_ASK = "the meter resets to zero when I reopen the app";
/** Exercise the same hand-off on the mock Claude client, not a Pi session. */
export const SEQ_CLAUDE_STEP_MARKER = "with both tasks on the Claude login";
export const SEQ_BUG_NO_ASK = "the dock flickers when I resize the window";
export const SEQ_FEATURE = {
  parent: "Declutter the settings page",
  plan: "Plan: ways to declutter settings",
  implement: "Implement the accepted direction",
} as const;
export const SEQ_SMALL = {
  implement: "Fix the settings page title spelling",
} as const;
/** Why the one-step ask skips its plan, as the mock Firstmate declares it. */
export const SEQ_SMALL_PLAN_SKIP =
  "One settings title; no rule or meaning changes; inspect the title";
export const SEQ_BUG_YES = {
  parent: "Fix the meter reset",
  reproduce: "Reproduce: the meter reset",
  fix: "Fix: the meter reset",
} as const;
export const SEQ_BUG_SHOWN_ASK = "the clock drifts when the laptop sleeps, show me the repro first";
export const SEQ_BUG_SHOWN = {
  parent: "Fix the clock drift",
  reproduce: "Reproduce: the clock drift",
  fix: "Fix: the clock drift",
} as const;
/** The captain's later word to start the fix while the repro card is still up. */
export const SEQ_START_SHOWN_FIX = "start the clock drift fix now";
export const SEQ_SHOWN_REPRO_TITLE = "The clock drift reproduces";
export const SEQ_BUG_NO = {
  parent: "Fix the dock flicker",
  reproduce: "Reproduce: the dock flicker",
  fix: "Fix: the dock flicker",
} as const;
/**
 * The seeded document's implement line, which the Firstmate relays word for
 * word as the implement step's free constraint.
 */
export const SEQ_IMPLEMENT_AMENDED_GOAL =
  "Implement the accepted direction for the settings page, including saved sample-count choices and replacement-only height motion";
export const SEQ_IMPLEMENT_LINE =
  stepLineOf(SEQUENCES_SEED, "feature", "implement") ?? "the seed has no feature implement line";
export const SEQ_PLAN_GOAL = "Propose two or three directions for the settings page as one card";
const SEQ_IMPLEMENT_GOAL = "Implement the accepted direction for the settings page";
const SEQ_SMALL_GOAL = "The settings page title reads Settings";
const SEQ_REPRODUCE_GOAL = "as reported, in a clean setup; open your report with reproduced:";
const SEQ_FIX_GOAL = "at its root; the failing check passes";
export const SEQ_PLAN_CARD_TITLE = "Two ways to declutter settings";
export const SEQ_PLAN_CHOICE = APPROVE_AND_BUILD;
export const SEQ_PLAN_CARD_BODY =
  '<p>Two directions for the settings page.</p><ul><li>Hide the rarely used rows behind one disclosure.</li><li>Group every row into three labelled sections.</li></ul><fieldset><legend>How many records?</legend><label><input type="radio" name="q2_count" value="one" checked>One record</label><label><input type="radio" name="q2_count" value="many">One per task</label><label><input type="radio" name="q2_count" value="other" data-inf-write-in>Something else</label></fieldset><label for="sample-count">Demo sample count</label><input id="sample-count" name="sample-count" type="number" value="3">';
export const SEQ_PLAN_REPORT =
  "Two directions for the settings page; grouping the rows into sections is the one I would take.";
export const SEQ_THREAD_REPLY = "B, but keep the gear icon where it is";
/** The planner's answer under its card to the captain's reply. */
export const SEQ_THREAD_ANSWER = "Noted: B keeps the gear icon where it is.";
/** The spec the planner records after the captain's tweak: the final agreed version. */
export const SEQ_PLAN_FINAL_SPEC =
  "Agreed spec: group every settings row into three labelled sections (option B), and keep the gear icon where it is.";
export const SEQ_IMPLEMENT_CARD_TITLE = "The settings page is grouped into sections";
export const SEQ_REPRODUCED_YES =
  "reproduced: yes - the meter reads zero after a reopen; the failing check is on the working copy.";
export const SEQ_REPRODUCED_NO =
  "reproduced: no - the dock held steady through forty resizes on a clean setup.";
export const SEQ_NOT_REPRODUCED_TITLE = "The dock flicker did not reproduce";
export const SEQ_NOT_REPRODUCED_WAYS = ["Fix it anyway", "Stop here"] as const;
/**
 * A plan the captain asks for on its own and saves for later (HANDOFF's
 * Save and defer): the planner offers Approve and build, Save and defer and
 * Abandon; on Save and defer the Firstmate files the build on request with
 * the plan as its basis, and starts nothing.
 */
export const SEQ_SAVED_ASK = "plan a calmer about page, I may build it later";
export const SEQ_SAVED = {
  plan: "Plan: a calmer about page",
  build: "Build the saved plan: a calmer about page",
} as const;
const SEQ_SAVED_PLAN_GOAL = "Propose a calmer about page as one card";
const SEQ_SAVED_BUILD_GOAL = "Build the calmer about page the saved plan agreed";
export const SEQ_SAVED_CARD_TITLE = "A calmer about page";
export const SEQ_SAVED_CHOICE = SAVE_AND_DEFER;
export const SEQ_SAVED_CARD_BODY =
  '<p>The about page keeps one paragraph and the version line, and the credits list goes.</p><ul><li>One paragraph says what the app is.</li><li>The credits list moves to the project page.</li></ul><fieldset><legend>Where does the version line sit?</legend><label><input type="radio" name="version_line" value="top">At the top</label><label><input type="radio" name="version_line" value="bottom" data-inf-recommended>At the bottom</label><label><input type="radio" name="version_line" value="other" data-inf-write-in>Something else</label></fieldset>';
export const SEQ_SAVED_SPEC =
  "Agreed spec: the about page keeps one paragraph and the version line, and drops the credits list.";

/**
 * The ideation plan line of a sequences document, as the Firstmate relays a
 * step's line (one line, no bullet; `SEQ_IMPLEMENT_LINE`).
 */
function planLineOf(document: string): string | undefined {
  return document
    .match(/^- (plan: a read-only step\.[\s\S]*?)\n(?=- |#)/m)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
}
/** A step's line under a section of a sequences document, as the Firstmate relays it. */
function stepLineOf(document: string, section: string, step: string): string | undefined {
  const at = document.indexOf(`\n## ${section} `);
  if (at === -1) return undefined;
  return document
    .slice(at)
    .split("\n- ")
    .find((line) => line.startsWith(`${step}: `))
    ?.split("\n#")[0]
    ?.replace(/\s+/g, " ")
    .trim();
}
/** The seeded plan line, which says what an ask for a prototype is. */
export const SEQ_PLAN_LINE = planLineOf(SEQUENCES_SEED) ?? "the seed has no plan line";
/**
 * An ask for a prototype (FI3-872): the plan line it was served sends it to
 * one read-only plan step whose card is a playable preview; Approve and
 * build closes that answer, and the Firstmate starts a builder grounded on it.
 */
export const SEQ_PROTOTYPE_ASK = "prototype a tilted glass dial I can try";
export const SEQ_PROTOTYPE = {
  plan: "Plan: a tilted glass dial",
  build: "Build: a tilted glass dial",
} as const;
export const SEQ_PROTOTYPE_PLAN_GOAL = "Show a tilted glass dial as a playable preview on one card";
export const SEQ_PROTOTYPE_BUILD_GOAL = "Build the tilted glass dial the captain approved";
export const SEQ_PROTOTYPE_CARD_TITLE = "A tilted glass dial to try";
export const SEQ_PROTOTYPE_CHOICE = APPROVE_AND_BUILD;
export const SEQ_PROTOTYPE_CARD_BODY =
  "<p>A glass dial tilted 16 degrees; drag the tilt to try another angle.</p>" +
  '<label>Tilt in degrees <input id="tilt" type="range" min="0" max="90" value="16"></label>' +
  '<output id="reading">16°</output>' +
  "<script>const tilt = document.getElementById('tilt'); tilt.oninput = () => { document.getElementById('reading').textContent = tilt.value + '°'; inf.stage('look', { tiltDeg: Number(tilt.value) }); }; tilt.oninput();</script>";
export const SEQ_PROTOTYPE_SPEC =
  "Agreed spec: a glass dial tilted 16 degrees by default, adjustable from 0 to 90 degrees.";

/**
 * A check a build waits on (FI3-422): the Firstmate starts the build, runs a
 * read-only check of it as an internal step, and links the check as blocking
 * the build, so the build cannot merge while the check is live. The check
 * reports a pass, and the Firstmate closes it as answered into the build.
 */
export const SEQ_CHECKED_ASK =
  "add the battery meter, and run the live cases on it before it merges";
export const SEQ_CHECKED = {
  build: "Build: the battery meter",
  check: "Check: the battery meter live cases",
} as const;
const SEQ_CHECKED_BUILD_GOAL = "Add a battery meter to the status bar";
const SEQ_CHECK_GOAL = "Run the ten live cases against the battery meter build";
export const SEQ_CHECKS_PASSED = "checks: pass - all ten live cases pass on the battery meter.";

type SeqAsk = {
  ask: string;
  /** The ask's parent; a one-step ask has none. */
  parent?: string;
  /**
   * The step that runs now. The mock Firstmate declares every step it adds
   * as internal_step, as the instructions say, except one the captain asked
   * to see (`captainAsked`) - its judgment, scripted here.
   */
  now: {
    title: string;
    goal: string;
    constraints?: ScriptedArgs<"spawn_crewmate">["constraints"];
    captainAsked?: boolean;
  };
  later?: { title: string; goal: string; constraints?: ScriptedArgs<"create_task">["constraints"] };
};

const SEQ_ASKS: SeqAsk[] = [
  // A clear, small ask: one step, so no parent.
  {
    ask: SEQ_SMALL_ASK,
    now: { title: SEQ_SMALL.implement, goal: `${SEQ_SMALL_GOAL}.` },
  },
  {
    ask: SEQ_FEATURE_ASK,
    parent: SEQ_FEATURE.parent,
    now: {
      title: SEQ_FEATURE.plan,
      goal: `${SEQ_PLAN_GOAL}, and wait for my choice.`,
      constraints: [{ kind: "read-only" }],
    },
    later: {
      title: SEQ_FEATURE.implement,
      goal: `${SEQ_IMPLEMENT_GOAL}.`,
      constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
    },
  },
  {
    ask: SEQ_BUG_YES_ASK,
    parent: SEQ_BUG_YES.parent,
    now: {
      title: SEQ_BUG_YES.reproduce,
      goal: `Reproduce the meter reset ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
    },
    later: { title: SEQ_BUG_YES.fix, goal: `Fix the meter reset ${SEQ_FIX_GOAL}.` },
  },
  {
    ask: SEQ_BUG_SHOWN_ASK,
    parent: SEQ_BUG_SHOWN.parent,
    now: {
      title: SEQ_BUG_SHOWN.reproduce,
      goal: `Reproduce the clock drift ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
      // The captain asked to see this step's own result: not an internal step.
      captainAsked: true,
    },
    later: { title: SEQ_BUG_SHOWN.fix, goal: `Fix the clock drift ${SEQ_FIX_GOAL}.` },
  },
  {
    ask: SEQ_BUG_NO_ASK,
    parent: SEQ_BUG_NO.parent,
    now: {
      title: SEQ_BUG_NO.reproduce,
      goal: `Reproduce the dock flicker ${SEQ_REPRODUCE_GOAL} yes or reproduced: no.`,
    },
    later: { title: SEQ_BUG_NO.fix, goal: `Fix the dock flicker ${SEQ_FIX_GOAL}.` },
  },
];

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
function servedInstructions(body: string): string {
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

/**
 * FI3-250's hermetic replay, not a claim that a live model obeys: the
 * captain's words (`DEPENDENCY_WAIT_PROMPT`, then the key of the work to
 * wait on) have the Firstmate start a crewmate and link that work as its
 * blocker; the crewmate reports the wait. The work it waits on carries
 * `DEPENDENCY_WAIT_MARKER` in its title, so the host's steer when that work
 * closes names it, and the resumed crewmate reports what the steer said.
 */
export const DEPENDENCY_WAIT_PROMPT = "exercise a dependency wait";
export const DEPENDENCY_WAIT_MARKER = "shared fixture fix";
export const DEPENDENCY_WAIT_TITLE = "Ship the gauge";

function dependencyWaitMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (firstmate) {
    if (!user.includes("[user]") || !user.includes(DEPENDENCY_WAIT_PROMPT)) return undefined;
    const owner = user.split(DEPENDENCY_WAIT_PROMPT)[1]?.match(/[A-Z0-9]+-\d+/)?.[0] ?? "missing";
    if (results.length === 0)
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: DEPENDENCY_WAIT_TITLE,
              goal: `Ship the gauge once ${owner} lands.`,
              user_words: `${DEPENDENCY_WAIT_PROMPT} on ${owner}`,
              shape: { rigor_ask: "quick" },
            },
          },
        ],
      };
    const spawned = results[0]?.match(/on task ([\w-]+)/)?.[1] ?? "missing";
    if (results.length === 1)
      return {
        calls: [{ name: "link_tasks", args: { from: owner, to: spawned, type: "blocks" } }],
      };
    return { text: "Started it behind the fixture fix." };
  }
  if (user.includes(DEPENDENCY_WAIT_MARKER)) {
    return results.length
      ? { text: "Reported." }
      : {
          calls: [
            {
              name: "report",
              args: { text: `Resumed after the wait ended: ${user.trim().split("\n").at(-1)}` },
            },
          ],
        };
  }
  if (!user.includes(DEPENDENCY_WAIT_PROMPT)) return undefined;
  return results.length
    ? { text: "Reported." }
    : {
        calls: [{ name: "report", args: { text: "Waiting for the fixture fix to merge first." } }],
      };
}

/** A completion card whose checks change on GitHub after it went up. */
export const STALE_CHECKS_MARKER = "exercise stale check strip";
export const STALE_CHECKS_CARD = "The stale strip change is ready";

function staleChecksMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes(STALE_CHECKS_MARKER)) return undefined;
  const taskId =
    indexTaskId(body, `meterlab ${STALE_CHECKS_MARKER}`) ??
    findCrewTaskId(body, STALE_CHECKS_MARKER) ??
    "missing";
  if (firstmate) {
    if (user.includes(SPAWN_PROMPT_MARKER))
      return results.length
        ? { text: "Opened." }
        : {
            calls: [
              {
                name: "spawn_crewmate",
                args: {
                  title: `meterlab ${STALE_CHECKS_MARKER}`,
                  goal: "Ship a change whose checks later fail",
                  user_words: STALE_CHECKS_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "standard",
                    skipped_plan_because: "Bounded check-refresh fixture",
                  },
                },
              },
            ],
          };
    if (user.includes(`${STALE_CHECKS_MARKER} read`))
      return results.length
        ? { text: "Read the checks." }
        : { calls: [{ name: "crew_status", args: { task_id: taskId } }] };
    return { text: "Noted." };
  }
  if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
  if (results.length === 1)
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: STALE_CHECKS_CARD,
            body: completionCardBody(
              "<p>The captain asked for this change.</p>",
              "<p>Changed the meter.</p>",
              "<p>The meter was wrong.</p>",
              '<p>The meter is right now.</p><figure aria-label="Checks pass"><svg viewBox="0 0 510 50" width="100%"><rect x="5" y="5" width="500" height="40" rx="8" fill="var(--ok-dim)"/><text x="20" y="30" fill="var(--fg-1)">Every current check passed</text></svg></figure>',
            ),
            actions: [
              {
                id: "merge-it",
                label: "Merge it",
                default: true,
                effect: { kind: "settle", mode: "merge" },
              },
            ],
          },
        },
      ],
    };
  if (results.length === 2)
    return {
      calls: [
        {
          name: "report",
          args: {
            text: "The change passed its checks; the completion decision is up.",
            waiting_on_captain: { reason: "the completion decision is up" },
          },
        },
      ],
    };
  return { text: "Waiting on the captain." };
}

/** Hermetic instruction/host replay for FI3-237, not a claim that a live model obeys. */
export const CI_REPAIR_MARKER = "exercise diagnosed check failures";
export const CI_REPAIR_OWNER = "ci-baseline-owner";
export const CI_REPAIR_CARD = "The diagnosed change is ready";
export const CI_REPAIR_HEADS = ["baseline-one", "baseline-two", "flake-head"] as const;

function checkRepairMove(
  body: string,
  firstmate: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes(CI_REPAIR_MARKER)) return undefined;
  const taskId =
    indexTaskId(body, `meterlab ${CI_REPAIR_MARKER}`) ??
    findCrewTaskId(body, CI_REPAIR_MARKER) ??
    "missing";
  if (firstmate) {
    if (user.includes(SPAWN_PROMPT_MARKER))
      return results.length
        ? { text: "Opened." }
        : {
            calls: [
              {
                name: "spawn_crewmate",
                args: {
                  title: `meterlab ${CI_REPAIR_MARKER}`,
                  goal: "Exercise diagnosed failures",
                  user_words: CI_REPAIR_MARKER,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  shape: {
                    rigor_ask: "standard",
                    skipped_plan_because:
                      "Existing check-repair reproduction; implementation fixture",
                  },
                },
              },
            ],
          };
    if (user.includes("needs diagnosis")) {
      if (results.length === 0)
        return { calls: [{ name: "crew_status", args: { task_id: taskId } }] };
      if (results.length === 1)
        return {
          calls: [
            {
              name: "steer_crewmate",
              args: { task_id: taskId, message: `${CI_REPAIR_MARKER} diagnose ${results[0]}` },
            },
          ],
        };
      return { text: "Diagnosis requested without a captain card." };
    }
    if (
      user.includes("[user]") &&
      (user.includes(`${CI_REPAIR_MARKER} read`) || user.includes(`${CI_REPAIR_MARKER} finish`))
    ) {
      return results.length
        ? { text: "Continued." }
        : {
            calls: [
              {
                name: "steer_crewmate",
                args: {
                  task_id: taskId,
                  message: `${CI_REPAIR_MARKER} ${user.includes(`${CI_REPAIR_MARKER} finish`) ? "finish" : "read"}`,
                },
              },
            ],
          };
    }
    if (user.includes("reported on task")) {
      // FI3-671: a wait on work nobody has started is started that turn.
      const unstarted = user.match(/It waits on ([\w-]+) "[^"]*" \(not started\)/)?.[1];
      if (unstarted && results.length === 0)
        return { calls: [{ name: "update_task", args: { task: unstarted, start_now: true } }] };
      // Routine waits are not decisions.
      return { text: "The separate owner and wait remain recorded; no captain decision needed." };
    }
    return undefined;
  }
  const card: ScriptedCall = {
    name: "emit_card",
    args: {
      title: CI_REPAIR_CARD,
      body: completionCardBody(
        "<p>A failed check needs a diagnosis before another repair.</p>",
        "<p>Repaired the diagnosed regression.</p>",
        "<p>The checks failed on the previous version.</p>",
        '<p>The diagnosed change is ready without an extra failure decision.</p><figure aria-label="Checks pass"><svg viewBox="0 0 510 50" width="100%"><rect x="5" y="5" width="500" height="40" rx="8" fill="var(--ok-dim)"/><text x="20" y="30" fill="var(--fg-1)">Every current check passed</text></svg></figure>',
      ),
      // The merge alone, unlabeled, as the crewmate is told: the host
      // attaches the completion buttons and their words (FI3-249).
      actions: [{ id: "put-in", default: true, effect: { kind: "settle", mode: "merge" } }],
    },
  };
  if (user.includes(`${CI_REPAIR_MARKER} finish`)) {
    if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
    if (results.length === 1) return { calls: [card] };
    return results.length === 2
      ? {
          calls: [
            {
              name: "report",
              args: {
                text: "The diagnosed change passed every current check and its completion decision is ready.",
              },
            },
          ],
        }
      : { text: "Completion recorded." };
  }
  if (user.includes(`${CI_REPAIR_MARKER} diagnose`)) {
    const headSha = CI_REPAIR_HEADS.find((head) => user.includes(head)) ?? "missing";
    const flake = headSha === CI_REPAIR_HEADS[2];
    if (!results.length)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              diagnosis: {
                headSha,
                check: "linux-checks",
                classification: flake ? "suspected-flake" : "baseline-blocked",
                evidence: flake
                  ? "Failed standalone timeout log differs from the same-head successful verification"
                  : "Separate owner reproduced the same failed assertion on untouched main, with log evidence",
                ...(flake ? {} : { dependencyTask: CI_REPAIR_OWNER }),
              },
            },
          },
        ],
      };
    if (flake && results.length === 1)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              rerun: {
                headSha,
                check: "linux-checks",
                evidence: "Successful same-head verification and failed-job timeout log",
              },
            },
          },
        ],
      };
    // Try premature completion to exercise the actual card gate on failed checks.
    if (flake && results.length === 2) return { calls: [card] };
    if (results.length === (flake ? 3 : 1))
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `${CI_REPAIR_MARKER} ${flake ? "rerun reserved; completion correctly refused until all checks pass" : "waiting for the evidenced separate baseline owner"}`,
            },
          },
        ],
      };
    return { text: "Waiting." };
  }
  if (!results.length) return { calls: [{ name: "check_change", args: {} }] };
  if (results.length === 1) {
    // It names the version it read, as a crewmate does: two failures at
    // two versions are two reports, never one repeated wake.
    const head = CI_REPAIR_HEADS.find((h) => results[0]?.includes(h)) ?? "the current version";
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `${CI_REPAIR_MARKER} needs diagnosis at ${head}; failed step and logs recorded for the next move`,
          },
        },
      ],
    };
  }
  return { text: "Reported." };
}

/**
 * A task filed earlier starts on the model the captain names (FI3-436): the
 * file ask records a parent and its on-request child with create_task; the
 * start ask names the model on that same row with update_task
 * override_model_id and starts it in the same call - never a replacement.
 */
export const FILED_MODEL_FILE_ASK = "file the gauge calibration for later";
export const FILED_MODEL_START_ASK = "start the gauge calibration on the mock model";
export const FILED_MODEL_PARENT = "Gauge work";
export const FILED_MODEL_TITLE = "Calibrate the gauge";

function filedModelFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes("[user]")) return undefined;
  const ask = user.slice(user.lastIndexOf("[user]"));
  if (ask.includes(FILED_MODEL_FILE_ASK)) {
    const parentKey = results[0]?.match(/Planned ([A-Z0-9]+-\d+)/)?.[1];
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: FILED_MODEL_PARENT,
              goal: `${FILED_MODEL_PARENT}.`,
              user_words: FILED_MODEL_FILE_ASK,
            },
          },
        ],
      };
    }
    if (results.length === 1 && parentKey) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: FILED_MODEL_TITLE,
              goal: "The gauge reads true.",
              user_words: FILED_MODEL_FILE_ASK,
              parent: parentKey,
            },
          },
        ],
      };
    }
    return { text: "Filed." };
  }
  if (ask.includes(FILED_MODEL_START_ASK)) {
    if (results.length > 0) return { text: "Started it on the model you named." };
    const task = indexTaskId(body, FILED_MODEL_TITLE) ?? "missing";
    return {
      calls: [
        {
          name: "update_task",
          args: {
            task,
            override_model_id: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
            start_now: true,
          },
        },
      ],
    };
  }
  return undefined;
}

/**
 * New work on a model the captain names (FI3-444): each ask is one
 * spawn_crewmate carrying override_model_id - one the app serves, and one it
 * does not - and the answer it reads back says which model took the task.
 */
export const NAMED_SPAWN_ASK = "spawn the dial repair on the mock model";
export const NAMED_SPAWN_TITLE = "Repair the dial";
export const NAMED_SPAWN_MISSING_ASK = "spawn the needle repair on a model that is not here";
export const NAMED_SPAWN_MISSING_TITLE = "Repair the needle";
/** A model id the hermetic app's models.json does not define. */
export const NAMED_SPAWN_MISSING_MODEL_ID = "mock-9";

function namedSpawnFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  if (!user.includes("[user]")) return undefined;
  const ask = user.slice(user.lastIndexOf("[user]"));
  const spawn = (
    title: string,
    words: string,
    model: string,
  ): { calls: ScriptedCall[] } | { text: string } =>
    results.length > 0
      ? { text: "Started it." }
      : {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title,
                goal: `${title}.`,
                user_words: words,
                shape: { override_model_id: model, rigor_ask: "quick" },
              },
            },
          ],
        };
  if (ask.includes(NAMED_SPAWN_ASK)) {
    return spawn(NAMED_SPAWN_TITLE, NAMED_SPAWN_ASK, `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`);
  }
  if (ask.includes(NAMED_SPAWN_MISSING_ASK)) {
    return spawn(
      NAMED_SPAWN_MISSING_TITLE,
      NAMED_SPAWN_MISSING_ASK,
      `${MOCK_PROVIDER_ID}/${NAMED_SPAWN_MISSING_MODEL_ID}`,
    );
  }
  return undefined;
}

/**
 * The mock Firstmate's moves for the sequences asks: the legs of opening an
 * ask, the plan's hand-off on the captain's choice, and the bug hand-offs on
 * the reproduce step's report. Undefined when the request is none of them.
 */
function sequencesFirstmateMove(
  body: string,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  const { user, results } = sinceLastUser(body);
  const onClaude = body.includes(SEQ_CLAUDE_STEP_MARKER);
  const userSegment = user.slice(user.lastIndexOf("[user]"));
  const script = user.includes("[user]")
    ? SEQ_ASKS.find((entry) => userSegment.includes(entry.ask))
    : undefined;
  // A plan asked for on its own: one read-only step, no parent.
  if (user.includes("[user]") && userSegment.includes(SEQ_SAVED_ASK)) {
    if (results.length > 0) return { text: "Opened." };
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_SAVED.plan,
            goal: `${SEQ_SAVED_PLAN_GOAL}, and wait for my choice.`,
            user_words: SEQ_SAVED_ASK,
            constraints: [{ kind: "read-only" }],
          },
        },
      ],
    };
  }
  // An ask for a prototype: the plan line the Firstmate was served says it
  // is that plan, so it relays the line beside the read-only constraint.
  if (user.includes("[user]") && userSegment.includes(SEQ_PROTOTYPE_ASK)) {
    if (results.length > 0) return { text: "Opened." };
    const line = planLineOf(servedInstructions(body));
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_PROTOTYPE.plan,
            goal: `${SEQ_PROTOTYPE_PLAN_GOAL}, and wait for my choice.`,
            user_words: SEQ_PROTOTYPE_ASK,
            constraints: [
              { kind: "read-only" },
              ...(line ? [{ kind: "free" as const, text: line }] : []),
            ],
          },
        },
      ],
    };
  }
  // Approve and build on it: no successor exists, so the builder is spawned
  // grounded on the plan (HANDOFF).
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_PROTOTYPE.plan}"`) &&
    user.includes(`"label":"${SEQ_PROTOTYPE_CHOICE}"`)
  ) {
    if (results.length > 0) return { text: "Started the build." };
    const plan = user.match(/"event":"answer_task_closed","task":\{"id":"([\w-]+)"/)?.[1];
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: SEQ_PROTOTYPE.build,
            goal: `${SEQ_PROTOTYPE_BUILD_GOAL}.`,
            user_words: SEQ_PROTOTYPE_ASK,
            constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
            shape: { basis: plan ?? "missing" },
          },
        },
      ],
    };
  }
  // Save and defer on that plan: no successor exists, so the build is filed
  // on request, grounded on the plan, and nothing starts.
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_SAVED.plan}"`) &&
    user.includes(`"label":"${SEQ_SAVED_CHOICE}"`)
  ) {
    if (results.length > 0) return { text: "Saved for later." };
    const plan = user.match(/"event":"answer_task_closed","task":\{"id":"([\w-]+)"/)?.[1];
    return {
      calls: [
        {
          name: "create_task",
          args: {
            title: SEQ_SAVED.build,
            goal: `${SEQ_SAVED_BUILD_GOAL}.`,
            user_words: SEQ_SAVED_ASK,
            basis: plan ?? "missing",
            start_policy: "on-request",
            constraints: [{ kind: "free", text: SEQ_IMPLEMENT_LINE }],
          },
        },
      ],
    };
  }
  // A build and a check it waits on: the build starts, the check runs as an
  // internal step, and a blocks link holds the build's merge on the check.
  if (user.includes("[user]") && userSegment.includes(SEQ_CHECKED_ASK)) {
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: SEQ_CHECKED.build,
              goal: `${SEQ_CHECKED_BUILD_GOAL}.`,
              user_words: SEQ_CHECKED_ASK,
            },
          },
        ],
      };
    }
    if (results.length === 1) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: SEQ_CHECKED.check,
              goal: `${SEQ_CHECK_GOAL}; open your report with checks: pass or checks: fail.`,
              user_words: SEQ_CHECKED_ASK,
              constraints: [{ kind: "read-only" }],
              shape: { internal_step: true },
            },
          },
        ],
      };
    }
    const build = results[0]?.match(/on task ([\w-]+)/)?.[1];
    const check = results[1]?.match(/on task ([\w-]+)/)?.[1];
    if (results.length === 2 && build && check) {
      return { calls: [{ name: "link_tasks", args: { from: check, to: build, type: "blocks" } }] };
    }
    return { text: "Started the build and its live check." };
  }
  if (script && !script.parent) {
    // One step: the implement step is the whole ask, spawned on its own.
    if (results.length > 0) return { text: "Opened." };
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: script.now.title,
            goal: script.now.goal,
            user_words: script.ask,
            ...(script.now.constraints ? { constraints: script.now.constraints } : {}),
            shape: { skipped_plan_because: SEQ_SMALL_PLAN_SKIP },
          },
        },
      ],
    };
  }
  if (script?.parent) {
    const parentKey = results[0]?.match(/Planned ([A-Z0-9]+-\d+)/)?.[1];
    if (results.length === 0) {
      return {
        calls: [
          {
            name: "create_task",
            args: { title: script.parent, goal: `${script.parent}.`, user_words: script.ask },
          },
        ],
      };
    }
    if (results.length === 1 && parentKey) {
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: script.now.title,
              goal: script.now.goal,
              // A pinned model skips the classifier. Keep this reproduction
              // an answer with its real read-only constraint (FI3-793).
              ...(onClaude
                ? {
                    override_model_id: CLAUDE_CREW_MODEL,
                    constraints: [{ kind: "read-only" }],
                  }
                : {}),
              user_words: script.ask,
              parent: parentKey,
              ...(script.now.constraints ? { constraints: script.now.constraints } : {}),
              ...(script.now.captainAsked ? {} : { shape: { internal_step: true } }),
            },
          },
        ],
      };
    }
    const nowId = results[1]?.match(/on task ([\w-]+)/)?.[1];
    if (results.length === 2 && parentKey && nowId && script.later) {
      return {
        calls: [
          {
            name: "create_task",
            args: {
              title: script.later.title,
              goal: script.later.goal,
              user_words: script.ask,
              parent: parentKey,
              basis: nowId,
              start_policy: "on-request",
              internal_step: true,
              ...(script.later.constraints ? { constraints: script.later.constraints } : {}),
            },
          },
        ],
      };
    }
    return { text: "Opened." };
  }
  // The captain says to start the clock fix while the repro he asked to see
  // is still up: the Firstmate starts it and leaves the repro alone - it
  // never declared it a step of its own, so it is his to close.
  if (
    user.includes("[user]") &&
    user.slice(user.lastIndexOf("[user]")).includes(SEQ_START_SHOWN_FIX)
  ) {
    if (results.length === 0) {
      const fix = indexTaskId(body, SEQ_BUG_SHOWN.fix) ?? "missing";
      return { calls: [{ name: "update_task", args: { task: fix, start_now: true } }] };
    }
    return { text: "Started the fix; the repro is yours to close." };
  }
  // The captain chose on the plan's card: the plan step closed answered, and
  // its choice says the implement step's turn has come.
  if (
    user.includes('"event":"answer_task_closed"') &&
    user.includes(`"title":"${SEQ_FEATURE.plan}"`)
  ) {
    if (results.length > 0) return { text: "Started." };
    const implement = indexTaskId(body, SEQ_FEATURE.implement) ?? "missing";
    return {
      calls: [
        {
          name: "update_task",
          args: {
            task: implement,
            start_policy: "when-ready",
            blocked_by: [],
            goal: SEQ_IMPLEMENT_AMENDED_GOAL,
          },
        },
      ],
    };
  }
  // The reproduce step's report: yes starts the fix and closes the step it
  // builds on as answered; no is one decision card with the ways out.
  const reproduced = (title: string, verdict: "yes" | "no") =>
    user.match(new RegExp(`reported on task ([\\w-]+) "${title}": reproduced: ${verdict}`))?.[1];
  const yes = reproduced(SEQ_BUG_YES.reproduce, "yes");
  if (yes) {
    if (results.length === 0) {
      const fix = indexTaskId(body, SEQ_BUG_YES.fix) ?? "missing";
      return {
        calls: [
          {
            name: "update_task",
            args: {
              task: fix,
              start_now: true,
              ...(onClaude ? { override_model_id: CLAUDE_CREW_MODEL } : {}),
            },
          },
        ],
      };
    }
    if (results.length === 1) {
      return {
        calls: [{ name: "settle_task", args: { task_id: yes, mode: "answered" } }],
      };
    }
    return { text: "Fix under way." };
  }
  // The check's pass: the build it held carries on, so the check closes as
  // answered into it.
  const passed = user.match(
    new RegExp(`reported on task ([\\w-]+) "${SEQ_CHECKED.check}": checks: pass`),
  )?.[1];
  if (passed) {
    if (results.length > 0) return { text: "The checks passed; the build carries on." };
    return { calls: [{ name: "settle_task", args: { task_id: passed, mode: "answered" } }] };
  }
  return undefined;
}

/** The sequences crewmates, keyed by their step's goal. */
function sequencesCrewmateMove(
  body: string,
  hasToolResults: boolean,
): { calls: ScriptedCall[] } | { text: string } | undefined {
  // Most specific first: a builder's brief quotes its basis, never its goal.
  if (body.includes(SEQ_SAVED_BUILD_GOAL)) return { text: "Building the saved plan." };
  if (body.includes(SEQ_PROTOTYPE_BUILD_GOAL)) return { text: "Building the approved dial." };
  if (body.includes(SEQ_PROTOTYPE_PLAN_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_PROTOTYPE_CARD_TITLE,
            body: SEQ_PROTOTYPE_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: "Save and defer" },
              { id: "approve", label: SEQ_PROTOTYPE_CHOICE, default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_PROTOTYPE_SPEC } },
      ],
    };
  }
  if (body.includes(SEQ_SAVED_PLAN_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_SAVED_CARD_TITLE,
            body: SEQ_SAVED_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: SEQ_SAVED_CHOICE },
              { id: "approve", label: "Approve and build", default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_SAVED_SPEC } },
      ],
    };
  }
  if (body.includes(SEQ_IMPLEMENT_GOAL)) {
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_IMPLEMENT_CARD_TITLE,
            body: completionCardBody(
              "<p>The settings rows need clear groups.</p>",
              "<p>Grouped the rows into three labelled sections.</p>",
              "<p>The rows were one undivided list.</p>",
              "<p>The sections now separate the rows.</p><ul><li>The gear icon stays where it was.</li></ul>",
            ),
            actions: [
              {
                id: "put-in",
                label: "Put it in",
                default: true,
                effect: { kind: "settle", mode: "merge" },
              },
            ],
          },
        },
        { name: "report", args: { text: "Grouped the settings rows into three sections." } },
      ],
    };
  }
  if (body.includes(SEQ_CHECK_GOAL)) {
    if (hasToolResults) return { text: "done" };
    return { calls: [{ name: "report", args: { text: SEQ_CHECKS_PASSED } }] };
  }
  if (body.includes(SEQ_CHECKED_BUILD_GOAL)) return { text: "Adding the battery meter now." };
  if (body.includes(SEQ_SMALL_GOAL)) return { text: "Fixing the title spelling now." };
  if (body.includes(SEQ_FIX_GOAL)) return { text: "The fix is under way." };
  if (body.includes(SEQ_REPRODUCE_GOAL)) {
    if (hasToolResults) return { text: "done" };
    const verdict = body.includes("the dock flicker") ? SEQ_REPRODUCED_NO : SEQ_REPRODUCED_YES;
    if (verdict === SEQ_REPRODUCED_NO) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: SEQ_NOT_REPRODUCED_TITLE,
              body: "<p>The dock flicker did not show on a clean setup.</p><ul><li>Forty resizes, no flicker.</li><li>The fix waits on your word.</li></ul>",
              actions: [
                { id: "fix-anyway", label: SEQ_NOT_REPRODUCED_WAYS[0], default: true },
                { id: "stop", label: SEQ_NOT_REPRODUCED_WAYS[1] },
              ],
            },
          },
          { name: "report", args: { text: verdict } },
        ],
      };
    }
    // The brief says which answer shape it has: the captain's own ask lands
    // as a card; a step the Firstmate runs hands its report on.
    if (body.includes("it lands as one card")) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: SEQ_SHOWN_REPRO_TITLE,
              body: "<p>The clock loses a minute over a sleep.</p><ul><li>Seen on three sleeps.</li></ul>",
              actions: [
                { id: "leave", label: "Leave it" },
                { id: "fix", label: "Fix it", default: true },
              ],
            },
          },
          { name: "report", args: { text: verdict } },
        ],
      };
    }
    return { calls: [{ name: "report", args: { text: verdict } }] };
  }
  if (body.includes(SEQ_PLAN_GOAL)) {
    const { user, tail } = sinceLastUser(body);
    // A native steer can precede the original card's tool receipt. Only
    // this amendment's reply call means it was acknowledged; any old tool
    // result is not proof that the new instruction was handled.
    if (user.includes(SEQ_THREAD_REPLY) && !calledTool(tail, "reply")) {
      const shown = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
      return {
        calls: [
          {
            name: "reply",
            args: { card_id: shown, text: SEQ_THREAD_ANSWER },
          },
          // The plan changed: the task records the final agreed spec.
          { name: "report", args: { text: SEQ_PLAN_FINAL_SPEC } },
        ],
      };
    }
    if (hasToolResults || calledTool(body, "emit_card")) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SEQ_PLAN_CARD_TITLE,
            body: SEQ_PLAN_CARD_BODY,
            actions: [
              { id: "abandon", label: "Abandon" },
              { id: "save-and-defer", label: "Save and defer" },
              { id: "group", label: SEQ_PLAN_CHOICE, default: true },
            ],
          },
        },
        { name: "report", args: { text: SEQ_PLAN_REPORT } },
      ],
    };
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
};
/** A scenario's answer: tool calls, text, or a refusal the way the service sends one. */
export type ScenarioAnswer =
  | { calls: ScriptedCall[] }
  | { text: string }
  | { refusal: { status: number; error: { type: string; message: string } } };
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

function settleNeedle(haystack: string, marker: string): string {
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
        const scenarioRequest = { body, isFirstmate, wantsStream, latestUserTail, hasToolResults };
        for (const scenario of scenarios) {
          const answer = scenario(scenarioRequest);
          if (!answer) continue;
          if ("calls" in answer) streamToolCalls(answer.calls);
          else if ("text" in answer) streamText(answer.text);
          else writeAnthropicError(res, answer.refusal.status, answer.refusal.error);
          return;
        }
        if (isFirstmate && wantsStream) {
          const checkMove =
            staleChecksMove(body, true) ??
            checkRepairMove(body, true) ??
            dependencyWaitMove(body, true);
          if (checkMove) {
            if ("calls" in checkMove) streamToolCalls(checkMove.calls);
            else streamText(checkMove.text);
            return;
          }
          const sequencesMove = sequencesFirstmateMove(body);
          if (sequencesMove) {
            if ("calls" in sequencesMove) streamToolCalls(sequencesMove.calls);
            else streamText(sequencesMove.text);
            return;
          }
          const filedModelMove = filedModelFirstmateMove(body);
          if (filedModelMove) {
            if ("calls" in filedModelMove) streamToolCalls(filedModelMove.calls);
            else streamText(filedModelMove.text);
            return;
          }
          const namedSpawnMove = namedSpawnFirstmateMove(body);
          if (namedSpawnMove) {
            if ("calls" in namedSpawnMove) streamToolCalls(namedSpawnMove.calls);
            else streamText(namedSpawnMove.text);
            return;
          }
          const settleCall = (
            marker: string,
            mode: "land" | "discard",
          ): ScriptedCall | undefined => {
            if (hasToolResults || !latestUserTail.includes(marker)) return undefined;
            const needle = settleNeedle(latestUserTail, marker);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            return { name: "settle_task", args: { task_id: taskId, mode } };
          };
          // Cards as threads, phase 1: the crewmate closed its card and
          // handed the captain's words up. The Firstmate runs the settle it
          // would have run had he typed them in the main input.
          if (!hasToolResults && latestUserTail.includes(THREAD_HANDOFF_PHRASE)) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            streamToolCalls([{ name: "settle_task", args: { task_id: taskId, mode: "land" } }]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(RELEASE_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, RELEASE_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "settle_task",
                args: {
                  task_id: taskId,
                  mode: "released",
                  release_evidence:
                    "Release v1.2.3 verified in the release manifest and published artifact",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(MERGE_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, MERGE_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([{ name: "settle_task", args: { task_id: taskId, mode: "merge-pr" } }]);
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
              { name: "interrupt_crewmate", args: { task_id: taskId, mode: "cancel" } },
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
          if (!hasToolResults && latestUserTail.includes(PERSONAL_CHANGE_PROMPT_MARKER)) {
            const match = latestUserTail.match(/change my panel ([a-z0-9-]+): ([^"\\]+)/);
            const surface = match?.[1] ?? "unknown";
            const ask = match?.[2]?.trim() ?? "change it";
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title: `Change the ${surface} panel`,
                  goal: `Change the ${surface} panel: ${ask}`,
                  user_words: `change my panel ${surface}: ${ask}`,
                  personal_ui: true,
                },
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
          if (!hasToolResults && latestUserTail.includes(ESCALATE_PROMPT_MARKER)) {
            // The captain rejected a result in words: a regular spawn with
            // escalate_from, never a new tool (the captain's second-pass call).
            const needle = settleNeedle(latestUserTail, ESCALATE_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title: needle,
                  goal: `Complete the task "${needle}" properly this time.`,
                  user_words: `${ESCALATE_PROMPT_MARKER}${needle}`,
                  shape: { escalate_from: taskId },
                },
              },
            ]);
            return;
          }
          // FI3-1581: woken by a finished report, Firstmate puts the answer on
          // a card of its own and, in the same turn, closes the task answered.
          // The gap is the reproduction's: the note is on the stack before the close.
          if (
            latestUserTail.includes(FINISHED_WAKE_NEEDLE) &&
            latestUserTail.includes(OWN_RENT_TITLE)
          ) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            if (!hasToolResults) {
              streamToolCalls([
                {
                  name: "emit_card",
                  args: {
                    task_id: taskId,
                    title: OWN_RENT_CARD_TITLE,
                    body:
                      "<p>Owning Macs costs far less than renting for steady Mac CI use.</p>" +
                      "<p>Renting only wins when extra demand comes in rare bursts.</p>",
                  },
                },
              ]);
              return;
            }
            if (
              calledTool(latestUserTail, "emit_card") &&
              !calledTool(latestUserTail, "settle_task")
            ) {
              setTimeout(() => {
                streamToolCalls([
                  { name: "settle_task", args: { task_id: taskId, mode: "answered" } },
                ]);
              }, OWN_RENT_SETTLE_DELAY_MS);
              return;
            }
          }
          if (!hasToolResults && latestUserTail.includes(FINISHED_WAKE_NEEDLE)) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            streamToolCalls([{ name: "settle_task", args: { task_id: taskId, mode: "answered" } }]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(PROPOSE_PROJECT_REPORT_NEEDLE)) {
            const path = latestUserTail.match(
              new RegExp(`folder at (\\S+) ${PROPOSE_PROJECT_REPORT_NEEDLE}`),
            )?.[1] as string;
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-setup",
                  value: { kind: "adopt", path, work: MOCK_PROPOSED_WORK },
                  evidence: "the crewmate reported the runner fixes need this project",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(BLOCKED_REPORT_NEEDLE)) {
            // The wrong trigger on purpose: a crewmate's own "I am blocked",
            // reaching the Firstmate as an [fm-op] because the whose-turn
            // rule found it stopped. The tool boundary refuses it.
            const taskId =
              findCrewTaskId(body, BLOCKED_REPORT_PROMPT_MARKER) ??
              latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ??
              latestUserTail.match(/\(task ([\w-]+)\)/)?.[1] ??
              "missing";
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title: "Stronger meter attempt",
                  goal: "The meter resets.",
                  user_words: MOCK_BLOCKED_REPORT,
                  shape: { escalate_from: taskId },
                },
              },
            ]);
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
          if (!hasToolResults && latestUserTail.includes(RETRIEVAL_TASK_ASK)) {
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title: RETRIEVAL_TASK_TITLE,
                  goal: RETRIEVAL_TASK_GOAL,
                  user_words: RETRIEVAL_TASK_ASK,
                  repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                  constraints: [{ kind: "read-only" }],
                },
              },
            ]);
            return;
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
          if (!hasToolResults && latestUserTail.includes(UNREGISTER_REPO_PROMPT_MARKER)) {
            const named = latestUserTail.match(
              /unregister the repository ([\w][\w.-]*)/,
            )?.[1] as string;
            const repo = contextRepos(body).find(([name]) => name === named);
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-remove",
                  value: { repoId: repo?.[1] ?? named },
                  evidence: latestUserTail,
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
          if (latestUserTail.includes(PROJECT_LIVES_PROMPT_MARKER)) {
            if (hasToolResults) {
              streamText("done");
              return;
            }
            const lives = (latestContext(body)?.repos ?? []).map(
              (repo) => `<li>${repo.name}: ${repo.lives ?? "?"}</li>`,
            );
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_PROJECT_LIVES_CARD_TITLE,
                  body: `<p>Where each project lives.</p><ul>${lives.join("")}</ul>`,
                  standalone: true,
                },
              },
            ]);
            return;
          }
          if (latestUserTail.includes(LOCATE_PROJECTS_PROMPT_MARKER)) {
            if (!hasToolResults) {
              const name = latestUserTail
                .match(/which of my projects is ([\w.-]+)/)?.[1]
                ?.trim() as string;
              streamToolCalls([{ name: "locate_project", args: { name } }]);
              return;
            }
            if (latestUserTail.includes(MOCK_LOCATED_CARD_TITLE)) {
              streamText("done");
              return;
            }
            // Only what the tool answered: the lines naming a project there.
            const listed = [
              ...latestUserTail.matchAll(
                /- ([\w.-]+\/[\w.-]+) [^|]*\| (?:private \| )?clone origin/g,
              ),
            ].map((match) => match[1] as string);
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_LOCATED_CARD_TITLE,
                  body:
                    listed.length > 0
                      ? `<p>These are your projects where they live.</p><ul>${listed.map((name) => `<li>${name}</li>`).join("")}</ul>`
                      : "<p>No projects were listed where they live.</p>",
                  standalone: true,
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
          if (!hasToolResults && latestUserTail.includes(CONFIGURE_REPO_PROMPT_MARKER)) {
            const named = latestUserTail.match(
              /make the repository ([\w][\w.-]*) autonomous/,
            )?.[1] as string;
            const repo = contextRepos(body).find(([name]) => name === named);
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "project-settings",
                  on_words: true,
                  value: { repoId: repo?.[1] ?? named, changes: { autonomy: true } },
                  evidence: latestUserTail,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(AMBIGUOUS_PROMPT_MARKER)) {
            // The ask path: one concise decision card naming the plausible
            // repositories from the context block.
            const repoNames = contextRepos(body)
              .map(([name]) => name)
              .slice(0, 2);
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_WHICH_PROJECT_TITLE,
                  body:
                    "<p>Two repositories plausibly match this request.</p>" +
                    `<ul>${repoNames.map((name) => `<li>${name}</li>`).join("")}</ul>`,
                  actions: repoNames.map((name, index) => ({
                    id: name,
                    label: name,
                    ...(index === 0 ? { default: true } : {}),
                  })),
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
          if (!hasToolResults && latestUserTail.includes(CHANGE_MARKS_PROMPT_MARKER)) {
            const version = Number(
              latestUserTail.match(new RegExp(`${CHANGE_MARKS_PROMPT_MARKER}(\\d)`))?.[1],
            );
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "change-marks",
                  title: CHANGE_MARKS_TITLE,
                  body: CHANGE_MARKS_VERSIONS[version] ?? "<p>No such version.</p>",
                  actions: [
                    { id: "clock", label: "Mock the clock" },
                    { id: "queue", label: "Await the queue", default: true },
                  ],
                  standalone: true,
                },
              },
            ]);
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
          if (!hasToolResults && latestUserTail.includes(PERSONALIZE_HIDE_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "panel",
                  value: { surface: "now", visible: false },
                  evidence: "hide tasks",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(PERSONALIZE_SHOW_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  action: "panel",
                  value: { surface: "now", visible: true },
                  evidence: "show tasks again",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(PERSONALIZE_INSTRUCTION_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "personalize",
                args: {
                  action: "instruction",
                  text: MOCK_STANDING_INSTRUCTION,
                  evidence: "always use compact rows in my panels",
                },
              },
            ]);
            return;
          }
          if (latestUserTail.includes(KNOWLEDGE_RETIRE_PROMPT_MARKER)) {
            if (!hasToolResults) {
              const named = [...latestUserTail.matchAll(/\b([cf]-[a-z0-9]{6})@(\d+)/g)];
              streamToolCalls(
                named.map((match) => ({
                  name: "record_knowledge",
                  args: {
                    action: "retire",
                    request_id: `retire-${match[1]}`,
                    id: match[1],
                    expected_revision: Number(match[2]),
                    reason: "the captain asked to retire it",
                  },
                })),
              );
            } else {
              streamText(MOCK_FM_DONE_TEXT);
            }
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
          if (!hasToolResults && latestUserTail.includes(REMEMBER_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "publish",
                  request_id: "remember-direction",
                  id: MOCK_NOTE.id,
                  kind: "direction",
                  text: MOCK_NOTE.content,
                  reason: "captain said always squash-merge",
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(SALUTE_PROMPT_MARKER)) {
            streamToolCalls([{ name: "emote", args: { emote: "salute" } }]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FORGET_PROMPT_MARKER)) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "retire",
                  request_id: "forget-direction",
                  id: `d:${MOCK_NOTE.id}`,
                  expected_revision: 1,
                  reason: "captain said to forget it",
                },
              },
            ]);
            return;
          }
          if (hasToolResults && latestUserTail.includes(WORDLESS_CLOSE_PROMPT_MARKER)) {
            streamText("");
            return;
          }
          if (hasToolResults && latestUserTail.includes(SLOW_CLOSE_PROMPT_MARKER)) {
            setTimeout(() => streamText(MOCK_FM_DONE_TEXT), MOCK_SLOW_CLOSE_MS);
            return;
          }
          streamText(hasToolResults ? MOCK_FM_DONE_TEXT : MOCK_FM_CHAT_TEXT);
          return;
        }

        // The knowledge crewmates (knowledge.spec.ts): one saves an article
        // as a concept, cites it from a finding, and is refused a second
        // concept for the same link; a later one finds the concept through
        // its brief, follows it to the finding, reads the excerpt and
        // declares its use. Each step reads the ids the app answered with.
        if (!isFirstmate && body.includes(KNOWLEDGE_RECORD_PROMPT_MARKER) && wantsStream) {
          const concept = /Recorded concept (c-[a-z0-9]{6})/.exec(latestUserTail)?.[1];
          const article = {
            url: MOCK_KNOWLEDGE_ARTICLE.url,
            title: MOCK_KNOWLEDGE_ARTICLE.title,
            author: MOCK_KNOWLEDGE_ARTICLE.author,
            published: MOCK_KNOWLEDGE_ARTICLE.published,
            excerpt: MOCK_KNOWLEDGE_ARTICLE.excerpt,
          };
          if (!concept) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "publish",
                  request_id: "inbox-concept",
                  kind: "concept",
                  title: MOCK_KNOWLEDGE_CONCEPT.title,
                  aliases: MOCK_KNOWLEDGE_CONCEPT.aliases,
                  text: MOCK_KNOWLEDGE_CONCEPT.explanation,
                  sources: [article],
                },
              },
            ]);
          } else if (!/Recorded finding f-[a-z0-9]{6}/.test(latestUserTail)) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "publish",
                  request_id: "inbox-finding",
                  kind: "finding",
                  text: MOCK_KNOWLEDGE_FINDING.statement,
                  basis: "observation",
                  about: [concept],
                  conditions: "the saved article, as read",
                  sources: [article],
                },
              },
            ]);
          } else if (!latestUserTail.includes("already saved")) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "publish",
                  request_id: "inbox-again",
                  kind: "concept",
                  title: "Inbox delivery again",
                  text: "A second copy of the same article.",
                  sources: [article],
                },
              },
            ]);
          } else if (!calledTool(latestUserTail, "report")) {
            streamToolCalls([{ name: "report", args: { text: MOCK_KNOWLEDGE_RECORD_REPORT } }]);
          } else {
            streamText(MOCK_KNOWLEDGE_RECORD_REPORT);
          }
          return;
        }
        if (!isFirstmate && body.includes(KNOWLEDGE_REUSE_PROMPT_MARKER) && wantsStream) {
          const concept = /(c-[a-z0-9]{6}) concept \\?"Inbox delivery/.exec(body)?.[1];
          const finding = /finding about this: (f-[a-z0-9]{6})/.exec(latestUserTail)?.[1];
          if (concept && !calledTool(latestUserTail, "knowledge")) {
            streamToolCalls([{ name: "knowledge", args: { action: "neighbors", id: concept } }]);
          } else if (finding && !latestUserTail.includes("statement:")) {
            streamToolCalls([{ name: "knowledge", args: { action: "get", ids: [finding] } }]);
          } else if (finding && !latestUserTail.includes(MOCK_KNOWLEDGE_ARTICLE.excerpt)) {
            const source = /s-[a-z0-9]{6}/.exec(latestUserTail)?.[0];
            if (!source) throw new Error("Knowledge finding read returned no source id.");
            streamToolCalls([{ name: "knowledge", args: { action: "get", ids: [source] } }]);
          } else if (finding && !calledTool(latestUserTail, "record_knowledge")) {
            streamToolCalls([
              {
                name: "record_knowledge",
                args: {
                  action: "use",
                  request_id: "inbox-use",
                  id: finding,
                  reason: "checked the wake queue against how the inbox retries",
                },
              },
            ]);
          } else if (!calledTool(latestUserTail, "report")) {
            streamToolCalls([
              {
                name: "report",
                args: {
                  text: concept
                    ? MOCK_KNOWLEDGE_REUSE_REPORT
                    : "My brief offered no knowledge about the inbox.",
                },
              },
            ]);
          } else {
            streamText(MOCK_KNOWLEDGE_REUSE_REPORT);
          }
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
        // Unpicked choices (contract 4.56): the first emit preanswers its
        // required questions and is refused; the refusal in the tool result
        // brings the same card back unpicked, its recommendations marked.
        if (!isFirstmate && body.includes(UNPICKED_PROMPT_MARKER) && wantsStream) {
          // The captain's choice is answered, never met with the card again.
          if (latestUserTail.includes("the user chose")) {
            streamText("Shipping the notes, as chosen.");
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          const refused = hasToolResults && latestUserTail.includes(UNPICKED_REFUSAL);
          if (emits === 0 || (emits === 1 && refused)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "unpicked-questions",
                  title: UNPICKED_TITLE,
                  body: unpickedQuestionsBody(!refused),
                  actions: [
                    { id: "not-now", label: "Not now" },
                    { id: "ship-notes", label: UNPICKED_DEFAULT_LABEL, default: true },
                  ],
                },
              },
            ]);
            return;
          }
          streamText("The release questions are on the card.");
          return;
        }
        // Something else (FI3-1002): the first emit has no row and is
        // refused; the refusal brings the same card back with one.
        if (!isFirstmate && body.includes(WRITE_IN_PROMPT_MARKER) && wantsStream) {
          if (latestUserTail.includes("the user chose")) {
            streamText("Following your own answer, as written.");
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          const refused = hasToolResults && latestUserTail.includes(WRITE_IN_REFUSAL);
          if (emits === 0 || (emits === 1 && refused)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "write-in-questions",
                  title: WRITE_IN_TITLE,
                  body: writeInQuestionsBody(refused),
                  actions: [
                    { id: "not-now", label: "Not now" },
                    { id: "send-answers", label: WRITE_IN_DEFAULT_LABEL, default: true },
                  ],
                },
              },
            ]);
            return;
          }
          streamText("The launch questions are on the card.");
          return;
        }
        // Card evidence: the card goes up with the report, then a revision
        // of it waits on this crewmate's next close-out while it works on.
        if (!isFirstmate && body.includes(STALE_OFFER_PROMPT_MARKER) && wantsStream) {
          if (latestUserTail.includes("the user chose")) {
            streamText("Retrying on the queue flush, as chosen.");
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "stale-offer",
                  title: STALE_OFFER_TITLE,
                  body: "<p>Retrying on the queue flush removes the race.</p><p>Ten runs in a row passed with the retry waiting on the flush.</p>",
                  actions: [
                    { id: "retry-flush", label: STALE_OFFER_CHOICE_LABEL, default: true },
                    { id: "leave-it", label: "Leave it as it is" },
                  ],
                },
              },
            ]);
            return;
          }
          if (!calledTool(latestUserTail, "report")) {
            streamToolCalls([
              {
                name: "report",
                args: { text: "The retry card is up; checking the clock path next." },
              },
            ]);
            return;
          }
          if (!latestUserTail.includes(STALE_OFFER_REVISED_TITLE)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "stale-offer",
                  title: STALE_OFFER_REVISED_TITLE,
                  body: "<p>Retrying on the clock is simpler than waiting on the flush.</p><p>The clock path passed the same ten runs.</p>",
                  actions: [
                    { id: "retry-clock", label: "Retry on the clock", default: true },
                    { id: "leave-it", label: "Leave it as it is" },
                  ],
                },
              },
            ]);
            return;
          }
          holdOpen();
          return;
        }
        if (!isFirstmate && body.includes(THREAD_WORKING_SIBLING_MARKER) && wantsStream) {
          holdOpen();
          return;
        }
        // The crewmate the app closes under: every delivery of its message
        // is held open until that message has come back RESTART_REPLAY_QUITS
        // times, each time saying it is a replay.
        if (!isFirstmate && body.includes(RESTART_REPLAY_PROMPT_MARKER) && wantsStream) {
          if (hasToolResults) {
            streamText("Reported.");
            return;
          }
          const replays = providerMessages(body).filter(
            (message) => message.role === "user" && message.text.includes(RESTART_REPLAY_NOTE),
          ).length;
          if (replays < RESTART_REPLAY_QUITS) {
            holdOpen();
            return;
          }
          streamToolCalls([{ name: "report", args: { text: MOCK_RESTART_REPLAY_REPORT } }]);
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
        // The settle hand-off: a reply asking for the change to go in is
        // not the crewmate's to run, so it closes its card and reports the
        // captain's words verbatim. No classifier reads anything.
        if (!isFirstmate && body.includes(THREAD_SETTLE_PROMPT_MARKER) && wantsStream) {
          const shownCardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
          if (!hasToolResults && latestUserTail.includes(THREAD_SETTLE_REPLY)) {
            streamToolCalls([
              { name: "close_card", args: { card_id: shownCardId } },
              { name: "report", args: { text: MOCK_THREAD_HANDOFF_REPORT } },
            ]);
            return;
          }
          if (!hasToolResults && !calledTool(body, "emit_card")) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "thread-settle",
                  title: THREAD_SETTLE_CARD_TITLE,
                  body: MOCK_STANDARD_CARD_BODY,
                  actions: [
                    {
                      id: "merge",
                      label: "Merge the branch",
                      default: true,
                      effect: { kind: "settle", mode: "merge" },
                    },
                  ],
                },
              },
            ]);
            return;
          }
          streamText("Holding for the captain's decision.");
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
        // The mock crewmate: the card e2e answers a marked brief with
        // emit_card tool calls; the follow-up (carrying tool results)
        // finishes with plain text.
        if (
          !isFirstmate &&
          latestUserTail.includes(REVISE_NOTE_PROMPT_MARKER) &&
          !hasToolResults &&
          wantsStream
        ) {
          streamToolCalls([
            {
              name: "emit_card",
              args: {
                id: "quota-note",
                title: MOCK_QUOTA_NOTE_TITLE,
                body: `<p>${MOCK_REVISED_NOTE_TEXT}</p>`,
              },
            },
          ]);
          return;
        }
        if (!isFirstmate && latestUserTail.includes(ESCAPED_CARD_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_ESCAPED_CARD_TITLE,
                  body: MOCK_ESCAPED_CARD_BODY.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
                  actions: MOCK_ESCAPED_CARD_ACTIONS,
                },
              },
            ]);
            return;
          }
          if (
            latestUserTail.includes(ESCAPED_BODY_REFUSAL_PHRASE) &&
            !latestUserTail.includes(`Card shown: ${MOCK_ESCAPED_CARD_TITLE}`)
          ) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_ESCAPED_CARD_TITLE,
                  body: MOCK_ESCAPED_CARD_BODY,
                  actions: MOCK_ESCAPED_CARD_ACTIONS,
                },
              },
            ]);
            return;
          }
          // The card is up: the turn ends with the plain-text report below.
        }
        const checkMove =
          !isFirstmate && wantsStream
            ? (staleChecksMove(body, false) ??
              checkRepairMove(body, false) ??
              dependencyWaitMove(body, false))
            : undefined;
        if (checkMove) {
          if ("calls" in checkMove) streamToolCalls(checkMove.calls);
          else streamText(checkMove.text);
          return;
        }

        // Exercise the real corrective refusal, then publish the correction.
        if (
          !isFirstmate &&
          latestUserTail.includes(STANDARD_TIER_MISSING_HEADING_MARKER) &&
          wantsStream
        ) {
          const results = sinceLastUser(body).results;
          if (results.length === 0) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_STANDARD_CARD_TITLE,
                  body: MOCK_STANDARD_CARD_BODY.replace(/<h3>Before<\/h3>/, ""),
                  actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
                },
              },
            ]);
          } else if (results.length === 1) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_STANDARD_CARD_TITLE,
                  body: MOCK_STANDARD_CARD_BODY,
                  actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
                },
              },
              { name: "report", args: { text: MOCK_STANDARD_REPORT } },
            ]);
          } else {
            streamText("The corrected completion outline is shown.");
          }
          return;
        }

        // The host-attached buttons and the freed body (contract v3.6): one
        // declared merge under an invented label, a body that draws its
        // answer rather than repeating the record, and the report that still
        // carries the five headings.
        if (
          !isFirstmate &&
          latestUserTail.includes(STANDARD_TIER_HOST_BUTTONS_MARKER) &&
          wantsStream
        ) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE,
                  body: MOCK_STANDARD_DRAWN_BODY,
                  actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
                },
              },
              { name: "report", args: { text: MOCK_STANDARD_REPORT } },
            ]);
            return;
          }
          streamText("done");
          return;
        }
        if (!isFirstmate && wantsStream) {
          const sequencesMove = sequencesCrewmateMove(body, hasToolResults);
          if (sequencesMove) {
            if ("calls" in sequencesMove) streamToolCalls(sequencesMove.calls);
            else streamText(sequencesMove.text);
            return;
          }
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
        if (!isFirstmate && latestUserTail.includes(WORKFLOW_DISPATCH_MARKER) && wantsStream) {
          const { results } = sinceLastUser(body);
          const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) =>
            streamToolCalls([{ name, args } as ScriptedCall]);
          const project = "/repos/octo/meterlab";
          const runs = `${project}/actions/runs?branch=main&event=workflow_dispatch`;
          if (!results.length) {
            call("github_write", { method: "POST", path: "/user/keys", body: "{}" });
            return;
          }
          if (results.length === 1) {
            call("github_write", {
              method: "POST",
              path: `${project}/actions/workflows/verify.yml/dispatches`,
              body: JSON.stringify({ ref: "main", inputs: { profile: "alpha", perf: true } }),
            });
            return;
          }
          const blocked = results[1]?.includes("Cannot call GitHub");
          if (results.length === 2 && !blocked) {
            call("github_read", { path: runs });
            return;
          }
          if (results.length === 3 && !blocked) {
            const runId = JSON.parse(results[2] ?? "{}").body?.workflow_runs?.[0]?.id;
            call("github_write", {
              method: "POST",
              path: `${project}/actions/runs/${runId}/cancel`,
            });
            return;
          }
          if (results.length === 4 && !blocked) {
            call("github_read", { path: runs });
            return;
          }
          if (results.length === (blocked ? 2 : 5)) {
            call("report", {
              text: `Account-level refusal: ${results[0]}\nDispatch: ${results[1]}\nRuns: ${results[2] ?? "not read"}\nCancellation: ${results[3] ?? "not requested"}\nFinal runs: ${results[4] ?? "not read"}`,
              summary: blocked
                ? "Workflow operations need the app's GitHub sign-in."
                : "The project workflow accepted its ref and inputs, then cancellation.",
            });
            return;
          }
          streamText("Workflow operations reported.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(GITLAB_EVIDENCE_MARKER) && wantsStream) {
          const { results } = sinceLastUser(body);
          const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) =>
            streamToolCalls([{ name, args } as ScriptedCall]);
          // The GitLab stand-in's project, by its URL-encoded path.
          const project = `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;
          if (!results.length) {
            call("bash", { command: "git rev-parse HEAD" });
            return;
          }
          const last = results[results.length - 1] ?? "";
          if (
            results.length <= 5 &&
            (last.includes("Cannot call") || last.includes("Cannot read workflow evidence"))
          ) {
            call("report", {
              text: `Evidence blocked: ${last}`,
              summary: "GitLab pipeline evidence could not be read.",
            });
            return;
          }
          const headSha = results[0]?.match(/[0-9a-f]{40}/)?.[0] ?? "";
          if (results.length === 1) {
            call("github_read", { path: `${project}/pipelines?sha=${headSha}` });
            return;
          }
          const runId = JSON.parse(results[1] ?? "{}").body?.[0]?.id;
          if (results.length === 2) {
            call("github_read", { path: `${project}/pipelines/${runId}/jobs` });
            return;
          }
          const jobId =
            (
              JSON.parse(results[2] ?? "{}").body as { id: number; status: string }[] | undefined
            )?.find((job) => job.status === "failed")?.id ?? 0;
          if (results.length === 3) {
            call("read_workflow", { runId, jobId, offset: 1, limit: 5 });
            return;
          }
          if (results.length === 4) {
            call("download_artifact", { runId, artifactId: jobId });
            return;
          }
          if (results.length === 5) {
            const receipt = JSON.parse(results[4] ?? "{}");
            call("bash", { command: `unzip -p '${receipt.path}' measurement.json` });
            return;
          }
          if (results.length === 6) {
            call("github_write", {
              method: "POST",
              path: `/projects/${encodeURIComponent(GITLAB_STUB_OTHER_PROJECT)}/issues`,
              body: '{"title":"not this task\'s project"}',
            });
            return;
          }
          if (results.length === 7) {
            call("report", {
              text: `GitLab pipeline evidence returned.\nPipelines: ${results[1]}\nJobs: ${results[2]}\nJob log: ${results[3]}\nArchive receipt: ${results[4]}\nMeasurement contents: ${results[5]}\nWrite to another project: ${results[6]}`,
              summary:
                "The failed job's log and archive are available through the app's GitLab key.",
            });
            return;
          }
          streamText("Evidence returned.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(WORKFLOW_EVIDENCE_MARKER) && wantsStream) {
          const { results } = sinceLastUser(body);
          const call = <N extends ScriptedCall["name"]>(name: N, args: ScriptedArgs<N>) =>
            streamToolCalls([{ name, args } as ScriptedCall]);
          // The project the forge-signin stand-in serves; github_read lists
          // the version's runs, the failed attempt's jobs and the artifacts,
          // read_workflow pages the job log and download_artifact saves the ZIP.
          const project = "/repos/octo/meterlab";
          if (!results.length) {
            call("bash", { command: "git rev-parse HEAD" });
            return;
          }
          const blocked = results.findIndex(
            (result) =>
              result.includes("Cannot call GitHub") ||
              result.includes("Cannot read workflow evidence"),
          );
          if (blocked >= 0) {
            if (blocked === results.length - 1)
              call("report", {
                text: `Evidence blocked: ${results[blocked]}`,
                summary: "Workflow evidence needs the app's GitHub sign-in.",
              });
            else streamText("Evidence blocker reported.");
            return;
          }
          const headSha = results[0]?.match(/[0-9a-f]{40}/)?.[0] ?? "";
          if (results.length === 1) {
            call("github_read", { path: `${project}/actions/runs?head_sha=${headSha}` });
            return;
          }
          const run = JSON.parse(results[1] ?? "{}").body?.workflow_runs?.[0];
          const runId = run?.id;
          if (results.length === 2) {
            call("github_read", {
              path: `${project}/actions/runs/${runId}/attempts/${run?.run_attempt}/jobs`,
            });
            return;
          }
          if (results.length === 3) {
            call("github_read", { path: `${project}/actions/runs/${runId}/artifacts` });
            return;
          }
          const jobId = JSON.parse(results[2] ?? "{}").body?.jobs?.[0]?.id;
          const artifactId = JSON.parse(results[3] ?? "{}").body?.artifacts?.[0]?.id;
          if (results.length === 4) {
            call("read_workflow", { runId, jobId, offset: 2, limit: 2 });
            return;
          }
          if (results.length === 5) {
            call("download_artifact", { runId, artifactId });
            return;
          }
          const receipt = JSON.parse(results[5] ?? "{}");
          if (results.length === 6) {
            call("bash", { command: `unzip -p '${receipt.path}' measurement.json` });
            return;
          }
          if (results.length === 7) {
            call("report", {
              text: `Workflow evidence returned.\nRuns: ${results[1]}\nJobs: ${results[2]}\nArtifacts: ${results[3]}\nJob log: ${results[4]}\nArtifact receipt: ${results[5]}\nMeasurement contents: ${results[6]}`,
              summary:
                "The failed job log and measurement artifact are available through the app's sign-in.",
            });
            return;
          }
          streamText("Evidence returned.");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(SEND_UP_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "bash",
                args: {
                  command:
                    'git commit --allow-empty -m "fix: the meter reads on time" && git push origin HEAD',
                },
              },
            ]);
            return;
          }
          if (latestUserTail.includes(MOCK_SENT_UP_CARD_TITLE)) {
            streamText("done");
            return;
          }
          streamToolCalls([
            {
              name: "emit_card",
              args: {
                title: MOCK_SENT_UP_CARD_TITLE,
                body: MOCK_STANDARD_CARD_BODY,
                actions: [
                  {
                    id: "put-in",
                    label: "Put it in",
                    default: true,
                    effect: { kind: "settle", mode: "merge" },
                  },
                ],
              },
            },
            { name: "report", args: { text: "The meter fix is saved and sent up." } },
          ]);
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_PROMPT_MARKER) && wantsStream) {
          const step = calledTool(body, "report") ? undefined : lookingAgain(body, taskBrowserStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_READING_MARKER) && wantsStream) {
          const step = calledTool(body, "report")
            ? undefined
            : lookingAgain(body, taskBrowserReadingStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_LONG_MARKER) && wantsStream) {
          const step = calledTool(body, "report")
            ? undefined
            : lookingAgain(body, taskBrowserLongStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_PAGES_MARKER) && wantsStream) {
          const step = calledTool(body, "report")
            ? undefined
            : lookingAgain(body, taskBrowserPagesStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_WATCH_MARKER) && wantsStream) {
          const step = calledTool(body, "report")
            ? undefined
            : lookingAgain(body, taskBrowserWatchStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_SAVED_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserSavedStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_HANDOFF_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserHandoffStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_TAKE_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserTakeStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_FENCE_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserFenceStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_BOOKING_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserBookingStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_LOST_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserLostStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_UNPAID_MARKER) && wantsStream) {
          const step = lookingAgain(body, taskBrowserUnpaidStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && body.includes(TASK_BROWSER_CARD_MARKER) && wantsStream) {
          const step = calledTool(body, "report")
            ? undefined
            : lookingAgain(body, taskBrowserCardStep);
          if (step) streamToolCalls(step);
          else streamText("done");
          return;
        }
        if (!isFirstmate && latestUserTail.includes(NODE_VERSION_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([{ name: "bash", args: { command: "node --version" } }]);
            return;
          }
          if (latestUserTail.includes(MOCK_NODE_REPORT_PREFIX)) {
            streamText("done");
            return;
          }
          // Only what came back from the shell: the tool result follows the call.
          const result = latestUserTail.slice(latestUserTail.indexOf('"tool_calls"'));
          const answer =
            result.match(/v\d+\.\d+\.\d+[\w.-]*/)?.[0] ??
            result.match(/command not found|not found/)?.[0] ??
            "nothing";
          streamToolCalls([
            { name: "report", args: { text: `${MOCK_NODE_REPORT_PREFIX} ${answer}.` } },
          ]);
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
        if (!isFirstmate && body.includes(RETRIEVAL_TASK_ASK) && wantsStream) {
          if (calledTool(body, "emit_card")) streamText("The lookup answer is ready.");
          else if (!calledTool(body, "read"))
            streamToolCalls([{ name: "read", args: { path: "release-info.json" } }]);
          else {
            const results = toolAnswers(providerMessages(body)).join("\n");
            if (!results.includes(RETRIEVAL_SOURCE))
              throw new Error("Retrieval fixture did not read its committed release facts");
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  id: "release-facts",
                  title: RETRIEVAL_CARD_TITLE,
                  body: "<p>Release 0.1.31 includes video demos.</p><p>Source: <code>release-info.json</code>, version and videoDemos fields.</p>",
                },
              },
              {
                name: "report",
                args: {
                  text: "Read release-info.json: version 0.1.31, videoDemos true. No changes made.",
                  summary: "The recorded release includes video demos.",
                  waiting_on_captain: { reason: "Read the lookup answer" },
                },
              },
            ]);
          }
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
        // The standard-tier crewmate (delivery rigor phase 1): its completion
        // card carries the five headings as sections and its report is the
        // same five headings in prose, in one turn; the follow-up leg closes
        // briefly, so the explicit report is the one Firstmate hears.
        if (!isFirstmate && latestUserTail.includes(STANDARD_TIER_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_STANDARD_CARD_TITLE,
                  body: MOCK_STANDARD_CARD_BODY,
                  actions: MOCK_STANDARD_CARD_ACTIONS,
                },
              },
              { name: "report", args: { text: MOCK_STANDARD_REPORT } },
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
        if (latestUserTail.includes(SCRIPT_CARDS_PROMPT_MARKER) && !hasToolResults && wantsStream) {
          streamToolCalls(scriptCardToolCalls((server.address() as AddressInfo).port));
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
          latestUserTail.includes(LOCAL_LINK_CARDS_PROMPT_MARKER) &&
          !hasToolResults &&
          wantsStream
        ) {
          streamToolCalls(localLinkCardToolCalls());
          return;
        }
        if (latestUserTail.includes(ATTACK_CARDS_PROMPT_MARKER) && !hasToolResults && wantsStream) {
          streamToolCalls(attackCardToolCalls((server.address() as AddressInfo).port));
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
        // The before-and-after crewmate: write the files, then offer the merge,
        // and offer it again once the card check refuses the misplaced mark.
        if (!isFirstmate && latestUserTail.includes(BEFORE_AFTER_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls(writeChangePicturesCalls());
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([beforeAfterCardCall("picture")]);
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          const refused = JSON.stringify(BEFORE_AFTER_MARK_REFUSAL).slice(1, -1);
          if (emits === 1 && latestUserTail.includes(refused)) {
            streamToolCalls([beforeAfterCardCall("figure")]);
            return;
          }
        }
        // The demo crewmate: write the files, offer the card with the filler
        // recording, then with the real one once the decoder refused it.
        if (!isFirstmate && latestUserTail.includes(DEMO_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([...writeChangePicturesCalls(), ...writeDemoCalls()]);
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([demoCardCall(BROKEN_DEMO)]);
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          if (emits === 1 && latestUserTail.includes(DEMO_REFUSAL)) {
            streamToolCalls([demoCardCall(DEMO_RECORDING.path)]);
            return;
          }
        }
        // The GIF demo crewmate: write the files, offer the card with a GIF
        // that loops, then with the single-play one once the host refused it.
        if (!isFirstmate && latestUserTail.includes(GIF_DEMO_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls([...writeChangePicturesCalls(), ...writeGifDemoCalls()]);
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([demoCardCall(LOOPING_GIF_DEMO.path, GIF_DEMO_CARD_TITLE)]);
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          if (emits === 1 && latestUserTail.includes(GIF_DEMO_REFUSAL)) {
            streamToolCalls([demoCardCall(GIF_DEMO_RECORDING.path, GIF_DEMO_CARD_TITLE)]);
            return;
          }
        }
        // The project-font crewmate: write the files, offer the preview with
        // the damaged copy, then with the real file once the host refused it.
        if (!isFirstmate && latestUserTail.includes(PROJECT_FONT_PROMPT_MARKER) && wantsStream) {
          const port = (server.address() as AddressInfo).port;
          if (!hasToolResults) {
            streamToolCalls(writeProjectFontCalls());
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls([projectFontCardCall(DAMAGED_FONT, port)]);
            return;
          }
          const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
            .map((call) => latestUserTail.split(call).length - 1)
            .reduce((sum, count) => sum + count, 0);
          if (emits === 1 && latestUserTail.includes(PROJECT_FONT_REFUSAL)) {
            streamToolCalls([projectFontCardCall(PROJECT_FONT, port)]);
            return;
          }
        }
        // The pictures crewmate: write the files, then attach them. After
        // the cards it falls through to the default close-out.
        if (!isFirstmate && latestUserTail.includes(CARD_PICTURES_PROMPT_MARKER) && wantsStream) {
          if (!hasToolResults) {
            streamToolCalls(writePicturesCalls());
            return;
          }
          if (!calledTool(latestUserTail, "emit_card")) {
            streamToolCalls(pictureCardToolCalls());
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
        // A crewmate that reports it is blocked (S4, O2): its own account of
        // itself is never an escalation trigger, so the report carries the
        // triage marker and reaches the Firstmate as an [fm-op].
        if (
          !isFirstmate &&
          latestUserTail.includes(BLOCKED_REPORT_PROMPT_MARKER) &&
          !hasToolResults &&
          wantsStream
        ) {
          streamText(MOCK_BLOCKED_REPORT);
          return;
        }
        if (
          !isFirstmate &&
          latestUserTail.includes(PROPOSE_PROJECT_PROMPT_MARKER) &&
          !hasToolResults &&
          wantsStream
        ) {
          const path = latestUserTail.match(
            new RegExp(`${PROPOSE_PROJECT_PROMPT_MARKER}([^"\\\\\\s]+)`),
          )?.[1];
          streamText(
            `The runner fixes need the folder at ${path} ${PROPOSE_PROJECT_REPORT_NEEDLE}.`,
          );
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
