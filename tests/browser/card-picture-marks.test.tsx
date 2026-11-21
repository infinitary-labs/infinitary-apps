import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { keyStep, middleBox, movedBox, sizedBox } from "../../src/shared/cardNoteMarks";
import {
  type CardNote,
  NOT_SENT,
  NOTE_COMMENT_LABEL,
  type NotePlace,
  noteLabel,
  STALE_NOTE,
} from "../../src/shared/cardNotes";
import {
  ANNOTATION_BODY,
  ANNOTATION_DRAWING_CAPTION,
  ANNOTATION_TITLE,
} from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Intent: the accepted Point at plan's place in a picture, in the viewer. The
 * arrows move a box, Shift with them sizes it and Enter opens the note; a
 * queued mark shows numbered on its picture; a press on its note opens the
 * viewer at the mark; and a picture a revision replaced reads "This part is no
 * longer in the card". The card is the approved annotation example with its
 * real drawing, 750 by 120.
 */
const DRAWING = { width: 750, height: 120 };
const SAID = "Say which card";

test("the viewer marks a drawing by keys, keeps the queued mark on it and opens at it from its note", async () => {
  const bridge = fakeBridge(await seededHome());
  await openSize();
  await openWindow(bridge);
  const frame = await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const { useShellStore } = await import("../../src/renderer/src/app/store");
  const { runWindowCommand } = await import("../../src/renderer/src/app/shellCommands");
  const card = useShellStore.getState().cards.find((each) => each.title === ANNOTATION_TITLE);
  if (!card) throw new Error("missing saved annotation example");
  frame.focus();
  await inCardBody(ANNOTATION_TITLE, () =>
    document.querySelector<SVGElement>("figure svg")?.focus(),
  );
  await userEvent.keyboard("{Enter}");
  const viewer = page.getByRole("dialog", { name: `Pictures from ${ANNOTATION_TITLE}` });
  await expect.element(viewer).toBeVisible();
  const pressed = () =>
    document.querySelector("[data-viewer-point-at]")?.getAttribute("aria-pressed");
  const drawnMarks = () =>
    document.querySelector("[data-picture-marks]")?.getAttribute("data-picture-marks");

  // The command's own key turns Point at on in the viewer, never in the card under it.
  expect(runWindowCommand("cards.point-at", "key")).toBe(true);
  await expect.poll(pressed).toBe("true");
  expect(useShellStore.getState().pointAtCard).toBeNull();
  // The first arrow shows the box in the picture's middle; the next ones move it, Shift sizes it.
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(drawnMarks).toBe("1");
  await userEvent.keyboard("{ArrowRight}{ArrowDown}{Shift>}{ArrowRight}{/Shift}{Enter}");
  const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
  await expect.element(comment).toBeVisible();
  const step = keyStep(DRAWING);
  expect(useShellStore.getState().annotationPick?.note).toMatchObject({
    kind: "drawing",
    // The picture's caption is the note's excerpt.
    excerpt: ANNOTATION_DRAWING_CAPTION,
    place: sizedBox(movedBox(movedBox(middleBox(DRAWING), step, 0), 0, step), step, 0),
  });
  // Point at turned off once it marked.
  expect(pressed()).toBe("false");
  await userEvent.fill(comment, SAID);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => useShellStore.getState().replyNotes[card.id]?.length).toBe(1);
  const note = useShellStore.getState().replyNotes[card.id]?.[0];
  if (!note) throw new Error("the mark queued no note");
  // The queued mark stays on its picture with its number.
  await expect.poll(drawnMarks).toBe("1");
  // It is drawn in the accent of the theme the window shows, and again when the theme changes.
  const drawing = () =>
    decodeURIComponent(
      document.querySelector<HTMLImageElement>("[data-picture-marks-drawn]")?.src ?? "",
    );
  const accent = () => getComputedStyle(document.body).getPropertyValue("--accent").trim();
  const before = accent();
  expect(drawing()).toContain(`stroke="${before}"`);
  useShellStore.getState().setTheme("light");
  await expect.poll(() => document.body.dataset.theme).toBe("light");
  expect(accent()).not.toBe(before);
  await expect.poll(drawing).toContain(`stroke="${accent()}"`);

  await userEvent.keyboard("{Escape}");
  await expect.element(viewer).not.toBeInTheDocument();
  // The note waits as Not sent, with a small copy of the marked picture.
  await expect.element(page.getByText(NOT_SENT, { exact: true })).toBeVisible();
  expect(document.querySelector('[data-marked-copy="1"]')).not.toBeNull();
  expect(bridge.requests("inf:cards:reply")).toEqual([]);

  // A press on the note opens the viewer at its mark.
  await userEvent.click(page.getByRole("button", { name: noteLabel(note, 1), exact: true }));
  await expect.element(viewer).toBeVisible();
  await expect.poll(drawnMarks).toBe("1");
  await userEvent.keyboard("{Escape}");
  await expect.element(viewer).not.toBeInTheDocument();

  // A revision that replaced the drawing: the note says its part is gone.
  bridge.push("inf:cards", [{ ...card, body: ANNOTATION_BODY }]);
  await expect.element(page.getByText(STALE_NOTE, { exact: true })).toBeVisible();
});

