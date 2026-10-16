/**
 * The HTML document a hidden window loads to photograph one docked panel in
 * one token theme. The live window is never in that document: copying the
 * panel's markup and the page CSS here is what keeps a capture from painting
 * the captain's whole UI light (or blank) while `capture_panel` runs.
 */

export type CaptureTheme = "dark" | "light";

/** Window backing color, matching `--bg-0` in `design/tokens/colors.css`. */
export const CAPTURE_WINDOW_BACKGROUND: Record<CaptureTheme, string> = {
  dark: "#05070d",
  light: "#eef1f7",
};

export function buildCaptureHtml(input: {
  css: string;
  panelHtml: string;
  theme: CaptureTheme;
  width: number;
  height: number;
}): string {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  const theme = input.theme === "light" ? "light" : "dark";
  // Copied CSS is data. A `</style>` inside it must not close the element.
  const css = input.css.replaceAll("</style", "<\\/style");
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:;">
<style>
${css}
html, body {
  margin: 0;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: var(--bg-0);
}
[data-side-panel] {
  width: ${width}px !important;
  max-width: none !important;
  min-height: ${height}px;
}
</style>
</head>
<body data-theme="${theme}">
${input.panelHtml}
</body>
</html>
`;
}
