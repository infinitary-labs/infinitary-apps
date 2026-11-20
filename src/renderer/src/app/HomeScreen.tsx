import { memo, useCallback, useRef, useState } from "react";
import { FirstRunGate } from "./FirstRunGate";
import { useListening } from "./HomeMate";
import { useCardUp } from "./LastTurn";
import { CardLayer } from "./stage/CardLayer";
import { useShellStore } from "./store";

/**
 * Stage layer: cards, the first-launch gate, and the screen label. Lives in
 * the inset stage. The gate mounts while it is open or still dissolving;
 * it never takes the stage from a card (a card is the host's or the
 * Firstmate's word, and outranks the caption).
 */
export const HomeScreen = memo(function HomeScreen() {
  const gateOpen = useShellStore((s) => s.firstRun?.gateOpen === true);
  const showCards = useCardUp();
  // The card layer outlives the stack by the last card's drop (CardLayer's `onEmptied`).
  const [layerUp, setLayerUp] = useState(showCards);
  if (showCards && !layerUp) setLayerUp(true);
  const emptied = useCallback(() => setLayerUp(false), []);
  const listening = useListening();
  const screenLabel = showCards ? "Working" : listening ? "Listening" : "Null state"; // i18n-exempt: not shown, screen name for the design tools
  return (
    <div
      data-screen-label={screenLabel}
      style={{ position: "absolute", inset: 0, pointerEvents: showCards ? "auto" : "none" }}
    >
      {!showCards && <GateLayer open={gateOpen} />}
      {(showCards || layerUp) && <CardLayer onEmptied={emptied} />}
    </div>
  );
});

/** Keeps the gate mounted through its dissolve after it closes. */
function GateLayer({ open }: { open: boolean }) {
  const everOpen = useRef(open);
  if (open) everOpen.current = true;
  return everOpen.current ? <FirstRunGate /> : null;
}
