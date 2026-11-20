import markMacInstallation from "./mark-mac-installation.mjs";
import placeMacAppLauncherAfterPack from "./place-mac-app-launcher.mjs";

/**
 * electron-builder's afterPack: on a Mac, on each architecture's bundle and
 * on the final universal one, before the fuses flip and signing. It puts the
 * app's own two executables in place (./place-mac-app-launcher.mjs) and marks
 * a direct copy's installation (./mark-mac-installation.mjs); any other
 * system's bundle is left as it is.
 */
export default function afterPack(context) {
  placeMacAppLauncherAfterPack(context);
  markMacInstallation(context);
}
