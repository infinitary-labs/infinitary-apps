import { describe, expect, it } from "vitest";
import { LEGACY_CLOSE_CONTROL_IDS } from "./cardLeave";
import {
  agentEffectSchema,
  type Card,
  cardPresentation,
  cardSchema,
  cardsSnapshotSchema,
  cardTakesReplies,
  cardWord,
  compareStack,
  HOST_OPS,
  isPlayableBody,
  isPreviewBody,
  legacyActionEffect,
  MERGE_CLOSES_WORDS,
  migrateLegacyActions,
  opensSettings,
  splitMergeClosesLine,
  splitSettleFacts,
  takesTaskFacts,
  withMergeClosesLine,
} from "./cards";

/**
 * One card shape (cards/tasks/agents P1, ruling D1 a): no kind on the wire,
 * the badge derived from the actions and the author, and what an action
 * does declared as its effect (ruling D2: settle and open for an agent, the
 * host's own ops for the host).
 */

const card: Card = {
  id: "card-t1-1",
  taskId: "t1",
  author: "crewmate",
  priority: 30,
  title: "The auth refactor is ready",
  meta: "crewmate 1 · fm/task-t1",
  body: "<p>Ready to merge.</p><p>CI is green.</p>",
  actions: [
    {
      id: "merge",
      label: "Merge PR",
      variant: "primary",
      default: true,
      effect: { kind: "merge", after: "close" },
    },
    {
      id: "discard",
      label: "Discard",
      variant: "danger",
      danger: true,
      effect: { kind: "settle", mode: "discard", confirm: true },
    },
  ],
  status: "ready",
  createdAt: 1000,
};

describe("GitHub Projects sign-in card effect", () => {
  it("preserves the live host's Projects sign-in target", () => {
    expect(
      agentEffectSchema.parse({ kind: "open", target: "projects", signIn: "github.com" }),
    ).toEqual({ kind: "open", target: "projects", signIn: "github.com" });
  });
});

describe("cardSchema", () => {
  it("carries actions with effects and refuses a kind on the wire", () => {
    expect(cardSchema.parse(card)).toEqual(card);
    expect(cardsSnapshotSchema.parse([card])).toEqual([card]);
    expect(cardSchema.safeParse({ ...card, kind: "decision" }).success).toBe(false);
    expect(cardsSnapshotSchema.safeParse([{ ...card, kind: "note" }]).success).toBe(false);
    // The author is a fact the wire carries; a card without one is malformed.
    const { author: _author, ...anonymous } = card;
    expect(cardSchema.safeParse(anonymous).success).toBe(false);
  });

  it("knows exactly the three effect kinds and the host's closed set of ops", () => {
    const effects = [
      { kind: "merge", after: "close" },
      { kind: "settle", mode: "discard", confirm: true },
      { kind: "merge", after: "close", proceedWithOpen: true },
      { kind: "open", target: "settings" },
      { kind: "open", target: "subscriptions" },
      { kind: "host", op: "restore-account", arg: "acct_1" },
      { kind: "host", op: "move-flagship", arg: "kimi-coding" },
      { kind: "host", op: "retry-firstmate" },
    ];
    for (const effect of effects) {
      const action = { id: "a", label: "A", effect };
      expect(
        cardSchema.safeParse({ ...card, actions: [action] }).success,
        JSON.stringify(effect),
      ).toBe(true);
    }
    for (const effect of [
      { kind: "settle", mode: "finish" },
      { kind: "settle", mode: "discard", confirm: false },
      { kind: "open", target: "observe" },
      { kind: "host", op: "park" },
      { kind: "defer", until: 1 },
      { kind: "task", op: "drop" },
    ]) {
      const action = { id: "a", label: "A", effect };
      expect(
        cardSchema.safeParse({ ...card, actions: [action] }).success,
        JSON.stringify(effect),
      ).toBe(false);
    }
  });
});

