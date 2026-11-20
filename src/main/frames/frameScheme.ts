import { APP_FRAME_SCHEME } from "@shared/csp";
import { type CustomScheme, protocol } from "electron";

/**
 * The frame scheme's privileges (`app-frame:`). `standard` gives normal URL
 * parsing, `secure` makes the origin trustworthy, `corsEnabled` is for the
 * fonts (the design system's and a preview's project fonts), and `stream`
 * lets a `<video>` play a recording while it loads and
 * seek by range. No `supportFetchAPI`: a frame never fetches from here; the
 * browser's own document, font and media loaders are the only clients.
 *
 * Electron takes every privileged scheme in one call, before `app.ready`
 * (`protocol.registerSchemesAsPrivileged` may run once per process). The
 * window registers this with the shell's other schemes (`../schemes.ts`).
 * The work mode registers this alone when its module loads (`../work.ts`):
 * that is the scheme its media probe plays a demo from and loads a project
 * font from, and the work mode
 * never loads the shell's other protocols. A process calls it once.
 */
export const frameScheme: CustomScheme = {
  scheme: APP_FRAME_SCHEME,
  privileges: { standard: true, secure: true, corsEnabled: true, stream: true },
};

/** The work mode's one registration, before `app.ready`. */
export function registerFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([frameScheme]);
}
