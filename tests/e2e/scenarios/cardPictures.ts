import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { shellJobsRunning } from "../browserScript";
import { writeFilesCalls } from "../crewCards";
import type { Scenario } from "../mockProvider";
import {
  bytesOf,
  dataUrl,
  FIRST_GROUP,
  INLINE_PICTURE,
  type PictureFixture,
  SECOND_GROUP,
  TALL_PICTURE,
  WIDE_PICTURE,
  WORKING_COPY_PICTURES,
} from "../pictureFixtures";
import { calledTool } from "../providerRequest";

/**
 * Marker prompt: the mock crewmate writes real picture files into its
 * working copy with bash, then names them in its card bodies - the real card
 * path since card pictures phase 2 (`card-picture-fit.spec.ts`,
 * `card-pictures.spec.ts`): one wide and one tall picture alone, a card
 * mixing lone pictures with one the body carries itself as a `data:` URL,
 * and a card with two groups.
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
 * A diagram a card draws inline, 750 units wide as docs/card-authoring.md
 * asks, in the design system's tokens: the press that opens it (INF-3107).
 */
export const CARD_DIAGRAM = {
  caption: "A picture travels from the card to the viewer on your own press",
  width: 750,
  height: 120,
  label: "Viewer",
} as const;
const DIAGRAM_BOX = (x: number, words: string, lit = false) =>
  `<rect x="${x}" y="30" width="200" height="60" rx="8" fill="var(${lit ? "--accent-dim" : "--bg-2"})" stroke="var(${lit ? "--accent" : "--line-2"})"/>` +
  `<text x="${x + 100}" y="66" text-anchor="middle" fill="var(--fg-1)" font-size="14">${words}</text>`;
const DIAGRAM =
  `<figure><svg viewBox="0 0 ${CARD_DIAGRAM.width} ${CARD_DIAGRAM.height}" width="100%" role="img" aria-label="Card, card page and viewer">` +
  DIAGRAM_BOX(25, "Card body") +
  `<path d="M225 60h50" stroke="var(--line-2)" stroke-width="2"/>` +
  DIAGRAM_BOX(275, "Card page") +
  `<path d="M475 60h50" stroke="var(--line-2)" stroke-width="2"/>` +
  DIAGRAM_BOX(525, CARD_DIAGRAM.label, true) +
  `</svg><figcaption>${CARD_DIAGRAM.caption}</figcaption></figure>`;
export const PICTURES_STILL_WRITING = "The pictures are still being written.";

function writePicturesCalls(): ScriptedCall[] {
  return writeFilesCalls(
    WORKING_COPY_PICTURES.map((picture) => ({ path: picture.path, bytes: bytesOf(picture) })),
  );
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
          img(TALL_PICTURE) +
          DIAGRAM,
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
 * The pictures crewmate: write the files, then attach them; after the cards
 * it passes on to the default close-out. It reads the whole conversation, not
 * only its latest turn, because a write can resume it from a wake.
 */
export const cardPictures: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(CARD_PICTURES_PROMPT_MARKER))
      return undefined;
    if (!calledTool(body, "bash")) return { calls: writePicturesCalls() };
    // INF-1128: on a busy computer a write can outlast the shell's limit and
    // come back as a background job's receipt while its file is still being
    // written. A card naming that file would be refused, so the crewmate ends
    // its turn and attaches the pictures once every write's job has exited.
    if (shellJobsRunning(body)) return { text: PICTURES_STILL_WRITING };
    if (!calledTool(body, "emit_card")) return { calls: pictureCardToolCalls() };
    return undefined;
  };
