import { BrowserWindow, type WebContents } from "electron";
import { isTaskBrowserWindow } from "./host/taskBrowser";
import { isMediaProbeWindow } from "./mediaProbe";

/**
 * The app's own windows: every window but a task browser's hidden pages
 * (./host/taskBrowser.ts) and the media probe's (./mediaProbe.ts). An app
 * push, a reload, a focus, a notification's click or the dock's activate
 * reaches these and never a task's page, whose content is a project's, not
 * the app's, nor a recording being checked.
 */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !isTaskBrowserWindow(win) && !isMediaProbeWindow(win),
  );
}

const startingOver = new WeakSet<WebContents>();

/**
 * Starts every app window over on a new page, as the window becomes another
 * first mate's (docs/view.md). The page it leaves runs until the new one
 * commits, and a push in that gap would come from the first mate it now
 * shows: the leaving page would draw it, such as a view's "in reach" line,
 * and whatever reads that page reads one about to go. So until the new page
 * commits, or the start-over ends without one, the window hears no push
 * (`pushWindows`); the new page reads what is current as it starts.
 */
export function startWindowsOver(): void {
  for (const win of appWindows()) {
    if (win.isDestroyed()) continue;
    const contents = win.webContents;
    if (!startingOver.has(contents)) {
      startingOver.add(contents);
      const begun = () => {
        startingOver.delete(contents);
        contents.off("did-navigate", begun);
        contents.off("did-stop-loading", begun);
      };
      contents.on("did-navigate", begun);
      // A start-over that ends without the app's new page sends no did-navigate, but its loading
      // stops: a stopped one keeps the page it had, and a failed one shows the browser's error page.
      contents.on("did-stop-loading", begun);
    }
    contents.reload();
  }
}

/** The app windows a push reaches now: each open one but a window starting over (`startWindowsOver`). */
export function pushWindows(): BrowserWindow[] {
  return appWindows().filter(
    (win) =>
      !win.isDestroyed() && !win.webContents.isDestroyed() && !startingOver.has(win.webContents),
  );
}

const mainWindows = new WeakSet<BrowserWindow>();

/** Marks the app's main window, the one that shows the crew, Settings and its Keyboard settings. */
export function markMainWindow(win: BrowserWindow): void {
  mainWindows.add(win);
}

/**
 * The main windows open now, the ones a person uses: never a hidden helper
 * such as a panel's capture, a task browser's page or the media probe.
 */
export function openMainWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => mainWindows.has(win) && !win.isDestroyed());
}

const refusalWindows = new WeakSet<BrowserWindow>();

/**
 * Marks a standalone refusal a person sees in place of the main window
 * (./savedDataRefusal.ts), never one held hidden for a capture.
 */
export function markRefusalWindow(win: BrowserWindow): void {
  refusalWindows.add(win);
}

/**
 * The windows a person uses now: the main windows, and a refusal shown in
 * their place (`markRefusalWindow`), which a second launch brings forward.
 */
export function personWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => (mainWindows.has(win) || refusalWindows.has(win)) && !win.isDestroyed(),
  );
}

/** Whether a main window is open now: one that installs the keys Keyboard settings shows. */
export function mainWindowOpen(): boolean {
  return openMainWindows().length > 0;
}

/**
 * The window a system confirmation belongs to on Windows (Windows Hello or
 * the password, ./host/windowsFreshAuthentication.ts): the app's focused
 * window, else its first visible one, by its native handle. Absent in a run
 * with no window, where the dialog stands on its own.
 */
export function confirmationWindow(): Buffer | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  const own = appWindows();
  const win =
    focused && own.includes(focused) ? focused : own.find((candidate) => candidate.isVisible());
  return win?.getNativeWindowHandle();
}
