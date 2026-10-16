import { describe, expect, it } from "vitest";
import { buildCsp, PRODUCTION_CSP } from "./csp";
import { FRAME_BRIDGE_SHA256 } from "./plugins/bridge";

describe("renderer CSP", () => {
  it("matches the architecture section 4 baseline exactly", () => {
    // Five additions over the section 4 string: the frame bridge hash in
    // script-src (docs/live-prototype-security.md), the host's own frame
    // scheme in font-src and frame-src (docs/ui-plugins.md, phase 1) and in
    // img-src for verified card pictures (card pictures, phase 2), its media
    // host alone in media-src for verified demo recordings, and the
    // personal-extension scheme in script-src alone (talk-to-personalize
    // Step 2, decision Q7: a personal panel is a module the renderer imports).
    expect(PRODUCTION_CSP).toBe(
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' '${FRAME_BRIDGE_SHA256}' app-plugin:; style-src 'self' 'unsafe-inline'; img-src 'self' data: app-frame:; font-src 'self' app-frame:; connect-src 'self' app-model:; media-src 'self' app-frame://media; worker-src 'self' blob:; frame-src 'self' app-frame:`,
    );
  });

  it("returns the production policy when no dev options are given", () => {
    expect(buildCsp()).toBe(PRODUCTION_CSP);
  });
});
