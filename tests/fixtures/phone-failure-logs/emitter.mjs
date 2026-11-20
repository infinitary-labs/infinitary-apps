import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

// Recorded WebKit readings from run 40952227386, attempt 2 (INF-1888).
export const launched =
  "2026-10-29 23:24:48.649 F  Infinitary[6999:81f3] [com.apple.WebKit:Process] WebContent process (0x1260b00c0) took 202.786854 seconds to launch";
const forwarded =
  "2026-10-29 23:24:50.131 Df Infinitary[6999:81f3] [com.apple.WebKit:Process] WebContent[7049] WebProcess::platformInitializeWebProcess\n";
const [mode, receipt] = process.argv.slice(2);
if (mode === "large") {
  // Repeat an actual log row past this Node runtime's string ceiling, without
  // allocating the whole fixture in memory. The runner must read witnesses too.
  const block = Buffer.from(forwarded.repeat(8192));
  const blocks = Math.ceil((constants.MAX_STRING_LENGTH + 1) / block.length);
  const hash = createHash("sha256");
  for (let i = 0; i < blocks; i++) {
    hash.update(block);
    if (!process.stdout.write(block)) await once(process.stdout, "drain");
  }
  const tail = Buffer.from(launched + "\n");
  hash.update(tail);
  process.stdout.write(tail);
  writeFileSync(
    receipt,
    JSON.stringify({ bytes: blocks * block.length + tail.length, sha256: hash.digest("hex") }),
  );
} else if (mode === "fail") {
  process.stderr.write("Domain is tearing down\n");
  process.exitCode = 1;
} else if (mode === "endless") {
  // A log reader still streaming when the native gate is interrupted: it never
  // finishes by itself, so only a signal ends it, however late the signal comes.
  // It leaves on its own only once its parent is gone, so it cannot outlive a run.
  process.stdout.write(`${launched}\n`);
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(1);
  }, 1000);
} else {
  process.stdout.write(launched + "\n");
  process.stderr.write("Filtering the log data using the requested predicate\n");
}
