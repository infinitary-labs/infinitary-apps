import { Type } from "typebox";
import type { PanelCaptureResult } from "../personal/personalExtensions";
import { crewmateTool } from "../session/tools";

/**
 * The live-build crewmate's two checks (talk-to-personalize Step 4, design
 * section 6 layers 5 and 6): `lint_panel` reads the extension's files and
 * answers with the adherence findings and the compiler's verdict;
 * `capture_panel` screenshots the docked panel in both themes at rail width
 * and hands the pictures back. Both are handed only to a crewmate on the
 * personal workspace, whichever backend runs it. Each is one entry of the
 * crewmate tool spec (`../session/tools.ts`), so the Claude client's tool
 * server serves the same names and descriptions.
 * Neither writes anything the crewmate did not: the lint rewrites nothing,
 * the capture changes nothing but a file under the task's own directory.
 */

export const LINT_PANEL_TOOL_NAME = "lint_panel";
export const CAPTURE_PANEL_TOOL_NAME = "capture_panel";

export const LINT_PANEL_TOOL_DESCRIPTION = [
  "Check a personal panel's files against the design rules and the compiler.",
  "Answers with findings: a refusal must be fixed before the panel is mountable, a warning names the nearest token to use instead, a note is a shape worth a review; then the compiler's verdict when the extension does not compile.",
  "Pass id (the extension's directory name) to lint one; omit it to lint every extension you have changed this turn.",
  "Rewrites nothing. Run it before your report, and again after fixing.",
].join(" ");

export const CAPTURE_PANEL_TOOL_DESCRIPTION = [
  "Screenshot a personal panel as the captain sees it, docked on its rail at rail width, in the dark theme and the light theme.",
  "Returns both images and the files they were written to, so you can look at what you built rather than guess.",
  "The panel must be on a rail: compiled, and its presence rule satisfied (a store-keyed presence needs data in that key first).",
  "Pass id: the extension's directory name.",
].join(" ");

/** The capture result's text half, shared by both backends' tools. */
export function renderCaptureText(result: PanelCaptureResult): string {
  if (!result.ok) return `Could not capture "${result.id}": ${result.reason}.`;
  const files = result.images.map(
    (image) =>
      `${image.theme}: ${image.width}x${image.height}${image.path ? ` at ${image.path}` : ""}`,
  );
  return [
    `Captured "${result.id}" in both themes (the token themes, at the panel's docked size). Look at each: a panel that reads well in one and turns to mud in the other is not done.`,
    ...files,
  ].join("\n");
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
