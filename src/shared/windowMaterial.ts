/**
 * How the main process tells the renderer what the window is made of
 * (docs/translucent-window.md). A shown macOS window is the system's
 * under-window material and the page must paint a translucent tint over
 * it; every other window is opaque and the page paints the void. The
 * choice rides the preload's argv (`additionalArguments`), so the document
 * knows it before its first paint and no IPC round trip is needed.
 */
export type WindowMaterialKind = "opaque" | "translucent";

export const WINDOW_MATERIAL_ARG = "--fm-window-material=";

/** The `<html data-window-material>` value the preload sets. */
export const WINDOW_MATERIAL_ATTRIBUTE = "data-window-material";

export function windowMaterialArgument(kind: WindowMaterialKind): string {
  return `${WINDOW_MATERIAL_ARG}${kind}`;
}

/** Opaque unless the argument says translucent; an absent or odd value is opaque. */
export function windowMaterialFromArgv(argv: readonly string[]): WindowMaterialKind {
  const arg = argv.find((entry) => entry.startsWith(WINDOW_MATERIAL_ARG));
  return arg?.slice(WINDOW_MATERIAL_ARG.length) === "translucent" ? "translucent" : "opaque";
}
