import { z } from "zod";
import { decisionModelIdSchema, decisionsSettingsSchema, decisionsViewSchema } from "../decisions";
import { decisionUseRequestSchema } from "../decisionUses";
import { homeUpdateSchema } from "../homeUpdate";
import { releaseNotesViewSchema, shownReleaseNoteSchema } from "../releaseTracking";
import { keptOutsideDataSchema, outsideDataDeletedSchema } from "../savedOutsideData";
import {
  presenceSettingsSchema,
  updateChannelSchema,
  updateInstallResultSchema,
  updateStatusSchema,
} from "../update";
import { type ChannelDeclaration, okSchema } from "./common";

/** Decisions and their keys, the app's own updates, release notes, presence and retention. */
export const upkeepChannels = {
  // Decision models (S7b, design section 5.3). Four channels, and the
  // split between them is the point: the ROW travels on the first pair and
  // carries no secret, so it can be read, logged and pushed; the KEY has
  // its own write-only call and is never returned by any of them.
  "inf:settings:decisions": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: decisionsViewSchema,
  },
  "inf:settings:decisions:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([decisionsSettingsSchema]),
    response: decisionsViewSchema,
  },
  "inf:decisions:key:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    /** The user's own key, write-only: the response is the row's new state. */
    request: z.tuple([decisionModelIdSchema, z.string().min(1)]),
    response: decisionsViewSchema,
  },
  "inf:decisions:key:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([decisionModelIdSchema]),
    response: decisionsViewSchema,
  },
  /** One decision model use switched in Settings (`src/shared/decisionUses.ts`). */
  "inf:decisions:use:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([decisionUseRequestSchema]),
    response: decisionsViewSchema,
  },
  "inf:update:status": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateStatusSchema,
  },
  // Check for updates in Settings: reads the release source now, past the
  // saved answer, and says when it could not (docs/alpha.md "Update channels").
  // An app controlling another computer checks its own, never the other's.
  "inf:update:check": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateStatusSchema,
  },
  "inf:update:channel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([updateChannelSchema]),
    response: updateStatusSchema,
  },
  "inf:update:open-release": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  // Installs the offered version where the app installs its own updates (a
  // deb, an rpm or an AppImage on Linux), then starts it; answers only when
  // it could not (docs/alpha.md "Updates on Linux"). An app controlling
  // another computer installs its own, never the other's.
  "inf:update:install": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateInstallResultSchema,
  },
  // Update later (docs/alpha.md, "Saving work before an update"): lets an
  // update go while it saves the crew's work, so nothing is replaced and
  // the work carries on. An app controlling another computer lets its own
  // update go, never the other's.
  "inf:update:later": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateStatusSchema,
  },
  // A window says whether it holds words not yet sent (docs/view.md,
  // "Following the home's version"): an app catching up with the computer it
  // controls starts again only while none of its windows holds any.
  "inf:update:unsent": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.boolean()]),
    response: okSchema,
  },
  // The first mate's computer's own update, read and started from any paired
  // view, a phone or a Mac that controls this one (docs/view.md, "Updating the
  // first mate's computer"; `home-update.md`). Asked across every major, so
  // their names and shapes never change: the version rule lets Update and
  // Update later past its read-only gate (`READ_ONLY_ASKS`). The home offers
  // only what its own Version row offers, and its update saves the crew's
  // work as one started at the home does.
  "inf:home-update:status": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: homeUpdateSchema,
  },
  "inf:home-update:install": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: homeUpdateSchema,
  },
  "inf:home-update:later": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: homeUpdateSchema,
  },
  // The release notes the app showed, newest first, with the version running
  // now (docs/release-notes.md "Reading a note again"): what Settings lists
  // and what tells the window and the Help menu whether What's new can open one.
  // The home's own: a view runs a version of its own, so it asks neither.
  "inf:release-notes:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: releaseNotesViewSchema,
  },
  // What's new: brings a shown release note forward, the one for a named
  // version or else the newest that listed changes. An open note comes to the
  // front of the stack, a closed one comes back read-only as a past card; it
  // saves nothing and raises no card. No note yet is refused in words. The one
  // door the Help menu, command search, Settings and Firstmate share.
  "inf:release-notes:show": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64).nullable()]),
    response: shownReleaseNoteSchema.extend({ open: z.boolean() }),
  },
  "inf:presence:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: presenceSettingsSchema,
  },
  "inf:presence:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([presenceSettingsSchema]),
    response: presenceSettingsSchema,
  },
  "inf:retention:purge": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({ purgedTasks: z.number() }),
  },
  /**
   * What a purge clears beyond tasks: knowledge, where this build has it
   * (docs/knowledge.md); and the words from outside this build keeps for a
   * while, which Settings → General can delete on their own
   * (docs/task-retention.md, "Words from outside").
   */
  "inf:retention:scope": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({
      knowledge: z.boolean(),
      kept: z.array(keptOutsideDataSchema).optional(),
    }),
  },
  /**
   * Delete the words from outside every saved conversation on this
   * computer holds, now: a note takes their place, and a conversation
   * still working follows once it pauses (docs/task-retention.md, "Words
   * from outside").
   */
  "inf:retention:delete-outside": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: outsideDataDeletedSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
