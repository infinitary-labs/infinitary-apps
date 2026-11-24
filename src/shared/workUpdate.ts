import { z } from "zod";
import { placedTaskIdSchema } from "./workIdentity";

/**
 * How long an update has to come back connected (docs/devices.md, "Updating
 * over the connection"; docs/helper.md, "A copy that does not start"): the
 * home waits this long for the computer on its version, and the computer
 * goes back to the copy it kept when the new one has not connected by then.
 */
export const UPDATE_RETURN_MS = 3 * 60_000;

/** Saves the crew's work on a computer before its home updates it (`work-update-saving.md`). */
export const WORK_SAVE_ORDER = "inf:session:save-for-update";
/** Lets that save go, after an update that did not replace the copy or Update later. */
export const WORK_RELEASE_ORDER = "inf:session:release-update";

/** What either order answers: each task whose turn the save stopped there. */
const savedTurnsSchema = z.object({ stopped: z.array(placedTaskIdSchema) });
/** What the let-go answers besides: each task whose stop it withdrew before it cut the turn. */
const releasedTurnsSchema = savedTurnsSchema.extend({ withdrawn: z.array(placedTaskIdSchema) });

/** The two orders a home asks a computer that runs work around its update, in `workOrders`. */
export const updateSaveOrders = {
  /**
   * Its home is about to update it (docs/helper.md, "Saving its work before
   * an update"; `work-update-saving.md`): no turn starts here, each one
   * running stops where nothing is lost, and the answer comes once every
   * stopped turn's end is written here and the home has it. `stopped` names
   * each task whose turn it stopped. A second ask joins the first; once
   * saved, nothing from the home for `UPDATE_RETURN_MS` lets it go here.
   */
  [WORK_SAVE_ORDER]: { effect: "change", request: z.tuple([]), response: savedTurnsSchema },
  /**
   * The update did not replace this copy, or was let go (Update later): a
   * turn still stopping goes on as if never asked, and turns start here
   * again. `stopped` names each task whose turn the save stopped, and
   * `withdrawn` each one whose stop it withdrew, whose turn goes on there.
   */
  [WORK_RELEASE_ORDER]: { effect: "change", request: z.tuple([]), response: releasedTurnsSchema },
} as const;

/**
 * The update order a home asks a computer that runs work whatever version it
 * runs (docs/helper.md, "Updated by its home"): bring Firstmate there to the
 * home's own version. A computer that keeps a copy of Firstmate gets the
 * home's at `FETCH_APP_PATH` with its own key and keeps it in place of its
 * own; one that runs its Mac's own app has nothing to get. Either answers,
 * then lets its run end, and its background starts it again from what is
 * kept there; `restarts` says whether a background is set up there to do so.
 *
 * It is asked of a computer on any major from `WORK_UPDATE_SINCE` on, so its
 * name and shape never change: a later major adds an order beside it, never
 * in its place.
 */
