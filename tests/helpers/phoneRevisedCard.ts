import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";
import { clearPhoneCards } from "./phoneCrewCards";

const TASK_TITLE = "Find why the tide gauge missed the spring tides";
const TITLE =
  "The tide gauge never lists held readings, so the spring tides never reached the harbour charts";
/** The body's first words, which the phone part looks for at the body's top. */
const FIRST_WORDS = "The tide gauge skipped the north and south pier readings";

/** One version of the card's body: which sections are folded and which new lines it adds. */
export type RevisedCardVersion = "first" | "marked" | "folded-marked";

/** A figure as a crewmate draws one: a row per reading, a state mark and a line. */
function figure(label: string, rows: readonly [string, string, boolean][]): string {
  const height = 60 + rows.length * 38;
  const drawn = rows
    .map(([name, value, ok], index) => {
      const y = 83 + index * 38;
      return `<text x="0" y="${y}" style="fill:var(--fg-1)">${name}</text>
  <circle cx="400" cy="${y - 4}" r="9" style="fill:var(--${ok ? "ok" : "danger"}-dim)"/>
  <text x="420" y="${y}" style="fill:var(--fg-1)">${value}</text>
  <line x1="0" y1="${y + 15}" x2="750" y2="${y + 15}" style="stroke:var(--line-1)"/>`;
    })
    .join("\n  ");
  return `<figure aria-label="${label}"><svg viewBox="0 0 750 ${height}" width="100%" role="img">
  <text x="0" y="18" style="font-size:14px;font-weight:600;fill:var(--fg-1)">${label}</text>
  <text x="0" y="50" style="font-family:var(--font-mono);font-size:11px;fill:var(--fg-3)">WHAT IT NEEDS</text>
  <line x1="0" y1="60" x2="750" y2="60" style="stroke:var(--line-2)"/>
  ${drawn}
</svg></figure>`;
}

const paragraphs = (lines: readonly string[]) => lines.map((line) => `<p>${line}</p>`).join("\n");
const items = (lines: readonly string[]) =>
  `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`;

/**
 * The long sections of the card, each with its summary and the lines it adds in a revision. The shape is the one the
 * captain's card had when its choices could not be reached (INF-6866): figures, a comparison, lists and a builder's
 * spec, several screens long when every section is open.
 */
