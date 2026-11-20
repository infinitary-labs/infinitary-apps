import { describe, expect, it } from "vitest";
import { buildCsp, PRODUCTION_CSP } from "./csp";
import { FRAME_BRIDGE_SHA256 } from "./plugins/frameScript";

describe("renderer CSP", () => {
  it("matches the architecture section 4 baseline exactly", () => {
    // Four additions over the section 4 string: the frame bridge hash in
    // script-src (docs/live-prototype-security.md), the host's own frame
    // scheme in font-src and frame-src (docs/ui-plugins.md, phase 1) and in
    // img-src for verified card pictures (card pictures, phase 2), and its
    // media host alone in media-src for verified demo recordings. No panel
    // code is a script source of the window: every panel draws in a frame.
    expect(PRODUCTION_CSP).toBe(
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' '${FRAME_BRIDGE_SHA256}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: app-frame:; font-src 'self' app-frame:; connect-src 'self' app-model:; media-src 'self' app-frame://media; worker-src 'self' blob:; frame-src 'self' app-frame:`,
    );
  });

  it("returns the production policy when no dev options are given", () => {
    expect(buildCsp()).toBe(PRODUCTION_CSP);
  });
});
