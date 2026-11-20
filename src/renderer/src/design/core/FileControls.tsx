import { FILE_WORDS } from "@shared/composer";
import type React from "react";
import { useRef, useState } from "react";
import { IconButton } from "./IconButton";

/**
 * What an input needs to take files (`docs/composer.md`, "Files"): given by
 * the host, drawn the same in the main input and a card's reply.
 */
export type FileIntake = {
  /** Files dropped on the input. */
  onFiles: (files: File[]) => void;
  /** Open the system picker. */
  onPick: () => void;
  /** Files being prepared, in order. */
  pending: ReadonlyArray<{ id: string; name: string }>;
  onCancel: (id: string) => void;
  /** What a screen reader is told about the files, said when it changes. */
  status: string;
  /** Whether the input takes files now. */
  enabled: boolean;
};

const clip = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
  </svg>
);

/** The one control that opens the picker: a keyboard path to everything a drop does. */
export function AddFilesButton({
  intake,
  size = 32,
  label = FILE_WORDS.add,
}: {
  intake: FileIntake;
  size?: number;
  /** What a screen reader hears; a reply names its destination. */
  label?: string;
}) {
  return (
    <IconButton label={label} size={size} disabled={!intake.enabled} onClick={intake.onPick}>
      {clip}
    </IconButton>
  );
}

const chipStyle: React.CSSProperties = {
  display: "flex",
  flex: "0 0 auto",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-1)",
  borderRadius: "var(--radius-s)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  fontSize: "var(--text-xs)",
};

/** A file being prepared: its name, "Preparing", and the control that stops it. */
export function PendingFileChip({ name, onCancel }: { name: string; onCancel: () => void }) {
  return (
    <div data-file-preparing="" style={chipStyle}>
      <span
        style={{
          maxWidth: "var(--space-9)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg-1)",
        }}
      >
        {name}
      </span>
      <span style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>{FILE_WORDS.preparing}</span>
      <IconButton label={FILE_WORDS.cancel(name)} size={20} onClick={onCancel}>
        ×
      </IconButton>
    </div>
  );
}

/** The chips of files still being prepared, or nothing. */
export function PendingFileChips({ intake }: { intake: FileIntake }) {
  if (intake.pending.length === 0) return null;
  return (
    <>
      {intake.pending.map((file) => (
        <PendingFileChip key={file.id} name={file.name} onCancel={() => intake.onCancel(file.id)} />
      ))}
    </>
  );
}

/** Read by a screen reader, drawn nowhere: the files' status, said when it changes. */
export function FilesStatus({ intake }: { intake: FileIntake | undefined }) {
  return (
    <span
      aria-live="polite"
      data-files-status=""
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
      }}
    >
      {intake?.status ?? ""}
    </span>
  );
}

/** Whether a drag carries files: the only drags an input answers. */
function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files"); // i18n-exempt: not shown (a drag data type)
}

/**
 * The drop target of one input: handlers for its shell (chips included) and
 * whether a file is over it now, so only the actual destination lights up.
 * An input that takes no files answers nothing, and a drop never reaches an
 * input beneath or beside it.
 */
export function useFileDrop(intake: FileIntake | undefined) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const enabled = intake?.enabled === true;
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  const handlers = intake
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          depth.current += 1;
          if (enabled) setOver(true);
        },
        onDragOver: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = enabled ? "copy" : "none";
        },
        onDragLeave: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        },
        onDrop: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          reset();
          const files = Array.from(event.dataTransfer.files);
          if (enabled && files.length > 0) intake.onFiles(files);
        },
      }
    : {};
  return { over: over && enabled, handlers };
}
