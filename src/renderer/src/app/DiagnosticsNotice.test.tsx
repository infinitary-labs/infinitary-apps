import { DIAGNOSTICS_NOTICE_TEXT, type SharingView } from "@shared/sharing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticsNoticeView, diagnosticsNoticeDue } from "./DiagnosticsNotice";

/**
 * The first-launch disclosure of Diagnostics (docs/sharing.md): owed
 * while the switch is on, the build has somewhere to send and the person
 * was never shown it; it says what goes and offers the way off.
 */

const FRESH: SharingView = {
  diagnostics: {
    enabled: true,
    viewedAt: null,
    sentAt: null,
    installId: "00000000-0000-4000-8000-000000000001",
    milestones: [],
    pending: [],
    phones: {},
  },
  contribution: { enabled: false, viewedAt: null, sentAt: null },
  ask: { askedAt: null, answeredAt: null, answer: null },
  termsPublished: false,
  termsVersion: "draft-1",
  diagnosticsDestination: "a.example.com",
  askPending: false,
};

describe("diagnosticsNoticeDue", () => {
  it("is owed on a fresh install with somewhere to send, and not otherwise", () => {
    expect(diagnosticsNoticeDue(FRESH)).toBe(true);
    expect(diagnosticsNoticeDue({ ...FRESH, diagnosticsDestination: null })).toBe(false);
    expect(
      diagnosticsNoticeDue({ ...FRESH, diagnostics: { ...FRESH.diagnostics, viewedAt: 5 } }),
    ).toBe(false);
    expect(
      diagnosticsNoticeDue({ ...FRESH, diagnostics: { ...FRESH.diagnostics, enabled: false } }),
    ).toBe(false);
  });
});

describe("DiagnosticsNoticeView", () => {
  it.each([true, false])("pairs a refusal with the last saved state (%s)", (enabled) => {
    const html = renderToStaticMarkup(
      <DiagnosticsNoticeView
        width="100%"
        onTurnOff={() => {}}
        onOk={() => {}}
        error="Could not change sharing: The saved settings are locked. Try again."
        enabled={enabled}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not change sharing: The saved settings are locked. Try again.");
    expect(html).toContain(`Last saved: Diagnostics ${enabled ? "on" : "off"}.`);
  });

  it.each(["off", "ok"] as const)("holds both choices while %s is saving", (pending) => {
    const html = renderToStaticMarkup(
      <DiagnosticsNoticeView width="100%" onTurnOff={() => {}} onOk={() => {}} pending={pending} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(html).toContain("Saving...");
    expect(html).not.toContain('role="alert"');
  });

  it("says what goes, offers the way off, and names no machinery", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsNoticeView width="100%" onTurnOff={() => {}} onOk={() => {}} />,
    );
    expect(html).toContain("data-diagnostics-notice");
    expect(html).toContain(DIAGNOSTICS_NOTICE_TEXT);
    // What goes, the install ID and its reset, and the way off; the event
    // list itself is one click away, in the Settings viewer.
    expect(html).toContain("anonymous usage events");
    expect(html).toContain("a random install ID, reset when you turn them off and on");
    expect(html).toContain("never what you type");
    expect(html).toContain("Turn off here or in Settings");
    expect(html).toContain("Turn off");
    expect(html).toContain("OK");
    for (const word of ["telemetry", "analytics", "umami"]) {
      expect(html.toLowerCase()).not.toContain(word);
    }
  });
});
