import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_MEDIA_PIECE_BYTES } from "@shared/cardPictures";
import { describe, expect, it } from "vitest";
import { type PictureRead, pictureFile } from "./pictureSave";

const root = join(import.meta.dirname, "../../..");
const PNG = readFileSync(join(root, "tests/e2e/fixtures/contribution-picture.png"));
const MP4 = readFileSync(join(root, "tests/fixtures/demo/moving-box.mp4"));

/** The home's media read (`inf:cards:media`): a piece of the kept recording from an offset. */
function mediaHome(file: Buffer, pieceBytes: number): PictureRead {
  return (async (_channel: string, args: unknown[]) => {
    const [, offset] = args as [string, number];
    return {
      contentType: "video/mp4",
      size: file.length,
      data: file.subarray(offset, offset + pieceBytes).toString("base64"),
    };
  }) as PictureRead;
}

// INF-6347's approved plan: Save to Downloads keeps the picture's or the recording's own file.
describe("pictureFile", () => {
  it("keeps a recording whole, read a piece at a time", async () => {
    const pieceBytes = Math.ceil(MP4.length / 3);
    expect(pieceBytes).toBeLessThanOrEqual(CARD_MEDIA_PIECE_BYTES);
    const file = await pictureFile({ demo: "task-1-abc.mp4" }, mediaHome(MP4, pieceBytes));
    expect(file.extension).toBe("mp4");
    expect(file.data.equals(MP4)).toBe(true);
  });

  it("saves a PNG the window drew, and refuses anything else it sends", async () => {
    const never = (() => Promise.reject(new Error("read"))) as PictureRead;
    const drawn = await pictureFile({ png: PNG.toString("base64") }, never);
    expect(drawn).toEqual({ data: PNG, extension: "png" });
    await expect(pictureFile({ png: MP4.toString("base64") }, never)).rejects.toThrow(
      "That is not a PNG picture.",
    );
  });
});