describe("opensSettings", () => {
  it("is every open effect but a task's browser, and of the host's ops only restore-account", () => {
    for (const target of ["settings", "subscriptions", "projects", "devices"] as const) {
      expect(opensSettings({ effect: { kind: "open", target } })).toBe(true);
    }
    expect(
      opensSettings({ effect: { kind: "open", target: "projects", signIn: "github.com" } }),
    ).toBe(true);
    expect(opensSettings({ effect: { kind: "open", target: "devices", make: "link" } })).toBe(true);
    expect(opensSettings({ effect: { kind: "open", target: "browser" } })).toBe(false);
    expect(
      HOST_OPS.filter((op) => opensSettings({ effect: { kind: "host", op, arg: "a1" } })),
    ).toEqual(["restore-account"]);
    expect(opensSettings({ effect: { kind: "merge", after: "close" } })).toBe(false);
    expect(opensSettings({})).toBe(false);
  });
});

describe("cardPresentation", () => {
  it("derives the badge from the actions and the author, never from a declared kind", () => {
    expect(cardPresentation(card)).toBe("decision");
    expect(cardPresentation({ ...card, actions: [] })).toBe("note");
    expect(cardPresentation({ ...card, author: "firstmate" })).toBe("decision");
    expect(cardPresentation({ ...card, author: "host" })).toBe("attention");
    // A host note (the quiet card) reads as a note: nothing to choose.
    expect(cardPresentation({ ...card, author: "host", actions: [] })).toBe("note");
    expect(cardWord(card)).toBe("decision");
    expect(cardWord({ actions: [] })).toBe("note");
  });
});

describe("legacyActionEffect", () => {
  it("maps the ids the host used to dispatch on to the effects they meant", () => {
    expect(legacyActionEffect("merge-pr")).toEqual({ kind: "merge", after: "close" });
    expect(legacyActionEffect("land")).toEqual({ kind: "merge", after: "close" });
    expect(legacyActionEffect("discard")).toEqual({ kind: "settle", mode: "discard" });
    expect(legacyActionEffect("discard-anyway")).toEqual({
      kind: "settle",
      mode: "discard",
      confirm: true,
    });
    expect(legacyActionEffect("open-settings")).toEqual({ kind: "open", target: "settings" });
    expect(legacyActionEffect("restore-account:acct_cl1")).toEqual({
      kind: "host",
      op: "restore-account",
      arg: "acct_cl1",
    });
    expect(legacyActionEffect("move-flagship:kimi-coding")).toEqual({
      kind: "host",
      op: "move-flagship",
      arg: "kimi-coding",
    });
    expect(legacyActionEffect("retry-firstmate")).toEqual({ kind: "host", op: "retry-firstmate" });
    // A reply, a lookalike that never dispatched, and (INF-3108's approved
    // plan) the old close controls, which no corner duplicates since
    // INF-1879, stay replies.
    for (const id of [
      "approve",
      "explain-more",
      "merge-pr55",
      "land-it",
      ...LEGACY_CLOSE_CONTROL_IDS,
    ]) {
      expect(legacyActionEffect(id)).toBeUndefined();
    }
  });

  it("rewrites a pre-P1 settle card into Merge and Discard, and leaves effects alone", () => {
    const legacy = [
      { id: "keep", label: "Keep", variant: "secondary" as const },
      { id: "merge-pr", label: "Merge PR", variant: "primary" as const, default: true },
      { id: "discard", label: "Discard", variant: "secondary" as const },
      { id: "explain-more", label: "Explain more", variant: "ghost" as const, keepsOpen: true },
    ];
    const migrated = migrateLegacyActions(legacy);
    expect(migrated).toEqual([
      { id: "keep", label: "Keep", variant: "secondary" },
      {
        id: "merge-pr",
        label: "Merge PR",
        variant: "primary",
        default: true,
        effect: { kind: "merge", after: "close" },
      },
      {
        id: "discard",
        label: "Discard",
        variant: "danger",
        danger: true,
        effect: { kind: "settle", mode: "discard" },
      },
      { id: "explain-more", label: "Explain more", variant: "ghost", keepsOpen: true },
    ]);
    // Idempotent: a card already in P1's vocabulary is untouched.
    expect(migrateLegacyActions(migrated)).toEqual(migrated);
    expect(migrateLegacyActions(card.actions)).toEqual(card.actions);
  });
});

