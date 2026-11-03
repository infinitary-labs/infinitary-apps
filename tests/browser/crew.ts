import { expect } from "vitest";

/**
 * The first mate and the crew on the stage as a browser test reads them
 * (docs/crew-orbits.md): the character's canvas and the near crew layer.
 */

/** The near crew layer's canvas, which carries the crew's placement and pace. */
export function nearCrew(): HTMLCanvasElement {
  const near = document.querySelector<HTMLCanvasElement>('canvas[data-crew-layer="near"]');
  if (!near) throw new Error("The stage drew no near crew layer");
  return near;
}

/** How many crew ride each orbit, once the crew's placement is painted. */
export async function crewPlaneCounts(): Promise<number[]> {
  await expect
    .poll(
      () =>
        document.querySelector('canvas[data-crew-layer="near"]')?.getAttribute("data-plane-counts"),
      {
        message: "Crew placement is not painted yet",
      },
    )
    .toMatch(/\S/);
  return (nearCrew().getAttribute("data-plane-counts") ?? "").split(",").map(Number);
}

/** The first mate's character canvases, hidden ones included. */
export const characters = () => [
  ...document.querySelectorAll<HTMLCanvasElement>('canvas[aria-label^="First mate - "]'),
];

/**
 * Returns once the first mate is idle on a character that has drawn: the
 * canvas mounts reading idle before its first frame starts the opening
 * greet, so a label on a character that has drawn nothing is not an idle.
 */
export async function firstmateIdle(timeout = 30_000): Promise<void> {
  await expect
    .poll(
      () =>
        characters().map((canvas) => {
          const blank = document.createElement("canvas");
          blank.width = canvas.width;
          blank.height = canvas.height;
          return canvas.toDataURL() === blank.toDataURL()
            ? "undrawn"
            : canvas.getAttribute("aria-label");
        }),
      { timeout, interval: 100 },
    )
    .toEqual(["First mate - idle"]);
}
