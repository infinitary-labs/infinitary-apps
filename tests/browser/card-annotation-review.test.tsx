import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  ANNOTATE,
  EDIT_UNAVAILABLE,
  NOTE_COMMENT_LABEL,
  NOTE_EDIT,
  NOTE_REMOVE,
  POINT_AT,
  POINTED_AT,
  STALE_NOTE,
  UNAVAILABLE_NOTE,
} from "../../src/shared/cardNotes";
import { ANNOTATION_RANGE, ANNOTATION_TITLE, ANNOTATION_WORDS } from "../fixtures/cardAnnotations";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/** Captain's Keep copy working choice and review f3/f4: real frame gestures and host state, no OS clipboard. */
test("selection keeps usual Copy, unrelated typing does not repaint, and an absent body is not called stale", async () => {
  const bridge = fakeBridge(await seededHome());
  await openSize();
  await openWindow(bridge);
  const frame = await bodyDrawn(ANNOTATION_TITLE);
  await stageAtRest();
  const { useShellStore } = await import("../../src/renderer/src/app/store");
  const { FrameController } = await import("../../src/renderer/src/plugins/frames/frameController");
  const { NoteAnchor, QueuedNotes } = await import(
    "../../src/renderer/src/cards/AnnotationControls"
  );
  const card = useShellStore.getState().cards.find((card) => card.title === ANNOTATION_TITLE);
  if (!card) throw new Error("missing saved annotation example");
  const repaint = vi.spyOn(FrameController.prototype, "annotate");
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    top: "100px",
    left: "100px",
    width: "600px",
    zIndex: "10000",
    background: "var(--bg-1)",
  });
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    const selectWords = async () => {
      frame.focus();
      await expect.poll(() => document.activeElement === frame).toBe(true);
      await inCardBody(
        ANNOTATION_TITLE,
        (words) => {
          const paragraph = document.querySelector("p");
          const node = paragraph?.firstChild;
          if (!paragraph || !node) throw new Error("missing example paragraph");
          const start = (node.textContent ?? "").indexOf(words);
          if (start < 0) throw new Error("missing selected fixture words");
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + words.length);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        },
        ANNOTATION_RANGE,
      );
    };
    const comment = page.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
    const annotate = page.getByRole("button", { name: new RegExp(`^${ANNOTATE}`) });
    // INF-3786: with Point at off a selection only offers Annotate; frame-focused
    // Escape consumes the offer, never the card (review r2).
    await selectWords();
    await expect.element(annotate).toBeVisible();
    expect(comment.query()).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.element(annotate).not.toBeInTheDocument();
    expect(useShellStore.getState().annotationOffer).toBeNull();
    expect(frame.isConnected).toBe(true);

    // With Point at on, a selection opens the editor at once with the caret in its comment.
    await userEvent.click(page.getByRole("button", { name: new RegExp(`^${POINT_AT}`) }));
    await selectWords();
    await expect.element(comment).toBeVisible();
    await expect.poll(() => document.activeElement === comment.element()).toBe(true);
    const selectedSpan = useShellStore.getState().annotationPick?.note.span;
    expect(selectedSpan).toBeDefined();
    await userEvent.keyboard("{Escape}");
    await expect.element(comment).not.toBeInTheDocument();
    expect(useShellStore.getState().annotationPick).toBeNull();
    expect(frame.isConnected).toBe(true);
    await userEvent.click(page.getByRole("button", { name: new RegExp(`^${POINT_AT}`) }));
    expect(useShellStore.getState().pointAtCard).toBeNull();

    // The captain's as-is selection route uses Tab, then Enter, without sending.
    await selectWords();
    await expect.element(annotate).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => document.activeElement === comment.element()).toBe(true);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => useShellStore.getState().replyNotes[card.id]?.length).toBe(1);
    expect(useShellStore.getState().replyNotes[card.id]?.[0]).toMatchObject({
      comment: "",
      span: selectedSpan,
    });
    await userEvent.click(page.getByRole("button", { name: NOTE_REMOVE, exact: true }));
    await selectWords();
    await expect.element(annotate).toBeVisible();
    expect(document.activeElement).toBe(frame);
    expect(await inCardBody(ANNOTATION_TITLE, () => window.getSelection()?.toString())).toBe(
      ANNOTATION_RANGE,
    );
    // Headless Chromium's private clipboard, exercised by the normal keys, never the person's clipboard.
    const modifier = navigator.platform.includes("Mac") ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}c{/${modifier}}`);
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => document.activeElement === comment.element()).toBe(true);
    await userEvent.keyboard(`{${modifier}>}v{/${modifier}}`);
    await expect.element(comment).toHaveValue(ANNOTATION_RANGE);
    expect(
      await inCardBody(ANNOTATION_TITLE, () =>
        Array.from(CSS.highlights.get("inf-point") ?? []).map((range) => range.toString()),
      ),
    ).toEqual([ANNOTATION_RANGE]);

    repaint.mockClear();
    useShellStore.setState((state) => ({
      replyDrafts: { ...state.replyDrafts, [card.id]: ANNOTATION_WORDS },
    }));
    await userEvent.keyboard(" together");
    expect(repaint).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(repaint).toHaveBeenCalled();
    const notes = useShellStore.getState().replyNotes[card.id] ?? [];
    const note = notes[0];
    if (!note) throw new Error("selection did not queue its real note");

    repaint.mockClear();
    flushSync(() =>
      useShellStore.setState((state) => ({
        sendingReplies: { ...state.sendingReplies, [card.id]: true },
      })),
    );
    expect(repaint).not.toHaveBeenCalled();
    useShellStore.setState((state) => {
      const sendingReplies = { ...state.sendingReplies };
      delete sendingReplies[card.id];
      return { sendingReplies };
    });

    // An in-place or past thread can retain this note without mounting its body.
    bridge.push("inf:cards", []);
    await stageAtRest();
    useShellStore.setState((state) => ({ replyNotes: { ...state.replyNotes, [card.id]: notes } }));
    document.body.append(host);
    root = createRoot(host);
    flushSync(() =>
      root?.render(
        <>
          <NoteAnchor cardId={card.id} note={note} />
          <QueuedNotes cardId={card.id} />
        </>,
      ),
    );
    const anchors = host.querySelectorAll<HTMLButtonElement>(".inf-note-anchor button");
    if (!anchors[0]) throw new Error("missing retained note anchor");
    expect(anchors[0].textContent).toContain(POINTED_AT);
    await userEvent.click(anchors[0]);
    await expect.poll(() => host.textContent).toContain(UNAVAILABLE_NOTE);
    expect(host.textContent).not.toContain(STALE_NOTE);
    await userEvent.click(page.getByRole("button", { name: NOTE_EDIT, exact: true }));
    await expect.poll(() => host.textContent).toContain(EDIT_UNAVAILABLE);
    expect(host.textContent).not.toContain(STALE_NOTE);
  } finally {
    repaint.mockRestore();
    root?.unmount();
    host.remove();
  }
});
