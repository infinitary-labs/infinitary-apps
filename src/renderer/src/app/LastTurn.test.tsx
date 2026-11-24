import type { LastRound } from "@shared/lastTurn";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LastTurnRound, PICTURE_ONLY_WORDS, WORKING_WORDS } from "./LastTurn";

/**
 * The last turn's words and states (docs/composer.md "The last turn"): what
 * each line of a round says for each shape of turn, read off the rendered
 * markup. The journey that drives turns through them is
 * `tests/e2e/last-turn.spec.ts`.
 */
type Bubble = {
  state: string | null;
  title: string | null;
  words: string;
  /** The mark beside the line spins in ember (INF-2483). */
  spinning: boolean;
  /** A reply the Firstmate keeps working after. */
  working: boolean;
};

function render(
  round: LastRound,
  options: { busy?: boolean; older?: boolean } = {},
): { html: string; you?: Bubble; mate?: Bubble } {
  const html = renderToStaticMarkup(
    <LastTurnRound round={round} busy={options.busy ?? false} older={options.older ?? false} />,
  );
  const bubble = (who: "you" | "firstmate"): Bubble | undefined => {
    // Each line is its own row, so a line's markup ends where its row does.
    const found = html.match(
      new RegExp(`<([a-z]+)([^>]*data-last-turn-bubble="${who}"[^>]*)>(.*?)</div>`),
    );
    if (!found) return undefined;
    const [, , open = "", inner = ""] = found;
    const mark =
      who === "firstmate" ? html.match(/<svg[^>]*data-last-turn-mark=""[^>]*>/)?.[0] : "";
    const attr = (name: string) => open.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    return {
      state: attr("data-state"),
      title: attr("title"),
      words: inner.match(/data-last-turn-words="">([^<]*)</)?.[1] ?? "",
      spinning: mark?.includes("data-working") ?? false,
      working: attr("data-working") !== null,
    };
  };
  return { html, you: bubble("you"), mate: bubble("firstmate") };
}

