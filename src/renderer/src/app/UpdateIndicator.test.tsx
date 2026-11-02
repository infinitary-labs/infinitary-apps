import type { UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_WORDS, UPDATE_WORK_WORDS } from "@shared/updateWords";
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

// INF-2245: while the update saves the crew's work, the panel says whose
// running work it waits for and offers Update later beside the pending install.
describe("UpdatePanel around the crew's work", () => {
  const INSTALLABLE: UpdateStatus = { ...ALPHA_OFFER, install: { asksPassword: false } };

  function renderInstall(status: UpdateStatus, extra: { later?: string } = {}): string {
    return renderToStaticMarkup(
      <UpdatePanel
        status={status}
        onViewRelease={() => {}}
        onInstall={() => {}}
        onLater={() => {}}
        {...(extra.later ? { later: extra.later } : {})}
      />,
    ).replace(/<!-- -->/g, "");
  }

  it("names each task whose running work it waits for, with Update later", () => {
    const markup = renderInstall({
      ...INSTALLABLE,
      phase: "installing",
      work: { state: "saving", tasks: ["Release notes", "Docs pass"] },
    });
    expect(markup).toContain("data-update-saving");
    expect(markup).toContain(UPDATE_WORK_WORDS.saving);
    expect(markup.match(/data-update-waiting/g)).toHaveLength(2);
    expect(markup).toContain(UPDATE_WORK_WORDS.waitingFor("Release notes"));
    expect(markup).toContain(UPDATE_WORK_WORDS.waitingFor("Docs pass"));
    expect(markup).toContain("data-update-later");
    expect(markup).toContain(UPDATE_WORDS.later);
    expect(markup).not.toContain("data-update-updating");
  });

  it("says it is updating once the work is saved, with no Update later", () => {
    const markup = renderInstall({ ...INSTALLABLE, phase: "installing" });
    expect(markup).toContain("data-update-updating");
    expect(markup).toContain(UPDATE_WORK_WORDS.updating);
    expect(markup).not.toContain("data-update-later");
    expect(markup).not.toContain("data-update-saving");
  });

  it("says the update waits after Update later, and offers Install again", () => {
    const markup = renderInstall(INSTALLABLE, { later: UPDATE_LATER });
    expect(markup).toContain("data-update-later-note");
    expect(markup).toContain(UPDATE_LATER);
    expect(markup).toContain("data-update-install");
    expect(markup).not.toContain("data-update-later=");
  });
});
