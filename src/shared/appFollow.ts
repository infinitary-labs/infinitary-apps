import { z } from "zod";
import * as m from "./i18n/messages.generated.ts";

/**
 * An Infinitary app open on another computer follows the home's version
 * (docs/view.md, "Following the home's version"; `app-follows-home`): at each
 * connection it reads the version the home runs and, while it is older, gets
 * that exact version through its own updater and starts it again while nobody
 * there uses it. It tells the home each step, and the home's Devices row
 * follows them; Update on that row has it start again at once.
 */

/** The contract change that adds the app's steps and the row's Update (`app-follows-home.md`). */
export const APP_FOLLOWS_HOME = "app-follows-home";

/**
 * Where the app stands in catching up with the home:
 * - `getting`: it downloads the home's version; `percent` says how far.
 * - `waiting`: it has the home's version and waits until nobody there uses it.
 * - `restarting`: it starts again on the home's version.
 * - `cannot`: it cannot install the home's version by itself; `reason` says why.
 * - `failed`: getting or installing it did not go through; `problem` says what happened.
 */
export const appFollowStepSchema = z.enum(["getting", "waiting", "restarting", "cannot", "failed"]);
export type AppFollowStep = z.infer<typeof appFollowStepSchema>;

/**
 * Why an app cannot install the home's version by itself:
 * - `package-manager`: a package manager installs it there, such as Homebrew;
 * - `own-window`: this kind of copy updates only from its own window there,
 *   as a Windows PC or a Linux package does;
 * - `installation`: the copy there cannot be replaced from its own updater,
 *   such as one not in Applications, or a run from source;
 * - `unpublished`: the home's version is not a published one.
 */
export const appFollowReasonSchema = z.enum([
  "package-manager",
  "own-window",
  "installation",
  "unpublished",
]);
export type AppFollowReason = z.infer<typeof appFollowReasonSchema>;

/**
 * What an app tells the home of its catching up (`inf:devices:app-follow`):
 * the home's version it follows, its step, and how far or why.
 */
export const appFollowReportSchema = z.strictObject({
  version: z.string().min(1).max(64),
  step: appFollowStepSchema,
  percent: z.number().min(0).max(100).optional(),
  reason: appFollowReasonSchema.optional(),
  /** The app's own words for what stopped it, said after the home's. */
  problem: z.string().min(1).max(400).optional(),
});
export type AppFollowReport = z.infer<typeof appFollowReportSchema>;

/**
 * What an app's own updater answers when asked to get one exact version
 * ready (`UpdateChecker.follow`): ready to start again on it, or why not.
 */
export type AppFollowResult =
  | { ok: true }
  | { ok: false; reason: AppFollowReason; problem?: string }
  | { ok: false; failed: string };

/**
 * The live frame a home sends the app open on one computer for its row's
 * Update: catch up now and start again as soon as it has the version. An
 * app from before ignores it.
 */
export const APP_UPDATE_LIVE = "inf:devices:update-app-now";

export const appUpdateAskSchema = z.strictObject({ deviceId: z.string().min(1).max(64) });

/** What an app's report answers when no app's own connection told it. */
// i18n-exempt: the refusal a request asked by the wrong side gets, never shown
export const APP_FOLLOW_ONLY = "What an app's catching up says is told only by that app.";

/** Why an app cannot install the home's version by itself, and what to do there, in words. */
export function appFollowWhy(reason: AppFollowReason, version: string): string {
  switch (reason) {
    case "package-manager":
      return m.devicesAppWhyPackageManager();
    case "own-window":
      return m.devicesAppWhyOwnWindow();
    case "installation":
      return m.devicesAppWhyInstallation({ version });
    case "unpublished":
      return m.devicesAppWhyUnpublished({ version });
  }
}

/**
 * What a Devices row says of an app catching up with this computer's
 * version (docs/devices.md, "Updating the app open there"), under its
 * version line.
 */
export function appFollowLine(report: AppFollowReport): string {
  const { version } = report;
  switch (report.step) {
    case "getting":
      return m.devicesAppGetting({ version, percent: String(report.percent ?? 0) });
    case "waiting":
      return m.devicesAppWaiting({ version });
    case "restarting":
      return m.devicesAppRestarting({ version });
    case "cannot":
      return `${m.devicesAppCannot({ version })} ${appFollowWhy(report.reason ?? "installation", version)}`;
    case "failed":
      return m.devicesAppFailed({ version });
  }
}
