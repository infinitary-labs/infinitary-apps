import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { inject } from "vitest";
import { page } from "vitest/browser";
import { CROWDED_PLANES } from "../../src/renderer/src/character/crew/orbitalPlanes";
import type { StoryPush } from "../helpers/browserProvided";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openWindow } from "./window";

/**
 * The crew in orbit around the first mate (src/renderer/src/character/crew/),
 * read off the real far and near canvases, so a test exercises the real
 * wiring, loop and painter (FI3-743). The window boots on a fresh home and
 * then hears the very pushes the core sent as one crewmate went out and was
 * cancelled (`CrewStory`, tests/helpers/browserFreshHome.ts), and reads each
 * board the core read on the way. A test file draws one window, so each case
 * is a file of its own, as each was a fresh app.
 */

export type Paint = {
  /** Pixels carrying visible ink across both layers. */
  count: number;
  /** Summed channels over those pixels. */
  r: number;
  g: number;
  b: number;
  /** Centroid of the ink, canvas px. */
  x: number;
  y: number;
  digest: string;
};

function layers(): HTMLCanvasElement[] {
  return ["far", "near"].map((layer) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-crew-layer="${layer}"]`);
    if (!canvas) throw new Error(`crew ${layer} layer missing`);
    return canvas;
  });
}

export function paint(): Paint {
  const out = { count: 0, r: 0, g: 0, b: 0, x: 0, y: 0, digest: "" };
  for (const canvas of layers()) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("a crew layer has no 2d context");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 40) continue;
      const p = i / 4;
      out.count += 1;
      out.r += data[i] ?? 0;
      out.g += data[i + 1] ?? 0;
      out.b += data[i + 2] ?? 0;
      out.x += p % width;
      out.y += Math.floor(p / width);
    }
    out.digest += canvas.toDataURL("image/png");
  }
  if (out.count > 0) {
    out.x /= out.count;
    out.y /= out.count;
  }
  return out;
}

/**
 * Crewmates on the ring as the orbit placed them, every plane together:
 * its typed placement, not a reconstruction from painted pixels. The orbit's
 * first frame writes it, so this is undefined until then.
 */
export function ringSize(): number | undefined {
  const counts = document
    .querySelector('canvas[data-crew-layer="near"]')
    ?.getAttribute("data-plane-counts");
  if (!counts?.trim()) return undefined;
  const values = counts.split(",").map(Number);
  if (values.length !== CROWDED_PLANES.length || values.some(Number.isNaN))
    throw new Error(`Crew placement is incomplete: ${counts}`);
  return values.reduce((sum, count) => sum + count, 0);
}

/** How far each crew canvas is from one backing pixel per device pixel: 0 is sharp. */
export function ringBlur(): number[] {
  return layers().map((canvas) => canvas.width - Math.round(canvas.offsetWidth * devicePixelRatio));
}

function replay(bridge: FakeBridge, push: StoryPush): void {
  switch (push.channel) {
    case "inf:event":
      bridge.push(push.channel, push.payload);
      break;
    case "inf:tasks":
      bridge.push(push.channel, push.payload);
      break;
    case "inf:tasks:delta":
      bridge.push(push.channel, push.payload);
      break;
  }
}

export type CrewWindow = {
  /** The crewmate goes out and goes idle, as the core told the window. */
  arrive(): void;
  cancel(): void;
};

/**
 * Opens the window on a fresh home whose person connected a subscription,
 * as a launched app with a model is, with no crew yet.
 */
export async function openCrewWindow(): Promise<CrewWindow> {
  const story = inject("crewStory");
  const home = freshHome();
  const firstRun = home["inf:app:first-run"];
  if (!firstRun || typeof firstRun === "function")
    throw new Error("A fresh home answers its first run");
  let board = story.fresh;
  const bridge = fakeBridge({
    ...home,
    "inf:app:first-run": { ...firstRun, gateOpen: false },
    "inf:tasks:board": () => board,
  });
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await openWindow(bridge);
  const play = (pushes: StoryPush[], after: typeof board) => {
    board = after;
    for (const push of pushes) replay(bridge, push);
  };
  return {
    arrive: () => play(story.arrive, story.crewed),
    cancel: () => play(story.cancel, story.dropped),
  };
}
