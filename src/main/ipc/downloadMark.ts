import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";

/** Give the system the same download-origin signal it gets from a browser. */
export async function markDownload(path: string): Promise<void> {
  if (hostPlatform() === "darwin") {
    const time = Math.floor(Date.now() / 1000).toString(16);
    await promisify(execFile)(
      "/usr/bin/xattr",
      ["-w", "com.apple.quarantine", `0081;${time};Infinitary;`, path],
      { env: hostEnv() },
    );
  } else if (hostPlatform() === "win32") {
    await writeFile(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  }
}