export const updateOrders = {
  "fm:firstmate:update": {
    effect: "change",
    request: z.tuple([]),
    response: z.object({ restarts: z.boolean(), needsPackage: z.literal(true).optional() }),
  },
} as const satisfies Record<
  `fm:firstmate:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type UpdateOrderChannel = keyof typeof updateOrders;
export const UPDATE_ORDER_CHANNELS = Object.keys(updateOrders) as UpdateOrderChannel[];
export const WORK_UPDATE_ORDER: UpdateOrderChannel = "fm:firstmate:update";
export type WorkUpdateAnswer = z.infer<(typeof updateOrders)[typeof WORK_UPDATE_ORDER]["response"]>;

/** Where the home's version is published for a Mac, and the SHA-256 it is checked against. */
export const updateDownloadSchema = z.object({
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/\S+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type UpdateDownload = z.infer<typeof updateDownloadSchema>;

const downloadCountShape = {
  received: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
};
/**
 * What is under way where a home asked a download: `idle`, nothing in this
 * run; `downloading`; `updating`, what arrived is checked and being kept, or
 * the update order runs, so it starts again from the new copy; `failed` or
 * `mismatch`, the last download ended with nothing there changed. The
 * progress order's shape never changes across majors, so a state a later
 * version adds is still read: a home reads one it does not know as under way.
 */
export const UPDATE_PROGRESS_STATES = [
  "idle",
  "downloading",
  "updating",
  "failed",
  "mismatch",
  // A source build's steps (`sourceOrders`), which a home before them reads as under way.
  "fetching",
  "installing",
  "building",
] as const;
export type UpdateProgressState = (typeof UPDATE_PROGRESS_STATES)[number];

/**
 * How far a download the home asked for has got: the bytes received, the
 * size its release stated (only when it stated one, and never a redirect's),
 * and what is under way there (`UPDATE_PROGRESS_STATES`). A home whose
 * connection dropped while it asked reads it to follow that download
 * (docs/devices.md, "Downloading over the connection").
 */
export const updateProgressSchema = z.object({
  ...downloadCountShape,
  state: z.string().min(1).max(64),
});
/** How far a download has got, as a computer of this version says it: one of the states it knows. */
export type UpdateProgress = Omit<z.infer<typeof updateProgressSchema>, "state"> & {
  state: UpdateProgressState;
};

/**
 * The orders a home asks a Mac that runs work to download its update itself
 * (docs/devices.md, "Downloading over the connection"), of a computer on
 * any major from `WORK_DOWNLOAD_SINCE` on, so their names and shapes never
 * change either. `fm:firstmate:update-download` gets the home's published
 * version over HTTPS, checks its SHA-256 and its publisher, keeps it in
 * place of the copy there and answers as the update order does; or answers
 * `fallback` with nothing there changed - the download failed, stopped with
 * nothing moving, or did not match (`mismatch`) - and the home sends its own
 * copy with the update order. Either answer carries the download's last
 * count. One asked while a download or an update already runs there answers
 * `updating`, and the home follows that one. `fm:firstmate:update-progress`
 * answers how far that download has got, which the home asks while it runs.
 */
export const downloadOrders = {
  "fm:firstmate:update-download": {
    effect: "change",
    request: z.tuple([updateDownloadSchema]),
    response: z.union([
      z.object({ restarts: z.boolean(), ...downloadCountShape }),
      z.object({ fallback: z.enum(["failed", "mismatch"]), ...downloadCountShape }),
      z.object({ updating: z.literal(true) }),
    ]),
  },
  "fm:firstmate:update-progress": {
    effect: "read",
    request: z.tuple([]),
    response: updateProgressSchema,
  },
} as const satisfies Record<
  `fm:firstmate:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type DownloadOrderChannel = keyof typeof downloadOrders;
export const DOWNLOAD_ORDER_CHANNELS = Object.keys(downloadOrders) as DownloadOrderChannel[];
export const WORK_DOWNLOAD_ORDER = "fm:firstmate:update-download" satisfies DownloadOrderChannel;
/** The order that reads how far the download has got. */
export const WORK_PROGRESS_ORDER = "fm:firstmate:update-progress" satisfies DownloadOrderChannel;
export type WorkDownloadAnswer = z.infer<
  (typeof downloadOrders)[typeof WORK_DOWNLOAD_ORDER]["response"]
>;

/**
 * The step a source build stopped at on a computer (`sourceOrders`), with
 * nothing there changed: `system`, it is no Mac; `tools`, it found no Node
 * or pnpm to build with; `fetch`, the source did not arrive whole; `install`
 * and `build`, its packages did not install or it did not build; `keep`, its
 * background could not be moved to the build.
 */
export const SOURCE_BUILD_STEPS = ["system", "tools", "fetch", "install", "build", "keep"] as const;
export type SourceBuildStep = (typeof SOURCE_BUILD_STEPS)[number];

/** The contract change that brings `build` in the hello and the source order. */
export const SOURCE_BUILDS_CHANGE = "source-builds";

/**
 * The order a home run from source asks a Mac that runs work for it, once
 * that computer lists `source-builds` (docs/devices.md, "Matching the home's build";
 * docs/helper.md, "Building the home's source"): get the home's committed
 * source at `commit` from `FETCH_SOURCE_PATH` with its own key, install its
 * packages, build it, and have its background run Electron from that folder
 * on trial, as an update keeps a copy. It answers `restarts` as the update
 * order does, and its run ends; or `failed` with the step it stopped at and
 * the last lines that step printed, with nothing there changed. One asked
 * while an update or another build runs there answers `updating`. While it
 * runs, the progress order says `fetching`, `installing` or `building`.
 */
export const sourceOrders = {
  "inf:source:build": {
    effect: "change",
    request: z.tuple([z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/) })]),
    response: z.union([
      z.object({ restarts: z.boolean() }),
      z.object({
        failed: z.enum(SOURCE_BUILD_STEPS),
        detail: z.string().max(4000).optional(),
      }),
      z.object({ updating: z.literal(true) }),
    ]),
  },
} as const satisfies Record<
  `inf:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type SourceOrderChannel = keyof typeof sourceOrders;
export const SOURCE_ORDER_CHANNELS = Object.keys(sourceOrders) as SourceOrderChannel[];
/** The source build order's channel. */
export const WORK_SOURCE_ORDER = "inf:source:build" satisfies SourceOrderChannel;
export type WorkSourceAnswer = z.infer<(typeof sourceOrders)[typeof WORK_SOURCE_ORDER]["response"]>;
