import { spawn } from "node:child_process";
import { hostEnv } from "../hostEnv";

/**
 * macOS's own Bonjour tool, as Macs nearby run it (docs/devices.md, "Macs
 * nearby"): `/usr/bin/dns-sd`, or a development run's stand-in
 * (`INFINITARY_DNS_SD`), so a test never listens on the Mac's own network. It
 * only listens and asks mDNSResponder; it sends nothing to any address.
 */
export const SYSTEM_DNS_SD = "/usr/bin/dns-sd";

/**
 * One run of it: each line it prints, then its end - `finished` when it
 * exited cleanly, as it does once its `-t` seconds ran out - unless `stop`
 * ended it first.
 */
export type DnsSdRun = (
  args: readonly string[],
  heard: { line: (text: string) => void; ended: (finished: boolean) => void },
) => { stop: () => void };

/**
 * Runs `program` with the app's environment (`hostEnv`) and hands back
 * each whole line it prints, on either stream. dns-sd flushes at the end of each batch, so a
 * line is never cut; a line still unfinished when it ends is dropped.
 */
export function runDnsSd(program: string): DnsSdRun {
  return (args, heard) => {
    let ended = false;
    const end = (finished: boolean) => {
      if (ended) return;
      ended = true;
      heard.ended(finished);
    };
    const child = spawn(program, [...args], {
      env: hostEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A call it could not make is said on stderr, the rest on stdout.
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (ended) return;
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) heard.line(line);
      });
    }
    child.on("error", () => end(false));
    child.on("close", (code) => end(code === 0));
    return {
      stop: () => {
        ended = true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      },
    };
  };
}
