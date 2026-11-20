import { useLayoutEffect, useState } from "react";
import { centeredRailsWidth } from "../cards/cardGeometry";
import { useCreatePanelSlotShown } from "../plugins/createPanelSlotStore";
import { useRailLayout } from "../plugins/railStore";

/**
 * What the shell measures for the thread ladder (cards-as-threads phase 1):
 * the window's width, and how much of it the DOCKED rails would take.
 *
 * "Would take" is the load-bearing word. While the docks are folded the
 * rails are still in the DOM with their panels in them - they are given
 * zero width by one CSS state, not unmounted - so `--rail-docked-left` and
 * `--rail-docked-right` keep saying what the rails ask for. Reading the
 * effective `--occupied-rail-*` instead would make the ladder circular:
 * folding would erase the reason to fold, and the pair would oscillate.
 */
export type ShellLayout = {
  windowWidth: number;
  /** `--rail-docked-left`, in px; 0 when no expanded panel is docked on that side. */
  left: number;
  right: number;
  /** Symmetric clearance: twice the larger expanded rail. */
  railsWidth: number;
};

function readPx(styles: CSSStyleDeclaration, name: string): number {
  const value = Number.parseFloat(styles.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

export function readShellLayout(): ShellLayout {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { windowWidth: 0, left: 0, right: 0, railsWidth: 0 };
  }
  const styles = getComputedStyle(document.documentElement);
  const left = readPx(styles, "--rail-docked-left");
  const right = readPx(styles, "--rail-docked-right");
  return {
    windowWidth: window.innerWidth,
    left,
    right,
    railsWidth: centeredRailsWidth(left, right),
  };
}

/**
 * Follow window/stage resizing and saved rail choices. Collapse keeps the
 * rail's header width, so its record must trigger a read even without a resize.
 * Read docked demand, not effective folded width, to avoid fold oscillation.
 */
export function useShellLayout(): ShellLayout {
  useRailLayout();
  // The create-your-own-panel slot reserves clearance as an expanded panel
  // does, and comes and goes with no resize and no layout record of its own.
  useCreatePanelSlotShown();
  const [layout, setLayout] = useState<ShellLayout>(readShellLayout);
  useLayoutEffect(() => {
    const measure = () => {
      const next = readShellLayout();
      setLayout((held) =>
        held.windowWidth === next.windowWidth &&
        held.left === next.left &&
        held.right === next.right
          ? held
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const stage = document.querySelector("[data-stage]");
    const observer = stage ? new ResizeObserver(measure) : undefined;
    if (stage && observer) observer.observe(stage);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  });
  return layout;
}

/** What folds the docked rails: a card that needs their room, or the main message. */
export type RailFold = "card" | "prompt";

const folding = new Set<RailFold>();

/**
 * The fold's one writer (design/styles.css, `data-rails-folded`): the
 * document carries the mark while any reason holds, so a card leaving never
 * unfolds rails the main message still needs folded, nor the other way
 * round. Each reason says so whenever it changes, and gives way as it goes.
 */
export function foldRails(reason: RailFold, folds: boolean): void {
  if (folds) folding.add(reason);
  else folding.delete(reason);
  document.documentElement.toggleAttribute("data-rails-folded", folding.size > 0);
}
