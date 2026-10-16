import { protocol } from "electron";
import { frameScheme } from "./frames/frameProtocol";
import { pluginScheme } from "./plugins/pluginProtocol";
import { voiceModelScheme } from "./voice/voiceProtocol";

/**
 * Every privileged scheme the shell serves, registered in the one call
 * Electron allows (`registerSchemesAsPrivileged` may run once, before
 * `app.ready`). Each protocol module owns its own privileges and handler;
 * this is only the gathering point.
 *
 * - `app-model:` lets the renderer's Whisper worker fetch the on-disk voice
 *   model on an Intel Mac, where the voice helper cannot run
 *   (docs/architecture.md section 8).
 * - `app-frame:` serves plugin frame documents and the design system's
 *   fonts to those frames (docs/ui-plugins.md, phase 1).
 * - `app-plugin:` serves compiled personal-extension modules and the host
 *   shims they import (talk-to-personalize Step 2).
 */
export const PRIVILEGED_SCHEMES = [voiceModelScheme, frameScheme, pluginScheme] as const;

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);
}
