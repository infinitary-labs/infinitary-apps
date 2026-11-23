import { BUILD_IN_PLACE_OPENING } from "../../src/core/orchestrator/intentBrief";
import { completionCardBody } from "../helpers/completionCard";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import type { ScenarioAnswer, ScenarioRequest } from "./mockProvider";
import { answering, calledTool, toolCallCount } from "./providerRequest";

/**
 * The journey stand-in's four built-in crew scripts and the words they
 * answer: the build-in-place panel crewmate, the crewmate that keeps a card's
 * thread, and the Claude crewmate, on a working login and on a refused one.
 * The stand-in (`mockProvider.ts`) asks them after a journey's own scenarios,
 * and keeps the controls a spec releases them through (`releaseThreadAnswer`,
 * `releaseHeldCrew`, `refuseClaude`).
 */

/** What a crew script reads of one request: a scenario's view, and whether the stand-in refuses Claude now. */
export type CrewScriptRequest = ScenarioRequest & { refusingClaude: boolean };

/**
 * Cards as threads, phase 1: `THREAD_PROMPT_MARKER` emits a plain decision
 * card and then answers the captain's replies the two ways the shared
 * contract prescribes - a REVISION of the card under the same id when his
 * words change what the card should say, and a prose `reply` when nothing on
 * it changes. The settle hand-off is `scenarios/threadSettle.ts`.
 */
export const THREAD_PROMPT_MARKER = "keep a thread open";
export const THREAD_CARD_TITLE = "Two ways to fix the flaky test";
export const THREAD_CARD_REVISED_TITLE = "Await the queue, not the clock";
/** The thread card's default action, on every version of it. */
export const THREAD_CARD_DEFAULT_LABEL = "Await the queue";
export const THREAD_REVISE_REPLY = "the second option is wrong";
export const THREAD_REVISE_ANSWER = "You are right; the card now leads with awaiting the queue.";
export const THREAD_PROSE_REPLY = "and the flaky retry - keep it?";
export const THREAD_PROSE_ANSWER = "Kept it; the queue flush makes the retry harmless either way.";
/**
 * The card return rule's case A (docs/card-threads.md "When a card reaches
 * the stage"): a reply the crewmate first ACKNOWLEDGES in the thread - the
 * shape the contract now forbids, scripted so the host is shown holding the
 * card anyway - then works on, held open until the spec calls
 * `releaseThreadAnswer`, and only then answers by revising the card and
 * reporting.
 */
export const THREAD_ACK_REPLY = "does it cover the retry on windows too?";
export const THREAD_ACK_TEXT = "I'll check the windows retry and update the card.";
export const THREAD_ACK_REVISED_TITLE = "Await the queue on every platform";
/** The revision's own answer: every revision while answering says what changed (INF-1623). */
export const THREAD_ACK_ANSWER =
  "The windows retry waits on the same queue flush, so I added it to the card.";
const MOCK_THREAD_ACK_REPORT =
  "Checked the windows retry: awaiting the queue covers it too, and the card now says so.";

/**
 * A Claude crewmate's turn (mockClaudeClient.ts turn mode). A commission
 * whose title carries this phrase makes the mock Firstmate pin the spawn to
 * CLAUDE_CREW_MODEL through `override_model_id`. The crewmate behind it
 * emits one card, then its next step is held open - the model still
 * working - until the spec calls `releaseHeldCrew`, which answers it with a
 * progress note. A steer the captain sent meanwhile rides into the running
 * turn at that step; a request carrying CLAUDE_STEER_MARKER reports that it
 * heard the steer and closes. The hold is what makes "mid-turn" a fact
 * rather than a race.
 */
export const CLAUDE_CREW_PROMPT_MARKER = "on the Claude login";
export const MOCK_CLAUDE_CARD_TITLE = "Rivet count";
export const MOCK_CLAUDE_CARD_TEXT = "Forty rivets on the port hatch, all tight.";
export const CLAUDE_STEER_MARKER = "count the starboard hatch too";
export const MOCK_CLAUDE_STEERED_REPORT =
  "Counted the starboard hatch too, as steered: thirty-eight rivets, all tight.";
