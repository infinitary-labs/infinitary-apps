import type { HostSecretsRecovery } from "@core/host";
import * as m from "@shared/i18n/messages.generated";
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
        title: m.secretsArchiveSaveTitle(),
        message: m.secretsArchiveSaveMessage(),
        defaultPath: "Secrets.infinitary-recovery",
        properties: ["createDirectory", "dontAddToRecent"],
      });
      if (archive.canceled || !archive.filePath) return undefined;
      const key = await dialog.showSaveDialog(window, {
        title: m.secretsKeySaveTitle(),
        message: m.secretsKeySaveMessage(),
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
        title: m.secretsArchiveOpenTitle(),
        properties: ["openFile", "dontAddToRecent"],
      });
      if (archive.canceled || !archive.filePaths[0]) return undefined;
      const key = await dialog.showOpenDialog(window, {
        title: m.secretsKeyOpenTitle(),
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
