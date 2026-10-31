// The stand-in app of the launch gate (INF-1768) and the data-folder check
// (INF-2110) in tests/release-contract.test.ts: Electron's own process tree
// in a packaged app's shape. Its window answers the healthcheck the launch
// gate asks; it opens its database in userData, as the core does early in
// boot, which the data-folder check waits for; a quit is held while it
// writes saved data into userData, as the app's lifecycle holds one
// (src/main/lifecycle.ts); and a child it starts, as the core starts git,
// writes there too and outlives it. For the data-folder check, a second
// child starts in a session of its own, as the core starts the login shell
// (src/core/userBin.ts), and writes into the home it names only in its
// environment.
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
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(join(app.getPath("userData"), "firstmate.db"), "");
  spawn(process.execPath, [join(__dirname, "child.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WRITE_INTO: app.getPath("userData") },
    stdio: "ignore",
  });
  if (process.env.LAUNCH_GATE_DETACHED_CHILD === "1") {
    spawn(process.execPath, [join(__dirname, "child.cjs")], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WRITE_INTO: app.getPath("home"),
        WITNESS_AS: "detached",
      },
      stdio: "ignore",
      detached: true,
    }).unref();
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs") },
  });
  window.loadURL("data:text/html,<title>launch-gate-app</title>");
});
