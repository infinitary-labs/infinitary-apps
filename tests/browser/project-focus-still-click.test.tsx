import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBox } from "./prompt";
import { openSize, openWindow } from "./window";

// INF-1292, from the project-focus journey: the row opens under the pointer
// that pressed the pill, and the pill it lands on lit its project with no
// movement, dimming the rest.

const PROJECTS = [
  { repoId: "repo-inf", name: "infinitary", key: "INF" },
  { repoId: "repo-web", name: "website", key: "WEB" },
  { repoId: "repo-lab", name: "quota-lab", key: "LAB" },
];

/** Four finished crewmates across three projects, each kept on the stage. */
const WORK = [
  { id: "inf-1", title: "Fix the Linux window buttons", repoId: "repo-inf" },
  { id: "inf-2", title: "Add the retry probe", repoId: "repo-inf" },
  { id: "web-1", title: "Refresh the pricing page", repoId: "repo-web" },
  { id: "lab-1", title: "Read the quota ledger again", repoId: "repo-lab" },
];

/** The tasks that wait on the captain: one in infinitary, one in quota-lab. */
const WAITS_ON = ["inf-1", "lab-1"];

/** How lit a crewmate's model name is on the stage: its anchor's opacity, or null before it draws. */
function crewLight(taskId: string): number | null {
  const anchor = document.querySelector<HTMLElement>(`[data-crew-model-anchor="${taskId}"]`);
  return anchor ? Number(anchor.style.opacity || "1") : null;
}

function part(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`The window drew no ${selector}`);
  return page.elementLocator(element);
}

const option = (key: string) => part(`[data-project-focus-option="${key}"]`);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

test("a still click opens the row without dimming any crew, and moving onto a pill lights its project", async () => {
  const home = subscribed(await seededHome({ projects: PROJECTS, work: WORK, waitsOn: WAITS_ON }));
  const bridge = fakeBridge(home);
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => messageBox()?.disabled).toBe(false);
  const board = home["inf:tasks:board"];
  if (!board || typeof board === "function") throw new Error("The seeded home read no board");
  // The crew's work, and a task for each step that waits on the captain.
  expect(board.tasks).toHaveLength(WORK.length + WAITS_ON.length);
  bridge.push("inf:tasks", board);
  for (const work of WORK) await expect.poll(() => crewLight(work.id)).toBeGreaterThan(0.6);
  const entered: string[] = [];
  const noteEntered = (event: PointerEvent) => {
    const pill = (event.target as Element).closest("[data-project-focus-option]");
    if (pill) entered.push(pill.getAttribute("data-project-focus-option") ?? "");
  };
  window.addEventListener("pointerover", noteEntered, true);
  try {
    // Section: a click with the pointer held still opens the row and every crewmate stays lit.
    await userEvent.click(part("[data-project-focus-pill]"));
    await expect.poll(() => document.querySelector("[data-project-focus-row]")).not.toBeNull();
    await expect.element(part("[data-project-focus-row]")).toBeVisible();
    // The row's pills glide out under the still pointer, and the browser
    // reports a project's pill entered, as the reporter's did.
    await expect.poll(() => entered.some((key) => key !== "all")).toBe(true);
    // The stage drew frames enough for the light's ease after that pill was
    // entered, and no crewmate dimmed.
    for (let left = 30; left > 0; left--) await nextFrame();
    for (const work of WORK) expect(crewLight(work.id)).toBeGreaterThan(0.6);

    // Section: moving onto a project's pill lights it, and onto All projects lights everyone.
    await userEvent.hover(option("LAB"));
    await expect.poll(() => crewLight("inf-1")).toBeLessThan(0.4);
    await expect.poll(() => crewLight("lab-1")).toBeGreaterThan(0.6);
    await userEvent.hover(option("all"));
    for (const work of WORK) await expect.poll(() => crewLight(work.id)).toBeGreaterThan(0.6);
  } finally {
    window.removeEventListener("pointerover", noteEntered, true);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
