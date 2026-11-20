import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import {
  MAC_INSTALLATION_ATTRIBUTE,
  MAC_INSTALLATION_RESOURCE,
  type MacInstallation,
  parseMacInstallation,
} from "@core/update/macInstallation";

/** The per-copy receipt lives in file metadata, not in the signed contents. */
export function readMacInstallation(
  bundle = dirname(dirname(dirname(process.execPath))),
): MacInstallation {
  try {
    return parseMacInstallation(
      execFileSync(
        "/usr/bin/xattr",
        ["-p", MAC_INSTALLATION_ATTRIBUTE, join(bundle, MAC_INSTALLATION_RESOURCE)],
        {
          encoding: "utf8",
          env: hostEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim(),
    );
  } catch {
    return { kind: "unknown" };
  }
}