/** The progress note `releaseHeldCrew` answers the held step with. */
export const MOCK_CLAUDE_HELD_PROGRESS = "Counted the port hatch.";
/** A ready decision released by report while the client remains in its held step. */
export const CLAUDE_CARD_RETIRE_MARKER = "with a choice to retire";

/**
 * A Claude crewmate on a login its organisation refuses (W1 S8). A
 * commission whose title carries this phrase beside CLAUDE_CREW_PROMPT_MARKER
 * runs on Claude, and while the server refuses Claude (`refuseClaude`) every
 * turn it starts is answered with the vendor's organisation refusal: a 403
 * carrying CLAUDE_ORG_REFUSAL_MESSAGE, which the real client types
 * `oauth_org_not_allowed`. Once the server stops refusing, a turn carrying
 * CLAUDE_REFUSAL_OVER_MARKER reports MOCK_CLAUDE_REFUSAL_OVER_REPORT.
 */
export const CLAUDE_REFUSED_PROMPT_MARKER = "while refused";
export const CLAUDE_REFUSAL_OVER_MARKER = "count the rivets again now";
export const MOCK_CLAUDE_REFUSAL_OVER_REPORT =
  "Counted the rivets again once Claude answered: forty, all tight.";
/**
 * The refused-login crewmate with a card first (FI3-592, the thread's
 * waiting line): a commission whose title also carries this phrase puts up
 * MOCK_CLAUDE_HELD_CARD_TITLE on its first turn, while Claude still serves
 * it (the spec turns `refuseClaude` off first: the server starts refusing). A captain reply carrying CLAUDE_HELD_REPLY that gets through is
 * answered in the card's thread with MOCK_CLAUDE_HELD_ANSWER.
 */
export const CLAUDE_HELD_CARD_MARKER = "with a chart first";
export const MOCK_CLAUDE_HELD_CARD_TITLE = "Reef chart";
export const CLAUDE_HELD_REPLY = "chart the northern reef too";
export const MOCK_CLAUDE_HELD_ANSWER = "Charted the northern reef too: two shoals, both marked.";
/** The words the vendor's organisation refusal carries; the client types it by them. */
export const CLAUDE_ORG_REFUSAL_MESSAGE =
  "OAuth authentication is currently not allowed for this organization.";

/**
 * The talk-to-personalize build loop (Step 4): the first mate's spawn and
 * remove are `scenarios/personalPanels.ts`. The mock crewmate, on a brief
 * that builds in place, writes the extension with Pi's own write tool, runs
 * lint_panel and capture_panel on the draft, places its version on the rail
 * with place_panel, photographs it there with capture_panel again, and
 * reports after a short delay so the running dot is observable; on the
 * change brief it rewrites the panel with smaller rows, captures, places
 * and captures it again, and reports after the same delay, so a spec can
 * watch the rails while the change is underway. Each build shows its
 * answering note before it reports.
 */
export const MOCK_PANEL_ID = "tokyo-clock";
export const MOCK_PANEL_TITLE = "Tokyo clock";
export const MOCK_PANEL_REPORT =
  "Tokyo clock panel added; it shows the time in Tokyo and how many lines the activity feed holds.";
export const MOCK_PANEL_REVISED_REPORT = "The Tokyo clock rows are smaller now.";
const MOCK_PANEL_REPORT_DELAY_MS = 2_500;
/**
 * What tells the mock crewmate its task builds in place: the personal
 * workspace's own brief sentence. It read `Delivery: live` until the
 * crew-posture rationalization's Task A made the workspace a KIND - a
 * personal brief carries no Delivery line at all now.
 */
const LIVE_BRIEF_MARKER = `${BUILD_IN_PLACE_OPENING}:`;
const ROWS_SMALLER_MARKER = "rows smaller";

/**
 * The answering note a panel build ends with before its report (INF-1677):
 * the ordinary completion of work with nothing to merge.
 */
