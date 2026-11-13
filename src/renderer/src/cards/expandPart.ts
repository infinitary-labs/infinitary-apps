import { createContext } from "react";
import type { ExpandRequest } from "./PrototypeBody";

/**
 * Where a card's body sends a part that asks to open full screen
 * (docs/card-authoring.md, "A part full screen"; `ExpandedPart`). The stage
 * offers it to every card it draws, shown or prepared, because a frame hears
 * once, as it is born, that it may ask; whether a press opens anything is
 * decided when it is asked. A body with no stage around it has none, so the
 * part opens what it would without.
 */
export const ExpandPartContext = createContext<
  ((open: ExpandRequest, opener: HTMLIFrameElement | null) => void) | null
>(null);