function sections(version: RevisedCardVersion): { summary: string; body: string }[] {
  const added = (line: string, from: RevisedCardVersion[]) =>
    from.includes(version) ? `<p>${line}</p>` : "";
  return [
    {
      summary: "Why the gauge missed them, and the second cause",
      body: `${figure("Open wait: the only kind of row for a started reading", [
        ["Started, and idle between tides", "yes", true],
        ["No hold on it", "held until the neap tides", false],
        ["Its newest report names no end", "names the spring tide", false],
        ["Not waiting on the harbour master", "waits on the chart office", false],
      ])}
${paragraphs([
  "A hold counts as something that will bring the reading back, so a held reading is never listed, by design.",
  "The one sweep came three minutes after the spring tide closed and still left them out; only your question moved them before the neap tides.",
  "Even a listed row reads new only by age, so a tide closing never marks anything new.",
])}
${added("The south pier reading was held twice more after the first sweep, each time until the neap tides.", ["marked", "folded-marked"])}
<p><strong>The second cause: the wrong copy of the tide table.</strong></p>
${figure("Two copies of the tide table", [
  ["The harbour office's copy", "lists the spring tides", true],
  ["The chart office's copy", "lists only the neap tides", false],
])}
${paragraphs([
  "The north pier's wrong copy changed no answer before the spring tide. After it, the chart office's copy still lists no spring tides, so a wake alone would likely have left it waiting.",
])}`,
    },
    {
      summary: "What linking means, step by step",
      body: `${paragraphs([
        "A link is the gauge's waits-for mark between two readings: when the reading waited for closes, the gauge wakes the waiting reading by itself, with no sweep needed.",
      ])}
${figure("How a link works", [
  ["North and south pier", "waited for the high water mark, woken at once", true],
  ["North and south pier", "no link to the spring tide, nothing woke them", false],
])}
${paragraphs([
  "Linking adds no new gauge: the harbour master already has the tool that makes this mark, and used it for the high water mark. Linking changes only the harbour master's rule book.",
  "The new rule: when a held reading waits on another reading, the harbour master marks it as waiting for that reading. If that reading does not exist yet, the harbour master files it first.",
])}
${added("The mark also keeps a waiting reading off the chart until the reading it waits for closes.", ["folded-marked"])}
${paragraphs([
  "Step 2 is the only new step; steps 3 and 4 already happen today for any marked wait.",
  "The mark cannot cover a wait on your word or on a storm with no reading behind it, so listing stays as the backup.",
])}`,
    },
    {
      summary: "How the options compare",
      body: `<table>
<tr><th>Option</th><th>Catches a wait nobody linked</th><th>Moves a reading once its wait ends</th><th>Changes</th></tr>
<tr><td>List held readings</td><td>Yes, at the next sweep</td><td>Within the hour</td><td>The gauge's list</td></tr>
<tr><td>Link held readings</td><td>No</td><td>At once</td><td>The harbour master's rule book</td></tr>
<tr><td>Both</td><td>Yes, at the next sweep</td><td>At once when linked</td><td>Both</td></tr>
</table>
${paragraphs([
  "Reliability means catching a wait nobody linked; speed means how soon a reading moves once its wait ends.",
  "I recommend both: a reading moves at once when linked, and the list still catches a missed link, at the cost of two changes.",
])}
${added("Either fix would have woken both readings within minutes of the spring tide.", ["marked", "folded-marked"])}
${figure("The spring tide replayed", [
  ["Linking", "both move at the spring tide", true],
  ["Listing", "both move at the next sweep", true],
  ["As built", "both wait for the neap tides", false],
])}`,
    },
    {
      summary: "Where the pier readings stand",
      body: items([
        "The south pier: its chart is ready, waiting on you.",
        "The north pier: it read the harbour office's copy and is waiting for its chart's checks.",
        "The east breakwater was held the same way, for a spring tide with the new datum. This spring tide has it, so I handed it to the harbour master.",
        "The fix: on Start or File, the harbour master starts or files it with your pick.",
      ]),
    },
    {
      summary: "Evidence, inference and the reproduction",
      body: `<p><strong>What the gauge's record shows</strong></p>
${items([
  "The gauge's list has two row kinds: a parked reading and an open wait. Neither covers a held reading.",
  "An open wait returns nothing for a reading with a hold, below the third sweep, or whose newest report names an end.",
  "The north and south pier readings were each held three times, the last until the neap tides.",
  "Their newest reports named waits with an end, such as a spring tide that reaches the chart office's copy.",
  "Both carried waits-for links to the high water mark, and that close woke both at once, so a link works on a held reading.",
  "Nothing linked them to the spring tide's reading.",
  "The gauge's one sweep came three minutes after the spring tide and listed five other readings.",
])}
${added("No sweep since: no row turned new, and a quiet sweep needs most of an hour after the harbour master's last request.", ["folded-marked"])}
<p><strong>What I infer, beyond the record</strong></p>
${items([
  "With held readings listed, the one sweep would have shown both as new rows, three minutes after the spring tide.",
  "With a link from both to the spring tide's reading, its close would have woken both at once.",
  "The stall came from the missing wake: the south pier read the right copy and waited just as long.",
])}
<p><strong>The reproduction</strong></p>
<pre><code>gauge replay --tide spring --readings north-pier,south-pier --hold neap --sweep 1 --show rows,links,wakes,holds</code></pre>`,
    },
    {
      summary: "Spec for the builder",
      body: `<p><strong>A. List held readings.</strong> Add a third row kind, held, to the gauge's list:</p>
<ol>
<li>A started reading with a hold the harbour master set, whose time is still ahead.</li>
<li>Fields: the pier, since when it was held, until when, the reason, and whether a tide ends it sooner.</li>
<li>New when it joins and at 1, 3 and 7 days, then weekly, like the other rows.</li>
<li>Update the gauge's manual and the harbour master's rule book.</li>
</ol>
<p><strong>B. Link held readings.</strong> A rule book change only; the mark is the harbour master's existing link.</p>
<ol>
<li>Where the harbour master holds a reading, it marks the reading the hold waits for.</li>
<li>Where the harbour master files a reading, it checks for held readings that the new reading's close ends, and links them.</li>
<li>No wake changes: the gauge already wakes every reading whose linked reading closes.</li>
</ol>
${added("C. Both: A and B as two changes, B first since it needs no new row kind.", ["marked", "folded-marked"])}`,
    },
  ];
}