export const MOCK_PANEL_NOTE_TITLE = "Your Tokyo clock panel is on the rail";
function panelNote(result: string): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      title: MOCK_PANEL_NOTE_TITLE,
      answering: true,
      body: completionCardBody(
        "<p>You asked for a Tokyo clock panel.</p>",
        `<p>${result}</p>`,
        "<p>Your rail had no such panel.</p>",
        "<p>The panel is on your rail now.</p>",
      ),
    },
  };
}

function mockPanelSource(rows: "regular" | "small"): string {
  return [
    'import type { PanelFeedLine, PanelProps } from "@infinitary/contracts";',
    'import { MicroLabel, Row } from "@infinitary/ui";',
    'import { useEffect, useState } from "react";',
    "",
    'const clock = new Intl.DateTimeFormat("en-GB", {',
    '  timeZone: "Asia/Tokyo",',
    '  hour: "2-digit",',
    '  minute: "2-digit",',
    "});",
    "",
    "export default function Panel({ reads }: PanelProps) {",
    "  const [lines, setLines] = useState<PanelFeedLine[]>([]);",
    '  useEffect(() => reads.subscribe("feed.recent", setLines), [reads]);',
    "  return (",
    "    <div",
    '      data-mock-panel=""',
    `      data-mock-rows="${rows}"`,
    `      style={{ display: "flex", flexDirection: "column", gap: "${rows === "small" ? "var(--space-1)" : "var(--space-2)"}" }}`,
    "    >",
    "      <MicroLabel count={lines.length}>Activity</MicroLabel>",
    `      <Row title="Tokyo" tone="idle" trailing={clock.format(Date.now())}${rows === "small" ? ' style={{ padding: "1px 6px" }}' : ""} />`,
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n");
}

// No placement: the panel lands where a panel that names none does.
const MOCK_PANEL_MANIFEST = `${JSON.stringify(
  {
    title: MOCK_PANEL_TITLE,
    reads: ["feed.recent"],
  },
  null,
  2,
)}\n`;

/**
 * The panel crewmate's answer to one request, the first crew script the
 * stand-in asks; undefined for every request that is not a panel build's.
 * A journey's own scenario may read it to change how one of its steps is
 * sent (`scenarios/panelPlaceHeld.ts`).
 */
export function panelCrewmateAnswer(request: ScenarioRequest): ScenarioAnswer | undefined {
  const { body, isFirstmate, wantsStream } = request;
  // The mock live-build crewmate (Step 4): write the extension with
  // Pi's own write tool, lint it and photograph its draft, place it on
  // the rail and photograph it there (docs/personal-panels.md, "Placed
  // on the rail"), then report after a pause so the running dot is
  // observable; a change brief rewrites, photographs, places,
  // photographs and reports. Each capture is its own turn, so the
  // first reads the draft and the second the rail the place left.
  // Match the task brief across the whole conversation. Tool-result
  // follow-ups can be serialized as a newer user message, so limiting
  // this session marker to `latestUserTail` makes the second leg fall
  // through to the generic crewmate response before it can report.
  if (!isFirstmate && body.includes(LIVE_BRIEF_MARKER) && wantsStream) {
    // The change brief, by the same whole-conversation match: a
    // capture's pictures come back as a newer user message.
    if (body.includes(ROWS_SMALLER_MARKER)) {
      if (!calledTool(body, "write")) {
        return {
          calls: [
            {
              name: "write",
              args: { path: `${MOCK_PANEL_ID}/panel.tsx`, content: mockPanelSource("small") },
            },
          ],
        };
      }
      if (!calledTool(body, "capture_panel")) {
        return { calls: [{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }] };
      }
      if (!calledTool(body, "place_panel")) {
        return { calls: [{ name: "place_panel", args: { id: MOCK_PANEL_ID } }] };
      }
      if (toolCallCount(body, "capture_panel") < 2) {
        return { calls: [{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }] };
      }
      if (!calledTool(body, "emit_card")) {
        return { calls: [panelNote(MOCK_PANEL_REVISED_REPORT)] };
      }
      if (!calledTool(body, "report")) {
        return {
          calls: [{ name: "report", args: { text: MOCK_PANEL_REVISED_REPORT } }],
          afterMs: MOCK_PANEL_REPORT_DELAY_MS,
        };
      }
      return { text: "done" };
    }
    if (!calledTool(body, "write")) {
      return {
        calls: [
          {
            name: "write",
            args: { path: `${MOCK_PANEL_ID}/panel.tsx`, content: mockPanelSource("regular") },
          },
          {
            name: "write",
            args: { path: `${MOCK_PANEL_ID}/manifest.json`, content: MOCK_PANEL_MANIFEST },
          },
          { name: "note_progress", args: { text: "Wrote the panel; checking it next." } },
        ],
      };
    }
    if (!calledTool(body, "lint_panel")) {
      return {
        calls: [
          { name: "lint_panel", args: {} },
          { name: "capture_panel", args: { id: MOCK_PANEL_ID } },
        ],
      };
    }
    if (!calledTool(body, "place_panel")) {
      return { calls: [{ name: "place_panel", args: { id: MOCK_PANEL_ID } }] };
    }
    if (toolCallCount(body, "capture_panel") < 2) {
      return { calls: [{ name: "capture_panel", args: { id: MOCK_PANEL_ID } }] };
    }
    if (!calledTool(body, "emit_card")) {
      return { calls: [panelNote(MOCK_PANEL_REPORT)] };
    }
    if (!calledTool(body, "report")) {
      return {
        calls: [{ name: "report", args: { text: MOCK_PANEL_REPORT } }],
        afterMs: MOCK_PANEL_REPORT_DELAY_MS,
      };
    }
    return { text: "done" };
  }
  return undefined;
}

/**
 * The built-in crew scripts' answer to one request, in the order the
 * stand-in always asked them: the panel crewmate, the thread crewmate, the
 * Claude crewmate on a refused login, then on a working one. Undefined
 * passes the request on to the stand-in's default close-out.
 */
export function crewScriptAnswer(request: CrewScriptRequest): ScenarioAnswer | undefined {
  const panel = panelCrewmateAnswer(request);
  if (panel) return panel;
  const {
    body,
    isFirstmate,
    wantsStream,
    latestUserTail,
    hasToolResults,
    anthropicMessages,
    refusingClaude,
  } = request;
  // Cards as threads, phase 1: the crewmate that keeps a thread. Its
  // card's id is the one emit_card handed back, read out of the
  // transcript exactly as a real model would read it.
  if (!isFirstmate && body.includes(THREAD_PROMPT_MARKER) && wantsStream) {
    const shownCardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
    // Case A: acknowledge, work (held until released), then answer by
    // revising the card, and report. Every step reads only this
    // reply's own leg of the conversation.
    if (latestUserTail.includes(THREAD_ACK_REPLY)) {
      if (!calledTool(latestUserTail, "reply")) {
        return {
          calls: [{ name: "reply", args: { card_id: shownCardId, text: THREAD_ACK_TEXT } }],
        };
      }
      if (!calledTool(latestUserTail, "emit_card")) {
        return {
          threadHeld: [
            {
              name: "emit_card",
              args: {
                id: "thread-card",
                reply: THREAD_ACK_ANSWER,
                // The answer names the reply; the acknowledgement did not.
                ...answering(latestUserTail),
                title: THREAD_ACK_REVISED_TITLE,
                body: "<p>Awaiting the job queue removes the race on every platform.</p><p>The windows retry waits on the same queue flush.</p>",
                actions: [
                  { id: "mock-clock", label: "Mock the clock" },
                  { id: "await-queue", label: THREAD_CARD_DEFAULT_LABEL, default: true },
                ],
              },
            },
          ],
        };
      }
      if (!calledTool(latestUserTail, "report")) {
        return { calls: [{ name: "report", args: { text: MOCK_THREAD_ACK_REPORT } }] };
      }
      return { text: "Answered on the card." };
    }
    // The captain's words change what the card says: revise the head
    // under the same id. The thread gets the host's "revised" line.
    if (!hasToolResults && latestUserTail.includes(THREAD_REVISE_REPLY)) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "thread-card",
              reply: THREAD_REVISE_ANSWER,
              ...answering(latestUserTail),
              title: THREAD_CARD_REVISED_TITLE,
              body: "<p>Awaiting the job queue removes the race entirely.</p><p>Mocking the clock leaves write order uncertain, which is what you spotted.</p>",
              actions: [
                { id: "mock-clock", label: "Mock the clock" },
                { id: "await-queue", label: THREAD_CARD_DEFAULT_LABEL, default: true },
              ],
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(THREAD_PROSE_REPLY)) {
      return {
        calls: [
          {
            name: "reply",
            args: {
              card_id: shownCardId,
              text: THREAD_PROSE_ANSWER,
              ...answering(latestUserTail),
            },
          },
        ],
      };
    }
    if (!hasToolResults && !calledTool(body, "emit_card")) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "thread-card",
              title: THREAD_CARD_TITLE,
              body: "<p>Awaiting the job queue removes the race entirely.</p><p>Mocking the clock is quicker but leaves write order uncertain.</p>",
              actions: [
                { id: "mock-clock", label: "Mock the clock" },
                { id: "await-queue", label: THREAD_CARD_DEFAULT_LABEL, default: true },
              ],
            },
          },
        ],
      };
    }
    return { text: "The card is up and I am holding for the captain." };
  }
  if (
    !isFirstmate &&
    anthropicMessages &&
    wantsStream &&
    body.includes(CLAUDE_REFUSED_PROMPT_MARKER)
  ) {
    if (refusingClaude) {
      return {
        refusal: {
          status: 403,
          error: { type: "permission_error", message: CLAUDE_ORG_REFUSAL_MESSAGE },
        },
      };
    }
    if (hasToolResults) return { text: "done" };
    if (body.includes(CLAUDE_HELD_CARD_MARKER)) {
      const cardId = latestUserTail.includes(CLAUDE_HELD_REPLY)
        ? latestUserTail.match(/\((card-[\w-]+)\)/)?.[1]
        : undefined;
      return {
        calls: [
          cardId
            ? {
                name: "reply",
                args: {
                  card_id: cardId,
                  text: MOCK_CLAUDE_HELD_ANSWER,
                  ...answering(latestUserTail),
                },
              }
            : {
                name: "emit_card",
                args: {
                  title: MOCK_CLAUDE_HELD_CARD_TITLE,
                  body: "<p>The reef has one shoal on the southern side.</p><p>It is marked on the chart.</p>",
                },
              },
        ],
      };
    }
    if (latestUserTail.includes(CLAUDE_REFUSAL_OVER_MARKER)) {
      return { calls: [{ name: "report", args: { text: MOCK_CLAUDE_REFUSAL_OVER_REPORT } }] };
    }
    return { text: "Nothing new to add." };
  }
  // The Claude crewmate (CLAUDE_CREW_PROMPT_MARKER): card, held step,
  // steer, report. The steer is checked first because the client
  // sends it in the same user message as the held step's tool result.
  if (!isFirstmate && body.includes(CLAUDE_CREW_PROMPT_MARKER) && wantsStream) {
    if (latestUserTail.includes(CLAUDE_STEER_MARKER)) {
      return { calls: [{ name: "report", args: { text: MOCK_CLAUDE_STEERED_REPORT } }] };
    }
    if (hasToolResults && body.includes(CLAUDE_STEER_MARKER)) return { text: "done" };
    if (hasToolResults) return { held: true };
    const retireChoice = body.includes(CLAUDE_CARD_RETIRE_MARKER);
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: MOCK_CLAUDE_CARD_TITLE,
            body: `<p>${MOCK_CLAUDE_CARD_TEXT}</p>${retireChoice ? "<p>Inspect port first because it is closest; starboard can wait.</p>" : ""}`,
            ...(retireChoice
              ? {
                  actions: [
                    { id: "port", label: "Inspect the port hatch", default: true },
                    { id: "starboard", label: "Inspect the starboard hatch" },
                  ],
                }
              : {}),
          },
        },
        ...(retireChoice
          ? [
              {
                name: "report",
                args: { text: MOCK_CLAUDE_HELD_PROGRESS },
              } satisfies ScriptedCall,
            ]
          : []),
      ],
    };
  }
  return undefined;
}
