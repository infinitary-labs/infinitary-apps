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

/**
 * A framed panel's drawing, read inside its own frame: the panel code runs in
 * a separate process, so its markup is not in the window's copy. It is set
 * back as a script-free `srcdoc` frame at the size it was drawn.
 */
export type CaptureFrame = { css: string; bodyHtml: string; width: number; height: number };

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function buildFrameCaptureHtml(frame: CaptureFrame, theme: CaptureTheme): string {
  const css = frame.css.replaceAll("</style", "<\\/style");
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:;">
<style>
${css}
</style>
</head>
<body data-theme="${theme}">
${frame.bodyHtml}
</body>
</html>
`;
}

export function buildCaptureHtml(input: {
  css: string;
  panelHtml: string;
  frames?: CaptureFrame[];
  theme: CaptureTheme;
  width: number;
  height: number;
}): string {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  const theme = input.theme === "light" ? "light" : "dark";
  // Copied CSS is data. A `</style>` inside it must not close the element.
  const css = input.css.replaceAll("</style", "<\\/style");
  const frames = input.frames ?? [];
  const panelHtml = input.panelHtml.replace(
    /<div data-capture-frame="(\d+)"><\/div>/g,
    (_marker, index: string) => {
      const frame = frames[Number(index)];
      if (!frame) return "";
      const frameWidth = Math.max(1, Math.round(frame.width));
      const frameHeight = Math.max(1, Math.round(frame.height));
      return `<iframe srcdoc="${escapeAttribute(buildFrameCaptureHtml(frame, theme))}" style="border:0;display:block;width:${frameWidth}px;height:${frameHeight}px"></iframe>`;
    },
  );
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
${panelHtml}
</body>
</html>
`;
}
