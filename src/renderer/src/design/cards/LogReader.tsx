import { fileSizeWords } from "@shared/attachments";
import { parseCardLogFileName } from "@shared/cardPictures";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useRef, useState } from "react";
import { HEADING_STYLE, META_STYLE, tabRing, useViewerFade, ViewerShell } from "./ViewerShell";

/**
 * Where a kept proof log is read (INF-3887): the picture viewer's twin for
 * text. A merge card names each log by one line, its name and size, and a
 * press on it opens the log here, over the whole window, as a picture opens
 * in the picture viewer - so the card never holds the log's text. Every rule
 * here is the design skill's `components/cards/PictureViewer.prompt.md`, "A
 * proof log".
 *
 * The reader owns its own leaving, as the viewer does: `onClose` is called
 * once it is gone, and the caller returns focus to what opened it.
 */

/** A kept proof log the reader opens: the host's served copy, its name and its size. */
export type ViewerLog = {
  /** The log's address on the card (`isReadableLogSource`). */
  src: string;
  /** The words of the line that opened it. */
  name: string;
  /** The size the card wrote; the reader shows what it read once it has. */
  bytes: number;
};

export type LogReaderProps = {
  /** The card's title: the dialog names the card. */
  title: string;
  log: ViewerLog;
  onClose: () => void;
  /** How the log's text is read; by default asked of the computer that keeps it. */
  read?: (src: string) => Promise<string>;
};

/** The log's text from the computer that keeps it, asked by its kept name. */
async function readKept(src: string): Promise<string> {
  const log = parseCardLogFileName(src.slice(src.lastIndexOf("/") + 1));
  if (!log) throw new Error("Not a kept log's address.");
  const { data } = await window.infinitary.cards.log(log.fileName);
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
}

type Reading =
  | { state: "reading" }
  | { state: "read"; text: string; bytes: number }
  | { state: "unreadable" };

export function LogReader({ title, log, onClose, read = readKept }: LogReaderProps) {
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const { shown, leaving, open, close } = useViewerFade(dialogRef, onClose);

  useEffect(() => {
    let current = true;
    read(log.src).then(
      (text) => {
        if (current)
          setReading({ state: "read", text, bytes: new TextEncoder().encode(text).length });
      },
      () => {
        if (current) setReading({ state: "unreadable" });
      },
    );
    return () => {
      current = false;
    };
  }, [log.src, read]);

  // In on the frame after the first paint at opacity 0, as the picture viewer fades in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves in once, on opening
  useEffect(() => {
    dialogRef.current?.focus();
    open();
  }, []);

  // The text takes focus once it is there, so the reading keys scroll it at once.
  useEffect(() => {
    if (reading.state !== "read") return;
    const dialog = dialogRef.current;
    if (dialog && document.activeElement === dialog) textRef.current?.focus();
  }, [reading.state]);

  // Esc and the Tab ring, captured at the window so they never reach the stack underneath.
  useEffect(() => {
    if (leaving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      } else if (event.key !== "Tab" || !tabRing(event, dialogRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leaving, close]);

  const size = fileSizeWords(reading.state === "read" ? reading.bytes : log.bytes);

  return (
    <ViewerShell
      dialogRef={dialogRef}
      label={m.uiLogReaderFrom({ title })}
      marker="data-log-reader"
      shown={shown}
      leaving={leaving}
      heading={
        <span data-log-name="" style={HEADING_STYLE}>
          {log.name}
        </span>
      }
      meta={
        <span data-log-size="" style={META_STYLE}>
          {size}
        </span>
      }
      closeLabel={m.uiLogReaderClose()}
      close={close}
    >
      {/* The backdrop's click is the pointer's twin of Esc, which the window
          listener above already gives the keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop, see above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc is its key */}
      <div
        data-log-row=""
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          justifyContent: "center",
          padding: "0 var(--space-8) var(--space-8)",
        }}
      >
        {reading.state === "read" ? (
          <pre
            ref={textRef}
            data-log-text=""
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard reads
            tabIndex={0}
            style={{
              margin: 0,
              width: "100%",
              maxWidth: "120ch",
              overflow: "auto",
              padding: "var(--space-4)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              lineHeight: 1.6,
              color: "var(--fg-1)",
              background: "var(--bg-1)",
              borderRadius: "var(--radius-s)",
              boxShadow: "var(--shadow-2)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {reading.text}
          </pre>
        ) : (
          <p
            data-log-state={reading.state}
            style={{
              alignSelf: "center",
              margin: 0,
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            {reading.state === "reading" ? m.uiLogReaderReading() : m.uiLogReaderUnreadable()}
          </p>
        )}
      </div>
    </ViewerShell>
  );
}