describe("a round of the last turn above the input", () => {
  // INF-3898 piece 2, the captain's answer: "From infinitary-axi" beside his line in the conversation.
  it("names infinitary-axi beside words the captain's command sent, and nothing beside the window's", () => {
    const fromTheCommand = render({ you: "What is waiting?", reply: null, through: "command" });
    expect(fromTheCommand.you?.words).toBe("What is waiting?");
    expect(fromTheCommand.html).toMatch(/data-last-turn-through="">From infinitary-axi</);
    expect(render({ you: "What is waiting?", reply: null }).html).not.toContain(
      "data-last-turn-through",
    );
  });

  // INF-2483's plan, the captain's Approve and build: "instead of using dot
  // dot dot, we should simply turn the mark to orange and spin it".
  it("shows the Firstmate working while it is busy with no reply yet, with the spinning mark and the working words", () => {
    const { you, mate } = render(
      { you: "How is the alpha coming along?", reply: null },
      { busy: true },
    );
    expect(you).toMatchObject({
      words: "How is the alpha coming along?",
      title: "How is the alpha coming along?",
    });
    expect(mate).toEqual({
      state: "working",
      title: WORKING_WORDS,
      words: WORKING_WORDS,
      spinning: true,
      working: false,
    });
  });

  // INF-1771, the captain's ask: "'working' should not block the user from
  // seeing the last message if there is one"; INF-2483's chosen answer: "The
  // reply's own mark turns orange and spins".
  it("keeps the reply's words while the Firstmate works, with the reply's own mark spinning", () => {
    const { mate } = render(
      { you: "Check the Linux lane", reply: { text: "Noted" } },
      { busy: true },
    );
    // A reply is a button: its cut words show in the app's own label on
    // rest, never the browser's title (INF-3019's plan, direction A).
    expect(mate).toEqual({
      state: "reply",
      title: null,
      words: "Noted",
      spinning: true,
      working: true,
    });
  });

  it("shows the reply once the turn has ended, read out once, and a problem in its own state", () => {
    const reply = render({ you: "Remember that I squash", reply: { text: "Noted" } });
    expect(reply.mate).toEqual({
      state: "reply",
      title: null,
      words: "Noted",
      spinning: false,
      working: false,
    });
    expect(reply.html).toMatch(/role="status"[^>]*>Noted</);
    const problem = render({
      you: "Merge it",
      reply: { text: "Something went wrong", problem: true },
    });
    expect(problem.mate).toMatchObject({ state: "problem", words: "Something went wrong" });
  });

  it("names a message of pictures alone, and leaves the Firstmate's line out until it works or replies", () => {
    const { you, mate } = render({ you: "", reply: null });
    expect(you).toMatchObject({ words: PICTURE_ONLY_WORDS });
    expect(mate).toBeUndefined();
  });

  // INF-1770's plan: the older round is drawn faded, never read out, and the
  // working signal belongs to the newest round alone.
  it("marks the older round, never reads it out, and never spins its mark", () => {
    const { html, mate } = render(
      { you: "Remember that I squash", reply: { text: "Noted" } },
      { busy: true, older: true },
    );
    expect(html).toMatch(/^<div[^>]*data-older=""/);
    expect(html).not.toContain('role="status"');
    expect(mate).toMatchObject({ state: "reply", spinning: false, working: false });
  });

  // INF-1103, the captain's Approve and build on INF-1102's plan: the reply
  // line is a button that opens the whole reply; the captain's own line and
  // the working words stay plain text.
  it("makes a finished or failed reply line the one button, and leaves the rest plain text", () => {
    const working = render({ you: "Cut another alpha", reply: null }, { busy: true });
    expect(working.html).not.toMatch(/<(button|a|input)\b/);
    expect(working.html).not.toMatch(/\b(tabindex|href)=|role="(button|link)"/);
    for (const reply of [{ text: "Got it" }, { text: "Something went wrong", problem: true }]) {
      for (const older of [false, true]) {
        const { html } = render({ you: "Cut another alpha", reply }, { older });
        expect(html.match(/<button\b[^>]*>/g)).toEqual([
          expect.stringMatching(/data-last-turn-bubble="firstmate"/),
        ]);
        expect(html).toMatch(/<span[^>]*data-last-turn-bubble="you"/);
      }
    }
  });

  // INF-6337's plan, the captain's Approve and build, part 2: a press of a
  // card's button is one row with the card's name, a button that opens the
  // card, before the button's words in an outlined bubble, with no reply line.
  it("draws a press of a card's button as one row naming the card, its words outlined, and no reply line", () => {
    const html = renderToStaticMarkup(
      <LastTurnRound
        round={{ you: "Approve and build", reply: null }}
        busy={false}
        card={{ id: "card-backlog", title: "A panel that charts your backlog" }}
        act="choice"
      />,
    );
    expect(html).toMatch(/^<div[^>]*data-card-round="choice"/);
    expect(html.match(/<button\b[^>]*>/g)).toEqual([
      expect.stringMatching(/data-last-turn-card="card-backlog"/),
    ]);
    expect(html).toMatch(/A panel that charts your backlog<\/span><\/button>/);
    expect(html).toMatch(/data-last-turn-bubble="you" data-choice=""[^>]*>.*Approve and build/);
    expect(html).not.toContain('data-last-turn-bubble="firstmate"');
    expect(html).not.toContain("data-last-turn-mark");
  });

  // INF-6365's review, the captain's choice: while the first mate works
  // after a card round, the row starts with its spinning mark, with no words.
  it("starts a card round's row with the working mark and no words while the first mate works", () => {
    const round = (older: boolean) =>
      renderToStaticMarkup(
        <LastTurnRound
          round={{ you: "Approve and build", reply: null }}
          busy
          older={older}
          card={{ id: "card-backlog", title: "A panel that charts your backlog" }}
          act="choice"
        />,
      );
    const newest = round(false);
    expect(newest.match(/data-last-turn-mark=""/g)).toHaveLength(1);
    expect(newest).toMatch(/data-last-turn-mark="" data-working=""/);
    expect(newest).not.toContain(WORKING_WORDS);
    expect(newest).not.toContain('data-last-turn-bubble="firstmate"');
    expect(round(true)).not.toContain("data-last-turn-mark");
  });
});
