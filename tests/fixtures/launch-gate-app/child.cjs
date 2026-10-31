// The stand-in app's child: it names the folder it writes into (the app's
// userData, or for the detached child the home) only in its environment and
// keeps writing new files there until it is killed.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

writeFileSync(
  join(process.env.LAUNCH_GATE_WITNESS, `${process.env.WITNESS_AS ?? "child"}.pid`),
  String(process.pid),
);
const work = join(process.env.WRITE_INTO, "work");
let n = 0;
setInterval(() => {
  try {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, `object-${n++}`), "");
  } catch {
    // The folder is being removed; the next write makes it again.
  }
}, 2);
