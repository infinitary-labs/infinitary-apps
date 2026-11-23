import { z } from "zod";
import {
  PANEL_CARD_VIEWS_MAX,
  PANEL_NAME_PATTERN,
  panelCardsDeclarationSchema,
  panelHeaderSchema,
} from "../plugins/panelCards";
import { sqlViewNameSchema } from "../sql";
import { panelReadNameSchema, personalIdSchema, personalPlacementSchema } from "./manifest";

/**
 * The app's own panels a view that carries no copy of this build may draw
 * (docs/view.md, "The app's own panels on the phone"): each one whose gate
 * is open now, with what the panel list gives one of the captain's panels,
 * so the view draws it the same way. Which of them a view already draws as
 * a screen of its own, as a phone draws Tasks and Activity, is the view's
 * call; the computer names every one it shows.
 */
export const appPanelViewSchema = z.strictObject({
  id: personalIdSchema,
  title: z.string().min(1).max(40),
  placement: personalPlacementSchema,
  order: z.number().int(),
  size: z.enum(["content", "fill"]),
  /** Its own code decides whether it shows (`rail.show`), as every app panel's gated one does. */
  ownPresence: z.boolean(),
  moves: z.boolean(),
  reads: z.array(panelReadNameSchema),
  sql: z.array(sqlViewNameSchema),
  /** Its card views, compiled beside its panel: the views `cards.emit` may name. */
  cardViews: z.array(z.string().regex(PANEL_NAME_PATTERN)).max(PANEL_CARD_VIEWS_MAX),
  cards: panelCardsDeclarationSchema,
  header: panelHeaderSchema,
  /** The version of its compiled files, which its files answer names: a hash of this build and their pins. */
  frame: z.strictObject({ version: z.string().regex(/^[0-9a-f]{16}$/) }),
});
export type AppPanelView = z.infer<typeof appPanelViewSchema>;

/** Every app panel the computer shows now, in its folders' order. */
export const appPanelsSchema = z.strictObject({ panels: z.array(appPanelViewSchema) });
export type AppPanels = z.infer<typeof appPanelsSchema>;

/** One app panel's compiled files, named by the version its listing gave. */
export const appPanelFilesRequestSchema = z.strictObject({
  id: personalIdSchema,
  version: z.string().regex(/^[0-9a-f]{16}$/),
});
export type AppPanelFilesRequest = z.infer<typeof appPanelFilesRequestSchema>;

/**
 * The answer: each file the build made under the panel's folder of the
 * frame realm's library, by its path inside that folder, with the pin its
 * import map must carry. Null when the computer shows no such panel now or
 * its files are of another version.
 */
export const appPanelFilesSchema = z
  .strictObject({
    /** This computer's version: the library the files import (`inf:plugins:library`). */
    builtFor: z.string().min(1).max(64),
    files: z.array(
      z.strictObject({
        path: z.string().min(1).max(512),
        integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]+=*$/),
        data: z.string(),
      }),
    ),
  })
  .nullable();
export type AppPanelFiles = z.infer<typeof appPanelFilesSchema>;