describe("isPreviewBody", () => {
  it("reads the body's shape, which is what the retired kind used to declare", () => {
    expect(isPreviewBody('<div class="mock"></div><script>draw();</script>')).toBe(true);
    expect(isPreviewBody("<style>.a{color:red}</style><div></div>")).toBe(true);
    expect(isPreviewBody('<canvas width="40"></canvas>')).toBe(true);
    expect(isPreviewBody("<p>A decision, in prose.</p>")).toBe(false);
    // Prose that merely says the words is not a preview.
    expect(isPreviewBody("<p>the script and the canvas of the style</p>")).toBe(false);
  });

  // FI3-796, the captain's yes: a figure's own script makes the figure move,
  // and the body around it stays prose.
  const MOVING =
    '<figure aria-label="Ten runs"><button type="button">Next run</button>' +
    '<svg viewBox="0 0 510 40" width="100%" role="img"><rect data-run width="45" height="24"/></svg>' +
    "<script>document.currentScript.closest('figure').querySelector('button').onclick=step;</script>" +
    "</figure>";

  it("keeps a body prose when every script sits inside a figure", () => {
    expect(isPreviewBody(`<p>Press Next run.</p>${MOVING}<p>Ten runs passed.</p>`)).toBe(false);
    expect(isPreviewBody(`<p>Two figures.</p>${MOVING}${MOVING}`)).toBe(false);
    // Nested inside an inner figure, or inside the drawing itself.
    expect(isPreviewBody(`<FIGURE><figure><script>a()</script></figure></FIGURE>`)).toBe(false);
    expect(isPreviewBody("<figure><svg><script>a()</script></svg></figure>")).toBe(false);
  });

  it("still reads a script outside any figure, a style sheet or a canvas as a preview", () => {
    // The script that drives a figure from outside it.
    expect(
      isPreviewBody(`<p>Press Next run.</p><figure><svg></svg></figure><script>a()</script>`),
    ).toBe(true);
    expect(isPreviewBody(`${MOVING}<script>b()</script>`)).toBe(true);
    // A figure's caption is not a figure.
    expect(isPreviewBody("<figcaption><script>a()</script></figcaption>")).toBe(true);
    expect(isPreviewBody(`<style>.a{color:red}</style>${MOVING}`)).toBe(true);
    expect(isPreviewBody('<figure><canvas width="40"></canvas><script>a()</script></figure>')).toBe(
      true,
    );
  });

  // INF-5452 (the captain: "we need to make this consistent with regular
  // decision cards"): a style sheet makes a body a preview for the prose
  // rules, but only controls of its own make its questions settings.
  it("reads only a body that runs controls of its own as playable", () => {
    const styledPlan =
      '<style>.pf fieldset label{display:block}</style><div class="pf"><p>Two calls.</p>' +
      '<fieldset><legend>Whose plugins?</legend><label><input type="radio" name="sources" value="claude" data-inf-recommended> Claude Code only</label></fieldset></div>';
    expect(isPreviewBody(styledPlan)).toBe(true);
    expect(isPlayableBody(styledPlan)).toBe(false);
    expect(isPlayableBody(`${styledPlan}<script>draw()</script>`)).toBe(true);
    expect(isPlayableBody('<canvas width="40"></canvas>')).toBe(true);
    expect(isPlayableBody(`<p>Press Next run.</p>${MOVING}`)).toBe(false);
    expect(isPlayableBody("<p>A decision, in prose.</p>")).toBe(false);
  });

  it("reads tags as the browser does: script text and comments close nothing", () => {
    // A </figure> inside a script string does not end the figure.
    expect(
      isPreviewBody("<figure><script>s='</figure>'</script><script>b()</script></figure>"),
    ).toBe(false);
    // Commented-out markup is not markup.
    expect(isPreviewBody("<p>Lead.</p><!-- <script>old()</script> -->")).toBe(false);
    expect(isPreviewBody("<figure><!-- </figure> --><script>a()</script></figure>")).toBe(false);
    // An unclosed figure holds the rest of the body, as the parser reads it.
    expect(isPreviewBody("<figure><svg></svg><script>a()</script>")).toBe(false);
  });
});

