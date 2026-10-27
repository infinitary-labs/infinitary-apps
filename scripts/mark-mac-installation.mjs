import { execFileSync } from "node:child_process";
import { join } from "node:path";
import receipt from "../packaging/mac-installation.json" with { type: "json" };

/** Runs on the final universal bundle before signing, and on each architecture's bundle. */
export default function markMacInstallation(context) {
  if (context.electronPlatformName !== "darwin") return;
  const bundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // A file's attributes follow replacement; merging into an existing directory retains its old ones.
  execFileSync("/usr/bin/xattr", ["-w", receipt.attribute, receipt.direct, join(bundle, receipt.path)]);
}
