import { APP_FRAME_SCHEME } from "../csp";
import { FRAME_BRIDGE_SHA256 } from "./bridge";

/**
 * The containment constants every plugin-facing frame shares (D6, "the
 * honest ledger"; docs/ui-plugins.md). Card bodies and template mounts
 * consume the same two definitions, so the boundary is one rather than one
 * per surface.
 *
 * `containment.test.ts` walks STRUCTURALLY_IMPOSSIBLE below and asserts each
 * entry against these constants and the manifest schema. Adding a token or
 * a CSP source here is a security-review event (docs/live-prototype-security.md);
 * the panel mount's two script sources (`panelFrameCsp`) were one, reviewed
 * there under "The frame realm".
 */

/** The only sandbox token a plugin frame ever gets. */
export const FRAME_SANDBOX_TOKENS = ["allow-scripts"] as const;
export const FRAME_SANDBOX = FRAME_SANDBOX_TOKENS.join(" ");

/**
 * The permissions policy every plugin frame gets, as its `allow` attribute:
 * no focus without the captain's own gesture (docs/ui-plugins.md, "Focus
 * and the frames"). A frame's script may move focus inside it while the
 * frame holds the window's focus, which the captain's click or key, or the
 * shell's own move, gives it. A `focus()`, `window.focus()`, dialog or form
 * check it runs while the captain types in the main message does nothing,
 * so the caret and the next keys stay there.
 */
export const FRAME_ALLOW = "focus-without-user-activation 'none'";

/**
 * The Blink feature that makes Chromium honour FRAME_ALLOW's policy, still
 * experimental in Electron 43: the main process turns it on for every
 * renderer before the app is ready (src/main/app.ts). Without it Chromium
 * ignores the policy and a frame's script takes focus whenever it likes.
 */
export const FRAME_FOCUS_BLINK_FEATURE = "BlockingFocusWithoutUserActivation";

/**
 * Tokens that would each break the containment model: same-origin access,
 * a way out of the frame, a way to a file, a way to submit or open. Kept as
 * a list so the test can name what it refuses.
 */
export const FORBIDDEN_SANDBOX_TOKENS = [
  "allow-same-origin",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
  "allow-modals",
  "allow-downloads",
  "allow-forms",
  "allow-presentation",
  "allow-pointer-lock",
  "allow-orientation-lock",
  "allow-storage-access-by-user-activation",
] as const;

/**
 * The one source a frame may load fonts from: the host's own frame scheme,
 * served in-process from the app bundle (src/main/frames/). It is not a
 * network path - nothing behind it leaves the machine - and it is what puts
 * the design system's typefaces inside every frame (the fonts-in-frames
 * papercut, proposal section 3.2). Its `typefaces` host serves the copy of
 * each project font the host checked and loaded for a preview
 * (docs/card-authoring.md "Fonts by reference"), by a name the core minted.
 */
export const FRAME_FONT_SOURCE = `${APP_FRAME_SCHEME}:`;

/**
 * The narrower font source of a card body on the srcdoc vehicle: the frame
 * scheme's `fonts` host alone, which serves the design system's typefaces. A project font is drawn only on the
 * mount vehicle, in a renderer process of its own (`cardBodyMounts`), so a
 * srcdoc body that names a kept font by an address the vehicle test did not
 * recognize loads nothing.
 */
export const SRCDOC_FONT_SOURCE = `${APP_FRAME_SCHEME}://fonts`;

/**
 * The two sources a frame may load an image from, neither of them a network
 * path: the document itself (a `data:` URI carries its bytes inline and names
 * no host - captain decision, 2026-09-15) and the host's own frame scheme,
 * whose `images` host serves the copy of each picture the host verified in a
 * crewmate's working copy (card pictures, phase 2; the fonts precedent). That
 * host answers only a name the core minted, so a body can name a verified
 * picture and nothing else on the machine.
 */
export const FRAME_IMAGE_SOURCE = `data: ${APP_FRAME_SCHEME}:`;

