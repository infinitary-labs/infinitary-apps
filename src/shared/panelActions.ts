import { z } from "zod";
import type { ActionLine } from "./actions";
import {
  type ArrangedPanel,
  arrangePanels,
  movePanel,
  pickToEdge,
  resetLayout,
} from "./panelArrangement";
import type { Layout } from "./preferences";

/**
 * Settings → Panels' move, hide, show, More pick and reset of one panel: one
 * line over the one saved arrangement (primitives/app-actions.md, INF-2344).
 */
export const panelLines = {
  panel: {
    // A reset takes the places saved before the arrangement existed too, as Settings → Panels does.
    fields: ["hiddenPanels", "arrangement", "morePick", "placements", "panelOrder"],
    sets: (v) =>
      v.reset === true
        ? ["arrangement", "morePick", "placements", "panelOrder"]
        : [
            ...(v.pick === true
              ? ["arrangement", "morePick"]
              : v.rail !== undefined ||
                  v.position !== undefined ||
                  v.above !== undefined ||
                  v.below !== undefined
                ? ["arrangement"]
                : []),
            ...(v.visible === undefined ? [] : ["hiddenPanels"]),
          ],
    area: "panels",
    tier: "asked",
    change: "inf:settings:layout:set",
    current: "inf:settings:layout:get",
    value: z
      .strictObject({
        surface: z.string().trim().min(1).max(64).optional(),
        rail: z.enum(["left", "right"]).optional(),
        position: z.enum(["top", "bottom"]).optional(),
        above: z.string().trim().min(1).max(64).optional(),
        below: z.string().trim().min(1).max(64).optional(),
        visible: z.boolean().optional(),
        pick: z.literal(true).optional(),
        reset: z.literal(true).optional(),
      })
      .refine((v) => (v.reset === true) !== (v.surface !== undefined), {
        // i18n-exempt: served to the first mate, a model, never shown
        message: "panel takes a surface, or reset alone",
      })
      .refine(
        (v) =>
          v.reset === true ||
          v.rail !== undefined ||
          v.position !== undefined ||
          v.above !== undefined ||
          v.below !== undefined ||
          v.visible !== undefined ||
          v.pick !== undefined,
        // i18n-exempt: served to the first mate, a model, never shown
        { message: "panel needs rail, position, above, below, visible or pick" },
      )
      .refine((v) => v.reset === undefined || Object.keys(v).every((key) => key === "reset"), {
        // i18n-exempt: served to the first mate, a model, never shown
        message: "reset takes nothing else",
      })
      .refine(
        (v) =>
          v.pick === undefined ||
          (v.rail === undefined &&
            v.position === undefined &&
            v.above === undefined &&
            v.below === undefined),
        // i18n-exempt: served to the first mate, a model, never shown
        { message: "pick moves the panel itself; leave out rail, position, above and below" },
      )
      .refine((v) => v.above === undefined || v.below === undefined, {
        // i18n-exempt: served to the first mate, a model, never shown
        message: "panel takes above or below, not both",
      })
      .refine(
        (v) =>
          (v.above === undefined && v.below === undefined) ||
          (v.rail === undefined && v.position === undefined),
        // i18n-exempt: served to the first mate, a model, never shown
        { message: "above or below already names the rail and position; leave those out" },
      ),
    // i18n-exempt: served to the first mate, a model, never shown
    line: "Move, hide or show one panel by its surface id when asked. rail and position move it to that slot's middle; above or below put it just above or below another panel; pick is a full rail's More pick, which moves it to its slot's edge and keeps its header on screen. reset alone puts every panel back where it asks to be, as Settings → Panels' Reset to defaults; shown, hidden and collapsed stay. Removal stays in personalize.",
    // actionRequest resolves the surface, the panel it goes next to and
    // every surface before adapting (INF-2344: one saved arrangement).
    toRequest: (v, c) => {
      type Surface = {
        id: string;
        placement: { x: "left" | "right"; y: "top" | "bottom" };
        preferred: { x: "left" | "right"; y: "top" | "bottom" };
        declaredOrder: number;
        place?: number;
      };
      const { layout, surface, neighbour, surfaces, known } = c as {
        layout: Layout;
        surface?: Surface;
        neighbour?: Surface;
        surfaces: Surface[];
        known: ArrangedPanel[];
      };
      if (v.reset === true) return [resetLayout(layout, known)];
      if (!surface) throw new Error("Name the panel's surface.");
      const next = { ...layout, hiddenPanels: { ...layout.hiddenPanels } };
      const moves =
        v.rail !== undefined ||
        v.position !== undefined ||
        neighbour !== undefined ||
        v.pick === true;
      // The create-your-own-panel slot is the only surface with no place.
      if (moves && surface.place === undefined)
        throw new Error(
          `${surface.id} always sits at the top of the left rail; it can only be hidden or shown.`,
        );
      if (neighbour && neighbour.place === undefined)
        throw new Error(`${neighbour.id} is not a panel to move next to; name a panel.`);
      const arrangement = arrangePanels(
        layout,
        surfaces
          .filter((each) => each.place !== undefined)
          .map((each) => ({ id: each.id, preferred: each.preferred, order: each.declaredOrder })),
      );
      if (v.pick === true) {
        next.arrangement = pickToEdge(arrangement, surface.id);
        next.morePick = surface.id;
      } else if (moves) {
        const target = neighbour
          ? neighbour.placement
          : { x: v.rail ?? surface.placement.x, y: v.position ?? surface.placement.y };
        const sameSlot =
          target.x === surface.placement.x && target.y === surface.placement.y && !neighbour;
        next.arrangement = sameSlot
          ? arrangement
          : movePanel(arrangement, surface.id, {
              slot: target as { x: "left" | "right"; y: "top" | "bottom" },
              ...(neighbour && v.above !== undefined ? { above: neighbour.id } : {}),
              ...(neighbour && v.below !== undefined ? { below: neighbour.id } : {}),
            });
      }
      if (v.visible === true) delete next.hiddenPanels[surface.id];
      else if (v.visible === false) next.hiddenPanels[surface.id] = true;
      return [next];
    },
    readValue: (c) => ({
      hiddenPanels: (c as Layout).hiddenPanels,
      arrangement: (c as Layout).arrangement ?? null,
      morePick: (c as Layout).morePick ?? null,
      // Places saved before the arrangement existed, which a reset takes too.
      placements: (c as Layout).placements,
    }),
    done: (v) => `${v.surface} ${v.description}`,
  },
} as const satisfies Record<string, ActionLine>;
