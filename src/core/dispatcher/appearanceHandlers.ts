import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import { ownThemesRead } from "@shared/ownColorThemes";
import type { CoreServices } from "../coreServices";

type AppearanceHandlers = {
  [C in Extract<
    CoreInvokeChannel,
    "inf:settings:appearance:get" | "inf:settings:own-themes:get" | "inf:settings:appearance:set"
  >]: (...args: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * The look and the own themes worked out from it (docs/themes.md). Every
 * preference write goes through the one writer, which pushes the whole value
 * back as `inf:shell:preferences` (talk-to-personalize Step 1).
 */
export function appearanceHandlers(services: CoreServices): AppearanceHandlers {
  return {
    "inf:settings:appearance:get": () => services.settings.getAppearance(),
    "inf:settings:own-themes:get": () => ownThemesRead(services.settings.getAppearance()),
    "inf:settings:appearance:set": (appearance) => services.preferences.setAppearance(appearance),
  };
}
