import { completionCardBody } from "../helpers/completionCard";
import type { ScriptedCall, ScriptedCardAction } from "../helpers/scriptedCalls";
import { DEMO_CAPTION, DEMO_POSTER } from "./demoFixtures";
import {
  bytesOf,
  CHANGE_AFTER_PICTURES,
  CHANGE_BEFORE_PICTURES,
  type PictureFixture,
} from "./pictureFixtures";

/**
 * The cards and files scripted crewmates and first mates put up, shared by
 * several scenarios: the files a crewmate writes into its working copy, the
 * demo card, the standard tier's report and completion card, and the first
 * mate's thread card.
 */

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

/**
 * Delivery rigor, phase 1 (the standard tier): a crewmate briefed with
 * "ship at the standard tier" (`STANDARD_TIER_PROMPT_MARKER` in
 * `mockProvider.ts`) reports under the five headings the tier prescribes and
 * emits its completion card with the four-heading outline.
 * The mock is the shape the prompt asks for, so
 * the e2e proves the shape renders through the real emit -> lint -> frame
 * path and the report reaches the feed - not that a model obeyed.
 */
const STANDARD_TIER_HEADINGS = ["Intent", "What changed", "Verified", "Risk", "Not done"] as const;
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
 * Cards as threads, phase 2: a Firstmate-authored card. The captain's
 * reply is a captain TURN about that card (not a crewmate steer). The
 * Firstmate revises under the same id, or its closing words land as
 * prose in the thread - it has no reply tool.
 */
export const FM_THREAD_CARD_TITLE = "Two ways to phrase the welcome";
/** Tiny PNG the image-on-steer e2e pastes. */
export const THREAD_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
