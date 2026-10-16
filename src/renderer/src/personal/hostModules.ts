import { OLDER_PERSONAL_HOST_GLOBAL, PERSONAL_HOST_GLOBAL } from "@shared/personal/manifest";
import * as React from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import * as ui from "../design";

/**
 * The host modules a personal panel may import (talk-to-personalize Step
 * 2; baby-menu's widget host shim). The app publishes its OWN React, JSX
 * runtimes, and design library on one global before any panel loads; the
 * shell serves each as a one-line shim (`app-plugin://host/<key>.mjs`,
 * `export default globalThis.__infinitaryHost.<key>`), and the compiler
 * rewrote every admitted host import to destructure from that shim. One
 * React instance means hooks work; one design library means a personal
 * panel is built from exactly the parts the app is built from.
 *
 * This is the whole `@infinitary/ui` boundary: `ui` is `src/renderer/src/
 * design/index.ts` as a namespace, so Step 3 adds a component by exporting
 * it there and nothing else moves. `hostModules.test.ts` pins that every
 * design export reaches the global.
 */
export type HostModules = {
  react: typeof React;
  jsxRuntime: typeof jsxRuntime;
  jsxDevRuntime: typeof jsxDevRuntime;
  ui: typeof ui;
};

export const hostModules: HostModules = { react: React, jsxRuntime, jsxDevRuntime, ui };

export function installHostModules(target: object = globalThis): void {
  // Vite's dev HMR can re-run the entry; each global is defined once. The
  // older name is the same modules, for a shim served before the rename.
  for (const name of [PERSONAL_HOST_GLOBAL, OLDER_PERSONAL_HOST_GLOBAL]) {
    if (Object.hasOwn(target, name)) continue;
    Object.defineProperty(target, name, {
      value: hostModules,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}
