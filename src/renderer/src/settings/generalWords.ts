/** Settings → General's words (`GeneralTab.tsx`). */

/** What the purge row says once a purge went through: how many tasks it removed. */
export function purgedTasksText(count: number): string {
  return count === 1 ? "1 task purged." : `${count} tasks purged.`;
}

/**
 * The Your panels row (`YourPanelsRow`): its title, what it says while the
 * captain's panels may run, and why they are off after a safe-mode boot.
 */
export const YOUR_PANELS_WORDS = {
  title: "Your panels",
  on: "The panels your first mate built for you and the ones you added. Off takes them all down until you turn them back on.",
  safeMode:
    "Turned off after the app closed twice just after starting. Turn them back on when you are ready.",
} as const;
