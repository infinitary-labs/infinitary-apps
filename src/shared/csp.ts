import { FRAME_BRIDGE_SHA256 } from "./plugins/frameScript";

/**
 * The renderer Content-Security-Policy, per docs/architecture.md section 4.
 * One source of truth used by the main process (response headers) and the
 * build-time meta fallback injected into index.html.
 *
 * The wasm / worker / app-model allowances exist solely for the voice
 * stack. `app-frame:` is the host's own frame scheme (src/main/frames/):
 * frame-src admits the template documents it serves, font-src admits
 * the design system's typefaces it serves to every frame and the project
 * fonts a preview names, and img-src admits the verified card pictures it
 * serves (card pictures, phase 2). Card-body
 * srcdoc documents inherit this policy - the script hash permits exactly
 * the app's own frame bridge inside those frames and nothing else (see
 * docs/live-prototype-security.md).
 */
export const APP_MODEL_SCHEME = "app-model";

/**
 * The privileged scheme the host serves plugin frames over: template
 * documents at `app-frame://mount/<id>`, font files at
 * `app-frame://fonts/<file>` and a preview's kept project fonts at
 * `app-frame://typefaces/<name>`. A frame document loaded from here gets its
 * own CSP from the response rather than inheriting the app's, which is
 * what lets a mount's template script run by hash (docs/ui-plugins.md).
 */
export const APP_FRAME_SCHEME = "app-frame";

export const PRODUCTION_CSP =
  "default-src 'none'; " +
  `script-src 'self' 'wasm-unsafe-eval' '${FRAME_BRIDGE_SHA256}'; ` +
  "style-src 'self' 'unsafe-inline'; " +
  `img-src 'self' data: ${APP_FRAME_SCHEME}:; ` +
  `font-src 'self' ${APP_FRAME_SCHEME}:; ` +
  `connect-src 'self' ${APP_MODEL_SCHEME}:; ` +
  // The picture viewer's player plays a card's verified demo recordings
  // from the frame scheme's media host (`CARD_MEDIA_HOST`, ./cardPictures,
  // written out because that module imports this one) and nothing else.
  `media-src 'self' ${APP_FRAME_SCHEME}://media; ` +
  "worker-src 'self' blob:; " +
  `frame-src 'self' ${APP_FRAME_SCHEME}:`;

/**
 * Dev builds load from the Vite dev server: react fast-refresh injects an
 * inline preamble script and HMR needs the websocket, so those two
 * allowances are added in dev only. The script hash is dropped there - a
 * hash's presence makes browsers ignore 'unsafe-inline', which would break
 * the preamble; 'unsafe-inline' covers the frame bridge in dev anyway.
 * The packaged app never sees this policy.
 */
export function buildCsp(dev?: { devServerOrigin: string }): string {
  if (!dev) return PRODUCTION_CSP;
  const wsOrigin = dev.devServerOrigin.replace(/^http/, "ws");
  return PRODUCTION_CSP.replace(
    `script-src 'self' 'wasm-unsafe-eval' '${FRAME_BRIDGE_SHA256}'`,
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  ).replace(
    `connect-src 'self' ${APP_MODEL_SCHEME}:`,
    `connect-src 'self' ${APP_MODEL_SCHEME}: ${dev.devServerOrigin} ${wsOrigin}`,
  );
}
