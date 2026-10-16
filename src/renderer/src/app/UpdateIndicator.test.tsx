import type { UpdateStatus } from "@shared/update";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdatePanel } from "./UpdateIndicator";

/**
 * The update panel (docs/alpha.md "Update channels"): it names the channel,
 * the offered version and the version this Mac has, so an offer reads as
 * new or not at a glance, and the channel's upgrade command.
 */

const ALPHA_OFFER: UpdateStatus = {
  currentVersion: "0.1.26-alpha.14",
  channel: "alpha",
  latestVersion: "0.1.27-alpha.15",
  updateAvailable: true,
  releaseUrl:
    "https://github.com/kunchenguid/homebrew-tap/releases/tag/firstmate-3000-alpha-v0.1.27-alpha.15",
  upgradeCommand: "brew update && brew upgrade --cask firstmate-3000@alpha",
};

/** The panel's visible text per hook, with React's text separators removed. */
function render(status: UpdateStatus): string {
  return renderToStaticMarkup(<UpdatePanel status={status} onViewRelease={() => {}} />).replace(
    /<!-- -->/g,
    "",
  );
}

function hookText(markup: string, hook: string): string | undefined {
  return new RegExp(`<div ${hook}="[^"]*"[^>]*>([^<]*)</div>`).exec(markup)?.[1];
}

describe("UpdatePanel", () => {
  it("names the offered version and, beneath it, the version this Mac has", () => {
    const markup = render(ALPHA_OFFER);
    expect(markup).toContain('data-update-channel="alpha"');
    expect(markup).toContain("Alpha updates");
    expect(hookText(markup, "data-update-offered")).toBe("Version 0.1.27-alpha.15 is available");
    expect(hookText(markup, "data-update-installed")).toBe("You have 0.1.26-alpha.14");
    expect(markup.indexOf("data-update-offered")).toBeLessThan(
      markup.indexOf("data-update-installed"),
    );
    expect(markup).toContain(ALPHA_OFFER.upgradeCommand.replaceAll("&", "&amp;"));
  });

  it("keeps the two versions apart when only the alpha suffix differs", () => {
    // Stable 0.1.25 handed to alpha outranks every 0.1.25-alpha.N.
    const markup = render({
      ...ALPHA_OFFER,
      currentVersion: "0.1.25-alpha.42",
      latestVersion: "0.1.25",
    });
    expect(hookText(markup, "data-update-offered")).toBe("Version 0.1.25 is available");
    expect(hookText(markup, "data-update-installed")).toBe("You have 0.1.25-alpha.42");
  });
});
