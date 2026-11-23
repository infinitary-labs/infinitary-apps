import { Type } from "typebox";
import { mountLine } from "../personal/panelMounts";
import type { PanelCaptureResult, PanelPlaceResult } from "../personal/personalExtensions";
import { crewmateTool } from "../session/tools";

/**
 * The live-build crewmate's three checks (talk-to-personalize Step 4, design
 * section 6 layers 5 and 6; docs/personal-panels.md "Placed on the rail"):
 * `lint_panel` reads the extension's files and answers with the adherence
 * findings and the compiler's verdict; `place_panel` puts the version being
 * built on the captain's own rail and answers with what the window did
 * with it; `capture_panel` screenshots the panel in both themes at rail
 * width and hands the pictures back. All three are handed only to a
 * crewmate on the personal workspace, whichever backend runs it. Each is
 * one entry of the crewmate tool spec (`../session/tools.ts`), so the
 * Claude client's tool server serves the same names and descriptions.
 * None writes anything the crewmate did not: the lint rewrites nothing, the
 * placing commits nothing, the capture changes nothing but a file under
 * the task's own directory.
 */

export const LINT_PANEL_TOOL_NAME = "lint_panel";
export const PLACE_PANEL_TOOL_NAME = "place_panel";
export const CAPTURE_PANEL_TOOL_NAME = "capture_panel";

export const LINT_PANEL_TOOL_DESCRIPTION = [
  "Check a personal panel's files against the design rules and the compiler.",
  "Answers with findings: a refusal must be fixed before the panel mounts, a warning names the nearest token, a note is worth a review; then the compiler's verdict when the extension does not compile.",
  "Pass id (the extension's directory name) to lint one; omit it to lint every extension you have changed this turn.",
  "Rewrites nothing. Run it before your report, and again after fixing.",
].join(" ");

export const PLACE_PANEL_TOOL_DESCRIPTION = [
  "Put the version of a personal panel you are building on the captain's rail, and read back what the window did.",
  "Until you place it or report, their rail keeps the panel's last commit and your version runs out of sight; a new panel is on no rail at all.",
  "Answers per panel in the window's own word: drawn (on which rail), collapsed, folded or in the More row, loading, stopped drawing, off its rail, hidden by the captain, or refused, with its reason.",
  "The placed version shows with the running dot until your report commits it; a save after placing runs out of sight again until you place again.",
  "Pass id (the extension's directory name) to place one; omit it to place every extension you changed. An id you did not change is only looked at.",
  "Run it before every report, then capture_panel to photograph the panel docked.",
  "When the window did not draw it and your files cannot change that (a hidden panel, panels switched off), say so in your report and wait on the captain; do not call it done.",
  "Folded or in the More row, the panel is built and on their rail, which is only too short: say where it sits, and never collapse, move or hide their other panels.",
].join(" ");

export const CAPTURE_PANEL_TOOL_DESCRIPTION = [
  "Screenshot a personal panel at rail width, in the dark theme and the light theme.",
  "While your saved files differ from the captain's rail, it photographs your version drawn out of sight, and says so; once place_panel has put that version on their rail, it photographs the panel docked.",
  "Returns both images and the files they were written to.",
  "The panel must be drawable: compiled, and its presence rule satisfied (a store-keyed presence needs data in that key first).",
  "Pass id: the extension's directory name.",
].join(" ");

export function renderCaptureText(result: PanelCaptureResult): string {
  if (!result.ok) return `Could not capture "${result.id}": ${result.reason}.`;
  const files = result.images.map(
    (image) =>
      `${image.theme}: ${image.width}x${image.height}${image.path ? ` at ${image.path}` : ""}`,
  );
  const which =
    result.photographed === "draft"
      ? `This is your version of "${result.id}", drawn out of sight: the captain's rail does not show it yet. place_panel puts it there; capture again then to see it docked.`
      : `This is "${result.id}" docked on the captain's rail, as they see it.`;
  const window =
    result.window && result.window.state !== "drawn"
      ? [`The window says it is ${mountLine(result.window)}.`]
      : [];
  return [
    `Captured "${result.id}" in both themes (the token themes, at the panel's docked size). Look at each: a panel that reads well in one and turns to mud in the other is not done.`,
    which,
    ...window,
    ...files,
  ].join("\n");
}

export function renderPlaceText(result: PanelPlaceResult): string {
  if (!result.ok) return `Could not place: ${result.reason}.`;
  const seconds = Math.round(result.waitedMs / 100) / 10;
  return result.panels
    .map((panel) => {
      const what = panel.placed
        ? `"${panel.id}" (${panel.title}): placed, so the captain's rail now takes it from your working files.`
        : `"${panel.id}" (${panel.title}): nothing of it is uncommitted, so nothing was placed; this is the window's word on the version their rail holds.`;
      const answer = panel.mount
        ? `The window says it is ${mountLine(panel.mount)}.`
        : panel.last
          ? `The window did not answer for this version in the ${seconds} seconds place_panel waited; its last word on "${panel.id}" was that it is ${mountLine(panel.last)}.`
          : `The window did not answer for it in the ${seconds} seconds place_panel waited.`;
      return `${what} ${answer}`;
    })
    .join("\n");
}

export const LINT_PANEL_TOOL = crewmateTool({
  name: LINT_PANEL_TOOL_NAME,
  label: "Lint panel",
  description: LINT_PANEL_TOOL_DESCRIPTION,
  parameters: Type.Object({
    id: Type.Optional(
      Type.String({
        description: "The extension's directory name; omit to lint everything you changed",
      }),
    ),
  }),
  bind: ({ onLintPanel }) =>
    onLintPanel &&
    (async (params) => ({ text: await onLintPanel(params.id ? { id: params.id } : {}) })),
});

export const PLACE_PANEL_TOOL = crewmateTool({
  name: PLACE_PANEL_TOOL_NAME,
  label: "Place panel",
  description: PLACE_PANEL_TOOL_DESCRIPTION,
  parameters: Type.Object({
    id: Type.Optional(
      Type.String({
        description: "The extension's directory name; omit to place everything you changed",
      }),
    ),
  }),
  bind: ({ onPlacePanel }) =>
    onPlacePanel &&
    (async (params) => ({
      text: renderPlaceText(await onPlacePanel(params.id ? { id: params.id } : {})),
    })),
});

/** A capture's images ride beside its text, on either runtime. */
export const CAPTURE_PANEL_TOOL = crewmateTool({
  name: CAPTURE_PANEL_TOOL_NAME,
  label: "Capture panel",
  description: CAPTURE_PANEL_TOOL_DESCRIPTION,
  parameters: Type.Object({
    id: Type.String({ description: "The extension's directory name" }),
  }),
  bind: ({ onCapturePanel }) =>
    onCapturePanel &&
    (async (params) => {
      const result = await onCapturePanel({ id: params.id });
      const text = renderCaptureText(result);
      return result.ok ? { text, images: result.images } : { text };
    }),
});
