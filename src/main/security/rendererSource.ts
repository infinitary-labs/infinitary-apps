import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type RendererSourceOptions = {
  /** The Vite dev server URL, when running under electron-vite dev. */
  devServerUrl?: string;
  /** Absolute path of the bundled renderer html in packaged/preview builds. */
  bundledRendererFile: string;
};

/**
 * True when `value` is our own renderer document: the dev server origin in
 * dev, or the exact bundled file URL in packaged builds. Every permission
 * grant and IPC sender check routes through this.
 */
export function isAppRendererSource(
  value: string | undefined,
  options: RendererSourceOptions,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (options.devServerUrl && url.origin === new URL(options.devServerUrl).origin) {
      return true;
    }
    return url.protocol === "file:" && url.href === pathToFileURL(options.bundledRendererFile).href;
  } catch {
    return false;
  }
}

export function defaultRendererSourceOptions(mainDirname: string): RendererSourceOptions {
  return {
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    bundledRendererFile: join(mainDirname, "../renderer/index.html"),
  };
}
