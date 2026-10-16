import { type RefObject, useEffect, useState } from "react";

/**
 * What the main message's foot stands on (docs/renderer.md, "Collapsed
 * headers under the input"). The input is pinned by its bottom above the
 * window's floor (`--prompt-floor`, design/styles.css), and two things hang
 * there: its own notices, and the collapsed side panels at a rail's foot.
 * A collapsed panel keeps its header on its rail and takes no card room, so
 * in a window narrow enough that the input shares columns with that header,
 * the input would be drawn over it once its foot came down to the header's
 * top: in a short window, or over a stack of collapsed headers.
 *
 * An expanded panel stands on its rail's floor, and the input is centred on
 * the window, so on a page narrow enough that the input shares a rail's
 * columns the panel would run under it. That rail ends above the input
 * instead (`data-rail-lifted`, docs/renderer.md "Expanded panels beside the
 * input"), and its foot holds no header the input could stand on.
 */

/** A box's edges, as `getBoundingClientRect()` gives them. */
type Edges = { left: number; right: number; top: number };

/** Sub-pixel rounding between two boxes laid out by the same engine is no overlap. */
const ROUNDING = 0.5;

/**
 * How high above the floor the highest of `headers` that shares columns
 * with `input` reaches, in px; 0 when none does. A header is drawn only
 * inside its rail, which folds to nothing while a wide card takes the room.
 */
export function headersReach(
  input: Edges,
  headers: readonly { header: Edges; rail: Edges }[],
  floor: number,
): number {
  let top = floor;
  for (const { header, rail } of headers) {
    const left = Math.max(input.left, header.left, rail.left);
    const right = Math.min(input.right, header.right, rail.right);
    if (right - left > ROUNDING) top = Math.min(top, header.top);
  }
  return Math.max(0, floor - top);
}

/** The air the input keeps from a rail's columns before that rail ends above it (`--space-4`). */
const RAIL_AIR = 16;

/**
 * Whether `input` shares `rail`'s columns, with `RAIL_AIR` to spare on
 * either side. A folded rail is drawn nowhere, so it shares nothing.
 */
function sharesColumns(
  input: Pick<Edges, "left" | "right">,
  rail: Pick<Edges, "left" | "right">,
): boolean {
  return (
    rail.right - rail.left > ROUNDING &&
    input.left < rail.right + RAIL_AIR &&
    input.right > rail.left - RAIL_AIR
  );
}

/** A rail's expanded panels: what ends above the input when it shares their columns. */
const EXPANDED_PANEL = ":scope > [data-side-panel]:not([data-side-panel-collapsed]):not([hidden])";

/** Set on a rail that ends above the input (design/styles.css). */
const LIFTED = "data-rail-lifted";

/**
 * The headers an input can come down onto: collapsed panels at the foot of
 * a rail that does not already end above it.
 */
const FOOT_HEADERS = `[data-rail]:not([${LIFTED}]) > [data-side-panel][data-side-panel-collapsed][data-side-panel-placement-y="bottom"]:not([hidden])`;

/** Set on the document while the input's foot would stand on those headers. */
const ON_PANELS = "data-prompt-on-panels";

function readPx(styles: CSSStyleDeclaration, name: string): number {
  const value = Number.parseFloat(styles.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Publishes what the input's foot stands on: the notices' height under it
 * as `--prompt-notices`, how high the collapsed headers it shares columns
 * with reach as `--prompt-panels`, and whether that is above where the
 * window and the notices put the foot (`data-prompt-on-panels`). Returns how
 * far the headers lift the foot now, which the composer's growth gives up
 * so its top stays clear of the Firstmate's frame. It also marks each rail
 * with an expanded panel whose columns the input shares (`data-rail-lifted`).
 *
 * A header that steps aside while a card is up keeps its box, so what this
 * reads never depends on what it decided, and the two cannot take turns.
 * A rail's mark reads only columns, which ending above the input leaves
 * alone, and a marked rail's headers lift nothing, so neither can a rail.
 */
export function usePromptFoot(
  dockRef: RefObject<HTMLElement | null>,
  noticesRef: RefObject<HTMLElement | null>,
): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const dock = dockRef.current;
    const notices = noticesRef.current;
    if (!dock || !notices) return;
    const root = document.documentElement;
    const rails = [...document.querySelectorAll<HTMLElement>("[data-rail]")];
    const publish = () => {
      const height = notices.childElementCount > 0 ? notices.getBoundingClientRect().height : 0;
      root.style.setProperty("--prompt-notices", `${height}px`);
      const input = dock.getBoundingClientRect();
      for (const rail of rails) {
        const shares = sharesColumns(input, rail.getBoundingClientRect());
        rail.toggleAttribute(LIFTED, shares && rail.querySelector(EXPANDED_PANEL) !== null);
      }
      const headers = [...document.querySelectorAll<HTMLElement>(FOOT_HEADERS)].flatMap((header) =>
        header.parentElement
          ? [
              {
                header: header.getBoundingClientRect(),
                rail: header.parentElement.getBoundingClientRect(),
              },
            ]
          : [],
      );
      const reach = headersReach(input, headers, window.innerHeight);
      root.style.setProperty("--prompt-panels", `${reach}px`);
      const styles = getComputedStyle(root);
      const base = readPx(styles, "--prompt-floor-base");
      root.toggleAttribute(ON_PANELS, reach > base + ROUNDING);
      const next = Math.max(0, readPx(styles, "--prompt-floor") - base);
      setLift((held) => (Math.abs(held - next) < ROUNDING ? held : next));
    };
    // A rail folding, a panel collapsing or the window changing changes a
    // box's size; a panel coming or going, or moving on its rail, changes
    // the rail's children or the panel's own attributes; a card coming up
    // or the last one going changes where the foot stands. A window only
    // narrowed moves the input across the rails without resizing either.
    const sizes = new ResizeObserver(publish);
    const changes = new MutationObserver(() => {
      watch();
      publish();
    });
    const watch = () => {
      for (const rail of rails) changes.observe(rail, { childList: true });
      for (const panel of document.querySelectorAll("[data-rail] > *")) {
        sizes.observe(panel);
        changes.observe(panel, {
          attributeFilter: ["hidden", "data-side-panel-collapsed", "data-side-panel-placement-y"],
        });
      }
    };
    for (const box of [dock, notices, ...rails]) sizes.observe(box);
    changes.observe(root, { attributeFilter: ["data-card-stack-open"] });
    watch();
    window.addEventListener("resize", publish);
    return () => {
      sizes.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--prompt-notices");
      root.style.removeProperty("--prompt-panels");
      root.removeAttribute(ON_PANELS);
      for (const rail of rails) rail.removeAttribute(LIFTED);
    };
  }, [dockRef, noticesRef]);
  return lift;
}
