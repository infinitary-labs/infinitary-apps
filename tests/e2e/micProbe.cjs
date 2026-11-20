// Run by Electron (tests/e2e/micPreflight.ts): opens the fake microphone the
// way hold-to-talk does and exits 0 when it opens, 2 when it is refused.
// The page is a file, because only a secure context has navigator.mediaDevices
// and a data: page is not one.
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadFile(join(__dirname, "micProbe.html"));
  const opened = await win.webContents.executeJavaScript(
    "navigator.mediaDevices.getUserMedia({ audio: true }).then(() => true, () => false)",
  );
  app.exit(opened ? 0 : 2);
});
