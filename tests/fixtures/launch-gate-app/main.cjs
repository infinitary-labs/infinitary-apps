// The launch gate's stand-in app (tests/release-contract.test.ts, INF-1768):
// Electron's own process tree in a packaged app's shape. Its window answers
// the healthcheck the gate asks; a quit is held while it writes saved data
// into userData, as the app's lifecycle holds one (src/main/lifecycle.ts);
// and a child it starts, as the core starts git, writes there too and
// outlives it.
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const witness = process.env.LAUNCH_GATE_WITNESS;
writeFileSync(join(witness, "app.pid"), String(process.pid));
ipcMain.handle("healthcheck", () => ({ version: app.getVersion() }));

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  const saved = join(app.getPath("userData"), "saved");
  mkdirSync(saved, { recursive: true });
  let n = 0;
  const writes = setInterval(() => writeFileSync(join(saved, `flush-${n++}`), ""), 5);
  setTimeout(() => {
    clearInterval(writes);
    app.exit(0);
  }, 1500);
});

app.whenReady().then(() => {
  spawn(process.execPath, [join(__dirname, "child.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WRITE_INTO: app.getPath("userData") },
    stdio: "ignore",
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs") },
  });
  window.loadURL("data:text/html,<title>launch-gate-app</title>");
});
