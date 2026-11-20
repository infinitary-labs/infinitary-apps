import type { ShellPreferencesService } from "@core/preferences/shellPreferences";
import { ACTIONS } from "@shared/actions";
import type { CoreInvokeChannel } from "@shared/ipc";
import { UI_SIZES, type UiSize } from "@shared/preferences";
import type { BrowserWindow } from "electron";
import type { SizeCommandHandlers } from "./keyboard";

/**
 * Where the window's size, theme and keys come from: the core's preferences
 * on the Mac that holds Firstmate, this Mac's own look on one that controls
 * it (docs/view.md, docs/keyboard.md).
 */
export type PreferenceSource = Pick<
  ShellPreferencesService,
  "get" | "subscribe" | "keymap" | "setKeymap"
>;

/**
 * The window's one door for a choice (./shell.ts): this Mac's core as the
 * captain, or the view's own look. The Size picker writes through it too.
 */
export type SizeDoor = {
  preferences: Pick<PreferenceSource, "get">;
  dispatch: (channel: CoreInvokeChannel, args: unknown[]) => Promise<unknown>;
};

type SizeDirection = "in" | "out" | "reset";

/** The next of the choices, bounded at either end. */
function steppedSize(current: UiSize, direction: SizeDirection): UiSize {
  if (direction === "reset") return 100;
  const index = UI_SIZES.indexOf(current) + (direction === "in" ? 1 : -1);
  return UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, index))] ?? 100;
}

/**
 * The keys, the View menu and command search all make the `window-size`
 * catalog change the picker and Firstmate make, so each step leaves one
 * trail (src/shared/actions.ts). Steps run one at a time, each from the size
 * the one before it saved, so a held key still climbs.
 */
function sizeChanger(door: SizeDoor) {
  const line = ACTIONS["window-size"];
  let tail = Promise.resolve();
  return (direction: SizeDirection) => {
    tail = tail
      .then(async () => {
        const appearance = door.preferences.get().appearance;
        const current = appearance.size ?? 100;
        const size = steppedSize(current, direction);
        if (size === current || !line.change) return;
        await door.dispatch(
          line.change,
          line.toRequest({ size }, appearance, (path) => path),
        );
      })
      // A refused step (Infinitary still starting) changes nothing; the next one starts over.
      .catch(() => {});
  };
}

/** The size commands' handlers: the window's keys (./keyboard.ts), the View menu and command search. */
export function sizeCommands(door: SizeDoor): SizeCommandHandlers {
  const change = sizeChanger(door);
  return {
    "size.larger": () => change("in"),
    "size.smaller": () => change("out"),
    "size.reset": () => change("reset"),
  };
}

/** Apply before first paint and after navigation; all windows follow core writes. */
export function followWindowSize(win: BrowserWindow, preferences: PreferenceSource): void {
  const apply = () => {
    const factor = (preferences.get().appearance.size ?? 100) / 100;
    if (win.webContents.getZoomFactor() !== factor) win.webContents.setZoomFactor(factor);
  };
  apply();
  win.webContents.on("did-finish-load", apply);
  const unsubscribe = preferences.subscribe(apply);
  win.once("closed", unsubscribe);
}
