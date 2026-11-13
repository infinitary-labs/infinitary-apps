import * as m from "@shared/i18n/messages.generated";
import type { FrameTheme } from "@shared/plugins/frameDocument";
import { useCallback, useEffect, useRef, useState } from "react";
import { FocusEdge } from "../app/stage/CardEdges";
import { HEADING_STYLE, useViewerFade, ViewerShell } from "../design/cards/ViewerShell";
import { focusWithRing } from "../design/focus";
import { HtmlCardBody } from "./PrototypeBody";

/**
 * A part of a card's body full screen (docs/card-authoring.md, "A part full
 * screen"; the design skill's PictureViewer, "A part full screen"): the
 * part's own body asked (`inf.expand`), and the same body opens again,
 * live, in a frame of its own on the viewers' shared overlay, stamped with
 * which part and the state it opens at. The copy says where it stands as it
 * moves; Close or Escape hands the last of it back to the part in the card
 * and returns focus to the frame that opened it.
 */

export type ExpandedPartProps = {
  /** The card's title: the header names the card. */
  title: string;
  /** The body the part is in, as its author wrote it. */
  body: string;
  index: number;
  /** The part's state as it asked to open, as JSON. */
  state: string;
  theme: FrameTheme;
  /** Called once it is gone, with the last state the copy stood at. */
  onClose: (state: string) => void;
};

export function ExpandedPart({ title, body, index, state, theme, onClose }: ExpandedPartProps) {
  const latest = useRef(state);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The body is the one it opened with: a revision of the card while it is
  // open does not move the copy under the captain.
  const [opened] = useState(() => ({ body, index, state }));
  const handBack = useCallback(() => onClose(latest.current), [onClose]);
  const { shown, leaving, open, close } = useViewerFade(dialogRef, handBack);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves in once, on opening
  useEffect(() => {
    dialogRef.current?.focus();
    open();
  }, []);

  // Escape and the Tab ring while focus is on the overlay's own chrome; inside
  // the frame the part's own keys are its, and its unused Escape closes it.
  useEffect(() => {
    if (leaving) return;
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") close();
      else if (event.key === "Tab") {
        const stops = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), iframe")];
        const at = stops.indexOf(document.activeElement as HTMLElement);
        const next = stops.at(event.shiftKey ? (at <= 0 ? -1 : at - 1) : (at + 1) % stops.length);
        next?.focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leaving, close]);

  return (
    <ViewerShell
      dialogRef={dialogRef}
      label={m.uiPictureViewerPartFrom({ title })}
      marker="data-expanded-part"
      shown={shown}
      leaving={leaving}
      heading={<span style={HEADING_STYLE}>{title}</span>}
      meta={null}
      closeLabel={m.uiPictureViewerClose()}
      close={close}
    >
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          margin: "0 var(--space-4) var(--space-4)",
          background: "var(--bg-2)",
          borderRadius: "var(--radius-m)",
          boxShadow: "var(--shadow-2)",
          overflow: "hidden",
        }}
      >
        <HtmlCardBody
          body={opened.body}
          theme={theme}
          title={title}
          declaredActionIds={[]}
          onAction={() => Promise.reject(new Error("A part full screen raises no action."))}
          expanded={{
            index: opened.index,
            state: opened.state,
            onState: (next) => {
              latest.current = next;
            },
            onEscape: close,
          }}
          onDrawn={() => {
            // Focus goes into the copy once it is drawn, where the part's keys are.
            const frame = dialogRef.current?.querySelector("iframe");
            if (frame && document.activeElement === dialogRef.current) frame.focus();
          }}
        />
      </div>
      {/* Tab past the copy's last control comes round to Close, never behind the overlay. */}
      <FocusEdge
        onFocus={() => {
          const button = dialogRef.current?.querySelector<HTMLElement>("button");
          if (button) focusWithRing(button);
        }}
      />
    </ViewerShell>
  );
}
