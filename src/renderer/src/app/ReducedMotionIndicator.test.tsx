import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REDUCED_MOTION_COPY, ReducedMotionPanel } from "./ReducedMotionIndicator";

/**
 * The reduced motion panel names what the Mac's setting changes here, and
 * where to change it. The words are the captain-approved copy (FI3-646).
 */
describe("ReducedMotionPanel", () => {
  const text = renderToStaticMarkup(<ReducedMotionPanel />)
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  it("says the Mac causes it and that Firstmate holds still", () => {
    expect(text).toContain(
      "Your computer is set to reduce motion, so your first mate holds still.",
    );
  });

  it("covers the Firstmate, the crew, the voice waveform and the interface", () => {
    expect(REDUCED_MOTION_COPY.points.map((p) => p.subject)).toEqual([
      "Your first mate",
      "Crewmates",
      "The voice waveform",
      "Cards, panels and Settings",
    ]);
    for (const point of REDUCED_MOTION_COPY.points) {
      expect(text).toContain(`${point.subject} ${point.text}`);
    }
  });

  it("points to where the setting lives", () => {
    expect(text).toContain("System Settings › Accessibility › Display › Reduce motion.");
  });
});
