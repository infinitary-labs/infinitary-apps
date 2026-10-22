import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { CROWDED_PLANES, projectPlane } from "../../src/renderer/src/character/crew/orbitalPlanes";

/** Model text is a DOM layer following the actual orbit, not canvas text. */
export function crewModelNames(page: Page) {
  return page.locator("[data-crew-model-name]").filter({ visible: true });
}

export function crewModelName(page: Page, taskId: string) {
  return page.locator(`[data-crew-model-name="${taskId}"]`).filter({ visible: true });
}

export async function crewModelNameLayout(page: Page) {
  // Read after the paint that follows a resize/reduced-motion change.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return crewModelNames(page).evaluateAll((elements) =>
    elements.map((element) => {
      const anchor = element.parentElement;
      const canvas = element
        .closest("[data-crew-formation]")
        ?.querySelector('[data-crew-layer="near"]');
      if (!anchor || !canvas) throw new Error("Crew name placement is missing");
      const box = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        id: element.getAttribute("data-crew-model-name"),
        name: element.textContent ?? "",
        aria: element.getAttribute("aria-label"),
        box: box(element),
        anchor: box(anchor),
        canvas: box(canvas),
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        labelTypeSize: Number.parseFloat(getComputedStyle(element).getPropertyValue("--text-xs")),
        truncated: element.scrollWidth > element.clientWidth,
      };
    }),
  );
}

/** The visible orbit's typed placement, not a reconstruction from painted pixels.
 * The orbit's first frame writes it, so a read right after launch waits for
 * that frame; a throw inside `expect.poll` would end the poll at once. */
export async function crewPlaneCounts(page: Page): Promise<[number, number, number]> {
  const near = page.locator('canvas[data-crew-layer="near"]');
  await expect(near, "Crew placement is not painted yet").toHaveAttribute(
    "data-plane-counts",
    /\S/,
  );
  const counts = await near.getAttribute("data-plane-counts");
  if (counts === null) throw new Error("Crew placement is not painted yet");
  const values = counts.split(",").map(Number);
  const [inner, middle, outer] = values;
  if (values.length !== 3 || inner === undefined || middle === undefined || outer === undefined)
    throw new Error("Crew placement is incomplete");
  return [inner, middle, outer];
}

/** Busy-state wait, not a visibility promise: cards hide the still-running frame. */
export async function waitForFirstmateIdle(page: Page, timeout = 30_000): Promise<void> {
  // The canvas mounts reading idle before its first frame starts the opening
  // greet, so a label on a character that has drawn nothing is not an idle.
  await expect
    .poll(
      () =>
        page
          .getByRole("img", { name: /^First mate - /, includeHidden: true })
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const canvas = node as HTMLCanvasElement;
              const blank = document.createElement("canvas");
              blank.width = canvas.width;
              blank.height = canvas.height;
              return canvas.toDataURL() === blank.toDataURL()
                ? "undrawn"
                : canvas.getAttribute("aria-label");
            }),
          ),
      { timeout, intervals: [100] },
    )
    .toEqual(["First mate - idle"]);
}

/** The summary beside the crewmate being read; DOM, never canvas text. */
export function crewSummary(page: Page) {
  return page.locator("[data-crew-summary]");
}

/** The task id of the crewmate the pointer (or the keyboard) is on, or null. */
export function crewInspecting(page: Page): Promise<string | null> {
  return page.locator("[data-crew-formation]").getAttribute("data-crew-inspecting");
}

/** After the paint that follows the last input. */
export function nextFrame(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The formation's centre on screen and how far it is fitted to the window. */
export function crewFormation(page: Page) {
  return page.locator("[data-crew-formation]").evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    return {
      x: left + width / 2,
      y: top + height / 2,
      scale: width / (el as HTMLElement).offsetWidth,
    };
  });
}

/** The task ids the visible orbit has placed on each plane: crewmates that
 * have arrived and orbit there, not ones still flying out to it. */
async function crewOnPlanes(page: Page): Promise<string[][]> {
  const placed = await page
    .locator('canvas[data-crew-layer="near"]')
    .getAttribute("data-plane-crew");
  return (placed ?? "").split("|").map((plane) => plane.split(" ").filter(Boolean));
}