describe("splitSettleFacts", () => {
  // The strip as the host writes it (intake.taskGraph.test.ts pins the same markup).
  const strip =
    '<div class="inf-facts" data-facts><p class="inf-foot-line">' +
    '<span class="inf-foot-states"><span class="inf-foot-state" data-fact="checks" data-level="ok" title="read just now" tabindex="0"><svg class="inf-fact-dot" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.5" fill="var(--ok)"/></svg><span class="inf-foot-k">Checks</span> <span class="inf-foot-v">passed</span></span></span>' +
    '<span class="inf-foot-ref"><span data-fact="project"><span class="inf-foot-v">Default workspace</span></span></span>' +
    "</p></div>";
  const followups = '<div class="inf-followups" data-followups><div>FM3K-2</div></div>';

  it("lifts the host's strip out from between the author's body and the follow-up rows", () => {
    const author = "<h3>Why</h3><p>The meter read early.</p>";
    expect(splitSettleFacts(`${author}${strip}${followups}`)).toEqual({
      body: `${author}${followups}`,
      facts: strip,
      at: author.length,
    });
  });

  it("takes the last strip, the host's, when the author's body carries a lookalike", () => {
    const lookalike = '<div class="inf-facts" data-facts><span>Project</span></div>';
    const author = `<p>Lead.</p>${lookalike}<p>More.</p>`;
    expect(splitSettleFacts(`${author}${strip}`)).toEqual({
      body: author,
      facts: strip,
      at: author.length,
    });
  });

  it("lifts the strip a home on the other side of the Infinitary rename writes", () => {
    const author = "<p>Ready to merge.</p>";
    const theirs = strip.replaceAll("fm-", "inf-");
    expect(splitSettleFacts(`${author}${theirs}`)).toEqual({
      body: author,
      facts: theirs,
      at: author.length,
    });
  });

  it("leaves a body with no strip alone", () => {
    expect(splitSettleFacts("<p>Ready to merge.</p>")).toBeUndefined();
  });
});

