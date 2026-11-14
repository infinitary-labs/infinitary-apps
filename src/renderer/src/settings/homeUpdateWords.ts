import type { HomeUpdate } from "@shared/homeUpdate";
import { formatList, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * What the first mate's computer's update row says on a Mac that controls it
 * (docs/view.md, "Updating the first mate's computer"), from the home's own
 * answer. The phone says the same from the same answer (`PhoneHomeUpdate.swift`).
 */

/** The steps during which the update moves on by itself, so the row reads again. */
export function homeUpdateUnderWay(update: HomeUpdate | null): boolean {
  return (
    update !== null &&
    ["starting", "downloading", "saving", "restarting", "resuming"].includes(update.step)
  );
}

/** The steps after which the home quits to replace its copy: an unanswered read is the restart. */
export function homeUpdateAboutToRestart(update: HomeUpdate | null): boolean {
  return update?.step === "saving" || update?.step === "restarting";
}

/** Update starts the offered version: a newer one is offered, or the last try failed and it still is. */
export function homeUpdateOffersUpdate(update: HomeUpdate | null): boolean {
  return update?.offered != null && (update.step === "offered" || update.step === "failed");
}

/** The row's line: where the home's update stands; a step this version does not know shows the version. */
export function homeUpdateLine(update: HomeUpdate, name: string): string {
  const current = m.viewHomeUpdateCurrent({ version: update.version });
  switch (update.step) {
    case "offered":
      return update.offered ? m.viewHomeUpdateOffered({ name, version: update.offered }) : current;
    case "elsewhere":
      return update.problem ?? current;
    case "starting":
      return m.viewHomeUpdateStarting({ name });
    case "downloading":
      return update.offered
        ? m.viewHomeUpdateDownloading({ name, version: update.offered })
        : m.viewHomeUpdateStarting({ name });
    case "saving": {
      const saving = m.viewHomeUpdateSaving({ name });
      return update.waitingFor.length > 0
        ? `${saving} ${m.viewHomeUpdateWaitingFor({ tasks: formatList(update.waitingFor) })}`
        : saving;
    }
    case "restarting":
      return m.viewHomeUpdateRestarting({ name });
    case "resuming":
      return m.viewHomeUpdateResuming({ name });
    case "failed": {
      const failed = m.viewHomeUpdateFailed({ name });
      return update.problem ? `${failed} ${update.problem}` : failed;
    }
    case "current":
      return current;
    default:
      return update.version;
  }
}

/** What Update confirms against: the work that finishes first, the jobs that stop, and that nothing undoes it from here. */
export function homeUpdateConfirm(
  update: HomeUpdate,
  name: string,
): { title: string; lines: string[] } {
  const lines = [
    update.stops.tasks.length > 0
      ? m.viewHomeUpdateConfirmTasks({ tasks: formatList(update.stops.tasks) })
      : m.viewHomeUpdateConfirmNoTasks(),
  ];
  if (update.stops.jobs > 0)
    lines.push(m.viewHomeUpdateConfirmJobs({ jobs: formatNumber(update.stops.jobs) }));
  lines.push(m.viewHomeUpdateConfirmNoUndo({ name }));
  return {
    title: m.viewHomeUpdateConfirmTitle({ name, version: update.offered ?? update.version }),
    lines,
  };
}
