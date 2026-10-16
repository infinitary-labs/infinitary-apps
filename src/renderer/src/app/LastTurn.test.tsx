import type { LastTurn } from "@shared/lastTurn";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LastTurnPair, PICTURE_ONLY_WORDS, WORKING_WORDS } from "./LastTurn";

/**
 * The last turn's words and states (docs/composer.md "The last turn"): what
 * each line says for each shape of turn, read off the rendered markup.
 * The journey that drives a turn through them is
 * `tests/e2e/last-turn.spec.ts`.
 */
type Bubble = {
  state: string | null;
  title: string | null;
  words: string;
  dots: boolean;
  /** The words sit between an opening and a closing quotation mark. */
  quoted: boolean;
};

function render(turn: LastTurn, busy = false): { html: string; you?: Bubble; mate?: Bubble } {
  const html = renderToStaticMarkup(<LastTurnPair turn={turn} busy={busy} />);
  const bubble = (who: "you" | "firstmate"): Bubble | undefined => {
    // Each line is its own row, so a line's markup ends where its row does.
    const found = html.match(
      new RegExp(`<([a-z]+)([^>]*data-last-turn-bubble="${who}"[^>]*)>(.*?)</div>`),
    );
    if (!found) return undefined;
    const [, , open = "", inner = ""] = found;
    const attr = (name: string) => open.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    const marks = [...inner.matchAll(/class="quote"[^>]*>([^<]*)</g)].map((mark) => mark[1]);
    const words = inner.match(/data-last-turn-words="">([^<]*)</)?.[1] ?? "";
    return {
      state: attr("data-state"),
      title: attr("title"),
      words,
      dots: inner.includes("data-last-turn-dots"),
      quoted:
        marks.join("") === "\u201c\u201d" &&
        inner.indexOf("\u201c") < inner.indexOf(words) &&
        inner.lastIndexOf("\u201d") > inner.indexOf(words),
    };
  };
  return { html, you: bubble("you"), mate: bubble("firstmate") };
}

describe("the last turn above the input", () => {
  it("shows the Firstmate working while it is busy, with the dots and the working words", () => {
    const { you, mate } = render({ you: "How is the alpha coming along?", reply: null }, true);
    expect(you).toMatchObject({
      words: "How is the alpha coming along?",
      title: "How is the alpha coming along?",
      quoted: true,
    });
    // The working words are the app's, not something said: no quotation marks.
    expect(mate).toEqual({
      state: "working",
      title: WORKING_WORDS,
      words: WORKING_WORDS,
      dots: true,
      quoted: false,
    });
  });

  it("shows the reply once the turn has ended, read out once, and a problem in its own state", () => {
    const reply = render({ you: "Remember that I squash", reply: { text: "Noted" } });
    expect(reply.mate).toEqual({
      state: "reply",
      title: "Noted",
      words: "Noted",
      dots: false,
      quoted: true,
    });
    expect(reply.html).toMatch(/role="status"[^>]*>Noted</);
    const problem = render({
      you: "Merge it",
      reply: { text: "Something went wrong", problem: true },
    });
    expect(problem.mate).toMatchObject({ state: "problem", quoted: true });
  });

  it("names a message of pictures alone, and leaves the Firstmate's bubble out until it works or replies", () => {
    const { you, mate } = render({ you: "", reply: null });
    expect(you).toMatchObject({ words: PICTURE_ONLY_WORDS, quoted: false });
    expect(mate).toBeUndefined();
  });

  it("draws both lines as plain text that nothing can click or reach by Tab", () => {
    for (const busy of [true, false]) {
      const { html } = render({ you: "Cut another alpha", reply: { text: "Got it" } }, busy);
      expect(html).not.toMatch(/<(button|a|input)\b/);
      expect(html).not.toMatch(/\b(tabindex|href)=|role="(button|link)"/);
    }
  });
});
