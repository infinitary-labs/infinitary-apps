import type { FolderSummary, MovePhase, MoveProgress, MoveRefusal } from "@core/folderMove/move";

/**
 * What the one-time move's hand-over window shows (./handOver.ts), as a
 * standalone page with no script of its own: the move under way, the
 * question when both folders hold work, the work ready, or why the move
 * stopped. Every button is a form's submit button; the window reads which
 * one was pressed from the navigation it starts and stops it there.
 */

/** The two apps by the names a person knows them: `from` Firstmate 3000, `to` Infinitary. */
export type HandOverNames = { from: string; to: string };

export type HandOverView =
  | { kind: "working"; progress: MoveProgress }
  | { kind: "ask"; from: FolderSummary; to: FolderSummary }
  | { kind: "moved" }
  | { kind: "refused"; refusal: MoveRefusal };

/** What a button asks the window to do. */
export type HandOverAction = "bring" | "keep" | "later" | "again" | "quit";

const ACTIONS: readonly HandOverAction[] = ["bring", "keep", "later", "again", "quit"];

/** Where every button's form goes: a name nothing answers, read and stopped by the window. */
export const HAND_OVER_ADDRESS = "https://hand-over.invalid/";

/** The action a navigation to `url` asks for, or undefined for anything else. */
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

const PHASE_WORDS: Readonly<Record<MovePhase, string>> = {
  checking: "Counting your saved work",
  copying: "Copying",
  verifying: "Checking the copy",
  finishing: "Finishing",
};

/** The status line and how full the bar is, for a move under way. */
export function progressLine(progress: MoveProgress): {
  status: string;
  amount: string;
  fill: number;
} {
  const { phase, done, total } = progress;
  const status = PHASE_WORDS[phase];
  if (phase === "finishing") return { status, amount: "", fill: 1 };
  if (total <= 0) return { status, amount: "", fill: 0 };
  const fill = Math.min(1, Math.max(0, done / total));
  return { status, amount: `${Math.floor(fill * 100)}%`, fill };
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
  const when = new Date(summary.lastOpened).toLocaleString(undefined, {
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

/** The page body for a view: the parts a person reads, and the buttons. */
export function handOverBody(view: HandOverView, names: HandOverNames): string {
  switch (view.kind) {
    case "working": {
      const line = progressLine(view.progress);
      return `<main aria-label="Moving your saved work">
        <h1>Moving your saved work to ${escapeHtml(names.to)}</h1>
        <p>Your tasks, cards, projects and sign-ins come over from ${escapeHtml(names.from)}. Its folder stays as it was, as a recovery copy.</p>
        <p class="status" role="status"><span id="status">${escapeHtml(line.status)}</span> <span id="amount" class="mono">${escapeHtml(line.amount)}</span></p>
        <div class="bar" aria-hidden="true"><div id="fill" style="width: ${(line.fill * 100).toFixed(1)}%"></div></div>
        <p class="note">Keep this window open. ${escapeHtml(names.to)} opens by itself when your work is ready.</p>
      </main>`;
    }
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
        <div class="bar" aria-hidden="true"><div id="fill" style="width: 100%"></div></div>
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
  .status .mono { color: var(--fg-2); margin-left: var(--space-2); }
  .note { font-size: var(--text-sm); color: var(--fg-3); margin-top: var(--space-5); }
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
