import type { ThisMac } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkSetupNoticeView, workSetupNoticeText } from "./WorkSetupNotice";

/**
 * The notice under the input of a window whose work cannot run (docs/view.md,
 * "A Mac that runs work"; the captain's ask, INF-4835: "Set it up again by
 * itself, and say why when it still cannot").
 */

const VIEW: Extract<ThisMac, { role: "view" }> = {
  role: "view",
  name: "MacBook Pro",
  address: "192.168.1.20",
  joinedAt: 1,
  contact: "in-reach",
  readOnly: null,
  heardAt: 1,
  caughtUp: 0,
  runsWork: true,
};

describe("the work notice", () => {
  it("names why this computer's work cannot run, with Not now and Try again", () => {
    const text = workSetupNoticeText({
      ...VIEW,
      workSetup: { state: "blocked", reason: "local-network" },
    });
    expect(text).toBe(
      "This computer's work has not reached MacBook Pro: macOS has not let Infinitary use your local network. Allow it in System Settings › Privacy & Security › Local Network, then try again.",
    );
    const html = renderToStaticMarkup(
      <WorkSetupNoticeView
        width="600px"
        text={text ?? ""}
        reason="local-network"
        trying={false}
        onTryAgain={() => {}}
        onNotNow={() => {}}
      />,
    );
    expect(html).toContain('data-work-setup-notice="local-network"');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(`>${m.viewWorkNotNow()}<`);
    expect(html).toContain(`>${m.viewWorkTryAgain()}<`);
  });

  it("shows nothing while the work starts or runs, or on this computer's own first mate", () => {
    expect(workSetupNoticeText(VIEW)).toBeNull();
    expect(workSetupNoticeText({ ...VIEW, workSetup: { state: "starting" } })).toBeNull();
    expect(workSetupNoticeText({ role: "home", left: null })).toBeNull();
  });
});
