import { z } from "zod";

/**
 * Which updates an installation is offered (docs/alpha.md "Update
 * channels"): the installed cask remembers it, independently of the
 * version running.
 */
export const updateChannelSchema = z.enum(["stable", "alpha"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

/**
 * What the crew's work is doing around this computer's own update
 * (docs/alpha.md, "Saving work before an update"): `saving` while running
 * work stops where nothing is lost, before the copy is replaced; `resuming`
 * after the restart, until each turn the update stopped has started again.
 */
export const updateWorkSchema = z.object({
  state: z.enum(["saving", "resuming"]),
  /**
   * Saving: each task whose running work the update waits for, by its
   * title. Resuming: each task whose work has not started again.
   */
  tasks: z.array(z.string()),
});
export type UpdateWork = z.infer<typeof updateWorkSchema>;

export const updateStatusSchema = z.object({
  currentVersion: z.string(),
  /** The subscription the status was read for. */
  channel: updateChannelSchema,
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().nullable(),
  /**
   * The command that installs the offered version by hand, shown selectable
   * in the panel: the installed channel's cask upgrade on a Mac, the package
   * manager's on Arch or NixOS, or the system installer's when installing
   * from the app could not finish. Empty when there is none.
   */
  upgradeCommand: z.string(),
  /**
   * Present when the app installs the offered version itself (a deb, an rpm
   * or an AppImage on Linux; docs/alpha.md "Updates on Linux").
   */
  install: z
    .object({
      /** The system asks for the person's password before it installs. */
      asksPassword: z.boolean(),
      /** A Mac update downloads, verifies and restarts only after consent. */
      restarts: z.boolean().optional(),
    })
    .optional(),
  /** The local app owns a persistent choice, independently of the installed version. */
  channelChoice: z.boolean().optional(),
  phase: z.enum(["idle", "checking", "downloading", "installing", "ready", "error"]).optional(),
  percent: z.number().min(0).max(100).optional(),
  problem: z.string().optional(),
  notice: z.string().optional(),
  /** The crew's work around this update, while there is any to save or resume. */
  work: updateWorkSchema.optional(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** How installing the offered version ended, when the app is still running to say. */
export const updateInstallResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    /** What happened and what to do, in the panel's own words. */
    problem: z.string(),
    /**
     * The person chose Update later while work was saved: nothing went
     * wrong, the update waits and the work carries on.
     */
    later: z.literal(true).optional(),
  }),
]);
export type UpdateInstallResult = z.infer<typeof updateInstallResultSchema>;

export const presenceSettingsSchema = z.object({
  startAtLogin: z.boolean(),
  showInDock: z.boolean(),
});
export type PresenceSettings = z.infer<typeof presenceSettingsSchema>;
