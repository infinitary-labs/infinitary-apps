import type { Scenario, ScriptedCall } from "../mockProvider";

/** Marker prompt: the mock crewmate answers with emit_card tool calls first. */
export const EMIT_CARDS_PROMPT_MARKER = "show every card kind";

/** The class the preview's own stylesheet lays its row of choices out by. */
const MOCK_PROTOTYPE_ROW_CLASS = "course-row";
/**
 * A working preview, which is what a decision body may be: it brings a
 * stylesheet of its own, in ordinary CSS the token-only document profile
 * would strip.
 */
export const MOCK_PROTOTYPE_HTML = [
  `<style>.${MOCK_PROTOTYPE_ROW_CLASS}{display:flex;gap:14px;padding:6px 0}</style>`,
  "<h2>Course options</h2>",
  '<p class="inf-muted">Pick a heading; this preview is sandboxed.</p>',
  `<div class="${MOCK_PROTOTYPE_ROW_CLASS}">`,
  '<button type="button" data-inf-action="hold-course">Hold course</button>',
  '<button type="button" data-inf-action="new-course">Plot new course</button>',
  "</div>",
].join("");

export const MOCK_LONG_ACTION_LABEL =
  "Mock the clock while preserving every queued write in its original execution order";

/** The card-kinds crewmate's three cards (`EMIT_CARDS_PROMPT_MARKER`): its decision, its note and its working preview. */
export const MOCK_CHOICE_CARD_TITLE = "Two ways to fix the flaky test";
export const MOCK_QUOTA_NOTE_TITLE = "Quota note";
export const MOCK_PREVIEW_CARD_TITLE = "Course preview";

/** The decision the card-kinds crewmate shows first. */
const MOCK_CHOICE_CARD = {
  name: "emit_card",
  args: {
    title: MOCK_CHOICE_CARD_TITLE,
    body:
      "<p>Awaiting the job queue removes the race entirely.</p>" +
      '<p class="inf-muted">Mocking time leaves write order uncertain.</p>' +
      '<figure><svg viewBox="0 0 320 62" width="100%" role="img" ' +
      'aria-label="Mock clock can leave the race">' +
      '<rect x="4" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--bg-1);stroke:var(--line-2)"></rect>' +
      '<rect x="180" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--accent-dim);stroke:var(--accent)"></rect>' +
      '<path d="M140 31 H174 M166 25 L174 31 L166 37" fill="none" ' +
      'style="stroke:var(--fg-2)"></path>' +
      '<g font-size="14" text-anchor="middle" style="fill:var(--fg-1)">' +
      '<text x="72" y="36">Mock clock</text><text x="248" y="36">Race can return</text>' +
      "</g></svg></figure>" +
      '<p class="inf-muted">Awaiting the queue orders both writes.</p>' +
      '<figure><svg viewBox="0 0 320 62" width="100%" role="img" ' +
      'aria-label="Await queue orders the writes">' +
      '<rect x="4" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--bg-1);stroke:var(--line-2)"></rect>' +
      '<rect x="180" y="9" width="136" height="44" rx="6" ' +
      'style="fill:var(--accent-dim);stroke:var(--accent)"></rect>' +
      '<path d="M140 31 H174 M166 25 L174 31 L166 37" fill="none" ' +
      'style="stroke:var(--fg-2)"></path>' +
      '<g font-size="14" text-anchor="middle" style="fill:var(--fg-1)">' +
      '<text x="72" y="36">Await queue</text><text x="248" y="36">Ordered writes</text>' +
      "</g></svg></figure>" +
      "<details><summary>Latency trade-off</summary>" +
      "<p>Awaiting the queue adds 40ms to the run.</p></details>",
    actions: [
      { id: "mock-clock", label: MOCK_LONG_ACTION_LABEL },
      { id: "await-queue", label: "Await the queue", default: true },
    ],
  },
} satisfies ScriptedCall;

const EVERY_CARD_KIND = [
  MOCK_CHOICE_CARD,
  {
    name: "emit_card",
    args: {
      id: "quota-note",
      title: MOCK_QUOTA_NOTE_TITLE,
      body:
        '<p>Codex weekly at <span class="inf-mono">41%</span> - routing stays put.</p>' +
        '<svg viewBox="0 0 200 8" width="100%" role="img" aria-label="Codex weekly quota">' +
        '<rect width="200" height="8" rx="4" style="fill:var(--bg-3)"></rect>' +
        '<rect width="82" height="8" rx="4" style="fill:var(--accent)"></rect></svg>' +
        "<details><summary>Windows</summary><h6>Weekly</h6>" +
        "<p><mark>41%</mark> used, resets Fri.</p></details>",
    },
  },
  {
    name: "emit_card",
    args: {
      // A working preview is a decision whose body is interactive: the card
      // that shows the thing carries the choice about it (its actions are
      // what make it a decision - nothing on the wire declares a kind).
      title: MOCK_PREVIEW_CARD_TITLE,
      body: MOCK_PROTOTYPE_HTML,
      actions: [
        { id: "hold-course", label: "Hold course" },
        { id: "new-course", label: "Plot new course", default: true },
      ],
    },
  },
] satisfies ScriptedCall[];

/** The card-kinds crewmate shows its three cards at once, then closes like any crewmate. */
export const everyCardKind: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults) return undefined;
    return latestUserTail.includes(EMIT_CARDS_PROMPT_MARKER)
      ? { calls: EVERY_CARD_KIND }
      : undefined;
  };
