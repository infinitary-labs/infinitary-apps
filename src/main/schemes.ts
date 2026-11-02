import { protocol } from "electron";
import { frameScheme } from "./frames/frameScheme";
import { voiceModelScheme } from "./voice/voiceProtocol";

/**
 * Every privileged scheme the shell serves, registered in the one call
 * Electron allows (`registerSchemesAsPrivileged` may run once, before
 * `app.ready`). Each scheme owns its privileges; its protocol module owns
 * the handler. This is only the gathering point. The work mode never loads
 * this module; it registers the frame scheme alone when its own module loads
 * (`./work.ts`).
 *
 * - `app-model:` lets the renderer's Whisper worker fetch the on-disk voice
 *   model on an Intel Mac, where the voice helper cannot run
 *   (docs/architecture.md section 8).
 * - `app-frame:` serves plugin frame documents and the design system's
 *   fonts to those frames (docs/ui-plugins.md, phase 1).
 */
export const PRIVILEGED_SCHEMES = [voiceModelScheme, frameScheme] as const;

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);
}