/**
 * The frame policy: nothing may load from anywhere except fonts and verified
 * pictures from the host's own scheme and images the document carries inline; inline styles
 * carry the design tokens; exactly the hash-pinned bridge executes, plus -
 * for a mount - each script the host hashed when it served the document.
 * Every other network-capable directive (connect, media, frame, worker) is
 * deliberately absent so it inherits `default-src 'none'`.
 */
export function frameCsp(
  scriptHashes: readonly string[] = [],
  fontSource: string = FRAME_FONT_SOURCE,
): string {
  const scripts = [FRAME_BRIDGE_SHA256, ...scriptHashes].map((hash) => `'${hash}'`).join(" ");
  return `default-src 'none'; style-src 'unsafe-inline'; font-src ${fontSource}; img-src ${FRAME_IMAGE_SOURCE}; script-src ${scripts}`;
}

/** The policy of a frame that runs no mount-specific script. */
export const FRAME_CSP = frameCsp();

/**
 * The policy of a card body on the srcdoc vehicle: the frame policy with
 * fonts from the design system's own `fonts` host alone (`SRCDOC_FONT_SOURCE`).
 */
export const SRCDOC_FRAME_CSP = frameCsp([], SRCDOC_FONT_SOURCE);

/**
 * The script sources a PANEL mount may load modules from (one plugin
 * vehicle, Phase A item 4; the frame realm): the app's own lib, and that
 * mount's own host, which serves exactly the compiled files the host read
 * and hashed when it mounted the panel. Both are paths of the host's own
 * frame scheme, served in-process; neither is a network path. This is the
 * ONE place a frame policy names a script source rather than a hash, and
 * only `panelFrameCsp` uses it - card bodies and template mounts keep
 * `frameCsp`, where every script runs by hash.
 */
export function panelScriptSources(mountHost: string): string[] {
  return [`${APP_FRAME_SCHEME}://lib/`, `${APP_FRAME_SCHEME}://${mountHost}/`];
}

/**
 * The policy of a panel drawn in the frame realm: the frame policy above -
 * `default-src 'none'`, no connect, media, frame or worker source - with
 * `script-src` admitting the bridge and the document's own inline import
 * map by hash, and module scripts from the two sources of
 * `panelScriptSources` alone. Module loads are also pinned by the import
 * map's `integrity`, so a source admitted here still runs only the bytes
 * the host hashed. No `'unsafe-eval'`: `eval` and `new Function` stay
 * refused inside a panel as everywhere else.
 */
export function panelFrameCsp(inlineHashes: readonly string[], mountHost: string): string {
  const scripts = [
    ...[FRAME_BRIDGE_SHA256, ...inlineHashes].map((hash) => `'${hash}'`),
    ...panelScriptSources(mountHost),
  ].join(" ");
  return `default-src 'none'; style-src 'unsafe-inline'; font-src ${FRAME_FONT_SOURCE}; img-src ${FRAME_IMAGE_SOURCE}; script-src ${scripts}`;
}

/**
 * CSP directives that would each open a network path if ever added with a
 * network source. `font-src` and `img-src` are on the list on purpose: the
 * test allows each ONLY with its own constant as its whole value - the host's
 * scheme for fonts (its `fonts` host alone on the srcdoc vehicle), `data:`
 * and the host's scheme for images - so any other source stays refused.
 */
export const NETWORK_CSP_DIRECTIVES = [
  "connect-src",
  "img-src",
  "font-src",
  "media-src",
  "frame-src",
  "worker-src",
  "child-src",
  "object-src",
  "prefetch-src",
  "manifest-src",
] as const;

/**
 * The ledger of things the plugin system makes impossible by construction
 * (proposal section 5.3), unchanged by the relaxed capability posture. The
 * test pins one assertion per entry.
 */
export const STRUCTURALLY_IMPOSSIBLE = [
  "plugin code in the renderer realm or the main process",
  "same-origin access from a plugin frame",
  "direct IPC from a plugin frame",
  "a plugin reading another plugin's data",
  "a plugin reading accounts or auth",
  "a plugin reaching an undeclared host",
  "a plugin holding or seeing a credential",
] as const;
