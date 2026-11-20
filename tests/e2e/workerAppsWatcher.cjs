// The watcher beside a Playwright worker (tests/e2e/workerApps.ts). It reads
// the user-data folder of each app the worker launches, one per line, and
// once its input ends - the worker has exited, however it ended - it stops
// every process still running with one of those folders, then exits.
const { execFileSync } = require("node:child_process");

const flags = new Set();
let pending = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const folder of lines) if (folder) flags.add(`--user-data-dir=${folder}`);
});
process.stdin.on("end", stopApps);
process.stdin.on("error", stopApps);

function stopApps() {
  let listing = "";
  try {
    if (flags.size > 0) {
      listing = execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "args="], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    }
  } catch {
    // Nothing to read: nothing this watcher can stop.
  }
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    // A whole argument: one folder's name never stops another's app.
    const args = `${match[2]} `;
    if (![...flags].some((flag) => args.includes(`${flag} `))) continue;
    const pid = Number(match[1]);
    // An app leads its own process group (Playwright starts it detached), so
    // the group takes its helpers with it; a helper alone is not a group.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Not a group, or already gone.
      }
    }
  }
  process.exit(0);
}
