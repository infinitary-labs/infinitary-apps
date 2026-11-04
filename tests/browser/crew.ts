import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import {
  CROWDED_PLANES,
  planeRadius,
  projectPlane,
} from "../../src/renderer/src/character/crew/orbitalPlanes";

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

/** The summary beside the crewmate being read; DOM, never canvas text. */
export const crewSummary = () => document.querySelector<HTMLElement>("[data-crew-summary]");

/** The task id of the crewmate the pointer (or the keyboard) is on, or null. */
const crewInspecting = () =>
  document.querySelector("[data-crew-formation]")?.getAttribute("data-crew-inspecting") ?? null;

/** After the paint that follows the last input. */
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * The task ids the visible orbit has placed on each plane: crewmates that
 * have arrived and orbit there, not ones still flying out to it.
 */
const crewOnPlanes = () =>
  (nearCrew().getAttribute("data-plane-crew") ?? "")
    .split("|")
    .map((plane) => plane.split(" ").filter(Boolean));

/**
 * Point at a crewmate on its orbit the way a person does, as the journeys'
 * `pointAtCrewmate` does (tests/e2e/crew.ts): once the planes have opened out
 * to the orbits the crew settle on, sweep the pointer along each occupied
 * orbit until it lands on a crewmate. Returns the task id the pointer is on
 * and where it was left resting. A part of a task with parts, drawn at its
 * own node off every orbit, is not looked for.
 */
export async function pointAtCrewmate(): Promise<{ id: string; x: number; y: number }> {
  let placed: string[][] = [];
  await expect
    .poll(
      () => {
        if (nearCrew().getAttribute("data-plane-blend") !== "1") return false;
        placed = crewOnPlanes();
        return placed.flat().length > 0;
      },
      { message: "No crewmate is placed on a settled orbit", timeout: 30_000 },
    )
    .toBe(true);
  const formation = document.querySelector<HTMLElement>("[data-crew-formation]");
  if (!formation) throw new Error("The stage drew no crew formation");
  const { left, top, width, height } = formation.getBoundingClientRect();
  const centre = { x: left + width / 2, y: top + height / 2 };
  const scale = width / formation.offsetWidth;
  const counts = await crewPlaneCounts();
  for (let plane = 0; plane < CROWDED_PLANES.length; plane++) {
    if (!placed[plane]?.length) continue;
    for (let degrees = 0; degrees < 360; degrees += 2) {
      // The growing ring's orbit sits at the radius its crew give it.
      const at = projectPlane(plane, (degrees * Math.PI) / 180, planeRadius(plane, counts));
      const point = { x: centre.x + at.x * scale, y: centre.y + at.y * scale };
      await userEvent.hover(document.documentElement, { position: point, force: true });
      await nextFrame();
      const id = crewInspecting();
      if (id) return { id, ...point };
    }
  }
  throw new Error("No crewmate was found under the pointer");
}
