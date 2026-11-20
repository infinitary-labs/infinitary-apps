/// <reference types="vite/client" />
/// <reference types="electron-vite/node" />
import { basename } from "node:path";
import type { FrameFontFiles } from "./frameProtocol";

/**
 * The design system's typefaces, by file name, as absolute paths the frame
 * scheme serves (frameProtocol.ts). electron-vite's `?asset` import copies
 * each file into the main bundle and resolves to its on-disk path, so the
 * one vendored copy under the renderer's design assets serves both the app
 * document (through its stylesheet) and every frame (through the scheme) -
 * no second copy of the binaries. The frame stylesheet references these by
 * the same basenames (src/renderer/src/plugins/frames/frameStylesheet.ts);
 * a test pins the two lists to the directory.
 *
 * Build-time only, and a leaf: `?asset` needs electron-vite's plugin, so
 * nothing unit-tested imports this module.
 */
const assets = import.meta.glob("../../renderer/src/design/assets/fonts/*.woff2", {
  query: "?asset",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const frameFontFiles: FrameFontFiles = Object.fromEntries(
  Object.entries(assets).map(([source, path]) => [basename(source), path]),
);