/**
 * Whether the planes have settled in. A first crewmate's arrival starts them
 * opening out over a few seconds of stage time; until they have, the orbits
 * are smaller than the ones the sweep follows, and a part of a task with
 * parts has no seat at its node yet, so it is still listed on its plane.
 */
async function planesSettled(page: Page): Promise<boolean> {
  const blend = await page
    .locator('canvas[data-crew-layer="near"]')
    .getAttribute("data-plane-blend");
  return blend === "1";
}

/** The task ids a task with parts draws at its own node, off every orbit. */
async function crewAtNodes(page: Page): Promise<string[]> {
  const seated = await page
    .locator('canvas[data-crew-layer="near"]')
    .getAttribute("data-constellation-crew");
  return (seated ?? "").split(" ").filter(Boolean);
}

/**
 * Point at a crewmate the constellation seats at its node: its name is drawn
 * above it and is part of it, so the pointer goes to the name, and finds it
 * only while the stage shows names. The seat glides with its task's mark, so
 * the pointer follows the name until the crewmate is the one being read.
 */
async function pointAtSeatedCrewmate(
  page: Page,
  id: string,
): Promise<{ id: string; x: number; y: number }> {
  const name = crewModelName(page, id);
  let point = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        // Read where the name is now without waiting for it: a name still
        // folded up is hidden, and the next try reads it again.
        const [centre] = await name.evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x: x + width / 2, y: y + height / 2 };
          }),
        );
        if (!centre) return null;
        point = centre;
        await page.mouse.move(point.x, point.y);
        await nextFrame(page);
        return crewInspecting(page);
      },
      {
        message: `Crewmate ${id} at its constellation node is not under the pointer`,
        timeout: 15_000,
      },
    )
    .toBe(id);
  return { id, ...point };
}

/**
 * Point at a crewmate the way a person does: once the orbit has placed it
 * (`wanted`, when a task id is given, or any crewmate), sweep the pointer
 * along the occupied orbits until it lands on it. A start the record already
 * names can reach the orbit a moment later, so the sweep never begins on an
 * orbit that has nobody to find (INF-745). A part of a task with parts is
 * drawn at its own node instead, off every orbit, so the pointer goes to it
 * there (INF-870). Either is read only once the planes have settled in: a
 * part that has just started is listed on its plane until then, and glides
 * to its seat while a sweep that began early looks for it on the orbit
 * (INF-885). The helper moves no pointer while it waits, so the stage keeps
 * its full speed. Works at every crew size, labels or not, for a crewmate on
 * an orbit, and returns the task id the pointer is on and where the pointer
 * was left resting on it.
 */
export async function pointAtCrewmate(
  page: Page,
  wanted?: string,
): Promise<{ id: string; x: number; y: number }> {
  let placed: string[][] = [];
  let seated: string[] = [];
  await expect
    .poll(
      async () => {
        if (!(await planesSettled(page))) return false;
        placed = await crewOnPlanes(page);
        seated = await crewAtNodes(page);
        return [...placed.flat(), ...seated].some((id) => !wanted || id === wanted);
      },
      {
        message: `Crewmate${wanted ? ` ${wanted}` : ""} is not placed on the settled orbit or at its node`,
        timeout: 30_000,
      },
    )
    .toBe(true);
  // A seated crewmate is still listed on its plane, but never on its path.
  const orbiting = placed.map((plane) => plane.filter((id) => !seated.includes(id)));
  const atNode = wanted
    ? seated.find((id) => id === wanted)
    : orbiting.flat().length
      ? undefined
      : seated[0];
  if (atNode) return pointAtSeatedCrewmate(page, atNode);
  const { x, y, scale } = await crewFormation(page);
  for (let plane = 0; plane < CROWDED_PLANES.length; plane++) {
    if (!orbiting[plane]?.length) continue;
    for (let degrees = 0; degrees < 360; degrees += 2) {
      const at = projectPlane(plane, (degrees * Math.PI) / 180);
      const point = { x: x + at.x * scale, y: y + at.y * scale };
      await page.mouse.move(point.x, point.y);
      await nextFrame(page);
      const id = await crewInspecting(page);
      if (id && (!wanted || id === wanted)) return { id, ...point };
    }
  }
  throw new Error(`No crewmate${wanted ? ` ${wanted}` : ""} was found under the pointer`);
}
