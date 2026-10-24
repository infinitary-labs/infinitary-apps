import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";

/** Marker prompt: the mock crewmate emits a note, a decision and a scripted card, each with a local-subdomain link. */
export const LOCAL_LINK_CARDS_PROMPT_MARKER = "show the local link cards";

export const LOCAL_LINK_HREF =
  "http://task-c5db2568.soapbox.localhost:1355/reports/probe?view=agenda";

export const LOCAL_LINK_CARD_TITLES = {
  note: "Local link note",
  decision: "Local link decision",
  scripted: "Local link scripted",
} as const;

function localLinkCardToolCalls(): ScriptedCall[] {
  const anchor = `<a href="${LOCAL_LINK_HREF}">Open the report</a>`;
  return [
    {
      name: "emit_card",
      args: { title: LOCAL_LINK_CARD_TITLES.note, body: `<p>${anchor}</p>` },
    },
    {
      name: "emit_card",
      args: {
        title: LOCAL_LINK_CARD_TITLES.decision,
        body: `<p>The report is ready to read.</p><p>${anchor}</p>`,
        actions: [
          { id: "keep", label: "Keep it", default: true },
          { id: "drop", label: "Drop it" },
        ],
      },
    },
    {
      name: "emit_card",
      args: {
        title: LOCAL_LINK_CARD_TITLES.scripted,
        body:
          "<p></p><script>const link = document.createElement('a');" +
          `link.href = ${JSON.stringify(LOCAL_LINK_HREF)}; link.textContent = 'Open the report';` +
          "document.querySelector('p').append(link);</script>",
      },
    },
  ];
}

/** The model shows cards that link to files on this computer. */
export const localLinkCards: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    // The first mate commissions the crewmate through the shared stand-in.
    if (isFirstmate) return undefined;
    if (latestUserTail.includes(LOCAL_LINK_CARDS_PROMPT_MARKER) && !hasToolResults && wantsStream) {
      return { calls: localLinkCardToolCalls() };
    }
    return undefined;
  };
