import { fixedHoldWords, softHoldWords } from "@shared/holds";
import { said, saidLine } from "@shared/i18n/said";
import type { StandingDirections } from "../knowledge/directions";
import { keptYeses } from "../tasks/alreadyAllowed";
import type { TaskService } from "../tasks/taskService";
import type { WriteAskSent } from "./githubGateway";

/**
 * A kept write's soft hold (`kept-write`, docs/delivery-rigor.md "The
 * holds"; docs/forge.md, "A write that asks"): a write where a project
 * lives that the task keeps for the captain's click, which a yes of the
 * captain's that still stands also passes when the crewmate names it as
 * `github_write`'s allowance. The host checks only that the named yes still
 * stands (`keptYeses`); whether its words cover the write is the
 * crewmate's judgment, and the host never reads them.
 */

/** Why a write waits on the captain, and whether a named yes may pass it. */
export type KeepReason = { why: string; soft: boolean };

/** The named yes, when it still stands on the task: its card and the captain's words. */
export function standingYes(
  tasks: TaskService,
  taskId: string,
  allowance: string,
  directions?: Pick<StandingDirections, "standing">,
): { card: string; words: string } | undefined {
  const record = tasks.get(taskId);
  if (!record) return undefined;
  const yes = keptYeses(tasks, record, record.delivery?.headSha, directions).find(
    (kept) => kept.card === allowance,
  );
  return yes ? { card: yes.card, words: yes.words } : undefined;
}

/** The answer to an allowance that names no yes standing on the task: nothing kept or sent. */
export function notStandingWords(allowance: string): string {
  // i18n-exempt: served to the crewmate as a tool answer
  return `Refused: nothing was kept or sent. ${allowance} is no yes that still stands on this task: a project direction counts only while its served heard is not false, a card only while it is on your Already allowed list, and standing only while the captain's standing override stands. Name one whose words cover this write, or leave allowance out and the write is kept for the captain's click. ${softHoldWords("kept-write", "crewmate")}`;
}

/** The line a kept write's answer ends with when the allowance it named could not pass it. */
export function passedNothingWords(allowance: string): string {
  // i18n-exempt: served to the crewmate as a tool answer
  return `The allowance ${allowance} passed nothing: a named yes passes only a write this task would keep on its own project or through the github.com sign-in, never an unsafe data reader's write, one through an integration or one to another project.`;
}

/** What the crewmate hears of a write sent once on the yes it named, by what came of it. */
export function sentOnYesWords(sent: WriteAskSent, yes: string): string {
  const id = sent.ask?.id ?? "";
  switch (sent.outcome.kind) {
    case "answered":
      // i18n-exempt: served to the crewmate as a tool answer
      return `Sent once on ${yes}, which still stands, with no card: kept on this task as ask ${id}, which is never sent again.\n${sent.answer ?? ""}`;
    case "unknown":
      // i18n-exempt: served to the crewmate as a tool answer
      return `Sent once on ${yes}, but what came of it is unknown (${sent.outcome.why}). Ask ${id} is never sent again: read ${sent.place} with github_read to learn whether it arrived, and never send it another way. ${fixedHoldWords("sent-once")}`;
    default:
      // i18n-exempt: served to the crewmate as a tool answer
      return `Not sent: ${"why" in sent.outcome ? sent.outcome.why : ""}. Ask ${id} named ${yes} and is closed; call github_write again if the write is still needed.`;
  }
}

/** The longest run of the captain's words a timeline line quotes. */
const WORDS_SHOWN = 120;

function shown(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim();
  if (flat.length <= WORDS_SHOWN) return flat;
  const cut = flat.slice(0, WORDS_SHOWN - 1);
  // Cut at the last whole word, and drop the comma or stop it ended on.
  return `${cut.replace(/\s+\S*$/, "").replace(/[\s,;:.]+$/, "") || cut}…`;
}

/** The task's timeline line for a write sent on a yes, quoting the captain's words it named. */
export function sentOnYesLine(sent: WriteAskSent, words: string): ReturnType<typeof saidLine> {
  const fills = { call: sent.call, place: sent.place, words: shown(words) };
  switch (sent.outcome.kind) {
    case "answered":
      return saidLine(said("feedWriteSentOnWords", { ...fills, status: `${sent.outcome.status}` }));
    case "unknown":
      return saidLine(said("feedWriteUnknownOnWords", fills));
    default:
      return saidLine(
        said("feedWriteNotSentOnWords", {
          ...fills,
          why: "why" in sent.outcome ? sent.outcome.why : "",
        }),
      );
  }
}
