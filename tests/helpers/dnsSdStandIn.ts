import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellWord } from "../../src/core/devices/joinCommand";
import { POLICY_DENIED } from "../../src/core/devices/nearby";
import { scratchDir } from "./scratchDirs";

/**
 * A stand-in for macOS's dns-sd (`INFINITARY_DNS_SD`, docs/devices.md, "Macs
 * nearby"), so a test never listens on the Mac's own network: `-B`
 * announces each Mac given as dns-sd prints it, and `-L <name>` answers
 * that Mac's name on this network; both then wait until stopped, or until
 * their `-t` seconds run out. With
 * `denied`, the browse answers what dns-sd says when macOS has not let the
 * app use the local network, and announces nothing. Each run adds its
 * process id to `pids` beside the script before it prints anything.
 */
export function standInDnsSd(
  macs: readonly { name: string; at: string }[],
  options: { denied?: boolean } = {},
): string {
  const path = join(scratchDir("infinitary-dns-sd-"), "dns-sd");
  const announced = options.denied
    ? [`12:00:00.000  Error code ${POLICY_DENIED}`]
    : macs.map(
        (mac) =>
          `12:00:00.000  Add        2  14 local.               _ssh._tcp.           ${mac.name}`,
      );
  const browse = [
    "Browsing for _ssh._tcp.local.",
    "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
    ...announced,
  ];
  const lookups = macs.map(
    (mac) =>
      `  ${shellWord(mac.name)}) printf '%s\\n' ${shellWord(
        `12:00:00.000  ${mac.name.replaceAll(" ", "\\032")}._ssh._tcp.local. can be reached at ${mac.at}.:22 (interface 14)`,
      )} ;;`,
  );
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // Each run says who it is beside the script, so a test can tell it ended,
      // before it prints anything: the app may stop a run once it has heard it.
      `echo $$ >> ${shellWord(join(dirname(path), "pids"))}`,
      // `-t <seconds>` ends a run cleanly after that long, as dns-sd's does.
      "t=120",
      'if [ "$1" = "-t" ]; then t="$2"; shift 2; fi',
      'case "$1" in',
      "-B)",
      ...browse.map((line) => `  printf '%s\\n' ${shellWord(line)}`),
      "  ;;",
      "-L)",
      '  case "$2" in',
      ...lookups,
      "  esac",
      "  ;;",
      "esac",
      'exec sleep "$t"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}
