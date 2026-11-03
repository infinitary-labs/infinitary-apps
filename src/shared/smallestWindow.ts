/**
 * The smallest the main window may be made, in its content's pixels
 * (src/main/app.ts): every screen is laid out to fit it, and the browser
 * tests draw the window at it (tests/browser/settings-width.test.tsx).
 */
export const SMALLEST_WINDOW = { width: 960, height: 640 } as const;
