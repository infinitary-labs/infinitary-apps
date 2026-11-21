import { z } from "zod";

/**
 * A Mac's work half (docs/helper.md, "A Mac that also controls"): a Mac that
 * joined with its window also runs its home's work in the background, and
 * the window checks that half at every connection to its home, the first of
 * each launch included and never before a welcome, sets up again what is
 * missing, and says why when it cannot (docs/view.md, "A Mac
 * that runs work").
 *
 * Why the work does not run, or has not reached its home:
 * - `other-home`: this user here runs another first mate's work already;
 * - `other-entry`: this user here runs this first mate's work under another
 *   entry on its list;
 * - `removal-unfinished`: an earlier removal here has not finished;
 * - `app-place`: the app runs from a place that does not last, a disk image
 *   or a copy macOS moved aside, which the background cannot start;
 * - `background-off`: the system refused the background item, as macOS does
 *   while its Login Items setting keeps Infinitary out of the background;
 * - `no-background`: this computer has no way to start work in the
 *   background that the app can use;
 * - `newer-work`: a newer Infinitary saved this user's work here, which the
 *   app there cannot read and leaves as it is (docs/helper.md, "Saved by a
 *   newer Infinitary");
 * - `local-network`: the work runs, and its home finds it dials on the local
 *   network, where macOS holds a background program's dial until someone at
 *   that Mac allows it (docs/devices.md, "Held on the local network");
 * - `not-reached`: the work runs and has not reached its home, for no reason
 *   the home can name.
 *
 * The last two are the home's own reading of the work's contact; the window
 * names the others. A view that does not know a reason a newer home names
 * reads it as `not-reached` (`VIEW_OPEN_LISTS`).
 */
export const workSetupReasonSchema = z.enum([
  "other-home",
  "other-entry",
  "removal-unfinished",
  "app-place",
  "background-off",
  "no-background",
  "newer-work",
  "local-network",
  "not-reached",
]);
export type WorkSetupReason = z.infer<typeof workSetupReasonSchema>;

/**
 * What a Mac's window found of its work half, as it tells its home
 * (`inf:devices:work-setup`): `running` once a live run holds the work
 * folder, `starting` while the background was asked and its run has not
 * taken the folder yet, `blocked` with the reason it cannot be set up.
 * `copyGone` when the copy of the app the work folder recorded was no longer
 * there, so the background now starts the app that checked, and the record
 * no longer names it: the home says so once.
 */
export const workSetupReportSchema = z.strictObject({
  state: z.enum(["running", "starting", "blocked"]),
  reason: workSetupReasonSchema.optional(),
  copyGone: z.literal(true).optional(),
});
export type WorkSetupReport = z.infer<typeof workSetupReportSchema>;

/**
 * What the home's Devices row says of a Mac's work half while its window is
 * connected and its work is not in reach: `starting` while it is being set
 * up, `blocked` with why it is not.
 */
export const deviceWorkSetupSchema = z.strictObject({
  state: z.enum(["starting", "blocked"]),
  reason: workSetupReasonSchema.optional(),
});
export type DeviceWorkSetup = z.infer<typeof deviceWorkSetupSchema>;

/**
 * The live frame a home sends the window of one Mac for its row's Fix it
 * (`work-setup`): check the work half and set it up again. A window from
 * before ignores it.
 */
export const WORK_SETUP_LIVE = "inf:devices:set-up-work";

export const workSetupAskSchema = z.strictObject({ deviceId: z.string().min(1).max(64) });

/** How long the home reads a run the window found or asked for as still starting, before it says it has not reached it. */
export const WORK_REACH_GRACE_MS = 30_000;

/** What a Mac's report of its work answers when no window of that Mac told it. */
export const WORK_SETUP_ONLY =
  "What a Mac found of its work is told only by that Mac's own window.";
