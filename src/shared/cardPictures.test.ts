import { describe, expect, it } from "vitest";
import {
  CARD_MEDIA_KINDS,
  CARD_MEDIA_TYPES,
  cardMediaUrl,
  cardPictureFiles,
  cardPictureUrl,
  demoSources,
  isPlayableDemoSource,
  isViewablePictureSource,
  parseCardMediaFileName,
  parseCardPictureFileName,
  playableDemoKind,
  viewablePictures,
} from "./cardPictures";
import { cardDemoSchema } from "./cards";

const served = (n: number) => cardPictureUrl(`task-1-${n.toString(16).padStart(32, "0")}`, "png");
const png = "data:image/png;base64,iVBORw0KGgo=";

describe("the pictures the viewer may show", () => {
  it("shows the host's own copies and data: raster pictures", () => {
    expect(isViewablePictureSource(served(1))).toBe(true);
    expect(isViewablePictureSource(png)).toBe(true);
    expect(isViewablePictureSource("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(isViewablePictureSource("data:image/webp;base64,UklGR")).toBe(true);
    expect(isViewablePictureSource("data:image/gif;base64,R0lGOD")).toBe(true);
  });

  it("shows nothing else", () => {
    for (const src of [
      "https://example.com/a.png",
      "data:image/svg+xml,<svg/>",
      "data:text/html,<p>",
      "app-frame://fonts/SpaceGrotesk.woff2",
      "app-frame://images/../../etc/passwd",
      "app-frame://images/not-a-minted-name.png",
      `${served(1)}?x=1`,
      "file:///tmp/a.png",
    ]) {
      expect(isViewablePictureSource(src), src).toBe(false);
    }
  });

  it("keeps a group's viewable pictures in order and follows the clicked one", () => {
    const group = [{ src: served(1) }, { src: "https://example.com/x.png" }, { src: png }];
    expect(viewablePictures(2, group)).toEqual({ index: 1, pictures: [group[0], group[2]] });
    expect(viewablePictures(0, group)).toEqual({ index: 0, pictures: [group[0], group[2]] });
  });

  it("opens nothing when the clicked picture is not viewable or not there", () => {
    const group = [{ src: served(1) }, { src: "https://example.com/x.png" }];
    expect(viewablePictures(1, group)).toBeUndefined();
    expect(viewablePictures(5, group)).toBeUndefined();
  });
});

describe("cardPictureFiles", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  it("names each picture's file under the crewmate folder, once, and leaves other links alone", () => {
    const body = `<img src="app-frame://images/task1-${hash}.png" alt="a"><img src="app-frame://images/task1-${hash}.png"><img src="app-frame://images/bad.png">`;
    const out = cardPictureFiles(body, "/data/crewmates");
    const file = `/data/crewmates/task1/cards/task1-${hash}.png`;
    expect(out.pictures).toEqual([file]);
    expect(out.recordings).toEqual([]);
    expect(out.body).toBe(
      `<img src="${file}" alt="a"><img src="${file}"><img src="app-frame://images/bad.png">`,
    );
  });

  it("names each demo recording's file beside its poster's, and leaves an unminted one alone", () => {
    const body = `<figure data-fm-demo="app-frame://media/task1-${hash}.mp4"><img src="app-frame://images/task1-${hash}.png" alt="p"></figure><figure data-fm-demo="app-frame://media/task1-${hash}.png"></figure>`;
    const out = cardPictureFiles(body, "/data/crewmates");
    const recording = `/data/crewmates/task1/cards/task1-${hash}.mp4`;
    const poster = `/data/crewmates/task1/cards/task1-${hash}.png`;
    expect(out.recordings).toEqual([recording]);
    expect(out.pictures).toEqual([poster]);
    expect(out.body).toBe(
      `<figure data-fm-demo="${recording}"><img src="${poster}" alt="p"></figure><figure data-fm-demo="app-frame://media/task1-${hash}.png"></figure>`,
    );
  });
});

describe("demo recording names", () => {
  const id = `task-1-${"a".repeat(32)}`;

  it("names the same kinds the card record keeps", () => {
    expect([...cardDemoSchema.shape.kind.options]).toEqual([...CARD_MEDIA_KINDS]);
    expect(Object.keys(CARD_MEDIA_TYPES)).toEqual([...CARD_MEDIA_KINDS]);
  });

  it("serves a minted recording at the media host, and a picture never there", () => {
    expect(cardMediaUrl(id, "mp4")).toBe(`app-frame://media/${id}.mp4`);
    expect(parseCardMediaFileName(`${id}.mp4`)).toEqual({
      taskId: "task-1",
      fileName: `${id}.mp4`,
      kind: "mp4",
      contentType: "video/mp4",
    });
    // The single-play GIF made when no MP4 could be.
    expect(cardMediaUrl(id, "gif")).toBe(`app-frame://media/${id}.gif`);
    expect(parseCardMediaFileName(`${id}.gif`)).toEqual({
      taskId: "task-1",
      fileName: `${id}.gif`,
      kind: "gif",
      contentType: "image/gif",
    });
    expect(parseCardMediaFileName(`${id}.png`)).toBeUndefined();
    expect(parseCardPictureFileName(`${id}.gif`)).toBeUndefined();
    expect(parseCardPictureFileName(`${id}.mp4`)).toBeUndefined();
  });

  it("reads the recordings a body plays, as the host wrote them, and nothing else", () => {
    const own = cardMediaUrl(id, "mp4");
    const body = `<figure data-fm-demo="${own}"><img src="a.png"></figure><figure data-fm-demo="https://example.com/a.mp4"></figure><p>data-fm-demo="${cardMediaUrl(`${id}x`, "mp4")}"</p>`;
    expect([...demoSources(body)]).toEqual([own]);
  });

  it("plays only the host's own copies, as the kind they were minted", () => {
    expect(isPlayableDemoSource(cardMediaUrl(id, "mp4"))).toBe(true);
    expect(playableDemoKind(cardMediaUrl(id, "mp4"))).toBe("mp4");
    expect(playableDemoKind(cardMediaUrl(id, "gif"))).toBe("gif");
    expect(playableDemoKind(`app-frame://images/${id}.gif`)).toBeUndefined();
    for (const src of [
      `app-frame://images/${id}.mp4`,
      `app-frame://media/${id}.webm`,
      "app-frame://media/../../etc/passwd",
      `${cardMediaUrl(id, "mp4")}?t=1`,
      "https://example.com/a.mp4",
      "data:video/mp4;base64,AAAA",
      "data:image/gif;base64,R0lGODlh",
      `${cardMediaUrl(id, "gif")}?play=1`,
      "blob:app-frame://card/1",
      "file:///tmp/a.mp4",
    ]) {
      expect(isPlayableDemoSource(src), src).toBe(false);
    }
  });
});
