import type { HostSecretsRecovery } from "@core/host";
import { dialog } from "electron";
import { appWindows } from "../windows";
import { readSecretRecoveryFiles, saveSecretRecoveryFiles } from "./secretRecoveryFiles";

/** Native-only file selection: the renderer supplies neither paths nor file contents. */
export function createSecretRecoveryDialogs(): HostSecretsRecovery {
  return {
    async chooseSave() {
      const window = appWindows()[0];
      if (!window || window.isDestroyed()) return undefined;
      const archive = await dialog.showSaveDialog(window, {
        title: "Save encrypted Secrets archive",
        message: "Choose a new file. Existing archives will not be replaced.",
        defaultPath: "Secrets.infinitary-recovery",
        properties: ["createDirectory", "dontAddToRecent"],
      });
      if (archive.canceled || !archive.filePath) return undefined;
      const key = await dialog.showSaveDialog(window, {
        title: "Save the separate recovery key",
        message:
          "Keep this key separately from the archive. Anyone with both can read the saved secrets. There is no key reset.",
        defaultPath: "Secrets.infinitary-recovery-key",
        properties: ["createDirectory", "dontAddToRecent"],
      });
      if (key.canceled || !key.filePath) return undefined;
      const destinations = { archive: archive.filePath, key: key.filePath };
      return (files) => saveSecretRecoveryFiles(destinations, files);
    },
    async chooseRestore() {
      const window = appWindows()[0];
      if (!window || window.isDestroyed()) return undefined;
      const archive = await dialog.showOpenDialog(window, {
        title: "Choose the encrypted Secrets archive",
        properties: ["openFile", "dontAddToRecent"],
      });
      if (archive.canceled || !archive.filePaths[0]) return undefined;
      const key = await dialog.showOpenDialog(window, {
        title: "Choose its separate recovery key",
        properties: ["openFile", "dontAddToRecent"],
      });
      if (key.canceled || !key.filePaths[0]) return undefined;
      const files = await readSecretRecoveryFiles({
        archive: archive.filePaths[0],
        key: key.filePaths[0],
      });
      if (!files) throw new Error("Recovery files could not be read.");
      return files;
    },
  };
}
