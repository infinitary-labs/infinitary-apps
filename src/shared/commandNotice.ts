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

/**
 * How the command ended: as its own record says, or `crashed` when it left
 * none. `not-answering` is a command that still runs and has not answered
 * the window in time (INF-4622): it never ended. Beside the program this
 * window started, Restart it ends it by force and starts it again; Start it
 * here stops it before this window runs the first mate itself. `restart` ends it to start its first mate again here, after a move
 * to another computer failed or the captain started it here again
 * (docs/devices.md, "Moving the first mate"); its notice speaks as any
 * other stop does.
 */
export const commandEndingSchema = z.enum([
  "quit",
  "signal",
  "updated",
  "restart",
  "start-failed",
  "crashed",
  "not-answering",
]);
export type CommandEnding = z.infer<typeof commandEndingSchema>;

export const commandNoticeSchema = z.strictObject({
  /**
   * `waiting` while its start entry is expected to start it again, or, on
   * `not-answering`, while Start it here waits for that run to stop;
   * `stopped` once Start it here is offered.
   */
  state: z.enum(["waiting", "stopped"]),
  ending: commandEndingSchema,
  /**
   * Set when this window started the program itself (docs/run.md, "The
   * window starts it"): the person never ran a command, so the line speaks
   * of their first mate, and Start it here starts that program again.
   */
  byWindow: z.literal(true).optional(),
  /**
   * Set on `not-answering` when the notice names no run that does not
   * answer: its door named none, or another run holds the folder now.
   * Start it here then stops nothing, and the app starting again connects
   * to whichever run is there; the line says so.
   */
  retries: z.literal(true).optional(),
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
    case "not-answering":
      return m.commandNoticeWindowNotAnswering();
    case "start-failed":
      return m.commandNoticeWindowStartFailed();
    default:
      return m.commandNoticeWindowStopped();
  }
}

export const COMMAND_NOTICE_WORDS = {
  title: (notice: CommandNotice): string =>
    notice.ending === "not-answering"
      ? "Infinitary is not answering"
      : notice.ending === "updated"
        ? notice.state === "waiting"
          ? "Infinitary is updating"
          : "Infinitary was updated"
        : "Infinitary stopped",
  line: (notice: CommandNotice): string => {
    // Start it here waiting for a run that does not answer to stop: it still runs until then.
    if (notice.ending === "not-answering" && notice.state === "waiting")
      return m.commandNoticeStopping();
    if (notice.ending === "not-answering" && notice.retries)
      return m.commandNoticeNotAnsweringRetry();
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
      case "not-answering":
        return "Infinitary started by a command is running but not answering. Wait for it, or start it here to stop it and carry on in this window.";
      case "start-failed":
        return "Infinitary started by a command could not start. Start it here to carry on in this window.";
      default:
        return "Infinitary started by a command was stopped, so your first mate is not running. Start it here to carry on in this window.";
    }
  },
  startHere: "Start it here",
  restart: "Restart it",
  quit: "Quit",
} as const;
