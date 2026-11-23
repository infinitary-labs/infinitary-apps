// park-pointer.ts - moves the pointer to one pixel of the X screen DISPLAY
// names and stops unless it stays there (docs/testing.md, "The Linux source
// desktop").
//
// usage: node scripts/park-pointer.ts <x> <y>
//
// It calls the X library through koffi, the project's own way into a system
// library. Electron loads that library itself, so every machine that runs
// the journeys already holds it, and their virtual screen needs nothing
// beyond Xvfb, which GitHub's hosted Ubuntu images hold: preparing it
// downloads nothing from Ubuntu's mirrors (docs/testing.md, "The runner's
// automatic updates").

import { fileURLToPath } from "node:url";
import koffi from "koffi";

/** One connection to the screen, and the X library calls the park makes on it. */
export type PointerScreen = {
  /** Moves the pointer to x, y of the screen's root window, once the server has done so. */
  warp(x: number, y: number): void;
  /** Where the pointer is on the screen's root window. */
  where(): { x: number; y: number };
  close(): void;
};

/**
 * Moves the pointer to x, y on one connection and reads it back on another,
 * opened after the first has closed, as the app's windows connect later.
 * Answers the line that says so, or throws when the pointer is anywhere else:
 * on a point off the screen, which X moves to the screen's nearest edge, or
 * on an Xvfb without -noreset, which resets as its last client leaves and
 * puts the pointer back at the centre.
 */
export function parkPointer(connect: () => PointerScreen, x: number, y: number): string {
  const mover = connect();
  try {
    mover.warp(x, y);
  } finally {
    mover.close();
  }
  const reader = connect();
  let at: { x: number; y: number };
  try {
    at = reader.where();
  } finally {
    reader.close();
  }
  if (at.x !== x || at.y !== y)
    throw new Error(`The pointer is not on the pixel at ${x},${y}: it is at ${at.x},${at.y}`);
  return `park-pointer: the pointer stays on the pixel at ${x},${y}`;
}

/** Connections to the screen DISPLAY names, through the X library Electron loads. */
export function xScreen(): () => PointerScreen {
  const x11 = koffi.load("libX11.so.6");
  const openDisplay = x11.func("void *XOpenDisplay(const char *name)");
  const rootWindow = x11.func("unsigned long XDefaultRootWindow(void *display)");
  const warpPointer = x11.func(
    "int XWarpPointer(void *display, unsigned long from, unsigned long to, int fromX, int fromY, unsigned int fromWidth, unsigned int fromHeight, int x, int y)",
  );
  const sync = x11.func("int XSync(void *display, int discard)");
  const queryPointer = x11.func(
    "int XQueryPointer(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *windowX, _Out_ int *windowY, _Out_ unsigned int *buttons)",
  );
  const closeDisplay = x11.func("int XCloseDisplay(void *display)");
  return () => {
    const display = openDisplay(null);
    if (!display) throw new Error(`No X screen answers at DISPLAY=${process.env.DISPLAY ?? ""}`);
    const root = rootWindow(display);
    return {
      warp(x, y) {
        // From no window in particular, so X moves the pointer wherever it is.
        warpPointer(display, 0, root, 0, 0, 0, 0, x, y);
        sync(display, 0);
      },
      where() {
        const rootX = [0];
        const rootY = [0];
        if (!queryPointer(display, root, [0], [0], rootX, rootY, [0], [0], [0]))
          throw new Error("The pointer is on another screen than the root window's");
        return { x: Number(rootX[0]), y: Number(rootY[0]) };
      },
      close() {
        closeDisplay(display);
      },
    };
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [x, y] = args.map(Number);
  if (args.length !== 2 || !Number.isInteger(x) || !Number.isInteger(y)) {
    console.error("usage: node scripts/park-pointer.ts <x> <y>");
    process.exit(2);
  }
  try {
    console.log(parkPointer(xScreen(), x as number, y as number));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
