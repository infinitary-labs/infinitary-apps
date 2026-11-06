import { DIAGNOSTIC_EVENT_NAMES } from "@shared/diagnostics";
import { DIAGNOSTICS_SUMMARY, type SharingPreview, type SharingView } from "@shared/sharing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  channelsAwaitingView,
  renderTerms,
  SharingAskView,
  SharingSectionView,
  sharingRowDescription,
} from "./SharingSection";

/**
 * The Sharing section's rendering contract (roadmap 1.4): the contribution
 * switch exists only under published terms, the diagnostics row says what
 * Diagnostics sends - the events, the version, the random install ID and
 * its reset - and where it goes (or that this build sends nowhere), the
 * viewer shows the install ID, every record's body in full and every event
 * and field the allowlist has, and the words for the machinery reach no
 * surface.
 */

const INSTALL_ID = "00000000-0000-4000-8000-000000000001";

const OFF: SharingView = {
  diagnostics: {
    enabled: false,
    viewedAt: null,
    sentAt: null,
    installId: null,
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

const ON: SharingView = {
  ...OFF,
  diagnostics: { ...OFF.diagnostics, enabled: true, viewedAt: 1, installId: INSTALL_ID },
};

const PREVIEW: SharingPreview = {
  diagnostics: {
    pending: [
      {
        at: 1_700_086_400_000,
        name: "main_agent_turn_end",
        body: {
          type: "event",
          payload: {
            website: "site-1",
            name: "main_agent_turn_end",
            data: { trigger: "captain", version: "1.2.3" },
            id: INSTALL_ID,
          },
        },
      },
    ],
    sent: [
      {
        at: 1_700_000_000_000,
        name: "app_launch",
        body: { type: "event", payload: { website: "site-1", name: "app_launch", id: INSTALL_ID } },
      },
    ],
  },
  contribution: {
    pending: [{ taskId: "t1", ref: "d1", kind: "decided", at: 1_700_000_000_000, data: {} }],
    pendingCount: 3,
  },
};

const noop = () => {};

function render(
  view: SharingView | null,
  preview: SharingPreview | null,
  viewerOpen = false,
  termsOpen = false,
) {
  return renderToStaticMarkup(
    <SharingSectionView
      view={view}
      preview={preview}
      viewerOpen={viewerOpen}
      termsOpen={termsOpen}
      onSwitch={noop}
      onViewer={noop}
      onTerms={noop}
    />,
  );
}

describe("SharingSectionView", () => {
  it("shows one switch while the terms are unpublished, and the second once they are", () => {
    const unpublished = render(OFF, null);
    expect(unpublished).toContain('data-setting="diagnostics"');
    expect(unpublished).not.toContain('data-setting="contribution"');
    expect(unpublished).not.toContain("Contribution");

    const published = render({ ...OFF, termsPublished: true }, null);
    expect(published).toContain('data-setting="contribution"');
    expect(published).toContain("Redacted records of your first mate&#x27;s own decisions");
  });

  it("shows no terms while they are unpublished, so no draft claims nothing is sent beside Diagnostics on", () => {
    // The draft the build carries says no diagnostic leaves and the app sends
    // nothing; under the switch that is on, that would contradict the row.
    for (const view of [OFF, ON]) {
      const unpublished = render(view, PREVIEW, true, true);
      expect(unpublished).not.toContain("The terms");
      expect(unpublished).not.toContain("data-sharing-terms");
      expect(unpublished).not.toContain("draft-1");
      expect(unpublished).not.toContain("sends us nothing");
      expect(unpublished).not.toContain("no diagnostic leaves");
    }
    expect(render(ON, null)).toContain('aria-checked="true"');

    const published = render({ ...ON, termsPublished: true }, null, false, true);
    expect(published).toContain("The terms");
    expect(published).toContain("data-sharing-terms");
    expect(published).toContain("Data terms</h3>");
  });

  it("says what Diagnostics sends, the install ID and its reset, and where it goes - or that this build sends nowhere", () => {
    expect(sharingRowDescription(OFF, "diagnostics")).toBe(
      `${DIAGNOSTICS_SUMMARY} Sent to a.example.com. Never a conversation, code or a card.`,
    );
    expect(sharingRowDescription({ ...OFF, diagnosticsDestination: null }, "diagnostics")).toBe(
      `${DIAGNOSTICS_SUMMARY} This build has nowhere to send them, so nothing leaves either way.`,
    );
    expect(render({ ...OFF, diagnosticsDestination: null }, null)).toContain("nothing leaves");
  });

  it("the viewer shows the install ID, every record in full, and every event and field that can leave", () => {
    const html = render({ ...ON, termsPublished: true }, PREVIEW, true);
    expect(html).toContain("data-sharing-viewer");
    expect(html).toContain("data-sharing-install-id");
    expect(html).toContain(`>${INSTALL_ID}</code>`);
    expect(html).toContain(
      "replaced with a new one whenever Diagnostics is turned off and back on",
    );
    expect(html).toContain('data-sharing-records="diagnostics-pending"');
    expect(html).toContain('data-sharing-records="diagnostics-sent"');
    expect(html).toContain('data-sharing-record="main_agent_turn_end"');
    expect(html).toContain('data-sharing-record="app_launch"');
    expect(html).toContain("&quot;website&quot;: &quot;site-1&quot;");
    expect(html).toContain(`&quot;id&quot;: &quot;${INSTALL_ID}&quot;`);
    // The catalog is the allowlist itself: every event, every field, every value.
    for (const name of DIAGNOSTIC_EVENT_NAMES) {
      expect(html).toContain(`data-sharing-catalog-event="${name}"`);
    }
    expect(html).toContain("reason: sign_in | time_limit | provider | no_session | error");
    expect(html).toContain("trigger: captain | operation");
    expect(html).toContain('data-sharing-records="contribution-pending"');
    expect(html).toContain("newest 1 of 3");
    expect(html).toContain('data-sharing-record="d1"');
    // Unpublished terms: no decision records are listed, whatever the preview holds.
    expect(render(OFF, PREVIEW, true)).not.toContain("contribution-pending");
  });

  it("says nothing is recorded while off, and when everything recorded has gone", () => {
    const drained = { ...PREVIEW, diagnostics: { ...PREVIEW.diagnostics, pending: [] } };
    const off = render(OFF, drained, true);
    expect(off).toContain("Nothing is recorded while Diagnostics is off.");
    expect(off).toContain("none while Diagnostics is off");
    expect(render(ON, PREVIEW, true)).toContain("Diagnostics waiting to send");
    expect(render(ON, drained, true)).toContain("everything recorded has been sent");
  });

  it("knows which switched-on channel still awaits its first view", () => {
    expect(channelsAwaitingView(OFF)).toEqual([]);
    const on = { ...OFF, diagnostics: { ...OFF.diagnostics, enabled: true } };
    expect(channelsAwaitingView(on)).toEqual(["diagnostics"]);
    expect(channelsAwaitingView({ ...on, diagnosticsDestination: null })).toEqual([]);
    expect(
      channelsAwaitingView({ ...on, diagnostics: { ...on.diagnostics, viewedAt: 5 } }),
    ).toEqual([]);
    const both = {
      ...on,
      contribution: { enabled: true, viewedAt: null, sentAt: null },
    };
    expect(channelsAwaitingView(both)).toEqual(["diagnostics"]);
    expect(channelsAwaitingView({ ...both, termsPublished: true })).toEqual([
      "diagnostics",
      "contribution",
    ]);
  });

  it("keeps the machinery's words off the surface", () => {
    const html = render({ ...OFF, termsPublished: true }, PREVIEW, true).toLowerCase();
    for (const word of ["telemetry", "analytics", "umami"]) {
      expect(html).not.toContain(word);
    }
    const ask = renderToStaticMarkup(<SharingAskView onAnswer={noop} />).toLowerCase();
    for (const word of ["telemetry", "analytics", "umami"]) {
      expect(ask).not.toContain(word);
    }
  });
});

describe("the terms reader", () => {
  it("renders headings, paragraphs and a bold lead, and nothing it does not know", () => {
    const html = renderToStaticMarkup(
      renderTerms(
        "# Data terms\n\n**Status: draft.** Plain words follow.\n\n## 1. Who\n\nOne paragraph\nwrapped over two lines.",
      ),
    );
    expect(html).toContain("<h3");
    expect(html).toContain("Data terms</h3>");
    expect(html).toContain("<h4");
    expect(html).toContain("1. Who</h4>");
    expect(html).toContain("<strong");
    expect(html).toContain("Status: draft.</strong>");
    expect(html).toContain("One paragraph wrapped over two lines.");
    expect(html).not.toContain("**");
  });
});

describe("a refused change", () => {
  it("is told beside its own switch, and the switches wait while a change is saved", () => {
    const html = renderToStaticMarkup(
      <SharingSectionView
        view={{ ...ON, termsPublished: true }}
        refusal={{ channel: "contribution", message: "Could not change sharing: Locked." }}
        saving
        preview={null}
        viewerOpen={false}
        termsOpen={false}
        onSwitch={noop}
        onViewer={noop}
        onTerms={noop}
      />,
    );
    const rows = html.split("data-setting=");
    const contribution = rows.find((row) => row.startsWith('"contribution"')) ?? "";
    const diagnostics = rows.find((row) => row.startsWith('"diagnostics"')) ?? "";
    expect(contribution).toContain('role="alert"');
    expect(contribution).toContain("Could not change sharing: Locked.");
    expect(diagnostics).not.toContain('role="alert"');
    expect(html.match(/role="switch"[^>]*disabled=""/g)).toHaveLength(2);
  });

  it("keeps the one-time ask up with the reason its answer was refused", () => {
    const html = renderToStaticMarkup(
      <SharingAskView onAnswer={noop} error="Could not save your answer: Locked." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not save your answer: Locked.");
    expect(html).toContain("Contribute");
  });
});

describe("SharingAskView", () => {
  it("offers exactly the two answers", () => {
    const html = renderToStaticMarkup(<SharingAskView onAnswer={noop} />);
    expect(html).toContain("data-sharing-ask");
    expect(html).toContain("Not now");
    expect(html).toContain("Contribute");
    expect(html).toContain("this is the only time the app asks");
  });
});
