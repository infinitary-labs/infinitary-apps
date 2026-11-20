import { COMPLETION_CARD_HEADINGS } from "@shared/cardHeadings";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { describe, expect, it } from "vitest";
import { languageCompletionHeadings } from "../prompts/captainLanguage";
import { ABANDON, SAVE_AND_DEFER } from "../prompts/cardContract";
import {
  ANYTHING_ELSE_TAKEN_WORDS,
  type CardLintContext,
  COMPLETION_PICTURES_REFUSAL,
  closedTaskChoiceRefusal,
  crewmateOwesCompletionRefusal,
  ESCAPED_BODY_REFUSAL,
  lintCardShape,
  lintCrewmateCard,
  lintFirstmateCard,
  NOTE_NAMES_TASK_REFUSAL,
  PASSWORD_FIELD_REFUSAL,
  steerNotAnswerRefusal,
  UNMARKED_SKIP_WORDS,
  unknownRelatedRefusal,
  unmarkedSkippableQuestions,
  untaggedNewMarkRefusal,
  writeInGaps,
} from "./cardLint";
import { type EmittedCard, resolveFirstmateCardId } from "./cardTool";

/** The one settle effect a merge offer carries (cards/tasks/agents P1): the host resolves the posture. */
const MERGE = { kind: "merge", after: "close" } as const;
/** A merge offer as an action, for the cases that need one and nothing else. */
const MERGE_ACTION = { id: "merge", label: "Merge PR", default: true, effect: MERGE } as const;
/**
 * A completion decision as the crewmate lint reads it: the crewmate declares
 * the merge and the host writes the merge and discard pair before the lint
 * (`CrewmateCards.withCompletionActions`).
 */
const COMPLETION_PAIR = [
  MERGE_ACTION,
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
] as const;

/**
 * The v1.1 emit_card boundary lint (interaction P1 WI-11): every refusal is
 * corrective text naming the fix; a passing card returns undefined. The
 * shape rules run at both boundaries; the gates are the Firstmate's. The
 * fixtures follow the Sep 14 session: cards the v1 ban list refused that
 * were legitimate must pass, and since INF-484 move 5 so does the
 * 3,885-character "delivered" note: how long a card runs is its author's.
 */

function context(overrides: Partial<CardLintContext> = {}): CardLintContext {
  return {
    resolveCardId: resolveFirstmateCardId,
    ...overrides,
  };
}

function note(overrides: Partial<EmittedCard> = {}): EmittedCard {
  return {
    title: "Quota headroom",
    body: "Codex has 62% of the weekly window left.",
    actions: [],
    ...overrides,
  };
}

const PICTURE = '<img src="fm-card-picture://t/a.png" alt="the view">';

/** A well-shaped decision: one-sentence answer, evidence, one default. */
function decision(overrides: Partial<EmittedCard> = {}): EmittedCard {
  return {
    title: "Finish the auth refactor",
    body: "<p>The auth refactor is ready to merge.</p><p>CI is green on the head commit. https://github.com/x/y/pull/23</p>",
    actions: [
      { id: "wait", label: "Wait for the next release" },
      { id: "merge-pr", label: "Merge PR", default: true, effect: MERGE },
    ],
    ...overrides,
  };
}

/** The Sep 14 crewmate note that answered "what's our definition of delivered". */
const DELIVERED_NOTE = [
  "<p>Keep delivered. Neither idle nor waiting is a better stored status for a task whose crewmate stopped with work on its branch.</p>",
  ...Array.from(
    { length: 14 },
    (_, index) =>
      `<p>Finding ${index + 1}: closeRecord sets delivered when the crewmate stops, finish runs, and the worktree still holds the branch; the board then shows the row until someone lands, merges, or discards it, which is why the row lingers after the crewmate is gone.</p>`,
  ),
  "<p>Want me to file that as a follow-up, or is FI3-62 the right place?</p>",
].join("");

describe("figure text at the emit boundary", () => {
  const figure = (width: number, size: number) =>
    note({
      body: `<p>A diagram.</p><figure><svg viewBox="0 0 ${width} 200" width="100%"><text x="5" y="20" style="font-size:${size}px">Label</text></svg></figure>`,
    });

  it("refuses a 1000-unit 11 px figure at the usual column and names the repair", () => {
    const refusal = lintCrewmateCard(figure(1000, 11));
    expect(refusal).toMatch(/8\.3 px/);
    expect(refusal).toMatch(/750 units/);
    expect(refusal).toMatch(/pixel width/);
    expect(refusal).not.toMatch(/smaller viewBox/);
    expect(lintFirstmateCard(figure(1000, 11), context())).toMatch(/8\.3 px/);
  });

  it("accepts 11 px in a 750-unit drawing, and larger type in a wider drawing", () => {
    expect(lintCrewmateCard(figure(750, 11))).toBeUndefined();
    // 16 px in 1,000 units draws at 12 px in the usual column, so width alone is not refused.
    expect(lintCrewmateCard(figure(1000, 16))).toBeUndefined();
  });

  it("accepts a smaller drawing at its pixel width, and does not refuse one stretched to the column", () => {
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 350 200" width="350"><text style="font-size:11px">Pixel width</text></svg></figure>',
        }),
      ),
    ).toBeUndefined();
    // The floor does not refuse a smaller drawing at 100%; the bridge
    // caps it at its own units. Authors still use a pixel width for small drawings.
    expect(lintCrewmateCard(figure(350, 11))).toBeUndefined();
  });

  it("refuses type that falls under 11 px in the usual column, including a percentage width", () => {
    expect(lintCrewmateCard(figure(1000, 14))).toMatch(/10\.5 px/);
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 500 200" width="50%"><text style="font-size:14px">Half width</text></svg></figure>',
        }),
      ),
    ).toMatch(/under 11 px/);
  });

  it("does not blame an empty parent text element for a larger child label", () => {
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 1000 200" width="100%"><text><tspan style="font-size:24px">Large label</tspan></text></svg></figure>',
        }),
      ),
    ).toBeUndefined();
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 1000 200" width="100%"><text style="font-size:24px"><tspan style="font-size:11px">Small label</tspan></text></svg></figure>',
        }),
      ),
    ).toMatch(/under 11 px/);
  });

  it("includes inherited text and flowing foreignObject text, without rejecting picture-only figures", () => {
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 1000 200" width="100%" style="font-size:14px"><text>Inherited</text></svg></figure>',
        }),
      ),
    ).toMatch(/under 11 px/);
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 1000 200" width="100%"><foreignObject><p style="font-size:12px">Flowing</p></foreignObject></svg></figure>',
        }),
      ),
    ).toMatch(/under 11 px/);
    expect(
      lintCrewmateCard(
        note({
          body: '<figure><svg viewBox="0 0 720 200" width="100%"><path d="M0 0L5 5"/></svg></figure>',
        }),
      ),
    ).toBeUndefined();
  });
});

