import { describe, expect, it } from "vitest";
import { pngImage } from "../../../tests/helpers/images";
import { refuseUnreadablePictures } from "./session";

describe("a model that cannot read pictures", () => {
  it("refuses them by name instead of dropping the bytes", () => {
    expect(() =>
      refuseUnreadablePictures({ name: "Text Only 1", input: ["text"] }, [pngImage]),
    ).toThrow(/Text Only 1 cannot read pictures/);
  });

  it("lets a picture model, an unknown model and a message without pictures through", () => {
    expect(() => refuseUnreadablePictures({ input: ["text", "image"] }, [pngImage])).not.toThrow();
    expect(() => refuseUnreadablePictures({ name: "Unknown" }, [pngImage])).not.toThrow();
    expect(() => refuseUnreadablePictures(undefined, [pngImage])).not.toThrow();
    expect(() => refuseUnreadablePictures({ input: ["text"] }, undefined)).not.toThrow();
  });
});
