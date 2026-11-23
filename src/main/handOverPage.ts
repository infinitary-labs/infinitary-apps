import type {
  FolderSummary,
  MoveItem,
  MovePhase,
  MoveProgress,
  MoveRefusal,
} from "@core/folderMove/move";
import { formatDateTime, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * What the one-time move's hand-over window shows (./handOver.ts), as a
 * standalone page with no script of its own: the move under way, the
 * question when both folders hold work, the work ready, or why the move
 * stopped. Every button is a form's submit button; the window reads which
 * one was pressed from the navigation it starts and stops it there. While
 * the move works, the window redraws the page's live part (`workingLive`)
 * as it goes. While it takes over from an older copy still running with no
 * window (src/core/folderMove/takeOver.ts), it says so, and asks before it
 * ends one that did not stop.
 */

/** The two apps by the names a person knows them: `from` Firstmate 3000, `to` Infinitary. */
export type HandOverNames = { from: string; to: string };

export type MoveClock = { elapsedMs: number; stepElapsedMs: number };

export type HandOverView =
  | { kind: "working"; progress: MoveProgress; clock?: MoveClock }
  | { kind: "ask"; from: FolderSummary; to: FolderSummary }
  | { kind: "moved" }
  | { kind: "refused"; refusal: MoveRefusal }
  /** Asking the older copy holding the saved work to save and stop. */
  | { kind: "stopping" }
  /** It was asked and still holds the saved work. */
  | { kind: "wont-stop" };

/** What a button asks the window to do: `force` ends the older copy that did not stop. */
export type HandOverAction = "bring" | "keep" | "later" | "again" | "quit" | "force";

const ACTIONS: readonly HandOverAction[] = ["bring", "keep", "later", "again", "quit", "force"];

/** Where every button's form goes: a name nothing answers, read and stopped by the window. */
export const HAND_OVER_ADDRESS = "https://hand-over.invalid/";

export function actionOf(url: string): HandOverAction | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (`${parsed.origin}/` !== HAND_OVER_ADDRESS) return undefined;
  const asked = parsed.searchParams.get("do");
  return ACTIONS.find((action) => action === asked);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Bytes as a person reads them, decimal like the system's own disk sizes. */
export function sizeOf(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const STEPS: readonly { phase: MovePhase; words: string }[] = [
  { phase: "checking", words: "Counting" },
  { phase: "copying", words: "Copying" },
  { phase: "verifying", words: "Checking the copy" },
  { phase: "finishing", words: "Finishing" },
];

/** A count as a person reads it, with thousands grouped: 324,350. */
export function countOf(count: number): string {
  return formatNumber(Math.round(count));
}

export function durationOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** How long the current step has run before its estimate is shown: its first seconds say little of its pace. */
const ESTIMATE_AFTER_MS = 3000;

/**
 * The time left in the current step at the pace it has kept so far, or
 * undefined while it is too early to say.
 */
export function stepLeftMs(progress: MoveProgress, stepElapsedMs: number): number | undefined {
  const { done, total } = progress;
  if (total <= 0 || done <= 0 || stepElapsedMs < ESTIMATE_AFTER_MS) return undefined;
  return (stepElapsedMs * Math.max(0, total - done)) / done;
}

/** How full the bar is: the share of the current step's entries done. */
export function fillOf(progress: MoveProgress): number {
  if (progress.phase === "finishing") return 1;
  if (progress.total <= 0) return 0;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

export function itemWords(item: MoveItem): string {
  const mono = (name: string | undefined) =>
    name ? ` <span class="mono">${escapeHtml(name)}</span>` : "";
  const place = `, ${countOf(item.index)} of ${countOf(item.of)}`;
  const files =
    item.files > 0 ? `, with ${countOf(item.files)} ${item.files === 1 ? "file" : "files"}` : "";
  switch (item.kind) {
    case "working-copy":
      return `the working copy of task${mono(item.name)}${place}${files}`;
    case "spare-working-copy":
      return `a spare working copy${place}${files}`;
    case "task-records":
      return `the records of task${mono(item.name)}${place}${files}`;
    case "project":
      return `the clone of project${mono(item.name)}${place}${files}`;
    case "saved-work":
      return "the rest of your saved work";
  }
}

function stepNote(progress: MoveProgress, step: MovePhase): string {
  if (step === "checking" && progress.phase !== "checking" && progress.counted)
    return `: ${countOf(progress.counted.files)} files, ${sizeOf(progress.counted.bytes)}`;
  if (step !== progress.phase) return "";
  const index = STEPS.findIndex((each) => each.phase === step);
  return `, step ${index + 1} of ${STEPS.length}`;
}

function whyWords(progress: MoveProgress): string {
  const counted = progress.counted;
  if (!counted || counted.files === 0) return "";
  if (counted.workingCopies > 0 && counted.workingCopyFiles * 2 >= counted.files)
    return `Most of this time is your ${countOf(counted.workingCopies)} ${counted.workingCopies === 1 ? "working copy" : "working copies"}, which hold ${countOf(counted.workingCopyFiles)} of the ${countOf(counted.files)} files.`;
  return `The time goes on the number of files: ${countOf(counted.files)}, each copied and checked.`;
}

/**
 * The live part of the working view, which the window redraws as the move
 * goes: the four steps with the current one lit, what is being copied, the
 * bar, the counts and times, and why it takes this long.
 */
export function workingLive(progress: MoveProgress, clock?: MoveClock): string {
  const current = STEPS.findIndex((step) => step.phase === progress.phase);
  const steps = STEPS.map((step, index) => {
    const state = index < current ? "done" : index === current ? "current" : "next";
    return `<li class="${state}"${state === "current" ? ' aria-current="step"' : ""}>${escapeHtml(step.words)}${stepNote(progress, step.phase)}</li>`;
  }).join("");
  const doing =
    progress.phase === "copying" && progress.item
      ? `Copying ${itemWords(progress.item)}`
      : progress.phase === "checking"
        ? `Counting what to copy: ${countOf(progress.done)} files and folders, ${sizeOf(progress.bytes ?? 0)}`
        : progress.phase === "verifying"
          ? "Checking that the copy matches your saved work"
          : progress.phase === "finishing"
            ? "Putting the copy in place"
            : "Copying";
  const counts =
    progress.total > 0 && progress.phase !== "finishing"
      ? [`${countOf(progress.done)} of ${countOf(progress.total)} files and folders`]
      : [];
  if (clock) {
    counts.push(`${durationOf(clock.elapsedMs)} so far`);
    const left = stepLeftMs(progress, clock.stepElapsedMs);
    // Under half a second left reads as zero: the step is as good as done.
    if (left !== undefined && left >= 500 && progress.phase !== "finishing")
      counts.push(`about ${durationOf(left)} left in this step`);
  }
  const why = progress.phase === "finishing" ? "" : whyWords(progress);
  return `<ol class="steps">${steps}</ol>
        <p class="doing">${doing}</p>
        <div class="bar" aria-hidden="true"><div style="width: ${(fillOf(progress) * 100).toFixed(1)}%"></div></div>
        <p class="counts">${escapeHtml(counts.join(" · "))}</p>
        ${why ? `<p class="why">${escapeHtml(why)}</p>` : ""}`;
}

function buttons(
  rows: readonly { action: HandOverAction; label: string; primary?: boolean }[],
): string {
  return `<form class="actions" method="get" action="${HAND_OVER_ADDRESS}">${rows
    .map(
      (row, index) =>
        `<button type="submit" name="do" value="${row.action}" class="${row.primary ? "primary" : "secondary"}"${index === 0 ? " autofocus" : ""}>${escapeHtml(row.label)}</button>`,
    )
    .join("")}</form>`;
}

function opened(summary: FolderSummary): string {
  if (summary.lastOpened === undefined) return "Never opened";
  const when = formatDateTime(summary.lastOpened, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Last opened <span class="mono">${escapeHtml(when)}</span>`;
}

function refusalWords(
  refusal: MoveRefusal,
  names: HandOverNames,
): { title: string; text: string; again: boolean } {
  const unchanged = "Nothing has been changed.";
  switch (refusal.reason) {
    case "busy":
      return {
        title: `${names.to} is already moving your saved work`,
        text: `Another ${names.to} window is moving it. That window closes when the move finishes. ${unchanged}`,
        again: true,
      };
    case "old-app-open":
      return {
        title: `${names.from} is still open`,
        text: `Quit ${names.from}, then choose Try again. ${unchanged}`,
        again: true,
      };
    case "old-work-running":
      return {
        title: `${names.from} is still running work for another computer`,
        text: `That work runs in the background with your saved work open. Wait for it to stop, or restart this computer, then choose Try again. ${unchanged}`,
        again: true,
      };
    case "app-runs-inside":
      return {
        title: `${names.to} is running from inside its current work`,
        text: `Bringing ${names.from}'s work moves ${names.to}'s current work to a folder beside it, and this copy of ${names.to} runs from inside that work for another computer. Bring cannot happen while this computer runs work for another one. Quit, open ${names.to} again and choose Keep ${names.to}'s work, or first remove this computer in Your devices on the computer it runs work for. ${unchanged}`,
        again: false,
      };
    case "own-work-running":
      return {
        title: `${names.to} is running work for another computer from this folder`,
        text: `Bringing ${names.from}'s work moves ${names.to}'s current work to a folder beside it, and that work runs in the background from there. Bring cannot happen while this computer runs work for another one. Quit, open ${names.to} again and choose Keep ${names.to}'s work, or first remove this computer in Your devices on the computer it runs work for, then choose Try again. ${unchanged}`,
        again: true,
      };
    case "unsupported":
      return {
        title: `This version of ${names.to} cannot open your saved work`,
        text: `A newer version of ${names.from} saved it. Update ${names.to}, then open it again. ${unchanged}`,
        again: false,
      };
    case "no-space":
      return {
        title: "There is not enough room to move your saved work",
        text: `Moving it needs about <span class="mono">${sizeOf(refusal.needed)}</span> free, and this computer has <span class="mono">${sizeOf(refusal.free)}</span>. Make room, then choose Try again. ${unchanged}`,
        again: true,
      };
    case "failed":
      return refusal.committed
        ? {
            title: `${names.to} could not finish moving your saved work`,
            text: `Your saved work is safe: ${names.from}'s folder is as it was. Choose Try again to finish the move.`,
            again: true,
          }
        : {
            title: `${names.to} could not move your saved work`,
            text: `${unchanged} ${names.from}'s folder is as it was. Choose Try again, or quit and open ${names.to} later.`,
            again: true,
          };
  }
}

export function handOverBody(view: HandOverView, names: HandOverNames): string {
  switch (view.kind) {
    case "working":
      return `<main aria-label="Moving your saved work">
        <h1>Moving your saved work to ${escapeHtml(names.to)}</h1>
        <p>Your tasks, cards, projects and sign-ins come over from ${escapeHtml(names.from)}. Its folder stays as it was, as a recovery copy.</p>
        <div id="live">${workingLive(view.progress, view.clock)}</div>
        <div id="leave"${view.progress.phase === "finishing" ? " hidden" : ""}>
          <p class="note">You can quit and come back later: nothing changes until the copy has been checked, and the move starts again the next time you open ${escapeHtml(names.to)}.</p>
          ${buttons([{ action: "quit", label: "Quit, continue later" }])}
        </div>
        <p class="note" id="opens">${escapeHtml(names.to)} opens by itself when your work is ready.</p>
      </main>`;
    case "ask":
      return `<main aria-label="Choose your saved work">
        <h1>${escapeHtml(names.to)} found saved work in two places</h1>
        <p>Choose the work ${escapeHtml(names.to)} opens. Nothing is merged and nothing is deleted.</p>
        <dl class="folders">
          <div><dt>${escapeHtml(names.from)}</dt><dd>${opened(view.from)}</dd></div>
          <div><dt>${escapeHtml(names.to)}</dt><dd>${opened(view.to)}</dd></div>
        </dl>
        ${buttons([
          { action: "bring", label: `Bring ${names.from}'s work` },
          { action: "keep", label: `Keep ${names.to}'s work` },
          { action: "later", label: "Decide later" },
        ])}
        <p class="note">Bringing ${escapeHtml(names.from)}'s work keeps ${escapeHtml(names.to)}'s current work in a folder beside it. Keeping ${escapeHtml(names.to)}'s work leaves ${escapeHtml(names.from)}'s folder as it is.</p>
      </main>`;
    case "moved":
      return `<main aria-label="Your saved work is ready">
        <h1>Your saved work is in ${escapeHtml(names.to)}</h1>
        <p class="status" role="status">Opening ${escapeHtml(names.to)}.</p>
        <div class="bar" aria-hidden="true"><div style="width: 100%"></div></div>
      </main>`;
    case "stopping":
      return `<main aria-label="${escapeHtml(m.handoverStoppingTitle({ from: names.from }))}">
        <h1>${escapeHtml(m.handoverStoppingTitle({ from: names.from }))}</h1>
        <p class="status" role="status">${escapeHtml(m.handoverStoppingText(names))}</p>
      </main>`;
    case "wont-stop":
      return `<main aria-label="${escapeHtml(m.handoverWontStopTitle({ from: names.from }))}">
        <h1>${escapeHtml(m.handoverWontStopTitle({ from: names.from }))}</h1>
        <p role="alert">${escapeHtml(m.handoverWontStopText({ to: names.to }))}</p>
        ${buttons([
          { action: "force", label: m.handoverStopNow(), primary: true },
          { action: "quit", label: m.handoverQuit() },
        ])}
      </main>`;
    case "refused": {
      const words = refusalWords(view.refusal, names);
      return `<main aria-label="Your saved work did not move">
        <h1>${escapeHtml(words.title)}</h1>
        <p role="alert">${words.text}</p>
        ${buttons([
          ...(words.again ? [{ action: "again" as const, label: "Try again", primary: true }] : []),
          { action: "quit", label: "Quit", primary: !words.again },
        ])}
      </main>`;
    }
  }
}

/** The page's own styles: the design system's button, bar and list, nothing more. */
export const HAND_OVER_CSS = `
  .mono { font-family: var(--font-mono); font-size: var(--text-sm); }
  .status { color: var(--fg-1); margin-bottom: var(--space-3); }
  .note { font-size: var(--text-sm); color: var(--fg-3); margin-top: var(--space-5); }
  .steps { list-style: none; margin: 0 0 var(--space-5); padding: 0; display: grid; gap: var(--space-2); color: var(--fg-3); }
  .steps li { display: flex; align-items: center; gap: var(--space-3); }
  .steps li::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--line-2); box-sizing: border-box; flex: none; }
  .steps li.done::before { background: var(--ok-dim); border-color: var(--ok); }
  .steps li.current { color: var(--fg-1); }
  .steps li.current::before { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .doing { color: var(--fg-1); margin-bottom: var(--space-3); }
  .counts { font-size: var(--text-sm); color: var(--fg-2); font-variant-numeric: tabular-nums; margin: var(--space-3) 0 var(--space-5); min-height: 1lh; }
  .why { font-size: var(--text-sm); color: var(--fg-3); margin-bottom: 0; }
  #leave .note { margin-bottom: var(--space-3); }
  .bar { height: 3px; border-radius: var(--radius-pill); background: var(--line-1); overflow: hidden; }
  .bar > div { height: 100%; background: var(--accent); transition: width var(--dur-fast) var(--ease-drift); }
  .folders { margin: 0 0 var(--space-5); padding: 0; display: grid; gap: var(--space-3); }
  .folders > div { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) var(--space-4); border: 1px solid var(--line-1); border-radius: var(--radius-m); }
  .folders dt { color: var(--fg-1); font-weight: var(--weight-medium); }
  .folders dd { margin: 0; color: var(--fg-2); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: 0; }
  button { font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); line-height: 1; white-space: nowrap; padding: 9px 16px; border-radius: var(--radius-m); border: 1px solid transparent; cursor: pointer; transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out); }
  button.primary { background: var(--accent); color: #05070d; }
  button.primary:hover { background: var(--accent-strong); }
  button.secondary { background: transparent; color: var(--fg-1); border-color: var(--line-2); }
  button.secondary:hover { background: var(--bg-3); }
  button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
`;
