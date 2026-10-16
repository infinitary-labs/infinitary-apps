import { type ChildProcessByStdio, spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import { hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";

/**
 * This app as another Mac gets it (docs/devices.md, "Getting Firstmate from
 * this Mac"): one gzipped tar of its bundle, made as it is sent by the Mac's
 * own tar at utility QoS, on the started process's stdout. A command fetches
 * it over the connection; adding a Mac by its address sends it over SSH.
 */
export function packApp(bundle: string): ChildProcessByStdio<null, Readable, null> {
  const { file, args } = atUtilityQos("/usr/bin/tar", [
    "-czf",
    "-",
    "-C",
    dirname(bundle),
    basename(bundle),
  ]);
  return spawn(file, args, { env: hostEnv(), stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Counts the copy as it goes and says the count (docs/devices.md, "How far
 * the copy has gone"): at its first bytes, then at most once every
 * `everyMs` while it moves, and once more at its end with all it sent. The
 * count is what was handed to that Mac's input, never a share of a total.
 */
export function copyCount(say: (sent: number) => void, everyMs: number) {
  let sent = 0;
  let told = -1;
  let toldAt = 0;
  const tell = (end: boolean) => {
    if (sent === told || sent === 0) return;
    const now = performance.now();
    if (!end && told >= 0 && now - toldAt < everyMs) return;
    told = sent;
    toldAt = now;
    say(sent);
  };
  return {
    add: (bytes: number) => {
      sent += bytes;
      tell(false);
    },
    end: () => tell(true),
  };
}
