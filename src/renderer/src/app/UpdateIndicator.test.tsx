import type { UpdateStatus } from "@shared/update";
import {
  UPDATE_LATER,
  UPDATE_NOTICES,
  UPDATE_STEP_WORDS,
  UPDATE_WORDS,
  UPDATE_WORK_WORDS,
} from "@shared/updateWords";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UpdatePanel } from "./UpdateIndicator";

/**
 * The update panel (docs/alpha.md "Update channels"): it names the channel,
 * the offered version and the version this Mac has, so an offer reads as
 * new or not at a glance, and the channel's upgrade command with Copy
 * command (INF-2670: the same update part as the Version row).
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
  return renderToStaticMarkup(<UpdatePanel status={status} />).replace(/<!-- -->/g, "");
}

/** A hook's text, its version link's tags removed. */
function hookText(markup: string, hook: string): string | undefined {
  return new RegExp(`<div ${hook}="[^"]*"[^>]*>(.*?)</div>`)
    .exec(markup)?.[1]
    ?.replace(/<[^>]*>/g, "");
}

describe("UpdatePanel", () => {
  it("names the offered version and, beneath it, the version this Mac has", () => {
    const markup = render(ALPHA_OFFER);
    expect(markup).toContain('data-update-channel="alpha"');
    expect(markup).toContain("Alpha updates");
    expect(hookText(markup, "data-update-line")).toBe(
      `${UPDATE_NOTICES.available("0.1.27-alpha.15")} ${UPDATE_STEP_WORDS.command}`,
    );
    expect(hookText(markup, "data-update-installed")).toBe("You have 0.1.26-alpha.14");
    expect(markup.indexOf("data-update-line")).toBeLessThan(
      markup.indexOf("data-update-installed"),
    );
    expect(markup).toContain(ALPHA_OFFER.upgradeCommand.replaceAll("&", "&amp;"));
    expect(markup).toContain('data-update-action="copy"');
    expect(markup).toContain(UPDATE_WORDS.copy);
    // INF-3405, the captain's direction B: Check for updates beside the next step, and the
    // offered version is the link to its release page.
    expect(markup).toContain('data-update-action="check"');
    expect(markup).not.toContain('data-update-action="release"');
    expect(markup).toMatch(/<button [^>]*data-update-release=""[^>]*>0\.1\.27-alpha\.15<\/button>/);
  });

  it("keeps the two versions apart when only the alpha suffix differs", () => {
    // Stable 0.1.25 handed to alpha outranks every 0.1.25-alpha.N.
    const markup = render({
      ...ALPHA_OFFER,
      currentVersion: "0.1.25-alpha.42",
      latestVersion: "0.1.25",
    });
    expect(hookText(markup, "data-update-line")).toContain(UPDATE_NOTICES.available("0.1.25"));
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
        presses={{ checking: false, busy: false, problem: null, later: extra.later ?? null }}
      />,
    ).replace(/<!-- -->/g, "");
  }

  it("names each task whose running work it waits for, with Update later", () => {
    const markup = renderInstall({
      ...INSTALLABLE,
      phase: "installing",
      work: { state: "saving", tasks: ["Release notes", "Docs pass"] },
    });
    expect(markup).toContain('data-update-step="saving"');
    expect(hookText(markup, "data-update-line")).toBe(UPDATE_WORK_WORDS.saving);
    expect(markup.match(/data-update-waiting/g)).toHaveLength(2);
    expect(markup).toContain(UPDATE_WORK_WORDS.waitingFor("Release notes"));
    expect(markup).toContain(UPDATE_WORK_WORDS.waitingFor("Docs pass"));
    expect(markup).toContain('data-update-action="later"');
    expect(markup).toContain(UPDATE_WORDS.later);
    expect(markup).not.toContain('data-update-step="updating"');
  });

  it("says it is updating once the work is saved, with no Update later", () => {
    const markup = renderInstall({ ...INSTALLABLE, phase: "installing" });
    expect(markup).toContain('data-update-step="updating"');
    expect(hookText(markup, "data-update-line")).toBe(UPDATE_WORK_WORDS.updating);
    expect(markup).not.toContain('data-update-action="later"');
    expect(markup).not.toContain('data-update-step="saving"');
  });

  it("says the update waits after Update later, and offers Install again", () => {
    const markup = renderInstall(INSTALLABLE, { later: UPDATE_LATER });
    expect(hookText(markup, "data-update-line")).toBe(
      `${UPDATE_NOTICES.available("0.1.27-alpha.15")} ${UPDATE_LATER}`,
    );
    expect(markup).toContain('data-update-action="install"');
    expect(markup).not.toContain('data-update-action="later"');
  });
});

// INF-4014's review: a command-started first mate opens its window to install a view's update and
// asks right after the window's main process says it is here, before the page listens for the
// push, so the first reading that names who asked opens the notice instead.
describe("the update notice on a view's update", () => {
  it("opens when a reading first names who asked, and stays shut once closed", async () => {
    const { refreshUpdateStatus, setUpdateNoticeOpen, useUpdateState } = await import(
      "./updateState"
    );
    let status: UpdateStatus = { ...ALPHA_OFFER, install: { asksPassword: false } };
    const stub = { infinitary: { update: { status: async () => status } } };
    const had = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = stub;
    vi.useFakeTimers();
    try {
      setUpdateNoticeOpen(false);
      await refreshUpdateStatus();
      expect(useUpdateState.getState().noticeOpen).toBe(false);
      status = { ...status, phase: "downloading", askedFrom: "the phone" };
      await refreshUpdateStatus();
      expect(useUpdateState.getState().noticeOpen).toBe(true);
      // Someone here closes it: later readings of the same update leave it shut.
      setUpdateNoticeOpen(false);
      await refreshUpdateStatus();
      expect(useUpdateState.getState().noticeOpen).toBe(false);
      status = { ...status, askedFrom: undefined, phase: "idle" };
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.useRealTimers();
      (globalThis as { window?: unknown }).window = had;
    }
  });
});