describe("lintCardShape (both boundaries)", () => {
  it("passes a decision with a one-sentence answer, evidence, and exactly one default", () => {
    expect(lintCardShape(decision())).toBeUndefined();
  });

  it("refuses a decision with no default, naming the fix", () => {
    const refusal = lintCardShape(
      decision({
        actions: [
          { id: "wait", label: "Wait" },
          { id: "merge-pr", label: "Merge PR", effect: MERGE },
        ],
      }),
    );
    expect(refusal).toMatch(/set default true on exactly one action/);
    // The fix never suggests explain-more as the default addition (v1.8).
    expect(refusal).not.toMatch(/explain.more/i);
  });

  it("refuses two defaults", () => {
    expect(
      lintCardShape(
        decision({
          actions: [
            { id: "wait", label: "Wait", default: true },
            { id: "merge-pr", label: "Merge PR", default: true, effect: MERGE },
          ],
        }),
      ),
    ).toMatch(/exactly one default, and this one marks 2 \(wait, merge-pr\)/);
  });

  it("leaves how a decision opens and where its evidence sits to its author (INF-484 move 5)", () => {
    // The Sep 15 completion cards led with two sentences and were refused
    // for it; E16 (INF-365) counted the cards refused for no lead paragraph
    // or no evidence after it. Each is the author's verdict, and shows.
    for (const body of [
      "<p>Merge it. CI is green and the diff is small.</p><ul><li>x</li></ul>",
      "<p>Merge the auth refactor.</p>",
      "<ul><li>a</li></ul>",
      "<h3>Auth</h3><p>Merge the refactor.</p><ul><li>CI green</li></ul>",
      "Merge the refactor.",
    ]) {
      expect(lintCardShape(decision({ body })), body).toBeUndefined();
    }
  });

  it("keeps the name of the app's own field's answer for that field (INF-680, INF-924)", () => {
    // The field's words ride the click as `anything_else`; an author's own
    // control or staged setting of that name would collide with them.
    for (const body of [
      '<p>Ship it?</p><label>Notes <textarea name="anything_else"></textarea></label>',
      '<p>Ship it?</p><input type="text" name="anything_else">',
      '<div data-inf-preview><script>inf.stage("anything_else", "{}")</script></div>',
    ]) {
      expect(lintCardShape(decision({ body })), body).toContain(ANYTHING_ELSE_TAKEN_WORDS);
    }
    // Another name, or a note with no buttons to send it, is the author's own.
    expect(
      lintCardShape(decision({ body: '<p>Ship it?</p><textarea name="notes"></textarea>' })),
    ).toBeUndefined();
    expect(
      lintCardShape(note({ body: '<p>Shipped.</p><textarea name="anything_else"></textarea>' })),
    ).toBeUndefined();
  });

  it("refuses an agent's own password field and points to the ask to keep a secret (INF-4239)", () => {
    // The captain on INF-4239: refuse an agent's own card that holds a
    // password field, and point the agent to the ask.
    for (const body of [
      '<p>Paste the key.</p><label>Key <input type="password" name="key"></label>',
      "<p>Paste the key.</p><INPUT TYPE='Password' name='key'>",
      '<p>Paste the key.</p><figure><script>const i=document.createElement("input");i.setAttribute("type","password");</script></figure>',
    ]) {
      expect(lintCardShape(decision({ body })), body).toBe(PASSWORD_FIELD_REFUSAL);
    }
    // Words about passwords, other fields and quoted markup are still allowed.
    for (const body of [
      '<p>The form reads:</p><pre><code>&lt;input type="password" name="key"&gt;</code></pre>',
      "<p>Set <code>type='password'</code> on the field.</p>",
    ]) {
      expect(lintCardShape(decision({ body })), body).not.toBe(PASSWORD_FIELD_REFUSAL);
    }
    expect(
      lintCardShape(
        decision({ body: '<p>Which password manager?</p><input type="text" name="manager">' }),
      ),
    ).not.toBe(PASSWORD_FIELD_REFUSAL);
  });

  it("names an entity-escaped body as such, never as a shape problem (v2.0)", () => {
    // The Sep 15 Claude crewmates sent exactly this and were told "the
    // decision's first paragraph has 3 sentences" four times running.
    const escaped =
      "&lt;p&gt;PR #140 fixes Observe's streaming transcript to auto-scroll.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;CI green.&lt;/li&gt;&lt;/ul&gt;";
    expect(lintCardShape(decision({ body: escaped }))).toBe(ESCAPED_BODY_REFUSAL);
    expect(lintCardShape(note({ body: escaped }))).toBe(ESCAPED_BODY_REFUSAL);
    expect(lintCardShape(decision({ body: "&lt;p&gt;Merge it.&lt;/p&gt;" }))).toBe(
      ESCAPED_BODY_REFUSAL,
    );
    // A literal tag inside real markup is a code sample, and renders as one.
    expect(
      lintCardShape(
        decision({ body: "<p>Use &lt;details&gt; for the rest.</p><ul><li>x</li></ul>" }),
      ),
    ).toBeUndefined();
    // Plain text with no tags at all is not escaped markup.
    expect(lintCardShape(note({ body: "Codex has 62% left; 3 &lt; 4." }))).toBeUndefined();
  });

  it("a card with an action is a decision, whatever it was meant as: it marks its default", () => {
    // One card shape (cards/tasks/agents P1): nothing declares "note", so a
    // fact that carries a next step is held to the decision rules.
    const leave = { id: "leave-it", label: "Leave it" };
    expect(lintCardShape(note({ actions: [{ id: "file-it", label: "File it" }, leave] }))).toMatch(
      /a decision marks the step you would take: set default true on exactly one action/,
    );
    expect(
      lintCardShape(
        note({
          body: "<p>Codex has 62% of the weekly window left.</p><ul><li>Pinning it keeps the pace.</li></ul>",
          actions: [{ id: "file-it", label: "File it", default: true }, leave],
        }),
      ),
    ).toBeUndefined();
  });

  describe("a decision gives 2 or 3 actions (CARD_MECHANICS)", () => {
    const actions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `choice-${index + 1}`,
        label: `Choice ${index + 1}`,
        ...(index === 0 ? { default: true } : {}),
      }));

    it("passes two or three, and a note gives none", () => {
      expect(lintCardShape(decision({ actions: actions(2) }))).toBeUndefined();
      expect(lintCardShape(decision({ actions: actions(3) }))).toBeUndefined();
      expect(lintCardShape(note())).toBeUndefined();
    });

    it("refuses one, naming the rule, the action and the fix", () => {
      // FI3-409's motion question: a radio question and a lone "Save this answer".
      const refusal = lintCardShape(
        decision({
          body: '<p>Reduced motion needs one answer.</p><fieldset><legend>When motion is reduced</legend><label><input type="radio" name="motion" value="instant" required data-inf-recommended> Instant reveal</label><label><input type="radio" name="motion" value="fade" required> Short fade</label></fieldset>',
          actions: [{ id: "save-answer", label: "Save this answer", default: true }],
        }),
      );
      expect(refusal).toContain(
        "a decision gives 2 or 3 actions, and this one gives 1 (save-answer)",
      );
      expect(refusal).toContain("add the other choice");
      expect(refusal).toContain("a note with no actions");
    });

    it("refuses four or more, naming each action", () => {
      const refusal = lintCardShape(decision({ actions: actions(4) }));
      expect(refusal).toContain(
        "a decision gives 2 or 3 actions, and this one gives 4 (choice-1, choice-2, choice-3, choice-4)",
      );
      expect(refusal).toContain("ask anything finer as a question in the body");
      expect(lintCardShape(decision({ actions: actions(6) }))).toContain("this one gives 6");
    });

    it("counts before the default, so one fix answers both", () => {
      expect(lintCardShape(decision({ actions: [{ id: "file-it", label: "File it" }] }))).toContain(
        "this one gives 1",
      );
    });

    it("holds a preview that offers a choice to it too", () => {
      const preview = "<style>.x{}</style><button data-inf-action='choice-1'>Pick</button>";
      expect(lintCardShape(decision({ body: preview, actions: actions(1) }))).toContain(
        "this one gives 1",
      );
      expect(lintCardShape(decision({ body: preview, actions: actions(2) }))).toBeUndefined();
    });

    it("applies at both boundaries, and a crewmate completion decision passes with the host's pair", () => {
      expect(lintFirstmateCard(decision({ actions: actions(1) }), context())).toContain(
        "a decision gives 2 or 3 actions",
      );
      expect(lintCrewmateCard(decision({ actions: actions(4) }))).toContain(
        "a decision gives 2 or 3 actions",
      );
      const outline = COMPLETION_CARD_HEADINGS.map(
        (heading) =>
          `<h3>${heading}</h3><p>Tests pass.</p>${heading === "Before" || heading === "After" ? PICTURE : ""}`,
      ).join("");
      // The crewmate declared only the merge; the host wrote the pair.
      expect(
        lintCrewmateCard(decision({ body: outline, actions: [...COMPLETION_PAIR] })),
      ).toBeUndefined();
      // One action the crewmate added beside the pair still fits; two do not.
      const own = actions(3).map(({ default: _default, ...action }) => action);
      expect(
        lintCrewmateCard(
          decision({
            body: outline,
            actions: [own[0], ...COMPLETION_PAIR] as EmittedCard["actions"],
          }),
        ),
      ).toBeUndefined();
      expect(
        lintCrewmateCard(
          decision({
            body: outline,
            actions: [own[0], own[1], ...COMPLETION_PAIR] as EmittedCard["actions"],
          }),
        ),
      ).toContain("this one gives 4 (choice-1, choice-2, merge, discard)");
      // INF-562: the host's Review carefully beside the pair is never the
      // author's choice, so the author's own action still fits.
      const careful = {
        id: "review-carefully",
        label: "Review carefully",
        care: "reviewed" as const,
      };
      expect(
        lintCrewmateCard(
          decision({
            body: outline,
            actions: [own[0], ...COMPLETION_PAIR, careful] as EmittedCard["actions"],
          }),
        ),
      ).toBeUndefined();
    });
  });

  it("shows the 3,885-character delivered note without headings: its length is its author's (INF-484 move 5)", () => {
    expect(
      lintCardShape(note({ title: "What delivered means", body: DELIVERED_NOTE })),
    ).toBeUndefined();
  });

  it("does not ban words: the Sep 14 cards the progress list refused now pass", () => {
    // #615, #633, #117: legitimate cards that merely said these words.
    for (const [title, body] of [
      [
        "The release script is in progress on main",
        "<p>Nothing to decide; it finishes on its own.</p>",
      ],
      [
        "What watching the run means",
        "<p>Watching the run is the crewmate's job until CI is green.</p>",
      ],
      [
        "Why the check is still pending",
        "<p>The package smoke job is still pending on the macOS runner.</p>",
      ],
    ] as const) {
      expect(lintCardShape(note({ title, body })), title).toBeUndefined();
    }
  });

  it("leaves the voice and the title's wording to the author (INF-484 move 5)", () => {
    // E16 (INF-365) counted cards refused for "!" and for an emoji; L3
    // refused a title led by a version. Each is the author's verdict, and shows.
    for (const card of [
      note({ body: "<p>Done!</p>" }),
      note({ title: "Quota 🎉" }),
      note({ title: "b45f6627 is green" }),
      note({ title: "PR 23" }),
    ]) {
      expect(lintCardShape(card), card.title).toBeUndefined();
    }
  });

  it("leaves a preview body to the frame, and still holds it to the action rules", () => {
    const prototype: EmittedCard = {
      title: "Course preview",
      body: "<style>.hold{color:#f00}</style><button data-inf-action='hold'>Hold</button>",
      actions: [
        { id: "hold", label: "Hold", default: true },
        { id: "turn", label: "Turn back" },
      ],
    };
    // A preview's controls carry its current settings, so the question
    // rules do not read it (isPreviewBody).
    const picked =
      '<fieldset><legend>Course</legend><label><input type="radio" name="course" value="north" required checked> North</label></fieldset>';
    expect(lintCardShape({ ...prototype, body: `${prototype.body}${picked}` })).toBeUndefined();
    // The decision rules still do - a preview that offers a choice marks one.
    expect(
      lintCardShape({
        ...prototype,
        actions: prototype.actions.map(({ default: _default, ...action }) => action),
      }),
    ).toMatch(/default true/);
    // A body of prose with the same question is still held to them.
    expect(lintCardShape({ ...prototype, body: `<p>Hold the course.</p>${picked}` })).toContain(
      'the required question "course" arrives already answered',
    );
  });

  it("holds a body whose scripts only move its figures to the question rules (FI3-796)", () => {
    const figure =
      '<figure aria-label="Ten runs after the fix, one more on each press">' +
      '<button type="button">Next run</button>' +
      '<svg viewBox="0 0 510 40" width="100%" role="img"><text x="0" y="20">10 of 10 passed</text></svg>' +
      "<script>(function(){if (shown !== total) step();})();</script></figure>";
    const moving: EmittedCard = {
      title: "Keep the queue fix",
      body: `<p>All ten runs passed after the fix.</p>${figure}`,
      actions: [
        { id: "revert", label: "Revert it" },
        { id: "keep", label: "Keep it", default: true },
      ],
    };
    expect(lintCardShape(moving)).toBeUndefined();
    // The question rules read it: a required question that arrives answered is refused.
    const answered =
      '<fieldset><legend>Ship it?</legend><label><input type="radio" name="ship" value="yes" required checked> Yes</label></fieldset>';
    expect(lintCardShape({ ...moving, body: `${moving.body}${answered}` })).toContain(
      'the required question "ship" arrives already answered',
    );
    // The same script outside its figure makes the body a preview again.
    expect(
      lintCardShape({
        ...moving,
        body: `${figure.replace(/<script>.*<\/script><\/figure>/, "</figure><script>step();</script>")}${answered}`,
      }),
    ).toBeUndefined();
  });

  describe("required choice questions arrive unpicked (contract 4.56)", () => {
    const LEAD =
      "<p>Pick who can see the report.</p><p>Every other report goes to the whole project weekly.</p>";
    const asking = (questions: string) =>
      decision({
        body: `${LEAD}${questions}`,
        actions: [
          { id: "defer", label: "Not now" },
          { id: "approve", label: "Approve", default: true },
        ],
      });
    const UNPICKED = [
      '<fieldset><legend>Who can see it?</legend><label><input type="radio" name="audience" value="me" required> Only me</label>',
      '<label><input type="radio" name="audience" value="project" data-inf-recommended> The whole project</label>',
      '<label><input type="radio" name="audience" value="other" data-inf-write-in> Something else</label></fieldset>',
      '<fieldset><legend>What should it include?</legend><label><input type="checkbox" name="include" value="summary" required data-inf-recommended> Summary</label></fieldset>',
      '<label for="often">How often?</label><select id="often" name="often" required><option value="">Choose</option><option value="weekly" data-inf-recommended>Weekly</option><option value="other" data-inf-write-in>Something else</option></select>',
    ].join("");

    it("passes required questions left unpicked with their recommendations marked", () => {
      expect(lintCardShape(asking(UNPICKED))).toBeUndefined();
      expect(lintCrewmateCard(asking(UNPICKED))).toBeUndefined();
    });

    it("refuses a required radio or checkbox written checked, naming the question and the fix", () => {
      const radio = lintCardShape(
        asking(UNPICKED.replace('value="project" data-inf-recommended', 'value="project" checked')),
      );
      expect(radio).toContain('the required question "audience" arrives already answered');
      expect(radio).toContain('"project" is checked');
      expect(radio).toContain("data-inf-recommended");
      expect(
        lintCardShape(
          asking(UNPICKED.replace('value="summary" required', 'value="summary" required checked')),
        ),
      ).toContain(
        'the required question "include" arrives already answered ("summary" is checked)',
      );
    });

    it("refuses a required select that opens on a value, marked or by default", () => {
      const marked = lintCardShape(
        asking(UNPICKED.replace('value="weekly" data-inf-recommended', 'value="weekly" selected')),
      );
      expect(marked).toContain(
        'the required question "often" arrives already answered ("weekly" is selected)',
      );
      expect(marked).toContain('<option value="">Choose</option>');
      // With no option marked, a dropdown picks its first enabled option by itself.
      const firstPicked = lintCardShape(
        asking(UNPICKED.replace('<option value="">Choose</option>', "")),
      );
      expect(firstPicked).toContain('"weekly" is selected');
      expect(
        lintCardShape(
          asking(
            UNPICKED.replace(
              '<option value="">Choose</option>',
              "<option disabled>Choose</option>",
            ),
          ),
        ),
      ).toContain('"weekly" is selected');
      // An option without a value attribute answers with its own words.
      expect(
        lintCardShape(
          asking(
            UNPICKED.replace(
              '<option value="">Choose</option><option value="weekly" data-inf-recommended>Weekly</option>',
              "<option>Weekly </option>",
            ),
          ),
        ),
      ).toContain('"Weekly" is selected');
    });

    it("leaves optional questions, text fields, disabled controls, notes and previews alone", () => {
      const optional = `<fieldset><legend>Also notify?</legend><label><input type="checkbox" name="notify" value="yes" checked> Notify the project</label></fieldset>`;
      const text = `<label>Title <input name="title" value="Weekly report" required></label><label>Notes <textarea name="notes" required>Keep it short</textarea></label>`;
      const disabled = `<label><input type="radio" name="locked" value="a" checked disabled required> Locked</label>`;
      const blank = `<label><input type="radio" name="none" value="" checked required> No answer</label>`;
      expect(
        lintCardShape(asking(`${UNPICKED}${optional}${text}${disabled}${blank}`)),
      ).toBeUndefined();
      const preanswered = UNPICKED.replace(
        'value="project" data-inf-recommended',
        'value="project" checked',
      );
      // A note sends nothing, so nothing it shows can be sent unread.
      expect(lintCardShape(note({ body: `${LEAD}${preanswered}` }))).toBeUndefined();
      // A preview keeps its settings: its controls are the thing being tuned.
      expect(
        lintCardShape(asking(`${preanswered}<script>document.body.dataset.ready = "1";</script>`)),
      ).toBeUndefined();
      // A name only one required control carries still makes the question required.
      expect(
        lintCardShape(
          asking(
            '<label><input type="radio" name="pace" value="slow" checked> Slow</label><label><input type="radio" name="pace" value="fast" required> Fast</label>',
          ),
        ),
      ).toContain('the required question "pace"');
    });
  });

  describe("every question with options offers Something else (FI3-1002)", () => {
    const LEAD =
      "<p>Settle who may write and what the report holds.</p><p>Each call changes what reaches the project.</p>";
    const asking = (body: string) =>
      decision({
        body: `${LEAD}${body}`,
        actions: [
          { id: "later", label: "Not now" },
          { id: "approve", label: "Approve", default: true },
        ],
      });
    const ROW = (type: string, name: string) =>
      `<label><input type="${type}" name="${name}" value="other" data-inf-write-in> Something else</label>`;
    const OPTION = '<option value="other" data-inf-write-in>Something else</option>';
    const radio = (row: string) =>
      [
        '<fieldset><legend>Which tasks can write?</legend><label><input type="radio" name="writes" value="shipping" data-inf-recommended> Tasks that ship a change</label>',
        `<label><input type="radio" name="writes" value="any"> Any task</label>${row}</fieldset>`,
      ].join("");
    const select = (option: string) =>
      `<label for="often">How often?</label><select id="often" name="often"><option value="">Choose</option><option value="weekly" data-inf-recommended>Weekly</option>${option}</select>`;
    const checkboxes = (row: string) =>
      [
        '<fieldset><legend>What should it include?</legend><label><input type="checkbox" name="include" value="summary"> Summary</label>',
        `<label><input type="checkbox" name="include" value="links"> Links</label>${row}</fieldset>`,
      ].join("");
    const ASKED = `${radio(ROW("radio", "writes"))}${select(OPTION)}${checkboxes(ROW("checkbox", "include"))}`;

    it("passes radio, select and checkbox questions that each end with a Something else row", () => {
      expect(writeInGaps(ASKED)).toEqual([]);
      expect(lintCardShape(asking(ASKED))).toBeUndefined();
      expect(lintCrewmateCard(asking(ASKED))).toBeUndefined();
    });

    it("refuses each kind of question without one, naming the question and the row to add", () => {
      const refusal = lintCardShape(asking(radio("")));
      expect(refusal).toContain('the question "writes" offers options with no Something else row');
      expect(refusal).toContain(ROW("radio", "writes"));
      expect(refusal).toContain("data-inf-options-only");
      const dropdown = lintCardShape(asking(select("")));
      expect(dropdown).toContain('the question "often" offers options with no Something else row');
      expect(dropdown).toContain(OPTION);
      expect(lintCardShape(asking(checkboxes("")))).toContain(ROW("checkbox", "include"));
      expect(writeInGaps(`${radio("")}${select("")}${checkboxes("")}`)).toMatchObject([
        { name: "writes", control: "radio" },
        { name: "often", control: "select" },
        { name: "include", control: "checkbox" },
      ]);
    });

    it("passes a question its author marks as options only, on its fieldset or its select", () => {
      const marked = radio("").replace("<fieldset>", "<fieldset data-inf-options-only>");
      const dropdown = select("").replace("<select ", "<select data-inf-options-only ");
      expect(lintCardShape(asking(`${marked}${dropdown}`))).toBeUndefined();
      // The mark belongs to the question: on another element it opts nothing out.
      expect(writeInGaps(`<p data-inf-options-only>Pick one.</p>${radio("")}`)).toMatchObject([
        { name: "writes", control: "radio" },
      ]);
    });

    it("reads the marks in Firstmate 3000's spelling too, as a crewmate told them before the rename writes them", () => {
      const older = (body: string) => body.replaceAll("data-inf-", "data-fm-");
      expect(writeInGaps(older(ASKED))).toEqual([]);
      const marked = radio("").replace("<fieldset>", "<fieldset data-fm-options-only>");
      expect(lintCardShape(asking(marked))).toBeUndefined();
    });

    it("leaves a lone checkbox, text fields, disabled questions, notes and previews alone", () => {
      const lone =
        '<label><input type="checkbox" name="notify" value="yes"> Notify the project</label>';
      const text =
        '<label>Title <input name="title" value="Weekly report"></label><label>Notes <textarea name="notes"></textarea></label>';
      const disabled =
        '<fieldset disabled><legend>Locked</legend><label><input type="radio" name="locked" value="a"> A</label></fieldset><label><input type="radio" name="off" value="b" disabled> B</label>';
      expect(lintCardShape(asking(`${lone}${text}${disabled}`))).toBeUndefined();
      // A note sends nothing, and a preview's controls are the thing being tuned.
      expect(lintCardShape(note({ body: `${LEAD}${radio("")}` }))).toBeUndefined();
      expect(
        lintCardShape(asking(`${radio("")}<script>document.body.dataset.ready = "1";</script>`)),
      ).toBeUndefined();
    });
  });

  describe("a question the captain may skip marks the option a skip sends (INF-4425)", () => {
    const LEAD = "<p>Settle how the weekly report goes out.</p>";
    const asking = (body: string) =>
      decision({
        body: `${LEAD}${body}`,
        actions: [
          { id: "later", label: "Not now" },
          { id: "approve", label: "Approve", default: true },
        ],
      });
    const width = (mark: string, required = "") =>
      [
        `<fieldset data-inf-options-only><legend>How wide is the table?</legend><label><input type="radio" name="width" value="wide"${mark}${required}> Wide</label>`,
        '<label><input type="radio" name="width" value="narrow"> Narrow</label></fieldset>',
      ].join("");
    const send = (mark: string) =>
      `<label for="send">When does it go out?</label><select id="send" name="send" data-inf-options-only><option value="">Choose</option><option value="friday"${mark}>Friday</option><option value="monday">Monday</option></select>`;

    it("passes skippable radio and select questions that mark an option", () => {
      const body = `${width(" data-inf-recommended")}${send(" data-inf-recommended")}`;
      expect(unmarkedSkippableQuestions(body)).toEqual([]);
      expect(lintCardShape(asking(body))).toBeUndefined();
    });

    it("refuses a skippable radio or select question that marks none, naming both fixes", () => {
      const refusal = lintCardShape(asking(width("")));
      expect(refusal).toContain(`the question "width" ${UNMARKED_SKIP_WORDS}`);
      expect(refusal).toContain("put data-inf-recommended on the option");
      expect(refusal).toContain("add required to the question");
      expect(lintCardShape(asking(send("")))).toContain(
        `the question "send" ${UNMARKED_SKIP_WORDS}`,
      );
    });

    it("passes a required question, one that arrives answered, checkboxes, notes and previews", () => {
      const required = width("", " required");
      const answered = width(" checked");
      const opensOnAnOption = send("").replace('<option value="">Choose</option>', "");
      const checkboxes =
        '<fieldset data-inf-options-only><legend>What goes in?</legend><label><input type="checkbox" name="include" value="summary"> Summary</label><label><input type="checkbox" name="include" value="charts"> Charts</label></fieldset>';
      expect(unmarkedSkippableQuestions(`${required}${opensOnAnOption}${checkboxes}`)).toEqual([]);
      expect(unmarkedSkippableQuestions(answered)).toEqual([]);
      expect(lintCardShape(note({ body: `${LEAD}${width("")}` }))).toBeUndefined();
      expect(
        lintCardShape(asking(`${width("")}<script>document.body.dataset.ready = "1";</script>`)),
      ).toBeUndefined();
    });
  });
});

