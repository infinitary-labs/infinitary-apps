import { looping, MOVING_BOX_GIF_SIZE, movingBoxGifBytes } from "../helpers/gifFixture";
import { MOVING_BOX, movingBoxBytes } from "../helpers/mp4Fixture";
import { encodePng, type PictureFixture } from "./pictureFixtures";

/**
 * The files a crewmate attaches as a demo in the card-demo specs: a real
 * H.264 recording of a box sliding right (`tests/fixtures/demo/moving-box.mp4`,
 * made by the pinned encoder), the single-play GIF the pinned encoder makes
 * of it (`moving-box.gif`), and their poster, the recording's first picture
 * drawn here at the same size - the box at its starting place.
 */

const BACKGROUND = [0x16, 0x18, 0x1d] as const;
const BOX = [0x7c, 0xc4, 0xfa] as const;

/** Where the box starts in the recording's first picture. */
const START = { x: 40, y: 105, size: 60 };

export const DEMO_RECORDING = {
  path: "shots/drag-demo.mp4",
  bytes: movingBoxBytes(),
  ...MOVING_BOX,
} as const;

export const DEMO_POSTER: PictureFixture = {
  path: "shots/drag-demo.png",
  alt: "The box at its starting place, before it slides right",
  width: MOVING_BOX.width,
  height: MOVING_BOX.height,
  format: "png",
  tint: 0,
  bytes: encodePng(MOVING_BOX.width, MOVING_BOX.height, (x, y) =>
    x >= START.x && x < START.x + START.size && y >= START.y && y < START.y + START.size
      ? BOX
      : BACKGROUND,
  ),
};

/** The demo's caption: the action and its result. */
export const DEMO_CAPTION = "Drag the box: it slides right to its new place.";

/** The GIF fallback of the same recording: 3 seconds at 10 frames a second, played once. */
export const GIF_DEMO_RECORDING = {
  path: "shots/drag-demo.gif",
  bytes: movingBoxGifBytes(),
  ...MOVING_BOX_GIF_SIZE,
} as const;

/** The same GIF told to loop forever, which the host refuses. */
export const LOOPING_GIF_DEMO = {
  path: "shots/looping-demo.gif",
  bytes: looping(movingBoxGifBytes()),
};
