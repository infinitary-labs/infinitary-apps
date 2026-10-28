const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infinitary", {
  app: { healthcheck: () => ipcRenderer.invoke("healthcheck") },
});
