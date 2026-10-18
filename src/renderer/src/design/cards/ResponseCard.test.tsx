import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../core/Button";
import { CardSizeContext } from "./CardSize";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "./cardSizeWords";
import { ResponseCard } from "./ResponseCard";

describe("ResponseCard chrome", () => {
  it("gives every card a close control and leaves a note without a Done button", () => {
    const html = renderToStaticMarkup(
      <ResponseCard kind="note" title="Quota note" meta="firstmate">
        All steady.
      </ResponseCard>,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain(">Done</");
  });

  it("reads where a card's task runs right after its meta line, as its own words", () => {
    const title = "Fix the footer links on the pricing page and recheck the mobile layout";
    const html = renderToStaticMarkup(
      <ResponseCard
        kind="note"
        title="Footer fixed"
        meta={title}
        place="on Mac mini"
        model="GPT-6 Sol"
      >
        Done.
      </ResponseCard>,
    );
    // The meta line, then the place in its own element that keeps its
    // width, so the meta line is the one that gives way; then the model chip.
    const head = html.match(
      /<span data-card-meta="" style="[^"]*">([^<]*)<\/span><span data-card-place="" style="([^"]*)">([^<]*)<\/span><\/span><span data-model-chip=""/,
    );
    expect(head?.[1]).toBe(title);
    expect(head?.[2]).toContain("flex-shrink:0");
    expect(head?.[3]).toBe("· on Mac mini");
    // Alone, with no meta line before it, it needs no separator.
    expect(renderToStaticMarkup(<ResponseCard place="on Mac mini">Done.</ResponseCard>)).toMatch(
      /<span data-card-place="" style="[^"]*">on Mac mini<\/span>/,
    );
  });

  it("leads the head with the task's key when the card is about a task, and draws none otherwise (INF-358)", () => {
    const title = "Fix the footer links on the pricing page";
    const keyed = renderToStaticMarkup(
      <ResponseCard
        kind="decision"
        title="Footer fixed"
        taskKey={<span data-task-key="SCR-7">SCR-7</span>}
        meta={title}
        model="GPT-6 Sol"
      >
        Done.
      </ResponseCard>,
    );
    // The key first, whole, then the separator, then the meta line as its own
    // words, so what reads the meta line still reads the title alone.
    const head = keyed.match(
      /<span data-card-key="" style="([^"]*)"><span data-task-key="SCR-7">SCR-7<\/span><\/span><span aria-hidden="true">·<\/span><span data-card-meta="" style="[^"]*">([^<]*)<\/span>/,
    );
    expect(head?.[1]).toContain("flex-shrink:0");
    expect(head?.[2]).toBe(title);
    expect(keyed.indexOf("data-card-key")).toBeLessThan(keyed.indexOf("data-model-chip"));
    const plain = renderToStaticMarkup(
      <ResponseCard kind="note" title="Quota note" meta="firstmate">
        All steady.
      </ResponseCard>,
    );
    expect(plain).not.toContain("data-card-key");
    expect(plain).not.toContain(">·<");
  });

  it("keeps real footer actions next to the close control", () => {
    const html = renderToStaticMarkup(
      <ResponseCard
        kind="decision"
        title="Refactor finished"
        actions={
          <>
            <Button variant="ghost">Discard task</Button>
            <Button variant="secondary">Land this work</Button>
            <Button>Done</Button>
          </>
        }
      >
        14 files changed.
      </ResponseCard>,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("Discard task");
    expect(html).toContain("Land this work");
    expect(html).toContain(">Done</button>");
    expect(html).toContain("padding:var(--space-3) 16px 16px");
  });

  it("draws the size control right before Close only where the stage lends a size", () => {
    const card = (
      <ResponseCard kind="note" title="Quota note" onClose={() => {}}>
        All steady.
      </ResponseCard>
    );
    expect(renderToStaticMarkup(card)).not.toContain(MAXIMIZE_LABEL);
    const lent = (maximized: boolean) =>
      renderToStaticMarkup(
        <CardSizeContext.Provider value={{ maximized, toggle: () => {} }}>
          {card}
        </CardSizeContext.Provider>,
      );
    const usual = lent(false);
    expect(usual.indexOf(`aria-label="${MAXIMIZE_LABEL}"`)).toBeGreaterThan(-1);
    expect(usual.indexOf(`aria-label="${MAXIMIZE_LABEL}"`)).toBeLessThan(
      usual.indexOf('aria-label="Close"'),
    );
    expect(lent(true)).toContain(`aria-label="${RESTORE_LABEL}"`);
    expect(lent(true)).toContain('aria-label="Close"');
  });
});
