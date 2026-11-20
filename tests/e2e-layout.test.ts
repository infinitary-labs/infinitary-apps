import type { ElectronApplication, Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minimumWindowSize, resizeWindow } from "./e2e/layout";

afterEach(() => vi.unstubAllGlobals());

/** BrowserWindow's outer/content boundary, with the real helper's callbacks. */
function desktop(chrome: number, zoom: number) {
  let content: [number, number] = [1200, 900];
  const shown = {
    getSize: () => [content[0], content[1] + chrome],
    getContentSize: () => [...content],
    getMinimumSize: () => [960, 640],
    setContentSize: (width: number, height: number) => {
      content = [width, height];
    },
    webContents: { getZoomFactor: () => zoom },
  };
  vi.stubGlobal("window", {
    get innerWidth() {
      return Math.round(content[0] / zoom);
    },
    get innerHeight() {
      return Math.round(content[1] / zoom);
    },
  });
  const app = {
    browserWindow: async () => ({
      evaluate: async (read: (window: typeof shown, size: unknown) => unknown, size: unknown) =>
        read(shown, size),
    }),
    evaluate: async (read: (electron: unknown) => unknown) =>
      read({ BrowserWindow: { getAllWindows: () => [shown] } }),
  } as unknown as ElectronApplication;
  const page = {
    evaluate: async (read: () => unknown) => read(),
  } as unknown as Page;
  return { app, page, shown };
}

describe.each([0, 27])("content sizes with %i pixels of native chrome", (chrome) => {
  it.each([1, 1.25, 1.5])("resizes and restores content at zoom %s", async (zoom) => {
    const { app, page, shown } = desktop(chrome, zoom);
    const before = await resizeWindow(app, page, { width: 1280, height: 800 });
    expect(before).toEqual({ width: 1200, height: 900 });
    expect(shown.getContentSize()).toEqual([1280, 800]);
    expect(shown.getSize()).toEqual([1280, 800 + chrome]);
    await resizeWindow(app, page, before);
    expect(shown.getContentSize()).toEqual([1200, 900]);
  });

  it("translates the outer minimum to the same content-size contract", async () => {
    const { app, page, shown } = desktop(chrome, 1);
    const minimum = await minimumWindowSize(app);
    expect(minimum).toEqual({ width: 960, height: 640 - chrome });
    await resizeWindow(app, page, minimum);
    expect(shown.getSize()).toEqual(shown.getMinimumSize());
  });
});