/** The card's body as one version draws it: sections folded, or opened under their own headings. */
export function revisedCardBody(version: RevisedCardVersion): string {
  const head = `<p>${FIRST_WORDS} because its list of waiting readings leaves out every held reading, and nothing marked them as waiting for the spring tide.</p>
<p>I recommend both fixes: a mark wakes a held reading the moment its tide closes, and the list catches a missed mark.</p>
<fieldset>
  <legend>Which fix should make the gauge catch held readings?</legend>
  <label><input type="radio" name="fix" value="held-rows" required> List held readings on the gauge's list</label>
  <label><input type="radio" name="fix" value="link-waits" required> Link held readings to the reading that ends their wait</label>
  <label><input type="radio" name="fix" value="both" required data-inf-recommended> Both: link them, and list them as the backup</label>
  <label><input type="radio" name="fix" value="other" required data-inf-write-in> Something else</label>
</fieldset>
<fieldset>
  <legend>Also fix the second cause, the north pier reading the wrong copy of the tide table?</legend>
  <label><input type="checkbox" name="table-docs" value="yes" data-inf-recommended> Say in the manual which copy lists the spring tides</label>
</fieldset>`;
  const folded = version === "folded-marked";
  const drawn = sections(version)
    .map(({ summary, body }) =>
      folded
        ? `<details>\n<summary>${summary}</summary>\n${body}\n</details>`
        : `<h3>${summary}</h3>\n${body}`,
    )
    .join("\n");
  // The first version carries two lines the revisions remove, so the phone's revised line counts removed parts too.
  const removed =
    version === "first"
      ? paragraphs([
          "I have not yet read the chart office's copy of the tide table.",
          "I will say which copy each pier reads once I have.",
        ])
      : "";
  return `${head}\n${drawn}\n${removed}`;
}

/** The card's task and story, which each revision reuses. */
let raised: { taskId: string; cardId: string } | undefined;

const story = (version: RevisedCardVersion) => ({
  id: "tide-gauge-held-readings",
  title: TITLE,
  body: revisedCardBody(version),
  actions: [
    { id: "file-fix", label: "File it for later" },
    { id: "not-now", label: "Not now" },
    { id: "start-fix", label: "Start this fix", default: true },
  ],
});

/**
 * The phone cards-revised-scroll part's cards (INF-6865): a short first mate card, the crewmate's long decision as card
 * 2 of 3 with every section open, and a short third card. The captain has seen the decision, so each revision draws
 * its new parts marked.
 */
export async function raiseRevisedCard(core: Core) {
  await clearPhoneCards(core);
  const supervisor = core.services.supervisor;
  const cards = supervisor.cards;
  supervisor.addFirstmateCard({
    id: "revised-scroll-first",
    title: "The tide table is up to date",
    body: "<p>The harbour office posted this week's tide table.</p>",
    actions: [
      { id: "later", label: "Not now" },
      { id: "read", label: "Read it", default: true },
    ],
  });
  cards.closeOut({ kind: "firstmate" }, "turn-end");
  const gauge = seedTask(core.services.tasks, {
    id: "revised-scroll-gauge",
    title: TASK_TITLE,
    status: "idle",
  });
  const cardId = cards.emitCrewmateCard(
    gauge.id,
    story("first"),
    TASK_TITLE,
    "Opus 5.5",
    "on Mac mini",
  );
  cards.closeOut({ kind: "crewmate", taskId: gauge.id }, "idle");
  cards.seen(cardId, cards.shown(cardId)?.offerId ?? "");
  const notes = seedTask(core.services.tasks, {
    id: "revised-scroll-notices",
    title: "Check the harbour notices",
    status: "idle",
  });
  cards.emitCrewmateCard(
    notes.id,
    {
      id: "harbour-notices",
      title: "The harbour notices are ready to read",
      body: "<p>The notices for the next tide are ready.</p>",
      actions: [{ id: "ok", label: "Got it", default: true }],
    },
    notes.title,
    "Opus 5.5",
    "on Mac mini",
  );
  cards.closeOut({ kind: "crewmate", taskId: notes.id }, "idle");
  cards.flushBroadcast();
  raised = { taskId: gauge.id, cardId };
  return {
    title: TITLE,
    first: FIRST_WORDS,
    actions: story("first").actions.map((action) => action.id),
  };
}

/**
 * The crewmate revises the decision in place, after the captain saw its last version, to the version the control
 * request names as `{"version": ...}`.
 */
export function reviseRevisedCard(core: Core, said: string) {
  const { version } = JSON.parse(said) as { version: RevisedCardVersion };
  if (!raised) throw new Error("A revision of the revised-scroll card before the card");
  const cards = core.services.supervisor.cards;
  cards.seen(raised.cardId, cards.shown(raised.cardId)?.offerId ?? "");
  cards.emitCrewmateCard(
    raised.taskId,
    {
      ...story(version),
      reply:
        version === "folded-marked" ? "I folded each section." : "I added what the record shows.",
    },
    TASK_TITLE,
    "Opus 5.5",
    "on Mac mini",
  );
  cards.closeOut({ kind: "crewmate", taskId: raised.taskId }, "idle");
  cards.flushBroadcast();
  return { version };
}
