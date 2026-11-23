import * as m from "@shared/i18n/messages.generated";
import type { ResetAnswer } from "@shared/reset";
import type { BrowserWindow } from "electron";
import { HAND_OVER_CSS } from "../handOverPage";
import { standaloneDocument } from "../savedDataRefusal";

/**
 * A standalone screen shown when Infinitary cannot open, offering Reset
 * Infinitary (docs/reset.md, "Where a reset can start"): the screen's own
 * words and buttons, then the reset's question in place, with Keep
 * everything focused so Enter never resets. Like the hand-over, every button
 * is a form's submit button the window reads from its navigation; the page
 * runs no script of its own.
 */
export type ScreenWords = { title: string; message: string; next: string };

/** What a button on the screen asks. */
export type ScreenAction = "ask" | "keep" | "reset" | "again" | "quit";
const ACTIONS: readonly ScreenAction[] = ["ask", "keep", "reset", "again", "quit"];

/** Where every button's form goes: a name nothing answers, read and stopped by the window. */
export const SCREEN_ADDRESS = "https://reset.invalid/";

export function screenActionOf(url: string): ScreenAction | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (`${parsed.origin}/` !== SCREEN_ADDRESS) return undefined;
  const asked = parsed.searchParams.get("do");
  return ACTIONS.find((action) => action === asked);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type Row = { action: ScreenAction; label: string; kind: "primary" | "secondary" | "danger" };

function buttons(rows: readonly Row[], focus: ScreenAction): string {
  return `<form class="actions" method="get" action="${SCREEN_ADDRESS}">${rows
    .map(
      (row) =>
        `<button type="submit" name="do" value="${row.action}" class="${row.kind}"${row.action === focus ? " autofocus" : ""}>${escapeHtml(row.label)}</button>`,
    )
    .join("")}</form>`;
}

/** What the screen shows now. */
export type ScreenView =
  | { kind: "offer"; words: ScreenWords; again: boolean; note?: string }
  | { kind: "question" }
  | { kind: "resetting" };

export function screenBody(view: ScreenView): string {
  if (view.kind === "question")
    return `<main aria-label="${escapeHtml(m.settingsGeneralReset())}" data-reset-question="">
    <h1>${escapeHtml(m.settingsGeneralResetQuestion())}</h1>
    <p>${escapeHtml(m.settingsGeneralResetDeletes())}</p>
    <p>${escapeHtml(m.resetScreenKeeps())}</p>
    ${buttons(
      [
        { action: "keep", label: m.settingsGeneralResetKeep(), kind: "secondary" },
        { action: "reset", label: m.settingsGeneralReset(), kind: "danger" },
      ],
      "keep",
    )}</main>`;
  if (view.kind === "resetting")
    return `<main aria-label="${escapeHtml(m.settingsGeneralReset())}" aria-busy="true">
    <h1>${escapeHtml(m.settingsGeneralResetting())}</h1></main>`;
  const rows: Row[] = [
    ...(view.again
      ? [{ action: "again" as const, label: m.resetHeldTryAgain(), kind: "primary" as const }]
      : []),
    { action: "ask", label: m.settingsGeneralReset(), kind: "secondary" },
    ...(view.again
      ? [{ action: "quit" as const, label: m.resetHeldQuit(), kind: "secondary" as const }]
      : []),
  ];
  return `<main aria-label="${escapeHtml(view.words.title)}">
    <h1>${escapeHtml(view.words.title)}</h1><p>${escapeHtml(view.words.message)}</p>
    <p>${escapeHtml(view.words.next)}</p>
    ${view.note ? `<p class="note" role="status">${escapeHtml(view.note)}</p>` : ""}
    ${buttons(rows, view.again ? "again" : "ask")}</main>`;
}

const SCREEN_CSS = `${HAND_OVER_CSS}
  .actions { margin-top: var(--space-5); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
  button.danger:hover { background: var(--danger-dim); }
  .note { margin-top: 0; }
`;

export function screenDocument(view: ScreenView): string {
  return standaloneDocument({ title: "Infinitary", body: screenBody(view), css: SCREEN_CSS });
}

/**
 * Draws the screen in `win` and follows its buttons: Reset Infinitary asks
 * the question, Keep everything goes back, and Reset Infinitary runs
 * `reset`. A reset that was not confirmed goes back to the screen and says
 * nothing changed. `again` and `quit`, on a screen that offers them, are the
 * caller's.
 */
export async function followResetScreen(input: {
  win: BrowserWindow;
  words: ScreenWords;
  /** Whether the screen offers Try again and Quit beside Reset Infinitary. */
  again: boolean;
  reset: () => Promise<ResetAnswer>;
  onAgain?: () => void;
  onQuit?: () => void;
}): Promise<void> {
  const { win } = input;
  const show = (view: ScreenView) =>
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(screenDocument(view))}`);
  const offer = (note?: string) =>
    show({ kind: "offer", words: input.words, again: input.again, ...(note ? { note } : {}) });
  let resetting = false;
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    const action = screenActionOf(url);
    if (resetting || !action) return;
    if (action === "ask") void show({ kind: "question" });
    else if (action === "keep") void offer();
    else if (action === "again") input.onAgain?.();
    else if (action === "quit") input.onQuit?.();
    else {
      resetting = true;
      void show({ kind: "resetting" })
        .then(() => input.reset())
        .then(
          (answer) => {
            if (answer.outcome === "restarting") return;
            resetting = false;
            void offer(m.resetScreenKept());
          },
          (error: unknown) => {
            console.warn(`[reset] the reset did not start: ${String(error)}`);
            resetting = false;
            void offer(m.resetScreenKept());
          },
        );
    }
  });
  await offer();
}
