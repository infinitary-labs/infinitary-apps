// The ambient music's styles by name (docs/ambient-music.md): the ten the
// captain kept from the prototypes, Cold sleep first heard.

import type { AmbientStyle } from "@shared/preferences";
import type { Style } from "../player";
import { ISLAND_MORNING, WAYFINDER_NIGHT } from "./island";
import { FAIR_WINDS, HARBOR_DAWN } from "./nautical";
import { COLD_SLEEP } from "./piano";
import { MOONLIT_DECK, QUIET_COVE, TAVERN_EMBERS } from "./pirate";
import { DEEP_DRIFT, STAR_CRUISE } from "./space";

export const STYLES: Record<AmbientStyle, Style> = {
  "deep-drift": DEEP_DRIFT,
  "star-cruise": STAR_CRUISE,
  "cold-sleep": COLD_SLEEP,
  "quiet-cove": QUIET_COVE,
  "tavern-embers": TAVERN_EMBERS,
  "moonlit-deck": MOONLIT_DECK,
  "harbor-dawn": HARBOR_DAWN,
  "fair-winds": FAIR_WINDS,
  "wayfinder-night": WAYFINDER_NIGHT,
  "island-morning": ISLAND_MORNING,
};
