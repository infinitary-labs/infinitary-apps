import { join } from "node:path";

/**
 * Where the Firstmate agent reads its own source. Packaged builds ship the
 * git-tracked tree as extraResources (`Contents/Resources/self-source`);
 * unpackaged / dev uses the checkout itself so both modes look the same to
 * the agent. Nothing ever executes from this tree.
 */
export type SelfSourceLocation = {
  isPackaged: boolean;
  resourcesPath: string;
  /** Electron `app.getAppPath()`: the repo root when unpackaged. */
  appPath: string;
};

export function resolveSelfSourceDir(location: SelfSourceLocation): string {
  if (location.isPackaged) {
    return join(location.resourcesPath, "self-source");
  }
  return location.appPath;
}
