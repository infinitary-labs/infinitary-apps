import { describe, expect, it } from "vitest";
import { releaseSelects } from "./copyOnSelect";

// The captain's ask for Copy on select (INA-32's plan): a release copies when
// words were selected by a drag or a double or triple click, and never for a
// bare click or a drag that left the earlier selection as it was.
describe("a pointer release", () => {
  const press = { x: 100, y: 40, clicks: 1, before: "" };

  it("copies the words a drag selected", () => {
    expect(releaseSelects(press, { x: 260, y: 42 }, "Frame words inside the card body")).toBe(true);
  });

  it("copies the word a double-click selected, with no movement", () => {
    expect(releaseSelects({ ...press, clicks: 2 }, { x: 100, y: 40 }, "INA-32")).toBe(true);
  });

  it("copies the paragraph a triple-click selected", () => {
    expect(releaseSelects({ ...press, clicks: 3 }, { x: 101, y: 40 }, "A whole paragraph.")).toBe(
      true,
    );
  });

  it("leaves a click with nothing selected alone", () => {
    expect(releaseSelects(press, { x: 100, y: 40 }, "")).toBe(false);
  });

  it("leaves a click that moved a pixel or two alone", () => {
    expect(releaseSelects({ ...press, before: "kept" }, { x: 102, y: 41 }, "kept")).toBe(false);
  });

  it("leaves a drag that moved a panel while earlier words stay selected", () => {
    expect(
      releaseSelects({ ...press, before: "earlier words" }, { x: 300, y: 90 }, "earlier words"),
    ).toBe(false);
  });

  it("leaves a double-click on blank space alone, where only a line break is selected", () => {
    expect(releaseSelects({ ...press, clicks: 2 }, { x: 100, y: 40 }, "\n")).toBe(false);
  });

  it("leaves a double-click on a picture alone, with no words selected", () => {
    expect(releaseSelects({ ...press, clicks: 2 }, { x: 100, y: 40 }, "")).toBe(false);
  });
});
