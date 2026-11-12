import { z } from "zod";
import * as m from "./i18n/messages.generated";

/**
 * The notice over the whole window opened beside Infinitary started by a
 * command, once that no longer runs (docs/run.md, "When the command
 * stops"; design skill `components/devices/CommandStopped.prompt.md`).
 * The window never starts a first mate of its own while it waits: it
 * waits for whatever started the command to start it again, and offers
 * Start it here once nothing will, or nothing did in time.
 */

/** How the command ended: as its own record says, or `crashed` when it left none. */
export const commandEndingSchema = z.enum(["quit", "signal", "updated", "start-failed", "crashed"]);
export type CommandEnding = z.infer<typeof commandEndingSchema>;

export const commandNoticeSchema = z.strictObject({
  /** `waiting` while its start entry is expected to start it again; `stopped` once Start it here is offered. */
  state: z.enum(["waiting", "stopped"]),
  ending: commandEndingSchema,
  /**
   * Set when this window started the program itself (docs/run.md, "The
   * window starts it"): the person never ran a command, so the line speaks
   * of their first mate, and Start it here starts that program again.
   */
  byWindow: z.literal(true).optional(),
});
export type CommandNotice = z.infer<typeof commandNoticeSchema>;

/**
 * The words on the notice. Beside a command the person set up they say
 * "started by a command", never the command's own word; beside the program
 * this window started they speak of the person's first mate, from the
 * catalog (docs/i18n.md).
 */
function byWindowLine(notice: CommandNotice): string {
  if (notice.state === "waiting")
    return notice.ending === "updated"
      ? m.commandNoticeWindowUpdating()
      : m.commandNoticeWindowRestarting();
  switch (notice.ending) {
    case "updated":
      return m.commandNoticeWindowUpdated();
    case "crashed":
      return m.commandNoticeWindowCrashed();
    case "start-failed":
      return m.commandNoticeWindowStartFailed();
    default:
      return m.commandNoticeWindowStopped();
  }
}

export const COMMAND_NOTICE_WORDS = {
  title: (notice: CommandNotice): string =>
    notice.ending === "updated"
      ? notice.state === "waiting"
        ? "Infinitary is updating"
        : "Infinitary was updated"
      : "Infinitary stopped",
  line: (notice: CommandNotice): string => {
    if (notice.byWindow) return byWindowLine(notice);
    if (notice.state === "waiting")
      return notice.ending === "updated"
        ? "Infinitary started by a command is starting again on its new version. This window waits for it."
        : "Infinitary started by a command stopped and is starting again. This window waits for it.";
    switch (notice.ending) {
      case "updated":
        return "Infinitary started by a command ended for its update and has not started again. Start it here to carry on in this window.";
      case "crashed":
        return "Infinitary started by a command stopped without saying why and has not started again. Start it here to carry on in this window.";
      case "start-failed":
        return "Infinitary started by a command could not start. Start it here to carry on in this window.";
      default:
        return "Infinitary started by a command was stopped, so your first mate is not running. Start it here to carry on in this window.";
    }
  },
  startHere: "Start it here",
  quit: "Quit",
} as const;