describe("lintCrewmateCard", () => {
  it("refuses the host's own effect: the agent-down cards are the app's, never a crewmate's", () => {
    expect(
      lintCrewmateCard(
        decision({
          actions: [
            {
              id: "retry",
              label: "Retry",
              default: true,
              effect: {
                kind: "host",
                op: "retry-firstmate",
              } as unknown as EmittedCard["actions"][number]["effect"],
            },
          ],
        }),
      ),
    ).toMatch(/carries a host effect, which only the app's own cards may/);
  });

  describe("the completion outline (contract v4.37)", () => {
    const section = (heading: string) =>
      `<h3>${heading}</h3><p>Task-specific content.</p>${heading === "Before" || heading === "After" ? PICTURE : ""}`;
    const outline = COMPLETION_CARD_HEADINGS.map(section).join("");
    const completion = (body: string) => decision({ body, actions: [...COMPLETION_PAIR] });

    it("accepts four sections opening at Why, without an answer paragraph before them", () => {
      expect(lintCrewmateCard(completion(outline))).toBeUndefined();
      // Extra headings, a list, a figure and closing details impose no recipe.
      expect(
        lintCrewmateCard(
          completion(
            outline +
              '<h4>Evidence</h4><ul><li>A check</li></ul><figure><svg viewBox="0 0 510 10"></svg></figure><details><summary>Remaining work</summary>None.</details>',
          ),
        ),
      ).toBeUndefined();
      expect(lintCrewmateCard(completion(outline.replace("Why", "<em>why</em>")))).toBeUndefined();
    });

    it("shows a saved story's conventional breaking marker (INF-470, INF-484 move 5)", () => {
      for (const title of ["fix!: correct the story", "fix(cards)!: correct the story"]) {
        expect(lintCrewmateCard({ ...completion(outline), title })).toBeUndefined();
      }
    });

    it.each(COMPLETION_CARD_HEADINGS)(
      "names the first missing heading, %s, and the repair",
      (heading) => {
        const refusal = lintCrewmateCard(completion(outline.replace(section(heading), "")));
        expect(refusal).toContain(`"${heading}"`);
        expect(refusal).toContain(COMPLETION_CARD_HEADINGS.join(", "));
      },
    );

    // INF-3674's approved plan: the crew writes to the captain in the
    // captain's language, so the check accepts the catalog's headings in the
    // language the app speaks. The en-XA pseudo-language is compiled from the
    // real catalog, so its headings are the catalog's own translation.
    it("accepts the headings in the language the app speaks, and names them when one is missing", () => {
      setCurrentLanguage("en-XA");
      try {
        const translated = languageCompletionHeadings();
        expect(translated).not.toEqual([...COMPLETION_CARD_HEADINGS]);
        const local = (heading: string, index: number) =>
          `<h3>${heading}</h3><p>Task-specific content.</p>${index >= 2 ? PICTURE : ""}`;
        expect(lintCrewmateCard(completion(translated.map(local).join("")))).toBeUndefined();
        // English stays accepted beside it.
        expect(lintCrewmateCard(completion(outline))).toBeUndefined();
        // The picture rule reads the translated Before and After sections.
        const pictureless = translated.map((heading) => `<h3>${heading}</h3><p>Text.</p>`).join("");
        expect(lintCrewmateCard(completion(pictureless))).toBe(COMPLETION_PICTURES_REFUSAL);
        const refusal = lintCrewmateCard(
          completion(
            translated
              .filter((_, index) => index !== 1)
              .map(local)
              .join(""),
          ),
        );
        expect(refusal).toContain(`"${COMPLETION_CARD_HEADINGS[1]}"`);
        expect(refusal).toContain(translated.join(", "));
      } finally {
        setCurrentLanguage(SOURCE_LANGUAGE);
      }
    });

    it("refuses out-of-order headings and does not mistake prose or scripted headings for sections", () => {
      expect(
        lintCrewmateCard(
          completion(["Why", "Before", "What changed", "After"].map(section).join("")),
        ),
      ).toContain('"Before"');
      expect(
        lintCrewmateCard(completion("<p>Why, What changed, Before, After.</p><p>All done.</p>")),
      ).toContain('"Why"');
      for (const tag of ["script", "style", "template"]) {
        expect(
          lintCrewmateCard(
            completion(`<${tag}>${outline}</${tag}><p>All done.</p><p>Checked.</p>`),
          ),
        ).toContain('"Why"');
      }
    });

    it("scopes the check to a crewmate's declared settle merge, not an id or other card shape", () => {
      const body = "<p>Answer first.</p><p>Evidence next.</p>";
      expect(lintCrewmateCard(completion(body))).toContain('"Why"');
      expect(lintCrewmateCard(note({ body }))).toBeUndefined();
      expect(
        lintCrewmateCard(
          decision({
            body,
            actions: [
              { id: "ship", label: "Build it", default: true },
              { id: "hold", label: "Hold" },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(
        lintCrewmateCard(
          decision({
            body,
            actions: [
              {
                id: "discard",
                label: "Discard",
                default: true,
                effect: { kind: "settle", mode: "discard" },
              },
              { id: "hold", label: "Hold" },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(
        lintCrewmateCard(
          decision({
            body: "<style>button { color: red; }</style><button>Preview</button>",
            actions: [
              { id: "build", label: "Build this", default: true },
              { id: "hold", label: "Hold" },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(lintFirstmateCard({ ...completion(body), taskId: "t91" }, context())).toBeUndefined();
      expect(
        lintCrewmateCard(completion(`${outline}<style>p { margin: 0; }</style>`)),
      ).toBeUndefined();
    });

    it("accepts INF-467's new outline only for a host-validated saved story", () => {
      const body =
        "<h3>Why</h3><p>Six cards drew the recommended button first.</p><h3>What changed</h3><ul><li>The default is at the right edge.</li></ul><h3>Before and after</h3><p>Before: the default was first. After: it is last.</p><h3>Checked</h3><ul><li>The six card pictures show the default at the right edge.</li></ul>";
      expect(lintCrewmateCard(completion(body), { tieredStory: true })).toBeUndefined();
      expect(lintCrewmateCard(completion(body))).toContain('"Before" heading');
      expect(
        lintCrewmateCard(completion(body.replace("<h3>Checked</h3>", "")), { tieredStory: true }),
      ).toContain('"Checked" heading');
    });

    describe("pictures (contract v4.69)", () => {
      const heading = (name: string, content: string) =>
        `<h3>${name}</h3><p>One sentence.</p>${content}`;
      const body = (before: string, after: string, extra = "") =>
        heading("Why", "") +
        heading("What changed", "") +
        heading("Before", before) +
        heading("After", after) +
        extra;
      const MARKED = `<figure data-inf-new>${PICTURE}</figure>`;

      it("passes pictures in both sections, one or several in each", () => {
        expect(lintCrewmateCard(completion(body(PICTURE, PICTURE)))).toBeUndefined();
        expect(
          lintCrewmateCard(
            completion(
              body(
                PICTURE + PICTURE,
                `<figure class="fm-pictures">${PICTURE}${PICTURE}${PICTURE}</figure>`,
              ),
            ),
          ),
        ).toBeUndefined();
      });

      it("passes new views with no Before picture, alone or mixed with changed ones", () => {
        expect(lintCrewmateCard(completion(body("", MARKED)))).toBeUndefined();
        expect(lintCrewmateCard(completion(body("", MARKED + MARKED)))).toBeUndefined();
        expect(lintCrewmateCard(completion(body(PICTURE, PICTURE + MARKED)))).toBeUndefined();
      });

      it("passes the mark on any element that holds the picture and can draw the New tag", () => {
        for (const holder of ["picture", "div", "p", "a"]) {
          const marked = `<${holder} data-inf-new>${PICTURE}</${holder}>`;
          expect(lintCrewmateCard(completion(body("", marked))), holder).toBeUndefined();
        }
        const group = `<figure class="fm-pictures" data-inf-new>${PICTURE}${PICTURE}</figure>`;
        expect(lintCrewmateCard(completion(body("", group)))).toBeUndefined();
      });

      it("refuses the mark on the picture itself, where no New tag can be drawn, and names the figure", () => {
        const onPicture = `<figure><img data-inf-new src="x.png" alt="new"></figure>`;
        expect(lintCrewmateCard(completion(body("", onPicture)))).toBe(
          untaggedNewMarkRefusal("img"),
        );
        // Before pictures of other views do not let it through.
        expect(lintCrewmateCard(completion(body(PICTURE, PICTURE + onPicture)))).toBe(
          untaggedNewMarkRefusal("img"),
        );
        expect(untaggedNewMarkRefusal("img")).toContain("<figure>");
        for (const element of ["svg", "video", "canvas"]) {
          const drawing = `<figure><${element} data-inf-new width="100" height="40"></${element}></figure>`;
          expect(lintCrewmateCard(completion(body(PICTURE, PICTURE + drawing))), element).toBe(
            untaggedNewMarkRefusal(element),
          );
        }
      });

      it("refuses the mark on the picture itself on every crewmate card, at every care level", () => {
        const misplaced = body("", `<img data-inf-new src="x.png" alt="new">`);
        expect(lintCrewmateCard(completion(misplaced), { rigor: "quick" })).toBe(
          untaggedNewMarkRefusal("img"),
        );
        expect(lintCrewmateCard(note({ body: misplaced }))).toBe(untaggedNewMarkRefusal("img"));
        expect(
          lintCrewmateCard(note({ body: body("", `<template><img data-inf-new></template>`) })),
        ).toBeUndefined();
      });

      it("refuses an unmarked After picture with no Before picture", () => {
        expect(lintCrewmateCard(completion(body("", PICTURE)))).toBe(COMPLETION_PICTURES_REFUSAL);
        expect(lintCrewmateCard(completion(body("", PICTURE + MARKED)))).toBe(
          COMPLETION_PICTURES_REFUSAL,
        );
      });

      it("refuses a card with no After picture, even with a Before picture", () => {
        expect(lintCrewmateCard(completion(body("", "")))).toBe(COMPLETION_PICTURES_REFUSAL);
        expect(lintCrewmateCard(completion(body(PICTURE, "")))).toBe(COMPLETION_PICTURES_REFUSAL);
      });

      it("counts a picture under the heading it follows, not elsewhere on the card", () => {
        expect(lintCrewmateCard(completion(body("", "", PICTURE)))).toBe(
          COMPLETION_PICTURES_REFUSAL,
        );
        expect(lintCrewmateCard(completion(PICTURE + body("", "")))).toBe(
          COMPLETION_PICTURES_REFUSAL,
        );
      });

      it("takes one sentence with words in an element marked data-inf-no-picture", () => {
        const reason = "<p data-inf-no-picture>Only a macOS notification changed.</p>";
        expect(lintCrewmateCard(completion(body("", reason)))).toBeUndefined();
        expect(lintCrewmateCard(completion(body("", "<p data-inf-no-picture> </p>")))).toBe(
          COMPLETION_PICTURES_REFUSAL,
        );
      });

      it("names all three ways in the one refusal", () => {
        expect(COMPLETION_PICTURES_REFUSAL).toContain("Before");
        expect(COMPLETION_PICTURES_REFUSAL).toContain("data-inf-new");
        expect(COMPLETION_PICTURES_REFUSAL).toContain("data-inf-no-picture");
      });

      it("does not run for a Quick task, and does run for the other tiers or an unstamped task", () => {
        const bare = completion(body("", ""));
        expect(lintCrewmateCard(bare, { rigor: "quick" })).toBeUndefined();
        expect(lintCrewmateCard(bare, { rigor: "standard" })).toBe(COMPLETION_PICTURES_REFUSAL);
        expect(lintCrewmateCard(bare, { rigor: "reviewed" })).toBe(COMPLETION_PICTURES_REFUSAL);
        expect(lintCrewmateCard(bare, {})).toBe(COMPLETION_PICTURES_REFUSAL);
      });

      it("leaves a note with no merge action alone", () => {
        expect(lintCrewmateCard(note({ body: body("", "") }))).toBeUndefined();
      });
    });

    it("still names malformed markup and decision defects before the outline", () => {
      expect(
        lintCrewmateCard(completion(outline.replace(/</g, "&lt;").replace(/>/g, "&gt;"))),
      ).toBe(ESCAPED_BODY_REFUSAL);
      expect(
        lintCrewmateCard(
          decision({
            body: outline,
            actions: [{ ...MERGE_ACTION, default: false }, COMPLETION_PAIR[1]],
          }),
        ),
      ).toMatch(/default true on exactly one action/);
    });
  });
});

describe("lintFirstmateCard", () => {
  it("INF-2714: a note is the first mate's own card, naming its tasks only in related, apart from a review relay", () => {
    // The captain's direction A: an answer that names a task as its own
    // took that task's head, origin line and question life (card-fm-12).
    const known = context({ taskExists: (id) => id === "ab12cd34", taskResolves: () => true });
    expect(lintFirstmateCard(note(), known)).toBeUndefined();
    expect(lintFirstmateCard(note({ relatedTaskIds: ["ab12cd34", "INF-2711"] }), known)).toBe(
      undefined,
    );
    expect(lintFirstmateCard(note({ taskId: "ab12cd34" }), known)).toBe(NOTE_NAMES_TASK_REFUSAL);
    // Revising a card already on the task, such as the app's required-action
    // card, keeps its task; adding a task to another card does not.
    const onTask = context({
      taskExists: () => true,
      openCardOnTask: (cardId, taskId) => cardId === "card-fm-required" && taskId === "ab12cd34",
    });
    expect(lintFirstmateCard(note({ id: "required", taskId: "ab12cd34" }), onTask)).toBe(undefined);
    expect(lintFirstmateCard(note({ id: "other", taskId: "ab12cd34" }), onTask)).toBe(
      NOTE_NAMES_TASK_REFUSAL,
    );
    // A review's findings stay on the builder's task.
    expect(lintFirstmateCard(note({ taskId: "ab12cd34", reviewTaskId: "rv01" }), known)).toBe(
      undefined,
    );
    // A related task must name a record.
    expect(
      lintFirstmateCard(
        note({ relatedTaskIds: ["INF-9999"] }),
        context({ taskResolves: (ref) => ref !== "INF-9999" }),
      ),
    ).toBe(unknownRelatedRefusal("INF-9999"));
    // A decision without a task_id becomes its own decision task, so only a
    // note is held to attach-first; the retired prototype kind was too.
    const prototype: EmittedCard = {
      title: "Course preview",
      body: "<button data-inf-action='hold'>Hold</button><script>wire();</script>",
      actions: [
        { id: "hold", label: "Hold", default: true },
        { id: "turn", label: "Turn back" },
      ],
    };
    expect(lintFirstmateCard(prototype, context())).toBeUndefined();
  });

  it("attach first: a task_id must name a record when the boundary can check", () => {
    const card = decision({ taskId: "nope" });
    expect(lintFirstmateCard(card, context({ taskExists: () => false }))).toMatch(
      /unknown task_id "nope"/,
    );
    // No record to check against (a boundary without a task store) trusts the id.
    expect(lintFirstmateCard(card, context())).toBeUndefined();
  });

  it("a closed task takes a note but no choice, because the click would refuse it", () => {
    const closed = context({ taskExists: () => true, taskClosed: (id) => id === "36410f14" });
    const build = decision({
      taskId: "36410f14",
      actions: [
        { id: "build-now", label: "Build it now", default: true },
        { id: "leave-it", label: "Leave it" },
      ],
    });
    expect(lintFirstmateCard(build, closed)).toBe(closedTaskChoiceRefusal("36410f14"));
    expect(closedTaskChoiceRefusal("36410f14")).toMatch(
      /create_task, with basis 36410f14.*without task_id.*basis 36410f14/,
    );
    expect(
      lintFirstmateCard(note({ taskId: "36410f14", reviewTaskId: "rv01" }), closed),
    ).toBeUndefined();
    // An open task still takes the same decision.
    expect(lintFirstmateCard({ ...build, taskId: "ab12cd34" }, closed)).toBeUndefined();
  });

  it("runs the shape rules after the gates", () => {
    expect(lintFirstmateCard(note(), context())).toBeUndefined();
    expect(
      lintFirstmateCard(
        decision({
          taskId: undefined,
          actions: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        }),
        context(),
      ),
    ).toMatch(/default true/);
  });

  it("a settle effect passes on any posture with no CI gate and no PR-link rule (v2.0, ruling D3)", () => {
    // The Firstmate never authors a merge card for a crewmate's task now,
    // and a settle card's CI state, PR link, repo, branch and posture are
    // the host's to write, so the boundary asks for none of them.
    const base = decision({
      taskId: "ab12cd34",
      body: "<p>Land it.</p><ul><li>The branch is green locally.</li></ul>",
    });
    const land = [
      { id: "land", label: "Land locally", default: true, effect: MERGE },
      { id: "wait", label: "Wait" },
    ];
    expect(lintFirstmateCard(base, context())).toBeUndefined();
    expect(lintFirstmateCard({ ...base, actions: land }, context())).toBeUndefined();
    expect(
      lintFirstmateCard(
        {
          ...base,
          actions: [
            { id: "keep-open", label: "Keep it open", default: true },
            { id: "close-it", label: "Close it" },
          ],
        },
        context(),
      ),
    ).toBeUndefined();
  });

  it("refuses a merge-looking action that carries no merge effect (INF-2744)", () => {
    // The live regression: every Merge PR card ever emitted used a per-PR
    // id like "merge-pr55" and no task_id, so act() fell through to the
    // steer branch and no PR was ever merged. With effects on the wire the
    // host dispatches on nothing else, so a merge-shaped id or label that
    // declares none is a button that would run nothing.
    const base = decision({ taskId: "ab12cd34" });
    const ctx = context();
    for (const id of ["merge-pr55", "merge_pr", "mergepr55", "land-it", "land2"]) {
      const refusal = lintFirstmateCard(
        { ...base, actions: [{ id, label: "Merge PR 55", default: true }] },
        ctx,
      );
      expect(refusal, id).toMatch(/reads like a merge but carries no merge effect/);
    }
    // The label alone is a claim too.
    expect(
      lintFirstmateCard(
        { ...base, actions: [{ id: "ship", label: "Merge it now", default: true }] },
        ctx,
      ),
    ).toMatch(/reads like a merge but carries no merge effect/);
    // An action that declares its settle passes under any id, and an
    // unrelated reply is untouched - this is a consistency check, not a ban.
    expect(
      lintFirstmateCard(
        {
          ...base,
          actions: [
            { id: "merge-pr55", label: "Merge PR 55", default: true, effect: MERGE },
            { id: "leave-pr55", label: "Leave it open" },
            { id: "landing-page", label: "Open the landing page" },
          ],
        },
        ctx,
      ),
    ).toBeUndefined();
  });

  it("refuses a settle effect that omits task_id", () => {
    // Without task_id every taskId-scoped gate below silently skips and
    // act() cannot resolve a task, so the button does nothing.
    for (const id of ["merge-pr", "land"]) {
      const refusal = lintFirstmateCard(
        decision({ actions: [{ id, label: "Merge PR", default: true, effect: MERGE }] }),
        context(),
      );
      expect(refusal, id).toMatch(/must pass task_id/);
    }
  });

  it("a plan choice on a PR task passes as before, and so does a merge offer without a link (v2.0)", () => {
    // Sep 14 #449: a plan choice on a direct-pr task was refused for lacking a link.
    expect(
      lintFirstmateCard(
        decision({
          taskId: "ab12cd34",
          title: "Drop the PR 89 follow-ups so it can merge",
          body: "<p>Drop the two on-request children so the parent can close.</p><ul><li>Both are unstarted.</li></ul>",
          actions: [
            { id: "drop-children", label: "Drop them", default: true },
            { id: "keep-children", label: "Keep them" },
          ],
        }),
        context(),
      ),
    ).toBeUndefined();
    expect(
      lintFirstmateCard(
        decision({
          taskId: "ab12cd34",
          body: "<p>The auth refactor is ready to merge.</p><p>CI is green.</p>",
        }),
        context(),
      ),
    ).toBeUndefined();
  });

  // INF-2214's approved shared cards: the refusal names the crewmate's card
  // as the place to write, by revision or by reply, instead of a second card.
  it("WI-12: refuses a card on a task its crewmate already carded, naming the card to write on", () => {
    const crew = { id: "card-t58-3", title: "PR 58 is merged" };
    const ctx = context({
      openCrewmateCard: (taskId) => (taskId === "t58" ? crew : undefined),
      isOpenFirstmateCard: (cardId) => cardId === "card-fm-7-abc123",
    });
    // A note names the task it answers about in related (INF-2714).
    const answer = note({
      relatedTaskIds: ["t58"],
      title: "PR 58 merged",
      body: "<p>It merged.</p>",
    });
    const refusal = lintFirstmateCard(answer, ctx);
    expect(refusal).toBe(steerNotAnswerRefusal("t58", crew));
    expect(refusal).toContain("emit_card with id card-t58-3");
    expect(refusal).toContain("expected_revision");
    // A decision acting on that task is held the same way.
    expect(lintFirstmateCard(decision({ taskId: "t58" }), ctx)).toBe(
      steerNotAnswerRefusal("t58", crew),
    );
    // A decision naming that task is turned away too, by its related list or
    // beside its own task (the captain on INF-2738: "The first mate's card is
    // turned away when it names that task").
    const choice = [
      { id: "retry", label: "Retry", default: true },
      { id: "drop", label: "Drop" },
    ];
    expect(lintFirstmateCard(decision({ relatedTaskIds: ["t58"], actions: choice }), ctx)).toBe(
      steerNotAnswerRefusal("t58", crew),
    );
    expect(
      lintFirstmateCard(decision({ taskId: "t77", relatedTaskIds: ["t58"], actions: choice }), ctx),
    ).toBe(steerNotAnswerRefusal("t58", crew));
    // A task without a crewmate card on screen is the Firstmate's to answer.
    expect(lintFirstmateCard({ ...answer, relatedTaskIds: ["t77"] }, ctx)).toBeUndefined();
    expect(
      lintFirstmateCard(decision({ relatedTaskIds: ["t77"], actions: choice }), ctx),
    ).toBeUndefined();
    // Revising the Firstmate's own open card on that task is not a second answer.
    expect(lintFirstmateCard({ ...answer, id: "card-fm-7-abc123" }, ctx)).toBeUndefined();
    // A revision of its own card on another task that names the carded task
    // is read against the card's own task (review INF-2881).
    const onTask = context({
      openCrewmateCard: (taskId) => (taskId === "t58" ? crew : undefined),
      isOpenFirstmateCard: (cardId, taskId) => cardId === "card-fm-8-def456" && taskId === "t77",
    });
    const revisedChoice = decision({
      id: "card-fm-8-def456",
      taskId: "t77",
      relatedTaskIds: ["t58"],
      actions: choice,
    });
    expect(lintFirstmateCard(revisedChoice, onTask)).toBeUndefined();
    expect(lintFirstmateCard({ ...revisedChoice, id: "card-fm-9-aaa111" }, onTask)).toBe(
      steerNotAnswerRefusal("t58", crew),
    );
  });

  it("v3.6: refuses a merge card while the task's own crewmate still owes its merge card (INF-2744)", () => {
    // The Sep 19 defect this exists for: after each of four reviews passed,
    // the Firstmate steered the crewmate to emit its completion card AND
    // emitted its own merge card in the same turn, so the captain got two
    // merge cards per task. WI-12 did not catch it - the crewmate's card was
    // not on screen yet, because the Firstmate got there first.
    const ctx = context({ crewmateOwesCompletion: (taskId) => taskId === "t91" });
    const merge = decision({ taskId: "t91", actions: [...COMPLETION_PAIR] });
    // INF-2744: the words are the refusal's own owner's; the merge card is
    // still the crewmate's to emit.
    expect(lintFirstmateCard(merge, ctx)).toBe(crewmateOwesCompletionRefusal("t91"));
    expect(crewmateOwesCompletionRefusal("t91")).toContain("steer_crewmate");
    // Once the crewmate has emitted it, a settle refusal's ways out are a
    // legitimate Firstmate card on the same task.
    expect(lintFirstmateCard({ ...merge, taskId: "t92" }, ctx)).toBeUndefined();
    // An answer that carries no settle effect is never the merge decision.
    expect(
      lintFirstmateCard(
        decision({
          taskId: "t91",
          title: "Where t91 stands",
          body: "<p>Its review passed.</p>",
          actions: [
            { id: "wait", label: "Wait for it", default: true },
            { id: "drop", label: "Drop it" },
          ],
        }),
        ctx,
      ),
    ).toBeUndefined();
  });
});

describe("ready-plan buttons", () => {
  it("leaves a ready plan's button labels to its author (INF-484 move 5)", () => {
    // E16 (INF-365) counted a ready plan refused for its own start label.
    expect(
      lintCrewmateCard(
        decision({
          actions: [
            { id: "build", label: "Build it", default: true },
            { id: "later", label: SAVE_AND_DEFER },
            { id: "drop", label: ABANDON },
          ],
        }),
      ),
    ).toBeUndefined();
  });
});