/**
 * A picture the window holds itself, as a card that carries its picture inline does. It is one
 * flat grey, so a pixel a mark covers and a pixel it leaves alone can be told apart.
 */
const GREY = [128, 128, 128];
function inlinePicture(alt: string, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no drawing surface");
  context.fillStyle = `rgb(${GREY.join(", ")})`;
  context.fillRect(0, 0, width, height);
  return { src: canvas.toDataURL("image/png"), alt, width, height };
}

/** A sent picture as the window decodes it: its size, and the color of one pixel. */
async function decodedPicture(picture: { mimeType: string; data: string }) {
  const image = new Image();
  image.src = `data:${picture.mimeType};base64,${picture.data}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no drawing surface");
  context.drawImage(image, 0, 0);
  return {
    size: { width: image.naturalWidth, height: image.naturalHeight },
    at: (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3),
  };
}

/**
 * Intent: the accepted Point at plan - on send the author "gets one picture per marked picture
 * with its numbered marks drawn in". The numbers' places are `cardNoteMarks.test.ts`'s; this
 * reads the pictures the window makes for a reply, from pictures it can read and one it cannot.
 */
test("a reply's marks ride one picture per marked picture, each at its own size with its marks drawn in", async () => {
  const { markedPictures, rememberMarked } = await import(
    "../../src/renderer/src/cards/markedPictures"
  );
  const settings = inlinePicture("The settings screen", 320, 200);
  const meters = inlinePicture("The whole meter row", 200, 120);
  // A picture the window can no longer read: its mark still goes as words.
  const gone = { src: "data:image/png;base64,AAAA", alt: "The old chart", width: 100, height: 100 };
  const marked = (
    start: number,
    source: { alt: string; width: number; height: number },
    place: Pick<NotePlace, "box" | "lines">,
  ): CardNote => ({
    start,
    key: `img:${start}`,
    kind: "picture",
    excerpt: source.alt,
    comment: "",
    line: start + 1,
    place: { width: source.width, height: source.height, ...place },
  });
  const box = marked(1, settings, { box: { x: 40, y: 30, width: 120, height: 80 } });
  const spot = marked(2, meters, { box: { x: 100, y: 60, width: 0, height: 0 } });
  const line = marked(1, settings, {
    lines: [
      [
        { x: 200, y: 150 },
        { x: 280, y: 150 },
      ],
    ],
  });
  const lost = marked(3, gone, { box: { x: 10, y: 10, width: 40, height: 40 } });
  // A note on a whole part marks no place, so it adds no picture.
  const whole: CardNote = {
    start: 0,
    key: "p:0",
    kind: "text",
    excerpt: "The settings screen, the meter row and the transcript",
    comment: "Shorter",
    line: 1,
  };
  rememberMarked("card-1", box, settings);
  rememberMarked("card-1", spot, meters);
  rememberMarked("card-1", line, settings);
  rememberMarked("card-1", lost, gone);

  const sent = await markedPictures("card-1", [box, whole, spot, line, lost]);
  expect(sent.map((picture) => picture.mimeType)).toEqual(["image/png", "image/png"]);
  const [first, second] = await Promise.all(sent.map(decodedPicture));
  if (!first || !second) throw new Error("missing marked picture");
  expect(first.size).toEqual({ width: 320, height: 200 });
  expect(second.size).toEqual({ width: 200, height: 120 });
  // The box's edge and the line are drawn in; inside the box and away from every mark the
  // picture is as it was.
  expect(first.at(100, 30)).not.toEqual(GREY);
  expect(first.at(240, 150)).not.toEqual(GREY);
  expect(first.at(100, 70)).toEqual(GREY);
  expect(first.at(310, 10)).toEqual(GREY);
  // The second picture carries only its own mark: the spot.
  expect(second.at(100, 60)).not.toEqual(GREY);
  expect(second.at(10, 110)).toEqual(GREY);
});
