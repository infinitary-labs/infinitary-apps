import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { useCardReadingPlace } from "../../src/renderer/src/cards/cardReadingPlace";

/**
 * A live card's reading place across the stage's copies of it (INF-513,
 * INF-2043), measured by Chromium's own scrolling: a scroller cuts its
 * offset short when its room shrinks, and says so with a scroll event.
 *
 * Paging from card A to card B retires A's drawing and prepares a fresh,
 * unseen copy of A as B's successor; paging back promotes that copy in
 * place. The stage prepares it bare - no head, title, field or buttons - so
 * its body is taller and has less room to scroll than the shown card's
 * (`bare` in `StackedCard`). The numbers are the alpha's failing card in
 * tests/e2e/card-reading-place.spec.ts on Linux: a body whose words scroll
 * 804 px, 259 px tall when shown and 454 px when prepared.
 */

const WORDS = 804;
const SHOWN = 259;
const PREPARED = 454;
/** Where the captain left the card: the shown card holds it, the prepared copy cannot. */
const PLACE = 400;

/**
 * A copy's role on the stage, as `EntrySurface` hands it to `StackedCard`:
 * only the shown copy is `active`, and only the prepared one is `bare`; a
 * leaving drawing keeps its look.
 */
type Drawing = { id: string; shown: boolean; bare: boolean };

/** A card body as `StackedCard` draws it: its words, which its frame sizes, in a scroller. */
function Body({ id, shown, bare, words }: Drawing & { words: number }) {
  const ref = useCardReadingPlace(id, shown);
  return (
    <div
      ref={ref}
      data-reading-body=""
      style={{ height: bare ? PREPARED : SHOWN, overflowY: "auto" }}
    >
      <div style={{ height: words }} />
    </div>
  );
}

/** One mount of a card's drawing on the stage. */
class Copy {
  private readonly host = document.createElement("div");
  private readonly root: Root;
  constructor(private readonly drawing: Drawing) {
    document.body.append(this.host);
    this.root = createRoot(this.host);
  }
  /** Commits `drawing` at once, as the stage's own render does, its refs included. */
  draw(changes: Partial<Drawing> & { words: number }): this {
    Object.assign(this.drawing, changes);
    flushSync(() => this.root.render(<Body {...this.drawing} words={changes.words} />));
    return this;
  }
  get body(): HTMLDivElement {
    return this.host.querySelector("[data-reading-body]") as HTMLDivElement;
  }
  retire(): void {
    this.root.unmount();
    this.host.remove();
  }
}

const copies: Copy[] = [];
const copy = (drawing: Drawing) => {
  const made = new Copy(drawing);
  copies.push(made);
  return made;
};
afterEach(() => {
  for (const made of copies.splice(0)) made.retire();
});

/** Lets Chromium run its rendering steps: resize observations and scroll events. */
async function frames(count = 3): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((done) => requestAnimationFrame(done));
}

async function readAndPageAway(id: string, place: number): Promise<void> {
  const first = copy({ id, shown: true, bare: false }).draw({ words: WORDS });
  await frames();
  first.body.scrollTop = place;
  await frames();
  expect(first.body.scrollTop).toBe(place);
  // It stays as the leaving drawing until it fades, then leaves the stage.
  first.draw({ shown: false, words: WORDS });
  await frames();
  first.retire();
}

/** The next visit to card `id`: a fresh shown copy, wherever its saved place puts it. */
async function nextVisit(id: string): Promise<number> {
  const again = copy({ id, shown: true, bare: false }).draw({ words: WORDS });
  await frames();
  return again.body.scrollTop;
}

test("a card prepared unseen comes back to its reading place when it is shown", async () => {
  const id = "read-prepared";
  await readAndPageAway(id, PLACE);
  // B's successor: a fresh copy of A, its frame still at its floor.
  const prepared = copy({ id, shown: false, bare: true }).draw({ words: 86 });
  await frames();
  prepared.draw({ words: WORDS });
  await frames();
  // The prepared copy cannot hold the place.
  expect(prepared.body.scrollTop).toBe(WORDS - PREPARED);
  // Previous card: the prepared copy is promoted in place.
  prepared.draw({ shown: true, bare: false, words: WORDS });
  await frames();
  expect(prepared.body.scrollTop).toBe(PLACE);
  prepared.retire();
  expect(await nextVisit(id)).toBe(PLACE);
});

test("a prepared copy whose frame first reports a taller body keeps the place it cannot hold", async () => {
  const id = "read-prepared-taller";
  await readAndPageAway(id, PLACE);
  const prepared = copy({ id, shown: false, bare: true }).draw({ words: 86 });
  await frames();
  // The frame's first height, measured while it was briefly at another
  // width (drawnAtWidth.ts), gives the prepared copy room for the place.
  prepared.draw({ words: WORDS + 60 });
  await frames();
  expect(prepared.body.scrollTop).toBe(PLACE);
  // Its final height cuts the prepared copy's offset short.
  prepared.draw({ words: WORDS });
  await frames();
  expect(prepared.body.scrollTop).toBe(WORDS - PREPARED);
  prepared.draw({ shown: true, bare: false, words: WORDS });
  await frames();
  expect(prepared.body.scrollTop).toBe(PLACE);
  prepared.retire();
  expect(await nextVisit(id)).toBe(PLACE);
});

test("the captain's own scroll on the promoted card becomes its reading place", async () => {
  const id = "read-promoted-scroll";
  await readAndPageAway(id, PLACE);
  const prepared = copy({ id, shown: false, bare: true }).draw({ words: WORDS });
  await frames();
  prepared.draw({ shown: true, bare: false, words: WORDS });
  await frames();
  expect(prepared.body.scrollTop).toBe(PLACE);
  prepared.body.scrollTop = 120;
  await frames();
  prepared.draw({ shown: false, words: WORDS });
  await frames();
  prepared.retire();
  expect(await nextVisit(id)).toBe(120);
});