// INF-2490, the captain's answer to INF-2489's question 4: every merge card
// carries the app's line, "Merging closes this task" or "The task continues
// after this merge", read from the card's own actions.
describe("the merge card's closes line", () => {
  const strip =
    '<div class="inf-facts" data-facts><p class="inf-foot-line">' +
    '<span class="inf-foot-ref"><span data-fact="project"><span class="inf-foot-v">meterlab</span></span></span>' +
    "</p></div>";
  const requestMerge: Card = {
    ...card,
    title: "Merge the continued work",
    actions: [
      {
        id: "merge",
        label: "Merge the pull request",
        default: true,
        effect: { kind: "merge", review: "mr-94", after: "continue" },
      },
      { id: "not-now", label: "Not now" },
    ],
  };

  it("puts the closes line last in a merge card's strip, where the stage lifts it beside the buttons", () => {
    const author = "<h3>Why</h3><p>The meter read early.</p>";
    const lifted = splitSettleFacts(`${author}${withMergeClosesLine(strip, card.actions)}`);
    expect(lifted?.body).toBe(author);
    expect(lifted?.facts).toContain('data-fact="project"');
    expect(lifted?.facts.endsWith(`${MERGE_CLOSES_WORDS.closes}</p></div>`)).toBe(true);
  });

  it("gives a merge card that continues the task a strip holding only the continues line, drawn beside its buttons (INF-2744)", () => {
    expect(takesTaskFacts(requestMerge)).toBe(true);
    const lifted = splitSettleFacts(
      `<p>Merge it.</p>${withMergeClosesLine(undefined, requestMerge.actions)}`,
    );
    expect(lifted?.facts).toContain(MERGE_CLOSES_WORDS.continues);
    expect(lifted?.facts).not.toContain(MERGE_CLOSES_WORDS.closes);
  });

  it("adds nothing to a card that merges nothing", () => {
    const discard = card.actions.filter((action) => action.id === "discard");
    expect(withMergeClosesLine(strip, discard)).toBe(strip);
    expect(withMergeClosesLine(undefined, [{}])).toBeUndefined();
  });

  // INF-3709's plan, done point 10: the line stands at the left end of the
  // buttons row, so the stage takes it out of the strip it draws above them.
  it("hands the stage the line's words and the strip without it, for the buttons row", () => {
    expect(splitMergeClosesLine(withMergeClosesLine(strip, card.actions) ?? "")).toEqual({
      strip,
      words: MERGE_CLOSES_WORDS.closes,
    });
  });

  it("leaves no strip to draw when the line was all a merge card's strip held (INF-2744)", () => {
    expect(
      splitMergeClosesLine(withMergeClosesLine(undefined, requestMerge.actions) ?? ""),
    ).toEqual({ strip: undefined, words: MERGE_CLOSES_WORDS.continues });
  });

  it("leaves a strip that carries no line as it is", () => {
    expect(splitMergeClosesLine(strip)).toEqual({ strip, words: undefined });
  });
});

describe("cardTakesReplies", () => {
  it("reaches a Firstmate card and a crewmate card with a task, never a host card", () => {
    expect(cardTakesReplies({ author: "firstmate" })).toBe(true);
    expect(cardTakesReplies({ author: "crewmate", taskId: "t1" })).toBe(true);
    expect(cardTakesReplies({ author: "crewmate" })).toBe(false);
    expect(cardTakesReplies({ author: "host" })).toBe(false);
  });

  it("reaches no card the host marked as taking none, whoever wrote it (the welcome)", () => {
    expect(cardTakesReplies({ author: "firstmate", replies: false })).toBe(false);
    expect(cardTakesReplies({ author: "crewmate", taskId: "t1", replies: false })).toBe(false);
  });

  // INF-1670: the stuck alert is the host's, and the first mate answers it.
  it("reaches a host card that names the first mate as its answerer (the stuck alert)", () => {
    expect(cardTakesReplies({ author: "host", taskId: "t1", answeredBy: "firstmate" })).toBe(true);
  });
});

describe("stack order", () => {
  // INF-770 direction A: a reply never moves a card, so its place holds.
  it("keeps a card the captain replied under in its place while its author answers", () => {
    const replied = { ...card, awaiting: "answer" as const, sentBackAt: 10 };
    const other = { ...card, id: "other", createdAt: card.createdAt + 1 };
    expect([other, replied].sort(compareStack).map((item) => item.id)).toEqual([card.id, "other"]);
  });

  it("orders bands by priority, oldest first within each, whatever waits on an answer", () => {
    const old = { ...card, id: "old", createdAt: 1 };
    const newer = { ...card, id: "new", createdAt: 2, sentBackAt: 50 };
    const note = { ...old, id: "note", priority: 15, createdAt: 0 };
    const held = { ...old, id: "held", createdAt: 3, awaiting: "answer" as const, sentBackAt: 10 };
    expect([held, newer, note, old].sort(compareStack).map((c) => c.id)).toEqual([
      "old",
      "new",
      "held",
      "note",
    ]);
  });
});
