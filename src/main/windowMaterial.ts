import { type WindowMaterialKind, windowMaterialArgument } from "@shared/windowMaterial";

/**
 * What the main window is made of (docs/translucent-window.md): on macOS a
 * shown window uses under-window vibrancy on macOS, with no backing color of its own - the
 * renderer paints `--material-tint` over it. Every other window keeps the
 * opaque void and the renderer paints `--bg-0`: other platforms have no
 * such material, and the hidden windows the e2e runs use stay opaque so
 * their pixel probes read the same frames they always did.
 */
export type WindowMaterial =
  | { kind: "opaque"; backgroundColor: "#05070d" }
  | {
      kind: "translucent";
      backgroundColor: "#00000000";
      vibrancy: "under-window";
      visualEffectState: "active";
    };

export const OPAQUE_VOID = "#05070d";

export function mainWindowMaterial(input: {
  platform: NodeJS.Platform;
  hidden: boolean;
}): WindowMaterial {
  if (input.platform === "darwin" && !input.hidden) {
    return {
      kind: "translucent",
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "active",
    };
  }
  return { kind: "opaque", backgroundColor: OPAQUE_VOID };
}

/** The BrowserWindow options a material asks for, and the argument that tells the page. */
export function windowMaterialOptions(material: WindowMaterial): {
  backgroundColor: string;
  vibrancy?: "under-window";
  visualEffectState?: "active";
  additionalArguments: string[];
} {
  const kind: WindowMaterialKind = material.kind;
  const additionalArguments = [windowMaterialArgument(kind)];
  return material.kind === "translucent"
    ? {
        backgroundColor: material.backgroundColor,
        vibrancy: material.vibrancy,
        visualEffectState: material.visualEffectState,
        additionalArguments,
      }
    : { backgroundColor: material.backgroundColor, additionalArguments };
}
