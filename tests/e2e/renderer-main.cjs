// Renderer-only test host. No application core, preload, sign-in or IPC.
// Keep the installed Electron's Chromium without downloading another browser.
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.INFINITARY_RENDERER_USER_DATA);
app.whenReady().then(() => {
  app.dock?.hide();
  const keeper = new BrowserWindow({ show: false });
  void keeper.loadURL("about:blank");
});
app.on("window-all-closed", () => {
  /* The worker owns the application lifetime. */
});
