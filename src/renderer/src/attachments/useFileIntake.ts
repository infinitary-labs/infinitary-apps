import { useMemo } from "react";
import type { FileIntake } from "../design/core/FileControls";
import {
  cancelPending,
  type FileDestination,
  giveFiles,
  pickFiles,
  useIntakeStore,
} from "./intake";

const NONE: ReadonlyArray<{ id: string; name: string }> = [];

export function useFileIntake(dest: FileDestination | undefined): FileIntake | undefined {
  const key = dest?.key ?? "";
  const pending = useIntakeStore((s) => s.pending[key]) ?? NONE;
  const status = useIntakeStore((s) => s.status[key]) ?? "";
  const enabled = dest?.accepts() ?? false;
  return useMemo(
    () =>
      dest
        ? {
            onFiles: (files: File[]) => void giveFiles(dest, files, window.infinitary.files),
            onPick: () => void pickFiles(dest, window.infinitary.files),
            pending,
            onCancel: (id: string) => cancelPending(dest.key, id),
            status,
            enabled,
          }
        : undefined,
    [dest, pending, status, enabled],
  );
}
